import { expect, test, type Locator, type Page } from "@playwright/test";
import { adminClient, as, easternLocal, gotoSteady, insertLoad, isoDate, loadRow, PNG_1X1, uniq, type SeedStatus } from "./support/helpers";

// R24 staff board (columns by status) and calendar (week and month by pickup date), R25 BOL pending
// badge and the status override with a required note. Authoritative state is read through the service role.

test.describe.configure({ mode: "serial", timeout: 120_000 });

// Loads that carry carrier A are parked (cancelled) afterwards so the carrier lists other specs compare stay small.
const parked: string[] = [];
async function seed(opts: Parameters<typeof insertLoad>[0]) {
  const r = await insertLoad(opts);
  parked.push(r.id);
  return r;
}
test.afterAll(async () => {
  if (parked.length === 0) return;
  await adminClient().from("loads").update({ status: "cancelled" })
    .in("id", parked).in("status", ["booked", "at_pickup", "loading", "enroute", "at_delivery"]);
});

// Board order is by pickup date ascending (capped), so these loads use a date older than anything else in the database.
const OLD = () => isoDate(-45);

const COLUMNS: { status: SeedStatus; label: string }[] = [
  { status: "requested", label: "Requested" }, { status: "booked", label: "Booked" },
  { status: "at_pickup", label: "At pickup" }, { status: "loading", label: "Loading" },
  { status: "enroute", label: "Enroute" }, { status: "at_delivery", label: "At delivery" },
  { status: "delivered", label: "Delivered" }, { status: "cancelled", label: "Cancelled" },
];

const cardIn = (page: Page, label: string, id: string) =>
  page.locator(`section[aria-label="${label}"]`).locator(`a[href="/admin/loads/${id}"]`);

test("the board puts each load in its status column and nowhere else", async ({ browser }) => {
  const made: { id: string; loadNumber: string; status: SeedStatus; label: string }[] = [];
  for (const c of COLUMNS) {
    const r = await seed({ po: uniq(`BRD-${c.status}`), status: c.status, pickupDate: OLD() });
    made.push({ ...r, status: c.status, label: c.label });
  }
  const { ctx, page } = await as(browser, "admin");
  await page.goto("/admin");
  for (const c of COLUMNS) await expect(page.locator(`section[aria-label="${c.label}"]`)).toHaveCount(1);

  for (const m of made) {
    // Authoritative status first, then the one column that holds the card.
    expect((await loadRow(m.id)).status).toBe(m.status);
    for (const c of COLUMNS) {
      await expect(cardIn(page, c.label, m.id), `${m.loadNumber} (${m.status}) in column ${c.label}`).toHaveCount(c.label === m.label ? 1 : 0);
    }
    await expect(cardIn(page, m.label, m.id)).toContainText(m.loadNumber);
  }
  // Column counts include the loads above.
  for (const c of COLUMNS) {
    const badge = page.locator(`section[aria-label="${c.label}"] h2 span`).nth(1);
    expect(Number(await badge.innerText())).toBeGreaterThanOrEqual(1);
  }
  await ctx.close();
});

test("BOL pending shows on a booked load without a BOL and goes away once a BOL is uploaded", async ({ browser }) => {
  const noBol = await seed({ po: uniq("BOL-NO"), status: "booked", pickupDate: OLD() });
  const pickup = await seed({ po: uniq("BOL-AP"), status: "at_pickup", pickupDate: OLD() });
  const requested = await seed({ po: uniq("BOL-REQ"), status: "requested", pickupDate: OLD() });
  const delivered = await seed({ po: uniq("BOL-DEL"), status: "delivered", pickupDate: OLD() });
  const { ctx, page } = await as(browser, "admin");

  await page.goto("/admin");
  await expect(cardIn(page, "Booked", noBol.id)).toContainText("BOL pending");
  await expect(cardIn(page, "At pickup", pickup.id)).toContainText("BOL pending");
  // Not expected before booking, nor after delivery.
  await expect(cardIn(page, "Requested", requested.id)).toHaveCount(1);
  await expect(cardIn(page, "Requested", requested.id)).not.toContainText("BOL pending");
  await expect(cardIn(page, "Delivered", delivered.id)).not.toContainText("BOL pending");

  await page.goto(`/admin/loads/${noBol.id}`);
  await expect(page.getByText("BOL pending", { exact: true })).toBeVisible();
  await page.getByTestId("upload-bol").getByTestId("dropzone-input").setInputFiles({ name: "bol.png", mimeType: "image/png", buffer: PNG_1X1 });
  await page.getByRole("button", { name: "Upload BOL" }).click();
  await expect(page.getByText("BOL uploaded.")).toBeVisible();
  const docs = await adminClient().from("load_documents").select("kind").eq("load_id", noBol.id);
  expect(docs.data).toEqual([{ kind: "bol" }]);
  await expect(page.getByText("BOL pending", { exact: true })).toHaveCount(0);

  await page.goto("/admin");
  await expect(cardIn(page, "Booked", noBol.id)).toHaveCount(1);
  await expect(cardIn(page, "Booked", noBol.id)).not.toContainText("BOL pending");
  // The other booked-stage load still has the badge, so the card text check above is not vacuous.
  await expect(cardIn(page, "At pickup", pickup.id)).toContainText("BOL pending");
  await ctx.close();
});

