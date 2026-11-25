// netlify/functions/cito-bkfc-profiles.js
// Fills the BKFC fighter profiles (bkfc_fighters) and fight logs (bkfc_fight_log)
// straight from Cito /bkfc/fighters/{slug}. Touches ONLY the bkfc_* tables.
// Photos are stored as Cito URLs plus the rights-holder credit (BKFC), unaltered.
//
// USAGE: /.netlify/functions/cito-bkfc-profiles?offset=0&limit=12     (batches, 58 fighters)
//        /.netlify/functions/cito-bkfc-profiles?slug=bryce-henry
//        add &dryRun=true to see what would be written
import { createClient } from '@supabase/supabase-js';

const BASE = 'https://api.citoapi.com/api/v1';
const cito = async (p) => {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(BASE + p, { headers: { 'x-api-key': process.env.CITO_API_KEY } });
    if (r.status === 429) { await new Promise((z) => setTimeout(z, 1000 * (i + 1))); continue; }
    if (!r.ok) throw new Error(`Cito ${p} -> ${r.status}`);
    return r.json();
  }
  throw new Error(`Cito ${p} -> 429`);
};
const json = (s, b) => new Response(JSON.stringify(b, null, 1), { status: s, headers: { 'Content-Type': 'application/json' } });

export default async (req) => {
  const u = new URL(req.url);
  const slug = u.searchParams.get('slug');
  const offset = +(u.searchParams.get('offset') || 0), limit = +(u.searchParams.get('limit') || 12);
  const dry = u.searchParams.get('dryRun') === 'true';
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  let q = sb.from('bkfc_fighters').select('id,cito_slug,full_name').order('cito_slug');
  q = slug ? q.eq('cito_slug', slug) : q.range(offset, offset + limit - 1);
  const { data: fs, error } = await q;
  if (error) return json(500, { error: error.message });
  const out = [];
  for (const f of fs) {
    try {
      const j = await cito('/bkfc/fighters/' + f.cito_slug);
      const d = j.data || j;
      const rec = d.record || {};
      const upd = {
        full_name: d.name || f.full_name, nickname: d.nickname || null, gender: d.gender || null,
        nationality: d.nationality || null, birth_month: d.birthMonth || null, status: d.status || null,
        height_cm: d.heightCm ?? null, reach_cm: d.reachCm ?? null,
        wins: rec.wins ?? null, losses: rec.losses ?? null, draws: rec.draws ?? null, nc: rec.noContests ?? null, ko_wins: rec.koWins ?? null,
        record_source: 'cito', headshot_url: d.headshot?.url || null, headshot_credit: d.headshot?.credit || null,
        last_bout_date: d.lastBoutDate || null, next_bout_date: d.nextBoutDate || null,
        rankings: d.rankings || null, profile_synced_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      const rows = (d.recentFights || []).map((b) => {
        const me = (b.fighters || []).find((x) => x.slug === f.cito_slug) || {};
        const t = me.totals || {}, p = b.perspective || {}, r = b.result || {};
        return {
          fighter_id: f.id, cito_bout_id: b.boutId, fight_date: b.event?.date || null, event_name: b.event?.name || null,
          opponent_slug: p.opponent?.slug || null, opponent_name: p.opponent?.name || null,
          weight_class: b.weightClass?.label || null, is_title_fight: !!b.titleFight, scheduled_rounds: b.scheduledRounds ?? null,
          result: me.result || p.result || null, method: r.method || null, method_text: r.methodText || null, end_round: r.round ?? null, end_time: r.time || null, elapsed_seconds: r.elapsedSeconds ?? null,
          landed: t.landed ?? null, thrown: t.thrown ?? null, accuracy_pct: t.accuracyPct ?? null, knockdowns: t.knockdowns ?? null,
          knocked_down: p.knockedDown ?? null, absorbed: p.absorbed ?? null,
          head_landed: t.headLanded ?? null, body_landed: t.bodyLanded ?? null, distance_landed: t.distanceLanded ?? null, clinch_landed: t.clinchLanded ?? null,
          weigh_in_lb: me.weighInLb ?? null, stats_complete: b.statsComplete ?? null,
        };
      }).filter((r) => r.result && r.cito_bout_id);
      if (!dry) {
        const a = await sb.from('bkfc_fighters').update(upd).eq('id', f.id);
        if (a.error) throw new Error(a.error.message);
        if (rows.length) { const b = await sb.from('bkfc_fight_log').upsert(rows, { onConflict: 'fighter_id,cito_bout_id' }); if (b.error) throw new Error(b.error.message); }
      }
      out.push({ slug: f.cito_slug, name: upd.full_name, nat: upd.nationality, rec: `${upd.wins}-${upd.losses}-${upd.draws}`, photo: !!upd.headshot_url, fights: rows.length });
    } catch (e) { out.push({ slug: f.cito_slug, error: String(e.message || e) }); }
    await new Promise((z) => setTimeout(z, 150));
  }
  return json(200, { dryRun: dry, offset, limit, count: out.length, fighters: out });
};
