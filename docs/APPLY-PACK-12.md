# Apply pack 12: migration 0022 (a carrier never sees a load that was never booked to it) to production

For a SEPARATE, owner supervised production session. Nothing in this pack was run against production. It was
rehearsed against the local stack only (see "Rehearsal result"). Production must hold migrations 0001 to 0021 first
(packs 2 to 11; 0021 is pack 11, customer locations). Block A refuses to continue when 0021 is missing.

The file list in section 1 and the `files=( ... )` array at the top of block B are the only places that name
migrations; every count and "highest number" check is derived from that list (see "Extending this pack").

Rules for the session
- The owner runs every block. Do not paste a connection string, key or password anywhere. Blocks print counts and PASS or FAIL only.
- Run in a quiet window (no customer or staff actions). The post-check compares row counts with the pre-check, so live traffic between the two shows as a FAIL to investigate, not as a silent pass.
- Every block is zsh and runs inside a subshell `( ... )`, so a failure ends the block and never closes your terminal. Each block exits non-zero on failure and prints its own verdict. No block relies on `set -e`.
- Blocks keep state in `$DLV_APPLY_DIR` (default `~/dlv-apply-12`, mode 700). The state file holds counts, 0/1 flags and md5 sums, no secrets.
- 0022 changes no row. It replaces one policy (`loads_select`) and three functions (`dlv_can_access_doc`, `dlv_carrier_can_see_location`, `dlv_customer_can_see_carrier`), each with one added condition, and restates their grants. No table, column, trigger or other policy is touched.

## 1. Migrations not yet in production (in order)

| File | What it does | Risk |
| --- | --- | --- |
| 0022_carrier_never_booked_cancel.sql | A carrier never sees a load that was never booked to it (DLV-043, CAR-01). Staff may save a carrier on a request before booking it; when that request was then cancelled (by Maria or by staff) the carrier saw the load, its addresses, contacts, timeline, BOL and the locations it uses, and Maria saw that carrier. Every carrier rule tested only `status <> 'requested'`; now it is `status <> 'requested' and (status <> 'cancelled' or booked_at is not null)`. Replaced: policy `loads_select` (carrier branch only), `dlv_can_access_doc` (the 0018 text plus the condition in the carrier branch), `dlv_carrier_can_see_location` and `dlv_customer_can_see_carrier` (the 0002 text plus the condition). All three stay SECURITY DEFINER with an empty search_path; EXECUTE stays revoked from PUBLIC and anon and granted to authenticated and service_role. | Low. Narrows what carriers (and, for the carrier row, customers) can read; nothing staff or customers do on their own loads changes. Loads put at a later status directly (no booked_at) stay visible, on purpose. Idempotent (CREATE OR REPLACE, DROP POLICY IF EXISTS, grants restated by name). Rolling back means section 5. |

Visible effect: right after the apply, a carrier no longer finds, on My loads or by link, a load that was cancelled while it was still a request (it was never theirs to carry). Every load that was booked once, including one cancelled after booking, looks exactly as before. Block A prints how many such cancelled loads exist (`PRE_cancel_never_booked_with_carrier`): those are the loads that disappear for their carrier, which is the fix.

## 2. Order of operations: 0022 first, then the app

Recommendation: apply 0022, then merge the DLV-043 PR and let it deploy. The order does not matter for safety: the app does not depend on 0022 and 0022 does not depend on the app. Apply first so the hole closes as early as possible.

Reasons
1. 0022 is backward compatible with the app that is live now: the app reads loads, documents and carriers through the same tables and policies; only the rows a carrier can read shrink.
2. If the migration fails, nothing user visible has changed and the app is untouched.

## 3. Pre-check (read only)

Session setup. Run this in the terminal you will use for every block below. It loads DATABASE_URL_DIRECT without printing it.

```
set -o allexport; source ~/.zshenvmitrex; set +o allexport
cd ~/Documents/Projects/GitHub/Mitrex-DLV && git fetch origin && git checkout fix/dlv-043-sanity-fixes
```

(If this branch was merged, `git checkout main && git pull` instead. The migration files must be exactly the ones listed above.)

