import { expect, test, type Page } from "@playwright/test";
import { adminClient, as, isoDate, uniq } from "./support/helpers";
import { customerLoadCount, fillBooking, makeLocation, retireLocations, type TestLocation } from "./support/book";

// R20 /book validation and default contacts, R33 the shared header. Every refusal is proved twice:
// the message on the page and an unchanged load count in the database (service role).

let pickup: TestLocation;
let delivery: TestLocation;

test.beforeAll(async () => {
  // Own locations with NO default contact, so the contact fields start empty.
  pickup = await makeLocation({ prefix: "E2E-BVP" });
  delivery = await makeLocation({ prefix: "E2E-BVD" });
});
test.afterAll(async () => {
  await retireLocations([pickup.id, delivery.id]);
});

const submit = (page: Page) => page.getByRole("button", { name: "Request load" }).click();

async function expectRefused(page: Page, before: number, messages: string[]) {
  for (const m of messages) await expect(page.getByText(m, { exact: true })).toBeVisible();
  await expect(page.getByText("Please fix the highlighted fields.")).toBeVisible();
  await expect(page).toHaveURL(/\/book$/);
  // Authoritative: nothing was inserted (a short wait first, so a slow wrong insert would be caught).
  await page.waitForTimeout(1500);
  expect(await customerLoadCount()).toBe(before);
}

test("contacts are required: submit is blocked with field errors and inserts nothing", async ({ browser }) => {
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/book");
  const before = await customerLoadCount();
  await fillBooking(page, { pickup: pickup.label, delivery: delivery.label, po: uniq("BV-CONTACT") });
  await expect(page.getByLabel("Contact name").nth(0)).toHaveValue("");
  await submit(page);
  await expectRefused(page, before, [
    "Pickup contact name is required.", "Pickup contact phone is required.",
    "Delivery contact name is required.", "Delivery contact phone is required.",
  ]);
  // Filling one side clears only that side's errors.
  await page.getByLabel("Contact name").nth(0).fill("Pat");
  await expect(page.getByText("Pickup contact name is required.")).toHaveCount(0);
  await expect(page.getByText("Delivery contact name is required.")).toBeVisible();
  await ctx.close();
});

test("the same pickup and delivery location is refused", async ({ browser }) => {
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/book");
  const before = await customerLoadCount();
  await fillBooking(page, {
    pickup: pickup.label, delivery: pickup.label, // this location can both ship and receive
    pickupContact: ["Pat", "416-555-0101"], deliveryContact: ["Dee", "416-555-0102"], po: uniq("BV-SAME"),
  });
  await submit(page);
  await expectRefused(page, before, ["Pickup and delivery must be different locations."]);
  await ctx.close();
});

test("a delivery date before the pickup date is refused", async ({ browser }) => {
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/book");
  const before = await customerLoadCount();
  await fillBooking(page, {
    pickup: pickup.label, delivery: delivery.label,
    pickupContact: ["Pat", "416-555-0101"], deliveryContact: ["Dee", "416-555-0102"],
    pickupDate: isoDate(6), deliveryDate: isoDate(4), po: uniq("BV-ORDER"),
  });
  await submit(page);
  await expectRefused(page, before, ["Delivery date cannot be before the pickup date."]);
  // Control: the same form with the delivery on the pickup day is accepted (the refusal was the date).
  await page.getByLabel("Delivery date").fill(isoDate(6));
  await submit(page);
  await page.waitForURL(/\/loads\/[0-9a-f-]{36}$/);
  expect(await customerLoadCount()).toBe(before + 1);
  await ctx.close();
});

test("a pickup window that ends before it starts is refused", async ({ browser }) => {
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/book");
  const before = await customerLoadCount();
  await fillBooking(page, {
    pickup: pickup.label, delivery: delivery.label,
    pickupContact: ["Pat", "416-555-0101"], deliveryContact: ["Dee", "416-555-0102"],
    pickupWindow: ["11:00", "08:00"], po: uniq("BV-WIN"),
  });
  await submit(page);
  await expectRefused(page, before, ["Pickup window end must be after the start."]);
  // An equal start and end is refused too (a zero length window).
  await page.getByLabel("Window to (ET)").fill("11:00");
  await submit(page);
  await expect(page.getByText("Pickup window end must be after the start.")).toBeVisible();
  expect(await customerLoadCount()).toBe(before);
  await ctx.close();
});

