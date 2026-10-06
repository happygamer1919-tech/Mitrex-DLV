import { expect, test, type Page } from "@playwright/test";
import { adminClient, as, isoDate, uniq } from "./support/helpers";
import { makeLocation, retireLocations, type TestLocation } from "./support/book";
import { stripTruckLine, buildLastContacts, parseFromParam } from "../src/lib/customer/requestAgain";

// R20 and R22: Completed filter, Request again (/book?from=<delivered load>), last contact hints.
// Everything is asserted against the database (service role) as well as the page.

test.describe.configure({ mode: "serial", timeout: 180_000 });

const db = () => adminClient();
const VIEWPORT = { width: 375, height: 812 };
const locations: string[] = [];
const touchedPos: string[] = [];
const parked: string[] = [];

let pu: TestLocation; // pickup with a saved default contact
let de: TestLocation; // delivery with a saved default contact
let bare: TestLocation; // never used by a load, has a saved default contact
let customerId = "";
let mariaId = "";

const PU_DEFAULT: [string, string] = ["Dflt Pickup", "416-555-0200"];
const DE_DEFAULT: [string, string] = ["Dflt Delivery", "416-555-0300"];
const BARE_DEFAULT: [string, string] = ["Dflt Bare", "416-555-0400"];

test.beforeAll(async () => {
  pu = await makeLocation({ prefix: "E2E-RAP", contactName: PU_DEFAULT[0], contactPhone: PU_DEFAULT[1] });
  de = await makeLocation({ prefix: "E2E-RAD", contactName: DE_DEFAULT[0], contactPhone: DE_DEFAULT[1] });
  bare = await makeLocation({ prefix: "E2E-RAB", contactName: BARE_DEFAULT[0], contactPhone: BARE_DEFAULT[1] });
  locations.push(pu.id, de.id, bare.id);
  customerId = (await db().from("customers").select("id").eq("name", "Mitrex").single()).data!.id as string;
  mariaId = (await db().from("profiles").select("id").eq("email", "maria@e2e.test").single()).data!.id as string;
});

test.afterAll(async () => {
  const d = db();
  for (const po of touchedPos) await d.from("loads").update({ status: "cancelled" }).eq("po_number", po).in("status", ["requested", "booked"]);
  if (parked.length) await d.from("loads").update({ status: "cancelled" }).in("id", parked).in("status", ["requested", "booked"]);
  await retireLocations(locations);
});

type Seed = {
  po: string; status?: "delivered" | "booked" | "cancelled" | "requested"; customer?: string;
  pickup?: string; delivery?: string; equipment?: number; moffett?: boolean; weight?: number | null; pieces?: number | null;
  notes?: string | null; pTiming?: "appointment" | "window"; dTiming?: "appointment" | "window";
  createdBy?: string; pContact?: [string, string]; dContact?: [string, string]; createdAt?: string; deliveredAt?: string;
};

