import { expect, test, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import { adminClient, as, anon, insertLoad, isoDate, loadRow, PNG_1X1, uniq } from "./support/helpers";
import { clearMail, latestCode } from "./support/mail";
import type { Who } from "./support/users";
import { safeNext } from "../src/lib/safe-next";

test.describe.configure({ timeout: 180_000 }); // sign in tests may wait out the code cooldown

// C3 failure UX. Every database claim is read back through the service role. Network failures are
// simulated in the browser with page.route / setOffline, never against any non-local host.

const CARRIER_EMAIL = "owner-a@e2e.test";

// Loads this file creates are parked (cancelled) afterwards, so the carrier lists other specs compare
// (they cap the active section) do not fill up with this file's loads.
const created: string[] = [];
async function seed(opts: Parameters<typeof insertLoad>[0]) {
  const r = await insertLoad(opts);
  created.push(r.id);
  return r;
}
test.afterAll(async () => {
  if (created.length === 0) return;
  await adminClient().from("loads").update({ status: "cancelled" })
    .in("id", created).in("status", ["booked", "at_pickup", "loading", "enroute", "at_delivery"]);
});
const STORAGE_UPLOAD = "**/storage/v1/object/documents/**";
// The app's own notices (Next also keeps an empty route announcer with role=alert on the page).
const alertOf = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');
const NEXT_STEP = (page: Page) => page.getByTestId("next-step");

async function openFresh(page: Page, path: string) {
  await page.goto("about:blank");
  await page.goto(path);
}

// ---- network helpers -------------------------------------------------------------------------

type Behaviour = (route: Route) => Promise<void>;
const isAction = (route: Route) => route.request().method() === "POST" && "next-action" in route.request().headers();

// One router per page, installed BEFORE the first navigation (WebKit can let the first request after a late
// page.route slip through) and switched by setting `mode`. Only server action calls (POST with a
// next-action header) and storage uploads are touched; everything else falls through.
const modes = new WeakMap<Page, { action: Behaviour | null; upload: Behaviour | null }>();
async function asNet(browser: Browser, who: Who) {
  // Service workers blocked: page.route cannot see requests a service worker answers (WebKit, and Chromium before it claims the page).
  const r = await as(browser, who, undefined, { serviceWorkers: "block" });
  const mode: { action: Behaviour | null; upload: Behaviour | null } = { action: null, upload: null };
  modes.set(r.page, mode);
  await r.page.route("**/*", async (route) => {
    if (isAction(route) && mode.action) return mode.action(route);
    if (route.request().method() === "POST" && route.request().url().includes("/storage/v1/object/documents/") && mode.upload) {
      return mode.upload(route);
    }
    return route.fallback();
  });
  return r;
}
function onAction(page: Page, behaviour: Behaviour) {
  modes.get(page)!.action = behaviour;
  return async () => { modes.get(page)!.action = null; };
}
function onUpload(page: Page, behaviour: Behaviour) {
  modes.get(page)!.upload = behaviour;
  return async () => { modes.get(page)!.upload = null; };
}

// Counts server action requests as the browser sends them (aborted and delayed ones included).
function countActions(page: Page) {
  const box = { n: 0 };
  page.on("request", (r) => { if (r.method() === "POST" && "next-action" in r.headers()) box.n += 1; });
  return box;
}

// A request that never answers. release() aborts what is still pending, as a dead connection eventually does.
function blackhole() {
  const held: Route[] = [];
  return {
    behaviour: async (route: Route) => { held.push(route); },
    release: async () => { for (const r of held.splice(0)) await r.abort().catch(() => {}); },
    land: async () => { for (const r of held.splice(0)) await r.continue().catch(() => {}); }, // the slow request finally arrives
    count: () => held.length,
  };
}

// ---- database helpers ------------------------------------------------------------------------

async function podRows(id: string) {
  const { data, error } = await adminClient().from("load_documents").select("id,storage_path").eq("load_id", id).eq("kind", "pod");
  if (error) throw error;
  return data ?? [];
}
async function events(id: string) {
  const { data, error } = await adminClient().from("load_events").select("from_status,to_status").eq("load_id", id).order("created_at");
  if (error) throw error;
  // Transitions only: the database also writes a creation event (from_status null) when a load is inserted.
  return (data ?? []).filter((e) => e.from_status !== null);
}
async function podFiles(id: string): Promise<string[]> {
  const { data, error } = await adminClient().storage.from("documents").list(`${id}/pod`);
  if (error) throw error;
  return (data ?? []).map((f) => f.name);
}
async function status(id: string) {
  return (await loadRow(id)).status as string;
}

// ---- sign in helper (real code login UI on the page that is showing) ---------------------------

// The code login has a per-address send cooldown ("Too many requests"), so a send that is throttled is retried.
async function signInHere(page: Page, email: string) {
  await page.getByTestId("login-email").fill(email);
  for (let attempt = 0; ; attempt++) {
    await clearMail(); // a code mail from a login a moment ago must not be mistaken for the new one
    const sentAt = Date.now();
    await page.getByTestId("login-send").click();
    const outcome = await Promise.race([
      page.getByTestId("login-code").waitFor({ timeout: 20_000 }).then(() => "code" as const, () => "none" as const),
      page.getByTestId("login-error").waitFor({ timeout: 20_000 }).then(() => "error" as const, () => "none" as const),
    ]);
    if (outcome === "code") {
      const code = await latestCode(email, sentAt);
      await page.getByTestId("login-code").fill(code);
      return;
    }
    if (attempt >= 14) throw new Error("sign in code request stayed throttled");
    await page.waitForTimeout(5000);
  }
}

async function accessTokenOf(ctx: BrowserContext): Promise<string> {
  const cookies = (await ctx.cookies()).filter((c) => /^sb-.*-auth-token(\.\d+)?$/.test(c.name));
  cookies.sort((a, b) => a.name.localeCompare(b.name));
  let raw = decodeURIComponent(cookies.map((c) => c.value).join(""));
  if (raw.startsWith("base64-")) raw = Buffer.from(raw.slice(7), "base64url").toString("utf8");
  return (JSON.parse(raw) as { access_token: string }).access_token;
}

async function bookingForm(page: Page, po: string) {
  await page.goto("/book");
  await page.getByLabel("Pickup location").selectOption({ label: "Mitrex (Toronto)" });
  await page.getByLabel("Delivery location").selectOption({ label: "Howden (Scarborough)" });
  const names = page.getByLabel("Contact name");
  const phones = page.getByLabel("Contact phone");
  await names.nth(0).fill("Pat Pickup");
  await phones.nth(0).fill("416-555-0101");
  await names.nth(1).fill("Dee Delivery");
  await phones.nth(1).fill("416-555-0102");
  await page.getByLabel("Pickup date").fill(isoDate(3));
  await page.getByLabel("Appointment time (ET)").nth(0).fill("08:00");
  await page.getByLabel("Delivery date").fill(isoDate(3));
  await page.getByLabel("Appointment time (ET)").nth(1).fill("14:00");
  await page.getByRole("radiogroup", { name: "Equipment size" }).getByRole("radio", { name: /48/ }).click();
  await page.getByLabel("PO number (optional)").fill(po);
}
async function loadsWithPo(po: string) {
  const { data, error } = await adminClient().from("loads").select("id").eq("po_number", po);
  if (error) throw error;
  return data ?? [];
}

// =================================================================================================
// 1) POD upload failure
// =================================================================================================

for (const mode of ["abort", "http500"] as const) {
  test(`POD upload fails (${mode}): clear message, Try again, nothing delivered; retry delivers once`, async ({ browser }) => {
    const { id } = await seed({ po: uniq(`PODFAIL-${mode}`), status: "at_delivery" });
    const { ctx, page } = await asNet(browser, "carrierA");
    await openFresh(page, `/my-loads/${id}`);
    const restore = onUpload(page, (route) =>
      mode === "abort"
        ? route.abort()
        : route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom" }) }));

    await NEXT_STEP(page).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('input[type="file"]').setInputFiles({ name: "pod.png", mimeType: "image/png", buffer: PNG_1X1 });
    await dialog.getByTestId("pod-submit").click();

    await expect(dialog.getByRole("alert")).toContainText("The photo did not upload");
    await expect(dialog.getByRole("alert")).toContainText("not marked delivered");
    const retry = dialog.getByTestId("pod-retry");
    await expect(retry).toBeVisible();
    await expect(retry).toBeEnabled();
    await expect(retry).toHaveText("Try again");

    // Authoritative state: still at_delivery, no POD row, no stored file, no event.
    expect(await status(id)).toBe("at_delivery");
    expect(await podRows(id)).toEqual([]);
    expect(await podFiles(id)).toEqual([]);
    expect(await events(id)).toEqual([]);

    await restore();
    await retry.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => status(id)).toBe("delivered");
    expect(await podRows(id)).toHaveLength(1);
    expect(await podFiles(id)).toHaveLength(1);
    expect((await events(id)).map((e) => e.to_status)).toEqual(["delivered"]);
    await ctx.close();
  });
}

test("POD saved but the final status call fails: not claimed delivered; retry reuses the POD and delivers", async ({ browser }) => {
  const { id } = await seed({ po: uniq("PODSTATUS"), status: "at_delivery" });
  const { ctx, page } = await asNet(browser, "carrierA");
  await openFresh(page, `/my-loads/${id}`);
  const restore = onAction(page, (route) => route.abort());

  await NEXT_STEP(page).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({ name: "pod.png", mimeType: "image/png", buffer: PNG_1X1 });
  await dialog.getByTestId("pod-submit").click();

  await expect(dialog.getByRole("alert")).toContainText("Could not reach the server");
  await expect(dialog.getByTestId("pod-retry")).toBeEnabled();
  await expect(dialog).toContainText("A POD photo is already saved"); // podDone: the saved POD is reused
  expect(await status(id)).toBe("at_delivery");
  expect((await loadRow(id)).delivered_at).toBeNull();
  expect(await podRows(id)).toHaveLength(1);
  expect(await events(id)).toEqual([]);

  await restore();
  await dialog.getByTestId("pod-retry").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => status(id)).toBe("delivered");
  expect(await podRows(id)).toHaveLength(1); // still exactly one POD
  expect(await podFiles(id)).toHaveLength(1);
  expect((await events(id)).map((e) => e.to_status)).toEqual(["delivered"]);
  await ctx.close();
});

