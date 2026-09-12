"use client";

import { useRef, useState, useEffect } from "react";

import AnswerText from "./AnswerText";
import SourceCard from "./SourceCard";
import UploadPanel from "./UploadPanel";
import { siteConfig } from "@/app/_lib/siteConfig";
import Spinner from "../ui/Spinner";
import Callout from "../ui/Callout";

const SUGGESTIONS = [
  "What approaches do these papers take to detecting malicious network traffic?",
  "Summarise what the library says about zero trust architecture.",
  "Where do these documents disagree with each other?",
];

/**
 * Read the NDJSON stream from /api/chat.
 *
 * Chunks do not arrive on line boundaries, so a partial line is carried over
 * to the next read. Parsing each chunk independently loses whatever straddled
 * the boundary -- which shows up as answers missing occasional fragments, and
 * is maddening to debug after the fact.
 */
async function* readNdjson(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        yield JSON.parse(line);
      } catch {
        // A truncated line means the connection died mid-write; the stream
        // ending will surface it.
      }
    }
  }

  if (buffer.trim() !== "") {
    try {
      yield JSON.parse(buffer);
    } catch {
      /* ignore a trailing partial line */
    }
  }
}

export default function ChatPanel() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState(null);
  const [activeCitation, setActiveCitation] = useState(null);
  const [documents, setDocuments] = useState([]);

  // The parent owns the uploaded-document list so the suggestions can change
  // once a visitor has their own document in play.
  async function refreshDocuments() {
    try {
      const response = await fetch("/api/documents");
      const body = await response.json();
      setDocuments(body.documents ?? []);
    } catch {
      // A failed listing is not worth interrupting the conversation for.
    }
  }

  const endRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isStreaming]);

  /**
   * Drive one assistant turn from an NDJSON endpoint.
   *
   * /api/chat and /api/summarize speak the same wire format, so the only
   * things that differ are the URL, the body, and what the user's own turn
   * says. Keeping one reader means a fix to stream handling cannot land on
   * one path and miss the other.
   */
  async function run({ url, body, userText, waiting }) {
    if (isStreaming) return;

    setError(null);
    setActiveCitation(null);
    setIsStreaming(true);

    setMessages((current) => [
      ...current,
      { role: "user", content: userText },
      { role: "assistant", content: "", sources: [], waiting },
    ]);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      for await (const event of readNdjson(response)) {
        if (event.type === "sources") {
          setMessages((current) => {
            const next = [...current];
            next[next.length - 1] = { ...next[next.length - 1], sources: event.sources };
            return next;
          });
        } else if (event.type === "delta") {
          setMessages((current) => {
            const next = [...current];
            const last = next[next.length - 1];
            next[next.length - 1] = { ...last, content: last.content + event.text };
            return next;
          });
        } else if (event.type === "error") {
          setError(event.message);
        }
      }
    } catch {
      setError("The connection dropped. Please try again.");
    } finally {
      setIsStreaming(false);
      inputRef.current?.focus();
    }
  }

  async function ask(question) {
    const trimmed = question.trim();
    if (trimmed === "" || isStreaming) return;

    setInput("");

    // Only completed turns go back as history -- the turn being written is
    // not part of the conversation yet.
    const history = messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    await run({
      url: "/api/chat",
      body: { question: trimmed, history },
      userText: trimmed,
      waiting: "Searching your documents",
    });
  }

  /**
   * Summarise a whole document.
   *
   * No history is sent, and none is needed: the summary is of the document,
   * not of the conversation. It still appears as an ordinary turn so a
   * follow-up question can refer back to it.
   */
  async function summarise(document) {
    await run({
      url: "/api/summarize",
      body: { documentId: document.id },
      userText: `Summarise ${document.title}`,
      waiting: "Reading the whole document",
    });
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const visibleSources = lastAssistant?.sources ?? [];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      {/* ---------------------------------------------------- conversation */}
      {/*
        self-start matters. Without it the grid stretches this column to match
        the sources column, which is routinely taller, and flex-1 then pushes
        the composer to the bottom of that stretched height -- leaving a few
        hundred pixels of blank space between the end of the answer and the
        input box. Sizing to content keeps the composer under the conversation,
        and sticky still pins it once the answer is taller than the viewport.
      */}
      <div className="flex min-w-0 flex-col self-start">
        <div className="flex-1 space-y-5">
          {messages.length === 0 && (
            <div className="rounded-xl border border-border bg-surface-raised p-5">
              {documents.length === 0 ? (
                <>
                  <p className="text-sm text-ink">
                    Upload a PDF to get started.
                  </p>
                  <p className="mt-1.5 text-sm text-ink-muted">
                    Ask anything about it and the answer will be built only from
                    what is actually in your document — never from outside it.
                    Nothing is stored beyond 24 hours, and only you can see what
                    you upload.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm text-ink-muted">
                    Ask anything about your {documents.length === 1 ? "document" : "documents"}.
                    Answers come only from what is in them.
                  </p>
                  <ul className="mt-4 space-y-2">
                    {[
                      `What is ${documents[0].title} about?`,
                      "What are the key points?",
                      "Is there anything here I should be careful about?",
                    ].map((suggestion) => (
                      <li key={suggestion}>
                        <button
                          type="button"
                          onClick={() => ask(suggestion)}
                          className="w-full rounded-lg border border-border px-3 py-2 text-left text-sm text-ink transition-colors hover:border-primary hover:bg-primary-soft"
                        >
                          {suggestion}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {messages.map((message, index) =>
            message.role === "user" ? (
              <div key={index} className="flex justify-end">
                <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm text-white">
                  {message.content}
                </p>
              </div>
            ) : (
              <div key={index} className="max-w-none">
                {message.content === "" && isStreaming ? (
                  <Spinner label={message.waiting ?? "Working"} />
                ) : (
                  <>
                    <AnswerText
                      text={message.content}
                      sources={message.sources ?? []}
                      onCite={setActiveCitation}
                      activeNumber={activeCitation}
                    />
                    {isStreaming && index === messages.length - 1 && (
                      <span className="streaming-caret" aria-hidden="true" />
                    )}
                  </>
                )}
              </div>
            )
          )}

          {error && <Callout tone="danger">{error}</Callout>}
          <div ref={endRef} />
        </div>

        {/* ------------------------------------------------------- composer */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            ask(input);
          }}
          className="sticky bottom-0 mt-6 bg-surface pt-3"
        >
          <div className="flex items-end gap-2 rounded-xl border border-border bg-surface-raised p-2 focus-within:border-primary">
            <label htmlFor="question" className="sr-only">
              Your question
            </label>
            <textarea
              id="question"
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends, Shift+Enter breaks the line -- the convention
                // every chat interface has trained people to expect.
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  ask(input);
                }
              }}
              placeholder={documents.length === 0 ? "Upload a PDF first…" : "Ask a question about your documents…"}
              disabled={isStreaming || documents.length === 0}
              className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={isStreaming || input.trim() === "" || documents.length === 0}
              className="rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isStreaming ? "…" : "Ask"}
            </button>
          </div>
        </form>
      </div>

      {/* --------------------------------------------------------- sources */}
      <aside className="lg:sticky lg:top-6 lg:self-start">
        <UploadPanel
          documents={documents}
          onChange={refreshDocuments}
          onSummarise={summarise}
          isBusy={isStreaming}
        />

        {siteConfig.mode.showCitations && (
          <>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Sources
              {visibleSources.length > 0 && (
                <span className="ml-1.5 font-normal normal-case tracking-normal">
                  ({visibleSources.length} passages)
                </span>
              )}
            </h2>

            {visibleSources.length === 0 ? (
              <p className="mt-3 text-sm text-ink-faint">
                The passages behind each answer appear here, with page numbers.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {visibleSources.map((source) => (
                  <SourceCard
                    key={source.chunkId}
                    source={source}
                    isActive={activeCitation === source.number}
                    onSelect={(number) =>
                      setActiveCitation((current) => (current === number ? null : number))
                    }
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
