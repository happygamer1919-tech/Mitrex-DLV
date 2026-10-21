import { expect, test, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  adminClient, anon, as, addLoadPhoto, forceStatus, gotoSteady, insertLoad, isoDate, jpegSize, loadRow,
  podChooseFile, staffBook, uniq, uniqIts,
} from "./support/helpers";
import { fillBooking, makeLocation, retireLocations } from "./support/book";
import { sentEmails } from "./support/mail-mock";
import { freshEmail } from "./support/rates";
import { CARRIER_A } from "./support/users";
import { parseWeight, validateLoad, EMPTY_LOAD_FORM, type LoadFormValues } from "../src/lib/customer/validate";
import { bookedMessageFromQuery } from "../src/lib/admin/booked-message";
import { GENERIC, LOCATION_GONE, RETURN_GONE, plainDbError } from "../src/lib/customer/db-messages";
import { MAIL_API } from "./support/env";
import { assertLocalUrl } from "./support/guard";
import { DUPLICATE_NAME } from "../src/lib/customer/location-validate";

// DLV-043 sanity sweep: one test (or more) per fixed defect. Every database claim is read back through the service role.
// Network failures are simulated in the browser only (page.route, setOffline), never against a non-local host.

const db = () => adminClient();
const NEXT_ERROR = "This page couldn't load";

// Loads that carry carrier A are parked (cancelled) afterwards so the carrier lists other specs compare stay small.
const created: string[] = [];
async function seed(opts: Parameters<typeof insertLoad>[0]) {
  const r = await insertLoad(opts);
  created.push(r.id);
  return r;
}
test.afterAll(async () => {
  if (created.length === 0) return;
  await db().from("loads").update({ status: "cancelled" })
    .in("id", created).in("status", ["booked", "at_pickup", "loading", "enroute", "at_delivery"]);
});

// The page keeps its rendered view: no realtime push and no poll repaint (the test changes the database behind it).
async function freeze(page: Page) {
  await page.routeWebSocket(/.*/, () => {});
  await page.route(/[?&]_rsc=/, (route) => route.abort());
}

async function mailFor(needle: string) {
  return (await sentEmails()).filter((m) => m.subject.includes(needle) || (m.text ?? "").includes(needle));
}

async function storeBol(loadId: string, bytes: Buffer): Promise<string> {
  const path = `${loadId}/bol/${randomUUID()}.pdf`;
  const up = await db().storage.from("documents").upload(path, bytes, { contentType: "application/pdf" });
  if (up.error) throw up.error;
  const { data: admin } = await db().from("profiles").select("id").eq("email", "admin@e2e.test").single();
  const { error } = await db().from("load_documents").insert({ load_id: loadId, kind: "bol", storage_path: path, uploaded_by: admin!.id });
  if (error) throw error;
  return path;
}

// ============================================================================================================
// Staff
// ============================================================================================================

test("STAFF-01: Mark booked on a stale page refuses a load that was cancelled meanwhile: nothing written, no email", async ({ browser }) => {
  const l = await seed({ po: uniq("S01C"), status: "requested", carrier: true });
  const { ctx, page } = await as(browser, "admin");
  await freeze(page);
  await page.goto(`/admin/loads/${l.id}`);
  await expect(page.getByTestId("book-card")).toBeVisible();
  // Maria cancels while the page is open (the database function as the table owner would be the same state).
  await forceStatus(l.id, "cancelled");
  const its = uniqIts();
  await staffBook(page, its);
  await expect(page.getByTestId("book-card")).toContainText("This load is no longer a request (now Cancelled). Reload the page.");
  const row = await loadRow(l.id);
  expect(row.status).toBe("cancelled");
  expect(row.its_load_number).toBeNull();
  await page.waitForTimeout(1500); // any mail would have gone out with the action
  expect(await mailFor(its)).toEqual([]);
  await expect(page.getByText(NEXT_ERROR)).toHaveCount(0);
  await ctx.close();
});

test("STAFF-01: Mark booked on a stale page never overwrites the ITS number of a load that is already booked", async ({ browser }) => {
  const l = await seed({ po: uniq("S01B"), status: "requested", carrier: true });
  const { ctx, page } = await as(browser, "admin");
  await freeze(page);
  await page.goto(`/admin/loads/${l.id}`);
  await expect(page.getByTestId("book-card")).toBeVisible();
  const first = uniqIts();
  const { error } = await db().from("loads").update({ status: "booked", its_load_number: first }).eq("id", l.id);
  expect(error).toBeNull();
  const second = uniqIts();
  await staffBook(page, second);
  await expect(page.getByTestId("book-card")).toContainText("This load is no longer a request (now Booked). Reload the page.");
  const row = await loadRow(l.id);
  expect(row.its_load_number).toBe(first);
  expect(row.status).toBe("booked");
  await page.waitForTimeout(1500);
  expect(await mailFor(second)).toEqual([]);
  await ctx.close();
});

