// Every requirement "- R<n> " in docs/SPEC.md must have a row in docs/SPEC-COVERAGE.md:
//   | R<n> | requirement | evidence | note |
// Evidence is one or more existing repo paths separated by semicolons, each optionally followed by
// " :: name". The name must occur verbatim in that file (a test title, an rls.sql section header, a
// gate id), so evidence cannot rot when a test is renamed or removed. Or the evidence cell starts with
// GAP and the note names the card or the docs/QUESTIONS.md entry that tracks it.
// Prints COVERAGE_OK or COVERAGE_FAIL plus the offending R-numbers (exit 1 on fail). Reads no secrets.
//
// Usage: node scripts/check-spec-coverage.mjs [--coverage <path>] [--spec <path>]
//   --coverage and --spec point at alternative files (used to prove the checker fails on bad input).
import { existsSync, readFileSync, statSync } from "node:fs";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const specPath = arg("--spec", "docs/SPEC.md");
const coveragePath = arg("--coverage", "docs/SPEC-COVERAGE.md");
const questionsPath = "docs/QUESTIONS.md";

function fail(lines) {
  console.log("COVERAGE_FAIL\n" + lines.join("\n"));
  process.exit(1);
}

let spec = "";
try {
  spec = readFileSync(specPath, "utf8");
} catch {
  fail([`${specPath} is missing`]);
}
const required = [...spec.matchAll(/^- (R\d+) /gm)].map((m) => m[1]);
if (required.length === 0) fail([`no R-numbers found in ${specPath}`]);

let doc = "";
try {
  doc = readFileSync(coveragePath, "utf8");
} catch {
  fail([`${coveragePath} is missing`]);
}

const rows = new Map();
const problems = [];
for (const line of doc.split("\n")) {
  const cells = line.split("|").map((c) => c.trim());
  if (cells.length < 5 || !/^R\d+$/.test(cells[1])) continue;
  if (rows.has(cells[1])) problems.push(`${cells[1]}: more than one row`);
  rows.set(cells[1], { requirement: cells[2], evidence: cells[3], note: cells[4] ?? "" });
}

const cache = new Map();
function textOf(path) {
  if (!cache.has(path)) cache.set(path, readFileSync(path, "utf8"));
  return cache.get(path);
}
const questions = existsSync(questionsPath) ? readFileSync(questionsPath, "utf8") : "";

let covered = 0;
let gaps = 0;
for (const r of required) {
  const row = rows.get(r);
  if (!row) {
    problems.push(`${r}: no row in ${coveragePath}`);
    continue;
  }
  const ev = row.evidence.replace(/`/g, "");
  if (!ev) {
    problems.push(`${r}: empty evidence`);
    continue;
  }
  // Any note may cite a QUESTIONS entry ("QUESTIONS: <heading text>"): it must exist in docs/QUESTIONS.md.
  const ref = /QUESTIONS:\s*(.+?)(?:\.|$)/i.exec(row.note);
  if (ref && !questions.includes(ref[1].trim())) {
    problems.push(`${r}: note cites a QUESTIONS entry that does not exist: ${ref[1].trim()}`);
    continue;
  }
  if (/^GAP\b/i.test(ev)) {
    if (!row.note) {
      problems.push(`${r}: GAP row needs a note naming the card or the QUESTIONS entry`);
      continue;
    }
    gaps++;
    continue;
  }
  let ok = true;
  for (const entry of ev.split(";").map((e) => e.trim()).filter(Boolean)) {
    const [path, ...rest] = entry.split(" :: ");
    const name = rest.join(" :: ").trim();
    if (!existsSync(path) || !statSync(path).isFile()) {
      problems.push(`${r}: evidence path not found: ${path}`);
      ok = false;
      continue;
    }
    if (name && !textOf(path).includes(name)) {
      problems.push(`${r}: "${name}" does not occur in ${path}`);
      ok = false;
    }
  }
  if (ok) covered++;
}
for (const r of rows.keys()) if (!required.includes(r)) problems.push(`${r}: row has no matching requirement in ${specPath}`);

console.log(`requirements=${required.length} covered=${covered} gaps=${gaps}`);
if (problems.length) fail(problems);
console.log("COVERAGE_OK");