// =================================================================================================
// 2) Double tap safety
// =================================================================================================

test("double click on the next step: one request, one transition, one event", async ({ browser }) => {
  const { id } = await seed({ po: uniq("DBLCLICK"), status: "booked" });
  const { ctx, page } = await asNet(browser, "carrierA");
  await openFresh(page, `/my-loads/${id}`);
  const posts = countActions(page);
  await NEXT_STEP(page).dblclick();
  await expect(NEXT_STEP(page)).toHaveText("Start loading");
  await page.waitForTimeout(500);
  expect(await status(id)).toBe("at_pickup");
  expect(await events(id)).toEqual([{ from_status: "booked", to_status: "at_pickup" }]);
  expect(posts.n).toBe(1);
  await ctx.close();
});

test("double tap, two clicks 50 ms apart, while the request is slow: busy at once, one transition", async ({ browser }) => {
  const { id } = await seed({ po: uniq("DBLTAP"), status: "at_pickup" });
  const { ctx, page } = await asNet(browser, "carrierA");
  await openFresh(page, `/my-loads/${id}`);
  const posts = countActions(page);
  onAction(page, async (route) => { await new Promise((r) => setTimeout(r, 800)); await route.continue().catch(() => {}); });
  const box = (await NEXT_STEP(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.click(x, y);
  await expect(NEXT_STEP(page)).toBeDisabled(); // disabled immediately, not after the response
  await page.waitForTimeout(50);
  await page.mouse.click(x, y);
  await expect(NEXT_STEP(page)).toHaveText("Leave for delivery", { timeout: 10_000 });
  await page.waitForTimeout(500);
  expect(await status(id)).toBe("loading");
  expect(await events(id)).toEqual([{ from_status: "at_pickup", to_status: "loading" }]);
  expect(posts.n).toBe(1);
  await ctx.close();
});

test("enroute modal is double submit safe", async ({ browser }) => {
  const { id } = await seed({ po: uniq("DBLENR"), status: "loading" });
  const { ctx, page } = await asNet(browser, "carrierA");
  await openFresh(page, `/my-loads/${id}`);
  await NEXT_STEP(page).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="datetime-local"]').fill(`${isoDate(4)}T16:30`);
  const posts = countActions(page);
  onAction(page, async (route) => { await new Promise((r) => setTimeout(r, 600)); await route.continue().catch(() => {}); });
  const confirm = dialog.getByRole("button", { name: "Confirm ETA and leave" });
  await confirm.dblclick();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await status(id)).toBe("enroute");
  expect(await events(id)).toEqual([{ from_status: "loading", to_status: "enroute" }]);
  expect(posts.n).toBe(1);
  await ctx.close();
});

