import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { SYSTEM_PROMPT, buildUserTurn, QUERY_REWRITE_SYSTEM } from "./prompt.js";

// Claude Opus 5. The job -- read a dozen passages, answer only from them, and
// attribute every claim correctly -- rewards a model that follows negative
// instructions ("do not use outside knowledge") reliably, which is exactly
// where the cheaper tiers drift.
const MODEL = "claude-opus-5";

// Follow-up rewriting is a mechanical transformation, so it runs on the
// cheapest model rather than paying Opus rates to resolve a pronoun.
const REWRITE_MODEL = "claude-haiku-4-5";

// A cited answer should be a few paragraphs. 4096 leaves room for a thorough
// answer over a dozen sources without ever truncating mid-sentence.
const MAX_TOKENS = 4096;

// Low effort, with adaptive thinking left on.
//
// Answering from supplied passages is synthesis, not hard reasoning -- the
// difficulty was in retrieval, which already happened. Low effort keeps
// time-to-first-token short, which is most of what makes the demo feel good.
// Lowering effort is also the recommended alternative to disabling thinking
// outright, which has its own failure modes.
const EFFORT = process.env.ANSWER_EFFORT || "low";

let client;
function anthropic() {
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

/**
 * Turn a follow-up into a standalone search query.
 *
 * Falls back to the raw question on any failure: a degraded search beats a
 * failed request, and the user never learns this step existed.
 *
 * @param {string} question
 * @param {Array<{role: string, content: string}>} history
 * @returns {Promise<string>}
 */
export async function rewriteQuery(question, history) {
  if (history.length === 0) return question;

  const transcript = history
    .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
    .join("\n");

  try {
    const response = await anthropic().messages.create({
      model: REWRITE_MODEL,
      max_tokens: 256,
      system: QUERY_REWRITE_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Conversation so far:\n${transcript}\n\nLatest message: ${question}`,
        },
      ],
    });

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    return text || question;
  } catch {
    return question;
  }
}

/**
 * Stream a grounded answer.
 *
 * Server-side refusal fallbacks are enabled: this corpus includes security
 * research, so questions about malware, exploits and attack techniques are
 * ordinary here and can trip a policy classifier. Without a fallback the
 * request would simply stop and the demo would look broken; with it, the same
 * request is re-run on a fallback model inside the same call.
 *
 * @param {object} params
 * @param {string} params.question
 * @param {import("./retrieve.js").Source[]} params.sources
 * @param {Array<{role: string, content: string}>} params.history
 * @returns {AsyncGenerator<string>}
 */
export async function* streamAnswer({ question, sources, history }) {
  const messages = [
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user", content: buildUserTurn(question, sources) },
  ];

  const stream = anthropic().beta.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: { effort: EFFORT },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages,
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
}
