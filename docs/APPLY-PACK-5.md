# Apply pack 5: migration 0014 (admin delete of loads) to production

For a SEPARATE, owner supervised production session. Nothing in this pack was run against production. It was
rehearsed against the local stack only (see "Rehearsal result"). Production holds migrations 0001 to 0013 (packs 2, 3 and 4).

More migrations will be appended to this pack by later cards. The file list in section 1 and the `files=( ... )`
array at the top of block B are the only places that name migrations; every count and "highest number"
check is derived from that list (see "Extending this pack"). Do not edit block logic to add a migration.

Rules for the session
- The owner runs every block. Do not paste a connection string, key or password anywhere. Blocks print counts and PASS or FAIL only.
- Run in a quiet window (no carrier or customer actions). The post-check compares row counts with the pre-check, so live traffic between the two shows as a FAIL to investigate, not as a silent pass.
- Every block is zsh and runs inside a subshell `( ... )`, so a failure ends the block and never closes your terminal. Each block exits non-zero on failure and prints its own verdict. No block relies on `set -e`.
- Blocks keep state in `$DLV_APPLY_DIR` (default `~/dlv-apply-5`, mode 700). The state file holds counts and 0/1 flags only. No secrets.
- 0014 deletes nothing and changes no existing row. The delete itself only happens later, when an admin uses the button in the app. That action cannot be undone: only the weekly backup can bring a deleted load back (see docs/RUNBOOK.md).

## 1. Migrations not yet in production (in order)

| File | What it does | Risk |
| --- | --- | --- |
| 0014_admin_delete_loads.sql | Admin only permanent delete of a load (DLV-027, R38). Catalog check first: exactly two foreign keys reference `loads` (`load_events`, `load_documents`), both ON DELETE CASCADE, and no DELETE trigger exists on those three tables, so nothing else can block a delete and no other table needs handling. Adds the table `load_deletions` (minimal audit record: request ref, ITS number, last status, deleted_by, deleted_at, orphan_paths; no foreign keys; RLS on; SELECT for an active staff_admin only; no client insert, update or delete). Adds `delete_load_forever(uuid, text)` (SECURITY DEFINER, search_path pinned, EXECUTE for authenticated only; requires an active staff_admin, locks the load row, requires the typed text to equal the ITS number when set, otherwise the request ref, writes the audit row, deletes the load, cascade removes events and document rows, returns the storage paths of its documents) and `record_load_deletion_orphans(uuid, text[])` (same grants, admin only, appends storage paths that could not be removed to the audit row of a load that no longer exists). No general DELETE privilege and no DELETE policy on `loads`: the function is the only path. | Low. One new empty table and two new functions, nothing existing is altered, no row is read or written. Idempotent (IF NOT EXISTS, CREATE OR REPLACE, grants restated by name). Rolling back means section 5 (it drops the audit table and its rows; deleted loads stay deleted). |

## 2. Order of operations: migration first, then the app

Recommendation: apply 0014 first, then deploy the app from main straight away.

Reasons
1. 0014 is purely additive and backward compatible. The app that is live now never touches `load_deletions` or the two functions, so nothing a user can see changes between the apply and the deploy.
2. The new app needs 0014: without it the "Delete this load forever" button calls a function that does not exist yet and answers "The load could not be deleted. Nothing was changed." (nothing is deleted). So deploying the app first is also safe, but the button would not work until the apply.
3. If the migration fails, nothing user visible has changed yet and the app is untouched.

What the new app needs from 0014
- The function `delete_load_forever` (the Danger zone card on /admin/loads/[id], staff_admin only) and `record_load_deletion_orphans` (used when a stored file cannot be removed).
- The table `load_deletions` (the audit record). Storage files are removed by the app with the service role key it already has for user management; no new environment variable.

## 3. Pre-check (read only)

Session setup. Run this in the terminal you will use for every block below. It loads DATABASE_URL_DIRECT without printing it.

```
set -o allexport; source ~/.zshenvmitrex; set +o allexport
cd ~/Documents/Projects/GitHub/Mitrex-DLV && git fetch origin && git checkout feat/dlv-027-admin-delete-loads
```

(If this branch was merged, `git checkout main && git pull` instead. The migration files must be exactly the ones listed above.)

Block A, pre-check. Read only: every statement runs with `default_transaction_read_only = on`, so it cannot change data even by mistake.

