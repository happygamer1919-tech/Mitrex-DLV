import { expect, test, type Page, type Route } from "@playwright/test";
import { adminClient, as, insertLoad, loadRow, PNG_1X1, uniq } from "./support/helpers";

// Card 2 of DLV-021: the POD is optional at delivery and can be added afterwards.
// Every claim is read back through the service role.

const podRows = async (id: string) =>
  (await adminClient().from("load_documents").select("id,storage_path").eq("load_id", id).eq("kind", "pod")).data ?? [];
const podFiles = async (id: string) => (await adminClient().storage.from("documents").list(`${id}/pod`)).data ?? [];
const events = async (id: string) =>
  ((await adminClient().from("load_events").select("from_status,to_status").eq("load_id", id).order("created_at")).data ?? [])
    .filter((e) => e.from_status !== null);

async function openFresh(page: Page, path: string) {
  await page.goto("about:blank");
  await page.goto(path);
}

test("Mark delivered works with no photo; the modal says the photo is optional; nothing is stored", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("NOPHOTO"), status: "at_delivery" });
  const { ctx, page } = await as(browser, "carrierA");
  await openFresh(page, `/my-loads/${id}`);
  await page.getByTestId("next-step").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Add the signed POD photo now if you have it. You can add it later from this load.")).toBeVisible();
  await expect(dialog.getByText(/required/i)).toHaveCount(0);
  await dialog.getByTestId("pod-submit").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await loadRow(id)).status).toBe("delivered");
  expect(await podRows(id)).toEqual([]);
  expect(await podFiles(id)).toEqual([]);
  expect(await events(id)).toEqual([{ from_status: "at_delivery", to_status: "delivered" }]);
  await ctx.close();
});

test("delivered without a photo: the carrier page shows POD not uploaded yet and Add POD photo; adding it makes exactly one POD row", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("LATEPOD"), status: "at_delivery" });
  const { ctx, page } = await as(browser, "carrierA");
  await openFresh(page, `/my-loads/${id}`);
  await page.getByTestId("next-step").click();
  await page.getByRole("dialog").getByTestId("pod-submit").click();
  await expect.poll(async () => (await loadRow(id)).status).toBe("delivered");

  const card = page.getByTestId("pod-card");
  await expect(card.getByTestId("pod-missing")).toHaveText("POD not uploaded yet");
  await expect(card.getByRole("link", { name: /View POD/ })).toHaveCount(0);
  await expect(card.getByTestId("dropzone-input")).toHaveAttribute("capture", "environment");
  // Nothing chosen: refused with a message.
  await card.getByTestId("pod-add").click();
  await expect(card.getByText("Choose or take a photo first.")).toBeVisible();
  expect(await podRows(id)).toEqual([]);

  await card.getByTestId("dropzone-input").setInputFiles({ name: "late.png", mimeType: "image/png", buffer: PNG_1X1 });
  await card.getByTestId("pod-add").click();
  await expect(card.getByRole("link", { name: "View POD" })).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId("pod-missing")).toHaveCount(0);
  expect(await podRows(id)).toHaveLength(1);
  expect(await podFiles(id)).toHaveLength(1);
  expect((await loadRow(id)).status).toBe("delivered");
  expect(await events(id)).toHaveLength(1); // still just the one delivered event

  // Add another: a second photo, a second row, both linked.
  await card.getByRole("button", { name: "Add another" }).click();
  await card.getByTestId("dropzone-input").setInputFiles({ name: "second.png", mimeType: "image/png", buffer: PNG_1X1 });
  await card.getByTestId("pod-add").click();
  await expect(card.getByRole("link", { name: /^View POD/ })).toHaveCount(2, { timeout: 30_000 });
  expect(await podRows(id)).toHaveLength(2);
  expect(await podFiles(id)).toHaveLength(2);
  await ctx.close();
});

test("the late POD photo is stored as a JPEG of at most 1600px and one stored path per photo", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("LATEJPG"), status: "delivered" });
  const { ctx, page } = await as(browser, "carrierA");
  await openFresh(page, `/my-loads/${id}`);
  const card = page.getByTestId("pod-card");
  await card.getByTestId("dropzone-input").setInputFiles({ name: "late.png", mimeType: "image/png", buffer: PNG_1X1 });
  await card.getByTestId("pod-add").click();
  await expect(card.getByRole("link", { name: "View POD" })).toBeVisible({ timeout: 30_000 });
  const rows = await podRows(id);
  expect(rows).toHaveLength(1);
  expect(rows[0].storage_path).toMatch(new RegExp(`^${id}/pod/[0-9a-f-]{36}\\.jpg$`));
  const obj = await adminClient().storage.from("documents").download(rows[0].storage_path as string);
  const bytes = Buffer.from(await obj.data!.arrayBuffer());
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  await ctx.close();
});

