// Summarise one whole document.
//
// Same NDJSON wire format as /api/chat, deliberately: the browser reads both
// with the same parser and renders the result as the same kind of assistant
// turn. A second format would buy nothing and cost a second reader.
//
//   {"type":"sources","sources":[...]}   at most once, before any text
//   {"type":"delta","text":"..."}        many
//   {"type":"error","message":"..."}     instead of, or after, the above
//
// Unlike the chat endpoint this spends NO embedding quota -- there is no query
// to embed. Only the answer model is billed.

import { getOutline } from "@/app/_lib/rag/summarize";
import { streamSummary } from "@/app/_lib/rag/answer";
import { checkRateLimit } from "@/app/_lib/rag/limits";
import { readSessionId } from "@/app/_lib/session";
import { siteConfig } from "@/app/_lib/siteConfig";

export const runtime = "nodejs";
export const maxDuration = 300;

// A uuid and nothing else. The id is passed straight to a database function,
// and while that function is parameterised, refusing a malformed id here keeps
// a typo from reaching Postgres as an error the visitor would see raw.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  let documentId;
  try {
    ({ documentId } = await request.json());
  } catch {
    return errorResponse("Malformed request.", 400);
  }

  if (typeof documentId !== "string" || !UUID.test(documentId)) {
    return errorResponse("That is not a document.", 400);
  }

  // A summary costs about what a question costs, so it draws on the same
  // hourly allowance. Metering one and not the other would leave the cheaper
  // door wide open.
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

  const sessionId = await readSessionId();

  let outline;
  try {
    outline = await getOutline(documentId, { sessionId });
  } catch (error) {
    console.error("Outline failed:", error);
    return errorResponse("Could not read that document. Please try again.", 502);
  }

  // Missing, someone else's, and still-indexing all land here with the same
  // message. Telling them apart would confirm to a prober which ids exist.
  if (!outline) {
    return errorResponse(
      "That document is not available. It may have expired, or still be indexing.",
      404
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        if (siteConfig.mode.showCitations) {
          controller.enqueue(
            line({
              type: "sources",
              sources: outline.passages.map((passage, index) => ({
                number: index + 1,
                chunkId: `${documentId}:${passage.chunkId}`,
                title: passage.title,
                authors: passage.authors,
                section: passage.section,
                pageStart: passage.pageStart,
                pageEnd: passage.pageEnd,
                sourceUrl: passage.sourceUrl,
                kind: passage.kind,
                isUpload: passage.isUpload,
                excerpt: passage.content.slice(0, 320),
              })),
            })
          );
        }

        for await (const text of streamSummary({ outline })) {
          controller.enqueue(line({ type: "delta", text }));
        }
      } catch (error) {
        console.error("Summary generation failed:", error);

        const message =
          error.name === "DailyQuotaExhausted"
            ? "This demo's daily allowance for writing is used up. It resets every " +
              "24 hours."
            : "The summary stopped early. Please try again.";

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
      "x-accel-buffering": "no",
    },
  });
}
