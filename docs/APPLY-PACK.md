# Apply pack 2: migrations 0006 to 0010 to production

For a SEPARATE, owner supervised production session. Nothing in this pack was run against production. It was
rehearsed against the local stack only (see "Rehearsal result"). Production holds migrations 0001 to 0005.

Rules for the session
- The owner runs every block. Do not paste a connection string, key or password anywhere. Blocks print counts and PASS or FAIL only.
- Run in a quiet window (no carrier or customer actions). The post-check compares row counts with the pre-check, so live traffic between the two shows as a FAIL to investigate, not as a silent pass.
- Every block is zsh and runs inside a subshell `( ... )`, so a failure ends the block and never closes your terminal. Each block exits non-zero on failure and prints its own verdict.
- Blocks keep state in `$DLV_APPLY_DIR` (default `~/dlv-apply-2`, mode 700). The state file holds counts and 0/1 flags only. No secrets.

## 1. Migrations not yet in production (in order)

| File | What it does | Risk |
| --- | --- | --- |
| 0006_load_documents_path_unique.sql | Unique index on load_documents(storage_path): one row per stored file, so a late POD insert after a retry cannot create a second row. | Not idempotent (plain CREATE UNIQUE INDEX). Fails if two rows share a path, the pre-check counts duplicates. Blocks writes to load_documents for the instant it builds (table is tiny). The block skips it if the index already exists. |
| 0007_document_path_hardening.sql | dlv_can_access_doc and the load_documents CHECK accept only `{load uuid}/{bol or pod}/{file uuid}.{ext}`; bucket gets a 15 MB limit and a mime allow list. | The new CHECK is validated against existing rows: ANY row with a non conforming path aborts the migration. The pre-check counts them (must be 0). Idempotent. |
| 0008_last_admin_guard.sql | Trigger on profiles: no change (deactivate, demote, delete) may leave zero active staff_admin. Advisory lock makes it race safe. Binds the service role too. | Low. New trigger only, no data change. If an admin needs to be removed later, add another active admin first. TRUNCATE is not covered. |
| 0009_updated_at.sql | updated_at column plus touch trigger on locations, carriers, customers, profiles, location_requests; locations customer-edit guard ignores updated_at. | Low. ADD COLUMN with a now() default is metadata only. Short ACCESS EXCLUSIVE lock on five small tables. |
| 0010_load_status_event_trigger.sql | One load_events row per status change enforced by an AFTER UPDATE OF status trigger on loads; set_load_status no longer inserts the event itself (same rules otherwise). | Medium. It replaces set_load_status. The two parts MUST land together: that is why the file is one transaction. Rolling back means restoring set_load_status AND dropping the trigger together (section 5). |

Indexes (card C6.2): nothing to add. loads(status), loads(pickup_date), loads(carrier_id, status), loads(customer_id, created_at) and
load_events(load_id, created_at) already lead an index; the test suite now asserts it.

## 2. Order of operations: migrations first, then the app

Recommendation: apply the migrations first, then deploy the app from main.

Reasons
1. 0006 to 0010 are additive and backward compatible with the app that is live now. No column the old code reads is renamed or dropped; the new columns are ignored by `select` lists, and `select *` consumers only gain a field.
2. The new app code assumes the database. Verified by reading the code on main: only the POD retry path leans on 0006 (carrier LoadActions treats error 23505 on the load_documents insert as "already saved"; without the unique index no 23505 ever comes, so a late duplicate insert makes two POD rows, which still works but is untidy). Deploying the app first would open that gap.
3. If a migration fails, nothing user visible has changed yet and the app is untouched. The reverse order leaves the new app running on an old schema until the migrations are fixed.

What each app behaviour needs (the app works with none of them, nothing crashes)
- 0006: POD upload retry is exactly one row per file (src/components/carrier/LoadActions.tsx, 23505 branch). Without it: possible duplicate POD row.

Rollback block for 0010:

```zsh
# BLOCK rollback-0010
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  tmp=$(mktemp) || exit 1
  { echo "drop trigger if exists loads_status_event on public.loads;"
    sed -n '/^create function public.set_load_status(/,/^\$fn\$;/p' supabase/migrations/0002_functions.sql | sed '1s/^create function/create or replace function/'
    echo "drop function if exists public.dlv_loads_status_event();"
  } > "$tmp"
  grep -q 'insert into public.load_events' "$tmp" || { echo "FAIL: extraction"; exit 1; }
  psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f "$tmp" || exit 1
  rm -f "$tmp"
  echo ROLLBACK_0010_OK
)
```
- 0007: server side enforcement of the document path shape, the 15 MB limit and the mime list. The app already generates conforming paths and checks type and size in the browser (src/components/admin/LoadControls.tsx, LoadActions.tsx). Without it: the browser limits are the only limits.
- 0008: the DB refuses removing the last admin. The app already checks first (src/lib/admin/user-actions.ts). With it, when two admins act at the same moment, the database wins and the app now shows the same plain message (changed in this branch, deploy the app after the migrations to get that message; before the app change the race shows the generic "Could not deactivate" text, harmless).
- 0009: no app code reads updated_at on these five tables (loads.updated_at is older and unchanged). Nothing depends on it.
- 0010: the app only changes status through the set_load_status RPC (customer cancel, staff and carrier steps; src/lib/admin/load-actions.ts, src/lib/customer/actions.ts, src/app/my-loads/[id]/actions.ts), whose events are identical before and after (same from, to, actor, note). Behaviour change visible only to direct writers: a status UPDATE by the service role or SQL editor now also writes an event.