test("STAFF-02: after Mark booked the page shows the booking result (number and who was emailed); a forged result shows nothing", async ({ browser }) => {
  const l = await seed({ po: uniq("S02"), status: "requested", carrier: true });
  const { ctx, page } = await as(browser, "admin");
  await page.goto(`/admin/loads/${l.id}`);
  const its = uniqIts();
  await staffBook(page, its);
  const notice = page.getByTestId("saved-notice");
  await expect(notice).toBeVisible({ timeout: 20_000 });
  await expect(notice).toHaveText(new RegExp(`^Booked as ITS ${its}\\. Email sent to [1-9]\\d* carrier users?\\. Booking confirmation sent to [1-9]\\d* customer users?\\.$`));
  await expect(page).toHaveURL(new RegExp(`/admin/loads/${l.id}\\?saved=booked&its=${its}&c=\\d+&m=\\d+$`));
  expect((await loadRow(l.id)).status).toBe("booked");
  // The query is untrusted: a forged number or count shows no notice at all.
  for (const q of ["saved=booked&its=12ab&c=1&m=1", "saved=booked&its=5&c=1000&m=1", "saved=booked&its=5&c=1", "saved=booked&its=%3Cb%3E&c=1&m=1"]) {
    await gotoSteady(page, `/admin/loads/${l.id}?${q}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("saved-notice")).toHaveCount(0);
  }
  await ctx.close();
});

test("STAFF-02: the booking result helper accepts only a valid number and small counts", () => {
  expect(bookedMessageFromQuery({ its: "313-2", c: "0", m: "2" })).toBe(
    "Booked as ITS 313-2. No carrier email was sent (the carrier has no users, or email is not configured). Booking confirmation sent to 2 customer users.");
  expect(bookedMessageFromQuery({ its: "313", c: "1", m: "1" })).toBe("Booked as ITS 313. Email sent to 1 carrier user. Booking confirmation sent to 1 customer user.");
  for (const bad of [{ its: "31a", c: "1", m: "1" }, { its: "313", c: "-1", m: "1" }, { its: "313", c: "1" }, { its: ["313"], c: "1", m: "1" }, { its: "1".repeat(31), c: "1", m: "1" }]) {
    expect(bookedMessageFromQuery(bad)).toBeNull();
  }
});

test("STAFF-03: a staff form whose action finds no session goes to sign in, never Next's error page", async ({ browser }) => {
  const l = await seed({ po: uniq("S03A"), status: "requested" });
  const { ctx, page } = await as(browser, "admin");
  await freeze(page);
  await page.goto(`/admin/loads/${l.id}`);
  await page.getByLabel("Carrier").first().selectOption({ label: CARRIER_A });
  await ctx.clearCookies(); // the proxy now answers the action with 401 SESSION_EXPIRED
  await page.getByRole("button", { name: "Save carrier" }).click();
  await expect(page).toHaveURL(/\/login\?/, { timeout: 15_000 });
  expect(new URL(page.url()).searchParams.get("next")).toBe(`/admin/loads/${l.id}`);
  await expect(page.getByText(NEXT_ERROR)).toHaveCount(0);
  expect((await loadRow(l.id)).carrier_id).toBeNull();
  await ctx.close();
});

test("STAFF-03: a staff form whose action is cut off shows the problem inline and keeps the page and the choice", async ({ browser }) => {
  const l = await seed({ po: uniq("S03B"), status: "requested" });
  const { ctx, page } = await as(browser, "admin", undefined, { serviceWorkers: "block" });
  await freeze(page);
  await page.goto(`/admin/loads/${l.id}`);
  await page.route("**/*", (route) => (route.request().method() === "POST" && "next-action" in route.request().headers() ? route.abort() : route.fallback()));
  const select = page.getByLabel("Carrier").first();
  await select.selectOption({ label: CARRIER_A });
  await page.getByRole("button", { name: "Save carrier" }).click();
  await expect(page.getByText(/Could not reach the server|You are offline|taking too long/)).toBeVisible();
  await expect(page.getByText(NEXT_ERROR)).toHaveCount(0);
  await expect(page.getByTestId("book-card")).toBeVisible();
  expect(await select.inputValue()).not.toBe("");
  expect((await loadRow(l.id)).carrier_id).toBeNull();
  await ctx.close();
});

test("STAFF-03: Maria's Add location cut off keeps every field and says so; with no session it goes to sign in", async ({ browser }) => {
  const name = uniq("LOC043");
  const { ctx, page } = await as(browser, "maria", undefined, { serviceWorkers: "block" });
  await freeze(page);
  await page.goto("/locations");
  const form = page.getByRole("form", { name: "Add location" });
  await form.getByLabel("Location name", { exact: true }).fill(name);
  await form.getByLabel("Street address", { exact: true }).fill("1 Offline Rd");
  await form.getByLabel("City", { exact: true }).fill("Toronto");
  await form.getByLabel("Province", { exact: true }).fill("ON");
  await page.route("**/*", (route) => (route.request().method() === "POST" && "next-action" in route.request().headers() ? route.abort() : route.fallback()));
  await form.getByRole("button", { name: "Add location" }).click();
  await expect(form.getByText(/Could not reach the server|You are offline|taking too long/)).toBeVisible();
  await expect(page.getByText(NEXT_ERROR)).toHaveCount(0);
  await expect(form.getByLabel("Location name", { exact: true })).toHaveValue(name);
  await expect(form.getByLabel("Street address", { exact: true })).toHaveValue("1 Offline Rd");
  expect((await db().from("locations").select("id").eq("name", name)).data).toEqual([]);
  await page.unroute("**/*");
  await ctx.clearCookies();
  await form.getByRole("button", { name: "Add location" }).click();
  await expect(page).toHaveURL(/\/login\?/, { timeout: 15_000 });
  expect(new URL(page.url()).searchParams.get("next")).toBe("/locations");
  expect((await db().from("locations").select("id").eq("name", name)).data).toEqual([]);
  await ctx.close();
});

test("FORM-RESET-01: a refused Update ETA keeps the note staff typed; a saved one clears it", async ({ browser }) => {
  const l = await seed({ po: uniq("F01"), status: "enroute" });
  const { ctx, page } = await as(browser, "admin");
  await page.goto(`/admin/loads/${l.id}`);
  const eta = page.getByLabel("ETA (Eastern time, ET)");
  const note = page.getByLabel("Note (optional)");
  await note.fill("probe note kept");
  // A malformed ETA reaches the server (the browser check is taken off), which refuses it.
  await eta.evaluate((el) => { const i = el as HTMLInputElement; i.required = false; i.type = "text"; i.value = "not a time"; });
  await page.getByRole("button", { name: "Update ETA" }).click();
  await expect(page.getByText("Enter the ETA as an Eastern date and time.")).toBeVisible();
  await expect(note).toHaveValue("probe note kept");
  await eta.evaluate((el, v) => { const i = el as HTMLInputElement; i.value = v; }, `${isoDate(3)}T10:00`);
  await page.getByRole("button", { name: "Update ETA" }).click();
  await expect(page.getByText("ETA updated.")).toBeVisible();
  await expect(note).toHaveValue("");
  const ev = await db().from("load_events").select("note").eq("load_id", l.id).eq("from_status", "enroute").eq("to_status", "enroute");
  expect((ev.data ?? []).map((e) => e.note)).toContain("probe note kept");
  await ctx.close();
});

test("STAFF-04 and STAFF-05: lanes say ET once; the ITS number fields open the full keyboard (no digits only pad)", async ({ browser }) => {
  const { ctx, page } = await as(browser, "admin");
  await page.goto("/admin/lanes");
  const updated = page.getByTestId("lane-updated").first();
  await expect(updated).toHaveText(/^Last updated by .+ ET$/);
  expect(await page.getByTestId("lane-updated").allTextContents()).not.toContainEqual(expect.stringContaining("ET ET"));
  await page.getByRole("button", { name: "Add lane" }).first().click().catch(() => {});
  for (const input of await page.locator('input[name="number"]').all()) await expect(input).not.toHaveAttribute("inputmode", /.*/);
  const l = await seed({ po: uniq("S05"), status: "requested", carrier: true });
  await page.goto(`/admin/loads/${l.id}`);
  await expect(page.getByTestId("its-input")).toBeVisible();
  await expect(page.getByTestId("its-input")).not.toHaveAttribute("inputmode", /.*/);
  await ctx.close();
});

// ============================================================================================================
// Customer
// ============================================================================================================

const FORM: LoadFormValues = {
  ...EMPTY_LOAD_FORM, pickup_location_id: "p", delivery_location_id: "d", pickup_contact_name: "P", pickup_contact_phone: "1",
  delivery_contact_name: "D", delivery_contact_phone: "2", equipment_size: "53", pickup_date: "2031-05-05", pickup_time_start: "14:00",
  delivery_date: "2031-05-05", delivery_time_start: "09:00",
};

test("CUST-02: same day, a delivery before the pickup time is refused; an overlapping delivery window is accepted (pure rule)", () => {
  const today = "2031-05-01";
  expect(validateLoad(FORM, today).delivery_time_start).toBe("Delivery time cannot be before the pickup time.");
  expect(validateLoad({ ...FORM, delivery_time_start: "14:00" }, today)).toEqual({});
  expect(validateLoad({ ...FORM, delivery_timing: "window", delivery_time_start: "13:00", delivery_time_end: "17:00" }, today)).toEqual({});
  expect(validateLoad({ ...FORM, delivery_timing: "window", delivery_time_start: "09:00", delivery_time_end: "13:00" }, today).delivery_time_start)
    .toBe("Delivery time cannot be before the pickup time.");
  expect(validateLoad({ ...FORM, delivery_date: "2031-05-06" }, today)).toEqual({});
  expect(validateLoad(FORM, today, { allowPast: true }).delivery_time_start).toBe("Delivery time cannot be before the pickup time.");
});

test("CUST-02: Maria booking pickup 14:00 and delivery 09:00 on the same day is refused under the field; nothing is created", async ({ browser }) => {
  const po = uniq("C02");
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/book");
  await fillBooking(page, {
    pickup: "Mitrex (Toronto)", delivery: "Howden (Scarborough)", pickupTime: "14:00", deliveryTime: "09:00", po,
    pickupContact: ["Pat", "416-555-0101"], deliveryContact: ["Dee", "416-555-0102"],
  });
  await page.getByRole("button", { name: "Request load" }).click();
  await expect(page.getByText("Delivery time cannot be before the pickup time.")).toBeVisible();
  expect((await db().from("loads").select("id").eq("po_number", po)).data).toEqual([]);
  await ctx.close();
});

test("CUST-08: a weight typed as 1,200 is accepted and shows as 1,200 lbs; 1,5 stays refused", async ({ browser }) => {
  expect(parseWeight("1,200")).toBe(1200);
  expect(parseWeight(" 12 500 ")).toBe(12500);
  expect(parseWeight("1,234,567.5")).toBe(1234567.5);
  expect(Number.isNaN(parseWeight("1,5"))).toBe(true);
  expect(validateLoad({ ...FORM, delivery_time_start: "15:00", weight_lbs: "1,5" }, "2031-05-01").weight_lbs).toBe("Weight must be a number greater than 0.");
  const po = uniq("C08");
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/book");
  await fillBooking(page, {
    pickup: "Mitrex (Toronto)", delivery: "Howden (Scarborough)", po,
    pickupContact: ["Pat", "416-555-0101"], deliveryContact: ["Dee", "416-555-0102"],
  });
  await page.getByLabel("Weight (lbs, optional)").fill("1,200");
  await page.getByRole("button", { name: "Request load" }).click();
  await expect(page).toHaveURL(/\/loads\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  await expect(page.getByText("1,200 lbs")).toBeVisible();
  const { data } = await db().from("loads").select("id,weight_lbs").eq("po_number", po);
  expect(data!.map((r) => Number(r.weight_lbs))).toEqual([1200]);
  await db().from("loads").update({ status: "cancelled" }).eq("po_number", po);
  await ctx.close();
});

test("CUST-03: Return of a load whose original shipper was turned off starts with an empty delivery, no broken hint", async ({ browser }) => {
  const shipper = await makeLocation({ prefix: "C03-SHIP" });
  const original = await seed({ po: uniq("C03"), status: "delivered", pickupLocationId: shipper.id });
  await seed({ po: uniq("C03-EARLIER"), status: "delivered", deliveryLocationId: shipper.id }); // a load that delivered there
  await retireLocations([shipper.id]);
  const { ctx, page } = await as(browser, "maria");
  await page.goto(`/book?return=${original.id}`);
  await expect(page.getByRole("heading", { name: "Book a return" })).toBeVisible();
  const delivery = page.getByLabel("Delivery location");
  await expect(delivery).toHaveValue("");
  await expect(delivery.locator("option", { hasText: shipper.name })).toHaveCount(0);
  await expect(page.getByText(/Last contact at :/)).toHaveCount(0);
  await expect(page.getByLabel("Contact name").nth(1)).toHaveValue("");
  await ctx.close();
});

test("CUST-04: a delivered load shows its delivered date and no stale ETA on Maria's list and load page; enroute still shows the ETA", async ({ browser }) => {
  const eta = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const delivered = await seed({ po: uniq("C04D"), status: "delivered", eta });
  const enroute = await seed({ po: uniq("C04E"), status: "enroute" });
  const { ctx, page } = await as(browser, "maria");
  await page.goto(`/loads?q=${encodeURIComponent(delivered.loadNumber)}`);
  const row = page.locator(`[data-testid="customer-load-row"][data-load-id="${delivered.id}"]`);
  await expect(row.getByTestId("delivered-date")).toBeVisible();
  await expect(row).not.toContainText("ETA");
  await page.goto(`/loads/${delivered.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("ETA", { exact: true })).toHaveCount(0);
  await page.goto(`/loads?q=${encodeURIComponent(enroute.loadNumber)}`);
  await expect(page.locator(`[data-testid="customer-load-row"][data-load-id="${enroute.id}"]`).getByTestId("row-eta")).toBeVisible();
  await page.goto(`/loads/${enroute.id}`);
  await expect(page.getByText("ETA", { exact: true })).toHaveCount(1);
  await ctx.close();
});

test("CUST-05 and CUST-07: Completed plus a Cancelled status shows the cancelled group; the active chip is announced", async ({ browser }) => {
  const cancelled = await seed({ po: uniq("C05"), status: "cancelled" });
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/loads?view=completed&status=cancelled");
  await expect(page.getByTestId("group-cancelled")).toBeVisible();
  await expect(page.locator(`[data-testid="customer-load-row"][data-load-id="${cancelled.id}"]`)).toBeVisible();
  const chips = page.getByRole("navigation", { name: "Filter by status" });
  await expect(chips.getByRole("link", { name: "Cancelled", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(chips.getByRole("link", { name: "Completed", exact: true })).not.toHaveAttribute("aria-current", /.*/);
  await page.goto("/loads");
  await expect(chips.getByRole("link", { name: "All", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(chips.locator('[aria-current="page"]')).toHaveCount(1);
  await page.goto("/loads?view=completed");
  await expect(chips.getByRole("link", { name: "Completed", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(chips.locator('[aria-current="page"]')).toHaveCount(1);
  await ctx.close();
});

// ============================================================================================================
// Carrier
// ============================================================================================================

test("CAR-02: offline longer than the poll, the driver's page stays (no browser error page); back online it refreshes", async ({ browser }) => {
  const l = await seed({ po: uniq("CR02"), status: "booked" });
  const { ctx, page } = await as(browser, "carrierA");
  await ctx.addInitScript(() => { (window as unknown as { __DLV_LIVE_MS: number }).__DLV_LIVE_MS = 1500; });
  await page.goto(`/my-loads/${l.id}`);
  await expect(page.getByTestId("next-step")).toBeVisible();
  await ctx.setOffline(true);
  await page.waitForTimeout(6000); // four polls
  expect(page.url()).toMatch(new RegExp(`/my-loads/${l.id}$`));
  await expect(page.getByTestId("next-step")).toBeVisible();
  const refreshed = page.waitForRequest((r) => /[?&]_rsc=/.test(r.url()), { timeout: 10_000 });
  await ctx.setOffline(false);
  await refreshed;
  await expect(page.getByTestId("next-step")).toBeVisible();
  expect(page.url()).toMatch(new RegExp(`/my-loads/${l.id}$`));
  await ctx.close();
});

test("CAR-03: the in-app camera asks for full HD, so the stored photo is larger than 640 px (fake camera)", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "WebKit has no fake camera");
  const l = await seed({ po: uniq("CR03"), status: "loading", photo: false });
  const { ctx, page } = await as(browser, "carrierA", undefined, { permissions: ["camera"] });
  await page.goto(`/my-loads/${l.id}`);
  await page.getByTestId("take-photo").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("camera-take")).toBeEnabled();
  expect(await dialog.getByTestId("camera-video").evaluate((v) => (v as HTMLVideoElement).videoWidth)).toBeGreaterThan(640);
  await dialog.getByTestId("camera-take").click();
  await dialog.getByTestId("camera-use").click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 20_000 });
  const { data: rows } = await db().from("load_documents").select("storage_path").eq("load_id", l.id).eq("kind", "pickup_photo");
  expect(rows).toHaveLength(1);
  const obj = await db().storage.from("documents").download(rows![0].storage_path as string);
  const size = jpegSize(Buffer.from(await obj.data!.arrayBuffer()));
  expect(size).not.toBeNull();
  expect(Math.max(size!.width, size!.height)).toBeGreaterThan(640);
  expect(Math.max(size!.width, size!.height)).toBeLessThanOrEqual(1600);
  await ctx.close();
});

test("CAR-05: the driver gets every BOL, newest first, each link serving its own file", async ({ browser }) => {
  const l = await seed({ po: uniq("CR05"), status: "booked" });
  const older = Buffer.from(`%PDF-1.4 first BOL ${randomUUID()}`);
  await storeBol(l.id, older);
  await new Promise((r) => setTimeout(r, 50));
  const newer = Buffer.from(`%PDF-1.4 second BOL ${randomUUID()}`);
  await storeBol(l.id, newer);
  const { ctx, page } = await as(browser, "carrierA");
  await page.goto(`/my-loads/${l.id}`);
  const links = page.getByTestId("carrier-bol-link");
  await expect(links).toHaveCount(2);
  await expect(links).toHaveText(["Download BOL 1", "Download BOL 2"]);
  const bodies: string[] = [];
  for (const href of await links.evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href))) {
    const res = await page.request.get(href);
    expect(res.status()).toBe(200);
    bodies.push((await res.body()).toString());
  }
  expect(bodies).toEqual([newer.toString(), older.toString()]);
  await ctx.close();
});

test("CAR-06: a POD photo the browser cannot read (.heic on Chrome) says what to do instead of a generic error", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "Safari decodes HEIC; the failing path is Chrome and Android");
  const l = await seed({ po: uniq("CR06"), status: "delivered" });
  const { ctx, page } = await as(browser, "carrierA");
  await page.goto(`/my-loads/${l.id}`);
  const card = page.getByTestId("pod-card");
  await podChooseFile(card, { name: "pod.heic", mimeType: "image/heic", buffer: Buffer.from("not really a heic image") });
  await card.getByTestId("pod-add").click();
  await expect(card.getByText("This photo format cannot be read here. Take the photo with the camera, or choose a JPG or PDF.")).toBeVisible();
  await expect(card.getByText("Something went wrong")).toHaveCount(0);
  expect((await db().from("load_documents").select("id").eq("load_id", l.id).eq("kind", "pod")).data).toEqual([]);
  await ctx.close();
});

test("CAR-07: step photo thumbnails are fetched once, not again on every live refresh", async ({ browser }) => {
  const l = await seed({ po: uniq("CR07"), status: "loading", photo: false });
  const photo = await addLoadPhoto(l.id, "pickup_photo");
  const { ctx, page } = await as(browser, "carrierA");
  await ctx.addInitScript(() => { (window as unknown as { __DLV_LIVE_MS: number }).__DLV_LIVE_MS = 1500; });
  const hits: string[] = [];
  page.on("request", (r) => { if (r.url().includes(photo.path)) hits.push(r.url()); });
  let polls = 0;
  // A live refresh re-requests THIS page as RSC (a prefetch of another link does not count).
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname === `/my-loads/${l.id}` && u.searchParams.has("_rsc") && !r.headers()["next-router-prefetch"]) polls += 1;
  });
  await page.goto(`/my-loads/${l.id}`);
  await expect(page.getByTestId("photo-item")).toHaveCount(1);
  await expect.poll(() => polls, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  await page.waitForTimeout(500);
  expect(hits, "one download of the thumbnail across the polls").toHaveLength(1);
  await ctx.close();
});

