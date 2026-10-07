import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { addLoadPhoto, adminClient, as, insertLoad, isoDate, jpegSize, loadRow, photoRows, PNG_1X1, uniq, type SeedStatus } from "./support/helpers";
import { makeUser, userClient } from "./support/rates";

// DLV-032 (R41): forced photos at the loaded step and at delivery, taken in the in-app camera, with the server time.
// Every claim is read back from the database or the storage API with the service role. The database is the control:
// the refusals are proved with a real session of each role (not only by a disabled button).
// Chromium runs the in-app camera against Chromium's fake video device (see playwright.config.ts). WebKit has no fake
// camera, so on WebKit the camera tests are skipped and the same flows run through the fallback input (a rejected
// getUserMedia, then the phone camera input) plus every gate and visibility test, which do not need a camera.

const OWNER_A = "owner-a@e2e.test";
const OWNER_B = "owner-b@e2e.test";
const MARIA = "maria@e2e.test";
const db = () => adminClient();

type Kind = "pickup_photo" | "delivery_photo";
const fmtEt = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso)) + " ET";

async function openFresh(page: Page, path: string) {
  await page.goto("about:blank");
  await page.goto(path);
}

async function objectExists(path: string): Promise<boolean> {
  const i = path.lastIndexOf("/");
  const { data, error } = await db().storage.from("documents").list(path.slice(0, i), { search: path.slice(i + 1) });
  if (error) throw error;
  return (data ?? []).some((f) => f.name === path.slice(i + 1));
}

const status = async (id: string) => (await loadRow(id)).status as string;
const setStatus = async (id: string, s: SeedStatus) => {
  const { error } = await db().from("loads").update({ status: s }).eq("id", id);
  if (error) throw error;
};
const eventNotes = async (id: string, to: string) =>
  ((await db().from("load_events").select("note").eq("load_id", id).eq("to_status", to).order("created_at")).data ?? []).map((e) => e.note as string | null);

// One attempt to store a photo as a signed in user: the file in the bucket and the row, reported separately.
async function attemptPhoto(c: SupabaseClient, loadId: string, kind: Kind, o: { ext?: string; mime?: string; body?: Buffer } = {}) {
  const path = `${loadId}/${kind}/${randomUUID()}.${o.ext ?? "png"}`;
  const { data: u } = await c.auth.getUser();
  const up = await c.storage.from("documents").upload(path, o.body ?? PNG_1X1, { contentType: o.mime ?? "image/png", upsert: false });
  const ins = await c.from("load_documents").insert({ load_id: loadId, kind, storage_path: path, uploaded_by: u.user!.id });
  return { path, uploadError: up.error, rowError: ins.error };
}

// ---------------------------------------------------------------------------------------------------------------
// 1) The gates
// ---------------------------------------------------------------------------------------------------------------

test("loading: no pickup photo means a Take loaded photo step, Leave for delivery locked, and a direct RPC refused; one photo unlocks it", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("GATE-LOAD"), status: "loading", photo: false });
  const { ctx, page } = await as(browser, "carrierA");
  await openFresh(page, `/my-loads/${id}`);
  await expect(page.getByTestId("photo-step")).toBeVisible();
  await expect(page.getByTestId("take-photo")).toHaveText("Take loaded photo");
  await expect(page.getByTestId("photo-needed")).toContainText("Take a photo of the loaded freight first");
  await expect(page.getByTestId("next-step")).toBeDisabled();
  await expect(page.getByTestId("next-step")).toHaveText("Leave for delivery");

  // The database refuses the same move from the carrier's own session, whatever the page shows.
  const c = await userClient(OWNER_A);
  const refused = await c.rpc("set_load_status", { p_load: id, p_status: "enroute", p_eta: new Date(Date.now() + 3_600_000).toISOString(), p_note: null });
  expect(refused.error?.message).toMatch(/photo of the loaded freight/i);
  expect(await status(id)).toBe("loading");
  expect(await eventNotes(id, "enroute")).toEqual([]);

  // One photo (stored the way the app stores it) unlocks the step.
  await addLoadPhoto(id, "pickup_photo");
  await page.reload();
  await expect(page.getByTestId("photo-item")).toHaveCount(1);
  await expect(page.getByTestId("photo-needed")).toHaveCount(0);
  await expect(page.getByTestId("next-step")).toBeEnabled();
  await page.getByTestId("next-step").click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="datetime-local"]').fill(`${isoDate(3)}T15:30`);
  await dialog.getByRole("button", { name: "Confirm ETA and leave" }).click();
  await expect.poll(() => status(id), { timeout: 20_000 }).toBe("enroute");
  await ctx.close();
});

