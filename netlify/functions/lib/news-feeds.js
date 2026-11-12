/**
 * Combat — shared RSS feed fetch/parse helpers
 *
 * Pulled out of what used to be get-news.js's whole job. Now only
 * news-sync.js (the scheduled function) calls these — get-news.js just
 * reads the news_items table that news-sync.js fills in, instead of
 * hitting these feeds live on every page load.
 */

const FEEDS = [
  { name: 'Sherdog', sport: 'MMA', url: 'https://www.sherdog.com/rss/news.xml' },
  { name: 'USA Wrestling', sport: 'Wrestling', url: 'https://www.themat.com/rss.xml' },
  { name: 'BJJEE', sport: 'BJJ', url: 'https://www.bjjee.com/feed' },
  { name: 'Boxing News 24', sport: 'Boxing', url: 'https://www.boxingnews24.com/feed' },
  // Unverified — WordPress site, likely works, but the raw feed
  // couldn't be confirmed directly. If this stops showing articles,
  // swap in a verified kickboxing/Glory/K-1 source instead.
  { name: 'FightBook MMA', sport: 'Kickboxing', url: 'https://www.fightbookmma.com/feed' },
  // Added Nov 12: more MMA outlets. Titles + short blurb + link only; the
  // app always sends readers to the original article. Feed URLs below are
  // the usual public ones — news-sync reports per-feed counts so any that
  // don't respond are easy to spot and swap.
  { name: 'MMA Fighting', sport: 'MMA', url: 'https://www.mmafighting.com/rss/current' },
  { name: 'MMA Junkie', sport: 'MMA', url: 'https://mmajunkie.usatoday.com/feed' },
  { name: 'MMA Mania', sport: 'MMA', url: 'https://www.mmamania.com/rss/current' },
  { name: 'MMA News', sport: 'MMA', url: 'https://www.mmanews.com/feed' },
  { name: 'Cageside Press', sport: 'MMA', url: 'https://cagesidepress.com/feed/' },
  { name: 'Combat Press', sport: 'MMA', url: 'https://combatpress.com/feed/' },
  { name: 'ESPN MMA', sport: 'MMA', url: 'https://www.espn.com/espn/rss/mma/news' },
  { name: 'BJPenn', sport: 'MMA', url: 'https://www.bjpenn.com/feed/' },
  { name: 'Middle Easy', sport: 'MMA', url: 'https://middleeasy.com/feed/' },
  { name: 'Bloody Elbow', sport: 'MMA', url: 'https://www.bloodyelbow.com/rss/index.xml' },
  { name: 'r/MMA', sport: 'MMA', url: 'https://www.reddit.com/r/MMA/top/.rss?t=day' },
  { name: 'r/Boxing', sport: 'Boxing', url: 'https://www.reddit.com/r/Boxing/top/.rss?t=day' },
];

const MAX_PER_FEED = 20;

function stripCdata(str) {
  if (!str) return '';
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').trim();
}

function stripHtml(str) {
  if (!str) return '';
  return str.replace(/<[^>]*>/g, '').trim();
}

function extractTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match ? stripCdata(match[1]) : '';
}

function parseAtomEntries(xml, sourceName, sport) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  return entries.map((m) => {
    const block = m[1];
    const href = (block.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
    return {
      title: extractTag(block, 'title'),
      link: href,
      description: stripHtml(extractTag(block, 'content')).slice(0, 300),
      pubDate: extractTag(block, 'updated') || extractTag(block, 'published'),
      source: sourceName,
      sport: sport,
    };
  });
}

function parseRssItems(xml, sourceName, sport) {
  if (!/<item[\s>]/.test(xml) && /<entry[\s>]/.test(xml)) return parseAtomEntries(xml, sourceName, sport);
  const items = [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g)];
  return items.map((m) => {
    const block = m[1];
    return {
      title: extractTag(block, 'title'),
      link: extractTag(block, 'link'),
      description: stripHtml(extractTag(block, 'description')),
      pubDate: extractTag(block, 'pubDate'),
      source: sourceName,
      sport: sport,
    };
  });
}

/**
 * Fetches every configured feed and returns their items merged, newest
 * first, capped per feed (not overall — news-sync.js decides how many of
 * these to actually persist).
 */
async function fetchAllFeeds(report) {
  const allItems = [];
  await Promise.all(FEEDS.map(async (feed) => {
    try {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CombatFantasyBot/1.0; +https://combatfantasy.netlify.app)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
        signal: AbortSignal.timeout(9000),
      });
      if (!res.ok) { if (report) report[feed.name] = 'HTTP ' + res.status; return; }
      const xml = await res.text();
      const parsed = parseRssItems(xml, feed.name, feed.sport).filter((x) => x.title && x.link);
      if (report) report[feed.name] = parsed.length + ' items';
      allItems.push(...parsed.slice(0, MAX_PER_FEED));
    } catch (e) {
      // Skip a feed that fails rather than failing the whole sync.
      if (report) report[feed.name] = 'error: ' + (e.message || e);
    }
  }));
  allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return allItems;
}

module.exports = { FEEDS, fetchAllFeeds, parseRssItems };
