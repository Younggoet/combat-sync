// netlify/functions/enrich-wikidata.js
// Fills NULL nationality, date_of_birth and height_cm on EXISTING fighters from Wikidata
// (public, no API key). Matches by normalized full name. Never inserts rows, never overwrites.
//   GET /.netlify/functions/enrich-wikidata            -> writes
//   GET /.netlify/functions/enrich-wikidata?dryRun=true -> report only
import { createClient } from '@supabase/supabase-js';

const q = (names) => `SELECT ?l ?cl ?dob ?h ?hu WHERE {
  VALUES ?l { ${names.map((n) => JSON.stringify(n) + '@en').join(' ')} }
  ?p rdfs:label ?l . ?p wdt:P106 wd:Q11607585 .
  OPTIONAL { ?p wdt:P27 ?c . ?c rdfs:label ?cl . FILTER(LANG(?cl)="en") }
  OPTIONAL { ?p wdt:P569 ?dob }
  OPTIONAL { ?p p:P2048 [ psv:P2048 [ wikibase:quantityAmount ?h ; wikibase:quantityUnit ?hu ] ] }
}`;
const ALIAS = { 'United States of America': 'United States', 'Russian Federation': 'Russia', "People's Republic of China": 'China', 'Republic of Ireland': 'Ireland', 'Kingdom of the Netherlands': 'Netherlands', 'Czech Republic': 'Czechia' };

const norm = (n) => (n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

export default async (req) => {
  const dryRun = new URL(req.url).searchParams.get('dryRun') === 'true';
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: 'Missing env vars.' });
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const all = new URL(req.url).searchParams.get('all') === 'true';
  let ids = null;
  if (!all) {
    const { data: bs } = await sb.from('bouts').select('fighter_a, fighter_b').eq('status', 'scheduled').gte('bout_date', new Date().toISOString().slice(0, 10));
    ids = new Set((bs || []).flatMap((b) => [b.fighter_a, b.fighter_b]).filter(Boolean));
  }
  const { data: fs0, error } = await sb.from('fighters').select('id, full_name, nationality, date_of_birth, height_cm');
  if (error) return json(500, { error: error.message });
  const fs = fs0.filter((f) => (!ids || ids.has(f.id)) && (!f.nationality || !f.date_of_birth || !f.height_cm));

  const out = { needing: fs.length, matched: 0, updated: 0, filled: { nationality: 0, date_of_birth: 0, height_cm: 0 }, notFound: [], errors: [] };
  const wd = new Map();
  const names = [...new Set(fs.map((f) => f.full_name))];
  const chunks = [];
  for (let i = 0; i < names.length; i += 25) chunks.push(names.slice(i, i + 25));
  await Promise.all(chunks.map(async (ch) => {
    try {
      const r = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q(ch)), {
        headers: { 'User-Agent': 'combat-app-enrich/1.0 (fantasy app)', Accept: 'application/sparql-results+json' },
      });
      if (!r.ok) { out.errors.push('wikidata ' + r.status); return; }
      for (const b of (await r.json()).results.bindings) {
        const k = norm(b.l.value);
        const o = wd.get(k) || {};
        if (b.cl && !o.nat) o.nat = ALIAS[b.cl.value] || b.cl.value;
        if (b.dob && !o.dob) { const d = new Date(b.dob.value); if (!isNaN(d) && d.getUTCFullYear() > 1940) o.dob = d.toISOString().slice(0, 10); }
        if (b.h && !o.h) {
          const v = parseFloat(b.h.value), u = b.hu ? b.hu.value : '';
          const cm = /Q174728/.test(u) ? v : /Q11573/.test(u) ? v * 100 : /Q218593/.test(u) ? v * 2.54 : v > 3 ? v : v * 100;
          if (cm > 120 && cm < 240) o.h = Math.round(cm * 10) / 10;
        }
        wd.set(k, o);
      }
    } catch (e) { out.errors.push(e.message); }
  }));

  await Promise.all(fs.map(async (f) => {
    const o = wd.get(norm(f.full_name));
    if (!o) { out.notFound.push(f.full_name); return; }
    out.matched++;
    const patch = {};
    if (!f.nationality && o.nat) patch.nationality = o.nat;
    if (!f.date_of_birth && o.dob) patch.date_of_birth = o.dob;
    if (!f.height_cm && o.h) patch.height_cm = o.h;
    if (!Object.keys(patch).length) return;
    if (!dryRun) {
      const { error: e } = await sb.from('fighters').update(patch).eq('id', f.id);
      if (e) { out.errors.push(f.full_name + ': ' + e.message); return; }
    }
    out.updated++;
    for (const k of Object.keys(patch)) out.filled[k]++;
  }));
  return json(200, out);
};

function json(s, b) { return new Response(JSON.stringify(b, null, 2), { status: s, headers: { 'Content-Type': 'application/json' } }); }
