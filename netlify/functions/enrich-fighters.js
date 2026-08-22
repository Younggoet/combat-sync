// netlify/functions/enrich-fighters.js
//
// Enrichment-only pass: walks Cito's /ufc/fighters pages and, for any Cito fighter
// whose name matches an EXISTING row in Supabase `fighters`, fills in the metadata
// fields (team, stance, height_cm, reach_cm, photo_url, nationality).
//
// SAFE BY DESIGN: this function NEVER inserts a new row into `fighters` and NEVER
// touches `fighter_external_ids`. It only UPDATEs rows that already exist, matched
// by normalized full_name. This is the fix for the "Cito has no active/inactive
// filter" problem — since we only ever touch fighters you've already confirmed
// active (via UFC.com/roster.watch), Cito can't reintroduce junk data.
//
// ENV VARS: same as sync-fighters.js (CITO_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
//
// TRIGGER:
//   GET https://<your-site>.netlify.app/.netlify/functions/enrich-fighters?page=1&pages=2&limit=50
//
// Query params:
//   page   - which Cito page to start on (default 1)
//   pages  - how many consecutive Cito pages to walk this invocation (default 2, keep small — 30s timeout)
//   limit  - fighters per Cito page (default 50)
//   dryRun - "true" to see what WOULD update without writing anything

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

  // Pull all existing fighters once, build a normalized-name lookup map.
  const { data: existingFighters, error: fetchErr } = await supabase
    .from('fighters')
    .select('id, full_name, team, stance, height_cm, reach_cm, photo_url, nationality');

  if (fetchErr) return json(500, { error: fetchErr.message });

  const byName = new Map();
  for (const f of existingFighters) {
    byName.set(normalize(f.full_name), f);
  }

  const summary = {
    pagesRequested: pages,
    startPage: page,
    limit,
    dryRun,
    citoFetched: 0,
    matched: 0,
    updated: 0,
    alreadyFilled: 0,
    errors: [],
  };

  const matchedIds = new Set();

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

    for (const raw of batch) {
      const key = normalize(raw.name);
      const existing = byName.get(key);
      if (!existing) continue;

      summary.matched++;
      matchedIds.add(existing.id);

      const patch = buildPatch(existing, raw);
      if (Object.keys(patch).length === 0) {
        summary.alreadyFilled++;
        continue;
      }

      if (!dryRun) {
        const { error: updateErr } = await supabase
          .from('fighters')
          .update(patch)
          .eq('id', existing.id);
        if (updateErr) {
          summary.errors.push({ fighter: existing.full_name, stage: 'update', message: updateErr.message });
          continue;
        }
      }
      summary.updated++;
    }
  }

  // Report which existing fighters were never matched in the pages walked this run
  // (not necessarily "not on Cito at all" — may just be on a page outside this batch).
  summary.unmatchedThisBatch = existingFighters
    .filter((f) => !matchedIds.has(f.id))
    .map((f) => f.full_name);

  return json(200, summary);
};

// Only fill fields that are currently empty — never overwrite data you've already
// verified/entered manually.
function buildPatch(existing, raw) {
  const patch = {};
  const candidate = {
    team: raw.trainsAt ?? raw.team ?? null,
    stance: raw.stance ?? null,
    height_cm: toCm(raw.height),
    reach_cm: toCm(raw.reach),
    photo_url: raw.imageUrl ?? null,
    nationality: raw.nationality ?? raw.country ?? null,
  };
  for (const [k, v] of Object.entries(candidate)) {
    if ((existing[k] === null || existing[k] === undefined) && v !== null && v !== undefined) {
      patch[k] = v;
    }
  }
  return patch;
}

function normalize(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]/g, ''); // strip spaces, hyphens, periods, apostrophes
}

async function fetchCitoPage(apiKey, page, limit) {
  const res = await fetch(`${CITO_BASE}/ufc/fighters?page=${page}&limit=${limit}`, {
    headers: { 'x-api-key': apiKey },
  });
  if (!res.ok) {
    throw new Error(`Cito ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  return Array.isArray(body) ? body : body.data;
}

function toCm(inches) {
  if (inches === null || inches === undefined) return null;
  const n = Number(inches);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 2.54 * 10) / 10;
}

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
