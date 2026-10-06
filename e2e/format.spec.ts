import { expect, test } from "@playwright/test";
import {
  TZ, easternLocalToIso, fmtDate, fmtDateTime, fmtSlot, fmtTime, isoToEasternLocal,
} from "../src/lib/format";

// R2: every displayed time is Eastern (America/Toronto) and says "ET". Pure helpers, no browser.
// 2026 DST in America/Toronto: spring forward Sun Mar 8 02:00 EST -> 03:00 EDT (02:xx does not exist),
// fall back Sun Nov 1 02:00 EDT -> 01:00 EST (01:xx happens twice).

test("the zone is America/Toronto", () => {
  expect(TZ).toBe("America/Toronto");
});

test("fmtDateTime carries ET and renders Eastern wall time in winter and summer", () => {
  // 15:30Z is 10:30 EST in January and 11:30 EDT in July.
  expect(fmtDateTime("2026-01-15T15:30:00Z")).toBe("Jan 15, 10:30 a.m. ET");
  expect(fmtDateTime("2026-07-15T15:30:00Z")).toBe("Jul 15, 11:30 a.m. ET");
  for (const iso of ["2026-01-15T03:00:00Z", "2026-07-15T23:59:00Z", "2026-03-08T07:30:00Z", "2026-11-01T06:30:00Z"]) {
    expect(fmtDateTime(iso).endsWith(" ET")).toBe(true);
  }
  expect(fmtDateTime(null)).toBe("");
  expect(fmtDateTime(undefined)).toBe("");
  expect(fmtDateTime("")).toBe("");
});

