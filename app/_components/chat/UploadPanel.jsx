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
export default function UploadPanel({
  documents,
  onChange,
  onSummarise,
  isBusy,
  incomingFile,
  onIncomingHandled,
}) {
  const notify = useToast();
  const [isUploading, setIsUploading] = useState(false);
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
      } else {
        await onChange();
        notify("Document indexed — ask it anything.", { tone: "success" });
      }
    } catch {
      setError("The upload failed. Please try again.");
    } finally {
      setIsUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
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
            <Spinner label="Reading and indexing your PDF…" />
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
                or drop one here — up to 10 MB
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
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {documents.map((document) => (
            <li
              key={document.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-surface-raised px-3.5 py-3"
            >
              <Icon name="file" className="h-4 w-4 shrink-0 text-ink-faint" />

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink" title={document.title}>
                  {document.title}
                </p>
                <p className="mt-0.5 text-xs text-ink-faint">
                  {document.pageCount} pages · {document.chunkCount} passages ·
                  deleted after 24h
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                {/* Summarising is the one thing here that is not a question,
                    so it gets its own control rather than a suggested prompt
                    the visitor has to think to type. */}
                <button
                  type="button"
                  onClick={() => onSummarise?.(document)}
                  disabled={isBusy}
                  className="rounded-lg px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary-soft disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Summarise
                </button>
                <button
                  type="button"
                  onClick={() => remove(document.id, document.title)}
                  className="rounded-lg px-2 py-1 text-xs text-ink-faint transition-colors hover:bg-danger-soft hover:text-danger"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}

          {isUploading ? (
            <li className="bg-surface-raised px-3.5 py-3">
              <Spinner label="Reading and indexing your PDF…" />
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
      )}
    </section>
  );
}
