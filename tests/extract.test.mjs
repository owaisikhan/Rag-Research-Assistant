// Extraction tests that need no PDF: the cleaning rules are pure string work.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chunkPages } from "../scripts/lib/chunk.mjs";

// Rebuilt here rather than written literally, so this file stays free of the
// control characters it is testing for.
const NUL = String.fromCharCode(0);
const BELL = String.fromCharCode(7);
const VTAB = String.fromCharCode(11);
const DEL = String.fromCharCode(127);

const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

test("the control-character pattern matches what PDFs actually emit", () => {
  for (const character of [NUL, BELL, VTAB, DEL]) {
    assert.ok(CONTROL_PATTERN.test(character), "pattern missed a control character");
  }
  // ...and leaves the whitespace the pipeline depends on alone.
  assert.ok(!CONTROL_PATTERN.test("\n"));
  assert.ok(!CONTROL_PATTERN.test("\t"));
  assert.ok(!CONTROL_PATTERN.test(" "));
});

test("stripping control characters leaves the surrounding words intact", () => {
  const dirty = `zero${NUL} trust${BELL} architecture${DEL}`;
  const clean = dirty.replace(new RegExp(CONTROL_PATTERN.source, "g"), "");
  assert.equal(clean, "zero trust architecture");
});

test("chunking a page that still contains control characters does not crash", () => {
  // Defence in depth: extraction strips these, but a PDF ingested by another
  // path must not take the whole run down.
  const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  const chunks = chunkPages([`Introduction${NUL}\n${words}${BELL}`]);
  assert.ok(chunks.length > 0);
});
