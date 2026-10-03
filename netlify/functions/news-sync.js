/**
 * Combat — Netlify scheduled function: news-sync
 *
 * Runs on a timer (see `config.schedule` below), NOT on page load. Pulls
 * every configured RSS feed, persists any article not already stored
 * (deduped by link), and name-matches newly-stored articles against the
 * fighters table so get-news.js can serve "news about fighters on your
 * roster" straight from the database instead of re-fetching and
 * re-scanning everything live on every visit.
 *
 * Schedule: every 30 minutes, every hour — set in netlify.toml (not here;
 * for a standard Node background function like this one, Netlify reads
 * the cron schedule from [functions."news-sync"] in netlify.toml, not
 * from an exported `config` object — that convention is for Deno Edge
 * Functions, a different runtime this repo doesn't use).
 *
 * Can also be triggered manually (e.g. for testing) by hitting
 * /.netlify/functions/news-sync directly — Netlify invokes scheduled
 * functions the same way under the hood, so the handler doesn't care how
 * it was invoked.
 */

const { createClient } = require('@supabase/supabase-js');
const { fetchAllFeeds } = require('./lib/news-feeds');
const { buildFighterMatchers, matchFightersInText } = require('./lib/fighter-matching');

exports.handler = async () => {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const items = await fetchAllFeeds();

  if (items.length === 0) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fetched: 0, inserted: 0, matched: 0, note: 'No items fetched from any feed' }),
    };
  }

  const rows = items.map((it) => ({
    source: it.source,
    sport: it.sport,
    title: it.title,
    link: it.link,
    description: it.description || null,
    pub_date: it.pubDate ? new Date(it.pubDate).toISOString() : null,
  }));

  // onConflict + ignoreDuplicates means this is an INSERT ... ON CONFLICT
  // (link) DO NOTHING — and critically, .select() on that only returns
  // the rows that were ACTUALLY inserted, never the skipped duplicates.
  // That's exactly the "which of these are new" list fighter-matching
  // needs, with no extra query.
  const { data: insertedRows, error: insertError } = await supabase
    .from('news_items')
    .upsert(rows, { onConflict: 'link', ignoreDuplicates: true })
    .select('id, title, description');

  if (insertError) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Storing news items failed', details: insertError.message }),
    };
  }

  const newItems = insertedRows || [];

  if (newItems.length === 0) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fetched: items.length, inserted: 0, matched: 0, note: 'Nothing new — all articles already stored' }),
    };
  }

  const { data: fighters, error: fightersError } = await supabase
    .from('fighters')
    .select('id, full_name, nickname');

  if (fightersError) {
    // The articles are already safely stored — matching can always catch
    // up on the next run. Don't fail the whole sync over this.
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fetched: items.length, inserted: newItems.length, matched: 0,
        warning: `Stored ${newItems.length} new articles but could not load fighters to match: ${fightersError.message}`,
      }),
    };
  }

  const matchers = buildFighterMatchers(fighters || []);
  const mentionRows = [];
  for (const item of newItems) {
    const text = `${item.title} ${item.description || ''}`;
    const matches = matchFightersInText(text, matchers);
    for (const m of matches) {
      mentionRows.push({ news_item_id: item.id, fighter_id: m.fighterId, matched_name: m.name });
    }
  }

  let matchedCount = 0;
  if (mentionRows.length > 0) {
    const { data: insertedMentions, error: mentionError } = await supabase
      .from('news_item_fighters')
      .upsert(mentionRows, { onConflict: 'news_item_id,fighter_id', ignoreDuplicates: true })
      .select('news_item_id');

    if (mentionError) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fetched: items.length, inserted: newItems.length, matched: 0,
          warning: `Articles stored but fighter-matching insert failed: ${mentionError.message}`,
        }),
      };
    }
    matchedCount = (insertedMentions || []).length;
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fetched: items.length, inserted: newItems.length, matched: matchedCount }),
  };
};
