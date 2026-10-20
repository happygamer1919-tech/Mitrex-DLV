import { expect, test, type Locator, type Page } from "@playwright/test";
import { adminClient, as, isoDate, uniq, uniqIts } from "./support/helpers";
import { makeLocation, retireLocations, type TestLocation } from "./support/book";
import { sentEmails } from "./support/mail-mock";
import { CARRIER_A } from "./support/users";
import { BASE_URL } from "./support/env";
import {
  ORIGINAL_SHIPPER_SUFFIX, RETURN_QUANTITY_MESSAGE, canReturn, parseReturnParam, returnDeliveryOptions, returnLocationError,
  returnValues, validateReturnQuantity,
} from "../src/lib/customer/returnLoad";
import type { Load, Location } from "../src/lib/types";

// R43 Return loads (DLV-038). Maria's whole flow at 375px on both engines, the staff badge and "Use the same carrier".
// Everything is asserted against the database (service role) as well as the page.

test.describe.configure({ mode: "serial", timeout: 180_000 });

const db = () => adminClient();
const VIEWPORT = { width: 375, height: 812 };
const locations: string[] = [];
const parked: string[] = [];

let shipper: TestLocation; // the original shipper: can ship, CANNOT receive
let site: TestLocation; // the construction site: can receive, CANNOT ship
let scrap: TestLocation; // a scrapyard: can receive only
let shipOnly: TestLocation; // can ship only: never a return destination
let customerId = "";
let mariaId = "";
let carrierAId = "";

const SHIPPER_DEFAULT: [string, string] = ["Shipper Dflt", "416-555-1100"];
const SCRAP_DEFAULT: [string, string] = ["Scrap Dflt", "416-555-1300"];

test.beforeAll(async () => {
  shipper = await makeLocation({ prefix: "E2E-RTSHIP", ship: true, receive: false, contactName: SHIPPER_DEFAULT[0], contactPhone: SHIPPER_DEFAULT[1] });
  site = await makeLocation({ prefix: "E2E-RTSITE", ship: false, receive: true, contactName: "Site Dflt", contactPhone: "416-555-1200" });
  scrap = await makeLocation({ prefix: "E2E-RTSCRAP", ship: false, receive: true, contactName: SCRAP_DEFAULT[0], contactPhone: SCRAP_DEFAULT[1] });
  shipOnly = await makeLocation({ prefix: "E2E-RTVAL", ship: true, receive: false });
  locations.push(shipper.id, site.id, scrap.id, shipOnly.id);
  customerId = (await db().from("customers").select("id").eq("name", "Mitrex").single()).data!.id as string;
  mariaId = (await db().from("profiles").select("id").eq("email", "maria@e2e.test").single()).data!.id as string;
  carrierAId = (await db().from("carriers").select("id").eq("name", CARRIER_A).single()).data!.id as string;
});

test.afterAll(async () => {
  if (parked.length) await db().from("loads").update({ status: "cancelled" }).in("id", parked).in("status", ["requested", "booked", "at_pickup", "loading", "enroute", "at_delivery"]);
  await retireLocations(locations);
});

type Status = "requested" | "booked" | "enroute" | "at_delivery" | "delivered" | "cancelled";
type Seed = {
  po: string; status?: Status; customer?: string; createdBy?: string; pickup?: string; delivery?: string;
  equipment?: number; moffett?: boolean; weight?: number | null; pieces?: number | null; notes?: string | null;
  pTiming?: "appointment" | "window"; dTiming?: "appointment" | "window"; carrier?: string | null;
  pContact?: [string, string]; dContact?: [string, string]; returnOf?: string; its?: string | null;
};
type Seeded = { id: string; requestRef: string; its: string | null; label: string };

