"use client";

import { useState } from "react";

import Icon from "../ui/Icon";

/**
 * Where an answer came from, under the answer.
 *
 * Grouped BY DOCUMENT rather than listed per passage. Twelve passages from one
 * lease is not twelve sources, it is one document and a set of pages, and a
 * reader checking a claim wants "which document, what page" -- not a numbered
 * list whose numbers point at nothing now that inline markers are off.
 *
 * Collapsed by default: the answer is the thing being read. Expanding one
 * shows the passages themselves, which is the only way to actually check a
 * claim rather than take the citation on trust.
 */
function formatPages(passages) {
  // Merge the page ranges into one readable run: "pp. 3-4, 9, 12-14".
  const ranges = passages
    .map((p) => [p.pageStart, p.pageEnd])
    .sort((a, b) => a[0] - b[0])
    .reduce((merged, [start, end]) => {
      const last = merged[merged.length - 1];
      // Adjacent as well as overlapping, so pages 3-4 and 5 read as "3-5"
      // rather than as two separate references to the same passage of text.
      if (last && start <= last[1] + 1) {
        last[1] = Math.max(last[1], end);
        return merged;
      }
      return [...merged, [start, end]];
    }, []);

  const parts = ranges.map(([start, end]) => (start === end ? `${start}` : `${start}–${end}`));
  const plural = ranges.length > 1 || ranges.some(([s, e]) => s !== e);

  return `${plural ? "pp." : "p."} ${parts.join(", ")}`;
}

function groupByDocument(sources) {
  const groups = new Map();

  for (const source of sources) {
    const key = source.documentId ?? source.title;
    if (!groups.has(key)) {
      groups.set(key, { key, title: source.title, sourceUrl: source.sourceUrl, passages: [] });
    }
    groups.get(key).passages.push(source);
  }

  return [...groups.values()];
}

export default function AnswerSources({ sources, used }) {
  const [openKey, setOpenKey] = useState(null);

  if (!sources || sources.length === 0) return null;

  // `used` is what the model said it relied on. Three cases, and conflating
  // any two of them is how a sources list starts lying:
  //
  //   an array  -> those passages, under "Based on"
  //   []        -> it answered from none of them; say so rather than showing
  //                a list the answer did not come from
  //   null      -> it did not say. Show what was SEARCHED, and label it that
  //                way. Retrieval hands over near-identical documents all the
  //                time; crediting them as sources would be a confident lie.
  const known = Array.isArray(used);

  if (known && used.length === 0) {
    return (
      <p className="mt-3 text-xs text-ink-faint">
        This answer did not come from your documents.
      </p>
    );
  }

  const shown = known
    ? sources.filter((source) => used.includes(source.number))
    : sources;

  if (shown.length === 0) return null;

  const groups = groupByDocument(shown);

  return (
    <section className="mt-3">
      <h3 className="text-[0.7rem] font-semibold uppercase tracking-wide text-ink-faint">
        {known ? "Based on" : "Passages searched"}
      </h3>

      <ul className="mt-1.5 space-y-1">
        {groups.map((group) => {
          const isOpen = openKey === group.key;

          return (
            <li key={group.key}>
              <button
                type="button"
                onClick={() => setOpenKey(isOpen ? null : group.key)}
                aria-expanded={isOpen}
                className="flex w-full items-center gap-2 rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-left transition-colors hover:border-border-strong"
              >
                <Icon name="file" className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate text-xs text-ink" title={group.title}>
                  {group.title}
                </span>
                <span className="shrink-0 text-xs text-primary">
                  {formatPages(group.passages)}
                </span>
                <span className="shrink-0 text-ink-faint">
                  <Icon
                    name="chevronDown"
                    className={`h-3.5 w-3.5 transition-transform ${isOpen ? "rotate-180" : ""}`}
                  />
                </span>
              </button>

              {isOpen && (
                <ul className="mt-1 space-y-1.5 pl-6">
                  {group.passages.map((passage) => (
                    <li key={passage.chunkId}>
                      <p className="border-l-2 border-border-strong pl-3 text-xs leading-relaxed text-ink-muted">
                        <span className="text-ink-faint">
                          {passage.section ? `${passage.section} · ` : ""}
                          {passage.pageStart === passage.pageEnd
                            ? `p. ${passage.pageStart}`
                            : `pp. ${passage.pageStart}–${passage.pageEnd}`}
                        </span>
                        <br />“{passage.excerpt}…”
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
