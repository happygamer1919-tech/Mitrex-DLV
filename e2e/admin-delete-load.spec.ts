import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { adminClient, anon, as, insertLoad, PNG_1X1, uniq, type SeedStatus } from "./support/helpers";
import { BASE_URL, localEnv } from "./support/env";
import { assertLocalUrl } from "./support/guard";
import { loginViaUi } from "./support/login";
import { deleteLoadCore, deletedBanner, type DeleteDeps } from "../src/lib/admin/delete-load";

// DLV-027 (R38): an admin can delete a load forever; nobody else can. Everything is read back from the database and
// from the storage API with the service role. Server action calls are forged over HTTP with the action id the real
// button used, so the refusals are proved at the server, not only by a hidden button.

test.describe.configure({ mode: "serial", timeout: 180_000 });
assertLocalUrl(BASE_URL, "base url");

const db = () => adminClient();
const VIEWPORT = { width: 375, height: 812 };
const createdUsers: string[] = [];

test.afterAll(async () => {
  for (const id of createdUsers) await db().auth.admin.deleteUser(id).catch(() => {});
});

// ---- helpers ------------------------------------------------------------------------------------

async function adminId(): Promise<string> {
  return (await db().from("profiles").select("id").eq("email", "admin@e2e.test").single()).data!.id as string;
}

// BOL and/or POD: a real object in the private bucket and its load_documents row.
async function seedDocs(loadId: string, kinds: ("bol" | "pod")[] = ["bol", "pod"]): Promise<string[]> {
  const by = await adminId();
  const paths: string[] = [];
  for (const kind of kinds) {
    const path = `${loadId}/${kind}/${randomUUID()}.${kind === "bol" ? "pdf" : "png"}`;
    const up = await db().storage.from("documents").upload(path, kind === "bol" ? Buffer.from("%PDF-1.4\n%%EOF\n") : PNG_1X1, {
      contentType: kind === "bol" ? "application/pdf" : "image/png",
    });
    if (up.error) throw up.error;
    const ins = await db().from("load_documents").insert({ load_id: loadId, kind, storage_path: path, uploaded_by: by });
    if (ins.error) throw ins.error;
    paths.push(path);
  }
  return paths;
}

async function fileExists(path: string): Promise<boolean> {
  const i = path.lastIndexOf("/");
  const { data, error } = await db().storage.from("documents").list(path.slice(0, i), { search: path.slice(i + 1) });
  if (error) throw error;
  return (data ?? []).some((f) => f.name === path.slice(i + 1));
}

const count = async (table: string, loadId: string): Promise<number> => {
  const { count: n, error } = await db().from(table).select("*", { count: "exact", head: true }).eq("load_id", loadId);
  if (error) throw error;
  return n ?? 0;
};
const loadExists = async (id: string): Promise<boolean> =>
  ((await db().from("loads").select("id").eq("id", id).maybeSingle()).data?.id ?? null) === id;
const audit = async (loadId: string) => (await db().from("load_deletions").select("*").eq("load_id", loadId)).data ?? [];

async function seed(status: SeedStatus, docs: ("bol" | "pod")[] = ["bol", "pod"], extra: { its?: string | null; po?: string } = {}) {
  const l = await insertLoad({ po: extra.po ?? uniq("DEL"), status, its: extra.its });
  const paths = docs.length ? await seedDocs(l.id, docs) : [];
  return { ...l, paths };
}

const cardOf = (page: Page) => page.getByTestId("danger-zone");
const modalOf = (page: Page) => page.getByTestId("delete-modal");

async function openModal(page: Page, id: string, marker: string) {
  await page.goto(`/admin/loads/${id}`);
  await expect(page.locator("h1").first()).toContainText(marker); // page marker: the load page, not an error page
  await cardOf(page).getByTestId("delete-open").click();
  await expect(modalOf(page)).toBeVisible();
}

async function uiDelete(page: Page, id: string, marker: string, typed: string) {
  await openModal(page, id, marker);
  await modalOf(page).getByTestId("delete-confirm-input").fill(typed);
  await modalOf(page).getByTestId("delete-confirm").click();
  await page.waitForURL((u) => u.pathname === "/admin" && u.searchParams.has("deleted"), { timeout: 30_000 });
}