```zsh
# BLOCK precheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-5}"
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
  for t in loads profiles load_events load_documents locations customers carriers location_requests; do
    v=$(q <<SQL
select count(*) from public.$t;
SQL
    ) || { echo "FAIL: count $t"; exit 1; }
    rec "PRE_count_$t" "$v"
  done

  echo "--- loads by status (before, informational, compared after)"
  for s in requested booked at_pickup loading enroute at_delivery delivered cancelled; do
    v=$(q <<SQL
select count(*) from public.loads where status = '$s';
SQL
    ) || { echo "FAIL: count status $s"; exit 1; }
    rec "PRE_status_$s" "$v"
  done
  print -r -- "  (informational: loads and documents that exist now stay exactly as they are; 0014 deletes nothing)"

  echo "--- production migration state is 0001 to 0013"
  v=$(q <<'SQL'
select count(*) from pg_tables where schemaname = 'public';
SQL
  ) || exit 1; need "8 public tables" "$v" "8"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity;
SQL
  ) || exit 1; need "RLS enabled on all 8 tables" "$v" "8"; rec PRE_rls_tables "$v"
  v=$(q <<'SQL'
select (to_regprocedure('public.set_load_status(uuid, public.load_status, timestamptz, text)') is not null
    and to_regprocedure('public.set_load_eta(uuid, timestamptz, text)') is not null
    and to_regprocedure('public.dlv_can_access_doc(text, boolean)') is not null
    and to_regprocedure('public.dlv_loads_before_insert()') is not null
    and to_regprocedure('public.dlv_loads_before_update()') is not null)::int;
SQL
  ) || exit 1; need "0002 functions present" "$v" "1"
  v=$(q <<'SQL'
select count(*) from storage.buckets where id = 'documents' and not public;
SQL
  ) || exit 1; need "private documents bucket exists (0004)" "$v" "1"
  v=$(q <<'SQL'
select (to_regclass('public.load_documents_storage_path_uq') is not null)::int;
SQL
  ) || exit 1; need "0006 unique index on load_documents(storage_path)" "$v" "1"
  v=$(q <<'SQL'
select count(*) from pg_constraint where conname = 'load_documents_path_ck' and convalidated and position('{2,5}' in pg_get_constraintdef(oid)) > 0;
SQL
  ) || exit 1; need "0007 strict path CHECK present and validated" "$v" "1"
  v=$(q <<'SQL'
select (to_regprocedure('public.dlv_profiles_last_admin_guard()') is not null)::int;
SQL
  ) || exit 1; need "0008 last admin guard function" "$v" "1"
  v=$(q <<'SQL'
select count(*) from information_schema.columns where table_schema = 'public' and column_name = 'updated_at'
   and table_name in ('locations','carriers','customers','profiles','location_requests');
SQL
  ) || exit 1; need "0009 updated_at on the 5 tables" "$v" "5"
  v=$(q <<'SQL'
select count(*) from pg_trigger where not tgisinternal and tgenabled = 'O' and (tgrelid, tgname) in (
  ('public.loads'::regclass, 'loads_status_event'),
  ('public.loads'::regclass, 'loads_after_insert'));
SQL
  ) || exit 1; need "0010 triggers (status event and insert event) enabled" "$v" "2"
  v=$(q <<'SQL'
select (pg_get_functiondef('public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure) !~* 'POD document is required')::int;
SQL
  ) || exit 1; need "0011 set_load_status has no POD requirement" "$v" "1"
  v=$(q <<'SQL'
select (position('''enroute'',''at_delivery'',''delivered''' in pg_get_functiondef('public.dlv_can_access_doc(text, boolean)'::regprocedure)) > 0)::int;
SQL
  ) || exit 1; need "0011 dlv_can_access_doc lets a carrier write a POD while delivered" "$v" "1"
  v=$(q <<'SQL'
select count(*) from pg_constraint where conrelid = 'public.loads'::regclass and contype = 'c' and convalidated
   and pg_get_constraintdef(oid) like '%equipment_size%' and pg_get_constraintdef(oid) not like '%48%';
SQL
  ) || exit 1; need "0012 equipment_size CHECK (no 48 ft) present and validated" "$v" "1"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('select'),('insert'),('update'),('delete'),('truncate'),('references'),('trigger')) p(priv)
 where n.nspname = 'public' and c.relkind in ('r','v','m','p') and has_table_privilege('anon', c.oid, p.priv);
SQL
  ) || exit 1; need "anon holds zero table grants (before)" "$v" "0"; rec PRE_anon_table_grants "$v"

  echo "--- 0013 its load number is present (this pack starts after pack 4)"
  v=$(q <<'SQL'
select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'loads'
   and column_name = 'its_load_number' and data_type = 'text' and is_nullable = 'YES';
SQL
  ) || exit 1; need "loads.its_load_number exists, text, nullable" "$v" "1"
  v=$(q <<'SQL'
select count(*) from pg_constraint where conname = 'loads_its_load_number_format' and conrelid = 'public.loads'::regclass and convalidated;
SQL
  ) || exit 1; need "format CHECK loads_its_load_number_format present and validated" "$v" "1"
  v=$(q <<'SQL'
select count(*) from pg_indexes where schemaname = 'public' and indexname = 'loads_its_load_number_key';
SQL
  ) || exit 1; need "partial UNIQUE index loads_its_load_number_key present" "$v" "1"
  v=$(q <<'SQL'
select (to_regprocedure('public.set_its_load_number(uuid, text)') is not null
    and position('enter the ITS load number before booking' in pg_get_functiondef('public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure)) > 0)::int;
SQL
  ) || exit 1; need "set_its_load_number exists and set_load_status carries the ITS rule" "$v" "1"
  v=$(q <<'SQL'
select count(*) from public.loads where its_load_number is not null;
SQL
  ) || exit 1; rec PRE_its_numbers "$v"

  echo "--- nothing of 0014 exists yet (must be absent)"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'load_deletions';
SQL
  ) || exit 1; need "no table named load_deletions" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('delete_load_forever', 'record_load_deletion_orphans');
SQL
  ) || exit 1; need "no function named delete_load_forever or record_load_deletion_orphans" "$v" "0"
  v=$(q <<'SQL'
select (has_table_privilege('authenticated', 'public.loads', 'delete') or has_table_privilege('anon', 'public.loads', 'delete'))::int;
SQL
  ) || exit 1; need "no client role holds DELETE on loads (before)" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_policy where polrelid = 'public.loads'::regclass and polcmd in ('d', '*');
SQL
  ) || exit 1; need "no DELETE or ALL policy on loads (before)" "$v" "0"
  echo "--- foreign keys that reference loads (read from the catalog, not assumed)"
  v=$(q <<'SQL'
select count(*) from pg_constraint where confrelid = 'public.loads'::regclass and contype = 'f';
SQL
  ) || exit 1; need "exactly two foreign keys reference loads (load_events, load_documents)" "$v" "2"
  v=$(q <<'SQL'
select count(*) from pg_constraint where confrelid = 'public.loads'::regclass and contype = 'f' and confdeltype = 'c'
   and conrelid in ('public.load_events'::regclass, 'public.load_documents'::regclass);
SQL
  ) || exit 1; need "both of them are ON DELETE CASCADE" "$v" "2"
  v=$(q <<'SQL'
select count(*) from pg_trigger where not tgisinternal and tgrelid in ('public.loads'::regclass, 'public.load_events'::regclass, 'public.load_documents'::regclass)
   and (tgtype & 8) = 8;
SQL
  ) || exit 1; need "no DELETE trigger on loads, load_events or load_documents" "$v" "0"

  echo "--- other facts recorded for the post-check"
  v=$(q <<'SQL'
select count(*) from public.profiles where role = 'staff_admin' and is_active;
SQL
  ) || exit 1; rec PRE_active_admins "$v"
  [[ "$v" -ge 1 ]] || { echo "FAIL: no active staff_admin in production (investigate before applying)"; bad=1; }
  v=$(q <<'SQL'
select count(*) from pg_policies where schemaname in ('public','storage');
SQL
  ) || exit 1; rec PRE_policies "$v"
  v=$(q <<'SQL'
select count(*) from public.loads where load_number !~ '^MTX-[0-9]+$';
SQL
  ) || exit 1; rec PRE_loads_unusual_request_ref "$v"

  if [[ $bad -ne 0 ]]; then print -r -- "PRECHECK_RESULT=FAIL" >> "$STATE"; echo "PRECHECK_FAIL (do not apply)"; exit 1; fi
  print -r -- "PRECHECK_RESULT=OK" >> "$STATE" || exit 1
  echo "PRECHECK_OK (state saved in $STATE)"
)
```

