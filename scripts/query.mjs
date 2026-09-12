#!/usr/bin/env node
// Ask the corpus a question from the terminal.
//
//   node scripts/query.mjs "what is zero trust?"
//   node scripts/query.mjs --retrieval-only "lateral movement detection"
//
// Exists for two reasons. It is the fastest way to tell whether a retrieval
// change helped or hurt, without a browser in the loop. And it separates the
// two halves of a RAG failure: --retrieval-only shows exactly what the model
// would have been given, which is where a bad answer almost always starts.

import { loadEnv } from "./lib/env.mjs";

loadEnv();

const { embedQuery, EMBEDDING_MODEL } = await import("../app/_lib/rag/embed.js");
const { createAdminClient } = await import("../app/_lib/supabase-auth.js");

function parseArgs(argv) {
  const args = { question: [], retrievalOnly: false, matchCount: 8 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--retrieval-only") args.retrievalOnly = true;
    else if (argv[i] === "--count") args.matchCount = Number(argv[++i]);
    else args.question.push(argv[i]);
  }
  args.question = args.question.join(" ").trim();
  return args;
}

function formatPages(source) {
  return source.page_start === source.page_end
    ? `p. ${source.page_start}`
    : `pp. ${source.page_start}-${source.page_end}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.question === "") {
    console.error('Usage: node scripts/query.mjs "your question"');
    process.exit(1);
  }

  const supabase = createAdminClient();

  console.log(`\nQuestion: ${args.question}`);
  console.log(`Embedding with: ${EMBEDDING_MODEL}\n`);

  const startedAt = Date.now();
  const embedding = await embedQuery(args.question);
  const embeddedAt = Date.now();

  const { data, error } = await supabase.rpc("match_chunks", {
    query_embedding: embedding,
    query_text: args.question,
    match_count: args.matchCount,
  });

  if (error) {
    console.error(`Retrieval failed: ${error.message}`);
    process.exit(1);
  }

  const retrievedAt = Date.now();

  console.log(
    `Retrieved ${data.length} passages ` +
      `(embed ${embeddedAt - startedAt}ms, search ${retrievedAt - embeddedAt}ms)\n`
  );

  if (data.length === 0) {
    console.log("Nothing matched. Is the corpus populated?\n");
    return;
  }

  data.forEach((source, index) => {
    const where = source.section ? `${source.section}, ${formatPages(source)}` : formatPages(source);
    console.log(`[${index + 1}] ${source.title}`);
    console.log(`    ${where}  ·  rrf ${source.score.toFixed(5)}`);
    console.log(`    ${source.content.slice(0, 200).replace(/\s+/g, " ")}...`);
    console.log("");
  });

  if (args.retrievalOnly) return;

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("ANTHROPIC_API_KEY is not set, so no answer was generated.");
    console.log("The passages above are exactly what would have been sent.\n");
    return;
  }

  const { streamAnswer } = await import("../app/_lib/rag/answer.js");

  const sources = data.map((row) => ({
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
    score: row.score,
  }));

  console.log("Answer:\n");
  for await (const text of streamAnswer({ question: args.question, sources, history: [] })) {
    process.stdout.write(text);
  }
  console.log("\n");
}

main().catch((error) => {
  console.error(`\n${error.name === "DailyQuotaExhausted" ? error.message : error.stack}`);
  process.exit(1);
});