// The server action id of deleteLoadForever, read from the request the real button sends. Cached per worker.
let cachedActionId: string | null = null;
async function actionId(browser: Browser): Promise<string> {
  if (cachedActionId) return cachedActionId;
  const l = await seed("cancelled", ["bol"]);
  const { ctx, page } = await as(browser, "admin");
  let found: string | null = null;
  page.on("request", (r) => {
    const h = r.headers()["next-action"];
    if (r.method() === "POST" && h) found = h;
  });
  await uiDelete(page, l.id, l.loadNumber, l.loadNumber);
  await ctx.close();
  expect(found, "the delete button sent a server action request").not.toBeNull();
  cachedActionId = found;
  return found!;
}

async function forge(ctx: BrowserContext, id: string, loadId: string, typed: string) {
  const res = await ctx.request.post("/admin", {
    headers: { "Next-Action": id, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component", Origin: BASE_URL },
    data: JSON.stringify([loadId, typed]),
    maxRedirects: 0,
  });
  return { status: res.status(), text: await res.text(), headers: res.headers() };
}

// A supabase-js client signed in as an e2e user (the client library path a hostile customer or carrier would use).
async function signedIn(email: string): Promise<SupabaseClient> {
  const e = localEnv();
  assertLocalUrl(e.NEXT_PUBLIC_SUPABASE_URL, "supabase url");
  const link = await db().auth.admin.generateLink({ type: "magiclink", email });
  if (link.error) throw link.error;
  const c = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const v = await c.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  if (v.error) throw v.error;
  return c;
}

async function makeCsr(): Promise<string> {
  const email = `del-csr-${Date.now().toString(36)}-${process.pid}@e2e.test`;
  const made = await db().auth.admin.createUser({ email, email_confirm: true });
  expect(made.error).toBeNull();
  createdUsers.push(made.data.user!.id);
  const p = await db().from("profiles").insert({ id: made.data.user!.id, email, full_name: "Delete CSR", role: "staff_csr", is_active: true });
  expect(p.error).toBeNull();
  return email;
}

async function expectNotFound(page: Page, path: string, number: string) {
  const res = await page.goto(path);
  const body = await page.content();
  expect(res?.status() === 404 || body.includes("This page could not be found")).toBeTruthy();
  expect(body.includes(number)).toBe(false);
}

// ---- the admin deletes a delivered load with a BOL and a POD -------------------------------------------

test("admin deletes a delivered load with a BOL and a POD: database, events, documents, both files, audit row, redirect and banner", async ({ browser }) => {
  const l = await seed("delivered", ["bol", "pod"]);
  expect(l.itsNumber, "guard: the load has an ITS number").not.toBeNull();
  expect(await count("load_events", l.id), "guard: it has events").toBeGreaterThan(0);
  expect(await count("load_documents", l.id), "guard: it has two document rows").toBe(2);
  for (const p of l.paths) expect(await fileExists(p), "guard: the file exists before the delete").toBe(true);

  const { ctx, page } = await as(browser, "admin");
  await openModal(page, l.id, l.loadNumber);
  const summary = modalOf(page).getByTestId("delete-summary");
  await expect(modalOf(page)).toContainText("This permanently deletes the load, its timeline, and its BOL and POD files. This cannot be undone.");
  await expect(summary).toContainText(l.loadNumber);
  await expect(summary).toContainText("Mitrex to Howden");
  await expect(summary).toContainText("Delivered");
  await expect(modalOf(page).getByTestId("delete-doc-count")).toHaveText("2 files");
  await modalOf(page).getByTestId("delete-confirm-input").fill(l.loadNumber);
  await modalOf(page).getByTestId("delete-confirm").click();

  await page.waitForURL((u) => u.pathname === "/admin" && u.searchParams.get("deleted") === l.loadNumber, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Load board" })).toBeVisible();
  await expect(page.getByTestId("deleted-banner")).toHaveText(`Load ${l.loadNumber} deleted forever`);

  expect(await loadExists(l.id)).toBe(false);
  expect(await count("load_events", l.id)).toBe(0);
  expect(await count("load_documents", l.id)).toBe(0);
  for (const p of l.paths) expect(await fileExists(p), `file ${p} is gone`).toBe(false);
  const rows = await audit(l.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    load_id: l.id, request_ref: l.requestRef, its_load_number: l.itsNumber, last_status: "delivered",
    deleted_by: await adminId(), orphan_paths: [],
  });
  expect(Math.abs(Date.now() - new Date(rows[0].deleted_at as string).getTime())).toBeLessThan(120_000);

  // gone from the board, and its page is not found
  await expect(page.locator(`a[href="/admin/loads/${l.id}"]`)).toHaveCount(0);
  await expectNotFound(page, `/admin/loads/${l.id}`, l.loadNumber);
  await ctx.close();
});

test("a request without an ITS number is confirmed by its request ref, the ITS number is not asked for", async ({ browser }) => {
  const l = await seed("requested", ["bol"]);
  expect(l.itsNumber).toBeNull();
  expect(l.loadNumber).toBe(l.requestRef);
  const { ctx, page } = await as(browser, "admin");
  await openModal(page, l.id, l.requestRef);
  await expect(modalOf(page).getByTestId("delete-summary")).toContainText(l.requestRef);
  await expect(modalOf(page).getByTestId("delete-doc-count")).toHaveText("1 file");
  await modalOf(page).getByTestId("delete-confirm-input").fill(l.requestRef);
  await expect(modalOf(page).getByTestId("delete-confirm")).toBeEnabled();
  await modalOf(page).getByTestId("delete-confirm").click();
  await page.waitForURL((u) => u.pathname === "/admin" && u.searchParams.get("deleted") === l.requestRef, { timeout: 30_000 });
  await expect(page.getByTestId("deleted-banner")).toHaveText(`Load ${l.requestRef} deleted forever`);
  expect(await loadExists(l.id)).toBe(false);
  expect((await audit(l.id))[0]).toMatchObject({ request_ref: l.requestRef, its_load_number: null, last_status: "requested" });
  expect(await fileExists(l.paths[0])).toBe(false);
  await ctx.close();
});

// ---- the modal ---------------------------------------------------------------------------------------

test("the Delete forever button stays disabled until the text matches exactly, Cancel and Escape change nothing", async ({ browser }) => {
  const l = await seed("booked", ["bol"]);
  const { ctx, page } = await as(browser, "admin");
  await openModal(page, l.id, l.loadNumber);
  const confirm = modalOf(page).getByTestId("delete-confirm");
  const input = modalOf(page).getByTestId("delete-confirm-input");
  await expect(confirm).toBeDisabled();
  for (const wrong of ["1234", l.loadNumber.slice(0, -1), `${l.loadNumber}0`, ` ${l.loadNumber}`, l.requestRef, "delete"]) {
    await input.fill(wrong);
    await expect(confirm, `"${wrong}" does not enable the button`).toBeDisabled();
  }
  await input.fill(l.loadNumber);
  await expect(confirm, "control: the exact number enables it").toBeEnabled();
  await input.fill(`${l.loadNumber}x`);
  await expect(confirm).toBeDisabled();

  // Cancel closes, nothing deleted, the typed text is not kept
  await modalOf(page).getByTestId("delete-cancel").click();
  await expect(modalOf(page)).toHaveCount(0);
  await expect(cardOf(page).getByTestId("delete-open")).toBeFocused();
  await cardOf(page).getByTestId("delete-open").click();
  await expect(modalOf(page).getByTestId("delete-confirm-input")).toHaveValue("");
  await expect(modalOf(page).getByTestId("delete-confirm")).toBeDisabled();
  // Escape closes too
  await page.keyboard.press("Escape");
  await expect(modalOf(page)).toHaveCount(0);
  await expect(cardOf(page).getByTestId("delete-open")).toBeFocused();
  expect(await loadExists(l.id)).toBe(true);
  expect(await count("load_documents", l.id)).toBe(1);
  expect(await audit(l.id)).toHaveLength(0);
  await ctx.close();
});

test("the modal is a labelled dialog that traps focus", async ({ browser }) => {
  const l = await seed("booked", []);
  const { ctx, page } = await as(browser, "admin");
  await openModal(page, l.id, l.loadNumber);
  const dlg = modalOf(page);
  await expect(dlg).toHaveAttribute("role", "dialog");
  await expect(dlg).toHaveAttribute("aria-modal", "true");
  await expect(page.getByRole("dialog", { name: "Delete this load forever?" })).toBeVisible();
  await expect(dlg.getByTestId("delete-confirm-input")).toBeFocused(); // focus moved into the dialog
  const inside = () => page.evaluate(() => !!document.activeElement?.closest('[data-testid="delete-modal"]'));
  // Type the number so all three controls are tabbable, then walk the loop both ways.
  await dlg.getByTestId("delete-confirm-input").fill(l.loadNumber);
  for (let i = 0; i < 7; i++) { await page.keyboard.press("Tab"); expect(await inside(), `Tab ${i + 1} stays inside`).toBe(true); }
  for (let i = 0; i < 7; i++) { await page.keyboard.press("Shift+Tab"); expect(await inside(), `Shift+Tab ${i + 1} stays inside`).toBe(true); }
  // Shift+Tab from the first control wraps to the last (Cancel)
  await dlg.getByTestId("delete-confirm-input").focus();
  await page.keyboard.press("Shift+Tab");
  await expect(dlg.getByTestId("delete-cancel")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dlg.getByTestId("delete-confirm-input")).toBeFocused();
  // focus fell to the body: the next Tab comes back into the dialog
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Tab");
  expect(await inside()).toBe(true);
  expect(await loadExists(l.id)).toBe(true);
  await ctx.close();
});

test("double click on Delete forever deletes once (one server call, one audit row)", async ({ browser }) => {
  const l = await seed("requested", ["bol"]);
  const { ctx, page } = await as(browser, "admin");
  let calls = 0;
  page.on("request", (r) => { if (r.method() === "POST" && r.headers()["next-action"]) calls += 1; });
  await openModal(page, l.id, l.requestRef);
  await modalOf(page).getByTestId("delete-confirm-input").fill(l.requestRef);
  const confirm = modalOf(page).getByTestId("delete-confirm");
  await expect(confirm).toBeEnabled();
  // two clicks inside one task: the second lands before React has re-rendered the disabled button
  await confirm.evaluate((b) => { (b as HTMLButtonElement).click(); (b as HTMLButtonElement).click(); });
  await page.waitForURL((u) => u.pathname === "/admin" && u.searchParams.has("deleted"), { timeout: 30_000 });
  await expect(page.getByTestId("deleted-banner")).toHaveText(`Load ${l.requestRef} deleted forever`);
  expect(calls, "exactly one server action call").toBe(1);
  expect(await audit(l.id)).toHaveLength(1);
  expect(await loadExists(l.id)).toBe(false);
  await ctx.close();
});

// ---- who can and cannot --------------------------------------------------------------------------------

test("a wrong text sent straight to the server (forged call) deletes nothing, the same call with the right text deletes (control)", async ({ browser }) => {
  const id = await actionId(browser);
  const l = await seed("booked", ["bol", "pod"]);
  const { ctx } = await as(browser, "admin");
  for (const wrong of ["1234", "", "   ", l.requestRef, `${l.loadNumber}9`]) {
    const r = await forge(ctx, id, l.id, wrong);
    expect(r.status, `forged call with "${wrong}" reached the action`).toBeLessThan(400);
    expect(r.text, `refused for "${wrong}"`).toMatch(/does not match|Type the load number/);
    expect(await loadExists(l.id)).toBe(true);
  }
  expect(await count("load_events", l.id)).toBeGreaterThan(0);
  expect(await count("load_documents", l.id)).toBe(2);
  for (const p of l.paths) expect(await fileExists(p)).toBe(true);
  expect(await audit(l.id)).toHaveLength(0);
  // control: the forged call is a real call, so the refusals above are the text check and not a broken forgery
  const ok = await forge(ctx, id, l.id, l.loadNumber);
  expect(ok.headers["x-action-redirect"] ?? "").toContain("deleted=");
  expect(await loadExists(l.id)).toBe(false);
  for (const p of l.paths) expect(await fileExists(p)).toBe(false);
  await ctx.close();
});

test("a csr sees no Danger zone at all, and a forged delete call is refused with the load unchanged", async ({ browser }) => {
  const id = await actionId(browser);
  const email = await makeCsr();
  const l = await seed("booked", ["bol", "pod"]);
  const { ctx, page } = await anon(browser);
  await loginViaUi(page, email);
  await page.goto(`/admin/loads/${l.id}`);
  await expect(page.locator("h1").first()).toContainText(l.loadNumber);
  await expect(page.getByRole("heading", { name: "Override status" })).toBeVisible(); // the staff page, as a csr
  await expect(page.getByTestId("danger-zone")).toHaveCount(0);
  await expect(page.getByText("Danger zone")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Delete this load forever/ })).toHaveCount(0);
  expect(await page.content()).not.toContain("delete-open");

  const r = await forge(ctx, id, l.id, l.loadNumber); // the RIGHT confirmation text, so only the role can refuse
  expect(r.headers["x-action-redirect"] ?? "", "refused by requireAdmin before the database: redirected to the staff home").toMatch(/^\/admin(;|$)/);
  expect(r.headers["x-action-redirect"] ?? "").not.toContain("deleted=");
  expect(await loadExists(l.id)).toBe(true);
  expect(await count("load_events", l.id)).toBeGreaterThan(0);
  expect(await count("load_documents", l.id)).toBe(2);
  for (const p of l.paths) expect(await fileExists(p)).toBe(true);
  expect(await audit(l.id)).toHaveLength(0);

  // the database refuses a csr too (client library with the csr's own session)
  const csr = await signedIn(email);
  const rpc = await csr.rpc("delete_load_forever", { p_load: l.id, p_confirm: l.loadNumber });
  expect(rpc.error?.code).toBe("42501");
  const direct = await csr.from("loads").delete().eq("id", l.id).select("id");
  expect(direct.error).not.toBeNull();
  expect(await loadExists(l.id)).toBe(true);
  await ctx.close();
});

