import type { Browser, BrowserContext, Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { localEnv } from "./env";
import { CARRIER_A, stateFile, type Who } from "./users";

export async function as(browser: Browser, who: Who, viewport?: { width: number; height: number }): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ storageState: stateFile(who), baseURL: "http://localhost:3200", viewport });
  return { ctx, page: await ctx.newPage() };
}

export function adminClient() {
  const e = localEnv();
  return createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

// 1x1 PNG, enough for the client side canvas compression path.
export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export function isoDate(daysAhead: number): string {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  return d.toISOString().slice(0, 10);
}

// Inserts a booked load for E2E carrier A directly (service role, no JWT, triggers allow it).
export async function insertBookedLoad(po: string, status: "booked" | "requested" | "cancelled" | "delivered" = "booked"): Promise<string> {
  const db = adminClient();
  const [{ data: cust }, { data: car }, { data: maria }, { data: pu }, { data: de }] = await Promise.all([
    db.from("customers").select("id").eq("name", "Mitrex").single(),
    db.from("carriers").select("id").eq("name", CARRIER_A).single(),
    db.from("profiles").select("id").eq("email", "maria@e2e.test").single(),
    db.from("locations").select("id").eq("name", "Mitrex").single(),
    db.from("locations").select("id").eq("name", "Howden").single(),
  ]);
  const { data, error } = await db.from("loads").insert({
    customer_id: cust!.id, created_by: maria!.id, pickup_location_id: pu!.id, delivery_location_id: de!.id,
    equipment_size: 48, pickup_timing: "appointment", pickup_date: isoDate(2), pickup_time_start: "08:00",
    delivery_timing: "appointment", delivery_date: isoDate(2), delivery_time_start: "14:00",
    pickup_contact_name: "Pat", pickup_contact_phone: "416-555-0101",
    delivery_contact_name: "Dee", delivery_contact_phone: "416-555-0102",
    po_number: po, status, carrier_id: status === "requested" ? null : car!.id,
    ...(status === "cancelled" ? { cancelled_at: new Date().toISOString() } : {}),
    ...(status === "delivered" ? { delivered_at: new Date().toISOString(), eta: new Date().toISOString() } : {}),
  }).select("id").single();
  if (error) throw error;
  return data.id as string;
}
