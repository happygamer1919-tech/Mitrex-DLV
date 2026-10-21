"use server";

import { revalidatePath } from "next/cache";
import { requireCustomer } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { DUPLICATE_NAME, validateCustomerLocation, type LocationErrors } from "./location-validate";

// R45 (DLV-041): Maria adds a location and edits every business field of an active one, at once, without a request.
// The session client writes (RLS and the 0021 trigger decide); the app never sends is_active, needs_review or the
// author columns, and the database would refuse or overwrite them anyway.

export type CustomerLocationResult = { ok?: true; id?: string; error?: string; errors?: LocationErrors };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC = "Something went wrong. Please try again.";

function dbError(error: { code?: string; message?: string }): CustomerLocationResult {
  if (error.code === "23505") return { errors: { name: DUPLICATE_NAME } };
  if (error.code === "23514") return { error: "One of the values is not allowed. Check the form and try again." };
  if (error.code === "42501") return { error: "You cannot change this location." };
  return { error: GENERIC };
}

function refresh() {
  revalidatePath("/locations");
  revalidatePath("/book");
  revalidatePath("/admin/locations");
}

export async function addCustomerLocation(input: unknown): Promise<CustomerLocationResult> {
  await requireCustomer();
  const v = validateCustomerLocation(input);
  if (!v.ok) return { errors: v.errors };
  const sb = await createClient();
  const { data, error } = await sb.from("locations").insert(v.row).select("id").single();
  if (error) return dbError(error);
  refresh();
  return { ok: true, id: (data as { id: string }).id };
}

export async function updateCustomerLocation(id: unknown, input: unknown): Promise<CustomerLocationResult> {
  await requireCustomer();
  if (typeof id !== "string" || !UUID.test(id)) return { error: "This location is no longer available." };
  const v = validateCustomerLocation(input);
  if (!v.ok) return { errors: v.errors };
  const sb = await createClient();
  const { data, error } = await sb.from("locations").update(v.row).eq("id", id).select("id");
  if (error) return dbError(error);
  if (!data || data.length === 0) return { error: "This location is no longer available." };
  refresh();
  return { ok: true, id };
}
