// netlify/functions/rebuild-bout.js
// HTTP wrapper around live-poll so a single bout can be re-read from Cito
// on demand (scheduled functions can't be called by URL).
// USAGE: /.netlify/functions/rebuild-bout?rebuild=<cito_bout_id>
import poll from './live-poll.js';
export default async (req, context) => {
  if (!new URL(req.url).searchParams.get('rebuild')) {
    return new Response(JSON.stringify({ error: 'Pass ?rebuild=<cito_bout_id>' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  return poll(req, context);
};
