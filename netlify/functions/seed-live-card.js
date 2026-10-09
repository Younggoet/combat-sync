// netlify/functions/seed-live-card.js
//
// One-time (per event) setup for live scoring: given a list of
// {fighterA, fighterB} name pairs for an upcoming card, finds each
// bout's Cito boutId (via /ufc/fighters/{slug}/fights, matched to the
// opponent) and upserts a `bouts` row with status='scheduled' plus the
// cito_bout_id column, so live-poll.js knows what to poll once the
// card starts. Also creates empty `performances` rows for both
// fighters (no stats yet — live-poll.js fills mma_stats as the fight
// happens).
//
// Run this ONCE, well before the card starts (today, for tomorrow's
// card). Safe to re-run — everything is upserted by cito_bout_id /
// bout_id+fighter_id, so running it twice just confirms the same rows.
//
// ENV VARS: CITO_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// USAGE:
//   GET /.netlify/functions/seed-live-card?event=UFC%20Fight%20Night%3A%20Allen%20vs%20Duncan&date=2026-10-10
//   Body/pairs are hardcoded below for tonight's card — edit CARD_PAIRS
//   for a future event, or extend to take pairs via query param later.

import { createClient } from '@supabase/supabase-js';

const CITO_BASE = 'https://api.citoapi.com/api/v1';

// Tonight's full card (Allen vs Duncan, Oct 10 2026) — same pairing
// list as the Face-Off Card Draft mockup's BOUTS array.
const CARD_PAIRS = [
  ['Brendan Allen', 'Christian Leroy Duncan'],
  ['Matheus Camilo', 'Jai Herbert'],
  ['Loopy Godinez', 'Ketlen Souza'],
  ['Andre Fili', 'Kai Kamaka III'],
  ['Julius Walker', 'Gerald Meerschaert'],
  ['Malcolm Wellmaker', 'Otari Tanzilovi'],
  ['Francisco Prado', 'Ismael Bonfim'],
  ['Niko Price', 'Leon Shahbazyan'],
  ['Felipe Franco', 'Brendson Ribeiro'],
  ['Allen Frye Jr', 'RJ Harris'],
  ['Alice Pereira', 'Daria Zhelezniakova'],
  ['Ernesta Kareckaite', 'Melissa Gatto'],
];

async function citoFetch(path) {
  const res = await fetch(`${CITO_BASE}${path}`, {
    headers: { 'x-api-key': process.env.CITO_API_KEY },
  });
  if (!res.ok) throw new Error(`Cito ${path} -> ${res.status}`);
  return res.json();
}

