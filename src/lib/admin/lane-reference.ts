// Lane references (DLV-028, R39): STAFF ONLY. For each repeat lane the staff copy an old ITS load; this says which one.
// A scenario is pickup location + delivery location + truck size. The reference is evaluated live from the load's
// current pickup, delivery and size (no snapshot). Callers pass a staff session client (RLS does the access control)
// or, in the staff email path only, the service role client. Nothing here is imported by a customer or carrier page.
import type { SupabaseClient } from "@supabase/supabase-js";
import { ITS_FORMAT, ITS_FORMAT_MESSAGE, ITS_MAX_LENGTH } from "@/lib/load-number";

export const LANE_SIZES = [26, 36, 53] as const;
export const NOTE_MAX = 500;
export const NO_REFERENCE_TEXT = "No ITS reference for this lane and size";

export type Scenario = { pickupId: string; deliveryId: string; size: number };
export type LaneReference = { number: string; laneLabel: string };

export const scenarioKey = (s: Scenario): string => `${s.pickupId}|${s.deliveryId}|${s.size}`;

// "Mitrex to 481 University Ave, 26 ft"
export function laneLabel(pickupName: string, deliveryName: string, size: number): string {
  return `${pickupName} to ${deliveryName}, ${size} ft`;
}

// The prefilled "Add it" link (staff only page).
export function addLanePath(s: Scenario): string {
  return `/admin/lanes?pickup=${encodeURIComponent(s.pickupId)}&delivery=${encodeURIComponent(s.deliveryId)}&size=${encodeURIComponent(String(s.size))}`;
}

export function validLaneNumber(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Enter the ITS load to copy.";
  if (!ITS_FORMAT.test(v)) return ITS_FORMAT_MESSAGE.replace("The ITS load number", "The ITS load to copy");
  if (v.length > ITS_MAX_LENGTH) return `The ITS load to copy is too long (at most ${ITS_MAX_LENGTH} characters).`;
  return null;
}

type Row = {
  pickup_location_id: string;
  delivery_location_id: string;
  equipment_size: number;
  its_reference_load: string;
  pickup: { name: string } | null;
  delivery: { name: string } | null;
};

const SELECT =
  "pickup_location_id,delivery_location_id,equipment_size,its_reference_load," +
  "pickup:locations!pickup_location_id(name),delivery:locations!delivery_location_id(name)";

const toRef = (r: Row): LaneReference => ({
  number: r.its_reference_load,
  laneLabel: laneLabel(r.pickup?.name ?? "Unknown", r.delivery?.name ?? "Unknown", r.equipment_size),
});

// One scenario. Throws on a database error (a failed lookup must never read as "no reference").
export async function resolve(sb: SupabaseClient, pickupId: string, deliveryId: string, size: number): Promise<LaneReference | null> {
  const { data, error } = await sb.from("lane_references").select(SELECT)
    .eq("pickup_location_id", pickupId).eq("delivery_location_id", deliveryId).eq("equipment_size", size).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toRef(data as unknown as Row) : null;
}

// Many scenarios in one query (the board). Keyed by scenarioKey.
export async function resolveMany(sb: SupabaseClient, scenarios: Scenario[]): Promise<Map<string, LaneReference>> {
  const out = new Map<string, LaneReference>();
  if (scenarios.length === 0) return out;
  const wanted = new Set(scenarios.map(scenarioKey));
  const pickups = [...new Set(scenarios.map((s) => s.pickupId))];
  const deliveries = [...new Set(scenarios.map((s) => s.deliveryId))];
  const sizes = [...new Set(scenarios.map((s) => s.size))];
  const { data, error } = await sb.from("lane_references").select(SELECT)
    .in("pickup_location_id", pickups).in("delivery_location_id", deliveries).in("equipment_size", sizes).limit(1000);
  if (error) throw new Error(error.message);
  for (const r of (data ?? []) as unknown as Row[]) {
    const key = scenarioKey({ pickupId: r.pickup_location_id, deliveryId: r.delivery_location_id, size: r.equipment_size });
    if (wanted.has(key)) out.set(key, toRef(r));
  }
  return out;
}
