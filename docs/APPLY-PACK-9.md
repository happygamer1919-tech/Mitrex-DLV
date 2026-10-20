# Apply pack 9: migration 0019 (return loads) to production

For a SEPARATE, owner supervised production session. Nothing in this pack was run against production. It was
rehearsed against the local stack only (see "Rehearsal result"). Production holds migrations 0001 to 0018 (packs 2 to 8).

The file list in section 1 and the `files=( ... )` array at the top of block B are the only places that name
migrations; every count and "highest number" check is derived from that list (see "Extending this pack").

Rules for the session
- The owner runs every block. Do not paste a connection string, key or password anywhere. Blocks print counts and PASS or FAIL only.
- Run in a quiet window (no customer or staff actions). The post-check compares row counts with the pre-check, so live traffic between the two shows as a FAIL to investigate, not as a silent pass.
- Every block is zsh and runs inside a subshell `( ... )`, so a failure ends the block and never closes your terminal. Each block exits non-zero on failure and prints its own verdict. No block relies on `set -e`.
- Blocks keep state in `$DLV_APPLY_DIR` (default `~/dlv-apply-9`, mode 700). The state file holds counts and 0/1 flags, no secrets.
- 0019 adds one nullable column, one foreign key, one index and one function, and replaces three functions. It changes, deletes and rewrites no row: no load, user, document, lane, rate request or status is touched.

## 1. Migrations not yet in production (in order)

