import { expect, test, type Page } from "@playwright/test";
import { as, insertBookedLoad } from "./support/helpers";

const VIEWPORT = { width: 375, height: 812 };

async function audit(page: Page, minButton: number, label: string) {
  await page.waitForLoadState("networkidle");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${label}: horizontal overflow`).toBeLessThanOrEqual(0);

  const buttons = page.locator('button, input[type="submit"], [role="button"]');
  const n = await buttons.count();
  expect(n, `${label}: found buttons to check`).toBeGreaterThan(0);
  const small: string[] = [];
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    if (!(await b.isVisible())) continue;
    const box = await b.boundingBox();
    if (box && box.height < minButton - 0.5) small.push(`${(await b.innerText()).slice(0, 30) || "?"}=${box.height.toFixed(1)}`);
  }
  expect(small, `${label}: buttons under ${minButton}px`).toEqual([]);
}

test("customer pages at 375x812", async ({ browser }) => {
  const { ctx, page } = await as(browser, "maria", VIEWPORT);
  for (const path of ["/book", "/loads"]) {
    await page.goto(path);
    await audit(page, 44, path);
  }
  await ctx.close();
});

test("driver pages at 375x812", async ({ browser }) => {
  const id = await insertBookedLoad(`MOB-${Date.now()}`);
  const { ctx, page } = await as(browser, "carrierA", VIEWPORT);
  await page.goto("/my-loads");
  await audit(page, 48, "/my-loads");
  await page.goto(`/my-loads/${id}`);
  await audit(page, 48, "/my-loads/[id]");
  await ctx.close();
});
