import { expect, test, type Browser } from "@playwright/test";
import { adminClient, as, gotoSteady, insertLoad, isoDate, PNG_1X1, staffBook, uniq, uniqIts } from "./support/helpers";
import { fillBooking, makeLocation, retireLocations } from "./support/book";
import { BASE_URL } from "./support/env";
import { sentEmails, setMockStatus, MAIL_MOCK_URL, type SentEmail } from "./support/mail-mock";
import { assertLocalUrl } from "./support/guard";
import { CARRIER_A } from "./support/users";

// R21 staff are emailed when Maria books, R31 carrier users are emailed on assignment, Maria on booking (see
// e2e/its-load-number.spec.ts), nobody on status changes. No real Resend: the app's resend SDK talks to a local mock (RESEND_BASE_URL, started by
// e2e/support/global-setup.ts, bodies recorded in memory). Real Resend delivery stays a manual gate.

test.describe.configure({ mode: "serial", timeout: 180_000 });
assertLocalUrl(MAIL_MOCK_URL, "mail mock url");

const MARIA = "maria@e2e.test";
const db = () => adminClient();

const createdUsers: string[] = [];
const parked: string[] = [];
const locations: string[] = [];
let csrActive = "";
let csrInactive = "";
let driverActive = "";
let driverInactive = "";
let carrierAId = "";

function freshEmail(tag: string): string {
  return `${tag}-${Date.now().toString(36)}-${process.pid}-${Math.floor(Math.random() * 1e6).toString(36)}@e2e.test`.toLowerCase();
}

async function makeUser(role: string, active: boolean, carrierId: string | null, tag: string): Promise<string> {
  const email = freshEmail(tag);
  const made = await db().auth.admin.createUser({ email, email_confirm: true });
  if (made.error || !made.data.user) throw made.error ?? new Error("createUser failed");
  createdUsers.push(made.data.user.id);
  const p = await db().from("profiles").insert({
    id: made.data.user.id, email, full_name: tag, role, carrier_id: carrierId, is_active: active,
  });
  if (p.error) throw p.error;
  return email;
}

test.beforeAll(async () => {
  carrierAId = (await db().from("carriers").select("id").eq("name", CARRIER_A).single()).data!.id as string;
  csrActive = await makeUser("staff_csr", true, null, "mail-csr");
  csrInactive = await makeUser("staff_csr", false, null, "mail-csr-off");
  driverActive = await makeUser("carrier_driver", true, carrierAId, "mail-drv");
  driverInactive = await makeUser("carrier_driver", false, carrierAId, "mail-drv-off");
});

test.afterAll(async () => {
  await setMockStatus(200);
  const d = db();
  if (parked.length) {
    await d.from("loads").update({ status: "cancelled" }).in("id", parked).in("status", ["booked", "at_pickup", "loading", "enroute", "at_delivery"]);
  }
  for (const id of createdUsers) await d.auth.admin.deleteUser(id).catch(() => {});
  await retireLocations(locations);
});

// The recorded emails that name this load (subject or body), oldest first. Polls until `count` are there.
async function emailsFor(loadNumber: string, count: number, timeoutMs = 15_000): Promise<SentEmail[]> {
  const end = Date.now() + timeoutMs;
  let hits: SentEmail[] = [];
  while (Date.now() < end) {
    hits = (await sentEmails()).filter((m) => m.subject.includes(loadNumber) || (m.text ?? "").includes(loadNumber));
    if (hits.length >= count) return hits;
    await new Promise((r) => setTimeout(r, 300));
  }
  return hits;
}
const recipients = (m: SentEmail) => [...m.to].sort();

