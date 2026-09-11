// PDF -> clean, page-tagged text blocks.
//
// Page numbers are carried from here all the way to the citation in the UI,
// so nothing in this file may merge pages without recording the range.

import { extractText, getDocumentProxy, getMeta } from "unpdf";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Lines that appear on most pages are furniture -- running heads, journal
 * names, the arXiv stamp down the margin, bare page numbers. They add nothing
 * to retrieval and they pollute chunks, so they are dropped.
 *
 * The threshold is 60% of pages rather than 100% because the first page
 * usually lacks the running head.
 */
function findBoilerplate(pages) {
  if (pages.length < 4) return new Set();

  const counts = new Map();
  for (const page of pages) {
    // Count each distinct line once per page.
    const seen = new Set(
      page
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line.length < 120)
    );
    for (const line of seen) counts.set(line, (counts.get(line) ?? 0) + 1);
  }

  const threshold = Math.ceil(pages.length * 0.6);
  const boilerplate = new Set();
  for (const [line, count] of counts) {
    if (count >= threshold) boilerplate.add(line);
  }
  return boilerplate;
}

/** Bare page numbers and similar noise. */
function isNoise(line) {
  return (
    line.length === 0 ||
    /^\d{1,4}$/.test(line) ||
    /^page\s+\d+(\s+of\s+\d+)?$/i.test(line)
  );
}

function cleanPage(text, boilerplate) {
  return text
    .split("\n")
    // Strip control characters before anything else.
    //
    // PDF text extraction yields NUL and other C0 controls from embedded fonts
    // and broken encodings. Postgres `text` cannot store a NUL at all, and
    // PostgREST rejects the whole insert with "unsupported Unicode escape
    // sequence" -- naming neither the document nor the character, so it reads
    // as a database problem rather than one bad byte in one PDF.
    //
    // Tab and newline are kept; they carry structure this pipeline relies on.
    .map((line) => line.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ""))
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => !isNoise(line) && !boilerplate.has(line))
    // Ligatures and hyphenation artefacts that break keyword search.
    .map((line) => line.replace(/­/g, "").replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl"))
    .join("\n")
    // De-hyphenate words split across a line break.
    .replace(/(\w)-\n(\w)/g, "$1$2");
}

/**
 * @param {string} filePath
 * @returns {Promise<{pages: string[], meta: object, pageCount: number, contentHash: string}>}
 */
export async function extractPdf(filePath) {
  const bytes = new Uint8Array(await readFile(filePath));
  const pdf = await getDocumentProxy(bytes);

  const [{ text: rawPages }, meta] = await Promise.all([
    extractText(pdf, { mergePages: false }),
    getMeta(pdf).catch(() => ({ info: {} })),
  ]);

  const boilerplate = findBoilerplate(rawPages);
  const pages = rawPages.map((page) => cleanPage(page, boilerplate));

  // Hash the cleaned text, not the file bytes: a PDF re-exported with a new
  // timestamp has different bytes and identical content, and re-embedding it
  // would be money spent for nothing.
  const contentHash = createHash("sha256").update(pages.join("\n")).digest("hex");

  return { pages, meta: meta.info ?? {}, pageCount: pdf.numPages, contentHash };
}
