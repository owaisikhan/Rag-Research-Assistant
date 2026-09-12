// Embedding provider.
//
// Deliberately an interface with a default rather than a direct SDK call.
// Clients ask for one of three things within the first week -- "use our
// OpenAI key", "we can't send documents to a US API", "can it run offline" --
// and each is a config change here rather than a rewrite.
//
// THE RULE THAT MATTERS: the model that embedded the corpus must be the model
// that embeds the query. Mixing them produces retrieval that looks like it is
// working and is actually returning noise. documents.embedding_model records
// which model wrote each row, and ingestion refuses to mix.

import OpenAI from "openai";

import { createRateWindow } from "./rate-window.js";

const PROVIDERS = {
  // Gemini lets you ASK for a dimensionality, so it is pinned to 1536 to match
  // the vector(1536) column rather than forcing a migration. 001 is preferred
  // over the newer gemini-embedding-2 here because it still supports
  // `taskType`, and embedding a document differently from a query is a real
  // retrieval gain on exactly this workload.
  "gemini-embedding-001": { provider: "gemini", dimensions: 1536, taskType: true },
  "gemini-embedding-2": { provider: "gemini", dimensions: 1536, taskType: false },

  "text-embedding-3-small": { provider: "openai", dimensions: 1536 },
  "text-embedding-3-large": { provider: "openai", dimensions: 3072 },
  "voyage-3": { provider: "voyage", dimensions: 1024 },
  "voyage-3-lite": { provider: "voyage", dimensions: 512 },
};

export const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL || "text-embedding-3-small";

const config = PROVIDERS[EMBEDDING_MODEL];
if (!config) {
  throw new Error(
    `Unknown EMBEDDING_MODEL "${EMBEDDING_MODEL}". ` +
      `Known models: ${Object.keys(PROVIDERS).join(", ")}. ` +
      `Adding one means adding it here AND changing the vector(n) dimension ` +
      `in a new migration -- the column width is fixed at the database.`
  );
}

export const EMBEDDING_DIMENSIONS = config.dimensions;

let openaiClient;
function openai() {
  openaiClient ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiClient;
}

async function embedWithOpenAI(texts) {
  const response = await openai().embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  // The API does not guarantee input order in the response.
  return response.data
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}

