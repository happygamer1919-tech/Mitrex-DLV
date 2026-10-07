import { expect, test } from "@playwright/test";
import { as, forceStatus, insertLoad, loadRow, staffBook, uniq, uniqIts } from "./support/helpers";
import { CARRIER_A } from "./support/users";

test("Maria's list shows Booked within 5 s of staff booking, without a reload", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("RT"), status: "requested" });

  const maria = await as(browser, "maria");
  const frames: string[] = [];
  maria.page.on("websocket", (ws) => ws.on("framereceived", (f) => frames.push(String(f.payload))));
  await maria.page.goto("/loads");
  const card = maria.page.locator(`a[href="/loads/${id}"]`);
  await expect(card).toContainText("Requested");
  // The Realtime channel is subscribed before staff acts.
  await expect.poll(() => frames.some((f) => f.includes("Subscribed to PostgreSQL")), { timeout: 20_000 }).toBe(true);

  const staff = await as(browser, "admin");
  await staff.page.goto(`/admin/loads/${id}`);
  await staff.page.getByLabel("Carrier").first().selectOption({ label: CARRIER_A });
  await staff.page.getByRole("button", { name: "Save carrier" }).click();
  await expect(staff.page.getByText("Carrier", { exact: true }).first()).toBeVisible();
  await expect.poll(async () => (await loadRow(id)).carrier_id, { timeout: 15_000 }).not.toBeNull();
  await staffBook(staff.page, uniqIts());
  await expect.poll(async () => (await loadRow(id)).status, { timeout: 15_000 }).toBe("booked");

  // No reload and no goto on Maria's page from here on.
  await expect(card).toContainText("Booked", { timeout: 5000 });
  await expect(card).not.toContainText("Requested");
  // And it was Realtime that carried it (the 15 s poll sends no websocket frame about this load).
  const hit = frames.some((f) => f.includes(id) && f.includes("booked"));
  expect(hit, `frames: ${JSON.stringify(frames.map((f) => f.slice(0, 300)).slice(-6))}`).toBe(true);
  await staff.ctx.close();
  await maria.ctx.close();
});

// R19 fallback: with the Realtime socket blocked, the 15 second poll alone brings the change to an open page.
test("Realtime blocked: the 15 s poll still shows Booked on an open page without a reload", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("RTPOLL"), status: "requested" });
  const { ctx, page } = await as(browser, "maria");
  await page.routeWebSocket(/.*/, () => {}); // the socket never connects and never delivers a frame
  await page.goto("/loads");
  const card = page.locator(`a[href="/loads/${id}"]`);
  await expect(card).toContainText("Requested");
  await forceStatus(id, "booked");
  expect((await loadRow(id)).status).toBe("booked");
  // No goto, no reload: only the interval (15 s) can repaint the page now. 40 s leaves room for one slow tick.
  await expect(card).toContainText("Booked", { timeout: 40_000 });
  await expect(card).not.toContainText("Requested");
  await ctx.close();
});
