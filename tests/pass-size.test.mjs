import { test } from "node:test";
import assert from "node:assert/strict";

import { passagesPerPass, fitBatch, estimateTokens } from "../app/_lib/rag/pass-size.js";

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

test("fitBatch stops at the token ceiling, not just the count", () => {
  // The bug this pins: 96 passages of ~480 tokens is 46,000 against a 30,000
  // token ceiling. Well inside the request limit, well outside the token one,
  // and rejected on the first attempt every time.
  const passage = "x".repeat(1750); // ~500 estimated tokens
  const contents = Array.from({ length: 96 }, () => passage);

  const size = fitBatch(contents, { maxCount: 100, maxTokens: 30_000 });

  assert.ok(size < 96, "must not send the whole document at once");
  assert.equal(size, 60, "30,000 / 500 = 60 passages");
});

test("fitBatch stops at the count ceiling when that binds first", () => {
  const contents = Array.from({ length: 50 }, () => "short");
  assert.equal(fitBatch(contents, { maxCount: 10, maxTokens: 30_000 }), 10);
});

test("fitBatch always takes at least one, even an oversized passage", () => {
  // Refusing it would strand the document. The provider will say so itself if
  // the passage really is too large for one request.
  const huge = "x".repeat(500_000);
  assert.equal(fitBatch([huge], { maxCount: 100, maxTokens: 30_000 }), 1);
});

test("estimateTokens is pessimistic rather than optimistic", () => {
  // Measured against a real document: 24,014 true tokens estimated as 27,423.
  // Overestimating costs a smaller batch; underestimating costs a 429 that no
  // retry can clear.
  const text = "x".repeat(3500);
  assert.equal(estimateTokens(text), 1000);
});
