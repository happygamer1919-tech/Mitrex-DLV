// PWA gate. Prints PWA_OK or PWA_FAIL (with reasons) and exits 0 or 1.
// Usage: node scripts/check-pwa.mjs [--manifest <path>] [--port 3307] [--reuse-build] [--static-only]
//  - Static checks read the manifest (default public/manifest.webmanifest, or --manifest for a temp copy;
//    icon src paths always resolve under public/), the PNG headers and pixels, and the layout metadata.
//  - Runtime checks build the app (NEXT_DIST_DIR=.next-<port>), start it in production mode on <port>
//    against the LOCAL Supabase stack only, and drive Playwright chromium.
// Maskable construction: the mark (outer ring) has radius 26 percent of the side, so it must sit inside the
// safe zone circle of radius 40 percent (80 percent of the icon). Verified from decoded pixels below.
import { readFileSync, existsSync, rmSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const PUBLIC = join(ROOT, "public");
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const MANIFEST = resolve(arg("--manifest", join(PUBLIC, "manifest.webmanifest")));
const PORT = Number(arg("--port", "3307"));
const STATIC_ONLY = argv.includes("--static-only");
const REUSE = argv.includes("--reuse-build");
const INK = "#020814";

const fails = [];
const fail = (m) => fails.push(m);
const ok = (c, m) => { if (!c) fail(m); return !!c; };

// Local-only guard (same rule as scripts/lib/local-guard.mjs: host must be exactly 127.0.0.1 or localhost).
function assertLocalUrl(label, value) {
  let host;
  try { host = new URL(value).hostname; } catch { throw new Error(`${label} is not a URL`); }
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`REFUSED: ${label} host is not local`);
}

// ---- PNG decode (8-bit, color type 2 or 6, non-interlaced) ----
function readPng(file) {
  const b = readFileSync(file);
  if (b.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("not a PNG");
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20), depth = b[24], ct = b[25], il = b[28];
  return { buf: b, w, h, depth, ct, il };
}
function pixels(png) {
  const { buf, w, h, depth, ct, il } = png;
  if (depth !== 8 || (ct !== 2 && ct !== 6) || il !== 0) throw new Error("unsupported PNG format");
  const bpp = ct === 2 ? 3 : 4;
  const idat = [];
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o), type = buf.subarray(o + 4, o + 8).toString();
    if (type === "IDAT") idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp, out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0, up = y ? out[dst - stride + x] : 0;
      const c = x >= bpp && y ? out[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      out[dst + x] = v & 255;
    }
  }
  return { data: out, bpp, w, h };
}
function markWithinSafeZone(file) {
  const { data, bpp, w, h } = pixels(readPng(file));
  const bg = [data[0], data[1], data[2]];
  const cx = w / 2, cy = h / 2, limit = 0.4 * Math.min(w, h);
  let maxD = 0, count = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * bpp;
    if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 30) {
      count++; maxD = Math.max(maxD, Math.hypot(x + 0.5 - cx, y + 0.5 - cy));
    }
  }
  return { count, maxD, limit };
}