function normalize(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function extractMatches(searchResults) {
  return Array.isArray(searchResults)
    ? searchResults
    : Array.isArray(searchResults.fighters)
      ? searchResults.fighters
      : Array.isArray(searchResults.data)
        ? searchResults.data
        : Array.isArray(searchResults.data?.fighters)
          ? searchResults.data.fighters
          : Array.isArray(searchResults.results)
            ? searchResults.results
            : [];
}

function extractFightList(fightsResponse) {
  return Array.isArray(fightsResponse)
    ? fightsResponse
    : Array.isArray(fightsResponse.fights)
      ? fightsResponse.fights
      : Array.isArray(fightsResponse.data)
        ? fightsResponse.data
        : Array.isArray(fightsResponse.data?.fights)
          ? fightsResponse.data.fights
          : [];
}

function pickBoutId(fightEntry) {
  return (
    fightEntry.boutId ||
    fightEntry.bout_id ||
    fightEntry.id ||
    fightEntry.fightId ||
    fightEntry.matchId ||
    null
  );
}

export default async (req, context) => {
  const CITO_API_KEY = process.env.CITO_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!CITO_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Missing env vars.' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: fighters, error: fErr } = await supabase
    .from('fighters')
    .select('id, full_name');
  if (fErr) return json(500, { error: fErr.message });

  const byName = new Map();
  for (const f of fighters) byName.set(normalize(f.full_name), f);

  const results = [];

  for (const [nameA, nameB] of CARD_PAIRS) {
    const result = { pair: [nameA, nameB] };
    try {
      const fighterA = byName.get(normalize(nameA));
      const fighterB = byName.get(normalize(nameB));
      if (!fighterA || !fighterB) {
        result.status = 'skipped';
        result.reason = `not in roster: ${[!fighterA ? nameA : null, !fighterB ? nameB : null].filter(Boolean).join(', ')}`;
        results.push(result);
        continue;
      }

      // Search Cito for fighter A, get their slug, then their fight list
      const searchRes = await citoFetch(`/ufc/search?q=${encodeURIComponent(nameA)}`);
      const matches = extractMatches(searchRes);
      const citoMatch = matches.find((m) => normalize(m.fighterName || m.name) === normalize(nameA)) || matches[0];

      if (!citoMatch) {
        result.status = 'error';
        result.reason = 'no Cito search match for fighter A';
        results.push(result);
        continue;
      }

      const slug = citoMatch.slug || citoMatch.fighterSlug;
      const fightsRes = await citoFetch(`/ufc/fighters/${slug}/fights`);
      const fightList = extractFightList(fightsRes);

      const targetFight = fightList.find((f) => {
        const opponentName = f.opponentName || f.opponent?.fighterName || f.fighterBName || '';
        return normalize(opponentName).includes(normalize(nameB).slice(0, 6));
      });

      if (!targetFight) {
        result.status = 'not_found';
        result.reason = 'no matching upcoming fight in Cito fight list vs opponent';
        result.sampleFightListEntry = fightList[0] || null;
        results.push(result);
        continue;
      }

      const citoBoutId = pickBoutId(targetFight);
      const eventName = targetFight.event?.title || targetFight.eventName || 'UFC Fight Night: Allen vs Duncan';
      const boutDate = targetFight.eventDate || targetFight.event?.eventDate || '2026-10-10';

      if (!citoBoutId) {
        result.status = 'error';
        result.reason = 'matched fight but could not find a boutId field on it';
        result.rawMatchedFight = targetFight;
        results.push(result);
        continue;
      }

      // Upsert the bout row
      const { data: existing } = await supabase
        .from('bouts')
        .select('id')
        .eq('cito_bout_id', String(citoBoutId))
        .maybeSingle();

      let boutRowId = existing?.id;

      if (!boutRowId) {
        const { data: inserted, error: insErr } = await supabase
          .from('bouts')
          .insert({
            sport_id: 'mma',
            event_name: eventName,
            bout_date: boutDate,
            status: 'scheduled',
            fighter_a: fighterA.id,
            fighter_b: fighterB.id,
            cito_bout_id: String(citoBoutId),
            data_source: 'cito',
          })
          .select('id')
          .single();
        if (insErr) {
          result.status = 'error';
          result.reason = `insert bout failed: ${insErr.message}`;
          results.push(result);
          continue;
        }
        boutRowId = inserted.id;
      }

      // Upsert empty performance rows for both fighters so live-poll.js
      // has somewhere to attach mma_stats once the fight starts.
      for (const fighter of [fighterA, fighterB]) {
        const { data: existingPerf } = await supabase
          .from('performances')
          .select('id')
          .eq('bout_id', boutRowId)
          .eq('fighter_id', fighter.id)
          .maybeSingle();

        if (!existingPerf) {
          await supabase.from('performances').insert({
            bout_id: boutRowId,
            fighter_id: fighter.id,
            sport_id: 'mma',
            bout_date: boutDate,
          });
        }
      }

      result.status = 'seeded';
      result.boutRowId = boutRowId;
      result.citoBoutId = citoBoutId;
      results.push(result);
    } catch (e) {
      result.status = 'error';
      result.reason = e.message;
      results.push(result);
    }
  }

  return json(200, { results });
};

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
