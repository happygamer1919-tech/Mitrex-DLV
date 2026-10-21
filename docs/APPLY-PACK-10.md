# Apply pack 10: migration 0020 (staff edit audit) to production

For a SEPARATE, owner supervised production session. Nothing in this pack was run against production. It was
rehearsed against the local stack only (see "Rehearsal result"). Production must hold migrations 0001 to 0019 first
(packs 2 to 9; 0019 is pack 9, return loads). Block A refuses to continue when 0019 is missing.

The file list in section 1 and the `files=( ... )` array at the top of block B are the only places that name
migrations; every count and "highest number" check is derived from that list (see "Extending this pack").

Rules for the session
- The owner runs every block. Do not paste a connection string, key or password anywhere. Blocks print counts and PASS or FAIL only.
- Run in a quiet window (no customer or staff actions). The post-check compares row counts with the pre-check, so live traffic between the two shows as a FAIL to investigate, not as a silent pass.
- Every block is zsh and runs inside a subshell `( ... )`, so a failure ends the block and never closes your terminal. Each block exits non-zero on failure and prints its own verdict. No block relies on `set -e`.
- Blocks keep state in `$DLV_APPLY_DIR` (default `~/dlv-apply-10`, mode 700). The state file holds counts and 0/1 flags, no secrets.
- 0020 adds two functions and one trigger. It changes, deletes and rewrites no row, and it changes no table, column, grant or policy: no load, user, event, document, lane, rate request or status is touched.

## 1. Migrations not yet in production (in order)

| File | What it does | Risk |
| --- | --- | --- |
| 0020_staff_edit_audit.sql | Staff edit audit (DLV-039, R44). New function `dlv_fmt_slot(text, date, time, time)` (IMMUTABLE, search_path empty; prints a pickup or delivery time exactly like the app). New function `dlv_loads_detail_event()` (SECURITY DEFINER, search_path empty) and the AFTER UPDATE row trigger `loads_detail_event` on `loads`: when an ACTIVE staff user (auth.uid() not null and dlv_is_staff()) changes at least one load detail, it inserts ONE `load_events` row (from = to = the current status, the staff user, the note "Details edited: ..."). Customers, carriers, the service role and owner tooling write nothing. Both functions: EXECUTE revoked from PUBLIC, anon and authenticated, granted to service_role only. | Low. Additive. Nothing changes for existing rows; the trigger writes only on a future staff edit. Idempotent (CREATE OR REPLACE, DROP TRIGGER IF EXISTS, grants restated by name). Rolling back means section 5. |

Visible effect: after a staff edit, the load's timeline (staff, Maria and the carrier) shows a line "Details edited: Field: old to new; ...". Without 0020 the app still saves staff edits; only that timeline line is missing.

## 2. Order of operations: 0019 first, then 0020, then the app

Recommendation: apply 0019 (pack 9) and deploy DLV-038 first if that has not happened yet. Then apply 0020, then merge the DLV-039 PR and let it deploy.

Reasons
1. 0020 is fully backward compatible with the app that is live now: it only adds a trigger that writes a timeline row after a staff edit. The live app has no staff edit screen, so nothing changes until the new app is deployed.
2. The new app does not need 0020 to work (the edit saves either way), but with 0020 already in place the very first staff edit is recorded in the timeline.
3. If the migration fails, nothing user visible has changed and the app is untouched.

## 3. Pre-check (read only)

Session setup. Run this in the terminal you will use for every block below. It loads DATABASE_URL_DIRECT without printing it.

```
set -o allexport; source ~/.zshenvmitrex; set +o allexport
cd ~/Documents/Projects/GitHub/Mitrex-DLV && git fetch origin && git checkout feat/dlv-039-staff-edit-loads
```

(If this branch was merged, `git checkout main && git pull` instead. The migration files must be exactly the ones listed above.)

Block A, pre-check. Read only: every statement runs with `default_transaction_read_only = on`, so it cannot change data even by mistake.

