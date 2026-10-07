// ONE place that decides which number a person sees for a load (DLV-025).
// loads.its_load_number is the ITS load number (source of truth once staff enter it before booking).
// loads.load_number is the internal REQUEST REF (MTX-0005 style, generated when Maria requests the load).
export type LoadNumbers = { load_number: string; its_load_number?: string | null };

export const hasIts = (l: LoadNumbers): boolean => Boolean(l.its_load_number && l.its_load_number.trim());

export const requestRefLabel = (ref: string): string => `Request ${ref}`;

// The ITS number when set, otherwise the request ref. Carriers (booked loads only, legacy ones may lack an
// ITS number), the CSV load_number column, and any place that needs one plain value.
export function itsOrRef(l: LoadNumbers): string {
  return hasIts(l) ? (l.its_load_number as string) : l.load_number;
}

// One line of plain text for a staff screen or a staff email: "313" or "Request MTX-0005".
export function staffLabel(l: LoadNumbers): string {
  return hasIts(l) ? (l.its_load_number as string) : requestRefLabel(l.load_number);
}

// One line of plain text for a customer sentence ("Cancel 313?", "Copied from Request MTX-0005."). The customer
// headline for an unnumbered load is "Number pending" (see customerHeadline); in running text the request ref
// is the only handle that identifies the load, so the sentence uses it.
export function customerLabel(l: LoadNumbers): string {
  return hasIts(l) ? (l.its_load_number as string) : requestRefLabel(l.load_number);
}

export const NUMBER_PENDING = "Number pending";

export type Headline = { headline: string; pending: boolean; secondaryRef: string | null };

// Customer headline: the ITS number, or "Number pending" with the request ref as secondary text.
export function customerHeadline(l: LoadNumbers): Headline {
  return hasIts(l)
    ? { headline: l.its_load_number as string, pending: false, secondaryRef: null }
    : { headline: NUMBER_PENDING, pending: true, secondaryRef: l.load_number };
}

// Same shape for the number the ITS field accepts: digits, optionally a dash and digits (313 or 313-2).
export const ITS_FORMAT = /^[0-9]+(-[0-9]+)?$/;
export const ITS_FORMAT_MESSAGE = "The ITS load number must be digits, optionally with a dash and digits (for example 313 or 313-2).";

export function normaliseIts(raw: string): string {
  return raw.trim();
}

export function validateIts(raw: string): string | null {
  const v = normaliseIts(raw);
  if (!v) return "Enter the ITS load number.";
  if (!ITS_FORMAT.test(v)) return ITS_FORMAT_MESSAGE;
  return null;
}