// ---- static checks ----
let manifest = null, scopePath = "/";
try { manifest = JSON.parse(readFileSync(MANIFEST, "utf8")); } catch (e) { fail(`manifest does not parse: ${e.message}`); }
if (manifest) {
  for (const k of ["name", "short_name", "start_url", "scope"]) ok(typeof manifest[k] === "string" && manifest[k], `manifest.${k} missing`);
  ok(manifest.display === "standalone", `manifest.display is ${JSON.stringify(manifest.display)}, want "standalone"`);
  ok(String(manifest.theme_color).toLowerCase() === INK, `manifest.theme_color is ${manifest.theme_color}, want ${INK}`);
  ok(String(manifest.background_color).toLowerCase() === INK, `manifest.background_color is ${manifest.background_color}, want ${INK}`);
  if (manifest.start_url && manifest.scope) {
    const base = "https://x.invalid";
    const s = new URL(manifest.scope, base), st = new URL(manifest.start_url, base);
    scopePath = s.pathname;
    ok(st.pathname.startsWith(s.pathname), `start_url ${manifest.start_url} is outside scope ${manifest.scope}`);
  }
  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  ok(icons.length > 0, "manifest.icons missing");
  const has = (size, purpose) => icons.some((i) => i.sizes === size && (i.purpose || "any").split(/\s+/).includes(purpose));
  ok(has("192x192", "any"), "no 192x192 purpose any icon");
  ok(has("512x512", "any"), "no 512x512 purpose any icon");
  ok(has("512x512", "maskable"), "no 512x512 maskable icon");
  for (const i of icons) {
    const file = join(PUBLIC, String(i.src || "").replace(/^\//, ""));
    if (!existsSync(file)) { fail(`icon file missing: ${i.src}`); continue; }
    try {
      const p = readPng(file), [dw, dh] = String(i.sizes).split("x").map(Number);
      ok(p.w === dw && p.h === dh, `icon ${i.src} is really ${p.w}x${p.h}, declared ${i.sizes}`);
      if ((i.purpose || "").split(/\s+/).includes("maskable")) {
        const z = markWithinSafeZone(file);
        ok(z.count > 0, `maskable icon ${i.src} has no visible mark`);
        ok(z.maxD <= z.limit, `maskable icon ${i.src} mark reaches ${z.maxD.toFixed(1)}px from centre, safe zone limit ${z.limit.toFixed(1)}px`);
      }
    } catch (e) { fail(`icon ${i.src}: ${e.message}`); }
  }
}
const apple = join(PUBLIC, "icons", "apple-touch-icon-180.png");
if (!existsSync(apple)) fail("apple-touch-icon 180x180 file missing (public/icons/apple-touch-icon-180.png)");
else { const p = readPng(apple); ok(p.w === 180 && p.h === 180, `apple-touch-icon is ${p.w}x${p.h}, want 180x180`); }
const sw = existsSync(join(PUBLIC, "sw.js"));
ok(sw, "public/sw.js missing");

// ---- runtime checks ----
async function waitUp(base, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(base + "/manifest.webmanifest", { redirect: "manual" }); if (r.status === 200) return true; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
async function runtime() {
  const sb = Object.fromEntries(execFileSync("supabase", ["status", "-o", "env"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").map((l) => l.match(/^([A-Z0-9_]+)="?(.*?)"?$/)).filter(Boolean).map((m) => [m[1], m[2]]));
  assertLocalUrl("local Supabase API_URL", sb.API_URL);
  const dist = `.next-${PORT}`;
  const env = {
    ...process.env, NODE_ENV: "production", NEXT_DIST_DIR: dist,
    NEXT_PUBLIC_SUPABASE_URL: sb.API_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: sb.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: sb.SERVICE_ROLE_KEY,
  };
  assertLocalUrl("NEXT_PUBLIC_SUPABASE_URL", env.NEXT_PUBLIC_SUPABASE_URL);
  const next = join(ROOT, "node_modules", ".bin", "next");
  if (!REUSE || !existsSync(join(ROOT, dist, "BUILD_ID"))) {
    try { execFileSync(next, ["build"], { cwd: ROOT, env, stdio: "pipe", maxBuffer: 256 * 1024 * 1024 }); }
    catch (e) { fail("next build failed: " + String(e.stdout || e.message).split("\n").slice(-8).join(" | ")); return; }
  }
  // A foreign process already on the port would answer the probes and fake a pass: refuse.
  try { await fetch(`http://127.0.0.1:${PORT}/`, { redirect: "manual" }); fail(`port ${PORT} is already in use, refusing to test another process`); return; } catch {}
  const server = spawn(next, ["start", "-p", String(PORT), "-H", "127.0.0.1"], { cwd: ROOT, env, stdio: "ignore" });
  const base = `http://127.0.0.1:${PORT}`;
  try {
    if (!(await waitUp(base, 60000))) { fail(`app did not start on port ${PORT}`); return; }
    const r = await fetch(base + "/sw.js", { redirect: "manual" });
    ok(r.status === 200, `/sw.js status ${r.status}, want 200`);
    ok(/javascript/i.test(r.headers.get("content-type") || ""), `/sw.js content-type is ${r.headers.get("content-type")}, want JavaScript`);
    const mr = await fetch(base + "/manifest.webmanifest", { redirect: "manual" });
    ok(mr.status === 200, `/manifest.webmanifest status ${mr.status}`);

    const html = await (await fetch(base + "/login")).text();
    const link = html.match(/<link[^>]*rel="apple-touch-icon"[^>]*>/i)?.[0];
    if (!ok(link, "no apple-touch-icon link in /login head")) { /* skip */ }
    else {
      const href = link.match(/href="([^"]+)"/)?.[1] || "";
      ok(/sizes="180x180"/.test(link), "apple-touch-icon link does not declare sizes 180x180");
      const ir = await fetch(base + href);
      ok(ir.status === 200, `apple-touch-icon ${href} served ${ir.status}`);
      if (ir.status === 200) { const buf = Buffer.from(await ir.arrayBuffer()); ok(buf.readUInt32BE(16) === 180 && buf.readUInt32BE(20) === 180, `served apple-touch-icon ${href} is not 180x180`); }
    }
    ok(/<meta[^>]*name="theme-color"[^>]*content="#020814"/i.test(html), "no theme-color meta #020814 in /login head");

    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      let chain = 0;
      page.on("request", (q) => { if (q.isNavigationRequest()) chain++; });
      try { await page.goto(base + "/", { waitUntil: "load", timeout: 30000 }); }
      catch (e) { fail(`navigation to / failed (redirect loop?): ${String(e.message).split("\n")[0]}`); return; }
      ok(chain <= 4, `too many navigation requests (${chain}), possible redirect loop`);
      ok(new URL(page.url()).pathname === "/login", `unauthenticated / ended at ${new URL(page.url()).pathname}, want /login`);
      const mlink = await page.locator('head link[rel="manifest"]').getAttribute("href");
      if (!ok(mlink, "/login head has no manifest link")) return;
      ok(new URL(mlink, base).pathname === "/manifest.webmanifest", `manifest link href is ${mlink}`);
      const reg = await page.evaluate(async () => {
        if (!("serviceWorker" in navigator)) return { error: "no serviceWorker support" };
        const t = new Promise((res) => setTimeout(() => res({ error: "serviceWorker.ready timed out" }), 15000));
        const r = navigator.serviceWorker.ready.then((x) => ({ scope: x.scope, active: !!x.active }));
        return Promise.race([r, t]);
      });
      if (!ok(!reg.error, `service worker: ${reg.error}`)) return;
      const rs = new URL(reg.scope);
      ok(rs.origin === base && rs.pathname.startsWith(scopePath), `registration scope ${reg.scope} is outside manifest scope ${scopePath}`);
      console.log(`runtime: sw scope ${reg.scope}, manifest link ${mlink}, final url ${page.url()}, nav requests ${chain}`);
    } finally { await browser.close(); }
  } finally {
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    if (server.exitCode === null) server.kill("SIGKILL");
    if (!REUSE) rmSync(join(ROOT, dist), { recursive: true, force: true });
  }
}
if (!STATIC_ONLY) {
  try { await runtime(); } catch (e) { fail("runtime check crashed: " + e.message); }
}
if (fails.length) { console.log("PWA_FAIL"); for (const f of fails) console.log(" - " + f); process.exit(1); }
console.log("PWA_OK");
