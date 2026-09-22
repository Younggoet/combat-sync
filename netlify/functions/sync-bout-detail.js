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

  const { data: existingFighters, error: fightersError } = await supabase
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

    const winnerSlug = detail.data?.winnerFighterSlug || detail.winnerFighterSlug || null;
  const winnerMatch = matched.find((m) => m.raw.fighterSlug === winnerSlug);

  const [a, b] = matched;
  if (!a?.fighter || !b?.fighter) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'skipped', reason: 'fighter(s) not in your roster', matched }, null, 2),
    };
  }

  const eventName = detail.data?.event?.title || detail.event?.title || null;
  const eventDate = detail.data?.event?.eventDate || detail.event?.eventDate || null;

  const { data: existingBout } = await supabase
    .from('bouts')
    .select('id')
    .eq('event_name', eventName)
    .eq('fighter_a', a.fighter.id)
    .eq('fighter_b', b.fighter.id)
    .maybeSingle();

  if (existingBout) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'already_exists', boutRowId: existingBout.id }, null, 2),
    };
  }

  const boutRow = {
    sport_id: 'mma',
    org_id: null,
    event_name: eventName,
    bout_date: eventDate,
    status: detail.data?.status || detail.status || 'completed',
    weight_class: detail.data?.weightClass || detail.weightClass || null,
    scheduled_rounds: null,
    is_title_fight: detail.data?.titleBout || detail.titleBout || false,
    fighter_a: a.fighter.id,
    fighter_b: b.fighter.id,
    winner_id: winnerMatch ? winnerMatch.fighter.id : null,
    method: detail.data?.method || detail.method || null,
    end_round: detail.data?.resultRound || detail.resultRound || null,
    end_time: detail.data?.resultTime || detail.resultTime || null,
    fotn: false,
    data_source: 'cito',
  };

  const { data: insertedBout, error: boutErr } = await supabase
    .from('bouts')
    .insert(boutRow)
    .select('id')
    .single();

  if (boutErr) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'error', error: boutErr.message }, null, 2),
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'inserted', boutRowId: insertedBout.id, matched }, null, 2),
  };
};
