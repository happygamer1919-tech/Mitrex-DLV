import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { adminClient, anon, as, insertLoad, isoDate, parseCsv, readDownload, staffBook, uniq, uniqIts } from "./support/helpers";
import { fillBooking, makeLocation, retireLocations, type TestLocation } from "./support/book";
import { BASE_URL, DB_URL, localEnv } from "./support/env";
import { assertLocalUrl } from "./support/guard";
import { loginViaUi } from "./support/login";
import { sentEmails, type SentEmail } from "./support/mail-mock";
import { CARRIER_A } from "./support/users";

// R39 lane references (DLV-028): for each repeat lane, which old ITS load staff copy. STAFF ONLY: shown on the staff
// load card, the staff board and the staff request email, never to Maria or a carrier. Real names from the owner's
// table (supabase/seed.sql applies it through migration 0016). Tests that edit or delete rows use their own test
// locations, so the 25 seeded lanes are never changed; the one seeded scenario added here (Mitrex to 125G at 53)
// is removed again in afterAll.

test.describe.configure({ mode: "serial", timeout: 180_000 });

const db = () => adminClient();

// The owner's table, written out independently of the migration: shipper, receiver, size, ITS load, Moffett (Y or N).
const OWNER: [string, string, number, string, boolean][] = [
  ["D Express Transport", "481 University Ave", 53, "653", false],
  ["Mitrex", "481 University Ave", 26, "1269", false],
  ["Mitrex", "481 University Ave", 53, "1264", false],
  ["481 University Ave", "QuickScrap Metal", 26, "1275", false],
  ["481 University Ave", "QuickScrap Metal", 53, "1265", false],
  ["481 University Ave", "Mitrex", 53, "829", false],
  ["481 University Ave", "Mitrex", 26, "752", false],
  ["Mitrex", "125G", 26, "1488", false],
  ["Mitrex", "QuickScrap Metal", 26, "1278", false],
  ["Valley Metal Finishing Ltd", "Mitrex", 26, "1292", false],
  ["Mitrex", "Spadina", 26, "810", false],
  ["Mitrex", "Sherbourne", 26, "1484", false],
  ["Howden", "Sherbourne", 26, "1475", false],
  ["Sherbourne", "Howden", 26, "1486", false],
  ["Sherbourne", "QuickScrap Metal", 26, "1439", false],
  ["Mitrex", "1HAM", 26, "158", true],
  ["Mitrex", "152 Sh", 26, "292", true],
  ["Mitrex", "831 Queen", 26, "1468", true],
  ["Mitrex", "SAMIH", 26, "1469", true],
  ["SAMIH", "Mitrex", 26, "1241", true],
  ["SAMIH", "QuickScrap Metal", 26, "1471", true],
  ["Mitrex", "Glengarry", 26, "1470", true],
  ["Mitrex", "Kitney site", 26, "1084", true],
  ["Mitrex", "Military Trailsite", 26, "776", true],
  ["Mitrex", "PrimeFab", 26, "1293", true],
];

const ids = new Map<string, string>();
const lanesToDelete: string[] = [];
const parkedLoads: string[] = [];
const testLocations: string[] = [];
const createdUsers: string[] = [];
let csrEmail = "";
let csrId = "";

async function loc(prefix: string): Promise<TestLocation> {
  const l = await makeLocation({ prefix });
  testLocations.push(l.id);
  return l;
}

async function addLaneRow(p: string, d: string, size: number, number: string, note: string | null = null): Promise<string> {
  const { data, error } = await db().from("lane_references")
    .insert({ pickup_location_id: p, delivery_location_id: d, equipment_size: size, its_reference_load: number, note }).select("id").single();
  if (error) throw error;
  lanesToDelete.push(data.id as string);
  return data.id as string;
}

