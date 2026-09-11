// Service-role client. Bypasses RLS entirely.
//
// Used ONLY by the ingestion scripts, which run on a developer machine. It
// must never be imported from anything under app/ that renders, and the key
// must never be exposed to the browser.
import { createClient } from "@supabase/supabase-js";

export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Ingestion needs it to write."
    );
  }

  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
