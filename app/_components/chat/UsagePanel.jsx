"use client";

import { useEffect, useState } from "react";

import Icon from "../ui/Icon";

const LABELS = {
  embedding: "Indexing & search",
  generation: "Answers",
};

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/**
 * What this app has spent against the model provider today.
 *
 * Gemini has no "how much is left" endpoint -- the only signal the free tier
 * gives is a 429 once the allowance is gone. This project kept discovering its
 * daily cap by having a feature stop working mid-test, so the spend is counted
 * on the way out and shown here.
 *
 * The two rows are never summed. Embedding and generation are metered
 * separately with different allowances, and confusing the two for each other
 * is the specific mistake this is meant to prevent.
 */
export default function UsagePanel({ refreshKey }) {
  const [usage, setUsage] = useState([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // The cancelled flag is not ceremony: refreshKey changes on every finished
    // turn, so two fetches can be in flight at once and the slower one must not
    // overwrite the newer figures with older ones.
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch("/api/usage", { cache: "no-store" });
        const body = await response.json();
        if (!cancelled) setUsage(body.usage ?? []);
      } catch {
        // A usage panel is never worth interrupting the app for.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (usage.length === 0) return null;

  const total = usage.reduce((sum, row) => sum + row.unitsToday, 0);

  return (
    <section className="mt-4">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-left transition-colors hover:border-border-strong"
      >
        <Icon name="pulse" className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
        <span className="flex-1 text-xs text-ink-muted">API usage today</span>
        <span className="text-xs text-ink-faint">{total}</span>
        <Icon
          name="chevronDown"
          className={`h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="mt-2 space-y-3 rounded-lg border border-border bg-surface-raised p-3">
          {usage.map((row) => {
            const pct = row.dailyLimit
              ? Math.min(100, Math.round((row.unitsToday / row.dailyLimit) * 100))
              : null;

            return (
              <div key={row.kind}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs text-ink">{LABELS[row.kind] ?? row.kind}</span>
                  <span className="text-xs text-ink-muted">
                    {row.unitsToday}
                    {row.dailyLimit ? ` / ${row.dailyLimit}` : ""}
                  </span>
                </div>

                {pct !== null && (
                  <div
                    className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-sunken"
                    role="img"
                    aria-label={`${pct}% of today's ${LABELS[row.kind]} allowance used`}
                  >
                    {/* Colour is never the only cue -- the number above says
                        the same thing, and the label says it again. */}
                    <div
                      className={pct >= 90 ? "h-full bg-danger" : "h-full bg-primary"}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}

                <p className="mt-1 text-[0.7rem] text-ink-faint">
                  {row.callsToday} {row.callsToday === 1 ? "call" : "calls"}
                  {row.tokensToday > 0 && ` · ${formatTokens(row.tokensToday)} tokens`}
                  {row.unitsLastHour > 0 && ` · ${row.unitsLastHour} in the last hour`}
                </p>
              </div>
            );
          })}

          <p className="border-t border-border pt-2 text-[0.7rem] leading-relaxed text-ink-faint">
            Counted by this app, not by Google. Quotas reset on Pacific time
            while this counts from UTC midnight, so the two disagree for part of
            each day.
          </p>
        </div>
      )}
    </section>
  );
}
