import { expect, test, type Page } from "@playwright/test";
import { adminClient, as, gotoSteady, insertLoad, isoDate, staffBook, uniq, uniqIts } from "./support/helpers";
import { fillBooking, makeLocation, retireLocations, type TestLocation } from "./support/book";
import { BASE_URL } from "./support/env";
import { sentEmails, MAIL_MOCK_URL, type SentEmail } from "./support/mail-mock";
import { assertLocalUrl } from "./support/guard";
import { CARRIER_A, CARRIER_B } from "./support/users";
import {
  buildTruckRows, exceedsRecentCap, insertTruckLoads, loadNumberSummary, MAX_TRUCKS, parseQuantityText, validateQuantity,
} from "../src/lib/customer/bulk";
import { EMPTY_LOAD_FORM } from "../src/lib/customer/validate";

// Multi-truck booking (R20, R21): "How many trucks?" at the end of /book creates N identical loads from one
// submission, one staff email, one banner on /loads. Everything is asserted against the database (service role).

test.describe.configure({ mode: "serial", timeout: 180_000 });
assertLocalUrl(MAIL_MOCK_URL, "mail mock url");

const db = () => adminClient();
const VIEWPORT = { width: 375, height: 812 };
const locations: string[] = [];
const parked: string[] = [];
const createdUsers: string[] = [];
let route: { pickup: TestLocation; delivery: TestLocation };

type LoadRow = Record<string, unknown> & { id: string; load_number: string; notes: string | null; created_by: string };

test.beforeAll(async () => {
  route = { pickup: await makeLocation({ prefix: "E2E-MTP", contactName: "Pat Pickup", contactPhone: "416-555-0101" }),
    delivery: await makeLocation({ prefix: "E2E-MTD", contactName: "Dee Delivery", contactPhone: "416-555-0102" }) };
  locations.push(route.pickup.id, route.delivery.id);
});

test.afterAll(async () => {
  const d = db();
  if (parked.length) await d.from("loads").update({ status: "cancelled" }).in("id", parked).in("status", ["booked"]);
  for (const id of createdUsers) await d.auth.admin.deleteUser(id).catch(() => {});
  await retireLocations(locations);
});

async function loadsByPo(po: string): Promise<LoadRow[]> {
  const { data, error } = await db().from("loads").select("*").eq("po_number", po).order("load_number");
  if (error) throw error;
  return (data ?? []) as LoadRow[];
}
const mariaId = async () => (await db().from("profiles").select("id").eq("email", "maria@e2e.test").single()).data!.id as string;

async function openBook(page: Page, po: string, notes?: string) {
  await page.goto("/book");
  await fillBooking(page, {
    pickup: route.pickup.label, delivery: route.delivery.label,
    pickupContact: ["Pat Pickup", "416-555-0101"], deliveryContact: ["Dee Delivery", "416-555-0102"],
    pickupDate: isoDate(5), deliveryDate: isoDate(6), equipment: 53, po,
  });
  if (notes) await page.getByLabel("Notes (optional)").fill(notes);
}

async function setQty(page: Page, value: string) {
  await page.getByLabel("How many trucks?").fill(value);
}

async function bookMany(page: Page, po: string, n: number): Promise<LoadRow[]> {
  await openBook(page, po);
  await setQty(page, String(n));
  await page.getByRole("button", { name: `Request ${n} loads` }).click();
  await page.waitForURL(/\/loads\?booked=/);
  const rows = await loadsByPo(po);
  expect(rows).toHaveLength(n);
  return rows;
}

