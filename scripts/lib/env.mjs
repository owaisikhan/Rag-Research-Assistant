// Minimal .env.local reader.
//
// Next.js loads .env.local itself, but these scripts run under plain node,
// which does not. Rather than add dotenv, parse the handful of lines we need.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnv(file = ".env.local") {
  let raw;
  try {
    raw = readFileSync(resolve(process.cwd(), file), "utf8");
  } catch {
    return; // Real environment variables may already be set.
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    // Strip matching surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] ??= value;
  }
}