async function seed(o: Seed): Promise<{ id: string; loadNumber: string }> {
  const status = o.status ?? "delivered";
  const day = isoDate(-3);
  const row: Record<string, unknown> = {
    customer_id: o.customer ?? customerId, created_by: o.createdBy ?? mariaId,
    pickup_location_id: o.pickup ?? pu.id, delivery_location_id: o.delivery ?? de.id,
    equipment_size: o.equipment ?? 53, moffett: o.moffett ?? false,
    weight_lbs: o.weight === undefined ? null : o.weight, pieces: o.pieces === undefined ? null : o.pieces,
    po_number: o.po, notes: o.notes ?? null, status,
    pickup_timing: o.pTiming ?? "appointment", pickup_date: day, pickup_time_start: "09:00",
    pickup_time_end: (o.pTiming ?? "appointment") === "window" ? "11:00" : null,
    delivery_timing: o.dTiming ?? "appointment", delivery_date: day, delivery_time_start: "14:00",
    delivery_time_end: (o.dTiming ?? "appointment") === "window" ? "16:00" : null,
    pickup_contact_name: (o.pContact ?? ["Pat Pickup", "416-555-0101"])[0], pickup_contact_phone: (o.pContact ?? ["Pat Pickup", "416-555-0101"])[1],
    delivery_contact_name: (o.dContact ?? ["Dee Delivery", "416-555-0102"])[0], delivery_contact_phone: (o.dContact ?? ["Dee Delivery", "416-555-0102"])[1],
    ...(status === "delivered" ? { delivered_at: o.deliveredAt ?? new Date().toISOString() } : {}),
    ...(status === "cancelled" ? { cancelled_at: new Date().toISOString() } : {}),
    ...(o.createdAt ? { created_at: o.createdAt } : {}),
  };
  if (status === "booked" || status === "delivered") {
    const { data: car } = await db().from("carriers").select("id").eq("name", "E2E Carrier A").single();
    row.carrier_id = car!.id;
  }
  const { data, error } = await db().from("loads").insert(row).select("id,load_number").single();
  if (error) throw error;
  if (status === "booked" || status === "requested") parked.push(data.id as string);
  touchedPos.push(o.po);
  return { id: data.id as string, loadNumber: data.load_number as string };
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
// Minutes ago, fixed once per call site: the history lookup sees only the customer's 200 most recent loads, so the
// seeded loads must be recent, not days old, on a database that accumulates loads across runs.
const minAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const etDate = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));

async function expectNoOverflow(page: Page, label: string) {
  const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(w.s, `${label}: scrollWidth ${w.s} within clientWidth ${w.c}`).toBeLessThanOrEqual(w.c);
}

async function expectTall(page: Page, loc: ReturnType<Page["getByRole"]>, label: string) {
  const b = await loc.first().boundingBox();
  expect(b, `${label} is rendered`).not.toBeNull();
  expect(b!.height, `${label} is at least 44px tall`).toBeGreaterThanOrEqual(44);
}

async function emptyForm(page: Page) {
  await expect(page.locator("h1")).toHaveText(/Book a load/);
  await expect(page.getByLabel("Pickup location")).toHaveValue("");
  await expect(page.getByLabel("Delivery location")).toHaveValue("");
  await expect(page.getByLabel("Contact name").nth(0)).toHaveValue("");
  await expect(page.getByLabel("PO number (optional)")).toHaveValue("");
  await expect(page.getByLabel("Notes (optional)")).toHaveValue("");
  await expect(page.getByLabel("Weight (lbs, optional)")).toHaveValue("");
  await expect(page.getByLabel("Pickup date")).toHaveValue("");
  await expect(page.getByTestId("copied-notice")).toHaveCount(0);
  await expect(page.getByRole("radiogroup", { name: "Equipment size" }).locator('[aria-checked="true"]')).toHaveCount(0);
}

async function fillDates(page: Page, o: { pickupWindow?: boolean } = {}) {
  await page.getByLabel("Pickup date").fill(isoDate(5));
  await page.getByLabel("Delivery date").fill(isoDate(6));
  if (o.pickupWindow) {
    await page.getByLabel("Window from (ET)").fill("08:00");
    await page.getByLabel("Window to (ET)").fill("10:00");
    await page.getByLabel("Appointment time (ET)").fill("13:00");
  } else {
    await page.getByLabel("Appointment time (ET)").nth(0).fill("08:00");
    await page.getByLabel("Appointment time (ET)").nth(1).fill("13:00");
  }
}

async function newLoadsFor(po: string, sourceId: string) {
  const { data, error } = await db().from("loads").select("*").eq("po_number", po).neq("id", sourceId).order("load_number");
  if (error) throw error;
  return (data ?? []) as Record<string, unknown>[];
}

