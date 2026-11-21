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
        const bk = ['bouts', 'fights', 'matches', 'card'].find(k => list[0][k] != null);
        if (bk) {
          // bouts can be an array, or an object like { total, completed }
          const cnt = (x) => Array.isArray(x[bk]) ? x[bk].length : (x[bk] && x[bk].total != null ? x[bk].total : null);
          const done = (x) => (x[bk] && x[bk].completed != null ? x[bk].completed : null);
          r.eventLines = list.slice().sort((a, b) => String(a[dk]).localeCompare(String(b[dk])))
            .map(x => `${x[dk]} | ${x.status || ''} | bouts ${cnt(x)}${done(x) != null ? ' (done ' + done(x) + ')' : ''} | ${x.name || x.slug}`);
        }
        r.firstSlug = list[0].slug || null;
        r.lastSlug = list[list.length - 1].slug || null;
      } else {
        r.sample = JSON.stringify(data).slice(0, 800);
      }
    } catch (e) { r.error = String(e.message || e); }
    out.results[p] = r;
  }
  // Look inside one completed RAF event: do its bouts carry scoring actions or only a final score?
  if (!one) {
    const ev = out.results['/raf/events'];
    const slugs = [];
    if (ev && ev.eventLines) {
      // pick the most recent event that has completed bouts
      const lines = ev.eventLines.filter(l => /done [1-9]/.test(l));
      if (lines.length) slugs.push(lines[lines.length - 1].split(' | ').pop());
    }
    out.rafDetail = {};
    for (const s of slugs) {
      for (const p of [`/raf/events/${s}`, `/raf/events/${s}/bouts`]) {
        try {
          const res = await fetch(CITO_BASE + p, { headers: { 'x-api-key': key } });
          const text = await res.text();
          out.rafDetail[p] = { http: res.status, bytes: text.length, start: text.slice(0, 3500) };
        } catch (e) { out.rafDetail[p] = { error: String(e.message || e) }; }
      }
    }
  }
  return json(200, out);
};
function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json' } });
}