test("delivered modal is double submit safe: one POD row, one event", async ({ browser }) => {
  const { id } = await seed({ po: uniq("DBLDEL"), status: "at_delivery" });
  const { ctx, page } = await asNet(browser, "carrierA");
  await openFresh(page, `/my-loads/${id}`);
  await NEXT_STEP(page).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({ name: "pod.png", mimeType: "image/png", buffer: PNG_1X1 });
  await dialog.getByTestId("pod-submit").dblclick();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => status(id)).toBe("delivered");
  await page.waitForTimeout(500);
  expect(await podRows(id)).toHaveLength(1);
  expect(await podFiles(id)).toHaveLength(1);
  expect(await events(id)).toEqual([{ from_status: "at_delivery", to_status: "delivered" }]);
  await ctx.close();
});

test("server refuses a stale or replayed request (expectedFrom): friendly message, no extra step", async ({ browser }) => {
  const { id } = await seed({ po: uniq("STALE"), status: "booked" });
  const a = await asNet(browser, "carrierA");
  const b = await asNet(browser, "carrierA");
  // Page B keeps its stale view: no websocket, no RSC refresh.
  await b.page.routeWebSocket(/.*/, () => {});
  let rscOpen = false; // opened only after B has tapped, so the refresh that follows the stale answer can run
  await b.page.route(/[?&]_rsc=/, (route) => (rscOpen ? route.fallback() : route.abort()));
  await openFresh(b.page, `/my-loads/${id}`);
  await expect(NEXT_STEP(b.page)).toHaveText("Arrived at pickup");

  // Capture the real request page A sends, to replay it later.
  await openFresh(a.page, `/my-loads/${id}`);
  const sent = a.page.waitForRequest((r) => r.method() === "POST" && "next-action" in r.headers());
  await NEXT_STEP(a.page).click();
  const req = await sent;
  await expect(NEXT_STEP(a.page)).toHaveText("Start loading");
  expect(await status(id)).toBe("at_pickup");

  // B still believes the load is booked and taps the same button.
  rscOpen = true;
  await NEXT_STEP(b.page).click();
  await expect(alertOf(b.page)).toContainText("already updated");
  await expect(NEXT_STEP(b.page)).toHaveText("Start loading"); // and it refreshed to the real state
  await expect(alertOf(b.page)).not.toContainText("one step at a time");
  expect(await status(id)).toBe("at_pickup");

  // Replay of A's original request, byte for byte, with the session cookies: refused, nothing written.
  const replay = await a.ctx.request.post(req.url(), { headers: req.headers(), data: req.postDataBuffer() ?? undefined });
  expect(await replay.text()).toContain("already updated");
  expect(await status(id)).toBe("at_pickup");
  expect(await events(id)).toEqual([{ from_status: "booked", to_status: "at_pickup" }]);
  await a.ctx.close();
  await b.ctx.close();
});

