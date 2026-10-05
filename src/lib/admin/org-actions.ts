"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { UUID, plainError, str } from "./errors";
import type { ActionState } from "./state";

type Table = "carriers" | "customers";

async function create(table: Table, fd: FormData, noun: string): Promise<ActionState> {
  await requireAdmin();
  const name = str(fd, "name");
  if (!name) return { error: "Name is required." };
  const supabase = await createClient();
  const { error } = await supabase.from(table).insert({ name });
  if (error) {
    return { error: error.code === "23505" ? `A ${noun} named "${name}" already exists.` : plainError(error) };
  }
  revalidatePath(table === "carriers" ? "/admin/carriers" : "/admin/users");
  return { ok: "Created." };
}

async function rename(table: Table, fd: FormData, noun: string): Promise<ActionState> {
  await requireAdmin();
  const id = str(fd, "id");
  const name = str(fd, "name");
  if (!UUID.test(id)) return { error: `${noun} not found.` };
  if (!name) return { error: "Name is required." };
  const supabase = await createClient();
  const { data, error } = await supabase.from(table).update({ name }).eq("id", id).select("id");
  if (error) {
    return { error: error.code === "23505" ? `A ${noun} named "${name}" already exists.` : plainError(error) };
  }
  if (!data || data.length === 0) return { error: `${noun} not found.` };
  revalidatePath(table === "carriers" ? "/admin/carriers" : "/admin/users");
  return { ok: "Saved." };
}

export async function createCarrier(_p: ActionState, fd: FormData) { return create("carriers", fd, "carrier"); }
export async function renameCarrier(_p: ActionState, fd: FormData) { return rename("carriers", fd, "carrier"); }
export async function createCustomer(_p: ActionState, fd: FormData) { return create("customers", fd, "customer"); }
export async function renameCustomer(_p: ActionState, fd: FormData) { return rename("customers", fd, "customer"); }

export async function setCarrierActive(_p: ActionState, fd: FormData): Promise<ActionState> {
  await requireAdmin();
  const id = str(fd, "id");
  if (!UUID.test(id)) return { error: "Carrier not found." };
  const active = str(fd, "active") === "true";
  const supabase = await createClient();
  const { data, error } = await supabase.from("carriers").update({ is_active: active }).eq("id", id).select("id");
  if (error) return { error: plainError(error) };
  if (!data || data.length === 0) return { error: "Carrier not found." };
  revalidatePath("/admin/carriers");
  return { ok: active ? "Activated." : "Deactivated." };
}
