import { expect, test, type Browser } from "@playwright/test";
import { adminClient, as, uniq } from "./support/helpers";

// R10 and R26: location requests Maria sent BEFORE DLV-041 still reach staff. Since DLV-041 (R45) she adds and edits
// locations herself, so her page no longer has the request forms; such a request is seeded here as she would have sent
// it. Her page lists it read only ("Waiting for DLV") until staff answer, and staff approval on /admin/requests still
// creates or changes the location.

type NewLoc = { name: string; city: string; ship: boolean; receive: boolean };

async function mariaId(): Promise<string> {
  const { data } = await adminClient().from("profiles").select("id").eq("email", "maria@e2e.test").single();
  return data!.id as string;
}

// A pending request exactly as the old form stored it.
async function seedRequest(kind: "new" | "change", payload: Record<string, unknown>, locationId: string | null = null): Promise<string> {
  const { data, error } = await adminClient().from("location_requests").insert({
    kind, location_id: locationId, payload, requested_by: await mariaId(), status: "pending",
  }).select("id").single();
  expect(error).toBeNull();
  return data!.id as string;
}

function newPayload(loc: NewLoc) {
  return {
    name: loc.name, address_line: "1 Test Road", city: loc.city, province: "ON", postal_code: "",
    can_ship: loc.ship, can_receive: loc.receive, requires_moffett: false,
    default_contact_name: "", default_contact_phone: "", notes: "",
  };
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

  const recvReq = await seedRequest("new", newPayload(recv));
  const shipReq = await seedRequest("new", newPayload(shipper));

  // Not offered before approval; Maria sees both requests read only, waiting for DLV, with no request form.
  const before = await as(browser, "maria");
  await before.page.goto("/locations");
  const waiting = before.page.locator('section[aria-label="Requests waiting for DLV"]');
  await expect(waiting.getByText(`New location: ${recv.name}`)).toBeVisible();
  await expect(waiting.getByText(`New location: ${shipper.name}`)).toBeVisible();
  await expect(waiting.locator("li").filter({ hasText: recv.name }).getByText("Waiting for DLV")).toBeVisible();
  await expect(waiting.locator("button, input, select, textarea")).toHaveCount(0);
  await expect(before.page.getByRole("button", { name: "Send request" })).toHaveCount(0);
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
  await page.goto("/locations");
  // Answered requests leave the waiting list.
  await expect(page.getByText(`New location: ${recv.name}`)).toHaveCount(0);
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
  const reqId = await seedRequest("change", { address_line: newAddress, city: "Newtown", postal_code: "B2B 2B2" }, locId);

  const { ctx, page } = await as(browser, "maria");
  await page.goto("/locations");
  await expect(page.locator('section[aria-label="Requests waiting for DLV"]').getByText(`Change for ${name} (address, city, postal code)`)).toBeVisible();
  await ctx.close();
  // Unchanged until staff approves.
  expect((await db.from("locations").select("city").eq("id", locId).single()).data?.city).toBe("Oldtown");

  await staffApprove(browser, reqId);

  const row = (await db.from("locations").select("name,address_line,city,province,postal_code").eq("id", locId).single()).data;
  expect(row).toEqual({ name, address_line: newAddress, city: "Newtown", province: "ON", postal_code: "B2B 2B2" });

  const after = await as(browser, "maria");
  await after.page.goto("/locations");
  await expect(after.page.getByText(`${newAddress}, Newtown, ON B2B 2B2`)).toBeVisible();
  await expect(after.page.getByText(oldAddress)).toHaveCount(0);
  await expect(after.page.getByText(`Change for ${name}`)).toHaveCount(0);
  await after.ctx.close();
});
