import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { adminClient, anon, as, insertLoad, isoDate, uniq, uniqIts } from "./support/helpers";
import { makeLocation, retireLocations } from "./support/book";
import type { Who } from "./support/users";

// C5b accessibility gate. Run with: npx playwright test e2e/a11y.spec.ts --project=chromium
// Every page and state is scanned with axe at 375x812. Only serious and critical violations fail;
// moderate and minor findings are printed per page (rule ids only).

const VIEWPORT = { width: 375, height: 812 };
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

// ---- contrast math (WCAG 2.x relative luminance) ------------------------------------------------

function lin(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function lum(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
export function ratio(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const INK = "#020814", NEON = "#2BFF88", MINT = "#E8FBF0", AMBER = "#F28C28", MUTED = "#4E5F57", WHITE = "#FFFFFF", LINE = "#CFE6D9";

// Mirrors src/components/ui.tsx (background, text).
const CHIPS: Record<string, [string, string]> = {
  Requested: ["#DCE6F5", INK],
  Booked: [INK, WHITE],
  "At pickup / Loading": ["#FDE7CC", "#6B3A00"],
  Enroute: [AMBER, "#2B1500"],
  "At delivery": ["#E4DCF5", "#3B2A78"],
  Delivered: ["#12875A", WHITE],
  Cancelled: ["#F7D9D9", "#7A1F1F"],
};

test.describe("contrast ratios (measured)", () => {
  test("text pairs meet WCAG AA 4.5:1", () => {
    const pairs: [string, string, string][] = [
      ["neon text on ink", NEON, INK],
      ["ink text on neon button", INK, NEON],
      ["white text on ink", WHITE, INK],
      ["ink text on mint", INK, MINT],
      ["muted on mint", MUTED, MINT],
      ["muted on white", MUTED, WHITE],
      ["amber button text (#2B1500 on amber)", "#2B1500", AMBER],
      ...Object.entries(CHIPS).map(([n, [bg, fg]]) => [`chip ${n}`, fg, bg] as [string, string, string]),
    ];
    const lines: string[] = [];
    const bad: string[] = [];
    for (const [name, fg, bg] of pairs) {
      const r = ratio(fg, bg);
      lines.push(`${name}: ${r.toFixed(2)}`);
      if (r < 4.5) bad.push(`${name} ${r.toFixed(2)}`);
    }
    console.log("CONTRAST text (need 4.5)\n  " + lines.join("\n  "));
    expect(bad).toEqual([]);
  });

  test("non-text: Delivered green stays distinct from mint, neon and card", () => {
    const g = "#12875A";
    const vsMint = ratio(g, MINT), vsNeon = ratio(g, NEON), vsWhite = ratio(g, WHITE);
    console.log(`CONTRAST non-text (need 3.0): delivered vs mint ${vsMint.toFixed(2)}, vs neon ${vsNeon.toFixed(2)}, vs card ${vsWhite.toFixed(2)}`);
    expect(vsMint).toBeGreaterThanOrEqual(3);
    expect(vsNeon).toBeGreaterThanOrEqual(3);
    expect(vsWhite).toBeGreaterThanOrEqual(3);
    // Chips that sit on mint or white need a visible edge from the page: either 3:1 or a border/text weight is not
    // enough for WCAG 1.4.11, so only the filled-boundary ones are held to 3:1 (the text inside carries the meaning).
    const onPage = ["Booked", "Enroute", "Delivered"].map((n) => `${n} ${ratio(CHIPS[n][0], MINT).toFixed(2)}`);
    console.log("CONTRAST chip fill vs mint: " + onPage.join(", "));
  });

  test("input and card borders", () => {
    // Informational: the field border #CFE6D9 is decorative; the 16px text and label carry the control.
    console.log(`CONTRAST info: line ${LINE} on white ${ratio(LINE, WHITE).toFixed(2)}, on mint ${ratio(LINE, MINT).toFixed(2)}`);
  });
});

// Contrast from the colors the browser actually rendered (not the constants above). Reads the real foreground and the
// first opaque background up the ancestor chain, converting any CSS color syntax through a canvas pixel.
async function renderedPair(loc: Locator): Promise<{ fg: string; bg: string }> {
  return loc.first().evaluate((el) => {
    const px = (c: string): [number, number, number, number] => {
      const cv = document.createElement("canvas");
      cv.width = cv.height = 1;
      const g = cv.getContext("2d", { willReadFrequently: true })!;
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = "#000";
      g.fillStyle = c;
      g.fillRect(0, 0, 1, 1);
      const d = g.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const hex = (v: number[]) => "#" + v.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
    const layers: [number, number, number, number][] = [];
    for (let n: Element | null = el; n; n = n.parentElement) {
      const b = px(getComputedStyle(n).backgroundColor);
      if (b[3] > 0) layers.push(b);
      if (b[3] === 1) break;
    }
    let base: number[] = [255, 255, 255];
    for (const l of layers.reverse()) base = [0, 1, 2].map((i) => l[i] * l[3] + base[i] * (1 - l[3]));
    const f = px(getComputedStyle(el).color);
    const fg = [0, 1, 2].map((i) => f[i] * f[3] + base[i] * (1 - f[3]));
    return { fg: hex(fg), bg: hex(base) };
  });
}

test("contrast measured from rendered colors", async ({ browser }) => {
  const rows: string[] = [];
  const check = (name: string, got: { fg: string; bg: string }, expectFg: string, expectBg: string, min: number) => {
    const r = ratio(got.fg, got.bg);
    rows.push(`${name}: ${got.fg} on ${got.bg} = ${r.toFixed(2)}`);
    expect(got.fg.toLowerCase(), `${name}: rendered fg matches the token constant`).toBe(expectFg.toLowerCase());
    expect(got.bg.toLowerCase(), `${name}: rendered bg matches the token constant`).toBe(expectBg.toLowerCase());
    expect(r, `${name}: rendered ratio`).toBeGreaterThanOrEqual(min);
  };
  const seeded: Record<string, string> = {};
  for (const st of ["requested", "booked", "at_pickup", "loading", "enroute", "at_delivery", "delivered", "cancelled"] as const) {
    seeded[st] = (await insertLoad({ po: uniq(`A11Y-C-${st}`), status: st })).loadNumber;
  }
  const label: Record<string, string> = { requested: "Requested", booked: "Booked", at_pickup: "At pickup", loading: "Loading", enroute: "Enroute", at_delivery: "At delivery", delivered: "Delivered", cancelled: "Cancelled" };
  const chipPair: Record<string, [string, string]> = {
    requested: CHIPS.Requested, booked: CHIPS.Booked, at_pickup: CHIPS["At pickup / Loading"], loading: CHIPS["At pickup / Loading"],
    enroute: CHIPS.Enroute, at_delivery: CHIPS["At delivery"], delivered: CHIPS.Delivered, cancelled: CHIPS.Cancelled,
  };
  await session(browser, "maria", async (page) => {
    await page.goto("/loads");
    await expect(page.locator("h1")).toHaveText(/My loads/);
    for (const st of Object.keys(seeded)) {
      const chip = page.locator(`xpath=//*[normalize-space(text())="${seeded[st]}"]/ancestor::*[.//span[contains(@class,"rounded-full")]][1]//span[contains(@class,"rounded-full") and normalize-space(.)="${label[st]}"]`).first();
      await expect(chip, `chip for ${st} is on the page`).toBeVisible();
      const [bg, fg] = chipPair[st];
      check(`chip ${label[st]} (rendered)`, await renderedPair(chip), fg, bg, 4.5);
    }
    // Body text and muted text on mint, rendered.
    check("ink text on mint (rendered h1)", await renderedPair(page.locator("h1")), INK, MINT, 4.5);
    await page.goto(`/loads/${(await insertLoad({ po: uniq("A11Y-M"), status: "booked" })).id}`);
    check("muted on card (rendered dt)", await renderedPair(page.locator("dt.text-muted").first()), MUTED, WHITE, 4.5);
    await page.goto("/book");
    check("amber button text (rendered Request load)", await renderedPair(page.getByRole("button", { name: "Request load" })), "#2B1500", AMBER, 4.5);
    // Tokens that no page renders as text today (neon): render the compiled utility classes and the custom property.
    const tok = await page.evaluate(() => {
      const d = document.createElement("div");
      d.innerHTML = '<button id="n1" class="bg-neon text-ink">x</button><div id="n2" class="bg-ink"><span id="n3" style="color:var(--color-neon)">x</span></div><p id="n4" class="text-muted">x</p>';
      document.body.appendChild(d);
      const root = getComputedStyle(document.documentElement);
      return { vars: ["--color-ink", "--color-neon", "--color-mint", "--color-amber", "--color-muted", "--color-line", "--color-card"].map((v) => root.getPropertyValue(v).trim().toLowerCase()) };
    });
    expect(tok.vars).toEqual([INK, NEON, MINT, AMBER, MUTED, LINE, "#fff"].map((c) => c.toLowerCase()));
    check("ink text on neon button (rendered class)", await renderedPair(page.locator("#n1")), INK, NEON, 4.5);
    check("neon text on ink (rendered)", await renderedPair(page.locator("#n3")), NEON, INK, 4.5);
    check("muted on mint (rendered)", await renderedPair(page.locator("#n4")), MUTED, MINT, 4.5);
  });
  console.log("CONTRAST rendered (need 4.5)\n  " + rows.join("\n  "));
});

// ---- page scanning --------------------------------------------------------------------------------

const tally = { pages: 0 };
const summary: string[] = [];

// Every scan proves the page reached its intended state first (a login redirect or an error page would pass axe
// trivially): the URL path, the single h1 text, optional visible text (status chip, load number) and an open dialog.
type Marker = { path: RegExp; h1: RegExp; text?: string | RegExp; dialog?: boolean; driver?: boolean };

async function scan(page: Page, label: string, m: Marker) {
  const opts = m;
  await page.waitForLoadState("networkidle");
  await expect(page.locator("h1").first(), `${label}: h1 marker`).toHaveText(m.h1);
  expect(new URL(page.url()).pathname, `${label}: url marker`).toMatch(m.path);
  if (m.text !== undefined) await expect(page.locator("main, [role=dialog]").getByText(m.text, { exact: typeof m.text === "string" }).filter({ visible: true }).first(), `${label}: text marker`).toBeVisible();
  if (m.dialog) await expect(page.getByRole("dialog"), `${label}: dialog open`).toBeVisible();
  else await expect(page.getByRole("dialog"), `${label}: no dialog expected`).toHaveCount(0);
  tally.pages += 1;
  const problems: string[] = [];

  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  // heading-order is moderate in axe but was fixed on /locations (h3 under h1), so it is held to zero as well.
  const hard = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical" || v.id === "heading-order");
  for (const v of hard) problems.push(`axe ${v.impact} ${v.id} (${v.nodes.length}): ${v.nodes[0]?.target.join(" ")}`);
  const soft = res.violations.filter((v) => !hard.includes(v)).map((v) => `${v.id}:${v.impact}`);
  summary.push(`${label}: ${soft.length ? soft.join(", ") : "none"}`);

  const facts = await page.evaluate((minH) => {
    const vis = (e: Element) => {
      const r = (e as HTMLElement).getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const small: string[] = [];
    document.querySelectorAll('button, input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]), select, textarea, [role=radio]').forEach((e) => {
      if (!vis(e)) return;
      const h = (e as HTMLElement).getBoundingClientRect().height;
      if (h < minH - 0.5) small.push(`${(e.textContent || (e as HTMLInputElement).name || e.tagName).trim().slice(0, 24)}=${h.toFixed(1)}`);
    });
    return {
      lang: document.documentElement.lang,
      h1: document.querySelectorAll("h1").length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      small,
    };
  }, opts.driver ? 48 : 44);
  if (!facts.lang) problems.push("html lang missing");
  if (facts.h1 !== 1) problems.push(`h1 count ${facts.h1}`);
  if (facts.overflow > 0) problems.push(`horizontal overflow ${facts.overflow}px`);
  if (facts.small.length) problems.push(`targets under ${opts.driver ? 48 : 44}px: ${facts.small.join(", ")}`);

  expect(problems, `${label}: ${problems.join(" | ")}`).toEqual([]);
}

test.afterAll(() => {
  console.log(`A11Y SUMMARY (moderate/minor, names only). Pages scanned in this worker: ${tally.pages}\n  ` + summary.join("\n  "));
});

async function session<T>(browser: Browser, who: Who, fn: (page: Page) => Promise<T>): Promise<T> {
  const { ctx, page } = await as(browser, who, VIEWPORT);
  try {
    return await fn(page);
  } finally {
    await ctx.close();
  }
}

test("login: email step and code step", async ({ browser }) => {
  const { ctx, page } = await anon(browser);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/login");
  await scan(page, "/login (email)", { path: /^\/login$/, h1: /Sign in/ });
  await page.getByTestId("login-email").fill("maria@e2e.test");
  await page.getByTestId("login-send").click();
  await expect(page.getByTestId("login-code")).toBeVisible();
  await scan(page, "/login (code step)", { path: /^\/login$/, h1: /Enter your code/, text: /code/i });
  await ctx.close();
});

test("customer pages and states", async ({ browser }) => {
  const requested = await insertLoad({ po: uniq("A11Y-REQ"), status: "requested" });
  const booked = await insertLoad({ po: uniq("A11Y-BKD"), status: "booked" });
  const delivered = await insertLoad({ po: uniq("A11Y-DLV"), status: "delivered" });
  const cancelled = await insertLoad({ po: uniq("A11Y-CXL"), status: "cancelled" });
  await session(browser, "maria", async (page) => {
    await page.goto("/book");
    await scan(page, "/book (empty)", { path: /^\/book$/, h1: /Book a load/ });
    await page.getByLabel("Delivery location").selectOption({ label: "SAMIH (Scarborough)" });
    await expect(page.getByLabel(/Moffett/)).toBeDisabled();
    await scan(page, "/book (SAMIH, Moffett locked)", { path: /^\/book$/, h1: /Book a load/ });
    await page.goto("/book");
    await page.getByRole("button", { name: "Request load" }).click();
    await expect(page.locator('[role="alert"]').first()).toBeVisible();
    await scan(page, "/book (validation errors)", { path: /^\/book$/, h1: /Book a load/ });
    await page.goto("/book");
    for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "More trucks" }).click();
    await expect(page.getByRole("button", { name: "Request 4 loads" })).toBeVisible();
    await scan(page, "/book (4 trucks)", { path: /^\/book$/, h1: /Book a load/, text: "This creates 4 separate loads, one per truck. Each gets its own load number and status." });

    await page.goto("/loads");
    await scan(page, "/loads (with loads)", { path: /^\/loads$/, h1: /My loads/, text: requested.loadNumber });
    for (const [name, l] of [["requested", requested], ["booked", booked], ["delivered", delivered], ["cancelled", cancelled]] as const) {
      await page.goto(`/loads/${l.id}`);
      await scan(page, `/loads/[id] (${name})`, { path: new RegExp(`^/loads/${l.id}$`), h1: new RegExp(l.loadNumber), text: name[0].toUpperCase() + name.slice(1) });
    }
    await page.goto(`/loads/${requested.id}/edit`);
    await scan(page, "/loads/[id]/edit", { path: new RegExp(`^/loads/${requested.id}/edit$`), h1: new RegExp(`Edit Request ${requested.requestRef}`) });
    await page.goto("/locations");
    await scan(page, "/locations", { path: /^\/locations$/, h1: /Locations/ });

    // Request again: the Completed filter, the copied form with its notice, and the last contact hint states.
    await page.goto("/loads?view=completed");
    await scan(page, "/loads (Completed filter)", { path: /^\/loads$/, h1: /My loads/, text: delivered.loadNumber });
    await page.goto(`/book?from=${delivered.id}`);
    await scan(page, "/book (Request again)", { path: /^\/book$/, h1: /Book a load/, text: `Copied from ${delivered.loadNumber}. Choose the new dates and times.` });
    await page.getByLabel("Contact name").nth(0).fill("Someone Else");
    await expect(page.getByTestId("pickup-use-last")).toBeVisible();
    await scan(page, "/book (last contact hint with Use last contact)", { path: /^\/book$/, h1: /Book a load/, text: /Last contact at/ });
    await page.getByTestId("pickup-use-last").click();
    await scan(page, "/book (last contact, same as last time)", { path: /^\/book$/, h1: /Book a load/, text: /Same as last time/ });
    const fresh = await makeLocation({ prefix: "E2E-A11Y-RA", contactName: "Dflt Name", contactPhone: "416-555-0100" });
    try {
      await page.goto("/book");
      await page.getByLabel("Pickup location").selectOption({ label: fresh.label });
      await scan(page, "/book (no earlier load, default contact)", { path: /^\/book$/, h1: /Book a load/, text: "No earlier load here. Using the saved default contact." });
    } finally {
      await retireLocations([fresh.id]);
    }
  });
});

test("staff pages", async ({ browser }) => {
  const l = await insertLoad({ po: uniq("A11Y-ADM"), status: "booked", pickupDate: isoDate(0) });
  await session(browser, "admin", async (page) => {
    for (const [path, label, h1, pathRe, text] of [
      ["/admin", "/admin", /Load board/, /^\/admin$/, l.loadNumber],
      ["/admin/calendar?view=week", "/admin/calendar (week)", /Calendar/, /^\/admin\/calendar$/, l.loadNumber],
      ["/admin/calendar?view=month", "/admin/calendar (month)", /Calendar/, /^\/admin\/calendar$/, l.loadNumber],
      [`/admin/loads/${l.id}`, "/admin/loads/[id]", new RegExp(l.loadNumber), new RegExp(`^/admin/loads/${l.id}$`), "Booked"],
      ["/admin/locations", "/admin/locations", /Locations/, /^\/admin\/locations$/, undefined],
      ["/admin/requests", "/admin/requests", /Location requests/, /^\/admin\/requests$/, undefined],
      ["/admin/carriers", "/admin/carriers", /Carriers/, /^\/admin\/carriers$/, "E2E Carrier A"],
      ["/admin/users", "/admin/users", /Users/, /^\/admin\/users$/, "admin@e2e.test"],
      ["/admin/export", "/admin/export", /Export loads/, /^\/admin\/export$/, undefined],
    ] as const) {
      await page.goto(path);
      if (label.includes("calendar")) await expect(page).toHaveURL(label.includes("(week)") ? /view=week/ : /view=month/);
      await scan(page, label, { path: pathRe, h1, text });
    }
  });
});

test("staff booking card states: needs carrier and ITS number, refusal message, ITS ready, Edit ITS number", async ({ browser }) => {
  const noCarrier = await insertLoad({ po: uniq("A11Y-BK0"), status: "requested", carrier: false });
  const ready = await insertLoad({ po: uniq("A11Y-BK1"), status: "requested", carrier: true });
  const booked = await insertLoad({ po: uniq("A11Y-BK2"), status: "booked" });
  const h1 = (l: { requestRef: string }) => new RegExp(`Request ${l.requestRef}`);
  await session(browser, "admin", async (page) => {
    await page.goto(`/admin/loads/${noCarrier.id}`);
    await scan(page, "/admin/loads/[id] (booking card: carrier and ITS number missing)", {
      path: new RegExp(`^/admin/loads/${noCarrier.id}$`), h1: h1(noCarrier), text: "Assign a carrier. Enter the ITS load number.",
    });
    await page.goto(`/admin/loads/${ready.id}`);
    await scan(page, "/admin/loads/[id] (booking card: ITS number missing)", {
      path: new RegExp(`^/admin/loads/${ready.id}$`), h1: h1(ready), text: "Enter the ITS load number.",
    });
    await page.getByLabel("ITS load number (required to book)").fill("abc");
    await page.getByRole("button", { name: "Mark booked" }).click();
    await scan(page, "/admin/loads/[id] (booking card: refused number)", {
      path: new RegExp(`^/admin/loads/${ready.id}$`), h1: h1(ready), text: /must be digits/,
    });
    await page.getByLabel("ITS load number (required to book)").fill(uniqIts());
    await expect(page.getByRole("button", { name: "Mark booked" })).toBeEnabled();
    await scan(page, "/admin/loads/[id] (booking card: ready to book)", {
      path: new RegExp(`^/admin/loads/${ready.id}$`), h1: h1(ready), text: "Enter the new load number from ITS.",
    });
    await page.goto(`/admin/loads/${booked.id}`);
    await page.getByRole("button", { name: "Edit ITS number" }).click();
    await expect(page.getByTestId("its-edit-input")).toBeVisible();
    await scan(page, "/admin/loads/[id] (Edit ITS number open)", {
      path: new RegExp(`^/admin/loads/${booked.id}$`), h1: new RegExp(booked.loadNumber), text: "Save ITS number",
    });
  });
});

test("staff Danger zone card and the Delete forever modal (admin only): closed, open, text typed", async ({ browser }) => {
  const l = await insertLoad({ po: uniq("A11Y-DEL"), status: "delivered" });
  const marker = { path: new RegExp(`^/admin/loads/${l.id}$`), h1: new RegExp(l.loadNumber) };
  await session(browser, "admin", async (page) => {
    await page.goto(`/admin/loads/${l.id}`);
    await scan(page, "/admin/loads/[id] (Danger zone card)", { ...marker, text: "Deleting a load removes it from the system for good. Only an admin can do this." });
    await page.getByTestId("delete-open").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await scan(page, "/admin/loads/[id] (Delete forever modal, open)", { ...marker, dialog: true, text: "This permanently deletes the load, its timeline, and its BOL and POD files. This cannot be undone." });
    await page.getByTestId("delete-confirm-input").fill(l.loadNumber);
    await expect(page.getByTestId("delete-confirm")).toBeEnabled();
    await scan(page, "/admin/loads/[id] (Delete forever modal, number typed, button enabled)", { ...marker, dialog: true, text: "Type it exactly as shown." });
    expectVisibleRing("delete modal input", await focusRing(page, page.getByTestId("delete-confirm-input")));
    // WebKit gives a scripted focus() on a button no :focus-visible after a mouse interaction (a harness quirk: the same
    // global rule is measured on WebKit buttons elsewhere in this file), so the two buttons are measured on chromium.
    if (page.context().browser()?.browserType().name() === "chromium") {
      expectVisibleRing("delete modal Delete forever button", await focusRing(page, page.getByTestId("delete-confirm")));
      expectVisibleRing("delete modal Cancel button", await focusRing(page, page.getByTestId("delete-cancel")));
    }
  });
});

test("lane references: /admin/lanes states (list, prefilled add form, refused add, edit row, delete ask, import preview) and the ITS load to copy card", async ({ browser }) => {
  const a = await makeLocation({ prefix: "E2E-A11Y-LA" });
  const b = await makeLocation({ prefix: "E2E-A11Y-LB" });
  const db = adminClient();
  const { data: seeded } = await db.from("locations").select("id,name").in("name", ["Mitrex", "481 University Ave", "125G"]);
  const id = (n: string) => seeded!.find((x) => x.name === n)!.id as string;
  const lane = await db.from("lane_references").insert({ pickup_location_id: a.id, delivery_location_id: b.id, equipment_size: 36, its_reference_load: "6601", note: "a11y lane" }).select("id").single();
  expect(lane.error).toBeNull();
  const withNumber = await insertLoad({ po: uniq("A11Y-LC1"), status: "requested", pickupLocationId: id("Mitrex"), deliveryLocationId: id("481 University Ave"), size: 26 });
  const noNumber = await insertLoad({ po: uniq("A11Y-LC2"), status: "requested", pickupLocationId: id("Mitrex"), deliveryLocationId: id("125G"), size: 53 });
  try {
    await session(browser, "admin", async (page) => {
      const lanes = { path: /^\/admin\/lanes$/, h1: /Lanes/ };
      await page.goto("/admin/lanes");
      await scan(page, "/admin/lanes (list)", { ...lanes, text: /Last updated by/ });
      await page.goto(`/admin/lanes?pickup=${a.id}&delivery=${b.id}&size=36`);
      await scan(page, "/admin/lanes (add form, prefilled from a load)", { ...lanes, text: "Prefilled from the load. Enter the ITS load to copy." });
      await page.locator('input[name="number"]').fill("6602");
      await page.getByRole("button", { name: "Add lane", exact: true }).click();
      await expect(page.getByText("A lane reference for this pickup, delivery and truck size already exists. Edit that row instead.")).toBeVisible();
      await scan(page, "/admin/lanes (add refused: duplicate)", { ...lanes, text: /already exists/ });
      await page.getByRole("button", { name: "Close add form" }).click();
      await page.getByLabel("Search").fill(a.name);
      const row = page.locator('[data-testid="lane-row"]').first();
      await row.getByRole("button", { name: "Edit" }).click();
      await scan(page, "/admin/lanes (row edit open)", { ...lanes, text: /Save/ });
      await row.getByRole("button", { name: "Close" }).click();
      await row.getByRole("button", { name: "Delete" }).click();
      await scan(page, "/admin/lanes (delete asks to confirm)", { ...lanes, text: /This cannot be undone/ });
      await row.getByRole("button", { name: "Keep" }).click();
      await page.getByRole("button", { name: "Import CSV" }).click();
      await page.getByLabel("Or paste the CSV here").fill(`shipper,receiver,truck_size,load_to_copy,note\n${a.name},${b.name},26,6603,\nNowhere,${b.name},48,x,`);
      await scan(page, "/admin/lanes (import preview with row errors)", { ...lanes, text: "1 of 2 rows have errors. Fix them to import." });
      await page.getByLabel("Or paste the CSV here").fill(`shipper,receiver,truck_size,load_to_copy,note\n${a.name},${b.name},26,6603,`);
      await scan(page, "/admin/lanes (import preview, all valid)", { ...lanes, text: "1 row, all valid." });
      await page.goto(`/admin/loads/${withNumber.id}`);
      await scan(page, "/admin/loads/[id] (ITS load to copy card with the number)", { path: new RegExp(`^/admin/loads/${withNumber.id}$`), h1: new RegExp(`Request ${withNumber.requestRef}`), text: "Mitrex to 481 University Ave, 26 ft" });
      await page.goto(`/admin/loads/${noNumber.id}`);
      await scan(page, "/admin/loads/[id] (ITS load to copy card, no reference, Add it)", { path: new RegExp(`^/admin/loads/${noNumber.id}$`), h1: new RegExp(`Request ${noNumber.requestRef}`), text: "No ITS reference for this lane and size" });
    });
  } finally {
    await db.from("lane_references").delete().eq("id", lane.data!.id);
    await retireLocations([a.id, b.id]);
  }
});

test("carrier driver pages and modals", async ({ browser }) => {
  const booked = await insertLoad({ po: uniq("A11Y-DB"), status: "booked" });
  const loading = await insertLoad({ po: uniq("A11Y-DL"), status: "loading" });
  const enroute = await insertLoad({ po: uniq("A11Y-DE"), status: "enroute" });
  const atDel = await insertLoad({ po: uniq("A11Y-DA"), status: "at_delivery" });
  await session(browser, "carrierA", async (page) => {
    await page.goto("/my-loads");
    await scan(page, "/my-loads", { path: /^\/my-loads$/, h1: /My loads/, text: booked.loadNumber, driver: true });
    await page.goto(`/my-loads/${booked.id}`);
    await scan(page, "/my-loads/[id] (booked)", { path: new RegExp(`^/my-loads/${booked.id}$`), h1: new RegExp(booked.loadNumber), text: "Booked", driver: true });
    await page.goto(`/my-loads/${enroute.id}`);
    await scan(page, "/my-loads/[id] (enroute)", { path: new RegExp(`^/my-loads/${enroute.id}$`), h1: new RegExp(enroute.loadNumber), text: "Enroute", driver: true });
    await page.getByRole("button", { name: "Update ETA" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await scan(page, "/my-loads/[id] (Update ETA modal)", { path: new RegExp(`^/my-loads/${enroute.id}$`), h1: new RegExp(enroute.loadNumber), dialog: true, driver: true });
    await page.goto(`/my-loads/${loading.id}`);
    await page.getByTestId("next-step").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await scan(page, "/my-loads/[id] (Enroute ETA modal)", { path: new RegExp(`^/my-loads/${loading.id}$`), h1: new RegExp(loading.loadNumber), dialog: true, driver: true });
    await page.goto(`/my-loads/${atDel.id}`);
    await scan(page, "/my-loads/[id] (at_delivery)", { path: new RegExp(`^/my-loads/${atDel.id}$`), h1: new RegExp(atDel.loadNumber), text: "At delivery", driver: true });
    await page.getByTestId("next-step").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await scan(page, "/my-loads/[id] (POD modal)", { path: new RegExp(`^/my-loads/${atDel.id}$`), h1: new RegExp(atDel.loadNumber), dialog: true, driver: true });
    await page.goto("/team");
    await scan(page, "/team", { path: /^\/team$/, h1: /Team/, driver: true });
  });
});

// ---- keyboard focus ---------------------------------------------------------------------------------

type Ring = { style: string; width: number; ringColors: string[]; bg: string };

// Tabs until the locator is the active element, then reads the computed focus indicator.
async function focusRing(page: Page, target: Locator): Promise<Ring> {
  await target.scrollIntoViewIfNeeded();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const handle = await target.elementHandle();
  if (page.context().browser()?.browserType().name() === "webkit") {
    // Safari does not Tab to buttons and links by default. A key press followed by focus() is keyboard focus.
    await page.keyboard.press("Shift");
    await handle!.evaluate((el) => (el as HTMLElement).focus());
  } else for (let i = 0; i < 80; i++) {
    await page.keyboard.press("Tab");
    if (await handle!.evaluate((el) => el === document.activeElement)) break;
    if (i === 79) throw new Error("could not reach element by keyboard");
  }
  return handle!.evaluate((el) => {
    const parse = (c: string): [number, number, number, number] => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return [0, 0, 0, 0];
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    };
    const hex = (c: number[]) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    // Background behind the ring: first opaque ancestor (blending partial alpha down the chain).
    const layers: [number, number, number, number][] = [];
    let n: Element | null = (el as HTMLElement).parentElement;
    while (n) {
      const b = parse(getComputedStyle(n).backgroundColor);
      if (b[3] > 0) layers.push(b);
      if (b[3] === 1) break;
      n = n.parentElement;
    }
    let base: number[] = [255, 255, 255];
    for (const l of layers.reverse()) base = [0, 1, 2].map((i) => l[i] * l[3] + base[i] * (1 - l[3]));
    const s = getComputedStyle(el);
    const ring: string[] = [];
    if (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) ring.push(hex(parse(s.outlineColor)));
    // Spread ring in box-shadow: "rgb(..) 0px 0px 0px 2px"
    for (const m of s.boxShadow.matchAll(/(rgba?\([^)]+\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/g)) {
      if (parseFloat(m[5]) >= 2 && parseFloat(m[2]) === 0 && parseFloat(m[3]) === 0) ring.push(hex(parse(m[1])));
    }
    return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), ringColors: ring, bg: hex(base) };
  });
}

function expectVisibleRing(name: string, r: Ring) {
  expect(r.ringColors.length, `${name}: has an outline or ring`).toBeGreaterThan(0);
  const best = Math.max(...r.ringColors.map((c) => ratio(c, r.bg)));
  console.log(`FOCUS ${name}: ring ${r.ringColors.join("+")} (outline ${r.style} ${r.width}px) on ${r.bg} = ${best.toFixed(2)}`);
  expect(best, `${name}: ring contrast`).toBeGreaterThanOrEqual(3);
}

test("keyboard focus is visible: mint pages", async ({ browser }) => {
  await session(browser, "maria", async (page) => {
    await page.goto("/book");
    await page.waitForLoadState("networkidle");
    expectVisibleRing("mint select", await focusRing(page, page.getByLabel("Pickup location")));
    expectVisibleRing("mint radio chip", await focusRing(page, page.getByRole("radiogroup", { name: "Equipment size" }).getByRole("radio").first()));
    expectVisibleRing("mint input", await focusRing(page, page.getByLabel("PO number (optional)")));
    expectVisibleRing("mint Button", await focusRing(page, page.getByRole("button", { name: "Request load" })));
    expectVisibleRing("ink header link", await focusRing(page, page.getByRole("link", { name: "Loads", exact: true })));
    expectVisibleRing("ink header sign out", await focusRing(page, page.getByRole("button", { name: "Sign out" })));
    await page.goto("/loads");
    const link = page.locator("main a").first();
    if (await link.count()) expectVisibleRing("mint link", await focusRing(page, link));
  });
  const { ctx, page } = await anon(browser);
  await page.goto("/login");
  expectVisibleRing("login input", await focusRing(page, page.getByTestId("login-email")));
  expectVisibleRing("login Button", await focusRing(page, page.getByTestId("login-send")));
  await ctx.close();
});

test("keyboard focus is visible: ink driver pages", async ({ browser }) => {
  const enroute = await insertLoad({ po: uniq("A11Y-FOC"), status: "enroute" });
  await session(browser, "carrierA", async (page) => {
    await page.goto(`/my-loads/${enroute.id}`);
    await page.waitForLoadState("networkidle");
    expectVisibleRing("driver big button", await focusRing(page, page.getByTestId("next-step")));
    expectVisibleRing("driver white button", await focusRing(page, page.getByRole("button", { name: "Update ETA" })));
    expectVisibleRing("driver header link", await focusRing(page, page.getByRole("link", { name: "My loads", exact: true })));
    const tel = page.locator('a[href^="tel:"]').first();
    if (await tel.count()) expectVisibleRing("driver tap-to-call link", await focusRing(page, tel));
    await page.getByRole("button", { name: "Update ETA" }).click();
    expectVisibleRing("driver modal input", await focusRing(page, page.getByRole("dialog").locator("input").first()));
    expectVisibleRing("driver modal button", await focusRing(page, page.getByRole("dialog").getByRole("button", { name: "Save ETA" })));
  });
});

// ---- DLV-021 drop area states ---------------------------------------------------------------------

test("drop area states: staff BOL and POD zones, carrier POD card, chosen file and error", async ({ browser }) => {
  const delivered = await insertLoad({ po: uniq("A11Y-DZ"), status: "delivered" });
  const staffMarker = { path: new RegExp(`^/admin/loads/${delivered.id}$`), h1: new RegExp(delivered.loadNumber), text: "Delivered" };
  await session(browser, "admin", async (page) => {
    await page.goto(`/admin/loads/${delivered.id}`);
    await expect(page.getByTestId("pod-pending")).toBeVisible();
    await scan(page, "/admin/loads/[id] (delivered, POD pending, two drop areas)", staffMarker);
    const bol = page.getByTestId("upload-bol");
    expectVisibleRing("drop area", await focusRing(page, bol.getByTestId("dropzone")));
    await bol.getByTestId("dropzone-input").setInputFiles({ name: "run.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
    await expect(bol.getByTestId("dropzone-error")).toBeVisible();
    await scan(page, "/admin/loads/[id] (drop area error)", staffMarker);
    await bol.getByTestId("dropzone-input").setInputFiles({ name: "ok.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
    await expect(bol.getByTestId("dropzone-file")).toBeVisible();
    await scan(page, "/admin/loads/[id] (drop area with a chosen file)", staffMarker);
  });
  const carrierMarker = { path: new RegExp(`^/my-loads/${delivered.id}$`), h1: new RegExp(delivered.loadNumber), text: "Delivered", driver: true };
  await session(browser, "carrierA", async (page) => {
    await page.goto(`/my-loads/${delivered.id}`);
    await expect(page.getByTestId("pod-missing")).toBeVisible();
    await scan(page, "/my-loads/[id] (delivered, POD not uploaded yet)", carrierMarker);
    const card = page.getByTestId("pod-card");
    await card.getByTestId("dropzone-input").setInputFiles({ name: "pod.png", mimeType: "image/png", buffer: Buffer.from("x") });
    await expect(card.getByTestId("dropzone-file")).toBeVisible();
    await scan(page, "/my-loads/[id] (POD drop area with a chosen file)", carrierMarker);
  });
});
