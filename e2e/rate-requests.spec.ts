import { expect, test, type Page } from "@playwright/test";
import { adminClient, anon, as, gotoSteady, uniq } from "./support/helpers";
import { BASE_URL } from "./support/env";
import { loginViaUi } from "./support/login";
import { sentEmails, setMockStatus, MAIL_MOCK_URL } from "./support/mail-mock";
import { assertLocalUrl } from "./support/guard";
import { fillRateForm, makeUser, RATE_MARK, rateRowByNotes, seedRate, settledMail, userClient } from "./support/rates";
import { exceedsRateCap, fmtMoney, rateLane, STATE_CODES, validateQuote, validateRateRequest, EMPTY_RATE_FORM } from "../src/lib/rates/validate";

// DLV-030 (R40): a customer asks for a RATE on a lane that is not in the system; staff enter it; the customer sees it on
// /rates. A rate request is not a load. Emails go to the local mock of the Resend API (RESEND_BASE_URL); no real mail.

test.describe.configure({ mode: "serial", timeout: 180_000 });
assertLocalUrl(MAIL_MOCK_URL, "mail mock url");

const db = () => adminClient();
const MARIA = "maria@e2e.test";
const ADMIN = "admin@e2e.test";

let mitrexId = "";
let otherCustomerId = "";
let mariaId = "";
let adminId = "";
// Extra users, so "every ACTIVE staff_admin / customer user and nobody else" is a real assertion.
let admin2: { id: string; email: string };
let adminOff: { id: string; email: string };
let csr: { id: string; email: string };
let csrOff: { id: string; email: string };
let cust2: { id: string; email: string };
let custOff: { id: string; email: string };
let otherCust: { id: string; email: string };
const made: { id: string }[] = [];

test.beforeAll(async () => {
  const d = db();
  mitrexId = (await d.from("customers").select("id").eq("name", "Mitrex").single()).data!.id as string;
  const existing = await d.from("customers").select("id").eq("name", "E2E Rates Other Co").maybeSingle();
  otherCustomerId = existing.data ? (existing.data.id as string) : ((await d.from("customers").insert({ name: "E2E Rates Other Co" }).select("id").single()).data!.id as string);
  mariaId = (await d.from("profiles").select("id").eq("email", MARIA).single()).data!.id as string;
  adminId = (await d.from("profiles").select("id").eq("email", ADMIN).single()).data!.id as string;
  admin2 = await makeUser({ role: "staff_admin", active: true, tag: "rate-admin2" });
  adminOff = await makeUser({ role: "staff_admin", active: false, tag: "rate-admin-off" });
  csr = await makeUser({ role: "staff_csr", active: true, tag: "rate-csr" });
  csrOff = await makeUser({ role: "staff_csr", active: false, tag: "rate-csr-off" });
  cust2 = await makeUser({ role: "customer", active: true, customerId: mitrexId, tag: "rate-cust2" });
  custOff = await makeUser({ role: "customer", active: false, customerId: mitrexId, tag: "rate-cust-off" });
  otherCust = await makeUser({ role: "customer", active: true, customerId: otherCustomerId, tag: "rate-other-cust" });
  made.push(admin2, adminOff, csr, csrOff, cust2, custOff, otherCust);
});

test.afterAll(async () => {
  await setMockStatus(200);
  const d = db();
  await d.from("rate_requests").delete().like("notes", `${RATE_MARK}%`);
  for (const u of made) {
    await d.from("rate_requests").delete().eq("requested_by", u.id);
    await d.from("profiles").update({ is_active: false }).eq("id", u.id);
    await d.auth.admin.deleteUser(u.id).catch(() => {});
  }
});

