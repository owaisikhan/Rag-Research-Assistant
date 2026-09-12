import { test } from "node:test";
import assert from "node:assert/strict";

import { parseUsed, stripUsed } from "../app/_lib/rag/used-trailer.js";

test("parses the numbers the model named", () => {
  assert.deepEqual(parseUsed("Answer.\n\n[[used: 1, 4]]"), [1, 4]);
});

test("tolerates the spacings and separators a model actually emits", () => {
  assert.deepEqual(parseUsed("x [[used:2 5 9]]"), [2, 5, 9]);
  assert.deepEqual(parseUsed("x [[ used : 3,3,1 ]]"), [1, 3]);
  assert.deepEqual(parseUsed("x [[USED: 7]]"), [7]);
});

test("absent trailer is null, not an empty list", () => {
  // The distinction carries the whole design: null means "the model did not
  // say", and the UI must not present that as "based on nothing".
  assert.equal(parseUsed("Just an answer."), null);
});

test("a trailer naming nothing is an empty list", () => {
  assert.deepEqual(parseUsed("Nothing matched. [[used: ]]"), []);
});

test("strips a complete trailer", () => {
  assert.equal(stripUsed("The rent is 2,500.\n\n[[used: 1, 2]]"), "The rent is 2,500.");
});

test("strips a partial trailer mid-stream", () => {
  // Each of these is one keystroke of the trailer arriving over the wire.
  for (const partial of ["[[", "[[u", "[[used", "[[used:", "[[used: 1,"]) {
    assert.equal(stripUsed(`Answer text.\n\n${partial}`), "Answer text.");
  }
});

test("leaves brackets that are part of the answer alone", () => {
  const text = "The array is written [[1, 2], [3, 4]] in the appendix.";
  assert.equal(stripUsed(text), text);
});

test("does not strip a bracket run that is not at the end", () => {
  assert.equal(stripUsed("See [[note]] for detail."), "See [[note]] for detail.");
});
