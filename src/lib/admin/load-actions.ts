"use server";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { easternLocalToIso } from "@/lib/format";
import { STATUS_LABEL, type LoadStatus } from "@/lib/types";
import { DATETIME_LOCAL, UUID, plainError, str } from "./errors";
import { notifyCarrierAssigned, notifyCustomerBolUploaded, notifyCustomerBooked } from "./notify";
import { ITS_FORMAT_MESSAGE, normaliseIts, validateIts } from "@/lib/load-number";
import type { ActionState } from "./state";

function refresh(id: string) {
  revalidatePath(`/admin/loads/${id}`);
  revalidatePath("/admin");
  revalidatePath("/admin/calendar");
}

function loadId(fd: FormData): string | null {
  const id = str(fd, "load_id");
  return UUID.test(id) ? id : null;
}

export async function assignCarrier(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff();
  const id = loadId(fd);
  if (!id) return { error: "Load not found." };
  const carrierId = str(fd, "carrier_id");
  if (carrierId && !UUID.test(carrierId)) return { error: "Choose a carrier from the list." };

  const supabase = await createClient();
  const { data: current } = await supabase.from("loads").select("status,carrier_id").eq("id", id).maybeSingle();
  if (!current) return { error: "Load not found." };
  if (carrierId) {
    const { data: carrier } = await supabase.from("carriers").select("id,is_active").eq("id", carrierId).maybeSingle();
    if (!carrier) return { error: "Carrier not found." };
    if (!carrier.is_active) return { error: "That carrier is inactive. Activate it first." };
  }
  const { data, error } = await supabase
    .from("loads").update({ carrier_id: carrierId || null }).eq("id", id).select("id");
  if (error) return { error: plainError(error) };
  if (!data || data.length === 0) return { error: "Load not found or not editable." };
  refresh(id);
  // A carrier added to a load that is already booked or moving has not been told yet.
  const live = !["requested", "delivered", "cancelled"].includes(current.status);
  if (carrierId && live && carrierId !== current.carrier_id) {
    const sent = await notifyCarrierAssigned(id);
    return { ok: sent > 0 ? `Carrier assigned. Email sent to ${sent} carrier ${sent === 1 ? "user" : "users"}.` : "Carrier assigned. No email was sent." };
  }
  return { ok: carrierId ? "Carrier assigned." : "Carrier removed." };
}

// Real DB message for a clash or a bad number; the unique index (race) answers 23505.
function itsError(error: { message?: string; code?: string }): string {
  if (error.code === "23505") return "That ITS load number is already used by another load.";
  if (error.code === "23514") return ITS_FORMAT_MESSAGE;
  return plainError(error);
}

// Staff books a load: ITS number first (set_its_load_number, event logged), then set_load_status('booked'),
// then the emails (carrier assigned, booking confirmation to the customer). A mail failure never fails the action.
export async function bookLoad(loadId: string, itsNumber: string): Promise<ActionState> {
  await requireStaff();
  if (!UUID.test(loadId)) return { error: "Load not found." };
  const invalid = validateIts(itsNumber);
  if (invalid) return { error: invalid };
  const its = normaliseIts(itsNumber);
  const supabase = await createClient();
  const set = await supabase.rpc("set_its_load_number", { p_load: loadId, p_number: its });
  if (set.error) return { error: itsError(set.error) };
  const { error } = await supabase.rpc("set_load_status", {
    p_load: loadId, p_status: "booked", p_eta: null, p_note: `Booked by staff (ITS ${its})`,
  });
  if (error) return { error: plainError(error) };
  const sent = await notifyCarrierAssigned(loadId);
  const told = await notifyCustomerBooked(loadId);
  refresh(loadId);
  revalidatePath("/loads");
  const carrierMsg = sent > 0
    ? `Email sent to ${sent} carrier ${sent === 1 ? "user" : "users"}.`
    : "No carrier email was sent (the carrier has no users, or email is not configured).";
  const customerMsg = told > 0
    ? `Booking confirmation sent to ${told} customer ${told === 1 ? "user" : "users"}.`
    : "No customer email was sent.";
  return { ok: `Booked as ITS ${its}. ${carrierMsg} ${customerMsg}` };
}