```zsh
# BLOCK precheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-10}"
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

  echo "--- production migration state is 0001 to 0019"
  v=$(q <<'SQL'
select count(*) from pg_tables where schemaname = 'public';
SQL
  ) || exit 1; need "11 public tables (0001 to 0019)" "$v" "11"; rec PRE_public_tables "$v"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity;
SQL
  ) || exit 1; need "RLS enabled on all 11 tables" "$v" "11"; rec PRE_rls_tables "$v"
  v=$(q <<'SQL'
select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'loads' and column_name = 'return_of_load_id';
SQL
  ) || exit 1; need "0019 is applied (loads.return_of_load_id exists; run pack 9 first otherwise)" "$v" "1"
  v=$(q <<'SQL'
select (to_regprocedure('public.dlv_return_original(uuid)') is not null
    and to_regprocedure('public.delete_load_photo(uuid)') is not null
    and to_regprocedure('public.set_load_status(uuid, public.load_status, timestamptz, text)') is not null
    and to_regprocedure('public.set_its_load_number(uuid, text)') is not null)::int;
SQL
  ) || exit 1; need "functions of 0010, 0013, 0018 and 0019 present" "$v" "1"
  v=$(q <<'SQL'
select (position('is_active' in pg_get_functiondef('public.dlv_is_staff()'::regprocedure)) > 0)::int;
SQL
  ) || exit 1; need "dlv_is_staff is inactive aware (0005)" "$v" "1"
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
select count(*) from (values ('insert'),('update'),('delete'),('truncate')) p(priv)
 where has_table_privilege('authenticated', 'public.load_events', p.priv) or has_table_privilege('anon', 'public.load_events', p.priv);
SQL
  ) || exit 1; need "clients hold no INSERT, UPDATE, DELETE or TRUNCATE on load_events (before)" "$v" "0"

  echo "--- nothing of 0020 exists yet (must be absent)"
  v=$(q <<'SQL'
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('dlv_loads_detail_event', 'dlv_fmt_slot');
SQL
  ) || exit 1; need "no function dlv_loads_detail_event or dlv_fmt_slot" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_trigger where tgrelid = 'public.loads'::regclass and tgname = 'loads_detail_event';
SQL
  ) || exit 1; need "no trigger loads_detail_event on loads" "$v" "0"
  v=$(q <<'SQL'
select count(*) from public.load_events where note like 'Details edited:%';
SQL
  ) || exit 1; need "no Details edited event exists yet" "$v" "0"

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
select count(*) from pg_policies where schemaname in ('public','storage');
SQL
  ) || exit 1; rec PRE_policies "$v"
  v=$(q <<'SQL'
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';
SQL
  ) || exit 1; rec PRE_public_functions "$v"
  v=$(q <<'SQL'
select count(*) from pg_trigger where tgrelid = 'public.loads'::regclass and not tgisinternal;
SQL
  ) || exit 1; rec PRE_loads_triggers "$v"
  v=$(q <<'SQL'
select count(*) from pg_publication_tables where pubname = 'supabase_realtime';
SQL
  ) || exit 1; rec PRE_realtime_tables "$v"
  v=$(q <<'SQL'
select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.oid::regprocedure::text)) from pg_proc p
 where p.oid in ('public.dlv_loads_before_update()'::regprocedure, 'public.dlv_loads_before_insert()'::regprocedure,
                 'public.dlv_check_load_locations(public.loads)'::regprocedure, 'public.dlv_loads_status_event()'::regprocedure);
SQL
  ) || exit 1; rec PRE_load_fn_md5 "$v"

  if [[ $bad -ne 0 ]]; then print -r -- "PRECHECK_RESULT=FAIL" >> "$STATE"; echo "PRECHECK_FAIL (do not apply)"; exit 1; fi
  print -r -- "PRECHECK_RESULT=OK" >> "$STATE" || exit 1
  echo "PRECHECK_OK (state saved in $STATE)"
)
```

