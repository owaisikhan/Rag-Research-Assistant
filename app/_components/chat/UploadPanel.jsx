"use client";

import { useEffect, useRef, useState } from "react";

import Spinner from "../ui/Spinner";
import Callout from "../ui/Callout";

/**
 * Upload a PDF and see it become searchable.
 *
 * The state that matters here is the slow one: indexing a PDF takes seconds,
 * not milliseconds, because every passage has to be embedded. A control that
 * looks idle during that is a control people click twice, so the button is
 * disabled and narrates what it is doing.
 */
export default function UploadPanel({ documents, onChange, onSummarise, isBusy }) {
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    onChange();
    // Deliberately once on mount: the parent owns the list from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function upload(file) {
    if (!file || isUploading) return;

    setError(null);
    setIsUploading(true);

    try {
      const body = new FormData();
      body.append("file", file);

      const response = await fetch("/api/upload", { method: "POST", body });
      const result = await response.json();

      if (!result.ok) setError(result.message ?? "That upload did not work.");
      else await onChange();
    } catch {
      setError("The upload failed. Please try again.");
    } finally {
      setIsUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove(id) {
    await fetch("/api/documents", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await onChange();
  }

  return (
    <section className="mb-6">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Your documents
      </h2>

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
        className={`mt-3 rounded-lg border border-dashed p-4 text-center transition-colors ${
          isDragging ? "border-primary bg-primary-soft" : "border-border-strong bg-surface-raised"
        }`}
      >
        {isUploading ? (
          <Spinner label="Reading and indexing your PDF…" />
        ) : (
          <>
            <input
              ref={inputRef}
              id="pdf-upload"
              type="file"
              accept="application/pdf,.pdf"
              className="sr-only"
              onChange={(event) => upload(event.target.files?.[0])}
            />
            <label
              htmlFor="pdf-upload"
              className="cursor-pointer text-sm font-medium text-primary hover:underline"
            >
              Choose a PDF
            </label>
            <p className="mt-1 text-xs text-ink-faint">
              or drop one here — up to 10 MB. Short documents index fastest;
              anything too long to index is refused straight away rather than
              left to time out.
            </p>
          </>
        )}
      </div>

      {error && (
        <div className="mt-3">
          <Callout tone="danger">{error}</Callout>
        </div>
      )}

      {documents.length > 0 && (
        <ul className="mt-3 space-y-2">
          {documents.map((document) => (
            <li
              key={document.id}
              className="flex items-start gap-2 rounded-lg border border-border bg-surface-raised p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink" title={document.title}>
                  {document.title}
                </p>
                <p className="mt-0.5 text-xs text-ink-faint">
                  {document.pageCount} pages · {document.chunkCount} passages · removed after 24h
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                {/*
                  Summarising is the one thing here that is not a question, so
                  it gets its own control rather than a suggested prompt the
                  visitor has to think to type.
                */}
                <button
                  type="button"
                  onClick={() => onSummarise?.(document)}
                  disabled={isBusy}
                  aria-label={`Summarise ${document.title}`}
                  className="rounded px-1.5 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-primary-soft disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Summarise
                </button>
                <button
                  type="button"
                  onClick={() => remove(document.id)}
                  aria-label={`Remove ${document.title}`}
                  className="rounded px-1.5 py-0.5 text-xs text-ink-faint transition-colors hover:bg-danger-soft hover:text-danger"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {documents.length === 0 && !isUploading && (
        <p className="mt-3 text-xs text-ink-faint">
          Nothing is shared. Your uploads are visible only to you and are
          deleted automatically after 24 hours.
        </p>
      )}
    </section>
  );
}