test("customer and carrier cannot delete through the client libraries, nothing changes (admin control deletes)", async ({ browser }) => {
  const l = await seed("booked", ["bol", "pod"]);
  const snapshot = async () => ({
    exists: await loadExists(l.id), events: await count("load_events", l.id), docs: await count("load_documents", l.id), audit: (await audit(l.id)).length,
  });
  const before = await snapshot();
  expect(before.exists).toBe(true);
  expect(before.events).toBeGreaterThan(0);
  expect(before.docs).toBe(2);

  for (const email of ["maria@e2e.test", "owner-a@e2e.test", "owner-b@e2e.test"]) {
    const c = await signedIn(email);
    const rpc = await c.rpc("delete_load_forever", { p_load: l.id, p_confirm: l.loadNumber });
    expect(rpc.error?.code, `${email} rpc refused`).toBe("42501");
    const orphans = await c.rpc("record_load_deletion_orphans", { p_load: l.id, p_paths: [l.paths[0]] });
    expect(orphans.error?.code, `${email} orphan log refused`).toBe("42501");
    const del = await c.from("loads").delete().eq("id", l.id).select("id");
    expect(del.error ?? { code: "none" }, `${email} direct DELETE has no privilege`).toMatchObject({ code: "42501" });
    const docDel = await c.from("load_documents").delete().eq("load_id", l.id).select("id");
    expect(docDel.error, `${email} cannot delete document rows`).not.toBeNull();
    const ins = await c.from("load_deletions").insert({ load_id: l.id, request_ref: "MTX-9999" });
    expect(ins.error, `${email} cannot write the audit table`).not.toBeNull();
    const read = await c.from("load_deletions").select("id");
    expect(read.error).toBeNull();
    expect(read.data, `${email} reads no audit rows`).toEqual([]);
    expect(await snapshot(), `${email}: nothing changed`).toEqual(before);
  }

  // control: the admin with the same client library path is allowed, so the refusals above are about the role
  const admin = await signedIn("admin@e2e.test");
  const ok = await admin.rpc("delete_load_forever", { p_load: l.id, p_confirm: l.loadNumber });
  expect(ok.error).toBeNull();
  expect([...(ok.data as string[])].sort()).toEqual([...l.paths].sort());
  expect(await loadExists(l.id)).toBe(false);
  const seen = await admin.from("load_deletions").select("load_id").eq("load_id", l.id);
  expect(seen.data).toHaveLength(1);
  // the database function does not remove files: that is the server action's job
  for (const p of l.paths) expect(await fileExists(p)).toBe(true);
  await db().storage.from("documents").remove(l.paths);
});

