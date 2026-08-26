// netlify/functions/sync-bout-detail.js
//
// Pulls ONE bout's full detail from Cito's /ufc/bouts/{boutId} endpoint and
// writes it across three tables:
//   1. bouts         - one row (event/result info, fighter_a, fighter_b, winner_id)
//   2. performances  - two rows, one per fighter (bout_id, fighter_id, result, method, end_round)
//   3. mma_stats     - fight-total row (round_number = null) + one row per round,
//                      for EACH fighter's performance
//
// SAFE BY DESIGN: only fighters already in your `fighters` table (matched by
// name) are written. If either fighter in the bout isn't found, the whole
// bout is skipped and logged — nothing partial gets written.
//
// COST NOTE: this hits Cito's Bout Detail endpoint, which is ONE call per bout
// (not paginated bulk like the fighter sync). Keep batches small given your
// plan's monthly call limit.
//
// ENV VARS: same as sync-fighters.js (CITO_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
//
// TRIGGER (single bout):
//   GET https://<your-site>.netlify.app/.netlify/functions/sync-bout-detail?boutId=770c5302e32916ea&dryRun=true
//
// TRIGGER (batch, comma-separated bout IDs — use sparingly, 1 Cito call each):
//   GET .../sync-bout-detail?boutIds=770c5302e32916ea,fb77b08a90b92d5b&dryRun=true

import { createClient } from '@supabase/supabase-js';

const CITO_BASE = 'https://api.citoapi.com/api/v1';

export default async (req, context) => {
  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dryRun') === 'true';

  const singleId = url.searchParams.get('boutId');
  const multiIds = url.searchParams.get('boutIds');
  const boutIds = multiIds
    ? multiIds.split(',').map((s) => s.trim()).filter(Boolean)
    : singleId
    ? [singleId]
    : [];

  if (boutIds.length === 0) {
    return json(400, { error: 'Provide ?boutId=... or ?boutIds=id1,id2,...' });
  }

  const CITO_API_KEY = process.env.CITO_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!CITO_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Missing env vars.' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Fighter lookup by normalized name (Cito's fighterName maps reasonably well
  // to your names since your roster came from the same UFC.com source Cito mirrors).
  const { data: existingFighters, error: fetchErr } = await supabase
    .from('fighters')
    .select('id, full_name');
  if (fetchErr) return json(500, { error: fetchErr.message });

  const byName = new Map();
  for (const f of existingFighters) {
    byName.set(normalize(f.full_name), f);
  }

  const summary = {
    boutIdsRequested: boutIds,
    dryRun,
    results: [],
  };

  for (const boutId of boutIds) {
    const result = { boutId };
    try {
      const detail = await fetchBoutDetail(CITO_API_KEY, boutId);

      const fightersRaw = detail.fighters || [];
      if (fightersRaw.length !== 2) {
        result.status = 'skipped';
        result.reason = `expected 2 fighters, got ${fightersRaw.length}`;
        summary.results.push(result);
        continue;
      }

      const matched = fightersRaw.map((f) => ({
        raw: f,
        fighter: byName.get(normalize(f.fighterName)),
      }));

      const unmatched = matched.filter((m) => !m.fighter).map((m) => m.raw.fighterName);
      if (unmatched.length > 0) {
        result.status = 'skipped';
        result.reason = 'fighter(s) not in your existing roster';
        result.missing = unmatched;
        summary.results.push(result);
        continue;
      }

      const [a, b] = matched;
      const winnerSlug = detail.winnerFighterSlug;
      const winnerMatch = matched.find((m) => m.raw.fighterSlug === winnerSlug);

      const { data: existingBout } = await supabase
        .from('bouts')
        .select('id')
        .eq('event_name', detail.event?.title ?? null)
        .eq('fighter_a', a.fighter.id)
        .eq('fighter_b', b.fighter.id)
        .maybeSingle();

      if (existingBout) {
        result.status = 'already_exists';
        result.boutRowId = existingBout.id;
        summary.results.push(result);
        continue;
      }

      const boutRow = {
        sport_id: 'mma',
        org_id: null,
        event_name: detail.event?.title ?? null,
        bout_date: detail.event?.eventDate ?? null,
        status: detail.status ?? 'completed',
        weight_class: detail.weightClass ?? null,
        scheduled_rounds: null,
        is_title_fight: detail.titleBout ?? false,
        fighter_a: a.fighter.id,
        fighter_b: b.fighter.id,
        winner_id: winnerMatch ? winnerMatch.fighter.id : null,
        method: detail.method ?? null,
        end_round: detail.resultRound ?? null,
        end_time: detail.resultTime ?? null,
        fotn: false,
        data_source: 'cito',
      };

      result.wouldInsert = { bout: boutRow };

      if (dryRun) {
        result.status = 'dry_run';
        summary.results.push(result);
        continue;
      }

      const { data: insertedBout, error: boutErr } = await supabase
        .from('bouts')
        .insert(boutRow)
        .select('id')
        .single();
      if (boutErr) {
        result.status = 'error';
        result.error = boutErr.message;
        summary.results.push(result);
        continue;
      }

      const boutRowId = insertedBout.id;
      result.boutRowId = boutRowId;

      const perfRows = matched.map((m) => ({
        bout_id: boutRowId,
        fighter_id: m.fighter.id,
        sport_id: 'mma',
        bout_date: detail.event?.eventDate ?? null,
        result: m.raw.outcome ?? null,
        method: detail.method ?? null,
        end_round: detail.resultRound ?? null,
      }));

      const { data: insertedPerfs, error: perfErr } = await supabase
        .from('performances')
        .insert(perfRows)
        .select('id, fighter_id');
      if (perfErr) {
        result.status = 'error';
        result.error = `performances: ${perfErr.message}`;
        summary.results.push(result);
        continue;
      }

      const perfByFighter = new Map(insertedPerfs.map((p) => [p.fighter_id, p.id]));

      const statRows = [];
      for (const m of matched) {
        const performanceId = perfByFighter.get(m.fighter.id);
        const totalRow = (detail.boutStats || []).find((s) => s.fighterSlug === m.raw.fighterSlug);
        if (totalRow) statRows.push(buildStatRow(performanceId, 0, totalRow));

        const roundRows = (detail.roundStats || []).filter((s) => s.fighterSlug === m.raw.fighterSlug);
        for (const r of roundRows) {
          statRows.push(buildStatRow(performanceId, r.round, r));
        }
      }

      if (statRows.length > 0) {
        const { error: statsErr } = await supabase.from('mma_stats').upsert(statRows, { onConflict: 'performance_id,round_number' });        if (statsErr) {
          result.status = 'error';
          result.error = `mma_stats: ${statsErr.message}`;
          summary.results.push(result);
          continue;
        }
      }

      result.status = 'inserted';
      result.statsRowsInserted = statRows.length;
      summary.results.push(result);
    } catch (err) {
      result.status = 'error';
      result.error = err.message;
      summary.results.push(result);
    }
  }

  return json(200, summary);
};

