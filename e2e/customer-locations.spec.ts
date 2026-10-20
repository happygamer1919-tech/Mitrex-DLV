import { expect, test, type Locator, type Page } from "@playwright/test";
import { adminClient, as, gotoSteady, uniq } from "./support/helpers";
import { makeLocation, retireLocations } from "./support/book";

// R45 (DLV-041): Maria adds and edits locations herself, at once, without a request. The booking form follows the
// edited flags straight away; staff see who added and who last edited a location. Runs on chromium and webkit.

const made: string[] = [];
test.afterAll(async () => { await retireLocations(made); });

async function mariaId(): Promise<string> {
  const { data } = await adminClient().from("profiles").select("id").eq("email", "maria@e2e.test").single();
  return data!.id as string;
}

const addForm = (page: Page) => page.getByRole("form", { name: "Add location" });
const card = (page: Page, name: string) =>
  page.locator('section[aria-label="Locations"] > *').filter({ has: page.getByRole("heading", { name, exact: true }) });

async function fillLocation(scope: Locator, v: {
  name?: string; street?: string; city?: string; province?: string; postal?: string;
  ship?: boolean; receive?: boolean; moffett?: boolean; contactName?: string; contactPhone?: string; notes?: string;
}) {
  if (v.name !== undefined) await scope.getByLabel("Location name", { exact: true }).fill(v.name);
  if (v.street !== undefined) await scope.getByLabel("Street address", { exact: true }).fill(v.street);
  if (v.city !== undefined) await scope.getByLabel("City", { exact: true }).fill(v.city);
  if (v.province !== undefined) await scope.getByLabel("Province", { exact: true }).fill(v.province);
  if (v.postal !== undefined) await scope.getByLabel("Postal code (optional)").fill(v.postal);
  if (v.ship !== undefined) await scope.getByLabel("Can ship (pickup)").setChecked(v.ship);
  if (v.receive !== undefined) await scope.getByLabel("Can receive (delivery)").setChecked(v.receive);
  if (v.moffett !== undefined) await scope.getByLabel("Needs a Moffett").setChecked(v.moffett);
  if (v.contactName !== undefined) await scope.getByLabel("Default contact name (optional)").fill(v.contactName);
  if (v.contactPhone !== undefined) await scope.getByLabel("Default contact phone (optional)").fill(v.contactPhone);
  if (v.notes !== undefined) await scope.getByLabel("Notes (optional)").fill(v.notes);
}

test("Maria adds a location: active at once, no review, offered in /book where it ships, staff see Added by", async ({ browser }) => {
  const name = uniq("E2E-ML-ADD");
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/locations");
  // The old request flows are gone from her page.
  await expect(page.getByRole("button", { name: "Send request" })).toHaveCount(0);
  await expect(page.getByText(/Request new location|Request address change/)).toHaveCount(0);

  const form = addForm(page);
  await fillLocation(form, {
    name, street: "12 Added Road", city: "Addtown", province: "on", postal: "m1m 1m1",
    ship: true, receive: false, moffett: false, contactName: "Ada Add", contactPhone: "416-555-0123", notes: "Ring the bell",
  });
  await form.getByRole("button", { name: "Add location" }).click();
  await expect(form.getByText(`${name} was added. You can book with it now.`)).toBeVisible();
  await expect(form.getByLabel("Location name", { exact: true })).toHaveValue(""); // the form is ready for the next one
  await expect(card(page, name)).toHaveCount(1);
  await expect(card(page, name).getByText("12 Added Road, Addtown, ON M1M 1M1")).toBeVisible();

  const row = await adminClient().from("locations")
    .select("id,address_line,city,province,postal_code,can_ship,can_receive,requires_moffett,default_contact_name,default_contact_phone,notes,is_active,needs_review,created_by,updated_by")
    .eq("name", name).single();
  expect(row.error).toBeNull();
  made.push(row.data!.id as string);
  expect(row.data).toMatchObject({
    address_line: "12 Added Road", city: "Addtown", province: "ON", postal_code: "M1M 1M1", can_ship: true, can_receive: false,
    requires_moffett: false, default_contact_name: "Ada Add", default_contact_phone: "416-555-0123", notes: "Ring the bell",
    is_active: true, needs_review: false, created_by: await mariaId(), updated_by: null,
  });

  // Offered at once in /book: as a pickup (it ships), not as a delivery (it does not receive), with its contact.
  await page.goto("/book");
  await expect(page.getByLabel("Pickup location").locator("option", { hasText: name })).toHaveCount(1);
  await expect(page.getByLabel("Delivery location").locator("option", { hasText: name })).toHaveCount(0);
  await page.getByLabel("Pickup location").selectOption({ label: `${name} (Addtown)` });
  await expect(page.getByLabel("Contact name").nth(0)).toHaveValue("Ada Add");
  await ctx.close();

  // Staff see who added it.
  const staff = await as(browser, "admin");
  await staff.page.goto("/admin/locations");
  await staff.page.getByLabel("Search").fill(name);
  const staffCard = staff.page.locator("div.rounded-\\[16px\\]").filter({ has: staff.page.getByText(name, { exact: true }) });
  await expect(staffCard.getByTestId("location-added-by")).toHaveText(/^Added by maria, .+ ET$/);
  await expect(staffCard.getByTestId("location-edited-by")).toHaveCount(0);
  await expect(staffCard.getByText("Needs review", { exact: true })).toHaveCount(0);
  await staff.ctx.close();
});

