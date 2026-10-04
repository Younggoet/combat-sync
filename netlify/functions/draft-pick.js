/**
 * Combat — Netlify function: draft-pick
 *
 * POST /.netlify/functions/draft-pick
 * Header: Authorization: Bearer <supabase access token>
 * Body: { "draft_room_id": "<uuid>", "team_id": "<uuid>", "fighter_id": "<uuid>",
 *          "role": "PRIMARY" | "STRIKER" | "GRAPPLER" | "FINISHER",
 *          "division": "<string, optional, descriptive only>" }
 *
 * Makes one human draft pick. Requires real sign-in: the caller must own
 * the team they're picking for (teams.owner_user_id) or be the league's
 * commissioner picking on someone's behalf. The room must be 'active' —
 * a draft that hasn't been started yet, or has already finished, refuses
 * picks.
 *
 * The actual legality check, insert, clock advance, and finalize-on-last-
 * pick all live in lib/make-pick.js, shared with autopick-check.js (the
 * scheduled function that picks for a team whose clock expired) so a
 * human pick and a bot pick are validated by the exact same rules.
 */

const { createClient } = require('@supabase/supabase-js');
const { makePick } = require('./lib/make-pick');

exports.handler = async (event, context) => {
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
      body: JSON.stringify({ error: 'Sign in to make a pick.' }),
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

  const { draft_room_id: draftRoomId, team_id: teamId, fighter_id: fighterId, role, division } = body;

  const missing = ['draft_room_id', 'team_id', 'fighter_id', 'role'].filter((k) => !body[k]);
  if (missing.length > 0) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Missing required field(s): ${missing.join(', ')}` }),
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

  const { data: team, error: teamError } = await supabase
    .from('teams')
    .select('id, league_id, owner_user_id')
    .eq('id', teamId)
    .maybeSingle();

  if (teamError || !team) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Team not found' }),
    };
  }

  if (team.owner_user_id !== userId) {
    // Not the team's own owner — allow it only if this user is the
    // league's commissioner, picking on an absent manager's behalf.
    const { data: league } = await supabase
      .from('leagues')
      .select('commissioner_user_id')
      .eq('id', team.league_id)
      .maybeSingle();

    if (!league || league.commissioner_user_id !== userId) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: "That's not your team, and you're not this league's commissioner." }),
      };
    }
  }

  const result = await makePick(supabase, {
    draftRoomId,
    teamId,
    fighterId,
    role,
    division,
    isAutopick: false,
  });

  if (!result.ok) {
    return {
      statusCode: result.statusCode,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: result.error, reason: result.reason, details: result.details }),
    };
  }

  return {
    statusCode: 201,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pick: result.pick, next: result.next, finalize: result.finalize }, null, 2),
  };
};
