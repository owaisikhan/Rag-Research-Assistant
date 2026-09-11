"use client";

import { useRef, useState, useEffect } from "react";

import AnswerText from "./AnswerText";
import SourceCard from "./SourceCard";
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

  const endRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isStreaming]);

  async function ask(question) {
    const trimmed = question.trim();
    if (trimmed === "" || isStreaming) return;

    setError(null);
    setActiveCitation(null);
    setInput("");
    setIsStreaming(true);

    // Only completed turns go back as history -- the turn being written is
    // not part of the conversation yet.
    const history = messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    setMessages((current) => [
      ...current,
      { role: "user", content: trimmed },
      { role: "assistant", content: "", sources: [] },
    ]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: trimmed, history }),
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

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const visibleSources = lastAssistant?.sources ?? [];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      {/* ---------------------------------------------------- conversation */}
      <div className="flex min-w-0 flex-col">
        <div className="flex-1 space-y-5">
          {messages.length === 0 && (
            <div className="rounded-xl border border-border bg-surface-raised p-5">
              <p className="text-sm text-ink-muted">
                Ask anything about the library. Every answer is built only from
                passages retrieved out of the documents, and every claim is
                numbered so you can check it.
              </p>
              <ul className="mt-4 space-y-2">
                {SUGGESTIONS.map((suggestion) => (
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
                  <Spinner label="Searching the library" />
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
              placeholder="Ask a question about the library…"
              disabled={isStreaming}
              className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={isStreaming || input.trim() === ""}
              className="rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isStreaming ? "…" : "Ask"}
            </button>
          </div>
        </form>
      </div>

      {/* --------------------------------------------------------- sources */}
      <aside className="lg:sticky lg:top-6 lg:self-start">
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
      </aside>
    </div>
  );
}
