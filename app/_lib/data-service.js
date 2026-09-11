import "server-only";

import { createClient } from "./supabase-server.js";

/**
 * Corpus figures for the header and the about panel.
 *
 * Aggregated by a Postgres function rather than counted in JavaScript, so
 * every screen showing "N documents" reads the same number from one place.
 */
export async function getCorpusStats() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("corpus_stats");

  if (error) {
    console.error("corpus_stats failed:", error.message);
    return { documentCount: 0, chunkCount: 0, pageCount: 0, kinds: {} };
  }

  const row = Array.isArray(data) ? data[0] : data;
  return {
    documentCount: row?.document_count ?? 0,
    chunkCount: row?.chunk_count ?? 0,
    pageCount: row?.page_count ?? 0,
    kinds: row?.kinds ?? {},
  };
}

/**
 * The library listing, newest first.
 */
export async function getDocuments({ limit = 100 } = {}) {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("documents")
    .select("id, title, authors, published_on, source_url, kind, page_count")
    .order("published_on", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) {
    console.error("getDocuments failed:", error.message);
    return [];
  }

  return data ?? [];
}
