import { expect, test } from "@playwright/test";
import { adminClient, as, insertBookedLoad, isoDate, PNG_1X1 } from "./support/helpers";
import { CARRIER_A } from "./support/users";

test.describe.configure({ mode: "serial" });

const PO = `E2E-${Date.now()}`;
let loadId = "";
let loadNumber = "";

test("SAMIH locks the Moffett toggle ON", async ({ browser }) => {
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/book");
  const moffett = page.getByLabel(/Moffett/);
  await expect(moffett).not.toBeChecked();
  await expect(moffett).toBeEnabled();
  await page.getByLabel("Delivery location").selectOption({ label: "SAMIH (Scarborough)" });
  await expect(moffett).toBeChecked();
  await expect(moffett).toBeDisabled();
  await ctx.close();
});

test("Maria books a load: window pickup, appointment delivery", async ({ browser }) => {
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/book");
  await page.getByLabel("Pickup location").selectOption({ label: "Mitrex (Toronto)" });
  await page.getByLabel("Delivery location").selectOption({ label: "Howden (Scarborough)" });

  const names = page.getByLabel("Contact name");
  const phones = page.getByLabel("Contact phone");
  await names.nth(0).fill("Pat Pickup");
  await phones.nth(0).fill("416-555-0101");
  await names.nth(1).fill("Dee Delivery");
  await phones.nth(1).fill("416-555-0102");

  await page.getByRole("radiogroup", { name: "Pickup timing" }).getByRole("radio", { name: "Time window" }).click();
  await page.getByLabel("Pickup date").fill(isoDate(3));
  await page.getByLabel("Window from (ET)").fill("08:00");
  await page.getByLabel("Window to (ET)").fill("11:00");

  await page.getByRole("radiogroup", { name: "Delivery timing" }).getByRole("radio", { name: "Appointment" }).click();
  await page.getByLabel("Delivery date").fill(isoDate(3));
  await page.getByLabel("Appointment time (ET)").fill("14:00");

  await page.getByRole("radiogroup", { name: "Equipment size" }).getByRole("radio", { name: /48/ }).click();
  await page.getByLabel("PO number (optional)").fill(PO);
  await page.getByRole("button", { name: "Request load" }).click();

  await page.waitForURL(/\/loads\/[0-9a-f-]{36}$/);
  loadId = page.url().split("/").pop()!;
  loadNumber = (await page.getByText(/MTX-\d+/).first().innerText()).match(/MTX-\d+/)![0];
  await expect(page.getByText("Requested").first()).toBeVisible();
  await expect(page.getByText(/window/i).first()).toBeVisible();
  await ctx.close();
});

test("staff assigns carrier A and marks booked", async ({ browser }) => {
  const { ctx, page } = await as(browser, "admin");
  await page.goto(`/admin/loads/${loadId}`);
  await page.getByLabel("Carrier").first().selectOption({ label: CARRIER_A });
  await page.getByRole("button", { name: "Save carrier" }).click();
  await expect(page.getByText(CARRIER_A).first()).toBeVisible();
  await page.getByRole("button", { name: "Mark booked" }).click();
  await expect(page.getByText("Booked").first()).toBeVisible();
  await expect(page.getByText("BOL pending").first()).toBeVisible();
  await ctx.close();
});

test("Maria sees the contact-DLV message while the load is booked", async ({ browser }) => {
  const { ctx, page } = await as(browser, "maria");
  await page.goto(`/loads/${loadId}`);
  await expect(page.getByTestId("load-state-note")).toHaveText("Contact DLV to change this load");
  await expect(page.getByRole("link", { name: "Edit load" })).toHaveCount(0);
  await ctx.close();
});

test("carrier A sees the load, carrier B does not", async ({ browser }) => {
  const a = await as(browser, "carrierA");
  await a.page.goto("/my-loads");
  await expect(a.page.getByText(loadNumber).first()).toBeVisible();
  await a.ctx.close();

  const b = await as(browser, "carrierB");
  await b.page.goto("/my-loads");
  await expect(b.page.getByRole("heading").first()).toBeVisible();
  await expect(b.page.getByText(loadNumber)).toHaveCount(0);
  const res = await b.page.goto(`/my-loads/${loadId}`);
  const body = await b.page.content();
  expect(res?.status() === 404 || !body.includes(loadNumber)).toBeTruthy();
  await b.ctx.close();
});