test("a status override needs a note: refused without one (database unchanged), accepted with one and recorded", async ({ browser }) => {
  const { id } = await seed({ po: uniq("OVR"), status: "booked", pickupDate: OLD() });
  const db = adminClient();
  const eventCount = async () => (await db.from("load_events").select("id").eq("load_id", id)).data?.length ?? 0;
  const events0 = await eventCount();

  const { ctx, page } = await as(browser, "admin");
  await page.goto(`/admin/loads/${id}`);
  const status = page.getByLabel("New status");
  const note = page.getByLabel("Note (required)");
  const go = page.getByRole("button", { name: "Override status" });

  await status.selectOption({ label: "At pickup" });
  // The browser itself blocks an empty note ...
  await go.click();
  expect(await note.evaluate((el) => (el as HTMLTextAreaElement).validity.valueMissing)).toBe(true);
  expect((await loadRow(id)).status).toBe("booked");
  // ... and the server refuses it when the browser check is bypassed, for empty and for blank notes.
  await note.evaluate((el) => el.removeAttribute("required"));
  for (const blank of ["", "   "]) {
    await note.fill(blank);
    await go.click();
    await expect(page.getByText("A note is required for a status override.")).toBeVisible();
    expect((await loadRow(id)).status).toBe("booked");
    expect(await eventCount()).toBe(events0);
    // The chosen status is still selected after a refusal (WebKit used to blank it, blocking the retry).
    await expect(status).toHaveValue("at_pickup");
  }

  const text = uniq("Driver called from the gate");
  await note.fill(text);
  await go.click();
  await expect(page.getByText("Status set to At pickup.")).toBeVisible();
  await expect.poll(async () => (await loadRow(id)).status).toBe("at_pickup");
  const ev = await db.from("load_events").select("from_status,to_status,note").eq("load_id", id).eq("to_status", "at_pickup");
  expect(ev.data).toEqual([{ from_status: "booked", to_status: "at_pickup", note: text }]);
  expect(await eventCount()).toBe(events0 + 1);
  // The timeline shows the entry with its note.
  await page.reload();
  await expect(page.locator("li").filter({ hasText: text })).toHaveCount(1);
  await expect(page.locator("li").filter({ hasText: text })).toContainText("Booked to At pickup");
  await ctx.close();
});

// ---- calendar ---------------------------------------------------------------------------------

const DAY = 86_400_000;
const utc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const weekStart = (d: string) => iso(utc(d) - new Date(utc(d)).getUTCDay() * DAY);
const monthTitle = (d: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(utc(d)));
const firstOfNextMonth = (d: string) => iso(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 1));
const firstOfPrevMonth = (d: string) => iso(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 2, 1));
// The month grid: whole weeks from the Sunday on or before the 1st to the Saturday on or after the last day.
function monthGrid(anyDay: string): [string, string] {
  const first = `${anyDay.slice(0, 7)}-01`;
  const last = iso(utc(firstOfNextMonth(anyDay)) - DAY);
  return [weekStart(first), iso(utc(last) + (6 - new Date(utc(last)).getUTCDay()) * DAY)];
}
const inGrid = (day: string, [a, b]: [string, string]) => day >= a && day <= b;

const todayET = () => easternLocal(new Date().toISOString()).slice(0, 10);

