/**
 * How many passages one indexing request embeds.
 *
 * Pure arithmetic, in its own file with no imports, so it can be tested
 * without dragging in a database client. It used to live in index-pass.js and
 * the test for it pulled the whole Supabase and Next request stack behind it,
 * which does not resolve outside a Next runtime.
 */

/**
 * Embedding is paced by the provider, so this is a time calculation, not a
 * memory one: seconds / 60 x requests-per-minute.
 *
 * It is NOT simply "as many as the budget allows". A pass is also capped at
 * maxPassSeconds, because the pass length is how often the visitor sees the
 * number move. At a full 198-second budget a 460-passage document would report
 * twice in five minutes, which reads as a hang between updates. A shorter pass
 * also loses less work when one fails.
 */
export function passagesPerPass({ budgetSeconds, embedRpm, embedShare, maxPassSeconds = 60 }) {
  const seconds = Math.min(budgetSeconds * embedShare, maxPassSeconds);
  // Never zero: a pass of zero passages never reduces `remaining`, so the
  // browser would loop until its own ceiling stopped it.
  return Math.max(1, Math.floor((seconds / 60) * embedRpm));
}