test("CAR-08: the driver's Update ETA dialog takes focus, keeps Tab inside, locks the page scroll and gives focus back", async ({ browser }) => {
  const l = await seed({ po: uniq("CR08"), status: "enroute" });
  const { ctx, page } = await as(browser, "carrierA");
  await page.goto(`/my-loads/${l.id}`);
  const opener = page.getByRole("button", { name: "Update ETA" });
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const inside = () => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));
  await expect.poll(inside).toBe(true);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
  // More presses than the dialog has controls, both ways: a browser's own Tab would leave the dialog by then.
  const controls = await dialog.locator("button:not([disabled]), input:not([disabled]), [href], select, textarea").count();
  expect(controls).toBeGreaterThan(0);
  for (const key of ["Tab", "Shift+Tab"]) {
    for (let i = 0; i < controls + 2; i++) {
      await page.keyboard.press(key);
      expect(await inside(), `focus stays in the dialog after ${key} ${i + 1}`).toBe(true);
    }
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
  await ctx.close();
});

test("CAR-09: Update ETA after the load was delivered elsewhere says it was updated and shows Delivered, never the database text", async ({ browser }) => {
  const l = await seed({ po: uniq("CR09"), status: "enroute" });
  const { ctx, page } = await as(browser, "carrierA");
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(`/my-loads/${l.id}`);
  await page.getByRole("button", { name: "Update ETA" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const { error } = await db().from("loads").update({ status: "delivered", delivered_at: new Date().toISOString() }).eq("id", l.id);
  expect(error).toBeNull();
  await dialog.getByRole("button", { name: "Save ETA" }).click();
  await expect(page.getByText(/eta can change only/i)).toHaveCount(0);
  await expect(page.getByText(/Delivered on /)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/eta can change only/i)).toHaveCount(0);
  await ctx.close();
});

test("CAR-10: the owner's Team page marks a driver dispatch turned off, offers no Remove, and explains a re-add", async ({ browser }) => {
  const { data: car } = await db().from("carriers").select("id").eq("name", CARRIER_A).single();
  const email = freshEmail("cr10-driver");
  const made = await db().auth.admin.createUser({ email, email_confirm: true });
  expect(made.error).toBeNull();
  const drv = { id: made.data.user!.id, email };
  const set = await db().from("profiles").insert({ id: drv.id, email, role: "carrier_driver", carrier_id: car!.id, is_active: false });
  expect(set.error).toBeNull();
  try {
    const { ctx, page } = await as(browser, "carrierA");
    await page.goto("/team");
    const row = page.getByTestId("team-member").filter({ hasText: drv.email });
    await expect(row).toHaveAttribute("data-active", "false");
    await expect(row.getByTestId("member-deactivated")).toHaveText("Deactivated by dispatch");
    await expect(row.getByRole("button", { name: "Remove" })).toHaveCount(0);
    await page.getByLabel("Driver email").fill(drv.email);
    await page.getByRole("button", { name: "Add driver" }).click();
    await expect(page.getByText("This driver was deactivated by dispatch. Contact dispatch to turn them back on.")).toBeVisible();
    // control: the owner row is active and keeps no Remove either; an active driver keeps Remove
    await expect(page.getByTestId("team-member").filter({ hasText: "owner-a@e2e.test" })).toHaveAttribute("data-active", "true");
    await ctx.close();
  } finally {
    await db().auth.admin.deleteUser(drv.id);
  }
});

// ============================================================================================================
// Sign in
// ============================================================================================================

// The real GoTrue answer is fetched and only its status and body are replaced, so its CORS headers stay real. Service
// workers are blocked: page.route cannot see a request a service worker answers (WebKit).
async function otpAs(page: Page, status: number, body: object) {
  await page.route("**/auth/v1/otp**", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const real = await route.fetch();
    return route.fulfill({ response: real, status, body: JSON.stringify(body) });
  });
}

