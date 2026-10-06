// Request again and last contact hints (R20, R22). Pure (no Next imports) and relative imports only, so the e2e
// specs can load this file directly.
import type { Load } from "../types";
import { EMPTY_LOAD_FORM, type LoadFormValues } from "./validate";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The "from" query value is untrusted: only a single well formed lowercase uuid passes.
export function parseFromParam(v: unknown): string | null {
  return typeof v === "string" && UUID_RE.test(v) ? v : null;
}

// A multi-truck booking writes "Truck i of N" as the first line of the notes. A copy must not carry it, because the
// new booking writes its own. Only a first line of exactly that shape is removed.
export function stripTruckLine(notes: string | null): string {
  if (!notes) return "";
  const m = /^Truck \d+ of \d+[ \t]*(?:\r?\n|$)/.exec(notes);
  return m ? notes.slice(m[0].length) : notes;
}

// Form values for a Request again. Everything is copied except ALL dates and times, which stay empty. The timing
// type (appointment or window) is kept. A location that can no longer be chosen is cleared with its contact.
export function requestAgainValues(
  l: Load, opts: { pickupOk: boolean; deliveryOk: boolean },
): LoadFormValues {
  return {
    ...EMPTY_LOAD_FORM,
    pickup_location_id: opts.pickupOk ? l.pickup_location_id : "",
    delivery_location_id: opts.deliveryOk ? l.delivery_location_id : "",
    pickup_contact_name: opts.pickupOk ? l.pickup_contact_name : "",
    pickup_contact_phone: opts.pickupOk ? l.pickup_contact_phone : "",
    delivery_contact_name: opts.deliveryOk ? l.delivery_contact_name : "",
    delivery_contact_phone: opts.deliveryOk ? l.delivery_contact_phone : "",
    equipment_size: ["26", "36", "53"].includes(String(l.equipment_size)) ? String(l.equipment_size) : "",
    moffett: l.moffett,
    pickup_timing: l.pickup_timing,
    delivery_timing: l.delivery_timing,
    weight_lbs: l.weight_lbs == null ? "" : String(l.weight_lbs),
    pieces: l.pieces == null ? "" : String(l.pieces),
    po_number: l.po_number ?? "",
    notes: stripTruckLine(l.notes),
  };
}

export type HistoryRow = Pick<Load,
  "id" | "load_number" | "created_at" | "pickup_location_id" | "delivery_location_id" |
  "pickup_contact_name" | "pickup_contact_phone" | "delivery_contact_name" | "delivery_contact_phone">;

export const HISTORY_COLUMNS =
  "id,load_number,created_at,pickup_location_id,delivery_location_id,pickup_contact_name,pickup_contact_phone,delivery_contact_name,delivery_contact_phone";
export const HISTORY_LIMIT = 200;

export type LastContact = { name: string; phone: string; loadNumber: string; createdAt: string };
export type LastContacts = { pickup: Record<string, LastContact>; delivery: Record<string, LastContact> };

// Rows (any order) of the customer's recent loads -> the most recent contact per location, by created_at desc.
export function buildLastContacts(rows: HistoryRow[]): LastContacts {
  const out: LastContacts = { pickup: {}, delivery: {} };
  // created_at desc. Loads inserted together (a multi-truck booking) share one created_at: the higher load number wins.
  const num = (n: string) => Number(/(\d+)$/.exec(n)?.[1] ?? 0);
  const sorted = rows.slice().sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : num(b.load_number) - num(a.load_number));
  for (const r of sorted) {
    if (!out.pickup[r.pickup_location_id]) {
      out.pickup[r.pickup_location_id] = { name: r.pickup_contact_name, phone: r.pickup_contact_phone, loadNumber: r.load_number, createdAt: r.created_at };
    }
    if (!out.delivery[r.delivery_location_id]) {
      out.delivery[r.delivery_location_id] = { name: r.delivery_contact_name, phone: r.delivery_contact_phone, loadNumber: r.load_number, createdAt: r.created_at };
    }
  }
  return out;
}
