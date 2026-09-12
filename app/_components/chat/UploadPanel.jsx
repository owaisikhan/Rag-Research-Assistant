"use client";

import { useEffect, useRef, useState } from "react";

import Icon from "../ui/Icon";
import Spinner from "../ui/Spinner";
import Callout from "../ui/Callout";
import { useToast } from "../ui/Toaster";

/**
 * Upload a PDF and see it become searchable.
 *
 * The state that matters here is the slow one: indexing a PDF takes seconds,
 * not milliseconds, because every passage has to be embedded. A control that
 * looks idle during that is a control people click twice, so the drop zone is
 * replaced by a narrated spinner while it works.
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

  // The composer's + button picks the file but this component owns uploading,
  // so the file is handed across rather than duplicating the upload logic in
  // two places.
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
        className={`mt-3 rounded-xl border border-dashed p-4 text-center transition-colors ${
          isDragging
            ? "border-primary bg-primary-soft"
            : "border-border-strong bg-surface-raised"
        }`}
      >
        {isUploading ? (
          <Spinner label="Reading and indexing your PDF…" />
        ) : (
          <>
            <span className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-xl bg-primary-soft text-primary">
              <Icon name="file" className="h-4.5 w-4.5" />
            </span>
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
              or drop one here — up to 10 MB
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
              className="rounded-xl border border-border bg-surface-raised p-3"
            >
              <p className="truncate text-sm font-medium text-ink" title={document.title}>
                {document.title}
              </p>
              <p className="mt-0.5 text-xs text-ink-faint">
                {document.pageCount} pages · {document.chunkCount} passages
              </p>

              <div className="mt-2 flex items-center gap-1">
                {/*
                  Summarising is the one thing here that is not a question, so
                  it gets its own control rather than a suggested prompt the
                  visitor has to think to type.
                */}
                <button
                  type="button"
                  onClick={() => onSummarise?.(document)}
                  disabled={isBusy}
                  className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary-soft disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Icon name="sparkle" className="h-3.5 w-3.5" />
                  Summarise
                </button>
                <button
                  type="button"
                  onClick={() => remove(document.id, document.title)}
                  className="ml-auto flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-ink-faint transition-colors hover:bg-danger-soft hover:text-danger"
                >
                  <Icon name="trash" className="h-3.5 w-3.5" />
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
