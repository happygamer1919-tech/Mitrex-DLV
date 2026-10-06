import { expect, test } from "@playwright/test";
import { adminClient, as, forceStatus, insertLoad, loadRow, uniq } from "./support/helpers";

test("customer edits a requested load; the same edit is refused after staff books it", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("EDIT-OLD"), status: "requested", notes: "old notes" });
  const newPo = uniq("EDIT-NEW");
  const newNotes = `new notes ${newPo}`;

  const maria = await as(browser, "maria");
  await maria.page.goto(`/loads/${id}/edit`);
  await maria.page.getByLabel("PO number (optional)").fill(newPo);
  await maria.page.getByLabel("Notes (optional)").fill(newNotes);
  await maria.page.getByRole("button", { name: "Save changes" }).click();
  await maria.page.waitForURL(new RegExp(`/loads/${id}$`));
  await expect(maria.page.getByText(newPo, { exact: true })).toBeVisible();
  await expect(maria.page.getByText(newNotes, { exact: true })).toBeVisible();
  const saved = await loadRow(id);
  expect(saved.po_number).toBe(newPo);
  expect(saved.notes).toBe(newNotes);

  // Open the edit form again while still requested, then staff books the load underneath it.
  await maria.page.goto(`/loads/${id}/edit`);
  const lostPo = uniq("EDIT-LOST");
  await maria.page.getByLabel("PO number (optional)").fill(lostPo);
  await maria.page.getByLabel("Notes (optional)").fill("must not be saved");
  await forceStatus(id, "booked");
  await maria.page.getByRole("button", { name: "Save changes" }).click();
  await expect(maria.page.getByText("This load can no longer be edited. Contact DLV to change this load.")).toBeVisible();
  const after = await loadRow(id);
  expect(after.status).toBe("booked");
  expect(after.po_number).toBe(newPo);
  expect(after.notes).toBe(newNotes);

  // A booked load has no edit entry point: the edit page bounces back to the load.
  await maria.page.goto(`/loads/${id}/edit`);
  await maria.page.waitForURL(new RegExp(`/loads/${id}$`));
  await expect(maria.page.getByRole("link", { name: "Edit load" })).toHaveCount(0);
  await expect(maria.page.getByText("Contact DLV to change this load", { exact: true })).toBeVisible();
  await maria.ctx.close();
});

test("customer cancels a requested load: status cancelled and a timeline entry", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("CXL"), status: "requested" });
  const { ctx, page } = await as(browser, "maria");
  await page.goto(`/loads/${id}`);
  await page.getByRole("button", { name: "Cancel load", exact: true }).click();
  await page.getByRole("button", { name: "Yes, cancel this load" }).click();
  await expect(page.getByText("Cancelled by customer", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel load", exact: true })).toHaveCount(0);

  const row = await loadRow(id);
  expect(row.status).toBe("cancelled");
  expect(row.cancelled_at).toBeTruthy();
  const ev = await adminClient().from("load_events").select("from_status,to_status,note").eq("load_id", id).eq("to_status", "cancelled");
  expect(ev.data).toEqual([{ from_status: "requested", to_status: "cancelled", note: "Cancelled by customer" }]);
  await ctx.close();
});

test("customer cannot cancel a booked load: no button, and the action is refused", async ({ browser }) => {
  // 1) A load that is already booked offers no Cancel button.
  const booked = await insertLoad({ po: uniq("NOCXL"), status: "booked" });
  const a = await as(browser, "maria");
  await a.page.goto(`/loads/${booked.id}`);
  await expect(a.page.getByRole("heading", { name: booked.loadNumber })).toBeVisible();
  await expect(a.page.getByRole("button", { name: /Cancel/ })).toHaveCount(0);
  await expect(a.page.getByText("Contact DLV to change this load", { exact: true })).toBeVisible();
  await a.ctx.close();

  // 2) The server action, reached through the confirm panel of a load that was requested when the
  // page rendered and booked before the click. Realtime and the poll are blocked so the page keeps its stale view.
  const { id } = await insertLoad({ po: uniq("RACE"), status: "requested" });
  const { ctx, page } = await as(browser, "maria");
  await page.routeWebSocket(/.*/, () => {});
  // The 15 s poll refreshes through RSC fetches: block them too so a slow run cannot repaint the page.
  await page.route(/[?&]_rsc=/, (route) => route.abort());
  await page.goto(`/loads/${id}`);
  await page.getByRole("button", { name: "Cancel load", exact: true }).click();
  await expect(page.getByRole("button", { name: "Yes, cancel this load" })).toBeVisible();
  await forceStatus(id, "booked");
  await page.getByRole("button", { name: "Yes, cancel this load" }).click();
  await expect(page.getByText("customers may only cancel their own requested loads")).toBeVisible();
  const row = await loadRow(id);
  expect(row.status).toBe("booked");
  expect(row.cancelled_at).toBeNull();
  const ev = await adminClient().from("load_events").select("id").eq("load_id", id).eq("to_status", "cancelled");
  expect(ev.data).toEqual([]);
  await ctx.close();
});

test("staff can cancel a booked load, with a confirm step", async ({ browser }) => {
  const { id, loadNumber } = await insertLoad({ po: uniq("STAFFCXL"), status: "booked" });
  const { ctx, page } = await as(browser, "admin");
  await page.goto(`/admin/loads/${id}`);
  await page.getByRole("button", { name: "Cancel load", exact: true }).click();
  await expect(page.getByText(`Cancel ${loadNumber}? The customer and carrier will see it as cancelled.`)).toBeVisible();
  // Nothing happened yet: the confirm step is a real gate.
  expect((await loadRow(id)).status).toBe("booked");
  await page.getByRole("button", { name: "Yes, cancel load" }).click();
  await expect.poll(async () => (await loadRow(id)).status, { timeout: 15_000 }).toBe("cancelled");
  const ev = await adminClient().from("load_events").select("from_status,to_status").eq("load_id", id).eq("to_status", "cancelled");
  expect(ev.data).toEqual([{ from_status: "booked", to_status: "cancelled" }]);
  await expect(page.getByRole("button", { name: "Cancel load", exact: true })).toHaveCount(0);
  await ctx.close();
});