test("at_delivery: no delivery photo means a Take delivery photo step, Mark delivered locked, and a direct RPC refused; one photo unlocks it; the POD stays optional", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("GATE-DEL"), status: "at_delivery", photo: false });
  const { ctx, page } = await as(browser, "carrierA");
  await openFresh(page, `/my-loads/${id}`);
  await expect(page.getByTestId("take-photo")).toHaveText("Take delivery photo");
  await expect(page.getByTestId("photo-needed")).toContainText("delivered freight");
  await expect(page.getByTestId("next-step")).toBeDisabled();
  await expect(page.getByTestId("next-step")).toHaveText("Mark delivered");

  const c = await userClient(OWNER_A);
  const refused = await c.rpc("set_load_status", { p_load: id, p_status: "delivered", p_eta: null, p_note: null });
  expect(refused.error?.message).toMatch(/delivery photo/i);
  expect(await status(id)).toBe("at_delivery");
  // A pickup photo does not stand in for the delivery photo.
  await addLoadPhoto(id, "pickup_photo");
  const still = await c.rpc("set_load_status", { p_load: id, p_status: "delivered", p_eta: null, p_note: null });
  expect(still.error?.message).toMatch(/delivery photo/i);
  expect(await status(id)).toBe("at_delivery");

  await addLoadPhoto(id, "delivery_photo");
  await page.reload();
  await expect(page.getByTestId("next-step")).toBeEnabled();
  await page.getByTestId("next-step").click();
  await page.getByRole("dialog").getByTestId("pod-submit").click(); // no POD: still delivered
  await expect.poll(() => status(id), { timeout: 20_000 }).toBe("delivered");
  expect((await db().from("load_documents").select("id").eq("load_id", id).eq("kind", "pod")).data).toEqual([]);
  await ctx.close();
});