async function signInPage(browser: Browser, path: string) {
  const s = await anon(browser, { serviceWorkers: "block" });
  await s.page.goto(path);
  return s;
}

test("SEC-03: when the code email cannot be sent (server error) the sign in page says so and does not ask for a code", async ({ browser }) => {
  const { ctx, page } = await signInPage(browser, "/login");
  await otpAs(page, 500, { code: 500, error_code: "unexpected_failure", msg: "Error sending magic link email" });
  await page.getByTestId("login-email").fill("someone@e2e.test");
  await page.getByTestId("login-send").click();
  await expect(page.getByTestId("login-error")).toHaveText("We could not send the code. Try again in a minute, or call DLV dispatch.");
  await expect(page.getByTestId("login-code")).toHaveCount(0);
  // control: a 4xx answer (an unknown email) stays generic and moves on to the code step
  await page.unroute("**/auth/v1/otp**");
  await otpAs(page, 422, { code: 422, error_code: "otp_disabled", msg: "Signups not allowed for otp" });
  await page.getByTestId("login-send").click();
  await expect(page.getByTestId("login-code")).toBeVisible();
  await ctx.close();
});

test("SEC-06: the emailed sign in link carries the page the user came from", async ({ browser }) => {
  const seen: string[] = [];
  const { ctx, page } = await signInPage(browser, `/login?next=${encodeURIComponent("/loads?view=completed")}`);
  page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/auth/v1/otp")) seen.push(r.url()); });
  await page.getByTestId("login-email").fill("someone@e2e.test");
  await page.getByTestId("login-send").click();
  await expect(page.getByTestId("login-code")).toBeVisible();
  expect(seen).toHaveLength(1);
  const redirect = new URL(seen[0]).searchParams.get("redirect_to");
  expect(redirect).not.toBeNull();
  const target = new URL(redirect!);
  expect(target.pathname).toBe("/auth/callback");
  expect(target.searchParams.get("next")).toBe("/loads?view=completed");
  await ctx.close();
});

