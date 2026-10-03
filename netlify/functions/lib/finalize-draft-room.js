/**
 * Combat — finalize a completed draft room into the standing `rosters` table
 *
 * Called automatically by draft-pick.js the instant a real (non-mock)
 * draft room's very last pick lands. For a real Dynasty draft, this *is*
 * the moment the league starts — rosters is what feeds My Corner, the
 * Fight Calendar, the Fight Pool, etc., so finalizing promptly matters.
 *
 * Mock draft rooms never reach this: the mock draft room (the Artifact)
 * runs entirely on fake front-end data today and never creates a real
 * draft_rooms row or calls draft-pick.js, so there's nothing in Supabase
 * for this to fire on by mistake. If the mock draft room is ever wired to
 * real picks later, it will need its own way to stay out of this path
 * (a flag on draft_rooms, a separate table — not decided yet).
 *
 * Confirmed with William (Oct 3 2026): a team's rosters rows are written
 * exactly once, right when its real draft finishes. There is no redraft
 * flow — when a manager leaves the league, whoever replaces them inherits
 * the existing team (and its existing roster) as-is. So finding existing
 * rosters rows for a team here means something unexpected happened (this
 * ran twice, a bug, manual data entry) — the safe move is to refuse and
 * report it for that team, never silently overwrite.
 *
 * @param {object} supabase - an already-configured Supabase client
 * @param {string} roomId - draft_rooms.id
 * @param {string[]} teamOrder - draft_rooms.team_order for this room
 * @param {object[]} allPicks - every draft_picks row for this room, each
 *   with at least { team_id, division, fighter_id, slot_type, role, role_slot_number }
 * @returns {Promise<object>} { finalizedTeams, skippedTeams, roomUpdateError? }
 */
async function finalizeDraftRoom(supabase, roomId, teamOrder, allPicks) {
  const results = { finalizedTeams: [], skippedTeams: [] };

  for (const teamId of teamOrder) {
    const { data: existingRosterRows, error: existingError } = await supabase
      .from('rosters')
      .select('id')
      .eq('team_id', teamId)
      .limit(1);

    if (existingError) {
      results.skippedTeams.push({ teamId, reason: `Roster lookup failed: ${existingError.message}` });
      continue;
    }

    if (existingRosterRows && existingRosterRows.length > 0) {
      results.skippedTeams.push({ teamId, reason: 'Team already has rosters rows — refusing to overwrite' });
      continue;
    }

    const teamPicks = allPicks.filter((p) => p.team_id === teamId);

    if (teamPicks.length === 0) {
      results.skippedTeams.push({ teamId, reason: 'No picks found for this team in this room' });
      continue;
    }

    const rosterRows = teamPicks.map((p) => ({
      team_id: p.team_id,
      division: p.division,
      fighter_id: p.fighter_id,
      slot_type: p.slot_type,
      role: p.role,
      role_slot_number: p.role_slot_number,
    }));

    const { error: insertError } = await supabase.from('rosters').insert(rosterRows);

    if (insertError) {
      results.skippedTeams.push({ teamId, reason: `Roster insert failed: ${insertError.message}` });
      continue;
    }

    results.finalizedTeams.push({ teamId, rosterRowsInserted: rosterRows.length });
  }

  const { error: roomUpdateError } = await supabase
    .from('draft_rooms')
    .update({ status: 'complete', completed_at: new Date().toISOString() })
    .eq('id', roomId);

  if (roomUpdateError) {
    results.roomUpdateError = roomUpdateError.message;
  }

  return results;
}

module.exports = { finalizeDraftRoom };