test("a server refusal is shown in plain words when the photo vanishes behind an open page", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("GATE-MSG"), status: "loading", photo: false });
  const { ctx, page } = await as(browser, "carrierA");
  await addLoadPhoto(id, "pickup_photo");
  await openFresh(page, `/my-loads/${id}`);
  await expect(page.getByTestId("next-step")).toBeEnabled();
  const gone = await db().from("load_documents").delete().eq("load_id", id).eq("kind", "pickup_photo"); // behind the page
  expect(gone.error).toBeNull();
  await page.getByTestId("next-step").click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="datetime-local"]').fill(`${isoDate(3)}T15:30`);
  await dialog.getByRole("button", { name: "Confirm ETA and leave" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Take a photo of the loaded freight first");
  expect(await status(id)).toBe("loading");
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------------------
// 2) Who may write a photo, and when
// ---------------------------------------------------------------------------------------------------------------

test("photo writes follow the status: only pickup photos at at_pickup or loading, only delivery photos at at_delivery (file and row)", async () => {
  const matrix: [SeedStatus, Kind, boolean][] = [
    ["booked", "pickup_photo", false], ["booked", "delivery_photo", false],
    ["at_pickup", "pickup_photo", true], ["at_pickup", "delivery_photo", false],
    ["loading", "pickup_photo", true], ["loading", "delivery_photo", false],
    ["enroute", "pickup_photo", false], ["enroute", "delivery_photo", false],
    ["at_delivery", "pickup_photo", false], ["at_delivery", "delivery_photo", true],
    ["delivered", "pickup_photo", false], ["delivered", "delivery_photo", false],
  ];
  const c = await userClient(OWNER_A);
  let allowed = 0;
  let refused = 0;
  for (const [st, kind, ok] of matrix) {
    const { id } = await insertLoad({ po: uniq(`WIN-${st}`), status: st, photo: false });
    const r = await attemptPhoto(c, id, kind);
    const rows = await photoRows(id);
    if (ok) {
      expect(r.uploadError, `${st}/${kind}: file`).toBeNull();
      expect(r.rowError, `${st}/${kind}: row`).toBeNull();
      expect(rows.map((x) => x.kind), `${st}/${kind}: stored`).toEqual([kind]);
      expect(await objectExists(r.path)).toBe(true);
      allowed += 1;
    } else {
      expect(r.uploadError, `${st}/${kind}: file refused`).not.toBeNull();
      expect(r.rowError?.message, `${st}/${kind}: row refused`).toMatch(/row-level security/i);
      expect(rows, `${st}/${kind}: nothing stored`).toEqual([]);
      expect(await objectExists(r.path)).toBe(false);
      refused += 1;
    }
  }
  expect([allowed, refused]).toEqual([3, 9]); // guard: the matrix really had both kinds of cell
});

test("another carrier cannot write or read a photo; the owning carrier's driver can write", async () => {
  const { id } = await insertLoad({ po: uniq("OTHER-CARRIER"), status: "loading", photo: false });
  const mine = await addLoadPhoto(id, "pickup_photo");
  expect((await photoRows(id)).length).toBe(1); // guard: there is a photo to be read

  const b = await userClient(OWNER_B);
  const w = await attemptPhoto(b, id, "pickup_photo");
  expect(w.uploadError).not.toBeNull();
  expect(w.rowError?.message).toMatch(/row-level security/i);
  const read = await b.from("load_documents").select("id").eq("load_id", id);
  expect(read.error).toBeNull();
  expect(read.data).toEqual([]);
  const signed = await b.storage.from("documents").createSignedUrl(mine.path, 60);
  expect(signed.data?.signedUrl ?? null).toBeNull();
  expect(await b.rpc("delete_load_photo", { p_doc: mine.id })).toMatchObject({ error: expect.anything() });
  expect((await photoRows(id)).length).toBe(1);

  // Controls: the owner reads it; a driver of the same carrier can write.
  const a = await userClient(OWNER_A);
  expect((await a.from("load_documents").select("id").eq("load_id", id)).data).toHaveLength(1);
  const { data: carrier } = await db().from("carriers").select("id").eq("name", "E2E Carrier A").single();
  const driverEmail = `photo-driver-${Date.now().toString(36)}-${process.pid}@e2e.test`;
  const made = await db().auth.admin.createUser({ email: driverEmail, email_confirm: true });
  expect(made.error).toBeNull();
  const driver = { id: made.data.user!.id, email: driverEmail };
  const prof = await db().from("profiles").insert({ id: driver.id, email: driverEmail, full_name: "Photo Driver", role: "carrier_driver", carrier_id: carrier!.id, is_active: true });
  expect(prof.error).toBeNull();
  const d = await userClient(driver.email);
  const dw = await attemptPhoto(d, id, "pickup_photo");
  expect(dw.uploadError).toBeNull();
  expect(dw.rowError).toBeNull();
  expect((await photoRows(id)).length).toBe(2);
  await db().auth.admin.deleteUser(driver.id).catch(() => {});
});

test("a photo that is not an image is refused: a pdf body, a pdf or heic name, and a kind folder that does not match", async () => {
  const { id } = await insertLoad({ po: uniq("NOTIMG"), status: "loading", photo: false });
  const c = await userClient(OWNER_A);
  const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");
  const body = await attemptPhoto(c, id, "pickup_photo", { ext: "jpg", mime: "application/pdf", body: pdf });
  expect(body.uploadError, "a pdf sent to a photo path").not.toBeNull();
  expect(await objectExists(body.path)).toBe(false);
  const name = await attemptPhoto(c, id, "pickup_photo", { ext: "pdf", mime: "application/pdf", body: pdf });
  expect(name.uploadError, "a .pdf photo name (file)").not.toBeNull();
  expect(name.rowError?.message, "a .pdf photo name (row)").toMatch(/row-level security|violates check/i);
  const heic = await attemptPhoto(c, id, "pickup_photo", { ext: "heic", mime: "image/heic" });
  expect(heic.uploadError, "a .heic photo name (file)").not.toBeNull();
  expect(heic.rowError, "a .heic photo name (row)").not.toBeNull();
  const wrongFolder = await c.from("load_documents").insert({
    load_id: id, kind: "pickup_photo", storage_path: `${id}/delivery_photo/${randomUUID()}.png`, uploaded_by: (await c.auth.getUser()).data.user!.id,
  });
  expect(wrongFolder.error).not.toBeNull();
  expect(await photoRows(id)).toEqual([]);
  // Control: the same load takes a real image.
  const okImg = await attemptPhoto(c, id, "pickup_photo");
  expect(okImg.uploadError).toBeNull();
  expect(okImg.rowError).toBeNull();
  expect(await photoRows(id, "pickup_photo")).toHaveLength(1);
});

test("at most 6 photos of a kind per load: the 7th is refused by the database and the page offers no more", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("SIX"), status: "loading", photo: false });
  const c = await userClient(OWNER_A);
  for (let i = 0; i < 6; i++) {
    const r = await attemptPhoto(c, id, "pickup_photo");
    expect(r.rowError, `photo ${i + 1}`).toBeNull();
  }
  expect(await photoRows(id, "pickup_photo")).toHaveLength(6);
  const seventh = await attemptPhoto(c, id, "pickup_photo");
  expect(seventh.rowError?.message).toMatch(/at most 6 photos/i);
  expect(await photoRows(id, "pickup_photo")).toHaveLength(6);

  const { ctx, page } = await as(browser, "carrierA");
  await openFresh(page, `/my-loads/${id}`);
  await expect(page.getByTestId("photo-item")).toHaveCount(6);
  await expect(page.getByTestId("take-photo")).toHaveCount(0);
  await expect(page.getByTestId("photo-step")).toContainText("6 photos, the most it can have");
  await expect(page.getByTestId("next-step")).toBeEnabled();
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------------------
// 3) Time, thumbnails, retake (remove) while the step is open
// ---------------------------------------------------------------------------------------------------------------

test("thumbnails show the SERVER time in Eastern time, not the browser's captured_at; a carrier removes its own photo while the step is open", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("THUMB"), status: "loading", photo: false });
  const p = await addLoadPhoto(id, "pickup_photo", { capturedAt: "2001-02-03T04:05:06Z" });
  const row = (await photoRows(id))[0];
  expect(row.captured_at).toContain("2001-02-03"); // guard: the browser claim is stored apart
  const { ctx, page } = await as(browser, "carrierA");
  await openFresh(page, `/my-loads/${id}`);
  const item = page.getByTestId("photo-item");
  await expect(item).toHaveCount(1);
  await expect(item.getByTestId("photo-time")).toHaveText(fmtEt(row.created_at as string));
  await expect(item.getByTestId("photo-time")).not.toContainText("2001");
  await expect(item.locator("img")).toBeVisible();
  // the picture really loads (signed URL, private bucket)
  await expect.poll(() => item.locator("img").evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);

  await item.getByTestId("photo-remove").click();
  await expect(page.getByTestId("photo-item")).toHaveCount(0);
  await expect(page.getByTestId("photo-needed")).toBeVisible();
  await expect(page.getByTestId("next-step")).toBeDisabled();
  expect(await photoRows(id)).toEqual([]);
  expect(await objectExists(p.path)).toBe(false);
  await ctx.close();
});

