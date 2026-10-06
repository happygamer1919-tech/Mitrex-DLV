# Apply pack 3: migrations 0011 and 0012 to production

For a SEPARATE, owner supervised production session. Nothing in this pack was run against production. It was
rehearsed against the local stack only (see "Rehearsal result"). Production holds migrations 0001 to 0010 (pack 2).

More migrations will be appended to this pack by later cards. The file list in section 1 and the `files=( ... )`
array at the top of block B and block C are the only places that name migrations; every count and "highest number"
check is derived from that list (see "Extending this pack"). Do not edit block logic to add a migration.

Rules for the session
- The owner runs every block. Do not paste a connection string, key or password anywhere. Blocks print counts and PASS or FAIL only.
- Run in a quiet window (no carrier or customer actions). The post-check compares row counts with the pre-check, so live traffic between the two shows as a FAIL to investigate, not as a silent pass.
- Every block is zsh and runs inside a subshell `( ... )`, so a failure ends the block and never closes your terminal. Each block exits non-zero on failure and prints its own verdict. No block relies on `set -e`.
- Blocks keep state in `$DLV_APPLY_DIR` (default `~/dlv-apply-3`, mode 700). The state file holds counts and 0/1 flags only. No secrets.

## 1. Migrations not yet in production (in order)

| File | What it does | Risk |
| --- | --- | --- |
| 0011_pod_optional.sql | A POD is optional at delivery. `set_load_status` loses ONLY the "a POD document is required for delivered" rule (the rest of the 0010 body is unchanged, checked with diff). `dlv_can_access_doc` lets a carrier owner or driver upload a POD while the load is `delivered` too (own carrier only, never a BOL, customers never write; the strict path regex is unchanged). | Low. Two CREATE OR REPLACE statements with the grants restated; no data change. Rolling back means restoring both functions together (section 5). |
| 0012_equipment_sizes_26_36_53.sql | Equipment sizes become 26, 36 and 53 only. Refuses to run (clear message, nothing altered) while any load has size 48. Finds the old CHECK through `pg_constraint`, drops it and adds the validated CHECK `loads_equipment_size_check`. | Low if the pre-check count of 48 ft loads is 0. The new CHECK is validated against every existing load: ANY load outside 26, 36, 53 aborts the file. Brief lock on `loads` while the CHECK validates (the table is tiny). Idempotent. |

## 2. Order of operations: migrations first, then the app

Recommendation: apply both migrations first, then deploy the app from main straight away.

Reasons
1. 0011 is backward compatible with the app that is live now. The old carrier screen still asks for a photo; it simply no longer needs the database to insist on one.
2. The new app needs 0011: without it, "Mark delivered" without a photo is refused by the database ("a POD document is required for delivered") and a POD added after delivery is refused by row level security. Deploying the app first would show those failures to a driver.
3. 0012 is the one step the OLD app does not survive: the old booking form still offers a 48 ft chip and the new CHECK refuses it. The pre-check proves no 48 ft loads exist, so nothing stored breaks; the only exposure is someone tapping 48 ft between the apply and the deploy. Run block B and the deploy back to back.
4. If a migration fails, nothing user visible has changed yet and the app is untouched.

What the new app needs from each migration (the app does not crash without them, it shows the plain errors above)
- 0011: carrier "Mark delivered" with no photo, the "Add POD photo" card on a delivered load, staff and customer "POD pending" and "POD not uploaded yet.".
- 0012: nothing at runtime; the form already offers only 26, 36, 53. The CHECK is the server side guarantee (a forged request with 48 is refused by the app and, behind it, by the database).

## 3. Pre-check (read only)

Session setup. Run this in the terminal you will use for every block below. It loads DATABASE_URL_DIRECT without printing it.

```
set -o allexport; source ~/.zshenvmitrex; set +o allexport
cd ~/Documents/Projects/GitHub/Mitrex-DLV && git fetch origin && git checkout feat/dlv-021-acceptance-fixes
```

(If this branch was merged, `git checkout main && git pull` instead. The migration files must be exactly the ones listed above.)

Block A, pre-check. Read only: every statement runs with `default_transaction_read_only = on`, so it cannot change data even by mistake.

