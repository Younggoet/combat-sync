import { createClient } from '@supabase/supabase-js';
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

    const detail = JSON.parse(body);
  const fightersRaw = detail.data?.fighters || detail.fighters || [];

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  function normalize(name) {
    return (name || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');
  }

  const { data: existingFighters } = await supabase
    .from('fighters')
    .select('id, full_name');

  const byName = new Map();
  for (const f of (existingFighters || [])) {
    byName.set(normalize(f.full_name), f);
  }

  const matched = fightersRaw.map((f) => ({
    raw: f,
    fighter: byName.get(normalize(f.fighterName)),
  }));

  return new Response(JSON.stringify({ detail, matched }, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
