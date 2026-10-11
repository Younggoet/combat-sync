// netlify/functions/repair-winners.js
//
// ONE-TIME repair: re-checks every completed bout tonight against Cito
// using the corrected name-based matching (see live-poll.js fix), and
// corrects winner_id if it was set wrong by the old rawA/rawB array-order
// bug. Only ever touches winner_id — never re-touches mma_stats (those
// were attributed correctly all along, only the winner-lookup had the bug).
//
// USAGE: /.netlify/functions/repair-winners  (GET, no params)

import { createClient } from '@supabase/supabase-js';

const CITO_BASE = 'https://api.citoapi.com/api/v1';

function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export default async (req, context) => {
  const CITO_API_KEY = process.env.CITO_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!CITO_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Missing env vars.' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: bouts, error: boutsErr } = await supabase
    .from('bouts')
    .select('id, cito_bout_id, fighter_a, fighter_b, status, winner_id, method')
    .eq('status', 'completed')
    .not('cito_bout_id', 'is', null);
  if (boutsErr) return json(500, { error: boutsErr.message });

  const fighterIds = Array.from(new Set(bouts.flatMap((b) => [b.fighter_a, b.fighter_b])));
  const { data: fighterRows } = fighterIds.length
    ? await supabase.from('fighters').select('id, full_name').in('id', fighterIds)
    : { data: [] };
  const nameById = new Map((fighterRows || []).map((f) => [f.id, f.full_name]));

  const results = [];

  for (const bout of bouts) {
    const entry = { boutId: bout.id, citoBoutId: bout.cito_bout_id, fighterA: nameById.get(bout.fighter_a), fighterB: nameById.get(bout.fighter_b) };
    try {
      const res = await fetch(`${CITO_BASE}/ufc/bouts/${bout.cito_bout_id}`, { headers: { 'x-api-key': CITO_API_KEY } });
      if (!res.ok) { entry.status = 'error'; entry.reason = `Cito ${res.status}`; results.push(entry); continue; }
      const detail = await res.json();
      const data = detail.data || detail;
      const fightersRaw = data.fighters || [];
      const winnerSlug = data.winnerFighterSlug || null;

      const matched = fightersRaw.map((f) => ({ raw: f, norm: normalizeName(f.fighterName) }));
      const matchA = matched.find((m) => m.norm === normalizeName(entry.fighterA));
      const matchB = matched.find((m) => m.norm === normalizeName(entry.fighterB));

      let correctWinnerId = null;
      if (winnerSlug && matchA && matchA.raw.fighterSlug === winnerSlug) correctWinnerId = bout.fighter_a;
      else if (winnerSlug && matchB && matchB.raw.fighterSlug === winnerSlug) correctWinnerId = bout.fighter_b;

      entry.citoWinnerSlug = winnerSlug;
      entry.storedWinnerId = bout.winner_id;
      entry.correctWinnerId = correctWinnerId;
      entry.wasWrong = bout.winner_id !== correctWinnerId;

      if (entry.wasWrong && correctWinnerId) {
        const { error: updErr } = await supabase.from('bouts').update({ winner_id: correctWinnerId }).eq('id', bout.id);
        entry.status = updErr ? 'error' : 'fixed';
        if (updErr) entry.reason = updErr.message;
      } else {
        entry.status = 'already_correct';
      }
    } catch (e) {
      entry.status = 'error';
      entry.reason = e.message;
    }
    results.push(entry);
  }

  return json(200, { checked: results.length, fixed: results.filter((r) => r.status === 'fixed').length, results });
};

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
