"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireCustomer } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Location } from "@/lib/types";
import { buildTruckRows, exceedsRecentCap, insertTruckLoads, MAX_LOADS_PER_WINDOW, RECENT_WINDOW_MINUTES, validateQuantity } from "./bulk";
import { notifyStaffOfRequest } from "./notify";
import { toLoadRow, validateLoad, type ActionResult, type LoadFormValues } from "./validate";

type Sb = Awaited<ReturnType<typeof createClient>>;

const GENERIC = "Something went wrong. Please try again.";

// Default 30 loads per 10 minutes per customer user. LOAD_RATE_CAP overrides it (the e2e server raises it, because
// the specs seed many loads as Maria through the service role).
function recentCap(): number {
  const n = Number(process.env.LOAD_RATE_CAP);
  return Number.isInteger(n) && n >= 1 ? n : MAX_LOADS_PER_WINDOW;
}

async function checkLocations(sb: Sb, v: LoadFormValues):
  Promise<{ pickup: Location; delivery: Location; moffett: boolean } | { error: ActionResult }> {
  const { data } = await sb.from("locations").select("*").in("id", [v.pickup_location_id, v.delivery_location_id]);
  const rows = (data ?? []) as Location[];
  const pickup = rows.find((r) => r.id === v.pickup_location_id);
  const delivery = rows.find((r) => r.id === v.delivery_location_id);
  if (!pickup) return { error: { fieldErrors: { pickup_location_id: "This pickup location is not available." } } };
  if (!delivery) return { error: { fieldErrors: { delivery_location_id: "This delivery location is not available." } } };
  if (!pickup.can_ship || !pickup.is_active) {
    return { error: { fieldErrors: { pickup_location_id: "This location cannot ship." } } };
  }
  if (!delivery.can_receive || !delivery.is_active) {
    return { error: { fieldErrors: { delivery_location_id: "This location cannot receive." } } };
  }
  return { pickup, delivery, moffett: v.moffett || pickup.requires_moffett || delivery.requires_moffett };
}

async function saveDefaults(sb: Sb, v: LoadFormValues) {
  const jobs: PromiseLike<unknown>[] = [];
  if (v.save_pickup_default) {
    jobs.push(sb.from("locations").update({
      default_contact_name: v.pickup_contact_name.trim(),
      default_contact_phone: v.pickup_contact_phone.trim(),
    }).eq("id", v.pickup_location_id));
  }
  if (v.save_delivery_default) {
    jobs.push(sb.from("locations").update({
      default_contact_name: v.delivery_contact_name.trim(),
      default_contact_phone: v.delivery_contact_phone.trim(),
    }).eq("id", v.delivery_location_id));
  }
  // A failed default save must not fail the load itself.
  await Promise.allSettled(jobs);
}

export async function createLoad(values: LoadFormValues, quantity: unknown = 1): Promise<ActionResult> {
  const profile = await requireCustomer();
  const fieldErrors = validateLoad(values);
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  const q = validateQuantity(quantity);
  if ("error" in q) return { fieldErrors: { quantity: q.error } };
  const n = q.value;
  const sb = await createClient();
  const loc = await checkLocations(sb, values);
  if ("error" in loc) return loc.error;

  // Runaway guard: loads this user created in the recent window (counted through the user client, RLS applies).
  const since = new Date(Date.now() - RECENT_WINDOW_MINUTES * 60_000).toISOString();
  const { count, error: countErr } = await sb
    .from("loads").select("id", { count: "exact", head: true })
    .eq("created_by", profile.id).gte("created_at", since);
  if (countErr) return { error: GENERIC };
  if (exceedsRecentCap(count ?? 0, n, recentCap())) {
    return { error: `That is a lot of loads in a short time (limit ${recentCap()} in ${RECENT_WINDOW_MINUTES} minutes). Wait a few minutes, or contact DLV.` };
  }

  const rows = buildTruckRows(values, loc.moffett, n, profile.customer_id!, profile.id);
  const made = await insertTruckLoads(sb, rows); // one statement: all or nothing
  if ("error" in made) return { error: made.error || GENERIC };
  const loads = made.loads;

  await saveDefaults(sb, values);
  const { data: cust } = await sb.from("customers").select("name").eq("id", profile.customer_id!).maybeSingle();
  await notifyStaffOfRequest({
    loads: loads.map((l) => ({ id: l.id, loadNumber: l.load_number })),
    pickupName: loc.pickup.name,
    deliveryName: loc.delivery.name,
    moffett: loc.moffett,
    values,
    customerName: (cust as { name: string } | null)?.name ?? null,
  });
  revalidatePath("/loads");
  revalidatePath("/locations");
  if (n === 1) redirect(`/loads/${loads[0].id}`);
  redirect(`/loads?booked=${loads.map((l) => l.id).join(",")}`);
}

