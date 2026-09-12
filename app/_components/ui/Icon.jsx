/**
 * The icon set, as inline SVG.
 *
 * No icon package. Every icon here is a stroked 24x24 path, which is a few
 * hundred bytes each -- against ~50KB+ for a library, plus a dependency that
 * has to stay on a CDN allowlist and survive upgrades. Inline also means an
 * icon inherits `currentColor` and the theme swap needs no extra work.
 *
 * Add one by adding a path. Keep the stroke attributes on the <svg>, not the
 * path, so they stay consistent.
 */

const PATHS = {
  // navigation rail
  grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  sparkle: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z",
  bot: "M12 3v3M8 9h8a2 2 0 012 2v6a2 2 0 01-2 2H8a2 2 0 01-2-2v-6a2 2 0 012-2zM9.5 13.5h.01M14.5 13.5h.01",
  pulse: "M3 12h4l3 8 4-16 3 8h4",
  card: "M3 7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2zM3 10h18",
  sliders: "M4 7h10M18 7h2M4 17h2M10 17h10M16 5v4M8 15v4",

  // top bar
  search: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3",
  moon: "M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z",
  sun: "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6L4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 17a5 5 0 100-10 5 5 0 000 10z",
  bell: "M18 8a6 6 0 10-12 0c0 7-3 8-3 8h18s-3-1-3-8M13.7 21a2 2 0 01-3.4 0",
  user: "M12 12a4 4 0 100-8 4 4 0 000 8zM6 20.5a6 6 0 0112 0",

  // composer
  plus: "M12 5v14M5 12h14",
  globe: "M12 21a9 9 0 100-18 9 9 0 000 18zM3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 000 18M12 3a15 15 0 010 18",
  wand: "M15 4V2M15 10V8M11.5 6h-2M20.5 6h-2M18 9l1.5 1.5M18 3l1.5-1.5M4 20l9-9M4 20l-1 1",
  code: "M8 18l-5-6 5-6M16 6l5 6-5 6",
  mic: "M12 15a3 3 0 003-3V6a3 3 0 10-6 0v6a3 3 0 003 3zM5 11a7 7 0 0014 0M12 18v4",
  send: "M22 2L11 13M22 2l-7 20-4-9-9-4z",
  stop: "M7 7h10v10H7z",

  // actions
  expand: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  collapse: "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
  gear: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 11-4 0v-.1A1.6 1.6 0 007.5 19.4l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00-1.1-2.7H3a2 2 0 110-4h.1A1.6 1.6 0 004.6 7.5l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 002.7-1.1V3a2 2 0 114 0v.1a1.6 1.6 0 002.7 1.1l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 001.1 2.7H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z",
  download: "M12 3v12M7 11l5 4 5-4M4 20h16",
  share: "M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7M12 16V3M8 7l4-4 4 4",
  trash: "M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13M10 11v6M14 11v6",
  copy: "M9 9h10v10a2 2 0 01-2 2H9a2 2 0 01-2-2zM5 15V5a2 2 0 012-2h10",
  file: "M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5",
  book: "M4 5a2 2 0 012-2h12v18H6a2 2 0 01-2-2zM8 7h7M8 11h7",
  close: "M6 6l12 12M18 6L6 18",
  check: "M4 12l5 5L20 6",
  info: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 8h.01",
  gem: "M6 3h12l3 6-9 12L3 9z",
};

export default function Icon({ name, className = "h-4 w-4", strokeWidth = 1.7 }) {
  const d = PATHS[name];
  if (!d) return null;

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