Stop here unless it printed `PRECHECK_OK`. A FAIL on "0001 to 0013 state" means an earlier pack is not fully applied: do not apply 0014. A FAIL on "must be absent" means something of 0014 already exists: stop and investigate (do not run block B). A FAIL on "exactly two foreign keys reference loads" means a table was added since this pack was written: stop, because that table could block or survive a delete. The load, document and ITS counts are informational.

## 4. Apply

Block B. One transaction per migration (`--single-transaction`), stops at the first failure, full transcript in `apply-transcript-5.txt` (repo root, it contains no connection string). The migration list and the expected highest number live in the `files` array.

```zsh
# BLOCK apply
(
  setopt pipefail
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-5}"
  [[ -f "$DIR/state.env" ]] || { echo "FAIL: run the pre-check (block A) first"; exit 1; }
  grep -qx 'PRECHECK_RESULT=OK' "$DIR/state.env" || { echo "FAIL: the last pre-check (block A) did not end in PRECHECK_OK. Do not apply. Fix the cause and run block A again."; exit 1; }
  files=(
    0014_admin_delete_loads.sql
  )
  for f in $files; do
    [[ -f "supabase/migrations/$f" ]] || { echo "FAIL: missing supabase/migrations/$f (run from the repo root)"; exit 1; }
  done
  last="${files[-1]%%_*}"
  highest=$(ls supabase/migrations | grep '^[0-9]' | sort | tail -1)
  [[ "${highest%%_*}" == "$last" ]] || { echo "FAIL: the highest migration file is ${highest%%_*} but the last file in this pack is $last"; exit 1; }
  count=$(ls supabase/migrations | grep -c '^[0-9]')
  [[ "$count" -eq $((10#$last)) ]] || { echo "FAIL: expected $((10#$last)) migration files (0001 to $last, none missing), found $count"; exit 1; }
  print -r -- "apply started $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-5.txt
  for f in $files; do
    print -r -- "=== $f" | tee -a apply-transcript-5.txt
    psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f "supabase/migrations/$f" 2>&1 | tee -a apply-transcript-5.txt || { echo "APPLY_FAIL at $f (that file was rolled back as one transaction; earlier files stay applied; see section 5)"; exit 1; }
  done
  print -r -- "APPLY_OK $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-5.txt
)
```

If a block fails midway: the failing file is one transaction, so it left nothing behind. Earlier files stay applied. Fix the cause and run block B again (the file is idempotent).

## 5. Rollback notes (per migration)

Every migration runs as one transaction, so a failure inside a file undoes that whole file. These are only for undoing a file that APPLIED and that you then decide to back out. Do not run any of this against production without the owner's explicit go. Reuse `$DATABASE_URL_DIRECT`.

- 0014: drops the two functions and the table `load_deletions`, as ONE transaction. WARNING: the audit rows go with the table, and loads an admin already deleted stay deleted (a rollback cannot bring them back; only the weekly backup can). The block refuses to run while `load_deletions` holds rows unless `DLV_ALLOW_AUDIT_LOSS=1` is exported. Run it together with a rollback of the app to a build without the Danger zone card, and only with the owner's explicit go. Nothing else is touched: 0014 changed no existing object.

