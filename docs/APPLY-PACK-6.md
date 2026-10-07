# Apply pack 6: migrations 0015 and 0016 (lane references) to production

For a SEPARATE, owner supervised production session. Nothing in this pack was run against production. It was
rehearsed against the local stack only (see "Rehearsal result"). Production holds migrations 0001 to 0014 (packs 2 to 5).

More migrations will be appended to this pack by later cards. The file list in section 1 and the `files=( ... )`
array at the top of block B are the only places that name migrations; every count and "highest number"
check is derived from that list (see "Extending this pack"). Do not edit block logic to add a migration.

Rules for the session
- The owner runs every block. Do not paste a connection string, key or password anywhere. Blocks print counts and PASS or FAIL only.
- Run in a quiet window (no carrier or customer actions). The post-check compares row counts with the pre-check, so live traffic between the two shows as a FAIL to investigate, not as a silent pass.
- Every block is zsh and runs inside a subshell `( ... )`, so a failure ends the block and never closes your terminal. Each block exits non-zero on failure and prints its own verdict. No block relies on `set -e`.
- Blocks keep state in `$DLV_APPLY_DIR` (default `~/dlv-apply-6`, mode 700). The state file holds counts, 0/1 flags and the names of the Moffett sites that were off (location names, no secrets).
- 0015 and 0016 delete nothing and change no load, user or document. 0016 sets `requires_moffett = true` on up to seven locations (the pre-check lists which ones) and writes 25 lane rows. The lane numbers are staff only: no customer or carrier screen, email or export carries them.

## 1. Migrations not yet in production (in order)

| File | What it does | Risk |
| --- | --- | --- |
| 0015_lane_references.sql | Lane references (DLV-028, R39). New table `lane_references` (pickup location, delivery location, truck size 26 / 36 / 53, the ITS load to copy as digits with an optional dash and digits up to 30 characters, optional note, created_at, updated_at, updated_by). UNIQUE on pickup + delivery + size, CHECK pickup differs from delivery. RLS on; all privileges revoked from PUBLIC and anon by name; select, insert, update, delete granted to authenticated; exactly four policies, one per command, each admitting only an ACTIVE staff user (`dlv_is_staff()`, so staff_admin and staff_csr alike). No policy for customers or carriers, so they read and write nothing. Not in the realtime publication. One small trigger function sets `updated_by` from the session; the shared touch trigger keeps `updated_at`. | Low. One new empty table and one new function. Nothing existing is altered. Idempotent (IF NOT EXISTS, CREATE OR REPLACE, grants restated by name). Rolling back means section 5. |
| 0016_lane_references_seed.sql | The owner's 25 lane references (shipper, receiver, truck size, ITS load to copy), joined to `locations` BY NAME. Every one of the 17 names is resolved first: a missing or ambiguous name raises one exception and nothing at all is written. Then `requires_moffett = true` for 1HAM, 152 Sh, 831 Queen, Glengarry, Kitney site, Military Trailsite and PrimeFab (only where it is false now; SAMIH already is). The lanes the owner left out on purpose (125G, D Express and MTD to Etobicoke, 481 to Brampton, Mitrex to Winnipeg) are NOT added. | Low. 25 inserted rows and up to 7 location flags. Idempotent: applying it again changes nothing (an upsert on the scenario key; the flag update only touches rows still false). The pre-check refuses to start if any name does not resolve. |

Visible effect of the Moffett flags: on /book, choosing one of those seven sites as pickup or delivery switches the Moffett toggle on and locks it, as SAMIH already does. Tell Maria before the deploy.

## 2. Order of operations: migration first, then the app

Recommendation: apply 0015 and 0016 first, then deploy the app from main straight away.

Reasons
1. 0015 and 0016 are additive and backward compatible. The app that is live now never reads `lane_references`. The only thing it does differently is the Moffett lock on seven sites (a database value the live app already honours).
2. The new app needs 0015: the Lanes page, the "ITS load to copy" card, the board line and the staff request email all read `lane_references`. Deploying the app first is safe (the card says "The lane reference could not be loaded", the email says "lookup failed", nothing else breaks), but the feature does not work until the apply.
3. If the migration fails, nothing user visible has changed yet and the app is untouched.

## 3. Pre-check (read only)

Session setup. Run this in the terminal you will use for every block below. It loads DATABASE_URL_DIRECT without printing it.

```
set -o allexport; source ~/.zshenvmitrex; set +o allexport
cd ~/Documents/Projects/GitHub/Mitrex-DLV && git fetch origin && git checkout feat/dlv-028-lane-references
```

(If this branch was merged, `git checkout main && git pull` instead. The migration files must be exactly the ones listed above.)

Block A, pre-check. Read only: every statement runs with `default_transaction_read_only = on`, so it cannot change data even by mistake.