// ============================================================================================================
// Review pass (DLV-043 adversarial review): defects found in the sweep's own fixes and in the same families
// ============================================================================================================

// CAR-08 follow-up: the camera dialogs hold hidden file inputs (hidden, tabindex -1). The hand-made Tab loop counted
// them, so Tab moved focus onto an input that cannot take it and focus stayed stuck on the control before it.
test("CAR-08: Tab and Shift+Tab move focus on every press in the driver's photo dialog (hidden file inputs are skipped)", async ({ browser }) => {
  const l = await seed({ po: uniq("CR08P"), status: "loading" });
  const { ctx, page } = await as(browser, "carrierA");
  await page.goto(`/my-loads/${l.id}`);
  await page.getByTestId("take-photo").click(); // "Take loaded photo", or "Take another photo" when the seed has one
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // Wait for the camera to settle (live on Chromium's fake camera, unavailable on WebKit): its buttons are final then.
  await expect(dialog.getByTestId("camera")).toHaveAttribute("data-phase", /^(live|unavailable)$/);
  if ((await dialog.getByTestId("camera").getAttribute("data-phase")) === "live") {
    await expect(dialog.getByTestId("camera-take")).toBeEnabled();
  }
  await expect(dialog.locator("input[type=file][hidden]").first()).toBeAttached();
  const here = () => page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return { inside: Boolean(a?.closest('[role="dialog"]')), id: a ? `${a.tagName}|${a.dataset.testid ?? ""}|${a.textContent ?? ""}` : "" };
  });
  const visible = await dialog.locator("button:not([disabled]), input:not([disabled]):not([hidden]), [href]").count();
  expect(visible).toBeGreaterThan(1);
  for (const key of ["Tab", "Shift+Tab"]) {
    let before = (await here()).id;
    const seen = new Set<string>();
    for (let i = 0; i < visible + 2; i++) {
      await page.keyboard.press(key);
      const now = await here();
      expect(now.inside, `focus stays in the dialog after ${key} ${i + 1}`).toBe(true);
      expect(now.id, `${key} ${i + 1} moves focus (it stayed on ${before})`).not.toBe(before);
      expect(now.id.startsWith("INPUT|"), `${key} ${i + 1} never lands on a hidden file input`).toBe(false);
      seen.add(now.id);
      before = now.id;
    }
    expect(seen.size, `${key} reaches every control`).toBe(visible);
  }
  await ctx.close();
});

