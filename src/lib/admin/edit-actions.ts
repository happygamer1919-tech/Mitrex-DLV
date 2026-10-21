"use server";
// Staff edit of a load, the carrier details email and a staff created return (R44, DLV-039). Staff only (admin and
// csr alike): requireStaff sends anyone else away before anything is read, and RLS (loads_staff_update,
// loads_staff_insert) refuses them again at the database. Everything the browser sends is validated again here.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toLoadRow, validateLoad, type ActionResult, type LoadFormValues } from "@/lib/customer/validate";
import { buildTruckRows, insertTruckLoads } from "@/lib/customer/bulk";
import { canReturn, parseReturnParam, returnLocationError } from "@/lib/customer/returnLoad";
import type { Load, Location } from "@/lib/types";
import { UUID, plainError, str } from "./errors";
import { notifyCarrierDetails } from "./notify";
import {
  NOT_EDITABLE, NOTHING_CHANGED, canStaffEdit, detailChanges, offersCarrierEmail, staffLocationError, type DetailSnapshot,
} from "./staff-edit";
import type { ActionState } from "./state";

type Sb = Awaited<ReturnType<typeof createClient>>;

const GENERIC = "Something went wrong. Please try again.";
const DETAIL_SELECT = "*,pickup:locations!pickup_location_id(name),delivery:locations!delivery_location_id(name)";

type Row = Load & { pickup: { name: string } | null; delivery: { name: string } | null };

function snapshot(l: Row): DetailSnapshot {
  return { ...l, pickupName: l.pickup?.name ?? "Unknown", deliveryName: l.delivery?.name ?? "Unknown" };
}

function refresh(id: string) {
  revalidatePath(`/admin/loads/${id}`);
  revalidatePath("/admin");
  revalidatePath("/admin/calendar");
  revalidatePath("/loads");
  revalidatePath(`/loads/${id}`);
  revalidatePath("/my-loads");
  revalidatePath(`/my-loads/${id}`);
}

async function locationsOf(sb: Sb, ids: string[]): Promise<Location[]> {
  const { data } = await sb.from("locations").select("*").in("id", ids);
  return (data ?? []) as Location[];
}

// Saves a staff edit. On success it redirects to the staff load page with the result of the optional carrier email
// ("Saved.", "Saved. The carrier was emailed.", "Saved. The carrier email could not be sent."). A mail failure never
// fails the save. The database writes the "Details edited" timeline event (0020).
export async function updateLoadAsStaff(loadId: unknown, values: LoadFormValues, emailCarrier: unknown = false): Promise<ActionResult> {
  await requireStaff();
  if (typeof loadId !== "string" || !UUID.test(loadId)) return { error: "Load not found." };
  if (typeof emailCarrier !== "boolean") return { error: "The form data was invalid. Reload the page and try again." };
  const fieldErrors = validateLoad(values, undefined, { allowPast: true });
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const sb = await createClient();
  const { data: cur } = await sb.from("loads").select(DETAIL_SELECT).eq("id", loadId).maybeSingle();
  const before = cur as unknown as Row | null;
  if (!before) return { error: "Load not found." };
  if (!canStaffEdit(before.status)) return { error: NOT_EDITABLE };

  let original: Pick<Load, "pickup_location_id" | "delivery_location_id"> | null = null;
  if (before.return_of_load_id) {
    const { data: o } = await sb.from("loads").select("pickup_location_id,delivery_location_id").eq("id", before.return_of_load_id).maybeSingle();
    original = (o as Pick<Load, "pickup_location_id" | "delivery_location_id"> | null) ?? null;
  }
  const locs = await locationsOf(sb, [values.pickup_location_id, values.delivery_location_id]);
  const pickup = locs.find((l) => l.id === values.pickup_location_id);
  const delivery = locs.find((l) => l.id === values.delivery_location_id);
  const bad = staffLocationError(values, before, original, pickup, delivery);
  if (bad) return { fieldErrors: { [bad.field]: bad.message } };
  if (!pickup || !delivery) return { error: "This location is not available." };
  const moffett = values.moffett || pickup.requires_moffett || delivery.requires_moffett;
  const row = toLoadRow(values, moffett);

  const planned = detailChanges(snapshot(before), { ...snapshot(before), ...row, pickupName: pickup.name, deliveryName: delivery.name });
  if (planned.length === 0) return { error: NOTHING_CHANGED };

  const { data: saved, error } = await sb.from("loads").update(row).eq("id", loadId).neq("status", "cancelled").select(DETAIL_SELECT);
  if (error) return { error: plainError(error) };
  const after = ((saved ?? []) as unknown as Row[])[0];
  if (!after) return { error: "This load was cancelled or removed meanwhile and was not changed." };
  refresh(loadId);

  let result = "1";
  if (emailCarrier && offersCarrierEmail(after)) {
    const sent = await notifyCarrierDetails(loadId, detailChanges(snapshot(before), snapshot(after)));
    result = sent > 0 ? "emailed" : "mail_failed";
  }
  redirect(`/admin/loads/${loadId}?saved=${result}`);
}

