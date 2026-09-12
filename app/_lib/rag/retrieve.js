import "server-only";

import { embedQuery } from "./embed.js";
import { createClient } from "../supabase-server.js";
import { siteConfig } from "../siteConfig.js";

// How many chunks reach the model. Twelve at ~450 tokens is ~5.4k tokens of
// context: enough that the answer is rarely starved, small enough that the
// model does not have to sift noise. Raising this does not reliably improve
// answers -- past a point it dilutes the good passages.
const MATCH_COUNT = 12;

/**
 * @typedef {object} Source
 * @property {number} chunkId
 * @property {string} documentId
 * @property {string} content
 * @property {string|null} section
 * @property {number} pageStart
 * @property {number} pageEnd
 * @property {string} title
 * @property {string[]} authors
 * @property {string|null} sourceUrl
 * @property {string} kind
 * @property {boolean} isUpload
 * @property {number} score
 */

/**
 * Retrieve the passages most likely to answer a question.
 *
 * The query is embedded AND passed as text: match_chunks runs vector search
 * and full-text search separately and fuses the ranks. Exact terms (a CVE id,
 * an error string, a surname) survive that way; paraphrase survives too.
 *
 * @param {string} question
 * @param {{ matchCount?: number }} [options]
 * @returns {Promise<Source[]>}
 */
export async function retrieve(question, { matchCount = MATCH_COUNT, sessionId = null } = {}) {
  const trimmed = question.trim();
  if (trimmed === "") return [];

  const [embedding, supabase] = await Promise.all([
    embedQuery(trimmed),
    createClient(),
  ]);

  // The session id decides whether this visitor's own uploads are searchable
  // alongside the demo corpus. It is enforced inside match_chunks, not here --
  // the anon key is public, so application-side filtering would not be
  // isolation.
  const { data, error } = await supabase.rpc("match_chunks", {
    query_embedding: embedding,
    query_text: trimmed,
    match_count: matchCount,
    p_session: sessionId,
    // When the curated library is switched off, the assistant answers only
    // from what this visitor uploaded. The library stays in the database.
    include_demo: siteConfig.mode.includeDemoCorpus,
  });

  if (error) {
    throw new Error(`Retrieval failed: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    content: row.content,
    section: row.section,
    pageStart: row.page_start,
    pageEnd: row.page_end,
    title: row.title,
    authors: row.authors ?? [],
    sourceUrl: row.source_url,
    kind: row.kind,
    isUpload: row.is_upload ?? false,
    score: row.score,
  }));
}