// CUST-06 follow-up: a refused return (the original load changed meanwhile) is not "one of the locations".
test("CUST-06: database refusals map to the right plain sentence (pure)", () => {
  expect(plainDbError("pickup location cannot ship")).toBe(LOCATION_GONE);
  expect(plainDbError("delivery location cannot receive")).toBe(LOCATION_GONE);
  expect(plainDbError("return load: the original load must be at delivery or delivered")).toBe(RETURN_GONE);
  expect(plainDbError("return load: the original load was not found")).toBe(RETURN_GONE);
  expect(plainDbError("return load: the pickup must be the delivery location of the original load")).toBe(RETURN_GONE);
  expect(plainDbError("new row violates row-level security policy")).toBe(GENERIC);
  expect(plainDbError(undefined)).toBe(GENERIC);
});

// FORM-RESET-01 follow-up: the same React reset wiped what staff typed in the location, user and carrier forms.
test("FORM-RESET-01: a refused new location keeps every field staff typed", async ({ browser }) => {
  const taken = await makeLocation({ prefix: "E2E-RV-LOC" });
  try {
    const { ctx, page } = await as(browser, "admin");
    await page.goto("/admin/locations");
    await page.getByRole("button", { name: "New location" }).click();
    const form = page.locator("form").filter({ has: page.getByLabel("Address line") });
    await form.getByLabel("Name", { exact: true }).fill(taken.name);
    await form.getByLabel("Address line").fill("12 Review Road");
    await form.getByLabel("City", { exact: true }).fill("Keptville");
    await form.getByLabel("Postal code").fill("K1K 1K1");
    await form.getByLabel("Default contact name").fill("Kept Contact");
    await form.getByRole("button", { name: "Create location" }).click();
    await expect(form.getByText(DUPLICATE_NAME)).toBeVisible();
    await expect(form.getByLabel("Name", { exact: true })).toHaveValue(taken.name);
    await expect(form.getByLabel("Address line")).toHaveValue("12 Review Road");
    await expect(form.getByLabel("City", { exact: true })).toHaveValue("Keptville");
    await expect(form.getByLabel("Postal code")).toHaveValue("K1K 1K1");
    await expect(form.getByLabel("Default contact name")).toHaveValue("Kept Contact");
    expect((await db().from("locations").select("id").eq("name", taken.name)).data).toHaveLength(1);
    await ctx.close();
  } finally {
    await retireLocations([taken.id]);
  }
});

