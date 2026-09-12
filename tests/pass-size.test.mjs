import { test } from "node:test";
import assert from "node:assert/strict";

import { passagesPerPass } from "../app/_lib/rag/pass-size.js";

const RPM = 95;

test("a pass is capped by time, not by the whole budget", () => {
  // 300s budget x 0.66 = 198s of embedding available, but a pass stops at 60s
  // so the visitor sees the count move about once a minute.
  assert.equal(
    passagesPerPass({ budgetSeconds: 300, embedRpm: RPM, embedShare: 0.66 }),
    Math.floor((60 / 60) * RPM)
  );
});

test("a budget smaller than the cap is what binds", () => {
  // 10s x 0.66 = 6.6s, well under the 60s cap, so the budget decides.
  assert.equal(
    passagesPerPass({ budgetSeconds: 10, embedRpm: RPM, embedShare: 0.66 }),
    Math.floor((6.6 / 60) * RPM)
  );
});

test("never returns zero, however small the budget", () => {
  // A pass of zero passages would make the browser loop forever without ever
  // reducing `remaining` -- the exact failure the loop's pass ceiling exists
  // to contain, and better avoided here.
  assert.equal(passagesPerPass({ budgetSeconds: 0.1, embedRpm: 1, embedShare: 0.1 }), 1);
});

test("a 460-passage document takes a handful of passes, not two", () => {
  const perPass = passagesPerPass({ budgetSeconds: 300, embedRpm: RPM, embedShare: 0.66 });
  assert.equal(Math.ceil(460 / perPass), 5);
});
