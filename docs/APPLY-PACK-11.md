# Apply pack 11: migration 0021 (customer locations) to production

For a SEPARATE, owner supervised production session. Nothing in this pack was run against production. It was
rehearsed against the local stack only (see "Rehearsal result"). Production must hold migrations 0001 to 0020 first
(packs 2 to 10; 0020 is pack 10, staff edit audit). Block A refuses to continue when 0020 is missing.

The file list in section 1 and the `files=( ... )` array at the top of block B are the only places that name
migrations; every count and "highest number" check is derived from that list (see "Extending this pack").

Rules for the session
- The owner runs every block. Do not paste a connection string, key or password anywhere. Blocks print counts and PASS or FAIL only.
- Run in a quiet window (no customer or staff actions). The post-check compares row counts and the content of every location with the pre-check, so live traffic between the two shows as a FAIL to investigate, not as a silent pass.
- Every block is zsh and runs inside a subshell `( ... )`, so a failure ends the block and never closes your terminal. Each block exits non-zero on failure and prints its own verdict. No block relies on `set -e`.
- Blocks keep state in `$DLV_APPLY_DIR` (default `~/dlv-apply-11`, mode 700). The state file holds counts, 0/1 flags and md5 sums, no secrets.
- 0021 adds three columns to `locations` (created_at, created_by, updated_by), two functions, one trigger and one policy, and replaces one function, one trigger and one policy. Existing locations get created_at = the apply time and no author; no business field of any location changes, and no load, user, event, document, lane, rate request or request is touched.

## 1. Migrations not yet in production (in order)

| File | What it does | Risk |
| --- | --- | --- |
| 0021_customer_locations.sql | Customer locations (DLV-041, R45). `locations` gets `created_at` (timestamptz not null default now()), `created_by` and `updated_by` (uuid, references profiles, ON DELETE SET NULL). New function `dlv_locations_before_insert()` (SECURITY DEFINER, search_path empty) and the BEFORE INSERT row trigger `locations_before_insert`: for a signed-in caller it stamps created_at, updated_at, created_by (the caller) and clears updated_by; for a customer it also forces is_active true and needs_review false. Replaced function `dlv_locations_before_update()` (now SECURITY DEFINER, search_path empty; trigger `locations_before_update` restated): a customer may change the eleven business fields of an active location and nothing else (42501); staff keep their rights, created_at and created_by keep their values and updated_by becomes the editor; carriers and inactive users are refused. New helper `dlv_location_customer_rules(locations)` (name not blank and at most 120, notes at most 1000, ship or receive). New policy `locations_customer_insert` (an active customer); replaced policy `locations_update` (staff, or an active customer on an active row). Functions: EXECUTE revoked from PUBLIC, anon and authenticated, granted to service_role only. | Low. Additive: three nullable or defaulted columns (a metadata change, no table rewrite), triggers that act only on future writes. Idempotent (ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF EXISTS, DROP POLICY IF EXISTS, grants restated by name). Rolling back means section 5. |

Visible effect: once the new app is deployed Maria can add a location and edit every detail of one on **Locations**; staff see "Added by" and "Last edited by". Without 0021 the new app's Add location is refused by the database and an edit of anything but the default contact is refused, so apply 0021 FIRST.

## 2. Order of operations: 0020 first, then 0021, then the app

Recommendation: apply 0020 (pack 10) and deploy DLV-039 first if that has not happened yet. Then apply 0021, then merge the DLV-041 PR and let it deploy.

Reasons
1. 0021 is backward compatible with the app that is live now: the live app lets Maria change only the default contact and files location requests; both keep working (a contact change is one of the business fields, and location_requests is untouched). Staff edits keep working and now also record who edited.
2. The new app NEEDS 0021: without it the database refuses Maria's new locations (insert is staff only before 0021) and her address edits (the old contact only guard).
3. If the migration fails, nothing user visible has changed and the app is untouched.

## 3. Pre-check (read only)

Session setup. Run this in the terminal you will use for every block below. It loads DATABASE_URL_DIRECT without printing it.

```
set -o allexport; source ~/.zshenvmitrex; set +o allexport
cd ~/Documents/Projects/GitHub/Mitrex-DLV && git fetch origin && git checkout feat/dlv-041-customer-locations
```

