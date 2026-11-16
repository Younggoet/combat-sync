// netlify/functions/cito-rate-probe.js
//
// Read-only diagnostic: how fresh is Cito's Bout Detail data?
// Polls one Cito bout every ~1s for ~8s (Netlify's sync-function limit),
// and reports (a) Cito's cache/age headers, (b) any updated/timestamp
// fields in the payload, and (c) when the stats actually changed.
// Writes nothing. Run it a few times during a LIVE fight for a real answer.
//
// USAGE: /.netlify/functions/cito-rate-probe?boutId=13164
//        optional: &polls=8&gapMs=1000

const CITO_BASE = 'https://api.citoapi.com/api/v1';

export default async (req) => {
  const url = new URL(req.url);
  const boutId = url.searchParams.get('boutId');
  const polls = Math.min(Number(url.searchParams.get('polls')) || 8, 10);
  const gapMs = Math.min(Number(url.searchParams.get('gapMs')) || 1000, 2000);
  const key = process.env.CITO_API_KEY;
  if (!key) return json(500, { error: 'Missing CITO_API_KEY' });
  if (!boutId) return json(400, { error: 'Pass ?boutId=<cito bout id>' });

  const log = [];
  let prev = null, changes = 0, headers = null, tsFields = null, status = null;
  for (let i = 0; i < polls; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${CITO_BASE}/ufc/bouts/${boutId}`, { headers: { 'x-api-key': key } });
      if (!headers) {
        headers = {};
        for (const h of ['date', 'cache-control', 'age', 'etag', 'last-modified', 'x-cache', 'cf-cache-status', 'x-ratelimit-limit', 'x-ratelimit-remaining'])
          if (res.headers.get(h)) headers[h] = res.headers.get(h);
      }
      const body = await res.json();
      const data = body.data || body;
      status = data.status || status;
      if (!tsFields) {
        tsFields = {};
        const walk = (o, p) => {
          if (!o || typeof o !== 'object') return;
          for (const [k, v] of Object.entries(o)) {
            if (/updat|modif|timestamp|clock|time|round/i.test(k) && typeof v !== 'object') tsFields[p + k] = v;
            else if (typeof v === 'object' && p.split('.').length < 4) walk(Array.isArray(v) ? v[0] : v, p + k + '.');
          }
        };
        walk(data, '');
      }
      const sig = JSON.stringify(data.roundStats || data.boutStats || data.fighters || data);
      const changed = prev !== null && sig !== prev;
      if (changed) changes++;
      prev = sig;
      log.push({ i, at: new Date().toISOString(), http: res.status, changed });
    } catch (e) {
      log.push({ i, error: String(e.message || e) });
    }
    const wait = gapMs - (Date.now() - t0);
    if (wait > 0 && i < polls - 1) await new Promise((r) => setTimeout(r, wait));
  }
  return json(200, { boutId, citoStatus: status, polls, gapMs, changesSeen: changes, headers, timeAndRoundFields: tsFields, log,
    howToRead: 'Only meaningful during a LIVE fight. Run it several times. If changesSeen>0 inside 8s, Cito updates faster than once a minute. If headers show cache-control max-age, that is Cito caching for that many seconds.' });
};

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json' } });
}
