# Apply pack 4: migration 0013 (ITS load number) to production

For a SEPARATE, owner supervised production session. Nothing in this pack was run against production. It was
rehearsed against the local stack only (see "Rehearsal result"). Production holds migrations 0001 to 0012 (packs 2 and 3).

More migrations will be appended to this pack by later cards. The file list in section 1 and the `files=( ... )`
array at the top of block B and block C are the only places that name migrations; every count and "highest number"
check is derived from that list (see "Extending this pack"). Do not edit block logic to add a migration.

Rules for the session
- The owner runs every block. Do not paste a connection string, key or password anywhere. Blocks print counts and PASS or FAIL only.
- Run in a quiet window (no carrier or customer actions). The post-check compares row counts with the pre-check, so live traffic between the two shows as a FAIL to investigate, not as a silent pass.
- Every block is zsh and runs inside a subshell `( ... )`, so a failure ends the block and never closes your terminal. Each block exits non-zero on failure and prints its own verdict. No block relies on `set -e`.
- Blocks keep state in `$DLV_APPLY_DIR` (default `~/dlv-apply-4`, mode 700). The state file holds counts and 0/1 flags only. No secrets.

## 1. Migrations not yet in production (in order)

| File | What it does | Risk |
| --- | --- | --- |
| 0013_its_load_number.sql | ITS load number. Adds the nullable column `loads.its_load_number` with the CHECK `loads_its_load_number_format` (digits, optionally a dash and digits, for example 313 or 313-2) and the partial UNIQUE index `loads_its_load_number_key` (where not null). Adds `set_its_load_number(uuid, text)` (SECURITY DEFINER, staff only, trims, validates, refuses duplicates naming the other load's request ref, writes a load_events row, EXECUTE for authenticated only). Replaces `dlv_loads_before_insert` (a customer insert stores NULL) and `dlv_loads_before_update` (no direct change of its_load_number, only through the function) with the 0002 bodies plus one rule each. Replaces `set_load_status` with the 0011 body plus ONE rule: a load leaves `requested` (to anything but cancelled) only when its ITS number is set ("enter the ITS load number before booking"). | Low. Adding a nullable column is metadata only (no rewrite, no data change). Every existing load keeps its request ref in `load_number` and stays valid with a NULL ITS number; legacy booked loads still move forward (the rule applies only when the old status is requested). Idempotent (IF NOT EXISTS, CREATE OR REPLACE, grants restated). Rolling back means section 5 (and it deletes any ITS numbers entered after the apply). |

## 2. Order of operations: migration first, then the app

Recommendation: apply 0013 first, then deploy the app from main straight away.

Reasons
1. 0013 is backward compatible with the app that is live now. The old app never reads or writes `its_load_number`. The one behaviour change a live user could notice before the deploy: the OLD "Mark booked" button now fails with "enter the ITS load number before booking" for a request that has no ITS number. Run block B and the deploy back to back, and tell staff not to book in the gap.
2. The new app needs 0013: without it the booking form calls `set_its_load_number`, which does not exist yet, and every select that names the column fails. Deploying the app first would break the staff and customer load screens.
3. If the migration fails, nothing user visible has changed yet and the app is untouched.

What the new app needs from 0013 (the app does not work without it)
- The column and the function: the staff ITS number field, "Mark booked", "Edit ITS number", the board, calendar, CSV, emails, and Maria's "Number pending" then the ITS number.
- The `set_load_status` rule: the database side of "no booking without an ITS number" (the form enforces it first).

## 3. Pre-check (read only)

Session setup. Run this in the terminal you will use for every block below. It loads DATABASE_URL_DIRECT without printing it.

```
set -o allexport; source ~/.zshenvmitrex; set +o allexport
cd ~/Documents/Projects/GitHub/Mitrex-DLV && git fetch origin && git checkout feat/dlv-025-its-load-number
```

(If this branch was merged, `git checkout main && git pull` instead. The migration files must be exactly the ones listed above.)

Block A, pre-check. Read only: every statement runs with `default_transaction_read_only = on`, so it cannot change data even by mistake.

```zsh
# BLOCK precheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-4}"
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
  v=$(q <<'SQL'
select count(*) from public.loads where status not in ('requested', 'cancelled');
SQL
  ) || exit 1; rec PRE_booked_without_its "$v"
  print -r -- "  (the loads counted in PRE_booked_without_its are already booked or later and have no ITS number; they stay valid and keep moving forward, staff can add the number with Edit ITS number)"

  echo "--- production migration state is 0001 to 0012"
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

  echo "--- nothing named its_load_number exists yet (must be absent)"
  v=$(q <<'SQL'
select count(*) from information_schema.columns where table_schema = 'public' and column_name = 'its_load_number';
SQL
  ) || exit 1; need "no column named its_load_number in any public table" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('set_its_load_number', 'its_load_number');
SQL
  ) || exit 1; need "no function named set_its_load_number or its_load_number" "$v" "0"
  v=$(q <<'SQL'
select (select count(*) from pg_constraint where conname = 'loads_its_load_number_format')
     + (select count(*) from pg_indexes where schemaname = 'public' and indexname = 'loads_its_load_number_key');
SQL
  ) || exit 1; need "no CHECK or index of 0013 present" "$v" "0"
  v=$(q <<'SQL'
select (position('its_load_number' in pg_get_functiondef('public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure)) = 0
    and position('its_load_number' in pg_get_functiondef('public.dlv_loads_before_insert()'::regprocedure)) = 0
    and position('its_load_number' in pg_get_functiondef('public.dlv_loads_before_update()'::regprocedure)) = 0)::int;
SQL
  ) || exit 1; need "set_load_status and the loads guards do not mention its_load_number yet" "$v" "1"

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

Stop here unless it printed `PRECHECK_OK`. A FAIL on "0001 to 0012 state" means packs 2 or 3 are not fully applied: do not apply 0013. A FAIL on "must be absent" means something named its_load_number already exists: stop and investigate (do not run block B). The booked without ITS count is informational: those loads stay valid.

## 4. Apply

Block B. One transaction per migration (`--single-transaction`), stops at the first failure, full transcript in `apply-transcript-4.txt` (repo root, git ignored; it contains no connection string). The migration list and the expected highest number live in the `files` array.

```zsh
# BLOCK apply
(
  setopt pipefail
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-4}"
  [[ -f "$DIR/state.env" ]] || { echo "FAIL: run the pre-check (block A) first"; exit 1; }
  grep -qx 'PRECHECK_RESULT=OK' "$DIR/state.env" || { echo "FAIL: the last pre-check (block A) did not end in PRECHECK_OK. Do not apply. Fix the cause and run block A again."; exit 1; }
  files=(
    0013_its_load_number.sql
  )
  for f in $files; do
    [[ -f "supabase/migrations/$f" ]] || { echo "FAIL: missing supabase/migrations/$f (run from the repo root)"; exit 1; }
  done
  last="${files[-1]%%_*}"
  highest=$(ls supabase/migrations | grep '^[0-9]' | sort | tail -1)
  [[ "${highest%%_*}" == "$last" ]] || { echo "FAIL: the highest migration file is ${highest%%_*} but the last file in this pack is $last"; exit 1; }
  count=$(ls supabase/migrations | grep -c '^[0-9]')
  [[ "$count" -eq $((10#$last)) ]] || { echo "FAIL: expected $((10#$last)) migration files (0001 to $last, none missing), found $count"; exit 1; }
  print -r -- "apply started $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-4.txt
  for f in $files; do
    print -r -- "=== $f" | tee -a apply-transcript-4.txt
    psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f "supabase/migrations/$f" 2>&1 | tee -a apply-transcript-4.txt || { echo "APPLY_FAIL at $f (that file was rolled back as one transaction; earlier files stay applied; see section 5)"; exit 1; }
  done
  print -r -- "APPLY_OK $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-4.txt
)
```

If a block fails midway: the failing file is one transaction, so it left nothing behind. Earlier files stay applied. Fix the cause and run block B again (the file is idempotent).

## 5. Rollback notes (per migration)

Every migration runs as one transaction, so a failure inside a file undoes that whole file. These are only for undoing a file that APPLIED and that you then decide to back out. Do not run any of this against production without the owner's explicit go. Reuse `$DATABASE_URL_DIRECT`.

- 0013: the block below restores the 0011 `set_load_status` and the 0002 loads guards, then removes the function, index, CHECK and column, as ONE transaction. WARNING: dropping the column deletes every ITS load number staff entered after the apply, and the emails already sent stay sent. Only run it together with a rollback of the app to a build that does not use the ITS number, and only with the owner's explicit go. The request refs in `load_number` are untouched.

```zsh
# BLOCK rollback-0013
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  tmp=$(mktemp) || exit 1
  { sed -n '/^create or replace function public.set_load_status(/,/^\$fn\$;/p' supabase/migrations/0011_pod_optional.sql
    echo "revoke all on function public.set_load_status(uuid, public.load_status, timestamptz, text) from public, anon;"
    echo "grant execute on function public.set_load_status(uuid, public.load_status, timestamptz, text) to authenticated, service_role;"
    sed -n '/^create function public.dlv_loads_before_insert()/,/^\$fn\$;/p' supabase/migrations/0002_functions.sql | sed 's/^create function/create or replace function/'
    sed -n '/^create function public.dlv_loads_before_update()/,/^\$fn\$;/p' supabase/migrations/0002_functions.sql | sed 's/^create function/create or replace function/'
    echo "revoke all on function public.dlv_loads_before_insert(), public.dlv_loads_before_update() from public, anon, authenticated;"
    echo "grant execute on function public.dlv_loads_before_insert(), public.dlv_loads_before_update() to service_role;"
    echo "drop function if exists public.set_its_load_number(uuid, text);"
    echo "drop index if exists public.loads_its_load_number_key;"
    echo "alter table public.loads drop constraint if exists loads_its_load_number_format;"
    echo "alter table public.loads drop column if exists its_load_number;"
  } > "$tmp"
  grep -q 'POD document is required' "$tmp" && { echo "FAIL: extraction (set_load_status has a POD rule, wrong source)"; exit 1; }
  grep -q 'create or replace function public.set_load_status' "$tmp" || { echo "FAIL: extraction (set_load_status)"; exit 1; }
  grep -q 'create or replace function public.dlv_loads_before_insert' "$tmp" || { echo "FAIL: extraction (before insert)"; exit 1; }
  grep -q 'create or replace function public.dlv_loads_before_update' "$tmp" || { echo "FAIL: extraction (before update)"; exit 1; }
  grep -q 'its_load_number' "$tmp" && { grep -v '^\(drop\|alter\)' "$tmp" | grep -q 'its_load_number' && { echo "FAIL: extraction (restored bodies mention its_load_number)"; exit 1; }; }
  psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f "$tmp" || exit 1
  rm -f "$tmp"
  echo ROLLBACK_0013_OK
)
```

## 6. Post-check (read only)

Block C. Expected values come from the same run: the counts saved by block A are compared with fresh counts. Checks that belong to a file in the pack are grouped under that file's number so a later card can add its own group.

```zsh
# BLOCK postcheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-4}"
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
  ) 2>/dev/null || v="query failed (is the column missing?)"; need "no ITS number was written by the migration (every existing load stays NULL)" "$v" "0"

  echo "--- 0013 its load number"
  v=$(q <<'SQL'
select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'loads'
   and column_name = 'its_load_number' and data_type = 'text' and is_nullable = 'YES';
SQL
  ) || exit 1; need "loads.its_load_number exists, text, nullable" "$v" "1"
  v=$(q <<'SQL'
select count(*) from pg_constraint where conname = 'loads_its_load_number_format' and conrelid = 'public.loads'::regclass
   and convalidated and position('[0-9]+' in pg_get_constraintdef(oid)) > 0 and position('-' in pg_get_constraintdef(oid)) > 0;
SQL
  ) || exit 1; need "format CHECK exists, is validated, digits with an optional dash and digits" "$v" "1"
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
    and position('already used by another load' in pg_get_functiondef($ITS)) > 0)::int;
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
  ) || exit 1; need "RLS still enabled on every public table" "$v" "$PRE_rls_tables"
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
  ) || exit 1; need "policy count unchanged" "$v" "$PRE_policies"
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