async function activeEmails(roles: string[], carrierId?: string): Promise<string[]> {
  let q = db().from("profiles").select("email").eq("is_active", true).in("role", roles);
  if (carrierId) q = q.eq("carrier_id", carrierId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map((r) => r.email as string).sort();
}

// Maria books through the real form; returns the load id and number.
async function mariaBooks(browser: Browser, route: { pickup: string; delivery: string }, po: string, equipment: 26 | 36 | 53) {
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/book");
  await fillBooking(page, {
    pickup: route.pickup, delivery: route.delivery,
    pickupContact: ["Pat Pickup", "416-555-0101"], deliveryContact: ["Dee Delivery", "416-555-0102"],
    pickupDate: isoDate(4), equipment, po,
  });
  await page.getByRole("button", { name: "Request load" }).click();
  await page.waitForURL(/\/loads\/[0-9a-f-]{36}$/);
  const id = page.url().split("/").pop()!;
  const loadNumber = (await db().from("loads").select("load_number").eq("id", id).single()).data!.load_number as string;
  await ctx.close();
  return { id, loadNumber };
}

test("the mock really is what the app talks to (the resend SDK honours RESEND_BASE_URL)", async () => {
  const res = await fetch(`${MAIL_MOCK_URL}/__emails`);
  expect(res.status).toBe(200);
  expect(Array.isArray(await res.json())).toBe(true);
});

test("when Maria books, ALL active staff get one email with route, equipment and the admin link; inactive staff and Maria do not", async ({ browser }) => {
  const pickup = await makeLocation({ prefix: "E2E-MAILP" });
  const delivery = await makeLocation({ prefix: "E2E-MAILD" });
  locations.push(pickup.id, delivery.id);

  const expected = await activeEmails(["staff_admin", "staff_csr"]);
  expect(expected).toContain("admin@e2e.test");
  expect(expected).toContain(csrActive);
  expect(expected).not.toContain(csrInactive);

  const po = uniq("MAIL-REQ");
  const { id, loadNumber } = await mariaBooks(browser, { pickup: pickup.label, delivery: delivery.label }, po, 36);
  const mails = await emailsFor(loadNumber, 1);
  expect(mails).toHaveLength(1);
  const m = mails[0];

  expect(recipients(m)).toEqual(expected);
  expect(m.to).not.toContain(csrInactive);
  expect(m.to).not.toContain(MARIA);
  expect(m.subject).toBe(`New load requested (Request ${loadNumber})`);
  expect(m.from).toBe("DLV <noreply@mock.test>");
  const body = m.text ?? "";
  expect(body).toContain(`Request ref: ${loadNumber}`);
  expect(body).toContain("ITS load number: not assigned yet. Enter it when you book.");
  expect(body).toContain(`Route: ${pickup.name} to ${delivery.name}`);
  expect(body).toContain("Equipment: 36 ft");
  expect(body).toContain(`PO number: ${po}`);
  expect(body).toContain("Pickup contact: Pat Pickup, 416-555-0101");
  expect(body).toContain(`${BASE_URL}/admin/loads/${id}`);
  // The database agrees the load is a plain request.
  expect((await db().from("loads").select("status").eq("id", id).single()).data?.status).toBe("requested");
});

test("assigning a carrier and booking emails ALL active users of that carrier, with addresses and the my-loads link", async ({ browser }) => {
  const expected = await activeEmails(["carrier_owner", "carrier_driver"], carrierAId);
  expect(expected).toContain("owner-a@e2e.test");
  expect(expected).toContain(driverActive);
  expect(expected).not.toContain(driverInactive);

  const { id, requestRef: loadNumber } = await insertLoad({ po: uniq("MAIL-BOOK"), status: "requested" });
  parked.push(id);
  const { ctx, page } = await as(browser, "admin");
  await page.goto(`/admin/loads/${id}`);

  // Saving the carrier on a load that is still only requested tells nobody yet.
  await page.getByLabel("Carrier").first().selectOption({ label: CARRIER_A });
  await page.getByRole("button", { name: "Save carrier" }).click();
  await expect(page.getByText("Carrier assigned.", { exact: true })).toBeVisible();
  expect((await db().from("loads").select("carrier_id").eq("id", id).single()).data?.carrier_id).toBe(carrierAId);
  expect(await emailsFor(loadNumber, 1, 2500)).toHaveLength(0);

  const its = uniqIts();
  await staffBook(page, its);
  // (The button and its message disappear with the "requested" state, so the database is the witness.)
  await expect.poll(async () => (await db().from("loads").select("status").eq("id", id).single()).data?.status).toBe("booked");
  const mails = (await emailsFor(its, 2)).filter((x) => x.subject.includes("assigned to you")); // the booking confirmation to the customer matches too
  expect(mails.length).toBeGreaterThan(0);
  expect(mails).toHaveLength(1);
  const m = mails[0];
  expect(recipients(m)).toEqual(expected);
  expect(m.to).not.toContain(driverInactive);
  expect(m.to).not.toContain(MARIA);
  expect(m.to).not.toContain("owner-b@e2e.test");
  expect(m.subject).toBe(`Load ${its} assigned to you`);
  const body = m.text ?? "";
  expect(body).toContain(`Load ${its} has been assigned to you.`);
  expect(body).not.toContain(loadNumber); // the carrier never sees the request ref
  expect(body).toContain("PICKUP");
  expect(body).toContain("Mitrex, 41 Racine Rd, Toronto, ON M9W 2Z4");
  expect(body).toContain("DELIVERY");
  expect(body).toContain("Howden, 38 Howden Rd, Scarborough, ON M1R 3E9");
  expect(body).toContain("Contact: Pat, 416-555-0101");
  expect(body).toContain("Contact: Dee, 416-555-0102");
  expect(body).toContain(`${BASE_URL}/my-loads/${id}`);
  expect((await db().from("loads").select("status").eq("id", id).single()).data?.status).toBe("booked");

  // A carrier added to a load that is already booked is told as well (the other path to the same email).
  const late = await insertLoad({ po: uniq("MAIL-LATE"), status: "booked", carrier: false });
  parked.push(late.id);
  await gotoSteady(page, `/admin/loads/${late.id}`);
  await page.getByLabel("Carrier").first().selectOption({ label: CARRIER_A });
  await page.getByRole("button", { name: "Save carrier" }).click();
  await expect(page.getByText(/^Carrier assigned\. Email sent to \d+ carrier users?\.$/)).toBeVisible();
  const lateMails = await emailsFor(late.loadNumber, 1);
  expect(lateMails).toHaveLength(1);
  expect(recipients(lateMails[0])).toEqual(expected);
  expect(lateMails[0].text).toContain(`${BASE_URL}/my-loads/${late.id}`);
  await ctx.close();
});

test("status changes by the carrier (at pickup to delivered) send no email at all, and none to Maria", async ({ browser }) => {
  const { id, loadNumber } = await insertLoad({ po: uniq("MAIL-WALK"), status: "booked" });
  parked.push(id);
  const before = (await sentEmails()).length;

  const { ctx, page } = await as(browser, "carrierA");
  await page.goto(`/my-loads/${id}`);
  await page.getByRole("button", { name: "Arrived at pickup" }).click();
  await expect(page.getByRole("button", { name: "Start loading" })).toBeVisible();
  await page.getByRole("button", { name: "Start loading" }).click();
  await expect(page.getByRole("button", { name: "Leave for delivery" })).toBeVisible();
  await page.getByRole("button", { name: "Leave for delivery" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="datetime-local"]').fill(`${isoDate(4)}T15:30`);
  await dialog.getByRole("button", { name: "Confirm ETA and leave" }).click();
  await expect(page.getByRole("button", { name: "Arrived at delivery" })).toBeVisible();
  await page.getByRole("button", { name: "Arrived at delivery" }).click();
  await expect(page.getByRole("button", { name: "Mark delivered" })).toBeVisible();
  await page.getByRole("button", { name: "Mark delivered" }).click();
  const pod = page.getByRole("dialog");
  await pod.locator('input[type="file"]').setInputFiles({ name: "pod.png", mimeType: "image/png", buffer: PNG_1X1 });
  await pod.getByRole("button", { name: "Mark delivered" }).click();
  await expect.poll(async () => (await db().from("loads").select("status").eq("id", id).single()).data?.status, { timeout: 30_000 }).toBe("delivered");
  const steps = (await db().from("load_events").select("to_status").eq("load_id", id).order("created_at")).data?.map((e) => e.to_status);
  expect(steps).toEqual(expect.arrayContaining(["at_pickup", "loading", "enroute", "at_delivery", "delivered"]));

  // Give a wrongly sent email time to arrive, then look at everything recorded during the walk.
  await page.waitForTimeout(2000);
  const during = (await sentEmails()).slice(before);
  expect(during.filter((m) => m.subject.includes(loadNumber) || (m.text ?? "").includes(loadNumber))).toEqual([]);
  for (const m of during) expect(m.to).not.toContain(MARIA);
  await ctx.close();
});

test("a failing email service (HTTP 500) does not fail the booking or the assignment", async ({ browser }) => {
  const pickup = await makeLocation({ prefix: "E2E-MAILFP" });
  const delivery = await makeLocation({ prefix: "E2E-MAILFD" });
  locations.push(pickup.id, delivery.id);
  await setMockStatus(500);
  try {
    const { id, loadNumber } = await mariaBooks(browser, { pickup: pickup.label, delivery: delivery.label }, uniq("MAIL-500"), 26);
    // The booking exists and is a normal request ...
    const row = await db().from("loads").select("status,equipment_size").eq("id", id).single();
    expect(row.data).toEqual({ status: "requested", equipment_size: 26 });
    // ... and the app did try to send (the mock records the attempt before it answers 500).
    expect(await emailsFor(loadNumber, 1)).toHaveLength(1);

    // Staff can still assign and book while the service is down; the screen says no email went out.
    const { ctx, page } = await as(browser, "admin");
    const late = await insertLoad({ po: uniq("MAIL-500B"), status: "booked", carrier: false });
    parked.push(late.id);
    await page.goto(`/admin/loads/${late.id}`);
    await page.getByLabel("Carrier").first().selectOption({ label: CARRIER_A });
    await page.getByRole("button", { name: "Save carrier" }).click();
    await expect(page.getByText("Carrier assigned. No email was sent.", { exact: true })).toBeVisible();
    expect((await db().from("loads").select("carrier_id").eq("id", late.id).single()).data?.carrier_id).toBe(carrierAId);
    expect(await emailsFor(late.loadNumber, 1)).toHaveLength(1); // attempted, refused by the mock
    await gotoSteady(page, `/admin/loads/${id}`);
    await page.getByLabel("Carrier").first().selectOption({ label: CARRIER_A });
    await page.getByRole("button", { name: "Save carrier" }).click();
    await expect(page.getByText("Carrier assigned.", { exact: true })).toBeVisible();
    parked.push(id);
    const its = uniqIts();
    await staffBook(page, its);
    await expect.poll(async () => (await db().from("loads").select("status").eq("id", id).single()).data?.status).toBe("booked");
    // The attempts were made (and refused by the mock): the request email, then the carrier email and the customer confirmation.
    expect((await emailsFor(loadNumber, 1)).map((m) => m.subject)).toEqual([`New load requested (Request ${loadNumber})`]);
    expect((await emailsFor(its, 2)).map((m) => m.subject)).toEqual([`Load ${its} assigned to you`, `Load ${its} booked`]);
    await ctx.close();
  } finally {
    await setMockStatus(200);
  }
});

test("nothing recorded during the whole run was addressed to Maria except a booking confirmation or a late BOL", async () => {
  const all = await sentEmails();
  expect(all.length).toBeGreaterThan(0); // the log is not empty, so the check below is not vacuous
  const toMaria = all.filter((m) => m.to.includes(MARIA));
  for (const m of toMaria) expect(m.subject, "an email to Maria").toMatch(/^(Load \S+ booked|BOL for load \S+)$/);
});
