import { expect, test } from "@playwright/test";
import { adminClient, as, insertLoad, uniq } from "./support/helpers";

// R22 /loads status filter and the load timeline (built from load_events) on /loads/[id].

const parked: string[] = [];
test.afterAll(async () => {
  if (parked.length === 0) return;
  await adminClient().from("loads").update({ status: "cancelled" })
    .in("id", parked).in("status", ["booked", "at_pickup", "loading", "enroute", "at_delivery"]);
});

test("the /loads status filter shows only that status, All shows everything, an unknown value is ignored", async ({ browser }) => {
  const mk = async (status: "requested" | "booked" | "cancelled" | "delivered") => {
    const r = await insertLoad({ po: uniq(`LST-${status}`), status });
    parked.push(r.id);
    return r;
  };
  const loads = { requested: await mk("requested"), booked: await mk("booked"), cancelled: await mk("cancelled"), delivered: await mk("delivered") };
  const { ctx, page } = await as(browser, "maria");
  const nav = page.getByRole("navigation", { name: "Filter by status" });
  const shown = async (n: string) => page.getByText(n, { exact: true }).count();

  await page.goto("/loads");
  for (const l of Object.values(loads)) expect(await shown(l.loadNumber), `All shows ${l.loadNumber}`).toBe(1);

  for (const [status, label] of [["booked", "Booked"], ["requested", "Requested"], ["cancelled", "Cancelled"], ["delivered", "Delivered"]] as const) {
    await nav.getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/loads\\?status=${status}$`));
    await expect(page.getByText(loads[status].loadNumber, { exact: true })).toHaveCount(1);
    for (const [other, l] of Object.entries(loads)) {
      if (other !== status) await expect(page.getByText(l.loadNumber, { exact: true }), `${other} hidden under ${status}`).toHaveCount(0);
    }
    // The database agrees about what the filter keeps.
    expect((await adminClient().from("loads").select("status").eq("id", loads[status].id).single()).data?.status).toBe(status);
  }

  await nav.getByRole("link", { name: "All", exact: true }).click();
  await expect(page).toHaveURL(/\/loads$/);
  for (const l of Object.values(loads)) expect(await shown(l.loadNumber)).toBe(1);

  await page.goto("/loads?status=bogus");
  for (const l of Object.values(loads)) expect(await shown(l.loadNumber), `unknown filter shows ${l.loadNumber}`).toBe(1);
  await ctx.close();
});

test("the load page timeline lists the status changes with their notes", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("LST-TL"), status: "booked" });
  parked.push(id);
  const note = uniq("Gate code changed");

  const staff = await as(browser, "admin");
  await staff.page.goto(`/admin/loads/${id}`);
  await staff.page.getByLabel("New status").selectOption({ label: "At pickup" });
  await staff.page.getByLabel("Note (required)").fill(note);
  await staff.page.getByRole("button", { name: "Override status" }).click();
  await expect.poll(async () => (await adminClient().from("load_events").select("note").eq("load_id", id).eq("to_status", "at_pickup")).data?.length).toBe(1);
  await staff.ctx.close();

  const { ctx, page } = await as(browser, "maria");
  await page.goto(`/loads/${id}`);
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  const entry = page.locator("li").filter({ hasText: note });
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText("At pickup");
  await expect(entry).toContainText("from Booked");
  // Entries are in time order: the creation event comes before the change.
  const items = await page.locator("li").filter({ has: page.locator("p") }).allInnerTexts();
  const at = items.findIndex((t) => t.includes(note));
  expect(at).toBeGreaterThan(0);
  await ctx.close();
});