async function embedWithVoyage(texts, inputType) {
  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
      // Voyage embeds documents and queries asymmetrically, which is a real
      // retrieval gain and the main reason to reach for it over OpenAI.
      input_type: inputType,
    }),
  });

  if (!response.ok) {
    throw new Error(`Voyage embeddings failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  return body.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
}

/**
 * Gemini returns UNNORMALISED vectors at any dimensionality other than 3072.
 *
 * Cosine distance normalises internally, so retrieval is correct either way
 * today. They are normalised anyway because the moment anyone switches the
 * index to L2 (`<->`) or inner product (`<#>`) — or compares two vectors in
 * application code — unnormalised values give quietly wrong answers with no
 * error. One cheap loop removes a whole class of future bug.
 */
function normalise(values) {
  let sumOfSquares = 0;
  for (const value of values) sumOfSquares += value * value;

  const magnitude = Math.sqrt(sumOfSquares);
  if (magnitude === 0) return values;

  return values.map((value) => value / magnitude);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Gemini's free tier allows 100 embed requests per minute, and — measured,
// not assumed — EACH TEXT inside a batch counts as one request, not each HTTP
// call. Batching therefore saves round trips and nothing else.
//
// The quota is enforced per project per model, so a sliding window here is
// what keeps ingestion under it. 95 rather than 100 leaves headroom for the
// query path, which shares the same quota with a live user waiting on it.
const GEMINI_LIMIT_PER_MINUTE = Number(process.env.GEMINI_EMBED_RPM || 95);
const WINDOW_MS = 60_000;

const geminiWindow = createRateWindow({ limit: GEMINI_LIMIT_PER_MINUTE, windowMs: WINDOW_MS });

/**
 * Gemini's free tier enforces TWO quotas, and they need opposite responses:
 *
 *   EmbedContentRequestsPerMinutePerProjectPerModel-FreeTier = 100
 *   EmbedContentRequestsPerDayPerProjectPerModel-FreeTier    = 1000
 *
 * A per-minute rejection is worth waiting out -- it clears in under a minute.
 * A per-day rejection is not: the retryDelay it returns is a small number of
 * seconds even when the quota does not reset for hours, so honouring it burns
 * every retry on a request that cannot succeed, then reports "429" as though
 * it were a transient blip. The run needs to stop and say so plainly.
 */
function quotaKind(payload) {
  try {
    const violations = JSON.parse(payload).error?.details?.find((detail) =>
      String(detail["@type"]).endsWith("QuotaFailure")
    )?.violations;

    const id = violations?.map((violation) => violation.quotaId).join(" ") ?? "";
    if (/PerDay/i.test(id)) return "daily";
    if (/PerMinute/i.test(id)) return "minute";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** Thrown when the day's allowance is gone; retrying cannot help. */
export class DailyQuotaExhausted extends Error {
  constructor(message) {
    super(message);
    this.name = "DailyQuotaExhausted";
  }
}

/** Google returns how long to wait; honour it instead of guessing. */
function retryDelayFrom(payload) {
  try {
    const info = JSON.parse(payload).error?.details?.find((detail) =>
      String(detail["@type"]).endsWith("RetryInfo")
    );
    const seconds = Number(String(info?.retryDelay).replace("s", ""));
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

async function embedWithGemini(texts, taskType) {
  const body = {
    requests: texts.map((text) => ({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      outputDimensionality: config.dimensions,
      // gemini-embedding-2 rejects taskType; it wants the instruction in the
      // prompt instead. Only send it to a model that accepts it.
      ...(config.taskType ? { taskType } : {}),
    })),
  };

  // The free tier rate limits aggressively and recovers quickly, so a few
  // backed-off retries turn a failed overnight ingestion into a slow one.
  const MAX_ATTEMPTS = 8;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await geminiWindow.reserve(texts.length);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify(body),
      }
    );

    if (response.ok) {
      const parsed = await response.json();
      const embeddings = parsed.embeddings ?? [];

      if (embeddings.length !== texts.length) {
        throw new Error(
          `Gemini returned ${embeddings.length} embeddings for ${texts.length} inputs.`
        );
      }

      return embeddings.map((embedding) => normalise(embedding.values));
    }

    const detail = await response.text();

    if (response.status === 429 && quotaKind(detail) === "daily") {
      throw new DailyQuotaExhausted(
        "Gemini free tier: the daily embedding allowance (1000 requests, where " +
          "each TEXT counts as one) is exhausted. It resets on Google's clock, " +
          "usually within 24 hours.\n" +
          "  Options: wait for the reset and re-run (ingestion resumes exactly " +
          "where it stopped), enable billing on the Google Cloud project, or " +
          "switch EMBEDDING_MODEL to a provider with headroom."
      );
    }

    const retryable = response.status === 429 || response.status >= 500;

    if (!retryable || attempt === MAX_ATTEMPTS) {
      throw new Error(`Gemini embeddings failed: ${response.status} ${detail.slice(0, 300)}`);
    }

    // Google states the wait in the error; an exponential guess is usually
    // far too short (it asks for ~38s, the guess starts at 2s).
    const wait = retryDelayFrom(detail) ?? 2000 * 2 ** (attempt - 1);
    console.warn(
      `  Gemini ${response.status}; waiting ${Math.round(wait / 1000)}s (attempt ${attempt}/${MAX_ATTEMPTS - 1})`
    );
    // Record the block BEFORE sleeping, so any other in-flight caller sharing
    // this module waits too rather than walking into the same wall.
    geminiWindow.block(wait);

    await sleep(wait);
  }

  throw new Error("Unreachable");
}

/**
 * Embed a batch of passages for storage.
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embedDocuments(texts) {
  if (texts.length === 0) return [];
  if (config.provider === "gemini") return embedWithGemini(texts, "RETRIEVAL_DOCUMENT");
  if (config.provider === "voyage") return embedWithVoyage(texts, "document");
  return embedWithOpenAI(texts);
}

/**
 * Embed a single question for retrieval.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embedQuery(text) {
  let vectors;
  if (config.provider === "gemini") vectors = await embedWithGemini([text], "RETRIEVAL_QUERY");
  else if (config.provider === "voyage") vectors = await embedWithVoyage([text], "query");
  else vectors = await embedWithOpenAI([text]);

  return vectors[0];
}
