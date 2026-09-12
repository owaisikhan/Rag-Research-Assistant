#!/usr/bin/env node
// Ingest PDFs into the knowledge base.
//
//   node scripts/ingest.mjs                 # add new / changed documents
//   node scripts/ingest.mjs --force         # re-embed everything
//   node scripts/ingest.mjs --dir ./other   # a different folder
//
// Runs on a developer machine, never on Vercel: embedding a few hundred PDFs
// takes minutes to hours and needs a real filesystem. The deployed app only
// ever reads what this writes.

import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import pLimit from "p-limit";

import { extractPdf } from "./lib/extract.mjs";
import { chunkPages } from "./lib/chunk.mjs";
import { loadEnv } from "./lib/env.mjs";

loadEnv();

const { embedDocuments, EMBEDDING_MODEL } = await import("../app/_lib/rag/embed.js");
const { createAdminClient } = await import("../app/_lib/supabase-auth.js");

// Embedding batch size and pacing depend on the provider's rate limits.
//
// Gemini's free tier is generous per day but tight per minute, and it answers
// a burst with 429 rather than queueing. Measured the hard way: 64-text
// batches at concurrency 3 exhausted the quota after four documents. Small
// serial batches with a pause between them finish the same work slower and
// without failing.
const isGemini = (process.env.EMBEDDING_MODEL || "").startsWith("gemini");

// Batch size no longer affects the Gemini quota (each text counts), so it is
// purely a round-trip optimisation. Pacing is handled inside embed.js by a
// sliding window against the real documented limit.
const EMBED_BATCH = 64;
const EMBED_CONCURRENCY = isGemini ? 1 : 3;
const EMBED_PACING_MS = 0;

// Rows per insert.
//
// NOT a Postgres limit -- a payload limit. Every row carries a 1536-float
// embedding, which serialises to roughly 18 kB of JSON, so 200 rows is a 4 MB
// request. That silently failed for longer documents while short ones went
// through, which is the worst shape of bug: the corpus looked fine and was
// quietly missing its biggest papers. 50 rows is about 1 MB.
const INSERT_BATCH = 50;

function parseArgs(argv) {
  const args = { dir: "corpus", force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--force") args.force = true;
    else if (argv[i] === "--dir") args.dir = argv[++i];
  }
  return args;
}

/**
 * Per-document metadata, keyed by filename, written by fetch-corpus.mjs.
 * Missing entries are not fatal -- a PDF dropped into the folder by hand
 * still ingests, it just carries less metadata.
 */
async function loadManifest(dir) {
  try {
    const raw = await readFile(join(dir, "manifest.json"), "utf8");
    const entries = JSON.parse(raw);
    return new Map(entries.map((entry) => [entry.fileName, entry]));
  } catch {
    return new Map();
  }
}

/** A stable id for a file that arrived without manifest metadata. */
function fallbackSourceId(fileName) {
  return `local:${createHash("sha1").update(fileName).digest("hex").slice(0, 16)}`;
}

/**
 * Refuse to mix embedding models in one corpus.
 *
 * Vectors from two models occupy the same space arithmetically and mean
 * nothing to each other semantically. Retrieval keeps working, quietly
 * returning noise for half the corpus -- a failure with no error message,
 * which is the worst kind. So it is checked up front and loudly.
 */