```zsh
# BLOCK precheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-6}"
  mkdir -p "$DIR" || exit 1
  chmod 700 "$DIR" || exit 1
  STATE="$DIR/state.env"
  : > "$STATE" || exit 1
  q() { { echo "set default_transaction_read_only = on;"; cat; } | psql "$DATABASE_URL_DIRECT" -X -A -t -q -v ON_ERROR_STOP=1 -f - ; }
  bad=0
  rec() { print -r -- "$1=$2" >> "$STATE"; print -r -- "  $1 = $2"; }
  recq() { print -r -- "$1=${(q)2}" >> "$STATE"; print -r -- "  $1 = $2"; }
  need() { if [[ "$2" == "$3" ]]; then print -r -- "PASS $1"; else print -r -- "FAIL $1 (got $2, want $3)"; bad=1; fi; }

  echo "--- connection"
  v=$(q <<'SQL'
select current_database() || ' / server ' || current_setting('server_version') || ' / read_only=' || current_setting('default_transaction_read_only');
SQL
  ) || { echo "FAIL: cannot connect"; exit 1; }
  echo "  $v"

  echo "--- row counts (before)"
  for t in loads profiles load_events load_documents locations customers carriers location_requests load_deletions; do
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

  echo "--- production migration state is 0001 to 0014 (the 0001 to 0013 objects first)"
  v=$(q <<'SQL'
select count(*) from pg_tables where schemaname = 'public';
SQL
  ) || exit 1; need "9 public tables (the 8 of 0001 plus load_deletions)" "$v" "9"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity;
SQL
  ) || exit 1; need "RLS enabled on all 9 tables" "$v" "9"; rec PRE_rls_tables "$v"
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

  echo "--- 0013 its load number is present"
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

  echo "--- 0014 is present (this pack starts after pack 5)"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'load_deletions' and c.relkind = 'r' and c.relrowsecurity;
SQL
  ) || exit 1; need "load_deletions exists with RLS enabled" "$v" "1"
  v=$(q <<'SQL'
select (to_regprocedure('public.delete_load_forever(uuid, text)') is not null
    and to_regprocedure('public.record_load_deletion_orphans(uuid, text[])') is not null)::int;
SQL
  ) || exit 1; need "delete_load_forever and record_load_deletion_orphans exist" "$v" "1"
  v=$(q <<'SQL'
select (has_table_privilege('authenticated', 'public.loads', 'delete') or has_table_privilege('anon', 'public.loads', 'delete'))::int;
SQL
  ) || exit 1; need "no client role holds DELETE on loads" "$v" "0"

  echo "--- nothing of 0015 exists yet (must be absent)"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'lane_references';
SQL
  ) || exit 1; need "no table named lane_references" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'dlv_lane_references_before_write';
SQL
  ) || exit 1; need "no function named dlv_lane_references_before_write" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_policies where schemaname = 'public' and tablename = 'lane_references';
SQL
  ) || exit 1; need "no policy on lane_references" "$v" "0"

  echo "--- 0016 needs every shipper and receiver name to resolve to exactly one location (17 names)"
  v=$(q <<'SQL'
with n(name) as (values ('125G'), ('152 Sh'), ('1HAM'), ('481 University Ave'), ('831 Queen'), ('D Express Transport'), ('Glengarry'), ('Howden'), ('Kitney site'), ('Military Trailsite'), ('Mitrex'), ('PrimeFab'), ('QuickScrap Metal'), ('SAMIH'), ('Sherbourne'), ('Spadina'), ('Valley Metal Finishing Ltd'))
select coalesce(string_agg(n.name || ' (' || (select count(*) from public.locations l where l.name = n.name) || ' matches)', ', ' order by n.name), '')
  from n where (select count(*) from public.locations l where l.name = n.name) <> 1;
SQL
  ) || exit 1; need "all 17 names resolve to exactly one location (a bad name is listed here with its match count)" "$v" ""

  echo "--- the seven Moffett sites (informational; 0016 turns on only those that are false)"
  v=$(q <<'SQL'
select coalesce(string_agg(name, '|' order by name), '') from public.locations
 where name in ('1HAM', '152 Sh', '831 Queen', 'Glengarry', 'Kitney site', 'Military Trailsite', 'PrimeFab') and not requires_moffett;
SQL
  ) || exit 1; recq PRE_moffett_false_sites "$v"
  v=$(q <<'SQL'
select count(*) from public.locations where name in ('1HAM', '152 Sh', '831 Queen', 'Glengarry', 'Kitney site', 'Military Trailsite', 'PrimeFab') and not requires_moffett;
SQL
  ) || exit 1; rec PRE_moffett_false7 "$v"
  v=$(q <<'SQL'
select count(*) from public.locations where requires_moffett;
SQL
  ) || exit 1; rec PRE_moffett_true "$v"
  v=$(q <<'SQL'
select count(*) from public.loads;
SQL
  ) || exit 1; print -r -- "  (informational) loads: $v. 0015 and 0016 do not touch loads."

  echo "--- foreign keys that reference loads (unchanged by this pack)"
  v=$(q <<'SQL'
select count(*) from pg_constraint where confrelid = 'public.loads'::regclass and contype = 'f';
SQL
  ) || exit 1; need "exactly two foreign keys reference loads (load_events, load_documents)" "$v" "2"

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

Stop here unless it printed `PRECHECK_OK`. A FAIL on "0001 to 0014 state" means an earlier pack is not fully applied: do not apply. A FAIL on "must be absent" means something of 0015 already exists: stop and investigate (do not run block B). A FAIL on "all 17 names resolve to exactly one location" lists the names that are missing (0 matches) or ambiguous (2 or more) with their match count: fix the location names in the Locations page (or tell the developer which lane name to change) and run block A again. The Moffett site list, the loads count and the load, document and ITS counts are informational.

## 4. Apply

Block B. One transaction per migration (`--single-transaction`), stops at the first failure, full transcript in `apply-transcript-6.txt` (repo root, it contains no connection string). The migration list and the expected highest number live in the `files` array.

```zsh
# BLOCK apply
(
  setopt pipefail
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-6}"
  [[ -f "$DIR/state.env" ]] || { echo "FAIL: run the pre-check (block A) first"; exit 1; }
  grep -qx 'PRECHECK_RESULT=OK' "$DIR/state.env" || { echo "FAIL: the last pre-check (block A) did not end in PRECHECK_OK. Do not apply. Fix the cause and run block A again."; exit 1; }
  files=(
    0015_lane_references.sql
    0016_lane_references_seed.sql
  )
  for f in $files; do
    [[ -f "supabase/migrations/$f" ]] || { echo "FAIL: missing supabase/migrations/$f (run from the repo root)"; exit 1; }
  done
  last="${files[-1]%%_*}"
  highest=$(ls supabase/migrations | grep '^[0-9]' | sort | tail -1)
  [[ "${highest%%_*}" == "$last" ]] || { echo "FAIL: the highest migration file is ${highest%%_*} but the last file in this pack is $last"; exit 1; }
  count=$(ls supabase/migrations | grep -c '^[0-9]')
  [[ "$count" -eq $((10#$last)) ]] || { echo "FAIL: expected $((10#$last)) migration files (0001 to $last, none missing), found $count"; exit 1; }
  print -r -- "apply started $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-6.txt
  for f in $files; do
    print -r -- "=== $f" | tee -a apply-transcript-6.txt
    psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f "supabase/migrations/$f" 2>&1 | tee -a apply-transcript-6.txt || { echo "APPLY_FAIL at $f (that file was rolled back as one transaction; earlier files stay applied; see section 5)"; exit 1; }
  done
  print -r -- "APPLY_OK $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-6.txt
)
```

If a block fails midway: the failing file is one transaction, so it left nothing behind. Earlier files stay applied. Fix the cause and run block B again (every file is idempotent).

## 5. Rollback notes (per migration)

Every migration runs as one transaction, so a failure inside a file undoes that whole file. These are only for undoing a file that APPLIED and that you then decide to back out. Do not run any of this against production without the owner's explicit go. Reuse `$DATABASE_URL_DIRECT`. Roll back 0016 first, then 0015, together with a rollback of the app to a build without the Lanes page.

- 0016: deletes the 25 seed scenarios and turns `requires_moffett` back off for exactly the sites the pre-check recorded as off (read from the state file of block A). It refuses to run when `lane_references` holds a number of rows other than 25 (staff added or removed lanes) unless `DLV_ALLOW_LANE_LOSS=1` is exported; with it, only the 25 seed scenarios are deleted and lanes staff added stay.
- 0015: drops the table `lane_references` and its trigger function, as ONE transaction. WARNING: every lane row goes with the table (export the CSV from /admin/lanes first if staff added or changed any). The block refuses to run while the table holds rows unless `DLV_ALLOW_LANE_LOSS=1` is exported. Nothing else is touched: 0015 changed no existing object.

```zsh
# BLOCK rollback-0016
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-6}"
  [[ -f "$DIR/state.env" ]] || { echo "FAIL: no state file (it holds the sites that were off before the apply)"; exit 1; }
  source "$DIR/state.env" || exit 1
  n=$(echo "select count(*) from public.lane_references;" | psql "$DATABASE_URL_DIRECT" -X -A -t -q -v ON_ERROR_STOP=1 -f -) || { echo "FAIL: cannot count lane_references (is 0015 applied?)"; exit 1; }
  if [[ "$n" != "25" && "$DLV_ALLOW_LANE_LOSS" != "1" ]]; then
    echo "FAIL: lane_references holds $n rows, not the 25 of the seed. Staff added or removed lanes. Rolling back 0016 deletes the 25 seed scenarios only, and the others stay; export DLV_ALLOW_LANE_LOSS=1 only with the owner's explicit go."
    exit 1
  fi
  psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -v sites="${PRE_moffett_false_sites}" -f - <<'SQL' || exit 1
delete from public.lane_references l using public.locations p, public.locations d
 where p.id = l.pickup_location_id and d.id = l.delivery_location_id
   and (p.name, d.name, l.equipment_size) in (
     ('D Express Transport', '481 University Ave', 53),
     ('Mitrex', '481 University Ave', 26),
     ('Mitrex', '481 University Ave', 53),
     ('481 University Ave', 'QuickScrap Metal', 26),
     ('481 University Ave', 'QuickScrap Metal', 53),
     ('481 University Ave', 'Mitrex', 53),
     ('481 University Ave', 'Mitrex', 26),
     ('Mitrex', '125G', 26),
     ('Mitrex', 'QuickScrap Metal', 26),
     ('Valley Metal Finishing Ltd', 'Mitrex', 26),
     ('Mitrex', 'Spadina', 26),
     ('Mitrex', 'Sherbourne', 26),
     ('Howden', 'Sherbourne', 26),
     ('Sherbourne', 'Howden', 26),
     ('Sherbourne', 'QuickScrap Metal', 26),
     ('Mitrex', '1HAM', 26),
     ('Mitrex', '152 Sh', 26),
     ('Mitrex', '831 Queen', 26),
     ('Mitrex', 'SAMIH', 26),
     ('SAMIH', 'Mitrex', 26),
     ('SAMIH', 'QuickScrap Metal', 26),
     ('Mitrex', 'Glengarry', 26),
     ('Mitrex', 'Kitney site', 26),
     ('Mitrex', 'Military Trailsite', 26),
     ('Mitrex', 'PrimeFab', 26)
   );
update public.locations set requires_moffett = false
 where name = any (string_to_array(:'sites', '|')) and requires_moffett;
SQL
  echo ROLLBACK_0016_OK
)
```

```zsh
# BLOCK rollback-0015
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  n=$(echo "select count(*) from public.lane_references;" | psql "$DATABASE_URL_DIRECT" -X -A -t -q -v ON_ERROR_STOP=1 -f -) || { echo "FAIL: cannot count lane_references (is 0015 applied?)"; exit 1; }
  if [[ "$n" != "0" && "$DLV_ALLOW_LANE_LOSS" != "1" ]]; then
    echo "FAIL: lane_references holds $n row(s). Rolling back 0015 drops them for good (run rollback-0016 first, and export the CSV from /admin/lanes if staff added lanes). Export DLV_ALLOW_LANE_LOSS=1 only with the owner's explicit go."
    exit 1
  fi
  psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f - <<'SQL' || exit 1
drop table if exists public.lane_references;
drop function if exists public.dlv_lane_references_before_write();
SQL
  echo ROLLBACK_0015_OK
)
```

## 6. Post-check (read only)

Block C. Expected values come from the same run: the counts saved by block A are compared with fresh counts, and the 25 lane rows are compared with the owner's table embedded in the block (both directions, plus the derived Moffett Y or N of every row). Checks that belong to a file in the pack are grouped under that file's number. Every pack 5 assertion (0014, 0013, 0011, 0012, pack 2 objects, security posture) is repeated and must still hold; the only expected differences are the new table (RLS table count plus one, policy count plus four).

```zsh
# BLOCK postcheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-6}"
  STATE="$DIR/state.env"
  [[ -f "$STATE" ]] || { echo "FAIL: no state file, run block A before the apply"; exit 1; }
  source "$STATE" || exit 1
  q() { { echo "set default_transaction_read_only = on;"; cat; } | psql "$DATABASE_URL_DIRECT" -X -A -t -q -v ON_ERROR_STOP=1 -f - ; }
  bad=0
  need() { if [[ "$2" == "$3" ]]; then print -r -- "PASS $1"; else print -r -- "FAIL $1 (got $2, want $3)"; bad=1; fi; }
  FN="'public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure"
  ITS="to_regprocedure('public.set_its_load_number(uuid, text)')"  # NULL when absent, so a missing function is a FAIL line, not a crash

  echo "--- row counts unchanged"
  for t in loads profiles load_events load_documents locations customers carriers location_requests load_deletions; do
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
  ) 2>/dev/null || v="query failed (is the column missing?)"; need "ITS numbers unchanged (0015 and 0016 write none)" "$v" "$PRE_its_numbers"

  echo "--- 0015 lane_references (staff only)"
  LANE="'public.lane_references'::regclass"
  LFN="to_regprocedure('public.dlv_lane_references_before_write()')"   # NULL when absent: a FAIL line, not a crash
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'lane_references' and c.relkind = 'r' and c.relrowsecurity;
SQL
  ) || exit 1; need "lane_references exists with RLS enabled" "$v" "1"
  v=$(q <<'SQL'
select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'lane_references' and
  ((column_name = 'id' and data_type = 'uuid' and is_nullable = 'NO')
or (column_name = 'pickup_location_id' and data_type = 'uuid' and is_nullable = 'NO')
or (column_name = 'delivery_location_id' and data_type = 'uuid' and is_nullable = 'NO')
or (column_name = 'equipment_size' and data_type = 'integer' and is_nullable = 'NO')
or (column_name = 'its_reference_load' and data_type = 'text' and is_nullable = 'NO')
or (column_name = 'note' and data_type = 'text' and is_nullable = 'YES')
or (column_name = 'created_at' and data_type = 'timestamp with time zone' and is_nullable = 'NO')
or (column_name = 'updated_at' and data_type = 'timestamp with time zone' and is_nullable = 'NO')
or (column_name = 'updated_by' and data_type = 'uuid' and is_nullable = 'YES'));
SQL
  ) || exit 1; need "lane_references has the 9 columns with the agreed types and nullability" "$v" "9"
  v=$(q <<'SQL'
select count(*) from pg_constraint where conrelid = 'public.lane_references'::regclass and contype = 'f' and confrelid = 'public.locations'::regclass and convalidated;
SQL
  ) || exit 1; need "two validated foreign keys to locations (pickup, delivery)" "$v" "2"
  v=$(q <<'SQL'
select count(*) from pg_constraint where conrelid = 'public.lane_references'::regclass and convalidated
   and conname in ('lane_references_size_ck', 'lane_references_number_ck', 'lane_references_distinct_ck', 'lane_references_scenario_uq');
SQL
  ) || exit 1; need "size, number, pickup-differs-from-delivery CHECKs and the scenario UNIQUE exist and are validated" "$v" "4"
  v=$(q <<'SQL'
select (select pg_get_constraintdef(oid) from pg_constraint where conname = 'lane_references_size_ck' and conrelid = 'public.lane_references'::regclass) like '%26%'
   and (select pg_get_constraintdef(oid) from pg_constraint where conname = 'lane_references_size_ck' and conrelid = 'public.lane_references'::regclass) like '%36%'
   and (select pg_get_constraintdef(oid) from pg_constraint where conname = 'lane_references_size_ck' and conrelid = 'public.lane_references'::regclass) like '%53%'
   and (select pg_get_constraintdef(oid) from pg_constraint where conname = 'lane_references_size_ck' and conrelid = 'public.lane_references'::regclass) not like '%48%'
   and (select pg_get_constraintdef(oid) from pg_constraint where conname = 'lane_references_number_ck' and conrelid = 'public.lane_references'::regclass) like '%[0-9]+%'
   and (select pg_get_constraintdef(oid) from pg_constraint where conname = 'lane_references_number_ck' and conrelid = 'public.lane_references'::regclass) like '%30%'
   and (select pg_get_constraintdef(oid) from pg_constraint where conname = 'lane_references_scenario_uq' and conrelid = 'public.lane_references'::regclass) like 'UNIQUE (pickup_location_id, delivery_location_id, equipment_size)';
SQL
  ) 2>/dev/null || v="query failed (is the table missing?)"; need "size allows 26 36 53 (not 48), number is digits with an optional dash and digits up to 30, unique on pickup + delivery + size" "$v" "t"
  v=$(q <<SQL
select (select count(*) from pg_trigger where not tgisinternal and tgenabled = 'O' and tgrelid = $LANE
          and tgname in ('lane_references_set_actor', 'lane_references_touch_updated_at')) = 2
   and ($LFN is not null)
   and not has_function_privilege('anon', $LFN, 'execute')
   and not has_function_privilege('authenticated', $LFN, 'execute');
SQL
  ) 2>/dev/null || v="query failed (is the table missing?)"; need "actor and updated_at triggers enabled; the trigger function is not executable by anon or authenticated" "$v" "t"
  v=$(q <<'SQL'
select (not has_table_privilege('anon', 'public.lane_references', 'select')
    and not has_table_privilege('anon', 'public.lane_references', 'insert')
    and not has_table_privilege('anon', 'public.lane_references', 'update')
    and not has_table_privilege('anon', 'public.lane_references', 'delete')
    and not has_table_privilege('anon', 'public.lane_references', 'truncate')
    and not exists (select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                     where c.oid = 'public.lane_references'::regclass and a.grantee = 0)
    and has_table_privilege('authenticated', 'public.lane_references', 'select')
    and has_table_privilege('authenticated', 'public.lane_references', 'insert')
    and has_table_privilege('authenticated', 'public.lane_references', 'update')
    and has_table_privilege('authenticated', 'public.lane_references', 'delete')
    and not has_table_privilege('authenticated', 'public.lane_references', 'truncate')
    and not has_table_privilege('authenticated', 'public.lane_references', 'references')
    and not has_table_privilege('authenticated', 'public.lane_references', 'trigger'))::int;
SQL
  ) 2>/dev/null || v="query failed (is the table missing?)"; need "grants: nothing for anon or PUBLIC; authenticated select, insert, update, delete only" "$v" "1"
  v=$(q <<'SQL'
select count(*) from pg_policy where polrelid = 'public.lane_references'::regclass;
SQL
  ) || exit 1; need "exactly four policies on lane_references" "$v" "4"
  v=$(q <<'SQL'
select count(distinct polcmd) from pg_policy where polrelid = 'public.lane_references'::regclass and polcmd in ('r', 'a', 'w', 'd');
SQL
  ) || exit 1; need "one policy each for select, insert, update and delete" "$v" "4"
  v=$(q <<'SQL'
select count(*) from pg_policies where schemaname = 'public' and tablename = 'lane_references' and roles = '{authenticated}'
   and coalesce(qual, with_check) like '%dlv_is_staff()%'
   and coalesce(qual, '') !~ 'customer|carrier|dlv_role|true' and coalesce(with_check, '') !~ 'customer|carrier|dlv_role|true';
SQL
  ) || exit 1; need "all four are for authenticated, gated by dlv_is_staff(), with no customer or carrier role and no open (true) policy" "$v" "4"
  v=$(q <<'SQL'
select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lane_references';
SQL
  ) || exit 1; need "lane_references is not in the realtime publication (no payload can reach a customer or carrier)" "$v" "0"

  echo "--- 0016 lane data (expected set embedded below, compared in both directions)"
  v=$(q <<'SQL'
select count(*) from public.lane_references;
SQL
  ) || exit 1; need "exactly 25 lane references" "$v" "25"
  v=$(q <<'SQL'
with exp(shipper, receiver, size, its, moffett) as (values
  ('D Express Transport', '481 University Ave', 53, '653', false),
  ('Mitrex', '481 University Ave', 26, '1269', false),
  ('Mitrex', '481 University Ave', 53, '1264', false),
  ('481 University Ave', 'QuickScrap Metal', 26, '1275', false),
  ('481 University Ave', 'QuickScrap Metal', 53, '1265', false),
  ('481 University Ave', 'Mitrex', 53, '829', false),
  ('481 University Ave', 'Mitrex', 26, '752', false),
  ('Mitrex', '125G', 26, '1488', false),
  ('Mitrex', 'QuickScrap Metal', 26, '1278', false),
  ('Valley Metal Finishing Ltd', 'Mitrex', 26, '1292', false),
  ('Mitrex', 'Spadina', 26, '810', false),
  ('Mitrex', 'Sherbourne', 26, '1484', false),
  ('Howden', 'Sherbourne', 26, '1475', false),
  ('Sherbourne', 'Howden', 26, '1486', false),
  ('Sherbourne', 'QuickScrap Metal', 26, '1439', false),
  ('Mitrex', '1HAM', 26, '158', true),
  ('Mitrex', '152 Sh', 26, '292', true),
  ('Mitrex', '831 Queen', 26, '1468', true),
  ('Mitrex', 'SAMIH', 26, '1469', true),
  ('SAMIH', 'Mitrex', 26, '1241', true),
  ('SAMIH', 'QuickScrap Metal', 26, '1471', true),
  ('Mitrex', 'Glengarry', 26, '1470', true),
  ('Mitrex', 'Kitney site', 26, '1084', true),
  ('Mitrex', 'Military Trailsite', 26, '776', true),
  ('Mitrex', 'PrimeFab', 26, '1293', true)
), act as (
  select p.name as shipper, d.name as receiver, l.equipment_size as size, l.its_reference_load as its
    from public.lane_references l
    join public.locations p on p.id = l.pickup_location_id
    join public.locations d on d.id = l.delivery_location_id
)
select (select count(*) from (select shipper, receiver, size, its from exp except select * from act) q)
     || '/' || (select count(*) from (select * from act except select shipper, receiver, size, its from exp) q);
SQL
  ) || exit 1; need "the (pickup, delivery, size, number) set equals the owner table: 0 missing / 0 extra" "$v" "0/0"
  v=$(q <<'SQL'
select count(*) from public.lane_references where equipment_size = 36;
SQL
  ) || exit 1; need "no 36 ft row yet (upcoming projects)" "$v" "0"
  v=$(q <<'SQL'
select count(*) from public.locations where name in ('1HAM', '152 Sh', '831 Queen', 'Glengarry', 'Kitney site', 'Military Trailsite', 'PrimeFab') and requires_moffett;
SQL
  ) || exit 1; need "the 7 sites now require Moffett" "$v" "7"
  v=$(q <<'SQL'
select requires_moffett::int from public.locations where name = 'SAMIH';
SQL
  ) || exit 1; need "SAMIH still requires Moffett" "$v" "1"
  v=$(q <<'SQL'
select count(*) from public.locations where requires_moffett;
SQL
  ) || exit 1; need "locations that require Moffett = those before plus the sites that were off (no other location changed)" "$v" "$((PRE_moffett_true + PRE_moffett_false7))"
  v=$(q <<'SQL'
with exp(shipper, receiver, size, its, moffett) as (values
  ('D Express Transport', '481 University Ave', 53, '653', false),
  ('Mitrex', '481 University Ave', 26, '1269', false),
  ('Mitrex', '481 University Ave', 53, '1264', false),
  ('481 University Ave', 'QuickScrap Metal', 26, '1275', false),
  ('481 University Ave', 'QuickScrap Metal', 53, '1265', false),
  ('481 University Ave', 'Mitrex', 53, '829', false),
  ('481 University Ave', 'Mitrex', 26, '752', false),
  ('Mitrex', '125G', 26, '1488', false),
  ('Mitrex', 'QuickScrap Metal', 26, '1278', false),
  ('Valley Metal Finishing Ltd', 'Mitrex', 26, '1292', false),
  ('Mitrex', 'Spadina', 26, '810', false),
  ('Mitrex', 'Sherbourne', 26, '1484', false),
  ('Howden', 'Sherbourne', 26, '1475', false),
  ('Sherbourne', 'Howden', 26, '1486', false),
  ('Sherbourne', 'QuickScrap Metal', 26, '1439', false),
  ('Mitrex', '1HAM', 26, '158', true),
  ('Mitrex', '152 Sh', 26, '292', true),
  ('Mitrex', '831 Queen', 26, '1468', true),
  ('Mitrex', 'SAMIH', 26, '1469', true),
  ('SAMIH', 'Mitrex', 26, '1241', true),
  ('SAMIH', 'QuickScrap Metal', 26, '1471', true),
  ('Mitrex', 'Glengarry', 26, '1470', true),
  ('Mitrex', 'Kitney site', 26, '1084', true),
  ('Mitrex', 'Military Trailsite', 26, '776', true),
  ('Mitrex', 'PrimeFab', 26, '1293', true)
)
select count(*) || '/' || count(*) filter (where (p.requires_moffett or d.requires_moffett) is distinct from e.moffett)
  from exp e join public.locations p on p.name = e.shipper join public.locations d on d.name = e.receiver;
SQL
  ) || exit 1; need "derived Moffett (pickup or delivery requires it) equals the owner's Y or N for all 25 rows: 25 rows / 0 mismatches" "$v" "25/0"

  echo "--- 0014 admin delete of loads (pack 5 assertions, unchanged by 0015 and 0016)"
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

  echo "--- 0013 its load number (pack 4 assertions, unchanged)"
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
  ) || exit 1; need "RLS enabled on every public table (the 9 before plus lane_references)" "$v" "$((PRE_rls_tables + 1))"
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
 where n.nspname = 'public' and p.proname in ('dlv_profiles_last_admin_guard','dlv_loads_status_event','dlv_touch_updated_at','dlv_locations_before_update','dlv_loads_before_insert','dlv_loads_before_update','dlv_lane_references_before_write')
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
  ) || exit 1; need "policy count is the old count plus the four lane_references policies" "$v" "$((PRE_policies + 4))"
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

