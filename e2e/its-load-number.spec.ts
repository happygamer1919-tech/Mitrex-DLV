import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { adminClient, as, gotoSteady, insertLoad, isoDate, parseCsv, uniq, uniqIts } from "./support/helpers";
import { fillBooking, makeLocation, retireLocations } from "./support/book";
import { BASE_URL } from "./support/env";
import { sentEmails, setMockStatus, MAIL_MOCK_URL, type SentEmail } from "./support/mail-mock";
import { assertLocalUrl } from "./support/guard";
import { CARRIER_A } from "./support/users";

// DLV-025: the ITS load number is the source of truth. Maria requests (request ref only, "Number pending"), staff
// assign the carrier, upload the BOL and MUST enter the ITS number before a load can be booked; after booking the
// ITS number is the identity everywhere (Maria, carrier, board, calendar, CSV, emails). Booking sends ONE email to
// all active customer users with the BOL attached.

test.describe.configure({ mode: "serial", timeout: 180_000 });
assertLocalUrl(MAIL_MOCK_URL, "mail mock url");

const MARIA = "maria@e2e.test";
const db = () => adminClient();

const createdUsers: string[] = [];
const parked: string[] = [];
const locations: string[] = [];
let customerId = "";
let secondCustomer = "";
let inactiveCustomer = "";
let adminProfileId = "";

function freshEmail(tag: string): string {
  return `${tag}-${Date.now().toString(36)}-${process.pid}-${Math.floor(Math.random() * 1e6).toString(36)}@e2e.test`.toLowerCase();
}

async function makeCustomerUser(active: boolean, tag: string): Promise<string> {
  const email = freshEmail(tag);
  const made = await db().auth.admin.createUser({ email, email_confirm: true });
  if (made.error || !made.data.user) throw made.error ?? new Error("createUser failed");
  createdUsers.push(made.data.user.id);
  const p = await db().from("profiles").insert({
    id: made.data.user.id, email, full_name: tag, role: "customer", customer_id: customerId, is_active: active,
  });
  if (p.error) throw p.error;
  return email;
}