async function laneRows(p: string, d: string, size?: number) {
  let q = db().from("lane_references").select("id,its_reference_load,note,updated_by").eq("pickup_location_id", p).eq("delivery_location_id", d);
  if (size !== undefined) q = q.eq("equipment_size", size);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

async function removeScenario(p: string, d: string, size: number) {
  await db().from("lane_references").delete().eq("pickup_location_id", p).eq("delivery_location_id", d).eq("equipment_size", size);
}

const unique = () => String(Date.now()).slice(-9) + String(process.pid % 100).padStart(2, "0");

test.beforeAll(async () => {
  const { data, error } = await db().from("locations").select("id,name").in("name", ["Mitrex", "481 University Ave", "125G", "1HAM", "Howden"]);
  if (error) throw error;
  for (const r of data ?? []) ids.set(r.name as string, r.id as string);
  expect(ids.size).toBe(5);
  await removeScenario(ids.get("Mitrex")!, ids.get("125G")!, 53); // a leftover of an aborted run
  csrEmail = `lane-csr-${Date.now().toString(36)}-${process.pid}@e2e.test`;
  const made = await db().auth.admin.createUser({ email: csrEmail, email_confirm: true });
  if (made.error || !made.data.user) throw made.error ?? new Error("createUser failed");
  csrId = made.data.user.id;
  createdUsers.push(csrId);
  const p = await db().from("profiles").insert({ id: csrId, email: csrEmail, full_name: "Lane CSR", role: "staff_csr", is_active: true });
  if (p.error) throw p.error;
});

test.afterAll(async () => {
  const d = db();
  await removeScenario(ids.get("Mitrex")!, ids.get("125G")!, 53);
  if (lanesToDelete.length) await d.from("lane_references").delete().in("id", lanesToDelete);
  if (testLocations.length) {
    await d.from("lane_references").delete().in("pickup_location_id", testLocations);
    await d.from("lane_references").delete().in("delivery_location_id", testLocations);
  }
  if (parkedLoads.length) {
    await d.from("loads").update({ status: "cancelled" }).in("id", parkedLoads).in("status", ["requested", "booked", "at_pickup", "loading", "enroute", "at_delivery"]);
  }
  for (const id of createdUsers) await d.auth.admin.deleteUser(id).catch(() => {});
  await retireLocations(testLocations);
});

async function admin(browser: Browser, path: string, viewport?: { width: number; height: number }) {
  const s = await as(browser, "admin", viewport);
  await s.page.goto(path);
  return s;
}

async function requested(p: string, d: string, size: 26 | 36 | 53, status: "requested" | "booked" = "requested") {
  const l = await insertLoad({ po: uniq("LANE"), status, pickupLocationId: p, deliveryLocationId: d, size, pickupDate: isoDate(0) });
  parkedLoads.push(l.id);
  return l;
}

const laneRow = (page: Page, p: string, d: string, size: number) =>
  page.locator(`[data-testid="lane-row"][data-lane="${p} > ${d} > ${size}"]`);

// ---- the seed -------------------------------------------------------------------------------------------------

test("the 25 owner rows are in the database with the exact numbers, and the derived Moffett equals the owner's Y or N for all 25", async () => {
  const { data, error } = await db().from("lane_references")
    .select("equipment_size,its_reference_load,pickup:locations!pickup_location_id(name,requires_moffett),delivery:locations!delivery_location_id(name,requires_moffett)")
    .limit(1000);
  expect(error).toBeNull();
  const rows = (data ?? []) as unknown as { equipment_size: number; its_reference_load: string; pickup: { name: string; requires_moffett: boolean }; delivery: { name: string; requires_moffett: boolean } }[];
  const key = (p: string, d: string, s: number) => `${p}|${d}|${s}`;
  const have = new Map(rows.map((r) => [key(r.pickup.name, r.delivery.name, r.equipment_size), r]));
  expect(OWNER).toHaveLength(25);
  let moffettY = 0;
  for (const [p, d, s, n, y] of OWNER) {
    const r = have.get(key(p, d, s));
    expect(r, `${p} to ${d} at ${s}`).toBeTruthy();
    expect(r!.its_reference_load, `${p} to ${d} at ${s}`).toBe(n);
    // The Moffett column is derived from the two locations, never stored on the lane.
    expect(r!.pickup.requires_moffett || r!.delivery.requires_moffett, `Moffett of ${p} to ${d}`).toBe(y);
    if (y) moffettY += 1;
  }
  expect(moffettY).toBe(10);
  const cols = await db().from("lane_references").select("*").limit(1);
  expect(Object.keys(cols.data![0]).some((c) => /moffett/i.test(c))).toBe(false);
});

// ---- the staff load card and the board --------------------------------------------------------------------------

test("staff sees the seeded number on a Requested load: Mitrex to 481 University Ave gives 1269 at 26 and 1264 at 53", async ({ browser }) => {
  const mitrex = ids.get("Mitrex")!, u481 = ids.get("481 University Ave")!;
  const l26 = await requested(mitrex, u481, 26);
  const l53 = await requested(mitrex, u481, 53);
  const s = await admin(browser, `/admin/loads/${l26.id}`);
  const page = s.page;
  await expect(page.getByTestId("its-copy-card")).toBeVisible();
  await expect(page.getByTestId("its-copy-card").getByRole("heading", { name: "ITS load to copy" })).toBeVisible();
  await expect(page.getByTestId("its-copy-number")).toHaveText("1269");
  await expect(page.getByTestId("its-copy-scenario")).toHaveText("Mitrex to 481 University Ave, 26 ft");
  // ABOVE the booking card
  const cardY = (await page.getByTestId("its-copy-card").boundingBox())!.y;
  const bookY = (await page.getByRole("heading", { name: "Carrier and booking" }).boundingBox())!.y;
  expect(cardY).toBeLessThan(bookY);
  await page.goto(`/admin/loads/${l53.id}`);
  await expect(page.getByTestId("its-copy-number")).toHaveText("1264");
  await expect(page.getByTestId("its-copy-scenario")).toHaveText("Mitrex to 481 University Ave, 53 ft");
  await s.ctx.close();
});

test("a size with no row (Mitrex to 481 University Ave at 36) shows the no reference message, never another size's number", async ({ browser }) => {
  const l = await requested(ids.get("Mitrex")!, ids.get("481 University Ave")!, 36);
  const s = await admin(browser, `/admin/loads/${l.id}`);
  await expect(s.page.getByTestId("its-copy-none")).toHaveText("No ITS reference for this lane and size");
  await expect(s.page.getByTestId("its-copy-scenario")).toHaveText("Mitrex to 481 University Ave, 36 ft");
  await expect(s.page.getByTestId("its-copy-number")).toHaveCount(0);
  await s.ctx.close();
});

test("the board shows a small Copy ITS line for Requested loads only (a booked load of the same lane shows none)", async ({ browser }) => {
  const mitrex = ids.get("Mitrex")!, u481 = ids.get("481 University Ave")!;
  const r = await requested(mitrex, u481, 26);
  const n = await requested(mitrex, u481, 36);
  const b = await requested(mitrex, u481, 26, "booked");
  const s = await admin(browser, "/admin");
  const page = s.page;
  const card = (id: string) => page.locator(`a[href="/admin/loads/${id}"]`);
  await expect(card(r.id)).toBeVisible();
  await expect(card(r.id).getByTestId("board-copy-its")).toHaveText("Copy ITS 1269");
  await expect(card(n.id).getByTestId("board-copy-its")).toHaveText("No ITS reference");
  await expect(card(b.id)).toBeVisible();
  await expect(card(b.id).getByTestId("board-copy-its")).toHaveCount(0);
  await s.ctx.close();
  // the booked load still has the card on its own page
  const s2 = await admin(browser, `/admin/loads/${b.id}`);
  await expect(s2.page.getByTestId("its-copy-number")).toHaveText("1269");
  await s2.ctx.close();
});

test("no row (Mitrex to 125G at 53): the message and a prefilled Add it link, and adding through it makes the card show the number", async ({ browser }) => {
  const mitrex = ids.get("Mitrex")!, g125 = ids.get("125G")!;
  expect(await laneRows(mitrex, g125, 53)).toHaveLength(0);
  const l = await requested(mitrex, g125, 53);
  const s = await admin(browser, `/admin/loads/${l.id}`);
  const page = s.page;
  try {
    await expect(page.getByTestId("its-copy-none")).toHaveText("No ITS reference for this lane and size");
    await expect(page.getByTestId("its-copy-scenario")).toHaveText("Mitrex to 125G, 53 ft");
    const add = page.getByRole("link", { name: "Add it" });
    await expect(add).toHaveAttribute("href", `/admin/lanes?pickup=${mitrex}&delivery=${g125}&size=53`);
    await add.click();
    await expect(page).toHaveURL(/\/admin\/lanes\?/);
    await expect(page.getByRole("heading", { name: "Lanes" })).toBeVisible();
    await expect(page.getByLabel("Pickup location")).toHaveValue(mitrex);
    await expect(page.getByLabel("Delivery location")).toHaveValue(g125);
    await expect(page.locator('select[name="size"]')).toHaveValue("53");
    const number = unique();
    await page.getByLabel("ITS load to copy").fill(number);
    await page.getByRole("button", { name: "Add lane", exact: true }).click();
    await expect(page.getByText("Lane added.")).toBeVisible();
    const rows = await laneRows(mitrex, g125, 53);
    expect(rows).toHaveLength(1);
    expect(rows[0].its_reference_load).toBe(number);
    await expect(laneRow(page, "Mitrex", "125G", 53).getByTestId("lane-number")).toHaveText(number);
    await page.goto(`/admin/loads/${l.id}`);
    await expect(page.getByTestId("its-copy-number")).toHaveText(number);
    await expect(page.getByTestId("its-copy-none")).toHaveCount(0);
  } finally {
    await removeScenario(mitrex, g125, 53);
    await s.ctx.close();
  }
});

test("the scenario is evaluated live: editing or deleting the lane, or changing the load's size, changes what an existing load shows", async ({ browser }) => {
  const a = await loc("E2E-LIVEA"), b = await loc("E2E-LIVEB");
  const lane = await addLaneRow(a.id, b.id, 26, "7771");
  const l = await requested(a.id, b.id, 26);
  const s = await admin(browser, `/admin/loads/${l.id}`);
  const page = s.page;
  await expect(page.getByTestId("its-copy-number")).toHaveText("7771");
  await db().from("lane_references").update({ its_reference_load: "7772" }).eq("id", lane);
  await page.reload();
  await expect(page.getByTestId("its-copy-number")).toHaveText("7772");
  expect((await db().from("loads").select("*").eq("id", l.id).single()).data).not.toHaveProperty("its_reference_load"); // nothing is copied onto the load
  await db().from("loads").update({ equipment_size: 36 }).eq("id", l.id);
  await page.reload();
  await expect(page.getByTestId("its-copy-none")).toBeVisible();
  await db().from("loads").update({ equipment_size: 26 }).eq("id", l.id);
  await db().from("lane_references").delete().eq("id", lane);
  await page.reload();
  await expect(page.getByTestId("its-copy-none")).toBeVisible();
  await s.ctx.close();
});

test("the Copy button copies the number and announces it, and without the clipboard API the fallback still copies", async ({ browser }, info) => {
  const l = await requested(ids.get("Mitrex")!, ids.get("481 University Ave")!, 26);
  const chromium = info.project.name === "chromium";
  const s = await as(browser, "admin", undefined, chromium ? { permissions: ["clipboard-read", "clipboard-write"] } : undefined);
  const page = s.page;
  await page.goto(`/admin/loads/${l.id}`);
  const status = page.getByTestId("its-copy-status");
  await expect(status).toHaveText("");
  await page.getByRole("button", { name: "Copy" }).click();
  await expect(status).toHaveText("Copied 1269");
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toHaveAttribute("aria-live", "polite");
  if (chromium) expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("1269");
  // clipboard API refused: the textarea fallback runs
  await page.reload();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("blocked")) }, configurable: true });
    (window as unknown as { __copied: string }).__copied = "";
    document.execCommand = ((cmd: string) => {
      if (cmd === "copy") (window as unknown as { __copied: string }).__copied = (document.activeElement as HTMLTextAreaElement | null)?.value ?? "";
      return true;
    }) as typeof document.execCommand;
  });
  await page.getByRole("button", { name: "Copy" }).click();
  await expect(page.getByTestId("its-copy-status")).toHaveText("Copied 1269");
  expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toBe("1269");
  await s.ctx.close();
});

