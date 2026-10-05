/**
 * Plain assert-based tests for rating-engine.js — run with:
 *   node netlify/functions/lib/rating-engine.test.js
 * No test framework, no DB, no network. Mirrors the style of
 * draft-engine.test.js (schema-first build order: pure logic tested
 * against fake data before it ever touches Supabase).
 */
const assert = require('assert');
const {
  baseFightPoints,
  roleFightPoints,
  isFinishWin,
  expectedScore,
  eloUpdate,
} = require('./rating-engine');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log('rating-engine.js');

test('baseFightPoints: zero stats -> zero points', () => {
  const stats = { sig_strikes_landed: 0, takedowns_landed: 0, knockdowns: 0, control_time_seconds: 0, submission_attempts: 0, reversals: 0 };
  assert.strictEqual(baseFightPoints(stats, null), 0);
});

test('baseFightPoints: locked point values applied correctly', () => {
  const stats = {
    sig_strikes_landed: 50, // 5.0
    takedowns_landed: 2,    // 4.0
    knockdowns: 1,          // 8.0
    control_time_seconds: 300, // 5 min -> 5.0
    submission_attempts: 2, // 3.0
    reversals: 1,            // 6.0
  };
  const opp = { takedowns_attempted: 5, takedowns_landed: 2 }; // defended 3 -> 1.5
  const total = baseFightPoints(stats, opp);
  assert.strictEqual(total, 5 + 4 + 8 + 5 + 3 + 6 + 1.5);
});

test('baseFightPoints: missing opponent stats treated as zero takedown defense', () => {
  const stats = { sig_strikes_landed: 10 };
  assert.strictEqual(baseFightPoints(stats, null), 1);
});

test('roleFightPoints: STRIKER gets 1.5x on knockdowns + sig strikes only', () => {
  const stats = { sig_strikes_landed: 10, takedowns_landed: 1, knockdowns: 1, control_time_seconds: 60, submission_attempts: 1, reversals: 0 };
  const primary = roleFightPoints('PRIMARY', stats, null, false);
  const striker = roleFightPoints('STRIKER', stats, null, false);
  const strikingPart = (1 * 8 + 10 * 0.1); // knockdown + sig strikes base
  assert.strictEqual(striker - primary, strikingPart * 0.5); // the extra 0.5x on top of the base 1x
});

test('roleFightPoints: GRAPPLER gets 1.5x on control+takedowns+subAttempts only', () => {
  const stats = { sig_strikes_landed: 10, takedowns_landed: 1, knockdowns: 1, control_time_seconds: 60, submission_attempts: 1, reversals: 0 };
  const primary = roleFightPoints('PRIMARY', stats, null, false);
  const grappler = roleFightPoints('GRAPPLER', stats, null, false);
  const grapplingPart = (1 + 1 * 2 + 1 * 1.5); // control(1min) + takedown + subAttempt base
  assert.strictEqual(grappler - primary, grapplingPart * 0.5);
});

test('roleFightPoints: FINISHER gets +10 flat only on a finish win, nothing on a decision win', () => {
  const stats = { sig_strikes_landed: 0, takedowns_landed: 0, knockdowns: 0, control_time_seconds: 0, submission_attempts: 0, reversals: 0 };
  const withFinish = roleFightPoints('FINISHER', stats, null, true);
  const withoutFinish = roleFightPoints('FINISHER', stats, null, false);
  assert.strictEqual(withFinish - withoutFinish, 10);
});

test('roleFightPoints: reversals and takedown defense never get the role multiplier', () => {
  const stats = { sig_strikes_landed: 0, takedowns_landed: 0, knockdowns: 0, control_time_seconds: 0, submission_attempts: 0, reversals: 2 };
  const opp = { takedowns_attempted: 4, takedowns_landed: 0 };
  const primary = roleFightPoints('PRIMARY', stats, opp, false);
  const striker = roleFightPoints('STRIKER', stats, opp, false);
  const grappler = roleFightPoints('GRAPPLER', stats, opp, false);
  assert.strictEqual(primary, striker);
  assert.strictEqual(primary, grappler);
  assert.strictEqual(primary, 2 * 6 + 4 * 0.5); // reversals + full takedown defense, flat
});

test('isFinishWin: true only when won AND method is a real finish', () => {
  assert.strictEqual(isFinishWin('KO/TKO', true), true);
  assert.strictEqual(isFinishWin('Submission', true), true);
  assert.strictEqual(isFinishWin('KO/TKO', false), false); // lost by KO/TKO doesn't count
  assert.strictEqual(isFinishWin('U-DEC', true), false); // decision win isn't a finish
  assert.strictEqual(isFinishWin(null, true), false);
});

test('expectedScore: equal ratings -> 0.5 each', () => {
  assert.strictEqual(expectedScore(1500, 1500), 0.5);
});

test('expectedScore: higher-rated fighter has >0.5 expectation', () => {
  assert.ok(expectedScore(1700, 1500) > 0.5);
  assert.ok(expectedScore(1500, 1700) < 0.5);
});

test('eloUpdate: equal ratings + equal performance -> no rating change', () => {
  const { newRatingA, newRatingB, deltaA } = eloUpdate(1500, 1500, 10, 10, 32);
  assert.strictEqual(deltaA, 0);
  assert.strictEqual(newRatingA, 1500);
  assert.strictEqual(newRatingB, 1500);
});

test('eloUpdate: zero-sum -- A gains exactly what B loses', () => {
  const { newRatingA, newRatingB } = eloUpdate(1500, 1550, 30, 5, 32);
  assert.strictEqual((newRatingA - 1500) + (newRatingB - 1550), 0);
});

test('eloUpdate: underdog outperforming a big favorite gains more than an even matchup would', () => {
  const evenMatch = eloUpdate(1500, 1500, 20, 10, 32); // 2:1 points ratio, even ratings
  const underdogUpset = eloUpdate(1400, 1700, 20, 10, 32); // same 2:1 points ratio, big underdog
  assert.ok(underdogUpset.deltaA > evenMatch.deltaA);
});

test('eloUpdate: a decision with no synced stats on either side is skipped (no change)', () => {
  const { newRatingA, newRatingB, deltaA } = eloUpdate(1500, 1600, 0, 0, 32);
  assert.strictEqual(deltaA, 0);
  assert.strictEqual(newRatingA, 1500);
  assert.strictEqual(newRatingB, 1600);
});

test('eloUpdate: losing fighter can still gain rating if their stat-line beat expectation', () => {
  // Heavy favorite (1800) vs underdog (1300) -- favorite "wins" the decision
  // in real life, but underdog puts up way better stats this simulation.
  const { deltaA } = eloUpdate(1800, 1300, 5, 40, 32); // A = favorite, scored worse
  assert.ok(deltaA < 0); // favorite's rating drops despite being the stronger fighter on paper
});

console.log(`\n${passed} passed`);
