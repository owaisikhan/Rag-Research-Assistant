"use client";

import { useSyncExternalStore } from "react";

import Icon from "../ui/Icon";

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
 * The theme lives on <html>, set by ThemeScript before React ever runs, so the
 * DOM attribute is the source of truth rather than a piece of React state that
 * would start wrong and correct itself after hydration. The server snapshot is
 * "dark" because that is what the markup renders.
 */
export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeToTheme, readTheme, () => "dark");

  function toggle() {
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
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} />
    </button>
  );
}