test("a photo cannot be removed once the step is closed (direct call), and a staff photo is not removable by the carrier", async () => {
  const { id } = await insertLoad({ po: uniq("NORM"), status: "loading", photo: false });
  const own = await addLoadPhoto(id, "pickup_photo");
  const staffs = await addLoadPhoto(id, "pickup_photo", { by: "admin@e2e.test" });
  const c = await userClient(OWNER_A);
  const notMine = await c.rpc("delete_load_photo", { p_doc: staffs.id });
  expect(notMine.error?.message).toMatch(/cannot remove/i);
  await setStatus(id, "enroute");
  const closed = await c.rpc("delete_load_photo", { p_doc: own.id });
  expect(closed.error?.message).toMatch(/cannot remove/i);
  expect(await photoRows(id)).toHaveLength(2);
  // control: while the step was open the owner could (a fresh load)
  const open = await insertLoad({ po: uniq("NORM2"), status: "loading", photo: false });
  const mine = await addLoadPhoto(open.id, "pickup_photo");
  const gone = await c.rpc("delete_load_photo", { p_doc: mine.id });
  expect(gone.error).toBeNull();
  expect(gone.data).toBe(mine.path);
  expect(await photoRows(open.id)).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------
// 4) The customer: photos appear only after the proper status change
// ---------------------------------------------------------------------------------------------------------------

test("Maria sees no photo before enroute, the pickup photo after, the delivery photo only once delivered, with the Eastern server time and a working full size link", async ({ browser }) => {
  const { id, loadNumber } = await insertLoad({ po: uniq("CUST"), status: "loading", photo: false });
  const pick = await addLoadPhoto(id, "pickup_photo");
  const del = await addLoadPhoto(id, "delivery_photo"); // stored as the service role at any status, so the visibility below is the rule
  const rows = await photoRows(id);
  expect(rows.map((r) => r.kind).sort()).toEqual(["delivery_photo", "pickup_photo"]); // guard: both exist, so "none" below is the rule

  const { ctx, page } = await as(browser, "maria");
  const open = async () => {
    await openFresh(page, `/loads/${id}`);
    await expect(page.locator("h1").first()).toContainText(loadNumber);
  };
  await open();
  await expect(page.getByTestId("photos-card")).toBeVisible();
  await expect(page.getByTestId("photo-item")).toHaveCount(0);
  await expect(page.getByTestId("photos-empty")).toContainText("appears here once the load leaves for delivery");

  await setStatus(id, "enroute");
  await open();
  await expect(page.getByTestId("photo-item")).toHaveCount(1);
  await expect(page.getByTestId("photo-item")).toHaveAttribute("data-kind", "pickup_photo");
  await expect(page.getByTestId("photo-time")).toHaveText(fmtEt(rows.find((r) => r.id === pick.id)!.created_at as string));

  await setStatus(id, "at_delivery");
  await open();
  await expect(page.getByTestId("photo-item")).toHaveCount(1); // still no delivery photo

  await setStatus(id, "delivered");
  await open();
  await expect(page.getByTestId("photo-item")).toHaveCount(2);
  await expect(page.getByTestId("photo-item").nth(0)).toHaveAttribute("data-kind", "pickup_photo");
  await expect(page.getByTestId("photo-item").nth(1)).toHaveAttribute("data-kind", "delivery_photo");
  await expect(page.getByTestId("photo-time").nth(1)).toHaveText(fmtEt(rows.find((r) => r.id === del.id)!.created_at as string));

  // Tap to open full size: the short lived signed link serves the image.
  const href = await page.getByTestId("photo-item").first().locator("a").getAttribute("href");
  expect(href).toContain("/storage/v1/object/sign/documents/");
  const img = await page.request.get(href!);
  expect(img.status()).toBe(200);
  expect(img.headers()["content-type"]).toContain("image/");
  await ctx.close();
});

test("the database hides photos from another customer and from a customer before the status allows; a customer cannot write one", async () => {
  const { data: other } = await db().from("customers").insert({ name: `Photo Other ${Date.now().toString(36)}` }).select("id").single();
  const u = await makeUser({ role: "customer", active: true, customerId: other!.id as string, tag: "photo-cust" });
  const { id } = await insertLoad({ po: uniq("CUSTDB"), status: "enroute", photo: false });
  const pick = await addLoadPhoto(id, "pickup_photo");
  const maria = await userClient(MARIA);
  const seen = await maria.from("load_documents").select("id,kind").eq("load_id", id);
  expect(seen.data?.map((r) => r.kind)).toEqual(["pickup_photo"]); // control: the owner customer sees it once enroute
  expect((await maria.storage.from("documents").createSignedUrl(pick.path, 60)).data?.signedUrl).toBeTruthy();

  const cu = await userClient(u.email);
  expect((await cu.from("load_documents").select("id").eq("load_id", id)).data).toEqual([]);
  expect((await cu.storage.from("documents").createSignedUrl(pick.path, 60)).data?.signedUrl ?? null).toBeNull();
  const w = await attemptPhoto(cu, id, "pickup_photo");
  expect(w.rowError?.message).toMatch(/row-level security/i);

  // A customer cannot write, even on its own load while it is in a window a carrier could write.
  const loading = await insertLoad({ po: uniq("CUSTW"), status: "loading", photo: false });
  const mw = await attemptPhoto(maria, loading.id, "pickup_photo");
  expect(mw.uploadError).not.toBeNull();
  expect(mw.rowError?.message).toMatch(/row-level security/i);
  const ad = await insertLoad({ po: uniq("CUSTW2"), status: "at_delivery", photo: false });
  const mw2 = await attemptPhoto(maria, ad.id, "delivery_photo");
  expect(mw2.rowError?.message).toMatch(/row-level security/i);
  expect(await photoRows(loading.id)).toEqual([]);
  expect(await photoRows(ad.id)).toEqual([]);
  // and sees a pickup photo of a loading load: no
  await addLoadPhoto(loading.id, "pickup_photo");
  expect((await maria.from("load_documents").select("id").eq("load_id", loading.id)).data).toEqual([]);
  await db().auth.admin.deleteUser(u.id).catch(() => {});
});

// ---------------------------------------------------------------------------------------------------------------
// 5) Staff
// ---------------------------------------------------------------------------------------------------------------

async function staffOverride(page: Page, to: "Enroute" | "Delivered", note: string) {
  await page.getByLabel("New status").selectOption({ label: to });
  if (to === "Enroute") await page.getByLabel("ETA (Eastern time, ET)").fill(`${isoDate(3)}T10:00`);
  await page.getByLabel("Note (required)").fill(note);
  await page.getByRole("button", { name: "Override status" }).click();
}

test("staff override to Enroute and to Delivered works without photos and the timeline records the skip", async ({ browser }) => {
  const a = await insertLoad({ po: uniq("STAFF-SKIP1"), status: "loading", photo: false });
  const b = await insertLoad({ po: uniq("STAFF-SKIP2"), status: "at_delivery", photo: false });
  const { ctx, page } = await as(browser, "admin");
  await openFresh(page, `/admin/loads/${a.id}`);
  await expect(page.locator("h1").first()).toContainText(a.loadNumber);
  await staffOverride(page, "Enroute", "dispatch fix");
  await expect.poll(() => status(a.id), { timeout: 20_000 }).toBe("enroute");
  expect(await eventNotes(a.id, "enroute")).toEqual(["dispatch fix. Staff skipped the pickup photo (none on file)."]);
  await page.reload();
  await expect(page.getByText("Staff skipped the pickup photo (none on file).")).toBeVisible();

  await openFresh(page, `/admin/loads/${b.id}`);
  await expect(page.locator("h1").first()).toContainText(b.loadNumber);
  await staffOverride(page, "Delivered", "closing it");
  await expect.poll(() => status(b.id), { timeout: 20_000 }).toBe("delivered");
  expect(await eventNotes(b.id, "delivered")).toEqual(["closing it. Staff skipped the delivery photo (none on file)."]);
  await ctx.close();
});

test("staff upload a pickup photo on behalf of the carrier: it shows with its time, unlocks the carrier, and staff can remove it", async ({ browser }) => {
  const { id, loadNumber } = await insertLoad({ po: uniq("STAFF-UP"), status: "loading", photo: false });
  const { ctx, page } = await as(browser, "admin");
  await openFresh(page, `/admin/loads/${id}`);
  await expect(page.locator("h1").first()).toContainText(loadNumber);
  const zone = page.getByTestId("upload-pickup_photo");
  await zone.getByTestId("dropzone-input").setInputFiles({ name: "front.png", mimeType: "image/png", buffer: PNG_1X1 });
  await page.getByRole("button", { name: "Upload Pickup photo" }).click();
  await expect(page.getByText("Pickup photo uploaded.")).toBeVisible();
  const rows = await photoRows(id, "pickup_photo");
  expect(rows).toHaveLength(1);
  const row = page.locator('[data-testid="doc-row"][data-kind="pickup_photo"]');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("doc-time")).toHaveText(fmtEt(rows[0].created_at as string));
  // a non image is refused before anything is sent
  await zone.getByTestId("dropzone-input").setInputFiles({ name: "x.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
  await expect(zone.getByTestId("dropzone-error")).toContainText("Use a photo");

  // the carrier's step is unlocked
  const carrier = await as(browser, "carrierA");
  await openFresh(carrier.page, `/my-loads/${id}`);
  await expect(carrier.page.getByTestId("next-step")).toBeEnabled();
  await carrier.ctx.close();

  await row.getByTestId("staff-photo-remove").click();
  await expect(page.locator('[data-testid="doc-row"][data-kind="pickup_photo"]')).toHaveCount(0);
  expect(await photoRows(id)).toEqual([]);
  expect(await objectExists(rows[0].storage_path as string)).toBe(false);
  await ctx.close();
});

test("admin delete forever removes the photo files too (database rows, both files, no orphans logged)", async ({ browser }) => {
  const { id, loadNumber } = await insertLoad({ po: uniq("DELPHOTO"), status: "delivered" });
  const p1 = await addLoadPhoto(id, "pickup_photo");
  const p2 = await addLoadPhoto(id, "delivery_photo");
  expect(await objectExists(p1.path)).toBe(true);
  expect(await objectExists(p2.path)).toBe(true);
  const { ctx, page } = await as(browser, "admin");
  await page.goto(`/admin/loads/${id}`);
  await expect(page.locator("h1").first()).toContainText(loadNumber);
  await page.getByTestId("danger-zone").getByTestId("delete-open").click();
  await page.getByTestId("delete-modal").getByTestId("delete-confirm-input").fill(loadNumber);
  await page.getByTestId("delete-modal").getByTestId("delete-confirm").click();
  await page.waitForURL((u) => u.pathname === "/admin" && u.searchParams.has("deleted"), { timeout: 30_000 });
  expect(new URL(page.url()).searchParams.has("orphans")).toBe(false);
  expect((await db().from("loads").select("id").eq("id", id)).data).toEqual([]);
  expect(await photoRows(id)).toEqual([]);
  expect(await objectExists(p1.path)).toBe(false);
  expect(await objectExists(p2.path)).toBe(false);
  const audit = (await db().from("load_deletions").select("orphan_paths").eq("load_id", id)).data ?? [];
  expect(audit).toHaveLength(1);
  expect(audit[0].orphan_paths).toEqual([]);
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------------------
// 6) The in-app camera
// ---------------------------------------------------------------------------------------------------------------

const trackStreams = async (ctx: BrowserContext) =>
  ctx.addInitScript(() => {
    const md = navigator.mediaDevices;
    const orig = md.getUserMedia.bind(md);
    (window as unknown as { __streams: MediaStream[] }).__streams = [];
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      const s = await orig(c);
      (window as unknown as { __streams: MediaStream[] }).__streams.push(s);
      return s;
    };
  });
const allTracksEnded = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __streams?: MediaStream[] }).__streams ?? [];
    return s.length > 0 && s.every((x) => x.getTracks().length > 0 && x.getTracks().every((t) => t.readyState === "ended"));
  });