## 3. Pre-check (read only)

Session setup. Run this in the terminal you will use for every block below. It loads DATABASE_URL_DIRECT without printing it.

```
set -o allexport; source ~/.zshenvmitrex; set +o allexport
cd ~/Documents/Projects/GitHub/Mitrex-DLV && git fetch origin && git checkout feat/dlv-015-data-integrity
```

(If this branch was merged, `git checkout main && git pull` instead. The migrations must be exactly the files listed above.)

Block A, pre-check. Read only: every statement runs with `default_transaction_read_only = on`, so it cannot change data even by mistake.

```zsh
# BLOCK precheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-2}"
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

  echo "--- production state is 0001 to 0005"
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
select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'is_active';
SQL
  ) || exit 1; need "profiles.is_active exists (0005)" "$v" "1"
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
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('select'),('insert'),('update'),('delete'),('truncate'),('references'),('trigger')) p(priv)
 where n.nspname = 'public' and c.relkind in ('r','v','m','p') and has_table_privilege('anon', c.oid, p.priv);
SQL
  ) || exit 1; need "anon holds zero table grants (before)" "$v" "0"

  echo "--- which of 0006 to 0010 are already present (informational)"
  v=$(q <<'SQL'
select (to_regclass('public.load_documents_storage_path_uq') is not null)::int;
SQL
  ) || exit 1; rec PRE_has_0006 "$v"
  v=$(q <<'SQL'
select (select count(*) from pg_constraint where conname = 'load_documents_path_ck' and position('{2,5}' in pg_get_constraintdef(oid)) > 0)::int;
SQL
  ) || exit 1; rec PRE_has_0007 "$v"
  v=$(q <<'SQL'
select (to_regprocedure('public.dlv_profiles_last_admin_guard()') is not null)::int;
SQL
  ) || exit 1; rec PRE_has_0008 "$v"
  v=$(q <<'SQL'
select (select count(*) from information_schema.columns where table_schema = 'public' and column_name = 'updated_at'
          and table_name in ('locations','carriers','customers','profiles','location_requests'))::int;
SQL
  ) || exit 1; rec PRE_has_0009_columns "$v"
  v=$(q <<'SQL'
select (to_regprocedure('public.dlv_loads_status_event()') is not null)::int;
SQL
  ) || exit 1; rec PRE_has_0010 "$v"

  echo "--- data the new constraints will validate"
  v=$(q <<'SQL'
select count(*) from public.load_documents
 where not (storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(bol|pod)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$'
            and left(storage_path, 38 + length(kind)) = load_id::text || '/' || kind || '/');
SQL
  ) || exit 1; need "load_documents rows violating the 0007 CHECK" "$v" "0"
  v=$(q <<'SQL'
select count(*) from (select storage_path from public.load_documents group by storage_path having count(*) > 1) d;
SQL
  ) || exit 1; need "duplicate load_documents.storage_path values (0006 unique index)" "$v" "0"

  echo "--- other facts recorded for the post-check"
  v=$(q <<'SQL'
select count(*) from public.profiles where role = 'staff_admin' and is_active;
SQL
  ) || exit 1; rec PRE_active_admins "$v"
  [[ "$v" -ge 1 ]] || { echo "FAIL: no active staff_admin in production (investigate before applying)"; bad=1; }
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('select'),('insert'),('update'),('delete'),('truncate'),('references'),('trigger')) p(priv)
 where n.nspname = 'public' and c.relkind in ('r','v','m','p') and has_table_privilege('anon', c.oid, p.priv);
SQL
  ) || exit 1; rec PRE_anon_table_grants "$v"
  v=$(q <<'SQL'
select count(*) from pg_policies where schemaname in ('public','storage');
SQL
  ) || exit 1; rec PRE_policies "$v"

  if [[ $bad -ne 0 ]]; then echo "PRECHECK_FAIL (do not apply)"; exit 1; fi
  echo "PRECHECK_OK (state saved in $STATE)"
)
```

