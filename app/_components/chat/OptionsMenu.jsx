"use client";

import { useEffect, useRef, useState } from "react";

import Icon from "../ui/Icon";
import { stripUsed } from "@/app/_lib/rag/used-trailer";
import { useToast } from "../ui/Toaster";

/**
 * The Fullscreen / Options pair above the conversation.
 *
 * Fullscreen, Export and Clear are real. Share is a placeholder: a shareable
 * link means storing a conversation server-side under a public id, which is a
 * privacy decision about documents the visitor was promised were private --
 * not something to bolt on for a demo.
 */
export default function OptionsMenu({ messages, onClear }) {
  const notify = useToast();
  const [open, setOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const menuRef = useRef(null);

  // A menu that does not close on an outside click is the single most common
  // way a dropdown feels broken.
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event) {
      if (!menuRef.current?.contains(event.target)) setOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    function onChange() {
      setIsFullscreen(Boolean(document.fullscreenElement));
    }
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      // Denied by the browser, or unsupported (iOS Safari). Nothing to fix.
      notify("This browser would not allow fullscreen.", { tone: "danger" });
    }
  }

  function exportChat() {
    if (messages.length === 0) {
      notify("There is nothing to export yet.");
      return;
    }

    const body = messages
      .map((message) => `## ${message.role === "user" ? "You" : "Folio"}\n\n${stripUsed(message.content)}`)
      .join("\n\n");

    const file = new Blob([`# Folio conversation\n\n${body}\n`], {
      type: "text/markdown;charset=utf-8",
    });

    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = `folio-conversation-${new Date().toISOString().slice(0, 10)}.md`;
    link.click();

    // Revoking immediately can cancel the download in some browsers; a tick
    // later is safe and still frees the blob.
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    setOpen(false);
    notify("Conversation exported as Markdown.", { tone: "success" });
  }

  const ITEMS = [
    { id: "export", icon: "download", label: "Export chat", onClick: exportChat },
    {
      id: "share",
      icon: "share",
      label: "Share chat",
      soon: true,
      onClick: () => {
        setOpen(false);
        notify("Share — a read-only link to this conversation.");
      },
    },
    {
      id: "clear",
      icon: "trash",
      label: "Clear chat",
      danger: true,
      onClick: () => {
        setOpen(false);
        onClear();
      },
    },
  ];

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={toggleFullscreen}
        className="flex items-center gap-1.5 rounded-xl border border-border bg-surface-raised px-3 py-2 text-sm text-ink transition-colors hover:border-border-strong"
      >
        <Icon name={isFullscreen ? "collapse" : "expand"} />
        <span className="hidden sm:inline">{isFullscreen ? "Exit" : "Fullscreen"}</span>
      </button>

      <div ref={menuRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          aria-haspopup="menu"
          className="flex items-center gap-1.5 rounded-xl border border-border bg-surface-raised px-3 py-2 text-sm text-ink transition-colors hover:border-border-strong"
        >
          <Icon name="gear" />
          <span className="hidden sm:inline">Options</span>
        </button>

        {open && (
          <div
            role="menu"
            className="absolute right-0 z-30 mt-2 w-52 overflow-hidden rounded-xl border border-border bg-surface-raised p-1 shadow-xl"
          >
            {ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                onClick={item.onClick}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                  item.danger
                    ? "text-danger hover:bg-danger-soft"
                    : "text-ink hover:bg-primary-soft"
                }`}
              >
                <Icon name={item.icon} />
                {item.label}
                {item.soon && (
                  <span className="ml-auto text-[0.65rem] uppercase tracking-wide text-ink-faint">
                    soon
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