test("fmtDateTime does not depend on the machine zone", () => {
  const saved = process.env.TZ;
  try {
    const seen = new Set<string>();
    for (const zone of ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      process.env.TZ = zone;
      seen.add(fmtDateTime("2026-07-15T03:30:00Z"));
    }
    expect([...seen]).toEqual(["Jul 14, 11:30 p.m. ET"]);
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});

test("fmtTime and fmtSlot: appointment wording versus window wording, both with ET", () => {
  expect(fmtTime("08:30:00")).toBe("8:30 AM");
  expect(fmtTime("00:05:00")).toBe("12:05 AM");
  expect(fmtTime("12:00")).toBe("12:00 PM");
  expect(fmtTime("23:59:00")).toBe("11:59 PM");
  expect(fmtTime(null)).toBe("");

  const appt = fmtSlot("appointment", "2026-03-08", "14:00:00", null);
  expect(appt).toBe("Sun, Mar 8, 2026, 2:00 PM ET (appointment)");
  // An appointment ignores a stray end time.
  expect(fmtSlot("appointment", "2026-03-08", "14:00:00", "16:00:00")).toBe(appt);

  const win = fmtSlot("window", "2026-03-08", "08:00:00", "11:30:00");
  expect(win).toBe("Sun, Mar 8, 2026, 8:00 AM to 11:30 AM ET (window)");
  expect(appt).not.toContain(" to ");
  expect(win).not.toContain("appointment");
  expect(appt).not.toContain("window");
});

test("date-only strings are never shifted by a time zone", () => {
  const saved = process.env.TZ;
  try {
    for (const zone of ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
      process.env.TZ = zone;
      expect(fmtDate("2026-03-08")).toBe("Sun, Mar 8, 2026");
      expect(fmtDate("2026-11-01")).toBe("Sun, Nov 1, 2026");
      expect(fmtDate("2026-12-31")).toBe("Thu, Dec 31, 2026");
      expect(fmtDate("2028-02-29")).toBe("Tue, Feb 29, 2028");
      expect(fmtSlot("appointment", "2026-01-01", "00:00:00", null)).toContain("Thu, Jan 1, 2026");
    }
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
  expect(fmtDate(null)).toBe("");
});

test("easternLocalToIso and isoToEasternLocal agree with known instants outside the transitions", () => {
  expect(easternLocalToIso("2026-01-15T10:30")).toBe("2026-01-15T15:30:00.000Z"); // EST, UTC-5
  expect(easternLocalToIso("2026-07-15T11:30")).toBe("2026-07-15T15:30:00.000Z"); // EDT, UTC-4
  expect(isoToEasternLocal("2026-01-15T15:30:00Z")).toBe("2026-01-15T10:30");
  expect(isoToEasternLocal("2026-07-15T15:30:00Z")).toBe("2026-07-15T11:30");
  // Midnight rolls the UTC date forward, never back.
  expect(easternLocalToIso("2026-07-15T23:30")).toBe("2026-07-16T03:30:00.000Z");
  expect(isoToEasternLocal("2026-07-16T03:30:00Z")).toBe("2026-07-15T23:30");
});

test("spring forward (Mar 8 2026): exact instants on both sides, no 02:xx, no one hour drift after 03:00", () => {
  expect(easternLocalToIso("2026-03-08T01:59")).toBe("2026-03-08T06:59:00.000Z"); // EST
  expect(easternLocalToIso("2026-03-08T03:00")).toBe("2026-03-08T07:00:00.000Z"); // EDT, one minute later
  expect(easternLocalToIso("2026-03-08T04:30")).toBe("2026-03-08T08:30:00.000Z");
  expect(easternLocalToIso("2026-03-08T06:59")).toBe("2026-03-08T10:59:00.000Z");
  expect(easternLocalToIso("2026-03-08T12:00")).toBe("2026-03-08T16:00:00.000Z");
  expect(easternLocalToIso("2026-03-07T23:59")).toBe("2026-03-08T04:59:00.000Z");
  // The minute after 01:59 EST is 03:00 EDT: the instant list has no gap and no overlap.
  expect(isoToEasternLocal("2026-03-08T06:59:00Z")).toBe("2026-03-08T01:59");
  expect(isoToEasternLocal("2026-03-08T07:00:00Z")).toBe("2026-03-08T03:00");
  // A time inside the skipped hour does not exist: it must land on a real instant inside the day,
  // within one hour of the request, and never fail.
  for (const t of ["02:00", "02:15", "02:30", "02:59"]) {
    const iso = easternLocalToIso(`2026-03-08T${t}`);
    expect(Number.isNaN(new Date(iso).getTime())).toBe(false);
    expect(isoToEasternLocal(iso).startsWith("2026-03-08T03:")).toBe(true);
  }
});

test("fall back (Nov 1 2026): the repeated hour resolves to its first occurrence, later times are not shifted", () => {
  expect(easternLocalToIso("2026-11-01T00:59")).toBe("2026-11-01T04:59:00.000Z"); // EDT
  // The ambiguous hour 01:00 to 01:59 exists twice. Either instant is valid, the first (EDT) is chosen,
  // and it must round trip to the same wall clock.
  for (const t of ["01:00", "01:15", "01:30", "01:59"]) {
    const iso = easternLocalToIso(`2026-11-01T${t}`);
    const first = Date.UTC(2026, 10, 1, Number(t.slice(0, 2)) + 4, Number(t.slice(3)));
    expect(new Date(iso).getTime()).toBe(first);
    expect(isoToEasternLocal(iso)).toBe(`2026-11-01T${t}`);
    // The second occurrence (EST) is one hour later and shows the same wall clock.
    expect(isoToEasternLocal(new Date(first + 3_600_000).toISOString())).toBe(`2026-11-01T${t}`);
  }
  // After the repeat the zone is EST (UTC-5): 02:00 is 07:00Z. These were an hour off before the fix.
  expect(easternLocalToIso("2026-11-01T02:00")).toBe("2026-11-01T07:00:00.000Z");
  expect(easternLocalToIso("2026-11-01T03:30")).toBe("2026-11-01T08:30:00.000Z");
  expect(easternLocalToIso("2026-11-01T05:59")).toBe("2026-11-01T10:59:00.000Z");
  expect(easternLocalToIso("2026-11-01T12:00")).toBe("2026-11-01T17:00:00.000Z");
  expect(easternLocalToIso("2026-11-02T00:00")).toBe("2026-11-02T05:00:00.000Z");
});

test("round trip every 15 minutes across both DST weekends", () => {
  const bad: string[] = [];
  const sweep = (fromDay: string, toDay: string, skipHour: { day: string; hour: string } | null) => {
    const start = Date.UTC(+fromDay.slice(0, 4), +fromDay.slice(5, 7) - 1, +fromDay.slice(8, 10));
    const end = Date.UTC(+toDay.slice(0, 4), +toDay.slice(5, 7) - 1, +toDay.slice(8, 10));
    for (let ms = start; ms < end; ms += 15 * 60_000) {
      const local = new Date(ms).toISOString().slice(0, 16); // the wall clock, written as if it were UTC
      if (skipHour && local.startsWith(`${skipHour.day}T${skipHour.hour}:`)) continue; // does not exist
      if (isoToEasternLocal(easternLocalToIso(local)) !== local) bad.push(local);
    }
  };
  sweep("2026-03-07", "2026-03-10", { day: "2026-03-08", hour: "02" });
  sweep("2026-10-31", "2026-11-03", null);
  expect(bad).toEqual([]);
});

test("the reverse direction is monotonic across both transitions (iso -> wall -> iso)", () => {
  const bad: string[] = [];
  for (const [from, to] of [["2026-03-08T04:00:00Z", "2026-03-08T12:00:00Z"], ["2026-11-01T03:00:00Z", "2026-11-01T11:00:00Z"]]) {
    for (let ms = Date.parse(from); ms < Date.parse(to); ms += 15 * 60_000) {
      const iso = new Date(ms).toISOString();
      const back = easternLocalToIso(isoToEasternLocal(iso));
      // Wall -> instant may pick the first of two instants in the repeated hour, never anything else.
      const delta = ms - Date.parse(back);
      if (delta !== 0 && delta !== 3_600_000) bad.push(iso);
    }
  }
  expect(bad).toEqual([]);
});
