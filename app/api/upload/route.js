// Upload a PDF and make it searchable for this visitor only.
//
// Runs the same extract -> clean -> chunk -> embed pipeline as the ingestion
// script, against the same code, so an uploaded document produces citations
// identical in shape to the curated corpus: document title, section, page.
//
// What is deliberately NOT here: the service-role key. Every write goes
// through SECURITY DEFINER functions that take the session id and enforce the
// limits themselves, so the deployed app never holds a credential that could
// touch another visitor's data or the demo corpus.

import { extractPdfBytes } from "@/app/_lib/rag/extract";
import { chunkPages } from "@/app/_lib/rag/chunk";
import { embedDocuments, EMBEDDING_MODEL } from "@/app/_lib/rag/embed";
import { createClient } from "@/app/_lib/supabase-server";
import { ensureSessionId } from "@/app/_lib/session";
import { checkRateLimit } from "@/app/_lib/rag/limits";

export const runtime = "nodejs";

// Vercel TERMINATES a function that exceeds this. It does not restart or retry
// it, and whatever was already written stays written.
//
// The ceiling depends on a project setting, and the two possibilities differ
// by 5x: 300s with fluid compute (the default for projects created after
// April 2025), 60s for a legacy project without it. Vercel's own docs carry
// both tables, which is exactly how you end up confidently sizing an upload
// limit against the wrong one.
//
// So this is declared at the higher value -- a project that only allows 60s
// caps it anyway -- and the REAL gate is UPLOAD_TIME_BUDGET_S below, which is
// checked at runtime against the work actually required.
export const maxDuration = 300;

// What the deployment can genuinely spend on one upload.
//
// Defaults to the pessimistic 60, so a project without fluid compute is
// correct out of the box. Raise it to 300 once you have confirmed fluid
// compute is enabled (Project Settings -> Functions).
const TIME_BUDGET_S = Number(process.env.UPLOAD_TIME_BUDGET_S || 60);

// Embedding requests per minute the provider allows. Gemini's free tier is
// 100; a paid tier is far higher, so raising this is the other half of
// supporting long documents.
const EMBED_RPM = Number(process.env.GEMINI_EMBED_RPM || 95);

// Extraction, chunking, inserts and network need their share of the budget.
// Two thirds for embedding is conservative and has held in testing.
const EMBED_SHARE = 0.66;

// Raised from 10 MB for local testing of large documents.
//
// CAVEAT WORTH KNOWING BEFORE RELYING ON IT: a serverless function's REQUEST
// BODY is capped by the platform, well below this, and that cap is enforced
// before the function ever runs -- so on the deployment a large upload fails
// at the edge with a platform error rather than reaching this check and
// getting a sentence explaining itself. Vercel's own answer to large uploads
// is to send the file straight from the browser to blob storage and hand the
// function a URL instead, which is a different shape of upload than this.
//
// So: works locally, and does not on its own make large uploads work in
// production.
const MAX_MB = Number(process.env.UPLOAD_MAX_MB || 60);
const MAX_BYTES = MAX_MB * 1024 * 1024;
// Chunks are inserted in batches for the same reason as the ingestion script:
// each row carries a 1536-float embedding, so a large batch becomes a
// multi-megabyte request that fails for long documents only.
const INSERT_BATCH = 40;

function fail(message, status) {
  return Response.json({ ok: false, message }, { status });
}

