// netlify/functions/lookup-fighter.js
//
// Looks up a fighter's Cito slug and fight history, to help find a
// specific boutId for use with sync-bout-detail.js. Read-only —
// doesn't write anything to Supabase.
//
// COST NOTE: this hits Cito's /ufc/search endpoint (1 call), then
// optionally /ufc/fighters/{slug}/fights (1 more call if you pass
// includeFights=true). Keep lookups deliberate given your plan's
// monthly call limit.
//
// ENV VARS: same as sync-bout-detail.js (CITO_API_KEY)
//
// USAGE (search only, returns slug + basic info):
//   GET https://<your-site>.netlify.app/.netlify/functions/lookup-fighter?name=Waldo%20Cortes-Acosta
//
// USAGE (search + full fight history with boutIds):
//   GET https://<your-site>.netlify.app/.netlify/functions/lookup-fighter?name=Waldo%20Cortes-Acosta&includeFights=true
//
// If a name matches multiple fighters, all matches are returned so you
// can pick the right one and re-query with includeFights=true if needed.

const CITO_BASE = 'https://api.citoapi.com/api/v1';

async function citoFetch(path) {
  const res = await fetch(`${CITO_BASE}${path}`, {
    headers: { 'x-api-key': process.env.CITO_API_KEY }
  });
  if (!res.ok) {
    throw new Error(`Cito ${path} returned ${res.status}`);
  }
  return res.json();
}

export default async (req, context) => {
  const url = new URL(req.url);
  const name = url.searchParams.get('name');
  const includeFights = url.searchParams.get('includeFights') === 'true';

  if (!name) {
    return new Response(
      JSON.stringify({ error: 'Pass a ?name= query param, e.g. ?name=Waldo Cortes-Acosta' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  try {
    const searchResults = await citoFetch(`/ufc/search?q=${encodeURIComponent(name)}`);

    // Cito wraps results as either a bare array, or nested under
    // .fighters, .data.fighters, .results, or .data — confirmed via a
    // real response that the actual shape is { fighters: [...] }.
    const matches = Array.isArray(searchResults)
      ? searchResults
      : Array.isArray(searchResults.fighters)
        ? searchResults.fighters
        : Array.isArray(searchResults.data)
          ? searchResults.data
          : Array.isArray(searchResults.data?.fighters)
            ? searchResults.data.fighters
            : Array.isArray(searchResults.results)
              ? searchResults.results
              : [];

    if (matches.length === 0) {
      return new Response(
        JSON.stringify({ query: name, matches: [] }),
        { headers: { 'content-type': 'application/json' } }
      );
    }

    if (!includeFights) {
      return new Response(
        JSON.stringify({ query: name, matches }),
        { headers: { 'content-type': 'application/json' } }
      );
    }

    // Pull fight history for every match (usually just one, but handles multiple)
    const withFights = await Promise.all(
      matches.map(async (m) => {
        const slug = m.slug || m.fighterSlug;
        if (!slug) return { ...m, fights: null, fightsError: 'no slug on this match' };
        try {
          const fights = await citoFetch(`/ufc/fighters/${slug}/fights`);
          return { ...m, fights };
        } catch (e) {
          return { ...m, fights: null, fightsError: e.message };
        }
      })
    );

    return new Response(
      JSON.stringify({ query: name, matches: withFights }, null, 2),
      { headers: { 'content-type': 'application/json' } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }
};
