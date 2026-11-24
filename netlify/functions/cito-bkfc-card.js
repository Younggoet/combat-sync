// netlify/functions/cito-bkfc-card.js
// Read-only: compact view of upcoming BKFC cards from Cito (every bout, both corners,
// whatever record/odds/physical fields Cito carries). Writes nothing.
// USAGE: /.netlify/functions/cito-bkfc-card            (all upcoming events)
//        /.netlify/functions/cito-bkfc-card?slug=bkfc-fight-night-hershey
const BASE = 'https://api.citoapi.com/api/v1';
const json = (s, b) => new Response(JSON.stringify(b, null, 1), { status: s, headers: { 'Content-Type': 'application/json' } });
export default async (req) => {
  const key = process.env.CITO_API_KEY;
  if (!key) return json(500, { error: 'Missing CITO_API_KEY' });
  const slug = new URL(req.url).searchParams.get('slug');
  const r = await fetch(BASE + '/bkfc/events/upcoming', { headers: { 'x-api-key': key } });
  if (!r.ok) return json(r.status, { error: 'Cito ' + r.status });
  const body = await r.json();
  let evs = body.data || [];
  if (slug) evs = evs.filter((e) => e.slug === slug);
  const out = evs.map((e) => ({
    slug: e.slug, name: e.name, date: e.date, time: e.localTime + ' ' + e.timezone, place: e.location && e.location.text, bouts: e.bouts,
    card: (e.card || []).map((b) => [
      b.order, b.section, b.slot, b.weightClass && b.weightClass.label, b.titleFight ? 'TITLE' : '', b.scheduledRounds || '',
      (b.fighters || []).map((f) => {
        const { corner, slug: s, name, nickname, headshot, ...rest } = f;
        const extra = Object.entries(rest).filter(([, v]) => v != null && typeof v !== 'object' && v !== '').map(([k, v]) => k + '=' + v).join(' ');
        return `${corner || ''}:${name}${nickname ? ' "' + nickname + '"' : ''} [${s}] ${extra}`;
      }).join('  VS  '),
    ].join(' | ')),
    fighterKeysSeen: (e.card && e.card[0] && e.card[0].fighters && e.card[0].fighters[0]) ? Object.keys(e.card[0].fighters[0]) : [],
  }));
  return json(200, { fetchedAt: new Date().toISOString(), events: out });
};