test("a pickup date in the past is refused", async ({ browser }) => {
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/book");
  const before = await customerLoadCount();
  await fillBooking(page, {
    pickup: pickup.label, delivery: delivery.label,
    pickupContact: ["Pat", "416-555-0101"], deliveryContact: ["Dee", "416-555-0102"],
    pickupDate: isoDate(-4), deliveryDate: isoDate(3), po: uniq("BV-PAST"),
  });
  await submit(page);
  await expectRefused(page, before, ["Pickup date cannot be in the past (Eastern time)."]);
  await ctx.close();
});

test("save as default for this location persists the contact and auto-fills the next booking", async ({ browser }) => {
  const db = adminClient();
  const loc = await makeLocation({ prefix: "E2E-BVS" });
  const other = await makeLocation({ prefix: "E2E-BVO" });
  try {
    const name = uniq("Sam Saved");
    const phone = "647-555-0188";
    const { ctx, page } = await as(browser, "maria");
    await page.goto("/book");
    await fillBooking(page, {
      pickup: loc.label, delivery: other.label,
      pickupContact: [name, phone], deliveryContact: ["Dee Delivery", "416-555-0102"], po: uniq("BV-SAVE"),
    });
    // Only the PICKUP box is ticked; the delivery contact must not be saved.
    const boxes = page.getByLabel("Save as default for this location");
    await expect(boxes).toHaveCount(2);
    await boxes.nth(0).check();
    await submit(page);
    await page.waitForURL(/\/loads\/[0-9a-f-]{36}$/);

    const saved = await db.from("locations").select("default_contact_name,default_contact_phone").eq("id", loc.id).single();
    expect(saved.data).toEqual({ default_contact_name: name, default_contact_phone: phone });
    const untouched = await db.from("locations").select("default_contact_name,default_contact_phone").eq("id", other.id).single();
    expect(untouched.data).toEqual({ default_contact_name: null, default_contact_phone: null });

    // The next booking: choosing the location fills the saved contact, and it can still be edited.
    await page.goto("/book");
    await page.getByLabel("Pickup location").selectOption({ label: loc.label });
    await expect(page.getByLabel("Contact name").nth(0)).toHaveValue(name);
    await expect(page.getByLabel("Contact phone").nth(0)).toHaveValue(phone);
    await expect(page.getByLabel("Contact name").nth(1)).toHaveValue("");
    await page.getByLabel("Delivery location").selectOption({ label: other.label });
    await expect(page.getByLabel("Contact name").nth(1)).toHaveValue("");
    await page.getByLabel("Contact name").nth(0).fill("Someone Else");
    await expect(page.getByLabel("Contact name").nth(0)).toHaveValue("Someone Else");
    // Editing for one load without the box does not change the saved default.
    expect((await db.from("locations").select("default_contact_name").eq("id", loc.id).single()).data?.default_contact_name).toBe(name);
    await ctx.close();
  } finally {
    await retireLocations([loc.id, other.id]);
  }
});

// R33: the header shows the wordmark "DLV", a neon dot and "Mitrex shipping portal" on every role's pages.
for (const [who, path] of [["maria", "/loads"], ["admin", "/admin"], ["carrierA", "/my-loads"]] as const) {
  test(`the shared header shows DLV, the neon dot and the portal name (${who} at ${path})`, async ({ browser }) => {
    const { ctx, page } = await as(browser, who);
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    const header = page.locator("header").first();
    await expect(header.getByText("DLV", { exact: true })).toBeVisible();
    await expect(header.getByText("Mitrex shipping portal", { exact: true })).toBeVisible();
    const dot = header.locator('span[aria-hidden="true"]').first();
    await expect(dot).toBeVisible();
    // #2BFF88 is rgb(43, 255, 136); the dot is a filled circle.
    expect(await dot.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(43, 255, 136)");
    expect(await dot.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).not.toBe("0px");
    // Order in the header: DLV, dot, then the portal name.
    const order = await header.locator("a").first().evaluate((a) =>
      [...a.children].map((c) => (c.getAttribute("aria-hidden") ? "dot" : (c.textContent ?? "").trim())));
    expect(order).toEqual(["DLV", "dot", "Mitrex shipping portal"]);
    await ctx.close();
  });
}
