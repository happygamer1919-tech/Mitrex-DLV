import { expect, test } from "@playwright/test";
import { adminClient, as, uniq } from "./support/helpers";
import { makeLocation, retireLocations } from "./support/book";

// R23 /locations: Maria edits the default contact name and phone (and only those) and it feeds /book.

test("Maria edits a location's default contact, it persists and prefills /book; no address editing is offered", async ({ browser }) => {
  const db = adminClient();
  const loc = await makeLocation({ prefix: "E2E-CC", contactName: "Old Name", contactPhone: "416-555-0000" });
  try {
    const { ctx, page } = await as(browser, "maria");
    await page.goto("/locations");
    const card = page.locator('section[aria-label="Locations"] > *').filter({ has: page.getByRole("heading", { name: loc.name, exact: true }) });
    await expect(card).toHaveCount(1);
    await expect(card.getByLabel("Default contact name")).toHaveValue("Old Name");
    await expect(card.getByLabel("Default contact phone")).toHaveValue("416-555-0000");

    // The only editable controls on a location are the two contact fields (no address, city, postal, flags).
    await expect(card.locator("input, textarea, select")).toHaveCount(2);
    await expect(card.getByRole("button", { name: "Save contact" })).toBeDisabled(); // nothing changed yet
    await expect(card.getByLabel(/address|city|postal|province/i)).toHaveCount(0);
    await expect(card.getByRole("button", { name: /edit|address/i })).toHaveCount(0);

    const name = uniq("Casey Contact");
    const phone = "905-555-0142";
    await card.getByLabel("Default contact name").fill(name);
    await card.getByLabel("Default contact phone").fill(phone);
    await card.getByRole("button", { name: "Save contact" }).click();
    await expect(card.getByText("Saved.")).toBeVisible();

    // Authoritative: the row changed in those two columns only.
    const row = await db.from("locations").select("name,address_line,city,province,postal_code,can_ship,can_receive,default_contact_name,default_contact_phone").eq("id", loc.id).single();
    expect(row.data).toEqual({
      name: loc.name, address_line: "1 Spec Road", city: "Testville", province: "ON", postal_code: "A1A 1A1",
      can_ship: true, can_receive: true, default_contact_name: name, default_contact_phone: phone,
    });

    // It survives a reload ...
    await page.reload();
    const again = page.locator('section[aria-label="Locations"] > *').filter({ has: page.getByRole("heading", { name: loc.name, exact: true }) });
    await expect(again.getByLabel("Default contact name")).toHaveValue(name);
    await expect(again.getByLabel("Default contact phone")).toHaveValue(phone);

    // ... and /book uses it, on the pickup side and on the delivery side.
    await page.goto("/book");
    await page.getByLabel("Pickup location").selectOption({ label: loc.label });
    await expect(page.getByLabel("Contact name").nth(0)).toHaveValue(name);
    await expect(page.getByLabel("Contact phone").nth(0)).toHaveValue(phone);
    await page.getByLabel("Delivery location").selectOption({ label: loc.label });
    await expect(page.getByLabel("Contact name").nth(1)).toHaveValue(name);
    await expect(page.getByLabel("Contact phone").nth(1)).toHaveValue(phone);
    await ctx.close();
  } finally {
    await retireLocations([loc.id]);
  }
});