test("Maria books quantity 4: four identical requested loads, Truck i of 4 notes, banner on /loads", async ({ browser }) => {
  const po = uniq("MT4");
  const { ctx, page } = await as(browser, "maria");
  await openBook(page, po, "Call before arrival");
  // The stepper and the field agree, the summary and the button follow the quantity.
  await expect(page.getByLabel("How many trucks?")).toHaveValue("1");
  await expect(page.getByText("Details above apply to every truck.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Request load", exact: true })).toBeVisible();
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "More trucks" }).click();
  await expect(page.getByLabel("How many trucks?")).toHaveValue("4");
  await expect(page.getByText("This creates 4 separate loads, one per truck. Each gets its own load number and status.")).toBeVisible();
  await page.getByRole("button", { name: "Request 4 loads" }).click();
  await page.waitForURL(/\/loads\?booked=/);

  const rows = await loadsByPo(po);
  expect(rows).toHaveLength(4);
  const nums = rows.map((r) => r.load_number);
  expect(new Set(nums).size).toBe(4);
  const maria = await mariaId();
  const first = rows[0];
  rows.forEach((r, i) => {
    expect(r.status).toBe("requested");
    expect(r.created_by).toBe(maria);
    expect(r.customer_id).toBe(first.customer_id);
    for (const k of ["pickup_location_id", "delivery_location_id", "equipment_size", "moffett", "pickup_timing", "pickup_date",
      "pickup_time_start", "delivery_timing", "delivery_date", "delivery_time_start", "pickup_contact_name", "pickup_contact_phone",
      "delivery_contact_name", "delivery_contact_phone", "po_number"]) {
      expect(r[k], `${k} of load ${i + 1}`).toEqual(first[k]);
    }
    expect(r.equipment_size).toBe(53);
    expect(r.notes).toBe(`Truck ${i + 1} of 4\nCall before arrival`);
    expect(r.carrier_id).toBeNull();
  });
  // Truck numbers follow the load numbers.
  const order = [...rows].sort((a, b) => a.load_number.localeCompare(b.load_number));
  order.forEach((r, i) => expect(r.notes).toMatch(new RegExp(`^Truck ${i + 1} of 4`)));

  // Banner lists the 4 numbers in order, and every load is in the list.
  const banner = page.getByTestId("booked-banner");
  await expect(banner).toContainText(`4 loads requested: ${order.map((r) => `Request ${r.load_number}`).join(", ")}`);
  for (const n of nums) await expect(page.locator("ul").getByText(n, { exact: true })).toBeVisible();

  // The parameter is not trusted: malformed values and other people's ids show nothing.
  for (const bad of ["abc", "not-a-uuid,also-bad", rows[0].id, `${order[0].id},${order[1].id},zzz`, `${order[0].id},${order[0].id}`]) {
    await gotoSteady(page, `/loads?booked=${encodeURIComponent(bad)}`);
    await expect(page.locator("h1")).toHaveText(/My loads/);
    await expect(page.getByTestId("booked-banner"), `ignored: ${bad}`).toHaveCount(0);
  }
  // Valid shape but unknown ids: only loads the customer can read are listed.
  await gotoSteady(page, `/loads?booked=${encodeURIComponent(`${order[0].id},00000000-0000-4000-8000-000000000000`)}`);
  await expect(page.getByTestId("booked-banner")).toContainText(`1 load requested: Request ${order[0].load_number}.`);
  await ctx.close();
});

test("quantity 1 behaves exactly as before: one load, its own page, no Truck note", async ({ browser }) => {
  const po = uniq("MT1");
  const { ctx, page } = await as(browser, "maria");
  await openBook(page, po, "Plain note");
  await page.getByRole("button", { name: "Request load", exact: true }).click();
  await page.waitForURL(/\/loads\/[0-9a-f-]{36}$/);
  const rows = await loadsByPo(po);
  expect(rows).toHaveLength(1);
  expect(page.url().endsWith(`/loads/${rows[0].id}`)).toBe(true);
  expect(rows[0].notes).toBe("Plain note");
  expect(rows[0].status).toBe("requested");
  expect(page.url()).not.toContain("booked=");
  await ctx.close();
});

