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

/**
 * Tokens in a string, near enough to budget with.
 *
 * Roughly 3.5 characters per token for English prose. Deliberately a little
 * PESSIMISTIC: overestimating costs a smaller batch, underestimating costs a
 * 429 that no amount of retrying can clear, because the retry re-sends the
 * same oversized request.
 */
export function estimateTokens(text) {
  return Math.ceil(String(text).length / 3.5);
}

/**
 * How many of these passages fit in one request.
 *
 * Both ceilings matter and they are enforced separately by the provider: a
 * request count per minute, and a TOKEN count per minute. Sizing by count
 * alone is what let a 96-passage batch of 46,000 tokens go out against a
 * 30,000 token ceiling -- rejected on the first attempt, every attempt.
 *
 * Always returns at least one, even when a single passage exceeds the whole
 * token budget. Refusing it would strand the document, and the provider will
 * say so itself if it really is too large.
 */
export function fitBatch(contents, { maxCount, maxTokens }) {
  let count = 0;
  let tokens = 0;

  for (const content of contents) {
    if (count >= maxCount) break;

    const next = estimateTokens(content);
    if (count > 0 && tokens + next > maxTokens) break;

    tokens += next;
    count += 1;
  }

  return Math.max(1, count);
}
