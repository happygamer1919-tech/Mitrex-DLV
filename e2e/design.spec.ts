import { expect, test, type Page } from "@playwright/test";
import { as } from "./support/helpers";

// R32 (the part no other spec measures): Plus Jakarta Sans, pill buttons, 16px cards, 12px inputs,
// mint pages for customer and staff, ink pages for drivers. Read from computed styles on rendered pages.
// Contrast, the Delivered green and touch targets are measured in a11y.spec.ts and mobile.spec.ts.

const MINT = "rgb(232, 251, 240)"; // #E8FBF0
const INK = "rgb(2, 8, 20)"; // #020814

// The first family of the body font, and whether a @font-face rule for that family points at the Jakarta files.
async function fontFacts(page: Page) {
  return page.evaluate(async () => {
    const first = getComputedStyle(document.body).fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
    const faces: { family: string; src: string; weight: string }[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const r of Array.from(rules)) {
        if (r instanceof CSSFontFaceRule) {
          faces.push({
            family: r.style.getPropertyValue("font-family").trim().replace(/^["']|["']$/g, ""),
            src: r.style.getPropertyValue("src"), weight: r.style.getPropertyValue("font-weight"),
          });
        }
      }
    }
    await document.fonts.ready;
    const match = faces.filter((f) => f.family === first);
    return {
      first, match,
      loaded: Array.from(document.fonts).some((f) => f.family.replace(/^["']|["']$/g, "") === first && f.status === "loaded"),
    };
  });
}

test("the font is self-hosted Plus Jakarta Sans, loaded, with weights 400 to 700", async ({ browser }) => {
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/book");
  const f = await fontFacts(page);
  expect(f.match.length, `font-face rules for ${f.first}`).toBeGreaterThan(0);
  for (const m of f.match) expect(m.src).toContain("PlusJakartaSans");
  expect(f.match.some((m) => /400/.test(m.weight) && /700/.test(m.weight))).toBe(true);
  expect(f.loaded, "the face really loaded").toBe(true);
  await ctx.close();
});

test("buttons are pills, cards are 16px, inputs are 12px, on the customer pages", async ({ browser }) => {
  const { ctx, page } = await as(browser, "maria");
  await page.goto("/book");
  const px = (el: Element, prop: string) => parseFloat(getComputedStyle(el).getPropertyValue(prop));
  const TL = "border-top-left-radius";
  const BR = "border-bottom-right-radius";

  const btn = page.getByRole("button", { name: "Request load" });
  const h = (await btn.boundingBox())!.height;
  const r = await btn.evaluate(px, TL);
  expect(r, "a pill: radius at least half the height").toBeGreaterThanOrEqual(h / 2);

  const input = page.getByLabel("PO number (optional)");
  expect(await input.evaluate(px, TL)).toBe(12);
  expect(await input.evaluate(px, BR)).toBe(12);
  const select = page.getByLabel("Pickup location");
  expect(await select.evaluate(px, TL)).toBe(12);

  const card = page.locator("div.rounded-\\[16px\\]").first();
  await expect(card).toBeVisible();
  expect(await card.evaluate(px, TL)).toBe(16);
  expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 255, 255)");
  await ctx.close();
});

test("customer and staff pages sit on mint, driver pages on ink", async ({ browser }) => {
  const paint = (page: Page) => page.evaluate(() => {
    const surface = document.querySelector(".driver-surface");
    return {
      body: getComputedStyle(document.body).backgroundColor,
      driver: surface ? getComputedStyle(surface).backgroundColor : null,
    };
  });
  for (const [who, path] of [["maria", "/loads"], ["admin", "/admin"], ["carrierA", "/my-loads"]] as const) {
    const { ctx, page } = await as(browser, who);
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    const p = await paint(page);
    if (who === "carrierA") {
      expect(p.driver, "driver surface painted ink").toBe(INK);
    } else {
      expect(p.driver, `${who} has no driver surface`).toBeNull();
      expect(p.body, `${who} at ${path}`).toBe(MINT);
    }
    await ctx.close();
  }
});