// Correct the ITS number after booking (same function, event logged).
export async function setItsNumber(loadId: string, itsNumber: string): Promise<ActionState> {
  await requireStaff();
  if (!UUID.test(loadId)) return { error: "Load not found." };
  const invalid = validateIts(itsNumber);
  if (invalid) return { error: invalid };
  const its = normaliseIts(itsNumber);
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_its_load_number", { p_load: loadId, p_number: its });
  if (error) return { error: itsError(error) };
  refresh(loadId);
  revalidatePath("/loads");
  return { ok: `ITS load number is ${its}.` };
}

// Called by the staff BOL upload (client side) after the file and its row are stored. Sends the follow-up to the
// customer only when the load is already booked (not requested). Staff only. Never fails the upload.
export async function notifyBolUploaded(loadId: string, storagePath: string): Promise<{ sent: number }> {
  await requireStaff();
  if (!UUID.test(loadId) || typeof storagePath !== "string" || storagePath.length > 200) return { sent: 0 };
  return { sent: await notifyCustomerBolUploaded(loadId, storagePath) };
}

export async function overrideStatus(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff();
  const id = loadId(fd);
  if (!id) return { error: "Load not found." };
  const status = str(fd, "status") as LoadStatus;
  if (!Object.hasOwn(STATUS_LABEL, status)) return { error: "Choose a status." };
  const note = str(fd, "note");
  if (!note) return { error: "A note is required for a status override." };
  let eta: string | null = null;
  if (status === "enroute") {
    const raw = str(fd, "eta");
    if (!DATETIME_LOCAL.test(raw)) return { error: "ETA is required for enroute (Eastern time)." };
    eta = easternLocalToIso(raw);
  }
  const supabase = await createClient();
  // Leaving "requested" (other than cancelling) needs the ITS load number, same rule as booking.
  const { data: cur } = await supabase.from("loads").select("status,its_load_number").eq("id", id).maybeSingle();
  if (!cur) return { error: "Load not found." };
  const leavingRequest = cur.status === "requested" && status !== "cancelled";
  if (leavingRequest) {
    const raw = str(fd, "its_load_number");
    if (raw || !cur.its_load_number) {
      const invalid = validateIts(raw);
      if (invalid) return { error: invalid };
      const set = await supabase.rpc("set_its_load_number", { p_load: id, p_number: normaliseIts(raw) });
      if (set.error) return { error: itsError(set.error) };
    }
  }
  const { error } = await supabase.rpc("set_load_status", {
    p_load: id, p_status: status, p_eta: eta, p_note: note,
  });
  if (error) return { error: plainError(error) };
  let msg = `Status set to ${STATUS_LABEL[status]}.`;
  if (status === "booked") {
    const sent = await notifyCarrierAssigned(id);
    if (sent > 0) msg += ` Email sent to ${sent} carrier ${sent === 1 ? "user" : "users"}.`;
  }
  if (leavingRequest) {
    const told = await notifyCustomerBooked(id);
    if (told > 0) msg += ` Booking confirmation sent to ${told} customer ${told === 1 ? "user" : "users"}.`;
    revalidatePath("/loads");
  }
  refresh(id);
  return { ok: msg };
}

export async function setEta(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff();
  const id = loadId(fd);
  if (!id) return { error: "Load not found." };
  const raw = str(fd, "eta");
  if (!DATETIME_LOCAL.test(raw)) return { error: "Enter the ETA as an Eastern date and time." };
  const note = str(fd, "note");
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_load_eta", {
    p_load: id, p_eta: easternLocalToIso(raw), p_note: note || null,
  });
  if (error) return { error: plainError(error) };
  refresh(id);
  return { ok: "ETA updated." };
}

export async function cancelLoad(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff();
  const id = loadId(fd);
  if (!id) return { error: "Load not found." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_load_status", {
    p_load: id, p_status: "cancelled", p_eta: null, p_note: "Cancelled by staff",
  });
  if (error) return { error: plainError(error) };
  refresh(id);
  return { ok: "Load cancelled." };
}
