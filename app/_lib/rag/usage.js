import "server-only";

import { createClient } from "../supabase-server.js";

/**
 * A ledger of what this app has spent against the model provider.
 *
 * Gemini has no "how much is left" endpoint. The only signal the free tier
 * gives is a 429 once the allowance is already gone, which is how this project
 * kept discovering its daily cap: a feature stopped working mid-test and the
 * cause was invisible until someone read a server log. Counting on the way out
 * is the only way to see the spend before it becomes a wall.
 *
 * The provider's count stays authoritative; this one drifts from it. A request
 * that fails after the provider counted it, the same key used from a script,
 * and the fact that Google resets on Pacific time while this rolls over at UTC
 * midnight all pull the two apart. It is for seeing the shape of consumption,
 * not for gating on.
 */

/** What the free tier allows per day, for showing spend against a denominator. */
export const DAILY_LIMITS = {
  // Measured, not assumed: the 429 body says "1000 requests, where each TEXT
  // counts as one".
  embedding: Number(process.env.GEMINI_EMBED_DAILY_LIMIT || 1000),
  // Gemini does not publish one figure for this and it varies by model, so it
  // is only shown when someone sets it.
  generation: Number(process.env.GEMINI_GEN_DAILY_LIMIT || 0) || null,
};

/**
 * Record one call's cost.
 *
 * NEVER throws. Bookkeeping must not be able to fail a request that already
 * succeeded -- losing a row costs an inaccurate chart, while throwing here
 * would cost the answer the visitor was waiting for.
 *
 * @param {{ provider?: string, kind: "embedding"|"generation", units: number,
 *           tokensIn?: number, tokensOut?: number }} entry
 */
export async function recordUsage({
  provider = "gemini",
  kind,
  units,
  tokensIn = 0,
  tokensOut = 0,
}) {
  if (!units && !tokensIn && !tokensOut) return;

  try {
    const supabase = await createClient();
    await supabase.rpc("record_api_usage", {
      p_provider: provider,
      p_kind: kind,
      p_units: Math.round(units || 0),
      p_tokens_in: Math.round(tokensIn || 0),
      p_tokens_out: Math.round(tokensOut || 0),
    });
  } catch (error) {
    console.error("Usage not recorded:", error.message);
  }
}

/**
 * Today's spend per kind, with the daily limit where one is known.
 *
 * Embedding and generation are metered SEPARATELY by Gemini, with different
 * allowances, so they are never summed into one number -- "you have used 60%"
 * across two unrelated quotas would be meaningless, and the whole reason this
 * exists is that the two were being confused for each other.
 */
export async function getUsageSummary() {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("api_usage_summary");
    if (error) throw new Error(error.message);

    return (data ?? []).map((row) => ({
      kind: row.kind,
      unitsToday: row.units_today,
      unitsLastHour: row.units_hour,
      tokensToday: Number(row.tokens_today ?? 0),
      callsToday: row.calls_today,
      dailyLimit: DAILY_LIMITS[row.kind] ?? null,
    }));
  } catch (error) {
    console.error("Usage summary failed:", error.message);
    return [];
  }
}