(If this branch was merged, `git checkout main && git pull` instead. The migration files must be exactly the ones listed above.)

Block A, pre-check. Read only: every statement runs with `default_transaction_read_only = on`, so it cannot change data even by mistake.

```zsh
# BLOCK precheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-11}"
  mkdir -p "$DIR" || exit 1
  chmod 700 "$DIR" || exit 1
  STATE="$DIR/state.env"
  : > "$STATE" || exit 1
  q() { { echo "set default_transaction_read_only = on;"; cat; } | psql "$DATABASE_URL_DIRECT" -X -A -t -q -v ON_ERROR_STOP=1 -f - ; }
  bad=0
  rec() { print -r -- "$1=$2" >> "$STATE"; print -r -- "  $1 = $2"; }
  need() { if [[ "$2" == "$3" ]]; then print -r -- "PASS $1"; else print -r -- "FAIL $1 (got $2, want $3)"; bad=1; fi; }

  echo "--- connection"
  v=$(q <<'SQL'
select current_database() || ' / server ' || current_setting('server_version') || ' / read_only=' || current_setting('default_transaction_read_only');
SQL
  ) || { echo "FAIL: cannot connect"; exit 1; }
  echo "  $v"

  echo "--- row counts (before)"
  for t in loads profiles load_events load_documents locations customers carriers location_requests load_deletions lane_references rate_requests; do
    v=$(q <<SQL
select count(*) from public.$t;
SQL
    ) || { echo "FAIL: count $t"; exit 1; }
    rec "PRE_count_$t" "$v"
  done

  echo "--- loads by status (before, compared after)"
  for s in requested booked at_pickup loading enroute at_delivery delivered cancelled; do
    v=$(q <<SQL
select count(*) from public.loads where status = '$s';
SQL
    ) || { echo "FAIL: count status $s"; exit 1; }
    rec "PRE_status_$s" "$v"
  done

  echo "--- locations content (before, compared after: 0021 changes no business field)"
  v=$(q <<'SQL'
select count(*) from public.locations where is_active;
SQL
  ) || exit 1; rec PRE_locations_active "$v"
  v=$(q <<'SQL'
select count(*) from public.locations where needs_review;
SQL
  ) || exit 1; rec PRE_locations_review "$v"
  v=$(q <<'SQL'
select coalesce(md5(string_agg(concat_ws('|', id, name, address_line, city, province, postal_code, can_ship, can_receive,
  requires_moffett, default_contact_name, default_contact_phone, is_active, needs_review, notes), E'\n' order by id)), 'empty')
  from public.locations;
SQL
  ) || exit 1; rec PRE_locations_md5 "$v"

  echo "--- production migration state is 0001 to 0020"
  v=$(q <<'SQL'
select count(*) from pg_tables where schemaname = 'public';
SQL
  ) || exit 1; need "11 public tables (0001 to 0020)" "$v" "11"; rec PRE_public_tables "$v"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity;
SQL
  ) || exit 1; need "RLS enabled on all 11 tables" "$v" "11"; rec PRE_rls_tables "$v"
  v=$(q <<'SQL'
select (to_regprocedure('public.dlv_loads_detail_event()') is not null and to_regprocedure('public.dlv_fmt_slot(text, date, time, time)') is not null)::int;
SQL
  ) || exit 1; need "0020 is applied (dlv_loads_detail_event and dlv_fmt_slot exist; run pack 10 first otherwise)" "$v" "1"
  v=$(q <<'SQL'
select (to_regprocedure('public.dlv_return_original(uuid)') is not null
    and to_regprocedure('public.delete_load_photo(uuid)') is not null
    and to_regprocedure('public.approve_location_request(uuid)') is not null
    and to_regprocedure('public.dlv_touch_updated_at()') is not null)::int;
SQL
  ) || exit 1; need "functions of 0002, 0009, 0018 and 0019 present" "$v" "1"
  v=$(q <<'SQL'
select (position('only default contact fields are editable' in pg_get_functiondef('public.dlv_locations_before_update()'::regprocedure)) > 0)::int;
SQL
  ) || exit 1; need "the old contact only guard of 0009 is in place" "$v" "1"
  v=$(q <<'SQL'
select (position('is_active' in pg_get_functiondef('public.dlv_role()'::regprocedure)) > 0)::int;
SQL
  ) || exit 1; need "dlv_role is inactive aware (0005)" "$v" "1"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('select'),('insert'),('update'),('delete'),('truncate'),('references'),('trigger')) p(priv)
 where n.nspname = 'public' and c.relkind in ('r','v','m','p') and has_table_privilege('anon', c.oid, p.priv);
SQL
  ) || exit 1; need "anon holds zero table grants (before)" "$v" "0"; rec PRE_anon_table_grants "$v"
  v=$(q <<'SQL'
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute');
SQL
  ) || exit 1; need "anon can EXECUTE no function in public (before)" "$v" "0"
  v=$(q <<'SQL'
select string_agg(p.priv, ',' order by p.priv) from (values ('select'),('insert'),('update'),('delete'),('truncate'),('references'),('trigger')) p(priv)
 where has_table_privilege('authenticated', 'public.locations', p.priv);
SQL
  ) || exit 1; need "authenticated holds select, insert, update and delete on locations (0003)" "$v" "delete,insert,select,update"; rec PRE_locations_grants "$v"

  echo "--- nothing of 0021 exists yet (must be absent)"
  v=$(q <<'SQL'
select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'locations'
   and column_name in ('created_at', 'created_by', 'updated_by');
SQL
  ) || exit 1; need "locations has no created_at, created_by or updated_by" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('dlv_locations_before_insert', 'dlv_location_customer_rules');
SQL
  ) || exit 1; need "no function dlv_locations_before_insert or dlv_location_customer_rules" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_trigger where tgrelid = 'public.locations'::regclass and tgname = 'locations_before_insert';
SQL
  ) || exit 1; need "no trigger locations_before_insert on locations" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_policies where schemaname = 'public' and tablename = 'locations' and policyname = 'locations_customer_insert';
SQL
  ) || exit 1; need "no policy locations_customer_insert" "$v" "0"

  echo "--- other facts recorded for the post-check"
  v=$(q <<'SQL'
select count(*) from public.profiles where role = 'staff_admin' and is_active;
SQL
  ) || exit 1; rec PRE_active_admins "$v"
  [[ "$v" -ge 1 ]] || { echo "FAIL: no active staff_admin in production (investigate before applying)"; bad=1; }
  v=$(q <<'SQL'
select count(*) from public.profiles where role = 'customer' and is_active;
SQL
  ) || exit 1; rec PRE_active_customer_users "$v"
  v=$(q <<'SQL'
select count(*) from public.location_requests where status = 'pending';
SQL
  ) || exit 1; rec PRE_pending_requests "$v"
  v=$(q <<'SQL'
select count(*) from pg_policies where schemaname in ('public','storage');
SQL
  ) || exit 1; rec PRE_policies "$v"
  v=$(q <<'SQL'
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';
SQL
  ) || exit 1; rec PRE_public_functions "$v"
  v=$(q <<'SQL'
select count(*) from pg_trigger where tgrelid = 'public.locations'::regclass and not tgisinternal;
SQL
  ) || exit 1; rec PRE_locations_triggers "$v"
  v=$(q <<'SQL'
select count(*) from pg_publication_tables where pubname = 'supabase_realtime';
SQL
  ) || exit 1; rec PRE_realtime_tables "$v"
  v=$(q <<'SQL'
select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.oid::regprocedure::text)) from pg_proc p
 where p.oid in ('public.dlv_loads_before_update()'::regprocedure, 'public.dlv_loads_before_insert()'::regprocedure,
                 'public.dlv_check_load_locations(public.loads)'::regprocedure, 'public.dlv_loads_status_event()'::regprocedure,
                 'public.dlv_loads_detail_event()'::regprocedure, 'public.approve_location_request(uuid)'::regprocedure);
SQL
  ) || exit 1; rec PRE_load_fn_md5 "$v"

  if [[ $bad -ne 0 ]]; then print -r -- "PRECHECK_RESULT=FAIL" >> "$STATE"; echo "PRECHECK_FAIL (do not apply)"; exit 1; fi
  print -r -- "PRECHECK_RESULT=OK" >> "$STATE" || exit 1
  echo "PRECHECK_OK (state saved in $STATE)"
)
```

