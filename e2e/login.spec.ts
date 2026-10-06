import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { adminClient, anon } from "./support/helpers";
import { localEnv } from "./support/env";
import { assertLocalUrl } from "./support/guard";
import { latestCode } from "./support/mail";

// R3 invite-only code login (no passwords, no public signup) and R36 deactivated users cannot sign in.
// Every database claim is read through the service role. Fresh addresses are used each run, so the
// per address send cooldown never applies.

test.describe.configure({ timeout: 120_000 });

const created: string[] = [];
function freshEmail(tag: string): string {
  return `${tag}-${Date.now().toString(36)}-${process.pid}-${Math.floor(Math.random() * 1e6).toString(36)}@e2e.test`.toLowerCase();
}

async function authUserCount(): Promise<number> {
  const db = adminClient();
  let total = 0;
  for (let page = 1; page < 100; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    total += data.users.length;
    if (data.users.length < 200) break;
  }
  return total;
}

async function authUserByEmail(email: string) {
  const db = adminClient();
  for (let page = 1; page < 100; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email === email);
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

// A real invited user: auth user plus an active customer profile for Mitrex.
async function createInvited(email: string, opts: { active: boolean; ban: boolean }): Promise<string> {
  const db = adminClient();
  const { data: cust } = await db.from("customers").select("id").eq("name", "Mitrex").single();
  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  const id = data.user.id;
  created.push(id);
  const p = await db.from("profiles").insert({
    id, email, full_name: "Login test", role: "customer", customer_id: cust!.id, is_active: opts.active,
  });
  if (p.error) throw p.error;
  if (opts.ban) {
    const b = await db.auth.admin.updateUserById(id, { ban_duration: "876000h" });
    if (b.error) throw b.error;
  }
  return id;
}

test.afterAll(async () => {
  const db = adminClient();
  for (const id of created) await db.auth.admin.deleteUser(id).catch(() => {});
});

async function requestCode(page: Page, email: string): Promise<number> {
  await page.goto("/login");
  const sentAt = Date.now();
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-send").click();
  await page.getByTestId("login-code").waitFor();
  return sentAt;
}

// What a person sees on the code step, with the typed address and the live countdown normalised.
async function codeStepShape(page: Page, email: string) {
  const text = (await page.locator("main").innerText()).split(email).join("<EMAIL>").replace(/Resend code in \d+s/, "Resend code in Ns");
  const testIds = await page.locator("[data-testid]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")).sort());
  return { text, testIds, heading: await page.getByRole("heading", { level: 1 }).innerText() };
}

async function hasSession(ctx: BrowserContext): Promise<boolean> {
  return (await ctx.cookies()).some((c) => /^sb-.*-auth-token(\.\d+)?$/.test(c.name));
}

test("an unknown email gets the same code step as a known one and no auth user is created", async ({ browser }) => {
  const known = freshEmail("known");
  await createInvited(known, { active: true, ban: false });
  const unknown = freshEmail("nobody");
  expect(await authUserByEmail(unknown)).toBeNull();
  const before = await authUserCount();

  const a = await anon(browser);
  await requestCode(a.page, known);
  const knownShape = await codeStepShape(a.page, known);

  const b = await anon(browser);
  const sentAt = await requestCode(b.page, unknown);
  const unknownShape = await codeStepShape(b.page, unknown);

  expect(knownShape.heading).toBe("Enter your code");
  expect(unknownShape).toEqual(knownShape);
  await expect(b.page.getByTestId("login-error")).toHaveCount(0);
  await expect(a.page.getByTestId("login-error")).toHaveCount(0);

  // The known address really got a code (control), the unknown one got nothing and no account exists.
  expect(await latestCode(known, sentAt - 10_000)).toMatch(/^\d{6,8}$/);
  await expect(latestCode(unknown, sentAt, 4000, 0)).rejects.toThrow(/no code mail/);
  expect(await authUserByEmail(unknown)).toBeNull();
  expect(await authUserCount()).toBe(before);
  const profile = await adminClient().from("profiles").select("id").eq("email", unknown);
  expect(profile.data).toEqual([]);
  await a.ctx.close();
  await b.ctx.close();
});