```zsh
# BLOCK precheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-3}"
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

  echo "--- production migration state is 0001 to 0010"
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
    and to_regprocedure('public.dlv_can_access_doc(text, boolean)') is not null)::int;
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
select (to_regprocedure('public.dlv_loads_status_event()') is not null)::int;
SQL
  ) || exit 1; need "0010 function dlv_loads_status_event" "$v" "1"
  v=$(q <<'SQL'
select (position('dlv.event_note' in pg_get_functiondef('public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure)) > 0
    and pg_get_functiondef('public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure) !~* 'insert into public[.]load_events')::int;
SQL
  ) || exit 1; need "0010 set_load_status hands the note to the trigger" "$v" "1"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('select'),('insert'),('update'),('delete'),('truncate'),('references'),('trigger')) p(priv)
 where n.nspname = 'public' and c.relkind in ('r','v','m','p') and has_table_privilege('anon', c.oid, p.priv);
SQL
  ) || exit 1; need "anon holds zero table grants (before)" "$v" "0"; rec PRE_anon_table_grants "$v"

  echo "--- which of the files in this pack are already present (informational)"
  v=$(q <<'SQL'
select (pg_get_functiondef('public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure) !~* 'POD document is required')::int;
SQL
  ) || exit 1; rec PRE_has_0011_set_load_status "$v"
  v=$(q <<'SQL'
select (position('''enroute'',''at_delivery'',''delivered''' in pg_get_functiondef('public.dlv_can_access_doc(text, boolean)'::regprocedure)) > 0)::int;
SQL
  ) || exit 1; rec PRE_has_0011_doc_access "$v"
  v=$(q <<'SQL'
select count(*) from pg_constraint where conrelid = 'public.loads'::regclass and contype = 'c' and convalidated
   and pg_get_constraintdef(oid) like '%equipment_size%' and pg_get_constraintdef(oid) not like '%48%';
SQL
  ) || exit 1; rec PRE_has_0012_check "$v"

  echo "--- data the new constraints will validate"
  v=$(q <<'SQL'
select count(*) from public.loads where equipment_size = 48;
SQL
  ) || exit 1; rec PRE_loads_48ft "$v"
  if [[ "$v" != "0" ]]; then
    print -r -- "FAIL $v load(s) have equipment_size 48 (48 ft is being removed). STOP: ask the owner what to do with those loads (change the size, or cancel them), then run this block again. Do not apply 0012 until this count is 0."
    bad=1
  else
    print -r -- "PASS no loads with equipment_size 48"
  fi
  v=$(q <<'SQL'
select count(*) from public.loads where equipment_size not in (26, 36, 53);
SQL
  ) || exit 1; need "loads outside 26, 36, 53 (the new CHECK would refuse them)" "$v" "0"
  v=$(q <<'SQL'
select count(*) from public.loads where status = 'delivered';
SQL
  ) || exit 1; rec PRE_delivered_loads "$v"
  v=$(q <<'SQL'
select count(*) from public.loads l where l.status = 'delivered'
   and not exists (select 1 from public.load_documents d where d.load_id = l.id and d.kind = 'pod');
SQL
  ) || exit 1; rec PRE_delivered_without_pod "$v"

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

  if [[ $bad -ne 0 ]]; then echo "PRECHECK_FAIL (do not apply)"; exit 1; fi
  echo "PRECHECK_OK (state saved in $STATE)"
)
```

Stop here unless it printed `PRECHECK_OK`. A FAIL on the 48 ft count means loads of the removed size exist: do not apply 0012 and ask the owner what to do with them first. The delivered counts are informational (delivered loads without a POD stay as they are; staff see them with a "POD pending" badge).

## 4. Apply

Block B. One transaction per migration (`--single-transaction`), stops at the first failure, full transcript in `apply-transcript-3.txt` (repo root, git ignored; it contains no connection string). The migration list and the expected highest number live in the `files` array.

