import ChatPanel from "@/app/_components/chat/ChatPanel";
import Callout from "@/app/_components/ui/Callout";
import { Toaster } from "@/app/_components/ui/Toaster";
import { siteConfig } from "@/app/_lib/siteConfig";
import { getCorpusStats } from "@/app/_lib/data-service";

// The corpus changes only when someone runs the ingestion script, so the
// figures are cached rather than counted on every request.
export const revalidate = 3600;

const isConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

export default async function HomePage() {
  // Only meaningful when the curated library is part of the search. With it
  // switched off the header would otherwise advertise a corpus the assistant
  // does not read.
  const showLibrary = siteConfig.mode.includeDemoCorpus;

  const stats =
    isConfigured && showLibrary
      ? await getCorpusStats()
      : { documentCount: 0, chunkCount: 0, pageCount: 0, kinds: {} };

  return (
    <Toaster>
      {/* min-h-dvh + flex-1 pins the footer to the bottom of the viewport on a
          short page, so an empty state does not leave the rule and the footer
          floating halfway up with nothing under them. */}
      <div className="mx-auto flex min-h-dvh w-full max-w-[88rem] flex-col px-4 py-10 sm:px-8 lg:px-12">
        <main className="flex min-w-0 flex-1 flex-col">
          {!isConfigured ? (
            <Callout tone="danger">
              Supabase is not configured. Copy <code>.env.example</code> to{" "}
              <code>.env.local</code>, fill in the project URL and anon key, run
              the migrations, then <code>node scripts/fetch-corpus.mjs</code> and{" "}
              <code>node scripts/ingest.mjs</code>. The README has the full
              sequence.
            </Callout>
          ) : showLibrary && stats.documentCount === 0 ? (
            <Callout tone="info">
              The library is empty. Run <code>npm run corpus:fetch</code> then{" "}
              <code>npm run corpus:ingest</code> to populate it.
            </Callout>
          ) : (
            <ChatPanel />
          )}
        </main>

        {/* A sibling of <main>, not a child of it -- flex-1 on main can only
            push down what sits beside it. */}
        <footer className="mt-12 w-full border-t border-border pt-5 text-xs text-ink-faint">
          <p>
            {siteConfig.mode.showCitations
              ? "Answers are generated from retrieved passages only. Citations link to the page they came from — check them."
              : "Answers are generated only from the documents you upload. Uploads are private to you and are deleted after 24 hours."}
          </p>
        </footer>
      </div>
    </Toaster>
  );
}