// =================================================================================================
// 3) Session expiry
// =================================================================================================

test("safeNext: hostile and valid values (unit level)", () => {
  for (const bad of ["//evil.test", "/\\evil.test", "https://evil.test", "javascript:alert(1)", "/%5Cevil.test", "/%2F%2Fevil.test",
    "/login", "/login?next=/x", "/auth/callback", "/auth/signout", "", "evil", "/a\nb", "http://evil.test/x",
    "/\t/evil.test", "/%09/evil.test", "/%0d%0aevil", "///evil.test", "/\\/evil.test", " //evil.test", "%2F%2Fevil.test", "/%5cevil.test"]) {
    expect(safeNext(bad), `rejects ${JSON.stringify(bad)}`).toBeNull();
  }
  for (const good of ["/my-loads", "/my-loads/abc?tab=1", "/admin/loads/1?x=a%20b", "/book"]) {
    expect(safeNext(good), `accepts ${good}`).toBe(good);
  }
});

test("cookies cleared: protected page goes to /login?next=<path and query>, sign in lands on that page", async ({ browser }) => {
  const { id } = await seed({ po: uniq("EXPIRED"), status: "booked" });
  const { ctx, page } = await asNet(browser, "carrierA");
  await ctx.clearCookies();
  const target = `/my-loads/${id}?from=expired`;
  await page.goto(target);
  await expect(page).toHaveURL(/\/login\?/, { timeout: 15_000 });
  expect(new URL(page.url()).searchParams.get("next")).toBe(target);
  await signInHere(page, CARRIER_EMAIL);
  await page.waitForURL((u) => u.pathname !== "/login", { timeout: 20_000 });
  const url = new URL(page.url());
  expect(url.pathname + url.search).toBe(target); // the original path, not the role home (/my-loads)
  await expect(NEXT_STEP(page)).toBeVisible();
  await ctx.close();
});