```zsh
# BLOCK rollback-0014
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  n=$(echo "select count(*) from public.load_deletions;" | psql "$DATABASE_URL_DIRECT" -X -A -t -q -v ON_ERROR_STOP=1 -f -) || { echo "FAIL: cannot count load_deletions (is 0014 applied?)"; exit 1; }
  if [[ "$n" != "0" && "$DLV_ALLOW_AUDIT_LOSS" != "1" ]]; then
    echo "FAIL: load_deletions holds $n audit row(s). Rolling back 0014 drops them for good. Export DLV_ALLOW_AUDIT_LOSS=1 only with the owner's explicit go."
    exit 1
  fi
  psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f - <<'SQL' || exit 1
drop function if exists public.record_load_deletion_orphans(uuid, text[]);
drop function if exists public.delete_load_forever(uuid, text);
drop table if exists public.load_deletions;
SQL
  echo ROLLBACK_0014_OK
)
```

## 6. Post-check (read only)

Block C. Expected values come from the same run: the counts saved by block A are compared with fresh counts. Checks that belong to a file in the pack are grouped under that file's number so a later card can add its own group. Every pack 4 assertion (0013, 0011, 0012, pack 2 objects, security posture) is repeated and must still hold; the only expected differences are the new table (RLS table count and policy count each go up by exactly one).

