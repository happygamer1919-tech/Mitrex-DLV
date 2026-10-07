import { addDays, isValidDay } from "@/lib/admin/cal";
import { TZ } from "@/lib/format";
import { bolPending, type BoardLoad } from "@/lib/admin/queries";
import type { LoadStatus } from "@/lib/types";

// Board filters and sorting (R42). All state lives in the URL query string and is validated strictly:
// a bad value is ignored, never an error page.

export const STATUSES: LoadStatus[] = [
  "requested", "booked", "at_pickup", "loading", "enroute", "at_delivery", "delivered", "cancelled",
];
export const SIZES = [26, 36, 53] as const;
export const WHEN_VALUES = ["today", "tomorrow", "week", "custom"] as const;
export const SORT_KEYS = ["pickup_time", "shipper", "receiver", "carrier", "its_number", "size", "created"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type When = (typeof WHEN_VALUES)[number];
export type View = "status" | "list";

export type BoardFilters = {
  q: string;
  status: LoadStatus | "";
  carrier: string; // carrier id, "none" or ""
  shipper: string; // pickup location id or ""
  receiver: string; // delivery location id or ""
  size: number | 0;
  when: When | "";
  from: string; // custom range, YYYY-MM-DD or ""
  to: string;
  needsBol: boolean;
  needsIts: boolean;
  sort: SortKey;
  dir: "asc" | "desc";
  view: View;
};

type Raw = Record<string, string | string[] | undefined>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

export function easternToday(now: Date = new Date()): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return p; // en-CA formats as YYYY-MM-DD
}

export function parseFilters(raw: Raw): BoardFilters {
  const q = one(raw.q).trim().slice(0, 80);
  const status = STATUSES.find((s) => s === one(raw.status)) ?? "";
  const carrier = one(raw.carrier);
  const shipper = one(raw.shipper);
  const receiver = one(raw.receiver);
  const size = SIZES.find((s) => String(s) === one(raw.size)) ?? 0;
  const when = WHEN_VALUES.find((w) => w === one(raw.when)) ?? "";
  let from = one(raw.from);
  let to = one(raw.to);
  if (!isValidDay(from)) from = "";
  if (!isValidDay(to)) to = "";
  if (from && to && from > to) [from, to] = [to, from];
  const sort = SORT_KEYS.find((k) => k === one(raw.sort)) ?? "pickup_time";
  return {
    q,
    status,
    carrier: carrier === "none" || UUID.test(carrier) ? carrier : "",
    shipper: UUID.test(shipper) ? shipper : "",
    receiver: UUID.test(receiver) ? receiver : "",
    size,
    // A custom range with no valid dates is meaningless: drop it.
    when: when === "custom" && !from && !to ? "" : when,
    from: when === "custom" ? from : "",
    to: when === "custom" ? to : "",
    needsBol: one(raw.bol) === "1",
    needsIts: one(raw.its) === "1",
    sort,
    dir: one(raw.dir) === "desc" ? "desc" : "asc",
    view: one(raw.view) === "list" ? "list" : "status",
  };
}

export function isFiltered(f: BoardFilters): boolean {
  return Boolean(f.q || f.status || f.carrier || f.shipper || f.receiver || f.size || f.when || f.needsBol || f.needsIts);
}

// Query string for a filter set (defaults are omitted so URLs stay short).
export function toQuery(f: BoardFilters): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.status) p.set("status", f.status);
  if (f.carrier) p.set("carrier", f.carrier);
  if (f.shipper) p.set("shipper", f.shipper);
  if (f.receiver) p.set("receiver", f.receiver);
  if (f.size) p.set("size", String(f.size));
  if (f.when) p.set("when", f.when);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.needsBol) p.set("bol", "1");
  if (f.needsIts) p.set("its", "1");
  if (f.sort !== "pickup_time") p.set("sort", f.sort);
  if (f.dir === "desc") p.set("dir", "desc");
  if (f.view === "list") p.set("view", "list");
  const s = p.toString();
  return s ? `?${s}` : "";
}

function whenRange(f: BoardFilters, today: string): [string, string] | null {
  if (f.when === "today") return [today, today];
  if (f.when === "tomorrow") { const t = addDays(today, 1); return [t, t]; }
  if (f.when === "week") return [today, addDays(today, 6)];
  if (f.when === "custom") return [f.from || "0000-01-01", f.to || "9999-12-31"];
  return null;
}

export function matches(l: BoardLoad, f: BoardFilters, today: string): boolean {
  if (f.status && l.status !== f.status) return false;
  if (f.carrier === "none" ? l.carrier_id !== null : f.carrier ? l.carrier_id !== f.carrier : false) return false;
  if (f.shipper && l.pickup_location_id !== f.shipper) return false;
  if (f.receiver && l.delivery_location_id !== f.receiver) return false;
  if (f.size && l.equipment_size !== f.size) return false;
  const r = whenRange(f, today);
  if (r && (l.pickup_date < r[0] || l.pickup_date > r[1])) return false;
  if (f.needsBol && !bolPending(l)) return false;
  if (f.needsIts && !(l.its_load_number === null || l.its_load_number.trim() === "") ) return false;
  if (f.q) {
    const hay = [
      l.its_load_number, l.load_number, l.po_number, l.pickup?.name, l.delivery?.name, l.carrier?.name,
    ].filter(Boolean).join("\n").toLowerCase();
    if (!f.q.toLowerCase().split(/\s+/).every((t) => hay.includes(t))) return false;
  }
  return true;
}

// Missing values sort last in both directions.
function cmp<T extends string | number>(a: T | null | undefined, b: T | null | undefined, dir: 1 | -1): number {
  const an = a === null || a === undefined || a === "";
  const bn = b === null || b === undefined || b === "";
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  return (a < b ? -1 : a > b ? 1 : 0) * dir;
}

export function sortLoads(list: BoardLoad[], f: BoardFilters): BoardLoad[] {
  const dir = f.dir === "desc" ? -1 : 1;
  const key = (l: BoardLoad): string | number | null => {
    switch (f.sort) {
      case "shipper": return l.pickup?.name.toLowerCase() ?? null;
      case "receiver": return l.delivery?.name.toLowerCase() ?? null;
      case "carrier": return l.carrier?.name.toLowerCase() ?? null;
      case "its_number": return l.its_load_number?.trim().toLowerCase() || null;
      case "size": return l.equipment_size;
      case "created": return l.created_at ?? null;
      default: return `${l.pickup_date} ${l.pickup_time_start}`; // a window sorts by its start
    }
  };
  // Stable tie-breaks: pickup date and start, then load number.
  return [...list].sort((a, b) =>
    cmp(key(a), key(b), dir)
    || cmp(`${a.pickup_date} ${a.pickup_time_start}`, `${b.pickup_date} ${b.pickup_time_start}`, 1)
    || cmp(a.load_number, b.load_number, 1));
}

export function applyFilters(loads: BoardLoad[], f: BoardFilters, today: string): BoardLoad[] {
  return sortLoads(loads.filter((l) => matches(l, f, today)), f);
}