```zsh
# BLOCK apply
(
  setopt pipefail
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-3}"
  [[ -f "$DIR/state.env" ]] || { echo "FAIL: run the pre-check (block A) first"; exit 1; }
  files=(
    0011_pod_optional.sql
    0012_equipment_sizes_26_36_53.sql
  )
  for f in $files; do
    [[ -f "supabase/migrations/$f" ]] || { echo "FAIL: missing supabase/migrations/$f (run from the repo root)"; exit 1; }
  done
  last="${files[-1]%%_*}"
  highest=$(ls supabase/migrations | grep '^[0-9]' | sort | tail -1)
  [[ "${highest%%_*}" == "$last" ]] || { echo "FAIL: the highest migration file is ${highest%%_*} but the last file in this pack is $last"; exit 1; }
  count=$(ls supabase/migrations | grep -c '^[0-9]')
  [[ "$count" -eq $((10#$last)) ]] || { echo "FAIL: expected $((10#$last)) migration files (0001 to $last, none missing), found $count"; exit 1; }
  print -r -- "apply started $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-3.txt
  for f in $files; do
    print -r -- "=== $f" | tee -a apply-transcript-3.txt
    psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f "supabase/migrations/$f" 2>&1 | tee -a apply-transcript-3.txt || { echo "APPLY_FAIL at $f (that file was rolled back as one transaction; earlier files stay applied; see section 5)"; exit 1; }
  done
  print -r -- "APPLY_OK $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-3.txt
)
```

If a block fails midway: the failing file is one transaction, so it left nothing behind. Earlier files stay applied. Fix the cause and run block B again (both files are idempotent). A failure at 0012 with the message "0012 refused: N load(s) still have equipment_size 48" means a 48 ft load appeared after the pre-check: ask the owner, then run block A again.

## 5. Rollback notes (per migration)

Every migration runs as one transaction, so a failure inside a file undoes that whole file. These are only for undoing a file that APPLIED and that you then decide to back out. Do not run any of this against production without the owner's explicit go. Reuse `$DATABASE_URL_DIRECT`.

- 0012: restore the old CHECK. Only if the app is also rolled back to a build that offers 48 ft:
  `alter table public.loads drop constraint loads_equipment_size_check; alter table public.loads add constraint loads_equipment_size_check check (equipment_size in (26,36,48,53));`
- 0011: restore BOTH functions together, as ONE transaction (block below). Delivered loads that were marked without a POD stay delivered; the old rule only applies to future status changes. A POD uploaded after delivery stays stored.

```zsh
# BLOCK rollback-0011
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  tmp=$(mktemp) || exit 1
  { sed -n '/^create or replace function public.set_load_status(/,/^\$fn\$;/p' supabase/migrations/0010_load_status_event_trigger.sql
    echo "revoke all on function public.set_load_status(uuid, public.load_status, timestamptz, text) from public, anon;"
    echo "grant execute on function public.set_load_status(uuid, public.load_status, timestamptz, text) to authenticated, service_role;"
    sed -n '/^create or replace function public.dlv_can_access_doc(/,/^\$fn\$;/p' supabase/migrations/0007_document_path_hardening.sql
    echo "revoke all on function public.dlv_can_access_doc(text, boolean) from public, anon;"
    echo "grant execute on function public.dlv_can_access_doc(text, boolean) to authenticated, service_role;"
  } > "$tmp"
  grep -q 'POD document is required' "$tmp" || { echo "FAIL: extraction (set_load_status)"; exit 1; }
  grep -q "l.status in ('enroute','at_delivery')" "$tmp" || { echo "FAIL: extraction (dlv_can_access_doc)"; exit 1; }
  psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f "$tmp" || exit 1
  rm -f "$tmp"
  echo ROLLBACK_0011_OK
)
```

## 6. Post-check (read only)

Block C. Expected values come from the same run: the counts saved by block A are compared with fresh counts. Checks that belong to a file in the pack are grouped under that file's number so a later card can add its own group.