```zsh
# BLOCK postcheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-5}"
  STATE="$DIR/state.env"
  [[ -f "$STATE" ]] || { echo "FAIL: no state file, run block A before the apply"; exit 1; }
  source "$STATE" || exit 1
  q() { { echo "set default_transaction_read_only = on;"; cat; } | psql "$DATABASE_URL_DIRECT" -X -A -t -q -v ON_ERROR_STOP=1 -f - ; }
  bad=0
  need() { if [[ "$2" == "$3" ]]; then print -r -- "PASS $1"; else print -r -- "FAIL $1 (got $2, want $3)"; bad=1; fi; }
  FN="'public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure"
  ITS="to_regprocedure('public.set_its_load_number(uuid, text)')"  # NULL when absent, so a missing function is a FAIL line, not a crash

  echo "--- row counts unchanged"
  for t in loads profiles load_events load_documents locations customers carriers location_requests; do
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
  v=$(q <<'SQL'
select count(*) from public.loads where its_load_number is not null;
SQL
  ) 2>/dev/null || v="query failed (is the column missing?)"; need "ITS numbers unchanged (0014 writes none)" "$v" "$PRE_its_numbers"

  echo "--- 0014 admin delete of loads"
  DEL="to_regprocedure('public.delete_load_forever(uuid, text)')"   # NULL when absent: a FAIL line, not a crash
  REC="to_regprocedure('public.record_load_deletion_orphans(uuid, text[])')"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'load_deletions' and c.relkind = 'r' and c.relrowsecurity;
SQL
  ) || exit 1; need "load_deletions exists with RLS enabled" "$v" "1"
  v=$(q <<'SQL'
select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'load_deletions' and
  ((column_name = 'id' and data_type = 'uuid' and is_nullable = 'NO')
or (column_name = 'load_id' and data_type = 'uuid' and is_nullable = 'NO')
or (column_name = 'request_ref' and data_type = 'text' and is_nullable = 'NO')
or (column_name = 'its_load_number' and data_type = 'text' and is_nullable = 'YES')
or (column_name = 'last_status' and udt_name = 'load_status' and is_nullable = 'YES')
or (column_name = 'deleted_by' and data_type = 'uuid' and is_nullable = 'YES')
or (column_name = 'deleted_at' and data_type = 'timestamp with time zone' and is_nullable = 'NO')
or (column_name = 'orphan_paths' and data_type = 'ARRAY' and is_nullable = 'NO'));
SQL
  ) || exit 1; need "load_deletions has the 8 columns with the agreed types and nullability" "$v" "8"
  v=$(q <<'SQL'
select count(*) from pg_constraint where conrelid = 'public.load_deletions'::regclass and contype = 'f';
SQL
  ) 2>/dev/null || v="query failed (is the table missing?)"; need "load_deletions has no foreign key (a removed user or load never blocks)" "$v" "0"
  v=$(q <<'SQL'
select count(*) from public.load_deletions;
SQL
  ) 2>/dev/null || v="query failed (is the table missing?)"; need "load_deletions is empty after the apply (0014 writes no audit rows)" "$v" "0"
  v=$(q <<'SQL'
select (to_regclass('public.load_deletions') is not null
    and not has_table_privilege('anon', 'public.load_deletions', 'select')
    and not has_table_privilege('anon', 'public.load_deletions', 'insert')
    and has_table_privilege('authenticated', 'public.load_deletions', 'select')
    and not has_table_privilege('authenticated', 'public.load_deletions', 'insert')
    and not has_table_privilege('authenticated', 'public.load_deletions', 'update')
    and not has_table_privilege('authenticated', 'public.load_deletions', 'delete')
    and not has_table_privilege('authenticated', 'public.load_deletions', 'truncate'))::int;
SQL
  ) 2>/dev/null || v="query failed (is the table missing?)"; need "load_deletions: select only for authenticated, no client insert, update or delete, nothing for anon" "$v" "1"
  v=$(q <<'SQL'
select count(*) from pg_policy where polrelid = 'public.load_deletions'::regclass and polcmd = 'r' and pg_get_expr(polqual, polrelid) like '%dlv_is_admin%';
SQL
  ) 2>/dev/null || v="query failed (is the table missing?)"; need "one SELECT policy, staff_admin only (dlv_is_admin)" "$v" "1"
  v=$(q <<'SQL'
select count(*) from pg_policy where polrelid = 'public.load_deletions'::regclass;
SQL
  ) 2>/dev/null || v="query failed (is the table missing?)"; need "load_deletions has no other policy (no client write policy)" "$v" "1"
  v=$(q <<SQL
select (to_regprocedure('public.delete_load_forever(uuid, text)') is not null
    and (select p.prosecdef from pg_proc p where p.oid = $DEL)
    and exists (select 1 from pg_proc p, unnest(p.proconfig) c where p.oid = $DEL and c like 'search_path=%')
    and position('dlv_is_admin' in pg_get_functiondef($DEL)) > 0
    and position('confirmation does not match' in pg_get_functiondef($DEL)) > 0
    and position('for update' in lower(pg_get_functiondef($DEL))) > 0
    and position('insert into public.load_deletions' in pg_get_functiondef($DEL)) > 0
    and position('delete from public.loads' in pg_get_functiondef($DEL)) > 0)::int;
SQL
  ) || exit 1; need "delete_load_forever exists, SECURITY DEFINER, search_path pinned, admin check, confirmation check, row lock, audit insert, delete" "$v" "1"
  v=$(q <<SQL
select (to_regprocedure('public.record_load_deletion_orphans(uuid, text[])') is not null
    and (select p.prosecdef from pg_proc p where p.oid = $REC)
    and exists (select 1 from pg_proc p, unnest(p.proconfig) c where p.oid = $REC and c like 'search_path=%')
    and position('dlv_is_admin' in pg_get_functiondef($REC)) > 0
    and position('load still exists' in pg_get_functiondef($REC)) > 0)::int;
SQL
  ) || exit 1; need "record_load_deletion_orphans exists, SECURITY DEFINER, search_path pinned, admin check, refuses a load that still exists" "$v" "1"
  v=$(q <<SQL
select (has_function_privilege('authenticated', $DEL, 'execute')
    and not has_function_privilege('anon', $DEL, 'execute')
    and has_function_privilege('authenticated', $REC, 'execute')
    and not has_function_privilege('anon', $REC, 'execute')
    and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     where p.oid in ($DEL, $REC) and a.grantee = 0 and a.privilege_type = 'EXECUTE'))::int;
SQL
  ) || exit 1; need "both functions: EXECUTE for authenticated, not for anon, not for PUBLIC" "$v" "1"
  v=$(q <<'SQL'
select (has_table_privilege('authenticated', 'public.loads', 'delete') or has_table_privilege('anon', 'public.loads', 'delete'))::int;
SQL
  ) || exit 1; need "no client role holds DELETE on loads (the function is the only path)" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_policy where polrelid = 'public.loads'::regclass and polcmd in ('d', '*');
SQL
  ) || exit 1; need "no DELETE or ALL policy on loads" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_constraint where confrelid = 'public.loads'::regclass and contype = 'f' and confdeltype = 'c';
SQL
  ) || exit 1; need "the two foreign keys referencing loads are still ON DELETE CASCADE" "$v" "2"
  v=$(q <<'SQL'
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('delete_load_forever', 'record_load_deletion_orphans')
   and has_function_privilege('anon', p.oid, 'execute');
SQL
  ) || exit 1; need "anon can EXECUTE neither new function" "$v" "0"

  echo "--- 0013 its load number (pack 4 assertions, unchanged by 0014)"
  v=$(q <<'SQL'
select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'loads'
   and column_name = 'its_load_number' and data_type = 'text' and is_nullable = 'YES';
SQL
  ) || exit 1; need "loads.its_load_number exists, text, nullable" "$v" "1"
  v=$(q <<'SQL'
select count(*) from pg_constraint where conname = 'loads_its_load_number_format' and conrelid = 'public.loads'::regclass
   and convalidated and position('[0-9]+' in pg_get_constraintdef(oid)) > 0 and position('-' in pg_get_constraintdef(oid)) > 0
   and position('30' in pg_get_constraintdef(oid)) > 0;
SQL
  ) || exit 1; need "format CHECK exists, is validated, digits with an optional dash and digits, at most 30 characters" "$v" "1"
  v=$(q <<'SQL'
select count(*) from pg_indexes where schemaname = 'public' and tablename = 'loads' and indexname = 'loads_its_load_number_key'
   and indexdef ilike '%unique%' and indexdef like '%(its_load_number)%' and indexdef ilike '%where%';
SQL
  ) || exit 1; need "partial UNIQUE index on its_load_number exists" "$v" "1"
  v=$(q <<'SQL'
select count(*) from public.loads where load_number is null or load_number !~ '^MTX-[0-9]+$';
SQL
  ) || exit 1; need "request refs in load_number unchanged in shape (same count of unusual refs as before)" "$v" "$PRE_loads_unusual_request_ref"
  v=$(q <<SQL
select (to_regprocedure('public.set_its_load_number(uuid, text)') is not null
    and (select p.prosecdef from pg_proc p where p.oid = $ITS)
    and position('dlv_is_staff' in pg_get_functiondef($ITS)) > 0
    and position('dlv.its_fn' in pg_get_functiondef($ITS)) > 0
    and position('already used by another load' in pg_get_functiondef($ITS)) > 0
    and position('too long' in pg_get_functiondef($ITS)) > 0)::int;
SQL
  ) || exit 1; need "set_its_load_number exists, is SECURITY DEFINER, staff only, logs, refuses duplicates" "$v" "1"
  v=$(q <<SQL
select (has_function_privilege('authenticated', $ITS, 'execute')
    and not has_function_privilege('anon', $ITS, 'execute')
    and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     where p.oid = $ITS and a.grantee = 0 and a.privilege_type = 'EXECUTE'))::int;
SQL
  ) || exit 1; need "set_its_load_number: EXECUTE for authenticated, not for anon, not for PUBLIC" "$v" "1"
  v=$(q <<SQL
select (position('enter the ITS load number before booking' in pg_get_functiondef($FN)) > 0
    and position('its_load_number is null' in pg_get_functiondef($FN)) > 0)::int;
SQL
  ) || exit 1; need "set_load_status contains the new ITS rule" "$v" "1"
  v=$(q <<'SQL'
select (position('its_load_number' in pg_get_functiondef('public.dlv_loads_before_insert()'::regprocedure)) > 0
    and position('set_its_load_number' in pg_get_functiondef('public.dlv_loads_before_update()'::regprocedure)) > 0)::int;
SQL
  ) || exit 1; need "loads insert guard nulls a customer ITS number, update guard refuses direct changes" "$v" "1"

  echo "--- 0011 pod optional (unchanged by 0013)"
  v=$(q <<SQL
select (pg_get_functiondef($FN) !~* 'POD document is required' and pg_get_functiondef($FN) !~* 'load_documents')::int;
SQL
  ) || exit 1; need "set_load_status still has no POD requirement" "$v" "1"
  v=$(q <<SQL
select (position('dlv.event_note' in pg_get_functiondef($FN)) > 0
    and pg_get_functiondef($FN) !~* 'insert into public[.]load_events'
    and position('a note is required for a staff override' in pg_get_functiondef($FN)) > 0
    and position('carriers move forward one step at a time' in pg_get_functiondef($FN)) > 0
    and position('delivered loads are final' in pg_get_functiondef($FN)) > 0
    and position('assign a carrier before booking' in pg_get_functiondef($FN)) > 0
    and position('eta is required for enroute' in pg_get_functiondef($FN)) > 0)::int;
SQL
  ) || exit 1; need "set_load_status keeps every earlier rule (event note, override note, one step, final, carrier, eta)" "$v" "1"
  v=$(q <<'SQL'
select (position('''enroute'',''at_delivery'',''delivered''' in pg_get_functiondef('public.dlv_can_access_doc(text, boolean)'::regprocedure)) > 0
    and position('v_kind = ''pod''' in pg_get_functiondef('public.dlv_can_access_doc(text, boolean)'::regprocedure)) > 0
    and position('{2,5}' in pg_get_functiondef('public.dlv_can_access_doc(text, boolean)'::regprocedure)) > 0
    and position('(bol|pod)' in pg_get_functiondef('public.dlv_can_access_doc(text, boolean)'::regprocedure)) > 0)::int;
SQL
  ) || exit 1; need "dlv_can_access_doc: carrier POD rule and strict path regex intact" "$v" "1"
  v=$(q <<SQL
select (has_function_privilege('authenticated', $FN, 'execute') and not has_function_privilege('anon', $FN, 'execute'))::int;
SQL
  ) || exit 1; need "set_load_status: authenticated yes, anon no" "$v" "1"

  echo "--- 0012 equipment sizes (unchanged)"
  v=$(q <<'SQL'
select count(*) from pg_constraint where conname = 'loads_equipment_size_check' and conrelid = 'public.loads'::regclass
   and convalidated and pg_get_constraintdef(oid) like '%26%' and pg_get_constraintdef(oid) like '%36%'
   and pg_get_constraintdef(oid) like '%53%' and pg_get_constraintdef(oid) not like '%48%';
SQL
  ) || exit 1; need "loads_equipment_size_check exists, validated, allows 26 36 53 and not 48" "$v" "1"

  echo "--- earlier migrations (pack 2) still in place"
  v=$(q <<'SQL'
select (to_regprocedure('public.dlv_profiles_last_admin_guard()') is not null and to_regprocedure('public.dlv_loads_status_event()') is not null)::int;
SQL
  ) || exit 1; need "functions dlv_profiles_last_admin_guard and dlv_loads_status_event" "$v" "1"
  v=$(q <<'SQL'
select count(*) from pg_trigger where not tgisinternal and tgenabled = 'O' and (tgrelid, tgname) in (
  ('public.profiles'::regclass, 'profiles_last_admin_guard_update'),
  ('public.profiles'::regclass, 'profiles_last_admin_guard_delete'));
SQL
  ) || exit 1; need "last-admin triggers (update and delete) enabled" "$v" "2"
  v=$(q <<'SQL'
select count(*) from pg_trigger where not tgisinternal and tgenabled = 'O' and (tgrelid, tgname) in (
  ('public.loads'::regclass, 'loads_status_event'),
  ('public.loads'::regclass, 'loads_after_insert'),
  ('public.loads'::regclass, 'loads_before_insert'),
  ('public.loads'::regclass, 'loads_before_update'),
  ('public.locations'::regclass, 'locations_touch_updated_at'),
  ('public.carriers'::regclass, 'carriers_touch_updated_at'),
  ('public.customers'::regclass, 'customers_touch_updated_at'),
  ('public.profiles'::regclass, 'profiles_touch_updated_at'),
  ('public.location_requests'::regclass, 'location_requests_touch_updated_at'));
SQL
  ) || exit 1; need "loads guards, status event, insert event and 5 touch triggers enabled" "$v" "9"
  v=$(q <<'SQL'
select (to_regclass('public.load_documents_storage_path_uq') is not null)::int;
SQL
  ) || exit 1; need "unique index load_documents_storage_path_uq" "$v" "1"
  v=$(q <<'SQL'
select count(*) from pg_constraint where conname = 'load_documents_path_ck' and convalidated and position('{2,5}' in pg_get_constraintdef(oid)) > 0;
SQL
  ) || exit 1; need "load_documents_path_ck present, validated, strict shape" "$v" "1"
  v=$(q <<'SQL'
select (position('insert into public.load_events' in lower(pg_get_functiondef('public.set_load_eta(uuid, timestamptz, text)'::regprocedure))) > 0)::int;
SQL
  ) || exit 1; need "set_load_eta still writes its own event" "$v" "1"

  echo "--- security posture unchanged"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity;
SQL
  ) || exit 1; need "RLS enabled on every public table (the 8 before plus load_deletions)" "$v" "$((PRE_rls_tables + 1))"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
SQL
  ) || exit 1; need "no public table without RLS" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('select'),('insert'),('update'),('delete'),('truncate'),('references'),('trigger')) p(priv)
 where n.nspname = 'public' and c.relkind in ('r','v','m','p') and has_table_privilege('anon', c.oid, p.priv);
SQL
  ) || exit 1; need "anon table grants unchanged (zero)" "$v" "$PRE_anon_table_grants"
  v=$(q <<'SQL'
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('dlv_profiles_last_admin_guard','dlv_loads_status_event','dlv_touch_updated_at','dlv_locations_before_update','dlv_loads_before_insert','dlv_loads_before_update')
   and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
SQL
  ) || exit 1; need "no client role can EXECUTE the trigger functions" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute');
SQL
  ) || exit 1; need "anon can EXECUTE no function in public" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_policies where schemaname in ('public','storage');
SQL
  ) || exit 1; need "policy count is the old count plus the one load_deletions policy" "$v" "$((PRE_policies + 1))"
  v=$(q <<'SQL'
select count(*) from public.profiles where role = 'staff_admin' and is_active;
SQL
  ) || exit 1; need "active staff_admin count unchanged" "$v" "$PRE_active_admins"
  v=$(q <<'SQL'
select count(*) from storage.buckets where id = 'documents' and not public and file_size_limit = 15728640
   and allowed_mime_types @> array['application/pdf','image/png','image/jpeg','image/webp','image/heic']
   and allowed_mime_types <@ array['application/pdf','image/png','image/jpeg','image/webp','image/heic','image/heif'];
SQL
  ) || exit 1; need "documents bucket: private, 15 MB, mime allow list" "$v" "1"

  if [[ $bad -ne 0 ]]; then echo "POSTCHECK_FAIL"; exit 1; fi
  echo "POSTCHECK_OK"
)
```

