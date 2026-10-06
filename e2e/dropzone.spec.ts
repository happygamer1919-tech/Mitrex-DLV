import { expect, test, type Locator, type Page } from "@playwright/test";
import { adminClient, as, insertLoad, PNG_1X1, uniq } from "./support/helpers";
import { checkFile, extOf, formatBytes } from "../src/lib/client/file-check";

// Card 1 of DLV-021: the upload drop area (src/components/DropZone.tsx) on the staff load page.
// Authoritative state is read back through the service role (load_documents rows and stored bytes).

const pdfBytes = (po: string) => Buffer.from(`%PDF-1.4\n% e2e dropzone ${po}\n1 0 obj<< /Type /Catalog >>endobj\ntrailer<< /Root 1 0 R >>\n%%EOF\n`);

// A real drag and drop: a DataTransfer holding a File, dispatched as dragenter, dragover and drop on the zone.
async function dropFile(page: Page, zone: Locator, file: { name: string; type: string; bytes?: number[]; size?: number }) {
  const dt = await page.evaluateHandle(({ name, type, bytes, size }) => {
    const data = new DataTransfer();
    const content = bytes ? new Uint8Array(bytes) : new Uint8Array(size ?? 1);
    data.items.add(new File([content], name, { type }));
    return data;
  }, file);
  await zone.dispatchEvent("dragenter", { dataTransfer: dt });
  await zone.dispatchEvent("dragover", { dataTransfer: dt });
  await zone.dispatchEvent("drop", { dataTransfer: dt });
}

const bolZone = (page: Page) => page.getByTestId("upload-bol").getByTestId("dropzone");

test("clicking the drop area opens the file chooser", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("DZCLICK"), status: "booked" });
  const { ctx, page } = await as(browser, "admin");
  await page.goto(`/admin/loads/${id}`);
  const zone = bolZone(page);
  await expect(zone).toContainText("Drop the file here, or tap to choose");
  await expect(zone).toContainText("Choose file");
  const box = await zone.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(96);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), zone.click()]);
  expect(chooser.isMultiple()).toBe(false);
  // Choosing through the chooser shows the name and size with a Remove control, and Remove clears it.
  await chooser.setFiles({ name: "chosen.pdf", mimeType: "application/pdf", buffer: pdfBytes("click") });
  const chip = page.getByTestId("upload-bol").getByTestId("dropzone-file");
  await expect(chip).toContainText("chosen.pdf");
  await expect(chip).toContainText(/\d+ (B|kB)/);
  await chip.getByRole("button", { name: "Remove" }).click();
  await expect(chip).toHaveCount(0);
  await ctx.close();
});

test("keyboard: Enter and Space on the drop area open the file chooser", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("DZKEY"), status: "booked" });
  const { ctx, page } = await as(browser, "admin");
  await page.goto(`/admin/loads/${id}`);
  const zone = bolZone(page);
  await expect(zone).toHaveAttribute("role", "button");
  await expect(zone).toHaveAttribute("aria-label", /Bill of lading/);
  for (const key of ["Enter", " "]) {
    await zone.focus();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press(key)]);
    expect(chooser).toBeTruthy();
    await chooser.setFiles([]);
  }
  await ctx.close();
});

test("drag and drop uploads a BOL and it shows in the Documents list; a drop outside the zone does not navigate", async ({ browser }) => {
  const po = uniq("DZDROP");
  const { id } = await insertLoad({ po, status: "booked" });
  const pdf = pdfBytes(po);
  const { ctx, page } = await as(browser, "admin");
  await page.goto(`/admin/loads/${id}`);
  const url = page.url();

  // Drag over highlights the zone.
  const zone = bolZone(page);
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(["x"], "x.pdf", { type: "application/pdf" }));
    return d;
  });
  await zone.dispatchEvent("dragenter", { dataTransfer: dt });
  await expect(zone).toHaveAttribute("data-over", "true");
  await zone.dispatchEvent("dragleave", { dataTransfer: dt });
  await expect(zone).toHaveAttribute("data-over", "false");

  // A file dropped slightly outside the zone: the page keeps its place (default prevented at the document).
  const prevented = await page.evaluate(() => {
    const d = new DataTransfer();
    d.items.add(new File(["x"], "stray.pdf", { type: "application/pdf" }));
    const over = new DragEvent("dragover", { dataTransfer: d, bubbles: true, cancelable: true });
    document.body.dispatchEvent(over);
    const drop = new DragEvent("drop", { dataTransfer: d, bubbles: true, cancelable: true });
    document.body.dispatchEvent(drop);
    return [over.defaultPrevented, drop.defaultPrevented];
  });
  expect(prevented).toEqual([true, true]);
  expect(page.url()).toBe(url);

  await dropFile(page, zone, { name: `bol-${po}.pdf`, type: "application/pdf", bytes: [...pdf] });
  await expect(page.getByTestId("upload-bol").getByTestId("dropzone-file")).toContainText(`bol-${po}.pdf`);
  await page.getByRole("button", { name: "Upload BOL" }).click();
  await expect(page.getByText("BOL uploaded.")).toBeVisible();

  const docs = await adminClient().from("load_documents").select("kind,storage_path").eq("load_id", id);
  expect(docs.data?.map((d) => d.kind)).toEqual(["bol"]);
  const stored = await adminClient().storage.from("documents").download(docs.data![0].storage_path as string);
  expect(Buffer.from(await stored.data!.arrayBuffer()).equals(pdf)).toBe(true);
  // It shows in the Documents list (a BOL row with a Download link) and the BOL pending badge is gone.
  const list = page.getByRole("heading", { name: "Documents" }).locator("..");
  await expect(list.getByText("BOL", { exact: true })).toBeVisible();
  await expect(list.getByRole("link", { name: "Download" })).toHaveCount(1);
  await expect(page.getByText("BOL pending")).toHaveCount(0);
  await ctx.close();
});

