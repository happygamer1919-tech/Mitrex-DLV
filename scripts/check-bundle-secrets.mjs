// Fails the build if any secret VALUE or secret-shaped token appears in client bundles or
// server-to-client HTML. Prints only BUNDLE_OK / BUNDLE_FAIL, counts and file paths. Never a value.
// Usage: node scripts/check-bundle-secrets.mjs [--self-test]
import { execSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.CHECK_PORT || 3306);
const DIST = process.env.NEXT_DIST_DIR || `.next-${PORT}`;

function assertLocal(urlStr, label) {
  let host = "";
  try {
    host = new URL(urlStr).hostname;
  } catch {
    host = "";
  }
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.error(`REFUSED: ${label} host is not local`);
    process.exit(2);
  }
}

function localStack() {
  const raw = execSync("supabase status -o env", { stdio: ["ignore", "pipe", "ignore"] }).toString();
  const m = {};
  for (const line of raw.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) m[line.slice(0, i)] = line.slice(i + 1).replace(/^"|"$/g, "");
  }
  assertLocal(m.API_URL, "supabase API_URL");
  assertLocal(m.DB_URL, "supabase DB_URL");
  return m;
}

function secretValues(stack) {
  const vals = new Set();
  // Bare passwords shorter than 12 chars (the local stack uses a dictionary word) match ordinary
  // code, so they are only compared as part of a full URL (also covered by the URL pattern check).
  const add = (v, min = 8) => {
    if (v && v.length >= min) vals.add(v);
  };
  add(process.env.SUPABASE_SERVICE_ROLE_KEY);
  for (const k of ["DATABASE_URL", "DATABASE_URL_DIRECT", "SUPABASE_DB_URL"]) {
    const v = process.env[k];
    if (!v) continue;
    add(v);
    try {
      add(decodeURIComponent(new URL(v).password), 12);
      add(new URL(v).password, 12);
    } catch {}
  }
  add(stack.SERVICE_ROLE_KEY);
  add(stack.SECRET_KEY);
  add(stack.JWT_SECRET);
  try {
    add(new URL(stack.DB_URL).password, 12);
  } catch {}
  return [...vals];
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const SB_SECRET_RE = /sb_secret_[A-Za-z0-9_-]{6,}/;
const PG_PW_RE = /postgres(?:ql)?:\/\/[^\s:@/"'`\\]+:[^\s@/"'`\\]+@/i;

// Returns [{file, kind}] only. kind is a label, never content.
function scanText(file, text, values) {
  const hits = [];
  for (let i = 0; i < values.length; i++) if (text.includes(values[i])) hits.push({ file, kind: "secret-value" });
  for (const tok of text.match(JWT_RE) || []) {
    try {
      const payload = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString("utf8"));
      if (payload.role === "service_role") hits.push({ file, kind: "service_role-jwt" });
    } catch {}
  }
  if (SB_SECRET_RE.test(text)) hits.push({ file, kind: "sb_secret-token" });
  if (PG_PW_RE.test(text)) hits.push({ file, kind: "postgres-url-with-password" });
  return hits;
}

function scanFiles(files, values) {
  const hits = [];
  for (const f of files) hits.push(...scanText(f, readFileSync(f, "latin1"), values));
  return hits;
}

function buildEnv(stack) {
  return {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: stack.API_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: stack.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: stack.SERVICE_ROLE_KEY,
    NEXT_DIST_DIR: DIST,
  };
}

function ensureBuild(stack) {
  if (existsSync(join(DIST, "BUILD_ID"))) return;
  console.log(`building into ${DIST}`);
  execSync("npx next build", { env: buildEnv(stack), stdio: ["ignore", "ignore", "inherit"] });
}

async function fetchPages(stack) {
  const env = buildEnv(stack);
  const child = spawn("npx", ["next", "start", "-p", String(PORT), "-H", "127.0.0.1"], { env, stdio: "ignore" });
  const pages = [];
  try {
    if (await fetch(`http://127.0.0.1:${PORT}/login`).then(() => true, () => false)) {
      throw new Error(`port ${PORT} is already in use`);
    }
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try {
        await fetch(`http://127.0.0.1:${PORT}/login`);
        up = true;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!up) throw new Error("app did not start");
    for (const path of ["/login", "/"]) {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { redirect: "follow" });
      pages.push({ file: `GET ${path}`, text: await res.text() });
    }
  } finally {
    child.kill("SIGTERM");
  }
  return pages;
}

const stack = localStack();
const values = secretValues(stack);
ensureBuild(stack);
const staticFiles = walk(join(DIST, "static"));

if (process.argv.includes("--self-test")) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const fake = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role: "service_role", iss: "selftest" })}.${Buffer.from("not-a-real-signature").toString("base64url")}`;
  const t1 = join(DIST, "static", "__selftest_pattern.js");
  const t2 = join(DIST, "static", "__selftest_value.js");
  let ok = true;
  try {
    const baseline = scanFiles(staticFiles, values).length;
    if (baseline !== 0) {
      console.log(`SELFTEST_FAIL clean baseline had ${baseline} hits`);
      ok = false;
    }
    writeFileSync(t1, `var x="${fake}";`);
    const h1 = scanFiles([t1], values);
    writeFileSync(t2, `var y="${stack.SERVICE_ROLE_KEY}";`);
    const h2 = scanFiles([t2], values);
    console.log(`pattern plant: ${h1.length > 0 ? "BUNDLE_FAIL" : "MISSED"} (${h1.length} hits)`);
    console.log(`value plant: ${h2.some((h) => h.kind === "secret-value") ? "BUNDLE_FAIL" : "MISSED"} (${h2.length} hits)`);
    if (!h1.some((h) => h.kind === "service_role-jwt") || !h2.some((h) => h.kind === "secret-value")) ok = false;
  } finally {
    rmSync(t1, { force: true });
    rmSync(t2, { force: true });
  }
  console.log(ok ? "SELFTEST_OK" : "SELFTEST_FAIL");
  process.exit(ok ? 0 : 1);
}

const serverHtml = walk(join(DIST, "server", "app")).filter((f) => f.endsWith(".html") || f.endsWith(".rsc"));
const files = [...staticFiles, ...serverHtml];
const hits = scanFiles(files, values);
let pagesScanned = 0;
try {
  for (const p of await fetchPages(stack)) {
    pagesScanned++;
    hits.push(...scanText(p.file, p.text, values));
  }
} catch (e) {
  console.error(`page fetch failed: ${e.message}`);
  console.log("BUNDLE_FAIL (could not fetch pages)");
  process.exit(1);
}
console.log(`scanned files=${files.length} pages=${pagesScanned} secret_values_checked=${values.length}`);
if (hits.length) {
  for (const h of hits) console.log(`  ${h.kind}: ${h.file}`);
  console.log(`BUNDLE_FAIL hits=${hits.length}`);
  process.exit(1);
}
console.log("BUNDLE_OK");