test("quantity validation refuses 0, 11, negative, decimal and empty, refuses forged server calls, and the edit form has no quantity", async ({ browser }) => {
  const po = uniq("MTV");
  // Service workers blocked: webkit would otherwise serve the fetch from the worker and page.route never sees it.
  const { ctx, page } = await as(browser, "maria", undefined, { serviceWorkers: "block" });
  await openBook(page, po);
  for (const bad of ["0", "11", "-2", "1.5", "", "abc"]) {
    await setQty(page, bad);
    await page.getByRole("button", { name: /^Request (load|\d+ loads)$/ }).click();
    await expect(page.getByRole("alert").filter({ hasText: /trucks|Trucks/ })).toBeVisible();
    await expect(page.getByLabel("How many trucks?")).toHaveAttribute("aria-invalid", "true");
    expect(page.url()).toMatch(/\/book$/);
    expect(await loadsByPo(po), `nothing inserted for "${bad}"`).toHaveLength(0);
  }
  // The pure rules agree.
  expect(["0", "11", "-2", "1.5", "", " "].map((t) => "error" in parseQuantityText(t))).toEqual([true, true, true, true, true, true]);
  expect(parseQuantityText(" 10 ")).toEqual({ value: 10 });
  expect(MAX_TRUCKS).toBe(10);

  // Forged server calls: the browser sends a valid form, the request body is rewritten to carry a bad quantity.
  for (const forged of ["11", '"abc"', "0", "-1", "2.5", "null"]) {
    let rewritten = false;
    await page.route("**/book", async (r) => {
      const req = r.request();
      const body = req.postData() ?? req.postDataBuffer()?.toString("utf8") ?? null;      if (req.method() === "POST" && req.headers()["next-action"] && body && /,1\]$/.test(body)) {
        rewritten = true;
        await r.continue({ postData: body.replace(/,1\]$/, `,${forged}]`) });
      } else await r.continue();
    });
    await setQty(page, "1");
    await page.getByRole("button", { name: "Request load", exact: true }).click();
    await expect.poll(() => rewritten, { message: `request rewritten for ${forged}` }).toBe(true);
    await expect(page.getByRole("alert").filter({ hasText: /trucks|Trucks/ })).toBeVisible();
    expect(page.url()).toMatch(/\/book$/);
    expect(await loadsByPo(po), `server refused ${forged}`).toHaveLength(0);
    await page.unroute("**/book");
  }
  // Server rule, directly.
  expect([11, "abc", 0, -1, 2.5, null, undefined, "4"].map((q) => "error" in validateQuantity(q))).toEqual(Array(8).fill(true));
  expect(validateQuantity(10)).toEqual({ value: 10 });

  // The edit form never offers quantity.
  const l = await insertLoad({ po: uniq("MTE"), status: "requested" });
  await page.goto(`/loads/${l.id}/edit`);
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
  await expect(page.getByLabel("How many trucks?")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "More trucks" })).toHaveCount(0);
  await expect(page.getByText("Details above apply to every truck.")).toHaveCount(0);
  await ctx.close();
});

test("the 30 loads per 10 minutes cap and the load number summary", async () => {
  expect(exceedsRecentCap(26, 4)).toBe(false);
  expect(exceedsRecentCap(27, 4)).toBe(true);
  expect(exceedsRecentCap(0, 10)).toBe(false);
  expect(exceedsRecentCap(21, 10)).toBe(true);
  expect(exceedsRecentCap(5, 10, 14)).toBe(true);
  expect(loadNumberSummary(["MTX-0005", "MTX-0006", "MTX-0007", "MTX-0008"])).toBe("MTX-0005 to MTX-0008");
  expect(loadNumberSummary(["MTX-0005", "MTX-0007"])).toBe("MTX-0005, MTX-0007");
  expect(loadNumberSummary(["MTX-0009"])).toBe("MTX-0009");
});

