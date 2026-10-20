import { addDays, isValidDay } from "@/lib/admin/cal";
import { TZ } from "@/lib/format";
import type { DocKind, LoadStatus } from "@/lib/types";

// Load list filters and sorting, shared by the staff board (R42, scope "staff") and Maria's /loads (R46, scope
// "customer"). All state lives in the URL query string and is validated strictly: a bad value is ignored, never an
// error page. The customer scope has no carrier filter, no Needs BOL or Needs ITS pills, no One list view and its own
// sort keys; whatever the URL says, those fields parse to their defaults for her.

export type Scope = "staff" | "customer";

export const STATUSES: LoadStatus[] = [
  "requested", "booked", "at_pickup", "loading", "enroute", "at_delivery", "delivered", "cancelled",
];
export const SIZES = [26, 36, 53] as const;
export const WHEN_VALUES = ["today", "tomorrow", "week", "custom"] as const;
export const SORT_KEYS = ["pickup_time", "shipper", "receiver", "carrier", "its_number", "size", "created"] as const;
export const CUSTOMER_SORT_KEYS = ["pickup_time", "created", "delivered", "shipper", "receiver"] as const;
export type SortKey = (typeof SORT_KEYS)[number] | (typeof CUSTOMER_SORT_KEYS)[number];
export type When = (typeof WHEN_VALUES)[number];
// "status" and "list" are the staff board views; "completed" is Maria's Completed quick view (delivered loads only).
export type View = "status" | "list" | "completed";

export const sortKeysFor = (scope: Scope): readonly SortKey[] => (scope === "staff" ? SORT_KEYS : CUSTOMER_SORT_KEYS);

export type LoadFilters = {
  q: string;
  status: LoadStatus | "";
  carrier: string; // carrier id, "none" or "" (staff only)
  shipper: string; // pickup location id or ""
  receiver: string; // delivery location id or ""
  size: number | 0;
  when: When | "";
  from: string; // custom range, YYYY-MM-DD or ""
  to: string;
  needsBol: boolean; // staff only
  needsIts: boolean; // staff only
  sort: SortKey;
  dir: "asc" | "desc";
  view: View;
};

// The fields a filter or a sort reads. Both the staff board rows and Maria's rows have them.
export type FilterLoad = {
  load_number: string;
  po_number: string | null;
  created_at: string | null;
  delivered_at?: string | null;
  its_load_number: string | null;
  status: LoadStatus;
  pickup_date: string;
  pickup_time_start: string;
  equipment_size: number;
  pickup_location_id: string;
  delivery_location_id: string;
  carrier_id: string | null;
  pickup: { name: string } | null;
  delivery: { name: string } | null;
  carrier: { name: string } | null;
  load_documents?: { kind: DocKind }[];
};

type Raw = Record<string, string | string[] | undefined>;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

export function easternToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now); // YYYY-MM-DD
}

export function parseFilters(raw: Raw, scope: Scope = "staff"): LoadFilters {
  const staff = scope === "staff";
  const q = one(raw.q).trim().slice(0, 80);
  const status = STATUSES.find((s) => s === one(raw.status)) ?? "";
  const carrier = staff ? one(raw.carrier) : "";
  const shipper = one(raw.shipper);
  const receiver = one(raw.receiver);
  const size = SIZES.find((s) => String(s) === one(raw.size)) ?? 0;
  const when = WHEN_VALUES.find((w) => w === one(raw.when)) ?? "";
  let from = one(raw.from);
  let to = one(raw.to);
  if (!isValidDay(from)) from = "";
  if (!isValidDay(to)) to = "";
  if (from && to && from > to) [from, to] = [to, from];
  const sort = sortKeysFor(scope).find((k) => k === one(raw.sort)) ?? "pickup_time";
  const view = one(raw.view);
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
    needsBol: staff && one(raw.bol) === "1",
    needsIts: staff && one(raw.its) === "1",
    sort,
    dir: one(raw.dir) === "desc" ? "desc" : "asc",
    view: staff ? (view === "list" ? "list" : "status") : (view === "completed" ? "completed" : "status"),
  };
}