// ---- every list drops it, other trucks stay ----------------------------------------------------------------

test("deleting a load makes Maria's list, a carrier's list and the board drop it without a reload", async ({ browser }) => {
  const l = await seed("booked", ["bol"]);
  const maria = await as(browser, "maria");
  const carrier = await as(browser, "carrierA");
  const board = await as(browser, "admin");
  await maria.page.goto("/loads");
  await carrier.page.goto("/my-loads");
  await board.page.goto("/admin");
  const links = [
    [maria.page, `a[href="/loads/${l.id}"]`], [carrier.page, `a[href="/my-loads/${l.id}"]`], [board.page, `a[href="/admin/loads/${l.id}"]`],
  ] as const;
  for (const [p, sel] of links) {
    await expect(p.locator(sel).first(), `guard: ${sel} is listed before the delete`).toBeVisible();
    await p.evaluate(() => { (window as unknown as { __kept: number }).__kept = 1; });
  }
  const admin = await signedIn("admin@e2e.test");
  const del = await admin.rpc("delete_load_forever", { p_load: l.id, p_confirm: l.loadNumber });
  expect(del.error).toBeNull();
  for (const [p, sel] of links) {
    await expect(p.locator(sel), `${sel} dropped off the open list`).toHaveCount(0, { timeout: 40_000 });
    expect(await p.evaluate(() => (window as unknown as { __kept?: number }).__kept), "the page was not reloaded").toBe(1);
  }
  await db().storage.from("documents").remove(l.paths);
  await maria.ctx.close(); await carrier.ctx.close(); await board.ctx.close();
});

