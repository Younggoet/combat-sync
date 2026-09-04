// netlify/functions/get-news.js
//
// Fetches Sherdog's MMA news RSS feed server-side and returns clean JSON.
// No database involved — this is a live fetch-and-parse on every request,
// matching the "RSS aggregator, no DB" design for the news module.
//
// Only Sherdog is wired up for now — it's the one feed confirmed reliable.
// Other sources (MMA Fighting, MMA Junkie, etc.) can be added to the
// FEEDS array below once their real RSS URLs are verified working.
//
// USAGE:
//   GET https://combat-sync.netlify.app/.netlify/functions/get-news

const FEEDS = [
  { name: "Sherdog", sport: "MMA", url: "https://www.sherdog.com/rss/news.xml" },
  { name: "USA Wrestling", sport: "Wrestling", url: "https://www.themat.com/rss.xml" },
  { name: "BJJEE", sport: "BJJ", url: "https://www.bjjee.com/feed" },
  { name: "Boxing News 24", sport: "Boxing", url: "https://www.boxingnews24.com/feed" },
  // Unverified — WordPress site, likely works, but the raw feed
  // couldn't be confirmed directly. If this stops showing articles,
  // swap in a verified kickboxing/Glory/K-1 source instead.
  { name: "FightBook MMA", sport: "Kickboxing", url: "https://www.fightbookmma.com/feed" },
];

const MAX_ITEMS = 40;
const MAX_PER_FEED = 10;

function stripCdata(str) {
  if (!str) return "";
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim();
}

function stripHtml(str) {
  if (!str) return "";
  return str.replace(/<[^>]*>/g, "").trim();
}

function extractTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match ? stripCdata(match[1]) : "";
}

function parseRssItems(xml, sourceName, sport) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  return items.map((m) => {
    const block = m[1];
    return {
      title: extractTag(block, "title"),
      link: extractTag(block, "link"),
      description: stripHtml(extractTag(block, "description")),
      pubDate: extractTag(block, "pubDate"),
      source: sourceName,
      sport: sport,
    };
  });
}

export default async () => {
  const corsHeaders = {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  };

  try {
    const allItems = [];

    for (const feed of FEEDS) {
      try {
        const res = await fetch(feed.url);
        if (!res.ok) continue;
        const xml = await res.text();
        const parsed = parseRssItems(xml, feed.name, feed.sport);
        // Cap per feed so high-frequency sources (like MMA) don't crowd
        // out lower-volume ones (wrestling, BJJ, boxing) once merged.
        allItems.push(...parsed.slice(0, MAX_PER_FEED));
      } catch (e) {
        // Skip a feed that fails rather than failing the whole request
        continue;
      }
    }

    allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    return new Response(
      JSON.stringify({ items: allItems.slice(0, MAX_ITEMS) }),
      { headers: corsHeaders }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e.message, items: [] }),
      { status: 500, headers: corsHeaders }
    );
  }
};
