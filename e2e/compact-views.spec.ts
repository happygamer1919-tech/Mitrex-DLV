import { expect, test, type Locator, type Page } from "@playwright/test";
import { addLoadPhoto, adminClient, anon, as, insertLoad, uniq, uniqIts } from "./support/helpers";
import { makeLocation, retireLocations, type TestLocation } from "./support/book";
import { makeUser } from "./support/rates";
import { CARRIER_A, CARRIER_B } from "./support/users";
import { addDays } from "../src/lib/admin/cal";
import { easternToday, parsePages, withParams } from "../src/lib/load-filters";

// R46 compact views (DLV-040): collapsed sections with a one line preview, Show all, Show older and Show more, the URL
// counters and their strict validation, the board filters reaching every finished load, Maria's search, filters, sort,
// chips and CSV export (only her loads, never a lane reference), the carrier list, the folds on the load pages, 375px
// without sideways scrolling and 44px targets. Both engines. Authoritative data is read through the service role.

test.describe.configure({ mode: "serial", timeout: 180_000 });

const PHONE = { width: 375, height: 812 };
const today = easternToday();
const day = (n: number) => addDays(today, n);
const DAY_MS = 86_400_000;

type Seeded = { id: string; po: string; number: string };
const S: {
  ship: TestLocation; recv: TestLocation; booked: Seeded[]; requested: Seeded[]; recentDelivered: Seeded[]; oldDelivered: Seeded[];
  other: Seeded | null; otherCustomer: string; laneNumber: string; laneId: string; many: Seeded | null;
} = {
  ship: null as unknown as TestLocation, recv: null as unknown as TestLocation, booked: [], requested: [], recentDelivered: [],
  oldDelivered: [], other: null, otherCustomer: "", laneNumber: "", laneId: "", many: null,
};

async function ids() {
  const db = adminClient();
  const [{ data: cust }, { data: car }, { data: carB }, { data: maria }] = await Promise.all([
    db.from("customers").select("id").eq("name", "Mitrex").single(),
    db.from("carriers").select("id").eq("name", CARRIER_A).single(),
    db.from("carriers").select("id").eq("name", CARRIER_B).single(),
    db.from("profiles").select("id").eq("email", "maria@e2e.test").single(),
  ]);
  return { customer: cust!.id as string, carrier: car!.id as string, carrierB: carB!.id as string, maria: maria!.id as string };
}

// Bulk insert as the service role (setup only). Each row gets a unique PO; past requested gets an ITS number.
async function seedMany(n: number, o: {
  status: "requested" | "booked" | "delivered"; pickupDate: string; deliveredAt?: string; prefix: string; customer?: string; carrierB?: boolean;
}): Promise<Seeded[]> {
  const k = await ids();
  const rows = Array.from({ length: n }, (_, i) => ({
    customer_id: o.customer ?? k.customer, created_by: k.maria, pickup_location_id: S.ship.id, delivery_location_id: S.recv.id,
    equipment_size: 53, pickup_timing: "appointment", pickup_date: o.pickupDate, pickup_time_start: `${String(6 + (i % 10)).padStart(2, "0")}:00`,
    delivery_timing: "appointment", delivery_date: o.pickupDate, delivery_time_start: "18:00",
    pickup_contact_name: "Pat", pickup_contact_phone: "416-555-0101", delivery_contact_name: "Dee", delivery_contact_phone: "416-555-0102",
    po_number: uniq(o.prefix), notes: `Compact note ${i}`, status: o.status,
    its_load_number: o.status === "requested" ? null : uniqIts(),
    carrier_id: o.status === "requested" ? null : o.carrierB ? k.carrierB : k.carrier,
    ...(o.status === "delivered" ? { delivered_at: o.deliveredAt } : {}),
  }));
  const { data, error } = await adminClient().from("loads").insert(rows).select("id,po_number,load_number,its_load_number");
  if (error) throw error;
  return (data ?? []).map((r) => ({ id: r.id as string, po: r.po_number as string, number: (r.its_load_number as string | null) ?? (r.load_number as string) }));
}

