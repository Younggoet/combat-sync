// netlify/functions/enrich-body-photos.js
// Reads each fighter's Cito profile and saves the full-body photo URL (fighters.body_photo_url).
//   ?event=UFC 334   -> fighters in bouts whose event_name contains that text
//   ?names=Ciryl Gane,Josh Hokit  -> specific fighters
//   ?dryRun=true     -> report only (also lists every image-looking field Cito returns)
import { createClient } from '@supabase/supabase-js';

const BASE = 'https://api.citoapi.com/api/v1';
const slugify = (n) => (n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['.]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const isImg = (v) => typeof v === 'string' && /^https?:\/\//.test(v) && /(\.(png|jpe?g|webp)|\/images?\/)/i.test(v);

export default async (req) => {
  const u = new URL(req.url);
  const dryRun = u.searchParams.get('dryRun') === 'true';
  const event = u.searchParams.get('event');
  const names = (u.searchParams.get('names') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const { CITO_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!CITO_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: 'Missing env vars.' });
  if (!event && !names.length) return json(400, { error: 'Pass ?event=UFC 334 or ?names=Name One,Name Two' });
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let fs = [];
  if (event) {
    const { data: bs } = await sb.from('bouts').select('fighter_a, fighter_b').ilike('event_name', `%${event}%`);
    const ids = [...new Set((bs || []).flatMap((b) => [b.fighter_a, b.fighter_b]).filter(Boolean))];
    if (ids.length) { const { data } = await sb.from('fighters').select('id, full_name, body_photo_url').in('id', ids); fs = data || []; }
  } else {
    const { data } = await sb.from('fighters').select('id, full_name, body_photo_url').in('full_name', names); fs = data || [];
  }

  const out = { sample: {}, fighters: fs.length, saved: 0, noBodyPhoto: [], notFound: [], errors: [], imageFieldsSeen: {} };
  const queue = fs.slice();
  const work = async (f) => {
    try {
      let r;
      for (let t = 0; t < 4; t++) {
        r = await fetch(`${BASE}/ufc/fighters/${slugify(f.full_name)}`, { headers: { 'x-api-key': CITO_API_KEY } });
        if (r.status !== 429) break;
        await new Promise((ok) => setTimeout(ok, 700 * (t + 1)));
      }
      if (!r.ok) { out.notFound.push(f.full_name + ' (' + r.status + ')'); return; }
      const b = await r.json();
      const c = b && b.data && !Array.isArray(b.data) ? b.data : b;
      for (const [k, v] of Object.entries(c || {})) if (isImg(v)) { out.imageFieldsSeen[k] = (out.imageFieldsSeen[k] || 0) + 1; if (Object.keys(out.sample).length < 2) (out.sample[f.full_name] = out.sample[f.full_name] || {})[k] = v; }
      const url = [c.bodyImageUrl, c.fullBodyImageUrl, c.fullBodyUrl, c.bodyUrl].find(isImg);
      if (!url) { out.noBodyPhoto.push(f.full_name); return; }
      if (!dryRun) {
        const { error } = await sb.from('fighters').update({ body_photo_url: url }).eq('id', f.id);
        if (error) { out.errors.push(f.full_name + ': ' + error.message); return; }
      }
      out.saved++;
    } catch (e) { out.errors.push(f.full_name + ': ' + e.message); }
  };
  await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await work(queue.shift()); }));
  return json(200, out);
};

function json(s, b) { return new Response(JSON.stringify(b, null, 2), { status: s, headers: { 'Content-Type': 'application/json' } }); }