// Service role insert (no JWT: the guard triggers allow any status, and a return is unrestricted for it).
async function seed(o: Seed): Promise<Seeded> {
  const status = o.status ?? "delivered";
  const day = isoDate(-2);
  const its = o.its !== undefined ? o.its : status === "requested" ? null : uniqIts();
  const row: Record<string, unknown> = {
    customer_id: o.customer ?? customerId, created_by: o.createdBy ?? mariaId,
    pickup_location_id: o.pickup ?? shipper.id, delivery_location_id: o.delivery ?? site.id,
    equipment_size: o.equipment ?? 53, moffett: o.moffett ?? false,
    weight_lbs: o.weight ?? null, pieces: o.pieces ?? null, po_number: o.po, notes: o.notes ?? null, status,
    pickup_timing: o.pTiming ?? "appointment", pickup_date: day, pickup_time_start: "09:00",
    pickup_time_end: (o.pTiming ?? "appointment") === "window" ? "11:00" : null,
    delivery_timing: o.dTiming ?? "appointment", delivery_date: day, delivery_time_start: "14:00",
    delivery_time_end: (o.dTiming ?? "appointment") === "window" ? "16:00" : null,
    pickup_contact_name: (o.pContact ?? ["Orig Pat", "416-555-0101"])[0], pickup_contact_phone: (o.pContact ?? ["Orig Pat", "416-555-0101"])[1],
    delivery_contact_name: (o.dContact ?? ["Orig Dee", "416-555-0102"])[0], delivery_contact_phone: (o.dContact ?? ["Orig Dee", "416-555-0102"])[1],
    its_load_number: its,
    carrier_id: o.carrier !== undefined ? o.carrier : status === "requested" ? null : carrierAId,
    return_of_load_id: o.returnOf ?? null,
    ...(status === "delivered" ? { delivered_at: new Date().toISOString() } : {}),
    ...(status === "cancelled" ? { cancelled_at: new Date().toISOString() } : {}),
  };
  const { data, error } = await db().from("loads").insert(row).select("id,load_number,its_load_number").single();
  if (error) throw error;
  parked.push(data.id as string);
  const ref = data.load_number as string;
  const itsNo = (data.its_load_number as string | null) ?? null;
  return { id: data.id as string, requestRef: ref, its: itsNo, label: itsNo ?? `Request ${ref}` };
}

async function loadsByPo(po: string) {
  const { data, error } = await db().from("loads").select("*").eq("po_number", po).order("load_number");
  if (error) throw error;
  return (data ?? []) as Record<string, unknown>[];
}

async function expectNoOverflow(page: Page, label: string) {
  const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(w.s, `${label}: scrollWidth ${w.s} within clientWidth ${w.c}`).toBeLessThanOrEqual(w.c);
}

async function expectTall(loc: Locator, label: string) {
  const b = await loc.first().boundingBox();
  expect(b, `${label} is rendered`).not.toBeNull();
  expect(b!.height, `${label} is at least 44px tall`).toBeGreaterThanOrEqual(44);
}

async function emptyForm(page: Page) {
  await expect(page.locator("h1")).toHaveText(/Book a load/);
  await expect(page.getByTestId("return-notice")).toHaveCount(0);
  await expect(page.getByTestId("return-pickup")).toHaveCount(0);
  await expect(page.getByTestId("copied-notice")).toHaveCount(0);
  await expect(page.getByLabel("Pickup location")).toHaveValue("");
  await expect(page.getByLabel("Delivery location")).toHaveValue("");
  await expect(page.getByLabel("Contact name").nth(0)).toHaveValue("");
  await expect(page.getByLabel("PO number (optional)")).toHaveValue("");
  await expect(page.getByLabel("How many trucks?")).toHaveValue("1");
  await expect(page.getByRole("button", { name: "Request load" })).toBeVisible();
}

async function fillDates(page: Page) {
  await page.getByLabel("Pickup date").fill(isoDate(4));
  await page.getByLabel("Delivery date").fill(isoDate(4));
  await page.getByLabel("Appointment time (ET)").nth(0).fill("07:30");
  await page.getByLabel("Appointment time (ET)").nth(1).fill("12:00");
}

const loc = (id: string, o: Partial<Location> = {}): Location => ({
  id, name: id.toUpperCase(), address_line: "1 Road", city: "Town", province: "ON", postal_code: null,
  can_ship: true, can_receive: true, requires_moffett: false, default_contact_name: null, default_contact_phone: null,
  is_active: true, needs_review: false, notes: null, ...o,
});