test("refresh token revoked server side (admin signOut): same redirect and return", async ({ browser }) => {
  const { id } = await seed({ po: uniq("REVOKED"), status: "booked" });
  // A session of its own, so revoking it leaves the shared storage state of the other tests intact.
  const { ctx, page } = await anon(browser);
  await page.goto("/login");
  await signInHere(page, CARRIER_EMAIL);
  await page.waitForURL((u) => u.pathname === "/my-loads", { timeout: 20_000 });
  const jwt = await accessTokenOf(ctx);
  const { error } = await adminClient().auth.admin.signOut(jwt, "local");
  expect(error).toBeNull();

  const target = `/my-loads/${id}?from=revoked`;
  await page.goto(target);
  await expect(page).toHaveURL(/\/login\?/, { timeout: 15_000 });
  expect(new URL(page.url()).searchParams.get("next")).toBe(target);
  await signInHere(page, CARRIER_EMAIL);
  await page.waitForURL((u) => u.pathname !== "/login", { timeout: 20_000 });
  const url = new URL(page.url());
  expect(url.pathname + url.search).toBe(target);
  await ctx.close();
});

test("hostile next is ignored: sign in lands on the role home on this origin", async ({ browser }) => {
  // One real sign in (the code login has a per-address cooldown); the other hostile values are covered above.
  const { ctx, page } = await anon(browser);
  await page.goto("/login");
  const base = new URL(page.url()).origin;
  await page.goto(`/login?next=${encodeURIComponent("/\\evil.test")}`);
  await signInHere(page, CARRIER_EMAIL);
  await page.waitForURL((u) => u.pathname !== "/login", { timeout: 20_000 });
  const url = new URL(page.url());
  expect(url.origin).toBe(base);
  expect(url.pathname).toBe("/my-loads");
  await ctx.close();
});

test("in-app: a server action with an expired session sends the user to /login?next=<current path>", async ({ browser }) => {
  const { id } = await seed({ po: uniq("INAPP"), status: "booked" });
  const { ctx, page } = await asNet(browser, "carrierA");
  await page.routeWebSocket(/.*/, () => {});
  await page.route(/[?&]_rsc=/, (route) => route.abort()); // the page stays as rendered; only the action runs
  const target = `/my-loads/${id}?from=inapp`;
  await openFresh(page, target);
  await expect(NEXT_STEP(page)).toHaveText("Arrived at pickup");
  await ctx.clearCookies();
  await NEXT_STEP(page).click();
  await expect(page).toHaveURL(/\/login\?/, { timeout: 15_000 });
  expect(new URL(page.url()).searchParams.get("next")).toBe(target);
  expect(await status(id)).toBe("booked");
  await ctx.close();
});

// =================================================================================================
// 4) Slow or dead network never leaves a button stuck
// =================================================================================================