test("a wrong extension and a 16 MB file are refused with a message and store nothing", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("DZBAD"), status: "booked" });
  const { ctx, page } = await as(browser, "admin");
  await page.goto(`/admin/loads/${id}`);
  const zone = bolZone(page);
  const err = page.getByTestId("upload-bol").getByTestId("dropzone-error");

  // Dropped.
  await dropFile(page, zone, { name: "notes.txt", type: "text/plain", bytes: [104, 105] });
  await expect(err).toContainText("Use a PDF or an image");
  await expect(page.getByTestId("upload-bol").getByTestId("dropzone-file")).toHaveCount(0);
  await dropFile(page, zone, { name: "huge.pdf", type: "application/pdf", size: 16 * 1024 * 1024 });
  await expect(err).toContainText("larger than 15 MB");
  await expect(page.getByTestId("upload-bol").getByTestId("dropzone-file")).toHaveCount(0);

  // Chosen through the picker.
  await page.getByTestId("upload-bol").getByTestId("dropzone-input").setInputFiles({ name: "run.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
  await expect(err).toContainText("Use a PDF or an image");
  await page.getByTestId("upload-bol").getByTestId("dropzone-input").setInputFiles({ name: "big.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(16 * 1024 * 1024, 1) });
  await expect(err).toContainText("larger than 15 MB");

  // Upload with nothing chosen is refused too, and nothing was stored.
  await page.getByRole("button", { name: "Upload BOL" }).click();
  await expect(page.getByText("Choose a file first.")).toBeVisible();
  const docs = await adminClient().from("load_documents").select("id").eq("load_id", id);
  expect(docs.data).toEqual([]);

  // Control: a good file clears the error and is accepted.
  await page.getByTestId("upload-bol").getByTestId("dropzone-input").setInputFiles({ name: "ok.pdf", mimeType: "application/pdf", buffer: pdfBytes("ok") });
  await expect(err).toHaveCount(0);
  await expect(page.getByTestId("upload-bol").getByTestId("dropzone-file")).toContainText("ok.pdf");
  await ctx.close();
});

test("staff uploads a POD on behalf of the carrier by drag and drop; POD pending clears", async ({ browser }) => {
  const po = uniq("DZPOD");
  const { id } = await insertLoad({ po, status: "delivered" });
  const { ctx, page } = await as(browser, "admin");
  await page.goto(`/admin/loads/${id}`);
  await expect(page.getByTestId("pod-pending")).toHaveText("POD pending");
  const zone = page.getByTestId("upload-pod").getByTestId("dropzone");
  await dropFile(page, zone, { name: `pod-${po}.pdf`, type: "application/pdf", bytes: [...pdfBytes(po)] });
  await page.getByRole("button", { name: "Upload POD" }).click();
  await expect(page.getByText("POD uploaded.")).toBeVisible();
  await expect(page.getByTestId("pod-pending")).toHaveCount(0);
  const docs = await adminClient().from("load_documents").select("kind,uploaded_by").eq("load_id", id);
  expect(docs.data?.map((d) => d.kind)).toEqual(["pod"]);
  await page.reload();
  await expect(page.getByTestId("pod-pending")).toHaveCount(0);
  await ctx.close();
});

test("the carrier POD upload uses the same drop area with the camera on phones, and 48px targets", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("DZCAM"), status: "delivered" });
  const { ctx, page } = await as(browser, "carrierA");
  await page.goto(`/my-loads/${id}`);
  const card = page.getByTestId("pod-card");
  await expect(card.getByTestId("dropzone-input")).toHaveAttribute("capture", "environment");
  const zone = card.getByTestId("dropzone");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), zone.click()]);
  await chooser.setFiles({ name: "pod.png", mimeType: "image/png", buffer: PNG_1X1 });
  await expect(card.getByTestId("dropzone-file")).toContainText("pod.png");
  const remove = await card.getByRole("button", { name: "Remove" }).boundingBox();
  expect(remove!.height).toBeGreaterThanOrEqual(48);
  await ctx.close();
});

test("pure file rules: extension, size, empty file and byte formatting", () => {
  const rule = { exts: ["pdf", "png"], maxBytes: 100 };
  expect(extOf("A.B.PDF")).toBe("pdf");
  expect(extOf("noext")).toBe("");
  expect(checkFile({ name: "a.pdf", size: 100 }, rule)).toBeNull();
  expect(checkFile({ name: "a.pdf", size: 101 }, rule)).toMatch(/larger than/);
  expect(checkFile({ name: "a.exe", size: 1 }, rule)).toMatch(/file types/);
  expect(checkFile({ name: "a", size: 1 }, rule)).toMatch(/file types/);
  expect(checkFile({ name: "a.pdf", size: 0 }, rule)).toMatch(/empty/);
  expect(checkFile({ name: "a.txt", size: 1 }, { ...rule, typeError: "custom" })).toBe("custom");
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(2048)).toBe("2 kB");
  expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
});
