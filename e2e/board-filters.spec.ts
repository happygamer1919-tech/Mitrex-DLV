import { expect, test } from "@playwright/test";
import { applyFilters, easternToday, isFiltered, parseFilters, toQuery } from "../src/lib/admin/board-filters";
import type { BoardLoad } from "../src/lib/admin/queries";

// R42 staff board filters and sorting. Pure helpers, no browser: the query string is validated strictly and the
// filter and sort rules are checked on plain data.

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

function load(o: Partial<BoardLoad> & { load_number: string }): BoardLoad {
  return {
    id: o.load_number, po_number: null, created_at: "2026-10-01T10:00:00Z", its_load_number: null, status: "booked",
    pickup_date: "2026-10-08", pickup_timing: "appointment", pickup_time_start: "08:00:00", pickup_time_end: null,
    equipment_size: 53, pickup_location_id: A, delivery_location_id: B, eta: null, carrier_id: null,
    pickup: { name: "Howden", city: "x", province: "ON" }, delivery: { name: "Sherbourne", city: "y", province: "ON" },
    carrier: null, load_documents: [], ...o,
  };
}
const TODAY = "2026-10-07";

test("board filters: bad query values are ignored, never an error", () => {
  const f = parseFilters({ status: "nope", size: "40", sort: "evil", dir: "sideways", view: "x", carrier: "abc", shipper: "'; drop", when: "custom", from: "2026-13-40", to: "zzz" });
  expect(f).toMatchObject({ status: "", size: 0, sort: "pickup_time", dir: "asc", view: "status", carrier: "", shipper: "", when: "", from: "", to: "" });
  expect(isFiltered(f)).toBe(false);
  expect(toQuery(f)).toBe("");
});

test("board filters: a valid query round trips through the URL", () => {
  const f = parseFilters({ q: " ITS 5 ", status: "booked", carrier: "none", shipper: A, size: "26", when: "week", sort: "carrier", dir: "desc", view: "list", bol: "1" });
  expect(f).toMatchObject({ q: "ITS 5", status: "booked", carrier: "none", shipper: A, size: 26, when: "week", sort: "carrier", dir: "desc", view: "list", needsBol: true });
  expect(parseFilters(Object.fromEntries(new URLSearchParams(toQuery(f))))).toEqual(f);
});

test("board filters: custom dates swap when reversed and are used by the date filter", () => {
  const f = parseFilters({ when: "custom", from: "2026-10-10", to: "2026-10-08" });
  expect([f.from, f.to]).toEqual(["2026-10-08", "2026-10-10"]);
  const list = [load({ load_number: "L1", pickup_date: "2026-10-07" }), load({ load_number: "L2", pickup_date: "2026-10-09" }), load({ load_number: "L3", pickup_date: "2026-10-11" })];
  expect(applyFilters(list, f, TODAY).map((l) => l.load_number)).toEqual(["L2"]);
});

test("board filters: today, tomorrow and next 7 days use the Eastern calendar", () => {
  const list = [0, 1, 6, 7].map((d, i) => load({ load_number: `D${d}`, pickup_date: `2026-10-${String(7 + d).padStart(2, "0")}`, id: String(i) }));
  const ids = (when: string) => applyFilters(list, parseFilters({ when }), TODAY).map((l) => l.load_number);
  expect(ids("today")).toEqual(["D0"]);
  expect(ids("tomorrow")).toEqual(["D1"]);
  expect(ids("week")).toEqual(["D0", "D1", "D6"]);
  // 03:30 UTC on 8 Oct is still 7 Oct in Toronto.
  expect(easternToday(new Date("2026-10-08T03:30:00Z"))).toBe("2026-10-07");
});

test("board filters: carrier, shipper, receiver, size and status narrow the list", () => {
  const list = [
    load({ load_number: "A", carrier_id: A, carrier: { name: "Kaja" } }),
    load({ load_number: "B", pickup_location_id: C, equipment_size: 26 }),
    load({ load_number: "C", status: "requested", delivery_location_id: C }),
  ];
  const run = (raw: Record<string, string>) => applyFilters(list, parseFilters(raw), TODAY).map((l) => l.load_number);
  expect(run({ carrier: "none" })).toEqual(["B", "C"]);
  expect(run({ carrier: A })).toEqual(["A"]);
  expect(run({ shipper: C })).toEqual(["B"]);
  expect(run({ receiver: C })).toEqual(["C"]);
  expect(run({ size: "26" })).toEqual(["B"]);
  expect(run({ status: "requested" })).toEqual(["C"]);
});

test("board filters: search covers ITS, request ref, PO, places and carrier, and the quick-pill filters", () => {
  const list = [
    load({ load_number: "MTX-0001", its_load_number: "ITS777", po_number: "PO-9", carrier_id: A, carrier: { name: "Kaja Transport" } }),
    load({ load_number: "MTX-0002" }),
  ];
  const run = (raw: Record<string, string>) => applyFilters(list, parseFilters(raw), TODAY).map((l) => l.load_number);
  for (const q of ["its777", "MTX-0001", "po-9", "howden", "sherbourne", "kaja"]) expect(run({ q })).toEqual(q === "howden" || q === "sherbourne" ? ["MTX-0001", "MTX-0002"] : ["MTX-0001"]);
  expect(run({ q: "howden kaja" })).toEqual(["MTX-0001"]);
  expect(run({ its: "1" })).toEqual(["MTX-0002"]);
  expect(run({ bol: "1" })).toEqual(["MTX-0001", "MTX-0002"]);
});

test("board filters: sorting is stable, windows sort by start, empty values go last in both directions", () => {
  const list = [
    load({ load_number: "W", pickup_timing: "window", pickup_time_start: "06:00:00", pickup_time_end: "10:00:00" }),
    load({ load_number: "X", pickup_time_start: "07:00:00" }),
    load({ load_number: "Y", pickup_time_start: "07:00:00", carrier_id: B, carrier: { name: "Beta" } }),
    load({ load_number: "Z", pickup_time_start: "07:00:00", carrier_id: A, carrier: { name: "Alpha" } }),
  ];
  const run = (raw: Record<string, string>) => applyFilters(list, parseFilters(raw), TODAY).map((l) => l.load_number);
  expect(run({})).toEqual(["W", "X", "Y", "Z"]);
  expect(run({ dir: "desc" })).toEqual(["X", "Y", "Z", "W"]);
  expect(run({ sort: "carrier" })).toEqual(["Z", "Y", "W", "X"]);
  expect(run({ sort: "carrier", dir: "desc" })).toEqual(["Y", "Z", "W", "X"]);
});