test("pure helpers: statuses, one truck, delivery options, swapped values, the location rule", () => {
  expect(["requested", "booked", "at_pickup", "loading", "enroute", "cancelled"].map((s) => canReturn(s as never))).toEqual([false, false, false, false, false, false]);
  expect(canReturn("at_delivery")).toBe(true);
  expect(canReturn("delivered")).toBe(true);
  expect(validateReturnQuantity(1)).toEqual({ value: 1 });
  for (const bad of [0, 2, 10, "1", 1.5, null, undefined]) expect(validateReturnQuantity(bad)).toEqual({ error: RETURN_QUANTITY_MESSAGE });
  expect(parseReturnParam("0b2f3f0e-5c4f-4b8e-9d3a-1f2e3d4c5b6a")).toBe("0b2f3f0e-5c4f-4b8e-9d3a-1f2e3d4c5b6a");
  for (const bad of ["", "x", "0B2F3F0E-5C4F-4B8E-9D3A-1F2E3D4C5B6A", ["a"], undefined]) expect(parseReturnParam(bad)).toBeNull();

  // The original shipper first (even when it cannot receive), every active receiver after it, no duplicate, never the site.
  const all = [
    loc("rcv1", { can_ship: false }), loc("shipper", { can_receive: false }), loc("site", { can_ship: false }),
    loc("shiponly", { can_receive: false }), loc("gone", { is_active: false }), loc("rcv2"),
  ];
  expect(returnDeliveryOptions(all, "shipper", "site")).toEqual([
    { id: "shipper", label: `SHIPPER ${ORIGINAL_SHIPPER_SUFFIX}` },
    { id: "rcv1", label: "RCV1 (Town)" },
    { id: "rcv2", label: "RCV2 (Town)" },
  ]);
  // A shipper that can also receive is listed once, as the original shipper.
  expect(returnDeliveryOptions([loc("both"), loc("rcv")], "both", "x").map((o) => o.id)).toEqual(["both", "rcv"]);
  // An inactive original shipper is not offered.
  expect(returnDeliveryOptions([loc("shipper", { is_active: false }), loc("rcv")], "shipper", "x").map((o) => o.id)).toEqual(["rcv"]);

  const orig = {
    pickup_location_id: "P", delivery_location_id: "D", pickup_contact_name: "PN", pickup_contact_phone: "PP",
    delivery_contact_name: "DN", delivery_contact_phone: "DP", equipment_size: 36, moffett: true, weight_lbs: 900, pieces: 4,
    po_number: "PO1", notes: "Truck 1 of 2\nFrames", pickup_timing: "window", delivery_timing: "appointment",
    pickup_date: "2030-01-01", pickup_time_start: "08:00", pickup_time_end: "10:00", delivery_date: "2030-01-01", delivery_time_start: "12:00",
  } as unknown as Load;
  const v = returnValues(orig);
  expect([v.pickup_location_id, v.pickup_contact_name, v.pickup_contact_phone]).toEqual(["D", "DN", "DP"]);
  expect([v.delivery_location_id, v.delivery_contact_name, v.delivery_contact_phone]).toEqual(["P", "PN", "PP"]);
  expect([v.equipment_size, v.moffett, v.weight_lbs, v.pieces, v.po_number, v.notes]).toEqual(["36", true, "900", "4", "PO1", "Frames"]);
  expect([v.pickup_timing, v.delivery_timing]).toEqual(["window", "appointment"]);
  expect([v.pickup_date, v.pickup_time_start, v.pickup_time_end, v.delivery_date, v.delivery_time_start, v.delivery_time_end]).toEqual(["", "", "", "", "", ""]);

  const o2 = { pickup_location_id: "shipper", delivery_location_id: "site" };
  const L = Object.fromEntries(all.map((l) => [l.id, l]));
  expect(returnLocationError({ pickup_location_id: "site", delivery_location_id: "shipper" }, o2, L.site, L.shipper)).toBeNull();
  expect(returnLocationError({ pickup_location_id: "site", delivery_location_id: "rcv1" }, o2, L.site, L.rcv1)).toBeNull();
  expect(returnLocationError({ pickup_location_id: "rcv2", delivery_location_id: "shipper" }, o2, L.rcv2, L.shipper)?.field).toBe("pickup_location_id");
  expect(returnLocationError({ pickup_location_id: "site", delivery_location_id: "shiponly" }, o2, L.site, L.shiponly)?.message).toBe("This location cannot receive.");
  expect(returnLocationError({ pickup_location_id: "site", delivery_location_id: "gone" }, o2, L.site, L.gone)?.field).toBe("delivery_location_id");
  expect(returnLocationError({ pickup_location_id: "site", delivery_location_id: "shipper" }, o2, { ...L.site, is_active: false }, L.shipper)?.field).toBe("pickup_location_id");
});

