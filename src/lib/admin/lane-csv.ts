// Lane reference CSV: export text and import validation. Pure (no server or client imports besides relative helpers)
// so the same code previews in the browser and re-validates on the server before anything is written.
import { csvRow } from "./csv";

export const LANE_CSV_COLUMNS = ["shipper", "receiver", "truck_size", "load_to_copy", "note"] as const;
export const MAX_IMPORT_ROWS = 500;
export const MAX_IMPORT_CHARS = 200_000;
const SIZES = new Set([26, 36, 53]);
const NUMBER_RE = /^[0-9]+(-[0-9]+)?$/;
const NOTE_MAX = 500;

export type LocRef = { id: string; name: string };

export type LaneCsvRow = { shipper: string; receiver: string; truck_size: number; load_to_copy: string; note: string | null };

export function lanesToCsv(rows: LaneCsvRow[]): string {
  const lines = [LANE_CSV_COLUMNS.join(",")];
  for (const r of rows) lines.push(csvRow([r.shipper, r.receiver, r.truck_size, r.load_to_copy, r.note ?? ""]));
  return lines.join("\r\n") + "\r\n";
}

// RFC 4180 parser with a delimiter chosen from the first line: a tab (pasted from a spreadsheet) or a comma.
export function parseDelimited(input: string): string[][] {
  const s = input.replace(/^﻿/, "");
  const firstLine = s.split(/\r\n|\n|\r/, 1)[0] ?? "";
  const d = firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell === "") q = true;
    else if (c === d) { row.push(cell); cell = ""; }
    else if (c === "\r" || c === "\n") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

export type PreviewRow = {
  line: number; // 1 based line of the file (the header is line 1)
  shipper: string; receiver: string; size: string; number: string; note: string;
  errors: string[];
  pickupId?: string; deliveryId?: string; sizeNum?: number;
};
export type Preview = { rows: PreviewRow[]; fileErrors: string[]; valid: boolean };

function matcher(locations: LocRef[]) {
  const exact = new Map<string, LocRef[]>();
  const folded = new Map<string, LocRef[]>();
  for (const l of locations) {
    const a = exact.get(l.name) ?? []; a.push(l); exact.set(l.name, a);
    const k = l.name.trim().toLowerCase();
    const b = folded.get(k) ?? []; b.push(l); folded.set(k, b);
  }
  return (raw: string): { loc?: LocRef; error?: string } => {
    const name = raw.trim();
    if (!name) return { error: "is empty" };
    const e = exact.get(name);
    if (e && e.length === 1) return { loc: e[0] };
    const f = folded.get(name.toLowerCase());
    if (f && f.length === 1) return { loc: f[0] };
    if ((e && e.length > 1) || (f && f.length > 1)) return { error: `matches more than one location ("${name}")` };
    return { error: `is not a known location ("${name}")` };
  };
}

// A leading apostrophe that the export adds in front of = + - @ is taken off again.
const unprotect = (v: string) => (/^'[=+\-@]/.test(v) ? v.slice(1) : v);

export function validateLaneImport(text: string, locations: LocRef[]): Preview {
  const fileErrors: string[] = [];
  if (text.length > MAX_IMPORT_CHARS) return { rows: [], fileErrors: ["The file is too large to import."], valid: false };
  const table = parseDelimited(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (table.length === 0) return { rows: [], fileErrors: ["No rows found. Paste or upload a CSV with the columns shipper, receiver, truck_size, load_to_copy, note."], valid: false };

  // Header: recognised by its first cell. Columns are then read by name, so their order does not matter.
  let idx = { shipper: 0, receiver: 1, size: 2, number: 3, note: 4 };
  let body = table;
  let firstLine = 1;
  const head = table[0].map((c) => c.trim().toLowerCase());
  if (head[0] === "shipper" || head.includes("load_to_copy")) {
    const at = (n: string) => head.indexOf(n);
    const missing = ["shipper", "receiver", "truck_size", "load_to_copy"].filter((n) => at(n) < 0);
    if (missing.length > 0) {
      return { rows: [], fileErrors: [`The header is missing the column(s): ${missing.join(", ")}.`], valid: false };
    }
    idx = { shipper: at("shipper"), receiver: at("receiver"), size: at("truck_size"), number: at("load_to_copy"), note: at("note") };
    body = table.slice(1);
    firstLine = 2;
  }
  if (body.length === 0) return { rows: [], fileErrors: ["The file has a header but no rows."], valid: false };
  if (body.length > MAX_IMPORT_ROWS) {
    return { rows: [], fileErrors: [`The file has ${body.length} rows. At most ${MAX_IMPORT_ROWS} rows can be imported at once.`], valid: false };
  }

  const find = matcher(locations);
  const seen = new Map<string, number>();
  const rows: PreviewRow[] = body.map((cells, i) => {
    const get = (k: number) => (k >= 0 ? (cells[k] ?? "").trim() : "");
    const r: PreviewRow = {
      line: firstLine + i,
      shipper: get(idx.shipper), receiver: get(idx.receiver), size: get(idx.size), number: get(idx.number), note: unprotect(get(idx.note)),
      errors: [],
    };
    const p = find(r.shipper);
    if (p.error) r.errors.push(`Shipper ${p.error}.`); else r.pickupId = p.loc!.id;
    const d = find(r.receiver);
    if (d.error) r.errors.push(`Receiver ${d.error}.`); else r.deliveryId = d.loc!.id;
    const sizeText = r.size.replace(/\s*ft$/i, "");
    if (/^\d+$/.test(sizeText) && SIZES.has(Number(sizeText))) r.sizeNum = Number(sizeText);
    else r.errors.push("Truck size must be 26, 36 or 53.");
    if (!r.number) r.errors.push("Load to copy is required.");
    else if (!NUMBER_RE.test(r.number) || r.number.length > 30) {
      r.errors.push("Load to copy must be digits, optionally with a dash and digits (for example 313 or 313-2), at most 30 characters.");
    }
    if (r.note.length > NOTE_MAX) r.errors.push(`Note is too long (at most ${NOTE_MAX} characters).`);
    if (r.pickupId && r.deliveryId && r.pickupId === r.deliveryId) r.errors.push("Shipper and receiver must be different locations.");
    if (r.pickupId && r.deliveryId && r.sizeNum && r.pickupId !== r.deliveryId) {
      const key = `${r.pickupId}|${r.deliveryId}|${r.sizeNum}`;
      const first = seen.get(key);
      if (first !== undefined) r.errors.push(`Duplicate of line ${first} (same shipper, receiver and truck size).`);
      else seen.set(key, r.line);
    }
    return r;
  });
  return { rows, fileErrors, valid: fileErrors.length === 0 && rows.every((r) => r.errors.length === 0) };
}