function buildStatRow(performanceId, roundNumber, raw) {
  return {
    performance_id: performanceId,
    round_number: roundNumber,
    sig_strikes_landed: landedOf(raw.significantStrikes),
    sig_strikes_attempted: attemptedOf(raw.significantStrikes),
    total_strikes_landed: landedOf(raw.totalStrikes),
    head_strikes: landedOf(raw.head),
    body_strikes: landedOf(raw.body),
    leg_strikes: landedOf(raw.leg),
    distance_strikes: landedOf(raw.distance),
    clinch_strikes: landedOf(raw.clinch),
    ground_strikes: landedOf(raw.ground),
    knockdowns: raw.knockdowns ?? null,
    takedowns_landed: landedOf(raw.takedowns),
    takedowns_attempted: attemptedOf(raw.takedowns),
    control_time_seconds: controlTimeToSeconds(raw.controlTime),
    submission_attempts: raw.submissionAttempts ?? null,
    reversals: raw.reversals ?? null,
  };
}

// "11 of 27" -> 11
function landedOf(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d+)\s+of\s+(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}
// "11 of 27" -> 27
function attemptedOf(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d+)\s+of\s+(\d+)$/);
  return m ? parseInt(m[2], 10) : null;
}
// "1:03" -> 63 (seconds)
function controlTimeToSeconds(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d+):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function normalize(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

async function fetchBoutDetail(apiKey, boutId) {
  const res = await fetch(`${CITO_BASE}/ufc/bouts/${boutId}`, {
    headers: { 'x-api-key': apiKey },
  });
  if (!res.ok) {
    throw new Error(`Cito ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  return body.data ?? body;
}

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
