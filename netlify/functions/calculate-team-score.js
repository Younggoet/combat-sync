/**
 * Combat — Netlify function: calculate-team-score
 *
 * GET /.netlify/functions/calculate-team-score?team_id=<uuid>
 *
 * Returns a team's total Fight Points, broken down by weight class,
 * using only the fighters sitting in ACTIVE slots (Ringside fighters
 * don't score — they only score once moved into Active).
 *
 * PLACEHOLDER — "current period" not yet decided:
 * This sums a fighter's Fight Points across EVERY fight they have
 * mma_stats for, not filtered to a real scoring window (week/month/
 * Dynasty Period). Once that's decided, add a date filter on the
 * bout's event date here. Flagged clearly so it's a one-line swap
 * later, not a rebuild.
 *
 * NOTE: the scoring logic normally lives in scoring.js, but it's
 * inlined directly here instead of require('./scoring') — Netlify's
 * function bundler was packaging scoring.js as its own separate
 * function rather than including it inside this one, causing this
 * function to crash on cold start with "module not found". Inlining
 * avoids that entirely. If scoring.js needs updating later, update
 * BOTH this copy and the standalone file, or move to a proper
 * shared-utils pattern (e.g. a netlify/functions/lib/ folder,
 * which some bundlers handle differently than top-level files).
 */

const { createClient } = require('@supabase/supabase-js');

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

function calculateFightPoints(fighterStats, opponentStats) {
  const sigStrikesLanded = Number(fighterStats.sig_strikes_landed) || 0;
  const takedownsLanded = Number(fighterStats.takedowns_landed) || 0;
  const knockdowns = Number(fighterStats.knockdowns) || 0;
  const controlMinutes = (Number(fighterStats.control_time_seconds) || 0) / 60;
  const submissionAttempts = Number(fighterStats.submission_attempts) || 0;
  const reversals = Number(fighterStats.reversals) || 0;

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
    total: Math.round(total * 100) / 100,
    breakdown,
  };
}

exports.handler = async (event, context) => {
  const params = event.queryStringParameters || {};
  const teamId = params.team_id;

  if (!teamId) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Provide ?team_id=...' }),
    };
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: activeRoster, error: rosterError } = await supabase
    .from('rosters')
    .select('id, weight_class, fighter_id')
    .eq('team_id', teamId)
    .eq('slot_type', 'active');

  if (rosterError) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Roster lookup failed', details: rosterError.message }),
    };
  }

  if (!activeRoster || activeRoster.length === 0) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, total: 0, byWeightClass: [], note: 'No active roster slots filled yet' }),
    };
  }

  const byWeightClass = [];

  for (const slot of activeRoster) {
    if (!slot.fighter_id) {
      byWeightClass.push({
        weightClass: slot.weight_class,
        fighter: null,
        fightPoints: 0,
        note: 'Slot is empty',
      });
      continue;
    }

    const { data: performances, error: perfError } = await supabase
      .from('performances')
      .select('id, bout_id, fighter_id')
      .eq('fighter_id', slot.fighter_id);

    if (perfError || !performances || performances.length === 0) {
      byWeightClass.push({
        weightClass: slot.weight_class,
        fighter_id: slot.fighter_id,
        fightPoints: 0,
        note: 'No fight history found',
      });
      continue;
    }

    let fighterTotal = 0;
    const fightBreakdown = [];

    for (const perf of performances) {
      const { data: ownStats } = await supabase
        .from('mma_stats')
        .select('*')
        .eq('performance_id', perf.id)
        .eq('round_number', 0)
        .maybeSingle();

      if (!ownStats) continue;

      const { data: opponentPerf } = await supabase
        .from('performances')
        .select('id')
        .eq('bout_id', perf.bout_id)
        .neq('fighter_id', slot.fighter_id)
        .maybeSingle();

      let opponentStats = null;
      if (opponentPerf) {
        const { data: oppStatsRow } = await supabase
          .from('mma_stats')
          .select('*')
          .eq('performance_id', opponentPerf.id)
          .eq('round_number', 0)
          .maybeSingle();
        opponentStats = oppStatsRow;
      }

      const result = calculateFightPoints(ownStats, opponentStats);
      fighterTotal += result.total;
      fightBreakdown.push({ bout_id: perf.bout_id, points: result.total, breakdown: result.breakdown });
    }

    byWeightClass.push({
      weightClass: slot.weight_class,
      fighter_id: slot.fighter_id,
      fightPoints: Math.round(fighterTotal * 100) / 100,
      fights: fightBreakdown,
    });
  }

  const total = Math.round(
    byWeightClass.reduce((sum, wc) => sum + (wc.fightPoints || 0), 0) * 100
  ) / 100;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId, total, byWeightClass }, null, 2),
  };
};
