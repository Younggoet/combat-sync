/**
 * Combat — Netlify function: send-chat-message
 *
 * POST /.netlify/functions/send-chat-message
 * Header: Authorization: Bearer <supabase access token>
 * Body: { "league_id": "<uuid>", "body": "<string>" }
 *
 * Requires real sign-in now: the caller's identity comes from their
 * Supabase Auth JWT, verified server-side, and display_name is read
 * from their own profiles row (never trusted from the client) — a
 * message can no longer be sent under a name you don't own.
 *
 * Inserts the message into chat_messages (service role — same table
 * chat.html's Realtime subscription already listens to, so every open
 * tab still gets the message live the instant it's inserted, same as
 * before) and then pushes a notification to every device subscribed to
 * chat alerts.
 */

const { createClient } = require('@supabase/supabase-js');
const { notifySubscribers } = require('./lib/push');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Use POST' }),
    };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Sign in to send a message.' }),
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

  const { league_id: leagueId, body: messageBody } = body;
  const missing = ['league_id', 'body'].filter((k) => !body[k]);
  if (missing.length > 0) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Missing required field(s): ${missing.join(', ')}` }),
    };
  }

  const trimmedBody = String(messageBody).trim();
  if (!trimmedBody) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Message body cannot be empty' }),
    };
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData || !userData.user) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Your session has expired — sign in again.' }),
    };
  }
  const user = userData.user;

  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('id', user.id)
    .maybeSingle();
  const displayName = (profile && profile.display_name) || user.email || 'Anonymous';

  const { data: inserted, error: insertError } = await supabase
    .from('chat_messages')
    .insert({
      league_id: leagueId,
      display_name: String(displayName).trim().slice(0, 40),
      body: trimmedBody.slice(0, 2000),
    })
    .select('id, league_id, display_name, body, created_at')
    .single();

  if (insertError) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Sending message failed', details: insertError.message }),
    };
  }

  // Best-effort — a push failure never undoes or hides the sent message.
  await notifySubscribers(supabase, 'chat', {
    title: `${inserted.display_name} · League Chat`,
    body: inserted.body.length > 120 ? `${inserted.body.slice(0, 117)}...` : inserted.body,
    url: '/chat.html',
  });

  return {
    statusCode: 201,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: inserted }),
  };
};
