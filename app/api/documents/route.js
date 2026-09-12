// This visitor's uploaded documents: list and delete.
//
// Both go through SECURITY DEFINER functions keyed to the session cookie, so
// a caller cannot list or delete anything that is not theirs by passing a
// different id -- the id never comes from the request body.

import { createClient } from "@/app/_lib/supabase-server";
import { readSessionId, ensureSessionId } from "@/app/_lib/session";

export const runtime = "nodejs";

export async function GET() {
  const sessionId = await readSessionId();
  if (!sessionId) return Response.json({ documents: [] });

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("session_documents", { p_session: sessionId });

  if (error) {
    console.error("session_documents failed:", error.message);
    return Response.json({ documents: [] });
  }

  return Response.json({
    documents: (data ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      fileName: row.file_name,
      pageCount: row.page_count,
      chunkCount: row.chunk_count,
      expiresAt: row.expires_at,
    })),
  });
}

export async function DELETE(request) {
  const sessionId = await ensureSessionId();

  let id;
  try {
    ({ id } = await request.json());
  } catch {
    return Response.json({ ok: false, message: "Malformed request." }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delete_session_document", {
    p_session: sessionId,
    p_document: id,
  });

  if (error) {
    return Response.json({ ok: false, message: "Could not remove that document." }, { status: 500 });
  }

  return Response.json({ ok: Boolean(data) });
}
