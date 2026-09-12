// Chunking tests. Run with: npm test
//
// Chunking is tested rather than retrieval because it is the part that is
// deterministic and offline, and it decides answer quality. A chunk carrying
// the wrong page number produces a citation that does not check out, which is
// worse for trust than no citation at all.

import { test } from "node:test";
import assert from "node:assert/strict";

import { chunkPages, estimateTokens, TARGET_TOKENS } from "../app/_lib/rag/chunk.js";

// A chunk may exceed the target by the overlap it carries plus the block that
// tipped it over, so the ceiling is the target with headroom rather than the
// target itself.
const TARGET_TOKENS_CEILING = Math.round(TARGET_TOKENS * 1.3);

const paragraph = (words) => Array.from({ length: words }, (_, i) => `word${i}`).join(" ");

test("page numbers are carried onto every chunk", () => {
  const pages = [paragraph(300), paragraph(300), paragraph(300)];
  const chunks = chunkPages(pages);

  assert.ok(chunks.length > 0, "expected chunks");
  for (const chunk of chunks) {
    assert.ok(chunk.pageStart >= 1, "pageStart must be a real page");
    assert.ok(chunk.pageEnd <= pages.length, "pageEnd cannot exceed the document");
    assert.ok(chunk.pageEnd >= chunk.pageStart, "page range must not be inverted");
  }
});

test("a chunk spanning a page break records both pages", () => {
  const chunks = chunkPages([paragraph(60), paragraph(60)]);
  assert.ok(
    chunks.some((chunk) => chunk.pageEnd > chunk.pageStart),
    "expected at least one chunk to span the page boundary"
  );
});

test("headings become section labels rather than body text", () => {
  const chunks = chunkPages([
    ["1 Introduction", paragraph(200)].join("\n"),
    ["3.5 Positional Encoding", paragraph(200)].join("\n"),
  ]);

  const sections = chunks.map((chunk) => chunk.section);
  assert.ok(sections.includes("1 Introduction"), "numbered heading not detected");
  assert.ok(sections.includes("3.5 Positional Encoding"), "subsection heading not detected");

  for (const chunk of chunks) {
    assert.ok(!chunk.content.startsWith("1 Introduction"), "heading leaked into content");
  }
});

test("the bibliography is excluded", () => {
  const chunks = chunkPages([
    ["1 Introduction", paragraph(400)].join("\n"),
    ["2 Method", paragraph(400)].join("\n"),
    ["References", "[1] A. Author. A paper title. In Proceedings, 2020."].join("\n"),
  ]);

  assert.ok(
    !chunks.some((chunk) => /^references$/i.test(chunk.section ?? "")),
    "reference entries must not be retrievable -- they match keyword queries and answer nothing"
  );
});

test("a document that is entirely references is not discarded", () => {
  const chunks = chunkPages([["References", paragraph(400)].join("\n")]);
  assert.ok(chunks.length > 0, "refused to keep any content");
});

test("chunks stay within the token budget", () => {
  // Derived from the chunker's own target rather than hardcoded, so tuning
  // TARGET_TOKENS for cost does not fail a test that is really asserting
  // "chunks are bounded", not "chunks are 500 tokens". A chunk can exceed the
  // target by roughly the overlap it carries forward, hence the allowance.
  const chunks = chunkPages([paragraph(4000)]);
  const largest = Math.max(...chunks.map((c) => c.tokenCount));
  const target = Math.max(...chunks.map((c) => c.tokenCount), 0);

  assert.ok(chunks.length > 1, "expected the text to be split at all");
  assert.ok(
    largest <= TARGET_TOKENS_CEILING,
    `largest chunk is ${largest} tokens, above the ${TARGET_TOKENS_CEILING} ceiling`
  );
  void target;
});

test("empty input produces no chunks rather than throwing", () => {
  assert.deepEqual(chunkPages([]), []);
  assert.deepEqual(chunkPages(["", "   "]), []);
});

test("token estimate is monotonic in length", () => {
  assert.ok(estimateTokens("a".repeat(400)) > estimateTokens("a".repeat(100)));
});

test("the title block is dropped when the document has sections", () => {
  const chunks = chunkPages([
    [
      "Predicting Privacy Leakage from Weight Spectral Density",
      "Richard J. Preen, University of the West of England",
      "richard.preen@uwe.ac.uk",
      "Abstract",
      paragraph(200),
    ].join("\n"),
    ["1 Introduction", paragraph(300)].join("\n"),
  ]);

  assert.ok(chunks.length > 0, "expected chunks to survive");
  assert.ok(
    !chunks.some((c) => c.content.includes("richard.preen@uwe.ac.uk")),
    "author/affiliation front matter must not be retrievable"
  );
  assert.ok(
    chunks.every((c) => c.section !== null),
    "every surviving chunk should sit under a heading"
  );
});

test("a document with no headings keeps its opening", () => {
  // A report or letter whose first page IS the content. Dropping it would be
  // worse than the front-matter noise the rule exists to remove.
  const chunks = chunkPages([paragraph(300), paragraph(300)]);
  assert.ok(chunks.length > 0, "content was discarded from a heading-less document");
  assert.ok(chunks[0].pageStart === 1, "the opening page should survive");
});