// ---- the lanes page ------------------------------------------------------------------------------------------------

test("/admin/lanes lists the lanes grouped by pickup with the derived Moffett flag, and filters by search, pickup, delivery and size", async ({ browser }) => {
  const s = await admin(browser, "/admin/lanes");
  const page = s.page;
  await expect(page.getByRole("heading", { name: "Lanes", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Lanes" }).first()).toBeVisible();
  const mitrexGroup = page.getByRole("region", { name: "Pickup Mitrex" });
  await expect(mitrexGroup).toBeVisible();
  expect(await mitrexGroup.getByTestId("lane-row").count()).toBeGreaterThanOrEqual(13);
  await expect(laneRow(page, "Mitrex", "481 University Ave", 26).getByTestId("lane-number")).toHaveText("1269");
  await expect(laneRow(page, "Mitrex", "481 University Ave", 26).getByTestId("lane-moffett")).toHaveText("No Moffett");
  await expect(laneRow(page, "Mitrex", "1HAM", 26).getByTestId("lane-moffett")).toHaveText("Moffett");
  await expect(laneRow(page, "SAMIH", "Mitrex", 26).getByTestId("lane-moffett")).toHaveText("Moffett");
  await expect(laneRow(page, "Mitrex", "1HAM", 26)).toContainText("Last updated by");

  const numbers = async () => (await page.getByTestId("lane-number").allTextContents()).sort();
  await page.getByLabel("Size filter").selectOption("53");
  expect(await numbers()).toEqual(["1264", "1265", "653", "829"]);
  await page.getByLabel("Size filter").selectOption("all");
  await page.getByLabel("Pickup filter").selectOption("SAMIH");
  expect(await numbers()).toEqual(["1241", "1471"]);
  await page.getByLabel("Pickup filter").selectOption("all");
  await page.getByLabel("Delivery filter").selectOption("Sherbourne");
  expect(await numbers()).toEqual(["1475", "1484"]);
  await page.getByLabel("Delivery filter").selectOption("all");
  await page.getByLabel("Search").fill("1269");
  expect(await numbers()).toEqual(["1269"]);
  await page.getByLabel("Search").fill("zzz no such lane");
  await expect(page.getByText("No lanes match this filter.")).toBeVisible();
  await s.ctx.close();
});

test("Add lane: a duplicate is refused with a clear message, and so are bad numbers and the same location twice", async ({ browser }) => {
  const mitrex = ids.get("Mitrex")!;
  const s = await admin(browser, "/admin/lanes");
  const page = s.page;
  await page.getByRole("button", { name: "Add lane", exact: true }).click();
  const submit = page.getByRole("button", { name: "Add lane", exact: true });
  await page.getByLabel("Pickup location").selectOption({ label: "Mitrex" });
  await page.getByLabel("Delivery location").selectOption({ label: "481 University Ave" });
  await page.locator('select[name="size"]').selectOption("26");
  await page.getByLabel("ITS load to copy").fill("5555");
  await submit.click();
  await expect(page.getByText("A lane reference for this pickup, delivery and truck size already exists. Edit that row instead.")).toBeVisible();
  expect((await laneRows(mitrex, ids.get("481 University Ave")!, 26))[0].its_reference_load).toBe("1269");
  await page.locator('select[name="size"]').selectOption("36");
  await page.getByLabel("ITS load to copy").fill("12x");
  await submit.click();
  await expect(page.getByText(/must be digits/)).toBeVisible();
  await page.getByLabel("ITS load to copy").fill("5555");
  await page.getByLabel("Delivery location").selectOption({ label: "Mitrex" });
  await submit.click();
  await expect(page.getByText("Pickup and delivery must be different locations.")).toBeVisible();
  expect(await laneRows(mitrex, ids.get("481 University Ave")!, 36)).toHaveLength(0);
  await s.ctx.close();
});

test("inline edit changes the number and note, delete asks first and removes the row", async ({ browser }) => {
  const a = await loc("E2E-EDA"), b = await loc("E2E-EDB");
  const id = await addLaneRow(a.id, b.id, 36, "8101", "first note");
  const s = await admin(browser, "/admin/lanes");
  const page = s.page;
  await page.getByLabel("Search").fill(a.name);
  const row = laneRow(page, a.name, b.name, 36);
  await expect(row.getByTestId("lane-number")).toHaveText("8101");
  await expect(row.getByTestId("lane-note")).toHaveText("first note");
  await row.getByRole("button", { name: "Edit" }).click();
  await row.getByLabel("ITS load to copy").fill("8102-2");
  await row.getByLabel("Note").fill("second note");
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row.getByTestId("lane-number")).toHaveText("8102-2");
  await expect(row.getByTestId("lane-note")).toHaveText("second note");
  const after = await laneRows(a.id, b.id, 36);
  expect(after[0].its_reference_load).toBe("8102-2");
  expect(after[0].note).toBe("second note");
  // a bad number is refused in the row, the database keeps the old one
  await row.getByRole("button", { name: "Edit" }).click();
  await row.getByLabel("ITS load to copy").fill("abc");
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row.getByText(/must be digits/)).toBeVisible();
  expect((await laneRows(a.id, b.id, 36))[0].its_reference_load).toBe("8102-2");
  await row.getByRole("button", { name: "Cancel" }).click();
  // delete: the first click only asks
  await row.getByRole("button", { name: "Delete" }).click();
  await expect(row.getByText(/This cannot be undone/)).toBeVisible();
  await row.getByRole("button", { name: "Keep" }).click();
  expect(await laneRows(a.id, b.id, 36)).toHaveLength(1);
  await row.getByRole("button", { name: "Delete" }).click();
  await row.getByRole("button", { name: "Yes, delete" }).click();
  await expect(row).toHaveCount(0);
  expect(await laneRows(a.id, b.id, 36)).toHaveLength(0);
  void id;
  await s.ctx.close();
});

// ---- CSV ----------------------------------------------------------------------------------------------------------

test("CSV export: the five columns, all 25 owner rows with their numbers, and a note that starts with = + - @ is protected", async ({ browser }) => {
  const a = await loc("E2E-CSVA"), b = await loc("E2E-CSVB");
  const notes = ["=HYPERLINK(\"x\")", "+1 call", "-2 call", "@home", "plain, with comma"];
  const sizes = [26, 36, 53];
  for (let i = 0; i < notes.length; i++) {
    const [p, d] = i % 2 === 0 ? [a.id, b.id] : [b.id, a.id];
    await addLaneRow(p, d, sizes[Math.floor(i / 2)], `88${i}`, notes[i]);
  }
  const s = await admin(browser, "/admin/lanes");
  const [download] = await Promise.all([s.page.waitForEvent("download"), s.page.getByRole("link", { name: "Export CSV" }).click()]);
  expect(download.suggestedFilename()).toBe("dlv-lane-references.csv");
  const rows = parseCsv((await readDownload(download)).toString("utf8"));
  expect(rows[0]).toEqual(["shipper", "receiver", "truck_size", "load_to_copy", "note"]);
  for (const [p, d, size, n] of OWNER) {
    expect(rows.some((r) => r[0] === p && r[1] === d && r[2] === String(size) && r[3] === n), `${p} to ${d} ${size}`).toBe(true);
  }
  const mine = rows.filter((r) => r[0] === a.name || r[0] === b.name);
  expect(mine).toHaveLength(notes.length);
  const noteOf = (n: string) => mine.find((r) => r[3] === n)![4];
  expect(noteOf("880")).toBe("'=HYPERLINK(\"x\")");
  expect(noteOf("881")).toBe("'+1 call");
  expect(noteOf("882")).toBe("'-2 call");
  expect(noteOf("883")).toBe("'@home");
  expect(noteOf("884")).toBe("plain, with comma");
  for (const r of rows.slice(1)) for (const c of r) expect(/^[=+\-@]/.test(c), `cell ${c}`).toBe(false);
  await s.ctx.close();
});

test("CSV import preview rejects each bad row type with a per row message and Apply stays disabled, nothing is written", async ({ browser }) => {
  const a = await loc("E2E-IMA"), b = await loc("E2E-IMB");
  const csv = [
    "shipper,receiver,truck_size,load_to_copy,note",
    `Nowhere Inc,${b.name},26,1001,`,
    `${a.name},Nowhere Inc,26,1002,`,
    `${a.name},${b.name},48,1003,`,
    `${a.name},${b.name},26,abc,`,
    `${a.name},${a.name},26,1005,`,
    `${a.name},${b.name},36,1006,good row`,
    `${a.name},${b.name},36,1007,duplicate of the row above`,
  ].join("\n");
  const s = await admin(browser, "/admin/lanes");
  const page = s.page;
  await page.getByRole("button", { name: "Import CSV" }).click();
  await page.getByLabel("Or paste the CSV here").fill(csv);
  const result = (n: number) => page.getByTestId("preview-row").nth(n).getByTestId("preview-result");
  await expect(page.getByTestId("preview-row")).toHaveCount(7);
  await expect(result(0)).toContainText('Shipper is not a known location ("Nowhere Inc")');
  await expect(result(1)).toContainText('Receiver is not a known location ("Nowhere Inc")');
  await expect(result(2)).toContainText("Truck size must be 26, 36 or 53.");
  await expect(result(3)).toContainText("Load to copy must be digits");
  await expect(result(4)).toContainText("Shipper and receiver must be different locations.");
  await expect(result(5)).toHaveText("OK");
  await expect(result(6)).toContainText("Duplicate of line 7");
  await expect(page.getByTestId("import-summary")).toHaveText("6 of 7 rows have errors. Fix them to import.");
  await expect(page.getByRole("button", { name: "Apply import" })).toBeDisabled();
  expect(await laneRows(a.id, b.id)).toHaveLength(0);

  // a header with a missing column, and more than 500 rows
  await page.getByLabel("Or paste the CSV here").fill("shipper,receiver,truck_size\nMitrex,Howden,26");
  await expect(page.getByText("The header is missing the column(s): load_to_copy.")).toBeVisible();
  const many = ["shipper,receiver,truck_size,load_to_copy,note", ...Array.from({ length: 501 }, (_, i) => `${a.name},${b.name},26,${i + 1},`)].join("\n");
  await page.getByLabel("Or paste the CSV here").fill(many);
  await expect(page.getByText("The file has 501 rows. At most 500 rows can be imported at once.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply import" })).toBeDisabled();
  expect(await laneRows(a.id, b.id)).toHaveLength(0);
  await s.ctx.close();
});