const activeEmails = async (roles: string[], customerId?: string): Promise<string[]> => {
  let q = db().from("profiles").select("email").eq("is_active", true).in("role", roles);
  if (customerId) q = q.eq("customer_id", customerId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map((r) => r.email as string).sort();
};
const loadCount = async () => (await db().from("loads").select("id", { count: "exact", head: true })).count ?? 0;
const rateCountOf = async (userId: string) => (await db().from("rate_requests").select("id", { count: "exact", head: true }).eq("requested_by", userId)).count ?? 0;

async function submitRequest(page: Page) {
  await page.getByRole("button", { name: "Request a rate" }).click();
}

// ---- pure rules -------------------------------------------------------------------------------------------------------

test("rate validation rules (pure): states, cities, size, weight, notes, the 30 per 10 minutes cap, the quote entry", () => {
  const ok = { ...EMPTY_RATE_FORM, pickup_city: " Toronto ", pickup_state: "on", delivery_city: "Buffalo", delivery_state: "NY", equipment_size: "53" };
  const good = validateRateRequest(ok);
  expect("clean" in good && good.clean.pickup_city === "Toronto" && good.clean.pickup_state === "ON" && good.clean.weight_lbs === null && good.clean.dims === null).toBe(true);
  const bad = (patch: Partial<typeof ok>) => { const r = validateRateRequest({ ...ok, ...patch }); return "errors" in r ? r.errors : null; };
  expect(bad({ pickup_state: "ZZ" })?.pickup_state).toBeTruthy();
  expect(bad({ delivery_state: "ONT" })?.delivery_state).toBeTruthy();
  expect(bad({ delivery_state: "" })?.delivery_state).toBeTruthy();
  expect(bad({ pickup_city: "   " })?.pickup_city).toBeTruthy();
  expect(bad({ delivery_city: "x".repeat(81) })?.delivery_city).toBeTruthy();
  expect(bad({ pickup_city: "a\nb" })?.pickup_city).toBeTruthy();
  expect(bad({ equipment_size: "48" })?.equipment_size).toBeTruthy();
  expect(bad({ equipment_size: "" })?.equipment_size).toBeTruthy();
  expect(bad({ weight_lbs: "100001" })?.weight_lbs).toBeTruthy();
  expect(bad({ weight_lbs: "0" })?.weight_lbs).toBeTruthy();
  expect(bad({ weight_lbs: "12.5" })?.weight_lbs).toBeTruthy();
  expect(bad({ weight_lbs: "abc" })?.weight_lbs).toBeTruthy();
  expect(bad({ weight_lbs: "100000" })).toBeNull();
  expect(bad({ notes: "n".repeat(1001) })?.notes).toBeTruthy();
  expect(bad({ notes: "n".repeat(1000) })).toBeNull();
  expect(bad({ dims: "d".repeat(201) })?.dims).toBeTruthy();
  expect(STATE_CODES.length).toBe(64);
  expect(exceedsRateCap(29)).toBe(false);
  expect(exceedsRateCap(30)).toBe(true);
  const today = "2031-05-04";
  const q = (patch: Partial<{ amount: string; currency: string; notes: string; validUntil: string }>) => validateQuote({ amount: "1850.50", currency: "CAD", notes: "", validUntil: "", ...patch }, today);
  expect("clean" in q({}) && (q({}) as { clean: { amount: number } }).clean.amount === 1850.5).toBe(true);
  expect("errors" in q({ amount: "0" })).toBe(true);
  expect("errors" in q({ amount: "-5" })).toBe(true);
  expect("errors" in q({ amount: "1850.999" })).toBe(true);
  expect("errors" in q({ amount: "abc" })).toBe(true);
  expect("errors" in q({ amount: "" })).toBe(true);
  expect("errors" in q({ currency: "EUR" })).toBe(true);
  expect("errors" in q({ validUntil: "2031-05-03" })).toBe(true);
  expect("errors" in q({ validUntil: "2031-02-30" })).toBe(true);
  expect("clean" in q({ validUntil: "2031-05-04", currency: "USD" })).toBe(true);
  expect(fmtMoney(1850.5, "CAD")).toBe("1,850.50 CAD");
  expect(rateLane({ pickup_city: "A", pickup_state: "ON", delivery_city: "B", delivery_state: "NY", equipment_size: 36 })).toBe("A, ON to B, NY, 36 ft");
});

// ---- customer creates a request ---------------------------------------------------------------------------------------

test("customer creates a rate request: the database row matches, no load is created, the list shows Waiting for rate and no amount", async ({ browser }) => {
  const notes = uniq(RATE_MARK);
  const pc = uniq("CITYA"), dc = uniq("CITYB");
  const loadsBefore = await loadCount();
  const { ctx, page } = await as(browser, "maria");
  await gotoSteady(page, "/rates");
  await expect(page.getByRole("heading", { name: "Rates", level: 1 })).toBeVisible();
  await fillRateForm(page, { pc: `  ${pc}  `, ps: "on", dc, ds: "ny", size: 36, weight: "12345", dims: "40 x 8 x 6 ft", notes });
  await submitRequest(page);
  const banner = page.getByTestId("rate-requested-banner");
  await expect(banner).toBeVisible();
  const ref = /RQ-\d{4,}/.exec((await banner.textContent()) ?? "")![0];
  const rows = await rateRowByNotes(notes);
  expect(rows).toHaveLength(1);
  const r = rows[0];
  expect(r).toMatchObject({
    ref, customer_id: mitrexId, requested_by: mariaId, pickup_city: pc, pickup_state: "ON", delivery_city: dc, delivery_state: "NY",
    equipment_size: 36, weight_lbs: 12345, dims: "40 x 8 x 6 ft", notes, status: "open",
    quoted_amount: null, quoted_currency: null, quote_notes: null, quote_valid_until: null, quoted_by: null, quoted_at: null,
  });
  expect(await loadCount()).toBe(loadsBefore); // a rate request creates no load
  const row = page.locator(`[data-testid="rate-row"][data-ref="${ref}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("rate-status")).toHaveText("Waiting for rate");
  await expect(row.getByTestId("rate-lane")).toHaveText(`${pc}, ON to ${dc}, NY, 36 ft`);
  await expect(row.getByTestId("rate-amount")).toHaveCount(0);
  await expect(row.getByRole("link", { name: "Book this lane" })).toHaveCount(0);
  await ctx.close();
});

test("validation: a bad state, a missing city, a bad size, a huge weight, too long notes or dimensions each show an error and leave NO row", async ({ browser }) => {
  const notes = uniq(RATE_MARK);
  const { ctx, page } = await as(browser, "maria");
  await gotoSteady(page, "/rates");
  const before = await rateCountOf(mariaId);
  const base = { pc: "Toronto", dc: uniq("VALB"), size: 53 as const, notes };
  const cases: { name: string; input: Parameters<typeof fillRateForm>[1]; message: RegExp; hidden?: string }[] = [
    { name: "bad pickup state", input: { ...base, ps: "ZZ" }, message: /Pickup state or province must be a two letter/ },
    { name: "bad delivery state (digit)", input: { ...base, ds: "N1" }, message: /Delivery state or province must be a two letter/ },
    { name: "missing pickup city", input: { ...base, pc: "" }, message: /Pickup city is required/ },
    { name: "missing delivery city", input: { ...base, dc: "" }, message: /Delivery city is required/ },
    { name: "no equipment size", input: { ...base, size: null }, message: /Choose an equipment size/ },
    { name: "forged equipment size 48", input: base, message: /Choose an equipment size/, hidden: "48" },
    { name: "huge weight", input: { ...base, weight: "1000000" }, message: /Weight must be a whole number of pounds from 1 to 100000/ },
    { name: "decimal weight", input: { ...base, weight: "12.5" }, message: /Weight must be a whole number/ },
    { name: "notes over 1000 characters", input: { ...base, notes: "n".repeat(1001) }, message: /Notes are too long/ },
    { name: "dimensions over 200 characters", input: { ...base, dims: "d".repeat(201) }, message: /Dimensions are too long/ },
  ];
  for (const c of cases) {
    await gotoSteady(page, "/rates");
    await fillRateForm(page, c.input);
    if (c.hidden) await page.evaluate((v) => { (document.querySelector('input[name="equipment_size"]') as HTMLInputElement).value = v; }, c.hidden);
    await submitRequest(page);
    await expect(page.getByRole("alert").filter({ hasText: c.message }), c.name).toBeVisible();
    await expect(page.getByTestId("rate-requested-banner"), `${c.name}: no success banner`).toHaveCount(0);
    expect(await rateCountOf(mariaId), `${c.name}: no row`).toBe(before);
  }
  // the form keeps what was typed after a refusal
  await expect(page.getByLabel("Dimensions (optional)")).toHaveValue("d".repeat(201));
  // control: the same baseline with valid input is accepted, so the refusals above were about the input
  await gotoSteady(page, "/rates");
  await fillRateForm(page, base);
  await submitRequest(page);
  await expect(page.getByTestId("rate-requested-banner")).toBeVisible();
  expect(await rateCountOf(mariaId)).toBe(before + 1);
  await ctx.close();
});

// ---- the admin email --------------------------------------------------------------------------------------------------

test("creating a request sends ONE email to every active staff_admin and to nobody else (not csr, not an inactive admin, not customers)", async ({ browser }) => {
  const notes = `${uniq(RATE_MARK)} <b>bold</b> & "quoted" text`;
  const pc = uniq("MAILA"), dc = uniq("MAILB");
  const { ctx, page } = await as(browser, "maria");
  await gotoSteady(page, "/rates");
  await fillRateForm(page, { pc, ps: "ON", dc, ds: "IL", size: 26, weight: "9000", dims: "20 x 4 ft", notes });
  await submitRequest(page);
  await expect(page.getByTestId("rate-requested-banner")).toBeVisible();
  const [row] = await rateRowByNotes(notes);
  const ref = row.ref as string;
  const mails = await settledMail(`Rate request ${ref}`, 1);
  expect(mails).toHaveLength(1);
  const m = mails[0];
  const expected = await activeEmails(["staff_admin"]);
  expect(expected).toEqual(expect.arrayContaining([ADMIN, admin2.email]));
  expect([...m.to].sort()).toEqual(expected);
  for (const nobody of [csr.email, csrOff.email, adminOff.email, MARIA, cust2.email, otherCust.email]) expect(m.to).not.toContain(nobody);
  expect(m.subject).toBe(`Rate request ${ref}: ${pc}, ON to ${dc}, IL, 26 ft`);
  expect(m.html).toBeUndefined(); // plain text only: user text cannot inject markup
  const body = m.text ?? "";
  for (const part of [`${pc}, ON to ${dc}, IL`, "26 ft", "9000 lbs", "20 x 4 ft", notes, "Mitrex", `${BASE_URL}/admin/rates/${row.id}`]) expect(body).toContain(part);
  // no email went to anyone else about this request
  expect((await sentEmails()).filter((e) => (e.text ?? "").includes(ref) || e.subject.includes(ref))).toHaveLength(1);
  // the same text is shown as text, never as markup, on the staff page
  const s = await as(browser, "admin");
  await gotoSteady(s.page, `/admin/rates/${row.id}`);
  await expect(s.page.getByTestId("rate-ref")).toHaveText(ref);
  await expect(s.page.getByText(notes, { exact: true })).toBeVisible();
  await expect(s.page.locator("main b")).toHaveCount(0);
  await s.ctx.close();
  await ctx.close();
});

test("an email failure never fails the request or the rate: the row is saved and the screen says the email could not be sent", async ({ browser }) => {
  const notes = uniq(RATE_MARK);
  const { ctx, page } = await as(browser, "maria");
  try {
    await setMockStatus(500);
    await gotoSteady(page, "/rates");
    await fillRateForm(page, { pc: uniq("FAILA"), dc: uniq("FAILB"), size: 53, notes });
    await submitRequest(page);
    await expect(page.getByTestId("rate-requested-banner")).toBeVisible();
    const [row] = await rateRowByNotes(notes);
    expect(row.status).toBe("open");
    const s = await as(browser, "admin");
    await gotoSteady(s.page, `/admin/rates/${row.id}`);
    await s.page.getByLabel("Amount").fill("900");
    await s.page.getByRole("button", { name: "Save rate" }).click();
    await expect(s.page.getByTestId("quote-ok")).toContainText("Rate saved. The email to the customer could not be sent");
    expect((await rateRowByNotes(notes))[0]).toMatchObject({ status: "quoted", quoted_amount: 900, quoted_currency: "CAD" });
    await s.ctx.close();
  } finally {
    await setMockStatus(200);
    await ctx.close();
  }
});

// ---- staff enter the rate ---------------------------------------------------------------------------------------------

test("staff enter the rate: the customer is emailed (active customer users only, ONE email, no amount) and sees the amount only after it is quoted", async ({ browser }) => {
  const notes = uniq(RATE_MARK);
  const quoteNote = `${uniq("QNOTE")} fuel included`;
  const row0 = await seedRate({ customerId: mitrexId, requestedBy: mariaId, notes, city: uniq("QA") });
  const m = await as(browser, "maria");
  // before: Waiting for rate, no amount anywhere on the page
  await gotoSteady(m.page, "/rates");
  const mrow = m.page.locator(`[data-testid="rate-row"][data-ref="${row0.ref}"]`);
  await expect(mrow.getByTestId("rate-status")).toHaveText("Waiting for rate");
  await expect(mrow.getByTestId("rate-quote")).toHaveCount(0);
  expect(await mrow.innerText()).not.toMatch(/\d,\d{3}\.\d{2}|CAD|USD/); // no amount or currency on a request that is not quoted yet

  const s = await as(browser, "admin");
  await gotoSteady(s.page, "/admin/rates");
  await expect(s.page.getByRole("heading", { name: "Rate requests", level: 1 })).toBeVisible();
  const srow = s.page.locator(`[data-testid="admin-rate-row"][data-ref="${row0.ref}"]`);
  await expect(srow).toBeVisible();
  await expect(s.page.getByTestId("rates-open").locator(`[data-ref="${row0.ref}"]`)).toHaveCount(1);
  await srow.click();
  await expect(s.page).toHaveURL(new RegExp(`/admin/rates/${row0.id}$`));
  await expect(s.page.getByTestId("rate-ref")).toHaveText(row0.ref);
  await expect(s.page.getByLabel("Currency")).toHaveValue("CAD"); // default currency
  await s.page.getByLabel("Amount").fill("1850.5");
  await s.page.getByLabel("Notes for the customer (optional)").fill(quoteNote);
  const until = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
  await s.page.getByLabel("Valid until (optional)").fill(until);
  await s.page.getByRole("button", { name: "Save rate" }).click();
  await expect(s.page.getByTestId("quote-ok")).toContainText("Rate saved. The customer was emailed that the rate is in the app.");
  const after = (await db().from("rate_requests").select("*").eq("id", row0.id).single()).data!;
  expect(after).toMatchObject({ status: "quoted", quoted_amount: 1850.5, quoted_currency: "CAD", quote_notes: quoteNote, quote_valid_until: until, quoted_by: adminId });
  expect(after.quoted_at).toBeTruthy();
  // the page now shows the existing quote and the correction form
  await expect(s.page.getByTestId("existing-amount")).toHaveText("1,850.50 CAD");

  // the customer email: ONE message to the active customer users of Mitrex, nothing about the amount
  const mails = await settledMail(`Your rate is ready in the app (${row0.ref})`, 1);
  expect(mails).toHaveLength(1);
  const mail = mails[0];
  const expected = await activeEmails(["customer"], mitrexId);
  expect(expected).toEqual(expect.arrayContaining([MARIA, cust2.email]));
  expect([...mail.to].sort()).toEqual(expected);
  for (const nobody of [custOff.email, otherCust.email, ADMIN, admin2.email, csr.email]) expect(mail.to).not.toContain(nobody);
  const text = `${mail.subject}\n${mail.text ?? ""}\n${mail.html ?? ""}`;
  expect(mail.text).toContain(`${BASE_URL}/rates`);
  for (const secret of ["1850", "1,850", "CAD", "USD", quoteNote, "fuel included"]) expect(text, `email must not contain ${secret}`).not.toContain(secret);

  // after: Rate ready with amount, currency, notes, valid until and a plain link to /book
  await gotoSteady(m.page, "/rates");
  const done = m.page.locator(`[data-testid="rate-row"][data-ref="${row0.ref}"]`);
  await expect(done.getByTestId("rate-status")).toHaveText("Rate ready");
  await expect(done.getByTestId("rate-amount")).toHaveText("1,850.50 CAD");
  await expect(done.getByTestId("rate-quote-notes")).toHaveText(quoteNote);
  await expect(done.getByTestId("rate-valid-until")).toContainText("Valid until");
  await expect(done.getByRole("link", { name: "Book this lane" })).toHaveAttribute("href", "/book");
  await expect(done.getByRole("button", { name: "Cancel request" })).toHaveCount(0); // a quoted request cannot be cancelled

  // a correction: after a reload the form is prefilled with the rate, the rate is replaced, the customer gets an update message (still no amount)
  await gotoSteady(s.page, `/admin/rates/${row0.id}`);
  await expect(s.page.getByLabel("Amount")).toHaveValue("1850.50");
  await s.page.getByLabel("Amount").fill("1900");
  await s.page.getByLabel("Currency").selectOption("USD");
  await s.page.getByRole("button", { name: "Correct the rate", exact: true }).click();
  await expect(s.page.getByTestId("quote-ok")).toContainText("Rate corrected.");
  expect((await db().from("rate_requests").select("quoted_amount,quoted_currency,status").eq("id", row0.id).single()).data).toMatchObject({ quoted_amount: 1900, quoted_currency: "USD", status: "quoted" });
  const upd = await settledMail(`Your rate was updated in the app (${row0.ref})`, 1);
  expect(upd).toHaveLength(1);
  expect(`${upd[0].subject}\n${upd[0].text}`).not.toMatch(/1900|1,900|USD/);
  expect((await settledMail(`Your rate is ready in the app (${row0.ref})`, 1))).toHaveLength(1); // the first message was not repeated
  await gotoSteady(m.page, "/rates");
  await expect(m.page.locator(`[data-testid="rate-row"][data-ref="${row0.ref}"]`).getByTestId("rate-amount")).toHaveText("1,900.00 USD");
  await s.ctx.close();
  await m.ctx.close();
});

test("quote entry refusals: 0, negative, text, three decimals and a past date leave the request open and send no email", async ({ browser }) => {
  const notes = uniq(RATE_MARK);
  const r = await seedRate({ customerId: mitrexId, requestedBy: mariaId, notes, city: uniq("QR") });
  const s = await as(browser, "admin");
  await gotoSteady(s.page, `/admin/rates/${r.id}`);
  const cases: [string, string | null, RegExp][] = [
    ["0", null, /greater than 0/], ["-5", null, /greater than 0/], ["abc", null, /greater than 0/], ["1850.999", null, /at most two decimals/],
    ["1850", "2000-01-01", /Valid until cannot be in the past/],
  ];
  for (const [amount, until, message] of cases) {
    await s.page.getByLabel("Amount").fill(amount);
    await s.page.getByLabel("Valid until (optional)").fill(until ?? "");
    await s.page.getByRole("button", { name: "Save rate" }).click();
    await expect(s.page.getByRole("alert").filter({ hasText: message }), `${amount} ${until}`).toBeVisible();
    expect((await db().from("rate_requests").select("status,quoted_amount").eq("id", r.id).single()).data).toMatchObject({ status: "open", quoted_amount: null });
  }
  expect((await sentEmails()).filter((e) => e.subject.includes(r.ref))).toHaveLength(0);
  // control: a valid amount on the same form is accepted
  await s.page.getByLabel("Amount").fill("1850");
  await s.page.getByLabel("Valid until (optional)").fill("");
  await s.page.getByRole("button", { name: "Save rate" }).click();
  await expect(s.page.getByTestId("quote-ok")).toBeVisible();
  expect((await db().from("rate_requests").select("status").eq("id", r.id).single()).data!.status).toBe("quoted");
  await s.ctx.close();
});

test("staff_csr can enter a rate; a csr does not get the new-request email; the quote records the csr", async ({ browser }) => {
  const notes = uniq(RATE_MARK);
  const r = await seedRate({ customerId: mitrexId, requestedBy: mariaId, notes, city: uniq("CSRQ") });
  const { ctx, page } = await anon(browser);
  await loginViaUi(page, csr.email);
  await expect(page).toHaveURL(/\/admin$/);
  const nav = page.locator("header nav");
  await expect(nav.getByRole("link", { name: "Rate requests" })).toBeVisible();
  await nav.getByRole("link", { name: "Rate requests" }).click();
  await expect(page).toHaveURL(/\/admin\/rates$/);
  await page.locator(`[data-testid="admin-rate-row"][data-ref="${r.ref}"]`).click();
  await page.getByLabel("Amount").fill("777");
  await page.getByLabel("Currency").selectOption("USD");
  await page.getByRole("button", { name: "Save rate" }).click();
  await expect(page.getByTestId("quote-ok")).toContainText("Rate saved.");
  expect((await db().from("rate_requests").select("*").eq("id", r.id).single()).data).toMatchObject({ status: "quoted", quoted_amount: 777, quoted_currency: "USD", quoted_by: csr.id });
  await ctx.close();
});

// ---- who can see and do what ------------------------------------------------------------------------------------------

test("another customer cannot see or cancel a request (forged id through the screen and through the API); a colleague of the same customer can", async ({ browser }) => {
  const mine = await seedRate({ customerId: mitrexId, requestedBy: mariaId, notes: uniq(RATE_MARK), city: uniq("OWN") });
  const theirs = await seedRate({ customerId: otherCustomerId, requestedBy: otherCust.id, notes: uniq(RATE_MARK), city: uniq("THEIRS") });
  // API as the other customer: reads only its own, cannot cancel Maria's (reads as not found), row stays open
  const oc = await userClient(otherCust.email);
  const read = await oc.from("rate_requests").select("ref");
  expect(read.error).toBeNull();
  expect(read.data!.map((x) => x.ref)).toContain(theirs.ref); // control: it sees its own
  expect(read.data!.map((x) => x.ref)).not.toContain(mine.ref);
  const forged = await oc.rpc("cancel_rate_request", { p_id: mine.id });
  expect(forged.error?.message).toMatch(/not found/);
  expect((await db().from("rate_requests").select("status").eq("id", mine.id).single()).data!.status).toBe("open");
  // through the screen: Maria's cancel form carries a hidden id; point it at the other customer's request
  const m = await as(browser, "maria");
  await gotoSteady(m.page, "/rates");
  await expect(m.page.locator(`[data-ref="${theirs.ref}"]`)).toHaveCount(0);
  const mrow = m.page.locator(`[data-testid="rate-row"][data-ref="${mine.ref}"]`);
  await mrow.getByRole("button", { name: "Cancel request" }).click();
  await mrow.locator('input[name="id"]').evaluate((el, id) => { (el as HTMLInputElement).value = id; }, theirs.id);
  await mrow.getByRole("button", { name: "Yes, cancel it" }).click();
  await expect(m.page.getByRole("alert").filter({ hasText: "Request not found." })).toBeVisible();
  expect((await db().from("rate_requests").select("status").eq("id", theirs.id).single()).data!.status).toBe("open");
  expect((await db().from("rate_requests").select("status").eq("id", mine.id).single()).data!.status).toBe("open");
  await m.ctx.close();
  // a colleague of the SAME customer sees and can cancel Maria's request
  const c2 = await userClient(cust2.email);
  expect((await c2.from("rate_requests").select("ref").eq("id", mine.id)).data).toHaveLength(1);
  expect((await c2.rpc("cancel_rate_request", { p_id: mine.id })).error).toBeNull();
  expect((await db().from("rate_requests").select("status").eq("id", mine.id).single()).data!.status).toBe("cancelled");
});

test("cancel works only on an own OPEN request: the button is on open rows only, a quoted or cancelled request refuses, and staff see it cancelled", async ({ browser }) => {
  const open = await seedRate({ customerId: mitrexId, requestedBy: mariaId, notes: uniq(RATE_MARK), city: uniq("CXO") });
  const quoted = await seedRate({ customerId: mitrexId, requestedBy: mariaId, notes: uniq(RATE_MARK), city: uniq("CXQ"), status: "quoted", amount: 500 });
  const m = await as(browser, "maria");
  await gotoSteady(m.page, "/rates");
  await expect(m.page.locator(`[data-ref="${quoted.ref}"]`).getByRole("button", { name: "Cancel request" })).toHaveCount(0);
  const row = m.page.locator(`[data-testid="rate-row"][data-ref="${open.ref}"]`);
  await row.getByRole("button", { name: "Cancel request" }).click();
  await row.getByRole("button", { name: "Yes, cancel it" }).click();
  await expect(row.getByTestId("rate-status")).toHaveText("Cancelled");
  await expect(row.getByRole("button", { name: "Cancel request" })).toHaveCount(0);
  expect((await db().from("rate_requests").select("status,quoted_amount").eq("id", open.id).single()).data).toMatchObject({ status: "cancelled", quoted_amount: null });
  // API: cancelling the quoted one and the cancelled one is refused
  const mc = await userClient(MARIA);
  expect((await mc.rpc("cancel_rate_request", { p_id: quoted.id })).error?.message).toMatch(/only an open request/);
  expect((await mc.rpc("cancel_rate_request", { p_id: open.id })).error?.message).toMatch(/only an open request/);
  expect((await db().from("rate_requests").select("status").eq("id", quoted.id).single()).data!.status).toBe("quoted");
  // staff: the cancelled request shows in the Cancelled section and has no rate form; the rate function refuses it
  const s = await as(browser, "admin");
  await gotoSteady(s.page, "/admin/rates");
  await expect(s.page.getByTestId("rates-cancelled").locator(`[data-ref="${open.ref}"]`)).toHaveCount(1);
  await gotoSteady(s.page, `/admin/rates/${open.id}`);
  await expect(s.page.getByText("The customer cancelled this request.")).toBeVisible();
  await expect(s.page.getByRole("button", { name: "Save rate" })).toHaveCount(0);
  const ac = await userClient(ADMIN);
  expect((await ac.rpc("set_rate_quote", { p_id: open.id, p_amount: 100, p_currency: "CAD", p_notes: null, p_valid_until: null })).error?.message).toMatch(/was cancelled/);
  await s.ctx.close();
  await m.ctx.close();
});

test("a customer cannot set quote fields or status, change or delete a request, or call the staff function (direct API calls are refused)", async () => {
  const r = await seedRate({ customerId: mitrexId, requestedBy: mariaId, notes: uniq(RATE_MARK), city: uniq("API") });
  const mc = await userClient(MARIA);
  // guard and control: the customer reads its row and can insert a normal request
  expect((await mc.from("rate_requests").select("ref").eq("id", r.id)).data).toHaveLength(1);
  const base = { customer_id: mitrexId, pickup_city: "A", pickup_state: "ON", delivery_city: "B", delivery_state: "NY", equipment_size: 53, notes: uniq(RATE_MARK) };
  const okIns = await mc.from("rate_requests").insert(base).select("status,requested_by").single();
  expect(okIns.error).toBeNull();
  expect(okIns.data).toMatchObject({ status: "open", requested_by: mariaId });
  const before = (await db().from("rate_requests").select("id", { count: "exact", head: true }).eq("requested_by", mariaId)).count!;
  for (const extra of [{ status: "quoted" }, { quoted_amount: 1 }, { quoted_currency: "CAD" }, { quote_notes: "x" }, { quoted_by: mariaId }, { requested_by: otherCust.id }, { ref: "RQ-9999" }, { id: "99999999-9999-9999-9999-999999999999" }]) {
    const res = await mc.from("rate_requests").insert({ ...base, notes: uniq(RATE_MARK), ...extra });
    expect(res.error?.message, JSON.stringify(extra)).toMatch(/permission denied/);
  }
  // another customer id is refused by the row policy
  expect((await mc.from("rate_requests").insert({ ...base, customer_id: otherCustomerId, notes: uniq(RATE_MARK) })).error?.message).toMatch(/row-level security/);
  expect((await db().from("rate_requests").select("id", { count: "exact", head: true }).eq("requested_by", mariaId)).count).toBe(before);
  // updates and deletes: no grant at all
  expect((await mc.from("rate_requests").update({ status: "quoted", quoted_amount: 1, quoted_currency: "CAD" }).eq("id", r.id)).error?.message).toMatch(/permission denied/);
  expect((await mc.from("rate_requests").update({ status: "cancelled" }).eq("id", r.id)).error?.message).toMatch(/permission denied/);
  expect((await mc.from("rate_requests").delete().eq("id", r.id)).error?.message).toMatch(/permission denied/);
  expect((await mc.rpc("set_rate_quote", { p_id: r.id, p_amount: 1, p_currency: "CAD", p_notes: null, p_valid_until: null })).error?.message).toMatch(/not authorized/);
  expect((await db().from("rate_requests").select("status,quoted_amount").eq("id", r.id).single()).data).toMatchObject({ status: "open", quoted_amount: null });
});

test("carriers see nothing and have no Rates pages; csr and admin read all; staff cannot write directly; customers cannot open the staff pages", async ({ browser }) => {
  const r = await seedRate({ customerId: mitrexId, requestedBy: mariaId, notes: uniq(RATE_MARK), city: uniq("ACL") });
  const carrierEmail = "owner-a@e2e.test";
  const cc = await userClient(carrierEmail);
  const cr = await cc.from("rate_requests").select("id");
  expect(cr.error).toBeNull();
  expect(cr.data).toEqual([]);
  expect((await db().from("rate_requests").select("id", { count: "exact", head: true })).count).toBeGreaterThan(0); // guard: rows exist
  expect((await cc.rpc("set_rate_quote", { p_id: r.id, p_amount: 1, p_currency: "CAD", p_notes: null, p_valid_until: null })).error?.message).toMatch(/not authorized/);
  expect((await cc.rpc("cancel_rate_request", { p_id: r.id })).error?.message).toMatch(/not authorized/);
  expect((await cc.from("rate_requests").insert({ customer_id: mitrexId, pickup_city: "A", pickup_state: "ON", delivery_city: "B", delivery_state: "NY", equipment_size: 53 })).error?.message).toMatch(/row-level security/);
  // csr reads all, cannot write directly, cannot cancel
  const sc = await userClient(csr.email);
  expect((await sc.from("rate_requests").select("ref").eq("id", r.id)).data).toHaveLength(1);
  expect((await sc.from("rate_requests").update({ status: "cancelled" }).eq("id", r.id)).error?.message).toMatch(/permission denied/);
  expect((await sc.rpc("cancel_rate_request", { p_id: r.id })).error?.message).toMatch(/not authorized/);
  // the inactive csr reads nothing
  const so = await userClient(csrOff.email).catch(() => null);
  if (so) expect((await so.from("rate_requests").select("id")).data ?? []).toEqual([]);
  // screens
  const car = await as(browser, "carrierA");
  await gotoSteady(car.page, "/rates");
  await expect(car.page).toHaveURL(/\/my-loads$/);
  await gotoSteady(car.page, "/admin/rates");
  await expect(car.page).toHaveURL(/\/my-loads$/);
  await expect(car.page.locator("header nav").getByRole("link", { name: /Rate/ })).toHaveCount(0);
  await car.ctx.close();
  const mar = await as(browser, "maria");
  await gotoSteady(mar.page, "/admin/rates");
  await expect(mar.page).toHaveURL(/\/loads$/);
  await gotoSteady(mar.page, `/admin/rates/${r.id}`);
  await expect(mar.page).toHaveURL(/\/loads$/);
  await mar.ctx.close();
  const adm = await as(browser, "admin");
  await gotoSteady(adm.page, "/rates");
  await expect(adm.page).toHaveURL(/\/admin$/);
  await gotoSteady(adm.page, "/admin/rates/not-a-uuid");
  await expect(adm.page.getByText(/could not be found|404|This page/i).first()).toBeVisible();
  await adm.ctx.close();
});

test("menu: customers get Rates, staff get Rate requests with the open count on the board, carriers get neither", async ({ browser }) => {
  const m = await as(browser, "maria");
  await gotoSteady(m.page, "/loads");
  const mnav = m.page.locator("header nav");
  await expect(mnav.getByRole("link", { name: "Rates", exact: true })).toBeVisible();
  await expect(mnav.getByRole("link", { name: "Rate requests" })).toHaveCount(0);
  await mnav.getByRole("link", { name: "Rates", exact: true }).click();
  await expect(m.page).toHaveURL(/\/rates$/);
  await m.ctx.close();
  const a = await as(browser, "admin");
  await gotoSteady(a.page, "/admin");
  const anav = a.page.locator("header nav");
  await expect(anav.getByRole("link", { name: "Rate requests" })).toBeVisible();
  await expect(anav.getByRole("link", { name: "Rates", exact: true })).toHaveCount(0);
  const open = (await db().from("rate_requests").select("id", { count: "exact", head: true }).eq("status", "open")).count!;
  await expect(a.page.getByTestId("board-rates-count")).toHaveText(String(open));
  await a.page.getByTestId("board-rates-link").click();
  await expect(a.page).toHaveURL(/\/admin\/rates$/);
  await expect(a.page.getByTestId("rates-open-count")).toHaveText(String(open));
  await a.ctx.close();
  const c = await as(browser, "carrierA");
  await gotoSteady(c.page, "/my-loads");
  await expect(c.page.locator("header nav").getByRole("link", { name: /Rate/ })).toHaveCount(0);
  await c.ctx.close();
});

// ---- rate limit -------------------------------------------------------------------------------------------------------

test("rate limit: 30 requests per 10 minutes per user. The 30th is accepted, the 31st is refused and adds no row", async ({ browser }) => {
  const capUser = await makeUser({ role: "customer", active: true, customerId: mitrexId, tag: "rate-cap" });
  made.push(capUser);
  const rows = Array.from({ length: 29 }, (_, i) => ({
    customer_id: mitrexId, requested_by: capUser.id, pickup_city: `Cap${i}`, pickup_state: "ON", delivery_city: "CapEnd", delivery_state: "NY", equipment_size: 53, notes: `${RATE_MARK}-CAP-${i}`,
  }));
  expect((await db().from("rate_requests").insert(rows)).error).toBeNull();
  expect(await rateCountOf(capUser.id)).toBe(29);
  const { ctx, page } = await anon(browser);
  await loginViaUi(page, capUser.email);
  await gotoSteady(page, "/rates");
  await fillRateForm(page, { pc: "Thirtieth", dc: "Place", size: 53, notes: uniq(RATE_MARK) });
  await submitRequest(page);
  await expect(page.getByTestId("rate-requested-banner")).toBeVisible();
  expect(await rateCountOf(capUser.id)).toBe(30);
  await gotoSteady(page, "/rates");
  await fillRateForm(page, { pc: "Thirtyfirst", dc: "Place", size: 53, notes: uniq(RATE_MARK) });
  await submitRequest(page);
  await expect(page.getByRole("alert").filter({ hasText: "That is a lot of rate requests in a short time (limit 30 in 10 minutes)" })).toBeVisible();
  expect(await rateCountOf(capUser.id)).toBe(30);
  // an older request does not count: age them past the window and the user can ask again
  expect((await db().from("rate_requests").update({ created_at: new Date(Date.now() - 11 * 60_000).toISOString() }).eq("requested_by", capUser.id)).error).toBeNull();
  await gotoSteady(page, "/rates");
  await fillRateForm(page, { pc: "Again", dc: "Place", size: 53, notes: uniq(RATE_MARK) });
  await submitRequest(page);
  await expect(page.getByTestId("rate-requested-banner")).toBeVisible();
  expect(await rateCountOf(capUser.id)).toBe(31);
  await ctx.close();
});

// ---- phone width ------------------------------------------------------------------------------------------------------

test("375px: /rates, /admin/rates and /admin/rates/[id] have no horizontal overflow and every button and field is at least 44px, even with 80 character city names", async ({ browser }) => {
  const longCity = "W".repeat(80);
  const open = await seedRate({ customerId: mitrexId, requestedBy: mariaId, notes: uniq(RATE_MARK), city: longCity.slice(0, 70) });
  const quoted = await seedRate({ customerId: mitrexId, requestedBy: mariaId, notes: uniq(RATE_MARK), city: longCity.slice(0, 70), status: "quoted", amount: 123456.78, currency: "USD", quoteNotes: "N".repeat(300) });
  const audit = async (page: Page, label: string) => {
    await page.waitForLoadState("networkidle");
    const f = await page.evaluate(() => {
      const small: string[] = [];
      document.querySelectorAll("button, input:not([type=hidden]), select, textarea, [role=radio]").forEach((e) => {
        const r = (e as HTMLElement).getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.height < 43.5) small.push(`${(e.textContent || (e as HTMLInputElement).name).trim().slice(0, 20)}=${r.height.toFixed(1)}`);
      });
      return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, small };
    });
    expect(f.overflow, `${label}: horizontal overflow`).toBeLessThanOrEqual(0);
    expect(f.small, `${label}: targets under 44px`).toEqual([]);
  };
  const m = await as(browser, "maria", { width: 375, height: 812 });
  await gotoSteady(m.page, "/rates");
  await expect(m.page.locator(`[data-ref="${quoted.ref}"]`).getByTestId("rate-amount")).toHaveText("123,456.78 USD");
  await audit(m.page, "/rates");
  await m.ctx.close();
  const s = await as(browser, "admin", { width: 375, height: 812 });
  await gotoSteady(s.page, "/admin/rates");
  await expect(s.page.locator(`[data-ref="${open.ref}"]`)).toBeVisible();
  await audit(s.page, "/admin/rates");
  await gotoSteady(s.page, `/admin/rates/${open.id}`);
  await expect(s.page.getByTestId("rate-ref")).toHaveText(open.ref);
  await audit(s.page, "/admin/rates/[id] (open)");
  await gotoSteady(s.page, `/admin/rates/${quoted.id}`);
  await expect(s.page.getByTestId("existing-amount")).toHaveText("123,456.78 USD");
  await audit(s.page, "/admin/rates/[id] (quoted)");
  await s.ctx.close();
});
