// Proves migration 0008 under real concurrency: two separate database sessions try to deactivate
// the last two active staff admins at the same moment. Exactly one may succeed.
// LOCAL ONLY: refuses unless the parsed host is exactly 127.0.0.1 or localhost.
//   node scripts/test-last-admin-race.mjs            (uses the local Supabase default URL)
//   LOCAL_DATABASE_URL=postgresql://... node scripts/test-last-admin-race.mjs
// It creates two temporary admins, parks any other active admin while it runs, and restores everything.
import pg from "pg";
import { assertLocal } from "./lib/local-guard.mjs";

const URL_ = process.env.LOCAL_DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
assertLocal("database url", URL_);

const T1 = "00000000-0000-0000-0000-00000000ac01";
const T2 = "00000000-0000-0000-0000-00000000ac02";
const ROUNDS = 25;

const connect = async () => {
  const c = new pg.Client({ connectionString: URL_ });
  await c.connect();
  return c;
};

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " (" + detail + ")" : ""}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deactivate = (c, id) => c.query("update public.profiles set is_active = false where id = $1", [id]);

const admin = await connect();
let parked = [];
try {
  const trg = await admin.query(
    "select count(*)::int n from pg_trigger where tgrelid = 'public.profiles'::regclass and not tgisinternal and tgname = 'profiles_last_admin_guard_update'");
  check("guard trigger exists", trg.rows[0].n === 1);

  // Setup: two temporary admins, every other active admin parked (inactive) for the run.
  await admin.query(
    "insert into auth.users (id, aud, role, email) values ($1,'authenticated','authenticated','race1@race.test'),($2,'authenticated','authenticated','race2@race.test') on conflict do nothing",
    [T1, T2]);
  await admin.query(
    "insert into public.profiles (id, email, role, is_active) values ($1,'race1@race.test','staff_admin',true),($2,'race2@race.test','staff_admin',true) on conflict (id) do update set role='staff_admin', is_active=true",
    [T1, T2]);
  parked = (await admin.query("select id from public.profiles where role = 'staff_admin' and is_active and id not in ($1,$2)", [T1, T2])).rows.map((r) => r.id);
  if (parked.length) await admin.query("update public.profiles set is_active = false where id = any($1::uuid[])", [parked]);
  const act = async () => (await admin.query("select count(*)::int n from public.profiles where role='staff_admin' and is_active")).rows[0].n;
  check("setup: exactly two active admins", (await act()) === 2);

  // 1. Deterministic: session A holds its uncommitted deactivation, session B must BLOCK, then be refused.
  {
    const a = await connect();
    const b = await connect();
    await a.query("begin");
    await deactivate(a, T1); // A passes (T2 is still active) and holds the lock until commit
    await b.query("begin");
    const bp = deactivate(b, T2).then(() => ({ ok: true }), (e) => ({ ok: false, code: e.code, msg: e.message }));
    let blocked = false;
    for (let i = 0; i < 30 && !blocked; i++) {
      await sleep(100);
      const w = await admin.query("select count(*)::int n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database() and query ilike 'update public.profiles%'");
      blocked = w.rows[0].n > 0;
    }
    check("session B blocks while session A holds an uncommitted last-admin change", blocked);
    await a.query("commit");
    const res = await Promise.race([bp, sleep(5000).then(() => ({ timeout: true }))]);
    check("session B is refused after A commits (23514)", res.ok === false && res.code === "23514", res.msg || (res.timeout ? "timeout" : "B succeeded"));
    await b.query("rollback");
    check("exactly one active admin remains", (await act()) === 1);
    await a.end();
    await b.end();
    await admin.query("update public.profiles set is_active = true where id in ($1,$2)", [T1, T2]);
  }

  // 2. Stress: both sessions fire at once, many rounds. Never zero admins, never two successes.
  {
    const a = await connect();
    const b = await connect();
    let zero = 0, both = 0, one = 0;
    const attempt = async (c, id, delay) => {
      await sleep(delay);
      try {
        await c.query("begin");
        await deactivate(c, id);
        await c.query("commit");
        return true;
      } catch {
        await c.query("rollback").catch(() => {});
        return false;
      }
    };
    for (let i = 0; i < ROUNDS; i++) {
      await admin.query("update public.profiles set is_active = true where id in ($1,$2)", [T1, T2]);
      const r = await Promise.all([attempt(a, T1, 0), attempt(b, T2, Math.floor(Math.random() * 15))]);
      const n = await act();
      if (n === 0) zero += 1;
      else if (n === 1) one += 1;
      else both += 1;
      if (r[0] && r[1]) both += 100; // both reported success: impossible when the guard works
    }
    check(`stress ${ROUNDS} rounds: never zero active admins`, zero === 0, `zero=${zero}`);
    check(`stress ${ROUNDS} rounds: exactly one admin left every round`, one === ROUNDS, `one=${one} two=${both}`);
    await a.end();
    await b.end();
  }
} finally {
  // Restore: reactivate parked admins first, then remove the temporary ones (guard disabled for the cleanup only).
  try {
    if (parked.length) await admin.query("update public.profiles set is_active = true where id = any($1::uuid[])", [parked]);
    const has = (await admin.query("select count(*)::int n from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname = 'profiles_last_admin_guard_delete'")).rows[0].n === 1;
    await admin.query("begin");
    if (has) await admin.query("alter table public.profiles disable trigger profiles_last_admin_guard_delete");
    await admin.query("delete from public.profiles where id in ($1,$2)", [T1, T2]);
    if (has) await admin.query("alter table public.profiles enable trigger profiles_last_admin_guard_delete");
    await admin.query("commit");
    await admin.query("delete from auth.users where id in ($1,$2)", [T1, T2]);
    const left = (await admin.query("select count(*)::int n from public.profiles where id in ($1,$2)", [T1, T2])).rows[0].n;
    check("cleanup: temporary admins removed, parked admins restored", left === 0);
  } catch (e) {
    check("cleanup", false, e.message);
  }
  await admin.end();
}
console.log(failures === 0 ? "RACE_OK" : `RACE_FAIL ${failures}`);
process.exit(failures === 0 ? 0 : 1);