export async function updateLoad(loadId: string, values: LoadFormValues): Promise<ActionResult> {
  await requireCustomer();
  const fieldErrors = validateLoad(values);
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  const sb = await createClient();
  const loc = await checkLocations(sb, values);
  if ("error" in loc) return loc.error;

  const { data, error } = await sb
    .from("loads")
    .update(toLoadRow(values, loc.moffett))
    .eq("id", loadId)
    .eq("status", "requested")
    .select("id");
  if (error) return { error: error.message };
  if (!data || data.length === 0) {
    return { error: "This load can no longer be edited. Contact DLV to change this load." };
  }
  await saveDefaults(sb, values);
  revalidatePath("/loads");
  revalidatePath(`/loads/${loadId}`);
  redirect(`/loads/${loadId}`);
}

export async function cancelLoad(loadId: string): Promise<ActionResult> {
  await requireCustomer();
  const sb = await createClient();
  const { error } = await sb.rpc("set_load_status", {
    p_load: loadId, p_status: "cancelled", p_eta: null, p_note: "Cancelled by customer",
  });
  if (error) return { error: error.message };
  revalidatePath("/loads");
  revalidatePath(`/loads/${loadId}`);
  return { ok: true };
}

export async function saveDefaultContact(locationId: string, name: string, phone: string): Promise<ActionResult> {
  await requireCustomer();
  const sb = await createClient();
  const { data, error } = await sb
    .from("locations")
    .update({ default_contact_name: name.trim() || null, default_contact_phone: phone.trim() || null })
    .eq("id", locationId)
    .select("id");
  if (error) return { error: error.message };
  if (!data || data.length === 0) return { error: "Location not found." };
  revalidatePath("/locations");
  revalidatePath("/book");
  return { ok: true };
}

export type NewLocationInput = {
  name: string; address_line: string; city: string; province: string; postal_code: string;
  can_ship: boolean; can_receive: boolean; requires_moffett: boolean;
  contact_name: string; contact_phone: string; notes: string;
};

export type LocationRequestResult = { ok?: boolean; error?: string; errors?: Record<string, string> };

export async function requestNewLocation(v: NewLocationInput): Promise<LocationRequestResult> {
  const profile = await requireCustomer();
  const errors: Record<string, string> = {};
  if (!v.name.trim()) errors.name = "Location name is required.";
  if (!v.address_line.trim()) errors.address_line = "Street address is required.";
  if (!v.city.trim()) errors.city = "City is required.";
  if (!v.province.trim()) errors.province = "Province is required.";
  if (!v.can_ship && !v.can_receive) errors.can_ship = "Choose can ship, can receive, or both.";
  if (Object.keys(errors).length > 0) return { errors };
  const sb = await createClient();
  const { error } = await sb.from("location_requests").insert({
    kind: "new",
    location_id: null,
    payload: {
      name: v.name.trim(),
      address_line: v.address_line.trim(),
      city: v.city.trim(),
      province: v.province.trim(),
      postal_code: v.postal_code.trim(),
      can_ship: v.can_ship,
      can_receive: v.can_receive,
      requires_moffett: v.requires_moffett,
      default_contact_name: v.contact_name.trim(),
      default_contact_phone: v.contact_phone.trim(),
      notes: v.notes.trim(),
    },
    requested_by: profile.id,
    status: "pending",
  });
  if (error) return { error: error.message };
  revalidatePath("/locations");
  return { ok: true };
}

export type ChangeLocationInput = {
  location_id: string; name: string; address_line: string; city: string; province: string;
  postal_code: string; notes: string;
};

export async function requestAddressChange(v: ChangeLocationInput): Promise<LocationRequestResult> {
  const profile = await requireCustomer();
  const errors: Record<string, string> = {};
  if (!v.location_id) errors.location_id = "Choose a location.";
  const changed: Record<string, string> = {};
  for (const key of ["name", "address_line", "city", "province", "postal_code"] as const) {
    if (v[key].trim()) changed[key] = v[key].trim();
  }
  if (Object.keys(changed).length === 0) errors.fields = "Fill in at least one field to change.";
  if (Object.keys(errors).length > 0) return { errors };
  if (v.notes.trim()) changed.notes = v.notes.trim();
  const sb = await createClient();
  const { error } = await sb.from("location_requests").insert({
    kind: "change",
    location_id: v.location_id,
    payload: changed,
    requested_by: profile.id,
    status: "pending",
  });
  if (error) return { error: error.message };
  revalidatePath("/locations");
  return { ok: true };
}
