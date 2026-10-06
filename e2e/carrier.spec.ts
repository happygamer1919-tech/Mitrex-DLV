import { expect, test, type Page } from "@playwright/test";
import { adminClient, as, easternLocal, insertLoad, isoDate, loadRow, uniq, type SeedStatus } from "./support/helpers";

// WebKit sometimes reports "navigation interrupted by another navigation" when a page with a live
// Realtime socket and a polling refresh is navigated straight to the next load. Leaving through
// about:blank first tears the old page down, so each load opens on a clean page.
async function openFresh(page: Page, path: string) {
  await page.goto("about:blank");
  await page.goto(path);
}

const LABELS = ["Arrived at pickup", "Start loading", "Leave for delivery", "Arrived at delivery", "Mark delivered"];
const EXPECTED: [SeedStatus, string][] = [
  ["booked", "Arrived at pickup"],
  ["at_pickup", "Start loading"],
  ["loading", "Leave for delivery"],
  ["enroute", "Arrived at delivery"],
  ["at_delivery", "Mark delivered"],
];

test("carrier UI offers only the next step at each status", async ({ browser }) => {
  const { ctx, page } = await as(browser, "carrierA");
  for (const [status, label] of EXPECTED) {
    const { id } = await insertLoad({ po: uniq(`STEP-${status}`), status });
    await openFresh(page, `/my-loads/${id}`);
    await expect(page.getByRole("button", { name: label, exact: true }), `${status}: next step button`).toHaveCount(1);
    for (const other of LABELS.filter((l) => l !== label)) {
      await expect(page.getByRole("button", { name: other, exact: true }), `${status}: no "${other}"`).toHaveCount(0);
    }
    // Exactly one status button in total (any of the five labels).
    const any = page.getByRole("button", { name: new RegExp(`^(${LABELS.join("|")})$`) });
    await expect(any).toHaveCount(1);
  }
  // A delivered load has no status button at all.
  const done = await insertLoad({ po: uniq("STEP-done"), status: "delivered" });
  await openFresh(page, `/my-loads/${done.id}`);
  await expect(page.getByRole("heading", { name: done.loadNumber })).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(`^(${LABELS.join("|")})$`) })).toHaveCount(0);
  await ctx.close();
});

test("ETA: not offered before enroute; carrier update shows on Maria's load page", async ({ browser }) => {
  const carrier = await as(browser, "carrierA");
  for (const status of ["booked", "at_pickup", "loading"] as SeedStatus[]) {
    const { id } = await insertLoad({ po: uniq(`NOETA-${status}`), status });
    await openFresh(carrier.page, `/my-loads/${id}`);
    await expect(carrier.page.getByRole("button", { name: LABELS[["booked", "at_pickup", "loading"].indexOf(status)], exact: true })).toHaveCount(1);
    await expect(carrier.page.getByRole("button", { name: "Update ETA" })).toHaveCount(0);
  }

  const { id } = await insertLoad({ po: uniq("ETA"), status: "enroute" });
  const oldEta = (await loadRow(id)).eta as string;
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
    }).format(new Date(iso)) + " ET";

  const maria = await as(browser, "maria");
  await maria.page.goto(`/loads/${id}`);
  await expect(maria.page.getByText(fmt(oldEta), { exact: true })).toBeVisible();

  const cp = await carrier.ctx.newPage();
  await cp.goto(`/my-loads/${id}`);
  await cp.getByRole("button", { name: "Update ETA" }).click();
  const dialog = cp.getByRole("dialog");
  const newLocal = `${isoDate(5)}T17:47`;
  await dialog.locator('input[type="datetime-local"]').fill(newLocal);
  await dialog.getByRole("button", { name: "Save ETA" }).click();
  await expect(cp.getByRole("dialog")).toHaveCount(0);

  const newEta = (await loadRow(id)).eta as string;
  expect(newEta).not.toBe(oldEta);
  expect(easternLocal(newEta)).toBe(newLocal);
  const status = (await adminClient().from("loads").select("status").eq("id", id).single()).data?.status;
  expect(status).toBe("enroute"); // ETA edit does not move the status

  await maria.page.reload();
  await expect(maria.page.getByText(fmt(newEta), { exact: true })).toBeVisible();
  await expect(maria.page.getByText(fmt(oldEta), { exact: true })).toHaveCount(0);
  await maria.ctx.close();
  await carrier.ctx.close();
});