After `POSTCHECK_OK`: deploy the app from main (Vercel), then follow the "After every deploy" list in docs/RUNBOOK.md. App level smoke after the deploy: sign in as staff, open a Requested load: the "ITS load to copy" card is above "Carrier and booking" (for Mitrex to 481 University Ave at 26 ft it reads 1269); open Lanes (25 rows); sign in as Maria: there is no Lanes page (the address redirects) and no number anywhere. Do not create real loads to test: book a throwaway load as Maria and cancel it.

## Extending this pack

A later card that adds a migration (for example 0017) does exactly three things and changes no block logic:
1. Add a row to the table in section 1.
2. Append the file name to the `files=( ... )` array in block B. The "highest file equals the last file in the list" and "file count equals the highest number" checks then expect 0017 by themselves.
3. Add a group of PASS checks for the new file to block C, and any read only data check to block A. The row count, security posture and earlier migration groups stay as they are (adjust the expected RLS table and policy counts by what the new file adds).

## Rehearsal result

Rehearsed on the LOCAL stack only (127.0.0.1:54322), never production, on 2026-10-06 by the engineering assistant (DLV-028 card).

IMPORTANT LIMIT, read first: the harness this session ran in REFUSES to execute zsh files (the same refusal packs 4 and 5 recorded), so the blocks were NOT run verbatim under `zsh -f`. What was run instead: the blocks were extracted from this file by a script and a small python driver (not the shell) ran EVERY SQL statement of blocks A and C through psql (block A read only, block C read only), compared each result with the expected value the block uses (including the values derived from the state file: `PRE_moffett_true + PRE_moffett_false7`, `PRE_rls_tables + 1`, `PRE_policies + 4`), and ran block B's file and count checks and its one command per file exactly as written (`psql --single-transaction -v ON_ERROR_STOP=1 -f supabase/migrations/<file>`). The shell logic (the subshell, `need`, `rec`, `recq`, the state file, the PRECHECK_RESULT gate, the rollback guards) was NOT executed, and the `zsh -n` syntax check was also refused. The shell parts are the pack 5 parts, which ran on 2026-10-07, with one new helper (`recq`, which writes the Moffett site names with zsh quoting `${(q)2}` so `source` reads them back). The lead must run blocks A, B and C once on the local stack under `zsh -f` before the production session (`supabase db reset --last 2`, add the production-like rows below, export DATABASE_URL_DIRECT to the local URL in that shell only, set DLV_APPLY_DIR to a scratch folder), and run `recq` once to confirm the state file sources back.

