import "server-only";

import { embedDocuments, embedCapacity } from "./embed.js";
import { recordUsage } from "./usage.js";

// Re-exported so callers have one import for "run a pass" and "how big".
export { passagesPerPass } from "./pass-size.js";

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

  const pendingRows = pending ?? [];

  // Nothing left: report the finished state properly. The early return here
  // used to omit contentHash and total, so a caller that finished a document
  // and then asked for one more pass tried to complete the upload with an
  // undefined hash and got a 500.
  if (pendingRows.length === 0) return readProgress({ supabase, sessionId, documentId });

  // Take only what the provider's window allows RIGHT NOW. Waiting for more
  // would block this request invisibly, and the pass is sized so that a full
  // window is not needed for it in the first place.
  const capacity = embedCapacity();

  if (capacity.available === 0) {
    const progress = await readProgress({ supabase, sessionId, documentId });
    // Told to come back rather than made to wait. The browser can say what it
    // is waiting for, which "nothing is happening" cannot.
    return { ...progress, waitMs: capacity.msUntilAvailable };
  }

  const batch = pendingRows.slice(0, capacity.available);

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

  return readProgress({ supabase, sessionId, documentId });
}

/**
 * Where a document has got to.
 *
 * One place, so every return path from a pass reports the same shape. The
 * contentHash is carried because a continue pass has to finish the upload with
 * the real hash and no longer has the file, and RLS hides session-scoped rows
 * from direct reads -- it can only come from this function.
 */
async function readProgress({ supabase, sessionId, documentId }) {
  const { data, error } = await supabase.rpc("upload_progress", {
    p_session: sessionId,
    p_document: documentId,
  });

  if (error) throw new Error(error.message);

  const row = Array.isArray(data) ? data[0] : data;
  const total = row?.total ?? 0;
  const embedded = row?.embedded ?? 0;

  return {
    embedded,
    total,
    remaining: Math.max(0, total - embedded),
    contentHash: row?.content_hash ?? null,
    waitMs: 0,
  };
}