test.beforeAll(async () => {
  S.ship = await makeLocation({ prefix: "CV-SHIP" });
  S.recv = await makeLocation({ prefix: "CV-RECV" });
  // 15 booked (a band with more than 12), 40 requested (more than 50 rows with the rest), delivered inside and outside
  // the 30 day windows (pickup date for staff and carriers, delivery date for Maria). The delivered ones carry carrier B,
  // whose finished list other specs do not fill (carrier A's holds every load the specs park).
  S.booked = await seedMany(15, { status: "booked", pickupDate: day(3), prefix: "CV-BKD" });
  S.requested = await seedMany(40, { status: "requested", pickupDate: day(4), prefix: "CV-REQ" });
  S.recentDelivered = await seedMany(3, { status: "delivered", pickupDate: day(-5), deliveredAt: new Date(Date.now() - 5 * DAY_MS).toISOString(), prefix: "CV-DNEW", carrierB: true });
  S.oldDelivered = await seedMany(2, { status: "delivered", pickupDate: day(-31), deliveredAt: new Date(Date.now() - 31 * DAY_MS - 3_600_000).toISOString(), prefix: "CV-DOLD", carrierB: true });
  // One active load of carrier B (Mitrex to Howden, outside the seeded shipper), for the carrier list.
  const bActive = await insertLoad({ po: uniq("CV-B-ACTIVE"), status: "booked" });
  await adminClient().from("loads").update({ carrier_id: (await ids()).carrierB }).eq("id", bActive.id);
  S.many = { id: bActive.id, po: "", number: bActive.loadNumber };
  // A load of ANOTHER customer in the same dates: it must never reach Maria's CSV.
  const db = adminClient();
  const other = await db.from("customers").insert({ name: uniq("CV-OTHER-CUSTOMER") }).select("id").single();
  if (other.error) throw other.error;
  S.otherCustomer = other.data.id as string;
  S.other = (await seedMany(1, { status: "booked", pickupDate: day(3), prefix: "CV-FOREIGN", customer: S.otherCustomer }))[0];
  // A lane reference for this exact scenario: the number must never appear in Maria's CSV.
  S.laneNumber = String(Date.now()).slice(-9);
  const lane = await db.from("lane_references").insert({
    pickup_location_id: S.ship.id, delivery_location_id: S.recv.id, equipment_size: 53, its_reference_load: S.laneNumber,
  }).select("id").single();
  if (lane.error) throw lane.error;
  S.laneId = lane.data.id as string;
  // The seed itself is checked, so a test below can never pass on missing data.
  const delivered = await db.from("loads").select("id,delivered_at").in("id", [...S.recentDelivered, ...S.oldDelivered].map((l) => l.id));
  expect((delivered.data ?? []).every((r) => r.delivered_at !== null)).toBe(true);
});

test.afterAll(async () => {
  const db = adminClient();
  // Remove every load this spec seeded (local stack only, service role): 60 loads per run in the coming days would
  // otherwise fill the calendar week and the carrier and customer lists that other specs read. Photos go with them.
  const mine = [...S.booked, ...S.requested, ...S.recentDelivered, ...S.oldDelivered, ...(S.other ? [S.other] : []), ...(S.many ? [S.many] : [])].map((l) => l.id);
  if (mine.length > 0) {
    const docs = await db.from("load_documents").select("storage_path").in("load_id", mine);
    const paths = (docs.data ?? []).map((d) => d.storage_path as string);
    if (paths.length > 0) await db.storage.from("documents").remove(paths);
    const del = await db.from("loads").delete().in("id", mine);
    if (del.error) throw del.error;
  }
  if (S.otherCustomer) await db.from("customers").delete().eq("id", S.otherCustomer);
  if (S.laneId) await db.from("lane_references").delete().eq("id", S.laneId);
  await retireLocations([S.ship?.id, S.recv?.id].filter(Boolean));
});

const isOpen = (l: Locator) => l.evaluate((el) => (el as HTMLDetailsElement).open);
const card = (page: Page, id: string) => page.locator(`[data-testid="board-card"][data-load-id="${id}"]`);
const row = (page: Page, id: string) => page.locator(`[data-testid="customer-load-row"][data-load-id="${id}"]`);
async function noSideways(page: Page, label: string) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, `${label}: no horizontal overflow`).toBeLessThanOrEqual(0);
}
// Every visible fold (summary) and Show older / Show more / Show all control is at least `min` px tall.
async function bigTargets(page: Page, label: string, min = 44) {
  const small = await page.evaluate((m) => {
    const out: string[] = [];
    document.querySelectorAll('summary, [data-testid^="band-older"], [data-testid^="group-older"], [data-testid="carrier-done-older"], [data-testid="list-show-more"], [data-testid="export-link"]').forEach((e) => {
      const r = (e as HTMLElement).getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.height < m - 0.5) out.push(`${(e.textContent ?? "").trim().slice(0, 30)}=${r.height.toFixed(1)}`);
    });
    return out;
  }, min);
  expect(small, `${label}: targets under ${min}px`).toEqual([]);
}

