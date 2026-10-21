import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { adminClient, anon, as, gotoSteady, isoDate, uniq, uniqIts, openMoreActions } from "./support/helpers";
import { makeLocation, retireLocations, type TestLocation } from "./support/book";
import { sentEmails, setMockStatus, type SentEmail } from "./support/mail-mock";
import { loginViaUi } from "./support/login";
import { CARRIER_A } from "./support/users";
import { BASE_URL } from "./support/env";
import {
  NOTHING_CHANGED, canStaffEdit, canStaffReturn, carrierDetailsMail, detailChanges, detailsNote, offersCarrierEmail,
  staffDeliveryOptions, staffLocationError, staffPickupOptions, type CarrierMailLoad, type DetailSnapshot,
} from "../src/lib/admin/staff-edit";
import { EMPTY_LOAD_FORM, validateLoad } from "../src/lib/customer/validate";
import { fmtSlot } from "../src/lib/format";
import type { Location } from "../src/lib/types";

// R44 Staff edit of a load (DLV-039): every detail at any status except cancelled, the "Details edited" timeline event
// (0020), the optional carrier email and its resend button, a staff created return, and the lane scenario edit.
// Staff screens run at 375px on both engines (webkit is an iPhone 13). Every database claim is read back through the
// service role, every email through the local mail mock.

test.describe.configure({ mode: "serial", timeout: 240_000 });

const db = () => adminClient();
const VIEWPORT = { width: 375, height: 812 };
const locations: string[] = [];
const parked: string[] = [];
const createdUsers: string[] = [];

let shipA: TestLocation; // can ship and receive
let shipB: TestLocation; // can ship and receive
let recvA: TestLocation; // can receive only
let recvB: TestLocation; // can receive only
let site: TestLocation; // a construction site: can receive, cannot ship (the reload site of a return)
let customerId = "";
let mariaId = "";
let adminId = "";
let carrierAId = "";

test.beforeAll(async () => {
  shipA = await makeLocation({ prefix: "E2E-SE-SHIPA", ship: true, receive: true, contactName: "ShipA Dflt", contactPhone: "416-555-2100" });
  shipB = await makeLocation({ prefix: "E2E-SE-SHIPB", ship: true, receive: true, contactName: "ShipB Dflt", contactPhone: "416-555-2200" });
  recvA = await makeLocation({ prefix: "E2E-SE-RCVA", ship: false, receive: true, contactName: "RcvA Dflt", contactPhone: "416-555-2300" });
  recvB = await makeLocation({ prefix: "E2E-SE-RCVB", ship: false, receive: true, contactName: "RcvB Dflt", contactPhone: "416-555-2400" });
  site = await makeLocation({ prefix: "E2E-SE-SITE", ship: false, receive: true, contactName: "Site Dflt", contactPhone: "416-555-2500" });
  locations.push(shipA.id, shipB.id, recvA.id, recvB.id, site.id);
  customerId = (await db().from("customers").select("id").eq("name", "Mitrex").single()).data!.id as string;
  mariaId = (await db().from("profiles").select("id").eq("email", "maria@e2e.test").single()).data!.id as string;
  adminId = (await db().from("profiles").select("id").eq("email", "admin@e2e.test").single()).data!.id as string;
  carrierAId = (await db().from("carriers").select("id").eq("name", CARRIER_A).single()).data!.id as string;
});

test.afterAll(async () => {
  await setMockStatus(200);
  if (parked.length) await db().from("loads").update({ status: "cancelled" }).in("id", parked).in("status", ["requested", "booked", "at_pickup", "loading", "enroute", "at_delivery"]);
  await retireLocations(locations);
  for (const id of createdUsers) await db().from("profiles").update({ is_active: false }).eq("id", id);
});

type Status = "requested" | "booked" | "enroute" | "at_delivery" | "delivered" | "cancelled";
type Seeded = { id: string; requestRef: string; its: string | null; label: string };

// Service role insert (no JWT: the database records no "Details edited" event for it, and allows any status).
async function seed(o: {
  po: string; status?: Status; customer?: string; pickup?: string; delivery?: string; day?: string; carrier?: string | null;
  notes?: string | null; weight?: number | null; pieces?: number | null; returnOf?: string;
}): Promise<Seeded> {
  const status = o.status ?? "booked";
  const day = o.day ?? isoDate(2);
  const its = status === "requested" ? null : uniqIts();
  const { data, error } = await db().from("loads").insert({
    // A load of ANOTHER customer is created_by the staff admin: one created_by Maria would be counted by the multi-truck
    // server cap test's top-up (service role) but not by the server (Maria's RLS), an off by one in its 10 minute window.
    customer_id: o.customer ?? customerId, created_by: o.customer && o.customer !== customerId ? adminId : mariaId,
    pickup_location_id: o.pickup ?? shipA.id, delivery_location_id: o.delivery ?? recvA.id,
    equipment_size: 53, moffett: false, weight_lbs: o.weight ?? 1200, pieces: o.pieces ?? 4, po_number: o.po, notes: o.notes ?? "Old note", status,
    pickup_timing: "appointment", pickup_date: day, pickup_time_start: "08:00",
    delivery_timing: "appointment", delivery_date: day, delivery_time_start: "14:00",
    pickup_contact_name: "Orig Pat", pickup_contact_phone: "416-555-0101",
    delivery_contact_name: "Orig Dee", delivery_contact_phone: "416-555-0102",
    its_load_number: its, carrier_id: o.carrier !== undefined ? o.carrier : status === "requested" ? null : carrierAId,
    return_of_load_id: o.returnOf ?? null,
    ...(status === "delivered" ? { delivered_at: new Date().toISOString() } : {}),
    ...(status === "cancelled" ? { cancelled_at: new Date().toISOString() } : {}),
  }).select("id,load_number,its_load_number").single();
  if (error) throw error;
  parked.push(data.id as string);
  const itsNo = (data.its_load_number as string | null) ?? null;
  return { id: data.id as string, requestRef: data.load_number as string, its: itsNo, label: itsNo ?? `Request ${data.load_number}` };
}

