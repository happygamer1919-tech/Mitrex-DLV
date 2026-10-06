import { expect, test, type Page } from "@playwright/test";
import { adminClient, anon, as, insertLoad, uniq } from "./support/helpers";
import { loginViaUi } from "./support/login";

// R26 staff managers (locations, carriers, users), R4 roles (a CSR is not an admin), R36 deactivation.
// Everything is created with fresh unique names and removed again at the end. State is read back through
// the service role. The tests share fixtures (the carrier, the invited users), so they run in order.

test.describe.configure({ mode: "serial", timeout: 150_000 });

const db = () => adminClient();
const createdUsers: string[] = [];
const createdLocations: string[] = [];
let carrierId = "";
let carrierName = "";
let carrierRenamed = "";

function freshEmail(tag: string): string {
  return `${tag}-${Date.now().toString(36)}-${process.pid}-${Math.floor(Math.random() * 1e6).toString(36)}@e2e.test`.toLowerCase();
}

test.afterAll(async () => {
  const d = db();
  for (const id of createdUsers) await d.auth.admin.deleteUser(id).catch(() => {});
  if (createdLocations.length) await d.from("locations").delete().in("id", createdLocations);
  if (carrierId) await d.from("carriers").delete().eq("id", carrierId);
});

const locCard = (page: Page, name: string) => page.locator("div.rounded-\\[16px\\]").filter({ has: page.getByText(name, { exact: true }) });

// ---- locations --------------------------------------------------------------------------------

test("staff_admin creates, edits and deactivates a location; a postal-less one is highlighted for review", async ({ browser }) => {
  const name = uniq("E2E-MGR-LOC");
  const { ctx, page } = await as(browser, "admin");
  await page.goto("/admin/locations");

  await page.getByRole("button", { name: "New location" }).click();
  const form = page.locator("form").filter({ has: page.getByLabel("Address line") });
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByLabel("Address line").fill("9 Manager Way");
  await form.getByLabel("City", { exact: true }).fill("Createville");
  await form.getByRole("button", { name: "Create location" }).click();
  await expect(form).toHaveCount(0); // the form closes once the location is saved

  const created = await db().from("locations").select("id,name,city,province,postal_code,can_ship,can_receive,needs_review,is_active").eq("name", name).single();
  expect(created.error).toBeNull();
  createdLocations.push(created.data!.id as string);
  expect(created.data).toMatchObject({ city: "Createville", province: "ON", postal_code: null, can_ship: true, can_receive: true, needs_review: true, is_active: true });

  // Filter to the one location. Highlighted: amber border, the "Needs review" badge, and the page notice.
  await page.getByLabel("Search").fill(name);
  const card = locCard(page, name);
  await expect(card).toHaveCount(1);
  await expect(card.getByText("Needs review", { exact: true })).toBeVisible();
  expect(await card.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe("rgb(242, 140, 40)"); // amber #F28C28
  await expect(page.getByText(/locations? needs? review \(missing postal code\)/)).toBeVisible();

  // Edit: new city and a postal code (typed lower case, stored upper case), review flag cleared.
  await card.getByRole("button", { name: "Edit" }).click();
  const edit = card.locator("form");
  await edit.getByLabel("City", { exact: true }).fill("Editville");
  await edit.getByLabel("Postal code").fill("m5v 2t6");
  await edit.getByLabel("Needs review").uncheck();
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => (await db().from("locations").select("city,postal_code,needs_review").eq("id", created.data!.id).single()).data)
    .toEqual({ city: "Editville", postal_code: "M5V 2T6", needs_review: false });
  await expect(locCard(page, name).getByText("Needs review", { exact: true })).toHaveCount(0);
  expect(await locCard(page, name).evaluate((el) => getComputedStyle(el).borderTopColor)).not.toBe("rgb(242, 140, 40)");
  // Saving again without a postal code puts the review flag back by itself.
  await locCard(page, name).getByRole("button", { name: "Edit" }).click();
  await locCard(page, name).locator("form").getByLabel("Postal code").fill("");
  await locCard(page, name).locator("form").getByLabel("Needs review").uncheck();
  await locCard(page, name).locator("form").getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => (await db().from("locations").select("needs_review").eq("id", created.data!.id).single()).data?.needs_review).toBe(true);
  await expect(locCard(page, name).getByText("Needs review", { exact: true })).toBeVisible();

  // Deactivate: Maria no longer sees it in /book. Activate: she does again (control for the check).
  const maria = await as(browser, "maria");
  const offered = async () => {
    await maria.page.goto("/book");
    return maria.page.getByLabel("Pickup location").locator("option", { hasText: name }).count();
  };
  expect(await offered()).toBe(1);
  await locCard(page, name).getByRole("button", { name: "Deactivate" }).click();
  await expect.poll(async () => (await db().from("locations").select("is_active").eq("id", created.data!.id).single()).data?.is_active).toBe(false);
  await expect(locCard(page, name).getByText("Inactive", { exact: true })).toBeVisible();
  expect(await offered()).toBe(0);
  await locCard(page, name).getByRole("button", { name: "Activate" }).click();
  await expect.poll(async () => (await db().from("locations").select("is_active").eq("id", created.data!.id).single()).data?.is_active).toBe(true);
  expect(await offered()).toBe(1);
  await maria.ctx.close();

  // Delete (unused location): confirm step, then the row is gone.
  await locCard(page, name).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText(`Delete ${name}? This cannot be undone.`)).toBeVisible();
  await page.getByRole("button", { name: "Yes, delete" }).click();
  await expect.poll(async () => (await db().from("locations").select("id").eq("id", created.data!.id)).data?.length).toBe(0);
  await ctx.close();
});

