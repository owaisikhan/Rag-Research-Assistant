"use client";

import { useEffect, useRef, useState } from "react";

import Icon from "../ui/Icon";
import Spinner from "../ui/Spinner";
import Callout from "../ui/Callout";
import { useToast } from "../ui/Toaster";

/**
 * Upload a PDF, and list what is uploaded.
 *
 * Two shapes, because the same component serves two moments. With nothing
 * uploaded this IS the page -- a drop target the size of the decision it is
 * asking for. Once there is a document it collapses to a compact strip, since
 * from then on the conversation is the point and this is reference.
 *
 * The state that matters is the slow one: indexing takes seconds, because
 * every passage has to be embedded. A control that looks idle during that is a
 * control people click twice.
 */
/**
 * A label that says which pass it is on, not just that something is happening.
 *
 * A long document takes minutes, and an unchanging "indexing…" for three
 * minutes is indistinguishable from a hang.
 */
function indexingLabel(progress) {
  if (!progress) return "Reading and indexing your PDF…";

  const pct = Math.round((progress.done / Math.max(1, progress.total)) * 100);
  const done = `${progress.done} of ${progress.total} passages (${pct}%)`;

  // Saying WHICH wait it is matters. "Indexing…" that does not move for a
  // minute reads as a hang; "waiting for the rate limit" reads as a queue,
  // which is what it is.
  if (progress.waitingMs > 0) {
    const seconds = Math.ceil(progress.waitingMs / 1000);
    return `Indexed ${done} — waiting ${seconds}s for the rate limit…`;
  }

  return `Indexing ${done}…`;
}