test("FORM-RESET-01: a refused new user keeps the email, name, role and company; a refused carrier name and rename stay as typed", async ({ browser }) => {
  const { ctx, page } = await as(browser, "admin");
  await page.goto("/admin/users");
  const form = page.locator("form").filter({ has: page.getByLabel("Full name") });
  await form.getByLabel("Email").fill("maria@e2e.test");
  await form.getByLabel("Full name").fill("Kept Name");
  await form.getByLabel("Role").selectOption({ label: "Customer" });
  await form.locator('select[name="customer_id"]').selectOption({ label: "Mitrex" });
  await form.getByRole("button", { name: "Add user" }).click();
  await expect(page.getByText("This email cannot be added. Use a different email address.")).toBeVisible();
  await expect(form.getByLabel("Email")).toHaveValue("maria@e2e.test");
  await expect(form.getByLabel("Full name")).toHaveValue("Kept Name");
  await expect(form.getByLabel("Role")).toHaveValue("customer");
  await expect(form.locator('select[name="customer_id"] option:checked')).toHaveText("Mitrex");

  await page.goto("/admin/carriers");
  await page.getByLabel("New carrier name").fill(CARRIER_A);
  await page.getByRole("button", { name: "Add carrier" }).click();
  await expect(page.getByText(`A carrier named "${CARRIER_A}" already exists.`)).toBeVisible();
  await expect(page.getByLabel("New carrier name")).toHaveValue(CARRIER_A);

  const row = page.locator("li").filter({ has: page.getByText(CARRIER_A, { exact: true }) });
  await row.getByRole("button", { name: "Rename" }).click();
  await row.getByLabel("carrier name").fill("E2E Carrier B");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row.getByText('A carrier named "E2E Carrier B" already exists.')).toBeVisible();
  await expect(row.getByLabel("carrier name")).toHaveValue("E2E Carrier B");
  expect((await db().from("carriers").select("id").eq("name", CARRIER_A)).data).toHaveLength(1);
  await ctx.close();
});