After `POSTCHECK_OK`: deploy the app from main (Vercel), then follow the "After every deploy" list in docs/RUNBOOK.md. Optional app level smoke after the deploy: sign in as chris@dlvlogistics.com, open a load: the "Danger zone" card is at the bottom; sign in as the CSR (Luca): the card is not there. Do NOT delete a real load to test it. To test the delete, create a throwaway load as Maria first and delete that one.

## Extending this pack

A later card that adds a migration (for example 0015) does exactly three things and changes no block logic:
1. Add a row to the table in section 1.
2. Append the file name to the `files=( ... )` array in block B. The "highest file equals the last file in the list" and "file count equals the highest number" checks then expect 0015 by themselves.
3. Add a group of PASS checks for the new file to block C, and any read only data check to block A. The row count, security posture and earlier migration groups stay as they are (adjust the expected RLS table and policy counts by what the new file adds).

## Rehearsal result

Rehearsed on the LOCAL stack only (127.0.0.1:54322), never production, on 2026-10-06 by the engineering assistant (DLV-027 card).

IMPORTANT LIMIT, read first: the harness this session ran in REFUSED to execute the zsh block files (every `zsh -f <file>` or `zsh -f -c 'source <file>'` attempt was rejected before it started, the same refusal pack 4 recorded). So the four blocks were NOT run verbatim under `zsh -f`. What was run instead: the blocks were extracted from this file by a script, then EVERY SQL statement in blocks A and C (all 24 and all 44 predicates, the two count loops expanded to 8 and 8 rows, 58 PASS lines in total) was run through psql read only and compared with the same expected value the block uses (a small python driver, not the shell), and block B's one command was run exactly as written (`psql --single-transaction -v ON_ERROR_STOP=1 -f supabase/migrations/0014_admin_delete_loads.sql`). The shell logic of the blocks (the subshell, `need`, `rec`, the state file, the PRECHECK_RESULT gate, the files array checks, the rollback guard on `load_deletions` rows) was NOT executed. The blocks are the pack 4 blocks, which ran against production on 2026-10-07, with SQL changes only plus the same `rec` and `need` pattern. Before the production session, run blocks A, B and C once on the local stack under `zsh -f` (`supabase db reset --last 1`, add the production-like rows, export DATABASE_URL_DIRECT to the local URL in that shell only, set DLV_APPLY_DIR to a scratch folder), as pack 4 did.

