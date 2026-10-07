import { execFileSync, spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { adminClient, isoDate, uniq } from "./support/helpers";
import { DB_URL, localEnv } from "./support/env";
import { assertLocalUrl } from "./support/guard";

// R5 customer Mitrex, R7 scripts/seed-users.mjs, R9 the 19 seeded locations. Node level (no browser).
// Everything runs against the local stack only. The refusal cases pass a fake non-local URL to the
// script as an argument of the CHILD process: the script exits before it creates any client, so that
// host is never contacted.

type Row = {
  name: string; address_line: string; city: string; province: string; postal_code: string | null;
  can_ship: boolean; can_receive: boolean; requires_moffett: boolean; needs_review: boolean;
};

// The full seed table, written out independently of supabase/seed.sql.
const L = (
  name: string, address_line: string, city: string, postal_code: string | null,
  can_ship: boolean, can_receive: boolean, requires_moffett = false, needs_review = false,
): Row => ({ name, address_line, city, province: "ON", postal_code, can_ship, can_receive, requires_moffett, needs_review });

const EXPECTED: Row[] = [
  L("Mitrex", "41 Racine Rd", "Toronto", "M9W 2Z4", true, true),
  L("481 University Ave", "481 University Ave", "Toronto", "M5G 1W2", true, true),
  L("125G", "125 George St", "Toronto", "M5A 2N4", true, true),
  L("Sherbourne", "591 Sherbourne St", "Toronto", "M4X 1W7", true, true),
  L("SAMIH", "840 Military Trail", "Scarborough", "M1C 0C7", true, true, true),
  L("Howden", "38 Howden Rd", "Scarborough", "M1R 3E9", true, true),
  L("D Express Transport", "30 Bethridge Rd", "Etobicoke", "M9W 1N1", true, true),
  L("Scion Powder Coatings Inc", "120 Woodbine Downs Blvd", "Toronto", null, true, false, false, true),
  L("MTD MetroTool & Die Limited", "1065 Pantera Dr", "Mississauga", "L4W 2X4", true, false),
  L("Valley Metal Finishing Ltd", "211 Snidercroft Rd", "Concord", "L4K 2J9", true, false),
  L("QuickScrap Metal", "407 Rexdale Blvd", "Etobicoke", "M9W 6P8", false, true),
  L("Spadina", "315 Spadina Ave", "Toronto", "M5T 2E9", false, true),
  L("Military Trailsite", "1050 Military Trail", "Scarborough", "M1C 1G9", false, true, true),
  L("1HAM", "1 Hamilton St S", "Hamilton", "L8B 1A6", false, true, true),
  L("831 Queen", "831 Queenston Rd", "Hamilton", "L8G 1B2", false, true, true),
  L("152 Sh", "152 Shanley St", "Kitchener", "N2H 5P5", false, true, true),
  L("Kitney site", "25 Kitney Dr", "Ajax", "L1S 0G6", false, true, true),
  L("PrimeFab", "111 Pilsbury Drive", "Midland", "L4R 0A3", false, true, true),
  L("Glengarry", "94 Wright Crescent", "Kingston", "K7L 5M3", false, true, true),
];

const COLS = "id,name,address_line,city,province,postal_code,can_ship,can_receive,requires_moffett,needs_review,is_active";

async function seededRows() {
  const { data, error } = await adminClient().from("locations").select(COLS).in("name", EXPECTED.map((r) => r.name));
  expect(error).toBeNull();
  return data ?? [];
}

test("the seed table has 19 rows, and the expectation here has 19 distinct names", () => {
  expect(EXPECTED).toHaveLength(19);
  expect(new Set(EXPECTED.map((r) => r.name)).size).toBe(19);
});

test("public.locations holds exactly the 19 seeded rows with the right flags", async () => {
  const rows = await seededRows();
  // Exactly one row per seeded name (no duplicates, none missing).
  expect(rows).toHaveLength(19);
  const byName = new Map(rows.map((r) => [r.name as string, r]));
  expect(byName.size).toBe(19);
  for (const want of EXPECTED) {
    const got = byName.get(want.name);
    expect(got, want.name).toBeTruthy();
    expect({ ...got, id: undefined, is_active: undefined }, want.name).toEqual({ ...want, id: undefined, is_active: undefined });
    expect(got!.is_active, `${want.name} is active`).toBe(true);
  }
  // The named business rules, asserted on their own so a changed table row cannot hide them.
  expect(byName.get("SAMIH")).toMatchObject({ requires_moffett: true, can_ship: true, can_receive: true });
  expect(byName.get("Scion Powder Coatings Inc")).toMatchObject({ needs_review: true, postal_code: null, can_ship: true, can_receive: false });
  expect(byName.get("QuickScrap Metal")).toMatchObject({ can_ship: false, can_receive: true });
  // DLV-028: SAMIH plus the seven sites the owner marked Y in the lane table (1HAM, 152 Sh, 831 Queen, Glengarry,
  // Kitney site, Military Trailsite, PrimeFab) require a Moffett.
  expect(rows.filter((r) => r.requires_moffett).map((r) => r.name).sort()).toEqual(
    ["1HAM", "152 Sh", "831 Queen", "Glengarry", "Kitney site", "Military Trailsite", "PrimeFab", "SAMIH"].sort());
  expect(rows.filter((r) => r.needs_review).map((r) => r.name)).toEqual(["Scion Powder Coatings Inc"]);
  expect(rows.filter((r) => r.can_ship && !r.can_receive)).toHaveLength(3);
  expect(rows.filter((r) => !r.can_ship && r.can_receive)).toHaveLength(9);
  expect(rows.filter((r) => r.can_ship && r.can_receive)).toHaveLength(7);
  expect(rows.filter((r) => !r.postal_code).map((r) => r.name)).toEqual(["Scion Powder Coatings Inc"]);
});

test("customer Mitrex exists exactly once", async () => {
  const { data, error } = await adminClient().from("customers").select("id,name").eq("name", "Mitrex");
  expect(error).toBeNull();
  expect(data).toHaveLength(1);
});

test("supabase/seed.sql is idempotent: applying it again changes no row id and adds no row", async () => {
  assertLocalUrl(DB_URL, "db url");
  const before = await seededRows();
  const customersBefore = (await adminClient().from("customers").select("id").eq("name", "Mitrex")).data;
  const r = spawnSync("psql", [DB_URL, "-v", "ON_ERROR_STOP=1", "-q", "-f", "supabase/seed.sql"], { encoding: "utf8" });
  expect(r.status, `psql failed: ${(r.stderr ?? "").slice(0, 200)}`).toBe(0);
  const after = await seededRows();
  const key = (rows: typeof before) => rows.map((x) => `${x.id}|${x.name}`).sort();
  expect(after).toHaveLength(19);
  expect(key(after)).toEqual(key(before));
  expect((await adminClient().from("customers").select("id").eq("name", "Mitrex")).data).toEqual(customersBefore);
});

// R8 measured on the live local database: every public table has RLS on, and anon and PUBLIC hold no table privilege.
test("every public table has row level security on and anon holds no table privilege", async () => {
  assertLocalUrl(DB_URL, "db url");
  const q = (sql: string) => {
    const r = spawnSync("psql", [DB_URL, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" });
    expect(r.status, `psql failed: ${(r.stderr ?? "").slice(0, 200)}`).toBe(0);
    return r.stdout.trim().split("\n").filter(Boolean);
  };
  const tables = q("select c.relname || '|' || c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p') order by 1");
  // The eight tables of the schema are all there (so the check below is not vacuous) and every one has RLS on.
  expect(tables.map((t) => t.split("|")[0])).toEqual(expect.arrayContaining([
    "carriers", "customers", "load_documents", "load_events", "loads", "location_requests", "locations", "profiles",
  ]));
  expect(tables.filter((t) => !t.endsWith("|true"))).toEqual([]);
  expect(q("select grantee || ' ' || table_name || ' ' || privilege_type from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'PUBLIC')")).toEqual([]);
  // Control: authenticated is granted narrowly (some privileges, so the query above can find grants at all).
  expect(q("select count(*) from information_schema.role_table_grants where table_schema = 'public' and grantee = 'authenticated'")[0]).not.toBe("0");
});

// R11 measured on the live local database: the columns exist and every constraint refuses its bad row.
test("loads carry the specified columns, MTX numbering and constraints; each bad row is refused and a valid one accepted", async () => {
  const db = adminClient();
  assertLocalUrl(DB_URL, "db url");
  const r = spawnSync("psql", [DB_URL, "-At", "-v", "ON_ERROR_STOP=1", "-c",
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'loads'"], { encoding: "utf8" });
  expect(r.status).toBe(0);
  const have = r.stdout.split("\n").filter(Boolean);
  for (const c of [
    "load_number", "customer_id", "equipment_size", "moffett", "weight_lbs", "pieces", "po_number", "notes",
    "pickup_timing", "pickup_date", "pickup_time_start", "pickup_time_end",
    "delivery_timing", "delivery_date", "delivery_time_start", "delivery_time_end",
    "pickup_contact_name", "pickup_contact_phone", "delivery_contact_name", "delivery_contact_phone",
    "status", "carrier_id", "eta", "booked_at", "delivered_at", "cancelled_at", "created_at", "updated_at",
  ]) expect(have, c).toContain(c);

  const [{ data: cust }, { data: maria }, { data: pu }, { data: de }] = await Promise.all([
    db.from("customers").select("id").eq("name", "Mitrex").single(),
    db.from("profiles").select("id").eq("email", "maria@e2e.test").single(),
    db.from("locations").select("id").eq("name", "Mitrex").single(),
    db.from("locations").select("id").eq("name", "Howden").single(),
  ]);
  const po = uniq("R11");
  const day = isoDate(5);
  const good = {
    customer_id: cust!.id, created_by: maria!.id, pickup_location_id: pu!.id, delivery_location_id: de!.id,
    equipment_size: 53, pickup_timing: "appointment", pickup_date: day, pickup_time_start: "08:00",
    delivery_timing: "window", delivery_date: day, delivery_time_start: "13:00", delivery_time_end: "16:00",
    pickup_contact_name: "Pat", pickup_contact_phone: "416-555-0101",
    delivery_contact_name: "Dee", delivery_contact_phone: "416-555-0102", po_number: po,
  };
  const bad: [string, Record<string, unknown>][] = [
    ["equipment 30", { equipment_size: 30 }],
    ["equipment 48 (removed size)", { equipment_size: 48 }],
    ["weight 0", { weight_lbs: 0 }],
    ["pieces 0", { pieces: 0 }],
    ["appointment with an end time", { pickup_time_end: "09:00" }],
    ["window without an end time", { delivery_time_end: null }],
    ["window ending before it starts", { delivery_time_end: "12:00" }],
    ["unknown timing", { pickup_timing: "whenever" }],
    ["same pickup and delivery location", { delivery_location_id: pu!.id }],
    ["delivery before pickup", { delivery_date: isoDate(4) }],
    ["blank contact name", { pickup_contact_name: "   " }],
    ["unknown status", { status: "teleported" }],
  ];
  for (const [label, patch] of bad) {
    const res = await db.from("loads").insert({ ...good, ...patch, po_number: `${po}-${label}` }).select("id");
    expect(res.error, `${label} must be refused`).not.toBeNull();
  }
  expect((await db.from("loads").select("id").like("po_number", `${po}-%`)).data).toEqual([]);

  // Control: the same row without any defect is accepted, gets an MTX number, and keeps its contact snapshot and timing.
  const ok = await db.from("loads").insert(good).select("id,load_number,status,delivery_timing,delivery_time_end,pickup_contact_name,delivery_contact_phone").single();
  expect(ok.error).toBeNull();
  expect(ok.data!.load_number).toMatch(/^MTX-\d{4,}$/);
  expect(ok.data).toMatchObject({
    status: "requested", delivery_timing: "window", delivery_time_end: "16:00:00",
    pickup_contact_name: "Pat", delivery_contact_phone: "416-555-0102",
  });
  await db.from("loads").update({ status: "cancelled" }).eq("id", ok.data!.id);
});

// ---- scripts/seed-users.mjs -------------------------------------------------------------------

function seedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  // An explicit environment: nothing from the caller's shell (production variables included) is inherited.
  const e = localEnv();
  return {
    PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
    NEXT_PUBLIC_SUPABASE_URL: e.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: e.SUPABASE_SERVICE_ROLE_KEY,
    ...extra,
  } as unknown as NodeJS.ProcessEnv;
}

async function authEmails(prefix: string): Promise<string[]> {
  const db = adminClient();
  const out: string[] = [];
  for (let page = 1; page < 100; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    for (const u of data.users) if ((u.email ?? "").includes(prefix)) out.push(u.email!);
    if (data.users.length < 200) break;
  }
  return out.sort();
}

test("seed-users.mjs run twice creates exactly 5 users and 2 carriers once", async () => {
  const tag = uniq("seed").toLowerCase();
  const names = { a: `Seed Carrier A ${tag}`, b: `Seed Carrier B ${tag}` };
  const emails = {
    admin: `admin-${tag}@seed.test`, csr: `csr-${tag}@seed.test`, maria: `maria-${tag}@seed.test`,
    ownerA: `owner-a-${tag}@seed.test`, ownerB: `owner-b-${tag}@seed.test`,
  };
  const env = seedEnv({
    SEED_ADMIN_EMAIL: emails.admin, SEED_CSR_EMAIL: emails.csr, SEED_MARIA_EMAIL: emails.maria,
    SEED_CARRIER_A_NAME: names.a, SEED_CARRIER_A_EMAIL: emails.ownerA,
    SEED_CARRIER_B_NAME: names.b, SEED_CARRIER_B_EMAIL: emails.ownerB,
  });
  const db = adminClient();
  try {
    expect(await authEmails(tag)).toEqual([]);
    const first = execFileSync("node", ["scripts/seed-users.mjs"], { env, encoding: "utf8" });
    expect(first).toContain("Target: local");
    expect(first).toContain("SEED_USERS_DONE");
    const second = execFileSync("node", ["scripts/seed-users.mjs"], { env, encoding: "utf8" });
    expect(second).toContain("SEED_USERS_DONE");

    // Exactly 5 auth users, one per address (not 10 after two runs).
    expect(await authEmails(tag)).toEqual(Object.values(emails).sort());
    const profiles = await db.from("profiles").select("id,email,role,customer_id,carrier_id,is_active").like("email", `%${tag}%`);
    expect(profiles.error).toBeNull();
    expect(profiles.data).toHaveLength(5);
    const roleOf = Object.fromEntries((profiles.data ?? []).map((p) => [p.email, p]));
    const mitrex = (await db.from("customers").select("id").eq("name", "Mitrex").single()).data!.id;
    const carriers = await db.from("carriers").select("id,name").in("name", [names.a, names.b]);
    expect(carriers.data).toHaveLength(2); // two runs, still one row per carrier name
    const idOf = Object.fromEntries((carriers.data ?? []).map((c) => [c.name, c.id]));

    expect(roleOf[emails.admin]).toMatchObject({ role: "staff_admin", customer_id: null, carrier_id: null, is_active: true });
    expect(roleOf[emails.csr]).toMatchObject({ role: "staff_csr", customer_id: null, carrier_id: null, is_active: true });
    expect(roleOf[emails.maria]).toMatchObject({ role: "customer", customer_id: mitrex, carrier_id: null, is_active: true });
    expect(roleOf[emails.ownerA]).toMatchObject({ role: "carrier_owner", customer_id: null, carrier_id: idOf[names.a], is_active: true });
    expect(roleOf[emails.ownerB]).toMatchObject({ role: "carrier_owner", customer_id: null, carrier_id: idOf[names.b], is_active: true });
    expect(idOf[names.a]).not.toBe(idOf[names.b]);

    // A third run with an upper case address does not duplicate the user either.
    const third = execFileSync("node", ["scripts/seed-users.mjs"], {
      env: { ...env, SEED_CSR_EMAIL: emails.csr.toUpperCase() }, encoding: "utf8",
    });
    expect(third).toContain("SEED_USERS_DONE");
    expect(await authEmails(tag)).toEqual(Object.values(emails).sort());
  } finally {
    // Remove what this test made (profiles go with the auth users), so no extra staff accumulate.
    const found = await db.from("profiles").select("id").like("email", `%${tag}%`);
    for (const p of found.data ?? []) await db.auth.admin.deleteUser(p.id as string);
    await db.from("carriers").delete().in("name", [names.a, names.b]);
  }
});

test("seed-users.mjs refuses a non-local target without --i-know-this-is-production, and creates nothing", async () => {
  const tag = uniq("refuse").toLowerCase();
  const before = await authEmails("@seed.test");
  const base = {
    SEED_ADMIN_EMAIL: `admin-${tag}@seed.test`, SEED_CSR_EMAIL: `csr-${tag}@seed.test`, SEED_MARIA_EMAIL: `maria-${tag}@seed.test`,
    SEED_CARRIER_A_NAME: `Refused A ${tag}`, SEED_CARRIER_A_EMAIL: `owner-a-${tag}@seed.test`,
    SEED_CARRIER_B_NAME: `Refused B ${tag}`, SEED_CARRIER_B_EMAIL: `owner-b-${tag}@seed.test`,
  };
  // Hosts that look local to a careless check but are not. None of them is ever contacted.
  const fakes = [
    "https://refusal-check.supabase.invalid",
    "http://127.0.0.1.refusal-check.invalid",
    "http://localhost@refusal-check.invalid",
    "http://localhost.refusal-check.invalid:54321",
  ];
  for (const fake of fakes) {
    const r = spawnSync("node", ["scripts/seed-users.mjs"], {
      env: { ...seedEnv(base), NEXT_PUBLIC_SUPABASE_URL: fake }, encoding: "utf8",
    });
    expect(r.status, fake).toBe(1);
    expect(r.stderr, fake).toContain("Target is not local. Re-run with --i-know-this-is-production to seed a real project.");
    expect(r.stdout, fake).not.toContain("SEED_USERS_DONE");
    expect(r.stdout, fake).not.toContain("ok ");
  }
  expect(await authEmails(tag)).toEqual([]);
  expect(await authEmails("@seed.test")).toEqual(before);
  const carriers = await adminClient().from("carriers").select("id").like("name", `%${tag}%`);
  expect(carriers.data).toEqual([]);
});

test("seed-users.mjs names every missing env variable and exits 1 before touching anything", async () => {
  const r = spawnSync("node", ["scripts/seed-users.mjs"], { env: seedEnv({}), encoding: "utf8" });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("Missing env names:");
  for (const name of ["SEED_ADMIN_EMAIL", "SEED_CSR_EMAIL", "SEED_MARIA_EMAIL", "SEED_CARRIER_A_NAME", "SEED_CARRIER_B_EMAIL"]) {
    expect(r.stderr).toContain(name);
  }
});
