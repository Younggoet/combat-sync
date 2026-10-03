/**
 * Combat — name-matching news articles against the fighters table
 *
 * RSS feeds have no idea our `fighters` table exists — there's no
 * fighter_id on an article, just free text. This does the only thing
 * that's actually possible against free text: looks for each fighter's
 * full name (and nickname, if they have one) as a whole-word, case-
 * insensitive phrase inside an article's title + description.
 *
 * Known limitations, on purpose rather than by accident:
 *   - Common surnames can false-positive if a fighter's FULL name happens
 *     to also belong to someone else mentioned in an article. Matching
 *     the full "First Last" phrase (not just the last name alone) cuts
 *     this down a lot, but doesn't eliminate it.
 *   - Alternate spellings, nicknames the fighter is known by that aren't
 *     in their `nickname` column, and name order variations (e.g. a
 *     fighter referred to by nickname only) won't match.
 *   - This is a "good enough to be useful" first version, not a claim of
 *     perfect accuracy. If mismatches show up in practice, tightening
 *     this is a software change here, not a schema change.
 */

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds one matcher per fighter (full name, plus nickname if present),
 * each as a word-boundary, case-insensitive regex.
 *
 * @param {object[]} fighters - each at least { id, full_name, nickname }
 * @returns {object[]} [{ fighterId, name, regex }]
 */
function buildFighterMatchers(fighters) {
  const matchers = [];
  for (const f of fighters) {
    if (f.full_name && f.full_name.trim().length > 0) {
      matchers.push({
        fighterId: f.id,
        name: f.full_name,
        regex: new RegExp(`\\b${escapeRegex(f.full_name)}\\b`, 'i'),
      });
    }
    if (f.nickname && f.nickname.trim().length > 0) {
      matchers.push({
        fighterId: f.id,
        name: f.nickname,
        regex: new RegExp(`\\b${escapeRegex(f.nickname)}\\b`, 'i'),
      });
    }
  }
  return matchers;
}

/**
 * Which fighters (if any) a single article's text mentions.
 *
 * @param {string} text - article title + description, already concatenated
 * @param {object[]} matchers - from buildFighterMatchers()
 * @returns {object[]} [{ fighterId, name }] — one entry per matching
 *   fighter (if BOTH their full name and nickname match, only the full
 *   name match is kept, since it's the stronger signal)
 */
function matchFightersInText(text, matchers) {
  const matchedByFighter = new Map();
  for (const m of matchers) {
    if (matchedByFighter.has(m.fighterId)) continue; // already matched (by full name, most likely)
    if (m.regex.test(text)) {
      matchedByFighter.set(m.fighterId, m.name);
    }
  }
  return Array.from(matchedByFighter, ([fighterId, name]) => ({ fighterId, name }));
}

module.exports = { escapeRegex, buildFighterMatchers, matchFightersInText };
