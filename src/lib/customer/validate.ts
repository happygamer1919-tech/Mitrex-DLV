import { todayEastern } from "@/lib/format";
import type { Timing } from "@/lib/types";

export type LoadFormValues = {
  pickup_location_id: string;
  delivery_location_id: string;
  pickup_contact_name: string;
  pickup_contact_phone: string;
  save_pickup_default: boolean;
  delivery_contact_name: string;
  delivery_contact_phone: string;
  save_delivery_default: boolean;
  equipment_size: string;
  moffett: boolean;
  pickup_timing: Timing;
  pickup_date: string;
  pickup_time_start: string;
  pickup_time_end: string;
  delivery_timing: Timing;
  delivery_date: string;
  delivery_time_start: string;
  delivery_time_end: string;
  weight_lbs: string;
  pieces: string;
  po_number: string;
  notes: string;
};

export type FieldErrors = Partial<Record<keyof LoadFormValues | "quantity", string>>;
export type ActionResult = { error?: string; fieldErrors?: FieldErrors; ok?: boolean };

export const EQUIPMENT_SIZES = [26, 36, 53] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// DLV-043 CUST-08: a weight typed the way the app shows it ("1,200" or "1 200") is a number. Only whole groups of
// three digits count as separators, so "1,5" stays invalid instead of silently becoming 15.
const GROUPED = /^\d{1,3}([, ]\d{3})+(\.\d+)?$/;
export function parseWeight(raw: string): number {
  const t = raw.trim();
  return Number(GROUPED.test(t) ? t.replace(/[, ]/g, "") : t);
}
const TIME_RE = /^\d{2}:\d{2}$/;

function checkSlot(
  v: LoadFormValues, side: "pickup" | "delivery", today: string, errors: FieldErrors, allowPast: boolean,
) {
  const label = side === "pickup" ? "Pickup" : "Delivery";
  const timing = v[`${side}_timing`];
  const date = v[`${side}_date`];
  const start = v[`${side}_time_start`];
  const end = v[`${side}_time_end`];
  if (timing !== "appointment" && timing !== "window") {
    errors[`${side}_timing`] = `Choose appointment or time window for ${label.toLowerCase()}.`;
  }
  const parsed = DATE_RE.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    errors[`${side}_date`] = `${label} date is required.`;
  }
  else if (!allowPast && date < today) errors[`${side}_date`] = `${label} date cannot be in the past (Eastern time).`;
  if (!TIME_RE.test(start)) {
    errors[`${side}_time_start`] = timing === "window" ? `${label} window start is required.` : `${label} appointment time is required.`;
  }
  if (timing === "window") {
    if (!TIME_RE.test(end)) errors[`${side}_time_end`] = `${label} window end is required.`;
    else if (TIME_RE.test(start) && end <= start) errors[`${side}_time_end`] = `${label} window end must be after the start.`;
  }
}

// Options of validateLoad. allowPast: staff edits (R44) may keep or set a past date (an in-progress or delivered load
// has past dates); every other rule stays, including delivery not before pickup and a window end after its start.
export type ValidateOptions = { allowPast?: boolean };

