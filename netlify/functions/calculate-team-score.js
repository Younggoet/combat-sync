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
 * Requires: netlify/functions/scoring.js sitting next to this file.
 */

const { createClient } = require('@supabase/supabase-js');
const { calculateFightPoints } = require('./scoring');

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

  // 1. Get this team's ACTIVE roster slots only
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

  // 2. For each active fighter, find every bout they have stats for
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

    // Find this fighter's performances (one row per bout they were in)
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
      // This fighter's whole-fight stats (round_number = 0)
      const { data: ownStats } = await supabase
        .from('mma_stats')
        .select('*')
        .eq('performance_id', perf.id)
        .eq('round_number', 0)
        .maybeSingle();

      if (!ownStats) continue;

      // Find the OPPONENT's performance in the same bout
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