Stop here unless it printed `PRECHECK_OK`. A FAIL on "load_documents rows violating the 0007 CHECK" means a legacy document path exists: do not apply 0007, ask for a data fix first.

## 4. Apply

Block B. One transaction per migration (`--single-transaction`), stops at the first failure, full transcript in `apply-transcript-2.txt` (repo root, git ignored; it contains no connection string).

```zsh
# BLOCK apply
(
  setopt pipefail
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-2}"
  [[ -f "$DIR/state.env" ]] || { echo "FAIL: run the pre-check (block A) first"; exit 1; }
  files=(
    0006_load_documents_path_unique.sql
    0007_document_path_hardening.sql
    0008_last_admin_guard.sql
    0009_updated_at.sql
    0010_load_status_event_trigger.sql
  )
  for f in $files; do
    [[ -f "supabase/migrations/$f" ]] || { echo "FAIL: missing supabase/migrations/$f (run from the repo root)"; exit 1; }
  done
  extra=$(ls supabase/migrations | grep -c '^00')
  [[ "$extra" -eq 10 ]] || { echo "FAIL: expected exactly 10 migration files (0001 to 0010), found $extra"; exit 1; }
  print -r -- "apply started $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-2.txt
  for f in $files; do
    if [[ "$f" == 0006_* ]]; then
      have=$({ echo "set default_transaction_read_only = on;"; echo "select (to_regclass('public.load_documents_storage_path_uq') is not null)::int;"; } | psql "$DATABASE_URL_DIRECT" -X -A -t -q -v ON_ERROR_STOP=1 -f -) || exit 1
      if [[ "$have" == "1" ]]; then print -r -- "SKIP $f (index already present)" | tee -a apply-transcript-2.txt; continue; fi
    fi
    print -r -- "=== $f" | tee -a apply-transcript-2.txt
    psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f "supabase/migrations/$f" 2>&1 | tee -a apply-transcript-2.txt || { echo "APPLY_FAIL at $f (that file was rolled back as one transaction; earlier files stay applied; see section 5)"; exit 1; }
  done
  print -r -- "APPLY_OK $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-2.txt
)
```

If a block fails midway: the failing file is one transaction, so it left nothing behind. Earlier files stay applied. Fix the cause and run block B again (every file except 0006 is idempotent, and 0006 is skipped when its index exists).

## 5. Rollback notes (per migration)

Every migration runs as one transaction, so a failure inside a file undoes that whole file. These are only for undoing a file that APPLIED and that you then decide to back out. Do not run any of this against production without the owner's explicit go. Replace nothing in the URL, reuse `$DATABASE_URL_DIRECT`.

- 0010: undo as ONE transaction, both parts together (restore set_load_status from 0002 and drop the trigger), otherwise events stop being written. Block below.
- 0009: `drop trigger` x5 (`locations_touch_updated_at`, `carriers_touch_updated_at`, `customers_touch_updated_at`, `profiles_touch_updated_at`, `location_requests_touch_updated_at`) and `alter table ... drop column updated_at` on the five tables. The `dlv_locations_before_update` change is harmless to keep.
- 0008: `drop trigger profiles_last_admin_guard_update on public.profiles; drop trigger profiles_last_admin_guard_delete on public.profiles; drop function public.dlv_profiles_last_admin_guard();`
- 0007: `alter table public.load_documents drop constraint load_documents_path_ck; alter table public.load_documents add constraint load_documents_path_ck check (storage_path like load_id::text || '/' || kind || '/%');` and `update storage.buckets set file_size_limit = null, allowed_mime_types = null where id = 'documents';`. The stricter dlv_can_access_doc can stay: the app generates conforming paths.
- 0006: `drop index public.load_documents_storage_path_uq;`

## 6. Post-check (read only)

Block C. Expected values come from the same run: the counts saved by block A are compared with fresh counts.

