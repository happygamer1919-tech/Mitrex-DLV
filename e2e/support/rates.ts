import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";
import { adminClient } from "./helpers";
import { localEnv } from "./env";
import { assertLocalUrl } from "./guard";
import { sentEmails, type SentEmail } from "./mail-mock";

// Helpers for e2e/rate-requests.spec.ts and e2e/a11y.spec.ts (rate requests, DLV-030).

export const RATE_MARK = "E2E-RATE"; // every rate request the specs create carries this text in its notes (cleanup)

// A Supabase client that acts AS a user: a magic link token is generated with the service role and exchanged with the
// anon key, so it is a real session (RLS applies) and the browser sessions in e2e/.auth are not touched.
export async function userClient(email: string): Promise<SupabaseClient> {
  const env = localEnv();
  assertLocalUrl(env.NEXT_PUBLIC_SUPABASE_URL, "supabase url");
  const gen = await adminClient().auth.admin.generateLink({ type: "magiclink", email });
  if (gen.error || !gen.data.properties?.hashed_token) throw gen.error ?? new Error("no link token");
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const v = await c.auth.verifyOtp({ token_hash: gen.data.properties.hashed_token, type: "magiclink" });
  if (v.error || !v.data.session) throw v.error ?? new Error("no session");
  return c;
}

export function freshEmail(tag: string): string {
  return `${tag}-${Date.now().toString(36)}-${process.pid}-${Math.floor(Math.random() * 1e6).toString(36)}@e2e.test`.toLowerCase();
}

// Creates an auth user and a profile. Returns id and email.
export async function makeUser(opts: { role: string; active: boolean; customerId?: string | null; tag: string }): Promise<{ id: string; email: string }> {
  const db = adminClient();
  const email = freshEmail(opts.tag);
  const made = await db.auth.admin.createUser({ email, email_confirm: true });
  if (made.error || !made.data.user) throw made.error ?? new Error("createUser failed");
  const p = await db.from("profiles").insert({
    id: made.data.user.id, email, full_name: opts.tag, role: opts.role, customer_id: opts.customerId ?? null, is_active: opts.active,
  });
  if (p.error) throw p.error;
  return { id: made.data.user.id, email };
}

// Emails whose subject contains `needle`, oldest first. Polls until `count` arrived (or the timeout), then returns what is there.
export async function waitForMail(needle: string, count = 1, timeoutMs = 15_000): Promise<SentEmail[]> {
  const end = Date.now() + timeoutMs;
  let hits: SentEmail[] = [];
  while (Date.now() < end) {
    hits = (await sentEmails()).filter((m) => m.subject.includes(needle));
    if (hits.length >= count) return hits;
    await new Promise((r) => setTimeout(r, 300));
  }
  return hits;
}

// Settles, then returns the mails with the needle: proves NO more than `expected` arrive.
export async function settledMail(needle: string, expected: number): Promise<SentEmail[]> {
  await waitForMail(needle, expected);
  await new Promise((r) => setTimeout(r, 1500));
  return (await sentEmails()).filter((m) => m.subject.includes(needle));
}

export type RateInput = { pc: string; ps?: string; dc: string; ds?: string; size?: 26 | 36 | 53 | null; weight?: string; dims?: string; notes?: string };

// Fills the customer request form on /rates (does not submit).
export async function fillRateForm(page: Page, v: RateInput): Promise<void> {
  await page.getByLabel("Pickup city").fill(v.pc);
  await page.getByLabel("Pickup state").fill(v.ps ?? "ON");
  await page.getByLabel("Delivery city").fill(v.dc);
  await page.getByLabel("Delivery state").fill(v.ds ?? "NY");
  if (v.size !== null) await page.getByRole("radiogroup", { name: "Equipment size" }).getByRole("radio", { name: new RegExp(String(v.size ?? 53)) }).click();
  if (v.weight !== undefined) await page.getByLabel("Weight in lbs (optional)").fill(v.weight);
  if (v.dims !== undefined) await page.getByLabel("Dimensions (optional)").fill(v.dims);
  if (v.notes !== undefined) await page.getByLabel("Notes (optional)").fill(v.notes);
}

export async function rateRowByNotes(notes: string) {
  const { data, error } = await adminClient().from("rate_requests").select("*").eq("notes", notes);
  if (error) throw error;
  return data ?? [];
}

// Inserts a rate request as the service role (setup only, never the thing under test).
export async function seedRate(opts: { customerId: string; requestedBy: string; notes: string; city?: string; status?: "open" | "quoted" | "cancelled"; amount?: number; currency?: "CAD" | "USD"; quoteNotes?: string; size?: 26 | 36 | 53 }) {
  const quoted = opts.status === "quoted";
  const { data, error } = await adminClient().from("rate_requests").insert({
    customer_id: opts.customerId, requested_by: opts.requestedBy,
    pickup_city: opts.city ?? "Seedville", pickup_state: "ON", delivery_city: opts.city ? `${opts.city} End` : "Seed End", delivery_state: "NY",
    equipment_size: opts.size ?? 53, notes: opts.notes, status: opts.status ?? "open",
    ...(quoted ? { quoted_amount: opts.amount ?? 1000, quoted_currency: opts.currency ?? "CAD", quoted_by: opts.requestedBy, quoted_at: new Date().toISOString(), quote_notes: opts.quoteNotes ?? null } : {}),
  }).select("*").single();
  if (error) throw error;
  return data as { id: string; ref: string } & Record<string, unknown>;
}
