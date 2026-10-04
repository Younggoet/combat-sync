/**
 * Combat — Netlify function: start-draft
 *
 * POST /.netlify/functions/start-draft
 * Header: Authorization: Bearer <supabase access token>
 * Body: { "league_id": "<uuid>" }
 *
 * Commissioner-only: flips the league's pending draft room (created by
 * save-league-settings, which sets its team_order) to 'active', stamps
 * started_at, and opens the clock on pick #1 (current_pick_deadline =
 * now + pick_seconds). Once active, draft-pick.js will accept picks and
 * autopick-check.js (a scheduled function) will auto-pick for whichever
 * team's clock runs out.
 */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Use POST' }) };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Sign in to start the draft.' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { league_id: leagueId } = body;
  if (!leagueId) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Provide league_id' }),
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
  const userId = userData.user.id;

  const { data: league, error: leagueError } = await supabase
    .from('leagues')
    .select('id, commissioner_user_id')
    .eq('id', leagueId)
    .maybeSingle();

  if (leagueError || !league) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'League not found' }),
    };
  }

  if (!league.commissioner_user_id || league.commissioner_user_id !== userId) {
    return {
      statusCode: 403,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: "Only this league's commissioner can start the draft." }),
    };
  }

  const { data: room, error: roomError } = await supabase
    .from('draft_rooms')
    .select('id, status, pick_seconds, team_order')
    .eq('league_id', leagueId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (roomError) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Draft room lookup failed', details: roomError.message }),
    };
  }

  if (!room || !Array.isArray(room.team_order) || room.team_order.length === 0) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Set the draft order in League Settings before starting the draft.' }),
    };
  }

  if (room.status !== 'pending') {
    return {
      statusCode: 409,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: room.status === 'active'
          ? 'This draft has already started'
          : 'This draft has already completed',
      }),
    };
  }

  const now = new Date();
  const { data: updated, error: updateError } = await supabase
    .from('draft_rooms')
    .update({
      status: 'active',
      started_at: now.toISOString(),
      current_pick_number: 1,
      current_pick_deadline: new Date(now.getTime() + room.pick_seconds * 1000).toISOString(),
    })
    .eq('id', room.id)
    .select('id, status, started_at, current_pick_deadline, team_order, pick_seconds')
    .single();

  if (updateError) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Starting the draft failed', details: updateError.message }),
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draftRoom: updated }, null, 2),
  };
};
