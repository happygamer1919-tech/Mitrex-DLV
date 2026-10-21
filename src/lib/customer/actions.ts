"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireCustomer } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Load, Location } from "@/lib/types";
import { buildTruckRows, exceedsRecentCap, insertTruckLoads, MAX_LOADS_PER_WINDOW, RECENT_WINDOW_MINUTES, validateQuantity } from "./bulk";
import { notifyStaffOfRequest } from "./notify";
import { canReturn, parseReturnParam, returnLocationError, validateReturnQuantity } from "./returnLoad";
import { toLoadRow, validateLoad, type ActionResult, type LoadFormValues } from "./validate";
import { plainDbError } from "./db-messages";

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

type Original = Pick<Load, "id" | "pickup_location_id" | "delivery_location_id" | "status">;

// R43: the location rule of a return load (the database applies the same one in dlv_check_load_locations).
async function checkReturnLocations(sb: Sb, v: LoadFormValues, original: Original):
  Promise<{ pickup: Location; delivery: Location; moffett: boolean } | { error: ActionResult }> {
  const { data } = await sb.from("locations").select("*").in("id", [v.pickup_location_id, v.delivery_location_id]);
  const rows = (data ?? []) as Location[];
  const pickup = rows.find((r) => r.id === v.pickup_location_id);
  const delivery = rows.find((r) => r.id === v.delivery_location_id);
  const bad = returnLocationError(v, original, pickup, delivery);
  if (bad || !pickup || !delivery) {
    return { error: { fieldErrors: { [bad?.field ?? "pickup_location_id"]: bad?.message ?? "This pickup location is not available." } } };
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
  if ("error" in made) return { error: plainDbError(made.error) };
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

// R43: a return of one of the customer's own loads that is at delivery or delivered. Everything is checked again here
// (the form is untrusted): the original, its status, the fixed pickup, the delivery rule and exactly ONE truck. The
// database checks the same rules again on insert (0019).
export async function createReturnLoad(originalId: unknown, values: LoadFormValues, quantity: unknown = 1): Promise<ActionResult> {
  const profile = await requireCustomer();
  const id = parseReturnParam(originalId);
  if (!id || !profile.customer_id) return { error: NOT_RETURNABLE };
  const fieldErrors = validateLoad(values);
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  const q = validateReturnQuantity(quantity);
  if ("error" in q) return { fieldErrors: { quantity: q.error } };
  const sb = await createClient();
  const { data: orig } = await sb.from("loads").select("id,pickup_location_id,delivery_location_id,status")
    .eq("id", id).eq("customer_id", profile.customer_id).maybeSingle();
  const original = orig as Original | null;
  if (!original || !canReturn(original.status)) return { error: NOT_RETURNABLE };
  const loc = await checkReturnLocations(sb, values, original);
  if ("error" in loc) return loc.error;

  const since = new Date(Date.now() - RECENT_WINDOW_MINUTES * 60_000).toISOString();
  const { count, error: countErr } = await sb
    .from("loads").select("id", { count: "exact", head: true })
    .eq("created_by", profile.id).gte("created_at", since);
  if (countErr) return { error: GENERIC };
  if (exceedsRecentCap(count ?? 0, 1, recentCap())) {
    return { error: `That is a lot of loads in a short time (limit ${recentCap()} in ${RECENT_WINDOW_MINUTES} minutes). Wait a few minutes, or contact DLV.` };
  }

  const rows = buildTruckRows(values, loc.moffett, 1, profile.customer_id, profile.id)
    .map((r) => ({ ...r, return_of_load_id: original.id }));
  const made = await insertTruckLoads(sb, rows);
  if ("error" in made) return { error: plainDbError(made.error) };
  const load = made.loads[0];

  await saveDefaults(sb, values);
  const { data: cust } = await sb.from("customers").select("name").eq("id", profile.customer_id).maybeSingle();
  await notifyStaffOfRequest({
    loads: [{ id: load.id, loadNumber: load.load_number }],
    pickupName: loc.pickup.name,
    deliveryName: loc.delivery.name,
    moffett: loc.moffett,
    values,
    customerName: (cust as { name: string } | null)?.name ?? null,
    returnOfLoadId: original.id,
  });
  revalidatePath("/loads");
  revalidatePath(`/loads/${original.id}`);
  revalidatePath("/locations");
  redirect(`/loads/${load.id}`);
}

const NOT_RETURNABLE = "This load cannot be returned. Open it again from your loads.";

export async function updateLoad(loadId: string, values: LoadFormValues): Promise<ActionResult> {
  await requireCustomer();
  const fieldErrors = validateLoad(values);
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  const sb = await createClient();
  // R43: a return load keeps its own location rule on an edit (pickup fixed, the original shipper allowed).
  const { data: cur } = await sb.from("loads").select("return_of_load_id").eq("id", loadId).maybeSingle();
  const returnOf = (cur as { return_of_load_id: string | null } | null)?.return_of_load_id ?? null;
  let original: Original | null = null;
  if (returnOf) {
    const { data: o } = await sb.from("loads").select("id,pickup_location_id,delivery_location_id,status").eq("id", returnOf).maybeSingle();
    original = o as Original | null;
  }
  const loc = original ? await checkReturnLocations(sb, values, original) : await checkLocations(sb, values);
  if ("error" in loc) return loc.error;

  const { data, error } = await sb
    .from("loads")
    .update(toLoadRow(values, loc.moffett))
    .eq("id", loadId)
    .eq("status", "requested")
    .select("id");
  if (error) return { error: plainDbError(error.message) };
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
  if (error) {
    // The database lets a customer cancel only while the load is requested (42501 otherwise). Say why in plain words.
    // No revalidate here: it would re-render the page at once and take this message away with the Cancel panel; the
    // live refresh shows the new status a moment later.
    const { data: cur } = await sb.from("loads").select("status").eq("id", loadId).maybeSingle();
    const st = (cur as { status: string } | null)?.status;
    if (st === "cancelled") return { error: "This load is already cancelled." };
    if (st && st !== "requested") return { error: "This load was already booked by DLV and can no longer be cancelled here. Contact DLV." };
    return { error: GENERIC };
  }
  revalidatePath("/loads");
  revalidatePath(`/loads/${loadId}`);
  return { ok: true };
}