// ---- carriers ---------------------------------------------------------------------------------

test("staff_admin creates, renames and deactivates a carrier", async ({ browser }) => {
  carrierName = uniq("E2E-MGR-CARRIER");
  carrierRenamed = uniq("E2E-MGR-RENAMED");
  const { ctx, page } = await as(browser, "admin");
  await page.goto("/admin/carriers");
  await page.getByLabel("New carrier name").fill(carrierName);
  await page.getByRole("button", { name: "Add carrier" }).click();
  await expect(page.getByText("Created.")).toBeVisible();
  const made = await db().from("carriers").select("id,name,is_active").eq("name", carrierName).single();
  expect(made.data).toMatchObject({ name: carrierName, is_active: true });
  carrierId = made.data!.id as string;

  // Duplicate names are refused with a plain message and no second row.
  await page.getByLabel("New carrier name").fill(carrierName);
  await page.getByRole("button", { name: "Add carrier" }).click();
  await expect(page.getByText(`A carrier named "${carrierName}" already exists.`)).toBeVisible();
  expect((await db().from("carriers").select("id").eq("name", carrierName)).data).toHaveLength(1);

  const row = () => page.locator("li").filter({ has: page.getByText(carrierName, { exact: true }) });
  await row().getByRole("button", { name: "Rename" }).click();
  await row().getByLabel("carrier name").fill(carrierRenamed);
  await row().getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await db().from("carriers").select("name").eq("id", carrierId).single()).data?.name).toBe(carrierRenamed);
  await expect(page.getByText(carrierRenamed, { exact: true })).toBeVisible();
  await expect(page.getByText(carrierName, { exact: true })).toHaveCount(0);
  await ctx.close();
});

// ---- users ------------------------------------------------------------------------------------

async function invite(page: Page, email: string, fullName: string, role: string, scope?: { field: "customer_id" | "carrier_id"; option: string }) {
  await page.goto("/admin/users");
  const form = page.locator("form").filter({ has: page.getByLabel("Full name") });
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Full name").fill(fullName);
  await form.getByLabel("Role").selectOption({ label: role });
  if (scope) await form.locator(`select[name="${scope.field}"]`).selectOption({ label: scope.option });
  await form.getByRole("button", { name: "Add user" }).click();
  await expect(page.getByText(`User created. ${email} can now sign in from the login page.`)).toBeVisible();
}

