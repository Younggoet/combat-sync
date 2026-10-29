// netlify/functions/enrich-wikidata.js
// Fills NULL nationality, date_of_birth and height_cm on EXISTING fighters from Wikidata
// (public, no API key). Matches by normalized full name. Never inserts rows, never overwrites.
//   GET /.netlify/functions/enrich-wikidata            -> writes
//   GET /.netlify/functions/enrich-wikidata?dryRun=true -> report only
import { createClient } from '@supabase/supabase-js';

const SPARQL = `SELECT ?l ?cl ?dob ?h ?hu WHERE {
  ?p wdt:P106 wd:Q11607585 . ?p rdfs:label ?l . FILTER(LANG(?l)="en")
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

  const r = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(SPARQL), {
    headers: { 'User-Agent': 'combat-app-enrich/1.0 (fantasy app)', Accept: 'application/sparql-results+json' },
  });
  if (!r.ok) return json(502, { error: 'Wikidata ' + r.status });
  const rows = (await r.json()).results.bindings;

  const wd = new Map();
  for (const b of rows) {
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

  const { data: fs, error } = await sb.from('fighters').select('id, full_name, nationality, date_of_birth, height_cm');
  if (error) return json(500, { error: error.message });

  const out = { wikidataRows: rows.length, fighters: fs.length, matched: 0, updated: 0, filled: { nationality: 0, date_of_birth: 0, height_cm: 0 }, errors: [] };
  for (const f of fs) {
    const o = wd.get(norm(f.full_name));
    if (!o) continue;
    out.matched++;
    const patch = {};
    if (!f.nationality && o.nat) patch.nationality = o.nat;
    if (!f.date_of_birth && o.dob) patch.date_of_birth = o.dob;
    if (!f.height_cm && o.h) patch.height_cm = o.h;
    if (!Object.keys(patch).length) continue;
    if (!dryRun) {
      const { error: e } = await sb.from('fighters').update(patch).eq('id', f.id);
      if (e) { out.errors.push({ f: f.full_name, m: e.message }); continue; }
    }
    out.updated++;
    for (const k of Object.keys(patch)) out.filled[k]++;
  }
  return json(200, out);
};

function json(s, b) { return new Response(JSON.stringify(b, null, 2), { status: s, headers: { 'Content-Type': 'application/json' } }); }