Method: `supabase_migrations.schema_migrations` was read first (14 rows, max version 0014, before the step back). `supabase db reset --last 1` then left 13 rows, max version 0013, with no load_deletions table and neither function (read back from the catalog before trusting it). Note: `--last N` undoes the last N migrations of the full set, so it equals production's state only while this pack holds exactly one file (with a second file in the pack use `--last 2`). Production-like rows were inserted at that state: 1 staff_admin, 1 customer user, 1 load (requested, 1 event). A first read of the state showed loads 1, profiles 2, load_events 1, load_documents 0, locations 19, customers 1, carriers 0, location_requests 0. Afterwards `supabase db reset` restored all fourteen migrations.

| Step | Result |
| --- | --- |
| Block A pre-check (SQL run through psql, read only) | 24 PASS, 0 FAIL. 0001 to 0013 state (8 tables, RLS 8 of 8, 0006 to 0012 objects, anon zero table grants, 0013 column, CHECK, index, function and the ITS rule in set_load_status), 0014 absent (no table, no function, no client DELETE privilege on loads, no DELETE or ALL policy on loads), exactly two foreign keys reference loads and both are ON DELETE CASCADE, no DELETE trigger on loads, load_events or load_documents. |
| Block B apply (the one command) | 0014 applied in one transaction, 0 error lines (only the expected NOTICE that the policy did not exist yet). The file and count checks of block B (14 files, highest 0014) hold: 14 files, highest 0014. |
| Block C post-check (SQL run through psql, read only) | 58 PASS, 0 FAIL (44 predicates, two of them looped over 8 tables and 8 statuses). Includes: the 8 counts and 8 per status counts unchanged, no ITS number written, load_deletions with RLS and the 8 agreed columns, no foreign key, empty, select only for authenticated and nothing for anon, one staff_admin only SELECT policy and no other, both functions SECURITY DEFINER with a pinned search_path and the admin, confirmation, row lock, audit and delete code, EXECUTE for authenticated and not for anon or PUBLIC, no DELETE privilege or policy on loads, the two cascade foreign keys intact, and every pack 4 assertion (0013, 0011, 0012, pack 2 objects, security posture with the RLS table count and policy count each plus one). |
| Re-run of B then C | 0 error lines, then 58 PASS, 0 FAIL (idempotent). |
| Negative arm: block A after the apply | 4 FAIL (do not apply): "8 public tables" got 9, "RLS enabled on all 8 tables" got 9, "no table named load_deletions" got 1, "no function named delete_load_forever or record_load_deletion_orphans" got 2. The 20 other checks PASS. |
| Negative arm: the rollback statements, then C | The three statements of block rollback-0014 (drop the two functions and the table, one transaction) ran clean. Block C then printed 12 FAIL, all in the 0014 group and the two posture counts; the 0013, 0011, 0012 and pack 2 groups stayed PASS. A, B and C again: 24 PASS, 0 errors, 58 PASS. |
| Functional rules of 0014 | Not part of the blocks. supabase/tests/rls.sql section 14 (admin deletes, csr, customer, carrier owner, driver, inactive admin and anon are refused, wrong confirmation refused, ITS number and request ref both confirm, direct DELETE refused for every client role, audit table readable by admin only, one truck of three deleted) runs on a fresh `supabase db reset` and printed `RLS_OK 575 OK / 0 VACUOUS / 0 FAIL`. Eight mutations of the migration were each caught by it. |