test("staff get exactly ONE email for a 4 truck booking: range subject, 4 numbers, 4 links, inactive staff excluded", async ({ browser }) => {
  // One inactive staff user, to prove it is not a recipient.
  const email = `mt-csr-off-${Date.now().toString(36)}-${process.pid}@e2e.test`;
  const made = await db().auth.admin.createUser({ email, email_confirm: true });
  if (made.error || !made.data.user) throw made.error ?? new Error("createUser failed");
  createdUsers.push(made.data.user.id);
  const ins = await db().from("profiles").insert({ id: made.data.user.id, email, full_name: "mt-off", role: "staff_csr", is_active: false });
  if (ins.error) throw ins.error;

  const po = uniq("MTM");
  const { ctx, page } = await as(browser, "maria");
  const rows = await bookMany(page, po, 4);
  const nums = rows.map((r) => r.load_number);
  const hits = async (): Promise<SentEmail[]> => (await sentEmails()).filter((m) => nums.some((n) => m.subject.includes(n) || (m.text ?? "").includes(n)));
  await expect.poll(async () => (await hits()).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await new Promise((r) => setTimeout(r, 1500)); // a stray second message would have arrived by now
  const mails = await hits();
  expect(mails).toHaveLength(1);
  const m = mails[0];
  const staff = ((await db().from("profiles").select("email").eq("is_active", true).in("role", ["staff_admin", "staff_csr"])).data ?? []).map((r) => r.email as string).sort();
  expect([...m.to].sort()).toEqual(staff);
  expect(m.to).not.toContain(email);
  expect(m.to).not.toContain("maria@e2e.test");
  expect(m.subject).toBe(`New loads requested (Request ${loadNumberSummary(nums)}, 4 trucks)`);
  expect(m.subject).toContain(" to ");
  const body = m.text ?? "";
  for (const r of rows) {
    expect(body).toContain(r.load_number);
    expect(body).toContain(`${BASE_URL}/admin/loads/${r.id}`);
  }
  expect(body.match(/\/admin\/loads\/[0-9a-f-]{36}/g)).toHaveLength(4);
  expect(body).toContain(`${route.pickup.name} to ${route.delivery.name}`);
  expect(body).toContain("Equipment: 53 ft");
  expect(body).toContain("ET");
  expect(body).toContain("Pickup contact: Pat Pickup, 416-555-0101");
  expect(body).toContain("Delivery contact: Dee Delivery, 416-555-0102");
  await ctx.close();
});

test("all or nothing: a failing 3rd row leaves zero loads (the one insert statement)", async () => {
  // A failure cannot be injected through the UI, so the insert helper the action uses is run directly with the
  // service role: row 3 carries equipment_size 99, which violates the loads check constraint.
  const po = uniq("MTA");
  const cust = (await db().from("customers").select("id").eq("name", "Mitrex").single()).data!.id as string;
  const values = {
    ...EMPTY_LOAD_FORM, pickup_location_id: route.pickup.id, delivery_location_id: route.delivery.id,
    pickup_contact_name: "Pat", pickup_contact_phone: "416-555-0101", delivery_contact_name: "Dee", delivery_contact_phone: "416-555-0102",
    equipment_size: "53", pickup_date: isoDate(5), pickup_time_start: "08:00", delivery_date: isoDate(5), delivery_time_start: "14:00", po_number: po,
  };
  const rows = buildTruckRows(values, false, 4, cust, await mariaId());
  expect(rows.map((r) => r.notes)).toEqual(["Truck 1 of 4", "Truck 2 of 4", "Truck 3 of 4", "Truck 4 of 4"]);
  const bad = rows.map((r, i) => (i === 2 ? { ...r, equipment_size: 99 } : r));
  const failed = await insertTruckLoads(db() as never, bad);
  expect("error" in failed).toBe(true);
  expect(await loadsByPo(po)).toHaveLength(0);
  // The same rows without the fault insert all four at once.
  const ok = await insertTruckLoads(db() as never, rows);
  expect("loads" in ok && ok.loads.length).toBe(4);
  expect(await loadsByPo(po)).toHaveLength(4);
});

test("staff assign a different carrier to each of the 4 loads and each keeps its own status", async ({ browser }) => {
  const po = uniq("MTS");
  const maria = await as(browser, "maria");
  const rows = await bookMany(maria.page, po, 4);
  await maria.ctx.close();
  parked.push(...rows.map((r) => r.id));
  const carriers = (await db().from("carriers").select("id,name").in("name", [CARRIER_A, CARRIER_B])).data ?? [];
  const idOf = (n: string) => carriers.find((c) => c.name === n)!.id as string;

  const { ctx, page } = await as(browser, "admin");
  for (const [row, carrier] of [[rows[0], CARRIER_A], [rows[1], CARRIER_B]] as const) {
    await gotoSteady(page, `/admin/loads/${row.id}`);
    await page.getByLabel("Carrier").first().selectOption({ label: carrier });
    await page.getByRole("button", { name: "Save carrier" }).click();
    await expect(page.getByText("Carrier assigned.", { exact: true })).toBeVisible();
  }
  // Only the first load is booked.
  await gotoSteady(page, `/admin/loads/${rows[0].id}`);
  await staffBook(page, uniqIts());
  await expect.poll(async () => (await loadsByPo(po)).find((r) => r.id === rows[0].id)?.status).toBe("booked");

  const now = await loadsByPo(po);
  const by = (id: string) => now.find((r) => r.id === id)!;
  expect(by(rows[0].id).carrier_id).toBe(idOf(CARRIER_A));
  expect(by(rows[1].id).carrier_id).toBe(idOf(CARRIER_B));
  expect(by(rows[2].id).carrier_id).toBeNull();
  expect(by(rows[3].id).carrier_id).toBeNull();
  expect([by(rows[0].id).status, by(rows[1].id).status, by(rows[2].id).status, by(rows[3].id).status]).toEqual(["booked", "requested", "requested", "requested"]);
  await ctx.close();
});

test("mobile 375x812: the 4 truck flow has no horizontal overflow and the quantity buttons are 44px or more", async ({ browser }) => {
  const po = uniq("MTB");
  const { ctx, page } = await as(browser, "maria", VIEWPORT);
  await openBook(page, po);
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "More trucks" }).click();
  await expect(page.getByRole("button", { name: "Request 4 loads" })).toBeVisible();
  await page.getByRole("button", { name: "Request 4 loads" }).scrollIntoViewIfNeeded();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow(), "overflow on /book with 4 trucks").toBeLessThanOrEqual(0);
  for (const name of ["Fewer trucks", "More trucks"]) {
    const box = (await page.getByRole("button", { name }).boundingBox())!;
    expect(box.width, `${name} width`).toBeGreaterThanOrEqual(44);
    expect(box.height, `${name} height`).toBeGreaterThanOrEqual(44);
  }
  const field = (await page.getByLabel("How many trucks?").boundingBox())!;
  expect(field.height).toBeGreaterThanOrEqual(44);
  await page.getByRole("button", { name: "Request 4 loads" }).click();
  await page.waitForURL(/\/loads\?booked=/);
  await expect(page.getByTestId("booked-banner")).toBeVisible();
  expect(await overflow(), "overflow on /loads with the banner").toBeLessThanOrEqual(0);
  expect(await loadsByPo(po)).toHaveLength(4);
  await ctx.close();
});

