// DLV-043 CUST-06: Maria never reads a raw database sentence. A location rule the database refused (a location turned
// off or changed meanwhile) gets one plain line, a return rule (the original load changed meanwhile) another; anything
// else the generic one. Kept out of the "use server" module, which may export async functions only.
export const GENERIC = "Something went wrong. Please try again.";
export const LOCATION_GONE = "One of the locations is no longer available. Choose another.";
export const RETURN_GONE = "A return can no longer be booked for this load. Reload the page, or contact DLV.";

export function plainDbError(message: string | undefined): string {
  const m = message ?? "";
  if (/location cannot (ship|receive)/i.test(m)) return LOCATION_GONE;
  if (/^return load:/i.test(m)) return RETURN_GONE;
  return GENERIC;
}
