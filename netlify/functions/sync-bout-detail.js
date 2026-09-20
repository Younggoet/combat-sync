const { createClient } = require('@supabase/supabase-js');

const CITO_BASE = 'https://api.citoapi.com/api/v1';

exports.handler = async (event, context) => {
  const params = event.queryStringParameters || {};
  const boutId = params.boutId;

  if (!boutId) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Provide ?boutId=...' }),
    };
  }

  const apiKey = process.env.CITO_API_KEY;
  const citoUrl = `${CITO_BASE}/ufc/bouts/${boutId}`;

  const res = await fetch(citoUrl, {
    headers: { 'x-api-key': apiKey },
  });

  const body = await res.text();

  if (!res.ok) {
    return {
      statusCode: res.status,
      headers: { 'Content-Type': 'application/json' },
      body: body,
    };
  }

  const detail = JSON.parse(body);
  const fightersRaw = detail.data?.fighters || detail.fighters || [];

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

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ detail, matched }, null, 2),
  };
};