export async function POST(request) {
  // Uploads spend embedding quota, so they share the question limiter.
  const { allowed } = await checkRateLimit(request);
  if (!allowed) {
    return fail("You have reached this demo's hourly limit. Try again later.", 429);
  }

  let file;
  try {
    const form = await request.formData();
    file = form.get("file");
  } catch {
    return fail("That upload could not be read.", 400);
  }

  if (!file || typeof file.arrayBuffer !== "function") {
    return fail("Choose a PDF to upload.", 400);
  }

  if (file.size > MAX_BYTES) {
    return fail(
      `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_MB} MB.`,
      400
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Trust the bytes, not the extension or the declared MIME type.
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") {
    return fail("That file is not a PDF.", 400);
  }

  const sessionId = await ensureSessionId();
  const supabase = await createClient();

  let pages;
  let pageCount;
  let contentHash;
  let meta;
  try {
    ({ pages, pageCount, contentHash, meta } = await extractPdfBytes(bytes));
  } catch {
    return fail("That PDF could not be read. It may be corrupt or password protected.", 400);
  }

  const chunks = chunkPages(pages);
  if (chunks.length === 0) {
    return fail(
      "No text could be extracted. Scanned PDFs need OCR before they can be searched.",
      400
    );
  }

  // Refuse BEFORE spending any quota.
  //
  // Extraction and chunking are local and free, so at this point the exact
  // cost of the document is known rather than estimated from its page count --
  // and pages are a poor proxy, ranging from 1.5 to 4.25 chunks each across
  // the corpus. Checking here turns a request that would have died at the
  // platform's timeout, halfway through, leaving a half-indexed document
  // behind, into an immediate sentence explaining what will fit.
  const embedSeconds = (chunks.length / EMBED_RPM) * 60;
  const allowedSeconds = TIME_BUDGET_S * EMBED_SHARE;

  if (embedSeconds > allowedSeconds) {
    const fits = Math.floor((allowedSeconds / 60) * EMBED_RPM);
    const roughPages = Math.max(1, Math.floor(pageCount * (fits / chunks.length)));

    return fail(
      `That document needs ${chunks.length} passages indexed, which takes about ` +
        `${Math.round(embedSeconds)}s — longer than this deployment can spend on one ` +
        `upload (${Math.round(allowedSeconds)}s). Try a document of roughly ` +
        `${roughPages} pages or fewer, or split this one.`,
      413
    );
  }

  // Reserve the row first. This enforces the per-session and page limits in
  // the database, and writes a `pending:` hash so a failure below cannot leave
  // a document that looks complete but has no passages.
  // The PDF's own title beats the filename when it looks like a real title --
  // "sample.pdf" should appear as what the document actually is. Guarded
  // because embedded titles are frequently a LaTeX temp name, a path, or
  // empty, in which case the filename is the better answer.
  const embedded = (meta?.Title ?? "").trim();
  const looksLikeATitle =
    embedded.length > 4 &&
    embedded.length < 200 &&
    !/^(untitled|microsoft word|\w+\.(tex|doc|docx|pdf)$)/i.test(embedded) &&
    !embedded.includes("/");

  const title = looksLikeATitle
    ? embedded
    : (file.name || "Uploaded document").replace(/\.pdf$/i, "");
  const { data: documentId, error: beginError } = await supabase.rpc("begin_upload", {
    p_session: sessionId,
    p_title: title,
    p_file_name: file.name ?? "upload.pdf",
    p_page_count: pageCount,
    p_content_hash: contentHash,
    p_embedding_model: EMBEDDING_MODEL,
  });

  if (beginError) {
    // These are the limit messages from the database, written for a person.
    return fail(beginError.message.replace(/^.*?:\s*/, ""), 400);
  }

  try {
    const embeddings = await embedDocuments(chunks.map((chunk) => chunk.content));

    if (embeddings.length !== chunks.length) {
      throw new Error("The embedding service returned the wrong number of vectors.");
    }

    const rows = chunks.map((chunk, index) => ({
      chunk_index: chunk.chunkIndex,
      content: chunk.content,
      token_count: chunk.tokenCount,
      section: chunk.section,
      page_start: chunk.pageStart,
      page_end: chunk.pageEnd,
      embedding: JSON.stringify(embeddings[index]),
    }));

    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const { error } = await supabase.rpc("add_upload_chunks", {
        p_session: sessionId,
        p_document: documentId,
        p_chunks: rows.slice(i, i + INSERT_BATCH),
      });
      if (error) throw new Error(error.message);
    }

    const { data: stored, error: finishError } = await supabase.rpc("finish_upload", {
      p_session: sessionId,
      p_document: documentId,
      p_content_hash: contentHash,
    });

    if (finishError) throw new Error(finishError.message);

    return Response.json({
      ok: true,
      document: {
        id: documentId,
        title,
        fileName: file.name,
        pageCount,
        chunkCount: stored,
      },
    });
  } catch (error) {
    console.error("Upload failed:", error);

    // The row is left behind carrying its pending hash rather than deleted, so
    // the failure is visible in the database instead of vanishing. It is
    // excluded from listings and purged with the rest after 24 hours.
    // The two quota failures need different sentences, and conflating them is
    // its own small bug: a per-minute limit clears in under a minute, while a
    // daily one does not move for hours. Telling someone to "try again
    // shortly" when the answer is "tomorrow" sends them back to retry against
    // a wall, and makes the app look broken rather than rationed.
    if (error.name === "DailyQuotaExhausted") {
      return fail(
        "This demo's daily indexing allowance is used up. It resets every 24 hours — " +
          "come back tomorrow, or ask a question about the existing library, which " +
          "still works.",
        429
      );
    }

    if (/quota|429|rate/i.test(error.message)) {
      return fail(
        "The indexing service is busy for a moment. Try that upload again shortly.",
        429
      );
    }

    return fail("That document could not be indexed. Please try another file.", 500);
  }
}
