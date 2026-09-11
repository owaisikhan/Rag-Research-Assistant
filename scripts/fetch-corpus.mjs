#!/usr/bin/env node
// Build the demo library.
//
//   node scripts/fetch-corpus.mjs              # fetch everything in sources.json
//   node scripts/fetch-corpus.mjs --limit 20   # a small set, for a first run
//
// Writes PDFs into corpus/ plus a manifest.json of real metadata (title,
// authors, date, licence, canonical URL) that ingestion attaches to each
// document. Metadata comes from the source API rather than the PDF's own
// fields, which are frequently blank or wrong.
//
// Re-running is safe: anything already downloaded is skipped.

import { mkdir, readdir, writeFile, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { XMLParser } from "fast-xml-parser";

const ARXIV_API = "http://export.arxiv.org/api/query";
// arXiv's terms ask for no more than one request every three seconds.
const ARXIV_DELAY_MS = 3200;
// Politeness between PDF downloads, and insurance against being rate limited.
const DOWNLOAD_DELAY_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = { dir: "corpus", limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit") args.limit = Number(argv[++i]);
    else if (argv[i] === "--dir") args.dir = argv[++i];
  }
  return args;
}

/** arXiv ids contain slashes and dots; filenames must not. */
function safeFileName(sourceId) {
  return `${sourceId.replace(/[^a-zA-Z0-9._-]/g, "_")}.pdf`;
}

async function fetchArxivCategory({ category, count, kind }) {
  const params = new URLSearchParams({
    search_query: `cat:${category}`,
    start: "0",
    max_results: String(count),
    sortBy: "submittedDate",
    sortOrder: "descending",
  });

  const response = await fetch(`${ARXIV_API}?${params}`, {
    headers: { "user-agent": "rag-assistant-demo-corpus/1.0" },
  });

  if (!response.ok) {
    throw new Error(`arXiv API ${response.status} for ${category}`);
  }

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const feed = parser.parse(await response.text())?.feed;

  // A single result is an object, not an array.
  const entries = [].concat(feed?.entry ?? []);

  return entries.map((entry) => {
    // "http://arxiv.org/abs/2401.12345v1" -> "2401.12345v1"
    const arxivId = String(entry.id).split("/abs/")[1];
    const authors = [].concat(entry.author ?? []).map((a) => a.name).filter(Boolean);

    return {
      sourceId: `arxiv:${arxivId}`,
      title: String(entry.title).replace(/\s+/g, " ").trim(),
      authors,
      publishedOn: String(entry.published).slice(0, 10),
      sourceUrl: `https://arxiv.org/abs/${arxivId}`,
      downloadUrl: `https://arxiv.org/pdf/${arxivId}`,
      kind,
      licence: "arXiv open access (see paper for specific licence)",
      fileName: safeFileName(`arxiv:${arxivId}`),
    };
  });
}

async function download(url, destination) {
  const response = await fetch(url, {
    headers: { "user-agent": "rag-assistant-demo-corpus/1.0" },
    redirect: "follow",
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const bytes = Buffer.from(await response.arrayBuffer());

  // A rate-limit or error page served with a 200 is the common failure here,
  // and it is invisible until ingestion produces a document of gibberish.
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new Error(`not a PDF (got ${bytes.length} bytes starting "${bytes.subarray(0, 20).toString("latin1").replace(/\s+/g, " ")}")`);
  }

  await writeFile(destination, bytes);
  return bytes.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolve(args.dir);
  await mkdir(dir, { recursive: true });

  const sources = JSON.parse(await readFile(resolve("scripts/sources.json"), "utf8"));

  console.log("Building the document list...\n");
  const wanted = [];

  for (const spec of sources.arxiv ?? []) {
    try {
      const entries = await fetchArxivCategory(spec);
      wanted.push(...entries);
      console.log(`  ${String(entries.length).padStart(3)} from arXiv ${spec.category} (${spec.label})`);
    } catch (error) {
      console.error(`  FAILED arXiv ${spec.category}: ${error.message}`);
    }
    await sleep(ARXIV_DELAY_MS);
  }

  for (const entry of sources.direct ?? []) {
    wanted.push({
      sourceId: entry.sourceId,
      title: entry.title,
      authors: entry.authors ?? [],
      publishedOn: entry.publishedOn ?? null,
      sourceUrl: entry.url,
      downloadUrl: entry.url,
      kind: entry.kind ?? "document",
      licence: entry.licence ?? null,
      fileName: safeFileName(entry.sourceId),
    });
  }
  console.log(`  ${String((sources.direct ?? []).length).padStart(3)} direct documents (standards, reports)\n`);

  const targets = wanted.slice(0, args.limit);
  const onDisk = new Set(await readdir(dir).catch(() => []));

  console.log(`Downloading ${targets.length} documents into ${dir}\n`);

  const manifest = [];
  const tally = { downloaded: 0, skipped: 0, failed: 0 };

  for (const [index, entry] of targets.entries()) {
    const position = `[${index + 1}/${targets.length}]`;
    const destination = join(dir, entry.fileName);

    if (onDisk.has(entry.fileName)) {
      const { size } = await stat(destination);
      manifest.push(entry);
      tally.skipped += 1;
      console.log(`${position} have      ${entry.fileName} (${(size / 1024).toFixed(0)} kB)`);
      continue;
    }

    try {
      const size = await download(entry.downloadUrl, destination);
      manifest.push(entry);
      tally.downloaded += 1;
      console.log(`${position} saved     ${entry.fileName} (${(size / 1024).toFixed(0)} kB)`);
    } catch (error) {
      tally.failed += 1;
      console.error(`${position} FAILED    ${entry.fileName} -- ${error.message}`);
    }

    await sleep(DOWNLOAD_DELAY_MS);
  }

  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(
    `\n${tally.downloaded} downloaded, ${tally.skipped} already present, ${tally.failed} failed.\n` +
      `Manifest written with ${manifest.length} documents.\n\n` +
      `Next: node scripts/ingest.mjs`
  );
}

main().catch((error) => {
  console.error(`\nCorpus build failed: ${error.message}`);
  process.exit(1);
});
