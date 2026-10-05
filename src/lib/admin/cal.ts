// Pure calendar date math on "YYYY-MM-DD" strings (no time zone involved).
const DAY = 86400000;

export function parseDay(d: string): Date {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

export function fmtDay(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

export function isValidDay(d: string | undefined): d is string {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const dt = parseDay(d);
  return !Number.isNaN(dt.getTime()) && fmtDay(dt) === d;
}

export function addDays(d: string, n: number): string {
  return fmtDay(new Date(parseDay(d).getTime() + n * DAY));
}

export function startOfWeek(d: string): string {
  const dt = parseDay(d);
  return addDays(d, -dt.getUTCDay());
}

export function startOfMonth(d: string): string {
  return d.slice(0, 8) + "01";
}

export function addMonths(d: string, n: number): string {
  const dt = parseDay(d);
  return fmtDay(new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + n, 1)));
}

export function endOfMonth(d: string): string {
  return addDays(addMonths(d, 1), -1);
}

export function monthLabel(d: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", month: "long", year: "numeric" }).format(parseDay(d));
}

export function dayLabel(d: string, long = false): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC", weekday: long ? "long" : "short", month: "short", day: "numeric",
  }).format(parseDay(d));
}

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
