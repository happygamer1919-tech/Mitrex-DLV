import { expect, test } from "@playwright/test";
import { adminClient, as, insertLoad, staffBook, uniq, uniqIts } from "./support/helpers";
import { makeLocation, retireLocations } from "./support/book";
import { sentEmails } from "./support/mail-mock";
import { addressWithName, nameIsStreet } from "../src/lib/address";
import { BASE_URL } from "./support/env";
import { CARRIER_A } from "./support/users";

// Card 4 of DLV-021: a location whose name equals its street prints that text once.

test("pure helper: name equal to the street (case and whitespace insensitive) is printed once", () => {
  const base = { city: "Toronto", province: "ON", postal_code: "M5S 1A1" };
  expect(nameIsStreet({ name: "481 University Ave", address_line: "481 University Ave" })).toBe(true);
  expect(nameIsStreet({ name: "481 University Ave", address_line: "  481   UNIVERSITY ave " })).toBe(true);
  expect(nameIsStreet({ name: "Mitrex", address_line: "41 Racine Rd" })).toBe(false);
  expect(nameIsStreet({ name: "", address_line: "41 Racine Rd" })).toBe(false);
  expect(addressWithName({ ...base, name: "481 University Ave", address_line: "481 University Ave" }))
    .toBe("481 University Ave, Toronto, ON M5S 1A1");
  expect(addressWithName({ ...base, name: "481 UNIVERSITY AVE", address_line: "481 university  ave" }))
    .toBe("481 university  ave, Toronto, ON M5S 1A1");
  expect(addressWithName({ ...base, name: "Mitrex", address_line: "41 Racine Rd" }))
    .toBe("Mitrex, 41 Racine Rd, Toronto, ON M5S 1A1");
  expect(addressWithName({ ...base, postal_code: null, name: "Mitrex", address_line: "41 Racine Rd" }))
    .toBe("Mitrex, 41 Racine Rd, Toronto, ON");
});

const twice = (text: string, street: string) => text.split(street).length - 1;

test("assignment email, carrier page, customer page and staff page print the shared name and street once", async ({ browser }) => {
  const cleanup: string[] = [];
  const street = (n: string) => n.toLowerCase(); // same text as the name, different case
  const pickup = await makeLocation({ prefix: "E2E-ADDRP", address: street });
  const delivery = await makeLocation({ prefix: "E2E-ADDRD" }); // control: a name that differs from its street
  cleanup.push(pickup.id, delivery.id);
  try {
    const { id } = await insertLoad({ po: uniq("ADDR"), status: "requested", pickupLocationId: pickup.id, deliveryLocationId: delivery.id });
    const staff = await as(browser, "admin");
    await staff.page.goto(`/admin/loads/${id}`);
    await staff.page.getByLabel("Carrier").first().selectOption({ label: CARRIER_A });
    await staff.page.getByRole("button", { name: "Save carrier" }).click();
    await expect(staff.page.getByText("Carrier assigned.", { exact: true })).toBeVisible();
    const its = uniqIts();
    await staffBook(staff.page, its);
    await expect.poll(async () => (await adminClient().from("loads").select("status").eq("id", id).single()).data?.status).toBe("booked");

    // Email: the pickup line has the street once; the control line keeps name and street.
    let body = "";
    await expect.poll(async () => {
      const m = (await sentEmails()).find((x) => (x.subject ?? "").includes(`Load ${its} assigned`));
      body = m?.text ?? "";
      return body;
    }, { timeout: 15_000 }).not.toBe("");
    const streetText = street(pickup.name);
    expect(body).toContain(`${streetText}, Testville, ON A1A 1A1`);
    expect(twice(body.toLowerCase(), streetText), "street printed once in the email").toBe(1);
    expect(body).toContain(`${delivery.name}, 1 Spec Road, Testville, ON A1A 1A1`);
    expect(body).toContain(`${BASE_URL}/my-loads/${id}`);

    // Staff detail page.
    await staff.page.reload();
    const staffText = (await staff.page.getByRole("heading", { name: "Load details" }).locator("..").innerText()).toLowerCase();
    expect(twice(staffText, streetText), "street printed once on the staff page").toBe(1);
    expect(staffText).toContain("1 spec road");
    await staff.ctx.close();

    // Carrier page: stop card.
    const carrier = await as(browser, "carrierA");
    await carrier.page.goto(`/my-loads/${id}`);
    const stop = (await carrier.page.getByRole("heading", { name: "Pickup" }).locator("..").innerText()).toLowerCase();
    expect(twice(stop, streetText), "street printed once on the carrier stop card").toBe(1);
    const stopB = await carrier.page.getByRole("heading", { name: "Delivery" }).locator("..").innerText();
    expect(stopB).toContain("1 Spec Road");
    await carrier.ctx.close();

    // Customer page.
    const maria = await as(browser, "maria");
    await maria.page.goto(`/loads/${id}`);
    const cust = (await maria.page.getByRole("heading", { name: "Pickup" }).locator("..").innerText()).toLowerCase();
    expect(twice(cust, streetText), "street printed once on the customer page").toBe(1);
    await maria.ctx.close();
  } finally {
    await retireLocations(cleanup);
  }
});