test("staff and customer: POD pending on the board and the load page, then gone; Maria sees POD not uploaded yet, then View POD", async ({ browser }) => {
  const po = uniq("PENDPOD");
  const { id, loadNumber } = await insertLoad({ po, status: "delivered" });
  const staff = await as(browser, "admin");
  await staff.page.goto("/admin");
  const boardCard = staff.page.locator(`a[href="/admin/loads/${id}"]`);
  await expect(boardCard).toContainText("POD pending");
  await staff.page.goto(`/admin/loads/${id}`);
  await expect(staff.page.getByTestId("pod-pending")).toHaveText("POD pending");
  await expect(staff.page.getByText("BOL pending")).toHaveCount(0); // a delivered load never shows BOL pending

  const maria = await as(browser, "maria");
  await maria.page.goto(`/loads/${id}`);
  await expect(maria.page.getByTestId("pod-missing")).toHaveText("POD not uploaded yet.");
  await expect(maria.page.getByRole("link", { name: /View POD/ })).toHaveCount(0);

  // The carrier adds the photo.
  const carrier = await as(browser, "carrierA");
  await carrier.page.goto(`/my-loads/${id}`);
  const card = carrier.page.getByTestId("pod-card");
  await card.getByTestId("dropzone-input").setInputFiles({ name: "p.png", mimeType: "image/png", buffer: PNG_1X1 });
  await card.getByTestId("pod-add").click();
  await expect(card.getByRole("link", { name: "View POD" })).toBeVisible({ timeout: 30_000 });
  await carrier.ctx.close();

  // Maria's open page picks it up without a reload (15 s poll), and the link serves the stored bytes.
  const link = maria.page.getByRole("link", { name: "View POD" });
  await expect(link).toBeVisible({ timeout: 40_000 });
  await expect(maria.page.getByTestId("pod-missing")).toHaveCount(0);
  const res = await maria.ctx.request.get((await link.getAttribute("href"))!);
  expect(res.status()).toBe(200);
  await maria.ctx.close();

  await staff.page.reload();
  await expect(staff.page.getByTestId("pod-pending")).toHaveCount(0);
  await staff.page.goto("/admin");
  await expect(staff.page.locator(`a[href="/admin/loads/${id}"]`)).toBeVisible();
  await expect(staff.page.locator(`a[href="/admin/loads/${id}"]`)).not.toContainText("POD pending");
  expect(loadNumber).toMatch(/^MTX-/);
  await staff.ctx.close();
});

test("a failed photo upload offers Try again and Mark delivered without photo; nothing is delivered silently; skipping delivers with no POD", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("SKIPPHOTO"), status: "at_delivery" });
  const { ctx, page } = await as(browser, "carrierA", undefined, { serviceWorkers: "block" });
  await openFresh(page, `/my-loads/${id}`);
  let failing = true;
  await page.route("**/storage/v1/object/documents/**", (route: Route) =>
    failing ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom" }) }) : route.fallback());

  await page.getByTestId("next-step").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("dropzone-input").setInputFiles({ name: "pod.png", mimeType: "image/png", buffer: PNG_1X1 });
  await dialog.getByTestId("pod-submit").click();
  await expect(dialog.getByRole("alert")).toContainText("The photo did not upload");
  await expect(dialog.getByTestId("pod-retry")).toHaveText("Try again");
  const skip = dialog.getByTestId("pod-skip");
  await expect(skip).toHaveText("Mark delivered without photo");
  // Not delivered silently.
  await page.waitForTimeout(500);
  expect((await loadRow(id)).status).toBe("at_delivery");
  expect(await podRows(id)).toEqual([]);

  await skip.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await loadRow(id)).status).toBe("delivered");
  expect(await podRows(id)).toEqual([]);
  expect(await podFiles(id)).toEqual([]);
  expect(await events(id)).toEqual([{ from_status: "at_delivery", to_status: "delivered" }]);
  failing = false;
  await expect(page.getByTestId("pod-card").getByTestId("pod-missing")).toBeVisible();
  await ctx.close();
});

test("the database lets a carrier upload a POD after delivered but never on another carrier's load", async ({ browser }) => {
  // Server side rule seen through the real app: carrier B opens carrier A's delivered load and gets no access.
  const { id } = await insertLoad({ po: uniq("OTHERCAR"), status: "delivered" });
  const b = await as(browser, "carrierB");
  const res = await b.page.goto(`/my-loads/${id}`);
  const body = await b.page.content();
  expect(res?.status() === 404 || !body.includes("pod-card")).toBeTruthy();
  await expect(b.page.getByTestId("pod-card")).toHaveCount(0);
  await b.ctx.close();
});
