/**
 * Combat — Dynasty draft engine (pure logic, no Supabase, no HTTP)
 *
 * REWRITTEN Oct 3 2026 — role-based slots replace the old division-based
 * model entirely. Everything here still takes plain data in and returns
 * plain data out — no network calls, no database reads/writes. Test it
 * with fake rooms/picks (see draft-engine.test.js) before it ever touches
 * Supabase or a screen.
 *
 * DYNASTY RULES THIS ENCODES (confirmed with William, Oct 2-3 2026):
 *   - 50 fighters per team: 10 Active role slots + 40 Cage side slots.
 *   - Active roles and counts: Primary x3, Striker x3, Grappler x2,
 *     Finisher x2. (Women's and Contender roles were floated Oct 2 and
 *     dropped Oct 3 — Finisher doubled up to fill the slot instead.)
 *   - There is NO division restriction anywhere in this model. A manager
 *     drafts whichever fighter they want, in whatever real weight class,
 *     then chooses which ROLE to place that pick into. The fighter's
 *     actual division is just descriptive metadata carried alongside the
 *     pick — it never gates legality.
 *   - Active phase: exactly 10 picks per team (one per active slot). Each
 *     pick is assigned to a role; once a role hits its cap (3/3/2/2) no
 *     more active picks can go to it.
 *   - Cage side phase: comes after Active, 40 picks per team. Each pick is
 *     assigned into one role's cage side pool, capped at
 *     (that role's active slot count) x 4 — so Primary/Striker cap at 12
 *     cage side picks each, Grappler/Finisher cap at 8 each (12+12+8+8=40).
 *   - A fighter can only be drafted once per room, period, in either phase.
 *   - Snake draft order: round 1 goes team_order forward, round 2 goes it
 *     in reverse, round 3 forward again, etc. (unchanged from before).
 *
 * Scoring multipliers (Striker 1.5x KD + sig strikes, Grappler 1.5x
 * control + TD + sub attempts, Finisher +10 flat per KO/TKO or submission,
 * reversals/TD defense always flat) live in the scoring layer, not here —
 * this module only governs what's a LEGAL pick.
 */

const ROLES = {
  PRIMARY: { activeCap: 3, cageCap: 12 },
  STRIKER: { activeCap: 3, cageCap: 12 },
  GRAPPLER: { activeCap: 2, cageCap: 8 },
  FINISHER: { activeCap: 2, cageCap: 8 },
};

const ROLE_NAMES = Object.keys(ROLES);

const ACTIVE_SLOTS_PER_TEAM = Object.values(ROLES).reduce((sum, r) => sum + r.activeCap, 0); // 10
const CAGESIDE_SLOTS_PER_TEAM = Object.values(ROLES).reduce((sum, r) => sum + r.cageCap, 0); // 40
const TOTAL_SLOTS_PER_TEAM = ACTIVE_SLOTS_PER_TEAM + CAGESIDE_SLOTS_PER_TEAM; // 50

function isValidRole(role) {
  return ROLE_NAMES.includes(role);
}

/**
 * Which team is on the clock for a given overall pick number, in a
 * standard snake order. Unchanged from the division-based engine.
 *
 * @param {string[]} teamOrder - team_ids in round-1 order (draft_rooms.team_order)
 * @param {number} pickNumber - 1-indexed overall pick number
 * @returns {string} team_id
 */
function snakeTeamForPick(teamOrder, pickNumber) {
  if (pickNumber < 1) throw new Error('pickNumber must be >= 1');
  const teamCount = teamOrder.length;
  const roundIndex0 = Math.floor((pickNumber - 1) / teamCount); // 0-based round
  const positionInRound0 = (pickNumber - 1) % teamCount;
  const reversed = roundIndex0 % 2 === 1;
  const position = reversed ? teamCount - 1 - positionInRound0 : positionInRound0;
  return teamOrder[position];
}

/**
 * Which round (1-indexed, overall — does NOT reset at the start of cage
 * side; use getPhase for a phase-relative round number) a pick falls in.
 */
function roundNumberForPick(pickNumber, teamCount) {
  if (pickNumber < 1) throw new Error('pickNumber must be >= 1');
  return Math.floor((pickNumber - 1) / teamCount) + 1;
}

/**
 * Which phase a given overall pick number falls in, plus round numbers
 * relative to that phase (e.g. "round 2 of cage side" rather than
 * "round 13 overall").
 */
function getPhase(pickNumber, teamCount) {
  const activePicks = ACTIVE_SLOTS_PER_TEAM * teamCount;
  const cagesidePicks = CAGESIDE_SLOTS_PER_TEAM * teamCount;

  if (pickNumber <= activePicks) {
    return {
      phase: 'active',
      roundInPhase: Math.floor((pickNumber - 1) / teamCount) + 1,
      roundsInPhase: ACTIVE_SLOTS_PER_TEAM,
    };
  }
  if (pickNumber <= activePicks + cagesidePicks) {
    const pickWithinCageside = pickNumber - activePicks;
    return {
      phase: 'cageside',
      roundInPhase: Math.floor((pickWithinCageside - 1) / teamCount) + 1,
      roundsInPhase: CAGESIDE_SLOTS_PER_TEAM,
    };
  }
  return { phase: 'complete', roundInPhase: null, roundsInPhase: null };
}