Method: `supabase_migrations.schema_migrations` was read first (16 rows, max version 0016). `supabase db reset --last 2` then left 14 rows, max version 0014, with no `lane_references` table (read back from the catalog before trusting it). Note: `--last N` undoes the last N migrations of the full set, so it equals production's state only while this pack holds exactly two files. Because `supabase db reset` also re-runs supabase/seed.sql, whose lane block now sets 7 sites to requires_moffett true, those 7 were set back to false (as in production) before the check, and production-like rows were inserted: 1 staff_admin, 1 customer user, 1 load (requested). Afterwards `supabase db reset` restored all sixteen migrations. (The seed block has a guard for a database that stops before 0015: after `--last 2` it printed a NOTICE and did nothing, instead of failing.)

| Step | Result |
| --- | --- |
| Block A pre-check (SQL through psql, read only) | 25 PASS, 0 FAIL: 9 public tables, RLS 9 of 9, the 0001 to 0013 objects, 0014 present (table, both functions, no client DELETE on loads), 0015 absent (no table, no function, no policy), all 17 shipper and receiver names resolve to exactly one location, exactly two foreign keys reference loads. Recorded: PRE_moffett_false_sites = `152 Sh|1HAM|831 Queen|Glengarry|Kitney site|Military Trailsite|PrimeFab`, PRE_moffett_false7 = 7, PRE_moffett_true = 1 (SAMIH), loads 1 (informational). |
| Block B apply (the files array, one command each) | File checks hold (16 files, highest 0016). 0015 and 0016 each applied in one transaction, rc 0, 0 error lines. |
| Block C post-check (SQL through psql, read only) | 59 PASS, 0 FAIL. Includes: every count unchanged, lane_references with RLS and the 9 agreed columns, two foreign keys to locations, the four constraints validated, the trigger function not executable by anon or authenticated, nothing for anon or PUBLIC, exactly four policies (one per command, authenticated only, dlv_is_staff(), no customer or carrier role, none open), not in the realtime publication, 25 rows, the (pickup, delivery, size, number) set equal to the owner table in both directions (0 missing / 0 extra), no 36 ft row, the 7 sites on and Moffett total = before + 7, the derived Moffett equal to the owner's Y or N for all 25 rows (25 rows / 0 mismatches), and every pack 5 assertion (0014, 0013, 0011, 0012, pack 2 objects, security posture with RLS tables plus one and policies plus four). |
| Re-run of B then C | 0 error lines, then 59 PASS, 0 FAIL (idempotent). |
| Negative arm: block A after the apply | 5 FAIL (do not apply): "9 public tables" got 10, "RLS enabled on all 9 tables" got 10, "no table named lane_references" got 1, "no function named dlv_lane_references_before_write" got 1, "no policy on lane_references" got 4. The other 20 checks PASS. |
| Negative arm: a location renamed (Howden to Howden X) | Block A: 1 FAIL, `all 17 names resolve to exactly one location (got Howden (0 matches), want )`, so the missing name is printed; PRECHECK FAIL. Restored afterwards. |
| Rollback 0016 SQL | The SQL of block rollback-0016 ran with the recorded site list: DELETE 25, UPDATE 7; lane rows 25 to 0, Moffett locations 8 to 1. |
| Functional rules of 0015 and 0016 | Not part of the blocks. supabase/tests/rls.sql section 15 (full seed set compared, derived Moffett for all 25 rows, staff admin and csr read and write, customer, other customer, carrier owner, carrier driver and inactive staff refused with guards, constraints, updated_by, applying 0016 twice more, a missing name writes nothing) runs on a fresh `supabase db reset`; nine mutations of the migration or data were each caught by it. |