test("a duplicate name says A location with this name already exists. and adds nothing", async ({ browser }) => {
  const existing = await makeLocation({ prefix: "E2E-ML-DUP" });
  made.push(existing.id);
  const other = await makeLocation({ prefix: "E2E-ML-DUP2" });
  made.push(other.id);
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/locations");
  const form = addForm(page);
  await fillLocation(form, { name: existing.name, street: "1 Twice St", city: "Twotown", receive: true });
  await form.getByRole("button", { name: "Add location" }).click();
  await expect(form.getByText("A location with this name already exists.")).toBeVisible();
  const { count } = await adminClient().from("locations").select("id", { count: "exact", head: true }).eq("name", existing.name);
  expect(count).toBe(1);

  // Renaming another location to a taken name is refused the same way, and nothing changes.
  const c = card(page, other.name);
  await c.getByRole("button", { name: `Edit ${other.name}` }).click();
  const edit = c.getByRole("form", { name: `Edit ${other.name}` });
  await edit.getByLabel("Location name", { exact: true }).fill(existing.name);
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(edit.getByText("A location with this name already exists.")).toBeVisible();
  expect((await adminClient().from("locations").select("name").eq("id", other.id).single()).data?.name).toBe(other.name);
  await ctx.close();
});

test("the server checks the form: required fields, ship or receive, the 120 character name and the 1000 character notes", async ({ browser }) => {
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/locations");
  const form = addForm(page);
  await form.getByLabel("Province", { exact: true }).fill("");
  await form.getByLabel("Can receive (delivery)").setChecked(false);
  await form.getByRole("button", { name: "Add location" }).click();
  await expect(form.getByText("Enter a location name.")).toBeVisible();
  await expect(form.getByText("Enter the street address.")).toBeVisible();
  await expect(form.getByText("Enter the city.")).toBeVisible();
  await expect(form.getByText("Enter the two letter province or state code, for example ON.")).toBeVisible();
  await expect(form.getByText("Choose can ship, can receive, or both.")).toBeVisible();

  // The browser stops at the limits (maxlength); remove that to prove the SERVER refuses longer values too.
  const long = uniq("E2E-ML-LONG");
  await form.locator("input, textarea").evaluateAll((els) => els.forEach((e) => e.removeAttribute("maxlength")));
  await fillLocation(form, {
    name: long + "x".repeat(121 - long.length), street: "1 Long Rd", city: "Longville", province: "ON", receive: true,
    notes: "n".repeat(1001),
  });
  await form.getByRole("button", { name: "Add location" }).click();
  await expect(form.getByText("Use at most 120 characters for the name.")).toBeVisible();
  await expect(form.getByText("Use at most 1000 characters for the notes.")).toBeVisible();
  const { count } = await adminClient().from("locations").select("id", { count: "exact", head: true }).like("name", `${long}%`);
  expect(count).toBe(0);
  await ctx.close();
});