Stop here unless it printed `PRECHECK_OK`. A FAIL on "0019 is applied" means pack 9 is not applied yet: apply pack 9 first. A FAIL on "must be absent" means something of 0020 already exists: stop and investigate (do not run block B). The loads count and the per status counts are not failures.

## 4. Apply

Block B. One transaction per migration (`--single-transaction`), stops at the first failure, full transcript in `apply-transcript-10.txt` (repo root, it contains no connection string; do not commit it). The migration list and the expected highest number live in the `files` array.

```zsh
# BLOCK apply
(
  setopt pipefail
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-10}"
  [[ -f "$DIR/state.env" ]] || { echo "FAIL: run the pre-check (block A) first"; exit 1; }
  grep -qx 'PRECHECK_RESULT=OK' "$DIR/state.env" || { echo "FAIL: the last pre-check (block A) did not end in PRECHECK_OK. Do not apply. Fix the cause and run block A again."; exit 1; }
  files=(
    0020_staff_edit_audit.sql
  )
  for f in $files; do
    [[ -f "supabase/migrations/$f" ]] || { echo "FAIL: missing supabase/migrations/$f (run from the repo root)"; exit 1; }
  done
  last="${files[-1]%%_*}"
  highest=$(ls supabase/migrations | grep '^[0-9]' | sort | tail -1)
  [[ "${highest%%_*}" == "$last" ]] || { echo "FAIL: the highest migration file is ${highest%%_*} but the last file in this pack is $last"; exit 1; }
  count=$(ls supabase/migrations | grep -c '^[0-9]')
  [[ "$count" -eq $((10#$last)) ]] || { echo "FAIL: expected $((10#$last)) migration files (0001 to $last, none missing), found $count"; exit 1; }
  print -r -- "apply started $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-10.txt
  for f in $files; do
    print -r -- "=== $f" | tee -a apply-transcript-10.txt
    psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f "supabase/migrations/$f" 2>&1 | tee -a apply-transcript-10.txt || { echo "APPLY_FAIL at $f (that file was rolled back as one transaction; earlier files stay applied; see section 5)"; exit 1; }
  done
  print -r -- "APPLY_OK $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-10.txt
)
```

If a block fails midway: the failing file is one transaction, so it left nothing behind. Fix the cause and run block B again (the file is idempotent).

## 5. Rollback notes (per migration)

The migration runs as one transaction, so a failure inside the file undoes the whole file. This is only for undoing a file that APPLIED and that you then decide to back out. Do not run it against production without the owner's explicit go. Reuse `$DATABASE_URL_DIRECT`. The app does not need to be rolled back with it: staff edits keep saving, only the "Details edited" timeline line stops.

- 0020: drops the trigger `loads_detail_event` and the functions `dlv_loads_detail_event()` and `dlv_fmt_slot(text, date, time, time)`, as ONE transaction. The "Details edited" events already written STAY in the timeline (load_events is an append only audit; nothing deletes them). Nothing else is touched: no load, event, document or status changes.

```zsh
# BLOCK rollback-0020
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f - <<'SQL' || exit 1
drop trigger if exists loads_detail_event on public.loads;
drop function if exists public.dlv_loads_detail_event();
drop function if exists public.dlv_fmt_slot(text, date, time, time);
SQL
  echo ROLLBACK_0020_OK
)
```

## 6. Post-check (read only)

Block C. Expected values come from the same run: the counts saved by block A are compared with fresh counts, and the security posture of the new objects is checked against the catalog. It changes nothing.