// Shared by the browser form and the server actions. Returns an empty object when valid.
export function validateLoad(v: LoadFormValues, today: string = todayEastern(), opts: ValidateOptions = {}): FieldErrors {
  const e: FieldErrors = {};
  // Server actions receive arbitrary input: reject anything that is not the expected shape.
  const bools: (keyof LoadFormValues)[] = ["save_pickup_default", "save_delivery_default", "moffett"];
  for (const key of Object.keys(EMPTY_LOAD_FORM) as (keyof LoadFormValues)[]) {
    const want = bools.includes(key) ? "boolean" : "string";
    if (typeof (v as Record<string, unknown>)?.[key] !== want) {
      return { notes: "The form data was invalid. Reload the page and try again." };
    }
  }
  if (!v.pickup_location_id) e.pickup_location_id = "Choose a pickup location.";
  if (!v.delivery_location_id) e.delivery_location_id = "Choose a delivery location.";
  if (v.pickup_location_id && v.pickup_location_id === v.delivery_location_id) {
    e.delivery_location_id = "Pickup and delivery must be different locations.";
  }
  if (!v.pickup_contact_name.trim()) e.pickup_contact_name = "Pickup contact name is required.";
  if (!v.pickup_contact_phone.trim()) e.pickup_contact_phone = "Pickup contact phone is required.";
  if (!v.delivery_contact_name.trim()) e.delivery_contact_name = "Delivery contact name is required.";
  if (!v.delivery_contact_phone.trim()) e.delivery_contact_phone = "Delivery contact phone is required.";
  if (!["26", "36", "53"].includes(v.equipment_size)) e.equipment_size = "Choose an equipment size.";
  const allowPast = opts.allowPast === true;
  checkSlot(v, "pickup", today, e, allowPast);
  checkSlot(v, "delivery", today, e, allowPast);
  if (!e.pickup_date && !e.delivery_date && v.delivery_date < v.pickup_date) {
    e.delivery_date = "Delivery date cannot be before the pickup date.";
  }
  // DLV-043 CUST-02: on the same day the delivery cannot end before the pickup starts. The latest delivery time is the
  // window end (or the appointment); an overlapping window stays allowed (start is not compared with start).
  if (!e.pickup_date && !e.delivery_date && v.delivery_date === v.pickup_date
      && !e.pickup_time_start && !e.delivery_time_start && !e.delivery_time_end) {
    const latest = v.delivery_timing === "window" ? v.delivery_time_end : v.delivery_time_start;
    if (TIME_RE.test(latest) && latest < v.pickup_time_start) {
      e.delivery_time_start = "Delivery time cannot be before the pickup time.";
    }
  }
  if (v.weight_lbs.trim()) {
    const w = parseWeight(v.weight_lbs);
    if (!Number.isFinite(w) || w <= 0 || w > 1000000) e.weight_lbs = "Weight must be a number greater than 0.";
  }
  if (v.pieces.trim()) {
    const p = Number(v.pieces);
    if (!Number.isInteger(p) || p <= 0 || p > 100000) e.pieces = "Pieces must be a whole number greater than 0.";
  }
  return e;
}

// Row shape written to the loads table (without customer_id and created_by).
export function toLoadRow(v: LoadFormValues, moffett: boolean) {
  const end = (timing: Timing, value: string) => (timing === "window" ? value : null);
  return {
    pickup_location_id: v.pickup_location_id,
    delivery_location_id: v.delivery_location_id,
    equipment_size: Number(v.equipment_size),
    moffett,
    weight_lbs: v.weight_lbs.trim() ? parseWeight(v.weight_lbs) : null,
    pieces: v.pieces.trim() ? Number(v.pieces) : null,
    po_number: v.po_number.trim() || null,
    notes: v.notes.trim() || null,
    pickup_timing: v.pickup_timing,
    pickup_date: v.pickup_date,
    pickup_time_start: v.pickup_time_start,
    pickup_time_end: end(v.pickup_timing, v.pickup_time_end),
    delivery_timing: v.delivery_timing,
    delivery_date: v.delivery_date,
    delivery_time_start: v.delivery_time_start,
    delivery_time_end: end(v.delivery_timing, v.delivery_time_end),
    pickup_contact_name: v.pickup_contact_name.trim(),
    pickup_contact_phone: v.pickup_contact_phone.trim(),
    delivery_contact_name: v.delivery_contact_name.trim(),
    delivery_contact_phone: v.delivery_contact_phone.trim(),
  };
}

export const EMPTY_LOAD_FORM: LoadFormValues = {
  pickup_location_id: "", delivery_location_id: "",
  pickup_contact_name: "", pickup_contact_phone: "", save_pickup_default: false,
  delivery_contact_name: "", delivery_contact_phone: "", save_delivery_default: false,
  equipment_size: "", moffett: false,
  pickup_timing: "appointment", pickup_date: "", pickup_time_start: "", pickup_time_end: "",
  delivery_timing: "appointment", delivery_date: "", delivery_time_start: "", delivery_time_end: "",
  weight_lbs: "", pieces: "", po_number: "", notes: "",
};
