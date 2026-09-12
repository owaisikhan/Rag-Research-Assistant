import "server-only";

import { DailyQuotaExhausted } from "../embed.js";

// Gemini answer generation, for running the app without an Anthropic key.
//
// Kept in its own file rather than branching inside answer.js, because the two
// APIs disagree about almost everything superficial -- role names, where the
// system prompt goes, how a stream is framed -- and interleaving that makes
// both harder to read than either is alone.

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Extra output budget set aside for reasoning tokens. Measured: a 12-passage
// prompt spends 300-500 thinking tokens before writing anything.
const THINKING_HEADROOM = 4096;

/**
 * Gemini calls the assistant "model", not "assistant". The wrong role name is
 * rejected outright; an inconsistent one silently confuses the model about who
 * said what.
 */
function toGeminiContents(messages) {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));
}

/**
 * Stream an answer from Gemini.
 *
 * @param {object} params
 * @param {string} params.model
 * @param {string} params.system
 * @param {Array<{role: string, content: string}>} params.messages
 * @param {number} params.maxTokens
 * @returns {AsyncGenerator<string>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function* streamGemini({ model, system, messages, maxTokens }) {
  const body = JSON.stringify({
    // The system prompt is a separate field, not a message with a role.
    systemInstruction: { parts: [{ text: system }] },
    contents: toGeminiContents(messages),
    generationConfig: {
      // Thinking tokens count against this budget on 3.x models, and they are
      // not small -- a RAG prompt of a dozen passages regularly draws several
      // hundred. Passing the caller's answer budget directly truncates the
      // answer mid-sentence, with finishReason MAX_TOKENS and no other signal.
      // The headroom is for reasoning, not for a longer answer.
      maxOutputTokens: maxTokens + THINKING_HEADROOM,
      // Low but not zero. This task is extraction and attribution, where
      // invention is a liability -- but zero makes repetitive phrasing and
      // occasional loops more likely.
      temperature: 0.2,
    },
  });

  // The free tier returns 503 "experiencing high demand" often enough that a
  // single attempt shows the user a broken app for something that clears in
  // seconds. Retried here rather than surfaced, because nothing upstream can
  // do anything useful with it.
  const MAX_ATTEMPTS = 5;
  let response;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    response = await fetch(`${BASE}/${model}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body,
    });

    if (response.ok) break;

    const detail = await response.text();

    // Generation has its own daily allowance, separate from the embedding one.
    // Retrying it is pointless and the generic "please try again" it produced
    // was actively misleading -- retrieval had worked, sources were already on
    // screen, and the only thing missing was an answer that would not arrive
    // for hours.
    if (response.status === 429 && /PerDay/i.test(detail)) {
      throw new DailyQuotaExhausted(
        "Gemini free tier: the daily allowance for generating answers is used up. " +
          "It is a separate quota from embeddings, so search still works. " +
          "It resets every 24 hours."
      );
    }

    const transient = response.status === 429 || response.status >= 500;

    if (!transient || attempt === MAX_ATTEMPTS) {
      throw new Error(`Gemini generation failed: ${response.status} ${detail.slice(0, 300)}`);
    }

    // 503 "experiencing high demand" is common on the free tier and clears in
    // seconds, so it is worth waiting out rather than failing the request.
    await sleep(1000 * 2 ** (attempt - 1));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse LINE BY LINE, not by blank-line-delimited frame.
    //
    // The SSE spec separates events with a blank line, but this endpoint does
    // not always send one -- payloads can arrive one per single newline.
    // Splitting on "\n\n" then concatenates several JSON objects into one
    // string that cannot parse, and the whole answer is silently dropped: the
    // stream completes, no error is raised, and the user sees an empty reply.
    //
    // Splitting on "\n" handles both framings, and \r is trimmed for CRLF.
    const lines = buffer.split("\n");
    // The last element may be a partial line; carry it to the next read.
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;

      try {
        const parsed = JSON.parse(payload);

        // Thinking models emit parts with no text (and a thoughtSignature)
        // alongside the answer; joining them is harmless, but a part without
        // text must not be treated as the answer ending.
        const candidate = parsed.candidates?.[0];

        const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("");
        if (text) yield text;

        // A truncated answer is worse than a short one, because it reads as
        // complete until the last line. Say so rather than let it pass.
        if (candidate?.finishReason === "MAX_TOKENS") {
          yield "\n\n_(This answer was cut short by the output limit.)_";
        }
      } catch {
        // A line that does not parse is a partial write; the next read
        // completes it.
      }
    }
  }
}
