// A location often has the same text as its name and its street ("481 University Ave"). Printing both gives
// "481 University Ave, 481 University Ave, Toronto". These helpers print the shared text once.

type Named = { name: string; address_line: string };
type Full = Named & { city: string; province: string; postal_code: string | null };

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// True when the name and the street line are the same text (case and whitespace insensitive).
export function nameIsStreet(l: Named): boolean {
  return norm(l.name) === norm(l.address_line);
}

// "Name, street, City, ON A1A 1A1", with the name left out when it equals the street.
export function addressWithName(l: Full): string {
  const tail = `${l.city}, ${l.province}${l.postal_code ? " " + l.postal_code : ""}`;
  return nameIsStreet(l) ? `${l.address_line}, ${tail}` : `${l.name}, ${l.address_line}, ${tail}`;
}
