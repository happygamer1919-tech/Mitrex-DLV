import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminClient, as, insertLoad, parseCsv, readDownload, uniq } from "./support/helpers";

function specColumns(): string[] {
  const line = readFileSync("docs/SPEC.md", "utf8").split("\n").find((l) => l.startsWith("CSV_COLUMNS:"));
  if (!line) throw new Error("docs/SPEC.md has no CSV_COLUMNS: line");
  return line.slice("CSV_COLUMNS:".length).split(",").map((s) => s.trim()).filter(Boolean);
}

// A pickup day nobody else uses (2031 to 2038), so the filter window holds only this test's loads.
function farDay(): string {
  const y = 2031 + Math.floor(Math.random() * 8);
  const m = 1 + Math.floor(Math.random() * 12);
  const d = 1 + Math.floor(Math.random() * 28);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

test("CSV export: exact header, filtered row count, escaped cells", async ({ browser }) => {
  const day = farDay();
  const u = uniq("CSV");
  const poComma = `${u},COMMA`;
  const poQuote = `${u}"QUOTE"`;
  const poFormula = `=${u}+1`;
  const poPlain = `${u}-PLAIN`;
  const poCancelled = `${u}-CANCELLED`;
  const poDelivered = `${u}-DELIVERED`;
  await insertLoad({ po: poComma, status: "requested", pickupDate: day });
  await insertLoad({ po: poQuote, status: "requested", pickupDate: day });
  await insertLoad({ po: poFormula, status: "booked", pickupDate: day });
  await insertLoad({ po: poPlain, status: "booked", pickupDate: day });
  await insertLoad({ po: poCancelled, status: "cancelled", pickupDate: day });
  await insertLoad({ po: poDelivered, status: "delivered", pickupDate: day });

  const { ctx, page } = await as(browser, "admin");
  await page.goto("/admin/export");
  await page.getByLabel("From", { exact: true }).fill(day);
  await page.getByLabel("To", { exact: true }).fill(day);
  await page.getByLabel("Requested", { exact: true }).check();
  await page.getByLabel("Booked", { exact: true }).check();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV" }).click()]);
  const text = (await readDownload(download)).toString("utf8");
  await ctx.close();

  const rows = parseCsv(text).filter((r) => r.length > 1 || r[0] !== "");
  const header = rows[0];
  const data = rows.slice(1);
  expect(header).toEqual(specColumns());

  const db = adminClient();
  const { count, error } = await db.from("loads").select("id", { count: "exact", head: true })
    .gte("pickup_date", day).lte("pickup_date", day).in("status", ["requested", "booked"]);
  expect(error).toBeNull();
  expect(count).toBeGreaterThanOrEqual(4);
  expect(data.length).toBe(count);

  const col = (name: string) => header.indexOf(name);
  for (const r of data) {
    expect(r.length).toBe(header.length);
    expect(r[col("pickup_date")]).toBe(day);
    expect(["requested", "booked"]).toContain(r[col("status")]);
  }
  const pos = data.map((r) => r[col("po_number")]);
  // Comma and quote survive a round trip through the RFC 4180 parser untouched.
  expect(pos).toContain(poComma);
  expect(pos).toContain(poQuote);
  // Formula injection guard: a leading "=" is neutralised with a leading apostrophe.
  expect(pos).toContain(`'${poFormula}`);
  expect(pos).not.toContain(poFormula);
  expect(pos).toContain(poPlain);
  // Filtered out by status.
  expect(pos).not.toContain(poCancelled);
  expect(pos).not.toContain(poDelivered);
  // The raw bytes show the quoting, not only the parsed result.
  expect(text).toContain(`"${poComma}"`);
  expect(text).toContain(`"${u}""QUOTE"""`);
});
