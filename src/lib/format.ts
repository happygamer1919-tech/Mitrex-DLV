export const TZ = "America/Toronto";

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  }).format(new Date(iso)) + " ET";
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return "";
  const [y, m, day] = d.split("-").map(Number);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, day)));
}

// "08:30:00" -> "8:30 AM"
export function fmtTime(t: string | null | undefined): string {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${ap}`;
}

export function fmtSlot(timing: "appointment" | "window", date: string, start: string, end: string | null): string {
  const base = `${fmtDate(date)}, `;
  return timing === "appointment"
    ? `${base}${fmtTime(start)} ET (appointment)`
    : `${base}${fmtTime(start)} to ${fmtTime(end)} ET (window)`;
}

// Eastern wall-clock "YYYY-MM-DDTHH:mm" (datetime-local value) -> UTC ISO string
export function easternLocalToIso(local: string): string {
  const [datePart, timePart] = local.split("T");
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi] = timePart.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asEt = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  const offset = guess - asEt;
  return new Date(guess + offset).toISOString();
}

// UTC ISO -> Eastern "YYYY-MM-DDTHH:mm" for datetime-local
export function isoToEasternLocal(iso: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function todayEastern(): string {
  return isoToEasternLocal(new Date().toISOString()).slice(0, 10);
}

export function telHref(phone: string): string {
  return "tel:" + phone.replace(/[^+\d]/g, "");
}
