// GET /.netlify/functions/get-fighter-feed?fighter=<uuid>
//
// Latest Feed for one fighter's profile: approved Combat summaries
// (fighter_summaries, status = published) plus recent coverage from every
// outlet news-sync stores, mixed so no single source floods the list.

const { createClient } = require('@supabase/supabase-js');
// Hand-written fight previews, keyed by fighter id (refreshed by Claude).
const WRITTEN = require('./data/fighter-previews.json');

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
const fw = (f) => (f.pro_wins != null ? f.pro_wins : f.wins);
const finPct = (f) => { const w = fw(f); return w && f.finishes != null && f.finishes <= w ? Math.round((f.finishes / w) * 100) : null; };
const rec = (f) => (f.pro_wins != null ? `${f.pro_wins}-${f.pro_losses ?? 0}` : `${f.wins ?? 0}-${f.losses ?? 0}`);
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
  const fin = finPct(f);
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
  const total = (f.pro_wins ?? f.wins ?? 0) + (f.pro_losses ?? f.losses ?? 0), ototal = (opp.pro_wins ?? opp.wins ?? 0) + (opp.pro_losses ?? opp.losses ?? 0);
  if (total && ototal && Math.abs(total - ototal) >= 6) details.push(`${total > ototal ? nm : on} has far more pro fights, ${Math.max(total, ototal)} to ${Math.min(total, ototal)}.`);
  out.push({
    id: 'gen-preview', kind: 'FIGHT PREVIEW', generated: true,
    headline: `${nm} vs ${on}${when ? ', ' + when : ''}`,
    body: [lead].concat(details).join(' '),
    take: fin != null ? `${nm} has finished ${fin}% of ${fw(f)} pro wins${finPct(opp) != null ? ` and ${on} has finished ${finPct(opp)}% of ${fw(opp)}` : ''}. ${(fin >= 60 || (finPct(opp) || 0) >= 60) ? 'With finishers on one or both sides this can end early, and an early finish is where the big fantasy nights come from.' : 'Neither is a heavy finisher, so expect this to be scored on volume and control more than on a single big moment.'}` : null,
    sources: [],
  });

  // 2. Style and fantasy: how this fight can score, built from both fighters' numbers.
  const proj = (x) => {
    const g = (k) => num(x[k]) || 0;
    return { sig: g('avg_sig_strikes') * 0.1, td: g('avg_takedowns') * 2, kd: g('avg_knockdowns') * 8, ctl: g('avg_control_seconds') / 60, sub: g('avg_sub_attempts'), rev: g('avg_reversals') * 6 };
  };
  const tot = (p) => p.sig + p.td + p.kd + p.ctl + p.sub + p.rev;
  const hasStats = (x) => num(x.avg_sig_strikes) != null;
  if (hasStats(f) && hasStats(opp)) {
    const pf = proj(f), po = proj(opp), tf = tot(pf), to = tot(po);
    const r1 = (v) => (Math.round(v * 10) / 10).toString();
    const paras = [];
    paras.push(`Before any finish bonus, the numbers project ${nm} at ${r1(tf)} points and ${on} at ${r1(to)}.`);
    const finF = finPct(f), finO = finPct(opp);
    const kdF = num(f.avg_knockdowns) || 0, kdO = num(opp.avg_knockdowns) || 0;
    // Short-night path
    if ((finF != null && finF >= 50) || (finO != null && finO >= 50) || kdF >= 0.4 || kdO >= 0.4) {
      const desc = (x) => { const kd = num(x.avg_knockdowns) || 0, fp = finPct(x); const bits = []; if (kd >= 0.3) bits.push(`averages ${kd.toFixed(1)} knockdowns`); if (fp != null) bits.push(`has finished ${fp}% of ${fw(x)} pro wins`); return bits.length ? `${last(x.full_name)} ${bits.join(' and ')}` : null; };
      const parts = (kdF >= kdO ? [f, opp] : [opp, f]).map(desc).filter(Boolean);
      paras.push(`Short-night path: ${parts.join('; ')}. A single knockdown is worth 8 points, the same as 80 significant strikes, and a finish adds 10 more in leagues with the bonus. If either one lands early, the points come in one burst and the fight can end before volume matters.`);
    }
    // Distance / volume path
    const vf = num(f.avg_sig_strikes), vo = num(opp.avg_sig_strikes), hi = vf >= vo ? f : opp, lo = vf >= vo ? opp : f;
    const rd = bout.scheduled_rounds || 3;
    paras.push(`Distance path: ${last(hi.full_name)} lands ${Math.max(vf, vo).toFixed(1)} significant strikes per fight to ${Math.min(vf, vo).toFixed(1)} for ${last(lo.full_name)}${rd >= 5 ? `, and five rounds give that volume more time to stack` : ''}. Volume only pays 0.1 per strike, so it decides the fight on points only when nobody lands the big shot.`);
    // Grappling path
    const tdF = num(f.avg_takedowns) || 0, tdO = num(opp.avg_takedowns) || 0;
    if (Math.max(tdF, tdO) >= 1) {
      const w = tdF >= tdO ? f : opp, v = tdF >= tdO ? opp : f, wn = last(w.full_name), vn = last(v.full_name);
      const tdd = num(v.td_def_pct), cs = (num(w.avg_control_seconds) || 0) / 60;
      paras.push(`Wrestling path: ${wn} averages ${Math.max(tdF, tdO).toFixed(1)} takedowns, worth ${r1(Math.max(tdF, tdO) * 2)} points a fight${cs >= 1 ? `, plus ${r1(cs)} minutes of control` : ''}.${tdd != null ? ` ${vn} stops ${Math.round(tdd * (tdd <= 1 ? 100 : 1))}% of takedowns, so every one that gets through is a swing in ${wn}'s favor.` : ''}`);
    }
    // Where it could run away
    const lead = tf >= to ? f : opp, trail = tf >= to ? opp : f, gap = Math.max(tf, to) - Math.min(tf, to);
    let take;
    if (Math.min(tf, to) > 0 && Math.max(tf, to) / Math.min(tf, to) >= 1.25) take = `This matchup leans toward ${last(lead.full_name)}. If ${last(trail.full_name)} can't match the pace early, ${last(lead.full_name)} is the one who piles up points, with a ${r1(gap)}-point projected gap before any finish.`;
    else take = `This projects almost even, ${r1(Math.max(tf, to))} to ${r1(Math.min(tf, to))}, so it will come down to who lands first. Whoever gets the early knockdown or takedown can turn an even projection into a big scoring night, and the other fighter will be playing catch-up.`;
    out.push({ id: 'gen-style', kind: 'STYLE AND FANTASY', generated: true, headline: `How ${nm} and ${on} can score`, body: paras.join(' '), take, sources: [] });
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
  const todayIso = new Date().toISOString().slice(0, 10);
  const wr = WRITTEN[id];
  const hasWritten = !!(wr && wr.date >= todayIso) || (sum.data || []).some((x) => x.kind === 'NEXT FIGHT' || x.kind === 'FIGHT PREVIEW');
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data: bouts } = await supabase.from('bouts')
      .select('id, event_name, bout_date, status, weight_class, scheduled_rounds, fighter_a, fighter_b, fighter_a_moneyline, fighter_b_moneyline')
      .or(`fighter_a.eq.${id},fighter_b.eq.${id}`).not('status', 'in', '(completed,cancelled)').gte('bout_date', today)
      .order('bout_date', { ascending: true }).limit(1);
    const bout = (bouts || [])[0];
    if (bout && !hasWritten) {
      const oid = bout.fighter_a === id ? bout.fighter_b : bout.fighter_a;
      const { data: fs } = await supabase.from('fighters').select('*').in('id', [id, oid]);
      const f = (fs || []).find((x) => x.id === id), opp = (fs || []).find((x) => x.id === oid);
      if (f && opp) {
        previews = buildPreviews(f, opp, bout);
        if ((sum.data || []).some((s) => s.kind === 'NEXT FIGHT')) previews = previews.filter((p) => p.id !== 'gen-preview');
      }
    }
  } catch (e) { /* previews are best-effort */ }

  const written = wr && wr.date >= todayIso
    ? [{ id: 'written-preview', kind: 'FIGHT PREVIEW', headline: wr.headline, body: wr.body, take: wr.take, sources: [] }]
    : [];

  return {
    statusCode: 200, headers: CORS,
    body: JSON.stringify({ summaries: (sum.data || []).concat(written, previews), coverage: mixed }),
  };
};
