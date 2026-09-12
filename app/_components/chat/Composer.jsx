"use client";

import { useRef } from "react";

import Icon from "../ui/Icon";
import { useToast } from "../ui/Toaster";

/**
 * The composer.
 *
 * The toolbar mixes real controls and placeholders, and the distinction is
 * deliberate rather than accidental:
 *
 *   +        REAL -- opens the PDF picker. The attach affordance the reference
 *                    design has is exactly the thing this product does.
 *   globe    placeholder -- searching the web alongside the documents
 *   wand     placeholder -- rewriting a vague question into a better one
 *   code     placeholder -- asking for output as a table or JSON
 *   mic      placeholder -- voice input
 *   send     REAL
 *
 * The mic becomes send the moment there is text, which is the behaviour the
 * reference has and the reason the right-hand control is one button rather
 * than two.
 */
const TOOLS = [
  { id: "attach", icon: "plus", label: "Attach a PDF" },
  { id: "web", icon: "globe", label: "Search the web" },
  { id: "improve", icon: "wand", label: "Improve this question" },
  { id: "format", icon: "code", label: "Output format" },
];

/** What each placeholder tool will eventually do, said out loud when clicked. */
const SOON = {
  web: "Web search — answer from your documents and the open web together.",
  improve: "Improve question — rewrite a vague question into a sharper one before searching.",
  format: "Output format — ask for the answer as a table, list or JSON.",
};

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
  const notify = useToast();
  const fileRef = useRef(null);

  const hasText = value.trim() !== "";

  function handleTool(id) {
    if (id === "attach") fileRef.current?.click();
    else notify(SOON[id]);
  }


  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="composer-glow rounded-2xl bg-surface-raised p-3 transition-shadow"
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
        className="max-h-44 min-h-10 w-full resize-none bg-transparent px-1.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
      />

      <div className="mt-1 flex items-center gap-1">
        {TOOLS.map((tool, index) => (
          <span key={tool.id} className="flex items-center">
            <button
              type="button"
              onClick={() => handleTool(tool.id)}
              title={tool.label}
              aria-label={tool.label}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-primary-soft hover:text-primary"
            >
              <Icon name={tool.icon} className="h-4.5 w-4.5" />
            </button>
            {/* A hairline after the attach button, which is the one that does
                something to the conversation rather than to the question. */}
            {index === 0 && <span className="mx-1 h-5 w-px bg-border" />}
          </span>
        ))}

        <button
          type={hasText ? "submit" : "button"}
          onClick={
            hasText
              ? undefined
              : () => notify("Voice input — dictate a question instead of typing it.")
          }
          disabled={isStreaming || (hasText && disabled)}
          aria-label={hasText ? "Send" : "Voice input"}
          className={`ml-auto flex h-10 w-10 items-center justify-center rounded-full transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
            hasText
              ? "brand-gradient text-white shadow-lg"
              : "border border-border bg-surface-sunken text-ink-muted hover:text-ink"
          }`}
        >
          <Icon name={hasText ? "send" : "mic"} className="h-4.5 w-4.5" />
        </button>
      </div>
    </form>
  );
}