test("deleting one truck of a multi-truck booking leaves the other trucks, with their timelines and files", async ({ browser }) => {
  const po = uniq("DEL-TRUCKS");
  const trucks = [];
  for (let i = 0; i < 3; i++) trucks.push(await seed("booked", ["bol"], { po }));
  const [a, b, c] = trucks;
  const { ctx, page } = await as(browser, "admin");
  await uiDelete(page, b.id, b.loadNumber, b.loadNumber);
  expect(await loadExists(b.id)).toBe(false);
  expect(await count("load_documents", b.id)).toBe(0);
  expect(await fileExists(b.paths[0])).toBe(false);
  for (const t of [a, c]) {
    expect(await loadExists(t.id), `truck ${t.loadNumber} still exists`).toBe(true);
    expect(await count("load_events", t.id)).toBeGreaterThan(0);
    expect(await count("load_documents", t.id)).toBe(1);
    expect(await fileExists(t.paths[0])).toBe(true);
    expect(await audit(t.id)).toHaveLength(0);
    await expect(page.locator(`a[href="/admin/loads/${t.id}"]`).first()).toBeVisible();
  }
  const { data } = await db().from("loads").select("id").eq("po_number", po);
  expect((data ?? []).map((r) => r.id).sort()).toEqual([a.id, c.id].sort());
  await ctx.close();
  await db().from("loads").update({ status: "cancelled" }).in("id", [a.id, c.id]);
});