// Where a load sits on the calendar, whichever layout is showing (desktop grid or phone agenda).
async function dayOf(link: Locator): Promise<string> {
  return link.evaluate((a) => {
    const section = a.closest("section");
    if (section) return "agenda:" + (section.querySelector("h3")?.textContent ?? "").replace(/ \(today\)$/, "");
    const cell = a.closest("div.min-h-\\[110px\\]");
    return "grid:" + (cell?.querySelector("p")?.textContent ?? "");
  });
}
const agendaLabel = (d: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" }).format(new Date(utc(d)));
const expectDay = (got: string, d: string) =>
  expect(got === `grid:${Number(d.slice(8))}` || got === `agenda:${agendaLabel(d)}`, `placed on ${d}, got ${got}`).toBe(true);

const linkTo = (page: Page, loadNumber: string) => page.getByRole("link", { name: new RegExp(loadNumber) });

test("the calendar shows a load on its pickup date in week view, with Prev, Next and Today", async ({ browser }) => {
  const today = todayET();
  const day = iso(utc(weekStart(today)) + 17 * DAY); // the Wednesday two weeks after this week's Sunday
  const next = iso(utc(day) + DAY);
  const a = await insertLoad({ po: uniq("CAL-A"), status: "requested", pickupDate: day });
  const b = await insertLoad({ po: uniq("CAL-B"), status: "requested", pickupDate: next });

  const { ctx, page } = await as(browser, "admin");
  await page.goto("/admin/calendar");
  await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
  await expect(linkTo(page, a.loadNumber)).toHaveCount(0); // this week does not hold it
  await page.getByRole("link", { name: "Next" }).click();
  await expect(page).toHaveURL(new RegExp(`date=${iso(utc(today) + 7 * DAY)}`));
  await expect(linkTo(page, a.loadNumber)).toHaveCount(0);
  await page.getByRole("link", { name: "Next" }).click();
  await expect(linkTo(page, a.loadNumber)).toHaveCount(1);
  await expect(linkTo(page, b.loadNumber)).toHaveCount(1);
  const pa = await dayOf(linkTo(page, a.loadNumber));
  const pb = await dayOf(linkTo(page, b.loadNumber));
  expectDay(pa, day);
  expectDay(pb, next);
  expect(pa).not.toBe(pb);

  await page.getByRole("link", { name: "Previous" }).click();
  await expect(linkTo(page, a.loadNumber)).toHaveCount(0);
  await page.getByRole("link", { name: "Next" }).click();
  await expect(linkTo(page, a.loadNumber)).toHaveCount(1);
  await page.getByRole("link", { name: "Today" }).click();
  await expect(page).toHaveURL(new RegExp(`date=${today}`));
  await expect(linkTo(page, a.loadNumber)).toHaveCount(0);

  // Live: a load added while the week is open appears without a reload (Realtime, or the 15 s poll).
  await page.goto(`/admin/calendar?view=week&date=${day}`);
  await expect(linkTo(page, a.loadNumber)).toHaveCount(1);
  const live = await insertLoad({ po: uniq("CAL-LIVE"), status: "requested", pickupDate: day });
  await expect(linkTo(page, live.loadNumber)).toHaveCount(1, { timeout: 30_000 });
  await ctx.close();
});

test("the calendar shows a load on its pickup date in month view, with Prev, Next and Today", async ({ browser }) => {
  const today = todayET();
  const day = iso(utc(weekStart(today)) + 17 * DAY);
  const a = await insertLoad({ po: uniq("CALM-A"), status: "requested", pickupDate: day });

  const { ctx, page } = await as(browser, "admin");
  await page.goto(`/admin/calendar?view=month&date=${day}`);
  await expect(page.getByRole("heading", { name: monthTitle(day) })).toBeVisible();
  await expect(linkTo(page, a.loadNumber)).toHaveCount(1);
  expectDay(await dayOf(linkTo(page, a.loadNumber)), day);

  // Next month: the title moves; the load is shown only if its day falls inside that month's grid.
  const nextFirst = firstOfNextMonth(day);
  await page.getByRole("link", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: monthTitle(nextFirst) })).toBeVisible();
  await expect(linkTo(page, a.loadNumber)).toHaveCount(inGrid(day, monthGrid(nextFirst)) ? 1 : 0);
  // Previous month from there is back at the original month.
  await page.getByRole("link", { name: "Previous" }).click();
  await expect(page.getByRole("heading", { name: monthTitle(day) })).toBeVisible();
  await expect(linkTo(page, a.loadNumber)).toHaveCount(1);
  // Two months back never holds it.
  await gotoSteady(page, `/admin/calendar?view=month&date=${firstOfPrevMonth(firstOfPrevMonth(day))}`);
  await expect(linkTo(page, a.loadNumber)).toHaveCount(0);

  await page.getByRole("link", { name: "Today" }).click();
  await expect(page.getByRole("heading", { name: monthTitle(today) })).toBeVisible();
  await expect(linkTo(page, a.loadNumber)).toHaveCount(inGrid(day, monthGrid(today)) ? 1 : 0);
  // The Week toggle keeps the anchor date and switches layout.
  await page.getByRole("link", { name: "Week", exact: true }).click();
  await expect(page).toHaveURL(/view=week/);
  await ctx.close();
});
