#!/usr/bin/env node
// Check the setup end to end and say precisely what is wrong.
//
//   node scripts/doctor.mjs
//
// Written because the first run is where everything fails at once -- a
// migration not applied, a key in the wrong variable, the pgvector extension
// missing -- and the raw errors from three different SDKs do not point at
// which. Each check below names the fix, not just the symptom.

import { loadEnv } from "./lib/env.mjs";

loadEnv();

const results = [];
let fatal = false;

function record(name, ok, detail, fix) {
  results.push({ name, ok, detail, fix });
  if (!ok && fix) fatal = true;
}

// ----------------------------------------------------------- environment

// Which embedding key is needed depends on EMBEDDING_MODEL, so asking for an
// OpenAI key while the project is configured for Gemini would send someone to
// buy credit they do not need.
const EMBEDDING_KEYS = {
  gemini: ["GEMINI_API_KEY", "aistudio.google.com → API keys (free tier covers embeddings)"],
  openai: ["OPENAI_API_KEY", "platform.openai.com → API keys (requires billing; no free tier)"],
  voyage: ["VOYAGE_API_KEY", "dash.voyageai.com → API keys"],
};

const selectedModel = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const selectedProvider = selectedModel.startsWith("gemini")
  ? "gemini"
  : selectedModel.startsWith("voyage")
    ? "voyage"
    : "openai";

const [embeddingKeyName, embeddingKeyWhere] = EMBEDDING_KEYS[selectedProvider];

const REQUIRED = {
  NEXT_PUBLIC_SUPABASE_URL: "Supabase → Project Settings → Data API → Project URL",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "Supabase → Project Settings → API Keys → anon / public",
  SUPABASE_SERVICE_ROLE_KEY: "Supabase → Project Settings → API Keys → service_role (keep it local)",
  [embeddingKeyName]: `${embeddingKeyWhere} — needed by EMBEDDING_MODEL=${selectedModel}`,
  ANTHROPIC_API_KEY: "console.anthropic.com → API keys (used for answers)",
};

for (const [key, where] of Object.entries(REQUIRED)) {
  const value = process.env[key];
  record(
    key,
    Boolean(value),
    value ? `set (${value.length} chars)` : "missing",
    value ? null : `Add ${key} to .env.local — ${where}`
  );
}

// Non-ASCII characters in a credential are almost always a paste artefact, and
// the failure they cause is genuinely baffling: the Supabase client puts these
// values into HTTP headers, headers may only hold characters 0-255, and the
// browser reports "Cannot convert argument to a ByteString because the
// character at index 8 has a value of 8226" -- naming neither the variable nor
// the character, and pointing at whichever line happened to log it.
//
// A bullet, a curly quote, an en dash or a non-breaking space is all it takes.
const INVISIBLE = {
  0x2022: "a bullet (•)",
  0x2013: "an en dash (–)",
  0x2014: "an em dash (—)",
  0x201c: "a curly quote (“)",
  0x201d: "a curly quote (”)",
  0x00a0: "a non-breaking space",
  0x200b: "a zero-width space",
  0xfeff: "a byte-order mark",
};

for (const key of Object.keys(REQUIRED)) {
  const value = process.env[key];
  if (!value) continue;

  const index = [...value].findIndex((character) => character.charCodeAt(0) > 127);
  if (index === -1) continue;

  const code = value.charCodeAt(index);
  const what = INVISIBLE[code] ?? `character U+${code.toString(16).toUpperCase().padStart(4, "0")}`;

  record(
    `${key} is plain text`,
    false,
    `contains ${what} at position ${index}`,
    `${key} has a non-ASCII character at position ${index} -- ${what}. It was ` +
      `almost certainly introduced by copying and pasting. Retype or re-copy ` +
      `that line in .env.local. The value should contain only letters, digits ` +
      `and plain punctuation.\n    Context: ...${value.slice(Math.max(0, index - 6), index + 7)}...`
  );
}

// A service-role key in the anon slot is a silent catastrophe: it works
// perfectly in development and hands every visitor full database access.
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function roleOf(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString()).role ?? null;
  } catch {
    return null;
  }
}

