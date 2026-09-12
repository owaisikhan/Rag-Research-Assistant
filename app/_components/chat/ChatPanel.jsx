"use client";

import { useRef, useState, useEffect } from "react";

import AnswerText from "./AnswerText";
import AnswerSources from "./AnswerSources";
import UploadPanel from "./UploadPanel";
import Composer from "./Composer";
import OptionsMenu from "./OptionsMenu";
import ThemeToggle from "../shell/ThemeToggle";
import Icon from "../ui/Icon";
import { parseUsed, stripUsed } from "@/app/_lib/rag/used-trailer";
import { useToast } from "../ui/Toaster";
import { siteConfig } from "@/app/_lib/siteConfig";
import Spinner from "../ui/Spinner";
import Callout from "../ui/Callout";

const STARTERS = [
  "What is this document about?",
  "What are the key points?",
  "Anything here I should be careful about?",
];

/**
 * The document ids a finished answer named, or null if it named none.
 */
function documentsUsedBy(message) {
  if (!message || message.content === "") return null;

  const used = parseUsed(message.content);
  if (used === null) return null;

  const byNumber = new Map((message.sources ?? []).map((source) => [source.number, source]));

  return new Set(
    used
      .map((number) => byNumber.get(number)?.documentId)
      .filter(Boolean)
  );
}

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
  /**
   * Attach a failure to the turn it belongs to.
   *
   * A page-level error banner was wrong twice over: two failed questions left
   * two blank assistant turns in the transcript with no sign of what happened
   * to them, and the banner only ever showed the most recent message, so the
   * earlier failure vanished entirely. The failure belongs to the turn.
   */
  function failTurn(message) {
    setMessages((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (last?.role !== "assistant") return current;
      next[next.length - 1] = { ...last, error: message };
      return next;
    });
  }

  async function run({ url, body, userText, waiting }) {
    if (isStreaming) return;

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
          failTurn(event.message);
        }
      }
    } catch {
      failTurn("The connection dropped. Please try again.");
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
  const hasDocuments = documents.length > 0;
  const isEmpty = messages.length === 0;

  // Which documents the newest answer actually drew on -- the question "but
  // which one said that?" is the first anybody asks once more than one
  // document is in play.
  //
  // From what the MODEL said it used, not from what retrieval returned. Those
  // differ constantly: ask what one customer owes and a second customer's
  // near-identical statement is fetched too, ignored, and would otherwise be
  // credited under the answer. null means the model did not say, and nothing
  // is marked -- an unknown must not be dressed up as an answer.
  const usedDocumentIds = documentsUsedBy(lastAssistant);

  const header = (
    <header className="mb-8 flex items-start justify-between gap-4">
      {/* The wordmark. Serif, against a sans interface: the contrast is what
          makes it read as a NAME rather than as the page's first heading. A
          folio is a leaf of a book, so the reference is to type rather than to
          software, which is also the point of the whole palette. */}
      <div>
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-on-primary">
            <Icon name="book" className="h-[1.15rem] w-[1.15rem]" strokeWidth={1.9} />
          </span>
          <h1 className="font-serif text-[2rem] font-semibold leading-none tracking-[-0.02em] text-ink">
            {siteConfig.name}
          </h1>
        </div>
        <p className="mt-2.5 text-sm text-ink-muted">{siteConfig.tagline}</p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <ThemeToggle />
        <OptionsMenu messages={messages} onClear={clearChat} />
      </div>
    </header>
  );

  const uploads = (
    <UploadPanel
      documents={documents}
      onChange={refreshDocuments}
      onSummarise={summarise}
      isBusy={isStreaming}
      incomingFile={pendingFile}
      onIncomingHandled={() => setPendingFile(null)}
      usedDocumentIds={usedDocumentIds}
    />
  );

  // Nothing uploaded: the drop zone is the whole page, centred in what is left
  // of the viewport under the header rather than sitting just below it.
  if (!hasDocuments) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">
        {header}
        <div className="flex flex-1 items-center justify-center py-8">
          <div className="w-full">{uploads}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl">
      {header}

      <div className="grid gap-8 lg:grid-cols-[17rem_minmax(0,1fr)]">
        {/* Documents on the left, so the thing being asked about sits beside
            the asking rather than under it. */}
        <aside className="lg:sticky lg:top-6 lg:self-start">{uploads}</aside>

        <div className="flex min-w-0 flex-col">
          <div className="flex-1 space-y-5">
            {isEmpty && (
              <p className="text-sm text-ink-muted">
                Ask anything about your{" "}
                {documents.length === 1 ? "document" : "documents"}. Answers come
                only from what is in {documents.length === 1 ? "it" : "them"}.
              </p>
            )}

            {messages.map((message, index) =>
              message.role === "user" ? (
                <div key={index} className="flex justify-end">
                  <p className="max-w-[85%] rounded-xl rounded-br-sm border border-border bg-surface-raised px-3.5 py-2 text-sm text-ink">
                    {message.content}
                  </p>
                </div>
              ) : (
                <div key={index} className="group max-w-none">
                  {message.content === "" && isStreaming ? (
                    <Spinner label={message.waiting ?? "Working"} />
                  ) : message.content === "" && message.error ? (
                    <Callout tone="danger">{message.error}</Callout>
                  ) : (
                    <>
                      <AnswerText
                        text={stripUsed(message.content)}
                        sources={message.sources ?? []}
                        onCite={setActiveCitation}
                        activeNumber={activeCitation}
                      />
                      {isStreaming && index === messages.length - 1 && (
                        <span className="streaming-caret" aria-hidden="true" />
                      )}

                      {/* A partial answer that then failed: the text is kept,
                          and the reason it stops is said underneath it. */}
                      {message.error && message.content !== "" && (
                        <div className="mt-3">
                          <Callout tone="danger">{message.error}</Callout>
                        </div>
                      )}

                      {message.content !== "" && (
                        <>
                          <AnswerSources
                            sources={message.sources}
                            used={parseUsed(message.content)}
                          />

                          <div className="mt-2 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                            <button
                              type="button"
                              onClick={() => copyAnswer(stripUsed(message.content))}
                              className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-ink-faint transition-colors hover:bg-primary-soft hover:text-primary"
                            >
                              <Icon name="copy" className="h-3.5 w-3.5" />
                              Copy
                            </button>
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>
              )
            )}

            <div ref={endRef} />
          </div>

          <div className="sticky bottom-0 mt-6 bg-surface pb-4 pt-3">
            <Composer
              value={input}
              onChange={setInput}
              onSubmit={() => ask(input)}
              onAttach={(file) => setPendingFile(file)}
              disabled={false}
              isStreaming={isStreaming}
              inputRef={inputRef}
              placeholder="Ask a question about your documents…"
            />

            {isEmpty && (
              <div className="mt-3 flex flex-wrap gap-2">
                {STARTERS.map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    onClick={() => ask(starter)}
                    className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
                  >
                    {starter}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