const streamCount = (page: Page) => page.evaluate(() => ((window as unknown as { __streams?: MediaStream[] }).__streams ?? []).length);

async function denyCamera(ctx: BrowserContext) {
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")) },
    });
  });
}

async function cameraSession(browser: Browser, name: "carrierA" = "carrierA") {
  const s = await as(browser, name, undefined, { permissions: ["camera"] });
  await trackStreams(s.ctx);
  return s;
}

test("camera happy path (fake device): live preview, Take photo, Use this photo stores one JPEG object and one row with the server time, then the step unlocks; tracks are stopped", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "WebKit has no fake camera: the fallback input path is tested instead");
  const { id } = await insertLoad({ po: uniq("CAM"), status: "loading", photo: false });
  const { ctx, page } = await cameraSession(browser);
  await openFresh(page, `/my-loads/${id}`);
  const before = Date.now();
  await page.getByTestId("take-photo").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("camera")).toHaveAttribute("data-phase", "live");
  await expect(dialog.getByTestId("camera-video")).toBeVisible();
  await expect(dialog.getByTestId("camera-status")).toContainText("Camera ready");
  // The camera is the primary button. The only file input is the gallery one (R41): no capture attribute, images only.
  await expect(dialog.locator('input[type="file"]')).toHaveCount(1);
  await expect(dialog.getByTestId("camera-fallback-input")).toHaveCount(0);
  await expect(dialog.getByTestId("camera-gallery-input")).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");
  await expect(dialog.getByTestId("camera-gallery-input")).not.toHaveAttribute("capture", /.*/);
  await expect(dialog.getByTestId("camera-gallery")).toHaveText("Choose a photo from your phone");
  const take = dialog.getByTestId("camera-take");
  await expect(take).toBeEnabled();
  expect((await take.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await take.click();
  await expect(dialog.getByTestId("camera")).toHaveAttribute("data-phase", "review");
  await expect(dialog.getByTestId("camera-preview")).toBeVisible();
  await expect(dialog.getByTestId("camera-status")).toContainText("Photo taken");
  expect(await allTracksEnded(page), "the camera is off right after the capture").toBe(true);
  expect(await photoRows(id)).toEqual([]); // nothing stored before Use this photo

  await dialog.getByTestId("camera-use").click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 20_000 });
  const rows = await photoRows(id, "pickup_photo");
  expect(rows).toHaveLength(1);
  const obj = await db().storage.from("documents").download(rows[0].storage_path as string);
  expect(obj.error).toBeNull();
  const bytes = Buffer.from(await obj.data!.arrayBuffer());
  const size = jpegSize(bytes);
  expect(size, "stored object is a JPEG").not.toBeNull();
  expect(Math.max(size!.width, size!.height)).toBeLessThanOrEqual(1600);
  expect(bytes.length).toBeLessThan(2 * 1024 * 1024);
  // The official time is the server time of the insert; the browser's claim is stored apart and is close to it.
  const created = new Date(rows[0].created_at as string).getTime();
  expect(Math.abs(created - Date.now())).toBeLessThan(60_000);
  expect(created).toBeGreaterThanOrEqual(before - 5_000);
  expect(Math.abs(new Date(rows[0].captured_at as string).getTime() - created)).toBeLessThan(60_000);
  await expect(page.getByTestId("photo-item")).toHaveCount(1);
  await expect(page.getByTestId("photo-time")).toHaveText(fmtEt(rows[0].created_at as string));
  await expect(page.getByTestId("next-step")).toBeEnabled();
  expect(await allTracksEnded(page)).toBe(true);
  await ctx.close();
});