async function assertModelConsistency(supabase, force) {
  const { data, error } = await supabase
    .from("documents")
    .select("embedding_model")
    .limit(1000);

  if (error) throw new Error(`Could not read documents: ${error.message}`);

  const existing = new Set((data ?? []).map((row) => row.embedding_model));
  existing.delete(EMBEDDING_MODEL);

  if (existing.size > 0 && !force) {
    throw new Error(
      `The corpus already contains vectors from ${[...existing].join(", ")}, ` +
        `but EMBEDDING_MODEL is "${EMBEDDING_MODEL}".\n` +
        `Mixing embedding models silently destroys retrieval quality.\n` +
        `Either set EMBEDDING_MODEL back, or re-ingest everything with --force ` +
        `(which also needs the vector(n) dimension to match the new model).`
    );
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function embedAll(texts) {
  const batches = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    batches.push(texts.slice(i, i + EMBED_BATCH));
  }

  // Serial with a pause when the provider needs pacing; concurrent otherwise.
  if (EMBED_CONCURRENCY === 1) {
    const results = [];
    for (const [index, batch] of batches.entries()) {
      results.push(await embedDocuments(batch));
      if (EMBED_PACING_MS > 0 && index < batches.length - 1) {
        await sleep(EMBED_PACING_MS);
      }
    }
    return results.flat();
  }

  const limit = pLimit(EMBED_CONCURRENCY);
  const results = await Promise.all(
    batches.map((batch) => limit(() => embedDocuments(batch)))
  );
  return results.flat();
}

async function ingestFile(supabase, filePath, manifest, force) {
  const fileName = basename(filePath);
  const meta = manifest.get(fileName) ?? {};
  const sourceId = meta.sourceId ?? fallbackSourceId(fileName);

  const { pages, meta: pdfMeta, pageCount, contentHash } = await extractPdf(filePath);

  // Incremental: unchanged content is skipped without spending a single
  // embedding call. This is what makes "add more PDFs later" cheap.
  const { data: existing } = await supabase
    .from("documents")
    .select("id, content_hash")
    .eq("source_id", sourceId)
    .maybeSingle();

  if (existing && existing.content_hash === contentHash && !force) {
    return { fileName, status: "unchanged", chunks: 0 };
  }

  const chunks = chunkPages(pages);
  if (chunks.length === 0) {
    return { fileName, status: "empty", chunks: 0 };
  }

  const embeddings = await embedAll(chunks.map((chunk) => chunk.content));
  if (embeddings.length !== chunks.length) {
    throw new Error(
      `Embedding count mismatch for ${fileName}: ` +
        `${embeddings.length} vectors for ${chunks.length} chunks.`
    );
  }

  // The hash is written in TWO steps, and the order is the whole point.
  //
  // Writing the real content_hash alongside the document means a failure
  // during chunk insertion leaves a row that claims to be fully ingested. The
  // next run compares hashes, sees a match, and skips it -- forever. The
  // corpus then contains a document from which not one passage can be
  // retrieved, and nothing anywhere reports a problem.
  //
  // So the row goes in with a sentinel hash that can never match a real one.
  // Only once the chunks are in and counted is the true hash written. Any
  // failure in between leaves a mismatch, and the next run retries.
  const PENDING = `pending:${contentHash}`;

  const documentRow = {
    source_id: sourceId,
    title:
      meta.title ?? (pdfMeta.Title?.trim() || basename(fileName, extname(fileName))),
    authors: meta.authors ?? (pdfMeta.Author ? [pdfMeta.Author] : []),
    published_on: meta.publishedOn ?? null,
    source_url: meta.sourceUrl ?? null,
    file_name: fileName,
    page_count: pageCount,
    kind: meta.kind ?? "document",
    licence: meta.licence ?? null,
    content_hash: PENDING,
    embedding_model: EMBEDDING_MODEL,
    ingested_at: new Date().toISOString(),
  };

  const { data: document, error: upsertError } = await supabase
    .from("documents")
    .upsert(documentRow, { onConflict: "source_id" })
    .select("id")
    .single();

  if (upsertError) throw new Error(`Upsert failed for ${fileName}: ${upsertError.message}`);

  // Replace chunks wholesale rather than diffing them. A changed document can
  // shift every chunk boundary, so a diff would be more code for no gain.
  const { error: deleteError } = await supabase
    .from("chunks")
    .delete()
    .eq("document_id", document.id);

  if (deleteError) throw new Error(`Could not clear old chunks: ${deleteError.message}`);

  const rows = chunks.map((chunk, index) => ({
    document_id: document.id,
    chunk_index: chunk.chunkIndex,
    content: chunk.content,
    token_count: chunk.tokenCount,
    section: chunk.section,
    page_start: chunk.pageStart,
    page_end: chunk.pageEnd,
    embedding: embeddings[index],
  }));

  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const { error } = await supabase.from("chunks").insert(rows.slice(i, i + INSERT_BATCH));
    if (error) {
      throw new Error(
        `Chunk insert failed for ${fileName} at row ${i}: ${error.message}` +
          ` (the document is left marked incomplete and will be retried)`
      );
    }
  }

  // Count what actually landed rather than trusting the inserts. Then, and
  // only then, commit the real hash.
  const { count, error: countError } = await supabase
    .from("chunks")
    .select("*", { count: "exact", head: true })
    .eq("document_id", document.id);

  if (countError) throw new Error(`Could not verify chunks for ${fileName}: ${countError.message}`);

  if (count !== chunks.length) {
    throw new Error(
      `Chunk count mismatch for ${fileName}: stored ${count}, expected ${chunks.length}.`
    );
  }

  const { error: commitError } = await supabase
    .from("documents")
    .update({ content_hash: contentHash })
    .eq("id", document.id);

  if (commitError) throw new Error(`Could not finalise ${fileName}: ${commitError.message}`);

  return {
    fileName,
    status: existing ? "updated" : "added",
    chunks: chunks.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolve(args.dir);

  const supabase = createAdminClient();
  await assertModelConsistency(supabase, args.force);

  const files = (await readdir(dir))
    .filter((name) => name.toLowerCase().endsWith(".pdf"))
    .sort();

  if (files.length === 0) {
    console.log(`No PDFs in ${dir}. Run scripts/fetch-corpus.mjs first.`);
    return;
  }

  const manifest = await loadManifest(dir);
  console.log(
    `Ingesting ${files.length} PDFs from ${dir}\n` +
      `Embedding model: ${EMBEDDING_MODEL}${args.force ? " (forced re-ingest)" : ""}\n`
  );

  const tally = { added: 0, updated: 0, unchanged: 0, empty: 0, failed: 0 };
  let totalChunks = 0;

  for (const [index, fileName] of files.entries()) {
    const position = `[${index + 1}/${files.length}]`;
    try {
      const result = await ingestFile(supabase, join(dir, fileName), manifest, args.force);
      tally[result.status] += 1;
      totalChunks += result.chunks;

      const detail = result.chunks > 0 ? ` (${result.chunks} chunks)` : "";
      console.log(`${position} ${result.status.padEnd(9)} ${fileName}${detail}`);
    } catch (error) {
      // A daily quota is not a per-file problem: every remaining document
      // would fail identically. Stop and say so, rather than printing the
      // same error four hundred times.
      if (error.name === "DailyQuotaExhausted") {
        console.error(`${position} STOPPED   ${fileName}\n\n${error.message}\n`);
        break;
      }

      tally.failed += 1;
      // One malformed PDF must not abandon the other 399.
      console.error(`${position} FAILED    ${fileName}\n           ${error.message}`);
    }
  }

  console.log(
    `\nDone. ${tally.added} added, ${tally.updated} updated, ` +
      `${tally.unchanged} unchanged, ${tally.empty} empty, ${tally.failed} failed.\n` +
      `${totalChunks} chunks embedded.`
  );

  if (tally.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nIngestion aborted: ${error.message}`);
  process.exit(1);
});