test("CSV import applies a good uploaded file as an upsert on the scenario key (new rows added, an existing one updated)", async ({ browser }) => {
  const a = await loc("E2E-UPA"), b = await loc("E2E-UPB");
  await addLaneRow(a.id, b.id, 53, "9001", "old note");
  const csv = [
    "shipper,receiver,truck_size,load_to_copy,note",
    `${a.name},${b.name},26,9002,new one`,
    `${b.name},${a.name},36,9003-1,`,
    `${a.name},${b.name},53,9004,updated`,
  ].join("\r\n") + "\r\n";
  const s = await admin(browser, "/admin/lanes");
  const page = s.page;
  await page.getByRole("button", { name: "Import CSV" }).click();
  await page.getByTestId("dropzone-input").setInputFiles({ name: "lanes.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByTestId("preview-row")).toHaveCount(3);
  await expect(page.getByTestId("import-summary")).toHaveText("3 rows, all valid.");
  await page.getByRole("button", { name: "Apply import" }).click();
  await expect(page.getByText("Imported 3 lanes (2 new, 1 updated).")).toBeVisible();
  const ab = await laneRows(a.id, b.id);
  expect(ab.map((r) => r.its_reference_load).sort()).toEqual(["9002", "9004"]);
  expect(ab.find((r) => r.its_reference_load === "9004")!.note).toBe("updated");
  const ba = await laneRows(b.id, a.id, 36);
  expect(ba.map((r) => r.its_reference_load)).toEqual(["9003-1"]);
  for (const r of [...ab, ...ba]) lanesToDelete.push(r.id as string);
  await expect(laneRow(page, a.name, b.name, 26).getByTestId("lane-number")).toHaveText("9002");
  await s.ctx.close();
});

test("CSV import is all or nothing on the server too: a file that was valid in the preview but is not any more writes no row", async ({ browser }) => {
  const a = await loc("E2E-AONA"), b = await loc("E2E-AONB"), gone = await loc("E2E-AONGONE");
  const s = await admin(browser, "/admin/lanes");
  const page = s.page;
  await page.getByRole("button", { name: "Import CSV" }).click();
  await page.getByLabel("Or paste the CSV here").fill([
    "shipper,receiver,truck_size,load_to_copy,note",
    `${a.name},${b.name},26,9101,`,
    `${a.name},${gone.name},26,9102,`,
  ].join("\n"));
  await expect(page.getByTestId("import-summary")).toHaveText("2 rows, all valid.");
  // the location disappears after the page was loaded (so the preview still says valid)
  const del = await db().from("locations").delete().eq("id", gone.id);
  expect(del.error).toBeNull();
  testLocations.splice(testLocations.indexOf(gone.id), 1);
  await page.getByRole("button", { name: "Apply import" }).click();
  await expect(page.getByText(/^Nothing was imported\./)).toBeVisible();
  expect(await laneRows(a.id, b.id)).toHaveLength(0);
  expect(await laneRows(a.id, gone.id)).toHaveLength(0);
  await s.ctx.close();
});

// ---- who can do what -------------------------------------------------------------------------------------------------

test("staff_csr can do everything admin can on lanes: open, add, edit, delete, import, export", async ({ browser }) => {
  const a = await loc("E2E-CSRA"), b = await loc("E2E-CSRB");
  const { ctx, page } = await anon(browser);
  await loginViaUi(page, csrEmail);
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.locator("header nav").getByRole("link", { name: "Lanes" })).toBeVisible();
  await page.locator("header nav").getByRole("link", { name: "Lanes" }).click();
  await expect(page).toHaveURL(/\/admin\/lanes$/);
  await expect(page.getByRole("heading", { name: "Lanes", exact: true })).toBeVisible();
  // add
  await page.getByRole("button", { name: "Add lane", exact: true }).click();
  await page.getByLabel("Pickup location").selectOption({ label: a.name });
  await page.getByLabel("Delivery location").selectOption({ label: b.name });
  await page.locator('select[name="size"]').selectOption("36");
  await page.getByLabel("ITS load to copy").fill("7100");
  await page.getByRole("button", { name: "Add lane", exact: true }).click();
  await expect(page.getByText("Lane added.")).toBeVisible();
  const made = await laneRows(a.id, b.id, 36);
  expect(made).toHaveLength(1);
  expect(made[0].updated_by).toBe(csrId);
  lanesToDelete.push(made[0].id as string);
  // edit
  await page.getByLabel("Search").fill(a.name);
  const row = laneRow(page, a.name, b.name, 36);
  await row.getByRole("button", { name: "Edit" }).click();
  await row.getByLabel("ITS load to copy").fill("7101");
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row.getByTestId("lane-number")).toHaveText("7101");
  expect((await laneRows(a.id, b.id, 36))[0].its_reference_load).toBe("7101");
  // import
  await page.getByRole("button", { name: "Import CSV" }).click();
  await page.getByLabel("Or paste the CSV here").fill(`shipper,receiver,truck_size,load_to_copy,note\n${b.name},${a.name},26,7102,`);
  await page.getByRole("button", { name: "Apply import" }).click();
  await expect(page.getByText("Imported 1 lane (1 new, 0 updated).")).toBeVisible();
  const imp = await laneRows(b.id, a.id, 26);
  expect(imp).toHaveLength(1);
  lanesToDelete.push(imp[0].id as string);
  // export
  const res = await ctx.request.get("/admin/lanes/csv");
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain("1269");
  // delete
  await row.getByRole("button", { name: "Delete" }).click();
  await row.getByRole("button", { name: "Yes, delete" }).click();
  await expect(row).toHaveCount(0);
  expect(await laneRows(a.id, b.id, 36)).toHaveLength(0);
  // the load card works for csr too
  const l = await requested(ids.get("Mitrex")!, ids.get("481 University Ave")!, 26);
  await page.goto(`/admin/loads/${l.id}`);
  await expect(page.getByTestId("its-copy-number")).toHaveText("1269");
  await ctx.close();
});

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

