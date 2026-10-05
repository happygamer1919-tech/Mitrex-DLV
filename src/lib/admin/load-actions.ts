"use server";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { easternLocalToIso } from "@/lib/format";
import { STATUS_LABEL, type LoadStatus } from "@/lib/types";
import { DATETIME_LOCAL, UUID, plainError, str } from "./errors";
import { notifyCarrierAssigned } from "./notify";
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

export async function markBooked(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff();
  const id = loadId(fd);
  if (!id) return { error: "Load not found." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_load_status", {
    p_load: id, p_status: "booked", p_eta: null, p_note: "Booked by staff",
  });
  if (error) return { error: plainError(error) };
  const sent = await notifyCarrierAssigned(id);
  refresh(id);
  return {
    ok: sent > 0
      ? `Booked. Email sent to ${sent} carrier ${sent === 1 ? "user" : "users"}.`
      : "Booked. No email was sent (the carrier has no users, or email is not configured).",
  };
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
  const { error } = await supabase.rpc("set_load_status", {
    p_load: id, p_status: status, p_eta: eta, p_note: note,
  });
  if (error) return { error: plainError(error) };
  let msg = `Status set to ${STATUS_LABEL[status]}.`;
  if (status === "booked") {
    const sent = await notifyCarrierAssigned(id);
    if (sent > 0) msg += ` Email sent to ${sent} carrier ${sent === 1 ? "user" : "users"}.`;
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