const row = async (id: string) => (await db().from("loads").select("*").eq("id", id).single()).data as Record<string, unknown>;
const edits = async (id: string) => ((await db().from("load_events").select("*").eq("load_id", id).like("note", "Details edited:%").order("id")).data ?? []) as
  { from_status: string; to_status: string; actor_id: string | null; note: string }[];

async function expectNoOverflow(page: Page, label: string) {
  const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(w.s, `${label}: scrollWidth ${w.s} within clientWidth ${w.c}`).toBeLessThanOrEqual(w.c);
}

async function expectTall(loc: Locator, label: string) {
  const b = await loc.first().boundingBox();
  expect(b, `${label} is rendered`).not.toBeNull();
  expect(b!.height, `${label} is at least 44px tall`).toBeGreaterThanOrEqual(44);
}

async function mailsSince(n: number): Promise<SentEmail[]> {
  return (await sentEmails()).slice(n);
}

async function makeCsr(): Promise<{ email: string; id: string }> {
  const email = `edit-csr-${Date.now().toString(36)}-${process.pid}@e2e.test`;
  const made = await db().auth.admin.createUser({ email, email_confirm: true });
  expect(made.error).toBeNull();
  const id = made.data.user!.id;
  createdUsers.push(id);
  const p = await db().from("profiles").insert({ id, email, full_name: "Edit CSR", role: "staff_csr", is_active: true });
  expect(p.error).toBeNull();
  return { email, id };
}

// The id of a server action, read from a real submit on this page (the request carries it in the Next-Action header).
function captureAction(page: Page, urlPart: string): () => string | null {
  let id: string | null = null;
  page.on("request", (r) => {
    const h = r.headers()["next-action"];
    if (r.method() === "POST" && h && r.url().includes(urlPart)) id = h;
  });
  return () => id;
}

