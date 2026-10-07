import { expect, test, type Page } from "@playwright/test";
import { adminClient, anon, as, insertLoad, uniq } from "./support/helpers";
import { loginViaUi } from "./support/login";
import { latestCode } from "./support/mail";

async function loadNumbers(page: Page): Promise<string[]> {
  await page.goto("/my-loads");
  await expect(page.getByRole("heading", { name: "My loads" })).toBeVisible();
  const text = await page.locator("body").innerText();
  return [...new Set(text.match(/\b\d{12,}\b/g) ?? [])].sort(); // seeded ITS numbers (digits)
}

test("owner adds a driver, driver signs in and sees the same loads, owner removes the driver", async ({ browser }) => {
  const email = `drv-${Date.now().toString(36)}-${process.pid}@e2e.test`;
  const name = uniq("Driver");
  const a = await insertLoad({ po: uniq("TEAM"), status: "booked" });
  const b = await insertLoad({ po: uniq("TEAM"), status: "at_pickup" });

  const owner = await as(browser, "carrierA");
  await owner.page.goto("/team");
  await owner.page.getByLabel("Driver email").fill(email);
  await owner.page.getByLabel("Full name (optional)").fill(name);
  await owner.page.getByRole("button", { name: "Add driver" }).click();
  await expect(owner.page.getByText(`${name} was added.`)).toBeVisible();

  const db = adminClient();
  const added = await db.from("profiles").select("id,role,carrier_id").eq("email", email).single();
  expect(added.data?.role).toBe("carrier_driver");
  const ownerProfile = await db.from("profiles").select("carrier_id").eq("email", "owner-a@e2e.test").single();
  expect(added.data?.carrier_id).toBe(ownerProfile.data?.carrier_id);
  const driverId = added.data!.id as string;

  // The driver signs in through the real code login UI and lands in the carrier app.
  const driver = await anon(browser);
  await loginViaUi(driver.page, email);
  await driver.page.goto("/my-loads");
  await expect(driver.page).toHaveURL(/\/my-loads$/);
  const driverList = await loadNumbers(driver.page);
  const ownerList = await loadNumbers(owner.page);
  expect(ownerList).toContain(a.loadNumber);
  expect(ownerList).toContain(b.loadNumber);
  expect(driverList).toEqual(ownerList);

  // A second, unused code is requested before removal so it can be replayed after.
  const spare = await anon(browser);
  await spare.page.goto("/login");
  const sentAt = Date.now();
  await spare.page.getByTestId("login-email").fill(email);
  await spare.page.getByTestId("login-send").click();
  const staleCode = await latestCode(email, sentAt);
  await spare.ctx.close();

  // Owner removes the driver.
  await owner.page.goto("/team");
  const row = owner.page.locator("li").filter({ hasText: email });
  await row.getByRole("button", { name: "Remove" }).click();
  await row.getByRole("button", { name: "Yes, remove" }).click();
  await expect(owner.page.getByText(`${name} was removed.`)).toBeVisible();
  await expect.poll(async () => (await db.from("profiles").select("id").eq("id", driverId)).data?.length).toBe(0);
  expect((await db.auth.admin.getUserById(driverId)).data.user).toBeNull();
  await owner.ctx.close();

  // The driver's existing session is sent to /login.
  await driver.page.goto("/my-loads");
  await driver.page.waitForURL(/\/login/);
  await driver.ctx.close();

  // The code login does not work for the deleted user: no new code mail, and the old code is refused.
  const again = await anon(browser);
  await again.page.goto("/login");
  const sent2 = Date.now();
  await again.page.getByTestId("login-email").fill(email);
  await again.page.getByTestId("login-send").click();
  await again.page.getByTestId("login-code").waitFor();
  await expect(latestCode(email, sent2, 4000, 0)).rejects.toThrow(/no code mail/);
  await again.page.getByTestId("login-code").fill(staleCode);
  await expect(again.page.getByTestId("login-error")).toBeVisible();
  await expect(again.page).toHaveURL(/\/login/);
  await again.page.goto("/my-loads");
  await again.page.waitForURL(/\/login/);
  await again.ctx.close();
});