```zsh
# BLOCK postcheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-3}"
  STATE="$DIR/state.env"
  [[ -f "$STATE" ]] || { echo "FAIL: no state file, run block A before the apply"; exit 1; }
  source "$STATE" || exit 1
  q() { { echo "set default_transaction_read_only = on;"; cat; } | psql "$DATABASE_URL_DIRECT" -X -A -t -q -v ON_ERROR_STOP=1 -f - ; }
  bad=0
  need() { if [[ "$2" == "$3" ]]; then print -r -- "PASS $1"; else print -r -- "FAIL $1 (got $2, want $3)"; bad=1; fi; }
  FN="'public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure"

  echo "--- row counts unchanged"
  for t in loads profiles load_events load_documents locations customers carriers location_requests; do
    v=$(q <<SQL
select count(*) from public.$t;
SQL
    ) || { echo "FAIL: count $t"; exit 1; }
    eval "want=\$PRE_count_$t"
    need "count $t unchanged" "$v" "$want"
  done

  echo "--- 0011 pod optional"
  v=$(q <<SQL
select (pg_get_functiondef($FN) !~* 'POD document is required' and pg_get_functiondef($FN) !~* 'load_documents')::int;
SQL
  ) || exit 1; need "set_load_status no longer mentions a POD requirement" "$v" "1"
  v=$(q <<SQL
select (position('dlv.event_note' in pg_get_functiondef($FN)) > 0
    and pg_get_functiondef($FN) !~* 'insert into public[.]load_events'
    and position('a note is required for a staff override' in pg_get_functiondef($FN)) > 0
    and position('carriers move forward one step at a time' in pg_get_functiondef($FN)) > 0
    and position('delivered loads are final' in pg_get_functiondef($FN)) > 0)::int;
SQL
  ) || exit 1; need "set_load_status keeps the 0010 rules (event note, override note, one step, final)" "$v" "1"
  v=$(q <<'SQL'
select (position('''enroute'',''at_delivery'',''delivered''' in pg_get_functiondef('public.dlv_can_access_doc(text, boolean)'::regprocedure)) > 0
    and position('v_kind = ''pod''' in pg_get_functiondef('public.dlv_can_access_doc(text, boolean)'::regprocedure)) > 0)::int;
SQL
  ) || exit 1; need "dlv_can_access_doc: carrier may write a POD while enroute, at_delivery or delivered, BOL never" "$v" "1"
  v=$(q <<'SQL'
select (position('{2,5}' in pg_get_functiondef('public.dlv_can_access_doc(text, boolean)'::regprocedure)) > 0
    and position('(bol|pod)' in pg_get_functiondef('public.dlv_can_access_doc(text, boolean)'::regprocedure)) > 0)::int;
SQL
  ) || exit 1; need "dlv_can_access_doc keeps the strict path regex" "$v" "1"
  v=$(q <<'SQL'
select (has_function_privilege('authenticated', 'public.dlv_can_access_doc(text, boolean)', 'execute')
    and not has_function_privilege('anon', 'public.dlv_can_access_doc(text, boolean)', 'execute'))::int;
SQL
  ) || exit 1; need "dlv_can_access_doc: authenticated yes, anon no" "$v" "1"

  echo "--- 0012 equipment sizes"
  v=$(q <<'SQL'
select count(*) from pg_constraint where conrelid = 'public.loads'::regclass and contype = 'c'
   and pg_get_constraintdef(oid) like '%equipment_size%';
SQL
  ) || exit 1; need "exactly one equipment_size CHECK on loads" "$v" "1"
  v=$(q <<'SQL'
select count(*) from pg_constraint where conname = 'loads_equipment_size_check' and conrelid = 'public.loads'::regclass
   and convalidated and pg_get_constraintdef(oid) like '%26%' and pg_get_constraintdef(oid) like '%36%'
   and pg_get_constraintdef(oid) like '%53%' and pg_get_constraintdef(oid) not like '%48%';
SQL
  ) || exit 1; need "loads_equipment_size_check exists, is validated, allows 26 36 53 and not 48" "$v" "1"
  v=$(q <<'SQL'
select count(*) from public.loads where equipment_size not in (26, 36, 53);
SQL
  ) || exit 1; need "no load outside 26, 36, 53" "$v" "0"

  echo "--- earlier migrations (pack 2) still in place"
  v=$(q <<'SQL'
select (to_regprocedure('public.dlv_profiles_last_admin_guard()') is not null)::int;
SQL
  ) || exit 1; need "function dlv_profiles_last_admin_guard" "$v" "1"
  v=$(q <<'SQL'
select (to_regprocedure('public.dlv_loads_status_event()') is not null)::int;
SQL
  ) || exit 1; need "function dlv_loads_status_event" "$v" "1"
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
  ('public.locations'::regclass, 'locations_touch_updated_at'),
  ('public.carriers'::regclass, 'carriers_touch_updated_at'),
  ('public.customers'::regclass, 'customers_touch_updated_at'),
  ('public.profiles'::regclass, 'profiles_touch_updated_at'),
  ('public.location_requests'::regclass, 'location_requests_touch_updated_at'));
SQL
  ) || exit 1; need "status event, insert event and 5 touch triggers enabled" "$v" "7"
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
 where n.nspname = 'public' and p.proname in ('dlv_profiles_last_admin_guard','dlv_loads_status_event','dlv_touch_updated_at','dlv_locations_before_update')
   and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
SQL
  ) || exit 1; need "no client role can EXECUTE the trigger functions" "$v" "0"
  v=$(q <<SQL
select (has_function_privilege('authenticated', $FN, 'execute') and not has_function_privilege('anon', $FN, 'execute'))::int;
SQL
  ) || exit 1; need "set_load_status: authenticated yes, anon no" "$v" "1"
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

After `POSTCHECK_OK`: deploy the app from main (Vercel), then follow the "After every deploy" list in docs/RUNBOOK.md. Optional app level smoke after the deploy: as a carrier, move a test load to Delivered without a photo, add the POD photo from the load page, and check staff no longer see "POD pending".

## Extending this pack

A later card that adds a migration (for example 0013) does exactly three things and changes no block logic:
1. Add a row to the table in section 1.
2. Append the file name to the `files=( ... )` array in block B. The "highest file equals the last file in the list" and "file count equals the highest number" checks then expect 0013 by themselves.
3. Add a group of PASS checks for the new file to block C, and any read only data check to block A. The row count, security posture and earlier migration groups stay as they are.

## Rehearsal result

Rehearsed on the LOCAL stack only (127.0.0.1:54322), never production. Method: `supabase db reset --last 2` (production's state, 0001 to 0010; journal max version 0010 and 10 rows confirmed from supabase_migrations.schema_migrations, 0011 and 0012 absent). Note: `--last N` undoes the last N migrations of the full set, so with 12 files `--last 10` would stop at 0002; `--last 2` is the right value while this pack holds exactly two files. Representative rows were inserted at that state (1 customer user, 1 admin, 1 carrier, 2 loads, 1 stored POD, 1 delivered load). Blocks A, B, C and the 0011 rollback block were extracted from this file by a script (from the `# BLOCK` line to the closing `)`) and run verbatim under `zsh -f` with `DATABASE_URL_DIRECT` exported to the local URL in that shell only (the `source ~/.zshenvmitrex` line was not run). Afterwards `supabase db reset` restored all twelve migrations.

