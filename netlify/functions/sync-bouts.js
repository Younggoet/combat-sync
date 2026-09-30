// netlify/functions/sync-bouts.js
//
// Pulls bout data from Cito's /ufc/bouts endpoint and writes THREE things
// to Supabase for each completed bout it can match to your roster:
//   1. `bouts`        — event/date/winner/method (as before)
//   2. `performances` — one row per fighter per bout (result, method, etc.)
//   3. `mma_stats`    — one row per fighter PER ROUND, plus a round_number = 0
//                       row holding that fighter's WHOLE-FIGHT totals (summed
//                       across rounds). calculate-team-score.js and scoring.js
//                       both read the round_number = 0 row.
//
// REWRITE NOTE (2026-09-29): the previous version of this file guessed at
// field names (raw.fighterA, raw.redCorner, etc.) that don't exist in Cito's
// actual response shape. The real shape is:
//   raw.fighters[]    — { fighterName, fighterSlug, corner, outcome, ... }
//   raw.roundStats[]  — { fighterSlug, round, knockdowns, significantStrikes:
//                         "38 of 65", takedowns: "2 of 4", controlTime: "2:11",
//                         totalStrikes, head, body, leg, distance, clinch,
//                         ground, submissionAttempts, reversals }
// Both fighter name/slug matching AND all the stat numbers come from THIS
// SAME bulk /ufc/bouts response — no per-bout detail call needed.
//
// SAFE BY DESIGN: never creates a `fighters` row. A bout with an unmatched
// fighter name is skipped and logged in `skippedUnknownFighter`. Bouts,
// performances, and mma_stats are all deduped against what's already in
// Supabase, so this is safe to re-run / resume across pages.
//
// ENV VARS: same as sync-fighters.js (CITO_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
//
// TRIGGER:
//   GET https://<your-site>.netlify.app/.netlify/functions/sync-bouts?page=1&pages=2&limit=50&dryRun=true
//
// Query params:
//   page   - which Cito page to start on (default 1)
//   pages  - how many consecutive Cito pages to walk this invocation (default 2)
//   limit  - bouts per Cito page (default 50)
//   dryRun - "true" to see what WOULD insert without writing anything

import { createClient } from '@supabase/supabase-js';

const CITO_BASE = 'https://api.citoapi.com/api/v1';

