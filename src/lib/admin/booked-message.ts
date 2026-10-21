import { ITS_FORMAT, ITS_MAX_LENGTH } from "@/lib/load-number";

// The result line of "Mark booked" (DLV-043 STAFF-02). The booking form disappears once the load is booked, so the
// form sends staff to /admin/loads/<id>?saved=booked&its=<n>&c=<carrier users>&m=<customer users> and the page shows
// this line in its saved notice. The query is untrusted: anything malformed shows nothing.
export function bookedMessage(its: string, sent: number, told: number): string {
  const carrierMsg = sent > 0
    ? `Email sent to ${sent} carrier ${sent === 1 ? "user" : "users"}.`
    : "No carrier email was sent (the carrier has no users, or email is not configured).";
  const customerMsg = told > 0
    ? `Booking confirmation sent to ${told} customer ${told === 1 ? "user" : "users"}.`
    : "No customer email was sent.";
  return `Booked as ITS ${its}. ${carrierMsg} ${customerMsg}`;
}

const COUNT = /^[0-9]{1,3}$/;

export function bookedQuery(its: string, sent: number, told: number): string {
  return new URLSearchParams({ saved: "booked", its, c: String(sent), m: String(told) }).toString();
}

export function bookedMessageFromQuery(q: { its?: unknown; c?: unknown; m?: unknown }): string | null {
  const { its, c, m } = q;
  if (typeof its !== "string" || typeof c !== "string" || typeof m !== "string") return null;
  if (its.length > ITS_MAX_LENGTH || !ITS_FORMAT.test(its) || !COUNT.test(c) || !COUNT.test(m)) return null;
  return bookedMessage(its, Number(c), Number(m));
}