// ---- storage failure: the load is gone, the files are logged ------------------------------------------------

function fakeDeps(over: Partial<DeleteDeps> & { paths?: unknown } = {}) {
  const calls = { rpc: [] as unknown[][], remove: [] as string[][], orphans: [] as unknown[][] };
  const deps: DeleteDeps = {
    rpcDelete: async (...a) => { calls.rpc.push(a); return { data: over.paths ?? [], error: null }; },
    removeFiles: async (p) => { calls.remove.push(p); return { error: null }; },
    recordOrphans: async (...a) => { calls.orphans.push(a); return { error: null }; },
    ...over,
  };
  return { deps, calls };
}
const LID = "30000000-0000-0000-0000-0000000000aa";
const P1 = `${LID}/bol/d0000000-0000-0000-0000-000000000001.pdf`;
const P2 = `${LID}/pod/d0000000-0000-0000-0000-000000000002.jpg`;

test("storage failure with the real database: the load is deleted, orphan_paths records the files, the message says so", async () => {
  const l = await seed("delivered", ["bol", "pod"]);
  const admin = await signedIn("admin@e2e.test");
  const out = await deleteLoadCore({
    rpcDelete: async (id, text) => { const r = await admin.rpc("delete_load_forever", { p_load: id, p_confirm: text }); return { data: r.data, error: r.error }; },
    removeFiles: async () => ({ error: { message: "storage unavailable (simulated)" } }),
    recordOrphans: async (id, paths) => { const r = await admin.rpc("record_load_deletion_orphans", { p_load: id, p_paths: paths }); return { error: r.error }; },
  }, l.id, l.loadNumber);
  expect(out).toMatchObject({ ok: true, number: l.loadNumber, removed: 0, orphaned: 2, orphansLogged: true });
  expect(await loadExists(l.id)).toBe(false);
  expect(await count("load_events", l.id)).toBe(0);
  const rows = await audit(l.id);
  expect(rows).toHaveLength(1);
  expect([...(rows[0].orphan_paths as string[])].sort()).toEqual([...l.paths].sort());
  for (const p of l.paths) expect(await fileExists(p), "the files really are still there (the simulated remover failed)").toBe(true);
  expect(deletedBanner({ deleted: l.loadNumber, orphans: "2" })).toEqual({
    tone: "warn", text: "The load was deleted. 2 files could not be removed and were logged for cleanup.",
  });
  await db().storage.from("documents").remove(l.paths);
});

