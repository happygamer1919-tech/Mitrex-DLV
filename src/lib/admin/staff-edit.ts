// Staff edit of a load (R44, DLV-039). Pure (no Next imports) and relative imports only, so the e2e specs can load
// this file. Staff (staff_admin and staff_csr alike) may change every detail of a load at any status except cancelled.
import type { Load, LoadStatus, Location, Timing } from "../types";
import { fmtSlot } from "../format";
import { addressWithName } from "../address";
import { itsOrRef } from "../load-number";
import type { LoadFormValues } from "../customer/validate";

// Every status except cancelled. A delivered load can still be corrected.
export const STAFF_EDITABLE: readonly LoadStatus[] = ["requested", "booked", "at_pickup", "loading", "enroute", "at_delivery", "delivered"];
export const canStaffEdit = (status: LoadStatus): boolean => STAFF_EDITABLE.includes(status);

// "Create return" on the staff load page: the same statuses as Maria's Return button (R43).
export const STAFF_RETURNABLE: readonly LoadStatus[] = ["at_delivery", "delivered"];
export const canStaffReturn = (status: LoadStatus): boolean => STAFF_RETURNABLE.includes(status);

// The carrier email checkbox is offered only for a load with a carrier that is past requested (and not cancelled).
export const offersCarrierEmail = (l: { status: LoadStatus; carrier_id: string | null }): boolean =>
  Boolean(l.carrier_id) && l.status !== "requested" && l.status !== "cancelled";

export const NOT_EDITABLE = "A cancelled load cannot be edited.";
export const NOTHING_CHANGED = "Nothing was changed. Change a detail, or go back to the load.";

export type Option = { id: string; label: string };

const label = (l: Location) => `${l.name} (${l.city})`;

// Pickup choices for a staff edit: every active location that can ship, plus the CURRENT pickup even when it no longer
// qualifies (marked "current"), plus, for a return load, the original's delivery site (where the truck reloads).
export function staffPickupOptions(locations: Location[], currentId: string, returnSiteId: string | null = null): Option[] {
  const out: Option[] = [];
  for (const l of locations) {
    const qualifies = l.is_active && (l.can_ship || l.id === returnSiteId);
    if (qualifies) out.push({ id: l.id, label: label(l) });
    else if (l.id === currentId) out.push({ id: l.id, label: `${label(l)} (current)` });
  }
  return out;
}

// Delivery choices for a staff edit: every active location that can receive, plus the CURRENT delivery even when it no
// longer qualifies, plus, for a return load, the original shipper (labelled, even when it cannot receive).
export function staffDeliveryOptions(locations: Location[], currentId: string, originalShipperId: string | null = null): Option[] {
  const out: Option[] = [];
  const shipper = originalShipperId ? locations.find((l) => l.id === originalShipperId && l.is_active) : undefined;
  if (shipper) out.push({ id: shipper.id, label: `${shipper.name} (original shipper)` });
  for (const l of locations) {
    if (l.id === shipper?.id) continue;
    if (l.is_active && l.can_receive) out.push({ id: l.id, label: label(l) });
    else if (l.id === currentId) out.push({ id: l.id, label: `${label(l)} (current)` });
  }
  return out;
}

type Ids = Pick<Load, "pickup_location_id" | "delivery_location_id">;

// The location rule of a staff edit, the same as the database (dlv_check_load_locations): when neither location
// changes nothing is checked (the current ones may stay even if they no longer qualify); when one changes, BOTH must
// qualify, with the return rule of R43 for a return load that still picks up at its original's delivery site.
export function staffLocationError(
  v: Pick<LoadFormValues, "pickup_location_id" | "delivery_location_id">,
  current: Ids,
  original: Ids | null,
  pickup: Location | undefined,
  delivery: Location | undefined,
): { field: "pickup_location_id" | "delivery_location_id"; message: string } | null {
  if (v.pickup_location_id === current.pickup_location_id && v.delivery_location_id === current.delivery_location_id) return null;
  if (!pickup) return { field: "pickup_location_id", message: "This pickup location is not available." };
  if (!delivery) return { field: "delivery_location_id", message: "This delivery location is not available." };
  const returnRule = Boolean(original) && v.pickup_location_id === original!.delivery_location_id;
  const pickupOk = pickup.is_active && (returnRule || pickup.can_ship);
  if (!pickupOk) {
    return {
      field: "pickup_location_id",
      message: v.pickup_location_id === current.pickup_location_id
        ? `${pickup.name} can no longer be a pickup. Choose another pickup location to change the delivery.`
        : "This location cannot ship.",
    };
  }
  const deliveryOk = delivery.is_active && (delivery.can_receive || (returnRule && delivery.id === original!.pickup_location_id));
  if (!deliveryOk) {
    return {
      field: "delivery_location_id",
      message: v.delivery_location_id === current.delivery_location_id
        ? `${delivery.name} can no longer receive. Choose another delivery location to change the pickup.`
        : "This location cannot receive.",
    };
  }
  return null;
}

// The details of a load as people read them, for the "What changed" list. Labels, location names and formats are the
// same as the "Details edited" timeline note of the database (0020) and the staff load page.
export type DetailSnapshot = {
  pickupName: string; deliveryName: string;
  pickup_contact_name: string; pickup_contact_phone: string; delivery_contact_name: string; delivery_contact_phone: string;
  pickup_timing: Timing; pickup_date: string; pickup_time_start: string; pickup_time_end: string | null;
  delivery_timing: Timing; delivery_date: string; delivery_time_start: string; delivery_time_end: string | null;
  equipment_size: number; moffett: boolean; weight_lbs: number | string | null; pieces: number | null;
  po_number: string | null; notes: string | null;
};

