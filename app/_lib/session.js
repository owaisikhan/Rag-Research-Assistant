import "server-only";

import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";

// A visitor's uploads are keyed to this. It is the ONLY thing standing between
// one person's uploaded contract and another person's search results, so:
//
//   httpOnly  - scripts on the page cannot read it, so an XSS in a dependency
//               cannot lift it
//   sameSite  - not sent on cross-site requests
//   secure    - in production only; localhost is plain http
//   a v4 uuid - unguessable, which matters because the database functions
//               trust whatever session id they are handed
export const SESSION_COOKIE = "cited_session";

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  // Matches the 24h upload lifetime; there is nothing to remember after that.
  maxAge: 60 * 60 * 24,
};

/** Read the session id, or null. Safe in a Server Component. */
export async function readSessionId() {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

/**
 * Read the session id, creating one if absent.
 *
 * Only callable from a Route Handler or Server Action -- a Server Component
 * cannot set cookies. That is why the home page uses readSessionId() and
 * simply shows no uploads until the visitor makes their first request.
 */
export async function ensureSessionId() {
  const store = await cookies();
  const existing = store.get(SESSION_COOKIE)?.value;
  if (existing) return existing;

  const created = randomUUID();
  store.set(SESSION_COOKIE, created, COOKIE_OPTIONS);
  return created;
}