test("the orphan banner is what the admin sees on /admin", async ({ browser }) => {
  const { ctx, page } = await as(browser, "admin");
  await page.goto("/admin?deleted=313&orphans=2");
  await expect(page.getByRole("heading", { name: "Load board" })).toBeVisible();
  await expect(page.getByTestId("deleted-banner")).toHaveText("The load was deleted. 2 files could not be removed and were logged for cleanup.");
  await page.goto("/admin?deleted=313");
  await expect(page.getByTestId("deleted-banner")).toHaveText("Load 313 deleted forever");
  await page.goto("/admin?deleted=%3Cb%3Ex%3C%2Fb%3E&orphans=2"); // markup in the URL is never shown
  await expect(page.getByRole("heading", { name: "Load board" })).toBeVisible();
  await expect(page.getByTestId("deleted-banner")).toHaveCount(0);
  await ctx.close();
});

test("deleteLoadCore: files removed only from the paths the function returned, strict shape, never twice", async () => {
  const f = fakeDeps({ paths: [P1, P2, "../etc/passwd", `${LID}/bol/../x.pdf`, `30000000-0000-0000-0000-0000000000bb/bol/d0000000-0000-0000-0000-000000000009.pdf`, 7] });
  const out = await deleteLoadCore(f.deps, LID, `  313 `);
  expect(f.calls.rpc).toEqual([[LID, "313"]]); // trimmed, once
  expect(f.calls.remove).toEqual([[P1, P2]]); // the two valid paths of THIS load only
  expect(f.calls.orphans).toEqual([]);
  expect(out).toEqual({ ok: true, number: "313", removed: 2, orphaned: 3, orphansLogged: true }); // 3 bad names are reported, not removed
});

test("deleteLoadCore: remover returns an error or throws -> orphans recorded, the orphan log failing is reported, never a failure", async () => {
  const a = fakeDeps({ paths: [P1, P2], removeFiles: async () => ({ error: { message: "boom" } }) });
  expect(await deleteLoadCore(a.deps, LID, "313")).toEqual({ ok: true, number: "313", removed: 0, orphaned: 2, orphansLogged: true });
  expect(a.calls.orphans).toEqual([[LID, [P1, P2]]]);
  const b = fakeDeps({ paths: [P1], removeFiles: async () => { throw new Error("network"); } });
  expect(await deleteLoadCore(b.deps, LID, "313")).toMatchObject({ ok: true, orphaned: 1, orphansLogged: true });
  expect(b.calls.orphans).toEqual([[LID, [P1]]]);
  const c = fakeDeps({ paths: [P1], removeFiles: async () => ({ error: { message: "boom" } }), recordOrphans: async () => ({ error: { message: "db down" } }) });
  expect(await deleteLoadCore(c.deps, LID, "313")).toEqual({ ok: true, number: "313", removed: 0, orphaned: 1, orphansLogged: false });
  expect(deletedBanner({ deleted: "313", orphans: "1", logged: "0" })?.text).toContain("cleanup log also failed");
  expect(deletedBanner({ deleted: "313", orphans: "1" })?.text).toBe("The load was deleted. 1 file could not be removed and was logged for cleanup.");
  // no documents: the remover is not even called
  const d = fakeDeps({ paths: [] });
  expect(await deleteLoadCore(d.deps, LID, "313")).toMatchObject({ ok: true, removed: 0, orphaned: 0 });
  expect(d.calls.remove).toEqual([]);
});