async function forge(ctx: BrowserContext, url: string, actionId: string, args: unknown) {
  const res = await ctx.request.post(url, {
    headers: { "Next-Action": actionId, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component", Origin: BASE_URL },
    data: JSON.stringify(args), maxRedirects: 0,
  });
  return { status: res.status(), text: await res.text(), redirect: res.headers()["x-action-redirect"] ?? "" };
}

// Form values exactly as the staff edit form sends them for a stored row.
function valuesOf(r: Record<string, unknown>) {
  const hm = (t: unknown) => (t ? String(t).slice(0, 5) : "");
  return {
    ...EMPTY_LOAD_FORM,
    pickup_location_id: String(r.pickup_location_id), delivery_location_id: String(r.delivery_location_id),
    pickup_contact_name: String(r.pickup_contact_name), pickup_contact_phone: String(r.pickup_contact_phone),
    delivery_contact_name: String(r.delivery_contact_name), delivery_contact_phone: String(r.delivery_contact_phone),
    equipment_size: String(r.equipment_size), moffett: Boolean(r.moffett),
    pickup_timing: r.pickup_timing as "appointment", pickup_date: String(r.pickup_date), pickup_time_start: hm(r.pickup_time_start), pickup_time_end: hm(r.pickup_time_end),
    delivery_timing: r.delivery_timing as "appointment", delivery_date: String(r.delivery_date), delivery_time_start: hm(r.delivery_time_start), delivery_time_end: hm(r.delivery_time_end),
    weight_lbs: r.weight_lbs == null ? "" : String(r.weight_lbs), pieces: r.pieces == null ? "" : String(r.pieces),
    po_number: String(r.po_number ?? ""), notes: String(r.notes ?? ""),
  };
}

const loc = (id: string, o: Partial<Location> = {}): Location => ({
  id, name: id.toUpperCase(), address_line: "1 Road", city: "Town", province: "ON", postal_code: null,
  can_ship: true, can_receive: true, requires_moffett: false, default_contact_name: null, default_contact_phone: null,
  is_active: true, needs_review: false, notes: null, ...o,
});

test("pure helpers: editable statuses, staff location choices and rule, past dates, the change list and the carrier mail", () => {
  for (const s of ["requested", "booked", "at_pickup", "loading", "enroute", "at_delivery", "delivered"]) expect(canStaffEdit(s as never), s).toBe(true);
  expect(canStaffEdit("cancelled")).toBe(false);
  expect(["requested", "booked", "enroute", "cancelled"].map((s) => canStaffReturn(s as never))).toEqual([false, false, false, false]);
  expect([canStaffReturn("at_delivery"), canStaffReturn("delivered")]).toEqual([true, true]);
  expect(offersCarrierEmail({ status: "booked", carrier_id: "c" })).toBe(true);
  expect(offersCarrierEmail({ status: "delivered", carrier_id: "c" })).toBe(true);
  expect(offersCarrierEmail({ status: "requested", carrier_id: "c" })).toBe(false);
  expect(offersCarrierEmail({ status: "booked", carrier_id: null })).toBe(false);
  expect(offersCarrierEmail({ status: "cancelled", carrier_id: "c" })).toBe(false);

  // Past dates: refused for the customer, allowed for staff; the other date and time rules stay for both.
  const v = { ...EMPTY_LOAD_FORM, pickup_location_id: "a", delivery_location_id: "b", pickup_contact_name: "P", pickup_contact_phone: "1",
    delivery_contact_name: "D", delivery_contact_phone: "2", equipment_size: "53", pickup_date: "2026-01-05", pickup_time_start: "08:00",
    delivery_date: "2026-01-05", delivery_time_start: "14:00" };
  expect(validateLoad(v, "2026-06-01").pickup_date).toBe("Pickup date cannot be in the past (Eastern time).");
  expect(validateLoad(v, "2026-06-01", { allowPast: true })).toEqual({});
  expect(validateLoad({ ...v, delivery_date: "2026-01-04" }, "2026-06-01", { allowPast: true }).delivery_date).toBe("Delivery date cannot be before the pickup date.");
  expect(validateLoad({ ...v, pickup_timing: "window", pickup_time_end: "07:00" }, "2026-06-01", { allowPast: true }).pickup_time_end).toBe("Pickup window end must be after the start.");

  // Choices: qualifying active locations, the current ones even when they no longer qualify, the return extras.
  const all = [loc("ship"), loc("rcv", { can_ship: false }), loc("gone", { is_active: false }), loc("site", { can_ship: false }),
    loc("shipper", { can_receive: false }), loc("noship", { can_ship: false, can_receive: false })];
  expect(staffPickupOptions(all, "gone").map((o) => o.label)).toEqual(["SHIP (Town)", "GONE (Town) (current)", "SHIPPER (Town)"]);
  expect(staffPickupOptions(all, "ship", "site").map((o) => o.id)).toEqual(["ship", "site", "shipper"]);
  expect(staffDeliveryOptions(all, "noship").map((o) => o.label)).toEqual(["SHIP (Town)", "RCV (Town)", "SITE (Town)", "NOSHIP (Town) (current)"]);
  expect(staffDeliveryOptions(all, "rcv", "shipper").map((o) => o.label)).toEqual(["SHIPPER (original shipper)", "SHIP (Town)", "RCV (Town)", "SITE (Town)"]);

  // The rule: unchanged locations are never checked; a change needs both to qualify; the return rule for a return.
  const L = Object.fromEntries(all.map((l) => [l.id, l]));
  const cur = { pickup_location_id: "gone", delivery_location_id: "rcv" };
  expect(staffLocationError({ pickup_location_id: "gone", delivery_location_id: "rcv" }, cur, null, L.gone, L.rcv)).toBeNull();
  expect(staffLocationError({ pickup_location_id: "gone", delivery_location_id: "site" }, cur, null, L.gone, L.site)?.message).toMatch(/can no longer be a pickup/);
  expect(staffLocationError({ pickup_location_id: "ship", delivery_location_id: "site" }, cur, null, L.ship, L.site)).toBeNull();
  expect(staffLocationError({ pickup_location_id: "rcv", delivery_location_id: "site" }, cur, null, L.rcv, L.site)?.message).toBe("This location cannot ship.");
  expect(staffLocationError({ pickup_location_id: "ship", delivery_location_id: "shipper" }, cur, null, L.ship, L.shipper)?.message).toBe("This location cannot receive.");
  const orig = { pickup_location_id: "shipper", delivery_location_id: "site" };
  expect(staffLocationError({ pickup_location_id: "site", delivery_location_id: "shipper" }, { pickup_location_id: "site", delivery_location_id: "rcv" }, orig, L.site, L.shipper)).toBeNull();
  expect(staffLocationError({ pickup_location_id: "site", delivery_location_id: "noship" }, { pickup_location_id: "site", delivery_location_id: "rcv" }, orig, L.site, L.noship)?.field).toBe("delivery_location_id");

  // The change list (same text as the database note) and the carrier mail.
  const a: DetailSnapshot = {
    pickupName: "Mitrex", deliveryName: "Howden", pickup_contact_name: "P", pickup_contact_phone: "1", delivery_contact_name: "D", delivery_contact_phone: "2",
    pickup_timing: "appointment", pickup_date: "2031-05-05", pickup_time_start: "08:00:00", pickup_time_end: null,
    delivery_timing: "appointment", delivery_date: "2031-05-05", delivery_time_start: "14:00:00", delivery_time_end: null,
    equipment_size: 53, moffett: false, weight_lbs: 1200, pieces: 4, po_number: "PO-OLD", notes: "Old note",
  };
  expect(detailChanges(a, { ...a, pickup_time_start: "08:00" })).toEqual([]);
  const b: DetailSnapshot = { ...a, deliveryName: "1HAM", moffett: true, pickup_timing: "window", pickup_time_start: "07:00", pickup_time_end: "09:00", weight_lbs: "1200.5", pieces: null, notes: "Line one\nLine two" };
  expect(detailChanges(a, b)).toEqual([
    "Pickup time: Mon, May 5, 2031, 8:00 AM ET (appointment) to Mon, May 5, 2031, 7:00 AM to 9:00 AM ET (window)",
    "Delivery: Howden to 1HAM", "Moffett: No to Yes", "Weight: 1,200 lbs to 1,200.5 lbs", "Pieces: 4 to Not given",
    "Notes: Old note to Line one Line two",
  ]);
  expect(detailsNote(["Pieces: 1 to 2"])).toBe("Details edited: Pieces: 1 to 2");
  expect(detailsNote(["x".repeat(2000)])).toHaveLength(1000);
  const place = { name: "Mitrex", address_line: "1 Road", city: "Toronto", province: "ON", postal_code: "M1M 1M1" };
  const m: CarrierMailLoad = { ...b, id: "L1", load_number: "MTX-0001", its_load_number: "313", pickup: place, delivery: { ...place, name: "1HAM" } };
  const upd = carrierDetailsMail(m, ["Delivery: Howden to 1HAM"], "https://x.test/");
  expect(upd.subject).toBe("Load 313 updated");
  expect(upd.body).toContain("WHAT CHANGED\n- Delivery: Howden to 1HAM\n");
  expect(upd.body).toContain("Open the load: https://x.test/my-loads/L1");
  const again = carrierDetailsMail({ ...m, its_load_number: null }, null, "https://x.test");
  expect(again.subject).toBe("Load MTX-0001 details");
  expect(again.body).not.toContain("WHAT CHANGED");
  expect(NOTHING_CHANGED).toMatch(/Nothing was changed/);
});

test("staff edit a booked load with a carrier: shipper, receiver, dates, size and contact; database, timeline note, Maria and the carrier see it; no email unless ticked", async ({ browser }) => {
  const po = uniq("SE-EDIT");
  const l = await seed({ po, status: "booked" });
  const before = (await sentEmails()).length;
  const { ctx, page } = await as(browser, "admin", VIEWPORT);
  await gotoSteady(page, `/admin/loads/${l.id}`);
  const editBtn = page.getByRole("link", { name: "Edit details" });
  await expectTall(editBtn, "Edit details");
  await expect(page.getByRole("link", { name: "Create return" })).toHaveCount(0); // booked: no return yet
  await editBtn.click();
  await expect(page).toHaveURL(new RegExp(`/admin/loads/${l.id}/edit$`));
  await expect(page.locator("h1")).toHaveText(`Edit ${l.its}`);
  await expect(page.getByLabel("Pickup location")).toHaveValue(shipA.id);
  await expect(page.getByLabel("Delivery location")).toHaveValue(recvA.id);
  await expect(page.getByLabel("PO number (optional)")).toHaveValue(po);
  await expect(page.getByText("Save as default for this location")).toHaveCount(0);
  const box = page.getByRole("checkbox", { name: "Email the updated details to the carrier" });
  await expect(box).toBeVisible();
  await expect(box, "default unchecked").not.toBeChecked();
  await expectNoOverflow(page, "/admin/loads/[id]/edit");

  // Nothing changed: refused, nothing written.
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(NOTHING_CHANGED)).toBeVisible();
  expect(await edits(l.id)).toHaveLength(0);

  await page.getByLabel("Pickup location").selectOption({ label: shipB.label });
  await page.getByLabel("Delivery location").selectOption({ label: recvB.label });
  await page.getByLabel("Contact name").nth(1).fill("New Receiver");
  await page.getByLabel("Contact phone").nth(1).fill("905-555-7000");
  await page.getByRole("radiogroup", { name: "Pickup timing" }).getByRole("radio", { name: "Time window" }).click();
  await page.getByLabel("Pickup date").fill(isoDate(5));
  await page.getByLabel("Window from (ET)").fill("07:00");
  await page.getByLabel("Window to (ET)").fill("09:00");
  await page.getByLabel("Delivery date").fill(isoDate(6));
  await page.getByLabel("Appointment time (ET)").fill("13:30");
  await page.getByRole("radiogroup", { name: "Equipment size" }).getByRole("radio", { name: /26/ }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(new RegExp(`/admin/loads/${l.id}\\?saved=1$`));
  await expect(page.getByTestId("saved-notice")).toHaveText("Saved.");

  const r = await row(l.id);
  expect([r.pickup_location_id, r.delivery_location_id, r.delivery_contact_name, r.delivery_contact_phone, r.equipment_size])
    .toEqual([shipB.id, recvB.id, "New Receiver", "905-555-7000", 26]);
  expect([r.pickup_timing, r.pickup_date, String(r.pickup_time_start).slice(0, 5), String(r.pickup_time_end).slice(0, 5)]).toEqual(["window", isoDate(5), "07:00", "09:00"]);
  expect([r.delivery_timing, r.delivery_date, String(r.delivery_time_start).slice(0, 5), r.delivery_time_end]).toEqual(["appointment", isoDate(6), "13:30", null]);
  expect([r.status, r.carrier_id, r.its_load_number, r.customer_id, r.load_number]).toEqual(["booked", carrierAId, l.its, customerId, l.requestRef]);

  // ONE timeline event, written by the database, the same text as the app's change list.
  const ev = await edits(l.id);
  expect(ev).toHaveLength(1);
  expect([ev[0].from_status, ev[0].to_status, ev[0].actor_id]).toEqual(["booked", "booked", adminId]);
  const day = isoDate(2);
  const expected = [
    `Pickup: ${shipA.name} to ${shipB.name}`,
    "Pickup contact: Orig Pat, 416-555-0101 to ShipB Dflt, 416-555-2200", // a new place brings its saved contact
    `Pickup time: ${fmtSlot("appointment", day, "08:00", null)} to ${fmtSlot("window", isoDate(5), "07:00", "09:00")}`,
    `Delivery: ${recvA.name} to ${recvB.name}`,
    "Delivery contact: Orig Dee, 416-555-0102 to New Receiver, 905-555-7000",
    `Delivery time: ${fmtSlot("appointment", day, "14:00", null)} to ${fmtSlot("appointment", isoDate(6), "13:30", null)}`,
    "Equipment size: 53 ft to 26 ft",
  ];
  expect(ev[0].note).toBe(`Details edited: ${expected.join("; ")}`);
  await expect(page.locator("main")).toContainText(ev[0].note);
  await expect(page.locator("main")).toContainText(recvB.name);
  await expectNoOverflow(page, "/admin/loads/[id] after the edit");

  // Not ticked: no carrier email; never an email to Maria.
  const mails = await mailsSince(before);
  expect(mails.filter((m) => m.subject.startsWith(`Load ${l.its}`)), "no carrier email").toHaveLength(0);
  expect(mails.filter((m) => m.to.includes("maria@e2e.test")), "no email to Maria").toHaveLength(0);
  await ctx.close();

  // Maria sees the new values and the event in her timeline; the carrier sees the new details.
  const maria = await as(browser, "maria", VIEWPORT);
  await gotoSteady(maria.page, `/loads/${l.id}`);
  await expect(maria.page.locator("main")).toContainText(recvB.name);
  await expect(maria.page.locator("main")).toContainText(shipB.name);
  await expect(maria.page.locator("main")).toContainText("New Receiver");
  await expect(maria.page.locator("main")).toContainText(ev[0].note);
  await maria.ctx.close();
  const car = await as(browser, "carrierA", VIEWPORT);
  await gotoSteady(car.page, `/my-loads/${l.id}`);
  await expect(car.page.locator("main")).toContainText(recvB.name);
  await expect(car.page.locator("main")).toContainText(shipB.name);
  await expect(car.page.locator("main")).toContainText("Call New Receiver");
  await expect(car.page.locator("main")).toContainText("26");
  await car.ctx.close();
});

test("the carrier email: ticked sends ONE email with What changed and the full details (no lane number), the resend button (also on a delivered load), a mail failure still saves", async ({ browser }) => {
  const po = uniq("SE-MAIL");
  const l = await seed({ po, status: "booked", notes: "Gate 4" });
  // A lane reference for the load's scenario: its number must never reach the carrier.
  const laneNo = String(Date.now()).slice(-9);
  const lane = await db().from("lane_references").insert({ pickup_location_id: shipA.id, delivery_location_id: recvA.id, equipment_size: 53, its_reference_load: laneNo }).select("id").single();
  expect(lane.error).toBeNull();
  const ownerEmails = ((await db().from("profiles").select("email").eq("carrier_id", carrierAId).eq("is_active", true)).data ?? []).map((p) => p.email as string);
  expect(ownerEmails.length, "guard: carrier A has active users").toBeGreaterThan(0);
  try {
    const { ctx, page } = await as(browser, "admin", VIEWPORT);
    let before = (await sentEmails()).length;
    await gotoSteady(page, `/admin/loads/${l.id}/edit`);
    await page.getByLabel("PO number (optional)").fill(`${po}-B`);
    await page.getByLabel("Notes (optional)").fill("Gate 7, call ahead");
    await page.getByRole("checkbox", { name: "Email the updated details to the carrier" }).check();
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForURL(new RegExp(`/admin/loads/${l.id}\\?saved=emailed$`));
    await expect(page.getByTestId("saved-notice")).toHaveText("Saved. The carrier was emailed.");
    await expect.poll(async () => (await mailsSince(before)).filter((m) => m.subject === `Load ${l.its} updated`).length).toBe(1);
    const mails = await mailsSince(before);
    expect(mails, "exactly one email for the edit").toHaveLength(1);
    const mail = mails[0];
    expect(mail.to.slice().sort()).toEqual(ownerEmails.slice().sort());
    const text = mail.text ?? "";
    const ev = await edits(l.id);
    expect(ev).toHaveLength(1);
    const changed = [`PO number: ${po} to ${po}-B`, "Notes: Gate 4 to Gate 7, call ahead"];
    expect(ev[0].note).toBe(`Details edited: ${changed.join("; ")}`);
    expect(text).toContain(`WHAT CHANGED\n${changed.map((c) => `- ${c}`).join("\n")}\n`);
    for (const want of [
      "PICKUP", `${shipA.name}, 1 Spec Road, Testville, ON A1A 1A1`, fmtSlot("appointment", isoDate(2), "08:00", null), "Contact: Orig Pat, 416-555-0101",
      "DELIVERY", `${recvA.name}, 1 Spec Road, Testville, ON A1A 1A1`, fmtSlot("appointment", isoDate(2), "14:00", null), "Contact: Orig Dee, 416-555-0102",
      "Equipment: 53 ft", "Moffett: No", `PO number: ${po}-B`, "Notes: Gate 7, call ahead", `/my-loads/${l.id}`,
    ]) expect(text, `the email contains ${want}`).toContain(want);
    expect(text.includes(laneNo), "the lane reference number is never in a carrier email").toBe(false);
    expect(mail.to.includes("maria@e2e.test")).toBe(false);

    // The resend button: the same email without What changed.
    await gotoSteady(page, `/admin/loads/${l.id}`);
    const resend = page.getByTestId("resend-carrier").getByRole("button", { name: "Email the details to the carrier again" });
    await expectTall(resend, "Email the details to the carrier again");
    before = (await sentEmails()).length;
    await resend.click();
    await expect(page.getByTestId("resend-carrier")).toContainText(`Details emailed to ${ownerEmails.length} carrier user`);
    const again = await mailsSince(before);
    expect(again.map((m) => m.subject)).toEqual([`Load ${l.its} details`]);
    expect(again[0].text).not.toContain("WHAT CHANGED");
    expect(again[0].text).toContain(`PO number: ${po}-B`);
    expect((again[0].text ?? "").includes(laneNo)).toBe(false);
    expect(await edits(l.id), "a resend writes no event").toHaveLength(1);

    // The mail service fails: the save still happens and the page says so; the resend says so too.
    await setMockStatus(500);
    await gotoSteady(page, `/admin/loads/${l.id}/edit`);
    await page.getByLabel("Pieces (optional)").fill("9");
    await page.getByRole("checkbox", { name: "Email the updated details to the carrier" }).check();
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForURL(new RegExp(`/admin/loads/${l.id}\\?saved=mail_failed$`));
    await expect(page.getByTestId("saved-notice")).toHaveText("Saved. The carrier email could not be sent.");
    expect((await row(l.id)).pieces).toBe(9);
    await page.getByTestId("resend-carrier").getByRole("button", { name: "Email the details to the carrier again" }).click();
    await expect(page.getByTestId("resend-carrier")).toContainText("The carrier email could not be sent.");
    await setMockStatus(200);

    // A requested load without a carrier: no checkbox, no resend button.
    const req = await seed({ po: uniq("SE-REQ"), status: "requested" });
    await gotoSteady(page, `/admin/loads/${req.id}`);
    await expect(page.getByTestId("resend-carrier")).toHaveCount(0);
    await gotoSteady(page, `/admin/loads/${req.id}/edit`);
    await expect(page.locator("h1")).toHaveText(`Edit Request ${req.requestRef}`);
    await expect(page.getByRole("checkbox", { name: "Email the updated details to the carrier" })).toHaveCount(0);

    // A delivered load (its carrier controls are gone) still has the resend button, in a Carrier and booking card.
    const done = await seed({ po: uniq("SE-DLV"), status: "delivered" });
    await gotoSteady(page, `/admin/loads/${done.id}`);
    await expect(page.getByRole("button", { name: "Save carrier" })).toHaveCount(0);
    const resendDone = page.getByTestId("resend-carrier").getByRole("button", { name: "Email the details to the carrier again" });
    await expectTall(resendDone, "Email the details to the carrier again (delivered load)");
    await expectNoOverflow(page, "/admin/loads/[delivered]");
    before = (await sentEmails()).length;
    await resendDone.click();
    await expect(page.getByTestId("resend-carrier")).toContainText(`Details emailed to ${ownerEmails.length} carrier user`);
    const doneMails = await mailsSince(before);
    expect(doneMails.map((m) => m.subject)).toEqual([`Load ${done.its} details`]);
    expect(doneMails[0].to.slice().sort()).toEqual(ownerEmails.slice().sort());
    await ctx.close();
  } finally {
    await setMockStatus(200);
    await db().from("lane_references").delete().eq("id", lane.data!.id);
  }
});

test("staff_csr has the same rights: edits a delivered load with a past date; delivery before pickup and a window ending before it starts are still refused", async ({ browser }) => {
  const csr = await makeCsr();
  const l = await seed({ po: uniq("SE-CSR"), status: "delivered", day: isoDate(-3) });
  const { ctx, page } = await anon(browser);
  await page.setViewportSize(VIEWPORT);
  await loginViaUi(page, csr.email);
  await gotoSteady(page, `/admin/loads/${l.id}`);
  await expect(page.getByRole("link", { name: "Create return" })).toBeVisible();
  await page.getByRole("link", { name: "Edit details" }).click();
  await expect(page.locator("h1")).toHaveText(`Edit ${l.its}`);
  await expect(page.getByRole("checkbox", { name: "Email the updated details to the carrier" })).not.toBeChecked();
  // Refusals first (nothing written).
  await page.getByLabel("Delivery date").fill(isoDate(-5));
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Delivery date cannot be before the pickup date.")).toBeVisible();
  await page.getByLabel("Delivery date").fill(isoDate(-3));
  await page.getByRole("radiogroup", { name: "Pickup timing" }).getByRole("radio", { name: "Time window" }).click();
  await page.getByLabel("Window from (ET)").fill("10:00");
  await page.getByLabel("Window to (ET)").fill("09:00");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Pickup window end must be after the start.")).toBeVisible();
  expect(await edits(l.id)).toHaveLength(0);
  // A past date is fine for staff.
  await page.getByRole("radiogroup", { name: "Pickup timing" }).getByRole("radio", { name: "Appointment" }).click();
  await page.getByLabel("Pickup date").fill(isoDate(-4));
  await page.getByLabel("Appointment time (ET)").nth(0).fill("06:15");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(new RegExp(`/admin/loads/${l.id}\\?saved=1$`));
  const r = await row(l.id);
  expect([r.pickup_date, String(r.pickup_time_start).slice(0, 5), r.status]).toEqual([isoDate(-4), "06:15", "delivered"]);
  const ev = await edits(l.id);
  expect(ev).toHaveLength(1);
  expect([ev[0].from_status, ev[0].to_status, ev[0].actor_id]).toEqual(["delivered", "delivered", csr.id]);
  expect(ev[0].note).toBe(`Details edited: Pickup time: ${fmtSlot("appointment", isoDate(-3), "08:00", null)} to ${fmtSlot("appointment", isoDate(-4), "06:15", null)}`);
  await ctx.close();
});

test("a customer and a carrier cannot reach the edit or return route, signed out goes to login, and the staff actions (edit, return, resend) refuse them", async ({ browser }) => {
  const l = await seed({ po: uniq("SE-DENY"), status: "delivered" });
  // The action ids, read from real staff submits (one edit is saved here).
  const staff = await as(browser, "admin", VIEWPORT);
  const editId = captureAction(staff.page, `/admin/loads/${l.id}/edit`);
  await gotoSteady(staff.page, `/admin/loads/${l.id}/edit`);
  await staff.page.getByLabel("Pieces (optional)").fill("5");
  await staff.page.getByRole("button", { name: "Save changes" }).click();
  await staff.page.waitForURL(new RegExp(`\\?saved=1$`));
  expect(editId(), "the edit form sent a server action request").not.toBeNull();
  const retId = captureAction(staff.page, `/admin/loads/${l.id}/return`);
  await gotoSteady(staff.page, `/admin/loads/${l.id}/return`);
  await staff.page.getByRole("button", { name: "Create return" }).click(); // dates missing: refused in the browser
  await expect(staff.page.getByText("Pickup date is required.")).toBeVisible();
  // Submit a real one to read the id, then park it.
  await staff.page.getByLabel("Pickup date").fill(isoDate(4));
  await staff.page.getByLabel("Delivery date").fill(isoDate(4));
  await staff.page.getByLabel("Appointment time (ET)").nth(0).fill("07:30");
  await staff.page.getByLabel("Appointment time (ET)").nth(1).fill("12:00");
  await staff.page.getByRole("button", { name: "Create return" }).click();
  await staff.page.waitForURL(/\/admin\/loads\/[0-9a-f-]{36}\?saved=return$/);
  expect(retId(), "the return form sent a server action request").not.toBeNull();
  const made = ((await db().from("loads").select("id").eq("return_of_load_id", l.id)).data ?? []).map((x) => x.id as string);
  parked.push(...made);
  // The resend button posts a form (multipart): keep the real request, headers and body, to replay it as others.
  let resendReq: { headers: Record<string, string>; body: Buffer } | null = null;
  staff.page.on("request", (r) => {
    const h = r.headers();
    if (r.method() === "POST" && h["next-action"] && r.url().includes(`/admin/loads/${l.id}`) && !r.url().includes("/edit") && !r.url().includes("/return")) {
      resendReq = { headers: { "Next-Action": h["next-action"], "Content-Type": h["content-type"], Accept: "text/x-component", Origin: BASE_URL }, body: r.postDataBuffer()! };
    }
  });
  await gotoSteady(staff.page, `/admin/loads/${l.id}`);
  await staff.page.getByTestId("resend-carrier").getByRole("button", { name: "Email the details to the carrier again" }).click();
  await expect(staff.page.getByTestId("resend-carrier")).toContainText("Details emailed to");
  expect(resendReq, "the resend button sent a server action request").not.toBeNull();
  await staff.ctx.close();
  const detailsMails = async () => (await sentEmails()).filter((m) => m.subject === `Load ${l.its} details`).length;
  const mailsAtStart = await detailsMails();
  expect(mailsAtStart, "control: the staff resend sent one email").toBe(1);

  const snapshot = async () => ({ load: await row(l.id), events: (await edits(l.id)).length, returns: ((await db().from("loads").select("id").eq("return_of_load_id", l.id)).data ?? []).length });
  const start = await snapshot();
  const forgedValues = { ...valuesOf(start.load), po_number: "FORGED", notes: "forged" };
  for (const who of ["maria", "carrierA"] as const) {
    const { ctx, page } = await as(browser, who, VIEWPORT);
    for (const path of [`/admin/loads/${l.id}/edit`, `/admin/loads/${l.id}/return`]) {
      const res = await page.goto(path);
      const body = await page.content();
      expect(res?.status(), `${who} ${path}: not found (404)`).toBe(404);
      expect(body.includes(l.its!), `${who} ${path}: the page leaks nothing`).toBe(false);
    }
    const home = who === "maria" ? "/loads" : "/my-loads";
    const e = await forge(ctx, `/admin/loads/${l.id}/edit`, editId()!, [l.id, forgedValues, true]);
    expect(e.redirect, `${who}: the edit action redirects home before anything is read`).toMatch(new RegExp(`^${home}(;|$)`));
    const r = await forge(ctx, `/admin/loads/${l.id}/return`, retId()!, [l.id, forgedValues]);
    expect(r.redirect, `${who}: the return action redirects home`).toMatch(new RegExp(`^${home}(;|$)`));
    const rr = resendReq as unknown as { headers: Record<string, string>; body: Buffer };
    const res = await ctx.request.post(`/admin/loads/${l.id}`, { headers: rr.headers, data: rr.body, maxRedirects: 0 });
    expect(res.headers()["x-action-redirect"] ?? "", `${who}: the resend action redirects home`).toMatch(new RegExp(`^${home}(;|$)`));
    await ctx.close();
  }
  const end = await snapshot();
  expect(end.load.po_number).toBe(start.load.po_number);
  expect([end.events, end.returns]).toEqual([start.events, start.returns]);
  expect(await detailsMails(), "no carrier email was sent by a customer or a carrier").toBe(mailsAtStart);

  const out = await anon(browser);
  await out.page.goto(`/admin/loads/${l.id}/edit`);
  await expect(out.page).toHaveURL(/\/login/);
  await out.ctx.close();
});

test("a cancelled load has no Edit details button, its edit route goes back to the load, and a forged edit is refused", async ({ browser }) => {
  const live = await seed({ po: uniq("SE-LIVE"), status: "booked" });
  const cxl = await seed({ po: uniq("SE-CXL"), status: "cancelled" });
  const { ctx, page } = await as(browser, "admin", VIEWPORT);
  const editId = captureAction(page, `/admin/loads/${live.id}/edit`);
  await gotoSteady(page, `/admin/loads/${live.id}/edit`);
  await page.getByLabel("Pieces (optional)").fill("6");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(/\?saved=1$/);
  await gotoSteady(page, `/admin/loads/${cxl.id}`);
  await openMoreActions(page); // R46: Override status sits under More actions
  await expect(page.getByRole("heading", { name: "Override status" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit details" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Create return" })).toHaveCount(0);
  await gotoSteady(page, `/admin/loads/${cxl.id}/edit`);
  await expect(page).toHaveURL(new RegExp(`/admin/loads/${cxl.id}$`));
  const before = await row(cxl.id);
  const res = await forge(ctx, `/admin/loads/${cxl.id}/edit`, editId()!, [cxl.id, { ...valuesOf(before), notes: "forged on a cancelled load" }, false]);
  expect(res.redirect).toBe("");
  expect(res.text).toContain("A cancelled load cannot be edited.");
  expect((await row(cxl.id)).notes).toBe(before.notes);
  expect(await edits(cxl.id)).toHaveLength(0);
  // The server checks the locations again: a pickup that cannot ship, on the live load.
  const r2 = await forge(ctx, `/admin/loads/${live.id}/edit`, editId()!, [live.id, { ...valuesOf(await row(live.id)), pickup_location_id: recvB.id }, false]);
  expect(r2.text).toContain("This location cannot ship.");
  expect((await row(live.id)).pickup_location_id).toBe(shipA.id);
  await ctx.close();
});

test("staff return: Create return on at delivery and delivered loads, the prefilled staff form, a requested load for the ORIGINAL customer created by staff, linked, no request email, Use the same carrier", async ({ browser }) => {
  const other = await db().from("customers").insert({ name: uniq("E2E-SE-CUST") }).select("id").single();
  expect(other.error).toBeNull();
  const otherId = other.data!.id as string;
  const atDel = await seed({ po: uniq("SE-RT-AD"), status: "at_delivery", pickup: shipA.id, delivery: site.id });
  const orig = await seed({ po: uniq("SE-RT"), status: "delivered", customer: otherId, pickup: shipA.id, delivery: site.id, notes: "Truck 1 of 2\nFrames" });
  const { ctx, page } = await as(browser, "admin", VIEWPORT);
  await gotoSteady(page, `/admin/loads/${atDel.id}`);
  await expect(page.getByRole("link", { name: "Create return" })).toHaveAttribute("href", `/admin/loads/${atDel.id}/return`);
  await gotoSteady(page, `/admin/loads/${orig.id}`);
  const btn = page.getByRole("link", { name: "Create return" });
  await expectTall(btn, "Create return");
  await btn.click();
  await expect(page).toHaveURL(new RegExp(`/admin/loads/${orig.id}/return$`));
  await expect(page.locator("h1")).toHaveText("Create a return");
  await expect(page.getByTestId("return-notice")).toHaveText(`Return of ${orig.its}. The truck reloads at ${site.name}. Choose where it goes and the new dates.`);
  await expect(page.getByTestId("return-pickup")).toContainText(site.name);
  const del = page.getByLabel("Delivery location");
  await expect(del).toHaveValue(shipA.id);
  expect((await del.locator("option").allTextContents())[1]).toBe(`${shipA.name} (original shipper)`);
  await expect(page.getByLabel("Contact name").nth(0)).toHaveValue("Orig Dee");
  await expect(page.getByLabel("Contact name").nth(1)).toHaveValue("Orig Pat");
  await expect(page.getByLabel("Notes (optional)")).toHaveValue("Frames");
  await expect(page.getByLabel("How many trucks?")).toHaveCount(0);
  await expect(page.getByText("Save as default for this location")).toHaveCount(0);
  await expectNoOverflow(page, "/admin/loads/[id]/return");
  await page.getByLabel("Pickup date").fill(isoDate(3));
  await page.getByLabel("Delivery date").fill(isoDate(3));
  await page.getByLabel("Appointment time (ET)").nth(0).fill("07:30");
  await page.getByLabel("Appointment time (ET)").nth(1).fill("12:00");
  const before = (await sentEmails()).length;
  await page.getByRole("button", { name: "Create return" }).click();
  await page.waitForURL(/\/admin\/loads\/[0-9a-f-]{36}\?saved=return$/);
  const newId = new URL(page.url()).pathname.split("/").pop()!;
  parked.push(newId);
  const n = await row(newId);
  expect([n.return_of_load_id, n.customer_id, n.created_by, n.status, n.carrier_id, n.its_load_number])
    .toEqual([orig.id, otherId, adminId, "requested", null, null]);
  expect([n.pickup_location_id, n.delivery_location_id, n.notes, n.pickup_date]).toEqual([site.id, shipA.id, "Frames", isoDate(3)]);
  await expect(page.getByTestId("saved-notice")).toContainText("Return created.");
  await expect(page.getByTestId("return-badge")).toHaveText("Return");
  await expect(page.getByTestId("return-of")).toHaveText(`Return of ${orig.its}`);
  // No staff request email for a staff created load.
  await page.waitForTimeout(1500);
  expect((await mailsSince(before)).filter((m) => m.subject.includes("requested")), "no request email").toHaveLength(0);
  // "Use the same carrier" of R43 applies.
  await expect(page.getByTestId("original-carrier")).toContainText(`Original carrier: ${CARRIER_A}`);
  await page.getByRole("button", { name: "Use the same carrier" }).click();
  await expect.poll(async () => (await row(newId)).carrier_id).toBe(carrierAId);
  await expectNoOverflow(page, "/admin/loads/[new return]");
  // A booked load has no Create return, and its return route goes back to the load.
  const booked = await seed({ po: uniq("SE-RT-BK"), status: "booked" });
  await gotoSteady(page, `/admin/loads/${booked.id}/return`);
  await expect(page).toHaveURL(new RegExp(`/admin/loads/${booked.id}$`));
  await expect(page.getByRole("link", { name: "Create return" })).toHaveCount(0);
  await ctx.close();
});

async function laneOf(id: string) {
  return (await db().from("lane_references").select("pickup_location_id,delivery_location_id,equipment_size,its_reference_load,note").eq("id", id).single()).data!;
}

test("lanes: the inline edit changes the scenario (pickup, delivery, size), a duplicate scenario is refused, the server validates again", async ({ browser }) => {
  const a = await makeLocation({ prefix: "E2E-SE-LA" }), b = await makeLocation({ prefix: "E2E-SE-LB" }), c = await makeLocation({ prefix: "E2E-SE-LC" });
  locations.push(a.id, b.id, c.id);
  const ins = await db().from("lane_references").insert([
    { pickup_location_id: a.id, delivery_location_id: b.id, equipment_size: 26, its_reference_load: "7101" },
    { pickup_location_id: a.id, delivery_location_id: c.id, equipment_size: 53, its_reference_load: "7102" },
  ]).select("id,its_reference_load");
  expect(ins.error).toBeNull();
  const one = ins.data!.find((r) => r.its_reference_load === "7101")!.id as string;
  const two = ins.data!.find((r) => r.its_reference_load === "7102")!.id as string;
  const { ctx, page } = await as(browser, "admin", VIEWPORT);
  try {
    await gotoSteady(page, "/admin/lanes");
    await page.getByLabel("Search").fill(a.name);
    const rowOf = (p: string, d: string, s: number) => page.locator(`[data-testid="lane-row"][data-lane="${p} > ${d} > ${s}"]`);
    const r1 = rowOf(a.name, b.name, 26);
    await r1.getByRole("button", { name: "Edit" }).click();
    const form = r1.getByRole("form");
    await expect(form.getByLabel("Pickup location")).toHaveValue(a.id);
    await expect(form.getByLabel("Delivery location")).toHaveValue(b.id);
    await expect(form.getByLabel("Truck size")).toHaveValue("26");
    await expectNoOverflow(page, "/admin/lanes (edit row)");
    // Change the scenario: a to c at 36 ft, a new number.
    await form.getByLabel("Delivery location").selectOption(c.id);
    await form.getByLabel("Truck size").selectOption("36");
    await form.getByLabel("ITS load to copy").fill("7103");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(rowOf(a.name, c.name, 36).getByTestId("lane-number")).toHaveText("7103");
    expect(await laneOf(one)).toEqual({ pickup_location_id: a.id, delivery_location_id: c.id, equipment_size: 36, its_reference_load: "7103", note: null });
    // A duplicate: a to c at 53 ft already exists (7102). Refused with the clear message, nothing changes.
    const r1b = rowOf(a.name, c.name, 36);
    await r1b.getByRole("button", { name: "Edit" }).click();
    await r1b.getByRole("form").getByLabel("Truck size").selectOption("53");
    await r1b.getByRole("form").getByRole("button", { name: "Save", exact: true }).click();
    await expect(r1b.getByText("A lane reference for this pickup, delivery and truck size already exists. Edit that row instead.")).toBeVisible();
    await expect(r1b.getByRole("form").getByLabel("Truck size"), "the choice is kept after the refusal").toHaveValue("53");
    expect((await laneOf(one)).equipment_size).toBe(36);
    expect((await laneOf(two)).its_reference_load).toBe("7102");
    // The server validates again (the browser form has no check of its own for these): the same location twice, and
    // values that the selects do not offer (an option added in the page, as a hand made request would send).
    await r1b.getByRole("form").getByLabel("Truck size").selectOption("36");
    const addOption = (label: string, value: string) => r1b.getByRole("form").getByLabel(label).evaluate((el, v) => {
      const o = document.createElement("option");
      o.value = v; o.textContent = `forged ${v}`;
      (el as HTMLSelectElement).appendChild(o);
    }, value);
    const cases: [string, () => Promise<unknown>, string][] = [
      ["the same location twice", () => r1b.getByRole("form").getByLabel("Delivery location").selectOption(a.id), "Pickup and delivery must be different locations."],
      ["a size that does not exist", async () => { await r1b.getByRole("form").getByLabel("Delivery location").selectOption(c.id); await addOption("Truck size", "48"); await r1b.getByRole("form").getByLabel("Truck size").selectOption("48"); }, "Truck size must be 26, 36 or 53."],
      ["not a location id", async () => { await r1b.getByRole("form").getByLabel("Truck size").selectOption("36"); await addOption("Pickup location", "nope"); await r1b.getByRole("form").getByLabel("Pickup location").selectOption("nope"); }, "Choose the pickup location."],
    ];
    for (const [label, prepare, want] of cases) {
      await prepare();
      await r1b.getByRole("form").getByRole("button", { name: "Save", exact: true }).click();
      await expect(r1b.getByText(want), `${label}: refused by the server`).toBeVisible();
    }
    expect(await laneOf(one)).toEqual({ pickup_location_id: a.id, delivery_location_id: c.id, equipment_size: 36, its_reference_load: "7103", note: null });
  } finally {
    await db().from("lane_references").delete().in("id", [one, two]);
    await ctx.close();
  }
});

