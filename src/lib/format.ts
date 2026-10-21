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

// Eastern wall-clock "YYYY-MM-DDTHH:mm" (datetime-local value) -> UTC ISO string.
// Resolves the offset by trying the offsets in force a day either side, so wall times shortly after a
// DST change are not shifted by an hour. An ambiguous time (the repeated hour in autumn) resolves to its
// first occurrence (EDT). A time that does not exist (the skipped hour in spring) moves forward.
export function easternLocalToIso(local: string): string {
  const [datePart, timePart] = local.split("T");
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi] = timePart.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const offsetAt = (ms: number) => {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) - ms;
  };
  const DAY = 86_400_000;
  const before = offsetAt(guess - DAY);
  const candidates = [...new Set([before, offsetAt(guess + DAY)])]
    .map((o) => guess - o)
    .filter((t) => guess - t === offsetAt(t))
    .sort((a, b) => a - b);
  return new Date(candidates.length > 0 ? candidates[0] : guess - before).toISOString();
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

// DLV-043 CAR-04: phones are free text. Dial the FIRST number only: the text is cut at an extension word (ext, x, #)
// or a separator between two numbers (/ , ; or). An extension in digits follows after a pause (","), which phones
// dial once the call connects. The button keeps showing the full text.
const PHONE_CUT = /(extension|ext\.?|x|#|\/|,|;|\bor\b)/i;
const PHONE_EXT = /^\s*(?:extension|ext\.?|x|#)\s*(\d{1,6})\b/i;
export function telHref(phone: string): string {
  const raw = String(phone ?? "");
  const cut = raw.search(PHONE_CUT);
  const head = cut >= 0 ? raw.slice(0, cut) : raw;
  const main = head.replace(/[^+\d]/g, "").replace(/(?!^)\+/g, "");
  if (!main) return "tel:" + raw.replace(/[^+\d]/g, "");
  const ext = cut >= 0 ? PHONE_EXT.exec(raw.slice(cut))?.[1] : undefined;
  return "tel:" + main + (ext ? `,${ext}` : "");
}

// "Oct 4, 2026" for an ISO instant, as the Eastern calendar date.
export function fmtDateEt(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
}
