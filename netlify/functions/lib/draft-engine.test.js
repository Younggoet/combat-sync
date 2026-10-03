/**
 * Combat — draft-engine self-test (role-based rewrite, Oct 3 2026)
 *
 * No test framework, no dependencies — just plain Node assertions you can
 * run with: node netlify/functions/lib/draft-engine.test.js
 *
 * This is where draft rules get proven BEFORE any Supabase table or UI
 * touches this logic. If something fails here, it's a bug in the rules
 * themselves, not in a screen or a query.
 */

const assert = require('assert');
const {
  ROLES,
  ACTIVE_SLOTS_PER_TEAM,
  CAGESIDE_SLOTS_PER_TEAM,
  TOTAL_SLOTS_PER_TEAM,
  snakeTeamForPick,
  getPhase,
  validatePick,
  getDraftStatus,
  isValidRole,
  openRoleSlots,
} = require('./draft-engine');

const TEAMS = ['t1', 't2', 't3', 't4']; // 4 teams for a small, easy-to-trace test
const room = { team_order: TEAMS };

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${label}`);
  } catch (err) {
    console.error(`FAIL  - ${label}`);
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('role shape');
check('10 active slots per team (3 Primary, 3 Striker, 2 Grappler, 2 Finisher)', () => {
  assert.strictEqual(ACTIVE_SLOTS_PER_TEAM, 10);
  assert.strictEqual(ROLES.PRIMARY.activeCap, 3);
  assert.strictEqual(ROLES.STRIKER.activeCap, 3);
  assert.strictEqual(ROLES.GRAPPLER.activeCap, 2);
  assert.strictEqual(ROLES.FINISHER.activeCap, 2);
});
check('40 cage side slots per team (12/12/8/8)', () => {
  assert.strictEqual(CAGESIDE_SLOTS_PER_TEAM, 40);
  assert.strictEqual(ROLES.PRIMARY.cageCap, 12);
  assert.strictEqual(ROLES.STRIKER.cageCap, 12);
  assert.strictEqual(ROLES.GRAPPLER.cageCap, 8);
  assert.strictEqual(ROLES.FINISHER.cageCap, 8);
});
check('50 total slots per team', () => {
  assert.strictEqual(TOTAL_SLOTS_PER_TEAM, 50);
});

console.log('snake order (unchanged from the division-based engine)');
check('pick 1 is team 1 (round 1 forward)', () => {
  assert.strictEqual(snakeTeamForPick(TEAMS, 1), 't1');
});
check('pick 4 is team 4 (end of round 1)', () => {
  assert.strictEqual(snakeTeamForPick(TEAMS, 4), 't4');
});
check('pick 5 is team 4 again (round 2 reverses)', () => {
  assert.strictEqual(snakeTeamForPick(TEAMS, 5), 't4');
});

console.log('phase detection');
check('pick 1 is active, round 1 of 10', () => {
  const p = getPhase(1, 4);
  assert.strictEqual(p.phase, 'active');
  assert.strictEqual(p.roundInPhase, 1);
  assert.strictEqual(p.roundsInPhase, 10);
});
check('pick 40 (10 active rounds x 4 teams) is the last active pick', () => {
  assert.strictEqual(getPhase(40, 4).phase, 'active');
});
check('pick 41 rolls into cage side, round 1 of cage side', () => {
  const p = getPhase(41, 4);
  assert.strictEqual(p.phase, 'cageside');
  assert.strictEqual(p.roundInPhase, 1);
});
check('pick 200 (40 active + 160 cageside, 40 rounds x 4 teams) is the last cageside pick', () => {
  assert.strictEqual(getPhase(200, 4).phase, 'cageside');
});
check('pick 201 is complete — nothing left to draft', () => {
  assert.strictEqual(getPhase(201, 4).phase, 'complete');
});

console.log('isValidRole');
check('all 4 roles are recognized', () => {
  ['PRIMARY', 'STRIKER', 'GRAPPLER', 'FINISHER'].forEach((r) => assert.strictEqual(isValidRole(r), true, r));
});
check('a made-up role is rejected', () => {
  assert.strictEqual(isValidRole('CONTENDER'), false);
});

console.log('validatePick — active phase');
check('a legal first pick for team 1 into Primary', () => {
  const result = validatePick(room, [], { teamId: 't1', fighterId: 'f1', role: 'PRIMARY' });
  assert.strictEqual(result.legal, true, result.reason || '');
  assert.strictEqual(result.slotType, 'active');
  assert.strictEqual(result.roleSlotNumber, 1);
});
check('wrong team on the clock is rejected', () => {
  const result = validatePick(room, [], { teamId: 't2', fighterId: 'f1', role: 'PRIMARY' });
  assert.strictEqual(result.legal, false);
  assert.match(result.reason, /on the clock/);
});
check('an invalid role is rejected', () => {
  const result = validatePick(room, [], { teamId: 't1', fighterId: 'f1', role: 'CONTENDER' });
  assert.strictEqual(result.legal, false);
  assert.match(result.reason, /not one of the 4 roles/);
});
check('no division is ever checked — any (or no) division string is accepted', () => {
  const result = validatePick(room, [], { teamId: 't1', fighterId: 'f1', role: 'PRIMARY', division: 'HEAVYWEIGHT' });
  const resultNoDiv = validatePick(room, [], { teamId: 't1', fighterId: 'f1', role: 'PRIMARY' });
  assert.strictEqual(result.legal, true);
  assert.strictEqual(resultNoDiv.legal, true);
});
check('a role fills up to its active cap, then the next pick to that role is rejected', () => {
  // Team 1's active picks land on pick 1, then every 4th pick after (snake
  // order with 4 teams round-trips back to t1 every other round boundary;
  // walk it honestly via snakeTeamForPick rather than hand-waving it).
  let picks = [];
  let pickNum = 1;
  let t1GrapplerPicks = 0;
  let sawRejection = false;
  while (t1GrapplerPicks < ROLES.GRAPPLER.activeCap + 1 && pickNum <= ACTIVE_SLOTS_PER_TEAM * 4) {
    const team = snakeTeamForPick(TEAMS, pickNum);
    if (team === 't1') {
      t1GrapplerPicks++;
      const result = validatePick(room, picks, { teamId: 't1', fighterId: `t1-g-${t1GrapplerPicks}`, role: 'GRAPPLER' });
      if (t1GrapplerPicks <= ROLES.GRAPPLER.activeCap) {
        assert.strictEqual(result.legal, true, result.reason || '');
        picks.push({ team_id: 't1', fighter_id: `t1-g-${t1GrapplerPicks}`, role: 'GRAPPLER', slot_type: 'active' });
      } else {
        assert.strictEqual(result.legal, false);
        assert.match(result.reason, /already has 2 active slots filled at GRAPPLER/);
        sawRejection = true;
        break;
      }
    } else {
      // everyone else just fills Primary so the draft keeps moving
      const result = validatePick(room, picks, { teamId: team, fighterId: `filler-${pickNum}`, role: 'PRIMARY' });
      assert.strictEqual(result.legal, true, result.reason || '');
      picks.push({ team_id: team, fighter_id: `filler-${pickNum}`, role: 'PRIMARY', slot_type: 'active' });
    }
    pickNum++;
  }
  assert.strictEqual(sawRejection, true, 'never got to test the 3rd Grappler pick being rejected');
});
check('a fighter already drafted anywhere in the room is rejected', () => {
  const picksSoFar = [{ team_id: 't1', fighter_id: 'f1', role: 'PRIMARY', slot_type: 'active' }];
  const result = validatePick(room, picksSoFar, { teamId: 't2', fighterId: 'f1', role: 'STRIKER' });
  assert.strictEqual(result.legal, false);
  assert.match(result.reason, /already been drafted/);
});

console.log('validatePick — cage side phase');
check('cage side allows up to a role\'s cap (Finisher = 8), then blocks the next one', () => {
  // Burn through all 40 active picks (10 rounds x 4 teams) first, split
  // evenly across roles per team so every team's active slots are full
  // before cage side starts.
  let picks = [];
  const roleOrder = ['PRIMARY', 'PRIMARY', 'PRIMARY', 'STRIKER', 'STRIKER', 'STRIKER', 'GRAPPLER', 'GRAPPLER', 'FINISHER', 'FINISHER'];
  const teamRoleIndex = { t1: 0, t2: 0, t3: 0, t4: 0 };
  for (let i = 1; i <= ACTIVE_SLOTS_PER_TEAM * 4; i++) {
    const team = snakeTeamForPick(TEAMS, i);
    const role = roleOrder[teamRoleIndex[team]];
    teamRoleIndex[team]++;
    const result = validatePick(room, picks, { teamId: team, fighterId: `active-${i}`, role });
    assert.strictEqual(result.legal, true, result.reason || '');
    picks.push({ team_id: team, fighter_id: `active-${i}`, role, slot_type: 'active' });
  }
  assert.strictEqual(getDraftStatus(room, picks).phase, 'cageside');

  let t1FinisherAttempts = 0;
  let sawRejection = false;
  while (true) {
    const status = getDraftStatus(room, picks);
    if (status.phase !== 'cageside') break;

    if (status.onTheClock === 't1') {
      t1FinisherAttempts++;
      const result = validatePick(room, picks, { teamId: 't1', fighterId: `t1-cs-fin-${t1FinisherAttempts}`, role: 'FINISHER' });
      if (t1FinisherAttempts <= ROLES.FINISHER.cageCap) {
        assert.strictEqual(result.legal, true, result.reason || '');
        picks.push({ team_id: 't1', fighter_id: `t1-cs-fin-${t1FinisherAttempts}`, role: 'FINISHER', slot_type: 'cageside' });
      } else {
        assert.strictEqual(result.legal, false);
        assert.match(result.reason, /already has 8 cage side slots filled at FINISHER/);
        sawRejection = true;
        break;
      }
    } else {
      const result = validatePick(room, picks, { teamId: status.onTheClock, fighterId: `cs-${picks.length}`, role: 'PRIMARY' });
      assert.strictEqual(result.legal, true, result.reason || '');
      picks.push({ team_id: status.onTheClock, fighter_id: `cs-${picks.length}`, role: 'PRIMARY', slot_type: 'cageside' });
    }
  }

  assert.strictEqual(
    sawRejection,
    true,
    'never got to test team 1 attempting a 9th Finisher cage side pick'
  );
});

console.log('getDraftStatus');
check('an empty room has team 1 on the clock, pick 1, active phase', () => {
  const status = getDraftStatus(room, []);
  assert.strictEqual(status.onTheClock, 't1');
  assert.strictEqual(status.pickNumber, 1);
  assert.strictEqual(status.phase, 'active');
});

console.log('openRoleSlots');
check('an empty room shows every role fully open', () => {
  const open = openRoleSlots([], 't1');
  const primary = open.find((r) => r.role === 'PRIMARY');
  const finisher = open.find((r) => r.role === 'FINISHER');
  assert.strictEqual(primary.activeOpen, 3);
  assert.strictEqual(primary.cageOpen, 12);
  assert.strictEqual(finisher.activeOpen, 2);
  assert.strictEqual(finisher.cageOpen, 8);
});
check('open counts shrink as a team drafts into a role', () => {
  const picks = [
    { team_id: 't1', fighter_id: 'f1', role: 'STRIKER', slot_type: 'active' },
    { team_id: 't1', fighter_id: 'f2', role: 'STRIKER', slot_type: 'active' },
  ];
  const striker = openRoleSlots(picks, 't1').find((r) => r.role === 'STRIKER');
  assert.strictEqual(striker.activeOpen, 1);
});

console.log(`\n${passed} checks passed${process.exitCode ? ', SOME FAILED — see above' : ''}`);
