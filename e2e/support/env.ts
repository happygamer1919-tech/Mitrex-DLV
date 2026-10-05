import { execSync } from "node:child_process";
import { assertLocalUrl } from "./guard";

// Local Supabase connection values from the CLI. Never printed.
export function localEnv(): Record<string, string> {
  const raw = execSync("supabase status -o env", { stdio: ["ignore", "pipe", "ignore"] }).toString();
  const m: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) m[line.slice(0, i)] = line.slice(i + 1).replace(/^"|"$/g, "");
  }
  assertLocalUrl("NEXT_PUBLIC_SUPABASE_URL", m.API_URL);
  return {
    NEXT_PUBLIC_SUPABASE_URL: m.API_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: m.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: m.SERVICE_ROLE_KEY,
  };
}

export const DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
assertLocalUrl("DB_URL", DB_URL);
export const MAIL_API = "http://127.0.0.1:54324/api/v1";
assertLocalUrl("MAIL_API", MAIL_API);