test("deleteLoadCore: a refusal from the database touches no file; bad input never reaches the database", async () => {
  for (const [code, message, want] of [
    ["42501", "not authorized", "Only an admin can delete a load."],
    ["P0001", "confirmation does not match", "The text you typed does not match. Nothing was deleted."],
    ["P0002", "load not found", "This load no longer exists."],
    ["XX000", "something internal with details", "The load could not be deleted. Nothing was changed. Please try again."],
  ] as const) {
    const f = fakeDeps({ rpcDelete: async () => ({ data: null, error: { code, message } }) });
    expect(await deleteLoadCore(f.deps, LID, "313")).toEqual({ ok: false, error: want });
    expect(f.calls.remove).toEqual([]);
    expect(f.calls.orphans).toEqual([]);
  }
  for (const [id, typed] of [["nope", "313"], [`${LID.toUpperCase()}`, "313"], [LID, ""], [LID, "   "], [LID, 313], [LID, null], [undefined, "313"], [LID, "9".repeat(41)]] as const) {
    const f = fakeDeps();
    const out = await deleteLoadCore(f.deps, id, typed);
    expect(out.ok, `${String(id)} / ${String(typed)}`).toBe(false);
    expect(f.calls.rpc, "the database was not called").toEqual([]);
  }
});

// ---- phone ---------------------------------------------------------------------------------------------------

test("phone 375x812: the Danger zone and the modal fit the screen, no horizontal overflow, targets at least 44px", async ({ browser }) => {
  const l = await seed("delivered", ["bol", "pod"]);
  const { ctx, page } = await as(browser, "admin", VIEWPORT);
  await page.goto(`/admin/loads/${l.id}`);
  await expect(page.locator("h1").first()).toContainText(l.loadNumber);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const small = (scope: string) => page.evaluate((s) => {
    const out: string[] = [];
    document.querySelector(s)!.querySelectorAll("button, input").forEach((e) => {
      const r = (e as HTMLElement).getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.height < 43.5) out.push(`${(e.textContent || (e as HTMLInputElement).name || e.tagName).trim().slice(0, 20)}=${r.height.toFixed(1)}`);
    });
    return out;
  }, scope);
  expect(await overflow(), "page overflow before the modal").toBeLessThanOrEqual(0);
  expect(await small('[data-testid="danger-zone"]')).toEqual([]);
  await cardOf(page).getByTestId("delete-open").scrollIntoViewIfNeeded();
  await cardOf(page).getByTestId("delete-open").click();
  await expect(modalOf(page)).toBeVisible();
  await modalOf(page).getByTestId("delete-confirm-input").fill(l.loadNumber);
  expect(await overflow(), "page overflow with the modal").toBeLessThanOrEqual(0);
  const box = await modalOf(page).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(-0.5);
  expect(box!.x + box!.width).toBeLessThanOrEqual(VIEWPORT.width + 0.5);
  expect(await modalOf(page).evaluate((e) => e.scrollWidth - e.clientWidth), "modal content overflow").toBeLessThanOrEqual(0);
  expect(await small('[data-testid="delete-modal"]')).toEqual([]);
  for (const t of ["delete-confirm", "delete-cancel", "delete-confirm-input"]) {
    await expect(modalOf(page).getByTestId(t)).toBeInViewport();
  }
  expect(await loadExists(l.id)).toBe(true);
  await ctx.close();
  await db().storage.from("documents").remove(l.paths);
});
