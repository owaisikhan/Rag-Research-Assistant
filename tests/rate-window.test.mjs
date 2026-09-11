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
  // 429. Nine documents failed in a row that way.
  const clock = fakeClock();
  const window = createRateWindow({ limit: 100, now: clock.now, sleep: clock.sleep });

  window.block(30_000);

  assert.equal(window.state().used, 100, "window must read as fully spent, not empty");

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