| Step | Result |
| --- | --- |
| Block A pre-check | PRECHECK_OK. Counts before: loads 2, profiles 2, load_events 4, load_documents 1, locations 19, customers 1, carriers 1, location_requests 0. 14 PASS (0001 to 0010 state: 8 tables, RLS 8 of 8, 0006 index, 0007 CHECK, 0008 guard, 0009 columns, 0010 triggers and function, set_load_status hands the note to the trigger, anon zero grants). Flags for 0011 and 0012 all 0. 48 ft loads 0, delivered loads 1, delivered without POD 0. |
| Block B apply | APPLY_OK. 0011 and 0012 each applied in its own transaction. |
| Block C post-check | POSTCHECK_OK, 31 of 31 PASS: 8 counts unchanged, set_load_status has no POD requirement and keeps the 0010 rules, dlv_can_access_doc allows a carrier POD write while delivered and keeps the strict path regex and grants, exactly one equipment CHECK that is validated and excludes 48, pack 2 objects (7 triggers, unique index, strict CHECK, set_load_eta event), RLS on every table, anon zero grants, no client EXECUTE on trigger functions, policy count, admin count, bucket limits. |
| Re-run of B then C | APPLY_OK and POSTCHECK_OK (idempotent). |
| Negative arm: rollback block for 0011, then C | ROLLBACK_0011_OK, then POSTCHECK_FAIL on exactly the 2 checks about 0011 (set_load_status text, dlv_can_access_doc). B then C again: exit 0 and POSTCHECK_OK. |
| Negative arm: a 48 ft load at the 0010 state | Block A printed the STOP message that asks the owner what to do with the load, plus FAIL on "loads outside 26, 36, 53", and PRECHECK_FAIL (do not apply). Block B run anyway: 0011 applied, 0012 raised "0012 refused: 1 load(s) still have equipment_size 48 ..." and rolled back as one transaction (old CHECK still the only equipment CHECK). After the load was changed to 36 ft: PRECHECK_OK, APPLY_OK, POSTCHECK_OK. |
| Functional check at the applied state (rolled back) | As staff, set_load_status to delivered on an at_delivery load with no POD row returned status delivered. The carrier side of the same rule (POD upload after delivered, never on another carrier's load, never a BOL, never a customer) is asserted by supabase/tests/rls.sql section 12. |