test("staff_admin invites a customer user for Mitrex and a carrier_owner for a chosen carrier", async ({ browser }) => {
  const custEmail = freshEmail("inv-customer");
  const ownerEmail = freshEmail("inv-owner");
  const { ctx, page } = await as(browser, "admin");

  await invite(page, custEmail, "Invited Customer", "Customer", { field: "customer_id", option: "Mitrex" });
  const mitrex = (await db().from("customers").select("id").eq("name", "Mitrex").single()).data!.id;
  const c = await db().from("profiles").select("id,email,full_name,role,customer_id,carrier_id,is_active").eq("email", custEmail).single();
  expect(c.data).toMatchObject({ full_name: "Invited Customer", role: "customer", customer_id: mitrex, carrier_id: null, is_active: true });
  createdUsers.push(c.data!.id as string);
  expect((await db().auth.admin.getUserById(c.data!.id as string)).data.user?.email).toBe(custEmail);

  await invite(page, ownerEmail, "Invited Owner", "Carrier owner", { field: "carrier_id", option: carrierRenamed });
  const o = await db().from("profiles").select("id,role,customer_id,carrier_id,is_active").eq("email", ownerEmail).single();
  expect(o.data).toMatchObject({ role: "carrier_owner", customer_id: null, carrier_id: carrierId, is_active: true });
  createdUsers.push(o.data!.id as string);

  // The same address cannot be invited twice.
  await page.goto("/admin/users");
  const form = page.locator("form").filter({ has: page.getByLabel("Full name") });
  await form.getByLabel("Email").fill(custEmail);
  await form.getByLabel("Full name").fill("Invited Again");
  await form.getByRole("button", { name: "Add user" }).click();
  await expect(page.getByText("This email cannot be added. Use a different email address.")).toBeVisible();
  expect((await db().from("profiles").select("id").eq("email", custEmail)).data).toHaveLength(1);

  await ctx.close();

  // The invited carrier owner can really sign in and lands in the carrier app.
  const owner = await anon(browser);
  await loginViaUi(owner.page, ownerEmail);
  await expect(owner.page).toHaveURL(/\/my-loads/);
  await owner.ctx.close();
});

test("deactivating a user ends their access at once; reactivating restores it", async ({ browser }) => {
  const email = freshEmail("deact");
  const admin = await as(browser, "admin");
  await invite(admin.page, email, "Soon Deactivated", "Customer", { field: "customer_id", option: "Mitrex" });
  const id = (await db().from("profiles").select("id").eq("email", email).single()).data!.id as string;
  createdUsers.push(id);

  // The user signs in through the real code login and reaches a protected page.
  const user = await anon(browser);
  await loginViaUi(user.page, email);
  await user.page.goto("/loads");
  await expect(user.page).toHaveURL(/\/loads$/);
  await expect(user.page.getByRole("heading", { name: "Loads" })).toBeVisible();

  // Admin deactivates (confirm step), both layers flip: profile flag and auth ban.
  await admin.page.goto("/admin/users");
  const row = () => admin.page.locator("li").filter({ hasText: email });
  await row().getByRole("button", { name: "Deactivate" }).click();
  await expect(admin.page.getByText(`Deactivate ${email}?`)).toBeVisible();
  await row().getByRole("button", { name: "Yes, deactivate" }).click();
  await expect.poll(async () => (await db().from("profiles").select("is_active").eq("id", id).single()).data?.is_active).toBe(false);
  const banned = (await db().auth.admin.getUserById(id)).data.user;
  expect(banned?.banned_until).toBeTruthy();
  await expect(row().getByText("Inactive", { exact: true })).toBeVisible();

  // The existing session no longer opens a protected page: the user is sent to /login (never the loads page).
  for (const path of ["/loads", "/book", "/locations"]) {
    await user.page.goto(path);
    await user.page.waitForURL(/\/login/);
  }
  await expect(user.page.getByRole("heading", { name: "Loads" })).toHaveCount(0);

  // Reactivate: profile and ban both come back and the same user can use the portal again.
  await row().getByRole("button", { name: "Reactivate" }).click();
  await expect(admin.page.getByText(`Reactivate ${email}?`)).toBeVisible();
  await row().getByRole("button", { name: "Yes, reactivate" }).click();
  await expect.poll(async () => (await db().from("profiles").select("is_active").eq("id", id).single()).data?.is_active).toBe(true);
  expect((await db().auth.admin.getUserById(id)).data.user?.banned_until ?? null).toBeNull();
  const again = await anon(browser);
  await loginViaUi(again.page, email);
  await again.page.goto("/loads");
  await expect(again.page).toHaveURL(/\/loads$/);
  await again.ctx.close();
  await user.ctx.close();
  await admin.ctx.close();
});