```zsh
# BLOCK postcheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-10}"
  STATE="$DIR/state.env"
  [[ -f "$STATE" ]] || { echo "FAIL: no state file, run block A before the apply"; exit 1; }
  source "$STATE" || exit 1
  q() { { echo "set default_transaction_read_only = on;"; cat; } | psql "$DATABASE_URL_DIRECT" -X -A -t -q -v ON_ERROR_STOP=1 -f - ; }
  bad=0
  need() { if [[ "$2" == "$3" ]]; then print -r -- "PASS $1"; else print -r -- "FAIL $1 (got $2, want $3)"; bad=1; fi; }
  EVT="to_regprocedure('public.dlv_loads_detail_event()')"
  FMT="to_regprocedure('public.dlv_fmt_slot(text, date, time, time)')"

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
select count(*) from public.load_events where note like 'Details edited:%';
SQL
  ) || exit 1; need "no Details edited event yet (the apply writes none)" "$v" "0"

  echo "--- 0020: the trigger and the two functions"
  v=$(q <<SQL
select (($EVT) is not null and ($FMT) is not null)::int;
SQL
  ) || exit 1
  if [[ "$v" != "1" ]]; then echo "FAIL the 0020 functions are missing (0020 is not applied)"; echo "POSTCHECK_FAIL"; exit 1; fi
  echo "PASS the two 0020 functions exist"
  v=$(q <<SQL
select count(*) from pg_trigger t where t.tgrelid = 'public.loads'::regclass and t.tgname = 'loads_detail_event'
   and not t.tgisinternal and t.tgenabled = 'O' and t.tgfoid = $EVT
   and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 0 and (t.tgtype & 64) = 0 and (t.tgtype & 16) = 16;
SQL
  ) || exit 1; need "loads_detail_event is an enabled AFTER UPDATE row trigger calling dlv_loads_detail_event" "$v" "1"
  v=$(q <<SQL
select count(*) from pg_trigger where tgrelid = 'public.loads'::regclass and not tgisinternal;
SQL
  ) || exit 1; need "loads has its old triggers plus one" "$v" "$((PRE_loads_triggers + 1))"
  v=$(q <<SQL
select count(*) from pg_proc where oid = $EVT and prosecdef and proconfig @> array['search_path=""'];
SQL
  ) || exit 1; need "dlv_loads_detail_event is SECURITY DEFINER with an empty search_path" "$v" "1"
  v=$(q <<SQL
select count(*) from pg_proc where oid = $FMT and provolatile = 'i' and not prosecdef and proconfig @> array['search_path=""'];
SQL
  ) || exit 1; need "dlv_fmt_slot is IMMUTABLE, not definer, with an empty search_path" "$v" "1"
  v=$(q <<SQL
select (not has_function_privilege('anon', $EVT, 'execute') and not has_function_privilege('authenticated', $EVT, 'execute')
    and not has_function_privilege('anon', $FMT, 'execute') and not has_function_privilege('authenticated', $FMT, 'execute')
    and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    where p.oid in ($EVT, $FMT) and a.grantee = 0))::int;
SQL
  ) || exit 1; need "no client role and not PUBLIC may execute the two 0020 functions" "$v" "1"
  v=$(q <<SQL
select (position('auth.uid() is null or not public.dlv_is_staff()' in pg_get_functiondef($EVT)) > 0
    and position('Details edited: ' in pg_get_functiondef($EVT)) > 0
    and position('left(v_note, 997)' in pg_get_functiondef($EVT)) > 0)::int;
SQL
  ) || exit 1; need "the trigger function records only an active staff actor and cuts the note at 1000 characters" "$v" "1"
  v=$(q <<SQL
select (public.dlv_fmt_slot('appointment', '2031-09-01', '12:00', null) = 'Mon, Sep 1, 2031, 12:00 PM ET (appointment)'
    and public.dlv_fmt_slot('window', '2031-05-07', '00:15', '13:05') = 'Wed, May 7, 2031, 12:15 AM to 1:05 PM ET (window)')::int;
SQL
  ) || exit 1; need "dlv_fmt_slot prints times like the app" "$v" "1"
  v=$(q <<SQL
select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.oid::regprocedure::text)) from pg_proc p
 where p.oid in ('public.dlv_loads_before_update()'::regprocedure, 'public.dlv_loads_before_insert()'::regprocedure,
                 'public.dlv_check_load_locations(public.loads)'::regprocedure, 'public.dlv_loads_status_event()'::regprocedure);
SQL
  ) || exit 1; need "the load trigger functions of 0010, 0013 and 0019 are byte identical (0020 replaces none)" "$v" "$PRE_load_fn_md5"

  echo "--- security posture unchanged"
  v=$(q <<SQL
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity;
SQL
  ) || exit 1; need "RLS enabled on every public table (same 11)" "$v" "$PRE_rls_tables"
  v=$(q <<SQL
select count(*) from pg_tables where schemaname = 'public';
SQL
  ) || exit 1; need "public table count unchanged (0020 adds no table)" "$v" "$PRE_public_tables"
  v=$(q <<SQL
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('select'),('insert'),('update'),('delete'),('truncate'),('references'),('trigger')) p(priv)
 where n.nspname = 'public' and c.relkind in ('r','v','m','p') and has_table_privilege('anon', c.oid, p.priv);
SQL
  ) || exit 1; need "anon table grants unchanged (zero)" "$v" "$PRE_anon_table_grants"
  v=$(q <<SQL
select count(*) from (values ('insert'),('update'),('delete'),('truncate')) p(priv)
 where has_table_privilege('authenticated', 'public.load_events', p.priv) or has_table_privilege('anon', 'public.load_events', p.priv);
SQL
  ) || exit 1; need "load_events stays append only: no client INSERT, UPDATE, DELETE or TRUNCATE" "$v" "0"
  v=$(q <<SQL
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute');
SQL
  ) || exit 1; need "anon can EXECUTE no function in public" "$v" "0"
  v=$(q <<SQL
select count(*) from pg_policies where schemaname in ('public','storage');
SQL
  ) || exit 1; need "policy count unchanged (0020 adds and replaces no policy)" "$v" "$PRE_policies"
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

After `POSTCHECK_OK`: merge the PR and wait for the production deploy, then follow the "After every deploy" list in docs/RUNBOOK.md. App level smoke after the deploy: sign in as staff, open a TEST load (PO starting `TEST-`) and check that **Edit details** is near the top. Do NOT edit a real load to test. Then run the manual test M15 in docs/ACCEPTANCE-CHECKLIST.md with TEST loads.

## Extending this pack

A later card that adds a migration (for example 0021) does exactly three things and changes no block logic:
1. Add a row to the table in section 1.
2. Append the file name to the `files=( ... )` array in block B. The "highest file equals the last file in the list" and "file count equals the highest number" checks then expect 0021 by themselves.
3. Add a group of PASS checks for the new file to block C, and any read only data check to block A. Adjust the expected function, trigger and policy counts by what the new file adds.

## Rehearsal result

Rehearsed on the LOCAL stack only (127.0.0.1:58322, the moved local ports of this machine), never production, on 2026-10-20 by the engineering assistant (DLV-039 card). REHEARSED VERBATIM: the harness ran zsh files. Each block was extracted from this file with a python regex (`` ```zsh\n# BLOCK name\n(.*?)\n``` ``; every block ends with a line that is exactly `)` and no other line in a block is exactly `)`, checked by the extractor) and run as `env -i PATH="$PATH" HOME="$HOME" DATABASE_URL_DIRECT=<the LOCAL url> DLV_APPLY_DIR=<fresh scratch dir> zsh -f <block file>` from a scratch folder whose `supabase` entry links to the repo's supabase folder (so the transcript stayed out of the repo). No production value was in that environment.

