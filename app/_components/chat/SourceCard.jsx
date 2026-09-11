"use client";

function formatPages(source) {
  return source.pageStart === source.pageEnd
    ? `p. ${source.pageStart}`
    : `pp. ${source.pageStart}–${source.pageEnd}`;
}

function formatAuthors(authors) {
  if (!authors || authors.length === 0) return null;
  if (authors.length <= 2) return authors.join(" & ");
  return `${authors[0]} et al.`;
}

export default function SourceCard({ source, isActive, onSelect }) {
  const authors = formatAuthors(source.authors);

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(source.number)}
        aria-current={isActive ? "true" : undefined}
        className={`w-full rounded-lg border p-3 text-left transition-colors ${
          isActive
            ? "border-primary bg-primary-soft"
            : "border-border bg-surface-raised hover:border-border-strong"
        }`}
      >
        <div className="flex items-baseline gap-2">
          <span
            className={`mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded text-[0.65rem] font-semibold ${
              isActive ? "bg-primary text-white" : "bg-surface-sunken text-ink-muted"
            }`}
          >
            {source.number}
          </span>
          <span className="text-sm font-medium leading-snug text-ink">{source.title}</span>
        </div>

        <p className="mt-1.5 pl-7 text-xs text-ink-faint">
          {authors ? `${authors} · ` : ""}
          {source.section ? `${source.section} · ` : ""}
          {formatPages(source)}
        </p>

        {isActive && (
          <div className="mt-2.5 pl-7">
            <p className="border-l-2 border-border-strong pl-3 text-xs leading-relaxed text-ink-muted">
              “{source.excerpt}…”
            </p>
            {source.sourceUrl && (
              <a
                href={source.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                onClick={(event) => event.stopPropagation()}
                className="mt-2 inline-block text-xs font-medium text-primary hover:underline"
              >
                Open the original document ↗
              </a>
            )}
          </div>
        )}
      </button>
    </li>
  );
}
