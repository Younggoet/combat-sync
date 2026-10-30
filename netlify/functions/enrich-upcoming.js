// netlify/functions/enrich-upcoming.js
// Looks up each fighter on an upcoming card directly in Cito (/ufc/fighters/{slug}) and fills
// record, nationality, date_of_birth, height_cm, reach_cm, stance, team. Existing rows only.
//   ?dryRun=true  -> report only      ?all=true -> every fighter (may time out)
//   ?offset=0&n=60 -> process a slice
import { createClient } from '@supabase/supabase-js';

const BASE = 'https://api.citoapi.com/api/v1';
const slugify = (n) => (n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['.]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const num = (v) => (v === null || v === undefined || v === '' || isNaN(+v) ? null : +v);
const ALIAS = { USA: 'United States', 'United States of America': 'United States', 'Russian Federation': 'Russia' };

export default async (req) => {
  const u = new URL(req.url);
  const dryRun = u.searchParams.get('dryRun') === 'true';
  const all = u.searchParams.get('all') === 'true';
  const offset = parseInt(u.searchParams.get('offset') || '0', 10);
  const n = parseInt(u.searchParams.get('n') || '120', 10);
  const { CITO_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!CITO_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: 'Missing env vars.' });
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let ids = null;
  if (!all) {
    const { data: bs } = await sb.from('bouts').select('fighter_a, fighter_b').eq('status', 'scheduled').gte('bout_date', new Date().toISOString().slice(0, 10));
    ids = new Set((bs || []).flatMap((b) => [b.fighter_a, b.fighter_b]).filter(Boolean));
  }
  const { data: fs0, error } = await sb.from('fighters').select('id, full_name, nationality, date_of_birth, height_cm, reach_cm, stance, team, record_source, age_years');
  if (error) return json(500, { error: error.message });
  const fs = fs0.filter((f) => !ids || ids.has(f.id)).slice(offset, offset + n);

  const out = { fighters: fs.length, found: 0, updated: 0, filled: {}, notFound: [], errors: [], sample: null };
  const get = async (slug) => {
    const r = await fetch(`${BASE}/ufc/fighters/${slug}`, { headers: { 'x-api-key': CITO_API_KEY } });
    if (!r.ok) return { status: r.status };
    const b = await r.json();
    return { data: b && b.data && !Array.isArray(b.data) ? b.data : b };
  };

  await Promise.all(fs.map(async (f) => {
    try {
      const res = await get(slugify(f.full_name));
      if (!res.data || res.status) { out.notFound.push(f.full_name + (res.status ? ' (' + res.status + ')' : '')); return; }
      const c = res.data;
      if (!out.sample) out.sample = { name: c.name, country: c.country, age: c.age, placeOfBirth: c.placeOfBirth, birthDate: c.birthDate, heightInches: c.heightInches, reachInches: c.reachInches, stance: c.stance, recordText: c.recordText, trainsAt: c.trainsAt };
      out.found++;
      const patch = {};
      if (!f.nationality && c.country) patch.nationality = ALIAS[c.country] || c.country;
      if (!f.date_of_birth && c.birthDate) { const d = new Date(c.birthDate); if (!isNaN(d)) patch.date_of_birth = d.toISOString().slice(0, 10); }
      const ag = num(c.age);
      if (!f.date_of_birth && !patch.date_of_birth && ag && ag > 15 && ag < 60) { patch.age_years = ag; patch.age_as_of = new Date().toISOString().slice(0, 10); }
      if (!f.nationality && !patch.nationality && c.placeOfBirth) { const seg = String(c.placeOfBirth).split(',').pop().trim(); if (seg) patch.nationality = ALIAS[seg] || seg; }
      if (!f.height_cm && num(c.heightInches)) patch.height_cm = Math.round(c.heightInches * 2.54 * 10) / 10;
      if (!f.reach_cm && num(c.reachInches)) patch.reach_cm = Math.round(c.reachInches * 2.54 * 10) / 10;
      if (!f.stance && c.stance) patch.stance = c.stance;
      if (!f.team && c.trainsAt) patch.team = c.trainsAt;
      const w = num(c.recordWins), l = num(c.recordLosses);
      if (w !== null && l !== null) Object.assign(patch, { pro_wins: w, pro_losses: l, pro_draws: num(c.recordDraws) || 0, pro_nc: num(c.recordNoContest) || 0, record_source: 'cito' });
      if (!Object.keys(patch).length) return;
      if (!dryRun) {
        const { error: e } = await sb.from('fighters').update(patch).eq('id', f.id);
        if (e) { out.errors.push(f.full_name + ': ' + e.message); return; }
      }
      out.updated++;
      for (const k of Object.keys(patch)) out.filled[k] = (out.filled[k] || 0) + 1;
    } catch (e) { out.errors.push(f.full_name + ': ' + e.message); }
  }));
  return json(200, out);
};

function json(s, b) { return new Response(JSON.stringify(b, null, 2), { status: s, headers: { 'Content-Type': 'application/json' } }); }
