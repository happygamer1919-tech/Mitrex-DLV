import { devices, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { deflateSync } from "node:zlib";
import { BASE_URL, localEnv } from "./env";
import { assertLocalUrl } from "./guard";
import { CARRIER_A, stateFile, type Who } from "./users";

type Viewport = { width: number; height: number };

// Context options for the engine of this browser. The webkit project is the iPhone 13 profile.
// (browser.newContext does not inherit the project's `use`, so it is rebuilt here.)
function engineOptions(browser: Browser) {
  const engine = browser.browserType().name();
  const d = engine === "webkit" ? devices["iPhone 13"] : devices["Desktop Chrome"];
  const { defaultBrowserType: _ignored, ...rest } = d;
  void _ignored;
  return { engine, options: rest };
}

export async function as(browser: Browser, who: Who, viewport?: Viewport): Promise<{ ctx: BrowserContext; page: Page }> {
  const { engine, options } = engineOptions(browser);
  const ctx = await browser.newContext({
    ...options,
    storageState: stateFile(engine, who),
    baseURL: BASE_URL,
    ...(viewport ? { viewport } : {}),
  });
  return { ctx, page: await ctx.newPage() };
}

// A fresh, signed-out context for the engine (login scenarios).
export async function anon(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const { options } = engineOptions(browser);
  const ctx = await browser.newContext({ ...options, baseURL: BASE_URL });
  return { ctx, page: await ctx.newPage() };
}

export function adminClient() {
  const e = localEnv();
  assertLocalUrl(e.NEXT_PUBLIC_SUPABASE_URL, "supabase url");
  return createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

// 1x1 PNG, enough for the client side canvas compression path.
export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export function isoDate(daysAhead: number): string {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  return d.toISOString().slice(0, 10);
}

// Unique per run and per call, so tests never collide on an accumulating database.
let seq = 0;
export function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${process.pid}-${seq}`.toUpperCase();
}

export type SeedStatus = "requested" | "booked" | "at_pickup" | "loading" | "enroute" | "at_delivery" | "delivered" | "cancelled";

// Inserts a load directly (service role, no JWT: the guard triggers allow it). Default: a booked load
// for E2E carrier A, created by Maria. Returns the id and the load number.
export async function insertLoad(opts: {
  po: string; status?: SeedStatus; carrier?: boolean; pickupDate?: string; eta?: string | null; notes?: string;
}): Promise<{ id: string; loadNumber: string }> {
  const db = adminClient();
  const status = opts.status ?? "booked";
  const withCarrier = opts.carrier ?? status !== "requested";
  const [{ data: cust }, { data: car }, { data: maria }, { data: pu }, { data: de }] = await Promise.all([
    db.from("customers").select("id").eq("name", "Mitrex").single(),
    db.from("carriers").select("id").eq("name", CARRIER_A).single(),
    db.from("profiles").select("id").eq("email", "maria@e2e.test").single(),
    db.from("locations").select("id").eq("name", "Mitrex").single(),
    db.from("locations").select("id").eq("name", "Howden").single(),
  ]);
  const pickup = opts.pickupDate ?? isoDate(2);
  const eta = opts.eta !== undefined ? opts.eta : status === "enroute" || status === "at_delivery" ? new Date(Date.now() + 6 * 3_600_000).toISOString() : null;
  const { data, error } = await db.from("loads").insert({
    customer_id: cust!.id, created_by: maria!.id, pickup_location_id: pu!.id, delivery_location_id: de!.id,
    equipment_size: 48, pickup_timing: "appointment", pickup_date: pickup, pickup_time_start: "08:00",
    delivery_timing: "appointment", delivery_date: pickup, delivery_time_start: "14:00",
    pickup_contact_name: "Pat", pickup_contact_phone: "416-555-0101",
    delivery_contact_name: "Dee", delivery_contact_phone: "416-555-0102",
    po_number: opts.po, notes: opts.notes ?? null, status,
    carrier_id: withCarrier ? car!.id : null, eta,
  }).select("id,load_number").single();
  if (error) throw error;
  return { id: data.id as string, loadNumber: data.load_number as string };
}

export async function insertBookedLoad(po: string): Promise<string> {
  return (await insertLoad({ po, status: "booked" })).id;
}

export async function loadRow(id: string) {
  const { data, error } = await adminClient().from("loads").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Record<string, unknown>;
}

// Moves a load straight to a status as the service role (setup only, never the thing under test).
export async function forceStatus(id: string, status: SeedStatus) {
  const db = adminClient();
  const { data: car } = await db.from("carriers").select("id").eq("name", CARRIER_A).single();
  const { error } = await db.from("loads").update({ status, carrier_id: car!.id }).eq("id", id);
  if (error) throw error;
}

// ---- binary helpers -------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// RGB PNG, a smooth gradient plus 2 bits of noise per byte: several MB as PNG, much smaller as JPEG.
export function makeNoisePng(width: number, height: number): Buffer {
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  let s = 0x9e3779b9;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      const o = row + 1 + x * 3;
      raw[o] = ((x * 255) / width + (s & 3)) & 0xff;
      raw[o + 1] = ((y * 255) / height + ((s >>> 2) & 3)) & 0xff;
      raw[o + 2] = (128 + ((s >>> 4) & 3)) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 1 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Decodes the pixel size from the JPEG SOF marker. Returns null when the bytes are not a JPEG.
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

// RFC 4180 parser (quotes, doubled quotes, commas and newlines inside quoted cells, CRLF).
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\r" || c === "\n") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

export async function readDownload(download: { createReadStream(): Promise<NodeJS.ReadableStream | null> }): Promise<Buffer> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("download has no stream");
  const parts: Buffer[] = [];
  for await (const p of stream) parts.push(Buffer.from(p as Buffer));
  return Buffer.concat(parts);
}

// "2031-05-04T17:47" wall clock in Eastern time for an ISO instant (independent of the app's helpers).
export function easternLocal(iso: string): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}
