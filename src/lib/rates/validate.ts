// Rate request rules (DLV-030, R40). Pure, no Next imports and relative imports only, so the e2e specs can load this
// file directly. Shared by the browser form and the server actions; the database repeats every limit as a CHECK.

export const RATE_SIZES = [26, 36, 53] as const;
export const MAX_RATE_REQUESTS_PER_WINDOW = 30; // per customer user (default, see docs/QUESTIONS.md)
export const RATE_WINDOW_MINUTES = 10;

export const CITY_MAX = 80;
export const DIMS_MAX = 200;
export const NOTES_MAX = 1000;
export const WEIGHT_MAX = 100000;

// US states, DC and the Canadian provinces and territories (same list as the CHECK in migration 0017).
export const STATE_CODES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD",
  "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT",
] as const;

export type RateFields = "pickup_city" | "pickup_state" | "delivery_city" | "delivery_state" | "equipment_size" | "weight_lbs" | "dims" | "notes";
export type RateFormValues = Record<RateFields, string>;
export type RateFieldErrors = Partial<Record<RateFields, string>>;

export const EMPTY_RATE_FORM: RateFormValues = {
  pickup_city: "", pickup_state: "", delivery_city: "", delivery_state: "", equipment_size: "", weight_lbs: "", dims: "", notes: "",
};

const CONTROL = /[\u0000-\u001f\u007f]/;       // a single line field may not carry any control character
const CONTROL_NOT_NL = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/; // notes may carry line breaks (\n, \r)

export function formValuesFrom(fd: FormData): RateFormValues {
  const out = { ...EMPTY_RATE_FORM };
  for (const k of Object.keys(out) as RateFields[]) {
    const v = fd.get(k);
    out[k] = typeof v === "string" ? v : "";
  }
  return out;
}

export type CleanRate = {
  pickup_city: string; pickup_state: string; delivery_city: string; delivery_state: string;
  equipment_size: number; weight_lbs: number | null; dims: string | null; notes: string | null;
};

// Returns either field errors or the cleaned row (trimmed text, upper case state, numbers).
export function validateRateRequest(v: RateFormValues): { errors: RateFieldErrors } | { clean: CleanRate } {
  const e: RateFieldErrors = {};
  const s = (k: RateFields) => (typeof v?.[k] === "string" ? v[k] : "");
  const city = (key: "pickup_city" | "delivery_city", label: string) => {
    const t = s(key).trim();
    if (!t) e[key] = `${label} city is required.`;
    else if (t.length > CITY_MAX) e[key] = `${label} city is too long (at most ${CITY_MAX} characters).`;
    else if (CONTROL.test(t)) e[key] = `${label} city has a character that is not allowed.`;
    return t;
  };
  const state = (key: "pickup_state" | "delivery_state", label: string) => {
    const t = s(key).trim().toUpperCase();
    if (!t) e[key] = `${label} state or province is required.`;
    else if (!(STATE_CODES as readonly string[]).includes(t)) e[key] = `${label} state or province must be a two letter US state or Canadian province code, like ON or NY.`;
    return t;
  };
  const pickup_city = city("pickup_city", "Pickup");
  const pickup_state = state("pickup_state", "Pickup");
  const delivery_city = city("delivery_city", "Delivery");
  const delivery_state = state("delivery_state", "Delivery");

  const sizeText = s("equipment_size").trim();
  if (!(RATE_SIZES as readonly number[]).map(String).includes(sizeText)) e.equipment_size = "Choose an equipment size (26, 36 or 53 ft).";

  let weight: number | null = null;
  const w = s("weight_lbs").trim();
  if (w) {
    if (!/^\d{1,7}$/.test(w) || Number(w) < 1 || Number(w) > WEIGHT_MAX) e.weight_lbs = `Weight must be a whole number of pounds from 1 to ${WEIGHT_MAX}.`;
    else weight = Number(w);
  }

  const dims = s("dims").trim();
  if (dims.length > DIMS_MAX) e.dims = `Dimensions are too long (at most ${DIMS_MAX} characters).`;
  else if (CONTROL.test(dims)) e.dims = "Dimensions have a character that is not allowed.";

  const notes = s("notes").trim();
  if (notes.length > NOTES_MAX) e.notes = `Notes are too long (at most ${NOTES_MAX} characters).`;
  else if (CONTROL_NOT_NL.test(notes)) e.notes = "Notes have a character that is not allowed.";

  if (Object.keys(e).length > 0) return { errors: e };
  return {
    clean: {
      pickup_city, pickup_state, delivery_city, delivery_state,
      equipment_size: Number(sizeText), weight_lbs: weight, dims: dims || null, notes: notes || null,
    },
  };
}

