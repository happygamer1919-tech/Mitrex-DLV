import { expect, test } from "@playwright/test";
import {
  adminClient, as, insertLoad, jpegSize, loadRow, makeNoisePng, readDownload, uniq,
} from "./support/helpers";

test("staff uploads a BOL, Maria downloads the same bytes, BOL pending disappears", async ({ browser }) => {
  const po = uniq("BOL");
  const { id } = await insertLoad({ po, status: "booked" });
  const pdf = Buffer.from(`%PDF-1.4\n% e2e bol ${po}\n1 0 obj<< /Type /Catalog >>endobj\ntrailer<< /Root 1 0 R >>\n%%EOF\n`);

  const staff = await as(browser, "admin");
  await staff.page.goto(`/admin/loads/${id}`);
  await expect(staff.page.getByText("BOL pending")).toHaveCount(1);
  await staff.page.getByTestId("upload-bol").getByTestId("dropzone-input").setInputFiles({ name: `bol-${po}.pdf`, mimeType: "application/pdf", buffer: pdf });
  await staff.page.getByRole("button", { name: "Upload BOL" }).click();
  await expect(staff.page.getByText("BOL uploaded.")).toBeVisible();
  await expect(staff.page.getByText("BOL pending")).toHaveCount(0);

  // Authoritative state: one bol row, and the stored object equals the uploaded bytes.
  const db = adminClient();
  const docs = await db.from("load_documents").select("kind,storage_path").eq("load_id", id);
  expect(docs.data?.map((d) => d.kind)).toEqual(["bol"]);
  const stored = await db.storage.from("documents").download(docs.data![0].storage_path as string);
  expect(Buffer.from(await stored.data!.arrayBuffer()).equals(pdf)).toBe(true);
  // A reload keeps the badge gone (not just a client-side hide).
  await staff.page.reload();
  await expect(staff.page.getByText("BOL pending")).toHaveCount(0);
  await staff.ctx.close();

  const maria = await as(browser, "maria");
  await maria.page.goto(`/loads/${id}`);
  const link = maria.page.getByRole("link", { name: /Download BOL/ });
  await expect(link).toHaveCount(1);
  const href = (await link.getAttribute("href"))!;
  // The link itself works and returns the same bytes.
  const viaRequest = await maria.ctx.request.get(href);
  expect(viaRequest.status()).toBe(200);
  expect((await viaRequest.body()).equals(pdf)).toBe(true);
  // And a real click downloads the same bytes.
  const [download] = await Promise.all([maria.page.waitForEvent("download"), link.click()]);
  expect((await readDownload(download)).equals(pdf)).toBe(true);
  await maria.ctx.close();
});

test("POD photo larger than 1600px is stored as a JPEG of at most 1600px and smaller", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("POD"), status: "at_delivery" });
  const png = makeNoisePng(3200, 2400);
  expect(png.length).toBeGreaterThan(2 * 1024 * 1024);

  const { ctx, page } = await as(browser, "carrierA");
  await page.goto(`/my-loads/${id}`);
  await page.getByRole("button", { name: "Mark delivered" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({ name: "pod-big.png", mimeType: "image/png", buffer: png });
  await dialog.getByRole("button", { name: "Mark delivered" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 60_000 });

  const db = adminClient();
  await expect.poll(async () => (await loadRow(id)).status, { timeout: 30_000 }).toBe("delivered");
  const pods = await db.from("load_documents").select("storage_path").eq("load_id", id).eq("kind", "pod");
  expect(pods.data?.length).toBe(1);
  const obj = await db.storage.from("documents").download(pods.data![0].storage_path as string);
  expect(obj.error).toBeNull();
  const bytes = Buffer.from(await obj.data!.arrayBuffer());
  const size = jpegSize(bytes);
  expect(size, "stored object is a JPEG").not.toBeNull();
  expect(Math.max(size!.width, size!.height)).toBeLessThanOrEqual(1600);
  expect(Math.max(size!.width, size!.height)).toBeGreaterThan(1000); // resized, not collapsed
  expect(size!.width / size!.height).toBeCloseTo(3200 / 2400, 1); // aspect ratio kept
  expect(bytes.length).toBeLessThan(png.length);
  await ctx.close();
});
