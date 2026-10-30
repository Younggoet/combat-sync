// netlify/functions/link-card-bouts.js
//
// Makes an ALREADY-LOADED card live-scorable. Finds bouts on ?date=YYYY-MM-DD
// that have no cito_bout_id, looks up each bout's Cito id through fighter A's
// fight list (matched on the opponent), saves it on the bout, and makes sure
// both fighters have a performance row. It never inserts or deletes bouts.
// live-poll.js (every minute) then picks the bouts up on fight night.
//
// USAGE: /.netlify/functions/link-card-bouts?date=2026-10-31   (add &dryRun=true to only look)
import { createClient } from '@supabase/supabase-js';

const BASE = 'https://api.citoapi.com/api/v1';
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const cito = async (p) => {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(BASE + p, { headers: { 'x-api-key': process.env.CITO_API_KEY } });
    if (r.status === 429) { await new Promise((z) => setTimeout(z, 1200 * (i + 1))); continue; }
    if (!r.ok) throw new Error(`Cito ${p} -> ${r.status}`);
    return r.json();
  }
  throw new Error(`Cito ${p} -> 429`);
};
const arr = (x, keys) => Array.isArray(x) ? x : (keys.map((k) => x?.[k] || x?.data?.[k]).find(Array.isArray) || (Array.isArray(x?.data) ? x.data : []));
const json = (s, b) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { 'Content-Type': 'application/json' } });

export default async (req) => {
  const u = new URL(req.url);
  const date = u.searchParams.get('date');
  const dry = u.searchParams.get('dryRun') === 'true';
  if (!date) return json(400, { error: 'Add ?date=YYYY-MM-DD' });
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: bouts, error } = await sb.from('bouts').select('id,fighter_a,fighter_b,bout_date,cito_bout_id').eq('bout_date', date);
  if (error) return json(500, { error: error.message });
  const ids = [...new Set(bouts.flatMap((b) => [b.fighter_a, b.fighter_b]))];
  const { data: fs } = await sb.from('fighters').select('id,full_name').in('id', ids);
  const name = new Map((fs || []).map((f) => [f.id, f.full_name]));

  const out = [];
  const work = async (b) => {
    const A = name.get(b.fighter_a), B = name.get(b.fighter_b), r = { bout: `${A} vs ${B}` };
    try {
      if (!b.cito_bout_id) {
        const sr = arr(await cito(`/ufc/search?q=${encodeURIComponent(A)}`), ['fighters', 'results']);
        const m = sr.find((x) => norm(x.fighterName || x.name) === norm(A)) || sr[0];
        const slug = m && (m.slug || m.fighterSlug);
        if (!slug) throw new Error('fighter A not found on Cito');
        const list = arr(await cito(`/ufc/fighters/${slug}/fights`), ['fights']);
        const f = list.find((x) => norm(x.opponent?.name || x.opponentName || x.opponent?.fighterName || '').includes(norm(B).slice(0, 6)));
        if (!f) throw new Error('no fight vs opponent in Cito list');
        const id = f.bout?.dataId || f.bout?.id || f.boutId || f.bout_id || f.dataId || f.id || f.fightId;
        if (!id) throw new Error('no bout id on matched fight');
        r.citoBoutId = String(id);
        if (!dry) await sb.from('bouts').update({ cito_bout_id: String(id), data_source: 'cito' }).eq('id', b.id);
      } else r.citoBoutId = b.cito_bout_id;
      if (!dry) for (const fid of [b.fighter_a, b.fighter_b]) {
        const { data: p } = await sb.from('performances').select('id').eq('bout_id', b.id).eq('fighter_id', fid).maybeSingle();
        if (!p) await sb.from('performances').insert({ bout_id: b.id, fighter_id: fid, sport_id: 'mma', bout_date: date });
      }
      r.status = dry ? 'would link' : 'linked';
    } catch (e) { r.status = 'error'; r.reason = e.message; }
    out.push(r);
  };
  for (let i = 0; i < bouts.length; i += 3) await Promise.all(bouts.slice(i, i + 3).map(work));
  return json(200, { date, total: bouts.length, linked: out.filter((x) => x.status === 'linked' || x.status === 'would link').length, results: out });
};