### Lead rehearsal of the real blocks (2026-10-07)

The blocks were extracted verbatim and run under `zsh -f` against the local stack only, from `supabase db reset --last 2` (state 0014) plus production-like rows (one staff admin, one customer user, two loads) with the seven Moffett sites set to false. Block A: PRECHECK_OK. Block B: APPLY_OK. Block C: 76 PASS, POSTCHECK_OK. Block B again: APPLY_OK (idempotent). Block C again: POSTCHECK_OK. Rollback-0016, then block C: POSTCHECK_FAIL on exactly the lane checks. Block B again restored it and block C gave POSTCHECK_OK.

## Production result (2026-10-07)

- Block A: PRECHECK_OK. Block B: APPLY_OK at 2026-10-07T12:39:09Z, 0015 and 0016 both applied with no errors.
- Block C: 72 PASS and 4 FAIL. The 4 FAILs were the row-count comparisons (loads, load_events, load_documents, load_deletions). Cause: the owner deleted two cancelled test loads (MTX-0001 and MTX-0002) with the new admin delete at 12:37:58Z and 12:38:07Z, while the pre-check was still reading its counts. Both appear in `load_deletions`, which holds exactly those two rows. Every schema and lane check passed (25 lanes, the number set equals the owner table, the 7 Moffett sites on, staff-only security).
- App PR #28 merged as 0cb5c03 after the checks passed. Production deploy of that commit succeeded; /api/health returned ok and /login returned 200.