test("double submit with 4 trucks creates exactly 4 loads, not 8", async ({ browser }) => {
  const po = uniq("MTD");
  const { ctx, page } = await as(browser, "maria");
  await openBook(page, po);
  await setQty(page, "4");
  // Two clicks in the same tick (no render between them): only the synchronous lock can stop the second.
  await page.getByRole("button", { name: "Request 4 loads" }).evaluate((b) => { (b as HTMLButtonElement).click(); (b as HTMLButtonElement).click(); });
  await page.waitForURL(/\/loads\?booked=/);
  await new Promise((r) => setTimeout(r, 1500));
  expect(await loadsByPo(po)).toHaveLength(4);
  await ctx.close();
});

test("server cap: loads past the recent window cap are refused with a clear message and nothing is inserted", async ({ browser }) => {
  // The e2e server runs with LOAD_RATE_CAP=1000. Seed Maria up to 2 below it in a few statements, then try 3, then 2.
  const d = db();
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const maria = await mariaId();
  const { count } = await d.from("loads").select("id", { count: "exact", head: true }).eq("created_by", maria).gte("created_at", since);
  const seedN = 998 - (count ?? 0);
  expect(seedN).toBeGreaterThan(0);
  // Template: one of Maria's loads whose locations can still ship and receive (other specs retire their own test
  // locations, and a load pointing at a retired one is refused by the guard trigger).
  const custId = (await d.from("customers").select("id").eq("name", "Mitrex").single()).data!.id as string;
  const live = await d.from("locations").select("id,can_ship,can_receive").eq("is_active", true);
  const ship = (live.data ?? []).filter((l) => l.can_ship).map((l) => l.id as string);
  const recv = (live.data ?? []).filter((l) => l.can_receive).map((l) => l.id as string);
  const base = (await d.from("loads").select("*").eq("created_by", maria).eq("customer_id", custId).in("pickup_location_id", ship).in("delivery_location_id", recv).limit(1).single()).data as Record<string, unknown>;
  // its_load_number is unique where set: a template that is a booked load would make every seeded copy collide
  const { id: _i, load_number: _n, created_at: _c, updated_at: _u, its_load_number: _its, ...tpl } = base;
  void _i; void _n; void _c; void _u; void _its;
  const seeded: string[] = [];
  const po = uniq("MTC");
  try {
    for (let off = 0; off < seedN; off += 200) {
      const rows = Array.from({ length: Math.min(200, seedN - off) }, () => ({ ...tpl, po_number: uniq("MTCAPSEED") }));
      const ins = await d.from("loads").insert(rows).select("id");
      if (ins.error) throw ins.error;
      seeded.push(...(ins.data ?? []).map((r) => r.id as string));
    }
    // Loads created 9 to 10 minutes ago (earlier specs) leave the 10 minute window while this test runs, so top up to
    // exactly 998 inside the window right before each submit.
    const topUp = async () => {
      const w = new Date(Date.now() - 10 * 60_000).toISOString();
      const { count: now } = await d.from("loads").select("id", { count: "exact", head: true }).eq("created_by", maria).gte("created_at", w);
      const missing = 998 - (now ?? 0);
      if (missing > 0) {
        const ins = await d.from("loads").insert(Array.from({ length: missing }, () => ({ ...tpl, po_number: uniq("MTCAPSEED") }))).select("id");
        if (ins.error) throw ins.error;
        seeded.push(...(ins.data ?? []).map((r) => r.id as string));
      }
    };
    const { ctx, page } = await as(browser, "maria");
    await openBook(page, po);
    await setQty(page, "3");
    await topUp();
    await page.getByRole("button", { name: "Request 3 loads" }).click();
    await expect(page.getByText(/That is a lot of loads in a short time/)).toBeVisible();
    expect(page.url()).toMatch(/\/book$/);
    expect(await loadsByPo(po), "no partial insert").toHaveLength(0);
    // Exactly at the cap is allowed.
    await setQty(page, "2");
    await topUp();
    await page.getByRole("button", { name: "Request 2 loads" }).click();
    await page.waitForURL(/\/loads\?booked=/);
    expect(await loadsByPo(po)).toHaveLength(2);
    await ctx.close();
  } finally {
    const mine = (await loadsByPo(po)).map((r) => r.id);
    const all = [...seeded, ...mine];
    for (let i = 0; i < all.length; i += 100) await d.from("loads").delete().in("id", all.slice(i, i + 100));
  }
});