test("Maria edits every field; /book follows the flags at once (lists and the Moffett lock); staff see Last edited by", async ({ browser }) => {
  const loc = await makeLocation({ prefix: "E2E-ML-EDIT", contactName: "Old Contact", contactPhone: "416-555-0000" });
  made.push(loc.id);
  const newName = uniq("E2E-ML-EDITED");
  const { ctx, page } = await as(browser, "maria");

  // Before: ships and receives, no Moffett lock when chosen as the delivery.
  await page.goto("/book");
  await expect(page.getByLabel("Pickup location").locator("option", { hasText: loc.name })).toHaveCount(1);
  await page.getByLabel("Delivery location").selectOption({ label: loc.label });
  await expect(page.getByLabel(/Moffett/)).toBeEnabled();

  await page.goto("/locations");
  const c = card(page, loc.name);
  await c.getByRole("button", { name: `Edit ${loc.name}` }).click();
  const edit = c.getByRole("form", { name: `Edit ${loc.name}` });
  // The edit form starts with the saved values.
  await expect(edit.getByLabel("Location name", { exact: true })).toHaveValue(loc.name);
  await expect(edit.getByLabel("Default contact name (optional)")).toHaveValue("Old Contact");
  await fillLocation(edit, {
    name: newName, street: "77 Edited Ave", city: "Editburg", province: "qc", postal: "h2x 1y4",
    ship: false, receive: true, moffett: true, contactName: "New Contact", contactPhone: "514-555-0177", notes: "Dock 3, call first",
  });
  await edit.getByRole("button", { name: "Save changes" }).click();
  const after = card(page, newName);
  await expect(after.getByRole("status")).toHaveText("Saved.");
  await expect(after.getByText("77 Edited Ave, Editburg, QC H2X 1Y4")).toBeVisible();
  await expect(after.getByText("Default contact: New Contact, 514-555-0177")).toBeVisible();
  await expect(after.getByText("Notes: Dock 3, call first")).toBeVisible();
  await expect(after.getByText("Moffett", { exact: true })).toBeVisible();
  await expect(after.getByText("Can ship", { exact: true })).toHaveCount(0);

  const row = await adminClient().from("locations")
    .select("name,address_line,city,province,postal_code,can_ship,can_receive,requires_moffett,default_contact_name,default_contact_phone,notes,is_active,needs_review,updated_by")
    .eq("id", loc.id).single();
  expect(row.data).toEqual({
    name: newName, address_line: "77 Edited Ave", city: "Editburg", province: "QC", postal_code: "H2X 1Y4",
    can_ship: false, can_receive: true, requires_moffett: true, default_contact_name: "New Contact",
    default_contact_phone: "514-555-0177", notes: "Dock 3, call first", is_active: true, needs_review: false,
    updated_by: await mariaId(),
  });

  // The booking form follows at once: no longer a pickup, a delivery under its new name, Moffett locked on.
  await gotoSteady(page, "/book");
  await expect(page.getByLabel("Pickup location").locator("option", { hasText: newName })).toHaveCount(0);
  await page.getByLabel("Delivery location").selectOption({ label: `${newName} (Editburg)` });
  await expect(page.getByLabel(/Moffett/)).toBeDisabled();
  await expect(page.getByLabel(/Moffett/)).toBeChecked();
  await expect(page.getByText(`Required: ${newName} needs a Moffett for unloading or loading.`)).toBeVisible();
  await expect(page.getByLabel("Contact name").nth(1)).toHaveValue("New Contact");
  await ctx.close();

  const staff = await as(browser, "admin");
  await staff.page.goto("/admin/locations");
  await staff.page.getByLabel("Search").fill(newName);
  const staffCard = staff.page.locator("div.rounded-\\[16px\\]").filter({ has: staff.page.getByText(newName, { exact: true }) });
  await expect(staffCard.getByTestId("location-edited-by")).toHaveText(/^Last edited by maria, .+ ET$/);
  await staff.ctx.close();
});

test("Maria is offered no status, review or delete control, and a cancelled edit changes nothing", async ({ browser }) => {
  const loc = await makeLocation({ prefix: "E2E-ML-NOOP" });
  made.push(loc.id);
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/locations");
  const main = page.locator("main");
  await expect(main.getByRole("button", { name: /deactivate|activate|delete|remove|review/i })).toHaveCount(0);
  await expect(main.getByLabel(/active|review/i)).toHaveCount(0);

  const c = card(page, loc.name);
  await c.getByRole("button", { name: `Edit ${loc.name}` }).click();
  const edit = c.getByRole("form", { name: `Edit ${loc.name}` });
  // Exactly the business fields: 7 text fields, 3 checkboxes and the notes; nothing about status or review.
  await expect(edit.locator("input:not([type=checkbox])")).toHaveCount(7);
  await expect(edit.locator("input[type=checkbox]")).toHaveCount(3);
  await expect(edit.locator("textarea")).toHaveCount(1);
  await expect(edit.locator("select")).toHaveCount(0);
  await expect(edit.getByLabel(/active|review/i)).toHaveCount(0);
  await edit.getByLabel("City", { exact: true }).fill("Never Saved");
  await edit.getByRole("button", { name: "Cancel" }).click();
  await expect(c.getByRole("form")).toHaveCount(0);
  expect((await adminClient().from("locations").select("city,updated_by").eq("id", loc.id).single()).data)
    .toEqual({ city: "Testville", updated_by: null });
  await ctx.close();
});

test("375px: the list, the open edit form and the add form errors fit without sideways scrolling, targets 44px", async ({ browser }) => {
  const loc = await makeLocation({ prefix: "E2E-ML-375-" + "W".repeat(40), contactName: "A very long contact name for the phone", contactPhone: "416-555-0199" });
  made.push(loc.id);
  const { ctx, page } = await as(browser, "maria", { width: 375, height: 812 });
  await page.goto("/locations");
  const c = card(page, loc.name);
  await c.getByRole("button", { name: `Edit ${loc.name}` }).click();
  const edit = c.getByRole("form", { name: `Edit ${loc.name}` });
  await edit.getByLabel("Location name", { exact: true }).fill("");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(edit.getByText("Enter a location name.")).toBeVisible();
  await addForm(page).getByRole("button", { name: "Add location" }).click();
  await expect(addForm(page).getByText("Enter a location name.")).toBeVisible();
  const facts = await page.evaluate(() => {
    const small: string[] = [];
    document.querySelectorAll("main button, main input:not([type=checkbox]), main textarea").forEach((e) => {
      const r = (e as HTMLElement).getBoundingClientRect();
      if (r.width > 0 && r.height < 43.5) small.push(`${(e.textContent || (e as HTMLInputElement).name || e.tagName).trim().slice(0, 20)}=${r.height}`);
    });
    return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, small };
  });
  expect(facts.overflow).toBeLessThanOrEqual(0);
  expect(facts.small).toEqual([]);
  await ctx.close();
});