test("the page counters are strict: digits 1 to 20 only, anything else is ignored", () => {
  for (const bad of ["", "0", "-1", "abc", "1.5", "21", "99", " 2", "02", "1e1"]) expect(parsePages(bad), `"${bad}"`).toBe(0);
  for (const good of ["1", "9", "20"]) expect(parsePages(good)).toBe(Number(good));
  expect(parsePages(["3", "4"])).toBe(3);
  expect(withParams("?q=x", { dold: 2, cold: 0, more: undefined })).toBe("?q=x&dold=2");
});

test("board: Delivered and Cancelled start collapsed, an open band shows 12 and Show all, Show older adds older loads", async ({ browser }) => {
  const { ctx, page } = await as(browser, "admin");
  await page.goto("/admin");
  await expect(page.getByTestId("band-toggle-booked")).toBeVisible();
  expect(await isOpen(page.getByTestId("band-toggle-booked"))).toBe(true);
  expect(await isOpen(page.getByTestId("band-toggle-requested"))).toBe(true);
  expect(await isOpen(page.getByTestId("band-toggle-delivered"))).toBe(false);
  expect(await isOpen(page.getByTestId("band-toggle-cancelled"))).toBe(false);

  // The Booked band holds at least our 15: 12 visible cards and "Show all <n>" for the rest.
  const booked = page.getByTestId("band-booked");
  const total = Number(await page.getByTestId("band-count-booked").innerText());
  expect(total).toBeGreaterThanOrEqual(15);
  await expect(booked.locator('[data-testid="board-card"]:visible')).toHaveCount(12);
  const showAll = page.getByTestId("band-all-booked").locator(":scope > summary");
  await expect(showAll).toHaveText(`Show all ${total}`, { useInnerText: true });
  await showAll.click();
  await expect(booked.locator('[data-testid="board-card"]:visible')).toHaveCount(total);
  await expect(showAll).toHaveText("Show the first 12 only", { useInnerText: true });

  // Delivered: the header count is every delivered load; the band holds the last 30 days of pickups only.
  const { count: deliveredTotal } = await adminClient().from("loads").select("id", { count: "exact", head: true }).eq("status", "delivered");
  await expect(page.getByTestId("band-count-delivered")).toHaveText(String(deliveredTotal));
  for (const l of S.recentDelivered) await expect(card(page, l.id)).toHaveCount(1);
  for (const l of S.oldDelivered) await expect(card(page, l.id), "older than 30 days: not fetched").toHaveCount(0);
  await expect(card(page, S.recentDelivered[0].id)).toBeHidden();
  await page.getByTestId("band-toggle-delivered").locator(":scope > summary").click();
  // Newest pickup first: other specs' delivered loads with later pickups may fill the first 12, so open Show all too.
  if (await page.getByTestId("band-all-delivered").count()) await page.getByTestId("band-all-delivered").locator(":scope > summary").click();
  await expect(card(page, S.recentDelivered[0].id)).toBeVisible();
  await expect(page.getByTestId("band-window-delivered")).toHaveText(/^Pickups from the last 30 days: \d+ of \d+ shown\.$/);
  await page.getByTestId("band-older-delivered").click();
  await expect(page).toHaveURL(/[?&]dold=1(&|$)/);
  expect(await isOpen(page.getByTestId("band-toggle-delivered"))).toBe(true);
  // The two old ones picked up 31 days ago are the newest loads beyond the window.
  for (const l of S.oldDelivered) await expect(card(page, l.id)).toHaveCount(1);
  await expect(page.getByTestId("band-window-delivered")).toContainText("and older");

  // Bad counters are ignored, never an error page.
  for (const q of ["dold=abc", "dold=99", "dold=-1", "cold=%27", "more=0x1"]) {
    const res = await page.goto(`/admin?${q}`);
    expect(res?.status(), q).toBe(200);
    expect(await isOpen(page.getByTestId("band-toggle-delivered")), q).toBe(false);
    for (const l of S.oldDelivered) await expect(card(page, l.id), q).toHaveCount(0);
  }
  await ctx.close();
});

test("board: a compact card is one line and Details reveals contacts, equipment and Moffett, PO, notes and ETA", async ({ browser }) => {
  const l = S.booked[0];
  const { ctx, page } = await as(browser, "admin");
  await page.goto(`/admin?q=${encodeURIComponent(l.po)}`);
  const c = card(page, l.id);
  await expect(c).toBeVisible();
  const line = c.locator(`a[href="/admin/loads/${l.id}"]`);
  await expect(line).toContainText(l.number);
  await expect(line).toContainText(`${S.ship.name} to ${S.recv.name}`);
  await expect(line).toContainText(CARRIER_A);
  await expect(line).toContainText("BOL pending");
  const body = c.getByTestId("card-details-body");
  await expect(body).toBeHidden();
  await c.getByTestId("card-details").locator(":scope > summary").click();
  await expect(body).toBeVisible();
  for (const t of ["Pat", "416-555-0101", "Dee", "416-555-0102", "53 ft, no Moffett", l.po, "Compact note 0", "Not set"]) await expect(body).toContainText(t);
  await expect(c.getByTestId("card-details").locator(":scope > summary")).toHaveText("Hide details", { useInnerText: true });
  await line.click();
  await expect(page).toHaveURL(new RegExp(`/admin/loads/${l.id}$`));
  await ctx.close();
});

