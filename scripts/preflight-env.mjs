// Validates env VALUE SHAPES. Prints only variable names and OK or BAD, never values.
// Usage: set -o allexport; source ~/.zshenvmitrex; set +o allexport; node scripts/preflight-env.mjs
const e = process.env;
const checks = [
  ["NEXT_PUBLIC_SUPABASE_URL", (v) => /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(v)],
  ["SUPABASE_SERVICE_ROLE_KEY", (v) => /^(eyJ|sb_secret_)/.test(v) && !v.includes("://")],
  ["DATABASE_URL_DIRECT", (v) => /^postgres(ql)?:\/\//.test(v)],
  ["RESEND_API_KEY", (v) => v.startsWith("re_")],
  ["NEXT_PUBLIC_SITE_URL", (v) => v === "https://portal.dlvlogistics.com"],
  ["NOTIFY_FROM", (v) => v.length > 0],
];
let bad = 0;
for (const [name, ok] of checks) {
  const good = ok(e[name] || "");
  if (!good) bad++;
  console.log(`${name}: ${good ? "OK" : "BAD"}`);
}
if (bad) {
  console.log(`PREFLIGHT_BAD ${bad}`);
  process.exit(1);
}
console.log("PREFLIGHT_OK");
