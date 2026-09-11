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

const PROVIDERS = {
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
 * Embed a batch of passages for storage.
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embedDocuments(texts) {
  if (texts.length === 0) return [];
  return config.provider === "voyage"
    ? embedWithVoyage(texts, "document")
    : embedWithOpenAI(texts);
}

/**
 * Embed a single question for retrieval.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embedQuery(text) {
  const [vector] =
    config.provider === "voyage"
      ? await embedWithVoyage([text], "query")
      : await embedWithOpenAI([text]);
  return vector;
}