Stop here unless it printed `PRECHECK_OK`. A FAIL on "0020 is applied" means pack 10 is not applied yet: apply pack 10 first. A FAIL on "must be absent" means something of 0021 already exists: stop and investigate (do not run block B). The loads count and the per status counts are not failures.

## 4. Apply

Block B. One transaction per migration (`--single-transaction`), stops at the first failure, full transcript in `apply-transcript-11.txt` (repo root, it contains no connection string; do not commit it). The migration list and the expected highest number live in the `files` array.

```zsh
# BLOCK apply
(
  setopt pipefail
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-11}"
  [[ -f "$DIR/state.env" ]] || { echo "FAIL: run the pre-check (block A) first"; exit 1; }
  grep -qx 'PRECHECK_RESULT=OK' "$DIR/state.env" || { echo "FAIL: the last pre-check (block A) did not end in PRECHECK_OK. Do not apply. Fix the cause and run block A again."; exit 1; }
  files=(
    0021_customer_locations.sql
  )
  for f in $files; do
    [[ -f "supabase/migrations/$f" ]] || { echo "FAIL: missing supabase/migrations/$f (run from the repo root)"; exit 1; }
  done
  last="${files[-1]%%_*}"
  highest=$(ls supabase/migrations | grep '^[0-9]' | sort | tail -1)
  [[ "${highest%%_*}" == "$last" ]] || { echo "FAIL: the highest migration file is ${highest%%_*} but the last file in this pack is $last"; exit 1; }
  count=$(ls supabase/migrations | grep -c '^[0-9]')
  [[ "$count" -eq $((10#$last)) ]] || { echo "FAIL: expected $((10#$last)) migration files (0001 to $last, none missing), found $count"; exit 1; }
  print -r -- "apply started $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-11.txt
  for f in $files; do
    print -r -- "=== $f" | tee -a apply-transcript-11.txt
    psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f "supabase/migrations/$f" 2>&1 | tee -a apply-transcript-11.txt || { echo "APPLY_FAIL at $f (that file was rolled back as one transaction; earlier files stay applied; see section 5)"; exit 1; }
  done
  print -r -- "APPLY_OK $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-11.txt
)
```