test("board: with a filter the bands holding a match open, counts read n of m, an old delivered load is found, One list has 50 rows then Show more", async ({ browser }) => {
  const { ctx, page } = await as(browser, "admin");
  await page.goto(`/admin?shipper=${S.ship.id}`);
  expect(await isOpen(page.getByTestId("band-toggle-booked"))).toBe(true);
  expect(await isOpen(page.getByTestId("band-toggle-delivered"))).toBe(true);
  expect(await isOpen(page.getByTestId("band-toggle-cancelled"))).toBe(false); // no cancelled load at this new shipper
  expect(await isOpen(page.getByTestId("band-toggle-loading"))).toBe(false);
  await expect(page.getByTestId("band-count-booked")).toHaveText(/^16 of \d+$/); // 15 of Maria's and the foreign customer's one
  await expect(page.getByTestId("band-count-requested")).toHaveText(/^40 of \d+$/);
  // A filter reaches past the 30 day window: all 5 delivered loads at this shipper, m is every delivered load.
  const { count: deliveredTotal } = await adminClient().from("loads").select("id", { count: "exact", head: true }).eq("status", "delivered");
  await expect(page.getByTestId("band-count-delivered")).toHaveText(`5 of ${deliveredTotal}`);
  for (const l of S.oldDelivered) await expect(card(page, l.id)).toHaveCount(1);

  // Search by the PO of an old delivered load: found although its pickup is older than 30 days.
  await page.goto(`/admin?q=${encodeURIComponent(S.oldDelivered[1].po.toLowerCase())}`);
  await expect(card(page, S.oldDelivered[1].id)).toBeVisible();
  await expect(page.getByTestId("band-count-delivered")).toHaveText(`1 of ${deliveredTotal}`);
  // A search word by place name also reaches the database query (location ids resolved by name).
  await page.goto(`/admin?q=${encodeURIComponent(S.ship.name.toLowerCase())}&status=delivered`);
  await expect(page.getByTestId("band-count-delivered")).toHaveText(`5 of ${deliveredTotal}`);

  // One list: 61 matches at this shipper (16 booked, 40 requested, 5 delivered), 50 rows, then Show more.
  await page.goto(`/admin?shipper=${S.ship.id}&view=list`);
  await expect(page.getByTestId("list-count")).toHaveText(/^61 of \d+ loads$/);
  const rows = page.getByTestId("board-list").locator("tbody tr");
  await expect(rows).toHaveCount(50);
  await expect(page.getByTestId("list-shown")).toHaveText("Showing 50 of 61");
  await page.getByTestId("list-show-more").click();
  await expect(page).toHaveURL(/[?&]more=1(&|$)/);
  await expect(rows).toHaveCount(61);
  await expect(page.getByTestId("list-show-more")).toHaveCount(0);
  await ctx.close();
});

