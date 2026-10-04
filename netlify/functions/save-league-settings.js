/**
 * Combat — Netlify function: save-league-settings
 *
 * POST /.netlify/functions/save-league-settings
 * Body: { league_id, team_order: [team_id, ...], pick_seconds }
 *
 * Commissioner settings: seeds (or updates) the league's pending draft
 * room with a team draft order and a pick timer — the two fields
 * draft_rooms already has for this. No auth exists yet in Combat, so
 * — same trust level as everything else today — anyone with the page
 * can call this; the guardrails here are about data integrity, not
 * who's allowed to use it:
 *
 *   - team_order must be every team in the league, used exactly once
 *     (no missing/duplicate/foreign team ids), 8 or 10 teams long
 *   - a draft room that has already started or completed is never
 *     touched — its order is locked in by the real picks already made
 */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Use POST' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { league_id, team_order, pick_seconds } = body;

  if (!league_id || !Array.isArray(team_order) || team_order.length === 0) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Provide league_id and a non-empty team_order array' }),
    };
  }
  if (![8, 10].includes(team_order.length)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `team_order must have 8 or 10 teams, got ${team_order.length}` }),
    };
  }
  const uniqueCount = new Set(team_order).size;
  if (uniqueCount !== team_order.length) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'team_order has duplicate team ids' }),
    };
  }
  const pickSeconds = Number.isFinite(pick_seconds) ? pick_seconds : 90;
  if (pickSeconds < 10 || pickSeconds > 600) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'pick_seconds must be between 10 and 600' }),
    };
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: teams, error: teamsError } = await supabase
    .from('teams')
    .select('id')
    .eq('league_id', league_id);

  if (teamsError) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Teams lookup failed', details: teamsError.message }),
    };
  }

  const validTeamIds = new Set((teams || []).map((t) => t.id));
  const everyTeamValid = team_order.every((id) => validTeamIds.has(id));
  if (!everyTeamValid) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'team_order includes a team that is not in this league' }),
    };
  }

  const { data: existingRoom, error: existingError } = await supabase
    .from('draft_rooms')
    .select('id, status')
    .eq('league_id', league_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingError) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Draft room lookup failed', details: existingError.message }),
    };
  }

  if (existingRoom && existingRoom.status !== 'pending') {
    return {
      statusCode: 409,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `This league's draft room has already ${existingRoom.status === 'complete' ? 'completed' : 'started'} — team order can't be changed anymore` }),
    };
  }

  let savedRoom;
  if (existingRoom) {
    const { data: updated, error: updateError } = await supabase
      .from('draft_rooms')
      .update({ team_order, pick_seconds: pickSeconds })
      .eq('id', existingRoom.id)
      .select('id, status, pick_seconds, team_order')
      .single();
    if (updateError) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Saving settings failed', details: updateError.message }),
      };
    }
    savedRoom = updated;
  } else {
    const { data: inserted, error: insertError } = await supabase
      .from('draft_rooms')
      .insert({ league_id, team_order, pick_seconds: pickSeconds, format: 'role_based_dynasty', status: 'pending' })
      .select('id, status, pick_seconds, team_order')
      .single();
    if (insertError) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Creating draft room failed', details: insertError.message }),
      };
    }
    savedRoom = inserted;
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      draftRoom: {
        id: savedRoom.id,
        status: savedRoom.status,
        pickSeconds: savedRoom.pick_seconds,
        teamOrder: savedRoom.team_order,
      },
    }, null, 2),
  };
};
