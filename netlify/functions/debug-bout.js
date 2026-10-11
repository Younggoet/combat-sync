// netlify/functions/debug-bout.js
//
// Read-only diagnostic: fetches Cito's raw Bout Detail response for one
// boutId and returns it verbatim, alongside what our own bouts/performances
// rows currently say for that bout. Writes nothing to the database.
//
// USAGE: /.netlify/functions/debug-bout?boutId=13164
// or:    /.netlify/functions/debug-bout?ourBoutId=<uuid>

import { createClient } from '@supabase/supabase-js';

const CITO_BASE = 'https://api.citoapi.com/api/v1';

export default async (req, context) => {
  const url = new URL(req.url);
  const citoBoutId = url.searchParams.get('boutId');
  const ourBoutId = url.searchParams.get('ourBoutId');

  const CITO_API_KEY = process.env.CITO_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!CITO_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Missing env vars.' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const out = {};

  // Our own row(s) for this bout
  let boutQuery = supabase
    .from('bouts')
    .select('id, cito_bout_id, status, winner_id, method, last_live_sync_at, fighter_a, fighter_b, bout_date');
  if (ourBoutId) boutQuery = boutQuery.eq('id', ourBoutId);
  else if (citoBoutId) boutQuery = boutQuery.eq('cito_bout_id', String(citoBoutId));
  const { data: ourBout, error: ourBoutErr } = await boutQuery.maybeSingle();
  out.ourBout = ourBout || null;
  out.ourBoutErr = ourBoutErr ? ourBoutErr.message : null;

  const effectiveCitoBoutId = citoBoutId || (ourBout && ourBout.cito_bout_id);

  if (ourBout) {
    const { data: fa } = await supabase.from('fighters').select('full_name').eq('id', ourBout.fighter_a).maybeSingle();
    const { data: fb } = await supabase.from('fighters').select('full_name').eq('id', ourBout.fighter_b).maybeSingle();
    out.ourFighterANames = fa ? fa.full_name : null;
    out.ourFighterBName = fb ? fb.full_name : null;

    const { data: perfs } = await supabase.from('performances').select('id, fighter_id').eq('bout_id', ourBout.id);
    out.ourPerformances = perfs || [];

    const { data: stats } = await supabase.from('mma_stats').select('*').in('performance_id', (perfs || []).map((p) => p.id)).eq('round_number', 0);
    out.ourMmaStats = stats || [];
  }

  if (!effectiveCitoBoutId) {
    return json(200, { ...out, citoRaw: null, citoFetchError: 'No cito_bout_id to query (pass ?boutId= or ?ourBoutId= that resolves to one)' });
  }

  try {
    const res = await fetch(`${CITO_BASE}/ufc/bouts/${effectiveCitoBoutId}`, {
      headers: { 'x-api-key': CITO_API_KEY },
    });
    const bodyText = await res.text();
    out.citoHttpStatus = res.status;
    try {
      out.citoRaw = JSON.parse(bodyText);
    } catch (e) {
      out.citoRaw = null;
      out.citoRawText = bodyText.slice(0, 2000);
    }
  } catch (e) {
    out.citoFetchError = e.message;
  }

  return json(200, out);
};

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
