import "server-only";

import { createClient } from "../supabase-server.js";

// How many passages a summary is built from.
//
// Sixteen at ~700 tokens is ~11k tokens of context: enough to cover a long
// document's shape without the cost of sending the whole thing. Raising it
// helps least where it costs most -- the long documents -- because doubling
// the sample of a 190-chunk paper still leaves most of it unseen, while
// doubling the bill.
const OUTLINE_SIZE = 16;

/**
 * @typedef {object} Outline
 * @property {string} title
 * @property {string[]} authors
 * @property {number|null} pageCount
 * @property {number} chunkTotal
 * @property {import("./retrieve.js").Source[]} passages
 */

/**
 * Fetch an even spread of passages across one document.
 *
 * Costs no embedding quota: summarising has no query to embed, so this is
 * pure Postgres. That makes it the cheapest thing the app does, which is worth
 * knowing when the daily allowance is tight.
 *
 * Returns null when the document does not exist, is not this visitor's, or is
 * still half-indexed. The caller cannot tell those apart, and should not --
 * distinguishing "not yours" from "does not exist" tells a prober which uuids
 * are real.
 *
 * @param {string} documentId
 * @param {{ sessionId: string|null, limit?: number }} options
 * @returns {Promise<Outline|null>}
 */
export async function getOutline(documentId, { sessionId, limit = OUTLINE_SIZE }) {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("document_outline", {
    p_session: sessionId,
    p_document: documentId,
    p_limit: limit,
  });

  if (error) {
    throw new Error(`Outline failed: ${error.message}`);
  }

  const rows = data ?? [];
  if (rows.length === 0) return null;

  return {
    title: rows[0].title,
    authors: rows[0].authors ?? [],
    pageCount: rows[0].page_count,
    chunkTotal: rows[0].chunk_total,
    passages: rows.map((row) => ({
      chunkId: row.chunk_index,
      documentId,
      content: row.content,
      section: row.section,
      pageStart: row.page_start,
      pageEnd: row.page_end,
      title: row.title,
      authors: row.authors ?? [],
      sourceUrl: null,
      kind: "document",
      isUpload: true,
      score: 0,
    })),
  };
}
