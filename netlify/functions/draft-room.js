/**
 * Combat — Netlify function: draft-room
 *
 * GET /.netlify/functions/draft-room?room_id=<uuid>
 *
 * Read-only status endpoint for a live draft room. Loads the room config
 * and every pick made so far from Supabase, then hands them to the pure
 * draft-engine (lib/draft-engine.js) to compute whose turn it is, what
 * phase/round the draft is in, and which role slots each team still has
 * open. A draft-room UI polls this (or wires it to Supabase Realtime on
 * draft_picks) to know what to render next.
 *
 * Returns:
 *   {
 *     room: { id, status, pickSeconds, teamOrder },
 *     status: { phase, onTheClock, pickNumber, roundNumber, roundInPhase, roundsInPhase },
 *     picks: [...],                 // every pick made so far, in order
 *     openRoleSlots: { [teamId]: [{ role, activeOpen, cageOpen }, ...] }
 *   }
 */

const { createClient } = require('@supabase/supabase-js');
const { getDraftStatus, openRoleSlots } = require('./lib/draft-engine');

exports.handler = async (event, context) => {
  const params = event.queryStringParameters || {};
  const roomId = params.room_id;

  if (!roomId) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Provide ?room_id=...' }),
    };
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: room, error: roomError } = await supabase
    .from('draft_rooms')
    .select('id, league_id, format, status, pick_seconds, team_order, current_pick_number, started_at, completed_at, current_pick_deadline')
    .eq('id', roomId)
    .maybeSingle();

  if (roomError) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Draft room lookup failed', details: roomError.message }),
    };
  }

  if (!room) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `No draft room found for id ${roomId}` }),
    };
  }

  if (!Array.isArray(room.team_order) || room.team_order.length === 0) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'This draft room has no team_order set — cannot compute draft status' }),
    };
  }

  const { data: picks, error: picksError } = await supabase
    .from('draft_picks')
    .select('id, pick_number, round_number, team_id, division, fighter_id, slot_type, role, role_slot_number, is_autopick, picked_at')
    .eq('draft_room_id', roomId)
    .order('pick_number', { ascending: true });

  if (picksError) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Picks lookup failed', details: picksError.message }),
    };
  }

  const engineRoom = { team_order: room.team_order };
  const engineExistingPicks = (picks || []).map((p) => ({
    team_id: p.team_id,
    fighter_id: p.fighter_id,
    role: p.role,
    slot_type: p.slot_type,
  }));

  const status = getDraftStatus(engineRoom, engineExistingPicks);

  const openSlotsByTeam = {};
  for (const teamId of room.team_order) {
    openSlotsByTeam[teamId] = openRoleSlots(engineExistingPicks, teamId);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      {
        room: {
          id: room.id,
          leagueId: room.league_id,
          format: room.format,
          status: room.status,
          pickSeconds: room.pick_seconds,
          teamOrder: room.team_order,
          startedAt: room.started_at,
          currentPickDeadline: room.current_pick_deadline,
          completedAt: room.completed_at,
        },
        status,
        picks: picks || [],
        openRoleSlots: openSlotsByTeam,
      },
      null,
      2
    ),
  };
};