test("the Return button shows only on at delivery and delivered loads, on the list and the load page, next to Request again", async ({ browser }) => {
  const s: Record<Status, Seeded> = {} as Record<Status, Seeded>;
  for (const st of ["requested", "booked", "enroute", "at_delivery", "delivered", "cancelled"] as Status[]) {
    s[st] = await seed({ po: uniq(`RT-VIS-${st.toUpperCase()}`), status: st });
  }
  const { ctx, page } = await as(browser, "maria", VIEWPORT);
  await page.goto("/loads");
  await expect(page.locator("h1")).toHaveText(/My loads/);
  for (const [st, l] of Object.entries(s) as [Status, Seeded][]) {
    const row = page.getByRole("listitem").filter({ hasText: l.its ?? l.requestRef });
    await expect(row, `${st} row`).toHaveCount(1);
    const want = st === "at_delivery" || st === "delivered" ? 1 : 0;
    await expect(row.getByRole("link", { name: "Return", exact: true }), `${st}: Return on the list`).toHaveCount(want);
    if (want) await expect(row.getByRole("link", { name: "Return", exact: true })).toHaveAttribute("href", `/book?return=${l.id}`);
    await expect(row.getByRole("link", { name: "Request again" }), `${st}: Request again only when delivered`).toHaveCount(st === "delivered" ? 1 : 0);
  }
  await expectTall(page.getByRole("listitem").filter({ hasText: s.delivered.its! }).getByTestId("return-button"), "Return (list)");
  await expectNoOverflow(page, "/loads");
  for (const [st, l] of Object.entries(s) as [Status, Seeded][]) {
    await page.goto(`/loads/${l.id}`);
    await expect(page.locator("h1")).toHaveText(new RegExp(l.its ?? "Number pending"));
    const want = st === "at_delivery" || st === "delivered" ? 1 : 0;
    await expect(page.getByTestId("return-button"), `${st}: Return on the load page`).toHaveCount(want);
    if (want) {
      await expect(page.getByTestId("return-button")).toHaveText("Return");
      await expect(page.getByTestId("return-button")).toHaveAttribute("href", `/book?return=${l.id}`);
      await expectTall(page.getByTestId("return-button"), `Return (${st} page)`);
      await expectNoOverflow(page, `/loads/[id] ${st}`);
    }
    await expect(page.getByRole("link", { name: "Request again" })).toHaveCount(st === "delivered" ? 1 : 0);
  }
  await ctx.close();
});

