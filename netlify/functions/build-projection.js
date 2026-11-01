// netlify/functions/build-projection.js
//
// Builds a fighter's projection (fighters.avg_* and td_def_pct) straight from
// Cito, for fighters whose past UFC fights were never loaded into our own
// bouts/performances tables. Averages are per-fight means of the whole-fight
// totals over their most recent completed UFC fights (default 5), the same
// meaning the existing avg_* columns have. Writes ONLY those fighter columns.
// A fighter with no completed UFC fight on Cito is left alone (true debut).
//
// USAGE: /.netlify/functions/build-projection?names=Hecher%20Sosa,Islam%20Dulatov&dryRun=true
//   names  - comma-separated fighter names (must already exist in fighters)
//   last   - how many recent fights to average (default 5)
//   dryRun - "true" to show what would be written without writing

import { createClient } from '@supabase/supabase-js';

const BASE = 'https://api.citoapi.com/api/v1';
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const cito = async (p) => {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(BASE + p, { headers: { 'x-api-key': process.env.CITO_API_KEY } });
    if (r.status === 429) { await new Promise((z) => setTimeout(z, 1000 * (i + 1))); continue; }
    if (!r.ok) throw new Error(`Cito ${p} -> ${r.status}`);
    return r.json();
  }
  throw new Error(`Cito ${p} -> 429`);
};
const arr = (x, keys) => Array.isArray(x) ? x : (keys.map((k) => x?.[k] || x?.data?.[k]).find(Array.isArray) || (Array.isArray(x?.data) ? x.data : []));
const json = (s, b) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { 'Content-Type': 'application/json' } });
const xy = (s) => { const m = String(s || '').match(/(\d+)\s*of\s*(\d+)/i); return m ? { l: +m[1], a: +m[2] } : { l: 0, a: 0 }; };
const ctl = (s) => { const m = String(s || '').match(/(\d+):(\d+)/); return m ? +m[1] * 60 + +m[2] : 0; };
const sum = (rounds) => rounds.reduce((t, r) => {
  t.ss += xy(r.significantStrikes).l; t.tdl += xy(r.takedowns).l; t.tda += xy(r.takedowns).a;
  t.kd += r.knockdowns || 0; t.ctrl += ctl(r.controlTime); t.sub += r.submissionAttempts || 0; t.rev += r.reversals || 0; return t;
}, { ss: 0, tdl: 0, tda: 0, kd: 0, ctrl: 0, sub: 0, rev: 0 });

export default async (req) => {
  const u = new URL(req.url);
  const names = (u.searchParams.get('names') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const last = parseInt(u.searchParams.get('last') || '5', 10);
  const dry = u.searchParams.get('dryRun') === 'true';
  if (!names.length) return json(400, { error: 'Add ?names=A,B' });
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const today = new Date().toISOString().slice(0, 10);
  const dateOf = (x) => String(x.eventDate || x.event?.eventDate || x.event?.date || x.date || '').slice(0, 10);
  const idOf = (f) => f.bout?.dataId || f.bout?.id || f.boutId || f.bout_id || f.dataId || f.id || f.fightId;
  const out = [];

  for (const name of names) {
    const r = { name };
    try {
      const { data: row } = await sb.from('fighters').select('id,full_name').ilike('full_name', name).maybeSingle();
      if (!row) throw new Error('not in our fighters table');
      const sr = arr(await cito(`/ufc/search?q=${encodeURIComponent(name)}`), ['fighters', 'results']);
      const m = sr.find((x) => norm(x.fighterName || x.name) === norm(name));
      const slug = m && (m.slug || m.fighterSlug);
      if (!slug) throw new Error('exact name not found on Cito');
      const list = arr(await cito(`/ufc/fighters/${slug}/fights`), ['fights']);
      r.fights_listed = list.length;
      if (list[0]) r.sample_keys = Object.keys(list[0]);
      const past = list.filter((x) => { const d = dateOf(x); return d && d < today && /^\d+$/.test(String(idOf(x))); })
        .sort((a, b) => dateOf(b).localeCompare(dateOf(a))).slice(0, last);
      const per = [], defs = { att: 0, land: 0 };
      for (const f of past) {
        const d = (await cito(`/ufc/bouts/${idOf(f)}`)); const data = d.data || d;
        const rs = data.roundStats || data.boutStats || [];
        const mine = rs.filter((x) => x.fighterSlug === slug);
        const theirs = rs.filter((x) => x.fighterSlug && x.fighterSlug !== slug);
        if (!mine.length) continue;
        const t = sum(mine), o = sum(theirs);
        defs.att += o.tda; defs.land += o.tdl;
        per.push({ date: dateOf(f), opp: f.opponent?.name || f.opponentName || '', ...t });
      }
      r.fights_used = per.length;
      r.per_fight = per;
      if (!per.length) { r.status = 'no completed UFC fights with stats on Cito, left as debut'; out.push(r); continue; }
      const avg = (k, d) => +(per.reduce((s, x) => s + x[k], 0) / per.length).toFixed(d);
      const patch = {
        avg_sig_strikes: avg('ss', 1), avg_takedowns: avg('tdl', 1), avg_knockdowns: avg('kd', 2),
        avg_control_seconds: Math.round(avg('ctrl', 0)), avg_sub_attempts: avg('sub', 1), avg_reversals: avg('rev', 2),
        td_def_pct: defs.att ? +((defs.att - defs.land) / defs.att).toFixed(3) : 0,
      };
      r.patch = patch;
      if (!dry) { const { error } = await sb.from('fighters').update(patch).eq('id', row.id); if (error) throw new Error(error.message); }
      r.status = dry ? 'would write' : 'written';
    } catch (e) { r.status = 'error'; r.reason = e.message; }
    out.push(r);
  }
  return json(200, { dryRun: dry, results: out });
};