test("slow response (3 s): busy label, then completes", async ({ browser }) => {
  const { id } = await seed({ po: uniq("SLOW"), status: "booked" });
  const { ctx, page } = await asNet(browser, "carrierA");
  await openFresh(page, `/my-loads/${id}`);
  onAction(page, async (route) => { await new Promise((r) => setTimeout(r, 3000)); await route.continue().catch(() => {}); });
  await NEXT_STEP(page).click();
  await expect(NEXT_STEP(page)).toHaveText("Saving...");
  await expect(NEXT_STEP(page)).toBeDisabled();
  await expect(NEXT_STEP(page)).toHaveText("Start loading", { timeout: 15_000 });
  await expect(NEXT_STEP(page)).toBeEnabled();
  expect(await status(id)).toBe("at_pickup");
  await ctx.close();
});

test("dead network on the status button: watchdog clears busy, says so, control usable; a late landing plus retry steps once", async ({ browser }) => {
  const { id } = await seed({ po: uniq("DEADSTEP"), status: "booked" });
  const { ctx, page } = await asNet(browser, "carrierA");
  await openFresh(page, `/my-loads/${id}`);
  const before = page.url();
  const hole = blackhole();
  const restore = onAction(page, hole.behaviour);
  await NEXT_STEP(page).click();
  await expect(NEXT_STEP(page)).toHaveText("Saving...");
  await expect(alertOf(page)).toContainText("taking too long", { timeout: 12_000 });
  await expect(alertOf(page)).toContainText(/check your connection/i);
  await expect(NEXT_STEP(page)).toBeEnabled();
  await expect(NEXT_STEP(page)).toHaveText("Arrived at pickup");
  expect(page.url()).toBe(before); // no navigation
  expect(hole.count()).toBe(1);
  expect(await status(id)).toBe("booked"); // the request never reached the server

  // The held request now lands late and the user taps again: expectedFrom turns the second one into a no-op.
  await restore();
  await hole.land();
  await NEXT_STEP(page).click();
  await expect(NEXT_STEP(page)).toHaveText("Start loading");
  expect(await status(id)).toBe("at_pickup");
  expect(await events(id)).toEqual([{ from_status: "booked", to_status: "at_pickup" }]);
  await ctx.close();
});

test("dead network in the ETA modal: watchdog, modal usable, retry saves", async ({ browser }) => {
  const { id } = await seed({ po: uniq("DEADETA"), status: "enroute" });
  const oldEta = (await loadRow(id)).eta as string;
  const { ctx, page } = await asNet(browser, "carrierA");
  await openFresh(page, `/my-loads/${id}`);
  await page.getByRole("button", { name: "Update ETA" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="datetime-local"]').fill(`${isoDate(6)}T09:15`);
  const hole = blackhole();
  const restore = onAction(page, hole.behaviour);
  await dialog.getByRole("button", { name: "Save ETA" }).click();
  await expect(dialog.getByRole("button", { name: "Saving..." })).toBeDisabled();
  await expect(dialog.getByRole("alert")).toContainText("taking too long", { timeout: 12_000 });
  const retry = dialog.getByRole("button", { name: "Try again" });
  await expect(retry).toBeEnabled();
  expect((await loadRow(id)).eta).toBe(oldEta);

  await hole.release();
  await restore();
  await retry.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await loadRow(id)).eta).not.toBe(oldEta);
  expect(await status(id)).toBe("enroute");
  await ctx.close();
});

test("dead network during the POD photo upload: watchdog, no stray rows; a late landing plus retry leaves one file and one POD", async ({ browser }) => {
  const { id } = await seed({ po: uniq("DEADPOD"), status: "at_delivery" });
  const { ctx, page } = await asNet(browser, "carrierA");
  await openFresh(page, `/my-loads/${id}`);
  await NEXT_STEP(page).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({ name: "pod.png", mimeType: "image/png", buffer: PNG_1X1 });
  const hole = blackhole();
  const restore = onUpload(page, hole.behaviour);
  const before = page.url();
  await dialog.getByTestId("pod-submit").click();
  await expect(dialog.getByRole("button", { name: "Uploading..." })).toBeDisabled();
  await expect(dialog.getByRole("alert")).toContainText("taking too long", { timeout: 12_000 });
  const retry = dialog.getByTestId("pod-retry");
  await expect(retry).toBeEnabled();
  expect(page.url()).toBe(before);
  expect(await status(id)).toBe("at_delivery");
  expect(await podRows(id)).toEqual([]);

  // The held upload now lands late (the watchdog had already given up on it), then the user retries.
  await restore();
  await hole.land();
  await retry.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => status(id)).toBe("delivered");
  expect(await podRows(id)).toHaveLength(1);
  expect(await podFiles(id)).toHaveLength(1);
  await ctx.close();
});