Method: `supabase db reset --last 1` took the local database to 0019 (read back from `supabase_migrations.schema_migrations`: max version 0019, 19 rows, no 0020 function). Production-like rows were inserted: 1 staff_admin, 1 customer user of Mitrex, 1 carrier, 6 loads (requested, booked, loading, at_delivery, delivered, cancelled; PO `TEST-R1` to `TEST-R6`) with their 6 creation events. Afterwards `supabase db reset` restored the full local state and rls.sql gave `RLS_OK 1020 OK / 0 VACUOUS / 0 FAIL`.

| Step | Result |
| --- | --- |
| Block A pre-check | rc 0, 11 PASS, 0 FAIL, PRECHECK_OK. |
| Block B apply | rc 0, APPLY_OK, 0 error lines (20 migration files, highest 0020). |
| Block C post-check | rc 0, 39 PASS, 0 FAIL, POSTCHECK_OK. |
| Block B again, then block C | APPLY_OK (idempotent), then 39 PASS, POSTCHECK_OK. |
| Negative arm: block A after the apply | rc 1, PRECHECK_FAIL with 2 FAIL: the two functions exist, the trigger exists. |
| Rollback 0020 | rc 0, ROLLBACK_0020_OK. Block C then failed closed (rc 1, "FAIL the 0020 functions are missing", POSTCHECK_FAIL); the public function count went back to 31 and the loads triggers to 4 (the 0019 state); block A gave PRECHECK_OK (11 PASS). Block B restored 0020 and block C gave 39 PASS, POSTCHECK_OK. |
| Negative arm: a real staff edit after the apply | The staff_admin (simulated session) changed the PO of the booked TEST load: ONE event "Details edited: PO number: TEST-R2 to TEST-R2-EDITED", actor the admin, booked = booked. Block C: rc 1, 2 FAIL (load_events count, "no Details edited event yet"). Reverted (event and PO), block C green again. |
| Negative arm: `grant execute` on `dlv_fmt_slot` to anon | Block C: rc 1, 2 FAIL (no client role may execute, anon executes a function). Revoked, green again. |
| Negative arm: the trigger disabled | Block C: rc 1, 1 FAIL (the trigger check). Enabled, block C 39 PASS, POSTCHECK_OK. |
| Functional rules of 0020 | Not part of the blocks. supabase/tests/rls.sql section 20 (41 checks: staff_admin and staff_csr edits with exact notes, customer, carrier, service role, no change updates, the ITS and status functions, the 1000 character cut, the delete of an original, the catalog, a second apply of the real file) and e2e/staff-edit.spec.ts. 4 database mutations were each caught by rls.sql. |

