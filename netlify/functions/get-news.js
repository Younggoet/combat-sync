// netlify/functions/get-news.js
//
// GET /.netlify/functions/get-news
//
// Returns stored news articles from Supabase, newest first, each tagged
// with which of our fighters (if any) it mentions.
//
// REWRITTEN Oct 3 2026 — this used to fetch every RSS feed live on every
// request and throw the results back without storing anything. That's
// now news-sync.js's job, running on a schedule (see netlify.toml). This
// function just reads what news-sync.js already persisted into
// news_items / news_item_fighters — fast, and able to tag fighters,
// which nothing could do against a live, un-stored RSS fetch.
//
// Response shape is unchanged from before ({ items: [...] }, each with
// title/link/description/pubDate/source/sport) so combat-app's
// news.html keeps working as-is. Each item now ALSO carries a
// `fighters` array ([{ id, name }]) — additive, nothing existing breaks
// if a consumer ignores it.

const { createClient } = require('@supabase/supabase-js');

const MAX_ITEMS = 40;

exports.handler = async () => {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: rows, error } = await supabase
    .from('news_items')
    .select('title, link, description, pub_date, source, sport, news_item_fighters(fighter_id, matched_name, fighters(id, full_name))')
    .order('pub_date', { ascending: false })
    .limit(MAX_ITEMS);

  if (error) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message, items: [] }),
    };
  }

  const items = (rows || []).map((r) => ({
    title: r.title,
    link: r.link,
    description: r.description,
    pubDate: r.pub_date,
    source: r.source,
    sport: r.sport,
    fighters: (r.news_item_fighters || [])
      .filter((m) => m.fighters)
      .map((m) => ({ id: m.fighters.id, name: m.fighters.full_name })),
  }));

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ items }),
  };
};
