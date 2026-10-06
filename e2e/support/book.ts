import type { Page } from "@playwright/test";
import { adminClient, isoDate, uniq } from "./helpers";

// Shared helpers for the booking form and for test locations (own rows, so a spec never edits the 19 seeded locations).

export type TestLocation = { id: string; name: string; label: string };

// A fresh active location that can ship and receive. Labels match the /book select: "<name> (<city>)".
export async function makeLocation(opts: {
  prefix?: string; ship?: boolean; receive?: boolean; contactName?: string | null; contactPhone?: string | null;
  postal?: string | null; moffett?: boolean; address?: (name: string) => string;
} = {}): Promise<TestLocation> {
  const name = uniq(opts.prefix ?? "E2E-LOC");
  const { data, error } = await adminClient().from("locations").insert({
    name, address_line: opts.address ? opts.address(name) : "1 Spec Road", city: "Testville", province: "ON",
    postal_code: opts.postal === undefined ? "A1A 1A1" : opts.postal,
    can_ship: opts.ship ?? true, can_receive: opts.receive ?? true, requires_moffett: opts.moffett ?? false,
    default_contact_name: opts.contactName ?? null, default_contact_phone: opts.contactPhone ?? null,
  }).select("id").single();
  if (error) throw error;
  return { id: data.id as string, name, label: `${name} (Testville)` };
}

// Takes test locations out of the select lists again (rows stay, loads may reference them).
export async function retireLocations(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await adminClient().from("locations").update({ is_active: false }).in("id", ids);
}

export type BookingInput = {
  pickup: string; delivery: string; // option labels
  pickupContact?: [string, string]; deliveryContact?: [string, string];
  pickupDate?: string; deliveryDate?: string;
  pickupWindow?: [string, string]; // switches pickup to a time window
  pickupTime?: string; deliveryTime?: string;
  equipment?: 26 | 36 | 53;
  po?: string;
};

// Fills the whole form, leaving the submit button for the caller. Fields not given are left as the page has them.
export async function fillBooking(page: Page, b: BookingInput): Promise<void> {
  await page.getByLabel("Pickup location").selectOption({ label: b.pickup });
  await page.getByLabel("Delivery location").selectOption({ label: b.delivery });
  const names = page.getByLabel("Contact name");
  const phones = page.getByLabel("Contact phone");
  if (b.pickupContact) { await names.nth(0).fill(b.pickupContact[0]); await phones.nth(0).fill(b.pickupContact[1]); }
  if (b.deliveryContact) { await names.nth(1).fill(b.deliveryContact[0]); await phones.nth(1).fill(b.deliveryContact[1]); }
  await page.getByLabel("Pickup date").fill(b.pickupDate ?? isoDate(3));
  if (b.pickupWindow) {
    await page.getByRole("radiogroup", { name: "Pickup timing" }).getByRole("radio", { name: "Time window" }).click();
    await page.getByLabel("Window from (ET)").fill(b.pickupWindow[0]);
    await page.getByLabel("Window to (ET)").fill(b.pickupWindow[1]);
    await page.getByLabel("Delivery date").fill(b.deliveryDate ?? b.pickupDate ?? isoDate(3));
    await page.getByLabel("Appointment time (ET)").fill(b.deliveryTime ?? "14:00");
  } else {
    await page.getByLabel("Appointment time (ET)").nth(0).fill(b.pickupTime ?? "08:00");
    await page.getByLabel("Delivery date").fill(b.deliveryDate ?? b.pickupDate ?? isoDate(3));
    await page.getByLabel("Appointment time (ET)").nth(1).fill(b.deliveryTime ?? "14:00");
  }
  await page.getByRole("radiogroup", { name: "Equipment size" }).getByRole("radio", { name: new RegExp(String(b.equipment ?? 53)) }).click();
  if (b.po !== undefined) await page.getByLabel("PO number (optional)").fill(b.po);
}

// How many loads a customer (by id) has. Used to prove a refused booking inserted nothing.
export async function customerLoadCount(): Promise<number> {
  const db = adminClient();
  const { data: cust } = await db.from("customers").select("id").eq("name", "Mitrex").single();
  const { count, error } = await db.from("loads").select("id", { count: "exact", head: true }).eq("customer_id", cust!.id);
  if (error) throw error;
  return count ?? 0;
}
