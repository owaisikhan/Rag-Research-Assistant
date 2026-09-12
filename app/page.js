import ChatPanel from "@/app/_components/chat/ChatPanel";
import Callout from "@/app/_components/ui/Callout";
import Sidebar from "@/app/_components/shell/Sidebar";
import TopBar from "@/app/_components/shell/TopBar";
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
      <div className="mx-auto flex w-full max-w-[84rem] gap-6 px-4 py-6 sm:px-6">
        <Sidebar />

        <main className="min-w-0 flex-1">
          <TopBar />

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

          <footer className="mt-12 border-t border-border pt-5 text-xs text-ink-faint">
            <p>
              {siteConfig.mode.showCitations
                ? "Answers are generated from retrieved passages only. Citations link to the page they came from — check them."
                : "Answers are generated only from the documents you upload. Uploads are private to you and are deleted after 24 hours."}
            </p>
          </footer>
        </main>
      </div>
    </Toaster>
  );
}
