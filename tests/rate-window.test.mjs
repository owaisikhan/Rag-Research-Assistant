// Tests for the embedding rate limiter, with an injected clock so a
// minute-scale window is exercised instantly.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createRateWindow } from "../app/_lib/rag/rate-window.js";

/** A controllable clock: sleeping advances time instead of waiting. */
function fakeClock() {
  let time = 1_000_000;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    advance: (ms) => {
      time += ms;
    },
    elapsedSince: (start) => time - start,
  };
}

test("requests inside the limit are not delayed", async () => {
  const clock = fakeClock();
  const window = createRateWindow({ limit: 100, now: clock.now, sleep: clock.sleep });

  const start = clock.now();
  await window.reserve(60);
  await window.reserve(40);

  assert.equal(clock.elapsedSince(start), 0, "should not have waited");
  assert.equal(window.state().used, 100);
});

test("exceeding the limit waits for the window to roll", async () => {
  const clock = fakeClock();
  const window = createRateWindow({ limit: 100, now: clock.now, sleep: clock.sleep });

  await window.reserve(100);
  const start = clock.now();
  await window.reserve(1);

  assert.ok(
    clock.elapsedSince(start) >= 60_000,
    `expected to wait a full window, waited ${clock.elapsedSince(start)}ms`
  );
});

test("a block does NOT hand back a full allowance", async () => {
  // The bug this exists to prevent: clearing the window on a 429 reads as
  // "nothing sent recently", so the next call bursts straight into another
  // 429. Nine documents failed in a row that way. The protection is
  // blockedUntil -- nothing goes out until it passes.
  const clock = fakeClock();
  const window = createRateWindow({ limit: 100, now: clock.now, sleep: clock.sleep });

  window.block(30_000);

  const start = clock.now();
  await window.reserve(1);

  assert.ok(
    clock.elapsedSince(start) >= 30_000,
    `expected to honour the block, waited only ${clock.elapsedSince(start)}ms`
  );
});

test("the block is honoured even when the window looks empty", async () => {
  const clock = fakeClock();
  const window = createRateWindow({ limit: 100, now: clock.now, sleep: clock.sleep });

  window.block(45_000);
  // Roll far enough forward that the spent window has expired but the block
  // has not. The server's instruction must still win.
  clock.advance(40_000);

  const start = clock.now();
  await window.reserve(1);

  assert.ok(
    clock.elapsedSince(start) > 0,
    "a server-declared block must outrank the local window"
  );
});

test("capacity returns after the window rolls past", async () => {
  const clock = fakeClock();
  const window = createRateWindow({ limit: 100, now: clock.now, sleep: clock.sleep });

  await window.reserve(100);
  clock.advance(61_000);

  const start = clock.now();
  await window.reserve(100);

  assert.equal(clock.elapsedSince(start), 0, "old requests should have expired");
});

test("available() reports capacity without consuming it", () => {
  let clock = 0;
  const window = createRateWindow({ limit: 5, now: () => clock, sleep: async () => {} });

  assert.equal(window.available(), 5);
  // Asking must not spend: two calls in a row report the same.
  assert.equal(window.available(), 5);
});

test("available() falls as the window fills, and recovers as it rolls", async () => {
  let clock = 0;
  const window = createRateWindow({ limit: 5, now: () => clock, sleep: async () => {} });

  await window.reserve(3);
  assert.equal(window.available(), 2);

  clock += 60_001;
  assert.equal(window.available(), 5);
});

test("msUntilAvailable() is zero with room, and the roll time when full", async () => {
  let clock = 0;
  const window = createRateWindow({ limit: 2, now: () => clock, sleep: async () => {} });

  assert.equal(window.msUntilAvailable(), 0);

  await window.reserve(2);
  clock += 10_000;
  // The oldest of the two was 10s ago, so 50s until it leaves the window.
  assert.equal(window.msUntilAvailable(), 50_000);
});

test("a server-declared block outranks local accounting", () => {
  let clock = 0;
  const window = createRateWindow({ limit: 100, now: () => clock, sleep: async () => {} });

  window.block(30_000);
  assert.equal(window.available(), 0);
  assert.equal(window.msUntilAvailable(), 30_000);
});

test("a short block costs exactly the short block", async () => {
  // The over-correction this pins down: marking the window fully spent on a
  // 429 meant a two-second backoff from Google also cost a full window roll
  // afterwards. Measured at 67 seconds for a request that asked for 2.
  const clock = fakeClock();
  const window = createRateWindow({ limit: 100, now: clock.now, sleep: clock.sleep });

  await window.reserve(10);
  window.block(2_000);

  const start = clock.now();
  await window.reserve(1);

  const waited = clock.elapsedSince(start);
  assert.ok(waited >= 2_000, `must honour the block, waited ${waited}ms`);
  assert.ok(waited < 10_000, `must not add a window roll on top, waited ${waited}ms`);
});

test("tighten() halves the believed rate and never climbs back", async () => {
  // A 429 on the first attempt means the request asked for more than the
  // account allows. Waiting cannot fix that; sending less can.
  const clock = fakeClock();
  const window = createRateWindow({ limit: 96, now: clock.now, sleep: clock.sleep });

  assert.equal(window.limitNow(), 96);
  assert.equal(window.tighten(), 48);
  assert.equal(window.tighten(), 24);
  assert.equal(window.tighten(), 12);

  // Rolling the window forward must not restore optimism: a limit that
  // recovers on its own walks into the same wall on the next document.
  clock.advance(600_000);
  assert.equal(window.limitNow(), 12);
});

test("tighten() stops at the floor rather than reaching zero", () => {
  const window = createRateWindow({ limit: 4, now: () => 0, sleep: async () => {} });
  for (let i = 0; i < 20; i++) window.tighten();
  assert.equal(window.limitNow(), 1, "a rate of zero would never send anything again");
});

test("a tightened window admits less", async () => {
  const clock = fakeClock();
  const window = createRateWindow({ limit: 100, now: clock.now, sleep: clock.sleep });

  assert.equal(window.available(), 100);
  window.tighten();
  assert.equal(window.available(), 50);
});

test("msUntilAvailable(count) answers for the amount actually needed", async () => {
  // The spin this pins down: with 200 slots left and 500 needed, asking only
  // "is it full?" answered "no wait" -- so the caller returned, came straight
  // back, and span without ever making progress.
  const clock = fakeClock();
  const window = createRateWindow({ limit: 1000, now: clock.now, sleep: clock.sleep });

  await window.reserve(800);

  assert.equal(window.msUntilAvailable(100), 0, "100 fits in the 200 left");
  assert.ok(window.msUntilAvailable(500) > 0, "500 does not fit and must report a wait");
});

test("the reported wait is when enough room frees, not when the window empties", async () => {
  const clock = fakeClock();
  const window = createRateWindow({ limit: 10, now: clock.now, sleep: clock.sleep });

  await window.reserve(4);
  clock.advance(10_000);
  await window.reserve(6);

  // Full. Needing 2 means waiting for the first batch's entries to expire,
  // which happens 60s after they were taken -- 50s from now, not 60.
  assert.equal(window.msUntilAvailable(2), 50_000);
});
