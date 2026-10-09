// netlify/functions/live-poll.js
//
// SCHEDULED function (see netlify.toml) — runs every minute. Finds
// bouts seeded by seed-live-card.js that are 'scheduled' or 'live' and
// scheduled for today, re-fetches each from Cito's Bout Detail endpoint
// (the same one sync-bout-detail.js uses), and UPSERTS the current
// whole-fight-so-far stats into mma_stats (round_number = 0) for both
// fighters. It does NOT compute Fight Points itself — calculate-team-
// score.js / the frontend compute points on read from mma_stats, same
// as for completed fights, so a live fight's score updates for free
// the moment this writes new numbers.
//
// Supabase Realtime is enabled on mma_stats and bouts (see migration
// enable_realtime_live_scoring), so any client subscribed to those
// tables gets pushed the update within ~1 min of it happening in the
// cage, no polling needed on the frontend.
//
// Bout lifecycle this function drives:
//   scheduled -> live       (first time Cito reports fighters/stats present)
//   live      -> completed  (Cito reports a status/winner/method)
// A bout past 'completed' is skipped on future runs (nothing left to poll).
//
// ENV VARS: CITO_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js';

const CITO_BASE = 'https://api.citoapi.com/api/v1';

export default async (req, context) => {
  const CITO_API_KEY = process.env.CITO_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!CITO_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Missing env vars.' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const today = new Date().toISOString().slice(0, 10);

  const { data: bouts, error: boutsErr } = await supabase
    .from('bouts')
    .select('id, cito_bout_id, fighter_a, fighter_b, status, bout_date')
    .in('status', ['scheduled', 'live'])
    .not('cito_bout_id', 'is', null)
    .gte('bout_date', today);

  if (boutsErr) return json(500, { error: boutsErr.message });

  const summary = { checked: bouts.length, updated: 0, completed: 0, errors: [] };

  for (const bout of bouts) {
    try {
      await pollBout(bout);
    } catch (e) {
      summary.errors.push({ boutId: bout.id, message: e.message });
    }
  }

  return json(200, summary);

  async function pollBout(bout) {
    const res = await fetch(`${CITO_BASE}/ufc/bouts/${bout.cito_bout_id}`, {
      headers: { 'x-api-key': CITO_API_KEY },
    });
    if (!res.ok) throw new Error(`Cito ${res.status} for boutId ${bout.cito_bout_id}`);

    const detail = await res.json();
    const data = detail.data || detail;
    const fightersRaw = data.fighters || [];
    const roundStats = data.roundStats || data.boutStats || [];

    // IMPORTANT: Cito's Bout Detail endpoint returns fighters[] (the
    // matchup) as soon as a fight is booked — well before it starts.
    // fighters[] alone is NOT a signal the fight is happening. Only
    // roundStats[] actually having entries (or Cito's own status field
    // explicitly saying so) means strikes have actually been recorded.
    const citoStatus = (data.status || '').toLowerCase();
    const citoSaysLive = citoStatus === 'live' || citoStatus === 'in_progress' || citoStatus === 'inprogress';
    const hasRealStats = roundStats.length > 0;

    if (!hasRealStats && !citoSaysLive) {
      // Booked but not yet fought — nothing to sync, stay 'scheduled'.
      return;
    }

    if (bout.status === 'scheduled') {
      await supabase.from('bouts').update({ status: 'live', last_live_sync_at: new Date().toISOString() }).eq('id', bout.id);
    }

    const isFinal = citoStatus === 'completed' || citoStatus === 'final' || !!data.winnerFighterSlug;

    const { data: performances } = await supabase
      .from('performances')
      .select('id, fighter_id')
      .eq('bout_id', bout.id);

    const perfByFighter = new Map((performances || []).map((p) => [p.fighter_id, p.id]));

    // Match Cito's fighters[] entries to our two known fighter_ids by
    // corner (cito returns 'red'/'blue' corner, stable even before
    // name-matching) falling back to array order (A = index 0).
    const [rawA, rawB] = fightersRaw.length >= 2 ? fightersRaw : [null, null];

    const slugFor = (fighterId) => {
      if (rawA && fighterId === bout.fighter_a) return rawA.fighterSlug;
      if (rawB && fighterId === bout.fighter_b) return rawB.fighterSlug;
      return null;
    };

    let anyUpdated = false;

    for (const fighterId of [bout.fighter_a, bout.fighter_b]) {
      const performanceId = perfByFighter.get(fighterId);
      if (!performanceId) continue;

      const slug = slugFor(fighterId);
      const fighterRounds = roundStats.filter((r) => r.fighterSlug === slug);
      if (fighterRounds.length === 0) continue;

      const totals = sumRounds(fighterRounds);

      const { error: upsertErr } = await supabase
        .from('mma_stats')
        .upsert(
          { performance_id: performanceId, round_number: 0, ...totals },
          { onConflict: 'performance_id,round_number' }
        );
      if (upsertErr) throw new Error(`mma_stats upsert failed: ${upsertErr.message}`);
      anyUpdated = true;
    }

    if (anyUpdated) summary.updated++;

    if (isFinal) {
      const winnerSlug = data.winnerFighterSlug || null;
      let winnerId = null;
      if (rawA && winnerSlug === rawA.fighterSlug) winnerId = bout.fighter_a;
      else if (rawB && winnerSlug === rawB.fighterSlug) winnerId = bout.fighter_b;

      await supabase
        .from('bouts')
        .update({
          status: 'completed',
          winner_id: winnerId,
          method: data.method || null,
          end_round: data.resultRound || null,
          end_time: data.resultTime || null,
          last_live_sync_at: new Date().toISOString(),
        })
        .eq('id', bout.id);
      summary.completed++;
    } else {
      await supabase.from('bouts').update({ last_live_sync_at: new Date().toISOString() }).eq('id', bout.id);
    }
  }
};