test("load pages: staff timeline latest 3, Upload files and More actions folded, Danger zone unchanged, Maria's timeline and photos", async ({ browser }) => {
  const l = S.recentDelivered[0];
  const db = adminClient();
  const { data: admin } = await db.from("profiles").select("id").eq("email", "admin@e2e.test").single();
  for (let i = 0; i < 4; i++) {
    const ev = await db.from("load_events").insert({ load_id: l.id, from_status: "delivered", to_status: "delivered", actor_id: admin!.id, note: `Compact event ${i}` });
    if (ev.error) throw ev.error;
  }
  for (let i = 0; i < 3; i++) { await addLoadPhoto(l.id, "pickup_photo"); await addLoadPhoto(l.id, "delivery_photo"); }
  const { count: events } = await db.from("load_events").select("id", { count: "exact", head: true }).eq("load_id", l.id);
  expect(events).toBeGreaterThanOrEqual(5);

  const staff = await as(browser, "admin");
  const p = staff.page;
  await p.goto(`/admin/loads/${l.id}`);
  await expect(p.getByTestId("timeline-latest").getByTestId("timeline-event")).toHaveCount(3);
  await expect(p.getByTestId("timeline-latest")).toContainText("Compact event 3");
  const older = p.getByTestId("timeline-older");
  await expect(older.locator(":scope > summary")).toHaveText(`Show all ${events} events`, { useInnerText: true });
  await expect(older.getByText("Compact event 0")).toBeHidden();
  await older.locator(":scope > summary").click();
  await expect(older.getByText("Compact event 0")).toBeVisible();
  // Documents: the file list stays visible, the four upload areas are folded.
  await expect(p.locator('[data-testid="doc-row"]').first()).toBeVisible();
  await expect(p.getByTestId("upload-bol")).toBeHidden();
  await p.getByTestId("upload-files").locator(":scope > summary").click();
  for (const k of ["bol", "pod", "pickup_photo", "delivery_photo"]) await expect(p.getByTestId(`upload-${k}`)).toBeVisible();
  // More actions holds Override status (a delivered load has no Cancel load); the Danger zone is outside it.
  await expect(p.getByLabel("New status")).toBeHidden();
  await expect(p.getByRole("button", { name: "Delete this load forever" })).toBeVisible();
  await p.getByTestId("more-actions").locator(":scope > summary").click();
  await expect(p.getByLabel("New status")).toBeVisible();
  await staff.ctx.close();

  // Cancel load sits in More actions on a live load.
  const live = await as(browser, "admin");
  await live.page.goto(`/admin/loads/${S.booked[1].id}`);
  await expect(live.page.getByRole("button", { name: "Cancel load" })).toBeHidden();
  await live.page.getByTestId("more-actions").locator(":scope > summary").click();
  await expect(live.page.getByRole("button", { name: "Cancel load" })).toBeVisible();
  await live.ctx.close();

  const maria = await as(browser, "maria");
  const m = maria.page;
  await m.goto(`/loads/${l.id}`);
  await expect(m.getByTestId("timeline-latest").getByTestId("timeline-event")).toHaveCount(3);
  await expect(m.getByTestId("timeline-older").locator(":scope > summary")).toHaveText(`Show all ${events} events`, { useInnerText: true });
  await expect(m.getByTestId("photo-list").getByTestId("photo-item")).toHaveCount(4);
  const more = m.getByTestId("photos-more");
  await expect(more.locator(":scope > summary")).toHaveText("Show all 6 photos", { useInnerText: true });
  await expect(more.getByTestId("photo-item").first()).toBeHidden();
  await more.locator(":scope > summary").click();
  await expect(more.getByTestId("photo-item")).toHaveCount(2);
  await expect(more.getByTestId("photo-item").first()).toBeVisible();
  await maria.ctx.close();
});

test("Maria: Active open, Delivered and Cancelled collapsed, Show older by delivery date, buttons on the rows", async ({ browser }) => {
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/loads");
  expect(await isOpen(page.getByTestId("group-toggle-active"))).toBe(true);
  expect(await isOpen(page.getByTestId("group-toggle-delivered"))).toBe(false);
  expect(await isOpen(page.getByTestId("group-toggle-cancelled"))).toBe(false);
  await expect(row(page, S.booked[0].id)).toBeVisible();
  for (const l of S.recentDelivered) await expect(row(page, l.id)).toHaveCount(1);
  for (const l of S.oldDelivered) await expect(row(page, l.id), "delivered 31 days ago: not fetched").toHaveCount(0);
  await expect(row(page, S.recentDelivered[0].id)).toBeHidden();
  await page.getByTestId("group-toggle-delivered").locator(":scope > summary").click();
  const r = row(page, S.recentDelivered[0].id);
  await expect(r).toBeVisible();
  // Request again and Return stay on the row, no extra expanding.
  await expect(r.getByRole("link", { name: "Request again" })).toBeVisible();
  await expect(r.getByTestId("return-button")).toBeVisible();
  await expect(r).toContainText(`${S.ship.name} to ${S.recv.name}`);
  await expect(r).toContainText(CARRIER_B);
  await expect(page.getByTestId("group-window-delivered")).toHaveText(/^Delivered in the last 30 days, newest first: \d+ of \d+\.$/);
  await page.getByTestId("group-older-delivered").click();
  await expect(page).toHaveURL(/[?&]dold=1(&|$)/);
  expect(await isOpen(page.getByTestId("group-toggle-delivered"))).toBe(true);
  for (const l of S.oldDelivered) await expect(row(page, l.id)).toHaveCount(1);
  // Bad counters are ignored.
  await page.goto("/loads?dold=x&cold=21");
  expect(await isOpen(page.getByTestId("group-toggle-delivered"))).toBe(false);
  for (const l of S.oldDelivered) await expect(row(page, l.id)).toHaveCount(0);
  await ctx.close();
});

