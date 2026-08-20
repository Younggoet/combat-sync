// netlify/functions/sync-fighters.js
//
// Manual-trigger sync: Cito API (/ufc/fighters) -> Supabase (fighters + fighter_external_ids).
// This is "Option B" from the handoff doc — you call it by hand (or via curl/browser)
// a page at a time. Once it's proven on ~50 fighters, wrap it in a scheduled function
// (Option A) with zero changes to the logic below.
//
// ENV VARS (set in Netlify UI -> Site settings -> Environment variables, NEVER in code):
//   CITO_API_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   <- service_role, NOT the publishable key. Server-side only.
//
// TRIGGER (after deploy):
//   GET https://<your-site>.netlify.app/.netlify/functions/sync-fighters?page=1&limit=50
//
// Query params:
//   page   - which Cito page to fetch (default 1)
//   pages  - how many consecutive pages to walk in this one invocation (default 1)
//   limit  - fighters per page from Cito (default 50, matches their docs example)
//   dryRun - "true" to fetch + map but skip writing to Supabase (sanity check first run)

import { createClient } from '@supabase/supabase-js';

const CITO_BASE = 'https://api.citoapi.com/api/v1';

export default async (req, context) => {
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const pages = parseInt(url.searchParams.get('pages') || '1', 10);
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);
  const dryRun = url.searchParams.get('dryRun') === 'true';

  const CITO_API_KEY = process.env.CITO_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!CITO_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, {
      error: 'Missing env vars. Need CITO_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY set in Netlify.',
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const summary = {
    pagesRequested: pages,
    startPage: page,
    limit,
    dryRun,
    fetched: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
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

    summary.fetched += batch.length;

    for (const raw of batch) {
      try {
        const result = await upsertFighter(supabase, raw, dryRun);
        if (result === 'created') summary.created++;
        else if (result === 'updated') summary.updated++;
        else summary.skipped++;
      } catch (err) {
        summary.errors.push({ page: p, slug: raw?.slug, stage: 'upsert', message: err.message });
      }
    }
  }

  return json(200, summary);
};

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

async function upsertFighter(supabase, raw, dryRun) {
  const fighterRow = {
    full_name: raw.name ?? null,
    nickname: raw.nickname ?? null,
    team: raw.trainsAt ?? raw.team ?? null,
    height_cm: toCm(raw.height),
    reach_cm: toCm(raw.reach),
    stance: raw.stance ?? null,
    photo_url: raw.imageUrl ?? null,
    nationality: raw.nationality ?? raw.country ?? null,
    primary_sport: 'mma',
  };
  Object.keys(fighterRow).forEach((k) => fighterRow[k] === null && delete fighterRow[k]);

  const externalId = raw.slug;
  if (!externalId) return 'skipped';

  const { data: existingLink, error: lookupErr } = await supabase
    .from('fighter_external_ids')
    .select('fighter_id')
    .eq('source', 'cito')
    .eq('external_id', externalId)
    .maybeSingle();

  if (lookupErr) throw lookupErr;

  if (existingLink) {
    if (dryRun) return 'updated';
    const { error: updateErr } = await supabase
      .from('fighters')
      .update(fighterRow)
      .eq('id', existingLink.fighter_id);
    if (updateErr) throw updateErr;
    return 'updated';
  }

  if (dryRun) return 'created';

  const { data: newFighter, error: insertErr } = await supabase
    .from('fighters')
    .insert(fighterRow)
    .select('id')
    .single();
  if (insertErr) throw insertErr;

  const { error: linkErr } = await supabase.from('fighter_external_ids').insert({
    fighter_id: newFighter.id,
    source: 'cito',
    external_id: externalId,
  });
  if (linkErr) throw linkErr;

  return 'created';
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
