"use client";

import Icon from "../ui/Icon";
import { useToast } from "../ui/Toaster";

/**
 * The navigation rail.
 *
 * PLACEHOLDER, deliberately and visibly. This product is one screen; the rail
 * exists because the reference design has one and because a pitch reads better
 * when the shell looks like a product rather than a page. Every item except
 * Assistant announces itself as not built yet rather than routing nowhere.
 */
const ITEMS = [
  { id: "overview", icon: "grid", label: "Overview", soon: "Overview — a dashboard of your documents and questions." },
  { id: "library", icon: "book", label: "Library", soon: "Library — browse and organise every document you have uploaded." },
  { id: "assistant", icon: "bot", label: "Assistant", active: true },
  { id: "insights", icon: "pulse", label: "Insights", soon: "Insights — what you ask about most, and what your documents cover." },
  { id: "billing", icon: "card", label: "Billing", soon: "Billing — plan, usage and invoices." },
  { id: "settings", icon: "sliders", label: "Preferences", soon: "Preferences — model, answer length and retrieval settings." },
];

export default function Sidebar() {
  const notify = useToast();

  return (
    <nav
      aria-label="Sections"
      className="brand-gradient sticky top-6 hidden h-[min(34rem,calc(100dvh-3rem))] w-[4.5rem] shrink-0 flex-col items-center gap-1 rounded-3xl py-5 shadow-xl lg:flex"
    >
      <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-white/15 text-white">
        <Icon name="gem" className="h-4.5 w-4.5" />
        <span className="sr-only">Folio</span>
      </span>

      {ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => !item.active && notify(item.soon)}
          aria-current={item.active ? "page" : undefined}
          title={item.label}
          className={`group relative flex h-11 w-11 items-center justify-center rounded-xl transition-colors ${
            item.active
              ? "bg-white/25 text-white"
              : "text-white/70 hover:bg-white/15 hover:text-white"
          }`}
        >
          <Icon name={item.icon} className="h-5 w-5" />
          <span className="sr-only">{item.label}</span>

          {/* The label on hover, so the rail is readable without widening it. */}
          <span className="pointer-events-none absolute left-full z-20 ml-2 hidden whitespace-nowrap rounded-lg border border-border bg-surface-raised px-2 py-1 text-xs text-ink shadow-lg group-hover:block">
            {item.label}
            {!item.active && <span className="ml-1.5 text-ink-faint">soon</span>}
          </span>
        </button>
      ))}
    </nav>
  );
}
