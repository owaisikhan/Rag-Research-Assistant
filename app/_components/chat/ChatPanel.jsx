"use client";

import { useRef, useState, useEffect } from "react";

import AnswerText from "./AnswerText";
import SourceCard from "./SourceCard";
import UploadPanel from "./UploadPanel";
import Composer from "./Composer";
import OptionsMenu from "./OptionsMenu";
import Icon from "../ui/Icon";
import { useToast } from "../ui/Toaster";
import { siteConfig } from "@/app/_lib/siteConfig";
import Spinner from "../ui/Spinner";
import Callout from "../ui/Callout";

const STARTERS = [
  "What is this document about?",
  "What are the key points?",
  "Is there anything here I should be careful about?",
  "What does it say about dates and deadlines?",
];

/**
 * Read the NDJSON stream from /api/chat and /api/summarize.
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
  const notify = useToast();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState(null);
  const [activeCitation, setActiveCitation] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [pendingFile, setPendingFile] = useState(null);

  const endRef = useRef(null);
  const inputRef = useRef(null);

  async function refreshDocuments() {
    try {
      const response = await fetch("/api/documents");
      const body = await response.json();
      setDocuments(body.documents ?? []);
    } catch {
      // A failed listing is not worth interrupting the conversation for.
    }
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isStreaming]);

  /**
   * Drive one assistant turn from an NDJSON endpoint.
   *
   * /api/chat and /api/summarize speak the same wire format, so the only
   * things that differ are the URL, the body, and what the user's own turn
   * says. One reader means a fix to stream handling cannot land on one path
   * and miss the other.
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

    if (documents.length === 0) {
      notify("Upload a PDF first — answers come only from your own documents.");
      return;
    }

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

  function clearChat() {
    if (messages.length === 0) {
      notify("The conversation is already empty.");
      return;
    }
    setMessages([]);
    setError(null);
    setActiveCitation(null);
    notify("Conversation cleared.", { tone: "success" });
  }

  async function copyAnswer(text) {
    try {
      await navigator.clipboard.writeText(text);
      notify("Answer copied.", { tone: "success" });
    } catch {
      notify("This browser would not allow copying.", { tone: "danger" });
    }
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const visibleSources = lastAssistant?.sources ?? [];
  const isEmpty = messages.length === 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      {/* ---------------------------------------------------- conversation */}
      <div className="flex min-w-0 flex-col self-start">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">
              {siteConfig.name}
            </h1>
            <p className="mt-1 text-sm text-ink-muted">{siteConfig.tagline}</p>
          </div>
          <OptionsMenu messages={messages} onClear={clearChat} />
        </div>

        <div className="flex-1 space-y-5">
          {isEmpty && (
            <div className="relative flex flex-col items-center justify-center py-10 text-center sm:py-16">
              {/* The orb. Pure decoration, and the reason the empty state
                  reads as a product waiting rather than a page missing its
                  content. */}
              <div className="idle-orb pointer-events-none absolute h-56 w-56 rounded-full" />

              <div className="relative">
                <p className="text-base font-medium text-ink">
                  {documents.length === 0
                    ? "Upload a PDF to get started"
                    : `Ask anything about your ${documents.length === 1 ? "document" : "documents"}`}
                </p>
                <p className="mx-auto mt-2 max-w-md text-sm text-ink-muted">
                  {documents.length === 0
                    ? "Every answer is built only from passages retrieved out of your own document — never from outside it."
                    : `Answers come only from what is in ${documents.length === 1 ? "it" : "them"}, so you can check every claim.`}
                </p>
              </div>
            </div>
          )}

          {messages.map((message, index) =>
            message.role === "user" ? (
              <div key={index} className="flex justify-end">
                <p className="brand-gradient max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm text-white shadow-md">
                  {message.content}
                </p>
              </div>
            ) : (
              <div key={index} className="group max-w-none">
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

                    {/* Appears on hover, as the reference does. Copy is real;
                        it is the one message action worth having. */}
                    {message.content !== "" && (
                      <div className="mt-2 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        <button
                          type="button"
                          onClick={() => copyAnswer(message.content)}
                          className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-ink-faint transition-colors hover:bg-primary-soft hover:text-primary"
                        >
                          <Icon name="copy" className="h-3.5 w-3.5" />
                          Copy
                        </button>
                      </div>
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
        <div className="sticky bottom-0 mt-6 bg-surface pt-3">
          <Composer
            value={input}
            onChange={setInput}
            onSubmit={() => ask(input)}
            onAttach={(file) => setPendingFile(file)}
            disabled={documents.length === 0}
            isStreaming={isStreaming}
            inputRef={inputRef}
            placeholder={
              documents.length === 0
                ? "Upload a PDF first…"
                : "Ask anything about your documents…"
            }
          />

          {isEmpty && documents.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-center text-xs text-ink-faint">Try asking</p>
              <div className="flex flex-wrap justify-center gap-2">
                {STARTERS.map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    onClick={() => ask(starter)}
                    className="rounded-full border border-border bg-surface-raised px-3.5 py-1.5 text-xs text-ink-muted transition-colors hover:border-primary hover:text-primary"
                  >
                    {starter}
                  </button>
                ))}
              </div>
            </div>
          )}

          <p className="mt-3 text-center text-xs text-ink-faint">
            Click + to attach a PDF · Hover an answer to copy it · Uploads are
            deleted after 24 hours
          </p>
        </div>
      </div>

      {/* --------------------------------------------------------- sources */}
      <aside className="lg:sticky lg:top-6 lg:self-start">
        <UploadPanel
          documents={documents}
          onChange={refreshDocuments}
          onSummarise={summarise}
          isBusy={isStreaming}
          incomingFile={pendingFile}
          onIncomingHandled={() => setPendingFile(null)}
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