After `POSTCHECK_OK`: deploy the app from main (Vercel), then follow the "After every deploy" list in docs/RUNBOOK.md. Optional app level smoke after the deploy: as Maria request a load and see "Number pending"; as staff assign the carrier, enter an ITS number and Mark booked; Maria then sees the ITS number and receives the booking email.

## Extending this pack

A later card that adds a migration (for example 0014) does exactly three things and changes no block logic:
1. Add a row to the table in section 1.
2. Append the file name to the `files=( ... )` array in block B. The "highest file equals the last file in the list" and "file count equals the highest number" checks then expect 0014 by themselves.
3. Add a group of PASS checks for the new file to block C, and any read only data check to block A. The row count, security posture and earlier migration groups stay as they are.

## Rehearsal result

Rehearsed on the LOCAL stack only (127.0.0.1:54322), never production. Method: `supabase db reset --last 1` with 13 migration files leaves production's state, 0001 to 0012 (confirmed from supabase_migrations.schema_migrations before trusting it: 12 rows, max version 0012, 0013 absent, no column its_load_number). Note: `--last N` undoes the last N migrations of the full set, so it equals production's state only while this pack holds exactly one file (with a second file in the pack use `--last 2`). Representative rows were inserted at that state (1 customer user, 1 admin, 1 carrier owner, 7 loads: 2 requested, 2 booked, 1 at pickup, 1 delivered, 1 cancelled; 12 events). Blocks A, B, C and the 0013 rollback block were extracted from this file by a script (the body of each `# BLOCK` fence) and run verbatim under `zsh -f` with `DATABASE_URL_DIRECT` exported to the LOCAL url for that child process only (the `source ~/.zshenvmitrex` line was not run; no production variable was passed on). Afterwards `supabase db reset` restored all thirteen migrations.

