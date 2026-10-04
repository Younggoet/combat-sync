/**
 * Combat — Netlify function: save-push-subscription
 *
 * POST /.netlify/functions/save-push-subscription
 * Body (subscribe/update):
 *   {
 *     "endpoint": "<push service URL>",
 *     "keys": { "p256dh": "...", "auth": "..." },
 *     "team_id": "<uuid, optional>",       // needed for "your pick is up" alerts
 *     "notify_pick": boolean,
 *     "notify_chat": boolean,
 *     "notify_news": boolean
 *   }
 * Body (unsubscribe): { "endpoint": "...", "action": "unsubscribe" }
 *
 * Upserts by `endpoint` (a push subscription's endpoint URL is unique per
 * browser/device/profile — there's no login system in Combat, so this is
 * the identity). Same no-auth trust level as chat display names and the
 * commissioner settings page: whoever has the device controls its own
 * subscription, nothing more.
 */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Use POST' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Body must be valid JSON' }),
    };
  }

  const { endpoint } = body;
  if (!endpoint) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing required field: endpoint' }),
    };
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  if (body.action === 'unsubscribe') {
    const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
    if (error) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unsubscribe failed', details: error.message }),
      };
    }
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  }

  const keys = body.keys || {};
  if (!keys.p256dh || !keys.auth) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing required field(s): keys.p256dh, keys.auth' }),
    };
  }

  const row = {
    endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    team_id: body.team_id || null,
    notify_pick: body.notify_pick !== false,
    notify_chat: body.notify_chat !== false,
    notify_news: body.notify_news !== false,
    updated_at: new Date().toISOString(),
  };

  const { error: upsertError } = await supabase
    .from('push_subscriptions')
    .upsert(row, { onConflict: 'endpoint' });

  if (upsertError) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Saving subscription failed', details: upsertError.message }),
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true }),
  };
};