## Production result

Owner approval (2026-10-20, verbatim): "yes, apply the migrations when ready". Run by the engineering assistant on 2026-10-20 (UTC). Before production, every block of this pack was rerun verbatim against a separate LOCAL rehearsal database (127.0.0.1:59322, migrations 0001 to 0018 plus production like rows: 1 staff_admin, 1 Mitrex customer, 1 carrier owner, 6 loads in six statuses) under `env -i` with no production value: pre-check OK, apply OK, apply again OK, post-check OK, rollback OK, post-check FAIL as designed, pre-check OK, apply OK, post-check OK. Production ran with `DLV_APPLY_DIR=<fresh dir> zsh -f -c 'set -o allexport; source ~/.zshenvmitrex; set +o allexport; zsh -f <block file>'` from a scratch folder whose `supabase` entry links to the PR head's supabase folder.

| Step | Result |
| --- | --- |
| Files | 0020_staff_edit_audit.sql from PR #39 (head 97120e1) |
| Block A pre-check | 11 PASS, PRECHECK_OK |
| Block B apply | APPLY_OK 2026-10-20T21:10:29Z |
| Block C post-check | 39 PASS, 0 FAIL, POSTCHECK_OK |
| Interruptions | The first post-check run was cut by the same pooler SSL blip after 34 PASS (read only); the rerun gave 39 PASS, POSTCHECK_OK. |
| Merge and deploy | Branch updated with `git merge -s ours` of main after #38 (tree unchanged, no force push), base moved to main; #39 squash merged 2026-10-21 as 2552b6a; production deploy 2552b6a success; /api/health {"ok":true}, /login 200. |