| Step | Result |
| --- | --- |
| Block A pre-check | PRECHECK_OK. Counts before: loads 7, profiles 3, load_events 12, load_documents 0, locations 19, customers 1, carriers 1, location_requests 0. Loads by status recorded (requested 2, booked 2, at_pickup 1, delivered 1, cancelled 1). 4 loads are already booked or later (informational, they have no ITS number and stay valid). 0001 to 0012 state checks all PASS (8 tables, RLS 8 of 8, 0006 index, 0007 CHECK, 0008 guard, 0009 columns, 0010 triggers, 0011 set_load_status and dlv_can_access_doc, 0012 equipment CHECK, anon zero grants). The four "must be absent" checks for 0013 all PASS. |
| Block B apply | APPLY_OK. 0013 applied in one transaction (ALTER TABLE, DO, CREATE INDEX, three CREATE FUNCTION with grants restated, the new function with its grants). |
| Block C post-check | POSTCHECK_OK, 44 of 44 PASS: 8 counts and 8 per status counts unchanged, no ITS number written to any existing load, column present (text, nullable), format CHECK validated, partial UNIQUE index present, set_its_load_number is SECURITY DEFINER, staff only, logs and refuses duplicates with EXECUTE for authenticated and not for anon or PUBLIC, set_load_status carries the new rule and keeps every earlier rule, dlv_can_access_doc and equipment CHECK intact, pack 2 objects (9 triggers incl. the two loads guards, unique index, strict CHECK, set_load_eta event), RLS on every table, anon zero table grants and no function EXECUTE, no client EXECUTE on the six trigger functions, policy count, admin count, bucket limits. |
| Re-run of B then C | APPLY_OK and POSTCHECK_OK (idempotent). |
| Negative arm: block A after the apply | PRECHECK_FAIL (do not apply) on exactly the four "must be absent" checks (column, function, CHECK or index, rule text), as designed. |
| Negative arm: rollback block for 0013, then C | ROLLBACK_0013_OK, then POSTCHECK_FAIL on exactly the 8 checks of the 0013 group (all other groups, including the restored 0011 set_load_status and the restored 0002 loads guards, stayed PASS). A, B, C again: PRECHECK_OK, APPLY_OK, POSTCHECK_OK. The first version of block C crashed silently on the missing function (a bare regprocedure cast) and on the missing column; both checks now print a FAIL line instead (found by this rehearsal, fixed in this file). |
| Functional rules of 0013 | Not part of the blocks. supabase/tests/rls.sql section 13 (staff sets the number through the function, customer and carrier cannot, direct UPDATE refused, no booking without a number, duplicate and format refused, 313-2 accepted, legacy booked load still advances, events written, customer reads the number) runs on a fresh `supabase db reset` and printed `RLS_OK 489 OK / 0 VACUOUS / 0 FAIL`.