test("carrier walks the status buttons; ETA and POD are required", async ({ browser }) => {
  const { ctx, page } = await as(browser, "carrierA");
  await page.goto(`/my-loads/${loadId}`);

  await page.getByRole("button", { name: "Arrived at pickup" }).click();
  await expect(page.getByRole("button", { name: "Start loading" })).toBeVisible();
  await page.getByRole("button", { name: "Start loading" }).click();
  await expect(page.getByRole("button", { name: "Leave for delivery" })).toBeVisible();

  // Enroute: the ETA modal is required.
  await page.getByRole("button", { name: "Leave for delivery" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const eta = dialog.locator('input[type="datetime-local"]');
  await eta.fill("");
  await dialog.getByRole("button", { name: "Confirm ETA and leave" }).click();
  await expect(dialog.getByText(/ETA/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Arrived at delivery" })).toHaveCount(0);
  await eta.fill(`${isoDate(3)}T15:30`);
  await dialog.getByRole("button", { name: "Confirm ETA and leave" }).click();
  await expect(page.getByRole("button", { name: "Arrived at delivery" })).toBeVisible();

  await page.getByRole("button", { name: "Arrived at delivery" }).click();
  await expect(page.getByRole("button", { name: "Mark delivered" })).toBeVisible();

  // Delivered: blocked without a POD photo.
  await page.getByRole("button", { name: "Mark delivered" }).click();
  const pod = page.getByRole("dialog");
  await pod.getByRole("button", { name: "Mark delivered" }).click();
  await expect(pod.getByText("Take a photo of the signed POD to mark this load delivered.")).toBeVisible();
  await expect(page.getByText("Delivered", { exact: true })).toHaveCount(0);

  // With a photo it passes.
  await pod.locator('input[type="file"]').setInputFiles({ name: "pod.png", mimeType: "image/png", buffer: PNG_1X1 });
  await pod.getByRole("button", { name: "Mark delivered" }).click();
  await expect(page.getByRole("button", { name: "Mark delivered" })).toHaveCount(0, { timeout: 30_000 });
  const db = adminClient();
  await expect.poll(async () => (await db.from("loads").select("status").eq("id", loadId).single()).data?.status, { timeout: 15_000 }).toBe("delivered");
  const pods = await db.from("load_documents").select("id").eq("load_id", loadId).eq("kind", "pod");
  expect(pods.data?.length).toBe(1);
  await ctx.close();
});

test("Maria sees status and ETA", async ({ browser }) => {
  const { ctx, page } = await as(browser, "maria");
  await page.goto(`/loads/${loadId}`);
  await expect(page.getByText("Delivered").first()).toBeVisible();
  await expect(page.getByRole("link", { name: /View POD/ })).toBeVisible();
  const note = page.getByTestId("load-state-note");
  await expect(note).toHaveCount(1);
  await expect(note).toContainText(/^Delivered on /);
  await expect(page.getByText("Contact DLV to change this load")).toHaveCount(0);
  await expect(page.getByText(/^ETA$/).first()).toBeVisible();
  const eta = (await adminClient().from("loads").select("eta").eq("id", loadId).single()).data?.eta;
  expect(eta).toBeTruthy();
  await expect(page.getByText(CARRIER_A).first()).toBeVisible();
  await ctx.close();
});

test("cancelled load shows Cancelled, not the contact-DLV message", async ({ browser }) => {
  const id = await insertBookedLoad(`CXL-${Date.now()}`, "cancelled");
  const { ctx, page } = await as(browser, "maria");
  await page.goto(`/loads/${id}`);
  await expect(page.getByTestId("load-state-note")).toContainText(/^Cancelled on /);
  await expect(page.getByText("Contact DLV to change this load")).toHaveCount(0);
  await ctx.close();
});

test("requested load shows no state note and offers Edit", async ({ browser }) => {
  const id = await insertBookedLoad(`REQ-${Date.now()}`, "requested");
  const { ctx, page } = await as(browser, "maria");
  await page.goto(`/loads/${id}`);
  await expect(page.getByTestId("load-state-note")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Edit load" })).toBeVisible();
  await ctx.close();
});