// "Email the details to the carrier again" (Carrier and booking card): the same email without the What changed list.
export async function resendCarrierDetails(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff();
  const id = str(fd, "load_id");
  if (!UUID.test(id)) return { error: "Load not found." };
  const sb = await createClient();
  const { data } = await sb.from("loads").select("status,carrier_id").eq("id", id).maybeSingle();
  const l = data as Pick<Load, "status" | "carrier_id"> | null;
  if (!l) return { error: "Load not found." };
  if (!offersCarrierEmail(l)) return { error: "Only a booked load with a carrier can be emailed to the carrier." };
  const sent = await notifyCarrierDetails(id, null);
  if (sent === 0) return { error: "The carrier email could not be sent." };
  return { ok: `Details emailed to ${sent} carrier ${sent === 1 ? "user" : "users"}.` };
}

const NOT_RETURNABLE = "A return can be created only for a load that is at delivery or delivered.";

// Staff create a return of a load at delivery or delivered (R43 rules, staff form): a requested load for the
// ORIGINAL load's customer, created_by the staff user, return_of_load_id set. No staff request email. Redirects to
// the new load's staff page, where "Use the same carrier" applies.
export async function createReturnAsStaff(originalId: unknown, values: LoadFormValues): Promise<ActionResult> {
  const profile = await requireStaff();
  const id = parseReturnParam(originalId);
  if (!id) return { error: NOT_RETURNABLE };
  const fieldErrors = validateLoad(values, undefined, { allowPast: true });
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  const sb = await createClient();
  const { data: o } = await sb.from("loads").select("id,customer_id,pickup_location_id,delivery_location_id,status").eq("id", id).maybeSingle();
  const original = o as Pick<Load, "id" | "customer_id" | "pickup_location_id" | "delivery_location_id" | "status"> | null;
  if (!original || !canReturn(original.status)) return { error: NOT_RETURNABLE };
  const locs = await locationsOf(sb, [values.pickup_location_id, values.delivery_location_id]);
  const pickup = locs.find((l) => l.id === values.pickup_location_id);
  const delivery = locs.find((l) => l.id === values.delivery_location_id);
  const bad = returnLocationError(values, original, pickup, delivery);
  if (bad || !pickup || !delivery) {
    return { fieldErrors: { [bad?.field ?? "pickup_location_id"]: bad?.message ?? "This pickup location is not available." } };
  }
  const moffett = values.moffett || pickup.requires_moffett || delivery.requires_moffett;
  const rows = buildTruckRows(values, moffett, 1, original.customer_id, profile.id).map((r) => ({ ...r, return_of_load_id: original.id }));
  const made = await insertTruckLoads(sb, rows);
  if ("error" in made) return { error: made.error || GENERIC };
  const load = made.loads[0];
  refresh(original.id);
  revalidatePath(`/admin/loads/${load.id}`);
  redirect(`/admin/loads/${load.id}?saved=return`);
}
