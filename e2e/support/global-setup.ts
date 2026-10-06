import { createClient } from "@supabase/supabase-js";
import { chromium, webkit, type FullConfig } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { BASE_URL, localEnv } from "./env";
import { assertLocalUrl } from "./guard";
import { clearMail, latestCode } from "./mail";
import { startMailMock } from "./mail-mock";
import { CARRIER_A, CARRIER_B, USERS, stateFile, type Who } from "./users";

// Creates the e2e users (idempotent) and signs each in through the real code login UI once per
// project (engine), saving e2e/.auth/<project>-<who>.json so the scenarios start authenticated.
export default async function globalSetup(config: FullConfig) {
  const mock = await startMailMock(); // Resend stand-in for the notification emails (see e2e/emails.spec.ts)
  const env = localEnv();
  assertLocalUrl(env.NEXT_PUBLIC_SUPABASE_URL, "supabase url");
  assertLocalUrl(BASE_URL, "base url");
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: customer, error: ce } = await admin.from("customers").select("id").eq("name", "Mitrex").single();
  if (ce) throw new Error("seed.sql not applied locally: " + ce.message);

  async function carrier(name: string) {
    const { data } = await admin.from("carriers").select("id").eq("name", name).maybeSingle();
    if (data) return data.id as string;
    const ins = await admin.from("carriers").insert({ name }).select("id").single();
    if (ins.error) throw ins.error;
    return ins.data.id as string;
  }
  const carriers = { carrierA: await carrier(CARRIER_A), carrierB: await carrier(CARRIER_B) } as Record<string, string>;

  // The database accumulates across runs. Park loads that earlier runs left active for the e2e
  // carriers, so the carrier lists (which cap the active section) hold only this run's loads.
  const parked = await admin.from("loads").update({ status: "cancelled" })
    .in("carrier_id", Object.values(carriers)).in("status", ["booked", "at_pickup", "loading", "enroute", "at_delivery"]);
  if (parked.error) throw parked.error;

  async function userId(email: string) {
    for (let page = 1; page < 20; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw error;
      const hit = data.users.find((u) => u.email === email);
      if (hit) return hit.id;
      if (data.users.length < 200) break;
    }
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error) throw error;
    return data.user.id;
  }

  for (const [who, u] of Object.entries(USERS)) {
    const id = await userId(u.email);
    const row = {
      id, email: u.email, full_name: who, role: u.role,
      customer_id: u.role === "customer" ? customer.id : null,
      carrier_id: who === "carrierA" || who === "carrierB" ? carriers[who] : null,
      is_active: true,
    };
    const { error } = await admin.from("profiles").upsert(row, { onConflict: "id" });
    if (error) throw error;
  }

  mkdirSync("e2e/.auth", { recursive: true });
  for (const project of config.projects) {
    const engine = project.use.defaultBrowserType === "webkit" ? webkit : chromium;
    const browser = await engine.launch();
    for (const who of Object.keys(USERS) as Who[]) {
      await clearMail();
      const ctx = await browser.newContext({
        viewport: project.use.viewport ?? undefined,
        userAgent: project.use.userAgent,
        deviceScaleFactor: project.use.deviceScaleFactor,
        isMobile: project.use.isMobile,
        hasTouch: project.use.hasTouch,
        baseURL: BASE_URL,
      });
      const page = await ctx.newPage();
      await page.goto("/login");
      const sentAt = Date.now();
      await page.getByTestId("login-email").fill(USERS[who].email);
      await page.getByTestId("login-send").click();
      const code = await latestCode(USERS[who].email, sentAt);
      await page.getByTestId("login-code").fill(code);
      await page.waitForURL((u) => u.pathname !== "/login", { timeout: 20_000 });
      await ctx.storageState({ path: stateFile(project.name, who) });
      await ctx.close();
    }
    await browser.close();
  }
  return async () => { await new Promise<void>((r) => mock.close(() => r())); };
}