test("a customer and a carrier cannot open /admin/lanes or its CSV, and PostgREST reads, writes and deletes return nothing", async ({ browser }) => {
  const total = await db().from("lane_references").select("id", { count: "exact", head: true });
  expect(total.count ?? 0).toBeGreaterThanOrEqual(25); // guard: rows exist
  const u481 = ids.get("481 University Ave")!, mitrex = ids.get("Mitrex")!;
  for (const [who, home, email] of [["maria", /\/loads$/, "maria@e2e.test"], ["carrierA", /\/my-loads$/, "owner-a@e2e.test"]] as const) {
    const s = await as(browser, who);
    await s.page.goto("/admin/lanes");
    await expect(s.page).toHaveURL(home);
    const html = await s.page.content();
    expect(html.includes("lane-row") || html.includes("ITS load to copy")).toBe(false);
    const csv = await s.ctx.request.get("/admin/lanes/csv");
    expect(csv.status()).toBe(403);
    expect(await csv.text()).not.toContain("load_to_copy");
    await s.ctx.close();

    const sb = await signedIn(email);
    const read = await sb.from("lane_references").select("*");
    expect(read.error).toBeNull();
    expect(read.data).toEqual([]);
    const ins = await sb.from("lane_references").insert({ pickup_location_id: u481, delivery_location_id: mitrex, equipment_size: 36, its_reference_load: "1" });
    expect(ins.error?.message).toMatch(/row-level security/);
    const upd = await sb.from("lane_references").update({ its_reference_load: "1" }).eq("equipment_size", 26).select("id");
    expect(upd.error).toBeNull();
    expect(upd.data).toEqual([]);
    const del = await sb.from("lane_references").delete().eq("equipment_size", 26).select("id");
    expect(del.error).toBeNull();
    expect(del.data).toEqual([]);
  }
  // control: the seeded numbers are untouched, and the staff client reads them
  expect((await laneRows(mitrex, u481, 26))[0].its_reference_load).toBe("1269");
  const staff = await signedIn("admin@e2e.test");
  expect((await staff.from("lane_references").select("id")).data!.length).toBeGreaterThanOrEqual(25);
  // a signed out visitor
  const v = await anon(browser);
  const csv = await v.ctx.request.get("/admin/lanes/csv", { maxRedirects: 0 });
  expect([307, 308, 302, 401]).toContain(csv.status());
  expect(await csv.text()).not.toContain("load_to_copy");
  await v.page.goto("/admin/lanes");
  await expect(v.page).toHaveURL(/\/login/);
  await v.ctx.close();
});

