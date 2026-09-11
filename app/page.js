import ChatPanel from "@/app/_components/chat/ChatPanel";
import Callout from "@/app/_components/ui/Callout";
import { siteConfig } from "@/app/_lib/siteConfig";
import { getCorpusStats } from "@/app/_lib/data-service";

// The corpus changes only when someone runs the ingestion script, so the
// figures are cached rather than counted on every request.
export const revalidate = 3600;

const isConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

function formatNumber(value) {
  return new Intl.NumberFormat("en-GB").format(value);
}

export default async function HomePage() {
  const stats = isConfigured
    ? await getCorpusStats()
    : { documentCount: 0, chunkCount: 0, pageCount: 0, kinds: {} };

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:py-12">
      <header className="mb-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <h1 className="text-xl font-semibold tracking-tight text-ink">
            {siteConfig.name}
          </h1>
          {stats.documentCount > 0 && (
            <p className="text-xs text-ink-faint">
              {formatNumber(stats.documentCount)} documents ·{" "}
              {formatNumber(stats.pageCount)} pages ·{" "}
              {formatNumber(stats.chunkCount)} indexed passages
            </p>
          )}
        </div>

        <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">
          {siteConfig.tagline} {siteConfig.corpus.blurb}
        </p>
      </header>

      {!isConfigured ? (
        <Callout tone="danger">
          Supabase is not configured. Copy <code>.env.example</code> to{" "}
          <code>.env.local</code>, fill in the project URL and anon key, run the
          migrations, then <code>node scripts/fetch-corpus.mjs</code> and{" "}
          <code>node scripts/ingest.mjs</code>. The README has the full sequence.
        </Callout>
      ) : stats.documentCount === 0 ? (
        <Callout tone="info">
          The library is empty. Run <code>node scripts/fetch-corpus.mjs</code>{" "}
          then <code>node scripts/ingest.mjs</code> to populate it.
        </Callout>
      ) : (
        <ChatPanel />
      )}

      <footer className="mt-12 border-t border-border pt-5 text-xs text-ink-faint">
        <p>
          Answers are generated from retrieved passages only. Citations link to
          the page they came from — check them.
        </p>
      </footer>
    </main>
  );
}