export function isFiltered(f: LoadFilters): boolean {
  return Boolean(f.q || f.status || f.carrier || f.shipper || f.receiver || f.size || f.when || f.needsBol || f.needsIts);
}

// The filter set with every filter removed (sort and view kept): the target of "Clear all".
export function cleared(f: LoadFilters): LoadFilters {
  return { ...f, q: "", status: "", carrier: "", shipper: "", receiver: "", size: 0, when: "", from: "", to: "", needsBol: false, needsIts: false };
}

// Query string for a filter set (defaults are omitted so URLs stay short).
export function toQuery(f: LoadFilters): string {
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
  if (f.view !== "status") p.set("view", f.view);
  const s = p.toString();
  return s ? `?${s}` : "";
}

// A query string plus extra page parameters (the "Show older" and "Show more" counters of R46). Zero or empty values
// are left out.
export function withParams(query: string, extra: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === "" || v === 0) p.delete(k);
    else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

// A "how many more pages" counter from the URL: digits 1 to max only, anything else is 0 (ignored).
export function parsePages(v: string | string[] | undefined, max = 20): number {
  const s = one(v);
  if (!/^[1-9]\d?$/.test(s)) return 0;
  const n = Number(s);
  return n <= max ? n : 0;
}

export function whenRange(f: LoadFilters, today: string): [string, string] | null {
  if (f.when === "today") return [today, today];
  if (f.when === "tomorrow") { const t = addDays(today, 1); return [t, t]; }
  if (f.when === "week") return [today, addDays(today, 6)];
  if (f.when === "custom") return [f.from || "0000-01-01", f.to || "9999-12-31"];
  return null;
}

const BOL_EXPECTED: LoadStatus[] = ["booked", "at_pickup", "loading", "enroute", "at_delivery"];

export function bolPending(l: { status: LoadStatus; load_documents?: { kind: DocKind }[] }): boolean {
  return BOL_EXPECTED.includes(l.status) && !(l.load_documents ?? []).some((d) => d.kind === "bol");
}

