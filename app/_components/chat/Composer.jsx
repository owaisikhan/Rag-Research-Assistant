"use client";

import { useRef } from "react";

import Icon from "../ui/Icon";

/**
 * The composer.
 *
 * Two controls, both of which do something: attach a PDF, and send.
 *
 * There were four more -- web search, improve-question, output format, voice --
 * copied from the reference design and wired to a "coming soon" message. They
 * are gone. A row of icons for features that do not exist is the visual
 * equivalent of a stock photo: it fills the space and tells the viewer nothing
 * true. Worse, in a demo the first thing anyone does is click them, and
 * discovering four dead ends in a row costs more trust than an empty toolbar
 * ever would.
 */
export default function Composer({
  value,
  onChange,
  onSubmit,
  onAttach,
  disabled,
  isStreaming,
  placeholder,
  inputRef,
}) {
  const fileRef = useRef(null);

  const hasText = value.trim() !== "";

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="composer-ring rounded-xl bg-surface-raised p-3 transition-shadow"
    >
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onAttach(file);
          event.target.value = "";
        }}
      />

      <label htmlFor="question" className="sr-only">
        Your question
      </label>
      <textarea
        id="question"
        ref={inputRef}
        rows={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends, Shift+Enter breaks the line -- the convention every
          // chat interface has trained people to expect.
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        className="max-h-44 min-h-10 w-full resize-none bg-transparent px-1 py-1 text-[0.95rem] text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
      />

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-ink-muted transition-colors hover:bg-primary-soft hover:text-primary"
        >
          <Icon name="paperclip" className="h-4 w-4" />
          Attach PDF
        </button>

        <button
          type="submit"
          disabled={isStreaming || !hasText || disabled}
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-35"
        >
          {isStreaming ? "Answering…" : "Ask"}
          {!isStreaming && <Icon name="arrowUp" className="h-3.5 w-3.5" strokeWidth={2.2} />}
        </button>
      </div>
    </form>
  );
}
