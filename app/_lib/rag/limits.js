import "server-only";

import { createHash } from "node:crypto";

import { createClient } from "../supabase-server.js";
import { siteConfig } from "../siteConfig.js";

/**
 * Identify a caller without storing their address.
 *
 * The salt means the hashes are not reversible with a rainbow table of the
 * IPv4 space, which an unsalted SHA-256 of an IP very much is.
 */
function hashCaller(request) {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const ip = forwarded.split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";

  const salt = process.env.RATE_LIMIT_SALT ?? "";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

let warned = false;

/** Say it once per process, not once per request. */
function warnLimiterOff() {
  if (warned) return;
  warned = true;
  console.warn(
    "[limits] RATE LIMITER IS OFF (DEMO_QUESTIONS_PER_HOUR=0). " +
      "Fine locally; on a public deployment this is an unbounded API bill."
  );
}

/**
 * @returns {Promise<{allowed: boolean, remaining: number, resetsAt: string|null}>}
 */
export async function checkRateLimit(request) {
  // 0 means off. Returned before touching the database, so a local test run
  // does not depend on Supabase being reachable either.
  if (siteConfig.demo.questionsPerHour <= 0) {
    warnLimiterOff();
    return { allowed: true, remaining: Infinity, resetsAt: null };
  }

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("check_rate_limit", {
    caller: hashCaller(request),
    max_per_hour: siteConfig.demo.questionsPerHour,
  });

  if (error) {
    // Fail CLOSED. A broken limiter that lets everything through is how a
    // public demo turns into an unbounded bill.
    console.error("Rate limit check failed:", error.message);
    return { allowed: false, remaining: 0, resetsAt: null };
  }

  const row = Array.isArray(data) ? data[0] : data;
  return {
    allowed: row?.allowed ?? false,
    remaining: row?.remaining ?? 0,
    resetsAt: row?.resets_at ?? null,
  };
}

/**
 * Validate what the browser sent. Never trust the client's own limits.
 */
export function validateChatRequest(body) {
  const question = typeof body?.question === "string" ? body.question.trim() : "";

  if (question === "") {
    return { ok: false, message: "Ask a question to get started." };
  }

  if (question.length > siteConfig.demo.maxQuestionLength) {
    return {
      ok: false,
      message: `Questions are limited to ${siteConfig.demo.maxQuestionLength} characters.`,
    };
  }

  const rawHistory = Array.isArray(body?.history) ? body.history : [];

  // Only the recent turns are kept, and only the shape we expect. This caps
  // what a caller can push into the context window regardless of what their
  // browser claims the conversation was.
  const history = rawHistory
    .filter(
      (turn) =>
        (turn?.role === "user" || turn?.role === "assistant") &&
        typeof turn?.content === "string" &&
        turn.content.trim() !== ""
    )
    .slice(-siteConfig.demo.maxTurnsKept)
    .map((turn) => ({
      role: turn.role,
      content: turn.content.slice(0, 4000),
    }));

  return { ok: true, question, history };
}

/**
 * Give back the slot a request spent, when that request produced nothing.
 *
 * check_rate_limit spends atomically -- it has to, or two simultaneous
 * requests both read "11 used" and both proceed. But that means a request
 * which dies afterwards, for reasons the visitor had no part in (the daily
 * model quota is gone, retrieval failed), still costs one of their twelve.
 * Twelve failures in a row and the hour is spent with nothing to show for it,
 * which is exactly how this was noticed.
 *
 * So the spend is refunded when, and only when, the request yielded no answer
 * at all. A partial answer is not refunded: the visitor got something and the
 * call was billed.
 */
export async function refundRateLimit(request) {
  if (siteConfig.demo.questionsPerHour <= 0) return;

  try {
    const supabase = await createClient();
    await supabase.rpc("refund_rate_limit", { caller: hashCaller(request) });
  } catch (error) {
    // A failed refund must never turn one failure into two. The visitor has
    // already been told what went wrong; losing a slot is the lesser problem.
    console.error("Rate limit refund failed:", error.message);
  }
}