test("a wrong 8 digit code shows the inline error, clears the field and keeps the user signed out", async ({ browser }) => {
  const email = freshEmail("wrong");
  await createInvited(email, { active: true, ban: false });
  const { ctx, page } = await anon(browser);
  const sentAt = await requestCode(page, email);
  const real = await latestCode(email, sentAt);
  const wrong = real === "00000000" ? "11111111" : "00000000";

  await page.getByTestId("login-code").fill(wrong);
  const err = page.getByTestId("login-error");
  await expect(err).toBeVisible();
  await expect(err).toContainText("That code is wrong or has expired");
  await expect(page.getByTestId("login-code")).toHaveValue("");
  await expect(page).toHaveURL(/\/login/);
  expect(await hasSession(ctx)).toBe(false);
  const other = await ctx.newPage();
  await other.goto("/loads");
  await other.waitForURL(/\/login/);
  await other.close();

  // Control: the real code, typed on the same code step, still works (the wrong try did not lock the user out).
  await page.getByTestId("login-code").fill(real);
  await page.waitForURL((u) => u.pathname !== "/login", { timeout: 20_000 });
  expect(await hasSession(ctx)).toBe(true);
  await ctx.close();
});

test("invite-only: no signup link, no signup route, and the auth API refuses to create accounts", async ({ browser }) => {
  const { ctx, page } = await anon(browser);
  await page.goto("/login");
  await expect(page.getByTestId("login-email")).toBeVisible();
  await expect(page.getByRole("link", { name: /sign ?up|register|create (an )?account/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /sign ?up|register|create (an )?account/i })).toHaveCount(0);
  // No password field: login is by emailed code only.
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  expect(await page.getByText("Access is by invitation.").count()).toBe(1);

  for (const path of ["/signup", "/register", "/sign-up"]) {
    const res = await page.goto(path);
    // Either a 404 or a redirect to the login page: never a form that creates an account.
    expect(res?.status() === 404 || /\/login/.test(page.url())).toBe(true);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
  }
  await ctx.close();

  // The auth server itself (anon key, as any visitor could call it) refuses every account creation path.
  const e = localEnv();
  assertLocalUrl(e.NEXT_PUBLIC_SUPABASE_URL, "supabase url");
  const visitor = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const before = await authUserCount();
  const target = freshEmail("squatter");
  const otp = await visitor.auth.signInWithOtp({ email: target, options: { shouldCreateUser: true } });
  expect(otp.error).not.toBeNull();
  const up = await visitor.auth.signUp({ email: freshEmail("squatter2"), password: "Sup3r-secret-pass!" });
  expect(up.error).not.toBeNull();
  expect(up.data.session).toBeNull();
  expect(await authUserByEmail(target)).toBeNull();
  expect(await authUserCount()).toBe(before);
});

test("a deactivated and banned user cannot get a session through the code login; an active one can", async ({ browser }) => {
  const dead = freshEmail("dead");
  const alive = freshEmail("alive");
  const deadId = await createInvited(dead, { active: false, ban: true });
  await createInvited(alive, { active: true, ban: false });
  const db = adminClient();
  expect((await db.from("profiles").select("is_active").eq("id", deadId).single()).data?.is_active).toBe(false);

  // Control: the active user signs in through the same UI and reaches the customer app.
  const ok = await anon(browser);
  const okSent = await requestCode(ok.page, alive);
  await ok.page.getByTestId("login-code").fill(await latestCode(alive, okSent));
  await ok.page.waitForURL(/\/loads/, { timeout: 20_000 });
  expect(await hasSession(ok.ctx)).toBe(true);
  await ok.ctx.close();

  // The deactivated user sees the same code step (nothing is revealed) but never gets a session.
  const { ctx, page } = await anon(browser);
  const sentAt = await requestCode(page, dead);
  await expect(page.getByTestId("login-error")).toHaveCount(0);
  // The auth server still mails a code (it does not reveal the ban), but the code is refused.
  const mailed = await latestCode(dead, sentAt, 10_000, 0);
  await page.getByTestId("login-code").fill(mailed);
  await expect(page.getByTestId("login-error")).toBeVisible();
  await expect(page.getByTestId("login-code")).toHaveValue("");
  await expect(page).toHaveURL(/\/login/);
  expect(await hasSession(ctx)).toBe(false);
  for (const path of ["/loads", "/book", "/locations", "/admin"]) {
    await page.goto(path);
    await page.waitForURL(/\/login/);
  }
  // Reactivating (profile and ban) is what restores access: the denial really came from the flags.
  const re = await db.auth.admin.updateUserById(deadId, { ban_duration: "none" });
  expect(re.error).toBeNull();
  expect((await db.from("profiles").update({ is_active: true }).eq("id", deadId)).error).toBeNull();
  await ctx.close();
});