const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);
const slot = (s: DetailSnapshot, side: "pickup" | "delivery") =>
  fmtSlot(s[`${side}_timing`], s[`${side}_date`], s[`${side}_time_start`], s[`${side}_time_end`]);
const weight = (w: number | string | null) => (w == null || w === "" ? "Not given" : `${Number(w).toLocaleString("en-CA")} lbs`);
const text = (t: string | null) => {
  const s = (t ?? "").replace(/\s+/g, " ").trim();
  return s || "None";
};
const yesNo = (b: boolean) => (b ? "Yes" : "No");

// One "<Field>: <old> to <new>" entry per changed detail, in the order of the form.
export function detailChanges(a: DetailSnapshot, b: DetailSnapshot): string[] {
  const out: string[] = [];
  const slotKey = (s: DetailSnapshot, side: "pickup" | "delivery") =>
    [s[`${side}_timing`], s[`${side}_date`], hhmm(s[`${side}_time_start`]), hhmm(s[`${side}_time_end`])].join("|");
  if (a.pickupName !== b.pickupName) out.push(`Pickup: ${a.pickupName} to ${b.pickupName}`);
  if (a.pickup_contact_name !== b.pickup_contact_name || a.pickup_contact_phone !== b.pickup_contact_phone) {
    out.push(`Pickup contact: ${a.pickup_contact_name}, ${a.pickup_contact_phone} to ${b.pickup_contact_name}, ${b.pickup_contact_phone}`);
  }
  if (slotKey(a, "pickup") !== slotKey(b, "pickup")) out.push(`Pickup time: ${slot(a, "pickup")} to ${slot(b, "pickup")}`);
  if (a.deliveryName !== b.deliveryName) out.push(`Delivery: ${a.deliveryName} to ${b.deliveryName}`);
  if (a.delivery_contact_name !== b.delivery_contact_name || a.delivery_contact_phone !== b.delivery_contact_phone) {
    out.push(`Delivery contact: ${a.delivery_contact_name}, ${a.delivery_contact_phone} to ${b.delivery_contact_name}, ${b.delivery_contact_phone}`);
  }
  if (slotKey(a, "delivery") !== slotKey(b, "delivery")) out.push(`Delivery time: ${slot(a, "delivery")} to ${slot(b, "delivery")}`);
  if (Number(a.equipment_size) !== Number(b.equipment_size)) out.push(`Equipment size: ${a.equipment_size} ft to ${b.equipment_size} ft`);
  if (a.moffett !== b.moffett) out.push(`Moffett: ${yesNo(a.moffett)} to ${yesNo(b.moffett)}`);
  if (weight(a.weight_lbs) !== weight(b.weight_lbs)) out.push(`Weight: ${weight(a.weight_lbs)} to ${weight(b.weight_lbs)}`);
  if ((a.pieces ?? null) !== (b.pieces ?? null)) out.push(`Pieces: ${a.pieces ?? "Not given"} to ${b.pieces ?? "Not given"}`);
  if ((a.po_number || null) !== (b.po_number || null)) out.push(`PO number: ${a.po_number || "None"} to ${b.po_number || "None"}`);
  if ((a.notes ?? null) !== (b.notes ?? null)) out.push(`Notes: ${text(a.notes)} to ${text(b.notes)}`);
  return out;
}

// The timeline note the database writes for the same edit (at most 1000 characters).
export function detailsNote(changes: string[]): string {
  const n = `Details edited: ${changes.join("; ")}`;
  return n.length > 1000 ? `${n.slice(0, 997)}...` : n;
}

type MailLoc = { name: string; address_line: string; city: string; province: string; postal_code: string | null } | null;

export type CarrierMailLoad = DetailSnapshot & {
  id: string; load_number: string; its_load_number: string | null;
  pickup: MailLoc; delivery: MailLoc;
};

const addr = (l: MailLoc) => (l ? addressWithName(l) : "Unknown");

// The carrier email of R44: "Load <number> updated" with a What changed list, or "Load <number> details" (the resend
// button) without it. Full current details, times in ET, a link to the carrier's load page. It never names a lane
// reference (the ITS load to copy is staff only, R39).
export function carrierDetailsMail(l: CarrierMailLoad, changes: string[] | null, siteUrl: string): { subject: string; body: string } {
  const num = itsOrRef(l);
  const lines: string[] = [];
  if (changes) {
    lines.push(`DLV updated load ${num}.`, "", "WHAT CHANGED", ...changes.map((c) => `- ${c}`), "");
  } else {
    lines.push(`The current details of load ${num}.`, "");
  }
  lines.push(
    "PICKUP",
    addr(l.pickup),
    fmtSlot(l.pickup_timing, l.pickup_date, l.pickup_time_start, l.pickup_time_end),
    `Contact: ${l.pickup_contact_name}, ${l.pickup_contact_phone}`,
    "",
    "DELIVERY",
    addr(l.delivery),
    fmtSlot(l.delivery_timing, l.delivery_date, l.delivery_time_start, l.delivery_time_end),
    `Contact: ${l.delivery_contact_name}, ${l.delivery_contact_phone}`,
    "",
    `Equipment: ${l.equipment_size} ft`,
    `Moffett: ${yesNo(l.moffett)}`,
    `Weight: ${weight(l.weight_lbs)}`,
    `Pieces: ${l.pieces ?? "Not given"}`,
    `PO number: ${l.po_number || "None"}`,
    `Notes: ${text(l.notes)}`,
    "",
    `Open the load: ${siteUrl.replace(/\/+$/, "")}/my-loads/${l.id}`,
  );
  return { subject: changes ? `Load ${num} updated` : `Load ${num} details`, body: lines.join("\n") };
}
