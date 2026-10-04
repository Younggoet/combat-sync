/**
 * Combat — Netlify scheduled function: autopick-check
 *
 * Runs on a timer (see [functions."autopick-check"] in netlify.toml) —
 * never called directly. Finds every 'active' draft room whose pick
 * clock has expired and makes the pick for whichever team is on the
 * clock, exactly as if a human had drafted the highest-rated fighter
 * still on the board into their first open role. Fires whether or not
 * that team's owner is online — confirmed with William Oct 4 2026.
 *
 * Reuses lib/make-pick.js (is_autopick: true) so an autopick is
 * validated and inserted through the exact same legality rules as a
 * real pick — this file's only job is deciding WHICH fighter/role to
 * hand it.
 */

const { createClient } = require('@supabase/supabase-js');
const { ROLE_NAMES, getPhase, openRoleSlots, snakeTeamForPick } = require('./lib/draft-engine');
const { makePick } = require('./lib/make-pick');

exports.handler = async () => {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: dueRooms, error: roomsError } = await supabase
    .from('draft_rooms')
    .select('id, team_order')
    .eq('status', 'active')
    .lt('current_pick_deadline', new Date().toISOString());

  if (roomsError) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Lookup failed', details: roomsError.message }) };
  }

  const results = [];

  for (const room of dueRooms || []) {
    const result = await autopickOne(supabase, room);
    results.push({ roomId: room.id, ...result });
  }

  return { statusCode: 200, body: JSON.stringify({ checked: (dueRooms || []).length, results }, null, 2) };
};

async function autopickOne(supabase, room) {
  const { data: picks, error: picksError } = await supabase
    .from('draft_picks')
    .select('team_id, fighter_id, role, slot_type')
    .eq('draft_room_id', room.id);

  if (picksError) {
    return { ok: false, error: `Picks lookup failed: ${picksError.message}` };
  }

  const existingPicks = picks || [];
  const nextPickNumber = existingPicks.length + 1;
  const teamCount = room.team_order.length;
  const { phase } = getPhase(nextPickNumber, teamCount);

  if (phase === 'complete') {
    // Nothing left to pick — the clock should already be null from the
    // last pick, but clear it defensively so this room stops showing up.
    await supabase.from('draft_rooms').update({ current_pick_deadline: null }).eq('id', room.id);
    return { ok: true, skipped: 'room already complete' };
  }

  const teamId = snakeTeamForPick(room.team_order, nextPickNumber);
  const openSlots = openRoleSlots(existingPicks, teamId);
  const openField = phase === 'active' ? 'activeOpen' : 'cageOpen';
  const role = ROLE_NAMES
    .map((r) => openSlots.find((s) => s.role === r))
    .find((s) => s && s[openField] > 0);

  if (!role) {
    return { ok: false, error: `No open role found for team ${teamId} in phase ${phase} — data inconsistency` };
  }

  const takenFighterIds = existingPicks.map((p) => p.fighter_id);
  const { data: candidates, error: fightersError } = await supabase
    .from('fighters')
    .select('id')
    .order('current_rating', { ascending: false })
    .limit(takenFighterIds.length + 20);

  if (fightersError) {
    return { ok: false, error: `Fighter lookup failed: ${fightersError.message}` };
  }

  const fighter = (candidates || []).find((f) => !takenFighterIds.includes(f.id));
  if (!fighter) {
    return { ok: false, error: 'No undrafted fighter found — pool may be exhausted' };
  }

  const pickResult = await makePick(supabase, {
    draftRoomId: room.id,
    teamId,
    fighterId: fighter.id,
    role: role.role,
    division: null,
    isAutopick: true,
  });

  if (!pickResult.ok) {
    return { ok: false, error: pickResult.error, reason: pickResult.reason };
  }

  return { ok: true, teamId, fighterId: fighter.id, role: role.role, pickNumber: pickResult.pick.pick_number };
}
