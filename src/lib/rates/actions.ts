"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireCustomer, requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { plainError, str, UUID } from "@/lib/admin/errors";
import type { ActionState } from "@/lib/admin/state";
import { todayEastern } from "@/lib/format";
import { notifyAdminsOfRateRequest, notifyCustomerOfRate } from "./notify";
import {
  exceedsRateCap, formValuesFrom, RATE_WINDOW_MINUTES, MAX_RATE_REQUESTS_PER_WINDOW, validateQuote, validateRateRequest,
  type RateFieldErrors, type RateRequest,
} from "./validate";

const GENERIC = "Something went wrong. Please try again.";

export type RateFormState = { error?: string; fieldErrors?: RateFieldErrors };

// Customer: ask for a rate. A rate request is not a load and creates no load.
export async function createRateRequest(_prev: RateFormState, fd: FormData): Promise<RateFormState> {
  const profile = await requireCustomer();
  const checked = validateRateRequest(formValuesFrom(fd));
  if ("errors" in checked) return { fieldErrors: checked.errors };
  const c = checked.clean;
  const sb = await createClient();

  // Runaway guard: requests this user made in the recent window (read through the user client, RLS applies).
  const since = new Date(Date.now() - RATE_WINDOW_MINUTES * 60_000).toISOString();
  const { count, error: countErr } = await sb
    .from("rate_requests").select("id", { count: "exact", head: true })
    .eq("requested_by", profile.id).gte("created_at", since);
  if (countErr) return { error: GENERIC };
  if (exceedsRateCap(count ?? 0)) {
    return { error: `That is a lot of rate requests in a short time (limit ${MAX_RATE_REQUESTS_PER_WINDOW} in ${RATE_WINDOW_MINUTES} minutes). Wait a few minutes, or contact DLV.` };
  }

  const { data, error } = await sb.from("rate_requests").insert({
    customer_id: profile.customer_id!, ...c,
  }).select("*").single();
  if (error || !data) return { error: GENERIC };
  const row = data as RateRequest;

  await notifyAdminsOfRateRequest(row); // never throws; a failed email never fails the request
  revalidatePath("/rates");
  revalidatePath("/admin/rates");
  revalidatePath("/admin");
  redirect(`/rates?requested=${encodeURIComponent(row.ref)}`);
}

// Customer: cancel an own open request (the database function refuses anything else).
export async function cancelRateRequest(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireCustomer();
  const id = str(fd, "id");
  if (!UUID.test(id)) return { error: "Request not found." };
  const sb = await createClient();
  const { error } = await sb.rpc("cancel_rate_request", { p_id: id });
  if (error) return { error: error.code === "P0002" ? "Request not found." : error.code === "P0001" ? "Only a request that is still waiting for a rate can be cancelled." : plainError(error) };
  revalidatePath("/rates");
  revalidatePath("/admin/rates");
  revalidatePath("/admin");
  return { ok: "Request cancelled." };
}

// Staff (admin and csr alike): enter or correct the rate, then tell the customer it is in the app.
export async function quoteRateRequest(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireStaff();
  const id = str(fd, "id");
  if (!UUID.test(id)) return { error: "Request not found." };
  const checked = validateQuote({ amount: str(fd, "amount"), currency: str(fd, "currency"), notes: str(fd, "notes"), validUntil: str(fd, "valid_until") }, todayEastern());
  if ("errors" in checked) return { error: Object.values(checked.errors)[0] };
  const q = checked.clean;
  const sb = await createClient();
  const { data: before, error } = await sb.rpc("set_rate_quote", {
    p_id: id, p_amount: q.amount, p_currency: q.currency, p_notes: q.notes, p_valid_until: q.validUntil,
  });
  if (error) return { error: error.code === "P0002" ? "Request not found." : plainError(error) };
  const corrected = before === "quoted";

  // The row is read with the service role only to build the email (the actor was verified as staff above).
  const admin = createAdminClient();
  const { data: row } = await admin.from("rate_requests").select("*").eq("id", id).maybeSingle();
  let emailed = false;
  if (row) emailed = await notifyCustomerOfRate(row as RateRequest, corrected);
  revalidatePath("/rates");
  revalidatePath("/admin/rates");
  revalidatePath(`/admin/rates/${id}`);
  revalidatePath("/admin");
  const base = corrected ? "Rate corrected." : "Rate saved.";
  return { ok: emailed ? `${base} The customer was emailed that the rate is in the app.` : `${base} The email to the customer could not be sent: tell them the rate is in the app.` };
}