| File | What it does | Risk |
| --- | --- | --- |
| 0019_return_loads.sql | Return loads (DLV-038, R43). New nullable column `loads.return_of_load_id` (uuid, no default, so adding it rewrites nothing) with the foreign key `loads_return_of_load_id_fkey` to `loads(id)` ON DELETE SET NULL and the partial index `loads_return_of_load_id_idx`. New function `dlv_return_original(uuid)` (SECURITY DEFINER, search_path empty; it returns the original's customer, pickup, delivery and status only to a caller who may already read that load; authenticated may execute it, anon may not). `dlv_check_load_locations` is replaced: the 0002 body plus one rule (a return load picking up at its original's delivery location only needs an active pickup, and may deliver to the original's pickup location even when it cannot receive). `dlv_loads_before_insert` is replaced: the 0013 body plus one rule (a signed-in insert that names an original needs the same customer, the pickup equal to the original's delivery location and, for a non staff caller, an original at delivery or delivered). `dlv_loads_before_update` is replaced: the 0013 body plus two rules (the link is immutable for every signed-in user, and a customer cannot move a return's pickup). | Low. Every existing load has `return_of_load_id` NULL, so every existing load and every ordinary new load follows exactly the old rules. The column is additive; nothing is converted. Idempotent (IF NOT EXISTS, the constraint added only when missing, CREATE OR REPLACE, grants restated by name). Rolling back means section 5. |

Visible effect (after the app deploy): Maria sees a **Return** button on loads that are At delivery or Delivered, and a return form; staff see a **Return** badge, the link to the original and **Use the same carrier**. Tell Maria and the staff (docs/MARIA-GUIDE.md "Book a return", docs/STAFF-GUIDE.md "Return loads").

## 2. Order of operations: migration first, then the app

Recommendation: apply 0019 first, then merge the PR and let it deploy.

Reasons
1. 0019 is fully backward compatible with the app that is live now: the old app never names `return_of_load_id`, so every old insert and update follows exactly the old rules. Leaving the migration applied for hours before the deploy is safe.
2. The new app NEEDS 0019: the board, the calendar and the load pages select `return_of_load_id`. Deploying the app first would show "Could not load the board" on /admin and break the return form until the migration is applied.
3. If the migration fails, nothing user visible has changed yet and the app is untouched.

## 3. Pre-check (read only)

Session setup. Run this in the terminal you will use for every block below. It loads DATABASE_URL_DIRECT without printing it.

```
set -o allexport; source ~/.zshenvmitrex; set +o allexport
cd ~/Documents/Projects/GitHub/Mitrex-DLV && git fetch origin && git checkout feat/dlv-038-return-loads
```

(If this branch was merged, `git checkout main && git pull` instead. The migration files must be exactly the ones listed above.)

Block A, pre-check. Read only: every statement runs with `default_transaction_read_only = on`, so it cannot change data even by mistake.

```zsh
# BLOCK precheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-9}"
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

  echo "--- INFORMATIONAL: loads Maria could return once the app is deployed (never a failure)"
  v=$(q <<'SQL'
select count(*) from public.loads where status in ('at_delivery', 'delivered');
SQL
  ) || exit 1; print -r -- "  loads at delivery or delivered now: $v"

  echo "--- production migration state is 0001 to 0018"
  v=$(q <<'SQL'
select count(*) from pg_tables where schemaname = 'public';
SQL
  ) || exit 1; need "11 public tables (0001 to 0018)" "$v" "11"; rec PRE_public_tables "$v"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity;
SQL
  ) || exit 1; need "RLS enabled on all 11 tables" "$v" "11"; rec PRE_rls_tables "$v"
  v=$(q <<'SQL'
select (to_regprocedure('public.delete_load_photo(uuid)') is not null
    and to_regprocedure('public.dlv_check_load_locations(public.loads)') is not null
    and to_regprocedure('public.dlv_loads_before_insert()') is not null
    and to_regprocedure('public.dlv_loads_before_update()') is not null
    and to_regprocedure('public.set_rate_quote(uuid, numeric, text, text, date)') is not null)::int;
SQL
  ) || exit 1; need "functions of 0002, 0013, 0017 and 0018 present" "$v" "1"
  v=$(q <<'SQL'
select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'load_documents' and column_name = 'captured_at';
SQL
  ) || exit 1; need "0018 is applied (load_documents.captured_at exists)" "$v" "1"
  v=$(q <<'SQL'
select (position('its_load_number := null' in pg_get_functiondef('public.dlv_loads_before_insert()'::regprocedure)) > 0
    and position('its_load_number changes only through set_its_load_number' in pg_get_functiondef('public.dlv_loads_before_update()'::regprocedure)) > 0)::int;
SQL
  ) || exit 1; need "the two load trigger functions carry the 0013 bodies that 0019 builds on" "$v" "1"
  v=$(q <<'SQL'
select (position('is_active' in pg_get_functiondef('public.dlv_is_staff()'::regprocedure)) > 0
    and position('is_active' in pg_get_functiondef('public.dlv_role()'::regprocedure)) > 0
    and position('is_active' in pg_get_functiondef('public.dlv_customer_id()'::regprocedure)) > 0)::int;
SQL
  ) || exit 1; need "dlv_is_staff, dlv_role and dlv_customer_id are inactive aware (0005)" "$v" "1"
  v=$(q <<'SQL'
select count(*) from public.customers where name = 'Mitrex';
SQL
  ) || exit 1; need "customer Mitrex exists" "$v" "1"
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
select count(*) from pg_constraint where contype = 'f' and confrelid = 'public.loads'::regclass;
SQL
  ) || exit 1; need "exactly two foreign keys reference loads (load_events, load_documents)" "$v" "2"

  echo "--- nothing of 0019 exists yet (must be absent)"
  v=$(q <<'SQL'
select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'loads' and column_name = 'return_of_load_id';
SQL
  ) || exit 1; need "no column loads.return_of_load_id" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'dlv_return_original';
SQL
  ) || exit 1; need "no function dlv_return_original" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_constraint where conname = 'loads_return_of_load_id_fkey';
SQL
  ) || exit 1; need "no constraint loads_return_of_load_id_fkey" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_indexes where schemaname = 'public' and indexname = 'loads_return_of_load_id_idx';
SQL
  ) || exit 1; need "no index loads_return_of_load_id_idx" "$v" "0"
  v=$(q <<'SQL'
select (position('return_of_load_id' in pg_get_functiondef('public.dlv_check_load_locations(public.loads)'::regprocedure)) > 0
     or position('return_of_load_id' in pg_get_functiondef('public.dlv_loads_before_insert()'::regprocedure)) > 0
     or position('return_of_load_id' in pg_get_functiondef('public.dlv_loads_before_update()'::regprocedure)) > 0)::int;
SQL
  ) || exit 1; need "the three functions 0019 replaces do not mention return_of_load_id yet" "$v" "0"

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
  [[ "$v" -ge 1 ]] || { echo "FAIL: no active customer user in production (investigate before applying)"; bad=1; }
  v=$(q <<'SQL'
select count(*) from pg_policies where schemaname in ('public','storage');
SQL
  ) || exit 1; rec PRE_policies "$v"
  v=$(q <<'SQL'
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';
SQL
  ) || exit 1; rec PRE_public_functions "$v"
  v=$(q <<'SQL'
select count(*) from pg_publication_tables where pubname = 'supabase_realtime';
SQL
  ) || exit 1; rec PRE_realtime_tables "$v"
  v=$(q <<'SQL'
select count(*) from pg_indexes where schemaname = 'public' and tablename = 'loads';
SQL
  ) || exit 1; rec PRE_loads_indexes "$v"

  if [[ $bad -ne 0 ]]; then print -r -- "PRECHECK_RESULT=FAIL" >> "$STATE"; echo "PRECHECK_FAIL (do not apply)"; exit 1; fi
  print -r -- "PRECHECK_RESULT=OK" >> "$STATE" || exit 1
  echo "PRECHECK_OK (state saved in $STATE)"
)
```

Stop here unless it printed `PRECHECK_OK`. A FAIL on "0001 to 0018 state" means an earlier pack is not fully applied: do not apply. A FAIL on "must be absent" means something of 0019 already exists: stop and investigate (do not run block B). The loads count, the per status counts and the informational line are not failures.

## 4. Apply

Block B. One transaction per migration (`--single-transaction`), stops at the first failure, full transcript in `apply-transcript-9.txt` (repo root, it contains no connection string; do not commit it). The migration list and the expected highest number live in the `files` array.

```zsh
# BLOCK apply
(
  setopt pipefail
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-9}"
  [[ -f "$DIR/state.env" ]] || { echo "FAIL: run the pre-check (block A) first"; exit 1; }
  grep -qx 'PRECHECK_RESULT=OK' "$DIR/state.env" || { echo "FAIL: the last pre-check (block A) did not end in PRECHECK_OK. Do not apply. Fix the cause and run block A again."; exit 1; }
  files=(
    0019_return_loads.sql
  )
  for f in $files; do
    [[ -f "supabase/migrations/$f" ]] || { echo "FAIL: missing supabase/migrations/$f (run from the repo root)"; exit 1; }
  done
  last="${files[-1]%%_*}"
  highest=$(ls supabase/migrations | grep '^[0-9]' | sort | tail -1)
  [[ "${highest%%_*}" == "$last" ]] || { echo "FAIL: the highest migration file is ${highest%%_*} but the last file in this pack is $last"; exit 1; }
  count=$(ls supabase/migrations | grep -c '^[0-9]')
  [[ "$count" -eq $((10#$last)) ]] || { echo "FAIL: expected $((10#$last)) migration files (0001 to $last, none missing), found $count"; exit 1; }
  print -r -- "apply started $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-9.txt
  for f in $files; do
    print -r -- "=== $f" | tee -a apply-transcript-9.txt
    psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f "supabase/migrations/$f" 2>&1 | tee -a apply-transcript-9.txt || { echo "APPLY_FAIL at $f (that file was rolled back as one transaction; earlier files stay applied; see section 5)"; exit 1; }
  done
  print -r -- "APPLY_OK $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-9.txt
)
```

If a block fails midway: the failing file is one transaction, so it left nothing behind. Fix the cause and run block B again (the file is idempotent).

## 5. Rollback notes (per migration)

The migration runs as one transaction, so a failure inside the file undoes the whole file. This is only for undoing a file that APPLIED and that you then decide to back out. Do not run it against production without the owner's explicit go. Reuse `$DATABASE_URL_DIRECT`. Roll back together with a rollback of the app to a build without return loads (the new app selects the column).

- 0019: puts back the 0018 definitions of `dlv_loads_before_insert` and `dlv_loads_before_update` (the 0013 bodies) and `dlv_check_load_locations` (the 0002 body), drops `dlv_return_original`, the index, the foreign key and the column `loads.return_of_load_id`, as ONE transaction. WARNING: every return link goes (the return loads themselves stay as ordinary loads, but no longer say what they return from, and a later location edit of a return that picks up at a site that cannot ship is refused by the old rule). The block refuses to run while any load has a link unless `DLV_ALLOW_RETURN_LINK_LOSS=1` is exported (use it only with the owner's explicit go). Nothing else is touched: no load row is deleted, no status, event or document changes.

```zsh
# BLOCK rollback-0019
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  n=$(echo "select count(*) from public.loads where return_of_load_id is not null;" | psql "$DATABASE_URL_DIRECT" -X -A -t -q -v ON_ERROR_STOP=1 -f -) || { echo "FAIL: cannot count return links (is 0019 applied?)"; exit 1; }
  if [[ "$n" != "0" && "$DLV_ALLOW_RETURN_LINK_LOSS" != "1" ]]; then
    echo "FAIL: $n load(s) are linked as returns. Rolling back 0019 drops those links (the loads stay). Export DLV_ALLOW_RETURN_LINK_LOSS=1 only with the owner's explicit go."
    exit 1
  fi
  psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f - <<'SQL' || exit 1
-- dlv_loads_before_insert and dlv_loads_before_update: the 0013 bodies (production before 0019)
create or replace function public.dlv_loads_before_insert() returns trigger
language plpgsql set search_path = ''
as $fn$
declare v_moff boolean;
begin
  v_moff := public.dlv_check_load_locations(new);
  if v_moff then new.moffett := true; end if;
  if auth.uid() is not null and not public.dlv_is_staff() then
    new.status := 'requested';
    new.carrier_id := null;
    new.eta := null;
    new.booked_at := null;
    new.delivered_at := null;
    new.cancelled_at := null;
    new.created_by := auth.uid();
    new.its_load_number := null;
  end if;
  return new;
end
$fn$;
create or replace function public.dlv_loads_before_update() returns trigger
language plpgsql set search_path = ''
as $fn$
declare v_moff boolean;
begin
  new.updated_at := now();
  if auth.uid() is null then return new; end if;  -- service role / owner tooling
  if new.its_load_number is distinct from old.its_load_number
     and coalesce(current_setting('dlv.its_fn', true), '') <> '1' then
    raise exception 'its_load_number changes only through set_its_load_number' using errcode = '42501';
  end if;
  if current_setting('dlv.status_fn', true) = '1' then return new; end if;

  if new.load_number is distinct from old.load_number
     or new.customer_id is distinct from old.customer_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'immutable load column' using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     or new.eta is distinct from old.eta
     or new.booked_at is distinct from old.booked_at
     or new.delivered_at is distinct from old.delivered_at
     or new.cancelled_at is distinct from old.cancelled_at then
    raise exception 'status and eta change only through set_load_status' using errcode = '42501';
  end if;
  if not public.dlv_is_staff() and new.carrier_id is distinct from old.carrier_id then
    raise exception 'carrier_id is staff only' using errcode = '42501';
  end if;
  if new.pickup_location_id is distinct from old.pickup_location_id
     or new.delivery_location_id is distinct from old.delivery_location_id then
    v_moff := public.dlv_check_load_locations(new);
    if v_moff then new.moffett := true; end if;
  end if;
  return new;
end
$fn$;
revoke all on function public.dlv_loads_before_insert(), public.dlv_loads_before_update() from public, anon, authenticated;
grant execute on function public.dlv_loads_before_insert(), public.dlv_loads_before_update() to service_role;

-- dlv_check_load_locations: the 0002 body (production before 0019)
create or replace function public.dlv_check_load_locations(p public.loads) returns boolean
language plpgsql stable security definer set search_path = ''
as $fn$
declare pu public.locations; de public.locations;
begin
  select * into pu from public.locations where id = p.pickup_location_id;
  select * into de from public.locations where id = p.delivery_location_id;
  if not pu.can_ship or not pu.is_active then
    raise exception 'pickup location cannot ship' using errcode = 'P0001';
  end if;
  if not de.can_receive or not de.is_active then
    raise exception 'delivery location cannot receive' using errcode = 'P0001';
  end if;
  return pu.requires_moffett or de.requires_moffett;
end
$fn$;
revoke all on function public.dlv_check_load_locations(public.loads) from public, anon;
grant execute on function public.dlv_check_load_locations(public.loads) to authenticated, service_role;

drop function if exists public.dlv_return_original(uuid);
drop index if exists public.loads_return_of_load_id_idx;
alter table public.loads drop constraint if exists loads_return_of_load_id_fkey;
alter table public.loads drop column if exists return_of_load_id;
SQL
  echo ROLLBACK_0019_OK
)
```

## 6. Post-check (read only)

Block C. Expected values come from the same run: the counts saved by block A are compared with fresh counts, and the security posture of the changed objects is checked against the catalog. It changes nothing.

```zsh
# BLOCK postcheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-9}"
  STATE="$DIR/state.env"
  [[ -f "$STATE" ]] || { echo "FAIL: no state file, run block A before the apply"; exit 1; }
  source "$STATE" || exit 1
  q() { { echo "set default_transaction_read_only = on;"; cat; } | psql "$DATABASE_URL_DIRECT" -X -A -t -q -v ON_ERROR_STOP=1 -f - ; }
  bad=0
  need() { if [[ "$2" == "$3" ]]; then print -r -- "PASS $1"; else print -r -- "FAIL $1 (got $2, want $3)"; bad=1; fi; }
  CHK="pg_get_functiondef('public.dlv_check_load_locations(public.loads)'::regprocedure)"
  INS="pg_get_functiondef('public.dlv_loads_before_insert()'::regprocedure)"
  UPD="pg_get_functiondef('public.dlv_loads_before_update()'::regprocedure)"
  RET="to_regprocedure('public.dlv_return_original(uuid)')"

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
select count(*) from public.loads where return_of_load_id is not null;
SQL
  ) || { echo "FAIL loads.return_of_load_id is missing (0019 is not applied)"; echo "POSTCHECK_FAIL"; exit 1; }
  need "no load is linked as a return yet (the apply links nothing)" "$v" "0"

  echo "--- 0019 loads: shape"
  v=$(q <<SQL
select data_type || ':' || is_nullable || ':' || coalesce(column_default, 'nodefault') from information_schema.columns where table_schema = 'public' and table_name = 'loads' and column_name = 'return_of_load_id';
SQL
  ) || exit 1; need "loads.return_of_load_id is a nullable uuid without a default" "$v" "uuid:YES:nodefault"
  v=$(q <<SQL
select count(*) from pg_constraint where conrelid = 'public.loads'::regclass and conname = 'loads_return_of_load_id_fkey'
   and contype = 'f' and confrelid = 'public.loads'::regclass and confdeltype = 'n' and convalidated;
SQL
  ) || exit 1; need "the foreign key to loads(id) is ON DELETE SET NULL and validated" "$v" "1"
  v=$(q <<SQL
select count(*) from pg_constraint where contype = 'f' and confrelid = 'public.loads'::regclass;
SQL
  ) || exit 1; need "exactly three foreign keys reference loads (load_events, load_documents, the return link)" "$v" "3"
  v=$(q <<SQL
select count(*) from pg_constraint where contype = 'f' and confrelid = 'public.loads'::regclass and confdeltype = 'c'
   and conrelid in ('public.load_events'::regclass, 'public.load_documents'::regclass);
SQL
  ) || exit 1; need "load_events and load_documents still cascade (a delete is never blocked)" "$v" "2"
  v=$(q <<SQL
select count(*) from pg_indexes where schemaname = 'public' and tablename = 'loads' and indexname = 'loads_return_of_load_id_idx' and indexdef like '%(return_of_load_id)%';
SQL
  ) || exit 1; need "the index on return_of_load_id exists" "$v" "1"
  v=$(q <<SQL
select count(*) from pg_indexes where schemaname = 'public' and tablename = 'loads';
SQL
  ) || exit 1; need "loads has its old indexes plus one" "$v" "$((PRE_loads_indexes + 1))"

  echo "--- 0019 functions"
  v=$(q <<SQL
select count(*) from pg_proc where oid in ($RET, to_regprocedure('public.dlv_check_load_locations(public.loads)'))
   and prosecdef and proconfig @> array['search_path=""'];
SQL
  ) || exit 1; need "dlv_return_original and dlv_check_load_locations are SECURITY DEFINER with an empty search_path" "$v" "2"
  v=$(q <<SQL
select count(*) from pg_proc where oid in (to_regprocedure('public.dlv_loads_before_insert()'), to_regprocedure('public.dlv_loads_before_update()'))
   and not prosecdef and proconfig @> array['search_path=""'];
SQL
  ) || exit 1; need "the two trigger functions stay SECURITY INVOKER with an empty search_path" "$v" "2"
  v=$(q <<SQL
select (has_function_privilege('authenticated', $RET, 'execute')
    and not has_function_privilege('anon', $RET, 'execute')
    and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $RET and a.grantee = 0)
    and has_function_privilege('authenticated', to_regprocedure('public.dlv_check_load_locations(public.loads)'), 'execute')
    and not has_function_privilege('anon', to_regprocedure('public.dlv_check_load_locations(public.loads)'), 'execute')
    and not has_function_privilege('anon', to_regprocedure('public.dlv_loads_before_insert()'), 'execute')
    and not has_function_privilege('authenticated', to_regprocedure('public.dlv_loads_before_insert()'), 'execute')
    and not has_function_privilege('anon', to_regprocedure('public.dlv_loads_before_update()'), 'execute')
    and not has_function_privilege('authenticated', to_regprocedure('public.dlv_loads_before_update()'), 'execute'))::int;
SQL
  ) || exit 1; need "execute rights: authenticated the two helpers, nobody else, no client role the trigger functions" "$v" "1"
  v=$(q <<SQL
select (position('dlv_customer_id()' in pg_get_functiondef($RET)) > 0 and position('dlv_is_staff()' in pg_get_functiondef($RET)) > 0
    and position('auth.uid() is null' in pg_get_functiondef($RET)) > 0)::int;
SQL
  ) || exit 1; need "dlv_return_original answers only the service role, staff, or a user of the load's own customer" "$v" "1"
  v=$(q <<SQL
select (position('return_of_load_id' in $CHK) > 0 and position('pickup location cannot ship' in $CHK) > 0
    and position('delivery location cannot receive' in $CHK) > 0 and position('requires_moffett' in $CHK) > 0)::int;
SQL
  ) || exit 1; need "dlv_check_load_locations has the return rule and keeps the old messages and the Moffett result" "$v" "1"
  v=$(q <<SQL
select (position('the original load was not found' in $INS) > 0 and position('at delivery or delivered' in $INS) > 0
    and position('the pickup must be the delivery location of the original load' in $INS) > 0
    and position('its_load_number := null' in $INS) > 0 and position('dlv_check_load_locations' in $INS) > 0)::int;
SQL
  ) || exit 1; need "dlv_loads_before_insert has the three return rules and keeps the 0013 body" "$v" "1"
  v=$(q <<SQL
select (position('return_of_load_id is immutable' in $UPD) > 0
    and position('its_load_number changes only through set_its_load_number' in $UPD) > 0
    and position('immutable load column' in $UPD) > 0 and position('carrier_id is staff only' in $UPD) > 0
    and position('status and eta change only through set_load_status' in $UPD) > 0)::int;
SQL
  ) || exit 1; need "dlv_loads_before_update has the immutability rule and keeps every 0013 rule" "$v" "1"
  v=$(q <<SQL
select count(*) from pg_trigger where tgrelid = 'public.loads'::regclass and not tgisinternal and tgenabled = 'O'
   and tgname in ('loads_before_insert', 'loads_before_update', 'loads_after_insert', 'loads_status_event');
SQL
  ) || exit 1; need "the four load triggers are still there and enabled" "$v" "4"

  echo "--- security posture unchanged"
  v=$(q <<SQL
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity;
SQL
  ) || exit 1; need "RLS enabled on every public table (same 11)" "$v" "$PRE_rls_tables"
  v=$(q <<SQL
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
SQL
  ) || exit 1; need "no public table without RLS" "$v" "0"
  v=$(q <<SQL
select count(*) from pg_tables where schemaname = 'public';
SQL
  ) || exit 1; need "public table count unchanged (0019 adds no table)" "$v" "$PRE_public_tables"
  v=$(q <<SQL
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('select'),('insert'),('update'),('delete'),('truncate'),('references'),('trigger')) p(priv)
 where n.nspname = 'public' and c.relkind in ('r','v','m','p') and has_table_privilege('anon', c.oid, p.priv);
SQL
  ) || exit 1; need "anon table grants unchanged (zero)" "$v" "$PRE_anon_table_grants"
  v=$(q <<SQL
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute');
SQL
  ) || exit 1; need "anon can EXECUTE no function in public" "$v" "0"
  v=$(q <<SQL
select count(*) from pg_policies where schemaname in ('public','storage');
SQL
  ) || exit 1; need "policy count unchanged (0019 adds and replaces no policy)" "$v" "$PRE_policies"
  v=$(q <<SQL
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';
SQL
  ) || exit 1; need "function count is the old count plus one" "$v" "$((PRE_public_functions + 1))"
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

After `POSTCHECK_OK`: merge the PR and wait for the production deploy, then follow the "After every deploy" list in docs/RUNBOOK.md. App level smoke after the deploy: sign in as staff and open /admin (the board loads; no Return badge yet), open an existing delivered load as Maria: the page shows a **Return** button. Do NOT create real loads to test. Then run the manual test M14 in docs/ACCEPTANCE-CHECKLIST.md with a TEST load.

## Extending this pack

A later card that adds a migration (for example 0020) does exactly three things and changes no block logic:
1. Add a row to the table in section 1.
2. Append the file name to the `files=( ... )` array in block B. The "highest file equals the last file in the list" and "file count equals the highest number" checks then expect 0020 by themselves.
3. Add a group of PASS checks for the new file to block C, and any read only data check to block A. Adjust the expected function and policy counts by what the new file adds.

## Rehearsal result

Rehearsed on the LOCAL stack only (127.0.0.1:58322, the moved local ports of this machine), never production, on 2026-10-20 by the engineering assistant (DLV-038 card). REHEARSED VERBATIM: this time the harness ran zsh files. Each block was extracted from this file with a python regex (`` ```zsh\n# BLOCK name\n(.*?)\n``` ``; every block ends with a line that is exactly `)` and no other line in a block is exactly `)`) and run as `env -i PATH="$PATH" HOME="$HOME" DATABASE_URL_DIRECT=<the LOCAL url> DLV_APPLY_DIR=<fresh scratch dir> zsh -f <block file>` from a scratch folder whose `supabase` entry links to the repo's supabase folder (so the transcript stayed out of the repo). No production value was in that environment.

Method: `supabase db reset --last 1` took the local database to 0018 (read back from `supabase_migrations.schema_migrations`: max version 0018, 18 rows, no `return_of_load_id`). Production-like rows were inserted: 1 staff_admin, 1 customer user of Mitrex, 1 carrier owner and its carrier, 6 loads (requested, booked, loading, at_delivery, delivered, cancelled) from Mitrex to the site 1HAM. Afterwards `supabase db reset` restored the full local state.

| Step | Result |
| --- | --- |
| Block A pre-check | rc 0, 15 PASS, 0 FAIL, PRECHECK_OK. Informational: "loads at delivery or delivered now: 2". |
| Block B apply | rc 0, APPLY_OK, 0 error lines (19 migration files, highest 0019). |
| Block C post-check | rc 0, 44 PASS, 0 FAIL, POSTCHECK_OK. |
| Block B again, then block C | APPLY_OK (idempotent), then 44 PASS, POSTCHECK_OK. |
| Negative arm: block A after the apply | rc 1, PRECHECK_FAIL with 6 FAIL: three foreign keys reference loads, the column, the function, the constraint, the index exist, and the three functions mention return_of_load_id. |
| Negative arms of block C | `grant execute` on `dlv_return_original` to anon: 2 FAIL (execute rights, anon executes a function). Index dropped: 2 FAIL (index exists, index count). A linked return row inserted: 4 FAIL (loads count, load_events count, requested count, no load linked yet). Each was reverted and block C was green again. |
| Rollback 0019 | Refused while a return link existed (rc 1, "1 load(s) are linked as returns"), ran with `DLV_ALLOW_RETURN_LINK_LOSS=1` (rc 0, ROLLBACK_0019_OK). Block C then failed closed (rc 1, "FAIL loads.return_of_load_id is missing", POSTCHECK_FAIL) and block A gave PRECHECK_OK (15 PASS). The three functions after the rollback (definition and ACL), the public function count (30) and the loads column count (33) are byte identical to a pristine `supabase db reset --last 1` (md5 of the definitions compared). Block B then restored 0019 and block C gave 44 PASS, POSTCHECK_OK. |
| Final clean run (after the post-check verdict fix) | Fresh 0018 plus the same rows: A PRECHECK_OK, B APPLY_OK, C 44 PASS, POSTCHECK_OK. |
| Functional rules of 0019 | Not part of the blocks. supabase/tests/rls.sql section 19 (61 checks: customer, other customer, staff_admin, staff_csr, carriers, the service role, immutability also through the status function shortcut, the delete of an original, a second apply of the real file) and e2e/return-loads.spec.ts, on a fresh `supabase db reset`. 8 database mutations were each caught by rls.sql. |

## Production result

To be filled in after the owner supervised session (blocks A, B, C against production, then the merge and the deploy).
