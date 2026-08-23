// netlify/functions/sync-bouts.js
//
// Pulls bout/fight data from Cito's /ufc/bouts endpoint and inserts rows into
// Supabase `bouts`, matched to your EXISTING `fighters` by name.
//
// SAFE BY DESIGN: never creates a `fighters` row. If a bout references a
// fighter name not already in your table, that bout is skipped and logged
// in `skippedUnknownFighter` so you know who's missing.
//
// Also skips bouts that already exist (matched by event_name + fighter_a +
// fighter_b) so this is safe to re-run / resume across pages.
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

  // Build a normalized-name -> fighter lookup from your EXISTING fighters only.
  const { data: existingFighters, error: fetchErr } = await supabase
    .from('fighters')
    .select('id, full_name');
  if (fetchErr) return json(500, { error: fetchErr.message });

  const byName = new Map();
  for (const f of existingFighters) {
    byName.set(normalize(f.full_name), f);
  }

  // Existing bouts, for dedupe (event_name + both fighter ids).
  const { data: existingBouts, error: boutErr } = await supabase
    .from('bouts')
    .select('event_name, fighter_a, fighter_b');
  if (boutErr) return json(500, { error: boutErr.message });

  const existingBoutKeys = new Set(
    existingBouts.map((b) => boutKey(b.event_name, b.fighter_a, b.fighter_b))
  );

  const summary = {
    pagesRequested: pages,
    startPage: page,
    limit,
    dryRun,
    citoFetched: 0,
    inserted: 0,
    alreadyExists: 0,
    skippedUnknownFighter: [],
    errors: [],
    sampleRawBout: null, // first raw Cito bout object, so we can verify field names
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
      const row = mapBout(raw, byName);

      if (row.error) {
        summary.skippedUnknownFighter.push(row.error);
        continue;
      }

      const key = boutKey(row.event_name, row.fighter_a, row.fighter_b);
      if (existingBoutKeys.has(key)) {
        summary.alreadyExists++;
        continue;
      }

      if (!dryRun) {
        const { error: insertErr } = await supabase.from('bouts').insert(row);
        if (insertErr) {
          summary.errors.push({ stage: 'insert', event: row.event_name, message: insertErr.message });
          continue;
        }
      }
      existingBoutKeys.add(key);
      summary.inserted++;
    }
  }

  return json(200, summary);
};

// Try several plausible field names per value, since we haven't confirmed
// Cito's exact bout schema yet. Adjust these once sampleRawBout confirms names.
function mapBout(raw, byName) {
  const fighterAName = raw.fighterA?.name ?? raw.fighter_a_name ?? raw.redCorner ?? raw.fighter1 ?? null;
  const fighterBName = raw.fighterB?.name ?? raw.fighter_b_name ?? raw.blueCorner ?? raw.fighter2 ?? null;

  const fighterA = fighterAName ? byName.get(normalize(fighterAName)) : null;
  const fighterB = fighterBName ? byName.get(normalize(fighterBName)) : null;

  if (!fighterA || !fighterB) {
    return {
      error: {
        event: raw.eventName ?? raw.event_name ?? raw.event ?? 'unknown event',
        fighterA: fighterAName,
        fighterB: fighterBName,
        missing: [!fighterA ? fighterAName : null, !fighterB ? fighterBName : null].filter(Boolean),
      },
    };
  }

  const winnerName = raw.winner?.name ?? raw.winnerName ?? raw.winner_name ?? null;
  let winnerId = null;
  if (winnerName) {
    const wKey = normalize(winnerName);
    if (wKey === normalize(fighterAName)) winnerId = fighterA.id;
    else if (wKey === normalize(fighterBName)) winnerId = fighterB.id;
  }

  return {
    sport_id: 'mma',
    org_id: null, // UFC org UUID — fill in once you confirm your `orgs` table's UFC row id
    event_name: raw.eventName ?? raw.event_name ?? raw.event ?? null,
    bout_date: raw.date ?? raw.eventDate ?? raw.bout_date ?? null,
    status: raw.status ?? 'completed',
    weight_class: raw.weightClass ?? raw.weight_class ?? raw.division ?? null,
    scheduled_rounds: raw.scheduledRounds ?? raw.scheduled_rounds ?? null,
    is_title_fight: raw.isTitleFight ?? raw.is_title_fight ?? false,
    fighter_a: fighterA.id,
    fighter_b: fighterB.id,
    winner_id: winnerId,
    method: raw.method ?? raw.finishMethod ?? raw.result?.method ?? null,
    end_round: raw.endRound ?? raw.round ?? raw.end_round ?? null,
    end_time: raw.endTime ?? raw.time ?? raw.end_time ?? null,
    fotn: raw.fightOfTheNight ?? raw.fotn ?? false,
    data_source: 'cito',
  };
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