test("pure helpers: the Truck i of N line is stripped only when it is the exact first line", () => {
  expect(stripTruckLine(null)).toBe("");
  expect(stripTruckLine("Truck 2 of 3")).toBe("");
  expect(stripTruckLine("Truck 2 of 3\nKeep dry")).toBe("Keep dry");
  expect(stripTruckLine("Truck 10 of 10\r\nKeep dry\nSecond line")).toBe("Keep dry\nSecond line");
  expect(stripTruckLine("Keep dry\nTruck 2 of 3")).toBe("Keep dry\nTruck 2 of 3");
  expect(stripTruckLine("Truck x of 3\nKeep dry")).toBe("Truck x of 3\nKeep dry");
  expect(stripTruckLine("Trucks 2 of 3")).toBe("Trucks 2 of 3");
  expect(parseFromParam("0b2f3f0e-5c4f-4b8e-9d3a-1f2e3d4c5b6a")).toBe("0b2f3f0e-5c4f-4b8e-9d3a-1f2e3d4c5b6a");
  for (const bad of ["", "abc", "0B2F3F0E-5C4F-4B8E-9D3A-1F2E3D4C5B6A", "0b2f3f0e-5c4f-4b8e-9d3a-1f2e3d4c5b6a'", undefined, ["x"]]) {
    expect(parseFromParam(bad)).toBeNull();
  }
  const rows = [
    { id: "1", load_number: "MTX-1", created_at: "2030-01-02T00:00:00Z", pickup_location_id: "L", delivery_location_id: "M", pickup_contact_name: "New", pickup_contact_phone: "2", delivery_contact_name: "D2", delivery_contact_phone: "2" },
    { id: "2", load_number: "MTX-2", created_at: "2030-01-01T00:00:00Z", pickup_location_id: "L", delivery_location_id: "M", pickup_contact_name: "Old", pickup_contact_phone: "1", delivery_contact_name: "D1", delivery_contact_phone: "1" },
  ];
  expect(buildLastContacts(rows).pickup.L.name).toBe("New");
  expect(buildLastContacts(rows.slice().reverse()).pickup.L.name).toBe("New");
  expect(buildLastContacts(rows).delivery.M.loadNumber).toBe("MTX-1");
});

test("the Completed filter lists delivered loads only, newest first with the delivered date, each with Request again", async ({ browser }) => {
  const older = await seed({ po: uniq("RA-CMP-OLD"), deliveredAt: hoursAgo(48) });
  const newer = await seed({ po: uniq("RA-CMP-NEW"), deliveredAt: hoursAgo(1) });
  const booked = await seed({ po: uniq("RA-CMP-BKD"), status: "booked" });
  const cancelled = await seed({ po: uniq("RA-CMP-CXL"), status: "cancelled" });
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/loads");
  await expect(page.locator("h1")).toHaveText(/My loads/);
  await page.getByRole("navigation", { name: "Filter by status" }).getByRole("link", { name: "Completed", exact: true }).click();
  await expect(page).toHaveURL(/\/loads\?view=completed$/);
  await expect(page.locator("h1")).toHaveText(/My loads/);
  const item = (n: string) => page.getByRole("listitem").filter({ hasText: n });
  await expect(item(newer.loadNumber)).toHaveCount(1);
  await expect(item(older.loadNumber)).toHaveCount(1);
  await expect(page.getByText(booked.loadNumber, { exact: true })).toHaveCount(0);
  await expect(page.getByText(cancelled.loadNumber, { exact: true })).toHaveCount(0);
  // Every row on the page is delivered and offers Request again.
  const rows = page.getByRole("listitem").filter({ hasText: /MTX-\d+/ });
  const count = await rows.count();
  expect(count).toBeGreaterThanOrEqual(2);
  for (let i = 0; i < count; i++) {
    await expect(rows.nth(i)).toContainText("Delivered");
    await expect(rows.nth(i).getByRole("link", { name: "Request again" })).toHaveCount(1);
  }
  await expect(item(newer.loadNumber).getByTestId("delivered-date")).toContainText(`Delivered ${new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric" }).format(new Date(Date.now() - 3_600_000))}`);
  // Newest delivery first.
  const text = await page.getByRole("list").filter({ has: item(newer.loadNumber) }).first().innerText();
  expect(text.indexOf(newer.loadNumber), "newer delivered load listed before the older one").toBeLessThan(text.indexOf(older.loadNumber));
  // The authoritative statuses.
  const st = await db().from("loads").select("id,status").in("id", [older.id, newer.id, booked.id, cancelled.id]);
  expect(Object.fromEntries((st.data ?? []).map((r) => [r.id, r.status]))).toEqual({
    [older.id]: "delivered", [newer.id]: "delivered", [booked.id]: "booked", [cancelled.id]: "cancelled",
  });
  // The unfiltered list shows Request again on delivered rows only.
  await page.goto("/loads");
  await expect(item(booked.loadNumber)).toHaveCount(1);
  await expect(item(booked.loadNumber).getByRole("link", { name: "Request again" })).toHaveCount(0);
  await expect(item(cancelled.loadNumber).getByRole("link", { name: "Request again" })).toHaveCount(0);
  await expect(item(newer.loadNumber).getByRole("link", { name: "Request again" })).toHaveCount(1);
  // Detail pages: delivered has the prominent button next to the Delivered note, cancelled and booked do not.
  await page.goto(`/loads/${newer.id}`);
  await expect(page.locator("h1")).toHaveText(new RegExp(newer.loadNumber));
  await expect(page.getByTestId("load-state-note")).toContainText(/^Delivered on /);
  await expect(page.getByRole("link", { name: "Request again" })).toHaveAttribute("href", `/book?from=${newer.id}`);
  for (const l of [cancelled, booked]) {
    await page.goto(`/loads/${l.id}`);
    await expect(page.locator("h1")).toHaveText(new RegExp(l.loadNumber));
    await expect(page.getByRole("link", { name: "Request again" })).toHaveCount(0);
  }
  await ctx.close();
});

