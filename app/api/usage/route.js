// Today's spend against the model provider.
//
// Read-only and unmetered: this endpoint exists to answer "how much is left"
// without spending any of what is left.

import { getUsageSummary } from "@/app/_lib/rag/usage";

export const runtime = "nodejs";
// Never cached. A usage figure that is even a minute stale is worse than none,
// because it will be read as current while someone is mid-upload.
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    { usage: await getUsageSummary() },
    { headers: { "cache-control": "no-store" } }
  );
}