test("Maria: search, filters, sort, chips and Clear all work from the URL and the Filters panel, staff-only values are ignored", async ({ browser }) => {
  const { ctx, page } = await as(browser, "maria");
  // Filters panel: search by PO.
  await page.goto("/loads");
  const filters = page.getByTestId("board-filters");
  await filters.locator("details > summary").click();
  await filters.getByLabel("Search").fill(S.booked[2].po);
  await filters.getByTestId("filters-apply").click();
  await expect(page).toHaveURL(/[?&]q=/);
  await expect(page.getByTestId("loads-match-count")).toHaveText("1 load matches");
  await expect(row(page, S.booked[2].id)).toBeVisible();
  await expect(page.getByTestId("filters-badge")).toHaveText("1");
  // Search reaches old delivered loads by PO, and by place name.
  await page.goto(`/loads?q=${encodeURIComponent(S.oldDelivered[0].po)}`);
  await expect(row(page, S.oldDelivered[0].id)).toBeVisible();
  expect(await isOpen(page.getByTestId("group-toggle-delivered"))).toBe(true);
  await page.goto(`/loads?q=${encodeURIComponent(S.recv.name.toLowerCase())}`);
  await expect(page.getByTestId("loads-match-count")).toHaveText("60 loads match");

  // Shipper and pickup date filters, chips, badge.
  await page.goto(`/loads?shipper=${S.ship.id}&when=custom&from=${day(3)}&to=${day(3)}`);
  await expect(page.getByTestId("group-count-active")).toHaveText(/^15 of \d+$/);
  await expect(page.getByTestId("filters-badge")).toHaveText("2");
  const chips = page.getByTestId("filter-chips");
  await expect(chips).toContainText(`Shipper: ${S.ship.name}`);
  await expect(chips).toContainText(`Pickup ${day(3)} to ${day(3)}`);
  await chips.getByRole("link", { name: `Remove filter Pickup ${day(3)} to ${day(3)}` }).click();
  await expect(page).not.toHaveURL(/when=/);
  await expect(page.getByTestId("group-count-active")).toHaveText(/^55 of \d+$/);
  await page.getByTestId("chips-clear").click();
  await expect(page).toHaveURL(/\/loads$/);
  await expect(page.getByTestId("filter-chips")).toHaveCount(0);

  // Sort: delivered ascending puts the oldest delivery first; created descending the newest request first.
  await page.goto(`/loads?shipper=${S.ship.id}&status=delivered&sort=delivered`);
  const order = await page.getByTestId("group-delivered").getByTestId("customer-load-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-load-id")));
  expect(order.slice(0, 2).sort()).toEqual(S.oldDelivered.map((l) => l.id).sort());
  await page.goto(`/loads?shipper=${S.ship.id}&status=delivered`);
  const def = await page.getByTestId("group-delivered").getByTestId("customer-load-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-load-id")));
  expect(def.slice(-2).sort(), "default: newest delivery first, the old ones last").toEqual(S.oldDelivered.map((l) => l.id).sort());

  // Staff-only and bad values are ignored for Maria: no carrier filter, no BOL or ITS pill, no One list, no carrier sort.
  const res = await page.goto("/loads?carrier=none&bol=1&its=1&view=list&sort=carrier&dir=sideways&size=40&status=nope&from=2026-13-40");
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId("filter-chips")).toHaveCount(0);
  await expect(page.getByTestId("filters-badge")).toHaveText("0");
  await expect(page.getByTestId("board-list")).toHaveCount(0);
  await expect(page.getByLabel("Sort by")).toHaveValue("pickup_time");
  await expect(page.getByLabel("Carrier", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("pill-bol")).toHaveCount(0);
  expect(await isOpen(page.getByTestId("group-toggle-active"))).toBe(true);
  // The status chips and the Completed view keep working.
  await page.goto("/loads?view=completed");
  await expect(page.getByTestId("group-active")).toHaveCount(0);
  expect(await isOpen(page.getByTestId("group-toggle-delivered"))).toBe(true);
  await page.goto("/loads?status=booked");
  await expect(page.getByTestId("group-delivered")).toHaveCount(0);
  await expect(row(page, S.booked[0].id)).toBeVisible();
  await ctx.close();
});

