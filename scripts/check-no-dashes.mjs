import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const BAD = String.fromCharCode(8212, 8211).split("");
const SKIP = new Set(["node_modules", ".next", ".next-e2e", ".git", ".unlazy", ".vercel", ".temp", "test-results", "playwright-report", ".auth"]);
const EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".css", ".json", ".md", ".sql", ".toml", ".webmanifest", ".html", ".txt", ".example", ".yml", ".yaml", ".svg", ""]);
const root = process.argv[2] || ".";
const hits = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".next") || name === ".claude" || name === "package-lock.json") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (EXT.has(extname(name))) {
      const lines = readFileSync(p, "utf8").split("\n");
      lines.forEach((l, i) => {
        if (BAD.some((c) => l.includes(c))) hits.push(`${p}:${i + 1}`);
      });
    }
  }
}
walk(root);
if (hits.length) {
  console.error("DASH_FOUND\n" + hits.join("\n"));
  process.exit(1);
}
console.log("GATE_OK");