export default function UploadPanel({
  documents,
  onChange,
  onSummarise,
  isBusy,
  incomingFile,
  onIncomingHandled,
  usedDocumentIds,
}) {
  const notify = useToast();
  const [isUploading, setIsUploading] = useState(false);
  // What to narrate while a long document is indexed across several passes.
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    onChange();
    // Deliberately once on mount: the parent owns the list from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The composer's attach button picks the file but this component owns
  // uploading, so the file is handed across rather than duplicating the upload
  // logic in two places.
  useEffect(() => {
    if (!incomingFile) return;
    upload(incomingFile);
    onIncomingHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingFile]);

  async function upload(file) {
    if (!file || isUploading) return;

    setError(null);
    setIsUploading(true);

    try {
      const body = new FormData();
      body.append("file", file);

      const response = await fetch("/api/upload", { method: "POST", body });
      const result = await response.json();

      if (!result.ok) {
        setError(result.message ?? "That upload did not work.");
        return;
      }

      // The upload stores the passages and returns; embedding happens in
      // further requests so that every one of them can report progress.
      if (result.indexing) {
        const total = result.document.chunkCount;
        // Shown before the first embedding request even starts, so the count
        // appears immediately rather than after the first pass completes.
        setProgress({ done: 0, total });
        await finishIndexing(result.document.id, total);
      }

      await onChange();
      notify("Document indexed — ask it anything.", { tone: "success" });
    } catch {
      setError("The upload failed. Please try again.");
    } finally {
      setIsUploading(false);
      setProgress(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  /**
   * Drive the remaining passes until the document is searchable.
   *
   * Bounded rather than while(true): a bug that never reduces `remaining`
   * would otherwise hammer a metered API forever. The ceiling is generous
   * enough for the largest document the daily allowance can index at all.
   */
  async function finishIndexing(documentId, total) {
    const MAX_PASSES = 40;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const response = await fetch("/api/upload/continue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentId }),
      });

      const result = await response.json();

      if (!result.ok) {
        setError(result.message ?? "Indexing stopped part-way.");
        return;
      }

      setProgress({
        done: result.embedded ?? 0,
        total: result.total ?? total,
        waitingMs: result.waitMs ?? 0,
      });

      if (!result.indexing) return;

      // The provider's per-minute window is full. The server told us how long
      // rather than holding the request open, so the wait happens here where
      // it can be shown.
      if (result.waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(result.waitMs + 250, 65_000)));
      }
    }

    setError("Indexing is taking longer than expected. Try uploading again to carry on.");
  }

  async function remove(id, title) {
    await fetch("/api/documents", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await onChange();
    notify(`Removed ${title}.`, { tone: "success" });
  }

  const hasDocuments = documents.length > 0;

  return (
    <section>
      <input
        ref={inputRef}
        id="pdf-upload"
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        onChange={(event) => upload(event.target.files?.[0])}
      />

      {!hasDocuments && (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            upload(event.dataTransfer.files?.[0]);
          }}
          className={`rounded-xl border border-dashed px-6 py-16 text-center transition-colors ${
            isDragging ? "border-primary bg-primary-soft" : "border-border-strong"
          }`}
        >
          {isUploading ? (
            <Spinner label={indexingLabel(progress)} />
          ) : (
            <>
              <label
                htmlFor="pdf-upload"
                className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
              >
                <Icon name="paperclip" className="h-4 w-4" />
                Choose a PDF
              </label>
              <p className="mt-3 text-sm text-ink-muted">
                or drop one here
              </p>
              <p className="mx-auto mt-4 max-w-sm text-xs text-ink-faint">
                Answers are built only from passages retrieved out of your own
                document. Nothing is shared: your uploads are visible only to
                you and are deleted after 24 hours.
              </p>
            </>
          )}
        </div>
      )}

      {error && (
        <div className="mt-3">
          <Callout tone="danger">{error}</Callout>
        </div>
      )}

      {hasDocuments && (
        <>
          <h2 className="mb-2 text-[0.7rem] font-semibold uppercase tracking-wide text-ink-faint">
            Uploaded documents
          </h2>

          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
            {documents.map((document) => {
              const wasUsed = usedDocumentIds?.has(document.id);

              return (
                <li
                  key={document.id}
                  className={`bg-surface-raised px-3.5 py-3 ${
                    wasUsed ? "border-l-2 border-l-primary" : ""
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <Icon name="file" className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-ink" title={document.title}>
                        {document.title}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-faint">
                        {document.pageCount} pages · {document.chunkCount} passages
                      </p>

                      {/* Listed, but honest about not being usable yet. It
                          holds one of the three slots either way, so hiding it
                          only made the limit message look like a lie. */}
                      {document.isComplete === false && (
                        <p className="mt-1.5 inline-block rounded bg-surface-sunken px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-ink-muted">
                          Not indexed — {document.embedded ?? 0} of {document.chunkCount} done
                        </p>
                      )}

                      {/* A word, not just the accent stripe: which document an
                          answer came from must not be something a reader has to
                          infer from a hue. */}
                      {wasUsed && (
                        <p className="mt-1.5 inline-block rounded bg-primary-soft px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-primary">
                          Used in this answer
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="mt-2 flex items-center gap-1">
                    {/* Summarising is the one thing here that is not a
                        question, so it gets its own control rather than a
                        suggested prompt the visitor has to think to type. */}
                    <button
                      type="button"
                      onClick={() => onSummarise?.(document)}
                      disabled={isBusy || document.isComplete === false}
                      className="rounded-lg px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary-soft disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Summarise
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(document.id, document.title)}
                      className="ml-auto rounded-lg px-2 py-1 text-xs text-ink-faint transition-colors hover:bg-danger-soft hover:text-danger"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}

            {isUploading ? (
              <li className="bg-surface-raised px-3.5 py-3">
                <Spinner label={indexingLabel(progress)} />
              </li>
            ) : (
              <li className="bg-surface-raised px-3.5 py-2">
                <label
                  htmlFor="pdf-upload"
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-ink-muted transition-colors hover:bg-primary-soft hover:text-primary"
                >
                  <Icon name="plus" className="h-3.5 w-3.5" />
                  Add another
                </label>
              </li>
            )}
          </ul>
        </>
      )}
    </section>
  );
}