Block A, pre-check. Read only: every statement runs with `default_transaction_read_only = on`, so it cannot change data even by mistake.

```zsh
# BLOCK precheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-12}"
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

  echo "--- what 0022 changes for carriers (information, not a failure)"
  v=$(q <<'SQL'
select count(*) from public.loads where status = 'cancelled' and carrier_id is not null and booked_at is null;
SQL
  ) || exit 1; rec PRE_cancel_never_booked_with_carrier "$v"
  echo "    (cancelled loads with a carrier that were never booked: these disappear for that carrier, which is the fix)"
  v=$(q <<'SQL'
select count(distinct carrier_id) from public.loads where status = 'cancelled' and carrier_id is not null and booked_at is null;
SQL
  ) || exit 1; rec PRE_carriers_losing_a_load "$v"
  v=$(q <<'SQL'
select count(*) from public.loads where status not in ('requested', 'cancelled') and booked_at is null;
SQL
  ) || exit 1; rec PRE_live_without_booked_at "$v"
  echo "    (loads past requested and not cancelled without booked_at: 0022 leaves them visible, the post-check proves the count is unchanged)"
  v=$(q <<'SQL'
select count(*) from public.loads where status = 'cancelled' and carrier_id is not null and booked_at is not null;
SQL
  ) || exit 1; rec PRE_cancel_after_booking_with_carrier "$v"
  echo "    (cancelled after booking: stay visible to their carrier)"

  echo "--- production migration state is 0001 to 0021"
  v=$(q <<'SQL'
select count(*) from pg_tables where schemaname = 'public';
SQL
  ) || exit 1; need "11 public tables (0001 to 0021)" "$v" "11"; rec PRE_public_tables "$v"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity;
SQL
  ) || exit 1; need "RLS enabled on all 11 tables" "$v" "11"; rec PRE_rls_tables "$v"
  v=$(q <<'SQL'
select (to_regprocedure('public.dlv_locations_before_insert()') is not null
    and to_regprocedure('public.dlv_location_customer_rules(public.locations)') is not null)::int;
SQL
  ) || exit 1; need "0021 is applied (dlv_locations_before_insert and dlv_location_customer_rules exist; run pack 11 first otherwise)" "$v" "1"
  v=$(q <<'SQL'
select (to_regprocedure('public.dlv_loads_detail_event()') is not null
    and to_regprocedure('public.dlv_return_original(uuid)') is not null
    and to_regprocedure('public.delete_load_photo(uuid)') is not null
    and to_regprocedure('public.dlv_can_access_doc(text, boolean)') is not null
    and to_regprocedure('public.dlv_carrier_can_see_location(uuid)') is not null
    and to_regprocedure('public.dlv_customer_can_see_carrier(uuid)') is not null)::int;
SQL
  ) || exit 1; need "functions of 0002, 0018, 0019 and 0020 present" "$v" "1"
  v=$(q <<'SQL'
select (position('pickup_photo' in pg_get_functiondef('public.dlv_can_access_doc(text, boolean)'::regprocedure)) > 0)::int;
SQL
  ) || exit 1; need "dlv_can_access_doc is the 0018 version (photo kinds)" "$v" "1"
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
select string_agg(policyname || ':' || cmd, ',' order by policyname) from pg_policies where schemaname = 'public' and tablename = 'loads';
SQL
  ) || exit 1; need "loads has its five policies" "$v" "loads_customer_insert:INSERT,loads_customer_update:UPDATE,loads_select:SELECT,loads_staff_insert:INSERT,loads_staff_update:UPDATE"

  echo "--- nothing of 0022 exists yet (must be absent)"
  v=$(q <<'SQL'
select (position('booked_at' in qual) > 0)::int from pg_policies where schemaname = 'public' and tablename = 'loads' and policyname = 'loads_select';
SQL
  ) || exit 1; need "loads_select has no booked_at condition yet" "$v" "0"
  v=$(q <<'SQL'
select ((position('booked_at' in pg_get_functiondef('public.dlv_can_access_doc(text, boolean)'::regprocedure)) > 0)::int
      + (position('booked_at' in pg_get_functiondef('public.dlv_carrier_can_see_location(uuid)'::regprocedure)) > 0)::int
      + (position('booked_at' in pg_get_functiondef('public.dlv_customer_can_see_carrier(uuid)'::regprocedure)) > 0)::int);
SQL
  ) || exit 1; need "none of the three helpers has a booked_at condition yet" "$v" "0"

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
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';
SQL
  ) || exit 1; rec PRE_public_functions "$v"
  v=$(q <<'SQL'
select count(*) from pg_publication_tables where pubname = 'supabase_realtime';
SQL
  ) || exit 1; rec PRE_realtime_tables "$v"
  v=$(q <<'SQL'
select md5(string_agg(policyname || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), E'\n' order by schemaname, tablename, policyname))
  from pg_policies where schemaname in ('public','storage') and not (schemaname = 'public' and tablename = 'loads' and policyname = 'loads_select');
SQL
  ) || exit 1; rec PRE_other_policies_md5 "$v"
  v=$(q <<'SQL'
select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.oid::regprocedure::text)) from pg_proc p
 where p.oid in ('public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure,
                 'public.set_its_load_number(uuid, text)'::regprocedure, 'public.set_load_eta(uuid, timestamptz, text)'::regprocedure,
                 'public.dlv_role()'::regprocedure, 'public.dlv_carrier_id()'::regprocedure, 'public.dlv_customer_id()'::regprocedure,
                 'public.dlv_is_staff()'::regprocedure, 'public.dlv_return_original(uuid)'::regprocedure);
SQL
  ) || exit 1; rec PRE_other_fn_md5 "$v"

  if [[ $bad -ne 0 ]]; then print -r -- "PRECHECK_RESULT=FAIL" >> "$STATE"; echo "PRECHECK_FAIL (do not apply)"; exit 1; fi
  print -r -- "PRECHECK_RESULT=OK" >> "$STATE" || exit 1
  echo "PRECHECK_OK (state saved in $STATE)"
)
```