if (anon && service) {
  const anonRole = roleOf(anon);
  record(
    "key roles",
    anonRole !== "service_role",
    anonRole ? `anon key carries role "${anonRole}"` : "could not decode (new-style keys are opaque — check manually)",
    anonRole === "service_role"
      ? "DANGER: the service_role key is in NEXT_PUBLIC_SUPABASE_ANON_KEY. That key ships to every browser and bypasses RLS. Swap them and rotate the exposed key immediately."
      : null
  );

  record(
    "keys differ",
    anon !== service,
    anon === service ? "anon and service_role are identical" : "distinct",
    anon === service ? "The same key is in both slots. Copy the anon key and the service_role key separately." : null
  );
}

if (fatal) {
  report();
  process.exit(1);
}

// -------------------------------------------------------------- database

const { createAdminClient } = await import("../app/_lib/supabase-auth.js");
const supabase = createAdminClient();

for (const table of ["documents", "chunks"]) {
  const { error, count } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true });

  record(
    `table ${table}`,
    !error,
    error ? error.message : `${count ?? 0} rows`,
    error ? "Run supabase/migrations/001_knowledge_base.sql in the Supabase SQL editor." : null
  );
}

// Calling the function is the only honest check that pgvector, the HNSW index
// and the function signature all line up.
{
  const probe = Array.from({ length: 1536 }, () => 0);
  const { error } = await supabase.rpc("match_chunks", {
    query_embedding: probe,
    query_text: "connectivity probe",
    match_count: 1,
  });

  const dimensionMismatch = error && /expected \d+ dimensions/i.test(error.message);

  record(
    "match_chunks()",
    !error,
    error ? error.message : "callable",
    !error
      ? null
      : dimensionMismatch
        ? "The vector column width does not match EMBEDDING_MODEL. Change vector(n) in a migration to match, then re-ingest with --force."
        : "Run supabase/migrations/001_knowledge_base.sql — the function or the vector extension is missing."
  );
}

{
  const { error } = await supabase.rpc("corpus_stats");
  record("corpus_stats()", !error, error ? error.message : "callable",
    error ? "Run supabase/migrations/001_knowledge_base.sql." : null);
}

{
  const { error } = await supabase.rpc("check_rate_limit", {
    caller: "doctor-probe",
    max_per_hour: 1000,
  });
  record("check_rate_limit()", !error, error ? error.message : "callable",
    error ? "Run supabase/migrations/002_rate_limit.sql." : null);
}

// ---------------------------------------------------------------- models

{
  const { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, embedQuery } = await import(
    "../app/_lib/rag/embed.js"
  );
  try {
    const vector = await embedQuery("connectivity probe");
    record(
      `embeddings (${EMBEDDING_MODEL})`,
      vector.length === EMBEDDING_DIMENSIONS,
      `returned ${vector.length} dimensions, schema expects ${EMBEDDING_DIMENSIONS}`,
      vector.length === EMBEDDING_DIMENSIONS
        ? null
        : `Dimension mismatch. Change vector(${EMBEDDING_DIMENSIONS}) to vector(${vector.length}) in a migration.`
    );
  } catch (error) {
    record(`embeddings (${EMBEDDING_MODEL})`, false, error.message,
      `Check ${embeddingKeyName} is valid and the account is in good standing.`);
  }
}

{
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  try {
    const response = await new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      .messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with the single word: ready" }],
      });
    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    record("Anthropic API", true, `responded "${text.trim()}"`, null);
  } catch (error) {
    record("Anthropic API", false, error.message,
      "Check ANTHROPIC_API_KEY is valid and the account has credit.");
  }
}

report();

function report() {
  const pad = Math.max(...results.map((r) => r.name.length));
  console.log("");
  for (const result of results) {
    console.log(`  ${result.ok ? "✓" : "✗"} ${result.name.padEnd(pad)}  ${result.detail}`);
  }

  const problems = results.filter((r) => !r.ok && r.fix);
  if (problems.length === 0) {
    console.log("\nEverything checks out. Next: npm run corpus:fetch -- --limit 20\n");
    return;
  }

  console.log(`\n${problems.length} problem${problems.length === 1 ? "" : "s"} to fix:\n`);
  for (const problem of problems) {
    console.log(`  ${problem.name}\n    ${problem.fix}\n`);
  }
  process.exitCode = 1;
}
