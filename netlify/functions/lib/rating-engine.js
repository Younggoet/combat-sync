/**
 * Combat — stat-based rating + role-ranking engine (pure logic, no Supabase,
 * no HTTP). Same build philosophy as draft-engine.js: plain data in, plain
 * data out, fully testable against fake fights before it ever touches
 * Supabase or a screen.
 *
 * WHAT THIS REPLACES: every fighter's current_rating sat at the flat
 * placeholder default (1500, identical for all 687 fighters) because the
 * rating engine described in memory/planning docs was never actually built.
 * This module is that engine.
 *
 * LOCKED SPEC THIS ENCODES:
 *  - Standard Fight Points formula (locked Sept 11-12 2026): sig strikes
 *    landed 0.1 pt, takedowns landed 2 pts, knockdowns 8 pts, control time
 *    1 pt/min, submission attempts 1.5 pts, reversals 6 pts, takedown
 *    defense 0.5 pt per defended takedown (opponent's attempted - landed).
 *  - Fight Points are stat-based regardless of win/loss (confirmed Sept 27).
 *  - Overall rating moves based on Fight Points scored vs. EXPECTED (given
 *    both fighters' current ratings), not win/loss (confirmed Sept 27) —
 *    implemented here as a two-player, zero-sum Elo where each fighter's
 *    "score" for the bout is their share of the two fighters' combined
 *    Fight Points (ptsMe / (ptsMe + ptsOpp)), compared against the
 *    standard Elo expected-score curve.
 *  - Role multipliers (from the Oct 2 2026 Dynasty engine header comment):
 *    Striker 1.5x on knockdowns + sig strikes landed; Grappler 1.5x on
 *    control time + takedowns landed + submission attempts; Finisher gets
 *    a flat +10 bonus on any fight they won by KO/TKO or submission;
 *    reversals and takedown defense always stay flat (1.0x) for every role.
 *    Primary has no multiplier — it's the flex slot, ranked by the same
 *    overall rating as everyone else.
 */

const POINTS = {
  SIG_STRIKE_LANDED: 0.1,
  TAKEDOWN_LANDED: 2,
  KNOCKDOWN: 8,
  CONTROL_TIME_PER_MIN: 1,
  SUBMISSION_ATTEMPT: 1.5,
  REVERSAL: 6,
  TAKEDOWN_DEFENDED: 0.5,
};

const FINISH_METHODS = ['KO/TKO', "TKO - Doctor's Stoppage", 'SUB', 'Submission'];

function num(v) {
  return Number(v) || 0;
}

/** Raw, role-free Fight Points for one fighter's stat line in one fight. */
function baseFightPoints(myStats, opponentStats) {
  const sigStrikes = num(myStats.sig_strikes_landed) * POINTS.SIG_STRIKE_LANDED;
  const takedowns = num(myStats.takedowns_landed) * POINTS.TAKEDOWN_LANDED;
  const knockdowns = num(myStats.knockdowns) * POINTS.KNOCKDOWN;
  const control = (num(myStats.control_time_seconds) / 60) * POINTS.CONTROL_TIME_PER_MIN;
  const subAttempts = num(myStats.submission_attempts) * POINTS.SUBMISSION_ATTEMPT;
  const reversals = num(myStats.reversals) * POINTS.REVERSAL;
  const oppAttempted = opponentStats ? num(opponentStats.takedowns_attempted) : 0;
  const oppLanded = opponentStats ? num(opponentStats.takedowns_landed) : 0;
  const tdDefense = Math.max(0, oppAttempted - oppLanded) * POINTS.TAKEDOWN_DEFENDED;
  return sigStrikes + takedowns + knockdowns + control + subAttempts + reversals + tdDefense;
}

function isFinishWin(method, won) {
  return won && !!method && FINISH_METHODS.includes(method);
}

/**
 * Role-weighted Fight Points for one fighter's stat line in one fight.
 * @param {string} role - PRIMARY | STRIKER | GRAPPLER | FINISHER
 * @param {object} myStats
 * @param {object} opponentStats
 * @param {boolean} wonByFinish - true if this fighter won this fight by
 *   KO/TKO or submission (only matters for FINISHER)
 */
function roleFightPoints(role, myStats, opponentStats, wonByFinish) {
  const sigStrikePts = num(myStats.sig_strikes_landed) * POINTS.SIG_STRIKE_LANDED;
  const takedownPts = num(myStats.takedowns_landed) * POINTS.TAKEDOWN_LANDED;
  const knockdownPts = num(myStats.knockdowns) * POINTS.KNOCKDOWN;
  const controlPts = (num(myStats.control_time_seconds) / 60) * POINTS.CONTROL_TIME_PER_MIN;
  const subAttemptPts = num(myStats.submission_attempts) * POINTS.SUBMISSION_ATTEMPT;
  const reversalPts = num(myStats.reversals) * POINTS.REVERSAL; // always flat
  const oppAttempted = opponentStats ? num(opponentStats.takedowns_attempted) : 0;
  const oppLanded = opponentStats ? num(opponentStats.takedowns_landed) : 0;
  const tdDefensePts = Math.max(0, oppAttempted - oppLanded) * POINTS.TAKEDOWN_DEFENDED; // always flat

  const strikerMult = role === 'STRIKER' ? 1.5 : 1;
  const grapplerMult = role === 'GRAPPLER' ? 1.5 : 1;

  const striking = (knockdownPts + sigStrikePts) * strikerMult;
  const grappling = (controlPts + takedownPts + subAttemptPts) * grapplerMult;
  const flat = reversalPts + tdDefensePts;
  const finishBonus = role === 'FINISHER' && wonByFinish ? 10 : 0;

  return striking + grappling + flat + finishBonus;
}

/**
 * Standard Elo expected score for player A, given both ratings.
 */
function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * One bout's rating update for both fighters. Zero-sum: whatever A gains,
 * B loses, same as standard Elo.
 *
 * @param {number} ratingA
 * @param {number} ratingB
 * @param {number} pointsA - fighter A's base Fight Points this bout
 * @param {number} pointsB - fighter B's base Fight Points this bout
 * @param {number} k - rating volatility factor (default 32, same order of
 *   magnitude as standard chess Elo)
 * @returns {{newRatingA: number, newRatingB: number, deltaA: number}}
 */
function eloUpdate(ratingA, ratingB, pointsA, pointsB, k = 32) {
  const total = pointsA + pointsB;
  // Neither fighter registered any scoring stats (e.g. a decision with no
  // synced breakdown) — nothing to judge performance against, so the fight
  // is skipped entirely rather than guessing a 50/50 split.
  if (total <= 0) {
    return { newRatingA: ratingA, newRatingB: ratingB, deltaA: 0 };
  }
  const actualA = pointsA / total;
  const expectedA = expectedScore(ratingA, ratingB);
  const deltaA = k * (actualA - expectedA);
  return {
    newRatingA: ratingA + deltaA,
    newRatingB: ratingB - deltaA,
    deltaA,
  };
}

module.exports = {
  POINTS,
  FINISH_METHODS,
  baseFightPoints,
  roleFightPoints,
  isFinishWin,
  expectedScore,
  eloUpdate,
};