test("Request again copies the details, leaves every date and time empty, and books a new load with the edited contacts", async ({ browser }) => {
  const po = uniq("RA-COPY");
  const src = await seed({
    po, equipment: 36, weight: 12345, pieces: 7, notes: "Truck 2 of 3\nHandle with care",
    pTiming: "window", dTiming: "appointment",
    pContact: ["Src Pat", "416-555-0111"], dContact: ["Src Dee", "416-555-0112"],
  });
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/loads?view=completed");
  await expect(page.locator("h1")).toHaveText(/My loads/);
  await page.getByRole("listitem").filter({ hasText: src.loadNumber }).getByRole("link", { name: "Request again" }).click();
  await expect(page).toHaveURL(new RegExp(`/book\\?from=${src.id}$`));
  await expect(page.locator("h1")).toHaveText(/Book a load/);
  await expect(page.getByTestId("copied-notice")).toHaveText(`Copied from ${src.loadNumber}. Choose the new dates and times.`);

  await expect(page.getByLabel("Pickup location")).toHaveValue(pu.id);
  await expect(page.getByLabel("Delivery location")).toHaveValue(de.id);
  await expect(page.getByLabel("Contact name").nth(0)).toHaveValue("Src Pat");
  await expect(page.getByLabel("Contact phone").nth(0)).toHaveValue("416-555-0111");
  await expect(page.getByLabel("Contact name").nth(1)).toHaveValue("Src Dee");
  await expect(page.getByLabel("Contact phone").nth(1)).toHaveValue("416-555-0112");
  await expect(page.getByRole("radiogroup", { name: "Equipment size" }).getByRole("radio", { name: /36/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radiogroup", { name: "Equipment size" }).locator('[aria-checked="true"]')).toHaveCount(1);
  await expect(page.getByLabel(/Moffett/)).not.toBeChecked();
  await expect(page.getByLabel("Weight (lbs, optional)")).toHaveValue("12345");
  await expect(page.getByLabel("Pieces (optional)")).toHaveValue("7");
  await expect(page.getByLabel("PO number (optional)")).toHaveValue(po);
  await expect(page.getByLabel("Notes (optional)")).toHaveValue("Handle with care");
  await expect(page.getByRole("radiogroup", { name: "Pickup timing" }).getByRole("radio", { name: "Time window" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radiogroup", { name: "Delivery timing" }).getByRole("radio", { name: "Appointment" })).toHaveAttribute("aria-checked", "true");
  // ALL dates and times are empty.
  await expect(page.getByLabel("Pickup date")).toHaveValue("");
  await expect(page.getByLabel("Delivery date")).toHaveValue("");
  await expect(page.getByLabel("Window from (ET)")).toHaveValue("");
  await expect(page.getByLabel("Window to (ET)")).toHaveValue("");
  await expect(page.getByLabel("Appointment time (ET)")).toHaveValue("");
  await expect(page.getByLabel("How many trucks?")).toHaveValue("1");
  // Submitting as copied is refused: the dates are required.
  await page.getByRole("button", { name: "Request load" }).click();
  await expect(page.getByText("Pickup date is required.")).toBeVisible();
  await expect(page.getByText("Delivery date is required.")).toBeVisible();
  expect(await newLoadsFor(po, src.id)).toHaveLength(0);

  // Dismiss the notice, edit one contact, choose the dates, book.
  await page.getByRole("button", { name: "Dismiss notice" }).click();
  await expect(page.getByTestId("copied-notice")).toHaveCount(0);
  await page.getByLabel("Contact name").nth(0).fill("Edited Pat");
  await fillDates(page, { pickupWindow: true });
  await page.getByRole("button", { name: "Request load" }).click();
  await page.waitForURL(/\/loads\/[0-9a-f-]{36}$/);
  const made = await newLoadsFor(po, src.id);
  expect(made).toHaveLength(1);
  const n = made[0];
  const s = (await db().from("loads").select("*").eq("id", src.id).single()).data as Record<string, unknown>;
  for (const k of ["pickup_location_id", "delivery_location_id", "equipment_size", "moffett", "weight_lbs", "pieces", "po_number",
    "pickup_timing", "delivery_timing", "pickup_contact_phone", "delivery_contact_name", "delivery_contact_phone", "customer_id"]) {
    expect(n[k], `copied ${k}`).toEqual(s[k]);
  }
  expect(n.notes).toBe("Handle with care");
  expect(n.pickup_contact_name).toBe("Edited Pat");
  expect(n.status).toBe("requested");
  expect(n.pickup_date).toBe(isoDate(5));
  expect(n.delivery_date).toBe(isoDate(6));
  expect(String(n.pickup_time_start).slice(0, 5)).toBe("08:00");
  expect(String(n.pickup_time_end).slice(0, 5)).toBe("10:00");
  expect(String(n.delivery_time_start).slice(0, 5)).toBe("13:00");
  expect(n.delivery_time_end).toBeNull();
  await expect(page.locator("h1")).toHaveText(new RegExp(String(n.load_number)));
  // The source load is untouched.
  expect(s.status).toBe("delivered");
  expect(s.pickup_contact_name).toBe("Src Pat");
  await ctx.close();
});

test("a malformed, unknown, foreign, not delivered or cancelled from= opens an empty form and leaks nothing", async ({ browser }) => {
  const other = await db().from("customers").insert({ name: uniq("E2E-OTHER-CUST") }).select("id").single();
  expect(other.error).toBeNull();
  const foreignPo = uniq("RA-FOREIGN-PO");
  const foreignName = "Zed Foreigncontact";
  // Created by staff, not Maria: another spec copies "one of Maria's loads" and must never pick a row she cannot read.
  const staffId = (await db().from("profiles").select("id").eq("email", "admin@e2e.test").single()).data!.id as string;
  const foreign = await seed({
    po: foreignPo, customer: other.data!.id as string, createdBy: staffId, pContact: [foreignName, "905-555-0999"], dContact: [foreignName, "905-555-0998"],
  });
  const booked = await seed({ po: uniq("RA-FROM-BKD"), status: "booked" });
  const requested = await seed({ po: uniq("RA-FROM-REQ"), status: "requested" });
  const cancelled = await seed({ po: uniq("RA-FROM-CXL"), status: "cancelled" });
  const ok = await seed({ po: uniq("RA-FROM-OK") });
  const { ctx, page } = await as(browser, "maria");

  const bads: [string, string][] = [
    ["foreign customer's delivered load", `from=${foreign.id}`],
    ["own booked load", `from=${booked.id}`],
    ["own requested load", `from=${requested.id}`],
    ["own cancelled load", `from=${cancelled.id}`],
    ["well formed id that does not exist", "from=00000000-0000-4000-8000-000000000000"],
    ["not an id", "from=not-a-uuid"],
    ["sql shaped", `from=${encodeURIComponent("' or 1=1 --")}`],
    ["uppercase id", `from=${ok.id.toUpperCase()}`],
    ["two values", `from=${ok.id}&from=${ok.id}`],
    ["empty", "from="],
  ];
  for (const [label, qs] of bads) {
    await page.goto(`/book?${qs}`);
    await emptyForm(page);
    const html = await page.content();
    for (const secret of [foreignPo, foreignName, foreign.loadNumber, "905-555-0999"]) {
      expect(html.includes(secret), `${label}: page does not contain ${secret}`).toBe(false);
    }
  }
  // The control: the same shape with the customer's own delivered load does prefill.
  await page.goto(`/book?from=${ok.id}`);
  await expect(page.getByTestId("copied-notice")).toContainText(ok.loadNumber);
  await expect(page.getByLabel("Pickup location")).toHaveValue(pu.id);
  await ctx.close();
});

test("last contact hint: the most recent load at the location, Use last contact, Same as last time, default fallback", async ({ browser }) => {
  const hLoc = await makeLocation({ prefix: "E2E-RAH", contactName: "Hdef Name", contactPhone: "416-555-0500" });
  const hDel = await makeLocation({ prefix: "E2E-RAHD", contactName: "Hdel Name", contactPhone: "416-555-0600" });
  locations.push(hLoc.id, hDel.id);
  // Inserted newest (by created_at) FIRST, so the load numbers run opposite to created_at.
  const tNew = minAgo(3), tOld = minAgo(4);
  const newest = await seed({
    po: uniq("RA-HINT-NEW"), pickup: hLoc.id, delivery: hDel.id, createdAt: tNew,
    pContact: ["New Contact", "416-555-0701"], dContact: ["New Receiver", "416-555-0801"],
  });
  const oldest = await seed({
    po: uniq("RA-HINT-OLD"), pickup: hLoc.id, delivery: hDel.id, createdAt: tOld,
    pContact: ["Old Contact", "416-555-0702"], dContact: ["Old Receiver", "416-555-0802"],
  });
  expect(Number(oldest.loadNumber.replace(/\D/g, ""))).toBeGreaterThan(Number(newest.loadNumber.replace(/\D/g, "")));
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/book");
  await expect(page.locator("h1")).toHaveText(/Book a load/);
  const pHint = page.getByTestId("pickup-last-contact");
  const dHint = page.getByTestId("delivery-last-contact");
  await expect(pHint).toHaveAttribute("aria-live", "polite");
  await expect(pHint).toHaveText("");
  await expect(page.getByTestId("pickup-use-last")).toHaveCount(0);

  // Location with history: the default contact fills the fields (existing behaviour), the hint shows the latest load.
  await page.getByLabel("Pickup location").selectOption({ label: hLoc.label });
  await expect(page.getByLabel("Contact name").nth(0)).toHaveValue("Hdef Name");
  await expect(pHint).toHaveText(`Last contact at ${hLoc.name}: New Contact, 416-555-0701 (${newest.loadNumber}, ${etDate(tNew)})`);
  await expect(pHint).not.toContainText("Old Contact");
  const use = page.getByTestId("pickup-use-last");
  await expect(use).toHaveText("Use last contact");
  await expect(use).toBeVisible();
  await expectTall(page, page.getByTestId("pickup-use-last"), "Use last contact");
  await use.click();
  await expect(page.getByLabel("Contact name").nth(0)).toHaveValue("New Contact");
  await expect(page.getByLabel("Contact phone").nth(0)).toHaveValue("416-555-0701");
  await expect(pHint).toHaveText(`Same as last time (${newest.loadNumber}, ${etDate(tNew)})`);
  await expect(page.getByTestId("pickup-use-last")).toHaveCount(0);
  // Typing something else brings the button back; typing the same again hides it.
  await page.getByLabel("Contact name").nth(0).fill("Someone Else");
  await expect(page.getByTestId("pickup-use-last")).toBeVisible();
  await page.getByLabel("Contact name").nth(0).fill("New Contact");
  await expect(pHint).toContainText("Same as last time");

  // A location with no earlier load: the default contact message.
  await page.getByLabel("Pickup location").selectOption({ label: bare.label });
  await expect(pHint).toHaveText("No earlier load here. Using the saved default contact.");
  await expect(page.getByLabel("Contact name").nth(0)).toHaveValue(BARE_DEFAULT[0]);
  await expect(page.getByLabel("Contact phone").nth(0)).toHaveValue(BARE_DEFAULT[1]);
  await expect(page.getByTestId("pickup-use-last")).toHaveCount(0);
  // Back to the first one: the line returns.
  await page.getByLabel("Pickup location").selectOption({ label: hLoc.label });
  await expect(pHint).toContainText("Last contact at");

  // The delivery side has its own history (the delivery contact of the same loads).
  await page.getByLabel("Delivery location").selectOption({ label: hDel.label });
  await expect(dHint).toHaveText(`Last contact at ${hDel.name}: New Receiver, 416-555-0801 (${newest.loadNumber}, ${etDate(tNew)})`);
  await page.getByTestId("delivery-use-last").click();
  await expect(page.getByLabel("Contact name").nth(1)).toHaveValue("New Receiver");
  await expect(page.getByLabel("Contact phone").nth(1)).toHaveValue("416-555-0801");
  await expect(dHint).toContainText("Same as last time");
  // A place used only as a pickup has no delivery history: the default contact message, never a Last contact line.
  await page.getByLabel("Delivery location").selectOption({ label: pu.label });
  await expect(dHint).toHaveText("No earlier load here. Using the saved default contact.");
  await ctx.close();
});

test("Request again shows the most recent contact at the location, which may be newer than the source load", async ({ browser }) => {
  const rLoc = await makeLocation({ prefix: "E2E-RAN" });
  const rDel = await makeLocation({ prefix: "E2E-RAND" });
  locations.push(rLoc.id, rDel.id);
  const po = uniq("RA-NEWER");
  const tSrc = minAgo(6), tLater = minAgo(5);
  const src = await seed({ po, pickup: rLoc.id, delivery: rDel.id, createdAt: tSrc, pContact: ["Src Contact", "416-555-0901"], dContact: ["Src Recv", "416-555-0902"] });
  const later = await seed({ po: uniq("RA-NEWER2"), pickup: rLoc.id, delivery: rDel.id, createdAt: tLater, pContact: ["Later Contact", "416-555-0903"], dContact: ["Src Recv", "416-555-0902"] });
  const { ctx, page } = await as(browser, "maria");
  await page.goto(`/book?from=${src.id}`);
  await expect(page.getByTestId("copied-notice")).toContainText(src.loadNumber);
  await expect(page.getByLabel("Contact name").nth(0)).toHaveValue("Src Contact");
  await expect(page.getByTestId("pickup-last-contact")).toHaveText(`Last contact at ${rLoc.name}: Later Contact, 416-555-0903 (${later.loadNumber}, ${etDate(tLater)})`);
  await page.getByTestId("pickup-use-last").click();
  await expect(page.getByLabel("Contact name").nth(0)).toHaveValue("Later Contact");
  // The delivery contact equals the latest one there.
  await expect(page.getByTestId("delivery-last-contact")).toHaveText(`Same as last time (${later.loadNumber}, ${etDate(tLater)})`);
  await ctx.close();
});

test("multi-truck quantity works from a Request again form and the copied Truck i of N line is not doubled", async ({ browser }) => {
  const po = uniq("RA-MULTI");
  const src = await seed({ po, notes: "Truck 1 of 2\nKeep dry" });
  const { ctx, page } = await as(browser, "maria");
  await page.goto(`/book?from=${src.id}`);
  await expect(page.getByLabel("Notes (optional)")).toHaveValue("Keep dry");
  await expect(page.getByLabel("How many trucks?")).toHaveValue("1");
  await page.getByRole("button", { name: "More trucks" }).click();
  await page.getByRole("button", { name: "More trucks" }).click();
  await expect(page.getByText("This creates 3 separate loads, one per truck. Each gets its own load number and status.")).toBeVisible();
  await fillDates(page);
  await page.getByRole("button", { name: "Request 3 loads" }).click();
  await page.waitForURL(/\/loads\?booked=/);
  const made = await newLoadsFor(po, src.id);
  expect(made).toHaveLength(3);
  expect(made.map((r) => r.notes)).toEqual(["Truck 1 of 3\nKeep dry", "Truck 2 of 3\nKeep dry", "Truck 3 of 3\nKeep dry"]);
  for (const r of made) {
    expect(r.status).toBe("requested");
    expect(r.pickup_location_id).toBe(pu.id);
    expect(r.pickup_date).toBe(isoDate(5));
  }
  await ctx.close();
});

test("Moffett is copied: a copied Moffett stays on and editable, a location that requires it stays locked on", async ({ browser }) => {
  const mLoc = await makeLocation({ prefix: "E2E-RAM", moffett: true });
  locations.push(mLoc.id);
  const free = await seed({ po: uniq("RA-MOF-FREE"), moffett: true });
  const locked = await seed({ po: uniq("RA-MOF-LOCK"), pickup: mLoc.id, moffett: true });
  const { ctx, page } = await as(browser, "maria");
  await page.goto(`/book?from=${free.id}`);
  await expect(page.getByTestId("copied-notice")).toContainText(free.loadNumber);
  await expect(page.getByLabel(/Moffett/)).toBeChecked();
  await expect(page.getByLabel(/Moffett/)).toBeEnabled();
  await page.goto(`/book?from=${locked.id}`);
  await expect(page.getByTestId("copied-notice")).toContainText(locked.loadNumber);
  await expect(page.getByLabel(/Moffett/)).toBeChecked();
  await expect(page.getByLabel(/Moffett/)).toBeDisabled();
  await ctx.close();
});

test("mobile 375x812: no horizontal overflow and 44px buttons on Completed, Request again and the hints", async ({ browser }) => {
  const po = uniq("RA-MOB");
  const src = await seed({ po, pContact: ["Mob Pat", "416-555-0121"], dContact: ["Mob Dee", "416-555-0122"] });
  const { ctx, page } = await as(browser, "maria", VIEWPORT);
  await page.goto("/loads?view=completed");
  await expect(page.locator("h1")).toHaveText(/My loads/);
  const row = page.getByRole("listitem").filter({ hasText: src.loadNumber });
  await expect(row).toHaveCount(1);
  await expectTall(page, row.getByRole("link", { name: "Request again" }), "Request again (list)");
  await expectNoOverflow(page, "/loads?view=completed");
  await page.goto(`/loads/${src.id}`);
  await expect(page.locator("h1")).toHaveText(new RegExp(src.loadNumber));
  await expectTall(page, page.getByRole("link", { name: "Request again" }), "Request again (detail)");
  await expectNoOverflow(page, "/loads/[id]");
  await page.goto(`/book?from=${src.id}`);
  await expect(page.getByTestId("copied-notice")).toBeVisible();
  await expectTall(page, page.getByRole("button", { name: "Dismiss notice" }), "Dismiss notice");
  await page.getByLabel("Contact name").nth(0).fill("Changed");
  await expect(page.getByTestId("pickup-use-last")).toBeVisible();
  await expectTall(page, page.getByTestId("pickup-use-last"), "Use last contact");
  await expect(page.getByTestId("pickup-last-contact")).toContainText("Last contact at");
  await expectNoOverflow(page, "/book?from=");
  await ctx.close();
});
