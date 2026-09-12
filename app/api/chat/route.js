// The chat endpoint.
//
// A route handler rather than a Server Action because Server Actions cannot
// stream token by token, and watching the answer appear is most of what makes
// the demo feel like a product rather than a form.
//
// Wire format is NDJSON -- one JSON object per line:
//   {"type":"sources","sources":[...]}   exactly once, before any text
//   {"type":"delta","text":"..."}        many
//   {"type":"error","message":"..."}     instead of, or after, the above
//
// Sources are sent FIRST so the UI can render the citation panel while the
// answer is still being written, and so a citation marker like [3] always has
// somewhere to point by the time it appears in the text.

import { retrieve } from "@/app/_lib/rag/retrieve";
import { streamAnswer, rewriteQuery } from "@/app/_lib/rag/answer";
import { checkRateLimit, validateChatRequest } from "@/app/_lib/rag/limits";
import { ensureSessionId } from "@/app/_lib/session";
import { siteConfig } from "@/app/_lib/siteConfig";

// Node runtime: the embedding and Anthropic SDKs and node:crypto all want it.
export const runtime = "nodejs";
// 300s is the Hobby limit with fluid compute. Answers stream long before
// this, but a slow retrieval plus a slow first token should not be cut off.
export const maxDuration = 300;

const encoder = new TextEncoder();

function line(object) {
  return encoder.encode(`${JSON.stringify(object)}\n`);
}

function errorResponse(message, status) {
  return new Response(`${JSON.stringify({ type: "error", message })}\n`, {
    status,
    headers: { "content-type": "application/x-ndjson" },
  });
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Malformed request.", 400);
  }

  const validated = validateChatRequest(body);
  if (!validated.ok) {
    return errorResponse(validated.message, 400);
  }

  const { allowed, resetsAt } = await checkRateLimit(request);
  if (!allowed) {
    const when = resetsAt
      ? ` Try again after ${new Date(resetsAt).toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
        })}.`
      : "";
    return errorResponse(
      `This demo allows a limited number of questions per hour.${when}`,
      429
    );
  }

  const { question, history } = validated;

  // Created here rather than on the home page, because a Server Component
  // cannot set cookies. A visitor who has never uploaded simply searches the
  // demo corpus.
  const sessionId = await ensureSessionId();

  let sources;
  try {
    // A follow-up ("what about the second one?") is meaningless to a search
    // index, so it is rewritten against the conversation before retrieval.
    const searchQuery = await rewriteQuery(question, history);
    sources = await retrieve(searchQuery, { sessionId });
  } catch (error) {
    console.error("Retrieval failed:", error);

    // Same distinction as the upload path: a daily allowance does not come
    // back "shortly", and saying so wastes the reader's time.
    if (error.name === "DailyQuotaExhausted") {
      return errorResponse(
        "This demo's daily allowance for searching is used up. It resets every " +
          "24 hours. Sorry — please come back tomorrow.",
        429
      );
    }

    return errorResponse("Could not search the library. Please try again.", 502);
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // With citations off there is no panel to fill, so the event is
        // skipped entirely rather than sent and ignored -- it is the largest
        // thing on the wire, and the browser would only discard it.
        if (siteConfig.mode.showCitations) {
        // Trimmed: the browser needs everything to render a citation, but not
        // the passage text, which is already going to the model.
        controller.enqueue(
          line({
            type: "sources",
            sources: sources.map((source, index) => ({
              number: index + 1,
              chunkId: source.chunkId,
              title: source.title,
              authors: source.authors,
              section: source.section,
              pageStart: source.pageStart,
              pageEnd: source.pageEnd,
              sourceUrl: source.sourceUrl,
              kind: source.kind,
              isUpload: source.isUpload,
              excerpt: source.content.slice(0, 320),
            })),
          })
        );
        }

        for await (const text of streamAnswer({ question, sources, history })) {
          controller.enqueue(line({ type: "delta", text }));
        }
      } catch (error) {
        console.error("Answer generation failed:", error);

        // The sources are already rendered at this point, so a bare "try
        // again" reads as though the whole thing broke. Say which half did.
        const message =
          error.name === "DailyQuotaExhausted"
            ? "The sources above were found, but this demo's daily allowance for " +
              "writing answers is used up. It resets every 24 hours."
            : "The answer stopped early. The sources above are still the ones " +
              "that matched — try asking again.";

        controller.enqueue(line({ type: "error", message }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      // Streaming dies behind some proxies without this.
      "x-accel-buffering": "no",
    },
  });
}
