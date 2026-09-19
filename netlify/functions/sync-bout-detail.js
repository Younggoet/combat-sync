export default async (req, context) => {
  const url = new URL(req.url);
  const boutId = url.searchParams.get('boutId');

  if (!boutId) {
    return new Response(JSON.stringify({ error: 'Provide ?boutId=...' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.CITO_API_KEY;
  const citoUrl = `https://api.citoapi.com/api/v1/ufc/bouts/${boutId}`;

  const res = await fetch(citoUrl, {
    headers: { 'x-api-key': apiKey },
  });

  const body = await res.text();

  return new Response(body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
};
