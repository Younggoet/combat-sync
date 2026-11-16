// netlify/functions/cito-live-probe.js
// Read-only: shows what Cito's /ufc/live endpoint returns (shape, sizes,
// timestamps) so we can plan the switch from per-bout polling to the live
// feed. Writes nothing.
// USAGE: /.netlify/functions/cito-live-probe        (whole live card)
const CITO_BASE = 'https://api.citoapi.com/api/v1';

export default async () => {
  const key = process.env.CITO_API_KEY;
  if (!key) return json(500, { error: 'Missing CITO_API_KEY' });
  const out = { fetchedAt: new Date().toISOString() };
  try {
    const res = await fetch(`${CITO_BASE}/ufc/live`, { headers: { 'x-api-key': key } });
    out.http = res.status;
    out.headers = {};
    for (const h of ['date', 'cache-control', 'age', 'etag', 'x-ratelimit-limit', 'x-ratelimit-remaining'])
      if (res.headers.get(h)) out.headers[h] = res.headers.get(h);
    const text = await res.text();
    out.bytes = text.length;
    let body; try { body = JSON.parse(text); } catch { out.rawStart = text.slice(0, 600); return json(200, out); }
    out.topLevelKeys = Object.keys(body || {});
    const data = body.data ?? body;
    const list = Array.isArray(data) ? data : (data.bouts || data.events || data.live || null);
    out.liveCount = Array.isArray(list) ? list.length : null;
    out.firstItemKeys = Array.isArray(list) && list[0] ? Object.keys(list[0]) : Object.keys(data || {});
    out.sample = JSON.stringify(Array.isArray(list) ? list[0] : data).slice(0, 2500);
    out.note = 'Run during a LIVE card. Outside a card this is usually empty.';
  } catch (e) { out.error = String(e.message || e); }
  return json(200, out);
};
function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json' } });
}