export function searchTerms(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

export function matches(l: FilterLoad, f: LoadFilters, today: string): boolean {
  if (f.status && l.status !== f.status) return false;
  if (f.carrier === "none" ? l.carrier_id !== null : f.carrier ? l.carrier_id !== f.carrier : false) return false;
  if (f.shipper && l.pickup_location_id !== f.shipper) return false;
  if (f.receiver && l.delivery_location_id !== f.receiver) return false;
  if (f.size && l.equipment_size !== f.size) return false;
  const r = whenRange(f, today);
  if (r && (l.pickup_date < r[0] || l.pickup_date > r[1])) return false;
  if (f.needsBol && !bolPending(l)) return false;
  if (f.needsIts && !(l.its_load_number === null || l.its_load_number.trim() === "")) return false;
  if (f.q) {
    const hay = [
      l.its_load_number, l.load_number, l.po_number, l.pickup?.name, l.delivery?.name, l.carrier?.name,
    ].filter(Boolean).join("\n").toLowerCase();
    if (!searchTerms(f.q).every((t) => hay.includes(t))) return false;
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

export function sortLoads<T extends FilterLoad>(list: T[], f: Pick<LoadFilters, "sort" | "dir">): T[] {
  const dir = f.dir === "desc" ? -1 : 1;
  const key = (l: T): string | number | null => {
    switch (f.sort) {
      case "shipper": return l.pickup?.name.toLowerCase() ?? null;
      case "receiver": return l.delivery?.name.toLowerCase() ?? null;
      case "carrier": return l.carrier?.name.toLowerCase() ?? null;
      case "its_number": return l.its_load_number?.trim().toLowerCase() || null;
      case "size": return l.equipment_size;
      case "created": return l.created_at ?? null;
      case "delivered": return l.delivered_at ?? null;
      default: return `${l.pickup_date} ${l.pickup_time_start}`; // a window sorts by its start
    }
  };
  // Stable tie-breaks: pickup date and start, then load number.
  return [...list].sort((a, b) =>
    cmp(key(a), key(b), dir)
    || cmp(`${a.pickup_date} ${a.pickup_time_start}`, `${b.pickup_date} ${b.pickup_time_start}`, 1)
    || cmp(a.load_number, b.load_number, 1));
}

export function applyFilters<T extends FilterLoad>(loads: T[], f: LoadFilters, today: string): T[] {
  return sortLoads(loads.filter((l) => matches(l, f, today)), f);
}

// True while the sort is the default (pickup time, ascending). Finished groups (delivered, cancelled) then list the
// most recent first instead (R46); any sort the user picks applies to every group.
export const isDefaultSort = (f: Pick<LoadFilters, "sort" | "dir">): boolean => f.sort === "pickup_time" && f.dir === "asc";

// A search term that is safe to send to PostgREST inside an or() filter. A term with any other character is not
// pushed down (the query is then wider, never narrower) and the in-memory match above stays the authority.
const SAFE_TERM = /^[a-z0-9 ._-]{1,80}$/i;

// Minimal structural type of a PostgREST filter builder, so this module does not depend on supabase-js types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Builder = any;

// Narrows a query on loads with the filters that are plain columns, so a filtered list of finished loads is a
// bounded query of the matching rows instead of every delivered load (R46). `ids` are the location and carrier ids
// whose NAME contains each search term (resolved by the caller with ilike), so a term matches the same fields as
// matches() does. The result is always a superset of what matches() keeps; the page filters again in memory.
export function pushDown(q: Builder, f: LoadFilters, today: string, ids: Map<string, { locations: string[]; carriers: string[] }>): Builder {
  let b = q;
  if (f.status) b = b.eq("status", f.status);
  if (f.carrier === "none") b = b.is("carrier_id", null);
  else if (f.carrier) b = b.eq("carrier_id", f.carrier);
  if (f.shipper) b = b.eq("pickup_location_id", f.shipper);
  if (f.receiver) b = b.eq("delivery_location_id", f.receiver);
  if (f.size) b = b.eq("equipment_size", f.size);
  const r = whenRange(f, today);
  if (r) b = b.gte("pickup_date", r[0]).lte("pickup_date", r[1]);
  for (const t of searchTerms(f.q)) {
    const found = ids.get(t);
    if (!SAFE_TERM.test(t) || !found) continue; // not resolved: not pushed down (wider, never narrower)
    const parts = [`its_load_number.ilike.*${t}*`, `load_number.ilike.*${t}*`, `po_number.ilike.*${t}*`];
    if (found.locations.length > 0) {
      parts.push(`pickup_location_id.in.(${found.locations.join(",")})`, `delivery_location_id.in.(${found.locations.join(",")})`);
    }
    if (found.carriers.length > 0) parts.push(`carrier_id.in.(${found.carriers.join(",")})`);
    b = b.or(parts.join(","));
  }
  return b;
}

// Location and carrier ids whose name contains each safe search term (one query per table and term, at most a few).
export async function resolveSearchIds(sb: Builder, f: LoadFilters): Promise<Map<string, { locations: string[]; carriers: string[] }>> {
  const out = new Map<string, { locations: string[]; carriers: string[] }>();
  const terms = searchTerms(f.q).filter((t) => SAFE_TERM.test(t)).slice(0, 6);
  await Promise.all(terms.map(async (t) => {
    const [locs, cars] = await Promise.all([
      sb.from("locations").select("id").ilike("name", `%${t}%`).limit(200),
      sb.from("carriers").select("id").ilike("name", `%${t}%`).limit(200),
    ]);
    out.set(t, {
      locations: ((locs.data ?? []) as { id: string }[]).map((r) => r.id),
      carriers: ((cars.data ?? []) as { id: string }[]).map((r) => r.id),
    });
  }));
  return out;
}