### Rehearsal re-run by the engineering assistant (2026-10-07)
The builder and reviewer sandboxes could not execute the zsh block files, so the blocks were run verbatim from the lead session: `supabase db reset --last 1` (journal max 0013, 13 rows), three production-like rows added (one staff admin, one customer user, one load), then blocks A, B and C extracted and run under `zsh -f` with `DATABASE_URL_DIRECT` exported to the local URL for those processes only. Result: PRECHECK_OK, APPLY_OK, POSTCHECK_OK (58 PASS), and a second run of block B was idempotent (APPLY_OK). `supabase db reset` restored all 14 migrations afterwards.

## Production result (2026-10-07)

Run by the engineering assistant under the owner's standing approval ("yes, apply the migrations when ready"). Blocks A, B and C were extracted verbatim from this file and run with `zsh -f` after loading the env file; no connection string was printed. PR #26 was merged only after the post-check passed (migrations first, then deploy).

| Step | Result |
| --- | --- |
| Block A pre-check | PRECHECK_OK. Production at 0001 to 0013, 3 loads, 2 document rows, 1 active staff_admin; load_deletions and both functions absent. |
| Block B apply | APPLY_OK at 2026-10-07T02:53:54Z. 0014 in one transaction, 0 ERROR lines. |
| Block C post-check | POSTCHECK_OK, 58 of 58 PASS: audit table with RLS and no client writes; delete_load_forever and record_load_deletion_orphans SECURITY DEFINER with EXECUTE for authenticated only; no DELETE privilege or policy on loads for clients; all pack 4 assertions and the security posture unchanged; row counts unchanged. |
