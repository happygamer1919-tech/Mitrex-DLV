// R45 (DLV-041): the customer's location form. Shared by the add and the edit form; the server validates again with the
// same function before it writes, and the database (0021) repeats the name, notes and ship or receive rules.

export type CustomerLocationInput = {
  name: string; address_line: string; city: string; province: string; postal_code: string;
  can_ship: boolean; can_receive: boolean; requires_moffett: boolean;
  default_contact_name: string; default_contact_phone: string; notes: string;
};

export type CustomerLocationRow = {
  name: string; address_line: string; city: string; province: string; postal_code: string | null;
  can_ship: boolean; can_receive: boolean; requires_moffett: boolean;
  default_contact_name: string | null; default_contact_phone: string | null; notes: string | null;
};

export type LocationErrors = Partial<Record<keyof CustomerLocationInput, string>>;

export const LIMITS = {
  name: 120, address_line: 200, city: 80, postal_code: 10, default_contact_name: 120, default_contact_phone: 40, notes: 1000,
} as const;

export const DUPLICATE_NAME = "A location with this name already exists.";

export const EMPTY_LOCATION: CustomerLocationInput = {
  name: "", address_line: "", city: "", province: "ON", postal_code: "",
  can_ship: false, can_receive: true, requires_moffett: false,
  default_contact_name: "", default_contact_phone: "", notes: "",
};

const text = (v: unknown): string => (typeof v === "string" ? v : "");

// Untrusted input (a server action argument) to a clean value, then the rules. Returns the row to write or the errors.
export function validateCustomerLocation(raw: unknown):
  { ok: true; row: CustomerLocationRow } | { ok: false; errors: LocationErrors } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const v = {
    name: text(r.name).trim(),
    address_line: text(r.address_line).trim(),
    city: text(r.city).trim(),
    province: text(r.province).trim().toUpperCase(),
    postal_code: text(r.postal_code).trim().toUpperCase(),
    can_ship: r.can_ship === true,
    can_receive: r.can_receive === true,
    requires_moffett: r.requires_moffett === true,
    default_contact_name: text(r.default_contact_name).trim(),
    default_contact_phone: text(r.default_contact_phone).trim(),
    notes: text(r.notes).trim(),
  };
  const e: LocationErrors = {};
  if (!v.name) e.name = "Enter a location name.";
  else if (v.name.length > LIMITS.name) e.name = `Use at most ${LIMITS.name} characters for the name.`;
  if (!v.address_line) e.address_line = "Enter the street address.";
  else if (v.address_line.length > LIMITS.address_line) e.address_line = `Use at most ${LIMITS.address_line} characters for the street address.`;
  if (!v.city) e.city = "Enter the city.";
  else if (v.city.length > LIMITS.city) e.city = `Use at most ${LIMITS.city} characters for the city.`;
  if (!/^[A-Z]{2}$/.test(v.province)) e.province = "Enter the two letter province or state code, for example ON.";
  if (v.postal_code.length > LIMITS.postal_code) e.postal_code = `Use at most ${LIMITS.postal_code} characters for the postal code.`;
  if (!v.can_ship && !v.can_receive) e.can_ship = "Choose can ship, can receive, or both.";
  if (v.default_contact_name.length > LIMITS.default_contact_name) {
    e.default_contact_name = `Use at most ${LIMITS.default_contact_name} characters for the contact name.`;
  }
  if (v.default_contact_phone.length > LIMITS.default_contact_phone) {
    e.default_contact_phone = `Use at most ${LIMITS.default_contact_phone} characters for the contact phone.`;
  }
  if (v.notes.length > LIMITS.notes) e.notes = `Use at most ${LIMITS.notes} characters for the notes.`;
  if (Object.keys(e).length > 0) return { ok: false, errors: e };
  return {
    ok: true,
    row: {
      ...v,
      postal_code: v.postal_code || null,
      default_contact_name: v.default_contact_name || null,
      default_contact_phone: v.default_contact_phone || null,
      notes: v.notes || null,
    },
  };
}

// A saved location as the form's starting values.
export function locationToInput(l: {
  name: string; address_line: string; city: string; province: string; postal_code: string | null;
  can_ship: boolean; can_receive: boolean; requires_moffett: boolean;
  default_contact_name: string | null; default_contact_phone: string | null; notes: string | null;
}): CustomerLocationInput {
  return {
    name: l.name, address_line: l.address_line, city: l.city, province: l.province, postal_code: l.postal_code ?? "",
    can_ship: l.can_ship, can_receive: l.can_receive, requires_moffett: l.requires_moffett,
    default_contact_name: l.default_contact_name ?? "", default_contact_phone: l.default_contact_phone ?? "", notes: l.notes ?? "",
  };
}