export default async (req, context) => {
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const pages = parseInt(url.searchParams.get('pages') || '2', 10);
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);
  const dryRun = url.searchParams.get('dryRun') === 'true';

  const CITO_API_KEY = process.env.CITO_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!CITO_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Missing env vars.' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ---- Preload everything we need to dedupe against ----

  const { data: existingFighters, error: fightersErr } = await supabase
    .from('fighters')
    .select('id, full_name');
  if (fightersErr) return json(500, { error: fightersErr.message });

  const byName = new Map();
  for (const f of existingFighters) {
    byName.set(normalize(f.full_name), f);
  }

  const { data: existingBouts, error: boutsErr } = await supabase
    .from('bouts')
    .select('id, event_name, fighter_a, fighter_b');
  if (boutsErr) return json(500, { error: boutsErr.message });

  const boutIdByKey = new Map();
  for (const b of existingBouts) {
    boutIdByKey.set(boutKey(b.event_name, b.fighter_a, b.fighter_b), b.id);
  }

  const { data: existingPerformances, error: perfErr } = await supabase
    .from('performances')
    .select('id, bout_id, fighter_id');
  if (perfErr) return json(500, { error: perfErr.message });

  const perfIdByKey = new Map();
  for (const p of existingPerformances) {
    perfIdByKey.set(`${p.bout_id}::${p.fighter_id}`, p.id);
  }

  const { data: existingStats, error: statsErr } = await supabase
    .from('mma_stats')
    .select('performance_id, round_number');
  if (statsErr) return json(500, { error: statsErr.message });

  const existingStatKeys = new Set(
    existingStats.map((s) => `${s.performance_id}::${s.round_number}`)
  );

  const summary = {
    pagesRequested: pages,
    startPage: page,
    limit,
    dryRun,
    citoFetched: 0,
    boutsInserted: 0,
    boutsAlreadyExisted: 0,
    performancesInserted: 0,
    statRowsInserted: 0,
    skippedUnknownFighter: [],
    skippedNoRoundStats: [],
    errors: [],
    sampleRawBout: null,
  };

  for (let p = page; p < page + pages; p++) {
    let batch;
    try {
      batch = await fetchCitoPage(CITO_API_KEY, p, limit);
    } catch (err) {
      summary.errors.push({ page: p, stage: 'fetch', message: err.message });
      break;
    }

    if (!batch || batch.length === 0) {
      summary.errors.push({ page: p, stage: 'fetch', message: 'empty page — likely past the end of the list' });
      break;
    }

    summary.citoFetched += batch.length;
    if (!summary.sampleRawBout) summary.sampleRawBout = batch[0];

    for (const raw of batch) {
      await processBout(raw);
    }
  }

  return json(200, summary);

  // ---- Per-bout processing ----

  async function processBout(raw) {
    const fightersRaw = raw.fighters || [];
    if (fightersRaw.length < 2) return;

    const [rawA, rawB] = fightersRaw;
    const fighterA = byName.get(normalize(rawA.fighterName));
    const fighterB = byName.get(normalize(rawB.fighterName));

    if (!fighterA || !fighterB) {
      summary.skippedUnknownFighter.push({
        event: raw.event?.title ?? 'unknown event',
        fighterA: rawA.fighterName,
        fighterB: rawB.fighterName,
        missing: [!fighterA ? rawA.fighterName : null, !fighterB ? rawB.fighterName : null].filter(Boolean),
      });
      return;
    }

    const eventName = raw.event?.title ?? null;
    const boutDate = raw.eventDate ?? raw.event?.eventDate ?? null;
    const key = boutKey(eventName, fighterA.id, fighterB.id);

    let boutId = boutIdByKey.get(key);

    if (!boutId) {
      const winnerSlug = raw.winnerFighterSlug ?? null;
      let winnerId = null;
      if (winnerSlug === rawA.fighterSlug) winnerId = fighterA.id;
      else if (winnerSlug === rawB.fighterSlug) winnerId = fighterB.id;

      const boutRow = {
        sport_id: 'mma',
        org_id: null,
        event_name: eventName,
        bout_date: boutDate,
        status: raw.status ?? 'completed',
        weight_class: raw.weightClass ?? null,
        scheduled_rounds: null,
        is_title_fight: raw.titleBout ?? false,
        fighter_a: fighterA.id,
        fighter_b: fighterB.id,
        winner_id: winnerId,
        method: raw.method ?? null,
        end_round: raw.resultRound ?? null,
        end_time: raw.resultTime ?? null,
        fotn: false,
        data_source: 'cito',
      };

      if (dryRun) {
        summary.boutsInserted++;
        boutId = 'DRY_RUN_BOUT_ID';
      } else {
        const { data: inserted, error: insertErr } = await supabase
          .from('bouts')
          .insert(boutRow)
          .select('id')
          .single();
        if (insertErr) {
          summary.errors.push({ stage: 'insert_bout', event: eventName, message: insertErr.message });
          return;
        }
        boutId = inserted.id;
        boutIdByKey.set(key, boutId);
        summary.boutsInserted++;
      }
    } else {
      summary.boutsAlreadyExisted++;
    }

    // ---- Performances + stats for each fighter ----
    const roundStats = raw.roundStats || [];
    if (roundStats.length === 0) {
      summary.skippedNoRoundStats.push(eventName ?? 'unknown event');
    }

    await processFighterSide(boutId, fighterA, rawA, roundStats, boutDate);
    await processFighterSide(boutId, fighterB, rawB, roundStats, boutDate);
  }

  async function processFighterSide(boutId, fighter, rawFighter, roundStats, boutDate) {
    const perfKey = `${boutId}::${fighter.id}`;
    let performanceId = perfIdByKey.get(perfKey);

    if (!performanceId) {
      const performanceRow = {
        bout_id: boutId,
        fighter_id: fighter.id,
        sport_id: 'mma',
        bout_date: boutDate,
        result: outcomeFor(rawFighter),
        method: null,
        end_round: null,
      };

      if (dryRun) {
        summary.performancesInserted++;
        performanceId = 'DRY_RUN_PERF_ID';
      } else {
        const { data: inserted, error: insertErr } = await supabase
          .from('performances')
          .insert(performanceRow)
          .select('id')
          .single();
        if (insertErr) {
          summary.errors.push({ stage: 'insert_performance', fighter: fighter.full_name, message: insertErr.message });
          return;
        }
        performanceId = inserted.id;
        perfIdByKey.set(perfKey, performanceId);
        summary.performancesInserted++;
      }
    }

    const fighterRounds = roundStats.filter((r) => r.fighterSlug === rawFighter.fighterSlug);
    if (fighterRounds.length === 0) return;

    const statRows = [];
    const totals = blankStatTotals();

    for (const r of fighterRounds) {
      const sig = parseXofY(r.significantStrikes);
      const td = parseXofY(r.takedowns);
      const controlSeconds = parseControlTime(r.controlTime);
      const row = {
        performance_id: performanceId,
        round_number: r.round,
        sig_strikes_landed: sig.landed,
        sig_strikes_attempted: sig.attempted,
        total_strikes_landed: parseXofY(r.totalStrikes).landed,
        head_strikes: parseXofY(r.head).landed,
        body_strikes: parseXofY(r.body).landed,
        leg_strikes: parseXofY(r.leg).landed,
        distance_strikes: parseXofY(r.distance).landed,
        clinch_strikes: parseXofY(r.clinch).landed,
        ground_strikes: parseXofY(r.ground).landed,
        knockdowns: r.knockdowns ?? 0,
        takedowns_landed: td.landed,
        takedowns_attempted: td.attempted,
        control_time_seconds: controlSeconds,
        submission_attempts: r.submissionAttempts ?? 0,
        reversals: r.reversals ?? 0,
      };

      addToTotals(totals, row);

      const rowKey = `${performanceId}::${row.round_number}`;
      if (!existingStatKeys.has(rowKey)) {
        statRows.push(row);
        existingStatKeys.add(rowKey);
      }
    }

    // Whole-fight totals row (round_number = 0), per scoring.js convention
    const totalKey = `${performanceId}::0`;
    if (!existingStatKeys.has(totalKey)) {
      statRows.push({ performance_id: performanceId, round_number: 0, ...totals });
      existingStatKeys.add(totalKey);
    }

    if (statRows.length === 0) return;

    if (dryRun) {
      summary.statRowsInserted += statRows.length;
      return;
    }

    const { error: statsInsertErr } = await supabase.from('mma_stats').insert(statRows);
    if (statsInsertErr) {
      summary.errors.push({ stage: 'insert_mma_stats', fighter: fighter.full_name, message: statsInsertErr.message });
      return;
    }
    summary.statRowsInserted += statRows.length;
  }
};

function outcomeFor(rawFighter) {
  if (!rawFighter.outcome) return null;
  return String(rawFighter.outcome).toLowerCase();
}

function blankStatTotals() {
  return {
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
}

function addToTotals(totals, row) {
  for (const key of Object.keys(totals)) {
    totals[key] += row[key] || 0;
  }
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

function boutKey(eventName, fighterA, fighterB) {
  return `${eventName}::${fighterA}::${fighterB}`;
}

function normalize(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

async function fetchCitoPage(apiKey, page, limit) {
  const res = await fetch(`${CITO_BASE}/ufc/bouts?page=${page}&limit=${limit}&hasStats=true&includeStats=true`, {
    headers: { 'x-api-key': apiKey },
  });
  if (!res.ok) {
    throw new Error(`Cito ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  return Array.isArray(body) ? body : body.data;
}

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