```zsh
# BLOCK postcheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-2}"
  STATE="$DIR/state.env"
  [[ -f "$STATE" ]] || { echo "FAIL: no state file, run block A before the apply"; exit 1; }
  source "$STATE" || exit 1
  q() { { echo "set default_transaction_read_only = on;"; cat; } | psql "$DATABASE_URL_DIRECT" -X -A -t -q -v ON_ERROR_STOP=1 -f - ; }
  bad=0
  need() { if [[ "$2" == "$3" ]]; then print -r -- "PASS $1"; else print -r -- "FAIL $1 (got $2, want $3)"; bad=1; fi; }

  echo "--- row counts unchanged"
  for t in loads profiles load_events load_documents locations customers carriers location_requests; do
    v=$(q <<SQL
select count(*) from public.$t;
SQL
    ) || { echo "FAIL: count $t"; exit 1; }
    eval "want=\$PRE_count_$t"
    need "count $t unchanged" "$v" "$want"
  done

  echo "--- new objects present"
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
select count(*) from information_schema.columns where table_schema = 'public' and column_name = 'updated_at' and is_nullable = 'NO'
  and table_name in ('locations','carriers','customers','profiles','location_requests');
SQL
  ) || exit 1; need "updated_at not null on the 5 tables" "$v" "5"
  v=$(q <<'SQL'
select (to_regclass('public.load_documents_storage_path_uq') is not null)::int;
SQL
  ) || exit 1; need "unique index load_documents_storage_path_uq" "$v" "1"
  v=$(q <<'SQL'
select count(*) from pg_constraint where conname = 'load_documents_path_ck' and convalidated and position('{2,5}' in pg_get_constraintdef(oid)) > 0;
SQL
  ) || exit 1; need "load_documents_path_ck present, validated, strict shape" "$v" "1"
  v=$(q <<'SQL'
select (position('dlv.event_note' in pg_get_functiondef('public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure)) > 0
    and pg_get_functiondef('public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure) !~* 'insert into public[.]load_events')::int;
SQL
  ) || exit 1; need "set_load_status hands the note to the trigger and no longer inserts events" "$v" "1"
  v=$(q <<'SQL'
select (position('insert into public.load_events' in lower(pg_get_functiondef('public.set_load_eta(uuid, timestamptz, text)'::regprocedure))) > 0)::int;
SQL
  ) || exit 1; need "set_load_eta still writes its own event" "$v" "1"
  v=$(q <<'SQL'
select count(*) from (values ('loads','status'),('loads','pickup_date'),('loads','carrier_id'),('loads','customer_id'),('load_events','load_id')) h(t, c)
 where exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
               where i.indrelid = ('public.' || h.t)::regclass and i.indisvalid and a.attname = h.c);
SQL
  ) || exit 1; need "5 hot columns each lead an index" "$v" "5"

  echo "--- security posture unchanged"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity;
SQL
  ) || exit 1; need "RLS still enabled on every public table" "$v" "$PRE_rls_tables"
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
  v=$(q <<'SQL'
select (has_function_privilege('authenticated', 'public.set_load_status(uuid, public.load_status, timestamptz, text)', 'execute')
    and not has_function_privilege('anon', 'public.set_load_status(uuid, public.load_status, timestamptz, text)', 'execute'))::int;
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

After `POSTCHECK_OK`: deploy the app from main (Vercel), then follow the "After every deploy" list in docs/RUNBOOK.md. Optional app level smoke after the deploy: as staff, move a test load one step and check the timeline shows exactly one new row.

## Rehearsal result

Rehearsed on the LOCAL stack only (127.0.0.1:54322), never production. Method: `supabase db reset --version 0005` (production's state), a few representative rows inserted, then blocks A, B, C extracted from this file and run verbatim with `DATABASE_URL_DIRECT` exported to the local URL in that shell only (the `source ~/.zshenvmitrex` line was not run). Afterwards `supabase db reset` restored the full migration set.

Setup note: the local CLI treats `supabase db reset --version 0005` as the global `--version` flag and prints the CLI version without resetting. `supabase db reset --last 5` did the job (journal 0001 to 0005 plus seed.sql, confirmed from supabase_migrations.schema_migrations and the missing 0006 index). Rows inserted at that state: 1 load, 2 events, 1 document (conforming path), 3 profiles, 1 carrier. Blocks were run with `zsh -f` so the machine's startup files could not replace the exported local URL.

| Step | Result |
| --- | --- |
| Block A pre-check | PRECHECK_OK. Counts before: loads 1, profiles 3, load_events 2, load_documents 1, locations 19, customers 1, carriers 1, location_requests 0. 6 PASS, flags for 0006 to 0010 all 0. |
| Block B apply | APPLY_OK. 0006, 0007, 0008, 0009, 0010 each applied in its own transaction; transcript has no connection string. |
| Block C post-check | POSTCHECK_OK, 25 of 25 PASS: all 8 counts unchanged, new functions, 7 triggers, 5 updated_at columns, unique index, strict CHECK validated, set_load_status text, 5 leading indexes, RLS on 8 of 8, anon zero grants, bucket limits. |
| Re-run of block B | APPLY_OK, 0006 reported SKIP (index present), the rest idempotent. |
| Negative arm: rollback block for 0010 then block C | ROLLBACK_0010_OK, then POSTCHECK_FAIL on exactly the 3 checks about 0010 (function, trigger count 6 of 7, set_load_status text). Block B again restored it, POSTCHECK_OK. |
| Negative arm: a legacy document path (`<load>/pod/legacy-name.jpg`) added at the 0005 state | Block A printed FAIL "load_documents rows violating the 0007 CHECK (got 1, want 0)" and PRECHECK_FAIL (do not apply). |

After the rehearsal `supabase db reset` restored all ten migrations.

