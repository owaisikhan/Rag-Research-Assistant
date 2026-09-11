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

/**
 * @returns {Promise<{allowed: boolean, remaining: number, resetsAt: string|null}>}
 */
export async function checkRateLimit(request) {
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
