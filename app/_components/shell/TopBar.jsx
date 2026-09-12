"use client";

import { useState, useSyncExternalStore } from "react";

import Icon from "../ui/Icon";
import { useToast } from "../ui/Toaster";


/** Watch <html> for a theme change, wherever it came from. */
function subscribeToTheme(onChange) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

function readTheme() {
  return document.documentElement.getAttribute("data-theme") === "light"
    ? "light"
    : "dark";
}

/**
 * The top bar: search, theme, notifications, account.
 *
 * Only the theme toggle is real. The rest are placeholders that say what they
 * will do -- see Toaster for why they announce themselves rather than sit dead.
 */
export default function TopBar() {
  const notify = useToast();
  const [query, setQuery] = useState("");

  // The theme lives on <html>, set by ThemeScript before React ever runs, so
  // the DOM attribute is the source of truth rather than a piece of React
  // state that would start wrong and correct itself in an effect. The server
  // snapshot is "dark" because that is what the markup renders.
  const theme = useSyncExternalStore(subscribeToTheme, readTheme, () => "dark");

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";

    if (next === "light") document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");

    try {
      localStorage.setItem("folio-theme", next);
    } catch {
      // Private browsing. The theme still applies for this page view.
    }
  }

  return (
    <header className="brand-gradient mb-8 flex items-center gap-3 rounded-2xl px-3 py-2.5 shadow-lg sm:px-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          notify("Search — find any passage across every document you have uploaded.");
        }}
        className="relative min-w-0 flex-1 sm:max-w-md"
      >
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/70">
          <Icon name="search" />
        </span>
        <label htmlFor="global-search" className="sr-only">
          Search your documents
        </label>
        <input
          id="global-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search…"
          className="w-full rounded-xl border border-white/20 bg-white/10 py-2 pl-9 pr-3 text-sm text-white outline-none transition-colors placeholder:text-white/60 focus:border-white/50"
        />
      </form>

      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          className="flex h-9 w-9 items-center justify-center rounded-xl text-white/85 transition-colors hover:bg-white/15 hover:text-white"
        >
          <Icon name={theme === "dark" ? "sun" : "moon"} className="h-4.5 w-4.5" />
        </button>

        <button
          type="button"
          onClick={() => notify("Notifications — upload finished, quota warnings, expiring documents.")}
          aria-label="Notifications"
          className="relative flex h-9 w-9 items-center justify-center rounded-xl text-white/85 transition-colors hover:bg-white/15 hover:text-white"
        >
          <Icon name="bell" className="h-4.5 w-4.5" />
          <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-white" />
        </button>

        <button
          type="button"
          onClick={() => notify("Account — sign in to keep documents beyond 24 hours.")}
          aria-label="Account"
          className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/20 text-white transition-colors hover:bg-white/30"
        >
          <Icon name="user" className="h-4.5 w-4.5" />
        </button>
      </div>
    </header>
  );
}
