/**
 * The "which passages did you actually use" trailer.
 *
 * THE PROBLEM. Retrieval hands the model a dozen passages; the model answers
 * from some subset of them. Without inline [n] markers there is no record of
 * which subset, so a sources list can only show what was RETRIEVED -- and
 * calling that "based on" is a lie the interface tells confidently. It shows
 * up the moment two documents are similar: ask what one customer owes, and a
 * second customer's statement is fetched too (same layout, same words, near
 * identical embedding), ignored by the model, and then credited underneath the
 * answer as a source.
 *
 * THE FIX. The model ends its answer with a machine-readable line naming the
 * passages it relied on. The prose stays clean -- no [1] markers, which is the
 * look that was asked for -- and the trailer is stripped before display.
 *
 * Stripping has to cope with STREAMING: the trailer arrives a character at a
 * time, so "[[us" would flash on screen unless a partial one at the end of the
 * text is also removed. Hence two patterns rather than one.
 */

/** A complete trailer, anywhere in the text. */
const TRAILER = /\[\[\s*used\s*:\s*([^\]]*)\]\]/i;

/**
 * An unterminated "[[..." at the very end -- the trailer mid-arrival.
 * Anchored to the end so a legitimate "[[" earlier in an answer survives.
 */
const PARTIAL = /\[\[[^\]]*$/;

/**
 * Which passage numbers the model says it used.
 *
 * @returns {number[]|null} null when the model did not say -- which is NOT the
 *   same as "used none", and the caller must treat the two differently: the
 *   first means "unknown, do not claim", the second means "answered from
 *   nothing", and showing an empty source list for an unknown is the same lie
 *   in a different shape.
 */
export function parseUsed(text) {
  const match = String(text).match(TRAILER);
  if (!match) return null;

  const numbers = match[1]
    .split(/[,\s]+/)
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isInteger(value) && value > 0);

  // Deduplicated and ordered, because the model lists them however it likes.
  return [...new Set(numbers)].sort((a, b) => a - b);
}

/** The answer as the reader should see it: no trailer, complete or partial. */
export function stripUsed(text) {
  return String(text).replace(TRAILER, "").replace(PARTIAL, "").trimEnd();
}
