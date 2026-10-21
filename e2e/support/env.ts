import { execSync } from "node:child_process";
import { assertLocalUrl } from "./guard";

// `supabase status -o env`, read once per process. The ports come from supabase/config.toml, so a stack moved off
// the default ports (another project holding 54321/54322) is followed without editing the specs. Never printed.
let statusCache: Record<string, string> | null = null;
function status(): Record<string, string> {
  if (statusCache) return statusCache;
  const raw = execSync("supabase status -o env", { stdio: ["ignore", "pipe", "ignore"] }).toString();
  const m: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) m[line.slice(0, i)] = line.slice(i + 1).replace(/^"|"$/g, "");
  }
  statusCache = m;
  return m;
}

// Local Supabase connection values from the CLI. Never printed.
export function localEnv(): Record<string, string> {
  const m = status();
  assertLocalUrl(m.API_URL, "supabase API_URL");
  return {
    NEXT_PUBLIC_SUPABASE_URL: m.API_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: m.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: m.SERVICE_ROLE_KEY,
  };
}

export const DB_URL = status().DB_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
export const MAIL_API = `${(status().MAILPIT_URL || status().INBUCKET_URL || "http://127.0.0.1:54324").replace(/\/+$/, "")}/api/v1`;
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3200);
export const BASE_URL = `http://localhost:${E2E_PORT}`;
assertLocalUrl(DB_URL, "DB_URL");
assertLocalUrl(MAIL_API, "MAIL_API");
assertLocalUrl(BASE_URL, "BASE_URL");