test("camera: Retake opens a new stream, a cancelled camera is stopped, and an unmount stops the stream", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "WebKit has no fake camera");
  const { id } = await insertLoad({ po: uniq("CAMRETAKE"), status: "loading", photo: false });
  const { ctx, page } = await cameraSession(browser);
  await openFresh(page, `/my-loads/${id}`);
  await page.getByTestId("take-photo").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("camera-take")).toBeEnabled();
  await dialog.getByTestId("camera-take").click();
  await expect(dialog.getByTestId("camera")).toHaveAttribute("data-phase", "review");
  await dialog.getByTestId("camera-retake").click();
  await expect(dialog.getByTestId("camera")).toHaveAttribute("data-phase", "live");
  expect(await streamCount(page)).toBe(2);
  // Cancel while live: the dialog closes and every track of every stream has ended.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => allTracksEnded(page)).toBe(true);
  expect(await photoRows(id)).toEqual([]);
  // Navigating away from a live camera also stops it (unmount).
  await page.getByTestId("take-photo").click();
  await expect(page.getByRole("dialog").getByTestId("camera")).toHaveAttribute("data-phase", "live");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => allTracksEnded(page)).toBe(true);
  await ctx.close();
});

test("camera: a 3200x2400 camera frame is stored as a JPEG of at most 1600 px on the long side, same aspect ratio", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "WebKit has no fake camera");
  const { id } = await insertLoad({ po: uniq("CAMBIG"), status: "loading", photo: false });
  const { ctx, page } = await as(browser, "carrierA", undefined, { permissions: ["camera"] });
  // A camera that delivers a 3200x2400 frame (a modern phone): a canvas stream stands in for the device.
  await ctx.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const c = document.createElement("canvas");
      c.width = 3200;
      c.height = 2400;
      const g = c.getContext("2d")!;
      let n = 0;
      const draw = () => {
        g.fillStyle = `hsl(${(n += 7) % 360} 70% 50%)`;
        g.fillRect(0, 0, 3200, 2400);
        g.fillStyle = "#fff";
        g.fillRect(100 + (n % 500), 100, 800, 600);
      };
      draw();
      setInterval(draw, 100);
      return c.captureStream(10);
    };
  });
  await openFresh(page, `/my-loads/${id}`);
  await page.getByTestId("take-photo").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("camera-take")).toBeEnabled();
  expect(await dialog.getByTestId("camera-video").evaluate((v) => (v as HTMLVideoElement).videoWidth)).toBe(3200);
  await dialog.getByTestId("camera-take").click();
  await dialog.getByTestId("camera-use").click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 20_000 });
  const rows = await photoRows(id, "pickup_photo");
  expect(rows).toHaveLength(1);
  const obj = await db().storage.from("documents").download(rows[0].storage_path as string);
  const bytes = Buffer.from(await obj.data!.arrayBuffer());
  const size = jpegSize(bytes);
  expect(size, "stored object is a JPEG").not.toBeNull();
  expect(Math.max(size!.width, size!.height)).toBe(1600);
  expect(size!.width / size!.height).toBeCloseTo(3200 / 2400, 1);
  expect(bytes.length).toBeLessThan(2 * 1024 * 1024);
  await ctx.close();
});

