import { expect, test, type Browser } from "@playwright/test";
import { adminClient, as, uniq } from "./support/helpers";

type NewLoc = { name: string; city: string; ship: boolean; receive: boolean };

// Maria requests a new location through the form; returns the request id (read from the DB).
async function requestNew(browser: Browser, loc: NewLoc): Promise<string> {
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/locations");
  const form = page.locator("form").filter({ has: page.getByLabel("Location name", { exact: true }) });
  await form.getByLabel("Location name", { exact: true }).fill(loc.name);
  await form.getByLabel("Street address", { exact: true }).fill("1 Test Road");
  await form.getByLabel("City", { exact: true }).fill(loc.city);
  const ship = form.getByLabel("Can ship (pickup)");
  const receive = form.getByLabel("Can receive (delivery)");
  if ((await ship.isChecked()) !== loc.ship) await ship.setChecked(loc.ship);
  if ((await receive.isChecked()) !== loc.receive) await receive.setChecked(loc.receive);
  await form.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByText("Request sent. DLV will review it.").first()).toBeVisible();
  await ctx.close();
  const { data, error } = await adminClient().from("location_requests").select("id,status,kind").eq("payload->>name", loc.name);
  expect(error).toBeNull();
  expect(data?.length).toBe(1);
  expect(data![0]).toMatchObject({ status: "pending", kind: "new" });
  return data![0].id as string;
}

async function staffApprove(browser: Browser, requestId: string) {
  const { ctx, page } = await as(browser, "admin");
  await page.goto("/admin/requests");
  const card = page.locator("form").filter({ has: page.locator(`input[name="id"][value="${requestId}"]`) }).filter({ hasText: "Approve" });
  await card.first().getByRole("button", { name: "Approve" }).click();
  // The pending card is gone once approved.
  await expect(page.locator(`input[name="id"][value="${requestId}"]`)).toHaveCount(0);
  await ctx.close();
  const { data } = await adminClient().from("location_requests").select("status").eq("id", requestId).single();
  expect(data?.status).toBe("approved");
}

test("new location request: approved, then offered in /book only where it can ship or receive", async ({ browser }) => {
  const recv: NewLoc = { name: uniq("E2E-RECV"), city: "Recvville", ship: false, receive: true };
  const shipper: NewLoc = { name: uniq("E2E-SHIP"), city: "Shipton", ship: true, receive: false };

  const recvReq = await requestNew(browser, recv);
  const shipReq = await requestNew(browser, shipper);

  // Not offered before approval.
  const before = await as(browser, "maria");
  await before.page.goto("/book");
  await expect(before.page.getByLabel("Delivery location").locator("option", { hasText: recv.name })).toHaveCount(0);
  await before.ctx.close();

  await staffApprove(browser, recvReq);
  await staffApprove(browser, shipReq);

  const db = adminClient();
  const rows = await db.from("locations").select("name,can_ship,can_receive,is_active").in("name", [recv.name, shipper.name]);
  const byName = Object.fromEntries((rows.data ?? []).map((r) => [r.name, r]));
  expect(byName[recv.name]).toMatchObject({ can_ship: false, can_receive: true, is_active: true });
  expect(byName[shipper.name]).toMatchObject({ can_ship: true, can_receive: false, is_active: true });

  const { ctx, page } = await as(browser, "maria");
  await page.goto("/book");
  const pickup = page.getByLabel("Pickup location");
  const delivery = page.getByLabel("Delivery location");
  await expect(delivery.locator("option", { hasText: recv.name })).toHaveCount(1);
  await expect(pickup.locator("option", { hasText: recv.name })).toHaveCount(0);
  await expect(pickup.locator("option", { hasText: shipper.name })).toHaveCount(1);
  await expect(delivery.locator("option", { hasText: shipper.name })).toHaveCount(0);
  await ctx.close();
});

test("address change request: approval applies the payload to the location", async ({ browser }) => {
  const name = uniq("E2E-CHG");
  const oldAddress = `${Date.now() % 100000} Old Street`;
  const db = adminClient();
  const ins = await db.from("locations").insert({
    name, address_line: oldAddress, city: "Oldtown", province: "ON", postal_code: "A1A 1A1",
    can_ship: true, can_receive: true,
  }).select("id").single();
  expect(ins.error).toBeNull();
  const locId = ins.data!.id as string;

  const newAddress = `${Date.now() % 100000} New Avenue`;
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/locations");
  const form = page.locator("form").filter({ has: page.getByLabel("New street address", { exact: true }) });
  await form.locator("select").selectOption({ label: name });
  await form.getByLabel("New street address", { exact: true }).fill(newAddress);
  await form.getByLabel("New city", { exact: true }).fill("Newtown");
  await form.getByLabel("New postal code", { exact: true }).fill("B2B 2B2");
  await form.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByText("Request sent. DLV will review it.").first()).toBeVisible();
  await ctx.close();

  const req = await db.from("location_requests").select("id,status,kind").eq("location_id", locId);
  expect(req.data?.length).toBe(1);
  expect(req.data![0]).toMatchObject({ kind: "change", status: "pending" });
  // Unchanged until staff approves.
  expect((await db.from("locations").select("city").eq("id", locId).single()).data?.city).toBe("Oldtown");

  await staffApprove(browser, req.data![0].id as string);

  const row = (await db.from("locations").select("name,address_line,city,province,postal_code").eq("id", locId).single()).data;
  expect(row).toEqual({ name, address_line: newAddress, city: "Newtown", province: "ON", postal_code: "B2B 2B2" });

  const after = await as(browser, "maria");
  await after.page.goto("/locations");
  await expect(after.page.getByText(`${newAddress}, Newtown, ON B2B 2B2`)).toBeVisible();
  await expect(after.page.getByText(oldAddress)).toHaveCount(0);
  await after.ctx.close();
});