test.beforeAll(async () => {
  customerId = (await db().from("customers").select("id").eq("name", "Mitrex").single()).data!.id as string;
  adminProfileId = (await db().from("profiles").select("id").eq("email", "admin@e2e.test").single()).data!.id as string;
  secondCustomer = await makeCustomerUser(true, "its-cust2");
  inactiveCustomer = await makeCustomerUser(false, "its-cust-off");
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

// ---- helpers ----------------------------------------------------------------------------------

async function row(id: string) {
  const { data, error } = await db().from("loads").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Record<string, unknown> & { status: string; its_load_number: string | null; load_number: string };
}

async function events(id: string) {
  const { data, error } = await db().from("load_events").select("from_status,to_status,note").eq("load_id", id).order("id");
  if (error) throw error;
  return (data ?? []) as { from_status: string | null; to_status: string; note: string | null }[];
}

// A requested load for the E2E carrier (or without one), parked afterwards.
async function request(opts: { carrier?: boolean; po?: string } = {}) {
  const l = await insertLoad({ po: opts.po ?? uniq("ITS"), status: "requested", carrier: opts.carrier ?? true });
  parked.push(l.id);
  return l;
}

const bookButton = (page: Page) => page.getByRole("button", { name: "Mark booked" });
const itsInput = (page: Page) => page.getByLabel("ITS load number (required to book)");

async function staffPage(browser: Browser, id: string) {
  const s = await as(browser, "admin");
  await gotoSteady(s.page, `/admin/loads/${id}`);
  await expect(s.page.getByRole("heading", { name: "Carrier and booking" })).toBeVisible();
  return s;
}

async function waitStatus(id: string, status: string) {
  await expect.poll(async () => (await row(id)).status, { timeout: 20_000 }).toBe(status);
}

async function emailsMatching(pred: (m: SentEmail) => boolean, count: number, timeoutMs = 20_000): Promise<SentEmail[]> {
  const end = Date.now() + timeoutMs;
  let hits: SentEmail[] = [];
  while (Date.now() < end) {
    hits = (await sentEmails()).filter(pred);
    if (hits.length >= count) return hits;
    await new Promise((r) => setTimeout(r, 300));
  }
  return hits;
}

async function activeCustomerEmails(): Promise<string[]> {
  const { data, error } = await db().from("profiles").select("email").eq("role", "customer").eq("customer_id", customerId).eq("is_active", true);
  if (error) throw error;
  return (data ?? []).map((r) => r.email as string).sort();
}

// Uploads a BOL the way the app stores it (service role): storage object plus load_documents row.
async function seedBol(loadId: string, bytes: Buffer, ext = "pdf"): Promise<string> {
  const path = `${loadId}/bol/${randomUUID()}.${ext}`;
  const up = await db().storage.from("documents").upload(path, bytes, { contentType: ext === "pdf" ? "application/pdf" : "image/png" });
  if (up.error) throw up.error;
  const ins = await db().from("load_documents").insert({ load_id: loadId, kind: "bol", storage_path: path, uploaded_by: adminProfileId });
  if (ins.error) throw ins.error;
  return path;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function bookAsStaff(browser: Browser, id: string, its: string) {
  const s = await staffPage(browser, id);
  await itsInput(s.page).fill(its);
  await bookButton(s.page).click();
  await waitStatus(id, "booked");
  await s.ctx.close();
}

// ---- tests ------------------------------------------------------------------------------------

test("a request shows Maria 'Number pending' with the request ref small, and staff 'Request MTX-...'", async ({ browser }) => {
  const pickup = await makeLocation({ prefix: "E2E-ITSP" });
  const delivery = await makeLocation({ prefix: "E2E-ITSD" });
  locations.push(pickup.id, delivery.id);
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/book");
  await fillBooking(page, {
    pickup: pickup.label, delivery: delivery.label,
    pickupContact: ["Pat Pickup", "416-555-0101"], deliveryContact: ["Dee Delivery", "416-555-0102"],
    pickupDate: isoDate(4), po: uniq("ITS-REQ"),
  });
  await page.getByRole("button", { name: "Request load" }).click();
  await page.waitForURL(/\/loads\/[0-9a-f-]{36}$/);
  const id = page.url().split("/").pop()!;
  parked.push(id);
  const r = await row(id);
  expect(r.status).toBe("requested");
  expect(r.its_load_number).toBeNull();
  expect(r.load_number).toMatch(/^MTX-\d{4,}$/);

  await expect(page.locator("h1").getByTestId("load-number")).toHaveText("Number pending");
  await expect(page.locator("h1").getByTestId("request-ref")).toHaveText(r.load_number);
  await expect(page.locator("h1")).toContainText(`Request ${r.load_number}`);

  await gotoSteady(page, "/loads");
  const item = page.getByRole("listitem").filter({ hasText: r.load_number });
  await expect(item).toHaveCount(1);
  await expect(item.getByTestId("load-number")).toHaveText("Number pending");
  await expect(item.getByTestId("request-ref")).toHaveText(r.load_number);
  await ctx.close();

  const s = await staffPage(browser, id);
  await expect(s.page.locator("h1").getByTestId("load-number")).toHaveText(`Request ${r.load_number}`);
  await expect(s.page.getByTestId("its-number")).toHaveText("Not assigned yet");
  await s.ctx.close();
});

test("Mark booked stays disabled until a carrier is saved AND an ITS number is entered, and says what is missing", async ({ browser }) => {
  const l = await request({ carrier: false });
  const s = await staffPage(browser, l.id);
  const page = s.page;
  await expect(itsInput(page)).toBeVisible();
  await expect(page.getByText("Enter the new load number from ITS.")).toBeVisible();
  await expect(bookButton(page)).toBeDisabled();
  await expect(page.getByTestId("book-missing")).toContainText("Assign a carrier");
  await expect(page.getByTestId("book-missing")).toContainText("Enter the ITS load number");

  await itsInput(page).fill(uniqIts());
  await expect(bookButton(page)).toBeDisabled();
  await expect(page.getByTestId("book-missing")).toHaveText("Assign a carrier.");

  await page.getByLabel("Carrier").first().selectOption({ label: CARRIER_A });
  await page.getByRole("button", { name: "Save carrier" }).click();
  await expect(page.getByText("Carrier assigned.").first()).toBeVisible();
  await expect(page.getByTestId("book-missing")).toHaveCount(0);
  await expect(bookButton(page)).toBeEnabled();

  await itsInput(page).fill("");
  await expect(bookButton(page)).toBeDisabled();
  await expect(page.getByTestId("book-missing")).toHaveText("Enter the ITS load number.");
  expect((await row(l.id)).status).toBe("requested");
  await s.ctx.close();
});

test("an invalid or a duplicate ITS number is refused with a message and the database is unchanged", async ({ browser }) => {
  const taken = await insertLoad({ po: uniq("ITS-TAKEN"), status: "booked" });
  const l = await request();
  const before = await events(l.id);
  const s = await staffPage(browser, l.id);
  const page = s.page;

  for (const bad of ["abc", "12 3", "1-", "a1"]) {
    await itsInput(page).fill(bad);
    await bookButton(page).click();
    await expect(page.getByText(/must be digits/)).toBeVisible();
    const r = await row(l.id);
    expect(r.status, `status after "${bad}"`).toBe("requested");
    expect(r.its_load_number, `number after "${bad}"`).toBeNull();
  }

  await itsInput(page).fill(taken.itsNumber!);
  await bookButton(page).click();
  await expect(page.getByText(/already used by another load/)).toBeVisible();
  await expect(page.getByText(new RegExp(taken.requestRef))).toBeVisible(); // names the other load's request ref
  const r = await row(l.id);
  expect(r.status).toBe("requested");
  expect(r.its_load_number).toBeNull();
  expect(await events(l.id)).toEqual(before);
  expect((await row(taken.id)).its_load_number).toBe(taken.itsNumber);

  // control: a split number such as 313-2 is accepted and books the load
  const split = `${uniqIts()}-2`;
  await itsInput(page).fill(`  ${split} `);
  await bookButton(page).click();
  await waitStatus(l.id, "booked");
  expect((await row(l.id)).its_load_number).toBe(split);
  await s.ctx.close();
});

test("after staff book, the ITS number identifies the load for Maria, the carrier, the board, the calendar and the CSV; Edit ITS number logs an event", async ({ browser }) => {
  const l = await request({ po: uniq("ITS-EVERY") });
  const its = uniqIts();
  const pickup = (await row(l.id)).pickup_date as string;
  await bookAsStaff(browser, l.id, its);
  const r = await row(l.id);
  expect(r.its_load_number).toBe(its);
  expect(r.load_number).toBe(l.requestRef); // the request ref is kept
  const ev = await events(l.id);
  expect(ev.map((e) => e.note)).toContain(`ITS load number set to ${its}`);
  expect(ev.map((e) => e.note)).toContain(`Booked by staff (ITS ${its})`);

  // Maria: list and detail
  const m = await as(browser, "maria");
  await m.page.goto("/loads");
  const item = m.page.getByRole("listitem").filter({ hasText: its });
  await expect(item).toHaveCount(1);
  await expect(item.getByTestId("load-number")).toHaveText(its);
  await expect(item.getByTestId("request-ref")).toHaveCount(0);
  await m.page.goto(`/loads/${l.id}`);
  await expect(m.page.locator("h1")).toContainText(its);
  await expect(m.page.locator("h1")).not.toContainText("Number pending");
  await m.ctx.close();

  // carrier: card and detail
  const c = await as(browser, "carrierA");
  await c.page.goto("/my-loads");
  await expect(c.page.getByRole("link", { name: new RegExp(its) })).toHaveCount(1);
  await expect(c.page.getByText(l.requestRef)).toHaveCount(0);
  await c.page.goto(`/my-loads/${l.id}`);
  await expect(c.page.locator("h1")).toContainText(its);
  await c.ctx.close();

  // staff: board, calendar, CSV
  const s = await as(browser, "admin");
  await s.page.goto("/admin");
  const card = s.page.locator(`#status-booked a[href="/admin/loads/${l.id}"]`);
  await expect(card).toContainText(its);
  await s.page.goto(`/admin/calendar?view=week&date=${pickup}`);
  await expect(s.page.getByRole("link", { name: new RegExp(its) })).toHaveCount(1);
  const csv = await s.page.request.get(`/admin/export/csv?from=${pickup}&to=${pickup}`);
  expect(csv.status()).toBe(200);
  const rows = parseCsv(await csv.text());
  expect(rows[0].slice(0, 3)).toEqual(["load_number", "request_ref", "created_at"]);
  const mine = rows.find((x) => x[1] === l.requestRef);
  expect(mine, "CSV row of the booked load").toBeTruthy();
  expect(mine![0]).toBe(its);

  // Edit ITS number
  await gotoSteady(s.page, `/admin/loads/${l.id}`);
  await expect(s.page.locator("h1")).toContainText(its);
  await expect(s.page.getByTestId("its-current")).toHaveText(its);
  await s.page.getByRole("button", { name: "Edit ITS number" }).click();
  const fixed = uniqIts();
  await s.page.getByTestId("its-edit-input").fill(fixed);
  await s.page.getByRole("button", { name: "Save ITS number" }).click();
  await expect(s.page.getByTestId("its-current")).toHaveText(fixed);
  expect((await row(l.id)).its_load_number).toBe(fixed);
  expect((await events(l.id)).map((e) => e.note)).toContain(`ITS load number changed from ${its} to ${fixed}`);
  await expect(s.page.getByText(`ITS load number changed from ${its} to ${fixed}`)).toBeVisible();
  await s.ctx.close();
});

test("a legacy booked load without an ITS number still works: carrier sees the request ref, staff can add the number", async ({ browser }) => {
  const l = await insertLoad({ po: uniq("ITS-LEGACY"), status: "booked", its: null });
  parked.push(l.id);
  expect(l.itsNumber).toBeNull();

  const c = await as(browser, "carrierA");
  await c.page.goto(`/my-loads/${l.id}`);
  await expect(c.page.locator("h1")).toContainText(l.requestRef);
  await c.page.getByRole("button", { name: "Arrived at pickup" }).click();
  await waitStatus(l.id, "at_pickup"); // the walk needs no ITS number
  await c.ctx.close();

  const s = await as(browser, "admin");
  await gotoSteady(s.page, `/admin/loads/${l.id}`);
  await expect(s.page.locator("h1")).toContainText(`Request ${l.requestRef}`);
  await expect(s.page.getByTestId("its-current")).toHaveText("not set (legacy load)");
  await s.page.getByRole("button", { name: "Edit ITS number" }).click();
  const its = uniqIts();
  await s.page.getByTestId("its-edit-input").fill(its);
  await s.page.getByRole("button", { name: "Save ITS number" }).click();
  await expect(s.page.getByTestId("its-current")).toHaveText(its);
  expect((await events(l.id)).map((e) => e.note)).toContain(`ITS load number set to ${its}`);
  await s.ctx.close();
});

test("a staff override out of Requested asks for the ITS number; the database refuses without it", async ({ browser }) => {
  const l = await request();
  const s = await staffPage(browser, l.id);
  const page = s.page;
  await page.getByLabel("New status").selectOption({ label: "Loading" });
  await expect(page.getByTestId("override-its-input")).toBeVisible();
  await page.getByLabel("Note (required)").fill("jump");
  await page.getByTestId("override-its-input").fill("x1");
  await page.getByRole("button", { name: "Override status" }).click();
  await expect(page.getByText(/must be digits/)).toBeVisible();
  expect((await row(l.id)).status).toBe("requested");

  const its = uniqIts();
  await page.getByTestId("override-its-input").fill(its);
  await page.getByLabel("Note (required)").fill("jump with the number"); // React resets the form after every action
  await page.getByRole("button", { name: "Override status" }).click();
  await waitStatus(l.id, "loading");
  expect((await row(l.id)).its_load_number).toBe(its);
  await s.ctx.close();
});

test("booking sends ONE confirmation to all active customer users with the BOL attached (right filename and size); inactive users excluded", async ({ browser }) => {
  const l = await request({ po: uniq("ITS-MAIL") });
  const bol = randomBytes(300_000);
  await seedBol(l.id, bol);
  const its = uniqIts();
  const expected = await activeCustomerEmails();
  expect(expected).toContain(MARIA);
  expect(expected).toContain(secondCustomer);
  expect(expected).not.toContain(inactiveCustomer);
  await bookAsStaff(browser, l.id, its);

  const mails = await emailsMatching((m) => m.subject === `Load ${its} booked`, 1);
  expect(mails).toHaveLength(1);
  const m = mails[0];
  expect([...m.to].sort()).toEqual(expected);
  expect(m.to).not.toContain(inactiveCustomer);
  expect(m.from).toBe("DLV <noreply@mock.test>");
  expect(m.attachments).toHaveLength(1);
  expect(m.attachments[0].filename).toBe(`BOL-${its}.pdf`);
  expect(m.attachments[0].bytes).toBe(bol.length);
  expect(m.attachments[0].sha256).toBe(sha(bol));
  expect(m.attachments[0].contentType).toBe("application/pdf");
  const body = m.text ?? "";
  expect(body).toContain(`Load ${its} is booked.`);
  expect(body).toContain("Carrier: " + CARRIER_A);
  expect(body).toContain("PICKUP");
  expect(body).toContain("DELIVERY");
  expect(body).toContain("ET (appointment)");
  expect(body).toContain("Contact: Pat, 416-555-0101");
  expect(body).toContain("Equipment: 53 ft");
  expect(body).toContain("The BOL is attached");
  expect(body).toContain(`${BASE_URL}/loads/${l.id}`);
  expect(body).not.toContain(l.requestRef);

  // the carrier is told too, with the ITS number
  const carrierMails = await emailsMatching((x) => x.subject === `Load ${its} assigned to you`, 1);
  expect(carrierMails).toHaveLength(1);
});

test("a BOL set over 20 MB is not attached: the email says the BOL is in the app and links to it", async ({ browser }) => {
  const l = await request();
  await seedBol(l.id, randomBytes(11 * 1024 * 1024));
  await seedBol(l.id, randomBytes(11 * 1024 * 1024));
  const its = uniqIts();
  await bookAsStaff(browser, l.id, its);
  const mails = await emailsMatching((m) => m.subject === `Load ${its} booked`, 1);
  expect(mails).toHaveLength(1);
  expect(mails[0].attachments).toHaveLength(0);
  expect(mails[0].text).toContain("The BOL is available in the app");
  expect(mails[0].text).toContain(`${BASE_URL}/loads/${l.id}`);
});

test("with no BOL yet the email says it will follow", async ({ browser }) => {
  const l = await request();
  const its = uniqIts();
  await bookAsStaff(browser, l.id, its);
  const mails = await emailsMatching((m) => m.subject === `Load ${its} booked`, 1);
  expect(mails).toHaveLength(1);
  expect(mails[0].attachments).toHaveLength(0);
  expect(mails[0].text).toContain("The BOL will follow once uploaded");
});

test("a BOL uploaded AFTER booking triggers the follow-up with the file; none while the load is still requested", async ({ browser }) => {
  const bolBytes = Buffer.from("%PDF-1.4\n" + "follow-up ".repeat(500) + "\n%%EOF\n");

  // still requested: the upload works, nobody is emailed
  const early = await request();
  const se = await staffPage(browser, early.id);
  await se.page.getByTestId("upload-bol").getByTestId("dropzone-input").setInputFiles({ name: "early.pdf", mimeType: "application/pdf", buffer: bolBytes });
  await se.page.getByRole("button", { name: "Upload BOL" }).click();
  await expect(se.page.getByText("BOL uploaded.")).toBeVisible();
  const stored = await db().from("load_documents").select("id").eq("load_id", early.id).eq("kind", "bol");
  expect(stored.data).toHaveLength(1);
  expect(await emailsMatching((m) => (m.subject + (m.text ?? "")).includes(early.requestRef), 1, 3000)).toHaveLength(0);
  await se.ctx.close();

  // booked: the follow-up carries the file
  const l = await insertLoad({ po: uniq("ITS-LATE"), status: "booked" });
  parked.push(l.id);
  const s = await staffPage(browser, l.id);
  await s.page.getByTestId("upload-bol").getByTestId("dropzone-input").setInputFiles({ name: "late.pdf", mimeType: "application/pdf", buffer: bolBytes });
  await s.page.getByRole("button", { name: "Upload BOL" }).click();
  await expect(s.page.getByText("BOL uploaded.")).toBeVisible();
  const mails = await emailsMatching((m) => m.subject === `BOL for load ${l.itsNumber}`, 1);
  expect(mails).toHaveLength(1);
  expect([...mails[0].to].sort()).toEqual(await activeCustomerEmails());
  expect(mails[0].attachments).toHaveLength(1);
  expect(mails[0].attachments[0].filename).toBe(`BOL-${l.itsNumber}.pdf`);
  expect(mails[0].attachments[0].bytes).toBe(bolBytes.length);
  expect(mails[0].attachments[0].sha256).toBe(sha(bolBytes));
  await s.ctx.close();
});

test("a POD uploaded to a booked load sends no customer email, and customers cannot open the staff page", async ({ browser }) => {
  // customers have no staff session: the page the action lives on is not theirs
  const m = await as(browser, "maria");
  const res = await m.page.goto("/admin/loads/00000000-0000-0000-0000-000000000000");
  expect(new URL(res!.url()).pathname).toBe("/loads");
  await m.ctx.close();
  // a booked load: uploading a POD must not email the customer (only a BOL does)
  const l = await insertLoad({ po: uniq("ITS-POD"), status: "booked" });
  parked.push(l.id);
  const s = await staffPage(browser, l.id);
  await s.page.getByTestId("upload-pod").getByTestId("dropzone-input").setInputFiles({ name: "pod.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
  await s.page.getByRole("button", { name: "Upload POD" }).click();
  await expect(s.page.getByText("POD uploaded.")).toBeVisible();
  expect(await emailsMatching((x) => x.subject.includes(String(l.itsNumber)), 1, 3000)).toHaveLength(0);
  await s.ctx.close();
});

test("a carrier status walk sends NO email to the customer", async ({ browser }) => {
  const l = await request();
  const its = uniqIts();
  await bookAsStaff(browser, l.id, its);
  await emailsMatching((m) => m.subject === `Load ${its} booked`, 1);
  const customers = await activeCustomerEmails();
  const toCustomers = async () => (await sentEmails()).filter((m) => m.to.some((a) => customers.includes(a))).length;
  const before = await toCustomers();

  const c = await as(browser, "carrierA");
  await gotoSteady(c.page, `/my-loads/${l.id}`);
  await c.page.getByRole("button", { name: "Arrived at pickup" }).click();
  await waitStatus(l.id, "at_pickup");
  await c.page.getByRole("button", { name: "Start loading" }).click();
  await waitStatus(l.id, "loading");
  await c.ctx.close();
  // staff move it on as well
  const s = await staffPage(browser, l.id);
  await s.page.getByLabel("New status").selectOption({ label: "Enroute" });
  await s.page.getByLabel("ETA (Eastern time, ET)").fill(`${isoDate(3)}T10:00`);
  await s.page.getByLabel("Note (required)").fill("walk");
  await s.page.getByRole("button", { name: "Override status" }).click();
  await waitStatus(l.id, "enroute");
  await s.ctx.close();

  await new Promise((r) => setTimeout(r, 2500));
  expect(await toCustomers()).toBe(before);
});

test("a failing mail service does not block booking", async ({ browser }) => {
  const l = await request();
  const its = uniqIts();
  await setMockStatus(500);
  try {
    const s = await staffPage(browser, l.id);
    await itsInput(s.page).fill(its);
    await bookButton(s.page).click();
    await waitStatus(l.id, "booked");
    expect((await row(l.id)).its_load_number).toBe(its);
    // the attempt was made (the mock records it before answering 500)
    expect(await emailsMatching((m) => m.subject === `Load ${its} booked`, 1)).toHaveLength(1);
    await s.ctx.close();
  } finally {
    await setMockStatus(200);
  }
});

test("multi-truck: every truck needs its own ITS number to be booked", async ({ browser }) => {
  const po = uniq("ITS-TRUCKS");
  const a = await request({ po });
  const b = await request({ po });
  const n1 = uniqIts();
  await bookAsStaff(browser, a.id, n1);

  const s = await staffPage(browser, b.id);
  await expect(bookButton(s.page)).toBeDisabled(); // the first truck's number is not inherited
  await expect(s.page.getByTestId("book-missing")).toHaveText("Enter the ITS load number.");
  await itsInput(s.page).fill(n1);
  await bookButton(s.page).click();
  await expect(s.page.getByText(/already used by another load/)).toBeVisible();
  expect((await row(b.id)).status).toBe("requested");
  const n2 = uniqIts();
  await itsInput(s.page).fill(n2);
  await bookButton(s.page).click();
  await waitStatus(b.id, "booked");
  expect([(await row(a.id)).its_load_number, (await row(b.id)).its_load_number]).toEqual([n1, n2]);
  await s.ctx.close();
});

test("Maria's Completed list and the Request again notice use the ITS number", async ({ browser }) => {
  const l = await insertLoad({ po: uniq("ITS-AGAIN"), status: "delivered" });
  const m = await as(browser, "maria");
  await m.page.goto("/loads?view=completed");
  const item = m.page.getByRole("listitem").filter({ hasText: l.itsNumber! });
  await expect(item).toHaveCount(1);
  await expect(item.getByTestId("load-number")).toHaveText(l.itsNumber!);
  await item.getByRole("link", { name: "Request again" }).click();
  await expect(m.page.getByTestId("copied-notice")).toHaveText(`Copied from ${l.itsNumber}. Choose the new dates and times.`);
  await m.ctx.close();
});
