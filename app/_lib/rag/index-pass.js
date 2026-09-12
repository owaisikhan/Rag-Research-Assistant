import "server-only";

import { embedDocuments } from "./embed.js";
import { recordUsage } from "./usage.js";

// How many passages one request can embed.
//
// Embedding is paced by the provider, so this is a time calculation, not a
// memory one: (budget x share) / 60 x requests-per-minute. Both routes derive
// it the same way, because a continue pass that assumed a different budget
// than the first pass would either waste time or die at the platform timeout.
export function passagesPerPass({ budgetSeconds, embedRpm, embedShare }) {
  return Math.max(1, Math.floor(((budgetSeconds * embedShare) / 60) * embedRpm));
}

/**
 * Embed the next batch of a document's unembedded passages.
 *
 * Returns what is left, so the caller can decide whether to finish the upload
 * or ask the visitor's browser to come back for another pass.
 *
 * @returns {Promise<{ embedded: number, remaining: number }>}
 */
export async function runIndexPass({ supabase, sessionId, documentId, limit }) {
  const { data: pending, error: pendingError } = await supabase.rpc("next_unembedded_chunks", {
    p_session: sessionId,
    p_document: documentId,
    p_limit: limit,
  });

  if (pendingError) throw new Error(pendingError.message);

  const batch = pending ?? [];
  if (batch.length === 0) return { embedded: 0, remaining: 0 };

  const vectors = await embedDocuments(batch.map((row) => row.content));

  // Each TEXT is one request against the daily quota, not each HTTP call.
  // Recorded after the call so a failure part-way does not log work never done.
  await recordUsage({ kind: "embedding", units: batch.length });

  if (vectors.length !== batch.length) {
    throw new Error("The embedding service returned the wrong number of vectors.");
  }

  // Written back in batches for the same reason chunks were inserted in
  // batches: a single request carrying hundreds of 1536-dimension vectors is
  // multiple megabytes of JSON, and it fails in a way that looks like a
  // timeout rather than a size limit.
  const WRITE_BATCH = 40;

  for (let i = 0; i < batch.length; i += WRITE_BATCH) {
    const rows = batch.slice(i, i + WRITE_BATCH).map((row, offset) => ({
      id: row.id,
      embedding: JSON.stringify(vectors[i + offset]),
    }));

    const { error } = await supabase.rpc("set_chunk_embeddings", {
      p_session: sessionId,
      p_document: documentId,
      p_rows: rows,
    });
    if (error) throw new Error(error.message);
  }

  const { data: progress, error: progressError } = await supabase.rpc("upload_progress", {
    p_session: sessionId,
    p_document: documentId,
  });

  if (progressError) throw new Error(progressError.message);

  const row = Array.isArray(progress) ? progress[0] : progress;
  const total = row?.total ?? 0;
  const embedded = row?.embedded ?? 0;

  return {
    embedded,
    remaining: Math.max(0, total - embedded),
    total,
    // Carried back because a continue pass has to finish the upload with the
    // real hash and no longer has the file. RLS hides session-scoped rows from
    // direct reads, so it can only come from this function.
    contentHash: row?.content_hash ?? null,
  };
}