test("POD row insert held past the watchdog, retry inserts, then the held one lands: still exactly one POD row", async ({ browser }) => {
  const { id } = await seed({ po: uniq("PODRACE"), status: "at_delivery" });
  const { ctx, page } = await asNet(browser, "carrierA");
  const held: Route[] = [];
  let hold = true;
  await page.route("**/rest/v1/load_documents*", async (route) => {
    if (hold && route.request().method() === "POST") { held.push(route); return; }
    return route.fallback();
  });
  await openFresh(page, `/my-loads/${id}`);
  await NEXT_STEP(page).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({ name: "pod.png", mimeType: "image/png", buffer: PNG_1X1 });
  await dialog.getByTestId("pod-submit").click();
  await expect(dialog.getByRole("alert")).toContainText("taking too long", { timeout: 12_000 });
  expect(held).toHaveLength(1);
  hold = false;
  const status_hole = blackhole(); // the retry's status call is parked, so the load is still at_delivery when the old insert lands
  onAction(page, status_hole.behaviour);
  await dialog.getByTestId("pod-retry").click();
  await expect.poll(async () => (await podRows(id)).length).toBe(1); // the retry's insert
  await held[0].continue(); // the abandoned insert finally arrives while the load is still open
  await page.waitForTimeout(1000);
  expect(await podRows(id)).toHaveLength(1); // the unique path index turned it away
  expect(await status(id)).toBe("at_delivery");
  modes.get(page)!.action = null;
  await status_hole.land();
  await expect.poll(() => status(id)).toBe("delivered");
  expect(await podRows(id)).toHaveLength(1);
  expect(await podFiles(id)).toHaveLength(1);
  await ctx.close();
});

test("offline: clear error, buttons recover when back online (status button)", async ({ browser }) => {
  const { id } = await seed({ po: uniq("OFFLINE"), status: "booked" });
  const { ctx, page } = await asNet(browser, "carrierA");
  await openFresh(page, `/my-loads/${id}`);
  await ctx.setOffline(true);
  await NEXT_STEP(page).click();
  await expect(alertOf(page)).toContainText("offline");
  await expect(NEXT_STEP(page)).toBeEnabled();
  await expect(NEXT_STEP(page)).toHaveText("Arrived at pickup");
  await ctx.setOffline(false);
  await NEXT_STEP(page).click();
  await expect(NEXT_STEP(page)).toHaveText("Start loading");
  expect(await status(id)).toBe("at_pickup");
  expect(await events(id)).toEqual([{ from_status: "booked", to_status: "at_pickup" }]);
  await ctx.close();
});

test("customer booking submit: dead network then offline never stick; one load once the network is back", async ({ browser }) => {
  const po = uniq("BOOKFAIL");
  const { ctx, page } = await asNet(browser, "maria");
  await bookingForm(page, po);
  const submit = page.getByRole("button", { name: /^(Request load|Saving\.\.\.)$/ });

  // Dead network
  const hole = blackhole();
  const restore = onAction(page, hole.behaviour);
  await submit.click();
  await expect(submit).toHaveText("Saving...");
  await expect(submit).toBeDisabled();
  await expect(page.getByText("taking too long")).toBeVisible({ timeout: 12_000 });
  await expect(submit).toBeEnabled();
  await expect(submit).toHaveText("Request load");
  await expect(page).toHaveURL(/\/book$/);
  expect(await loadsWithPo(po)).toEqual([]);
  await hole.release();
  await restore();

  // Offline
  await ctx.setOffline(true);
  await submit.click();
  await expect(page.getByText("You are offline")).toBeVisible();
  await expect(submit).toBeEnabled();
  expect(await loadsWithPo(po)).toEqual([]);

  // Back online: the same form submits, exactly one load.
  await ctx.setOffline(false);
  await submit.click();
  await page.waitForURL(/\/loads\/[0-9a-f-]{36}$/);
  expect(await loadsWithPo(po)).toHaveLength(1);
  await ctx.close();
});