test("Maria's CSV export: the form, only her loads, the R27 columns, never a lane reference, others are refused", async ({ browser }) => {
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/loads");
  await page.getByTestId("export-link").click();
  await expect(page).toHaveURL(/\/loads\/export$/);
  await expect(page.getByRole("heading", { name: "Export my loads" })).toBeVisible();
  await expect(page.locator(`form[action="/loads/export/csv"]`)).toHaveCount(1);
  const res = await page.request.get(`/loads/export/csv?from=${day(-40)}&to=${day(10)}`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/csv");
  const csv = (await res.text()).replace(/^﻿/, "");
  const lines = csv.trim().split("\r\n");
  expect(lines[0]).toBe("load_number,request_ref,created_at,pickup_location,delivery_location,equipment_size,moffett,weight_lbs,pieces,po_number,pickup_timing,pickup_date,pickup_time_start,pickup_time_end,delivery_timing,delivery_date,delivery_time_start,delivery_time_end,carrier,status,eta,delivered_at");
  for (const l of [...S.booked, ...S.oldDelivered]) expect(csv, `her load ${l.po}`).toContain(l.po);
  expect(csv).not.toContain(S.other!.po); // another customer's load in the same dates
  expect(csv).not.toContain(S.laneNumber); // the lane reference of this exact scenario
  // Every row is a Mitrex load (the database agrees), and the count matches.
  const db = adminClient();
  const k = await ids();
  const { count } = await db.from("loads").select("id", { count: "exact", head: true }).eq("customer_id", k.customer).gte("pickup_date", day(-40)).lte("pickup_date", day(10));
  expect(lines.length - 1).toBe(count);
  // Status filter narrows the file.
  const del = (await (await page.request.get(`/loads/export/csv?from=${day(-40)}&to=${day(10)}&status=delivered`)).text()).trim().split("\r\n").slice(1);
  expect(del.length).toBeGreaterThanOrEqual(5);
  expect(del.every((x) => x.includes(",delivered,"))).toBe(true);
  expect((await page.request.get("/loads/export/csv?from=bad&to=2026-01-01")).status()).toBe(400);
  await ctx.close();

  // Staff see the foreign load in the staff export (so the exclusion above is not vacuous) and are refused here.
  const staff = await as(browser, "admin");
  const staffCsv = await (await staff.page.request.get(`/admin/export/csv?from=${day(-40)}&to=${day(10)}`)).text();
  expect(staffCsv).toContain(S.other!.po);
  const refused = await staff.page.request.get(`/loads/export/csv?from=${day(-1)}&to=${day(1)}`);
  expect(refused.status()).toBe(403);
  expect(await refused.text()).toBe("Customers only.");
  await staff.ctx.close();
  const carrier = await as(browser, "carrierA");
  expect((await carrier.page.request.get(`/loads/export/csv?from=${day(-1)}&to=${day(1)}`)).status()).toBe(403);
  await carrier.ctx.close();
  const nobody = await anon(browser);
  const r = await nobody.page.request.get(`/loads/export/csv?from=${day(-1)}&to=${day(1)}`, { maxRedirects: 0 });
  expect([307, 401]).toContain(r.status());
  await nobody.ctx.close();
});

test("carrier: active loads first, Delivered and cancelled collapsed with its count, Show older 25 at a time", async ({ browser }) => {
  const { ctx, page } = await as(browser, "carrierB");
  await page.goto("/my-loads");
  const toggle = page.getByTestId("carrier-done-toggle");
  expect(await isOpen(toggle)).toBe(false);
  await expect(page.locator(`a[href="/my-loads/${S.many!.id}"]`)).toBeVisible();
  await expect(page.locator(`a[href="/my-loads/${S.recentDelivered[0].id}"]`)).toBeHidden();
  for (const l of S.oldDelivered) await expect(page.locator(`a[href="/my-loads/${l.id}"]`)).toHaveCount(0);
  await expect(page.getByTestId("carrier-done-count")).toHaveText(/^\d+$/);
  await toggle.locator(":scope > summary").click();
  await expect(page.locator(`a[href="/my-loads/${S.recentDelivered[0].id}"]`)).toBeVisible();
  await page.getByTestId("carrier-done-older").click();
  await expect(page).toHaveURL(/\/my-loads\?older=1$/);
  expect(await isOpen(page.getByTestId("carrier-done-toggle"))).toBe(true);
  for (const l of S.oldDelivered) await expect(page.locator(`a[href="/my-loads/${l.id}"]`)).toHaveCount(1);
  await page.goto("/my-loads?older=abc");
  expect(await isOpen(page.getByTestId("carrier-done-toggle"))).toBe(false);
  await ctx.close();
});

test("staff lists: locations expand to the edit form, lane groups collapsed until a search, rates, requests and users folded", async ({ browser }) => {
  const inactive = await makeUser({ role: "customer", active: false, customerId: (await ids()).customer, tag: "cv-inactive" });
  const { ctx, page } = await as(browser, "admin");
  await page.goto("/admin/locations");
  await page.getByLabel("Search").fill(S.ship.name);
  const locRow = page.getByTestId("location-row").filter({ hasText: S.ship.name });
  await expect(locRow).toHaveCount(1);
  const edit = locRow.getByRole("button", { name: "Edit" });
  await expect(edit).toHaveAttribute("aria-expanded", "false");
  await expect(locRow.getByTestId("location-panel")).toBeHidden();
  await edit.click();
  await expect(locRow.getByRole("button", { name: "Close" })).toHaveAttribute("aria-expanded", "true");
  await expect(locRow.getByTestId("location-panel")).toBeVisible();
  await expect(locRow.getByRole("button", { name: "Save changes" })).toBeVisible();
  const controls = await locRow.getByRole("button", { name: "Close" }).getAttribute("aria-controls");
  expect(await page.locator(`#${controls}`).getAttribute("data-testid")).toBe("location-panel");

  await page.goto("/admin/lanes");
  const group = page.getByTestId("lane-group").filter({ hasText: S.ship.name });
  expect(await isOpen(group.locator("details"))).toBe(false);
  await expect(group.getByTestId("lane-group-count")).toHaveText("1");
  await page.getByLabel("Search").fill(S.laneNumber);
  expect(await isOpen(group.locator("details"))).toBe(true);
  await expect(group.getByTestId("lane-number")).toHaveText(S.laneNumber);

  await page.goto("/admin/rates");
  expect(await isOpen(page.getByTestId("rates-open-toggle"))).toBe(true);
  expect(await isOpen(page.getByTestId("rates-quoted-toggle"))).toBe(false);
  expect(await isOpen(page.getByTestId("rates-cancelled-toggle"))).toBe(false);
  await page.goto("/admin/requests");
  expect(await isOpen(page.getByTestId("requests-done-toggle"))).toBe(false);
  await page.goto("/admin/users");
  const inact = page.getByTestId("users-inactive");
  expect(await isOpen(inact)).toBe(false);
  await expect(inact.getByText(inactive.email)).toBeHidden();
  await expect(page.getByTestId("users-active").getByText(inactive.email)).toHaveCount(0);
  await inact.locator(":scope > summary").click();
  await expect(inact.getByText(inactive.email)).toBeVisible();
  await ctx.close();
});

test("375px: no sideways scrolling and 44px targets (48px on driver pages) with the folds open", async ({ browser }) => {
  const staff = await as(browser, "admin", PHONE);
  const s = staff.page;
  await s.goto("/admin");
  await s.getByTestId("band-toggle-delivered").locator(":scope > summary").click();
  await s.getByTestId("band-all-booked").locator(":scope > summary").click();
  await card(s, S.booked[0].id).getByTestId("card-details").locator(":scope > summary").click();
  await noSideways(s, "/admin bands open");
  await bigTargets(s, "/admin bands open");
  await s.goto(`/admin?shipper=${S.ship.id}&view=list`);
  await noSideways(s, "/admin one list");
  await bigTargets(s, "/admin one list");
  await s.goto(`/admin/loads/${S.recentDelivered[0].id}`);
  for (const t of ["timeline-older", "upload-files", "more-actions"]) await s.getByTestId(t).locator(":scope > summary").click();
  await noSideways(s, "/admin/loads/[id] folds open");
  await bigTargets(s, "/admin/loads/[id] folds open");
  for (const path of ["/admin/lanes", "/admin/rates", "/admin/users", "/admin/requests"]) {
    await s.goto(path);
    await noSideways(s, path);
    await bigTargets(s, path);
  }
  await staff.ctx.close();

  const maria = await as(browser, "maria", PHONE);
  const m = maria.page;
  await m.goto(`/loads?dold=1&shipper=${S.ship.id}`);
  await m.getByTestId("board-filters").locator("details > summary").click();
  await noSideways(m, "/loads filtered, Filters open");
  await bigTargets(m, "/loads filtered, Filters open");
  await m.goto("/loads?dold=1");
  await m.getByTestId("group-toggle-cancelled").locator(":scope > summary").click();
  await noSideways(m, "/loads groups open");
  await bigTargets(m, "/loads groups open");
  await m.goto(`/loads/${S.recentDelivered[0].id}`);
  await noSideways(m, "/loads/[id]");
  await bigTargets(m, "/loads/[id]");
  await m.goto("/loads/export");
  await noSideways(m, "/loads/export");
  await maria.ctx.close();

  const carrier = await as(browser, "carrierB", PHONE);
  await carrier.page.goto("/my-loads?older=1");
  await noSideways(carrier.page, "/my-loads open");
  await bigTargets(carrier.page, "/my-loads open", 48);
  await carrier.ctx.close();
});
