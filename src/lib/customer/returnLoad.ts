// Return loads (R43, DLV-038). Pure (no Next imports) and relative imports only, so the e2e specs can load this file.
// A return recreates a load the other way round: the truck reloads where the original delivered (pickup FIXED to the
// original delivery location) and goes back to the original shipper or to another place that can receive.
import type { Load, LoadStatus, Location } from "../types";
import { EMPTY_LOAD_FORM, type LoadFormValues } from "./validate";
import { parseFromParam, stripTruckLine } from "./requestAgain";

// A customer may ask for a return once the truck is at the site or the load is delivered.
export const RETURNABLE: readonly LoadStatus[] = ["at_delivery", "delivered"];
export const canReturn = (status: LoadStatus): boolean => RETURNABLE.includes(status);

// The "return" query value is untrusted, same rule as "from": a single well formed lowercase uuid, else null.
export const parseReturnParam = parseFromParam;

export const RETURN_QUANTITY_MESSAGE = "A return is always one truck.";

// Server side: a return books exactly ONE truck. Anything else is refused.
export function validateReturnQuantity(q: unknown): { value: 1 } | { error: string } {
  return q === 1 ? { value: 1 } : { error: RETURN_QUANTITY_MESSAGE };
}

export const ORIGINAL_SHIPPER_SUFFIX = "(original shipper)";

// What the return form needs to know about the original load (never more than the customer can already read).
export type ReturnContext = {
  originalId: string;
  originalLabel: string; // customerLabel(original): "313" or "Request MTX-0005"
  siteName: string; // the original delivery location, where the truck reloads
  siteCity: string;
  originalPickupId: string; // the original shipper, first delivery option
  originalPickupContact: { name: string; phone: string };
  existingReturn: string | null; // label of a return already requested (not cancelled), shown as information
};

// Form values of a return: pickup = original delivery with the original DELIVERY contact, delivery = original pickup
// with the original PICKUP contact. Equipment, Moffett, weight, pieces, PO and notes (without the "Truck i of N" line)
// are copied, the timing type is kept, every date and time is empty.
export function returnValues(l: Load): LoadFormValues {
  return {
    ...EMPTY_LOAD_FORM,
    pickup_location_id: l.delivery_location_id,
    pickup_contact_name: l.delivery_contact_name,
    pickup_contact_phone: l.delivery_contact_phone,
    delivery_location_id: l.pickup_location_id,
    delivery_contact_name: l.pickup_contact_name,
    delivery_contact_phone: l.pickup_contact_phone,
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

export type DeliveryOption = { id: string; label: string };

// Delivery choices of a return: the original shipper first (labelled, even when it cannot receive), then every active
// location that can receive, without a duplicate and never the reload site itself.
export function returnDeliveryOptions(locations: Location[], originalPickupId: string, siteId: string): DeliveryOption[] {
  const out: DeliveryOption[] = [];
  const shipper = locations.find((l) => l.id === originalPickupId && l.is_active);
  if (shipper) out.push({ id: shipper.id, label: `${shipper.name} ${ORIGINAL_SHIPPER_SUFFIX}` });
  for (const l of locations) {
    if (!l.is_active || !l.can_receive || l.id === originalPickupId || l.id === siteId) continue;
    out.push({ id: l.id, label: `${l.name} (${l.city})` });
  }
  return out;
}

// The location rule the server applies to a return (the database applies the same one): the pickup is the original
// delivery location and only needs to be active; the delivery is active and can receive, or is the original shipper.
export function returnLocationError(
  v: Pick<LoadFormValues, "pickup_location_id" | "delivery_location_id">,
  original: Pick<Load, "pickup_location_id" | "delivery_location_id">,
  pickup: Location | undefined,
  delivery: Location | undefined,
): { field: "pickup_location_id" | "delivery_location_id"; message: string } | null {
  if (v.pickup_location_id !== original.delivery_location_id) {
    return { field: "pickup_location_id", message: "A return picks up where the original load was delivered." };
  }
  if (!pickup || !pickup.is_active) return { field: "pickup_location_id", message: "This pickup location is not available." };
  if (!delivery || !delivery.is_active) return { field: "delivery_location_id", message: "This delivery location is not available." };
  if (!delivery.can_receive && delivery.id !== original.pickup_location_id) {
    return { field: "delivery_location_id", message: "This location cannot receive." };
  }
  return null;
}