test("a deactivated carrier cannot be assigned and is not offered for new carrier users", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("MGR-INACT"), status: "requested" });
  const { ctx, page } = await as(browser, "admin");
  await page.goto("/admin/carriers");
  const row = () => page.locator("li").filter({ has: page.getByText(carrierRenamed, { exact: true }) });
  await row().getByRole("button", { name: "Deactivate" }).click();
  await expect.poll(async () => (await db().from("carriers").select("is_active").eq("id", carrierId).single()).data?.is_active).toBe(false);
  await expect(row().getByText("Inactive", { exact: true })).toBeVisible();

  // Not selectable on a load, and not offered when inviting a carrier user.
  await page.goto(`/admin/loads/${id}`);
  const opt = page.getByLabel("Carrier").first().locator("option", { hasText: carrierRenamed });
  await expect(opt).toHaveText(`${carrierRenamed} (inactive)`);
  // (the DOM property: Playwright's own disabled check does not see an <option> in WebKit)
  expect(await opt.evaluate((el) => (el as HTMLOptionElement).disabled)).toBe(true);
  await page.goto("/admin/users");
  const form = page.locator("form").filter({ has: page.getByLabel("Full name") });
  await form.getByLabel("Role").selectOption({ label: "Carrier driver" });
  await expect(form.locator('select[name="carrier_id"]').locator("option", { hasText: carrierRenamed })).toHaveCount(0);
  await ctx.close();
});

// ---- staff_csr is not an admin ----------------------------------------------------------------

test("a staff_csr user reaches /admin but is redirected away from /admin/users and /admin/carriers", async ({ browser }) => {
  const email = freshEmail("csr");
  const d = db();
  const made = await d.auth.admin.createUser({ email, email_confirm: true });
  expect(made.error).toBeNull();
  const id = made.data.user!.id;
  createdUsers.push(id);
  const p = await d.from("profiles").insert({ id, email, full_name: "Test CSR", role: "staff_csr", is_active: true });
  expect(p.error).toBeNull();

  // Real code login; the state is then used for the checks (same engine).
  const { ctx, page } = await anon(browser);
  await loginViaUi(page, email);
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Load board" })).toBeVisible();
  for (const path of ["/admin/calendar", "/admin/locations", "/admin/requests", "/admin/export"]) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
  }

  // Admin only pages bounce to the staff home, and show none of their content.
  for (const path of ["/admin/users", "/admin/carriers"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { name: "Load board" })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Users" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Carriers" })).toHaveCount(0);
  // The navigation does not offer them either.
  const nav = page.locator("header nav");
  await expect(nav.getByRole("link", { name: "Board" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Users" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Carriers" })).toHaveCount(0);

  // Same operational rights as an admin: the CSR can open a load and see the assign control.
  const { id: loadId } = await insertLoad({ po: uniq("MGR-CSR"), status: "requested" });
  await page.goto(`/admin/loads/${loadId}`);
  await expect(page.getByRole("button", { name: "Mark booked" })).toBeVisible();

  // Control: the admin does reach the same two pages.
  const admin = await as(browser, "admin");
  for (const [path, heading] of [["/admin/users", "Users"], ["/admin/carriers", "Carriers"]] as const) {
    await admin.page.goto(path);
    await expect(admin.page).toHaveURL(new RegExp(`${path}$`));
    await expect(admin.page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
  await admin.ctx.close();
  await ctx.close();
});
