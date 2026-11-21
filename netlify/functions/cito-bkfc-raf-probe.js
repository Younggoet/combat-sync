// netlify/functions/cito-bkfc-raf-probe.js
// Read-only: shows what Cito returns for BKFC and RAF events and bouts, so we can see
// (1) how far ahead cards are filled in, (2) how many bouts each upcoming card has,
// (3) whether RAF bouts carry scoring actions or only final scores. Writes nothing.
// USAGE: /.netlify/functions/cito-bkfc-raf-probe
//        /.netlify/functions/cito-bkfc-raf-probe?path=/bkfc/events   (one custom path, bkfc or raf only)
const CITO_BASE = 'https://api.citoapi.com/api/v1';
const DEFAULT_PATHS = [
  '/bkfc/events', '/bkfc/events/upcoming', '/bkfc/bouts',
  '/raf/events', '/raf/events/upcoming', '/raf/bouts',
];

export default async (req) => {
  const key = process.env.CITO_API_KEY;
  if (!key) return json(500, { error: 'Missing CITO_API_KEY' });
  const url = new URL(req.url);
  const one = url.searchParams.get('path');
  if (one && !/^\/(bkfc|raf)(\/[A-Za-z0-9_\-]+)*$/.test(one)) return json(400, { error: 'path must start with /bkfc or /raf' });
  const paths = one ? [one] : DEFAULT_PATHS;
  const out = { fetchedAt: new Date().toISOString(), results: {} };
  for (const p of paths) {
    const r = { };
    try {
      const res = await fetch(CITO_BASE + p, { headers: { 'x-api-key': key } });
      r.http = res.status;
      const text = await res.text();
      r.bytes = text.length;
      let body; try { body = JSON.parse(text); } catch { r.rawStart = text.slice(0, 300); out.results[p] = r; continue; }
      r.topLevelKeys = Object.keys(body || {});
      const data = body.data ?? body;
      const list = Array.isArray(data) ? data : (data.events || data.bouts || data.items || data.results || null);
      r.count = Array.isArray(list) ? list.length : null;
      if (Array.isArray(list) && list.length) {
        r.firstItemKeys = Object.keys(list[0]);
        r.firstItem = JSON.stringify(list[0]).slice(0, 1200);
        // date range and per-event bout counts when the items look like events
        const dk = ['date', 'event_date', 'start_date', 'start_time', 'scheduled_at'].find(k => list[0][k] != null);
        if (dk) {
          const ds = list.map(x => x[dk]).filter(Boolean).sort();
          r.dateKey = dk; r.firstDate = ds[0]; r.lastDate = ds[ds.length - 1];
        }
        const bk = ['bouts', 'fights', 'matches', 'card'].find(k => Array.isArray(list[0][k]));
        if (bk) r.boutsPerEvent = list.slice(-15).map(x => ({ name: x.name || x.event_name || x.title, date: x[dk], bouts: (x[bk] || []).length }));
      } else {
        r.sample = JSON.stringify(data).slice(0, 800);
      }
    } catch (e) { r.error = String(e.message || e); }
    out.results[p] = r;
  }
  return json(200, out);
};
function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json' } });
}
