import type { Page } from "@playwright/test";
import { latestCode } from "./mail";

// Signs in through the real code login UI (code read from the local mail catcher).
export async function loginViaUi(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  const sentAt = Date.now();
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-send").click();
  const code = await latestCode(email, sentAt);
  await page.getByTestId("login-code").fill(code);
  await page.waitForURL((u) => u.pathname !== "/login", { timeout: 20_000 });
}