// ---- the leak test and the emails ----------------------------------------------------------------------------------

const MARIA = "maria@e2e.test";

async function mariaBooks(browser: Browser, pickup: TestLocation | string, delivery: TestLocation | string, size: 26 | 36 | 53, po: string, trucks = 1) {
  const label = (x: TestLocation | string) => (typeof x === "string" ? x : x.label);
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/book");
  await fillBooking(page, {
    pickup: label(pickup), delivery: label(delivery),
    pickupContact: ["Pat Pickup", "416-555-0101"], deliveryContact: ["Dee Delivery", "416-555-0102"],
    pickupDate: isoDate(4), equipment: size, po,
  });
  if (trucks > 1) await page.getByLabel("How many trucks?").fill(String(trucks));
  await page.getByRole("button", { name: trucks > 1 ? `Request ${trucks} loads` : "Request load" }).click();
  await page.waitForURL(/\/loads(\/[0-9a-f-]{36})?(\?booked=.*)?$/);
  await ctx.close();
  const { data } = await db().from("loads").select("id,load_number").eq("po_number", po).order("load_number");
  for (const r of data ?? []) parkedLoads.push(r.id as string);
  return (data ?? []) as { id: string; load_number: string }[];
}

async function emailsWith(text: string, count: number, timeoutMs = 15_000): Promise<SentEmail[]> {
  const end = Date.now() + timeoutMs;
  let hits: SentEmail[] = [];
  while (Date.now() < end) {
    hits = (await sentEmails()).filter((m) => (m.text ?? "").includes(text) || m.subject.includes(text));
    if (hits.length >= count) return hits;
    await new Promise((r) => setTimeout(r, 300));
  }
  return hits;
}

