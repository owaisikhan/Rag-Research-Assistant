import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_NO_CITATIONS,
  buildUserTurn,
  QUERY_REWRITE_SYSTEM,
  summarySystem,
  buildSummaryTurn,
} from "./prompt.js";
import { siteConfig } from "../siteConfig.js";
import { streamGemini } from "./providers/gemini-chat.js";

// Which model writes the answer.
//
// Claude Opus 5 is the default and the recommendation. The job -- read a dozen
// passages, answer only from them, and attribute every claim correctly --
// rewards a model that follows NEGATIVE instructions ("do not use outside
// knowledge, say so if the sources do not answer") reliably, and that is
// exactly where cheaper models drift: they answer the question well from
// general knowledge and cite whatever looks closest.
//
// A Gemini model can be set instead, which lets the whole app run on a free
// tier with no Anthropic account. Useful for development and for demonstrating
// the pipeline; judge the pipeline by it, not the answer quality.
const MODEL = process.env.ANSWER_MODEL || "claude-opus-5";
const isGeminiAnswer = MODEL.startsWith("gemini");

// Follow-up rewriting is a mechanical transformation, so it runs on the
// cheapest available model rather than paying top rates to resolve a pronoun.
const REWRITE_MODEL = isGeminiAnswer ? "gemini-flash-lite-latest" : "claude-haiku-4-5";

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

  const prompt = `Conversation so far:\n${transcript}\n\nLatest message: ${question}`;

  try {
    if (isGeminiAnswer) {
      let text = "";
      for await (const delta of streamGemini({
        model: REWRITE_MODEL,
        system: QUERY_REWRITE_SYSTEM,
        messages: [{ role: "user", content: prompt }],
        maxTokens: 256,
      })) {
        text += delta;
      }
      return text.trim() || question;
    }

    const response = await anthropic().messages.create({
      model: REWRITE_MODEL,
      max_tokens: 256,
      system: QUERY_REWRITE_SYSTEM,
      messages: [{ role: "user", content: prompt }],
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
  const withCitations = siteConfig.mode.showCitations;

  const messages = [
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    {
      role: "user",
      content: buildUserTurn(question, sources, { numbered: withCitations }),
    },
  ];

  yield* streamChat({
    system: withCitations ? SYSTEM_PROMPT : SYSTEM_PROMPT_NO_CITATIONS,
    messages,
  });
}

/**
 * Stream a summary of one document.
 *
 * Single-turn by design: a summary is of the document, not of the
 * conversation, so the chat history is deliberately not sent. Passing it would
 * let an earlier turn steer what the summary emphasises, which is the one
 * thing a summary must not do.
 *
 * @param {object} params
 * @param {import("./summarize.js").Outline} params.outline
 * @returns {AsyncGenerator<string>}
 */
export async function* streamSummary({ outline }) {
  const withCitations = siteConfig.mode.showCitations;

  yield* streamChat({
    system: summarySystem({ numbered: withCitations }),
    messages: [
      {
        role: "user",
        content: buildSummaryTurn(outline, outline.passages, { numbered: withCitations }),
      },
    ],
  });
}

/**
 * The provider split, in one place.
 *
 * Both callers need the same thing -- a system prompt, some messages, text
 * deltas out -- and the Anthropic/Gemini branch is the kind of detail that
 * drifts when it is written twice.
 */
async function* streamChat({ system, messages, maxTokens = MAX_TOKENS }) {
  if (isGeminiAnswer) {
    yield* streamGemini({ model: MODEL, system, messages, maxTokens });
    return;
  }

  const stream = anthropic().beta.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    system,
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