function sumRounds(rounds) {
  const totals = {
    sig_strikes_landed: 0,
    sig_strikes_attempted: 0,
    total_strikes_landed: 0,
    head_strikes: 0,
    body_strikes: 0,
    leg_strikes: 0,
    distance_strikes: 0,
    clinch_strikes: 0,
    ground_strikes: 0,
    knockdowns: 0,
    takedowns_landed: 0,
    takedowns_attempted: 0,
    control_time_seconds: 0,
    submission_attempts: 0,
    reversals: 0,
  };
  for (const r of rounds) {
    const sig = parseXofY(r.significantStrikes);
    const td = parseXofY(r.takedowns);
    totals.sig_strikes_landed += sig.landed;
    totals.sig_strikes_attempted += sig.attempted;
    totals.total_strikes_landed += parseXofY(r.totalStrikes).landed;
    totals.head_strikes += parseXofY(r.head).landed;
    totals.body_strikes += parseXofY(r.body).landed;
    totals.leg_strikes += parseXofY(r.leg).landed;
    totals.distance_strikes += parseXofY(r.distance).landed;
    totals.clinch_strikes += parseXofY(r.clinch).landed;
    totals.ground_strikes += parseXofY(r.ground).landed;
    totals.knockdowns += r.knockdowns || 0;
    totals.takedowns_landed += td.landed;
    totals.takedowns_attempted += td.attempted;
    totals.control_time_seconds += parseControlTime(r.controlTime);
    totals.submission_attempts += r.submissionAttempts || 0;
    totals.reversals += r.reversals || 0;
  }
  return totals;
}

function parseXofY(str) {
  if (!str) return { landed: 0, attempted: 0 };
  const m = String(str).match(/(\d+)\s*of\s*(\d+)/i);
  if (!m) return { landed: 0, attempted: 0 };
  return { landed: parseInt(m[1], 10), attempted: parseInt(m[2], 10) };
}

function parseControlTime(str) {
  if (!str) return 0;
  const m = String(str).match(/(\d+):(\d+)/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