Stop here unless it printed `PRECHECK_OK`. A FAIL on "0021 is applied" means pack 11 is not applied yet: apply pack 11 first. A FAIL on "must be absent" means something of 0022 already exists: stop and investigate (do not run block B). The loads counts, the per status counts and the three "what 0022 changes" numbers are not failures.

## 4. Apply

Block B. One transaction per migration (`--single-transaction`), stops at the first failure, full transcript in `apply-transcript-12.txt` (repo root, it contains no connection string; do not commit it). The migration list and the expected highest number live in the `files` array.

```zsh
# BLOCK apply
(
  setopt pipefail
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-12}"
  [[ -f "$DIR/state.env" ]] || { echo "FAIL: run the pre-check (block A) first"; exit 1; }
  grep -qx 'PRECHECK_RESULT=OK' "$DIR/state.env" || { echo "FAIL: the last pre-check (block A) did not end in PRECHECK_OK. Do not apply. Fix the cause and run block A again."; exit 1; }
  files=(
    0022_carrier_never_booked_cancel.sql
  )
  for f in $files; do
    [[ -f "supabase/migrations/$f" ]] || { echo "FAIL: missing supabase/migrations/$f (run from the repo root)"; exit 1; }
  done
  last="${files[-1]%%_*}"
  highest=$(ls supabase/migrations | grep '^[0-9]' | sort | tail -1)
  [[ "${highest%%_*}" == "$last" ]] || { echo "FAIL: the highest migration file is ${highest%%_*} but the last file in this pack is $last"; exit 1; }
  count=$(ls supabase/migrations | grep -c '^[0-9]')
  [[ "$count" -eq $((10#$last)) ]] || { echo "FAIL: expected $((10#$last)) migration files (0001 to $last, none missing), found $count"; exit 1; }
  print -r -- "apply started $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-12.txt
  for f in $files; do
    print -r -- "=== $f" | tee -a apply-transcript-12.txt
    psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f "supabase/migrations/$f" 2>&1 | tee -a apply-transcript-12.txt || { echo "APPLY_FAIL at $f (that file was rolled back as one transaction; earlier files stay applied; see section 5)"; exit 1; }
  done
  print -r -- "APPLY_OK $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-12.txt
)
```

