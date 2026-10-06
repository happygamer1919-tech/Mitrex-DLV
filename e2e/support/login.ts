import type { Page } from "@playwright/test";
import { latestCode } from "./mail";

// Signs in through the real code login UI (code read from the local mail catcher).
// The code login has a per address send cooldown ("Too many requests"): a throttled send is waited out
// and retried, so a user that signs in twice within a minute (before and after a deactivation, say) works.
export async function loginViaUi(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(email);
  for (let attempt = 0; ; attempt++) {
    const sentAt = Date.now();
    await page.getByTestId("login-send").click();
    const outcome = await Promise.race([
      page.getByTestId("login-code").waitFor({ timeout: 20_000 }).then(() => "code" as const, () => "none" as const),
      page.getByTestId("login-error").waitFor({ timeout: 20_000 }).then(() => "error" as const, () => "none" as const),
    ]);
    if (outcome === "code") {
      const code = await latestCode(email, sentAt);
      await page.getByTestId("login-code").fill(code);
      await page.waitForURL((u) => u.pathname !== "/login", { timeout: 20_000 });
      return;
    }
    if (attempt >= 14) throw new Error("sign in code request stayed throttled");
    await page.waitForTimeout(5000);
  }
}
