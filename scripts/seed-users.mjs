// Creates the invited users and carriers. Idempotent.
// Reads env NAMES only: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SEED_ADMIN_EMAIL, SEED_CSR_EMAIL, SEED_MARIA_EMAIL,
// SEED_CARRIER_A_NAME, SEED_CARRIER_A_EMAIL, SEED_CARRIER_B_NAME, SEED_CARRIER_B_EMAIL.
// Against a non-local project it refuses to run without the flag --i-know-this-is-production.
import { createClient } from "@supabase/supabase-js";

const need = [
  "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
  "SEED_ADMIN_EMAIL", "SEED_CSR_EMAIL", "SEED_MARIA_EMAIL",
  "SEED_CARRIER_A_NAME", "SEED_CARRIER_A_EMAIL", "SEED_CARRIER_B_NAME", "SEED_CARRIER_B_EMAIL",
];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("Missing env names: " + missing.join(", "));
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);
if (!local && !process.argv.includes("--i-know-this-is-production")) {
  console.error("Target is not local. Re-run with --i-know-this-is-production to seed a real project.");
  process.exit(1);
}
console.log(`Target: ${local ? "local" : new URL(url).host}`);

const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function findUserByEmail(email) {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => (u.email || "").toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function ensureUser(email) {
  const existing = await findUserByEmail(email);
  if (existing) return existing.id;
  const { data, error } = await admin.auth.admin.createUser({ email: email.toLowerCase(), email_confirm: true });
  if (error) throw error;
  return data.user.id;
}

async function ensureProfile(row) {
  const { error } = await admin.from("profiles").upsert(row, { onConflict: "id" });
  if (error) throw error;
}

async function ensureCarrier(name) {
  const { data: found, error: e1 } = await admin.from("carriers").select("id").eq("name", name).maybeSingle();
  if (e1) throw e1;
  if (found) return found.id;
  const { data, error } = await admin.from("carriers").insert({ name }).select("id").single();
  if (error) throw error;
  return data.id;
}

const { data: customer, error: cErr } = await admin.from("customers").select("id").eq("name", "Mitrex").single();
if (cErr) throw new Error("Customer Mitrex missing: apply supabase/seed.sql first (" + cErr.message + ")");

const e = process.env;
const plan = [
  { email: e.SEED_ADMIN_EMAIL, role: "staff_admin", full_name: "DLV Admin" },
  { email: e.SEED_CSR_EMAIL, role: "staff_csr", full_name: "DLV CSR" },
  { email: e.SEED_MARIA_EMAIL, role: "customer", full_name: "Maria", customer_id: customer.id },
];
for (const p of plan) {
  const id = await ensureUser(p.email);
  await ensureProfile({ id, email: p.email.toLowerCase(), full_name: p.full_name, role: p.role,
    customer_id: p.customer_id ?? null, carrier_id: null });
  console.log(`ok ${p.role}`);
}
for (const k of ["A", "B"]) {
  const carrierId = await ensureCarrier(e[`SEED_CARRIER_${k}_NAME`]);
  const email = e[`SEED_CARRIER_${k}_EMAIL`];
  const id = await ensureUser(email);
  await ensureProfile({ id, email: email.toLowerCase(), full_name: e[`SEED_CARRIER_${k}_NAME`] + " owner",
    role: "carrier_owner", customer_id: null, carrier_id: carrierId });
  console.log(`ok carrier ${k} + owner`);
}
console.log("SEED_USERS_DONE");