test("camera permission denied: a plain explanation and the phone camera input as the fallback; the photo is stored and unlocks the step (both engines)", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("CAMDENY"), status: "loading", photo: false });
  const { ctx, page } = await as(browser, "carrierA");
  await denyCamera(ctx);
  await openFresh(page, `/my-loads/${id}`);
  await page.getByTestId("take-photo").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("camera")).toHaveAttribute("data-phase", "unavailable");
  await expect(dialog.getByTestId("camera-reason")).toContainText("The camera is blocked");
  await expect(dialog.getByTestId("camera-reason")).toContainText("open the phone camera app");
  const input = dialog.getByTestId("camera-fallback-input");
  await expect(input).toHaveAttribute("capture", "environment");
  await expect(input).toHaveAttribute("accept", "image/*");
  await expect(dialog.getByTestId("camera-again")).toBeVisible();
  expect(await photoRows(id)).toEqual([]);

  await input.setInputFiles({ name: "cam.png", mimeType: "image/png", buffer: PNG_1X1 });
  await expect(dialog.getByTestId("camera")).toHaveAttribute("data-phase", "review");
  await dialog.getByTestId("camera-use").click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 20_000 });
  const rows = await photoRows(id, "pickup_photo");
  expect(rows).toHaveLength(1);
  const obj = await db().storage.from("documents").download(rows[0].storage_path as string);
  expect(jpegSize(Buffer.from(await obj.data!.arrayBuffer())), "re-encoded as JPEG").not.toBeNull();
  await expect(page.getByTestId("next-step")).toBeEnabled();
  await ctx.close();
});

test("gallery: Choose a photo from your phone stores one JPEG with the server time and unlocks the step (both engines)", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("GAL"), status: "loading", photo: false });
  const { ctx, page } = await as(browser, "carrierA");
  await denyCamera(ctx);
  await openFresh(page, `/my-loads/${id}`);
  await expect(page.getByTestId("next-step")).toBeDisabled();
  await page.getByTestId("take-photo").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("camera-gallery-input").setInputFiles({ name: "old.png", mimeType: "image/png", buffer: PNG_1X1 });
  await expect(dialog.getByTestId("camera")).toHaveAttribute("data-phase", "review");
  const before = Date.now();
  await dialog.getByTestId("camera-use").click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 20_000 });
  const rows = await photoRows(id, "pickup_photo");
  expect(rows).toHaveLength(1);
  // The official time is the server time of the upload, never the file's own date.
  expect(Math.abs(new Date(rows[0].created_at as string).getTime() - before)).toBeLessThan(60_000);
  const obj = await db().storage.from("documents").download(rows[0].storage_path as string);
  expect(jpegSize(Buffer.from(await obj.data!.arrayBuffer())), "re-encoded as JPEG").not.toBeNull();
  await expect(page.getByTestId("next-step")).toBeEnabled();
  await ctx.close();
});

