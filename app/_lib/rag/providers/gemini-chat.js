import "server-only";

// Gemini answer generation, for running the app without an Anthropic key.
//
// Kept in its own file rather than branching inside answer.js, because the two
// APIs disagree about almost everything superficial -- role names, where the
// system prompt goes, how a stream is framed -- and interleaving that makes
// both harder to read than either is alone.

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

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
export async function* streamGemini({ model, system, messages, maxTokens }) {
  const response = await fetch(`${BASE}/${model}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      // The system prompt is a separate field, not a message with a role.
      systemInstruction: { parts: [{ text: system }] },
      contents: toGeminiContents(messages),
      generationConfig: {
        maxOutputTokens: maxTokens,
        // Low but not zero. This task is extraction and attribution, where
        // invention is a liability -- but zero makes repetitive phrasing and
        // occasional loops more likely.
        temperature: 0.2,
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini generation failed: ${response.status} ${detail.slice(0, 300)}`);
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
        const text = parsed.candidates?.[0]?.content?.parts
          ?.map((part) => part.text ?? "")
          .join("");
        if (text) yield text;
      } catch {
        // A line that does not parse is a partial write; the next read
        // completes it.
      }
    }
  }
}
