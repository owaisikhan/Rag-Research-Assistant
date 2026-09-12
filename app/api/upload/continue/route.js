// Index the next batch of a document already uploaded.
//
// Embedding is paced by the provider, so a long document cannot be indexed
// inside one request's duration however generous that duration is. The file is
// uploaded ONCE; this endpoint carries on where the last pass stopped.
//
// NOT rate limited, deliberately. One upload spends one slot, and the work
// this endpoint can do is bounded by passages the original -- rate limited --
// upload already stored. It cannot be used to embed anything that was not
// already accepted, and only for a document belonging to the caller's own
// session.

import { createClient } from "@/app/_lib/supabase-server";
import { readSessionId } from "@/app/_lib/session";
import { runIndexPass, passagesPerPass } from "@/app/_lib/rag/index-pass";

export const runtime = "nodejs";
export const maxDuration = 300;

const TIME_BUDGET_S = Number(process.env.UPLOAD_TIME_BUDGET_S || 300);
const EMBED_RPM = Number(process.env.GEMINI_EMBED_RPM || 95);
const EMBED_SHARE = 0.66;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message, status) {
  return Response.json({ ok: false, message }, { status });
}

export async function POST(request) {
  const sessionId = await readSessionId();
  if (!sessionId) return fail("That upload is no longer in progress.", 400);

  let documentId;
  try {
    ({ documentId } = await request.json());
  } catch {
    return fail("Malformed request.", 400);
  }

  if (typeof documentId !== "string" || !UUID.test(documentId)) {
    return fail("That is not a document.", 400);
  }

  const supabase = await createClient();

  try {
    const { remaining, embedded, total, contentHash } = await runIndexPass({
      supabase,
      sessionId,
      documentId,
      limit: passagesPerPass({
        budgetSeconds: TIME_BUDGET_S,
        embedRpm: EMBED_RPM,
        embedShare: EMBED_SHARE,
      }),
    });

    if (remaining > 0) {
      return Response.json({ ok: true, indexing: true, embedded, total, remaining });
    }

    // Everything is embedded, so the document can stop being `pending:` and
    // become searchable. finish_upload refuses a document with no passages,
    // which is the guard that makes this safe to call more than once.
    const { data: stored, error } = await supabase.rpc("finish_upload", {
      p_session: sessionId,
      p_document: documentId,
      p_content_hash: contentHash,
    });

    if (error) throw new Error(error.message);

    return Response.json({ ok: true, indexing: false, embedded: stored, total: stored });
  } catch (error) {
    console.error("Index pass failed:", error);

    if (error.name === "DailyQuotaExhausted") {
      return fail(
        "This demo's daily indexing allowance is used up part-way through this " +
          "document. It resets every 24 hours — the passages already indexed are " +
          "kept, so uploading it again tomorrow will carry on rather than start over.",
        429
      );
    }

    return fail("That document could not be indexed. Please try again.", 500);
  }
}
