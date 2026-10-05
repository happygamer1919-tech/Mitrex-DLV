"use server";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { UUID, plainError, str } from "./errors";
import type { ActionState } from "./state";

function done() {
  revalidatePath("/admin/locations");
  revalidatePath("/admin/requests");
}

export async function saveLocation(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff();
  const id = str(fd, "id");
  const name = str(fd, "name");
  const address = str(fd, "address_line");
  const city = str(fd, "city");
  const province = str(fd, "province").toUpperCase();
  const postal = str(fd, "postal_code").toUpperCase();
  if (!name) return { error: "Name is required." };
  if (!address) return { error: "Address is required." };
  if (!city) return { error: "City is required." };
  if (!province) return { error: "Province is required." };
  if (id && !UUID.test(id)) return { error: "Location not found." };

  const row = {
    name,
    address_line: address,
    city,
    province,
    postal_code: postal || null,
    can_ship: fd.get("can_ship") === "on",
    can_receive: fd.get("can_receive") === "on",
    requires_moffett: fd.get("requires_moffett") === "on",
    default_contact_name: str(fd, "default_contact_name") || null,
    default_contact_phone: str(fd, "default_contact_phone") || null,
    notes: str(fd, "notes") || null,
    // A location without a postal code always needs review.
    needs_review: fd.get("needs_review") === "on" || !postal,
  };
  const supabase = await createClient();
  if (id) {
    const { data, error } = await supabase.from("locations").update(row).eq("id", id).select("id");
    if (error) return { error: plainError(error) };
    if (!data || data.length === 0) return { error: "Location not found." };
    done();
    return { ok: "Location saved." };
  }
  const { error } = await supabase.from("locations").insert({ ...row, is_active: true });
  if (error) return { error: plainError(error) };
  done();
  return { ok: "Location created." };
}

export async function setLocationActive(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff();
  const id = str(fd, "id");
  if (!UUID.test(id)) return { error: "Location not found." };
  const active = str(fd, "active") === "true";
  const supabase = await createClient();
  const { data, error } = await supabase.from("locations").update({ is_active: active }).eq("id", id).select("id");
  if (error) return { error: plainError(error) };
  if (!data || data.length === 0) return { error: "Location not found." };
  done();
  return { ok: active ? "Activated." : "Deactivated." };
}

export async function deleteLocation(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff();
  const id = str(fd, "id");
  if (!UUID.test(id)) return { error: "Location not found." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("locations").delete().eq("id", id).select("id");
  if (error) {
    if (error.code === "23503") {
      return { error: "This location is used by loads or requests and cannot be deleted. Deactivate it instead." };
    }
    return { error: plainError(error) };
  }
  if (!data || data.length === 0) return { error: "Location not found." };
  done();
  return { ok: "Deleted." };
}

export async function approveRequest(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff();
  const id = str(fd, "id");
  if (!UUID.test(id)) return { error: "Request not found." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("approve_location_request", { p_request: id });
  if (error) return { error: plainError(error) };
  done();
  return { ok: "Approved." };
}

export async function rejectRequest(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff();
  const id = str(fd, "id");
  if (!UUID.test(id)) return { error: "Request not found." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("reject_location_request", { p_request: id });
  if (error) return { error: plainError(error) };
  done();
  return { ok: "Rejected." };
}