If a block fails midway: the failing file is one transaction, so it left nothing behind. Fix the cause and run block B again (the file is idempotent).

## 5. Rollback notes (per migration)

The migration runs as one transaction, so a failure inside the file undoes the whole file. This is only for undoing a file that APPLIED and that you then decide to back out. Do not run it against production without the owner's explicit go. Reuse `$DATABASE_URL_DIRECT`. Roll the app back FIRST (to the DLV-039 deploy): the new app's Add location and full edit need 0021.

- 0021: drops the trigger `locations_before_insert`, the functions `dlv_locations_before_insert()` and `dlv_location_customer_rules(locations)` and the policy `locations_customer_insert`, and puts back the 0009 contact only guard `dlv_locations_before_update()` (not definer) and the 0003 policy `locations_update`, as ONE transaction. The three columns `created_at`, `created_by` and `updated_by` STAY with their values (dropping them would delete who added and edited each location; drop them by hand only with the owner's go). Locations Maria added stay and stay active. After this rollback block A reports the three columns as present (expected); block B re-applies cleanly.

```zsh
# BLOCK rollback-0021
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f - <<'SQL' || exit 1
drop trigger if exists locations_before_insert on public.locations;
drop function if exists public.dlv_locations_before_insert();
drop policy if exists locations_customer_insert on public.locations;
drop policy if exists locations_update on public.locations;
create policy locations_update on public.locations for update to authenticated
  using (public.dlv_is_staff() or public.dlv_role() = 'customer')
  with check (public.dlv_is_staff() or public.dlv_role() = 'customer');
create or replace function public.dlv_locations_before_update() returns trigger
language plpgsql security invoker set search_path = ''
as $fn$
begin
  if auth.uid() is null or public.dlv_is_staff() then return new; end if;
  if (to_jsonb(new) - 'default_contact_name' - 'default_contact_phone' - 'updated_at' - 'created_by' - 'updated_by')
     is distinct from
     (to_jsonb(old) - 'default_contact_name' - 'default_contact_phone' - 'updated_at' - 'created_by' - 'updated_by') then
    raise exception 'only default contact fields are editable' using errcode = '42501';
  end if;
  return new;
end
$fn$;
drop function if exists public.dlv_location_customer_rules(public.locations);
revoke all on function public.dlv_locations_before_update() from public, anon, authenticated;
grant execute on function public.dlv_locations_before_update() to service_role;
SQL
  echo ROLLBACK_0021_OK
)
```

(The restored guard ignores `created_by` and `updated_by` as well as the contact: with the columns kept, the ON DELETE SET NULL of a deleted profile must not count as a customer edit. Everything else is the 0009 text.)

## 6. Post-check (read only)

Block C. Expected values come from the same run: the counts and the location content saved by block A are compared with fresh values, and the security posture of the new objects is checked against the catalog. It changes nothing.

```zsh
# BLOCK postcheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-11}"
  STATE="$DIR/state.env"
  [[ -f "$STATE" ]] || { echo "FAIL: no state file, run block A before the apply"; exit 1; }
  source "$STATE" || exit 1
  q() { { echo "set default_transaction_read_only = on;"; cat; } | psql "$DATABASE_URL_DIRECT" -X -A -t -q -v ON_ERROR_STOP=1 -f - ; }
  bad=0
  need() { if [[ "$2" == "$3" ]]; then print -r -- "PASS $1"; else print -r -- "FAIL $1 (got $2, want $3)"; bad=1; fi; }
  INS="to_regprocedure('public.dlv_locations_before_insert()')"
  UPD="to_regprocedure('public.dlv_locations_before_update()')"
  RUL="to_regprocedure('public.dlv_location_customer_rules(public.locations)')"

  echo "--- row counts unchanged"
  for t in loads profiles load_events load_documents locations customers carriers location_requests load_deletions lane_references rate_requests; do
    v=$(q <<SQL
select count(*) from public.$t;
SQL
    ) || { echo "FAIL: count $t"; exit 1; }
    eval "want=\$PRE_count_$t"
    need "count $t unchanged" "$v" "$want"
  done
  for s in requested booked at_pickup loading enroute at_delivery delivered cancelled; do
    v=$(q <<SQL
select count(*) from public.loads where status = '$s';
SQL
    ) || { echo "FAIL: count status $s"; exit 1; }
    eval "want=\$PRE_status_$s"
    need "loads in status $s unchanged" "$v" "$want"
  done
  v=$(q <<SQL
select count(*) from public.location_requests where status = 'pending';
SQL
  ) || exit 1; need "pending location requests unchanged" "$v" "$PRE_pending_requests"

  echo "--- locations content unchanged"
  v=$(q <<SQL
select count(*) from public.locations where is_active;
SQL
  ) || exit 1; need "active locations unchanged" "$v" "$PRE_locations_active"
  v=$(q <<SQL
select count(*) from public.locations where needs_review;
SQL
  ) || exit 1; need "locations needing review unchanged" "$v" "$PRE_locations_review"
  v=$(q <<SQL
select coalesce(md5(string_agg(concat_ws('|', id, name, address_line, city, province, postal_code, can_ship, can_receive,
  requires_moffett, default_contact_name, default_contact_phone, is_active, needs_review, notes), E'\n' order by id)), 'empty')
  from public.locations;
SQL
  ) || exit 1; need "every business field of every location is byte identical" "$v" "$PRE_locations_md5"

  echo "--- 0021: columns, triggers, functions, policies"
  v=$(q <<SQL
select (($INS) is not null and ($UPD) is not null and ($RUL) is not null)::int;
SQL
  ) || exit 1
  if [[ "$v" != "1" ]]; then echo "FAIL the 0021 functions are missing (0021 is not applied)"; echo "POSTCHECK_FAIL"; exit 1; fi
  echo "PASS the three 0021 functions exist"
  v=$(q <<SQL
select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'locations'
   and ((column_name = 'created_at' and data_type = 'timestamp with time zone' and is_nullable = 'NO' and column_default is not null)
     or (column_name in ('created_by', 'updated_by') and data_type = 'uuid' and is_nullable = 'YES'));
SQL
  ) || exit 1; need "the three columns exist with the right types" "$v" "3"
  v=$(q <<SQL
select count(*) from pg_constraint c
 where c.conrelid = 'public.locations'::regclass and c.contype = 'f' and c.confrelid = 'public.profiles'::regclass and c.confdeltype = 'n'
   and (select array_agg(a.attname::text) from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) in (array['created_by'], array['updated_by']);
SQL
  ) || exit 1; need "created_by and updated_by reference profiles ON DELETE SET NULL" "$v" "2"
  v=$(q <<SQL
select count(*) from public.locations where created_by is not null or updated_by is not null or created_at is null;
SQL
  ) || exit 1; need "the apply wrote no author and every row has a created_at" "$v" "0"
  v=$(q <<SQL
select count(*) from pg_trigger t where t.tgrelid = 'public.locations'::regclass and t.tgname = 'locations_before_insert'
   and not t.tgisinternal and t.tgenabled = 'O' and t.tgfoid = $INS
   and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 4) = 4 and (t.tgtype & 16) = 0;
SQL
  ) || exit 1; need "locations_before_insert is an enabled BEFORE INSERT row trigger" "$v" "1"
  v=$(q <<SQL
select count(*) from pg_trigger t where t.tgrelid = 'public.locations'::regclass and t.tgname = 'locations_before_update'
   and not t.tgisinternal and t.tgenabled = 'O' and t.tgfoid = $UPD
   and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 16) = 16;
SQL
  ) || exit 1; need "locations_before_update is an enabled BEFORE UPDATE row trigger" "$v" "1"
  v=$(q <<SQL
select count(*) from pg_trigger where tgrelid = 'public.locations'::regclass and not tgisinternal;
SQL
  ) || exit 1; need "locations has its old triggers plus one" "$v" "$((PRE_locations_triggers + 1))"
  v=$(q <<SQL
select count(*) from pg_proc where oid in ($INS, $UPD) and prosecdef and proconfig @> array['search_path=""'];
SQL
  ) || exit 1; need "the two trigger functions are SECURITY DEFINER with an empty search_path" "$v" "2"
  v=$(q <<SQL
select count(*) from pg_proc where oid = $RUL and not prosecdef and proconfig @> array['search_path=""'];
SQL
  ) || exit 1; need "dlv_location_customer_rules is not definer, with an empty search_path" "$v" "1"
  v=$(q <<SQL
select (not has_function_privilege('anon', $INS, 'execute') and not has_function_privilege('authenticated', $INS, 'execute')
    and not has_function_privilege('anon', $UPD, 'execute') and not has_function_privilege('authenticated', $UPD, 'execute')
    and not has_function_privilege('anon', $RUL, 'execute') and not has_function_privilege('authenticated', $RUL, 'execute')
    and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    where p.oid in ($INS, $UPD, $RUL) and a.grantee = 0))::int;
SQL
  ) || exit 1; need "no client role and not PUBLIC may execute the three 0021 functions" "$v" "1"
  v=$(q <<SQL
select (position('customer can change only' in pg_get_functiondef($UPD)) > 0
    and position('v_business' in pg_get_functiondef($UPD)) > 0
    and position('new.updated_by := v_uid' in pg_get_functiondef($UPD)) > 0
    and position('new.is_active := true' in pg_get_functiondef($INS)) > 0
    and position('new.needs_review := false' in pg_get_functiondef($INS)) > 0
    and position('new.created_by := v_uid' in pg_get_functiondef($INS)) > 0)::int;
SQL
  ) || exit 1; need "the guard is the 0021 whitelist and the insert trigger forces the flags and the author" "$v" "1"
  v=$(q <<SQL
select string_agg(policyname || ':' || cmd, ',' order by policyname) from pg_policies where schemaname = 'public' and tablename = 'locations';
SQL
  ) || exit 1; need "locations policies are exactly the five expected" "$v" "locations_customer_insert:INSERT,locations_select:SELECT,locations_staff_delete:DELETE,locations_staff_insert:INSERT,locations_update:UPDATE"
  v=$(q <<SQL
select (qual like '%customer%' and qual like '%is_active%' and with_check like '%is_active%')::int from pg_policies
 where schemaname = 'public' and tablename = 'locations' and policyname = 'locations_update';
SQL
  ) || exit 1; need "locations_update limits a customer to active rows" "$v" "1"
  v=$(q <<SQL
select (with_check like '%customer%' and with_check like '%is_active%' and with_check like '%needs_review%')::int from pg_policies
 where schemaname = 'public' and tablename = 'locations' and policyname = 'locations_customer_insert';
SQL
  ) || exit 1; need "locations_customer_insert is for an active customer, active rows, no review" "$v" "1"
  v=$(q <<SQL
select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.oid::regprocedure::text)) from pg_proc p
 where p.oid in ('public.dlv_loads_before_update()'::regprocedure, 'public.dlv_loads_before_insert()'::regprocedure,
                 'public.dlv_check_load_locations(public.loads)'::regprocedure, 'public.dlv_loads_status_event()'::regprocedure,
                 'public.dlv_loads_detail_event()'::regprocedure, 'public.approve_location_request(uuid)'::regprocedure);
SQL
  ) || exit 1; need "the load functions and approve_location_request are byte identical (0021 replaces none)" "$v" "$PRE_load_fn_md5"

  echo "--- security posture unchanged"
  v=$(q <<SQL
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity;
SQL
  ) || exit 1; need "RLS enabled on every public table (same 11)" "$v" "$PRE_rls_tables"
  v=$(q <<SQL
select count(*) from pg_tables where schemaname = 'public';
SQL
  ) || exit 1; need "public table count unchanged (0021 adds no table)" "$v" "$PRE_public_tables"
  v=$(q <<SQL
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('select'),('insert'),('update'),('delete'),('truncate'),('references'),('trigger')) p(priv)
 where n.nspname = 'public' and c.relkind in ('r','v','m','p') and has_table_privilege('anon', c.oid, p.priv);
SQL
  ) || exit 1; need "anon table grants unchanged (zero)" "$v" "$PRE_anon_table_grants"
  v=$(q <<SQL
select string_agg(p.priv, ',' order by p.priv) from (values ('select'),('insert'),('update'),('delete'),('truncate'),('references'),('trigger')) p(priv)
 where has_table_privilege('authenticated', 'public.locations', p.priv);
SQL
  ) || exit 1; need "authenticated grants on locations unchanged" "$v" "$PRE_locations_grants"
  v=$(q <<SQL
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute');
SQL
  ) || exit 1; need "anon can EXECUTE no function in public" "$v" "0"
  v=$(q <<SQL
select count(*) from pg_policies where schemaname in ('public','storage');
SQL
  ) || exit 1; need "policy count is the old count plus one (one new, one replaced)" "$v" "$((PRE_policies + 1))"
  v=$(q <<SQL
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';
SQL
  ) || exit 1; need "function count is the old count plus two" "$v" "$((PRE_public_functions + 2))"
  v=$(q <<SQL
select count(*) from pg_publication_tables where pubname = 'supabase_realtime';
SQL
  ) || exit 1; need "the realtime publication holds the same tables as before" "$v" "$PRE_realtime_tables"
  v=$(q <<SQL
select count(*) from public.profiles where role = 'staff_admin' and is_active;
SQL
  ) || exit 1; need "active staff_admin count unchanged" "$v" "$PRE_active_admins"
  v=$(q <<SQL
select count(*) from public.profiles where role = 'customer' and is_active;
SQL
  ) || exit 1; need "active customer user count unchanged" "$v" "$PRE_active_customer_users"

  if [[ $bad -ne 0 ]]; then echo "POSTCHECK_FAIL"; exit 1; fi
  echo "POSTCHECK_OK"
)
```

After `POSTCHECK_OK`: merge the PR and wait for the production deploy, then follow the "After every deploy" list in docs/RUNBOOK.md. App level smoke after the deploy: sign in as Maria (or ask her), open **Locations** and check the **Add location** form is at the bottom and every location has **Edit**. Then run the manual test M16 in docs/ACCEPTANCE-CHECKLIST.md with a TEST location (name starting `TEST-`), and deactivate that location afterwards as staff.

## Extending this pack

A later card that adds a migration (for example 0022) does exactly three things and changes no block logic:
1. Add a row to the table in section 1.
2. Append the file name to the `files=( ... )` array in block B. The "highest file equals the last file in the list" and "file count equals the highest number" checks then expect 0022 by themselves.
3. Add a group of PASS checks for the new file to block C, and any read only data check to block A. Adjust the expected function, trigger and policy counts by what the new file adds.

## Rehearsal result

Rehearsed on the LOCAL stack only (127.0.0.1:58322, the moved local ports of this machine), never production, on 2026-10-20 by the engineering assistant (DLV-041 card). REHEARSED VERBATIM: the harness ran zsh files. Each block was extracted from this file with a python regex (`` ```zsh\n# BLOCK name\n(.*?)\n``` ``; every block starts with a line `(`, ends with a line that is exactly `)` and no other line in a block is exactly `)`, checked by the extractor) and run as `env -i PATH="$PATH" HOME="$HOME" DATABASE_URL_DIRECT=<the LOCAL url> DLV_APPLY_DIR=<fresh scratch dir> zsh -f <block file>` from a scratch folder whose `supabase` entry links to the repo's supabase folder (so the transcript stayed out of the repo). No production value was in that environment.

Method: `supabase db reset --last 1` took the local database to 0020 (read back from `supabase_migrations.schema_migrations`: max version 0020, 20 rows; no `created_by` column on locations) with the 19 seeded locations. Production-like rows were inserted: 1 staff_admin, 1 customer user of Mitrex, 1 carrier, 1 pending location request and 1 requested load (PO `TEST-R1`). Afterwards `supabase db reset` restored the full local state for rls.sql and the e2e runs.

| Step | Result |
| --- | --- |
| Block A pre-check | rc 0, 13 PASS, 0 FAIL, PRECHECK_OK. |
| Block B apply | rc 0, APPLY_OK, 0 error lines (21 migration files, highest 0021). |
| Block C post-check | rc 0, 48 PASS, 0 FAIL, POSTCHECK_OK. |
| Block B again, then block C | APPLY_OK (idempotent), then 48 PASS, POSTCHECK_OK. |
| Negative arm: block A after the apply | rc 1, PRECHECK_FAIL with 5 FAIL: the old guard is gone, the three columns, the two functions, the trigger and the policy exist. |
| Negative arm: a real customer edit after the apply | Maria (simulated session) changed the address of Howden: the location md5 and "the apply wrote no author" FAILED (rc 1, 2 FAIL, POSTCHECK_FAIL), updated_by was her id. Reverted as the table owner, block C 48 PASS again. |
| Negative arm: `grant execute` on `dlv_locations_before_insert` to anon | Block C: rc 1, 2 FAIL (no client role may execute, anon executes a function). Revoked, green again. |
| Negative arm: the insert trigger disabled | Block C: rc 1, 1 FAIL (the trigger check). Enabled, block C 48 PASS, POSTCHECK_OK. |
| Rollback 0021 | rc 0, ROLLBACK_0021_OK. Block C then failed closed (rc 1, "FAIL the 0021 functions are missing", POSTCHECK_FAIL); the public function count went back to 33 and the policy count to 29 (the 0020 values); block A then failed only on "locations has no created_at, created_by or updated_by" (the columns are kept on purpose) and passed "the old contact only guard of 0009 is in place". Behaviour after the rollback (simulated Maria session, rolled back): a contact edit is allowed, an address edit is refused "only default contact fields are editable", an insert is refused by row level security. Block B re-applied 0021 and block C gave 48 PASS, POSTCHECK_OK. |
| Functional rules of 0021 | Not part of the blocks. supabase/tests/rls.sql section 21 (78 checks: Maria's insert with forced flags and author, every business field, each forbidden column, the customer rules, no delete, inactive rows and users, carrier owner and driver, staff unchanged with the author columns kept, owner tooling, a deleted author, the booking rules, a second apply of the real file) and e2e/customer-locations.spec.ts. 5 database mutations were each caught by rls.sql. |

## Production result

To be filled in after the owner supervised session (blocks A, B, C against production, then the merge and the deploy).