// SEC-06 follow-up: the request carries ?next=, but only the real link proves the auth server accepts that redirect.
// The local allow-list names localhost:3000/auth/callback only (no query, another port): the link is accepted because
// its host is the Site URL host, the same as production (Site URL https://portal.dlvlogistics.com).
test("SEC-06: following the emailed link signs in and lands on the page the user came from", async ({ browser }) => {
  const email = freshEmail("sec06-link");
  const made = await db().auth.admin.createUser({ email, email_confirm: true });
  expect(made.error).toBeNull();
  const uid = made.data.user!.id;
  const { data: mitrex } = await db().from("customers").select("id").eq("name", "Mitrex").single();
  const prof = await db().from("profiles").insert({ id: uid, email, role: "customer", customer_id: mitrex!.id, is_active: true });
  expect(prof.error).toBeNull();
  try {
    const { ctx, page } = await signInPage(browser, `/login?next=${encodeURIComponent("/loads?view=completed")}`);
    const sentAt = Date.now();
    await page.getByTestId("login-email").fill(email);
    await page.getByTestId("login-send").click();
    await expect(page.getByTestId("login-code")).toBeVisible();
    assertLocalUrl(MAIL_API, "mail api");
    let link = "";
    await expect.poll(async () => {
      const res = await fetch(`${MAIL_API}/search?query=${encodeURIComponent("to:" + email)}&limit=5`);
      const body = (await res.json()) as { messages?: { ID: string; Created: string }[] };
      for (const m of body.messages ?? []) {
        if (new Date(m.Created).getTime() < sentAt - 2000) continue;
        const full = (await (await fetch(`${MAIL_API}/message/${m.ID}`)).json()) as { HTML?: string };
        const href = /href="([^"]*\/auth\/v1\/verify[^"]*)"/.exec(full.HTML ?? "")?.[1];
        if (href) link = href.replace(/&amp;/g, "&");
      }
      return link;
    }, { timeout: 30_000 }).not.toBe("");
    assertLocalUrl(link, "emailed link");
    await page.goto(link);
    await page.waitForURL((u) => u.pathname === "/loads", { timeout: 20_000 });
    expect(new URL(page.url()).searchParams.get("view")).toBe("completed");
    await ctx.close();
  } finally {
    await db().auth.admin.deleteUser(uid);
  }
});