// True when creating one more request would pass the cap for the recent window.
export function exceedsRateCap(recent: number, cap: number = MAX_RATE_REQUESTS_PER_WINDOW): boolean {
  return recent + 1 > cap;
}

// "Toronto, ON to Buffalo, NY, 53 ft"
export function rateLane(r: { pickup_city: string; pickup_state: string; delivery_city: string; delivery_state: string; equipment_size: number }): string {
  return `${r.pickup_city}, ${r.pickup_state} to ${r.delivery_city}, ${r.delivery_state}, ${r.equipment_size} ft`;
}

export const CURRENCIES = ["CAD", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

export type QuoteInput = { amount: string; currency: string; notes: string; validUntil: string };
export type QuoteFieldErrors = Partial<Record<"amount" | "currency" | "notes" | "valid_until", string>>;

// Staff entry. Amount: digits with at most two decimals, greater than 0, below 100,000,000.
export function validateQuote(q: QuoteInput, today: string): { errors: QuoteFieldErrors } | { clean: { amount: number; currency: Currency; notes: string | null; validUntil: string | null } } {
  const e: QuoteFieldErrors = {};
  const amountText = (typeof q.amount === "string" ? q.amount : "").trim().replace(/,/g, "");
  let amount = 0;
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(amountText) || Number(amountText) <= 0) e.amount = "Enter the rate as a number greater than 0, with at most two decimals (for example 1850 or 1850.50).";
  else amount = Number(amountText);
  const currency = typeof q.currency === "string" ? q.currency : "";
  if (!(CURRENCIES as readonly string[]).includes(currency)) e.currency = "Choose CAD or USD.";
  const notes = (typeof q.notes === "string" ? q.notes : "").trim();
  if (notes.length > NOTES_MAX) e.notes = `Notes are too long (at most ${NOTES_MAX} characters).`;
  else if (CONTROL_NOT_NL.test(notes)) e.notes = "Notes have a character that is not allowed.";
  const vu = (typeof q.validUntil === "string" ? q.validUntil : "").trim();
  if (vu) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(vu) ? new Date(`${vu}T00:00:00Z`) : null;
    if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== vu) e.valid_until = "Enter a valid date.";
    else if (vu < today) e.valid_until = "Valid until cannot be in the past.";
  }
  if (Object.keys(e).length > 0) return { errors: e };
  return { clean: { amount, currency: currency as Currency, notes: notes || null, validUntil: vu || null } };
}

export function fmtMoney(amount: number | string, currency: string): string {
  const n = Number(amount);
  return `${n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

export type RateRequest = {
  id: string; ref: string; customer_id: string; requested_by: string;
  pickup_city: string; pickup_state: string; delivery_city: string; delivery_state: string;
  equipment_size: number; weight_lbs: number | null; dims: string | null; notes: string | null;
  status: "open" | "quoted" | "cancelled";
  quoted_amount: number | string | null; quoted_currency: string | null; quote_notes: string | null;
  quote_valid_until: string | null; quoted_by: string | null; quoted_at: string | null;
  created_at: string; updated_at: string;
};

export const RATE_STATUS_LABEL: Record<RateRequest["status"], string> = {
  open: "Waiting for rate", quoted: "Rate ready", cancelled: "Cancelled",
};