If a block fails midway: the failing file is one transaction, so it left nothing behind. Fix the cause and run block B again (the file is idempotent).

## 5. Rollback notes (per migration)

The migration runs as one transaction, so a failure inside the file undoes the whole file. This is only for undoing a file that APPLIED and that you then decide to back out. Do not run it against production without the owner's explicit go. Reuse `$DATABASE_URL_DIRECT`. The app does not depend on 0022, so no app rollback is needed.

- 0022: puts back the 0003 policy `loads_select`, the 0018 text of `dlv_can_access_doc` and the 0002 text of `dlv_carrier_can_see_location` and `dlv_customer_can_see_carrier`, with their grants, as ONE transaction. No row changes. After it, the hole of CAR-01 is open again (a carrier sees a request that was cancelled before it was booked). To re-apply run block A again (it passes: the old texts are back), then block B, then block C.

```zsh
# BLOCK rollback-0022
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f - <<'SQL' || exit 1
create or replace function public.dlv_carrier_can_see_location(loc uuid) returns boolean
language sql stable security definer set search_path = ''
as $fn$
  select exists (
    select 1 from public.loads l
    where l.carrier_id = public.dlv_carrier_id()
      and l.status <> 'requested'
      and (l.pickup_location_id = loc or l.delivery_location_id = loc))
$fn$;
create or replace function public.dlv_customer_can_see_carrier(car uuid) returns boolean
language sql stable security definer set search_path = ''
as $fn$
  select exists (
    select 1 from public.loads l
    where l.customer_id = public.dlv_customer_id()
      and l.carrier_id = car and l.status <> 'requested')
$fn$;
create or replace function public.dlv_can_access_doc(path text, write boolean) returns boolean
language plpgsql stable security definer set search_path = ''
as $fn$
declare
  v_load uuid;
  v_kind text;
  l public.loads;
  v_role text;
begin
  -- Shape first, before any lookup. Case sensitive; $ anchors the true end of the string. Photo kinds take images only.
  if path is null or path !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/((bol|pod)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}|(pickup_photo|delivery_photo)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp))$' then
    return false;
  end if;
  v_role := public.dlv_role();
  if v_role is null then return false; end if;
  v_load := split_part(path, '/', 1)::uuid;
  v_kind := split_part(path, '/', 2);
  select * into l from public.loads where id = v_load;
  if not found then return false; end if;
  if v_role in ('staff_admin','staff_csr') then return true; end if;
  if v_role = 'customer' then
    if write or l.customer_id is distinct from public.dlv_customer_id() then return false; end if;
    if v_kind = 'pickup_photo' then return l.status in ('enroute','at_delivery','delivered'); end if;
    if v_kind = 'delivery_photo' then return l.status = 'delivered'; end if;
    return true;
  end if;
  -- carrier_owner, carrier_driver
  if l.carrier_id is distinct from public.dlv_carrier_id() or l.status = 'requested' then
    return false;
  end if;
  if write then
    if v_kind = 'pod' then return l.status in ('enroute','at_delivery','delivered'); end if;
    if v_kind = 'pickup_photo' then return l.status in ('at_pickup','loading'); end if;
    if v_kind = 'delivery_photo' then return l.status = 'at_delivery'; end if;
    return false;
  end if;
  return true;
end
$fn$;
drop policy if exists loads_select on public.loads;
create policy loads_select on public.loads for select to authenticated
  using (public.dlv_is_staff()
         or (public.dlv_role() = 'customer' and customer_id = public.dlv_customer_id())
         or (public.dlv_role() in ('carrier_owner','carrier_driver')
             and carrier_id = public.dlv_carrier_id() and status <> 'requested'));
revoke all on function public.dlv_carrier_can_see_location(uuid) from public, anon;
grant execute on function public.dlv_carrier_can_see_location(uuid) to authenticated, service_role;
revoke all on function public.dlv_customer_can_see_carrier(uuid) from public, anon;
grant execute on function public.dlv_customer_can_see_carrier(uuid) to authenticated, service_role;
revoke all on function public.dlv_can_access_doc(text, boolean) from public, anon;
grant execute on function public.dlv_can_access_doc(text, boolean) to authenticated, service_role;
SQL
  echo ROLLBACK_0022_OK
)
```