const rawAndRendered = async (s: { page: Page; ctx: { request: { get(u: string): Promise<{ text(): Promise<string> }> } } }, path: string): Promise<string> => {
  await s.page.goto(path);
  await s.page.waitForLoadState("networkidle");
  const raw = await (await s.ctx.request.get(path)).text();
  return (await s.page.content()) + "\n" + raw;
};

test("LEAK: the lane reference number appears ONLY in the staff views and the staff request email, never to Maria, the carrier, or in any other email, export or realtime payload", async ({ browser }) => {
  const a = await loc("E2E-LEAKA"), b = await loc("E2E-LEAKB");
  const NUMBER = `999${unique()}`; // 999 plus digits unique to this run: appears nowhere else in the app, its data or the mail mock
  const NOTE = `LEAKNOTE${unique()}`;
  await addLaneRow(a.id, b.id, 26, NUMBER, NOTE);
  const its = uniqIts();
  const po = uniq("LEAK");
  const [load] = await mariaBooks(browser, a, b, 26, po);
  expect(load).toBeTruthy();
  const secrets = [NUMBER, NOTE];
  const clean = (where: string, text: string) => {
    for (const x of secrets) expect(text.includes(x), `${where} must not contain ${x}`).toBe(false);
  };

  // 1. the staff request email carries it (the positive control)
  const staffMails = await emailsWith(load.load_number, 1);
  expect(staffMails).toHaveLength(1);
  expect(staffMails[0].subject).toBe(`New load requested (Request ${load.load_number})`);
  expect(staffMails[0].text).toContain(`ITS load to copy: ${NUMBER} (${a.name} to ${b.name}, 26 ft)`);
  expect(staffMails[0].text ?? "").not.toContain(NOTE); // only the number is sent, not the note
  expect(staffMails[0].to).not.toContain(MARIA);

  // 2. Maria: every page she can open while the load is requested (raw HTML including the Next payload, and the rendered DOM)
  const maria = await as(browser, "maria");
  for (const path of ["/loads", `/loads/${load.id}`, `/loads/${load.id}/edit`, "/book", "/locations", "/loads?view=completed"]) {
    clean(`Maria ${path}`, await rawAndRendered(maria, path));
  }
  // her own PostgREST view of the load has no lane column and no joined lane
  const mSb = await signedIn(MARIA);
  const mLoad = await mSb.from("loads").select("*").eq("id", load.id).single();
  clean("Maria's own load row", JSON.stringify(mLoad.data));
  expect(await mSb.from("lane_references").select("*")).toMatchObject({ data: [] });

  // 3. staff: the card shows it (positive control that the scan can see it), then assign the carrier and book
  const staff = await as(browser, "admin");
  const staffText = await rawAndRendered(staff, `/admin/loads/${load.id}`);
  expect(staffText).toContain(NUMBER);
  await staff.page.getByLabel("Carrier").first().selectOption({ label: CARRIER_A });
  await staff.page.getByRole("button", { name: "Save carrier" }).click();
  await expect(staff.page.getByText("Carrier assigned.").first()).toBeVisible();
  await staffBook(staff.page, its);
  await expect.poll(async () => (await db().from("loads").select("status").eq("id", load.id).single()).data?.status, { timeout: 20_000 }).toBe("booked");
  await staff.page.goto("/admin");
  await staff.page.waitForLoadState("networkidle");
  expect(await staff.page.locator(`a[href="/admin/loads/${load.id}"]`).count()).toBe(1); // booked: on the board, no Copy ITS line
  await expect(staff.page.locator(`a[href="/admin/loads/${load.id}"]`).getByTestId("board-copy-its")).toHaveCount(0);
  await staff.page.goto(`/admin/loads/${load.id}`);
  await expect(staff.page.getByTestId("its-copy-number")).toHaveText(NUMBER);

  // 4. the booking confirmation to Maria and the carrier assignment email
  const booked = await emailsWith(`Load ${its} booked`, 1);
  expect(booked).toHaveLength(1);
  expect(booked[0].to).toContain(MARIA);
  clean("the booking confirmation (text)", booked[0].text ?? "");
  clean("the booking confirmation (html)", booked[0].html ?? "");
  clean("the booking confirmation (subject)", booked[0].subject);
  const assigned = await emailsWith(`Load ${its} assigned to you`, 1);
  expect(assigned).toHaveLength(1);
  clean("the carrier email (text)", assigned[0].text ?? "");
  clean("the carrier email (html)", assigned[0].html ?? "");
  // EVERY recorded email that carries the number is the one staff request email, sent to staff only
  const staffEmails = new Set((await db().from("profiles").select("email").eq("is_active", true).in("role", ["staff_admin", "staff_csr"])).data!.map((r) => r.email as string));
  const carrying = (await sentEmails()).filter((m) => [m.subject, m.text ?? "", m.html ?? ""].some((t) => t.includes(NUMBER)));
  expect(carrying).toHaveLength(1);
  expect(carrying[0].subject).toBe(`New load requested (Request ${load.load_number})`);
  for (const to of carrying[0].to) expect(staffEmails.has(to), `${to} is staff`).toBe(true);
  expect((await sentEmails()).filter((m) => [m.subject, m.text ?? "", m.html ?? ""].some((t) => t.includes(NOTE)))).toHaveLength(0);

  // 5. Maria after booking, and the carrier after assignment
  for (const path of ["/loads", `/loads/${load.id}`, "/locations"]) clean(`Maria ${path} (booked)`, await rawAndRendered(maria, path));
  await maria.ctx.close();
  const carrier = await as(browser, "carrierA");
  for (const path of ["/my-loads", `/my-loads/${load.id}`]) {
    const text = await rawAndRendered(carrier, path);
    clean(`carrier ${path}`, text);
    if (path !== "/my-loads") expect(text).toContain(its); // control: the carrier really saw the load
  }
  await carrier.ctx.close();

  // 6. the CSV export of loads and the realtime publication
  const from = isoDate(-1), to = isoDate(30);
  const exp = await staff.ctx.request.get(`/admin/export/csv?from=${from}&to=${to}&by=created_at`);
  expect(exp.status()).toBe(200);
  const expText = await exp.text();
  expect(expText).toContain(its); // control: the load is in the export
  clean("the loads CSV export", expText);
  await staff.ctx.close();
  assertLocalUrl(DB_URL, "db url");
  const pub = spawnSync("psql", [DB_URL, "-At", "-c", "select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1"], { encoding: "utf8" });
  expect(pub.status).toBe(0);
  const published = pub.stdout.trim().split("\n");
  expect(published).toContain("loads"); // control: the publication is read
  expect(published).not.toContain("lane_references");
});

