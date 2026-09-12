import { test } from "node:test";
import assert from "node:assert/strict";

import { isSmallTalk, smallTalkReply } from "../app/_lib/rag/smalltalk.js";

test("catches greetings, with and without punctuation", () => {
  for (const text of ["hello", "Hello!", "  HI  ", "hey there", "Good morning.", "ok fine"]) {
    assert.equal(isSmallTalk(text), true, text);
  }
});

test("catches an emoji-only decoration around a greeting", () => {
  assert.equal(isSmallTalk("hello 👋"), true);
});

test("does NOT catch short real questions", () => {
  // The whole reason matching is exact: these are content-free and short, and
  // a heuristic would answer a real question with a canned greeting.
  for (const text of ["rent?", "total?", "how much", "abdul?", "no rent?", "who signed"]) {
    assert.equal(isSmallTalk(text), false, text);
  }
});

test("does NOT catch a greeting with a question attached", () => {
  assert.equal(isSmallTalk("hello how much does abdul owe"), false);
  assert.equal(isSmallTalk("hi, what is this document about?"), false);
});

test("empty input is not small talk", () => {
  assert.equal(isSmallTalk(""), false);
  assert.equal(isSmallTalk("   "), false);
  assert.equal(isSmallTalk("!!!"), false);
});

test("the reply agrees with itself about how many documents there are", () => {
  assert.match(smallTalkReply(0), /Upload a PDF/);
  assert.match(smallTalkReply(1), /your document\b/);
  assert.match(smallTalkReply(3), /your documents\b/);
});
