/**
 * Combat — Netlify function: draft-pick
 *
 * POST /.netlify/functions/draft-pick
 * Body: { "draft_room_id": "<uuid>", "team_id": "<uuid>", "fighter_id": "<uuid>",
 *          "role": "PRIMARY" | "STRIKER" | "GRAPPLER" | "FINISHER",
 *          "division": "<string, optional, descriptive only>",
 *          "is_autopick": boolean (optional, default false) }
 *
 * Makes one draft pick. Loads the room + every pick made so far, asks the
 * pure draft-engine (lib/draft-engine.js) whether the proposed pick is
 * legal (right team on the clock, fighter not already taken, role not at
 * cap for the current phase), and if so inserts the row into draft_picks.
 *
 * The engine is the single source of truth for legality — this function
 * never re-implements any of those rules, it just loads data in and
 * writes the engine's decision out. The table's own UNIQUE constraints
 * (draft_room_id+pick_number, draft_room_id+fighter_id,
 * draft_room_id+team_id+role+slot_type+role_slot_number) are a second,
 * database-level backstop against two simultaneous requests both passing
 * validation and racing each other — if that happens, the loser's insert
 * fails with a 409 instead of corrupting the room.
 *
 * NOT done here (by design, not oversight): when a draft room finishes
 * (status -> 'complete'), nothing here copies its draft_picks rows into
 * the standing `rosters` table. That finalize-the-room step still needs
 * to be designed and built — flagging it rather than guessing at it.
 */

const { createClient } = require('@supabase/supabase-js');
const { validatePick } = require('./lib/draft-engine');

exports.handler = async (event, context) => {
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

  const { draft_room_id: draftRoomId, team_id: teamId, fighter_id: fighterId, role, division, is_autopick: isAutopick } = body;

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

  const { data: room, error: roomError } = await supabase
    .from('draft_rooms')
    .select('id, status, team_order')
    .eq('id', draftRoomId)
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
      body: JSON.stringify({ error: `No draft room found for id ${draftRoomId}` }),
    };
  }

  if (!Array.isArray(room.team_order) || room.team_order.length === 0) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'This draft room has no team_order set — cannot validate picks' }),
    };
  }

  const { data: picks, error: picksError } = await supabase
    .from('draft_picks')
    .select('team_id, fighter_id, role, slot_type')
    .eq('draft_room_id', draftRoomId)
    .order('pick_number', { ascending: true });

  if (picksError) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Picks lookup failed', details: picksError.message }),
    };
  }

  const engineRoom = { team_order: room.team_order };
  const result = validatePick(engineRoom, picks || [], { teamId, fighterId, role });

  if (!result.legal) {
    return {
      statusCode: 409,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Illegal pick', reason: result.reason }),
    };
  }

  const { data: inserted, error: insertError } = await supabase
    .from('draft_picks')
    .insert({
      draft_room_id: draftRoomId,
      pick_number: result.pickNumber,
      round_number: result.roundNumber,
      team_id: teamId,
      division: division ?? null,
      fighter_id: fighterId,
      slot_type: result.slotType,
      role: result.role,
      role_slot_number: result.roleSlotNumber,
      is_autopick: !!isAutopick,
      picked_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertError) {
    // A unique-constraint violation here means another request won a race
    // against this one (same pick_number, fighter, or role slot) between
    // our validation read and this write — not a bug, just two picks
    // arriving at once. Surface it as a 409 so the client re-fetches
    // draft-room and retries with fresh state, same as a normal illegal pick.
    const isRaceConflict = insertError.code === '23505'; // Postgres unique_violation
    return {
      statusCode: isRaceConflict ? 409 : 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: isRaceConflict ? 'Pick lost a race with another pick — refresh and retry' : 'Pick insert failed',
        details: insertError.message,
      }),
    };
  }

  const nextStatus = {
    phase: result.phase,
    pickNumber: result.pickNumber,
    roundNumber: result.roundNumber,
    roundInPhase: result.roundInPhase,
    roundsInPhase: result.roundsInPhase,
  };

  // Keep draft_rooms.current_pick_number in sync so anything reading the
  // room row directly (not just via draft-room.js) sees where things stand.
  // Best-effort: a failure here doesn't undo the pick that was just made.
  await supabase
    .from('draft_rooms')
    .update({ current_pick_number: result.pickNumber + 1 })
    .eq('id', draftRoomId);

  return {
    statusCode: 201,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pick: inserted, next: nextStatus }, null, 2),
  };
};
