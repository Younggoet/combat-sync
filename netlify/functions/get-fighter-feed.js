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

  return {
    statusCode: 200, headers: CORS,
    body: JSON.stringify({ summaries: sum.data || [], coverage: mixed }),
  };
};
