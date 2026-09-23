/**
 * Combat — Standard Fight Points scoring function
 *
 * Takes raw stats for ONE fighter's performance in ONE bout (a row from
 * the mma_stats table, WHOLE-FIGHT totals — see note below on round_number)
 * and returns their Fight Points total, using the locked Standard point
 * values:
 *
 *   Sig strikes landed        0.1 pt each
 *   Takedowns landed          2 pts each
 *   Knockdowns                8 pts each
 *   Control time               1 pt per minute
 *   Submission attempts       1 pt each
 *   Reversals                 6 pts each
 *   Takedown defense          0.5 pts per defended takedown
 *
 * SCHEMA NOTE: mma_stats stores control time as control_time_seconds
 * (a plain integer), and everything else as plain integer counts —
 * no "X of Y" string parsing needed, unlike Cito's raw API shape.
 *
 * ROUND_NUMBER NOTE: mma_stats has one row per round PLUS a row where
 * round_number = 0, which holds the whole-fight totals (per the
 * existing sync-bout-detail.js convention). This function expects to
 * be called with that round_number = 0 row for each fighter — pull
 * WHERE performance_id = ? AND round_number = 0 when fetching, not
 * the per-round rows, unless you specifically want round-by-round
 * scoring later.
 *
 * Takedown defense is the one stat that needs the OPPONENT's row, not
 * just this fighter's own: it's the opponent's takedowns_attempted
 * minus their takedowns_landed (how many of the opponent's takedown
 * attempts this fighter stopped). So this function takes both
 * fighters' round_number = 0 rows for the bout.
 */

// ---- Point values (Standard mode) ----
const POINTS = {
  SIG_STRIKE_LANDED: 0.1,
  TAKEDOWN_LANDED: 2,
  KNOCKDOWN: 8,
  CONTROL_TIME_PER_MIN: 1,
  SUBMISSION_ATTEMPT: 1,
  REVERSAL: 6,
  TAKEDOWN_DEFENDED: 0.5,
};

/**
 * Calculates a single fighter's Standard Fight Points for one bout.
 *
 * @param {object} fighterStats - mma_stats row for this fighter, round_number = 0
 * @param {object} opponentStats - mma_stats row for the OTHER fighter, round_number = 0
 *   (needed only for the takedown-defense calc)
 * @returns {object} { total, breakdown } — breakdown shows each category's contribution
 */
function calculateFightPoints(fighterStats, opponentStats) {
  const sigStrikesLanded = Number(fighterStats.sig_strikes_landed) || 0;
  const takedownsLanded = Number(fighterStats.takedowns_landed) || 0;
  const knockdowns = Number(fighterStats.knockdowns) || 0;
  const controlMinutes = (Number(fighterStats.control_time_seconds) || 0) / 60;
  const submissionAttempts = Number(fighterStats.submission_attempts) || 0;
  const reversals = Number(fighterStats.reversals) || 0;

  // Takedown defense: how many of the OPPONENT's takedown attempts
  // did NOT land (i.e. this fighter stopped them).
  const opponentAttempted = opponentStats
    ? Number(opponentStats.takedowns_attempted) || 0
    : 0;
  const opponentLanded = opponentStats
    ? Number(opponentStats.takedowns_landed) || 0
    : 0;
  const takedownsDefended = Math.max(0, opponentAttempted - opponentLanded);

  const breakdown = {
    sigStrikes: sigStrikesLanded * POINTS.SIG_STRIKE_LANDED,
    takedowns: takedownsLanded * POINTS.TAKEDOWN_LANDED,
    knockdowns: knockdowns * POINTS.KNOCKDOWN,
    controlTime: controlMinutes * POINTS.CONTROL_TIME_PER_MIN,
    submissionAttempts: submissionAttempts * POINTS.SUBMISSION_ATTEMPT,
    reversals: reversals * POINTS.REVERSAL,
    takedownDefense: takedownsDefended * POINTS.TAKEDOWN_DEFENDED,
  };

  const total = Object.values(breakdown).reduce((sum, v) => sum + v, 0);

  return {
    total: Math.round(total * 100) / 100, // round to 2 decimals
    breakdown,
  };
}

module.exports = {
  calculateFightPoints,
  POINTS,
};
