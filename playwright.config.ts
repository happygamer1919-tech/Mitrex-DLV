import { defineConfig, devices } from "@playwright/test";
import { E2E_PORT, localEnv } from "./e2e/support/env";
import { MAIL_MOCK_URL } from "./e2e/support/mail-mock";

const env = localEnv();
const PORT = E2E_PORT; // default 3200, override with E2E_PORT

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  globalSetup: "./e2e/support/global-setup.ts",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["iPhone 13"] } },
  ],
  webServer: {
    command: `npx next build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      ...env,
      NEXT_DIST_DIR: ".next-e2e",
      NEXT_PUBLIC_SITE_URL: `http://localhost:${PORT}`,
      // Notification emails go to a local mock of the Resend API (started by e2e/support/global-setup.ts).
      RESEND_API_KEY: "re_test_local",
      RESEND_BASE_URL: MAIL_MOCK_URL,
      NOTIFY_FROM: "DLV <noreply@mock.test>",
      NEXT_PUBLIC_ACTION_TIMEOUT_MS: "4000", // watchdog for the e2e server only (default 25000)
    },
  },
});
