/**
 * Combat — Netlify function: league-settings
 *
 * GET /.netlify/functions/league-settings?league_id=<uuid>
 *
 * Read-only endpoint for the commissioner settings page: every team in the
 * league, plus the league's current "pending" draft room (if one exists)
 * so the page can show whatever team_order/pick_seconds were already
 * saved rather than starting blank every time.
 *
 * Returns:
 *   {
 *     league: { id, name },
 *     teams: [{ id, name }, ...],          // every team in the league
 *     draftRoom: {                          // null if none exists yet
 *       id, status, pickSeconds, teamOrder
 *     } | null
 *   }
 */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const leagueId = params.league_id;

  if (!leagueId) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Provide ?league_id=...' }),
    };
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: league, error: leagueError } = await supabase
    .from('leagues')
    .select('id, name, commissioner_user_id')
    .eq('id', leagueId)
    .maybeSingle();

  if (leagueError) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'League lookup failed', details: leagueError.message }),
    };
  }
  if (!league) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `No league found for id ${leagueId}` }),
    };
  }

  const { data: teams, error: teamsError } = await supabase
    .from('teams')
    .select('id, name, photo_url, owner_user_id')
    .eq('league_id', leagueId)
    .order('name', { ascending: true });

  if (teamsError) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Teams lookup failed', details: teamsError.message }),
    };
  }

  // Most recent room regardless of status — the settings page already
  // locks its inputs once status isn't 'pending', and draft.html needs
  // the room's id and status whatever state it's in (pending to start
  // it, active to show the live draft, complete to point at rosters).
  const { data: draftRoom, error: roomError } = await supabase
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

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      {
        league,
        teams: teams || [],
        draftRoom: draftRoom
          ? { id: draftRoom.id, status: draftRoom.status, pickSeconds: draftRoom.pick_seconds, teamOrder: draftRoom.team_order }
          : null,
      },
      null,
      2
    ),
  };
};