test("Maria books a return: swapped and prefilled, contacts follow the delivery choice, one truck, linked both ways, staff email", async ({ browser }) => {
  const po = uniq("RT-FLOW");
  const orig = await seed({
    po, status: "delivered", equipment: 36, weight: 12345, pieces: 7, notes: "Truck 2 of 3\nFrames back",
    pTiming: "window", dTiming: "appointment", pContact: ["Orig Pat", "416-555-0111"], dContact: ["Orig Dee", "416-555-0112"],
  });
  const { ctx, page } = await as(browser, "maria", VIEWPORT);
  await page.goto(`/loads/${orig.id}`);
  await page.getByTestId("return-button").click();
  await expect(page).toHaveURL(new RegExp(`/book\\?return=${orig.id}$`));
  await expect(page.locator("h1")).toHaveText("Book a return");
  await expect(page.getByTestId("return-notice")).toHaveText(`Return of ${orig.its}. The truck reloads at ${site.name}. Choose where it goes and the new dates.`);
  await expect(page.getByTestId("return-existing")).toHaveCount(0);
  await expect(page.getByTestId("copied-notice")).toHaveCount(0);

  // Pickup: FIXED to the original delivery (read only, no select), with the original DELIVERY contact.
  await expect(page.getByTestId("return-pickup")).toContainText(`${site.name} (Testville)`);
  await expect(page.getByRole("combobox", { name: "Pickup location" })).toHaveCount(0);
  await expect(page.getByLabel("Contact name").nth(0)).toHaveValue("Orig Dee");
  await expect(page.getByLabel("Contact phone").nth(0)).toHaveValue("416-555-0112");
  // Delivery: the original shipper first and preselected, with the original PICKUP contact.
  const del = page.getByLabel("Delivery location");
  await expect(del).toHaveValue(shipper.id);
  const opts = await del.locator("option").allTextContents();
  expect(opts[1]).toBe(`${shipper.name} (original shipper)`);
  expect(opts.filter((t) => t.startsWith(shipper.name))).toHaveLength(1);
  expect(opts).toContain(scrap.label);
  expect(opts.some((t) => t.startsWith(site.name)), "the reload site is not a destination").toBe(false);
  expect(opts.some((t) => t.startsWith(shipOnly.name)), "a place that cannot receive and is not the original shipper is not offered").toBe(false);
  await expect(page.getByLabel("Contact name").nth(1)).toHaveValue("Orig Pat");
  await expect(page.getByLabel("Contact phone").nth(1)).toHaveValue("416-555-0111");
  // Another place: its default contact (today's behaviour); back to the shipper: the original pickup contact again.
  await del.selectOption({ label: scrap.label });
  await expect(page.getByLabel("Contact name").nth(1)).toHaveValue(SCRAP_DEFAULT[0]);
  await expect(page.getByLabel("Contact phone").nth(1)).toHaveValue(SCRAP_DEFAULT[1]);
  await del.selectOption({ label: `${shipper.name} (original shipper)` });
  await expect(page.getByLabel("Contact name").nth(1)).toHaveValue("Orig Pat");
  // Copied unchanged; dates empty; timing kept; no trucks stepper.
  await expect(page.getByRole("radiogroup", { name: "Equipment size" }).getByRole("radio", { name: /36/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByLabel("Weight (lbs, optional)")).toHaveValue("12345");
  await expect(page.getByLabel("Pieces (optional)")).toHaveValue("7");
  await expect(page.getByLabel("PO number (optional)")).toHaveValue(po);
  await expect(page.getByLabel("Notes (optional)")).toHaveValue("Frames back");
  await expect(page.getByRole("radiogroup", { name: "Pickup timing" }).getByRole("radio", { name: "Time window" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radiogroup", { name: "Delivery timing" }).getByRole("radio", { name: "Appointment" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByLabel("Pickup date")).toHaveValue("");
  await expect(page.getByLabel("Delivery date")).toHaveValue("");
  await expect(page.getByLabel("Window from (ET)")).toHaveValue("");
  await expect(page.getByLabel("How many trucks?")).toHaveCount(0);
  await expectTall(page.getByRole("button", { name: "Dismiss notice" }), "Dismiss notice");
  await expectNoOverflow(page, "/book?return=");
  // As copied the dates are missing: refused, nothing written.
  await page.getByRole("button", { name: "Request return" }).click();
  await expect(page.getByText("Pickup date is required.")).toBeVisible();
  expect(await loadsByPo(po)).toHaveLength(1);

  await page.getByLabel("Contact name").nth(0).fill("Site Sam");
  await page.getByLabel("Pickup date").fill(isoDate(4));
  await page.getByLabel("Window from (ET)").fill("07:00");
  await page.getByLabel("Window to (ET)").fill("09:00");
  await page.getByLabel("Delivery date").fill(isoDate(4));
  await page.getByLabel("Appointment time (ET)").fill("13:00");
  const before = (await sentEmails()).length;
  await page.getByRole("button", { name: "Request return" }).click();
  await page.waitForURL(/\/loads\/[0-9a-f-]{36}$/);
  const rows = await loadsByPo(po);
  expect(rows, "exactly one new load (one truck)").toHaveLength(2);
  const n = rows.find((r) => r.id !== orig.id)!;
  expect(n.return_of_load_id).toBe(orig.id);
  expect(n.pickup_location_id).toBe(site.id); // a site that cannot ship
  expect(n.delivery_location_id).toBe(shipper.id); // the original shipper that cannot receive
  expect(n.pickup_contact_name).toBe("Site Sam");
  expect(n.pickup_contact_phone).toBe("416-555-0112");
  expect([n.delivery_contact_name, n.delivery_contact_phone]).toEqual(["Orig Pat", "416-555-0111"]);
  expect([n.equipment_size, Number(n.weight_lbs), n.pieces, n.notes, n.status, n.customer_id, n.carrier_id, n.its_load_number])
    .toEqual([36, 12345, 7, "Frames back", "requested", customerId, null, null]);
  expect(n.created_by).toBe(mariaId);
  expect([n.pickup_date, String(n.pickup_time_start).slice(0, 5), String(n.pickup_time_end).slice(0, 5)]).toEqual([isoDate(4), "07:00", "09:00"]);

  // The link both ways.
  const ref = n.load_number as string;
  await expect(page.getByTestId("return-of")).toHaveText(`Return of ${orig.its}`);
  await expect(page.getByTestId("return-of").getByRole("link")).toHaveAttribute("href", `/loads/${orig.id}`);
  await expectNoOverflow(page, "/loads/[return]");
  await page.goto(`/loads/${orig.id}`);
  const list = page.getByTestId("return-loads");
  await expect(list).toContainText("Return loads:");
  await expect(list.getByRole("link", { name: `Request ${ref}` })).toHaveAttribute("href", `/loads/${n.id}`);
  await expect(list.getByRole("listitem").filter({ hasText: ref })).toContainText("Requested");

  // The staff email: return subject, the original and its carrier near the top, everything else as today.
  await expect.poll(async () => (await sentEmails()).slice(before).filter((m) => m.subject === `New return load requested (Request ${ref})`).length).toBe(1);
  const mail = (await sentEmails()).slice(before).find((m) => m.subject === `New return load requested (Request ${ref})`)!;
  const text = mail.text ?? "";
  const lines = text.split("\n");
  expect(lines[0]).toBe("A new return load was requested by Mitrex.");
  expect(lines[2]).toBe(`Return of ${orig.its}, original carrier: ${CARRIER_A}`);
  expect(text).toContain(`Request ref: ${ref}`);
  expect(text).toContain("ITS load number: not assigned yet. Enter it when you book.");
  expect(text).toMatch(/ITS load to copy: |No ITS reference for this lane and size yet\. Add it: /);
  expect(text).toContain(`Route: ${site.name} to ${shipper.name}`);
  expect(mail.to).toContain("admin@e2e.test");
  expect(mail.to).not.toContain("maria@e2e.test");

  // A second visit says a return was already requested (information, not blocking).
  await page.goto(`/book?return=${orig.id}`);
  await expect(page.getByTestId("return-existing")).toHaveText(`A return was already requested for this load: Request ${ref}.`);
  await expect(page.getByRole("button", { name: "Request return" })).toBeEnabled();
  await ctx.close();
});

test("a return of an at delivery load to a scrapyard, from the list row, and the edit form keeps the pickup fixed", async ({ browser }) => {
  const po = uniq("RT-SCRAP");
  const orig = await seed({ po, status: "at_delivery" });
  const { ctx, page } = await as(browser, "maria", VIEWPORT);
  await page.goto("/loads?status=at_delivery");
  await page.getByRole("listitem").filter({ hasText: orig.its! }).getByRole("link", { name: "Return", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/book\\?return=${orig.id}$`));
  await page.getByLabel("Delivery location").selectOption({ label: scrap.label });
  await fillDates(page);
  await page.getByRole("button", { name: "Request return" }).click();
  await page.waitForURL(/\/loads\/[0-9a-f-]{36}$/);
  const n = (await loadsByPo(po)).find((r) => r.id !== orig.id)!;
  expect([n.return_of_load_id, n.pickup_location_id, n.delivery_location_id]).toEqual([orig.id, site.id, scrap.id]);
  expect([n.delivery_contact_name, n.delivery_contact_phone]).toEqual(SCRAP_DEFAULT);
  // Edit while requested: the pickup stays fixed and the original shipper can still be chosen.
  await page.goto(`/loads/${n.id}/edit`);
  await expect(page.getByTestId("return-pickup")).toContainText(site.name);
  await expect(page.getByTestId("return-notice")).toHaveCount(0);
  await page.getByLabel("Delivery location").selectOption({ label: `${shipper.name} (original shipper)` });
  await expect(page.getByLabel("Contact name").nth(1)).toHaveValue("Orig Pat");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(new RegExp(`/loads/${n.id}$`));
  const after = (await db().from("loads").select("pickup_location_id,delivery_location_id,return_of_load_id").eq("id", n.id).single()).data!;
  expect(after).toEqual({ pickup_location_id: site.id, delivery_location_id: shipper.id, return_of_load_id: orig.id });
  await ctx.close();
});

test("a malformed, unknown, foreign, requested or not yet delivered ?return= opens the empty form and leaks nothing, and return wins over from", async ({ browser }) => {
  const other = await db().from("customers").insert({ name: uniq("E2E-RT-OTHER") }).select("id").single();
  expect(other.error).toBeNull();
  const staffId = (await db().from("profiles").select("id").eq("email", "admin@e2e.test").single()).data!.id as string;
  const foreignPo = uniq("RT-FOREIGN-PO");
  const foreignName = "Zed Returncontact";
  const foreign = await seed({ po: foreignPo, customer: other.data!.id as string, createdBy: staffId, pContact: [foreignName, "905-555-0997"], dContact: [foreignName, "905-555-0996"] });
  const requested = await seed({ po: uniq("RT-BAD-REQ"), status: "requested" });
  const booked = await seed({ po: uniq("RT-BAD-BKD"), status: "booked" });
  const enroute = await seed({ po: uniq("RT-BAD-ENR"), status: "enroute" });
  const cancelled = await seed({ po: uniq("RT-BAD-CXL"), status: "cancelled" });
  const good = await seed({ po: uniq("RT-GOOD"), status: "delivered" });
  // A delivered load of a lane that can be copied (Request again needs a shipper that can ship and a receiver).
  const copyable = await seed({ po: uniq("RT-FROM"), status: "delivered", pickup: shipOnly.id, delivery: scrap.id });
  const { ctx, page } = await as(browser, "maria", VIEWPORT);
  const bads: [string, string][] = [
    ["foreign customer's delivered load", `return=${foreign.id}`],
    ["own requested load", `return=${requested.id}`],
    ["own booked load", `return=${booked.id}`],
    ["own enroute load", `return=${enroute.id}`],
    ["own cancelled load", `return=${cancelled.id}`],
    ["well formed unknown id", "return=00000000-0000-4000-8000-000000000000"],
    ["not an id", "return=not-a-uuid"],
    ["sql shaped", `return=${encodeURIComponent("' or 1=1 --")}`],
    ["uppercase id", `return=${good.id.toUpperCase()}`],
    ["two values", `return=${good.id}&return=${good.id}`],
    ["empty", "return="],
    ["a bad return wins over a good from", `return=${foreign.id}&from=${copyable.id}`],
  ];
  for (const [label, qs] of bads) {
    await page.goto(`/book?${qs}`);
    await emptyForm(page);
    const html = await page.content();
    for (const secret of [foreignPo, foreignName, foreign.its!, foreign.requestRef, "905-555-0997"]) {
      expect(html.includes(secret), `${label}: the page does not contain ${secret}`).toBe(false);
    }
  }
  // Controls: a good return opens the return form, also when a from is given; a good from alone still copies.
  await page.goto(`/book?return=${good.id}&from=${copyable.id}`);
  await expect(page.getByTestId("return-notice")).toContainText(`Return of ${good.its}.`);
  await expect(page.getByTestId("copied-notice")).toHaveCount(0);
  await page.goto(`/book?from=${copyable.id}`);
  await expect(page.getByTestId("copied-notice")).toContainText(copyable.its!);
  await expect(page.getByTestId("return-notice")).toHaveCount(0);
  await ctx.close();
});

test("staff: the Return badge on the board (both views) and the calendar, the links, Original carrier and Use the same carrier", async ({ browser }) => {
  const po = uniq("RT-STAFF");
  const orig = await seed({ po, status: "delivered" });
  const ret = await seed({ po, status: "requested", pickup: site.id, delivery: shipper.id, returnOf: orig.id });
  const plain = await seed({ po, status: "requested", pickup: shipOnly.id, delivery: scrap.id });
  const noCarrierOrig = await seed({ po: uniq("RT-NOCAR"), status: "requested", carrier: null });
  const ret2 = await seed({ po: uniq("RT-NOCAR"), status: "requested", pickup: site.id, delivery: shipper.id, returnOf: noCarrierOrig.id });
  // Pickup on a known day for the calendar.
  const day = isoDate(3);
  await db().from("loads").update({ pickup_date: day, delivery_date: day }).in("id", [ret.id, plain.id]);
  const { ctx, page } = await as(browser, "admin", VIEWPORT);
  const badgeIn = (id: string) => page.locator(`a[href="/admin/loads/${id}"] [data-testid="board-return-badge"]:visible`);

  await page.goto(`/admin?q=${encodeURIComponent(po)}`);
  await expect(page.locator("h1")).toHaveText(/Load board/);
  await expect(badgeIn(ret.id)).toHaveCount(1);
  await expect(badgeIn(ret.id)).toHaveText("Return");
  await expect(badgeIn(plain.id)).toHaveCount(0);
  await expect(page.locator(`a[href="/admin/loads/${plain.id}"]:visible`)).toHaveCount(1);
  await expectNoOverflow(page, "/admin (by status)");
  // One list view: cards at phone width, the table at desktop width; the badge is next to the number in both.
  await page.goto(`/admin?view=list&q=${encodeURIComponent(po)}`);
  await expect(page.getByTestId("board-list").locator('[data-testid="board-return-badge"]:visible')).toHaveCount(1);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByTestId("board-list").locator("table")).toBeVisible();
  const row = page.getByTestId("board-list").locator("tr").filter({ has: page.locator(`a[href="/admin/loads/${ret.id}"]`) });
  await expect(row.getByTestId("board-return-badge")).toHaveText("Return");
  await expect(page.getByTestId("board-list").locator("tr").filter({ has: page.locator(`a[href="/admin/loads/${plain.id}"]`) }).getByTestId("board-return-badge")).toHaveCount(0);
  await page.setViewportSize(VIEWPORT);
  // Calendar (cards are shown there).
  await page.goto(`/admin/calendar?view=week&date=${day}`);
  await expect(badgeIn(ret.id).first()).toBeVisible();
  await expect(badgeIn(plain.id)).toHaveCount(0);

  // The return load page: badge, the link to the original, Original carrier and Use the same carrier.
  await page.goto(`/admin/loads/${ret.id}`);
  await expect(page.getByTestId("return-badge")).toHaveText("Return");
  await expect(page.getByTestId("return-of")).toHaveText(`Return of ${orig.its}`);
  await expect(page.getByTestId("return-of").getByRole("link")).toHaveAttribute("href", `/admin/loads/${orig.id}`);
  await expect(page.getByTestId("original-carrier")).toContainText(`Original carrier: ${CARRIER_A}`);
  const same = page.getByRole("button", { name: "Use the same carrier" });
  await expectTall(page.getByTestId("original-carrier").getByRole("button"), "Use the same carrier");
  await expectNoOverflow(page, "/admin/loads/[return]");
  const mailsBefore = (await sentEmails()).length;
  await same.click();
  await expect.poll(async () => (await db().from("loads").select("carrier_id").eq("id", ret.id).single()).data!.carrier_id).toBe(carrierAId);
  await expect(page.getByTestId("original-carrier")).toHaveCount(0);
  await expect(page.locator('select[name="carrier_id"]')).toHaveValue(carrierAId);
  // Same carrier email rules: a requested load tells no carrier yet.
  expect((await sentEmails()).slice(mailsBefore).filter((m) => m.subject.includes("assigned to you"))).toHaveLength(0);
  // The original's page lists the return.
  await page.goto(`/admin/loads/${orig.id}`);
  await expect(page.getByTestId("return-loads").getByRole("link", { name: `Request ${ret.requestRef}` })).toHaveAttribute("href", `/admin/loads/${ret.id}`);
  await expect(page.getByTestId("return-badge")).toHaveCount(0);
  // An original without a carrier: the line says so and offers no button.
  await page.goto(`/admin/loads/${ret2.id}`);
  await expect(page.getByTestId("original-carrier")).toContainText("Original carrier: Not assigned");
  await expect(page.getByRole("button", { name: "Use the same carrier" })).toHaveCount(0);
  await ctx.close();
});

test("the server re-checks a forged return: not returnable, foreign, a moved pickup, two trucks, a refused delivery, and a real call works", async ({ browser }) => {
  const po = uniq("RT-FORGE");
  const good = await seed({ po, status: "delivered" });
  const requested = await seed({ po: uniq("RT-FORGE-REQ"), status: "requested" });
  const other = await db().from("customers").insert({ name: uniq("E2E-RT-FORGE") }).select("id").single();
  expect(other.error).toBeNull();
  const foreign = await seed({ po: uniq("RT-FORGE-FOR"), customer: other.data!.id as string });
  const { ctx, page } = await as(browser, "maria", VIEWPORT);
  // The id of the createReturnLoad action, read from a real submit of the return form (one return is made here).
  let actionId: string | null = null;
  page.on("request", (r) => {
    const h = r.headers()["next-action"];
    if (r.method() === "POST" && h && r.url().includes("/book")) actionId = h;
  });
  await page.goto(`/book?return=${good.id}`);
  await fillDates(page);
  await page.getByRole("button", { name: "Request return" }).click();
  await page.waitForURL(/\/loads\/[0-9a-f-]{36}$/);
  expect(actionId, "the return form sent a server action request").not.toBeNull();
  const made = (await loadsByPo(po)).length;

  const row = async (id: string) => (await db().from("loads").select("*").eq("id", id).single()).data as unknown as Load;
  const valuesOf = (l: Load) => ({
    ...returnValues(l), pickup_date: isoDate(4), pickup_time_start: "07:30", delivery_date: isoDate(4), delivery_time_start: "12:00",
  });
  const forge = async (args: unknown[]) => {
    const res = await ctx.request.post(`/book?return=${good.id}`, {
      headers: { "Next-Action": actionId!, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component", Origin: BASE_URL },
      data: JSON.stringify(args), maxRedirects: 0,
    });
    return { status: res.status(), text: await res.text(), redirect: res.headers()["x-action-redirect"] ?? "" };
  };
  const g = await row(good.id);
  const cases: [string, unknown[], RegExp][] = [
    ["a requested original", [requested.id, valuesOf(await row(requested.id)), 1], /This load cannot be returned/],
    ["another customer's delivered load", [foreign.id, valuesOf(await row(foreign.id)), 1], /This load cannot be returned/],
    ["a malformed id", ["not-a-uuid", valuesOf(g), 1], /This load cannot be returned/],
    ["a pickup that is not the original delivery", [good.id, { ...valuesOf(g), pickup_location_id: shipOnly.id }], /A return picks up where the original load was delivered/],
    ["two trucks", [good.id, valuesOf(g), 2], /A return is always one truck/],
    ["a delivery that cannot receive and is not the original shipper", [good.id, { ...valuesOf(g), delivery_location_id: shipOnly.id }], /This location cannot receive/],
  ];
  for (const [label, args, want] of cases) {
    const r = await forge(args);
    expect(r.status, `${label}: the forged call reached the action`).toBeLessThan(400);
    expect(r.redirect, `${label}: no redirect to a new load`).toBe("");
    expect(r.text, `${label}: refused with the right message`).toMatch(want);
  }
  expect(await loadsByPo(po), "the refused calls wrote nothing").toHaveLength(made);
  for (const id of [requested.id, foreign.id]) {
    expect((await db().from("loads").select("id").eq("return_of_load_id", id)).data, "no return linked to a refused original").toEqual([]);
  }
  // Control: the same forged call with valid values is a real call and makes one return.
  const ok = await forge([good.id, valuesOf(g), 1]);
  expect(ok.redirect).toMatch(/\/loads\/[0-9a-f-]{36}/);
  expect(await loadsByPo(po)).toHaveLength(made + 1);
  await ctx.close();
});
