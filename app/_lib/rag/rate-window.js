// A sliding-window rate limiter for a provider that counts per minute.
//
// Extracted from embed.js so it can be tested without the network. That is not
// ceremony: the first version of this logic cleared its window on a 429, which
// reads as "nothing sent recently" — a FULL allowance — and so bursted
// straight back into the limit. Nine documents failed in a row. The behaviour
// below is what the tests pin down.

/**
 * @param {object} options
 * @param {number} options.limit       requests allowed per window
 * @param {number} [options.windowMs]  window length, default 60s
 * @param {() => number} [options.now] injectable clock, for tests
 * @param {(ms: number) => Promise<void>} [options.sleep] injectable delay
 */
export function createRateWindow({ limit, windowMs = 60_000, now = Date.now, sleep }) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let recent = [];
  let blockedUntil = 0;

  return {
    /** Hold until `count` more requests fit. */
    async reserve(count) {
      for (;;) {
        const at = now();

        // A server-declared block outranks local accounting: the API knows
        // what it actually counted; this window can only estimate.
        if (at < blockedUntil) {
          await wait(blockedUntil - at + 250);
          continue;
        }

        recent = recent.filter((stamp) => at - stamp < windowMs);

        if (recent.length + count <= limit) {
          for (let i = 0; i < count; i++) recent.push(at);
          return;
        }

        await wait(windowMs - (at - recent[0]) + 250);
      }
    },

    /**
     * Record that the provider rejected us for `ms`.
     *
     * The window is marked FULLY SPENT rather than cleared. Clearing it would
     * say "no recent requests", which is the opposite of being rate limited.
     */
    block(ms) {
      const at = now();
      blockedUntil = at + ms;
      recent = Array.from({ length: limit }, () => at);
    },

    /** For tests and diagnostics. */
    state() {
      return { used: recent.length, blockedUntil };
    },
  };
}
