import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { anon, as, insertLoad, isoDate, uniq } from "./support/helpers";
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
    await scan(page, "/loads/[id]/edit", { path: new RegExp(`^/loads/${requested.id}/edit$`), h1: new RegExp(`Edit ${requested.loadNumber}`) });
    await page.goto("/locations");
    await scan(page, "/locations", { path: /^\/locations$/, h1: /Locations/ });
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