test("the staff request email: one line for the seeded scenario of a 3 truck booking, and the Add it link for a scenario with no row", async ({ browser }) => {
  const po = uniq("LANE-MAIL");
  const trucks = await mariaBooks(browser, "Mitrex (Toronto)", "481 University Ave (Toronto)", 26, po, 3);
  expect(trucks).toHaveLength(3);
  const mails = await emailsWith(po, 1);
  expect(mails).toHaveLength(1);
  const body = mails[0].text ?? "";
  expect(body.split("\n").filter((l) => l.startsWith("ITS load to copy:"))).toEqual(["ITS load to copy: 1269 (Mitrex to 481 University Ave, 26 ft)"]);
  expect(body).not.toContain("No ITS reference");
  expect(mails[0].subject).toContain("3 trucks");

  const a = await loc("E2E-NOREFA"), b = await loc("E2E-NOREFB");
  const po2 = uniq("LANE-MAIL2");
  const two = await mariaBooks(browser, a, b, 36, po2, 2);
  expect(two).toHaveLength(2);
  const mails2 = await emailsWith(po2, 1);
  expect(mails2).toHaveLength(1);
  const lines = (mails2[0].text ?? "").split("\n");
  expect(lines.filter((l) => l.includes("ITS reference") || l.startsWith("ITS load to copy"))).toEqual([
    `No ITS reference for this lane and size yet. Add it: ${BASE_URL}/admin/lanes?pickup=${a.id}&delivery=${b.id}&size=36`,
  ]);
  // the link works for staff and prefills the form
  const s = await admin(browser, `/admin/lanes?pickup=${a.id}&delivery=${b.id}&size=36`);
  await expect(s.page.getByLabel("Pickup location")).toHaveValue(a.id);
  await expect(s.page.getByLabel("Delivery location")).toHaveValue(b.id);
  await expect(s.page.locator('select[name="size"]')).toHaveValue("36");
  await s.ctx.close();
});

// ---- Moffett ----------------------------------------------------------------------------------------------------

test("the Moffett lock now applies to the 7 sites (1HAM locks it on) and the booking form for Mitrex to 481 University Ave stays unlocked", async ({ browser }) => {
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/book");
  const moffett = page.getByLabel(/Moffett/);
  await page.getByLabel("Pickup location").selectOption({ label: "Mitrex (Toronto)" });
  await page.getByLabel("Delivery location").selectOption({ label: "481 University Ave (Toronto)" });
  await expect(moffett).not.toBeChecked();
  await expect(moffett).toBeEnabled();
  await page.getByLabel("Delivery location").selectOption({ label: "1HAM (Hamilton)" });
  await expect(moffett).toBeChecked();
  await expect(moffett).toBeDisabled();
  await page.getByLabel("Delivery location").selectOption({ label: "481 University Ave (Toronto)" });
  await expect(moffett).not.toBeChecked();
  await expect(moffett).toBeEnabled();
  for (const name of ["152 Sh (Kitchener)", "831 Queen (Hamilton)", "Glengarry (Kingston)", "Kitney site (Ajax)", "Military Trailsite (Scarborough)", "PrimeFab (Midland)", "SAMIH (Scarborough)"]) {
    await page.getByLabel("Delivery location").selectOption({ label: name });
    await expect(moffett, name).toBeChecked();
    await expect(moffett, name).toBeDisabled();
  }
  await ctx.close();
});

// ---- mobile ------------------------------------------------------------------------------------------------------------

test("mobile 375px: /admin/lanes (list, add form, import preview) and the load card do not scroll sideways and keep 44px targets", async ({ browser }) => {
  const l = await requested(ids.get("Mitrex")!, ids.get("125G")!, 36);
  const s = await admin(browser, "/admin/lanes", { width: 375, height: 812 });
  const page = s.page;
  const noSideScroll = async (label: string) => {
    const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
    expect(w.s, `${label}: scrollWidth ${w.s} <= clientWidth ${w.c}`).toBeLessThanOrEqual(w.c);
  };
  await expect(page.getByRole("heading", { name: "Lanes", exact: true })).toBeVisible();
  await noSideScroll("list");
  await page.getByRole("button", { name: "Add lane", exact: true }).click();
  await noSideScroll("add form");
  await page.getByRole("button", { name: "Import CSV" }).click();
  await page.getByLabel("Or paste the CSV here").fill("shipper,receiver,truck_size,load_to_copy,note\nMitrex,Howden,26,12\nNowhere,Howden,26,12");
  await expect(page.getByTestId("preview-row")).toHaveCount(2);
  await noSideScroll("import preview");
  for (const name of ["Close add form", "Close import", "Apply import"]) {
    const box = await page.getByRole("button", { name }).boundingBox();
    expect(box!.height, name).toBeGreaterThanOrEqual(44);
  }
  const edit = await laneRow(page, "Mitrex", "1HAM", 26).getByRole("button", { name: "Edit" }).boundingBox();
  expect(edit!.height).toBeGreaterThanOrEqual(44);
  await page.goto(`/admin/loads/${l.id}`);
  await expect(page.getByTestId("its-copy-card")).toBeVisible();
  await noSideScroll("load card (no reference)");
  const link = await page.getByRole("link", { name: "Add it" }).boundingBox();
  expect(link!.height).toBeGreaterThanOrEqual(44);
  await s.ctx.close();
});