## 6. Post-check (read only)

Block C. Expected values come from the same run: the counts saved by block A are compared with fresh values, and the security posture of the replaced objects is checked against the catalog. It changes nothing.

```zsh
# BLOCK postcheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-12}"
  STATE="$DIR/state.env"
  [[ -f "$STATE" ]] || { echo "FAIL: no state file, run block A before the apply"; exit 1; }
  source "$STATE" || exit 1
  q() { { echo "set default_transaction_read_only = on;"; cat; } | psql "$DATABASE_URL_DIRECT" -X -A -t -q -v ON_ERROR_STOP=1 -f - ; }
  bad=0
  need() { if [[ "$2" == "$3" ]]; then print -r -- "PASS $1"; else print -r -- "FAIL $1 (got $2, want $3)"; bad=1; fi; }
  DOC="'public.dlv_can_access_doc(text, boolean)'::regprocedure"
  LOC="'public.dlv_carrier_can_see_location(uuid)'::regprocedure"
  CAR="'public.dlv_customer_can_see_carrier(uuid)'::regprocedure"

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
  v=$(q <<'SQL'
select count(*) from public.loads where status = 'cancelled' and carrier_id is not null and booked_at is null;
SQL
  ) || exit 1; need "cancelled never booked loads with a carrier unchanged (0022 changes no row)" "$v" "$PRE_cancel_never_booked_with_carrier"
  v=$(q <<'SQL'
select count(*) from public.loads where status not in ('requested', 'cancelled') and booked_at is null;
SQL
  ) || exit 1; need "live loads without booked_at unchanged" "$v" "$PRE_live_without_booked_at"

  echo "--- 0022: the policy and the three helpers"
  v=$(q <<'SQL'
select (position('booked_at' in qual) > 0)::int from pg_policies where schemaname = 'public' and tablename = 'loads' and policyname = 'loads_select';
SQL
  ) || exit 1
  if [[ "$v" != "1" ]]; then echo "FAIL loads_select has no booked_at condition (0022 is not applied)"; echo "POSTCHECK_FAIL"; exit 1; fi
  echo "PASS loads_select carries the booked_at condition"
  v=$(q <<'SQL'
select (qual like '%dlv_is_staff()%' and qual like '%''customer''%' and qual like '%customer_id = dlv_customer_id()%'
    and qual like '%carrier_id = dlv_carrier_id()%' and qual like '%''requested''%' and qual like '%''cancelled''%'
    and qual like '%booked_at IS NOT NULL%' and cmd = 'SELECT' and roles = '{authenticated}')::int
  from pg_policies where schemaname = 'public' and tablename = 'loads' and policyname = 'loads_select';
SQL
  ) || exit 1; need "loads_select keeps the staff and customer branches and narrows the carrier branch" "$v" "1"
  v=$(q <<SQL
select ((position('l.status <> ''cancelled'' or l.booked_at is not null' in pg_get_functiondef($LOC)) > 0)
    and (position('l.status <> ''cancelled'' or l.booked_at is not null' in pg_get_functiondef($CAR)) > 0)
    and (position('l.status = ''cancelled'' and l.booked_at is null' in pg_get_functiondef($DOC)) > 0)
    and (position('pickup_photo' in pg_get_functiondef($DOC)) > 0))::int;
SQL
  ) || exit 1; need "the three helpers carry the condition (and dlv_can_access_doc keeps the photo kinds)" "$v" "1"
  v=$(q <<SQL
select count(*) from pg_proc where oid in ($DOC, $LOC, $CAR) and prosecdef and proconfig @> array['search_path=""'];
SQL
  ) || exit 1; need "the three helpers are SECURITY DEFINER with an empty search_path" "$v" "3"
  v=$(q <<SQL
select (not has_function_privilege('anon', $DOC, 'execute') and not has_function_privilege('anon', $LOC, 'execute')
    and not has_function_privilege('anon', $CAR, 'execute')
    and has_function_privilege('authenticated', $DOC, 'execute') and has_function_privilege('authenticated', $LOC, 'execute')
    and has_function_privilege('authenticated', $CAR, 'execute')
    and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    where p.oid in ($DOC, $LOC, $CAR) and a.grantee = 0))::int;
SQL
  ) || exit 1; need "anon and PUBLIC may not execute the helpers, authenticated may" "$v" "1"
  v=$(q <<'SQL'
select string_agg(policyname || ':' || cmd, ',' order by policyname) from pg_policies where schemaname = 'public' and tablename = 'loads';
SQL
  ) || exit 1; need "loads policies are exactly the five expected" "$v" "loads_customer_insert:INSERT,loads_customer_update:UPDATE,loads_select:SELECT,loads_staff_insert:INSERT,loads_staff_update:UPDATE"
  v=$(q <<'SQL'
select md5(string_agg(policyname || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), E'\n' order by schemaname, tablename, policyname))
  from pg_policies where schemaname in ('public','storage') and not (schemaname = 'public' and tablename = 'loads' and policyname = 'loads_select');
SQL
  ) || exit 1; need "every other policy is byte identical" "$v" "$PRE_other_policies_md5"
  v=$(q <<'SQL'
select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.oid::regprocedure::text)) from pg_proc p
 where p.oid in ('public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure,
                 'public.set_its_load_number(uuid, text)'::regprocedure, 'public.set_load_eta(uuid, timestamptz, text)'::regprocedure,
                 'public.dlv_role()'::regprocedure, 'public.dlv_carrier_id()'::regprocedure, 'public.dlv_customer_id()'::regprocedure,
                 'public.dlv_is_staff()'::regprocedure, 'public.dlv_return_original(uuid)'::regprocedure);
SQL
  ) || exit 1; need "the status, ITS, ETA and identity functions are byte identical (0022 replaces none)" "$v" "$PRE_other_fn_md5"

  echo "--- security posture unchanged"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity;
SQL
  ) || exit 1; need "RLS enabled on every public table (same 11)" "$v" "$PRE_rls_tables"
  v=$(q <<'SQL'
select count(*) from pg_tables where schemaname = 'public';
SQL
  ) || exit 1; need "public table count unchanged (0022 adds no table)" "$v" "$PRE_public_tables"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('select'),('insert'),('update'),('delete'),('truncate'),('references'),('trigger')) p(priv)
 where n.nspname = 'public' and c.relkind in ('r','v','m','p') and has_table_privilege('anon', c.oid, p.priv);
SQL
  ) || exit 1; need "anon table grants unchanged (zero)" "$v" "$PRE_anon_table_grants"
  v=$(q <<'SQL'
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute');
SQL
  ) || exit 1; need "anon can EXECUTE no function in public" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_policies where schemaname in ('public','storage');
SQL
  ) || exit 1; need "policy count unchanged (one replaced)" "$v" "$PRE_policies"
  v=$(q <<'SQL'
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';
SQL
  ) || exit 1; need "function count unchanged (three replaced)" "$v" "$PRE_public_functions"
  v=$(q <<'SQL'
select count(*) from pg_publication_tables where pubname = 'supabase_realtime';
SQL
  ) || exit 1; need "the realtime publication holds the same tables as before" "$v" "$PRE_realtime_tables"
  v=$(q <<'SQL'
select count(*) from public.profiles where role = 'staff_admin' and is_active;
SQL
  ) || exit 1; need "active staff_admin count unchanged" "$v" "$PRE_active_admins"

  if [[ $bad -ne 0 ]]; then echo "POSTCHECK_FAIL"; exit 1; fi
  echo "POSTCHECK_OK"
)
```

