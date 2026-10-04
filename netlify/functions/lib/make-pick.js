/**
 * Combat — shared "make one draft pick" logic
 *
 * Used by both draft-pick.js (a human clicking a fighter) and
 * autopick-check.js (the scheduled function that picks for a team whose
 * clock ran out). Pulling this out of draft-pick.js means both paths
 * validate, insert, advance the clock, finalize, and notify identically —
 * an autopick is just a regular pick with is_autopick: true, never a
 * separate code path that could drift out of sync with the real rules.
 *
 * Returns a plain result object (no HTTP shape) so either caller can
 * translate it into whatever response/log format it needs:
 *   { ok: true, pick, next, finalize }
 *   { ok: false, statusCode, error, reason? }
 */

const { validatePick, snakeTeamForPick, TOTAL_SLOTS_PER_TEAM } = require('./draft-engine');
const { finalizeDraftRoom } = require('./finalize-draft-room');
const { notifySubscribers } = require('./push');

async function makePick(supabase, { draftRoomId, teamId, fighterId, role, division, isAutopick }) {
  const { data: room, error: roomError } = await supabase
    .from('draft_rooms')
    .select('id, status, team_order, pick_seconds')
    .eq('id', draftRoomId)
    .maybeSingle();

  if (roomError) {
    return { ok: false, statusCode: 500, error: 'Draft room lookup failed', details: roomError.message };
  }
  if (!room) {
    return { ok: false, statusCode: 404, error: `No draft room found for id ${draftRoomId}` };
  }
  if (room.status !== 'active') {
    return {
      ok: false,
      statusCode: 409,
      error: room.status === 'pending'
        ? "This draft hasn't started yet"
        : 'This draft room has already completed',
    };
  }
  if (!Array.isArray(room.team_order) || room.team_order.length === 0) {
    return { ok: false, statusCode: 500, error: 'This draft room has no team_order set — cannot validate picks' };
  }

  const { data: picks, error: picksError } = await supabase
    .from('draft_picks')
    .select('team_id, fighter_id, role, slot_type')
    .eq('draft_room_id', draftRoomId)
    .order('pick_number', { ascending: true });

  if (picksError) {
    return { ok: false, statusCode: 500, error: 'Picks lookup failed', details: picksError.message };
  }

  const engineRoom = { team_order: room.team_order };
  const result = validatePick(engineRoom, picks || [], { teamId, fighterId, role });

  if (!result.legal) {
    return { ok: false, statusCode: 409, error: 'Illegal pick', reason: result.reason };
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
    const isRaceConflict = insertError.code === '23505';
    return {
      ok: false,
      statusCode: isRaceConflict ? 409 : 500,
      error: isRaceConflict ? 'Pick lost a race with another pick — refresh and retry' : 'Pick insert failed',
      details: insertError.message,
    };
  }

  const nextStatus = {
    phase: result.phase,
    pickNumber: result.pickNumber,
    roundNumber: result.roundNumber,
    roundInPhase: result.roundInPhase,
    roundsInPhase: result.roundsInPhase,
  };

  const isRoomsLastPick = result.pickNumber === TOTAL_SLOTS_PER_TEAM * room.team_order.length;

  // Advance (or clear) the pick clock. Best-effort — never undoes the pick.
  await supabase
    .from('draft_rooms')
    .update({
      current_pick_number: result.pickNumber + 1,
      current_pick_deadline: isRoomsLastPick ? null : new Date(Date.now() + room.pick_seconds * 1000).toISOString(),
    })
    .eq('id', draftRoomId);

  let finalize = null;
  if (isRoomsLastPick) {
    const { data: allPicks, error: allPicksError } = await supabase
      .from('draft_picks')
      .select('team_id, division, fighter_id, slot_type, role, role_slot_number')
      .eq('draft_room_id', draftRoomId);

    if (allPicksError) {
      finalize = { error: `Could not load picks to finalize: ${allPicksError.message}` };
    } else {
      finalize = await finalizeDraftRoom(supabase, draftRoomId, room.team_order, allPicks || []);
    }
  }

  if (!isRoomsLastPick) {
    const nextTeamId = snakeTeamForPick(room.team_order, result.pickNumber + 1);
    await notifySubscribers(supabase, 'pick', {
      title: "You're on the clock",
      body: `Pick ${result.pickNumber + 1} is yours in Combat`,
      url: '/draft.html',
    }, { teamId: nextTeamId });
  }

  return { ok: true, pick: inserted, next: nextStatus, finalize };
}

module.exports = { makePick };
