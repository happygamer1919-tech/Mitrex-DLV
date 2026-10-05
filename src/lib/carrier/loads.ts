import type { Load, LoadStatus, Location } from "@/lib/types";

export type CarrierLoad = Load & { pickup: Location | null; delivery: Location | null };

// Load row with both locations embedded. RLS limits the rows and the locations.
export const LOAD_SELECT =
  "*, pickup:locations!pickup_location_id(*), delivery:locations!delivery_location_id(*)";

export const ACTIVE_STATUSES: LoadStatus[] = ["booked", "at_pickup", "loading", "enroute", "at_delivery"];

export const isActive = (s: LoadStatus) => ACTIVE_STATUSES.includes(s);

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The driver steps, in order. The first entry is the state a carrier starts from.
export const PROGRESS_STEPS: LoadStatus[] = ["booked", "at_pickup", "loading", "enroute", "at_delivery", "delivered"];

export const NEXT_STATUS: Partial<Record<LoadStatus, LoadStatus>> = {
  booked: "at_pickup",
  at_pickup: "loading",
  loading: "enroute",
  enroute: "at_delivery",
  at_delivery: "delivered",
};

// Label of the one big button, by the status it moves the load to.
export const NEXT_LABEL: Partial<Record<LoadStatus, string>> = {
  at_pickup: "Arrived at pickup",
  loading: "Start loading",
  enroute: "Leave for delivery",
  at_delivery: "Arrived at delivery",
  delivered: "Mark delivered",
};

export function placeLine(l: { name: string; city: string; province: string } | null): string {
  if (!l) return "Location not available";
  return `${l.name}, ${l.city}, ${l.province}`;
}

// Eastern wall clock value for the delivery appointment or window start (datetime-local).
export function deliveryStartLocal(load: Load): string {
  return `${load.delivery_date}T${load.delivery_time_start.slice(0, 5)}`;
}
