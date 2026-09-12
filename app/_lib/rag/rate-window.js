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
export function createRateWindow({ limit, windowMs = 60_000, now = Date.now, sleep, minLimit = 1 }) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let recent = [];
  let blockedUntil = 0;
  // The CURRENT belief about the provider's rate, which starts as the
  // configured guess and is lowered by experience. Free-tier limits differ per
  // account and per model and are not discoverable from the API, so a fixed
  // number is a guess either way -- one that corrects itself is a better guess.
  let effective = limit;

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

        if (recent.length + count <= effective) {
          for (let i = 0; i < count; i++) recent.push(at);
          return;
        }

        await wait(windowMs - (at - recent[0]) + 250);
      }
    },

    /**
     * Record that the provider rejected us for `ms`.
     *
     * The block is honoured for EXACTLY ms, and the real request history is
     * left alone -- neither cleared nor replaced.
     *
     * Clearing was the original bug: it says "nothing sent recently", which is
     * the opposite of being rate limited, and the next call bursts straight
     * into another 429. Nine documents failed in a row that way.
     *
     * Stamping the window as fully spent was the over-correction, and it cost
     * a great deal more than it looked. Google usually asks for a SHORT wait
     * -- two seconds -- but a fabricated full window means the next reserve()
     * also waits out a whole window roll on top. A two-second backoff became a
     * sixty-seven second stall, inside a request, with nothing on screen
     * explaining it.
     *
     * blockedUntil alone prevents the burst, because nothing may go out until
     * it passes. Keeping the true history means what happens after that is
     * paced by what was actually sent.
     */
    block(ms) {
      blockedUntil = now() + ms;
    },

    /**
     * How many more fit RIGHT NOW, without waiting.
     *
     * The point of asking rather than reserving: a serverless request that
     * blocks for a minute inside reserve() is paid for, invisible to the
     * person waiting, and eats the function's duration budget. A caller that
     * can ask first can return instead, and let the browser come back.
     */
    available() {
      const at = now();
      if (at < blockedUntil) return 0;
      recent = recent.filter((stamp) => at - stamp < windowMs);
      return Math.max(0, effective - recent.length);
    },

    /**
     * How long until `count` more fit. 0 when they fit now.
     *
     * The count matters. Answering "is the window completely full?" reported
     * no wait whenever a single slot remained -- so a caller needing 500 tokens
     * with 200 left was told to come back immediately, came back immediately,
     * and span. The question is not whether there is room, it is whether there
     * is enough room.
     */
    msUntilAvailable(count = 1) {
      const at = now();
      if (at < blockedUntil) return blockedUntil - at;

      recent = recent.filter((stamp) => at - stamp < windowMs);

      const overflow = recent.length + count - effective;
      if (overflow <= 0) return 0;

      // recent is in time order, so the entry that must expire to make room is
      // the one `overflow` from the front.
      const index = Math.min(overflow - 1, recent.length - 1);
      return Math.max(0, recent[index] + windowMs - at);
    },

    /**
     * Believe the provider over the configuration, and halve the rate.
     *
     * A 429 on the FIRST attempt does not mean "wait and try again" -- it
     * means the request itself asked for more than this account is allowed,
     * and re-sending the same request after any delay fails identically. That
     * is what a fixed limit gets wrong: the free tier's real numbers vary by
     * account and model, are not discoverable from the API, and were being
     * guessed at 95 a minute against an account allowed far fewer.
     *
     * Halving converges in a few attempts and never climbs back on its own,
     * because a limit that recovers optimistically just walks into the wall
     * again on the next document.
     */
    tighten() {
      effective = Math.max(minLimit, Math.floor(effective / 2));
      return effective;
    },

    /** The rate currently believed to be allowed. */
    limitNow() {
      return effective;
    },

    /** For tests and diagnostics. */
    state() {
      return { used: recent.length, blockedUntil, effective };
    },
  };
}
