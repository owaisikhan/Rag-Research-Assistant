// File-path convenience around the shared extractor.
//
// The extraction itself lives in app/_lib/rag/extract.js so the upload route
// and the ingestion script run the SAME code. Two copies of chunking logic is
// how the web path and the CLI quietly start producing different citations.

import { readFile } from "node:fs/promises";

export { extractPdfBytes } from "../../app/_lib/rag/extract.js";

import { extractPdfBytes } from "../../app/_lib/rag/extract.js";

/** @param {string} filePath */
export async function extractPdf(filePath) {
  return extractPdfBytes(new Uint8Array(await readFile(filePath)));
}
