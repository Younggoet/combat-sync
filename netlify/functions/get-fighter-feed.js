// GET /.netlify/functions/get-fighter-feed?fighter=<uuid>
//
// Latest Feed for one fighter's profile: approved Combat summaries
// (fighter_summaries, status = published) plus recent coverage from every
// outlet news-sync stores, mixed so no single source floods the list.

const { createClient } = require('@supabase/supabase-js');

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' };
const MAX_COVERAGE = 12;
const WINDOW_DAYS = 45;

const decode = (s) => String(s || '')
  .replace(/&#0?38;|&amp;/g, '&').replace(/&#8217;|&#8216;|&rsquo;|&lsquo;/g, "'")
  .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;|&quot;/g, '"').replace(/&#8211;|&#8212;/g, '-')
  .replace(/&#8230;/g, '...').replace(/&nbsp;/g, ' ').replace(/&lt;|&gt;/g, '').trim();

const cleanLink = (l) => String(l || '').replace(/&#0?38;|&amp;/g, '&').split('?utm_')[0];
const norm = (t) => decode(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();


// ---- Before-the-fight previews, built from our own data so every fighter
// with a scheduled bout has content, not just the ones in the news. ----
const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
const inches = (cm) => { const t = Math.round(cm / 2.54); return `${Math.floor(t / 12)}'${t % 12}"`; };
const ageOf = (f) => (f.date_of_birth ? Math.floor((Date.now() - new Date(f.date_of_birth).getTime()) / 31557600000) : num(f.age_years));
const fw = (f) => ((f.finishes > f.wins && f.pro_wins >= f.finishes) ? f.pro_wins : f.wins);
const rec = (f) => `${f.wins ?? 0}-${f.losses ?? 0}`;
const prob = (ml) => { ml = num(ml); if (ml == null) return null; return ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100); };
const dateStr = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const last = (n) => String(n || '').split(' ').slice(-1)[0];

function styleLine(f) {
  const bits = [];
  const sig = num(f.avg_sig_strikes), td = num(f.avg_takedowns), kd = num(f.avg_knockdowns), ctl = num(f.avg_control_seconds);
  if (sig != null) bits.push(`lands ${sig.toFixed(1)} significant strikes per fight`);
  if (td != null && td >= 0.5) bits.push(`averages ${td.toFixed(1)} takedowns`);
  if (kd != null && kd >= 0.3) bits.push(`${kd.toFixed(1)} knockdowns`);
  if (ctl != null && ctl >= 90) bits.push(`${Math.round(ctl / 60 * 10) / 10} minutes of control`);
  return bits;
}

function buildPreviews(f, opp, bout) {
  const out = [];
  const nm = last(f.full_name), on = last(opp.full_name);
  const when = bout.bout_date ? dateStr(bout.bout_date) : null;
  const rounds = bout.scheduled_rounds ? `${bout.scheduled_rounds}-round ` : '';
  const wc = bout.weight_class || f.announced_weight_class || '';
  const fin = fw(f) ? Math.min(100, Math.round(((f.finishes || 0) / fw(f)) * 100)) : null;
  const pa = prob(bout.fighter_a_moneyline), pb = prob(bout.fighter_b_moneyline);
  const isA = bout.fighter_a === f.id;
  let odds = null;
  if (pa != null && pb != null) { const mine = (isA ? pa : pb) / (pa + pb); odds = Math.round(mine * 100); }

  // 1. Fight preview
  const lead = `${f.full_name} (${rec(f)}) faces ${opp.full_name} (${rec(opp)})${when ? ' on ' + dateStr(bout.bout_date) : ''} in a ${rounds}${wc ? wc.toLowerCase() + ' ' : ''}fight${bout.event_name ? ' at ' + bout.event_name : ''}.`;
  const details = [];
  if (odds != null) details.push(`Sportsbooks give ${nm} about a ${odds}% chance to win.`);
  const ha = num(f.height_cm), hb = num(opp.height_cm), ra = num(f.reach_cm), rb = num(opp.reach_cm);
  if (ra != null && rb != null && Math.abs(ra - rb) >= 3) details.push(`${ra > rb ? nm : on} has the reach edge, ${Math.round(Math.max(ra, rb) / 2.54)}" to ${Math.round(Math.min(ra, rb) / 2.54)}".`);
  else if (ha != null && hb != null && Math.abs(ha - hb) >= 5) details.push(`${ha > hb ? nm : on} is the taller fighter, ${inches(Math.max(ha, hb))} to ${inches(Math.min(ha, hb))}.`);
  const a1 = ageOf(f), a2 = ageOf(opp);
  if (a1 != null && a2 != null && Math.abs(a1 - a2) >= 4) details.push(`${a1 < a2 ? nm : on} is the younger fighter, ${Math.min(a1, a2)} to ${Math.max(a1, a2)}.`);
  const total = (f.wins || 0) + (f.losses || 0), ototal = (opp.wins || 0) + (opp.losses || 0);
  if (total && ototal && Math.abs(total - ototal) >= 6) details.push(`${total > ototal ? nm : on} has far more pro fights, ${Math.max(total, ototal)} to ${Math.min(total, ototal)}.`);
  out.push({
    id: 'gen-preview', kind: 'FIGHT PREVIEW', generated: true,
    headline: `${nm} vs ${on}${when ? ', ' + when : ''}`,
    body: [lead].concat(details).join(' '),
    take: fin != null ? `${nm} has finished ${fin}% of ${fw(f)} wins, which is where bonus points come from. ${fw(opp) ? `${on} has finished ${Math.min(100, Math.round(((opp.finishes || 0) / fw(opp)) * 100))}% of ${fw(opp)}.` : ''}` : null,
    sources: [],
  });

  // 2. Style and fantasy angle
  const mine = styleLine(f), theirs = styleLine(opp);
  if (mine.length) {
    let body = `${nm} ${mine.join(', ')}.`;
    if (theirs.length) body += ` ${on} ${theirs.join(', ')}.`;
    const tdd = num(f.td_def_pct), otd = num(opp.avg_takedowns);
    let take = null;
    if (otd != null && otd >= 1 && tdd != null) take = `${on} averages ${otd.toFixed(1)} takedowns and ${nm} stops ${Math.round(tdd * (tdd <= 1 ? 100 : 1))}% of them, so takedown defense points are in play.`;
    else if (num(f.avg_sig_strikes) != null && num(opp.avg_sig_strikes) != null) take = num(f.avg_sig_strikes) >= num(opp.avg_sig_strikes) ? `${nm} projects for more strike volume in this matchup.` : `${on} projects for more strike volume, so ${nm} points lean on finishes and control.`;
    out.push({ id: 'gen-style', kind: 'STYLE AND FANTASY', generated: true, headline: `How ${nm} scores against ${on}`, body, take, sources: [] });
  }
  return out;
}

exports.handler = async (event) => {
  const id = (event.queryStringParameters || {}).fighter;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'fighter id required' }) };
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const since = new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString();

  const [sum, cov] = await Promise.all([
    supabase.from('fighter_summaries').select('id, kind, headline, body, take, sources, published_at')
      .eq('fighter_id', id).eq('status', 'published').order('published_at', { ascending: false }).limit(6),
    supabase.from('news_item_fighters')
      .select('news_items!inner(title, link, source, pub_date)')
      .eq('fighter_id', id).gte('news_items.pub_date', since)
      .order('news_items(pub_date)', { ascending: false }).limit(60),
  ]);

  const seen = new Set();
  const bySource = {};
  for (const r of cov.data || []) {
    const n = r.news_items;
    if (!n || !n.title) continue;
    const key = norm(n.title);
    if (seen.has(key)) continue;
    seen.add(key);
    (bySource[n.source] = bySource[n.source] || []).push({
      title: decode(n.title), link: cleanLink(n.link), source: n.source, date: n.pub_date,
    });
  }
  // Round-robin across outlets so the list mixes sources, then sort by date.
  const mixed = [];
  const queues = Object.values(bySource);
  for (let i = 0; mixed.length < MAX_COVERAGE && queues.some((q) => q[i]); i++) {
    for (const q of queues) if (q[i] && mixed.length < MAX_COVERAGE) mixed.push(q[i]);
  }
  mixed.sort((a, b) => new Date(b.date) - new Date(a.date));

  // Previews for the next scheduled bout (skipped if a published NEXT FIGHT exists).
  let previews = [];
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data: bouts } = await supabase.from('bouts')
      .select('id, event_name, bout_date, status, weight_class, scheduled_rounds, fighter_a, fighter_b, fighter_a_moneyline, fighter_b_moneyline')
      .or(`fighter_a.eq.${id},fighter_b.eq.${id}`).not('status', 'in', '(completed,cancelled)').gte('bout_date', today)
      .order('bout_date', { ascending: true }).limit(1);
    const bout = (bouts || [])[0];
    if (bout) {
      const oid = bout.fighter_a === id ? bout.fighter_b : bout.fighter_a;
      const { data: fs } = await supabase.from('fighters').select('*').in('id', [id, oid]);
      const f = (fs || []).find((x) => x.id === id), opp = (fs || []).find((x) => x.id === oid);
      if (f && opp) {
        previews = buildPreviews(f, opp, bout);
        if ((sum.data || []).some((s) => s.kind === 'NEXT FIGHT')) previews = previews.filter((p) => p.id !== 'gen-preview');
      }
    }
  } catch (e) { /* previews are best-effort */ }

  return {
    statusCode: 200, headers: CORS,
    body: JSON.stringify({ summaries: (sum.data || []).concat(previews), coverage: mixed }),
  };
};