After `POSTCHECK_OK`: merge the PR and wait for the production deploy, then follow the "After every deploy" list in docs/RUNBOOK.md. App level smoke: sign in as a carrier (or ask one) and open My loads: every booked load is there as before. If block A counted any `PRE_cancel_never_booked_with_carrier`, those loads are no longer listed for their carrier.

## Extending this pack

A later card that adds a migration (for example 0023) does exactly three things and changes no block logic:
1. Add a row to the table in section 1.
2. Append the file name to the `files=( ... )` array in block B. The "highest file equals the last file in the list" and "file count equals the highest number" checks then expect 0023 by themselves.
3. Add a group of PASS checks for the new file to block C, and any read only data check to block A. Adjust the expected function, trigger and policy counts by what the new file adds.

## Rehearsal result

Rehearsed on the LOCAL stack only (127.0.0.1:58322, the moved local ports of this machine), never production, on 2026-10-21 by the engineering assistant (DLV-043). REHEARSED VERBATIM: each block was extracted from this file with a python regex (`` ```zsh\n# BLOCK name\n(.*?)\n``` ``; every block starts with a line `(`, ends with a line that is exactly `)` and no other line in a block is exactly `)`, checked by the extractor) and run as `env -i PATH="$PATH" HOME="$HOME" DATABASE_URL_DIRECT=<the LOCAL url> DLV_APPLY_DIR=<fresh scratch dir> zsh -f <block file>` from a scratch folder whose `supabase` entry links to the repo's supabase folder (so the transcript stayed out of the repo). No production value was in that environment.