test("camera: a failed upload keeps the photo, says so, and Try again stores exactly one (both engines)", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("CAMFAIL"), status: "at_delivery", photo: false });
  const { ctx, page } = await as(browser, "carrierA", undefined, { serviceWorkers: "block" });
  await denyCamera(ctx);
  let fail = true;
  await page.route("**/*", (r) => (fail && r.request().method() === "POST" && r.request().url().includes("/storage/v1/object/documents/") ? r.abort("failed") : r.fallback()));
  await openFresh(page, `/my-loads/${id}`);
  await page.getByTestId("take-photo").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("camera-fallback-input").setInputFiles({ name: "cam.png", mimeType: "image/png", buffer: PNG_1X1 });
  await dialog.getByTestId("camera-use").click();
  await expect(dialog.getByTestId("camera-error")).toContainText("did not upload");
  await expect(dialog.getByTestId("camera-preview")).toBeVisible(); // the picture is still there
  expect(await photoRows(id)).toEqual([]);
  fail = false;
  await dialog.getByTestId("camera-use").click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 20_000 });
  expect(await photoRows(id, "delivery_photo")).toHaveLength(1);
  await ctx.close();
});

test("POD with the in-app camera still works and stays optional (fake device)", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "WebKit has no fake camera: the POD file path is covered in pod-optional.spec.ts");
  const { id } = await insertLoad({ po: uniq("PODCAM"), status: "at_delivery" }); // seeded with its delivery photo
  const { ctx, page } = await cameraSession(browser);
  await openFresh(page, `/my-loads/${id}`);
  await page.getByTestId("next-step").click();
  const dialog = page.getByRole("dialog");
  // Nothing forces a POD: the picker is a choice, not a gate.
  await expect(dialog.getByText(/required/i)).toHaveCount(0);
  await dialog.getByTestId("pod-take").click();
  await expect(dialog.getByTestId("camera")).toHaveAttribute("data-phase", "live");
  await expect(dialog.getByTestId("camera-take")).toBeEnabled();
  await dialog.getByTestId("camera-take").click();
  await dialog.getByTestId("camera-use").click();
  await expect(dialog.getByTestId("pod-ready")).toBeVisible();
  await dialog.getByTestId("pod-submit").click();
  await expect.poll(() => status(id), { timeout: 30_000 }).toBe("delivered");
  const pods = (await db().from("load_documents").select("storage_path,kind").eq("load_id", id).eq("kind", "pod")).data ?? [];
  expect(pods).toHaveLength(1);
  const obj = await db().storage.from("documents").download(pods[0].storage_path as string);
  const size = jpegSize(Buffer.from(await obj.data!.arrayBuffer()));
  expect(size).not.toBeNull();
  expect(Math.max(size!.width, size!.height)).toBeLessThanOrEqual(1600);
  expect(await allTracksEnded(page)).toBe(true);

  // After delivery the POD card takes a second POD with the camera too.
  const card = page.getByTestId("pod-card");
  await card.getByTestId("pod-add-another").click();
  await card.getByTestId("pod-take").click();
  await expect(card.getByTestId("camera-take")).toBeEnabled();
  await card.getByTestId("camera-take").click();
  await card.getByTestId("camera-use").click();
  await card.getByTestId("pod-add").click();
  await expect.poll(async () => ((await db().from("load_documents").select("id").eq("load_id", id).eq("kind", "pod")).data ?? []).length, { timeout: 30_000 }).toBe(2);
  await ctx.close();
});

test("375px: the photo step and the camera dialog have no horizontal overflow (both engines)", async ({ browser }) => {
  const { id } = await insertLoad({ po: uniq("W375"), status: "loading", photo: false });
  for (let i = 0; i < 3; i++) await addLoadPhoto(id, "pickup_photo");
  const { ctx, page } = await as(browser, "carrierA", { width: 375, height: 812 });
  await denyCamera(ctx);
  await openFresh(page, `/my-loads/${id}`);
  await expect(page.getByTestId("photo-item")).toHaveCount(3);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.getByTestId("take-photo").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("camera")).toHaveAttribute("data-phase", "unavailable");
  expect(await overflow()).toBeLessThanOrEqual(0);
  const dw = await dialog.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(dw.sw).toBeLessThanOrEqual(dw.cw);
  // every control is at least 44px tall
  for (const t of ["camera-fallback", "camera-again"]) {
    expect((await dialog.getByTestId(t).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await ctx.close();
});

test("the camera stays permitted for this origin only (Permissions-Policy)", async ({ request }) => {
  const res = await request.get("/login");
  expect(res.headers()["permissions-policy"]).toContain("camera=(self)");
});

void isoDate;
