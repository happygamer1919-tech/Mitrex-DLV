import type { Load, Location } from "@/lib/types";
import type { LoadFormValues } from "./validate";

export const LOAD_SELECT =
  "*, pickup:locations!pickup_location_id(*), delivery:locations!delivery_location_id(*), carrier:carriers(name)";

export type LoadWithRefs = Load & {
  pickup: Location | null;
  delivery: Location | null;
  carrier: { name: string } | null;
};

const hhmm = (t: string | null) => (t ? t.slice(0, 5) : "");

export function loadToFormValues(l: Load): LoadFormValues {
  return {
    pickup_location_id: l.pickup_location_id,
    delivery_location_id: l.delivery_location_id,
    pickup_contact_name: l.pickup_contact_name,
    pickup_contact_phone: l.pickup_contact_phone,
    save_pickup_default: false,
    delivery_contact_name: l.delivery_contact_name,
    delivery_contact_phone: l.delivery_contact_phone,
    save_delivery_default: false,
    equipment_size: String(l.equipment_size),
    moffett: l.moffett,
    pickup_timing: l.pickup_timing,
    pickup_date: l.pickup_date,
    pickup_time_start: hhmm(l.pickup_time_start),
    pickup_time_end: hhmm(l.pickup_time_end),
    delivery_timing: l.delivery_timing,
    delivery_date: l.delivery_date,
    delivery_time_start: hhmm(l.delivery_time_start),
    delivery_time_end: hhmm(l.delivery_time_end),
    weight_lbs: l.weight_lbs == null ? "" : String(l.weight_lbs),
    pieces: l.pieces == null ? "" : String(l.pieces),
    po_number: l.po_number ?? "",
    notes: l.notes ?? "",
  };
}