Method: `supabase db reset --last 1` took the local database to 0021 (read back from `supabase_migrations.schema_migrations`: max version 0021, 21 rows). The md5 of the three helper definitions and of the `loads_select` text were recorded. Production-like rows were inserted: 1 staff_admin, 1 customer user of Mitrex, 1 carrier with its owner, and three loads of that carrier: TEST-R1 cancelled without booked_at (the CAR-01 case), TEST-R2 booked without booked_at (a load put at booked directly, as owner tooling does) and TEST-R3 delivered with booked_at. Afterwards `supabase db reset` restored the full local state for rls.sql and the e2e runs.

| Step | Result |
| --- | --- |
| Block A pre-check | rc 0, 10 PASS, 0 FAIL, PRECHECK_OK. PRE_cancel_never_booked_with_carrier 1, PRE_carriers_losing_a_load 1, PRE_live_without_booked_at 1. |
| Behaviour before the apply (simulated carrier owner session, rolled back) | The carrier read TEST-R1, TEST-R2 and TEST-R3 (the hole). |
| Block B apply | rc 0, APPLY_OK, 0 error lines (22 migration files, highest 0022). |
| Block C post-check | rc 0, 37 PASS, 0 FAIL, POSTCHECK_OK. |
| Behaviour after the apply | The carrier read TEST-R2 and TEST-R3 only: the never booked cancelled load is gone, the booked load without booked_at stays. |
| Block B again, then block C | APPLY_OK (idempotent), then 37 PASS, POSTCHECK_OK. |
| Negative arm: block A after the apply | rc 1, PRECHECK_FAIL with 2 FAIL (loads_select and the three helpers already carry the condition). |
| Negative arm: `grant execute` on `dlv_customer_can_see_carrier` to anon | Block C: rc 1, 2 FAIL (the helper grant check, anon executes a function). Revoked, block C 37 PASS again. |
| Negative arm: a row changed between A and C (booked_at stamped on TEST-R1) | Block C: rc 1, 1 FAIL ("cancelled never booked loads with a carrier unchanged"). Put back, block C 37 PASS, POSTCHECK_OK. |
| Rollback 0022 | rc 0, ROLLBACK_0022_OK. Block C then failed closed (rc 1, "FAIL loads_select has no booked_at condition (0022 is not applied)", POSTCHECK_FAIL). The md5 of the three helper definitions and of the `loads_select` text were byte identical to the 0021 values recorded before the apply. The carrier read TEST-R1 again (the old behaviour). Block A then 10 PASS, PRECHECK_OK; block B APPLY_OK; block C 37 PASS, POSTCHECK_OK. |
| Functional rules of 0022 | Not part of the blocks. supabase/tests/rls.sql section 22 (74 checks: a request with a carrier saved, cancelled by Maria and by staff, hidden from the carrier owner and driver: the load, its timeline, the BOL row and object, dlv_can_access_doc, the private pickup site, the contact phone, a POD upload; Maria no longer sees that carrier; controls: a booked then cancelled load and a load put at delivered without booked_at stay visible; definitions and grants; a second apply of the real file). Mutation: the clause removed from `loads_select` made 12 checks fail. |

## Production result

To be filled in after the owner supervised session (blocks A, B, C against production, then the merge and the deploy).
