// Builds (if needed), starts the app locally, GETs /login and asserts security headers.
// Prints HEADERS_OK or HEADERS_FAIL with the failing header names.
import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.CHECK_PORT || 3306);
const DIST = process.env.NEXT_DIST_DIR || `.next-${PORT}`;

function assertLocal(urlStr, label) {
  let host = "";
  try {
    host = new URL(urlStr).hostname;
  } catch {}
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.error(`REFUSED: ${label} host is not local`);
    process.exit(2);
  }
}

const raw = execSync("supabase status -o env", { stdio: ["ignore", "pipe", "ignore"] }).toString();
const m = {};
for (const line of raw.split("\n")) {
  const i = line.indexOf("=");
  if (i > 0) m[line.slice(0, i)] = line.slice(i + 1).replace(/^"|"$/g, "");
}
assertLocal(m.API_URL, "supabase API_URL");
const env = {
  ...process.env,
  NEXT_PUBLIC_SUPABASE_URL: m.API_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: m.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: m.SERVICE_ROLE_KEY,
  NEXT_DIST_DIR: DIST,
};
if (!existsSync(join(DIST, "BUILD_ID"))) {
  console.log(`building into ${DIST}`);
  execSync("npx next build", { env, stdio: ["ignore", "ignore", "inherit"] });
}

const child = spawn("npx", ["next", "start", "-p", String(PORT), "-H", "127.0.0.1"], { env, stdio: "ignore" });
let headers;
try {
  let res;
  for (let i = 0; i < 60 && !res; i++) {
    try {
      res = await fetch(`http://127.0.0.1:${PORT}/login`);
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!res) throw new Error("app did not start");
  headers = res.headers;
} finally {
  child.kill("SIGTERM");
}

const fails = [];
const get = (n) => (headers.get(n) || "").toLowerCase();

if (get("x-content-type-options") !== "nosniff") fails.push("X-Content-Type-Options");

const STRICT_REFERRERS = ["no-referrer", "same-origin", "strict-origin", "strict-origin-when-cross-origin"];
if (!STRICT_REFERRERS.includes(get("referrer-policy"))) fails.push("Referrer-Policy");

const xfo = get("x-frame-options");
const csp = get("content-security-policy");
const fa = /frame-ancestors\s+('none'|'self')(\s|;|$)/.test(csp);
if (!(xfo === "deny" || fa)) fails.push("X-Frame-Options/CSP frame-ancestors");

const pp = get("permissions-policy");
const dir = (name) => {
  const mm = pp.match(new RegExp(`(?:^|,\\s*)${name}=(\\([^)]*\\)|\\*)`));
  return mm ? mm[1].replace(/\s+/g, "") : null;
};
if (!pp) fails.push("Permissions-Policy");
else {
  if (dir("camera") !== "(self)") fails.push("Permissions-Policy:camera");
  if (dir("microphone") !== "()") fails.push("Permissions-Policy:microphone");
  if (dir("geolocation") !== "()") fails.push("Permissions-Policy:geolocation");
}

const hsts = get("strict-transport-security");
const age = Number((hsts.match(/max-age=(\d+)/) || [])[1] || 0);
if (age < 31536000 || !hsts.includes("includesubdomains")) fails.push("Strict-Transport-Security");

if (fails.length) {
  console.log(`HEADERS_FAIL ${fails.join(", ")}`);
  process.exit(1);
}
console.log("HEADERS_OK");