/**
 * How many picks a team already has in a given role, for a given slot
 * type ('active' or 'cageside'), from the existing picks list.
 */
function roleCountForTeam(existingPicks, teamId, role, slotType) {
  return existingPicks.filter(
    (p) => p.team_id === teamId && p.role === role && p.slot_type === slotType
  ).length;
}

/**
 * Checks whether a fighter has already been drafted anywhere in this room.
 */
function isFighterTaken(existingPicks, fighterId) {
  return existingPicks.some((p) => p.fighter_id === fighterId);
}

/**
 * The main gate: given a room's config, the picks made so far, and a
 * proposed pick, says whether it's legal and why not if it isn't.
 *
 * @param {object} room - { team_order }
 * @param {object[]} existingPicks - picks already made in this room, each
 *   at least { team_id, fighter_id, role, slot_type }
 * @param {object} proposed - { teamId, fighterId, role, division? }
 *   division is optional, descriptive-only — never checked for legality.
 * @returns {object} result — see shape below
 */
function validatePick(room, existingPicks, proposed) {
  const { teamId, fighterId, role } = proposed;
  const teamCount = room.team_order.length;
  const nextPickNumber = existingPicks.length + 1;

  const base = { legal: false, pickNumber: nextPickNumber, reason: null };

  if (!isValidRole(role)) {
    return { ...base, reason: `"${role}" is not one of the 4 roles (${ROLE_NAMES.join(', ')})` };
  }

  const { phase, roundInPhase, roundsInPhase } = getPhase(nextPickNumber, teamCount);

  if (phase === 'complete') {
    return { ...base, reason: 'This draft room has no picks left — Active and Cage side are both full' };
  }

  const expectedTeam = snakeTeamForPick(room.team_order, nextPickNumber);
  if (teamId !== expectedTeam) {
    return { ...base, reason: `It's not this team's pick — team ${expectedTeam} is on the clock` };
  }

  if (isFighterTaken(existingPicks, fighterId)) {
    return { ...base, reason: 'This fighter has already been drafted in this room' };
  }

  const slotType = phase === 'active' ? 'active' : 'cageside';
  const cap = phase === 'active' ? ROLES[role].activeCap : ROLES[role].cageCap;
  const countSoFar = roleCountForTeam(existingPicks, teamId, role, slotType);

  if (countSoFar >= cap) {
    const label = phase === 'active' ? 'active slots' : 'cage side slots';
    return {
      ...base,
      reason: `This team already has ${cap} ${label} filled at ${role}`,
    };
  }

  return {
    legal: true,
    reason: null,
    pickNumber: nextPickNumber,
    roundNumber: roundNumberForPick(nextPickNumber, teamCount),
    phase,
    roundInPhase,
    roundsInPhase,
    slotType,
    role,
    roleSlotNumber: countSoFar + 1,
  };
}

/**
 * Convenience summary for a room given its picks so far — what a draft
 * room UI would poll for: whose turn, what phase/round, is it over.
 */
function getDraftStatus(room, existingPicks) {
  const teamCount = room.team_order.length;
  const nextPickNumber = existingPicks.length + 1;
  const { phase, roundInPhase, roundsInPhase } = getPhase(nextPickNumber, teamCount);

  if (phase === 'complete') {
    return { phase: 'complete', onTheClock: null, pickNumber: null, roundInPhase: null, roundsInPhase: null };
  }

  return {
    phase,
    onTheClock: snakeTeamForPick(room.team_order, nextPickNumber),
    pickNumber: nextPickNumber,
    roundNumber: roundNumberForPick(nextPickNumber, teamCount),
    roundInPhase,
    roundsInPhase,
  };
}

/**
 * How many role slots (active + cage side) a team still has open, broken
 * out by role — handy for a draft-room UI deciding which role buttons to
 * show as pickable for the fighter currently being drafted.
 */
function openRoleSlots(existingPicks, teamId) {
  return ROLE_NAMES.map((role) => {
    const activeCount = roleCountForTeam(existingPicks, teamId, role, 'active');
    const cageCount = roleCountForTeam(existingPicks, teamId, role, 'cageside');
    return {
      role,
      activeOpen: ROLES[role].activeCap - activeCount,
      cageOpen: ROLES[role].cageCap - cageCount,
    };
  });
}

module.exports = {
  ROLES,
  ROLE_NAMES,
  ACTIVE_SLOTS_PER_TEAM,
  CAGESIDE_SLOTS_PER_TEAM,
  TOTAL_SLOTS_PER_TEAM,
  isValidRole,
  snakeTeamForPick,
  roundNumberForPick,
  getPhase,
  roleCountForTeam,
  isFighterTaken,
  validatePick,
  getDraftStatus,
  openRoleSlots,
};
