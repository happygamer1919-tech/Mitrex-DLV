# Apply pack 8: migration 0018 (load photos) to production

For a SEPARATE, owner supervised production session. Nothing in this pack was run against production. It was
rehearsed against the local stack only (see "Rehearsal result"). Production holds migrations 0001 to 0017 (packs 2 to 7).

More migrations will be appended to this pack by later cards. The file list in section 1 and the `files=( ... )`
array at the top of block B are the only places that name migrations; every count and "highest number"
check is derived from that list (see "Extending this pack"). Do not edit block logic to add a migration.

Rules for the session
- The owner runs every block. Do not paste a connection string, key or password anywhere. Blocks print counts and PASS or FAIL only.
- Run in a quiet window (no customer or staff actions). The post-check compares row counts with the pre-check, so live traffic between the two shows as a FAIL to investigate, not as a silent pass.
- Every block is zsh and runs inside a subshell `( ... )`, so a failure ends the block and never closes your terminal. Each block exits non-zero on failure and prints its own verdict. No block relies on `set -e`.
- Blocks keep state in `$DLV_APPLY_DIR` (default `~/dlv-apply-8`, mode 700). The state file holds counts and 0/1 flags, no secrets.
- 0018 adds one column and one trigger, replaces three functions and two policies, adds one function and widens two CHECK constraints. It changes, deletes and rewrites no row: no load, user, document, lane, rate request or status is touched.

## 1. Migrations not yet in production (in order)

| File | What it does | Risk |
| --- | --- | --- |
| 0018_load_photos.sql | Load photos (DLV-032, R41). `load_documents.kind` also allows `pickup_photo` and `delivery_photo`; the path CHECK keeps its strict anchored shape and lets the two photo kinds name only jpg, jpeg, png or webp files. New nullable column `captured_at` (the browser's claim about when the photo was taken; never trusted or shown; the official time stays `created_at`, the server time). `dlv_can_access_doc` is replaced: carriers write a pickup photo only while the load is at_pickup or loading and a delivery photo only while it is at_delivery, customers read a pickup photo once the load is enroute or later and a delivery photo once it is delivered (never write, never another customer's), staff everything, BOL and POD rules unchanged. The `load_documents_insert` policy and the storage `documents_insert` policy are replaced (same rule, plus: a photo row needs its image file already in the bucket, and a photo object must be an image). New BEFORE INSERT trigger `load_documents_photo_cap` (at most 6 photos per kind per load). New function `delete_load_photo(uuid)` (the only way to remove a photo; no DELETE privilege is granted). `set_load_status` is replaced: the 0013 body plus two rules (a carrier role cannot move loading to enroute without a pickup photo, nor at_delivery to delivered without a delivery photo; staff are exempt and the skip is written into the event note). `record_load_deletion_orphans` is replaced with the photo path shape. | Medium for behaviour, low for data. Nothing existing is rewritten. The visible change is the gate: every load that is in loading or at_delivery WHEN THE APP IS DEPLOYED needs a photo before the carrier can advance it (staff can still override). Block A reports how many such loads exist right now. Idempotent (drop-then-add constraints, CREATE OR REPLACE, drop and recreate of its own policy and trigger, grants restated by name). Rolling back means section 5. |

Visible effect: carriers see a "Take loaded photo" step before Leave for delivery and a "Take delivery photo" step before Mark delivered, using the in-app camera. Maria sees a Photos card on her load page after the status change. The POD card offers the in-app camera first and a small "Choose a file instead". Tell Kaja and his drivers, and Maria.

## 2. Order of operations: migration first, then the app

Recommendation: apply 0018 first, then deploy the app from main straight away.

Reasons
1. 0018 is backward compatible with the app that is live now, EXCEPT for one rule: the live app has no photo step, so once 0018 is applied a carrier on the OLD app is refused at Leave for delivery (loading to enroute) and at Mark delivered (at_delivery to delivered) with the message "Take a photo of the loaded freight first ..." / "Take a delivery photo first ...". Keep the window between block B and the deploy short, and do it when no carrier is on those two steps (block A prints how many loads sit there). Staff can override any stuck load.
2. The new app needs 0018: the photo step stores `pickup_photo` and `delivery_photo` rows, which the old CHECK constraint refuses, and the page selects the new function. Deploying the app first would show a photo step that cannot save.
3. If the migration fails, nothing user visible has changed yet and the app is untouched.

## 3. Pre-check (read only)

Session setup. Run this in the terminal you will use for every block below. It loads DATABASE_URL_DIRECT without printing it.

```
set -o allexport; source ~/.zshenvmitrex; set +o allexport
cd ~/Documents/Projects/GitHub/Mitrex-DLV && git fetch origin && git checkout feat/dlv-032-load-photos
```

(If this branch was merged, `git checkout main && git pull` instead. The migration files must be exactly the ones listed above.)

Block A, pre-check. Read only: every statement runs with `default_transaction_read_only = on`, so it cannot change data even by mistake. It REPORTS how many loads are in loading or at_delivery now (informational, never a failure): those loads would need a photo before a carrier can advance them.

```zsh
# BLOCK precheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-8}"
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

  echo "--- INFORMATIONAL: loads that the photo gate would hold (never a failure)"
  v=$(q <<'SQL'
select count(*) from public.loads where status = 'loading';
SQL
  ) || exit 1; print -r -- "  loads in loading now: $v (the carrier needs a pickup photo before Leave for delivery)"
  v=$(q <<'SQL'
select count(*) from public.loads where status = 'at_delivery';
SQL
  ) || exit 1; print -r -- "  loads at delivery now: $v (the carrier needs a delivery photo before Mark delivered)"
  v=$(q <<'SQL'
select count(*) from public.loads where status in ('loading', 'at_delivery');
SQL
  ) || exit 1; rec PRE_gated_loads "$v"
  print -r -- "  (if this is above 0: apply and deploy in one quick step, or let those loads finish first; staff can always override a stuck load)"

  echo "--- production migration state is 0001 to 0017"
  v=$(q <<'SQL'
select count(*) from pg_tables where schemaname = 'public';
SQL
  ) || exit 1; need "11 public tables (the 10 of 0001 to 0016 plus rate_requests)" "$v" "11"; rec PRE_public_tables "$v"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity;
SQL
  ) || exit 1; need "RLS enabled on all 11 tables" "$v" "11"; rec PRE_rls_tables "$v"
  v=$(q <<'SQL'
select (to_regprocedure('public.set_load_status(uuid, public.load_status, timestamptz, text)') is not null
    and to_regprocedure('public.dlv_can_access_doc(text, boolean)') is not null
    and to_regprocedure('public.delete_load_forever(uuid, text)') is not null
    and to_regprocedure('public.record_load_deletion_orphans(uuid, text[])') is not null
    and to_regprocedure('public.set_rate_quote(uuid, numeric, text, text, date)') is not null)::int;
SQL
  ) || exit 1; need "functions of 0002, 0013, 0014 and 0017 present" "$v" "1"
  v=$(q <<'SQL'
select (position('enter the ITS load number before booking' in pg_get_functiondef('public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure)) > 0)::int;
SQL
  ) || exit 1; need "set_load_status carries the ITS rule of 0013 (the body 0018 builds on)" "$v" "1"
  v=$(q <<'SQL'
select (position('is_active' in pg_get_functiondef('public.dlv_is_staff()'::regprocedure)) > 0
    and position('is_active' in pg_get_functiondef('public.dlv_role()'::regprocedure)) > 0)::int;
SQL
  ) || exit 1; need "dlv_is_staff and dlv_role are inactive aware (0005)" "$v" "1"
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
select count(*) from public.load_documents where kind not in ('bol', 'pod');
SQL
  ) || exit 1; need "every stored document is a bol or a pod (the new CHECK is a superset, nothing to convert)" "$v" "0"
  v=$(q <<'SQL'
select count(*) from public.load_documents where kind = 'bol';
SQL
  ) || exit 1; rec PRE_bols "$v"
  v=$(q <<'SQL'
select count(*) from public.load_documents where kind = 'pod';
SQL
  ) || exit 1; rec PRE_pods "$v"

  echo "--- nothing of 0018 exists yet (must be absent)"
  v=$(q <<'SQL'
select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'load_documents' and column_name = 'captured_at';
SQL
  ) || exit 1; need "no column load_documents.captured_at" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('delete_load_photo', 'load_documents_photo_cap');
SQL
  ) || exit 1; need "no function named delete_load_photo or load_documents_photo_cap" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_trigger where tgrelid = 'public.load_documents'::regclass and not tgisinternal and tgname = 'load_documents_photo_cap';
SQL
  ) || exit 1; need "no photo cap trigger" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_constraint where conrelid = 'public.load_documents'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%pickup_photo%';
SQL
  ) || exit 1; need "no CHECK constraint mentions pickup_photo" "$v" "0"
  v=$(q <<'SQL'
select (position('pickup_photo' in pg_get_functiondef('public.dlv_can_access_doc(text, boolean)'::regprocedure)) > 0
     or position('pickup_photo' in pg_get_functiondef('public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure)) > 0)::int;
SQL
  ) || exit 1; need "dlv_can_access_doc and set_load_status do not mention the photo kinds yet" "$v" "0"

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

  if [[ $bad -ne 0 ]]; then print -r -- "PRECHECK_RESULT=FAIL" >> "$STATE"; echo "PRECHECK_FAIL (do not apply)"; exit 1; fi
  print -r -- "PRECHECK_RESULT=OK" >> "$STATE" || exit 1
  echo "PRECHECK_OK (state saved in $STATE)"
)
```

Stop here unless it printed `PRECHECK_OK`. A FAIL on "0001 to 0017 state" means an earlier pack is not fully applied: do not apply. A FAIL on "must be absent" means something of 0018 already exists: stop and investigate (do not run block B). The loads count, the per status counts and the "loads that the photo gate would hold" lines are informational.

## 4. Apply

Block B. One transaction per migration (`--single-transaction`), stops at the first failure, full transcript in `apply-transcript-8.txt` (repo root, it contains no connection string; do not commit it). The migration list and the expected highest number live in the `files` array.

```zsh
# BLOCK apply
(
  setopt pipefail
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-8}"
  [[ -f "$DIR/state.env" ]] || { echo "FAIL: run the pre-check (block A) first"; exit 1; }
  grep -qx 'PRECHECK_RESULT=OK' "$DIR/state.env" || { echo "FAIL: the last pre-check (block A) did not end in PRECHECK_OK. Do not apply. Fix the cause and run block A again."; exit 1; }
  files=(
    0018_load_photos.sql
  )
  for f in $files; do
    [[ -f "supabase/migrations/$f" ]] || { echo "FAIL: missing supabase/migrations/$f (run from the repo root)"; exit 1; }
  done
  last="${files[-1]%%_*}"
  highest=$(ls supabase/migrations | grep '^[0-9]' | sort | tail -1)
  [[ "${highest%%_*}" == "$last" ]] || { echo "FAIL: the highest migration file is ${highest%%_*} but the last file in this pack is $last"; exit 1; }
  count=$(ls supabase/migrations | grep -c '^[0-9]')
  [[ "$count" -eq $((10#$last)) ]] || { echo "FAIL: expected $((10#$last)) migration files (0001 to $last, none missing), found $count"; exit 1; }
  print -r -- "apply started $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-8.txt
  for f in $files; do
    print -r -- "=== $f" | tee -a apply-transcript-8.txt
    psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f "supabase/migrations/$f" 2>&1 | tee -a apply-transcript-8.txt || { echo "APPLY_FAIL at $f (that file was rolled back as one transaction; earlier files stay applied; see section 5)"; exit 1; }
  done
  print -r -- "APPLY_OK $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-8.txt
)
```

If a block fails midway: the failing file is one transaction, so it left nothing behind. Earlier files stay applied. Fix the cause and run block B again (every file is idempotent).

## 5. Rollback notes (per migration)

Every migration runs as one transaction, so a failure inside a file undoes that whole file. This is only for undoing a file that APPLIED and that you then decide to back out. Do not run it against production without the owner's explicit go. Reuse `$DATABASE_URL_DIRECT`. Roll back together with a rollback of the app to a build without the photo steps (otherwise the app would try to save photo rows).

- 0018: puts back the 0017 definitions of `set_load_status` (the 0013 body), `dlv_can_access_doc` (0011), `record_load_deletion_orphans` (0014) and the two insert policies (0003, 0004), restores the old `kind` and path CHECK constraints, drops the photo cap trigger and function, drops `delete_load_photo` and drops the column `captured_at`, as ONE transaction. WARNING: every pickup and delivery photo ROW goes (the old constraint cannot hold them). The block refuses to run while any photo row exists unless `DLV_ALLOW_PHOTO_LOSS=1` is exported (use it only with the owner's explicit go). The photo FILES stay in the private bucket as unreachable objects; the block prints how many, and removing them is a separate owner decision. Nothing else is touched: no load, no BOL, no POD, no event.

```zsh
# BLOCK rollback-0018
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  n=$(echo "select count(*) from public.load_documents where kind in ('pickup_photo', 'delivery_photo');" | psql "$DATABASE_URL_DIRECT" -X -A -t -q -v ON_ERROR_STOP=1 -f -) || { echo "FAIL: cannot count photo rows (is 0018 applied?)"; exit 1; }
  if [[ "$n" != "0" && "$DLV_ALLOW_PHOTO_LOSS" != "1" ]]; then
    echo "FAIL: load_documents holds $n photo row(s). Rolling back 0018 deletes those rows (the files stay in the bucket). Export DLV_ALLOW_PHOTO_LOSS=1 only with the owner's explicit go."
    exit 1
  fi
  psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f - <<'SQL' || exit 1
delete from public.load_documents where kind in ('pickup_photo', 'delivery_photo');
drop trigger if exists load_documents_photo_cap on public.load_documents;
drop function if exists public.load_documents_photo_cap();
drop function if exists public.delete_load_photo(uuid);

-- set_load_status: the 0013 body (production before 0018)
create or replace function public.set_load_status(
  p_load uuid, p_status public.load_status,
  p_eta timestamptz default null, p_note text default null)
returns public.loads
language plpgsql security definer set search_path = ''
as $fn$
declare
  l public.loads;
  v_role text := public.dlv_role();
  v_staff boolean := public.dlv_is_staff();
  v_eta timestamptz;
  v_from int;
  v_to int;
begin
  if auth.uid() is null or v_role is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into l from public.loads where id = p_load for update;
  if not found then raise exception 'load not found' using errcode = 'P0002'; end if;

  -- authorization per role
  if v_role = 'customer' then
    if l.customer_id is distinct from public.dlv_customer_id()
       or p_status <> 'cancelled' or l.status <> 'requested' then
      raise exception 'customers may only cancel their own requested loads' using errcode = '42501';
    end if;
  elsif not v_staff then
    -- carrier owner or driver: own carrier, forward one step only
    if l.carrier_id is distinct from public.dlv_carrier_id() or l.status = 'requested' then
      raise exception 'not your load' using errcode = '42501';
    end if;
    v_from := public.dlv_step_index(l.status);
    v_to := public.dlv_step_index(p_status);
    if v_from is null or v_to is null or v_to <> v_from + 1 or p_status = 'booked' then
      raise exception 'carriers move forward one step at a time' using errcode = '42501';
    end if;
  end if;

  if l.status = p_status then
    raise exception 'load is already %', p_status using errcode = 'P0001';
  end if;
  if l.status = 'delivered' and p_status <> 'delivered' and not v_staff then
    raise exception 'delivered loads are final' using errcode = '42501';
  end if;

  -- staff: cancel before delivered; any other jump needs a note unless it is the next step
  if v_staff then
    if p_status = 'cancelled' and l.status = 'delivered' then
      raise exception 'cannot cancel a delivered load' using errcode = 'P0001';
    end if;
    v_from := public.dlv_step_index(l.status);
    v_to := public.dlv_step_index(p_status);
    if p_status <> 'cancelled' and (v_from is null or v_to is distinct from v_from + 1)
       and coalesce(btrim(p_note), '') = '' then
      raise exception 'a note is required for a staff override' using errcode = 'P0001';
    end if;
  end if;

  if p_status = 'booked' and l.carrier_id is null then
    raise exception 'assign a carrier before booking' using errcode = 'P0001';
  end if;
  if p_status in ('at_pickup','loading','enroute','at_delivery','delivered') and l.carrier_id is null then
    raise exception 'assign a carrier first' using errcode = 'P0001';
  end if;

  -- 0013: ITS is the source of truth for the load number. A request leaves 'requested' (booked, or a staff
  -- override jump) only once the ITS load number is on the load. Cancelling needs none, and legacy loads that
  -- are already booked without a number move forward normally (the rule needs old status = requested).
  if l.status = 'requested' and p_status <> 'cancelled' and l.its_load_number is null then
    raise exception 'enter the ITS load number before booking' using errcode = 'P0001';
  end if;

  v_eta := coalesce(p_eta, l.eta);
  if p_status = 'enroute' and v_eta is null then
    raise exception 'eta is required for enroute' using errcode = 'P0001';
  end if;

  -- The load_events row is written by the loads_status_event trigger; it reads the note from here.
  perform set_config('dlv.event_note', coalesce(p_note, ''), true);
  perform set_config('dlv.status_fn', '1', true);
  update public.loads set
    status = p_status,
    eta = case when p_status in ('enroute','at_delivery') then v_eta else eta end,
    booked_at = case when p_status <> 'requested' and p_status <> 'cancelled' and booked_at is null
                     then now() else booked_at end,
    delivered_at = case when p_status = 'delivered' then now() else delivered_at end,
    cancelled_at = case when p_status = 'cancelled' then now() else cancelled_at end
  where id = l.id
  returning * into l;
  perform set_config('dlv.status_fn', '0', true);
  perform set_config('dlv.event_note', '', true);
  return l;
end
$fn$;

revoke all on function public.set_load_status(uuid, public.load_status, timestamptz, text) from public, anon;
grant execute on function public.set_load_status(uuid, public.load_status, timestamptz, text) to authenticated, service_role;

-- dlv_can_access_doc: the 0011 body (production before 0018)
create or replace function public.dlv_can_access_doc(path text, write boolean) returns boolean
language plpgsql stable security definer set search_path = ''
as $fn$
declare
  v_load uuid;
  v_kind text;
  l public.loads;
  v_role text;
begin
  -- Shape first, before any lookup. Case sensitive; $ anchors the true end of the string.
  if path is null or path !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(bol|pod)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$' then
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
    return not write and l.customer_id = public.dlv_customer_id();
  end if;
  -- carrier_owner, carrier_driver
  if l.carrier_id is distinct from public.dlv_carrier_id() or l.status = 'requested' then
    return false;
  end if;
  if write then
    return v_kind = 'pod' and l.status in ('enroute','at_delivery','delivered');
  end if;
  return true;
end
$fn$;

revoke all on function public.dlv_can_access_doc(text, boolean) from public, anon;
grant execute on function public.dlv_can_access_doc(text, boolean) to authenticated, service_role;

-- record_load_deletion_orphans: the 0014 body (production before 0018)
create or replace function public.record_load_deletion_orphans(p_load uuid, p_paths text[])
returns integer
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_id uuid;
  v_new text[];
  v_old text[];
  v_bad int;
begin
  if auth.uid() is null or not public.dlv_is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_paths is null or cardinality(p_paths) = 0 then return 0; end if;
  -- Only strict document paths of THIS load can be recorded (same shape as dlv_can_access_doc).
  select count(*) into v_bad from unnest(p_paths) p
   where p is null
      or p !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(bol|pod)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$'
      or split_part(p, '/', 1) <> p_load::text;
  if v_bad > 0 then
    raise exception 'path does not belong to this load' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.loads where id = p_load) then
    raise exception 'load still exists' using errcode = 'P0001';
  end if;
  select d.id, d.orphan_paths into v_id, v_old from public.load_deletions d
   where d.load_id = p_load order by d.deleted_at desc, d.id limit 1 for update;
  if v_id is null then raise exception 'no deletion record for this load' using errcode = 'P0002'; end if;
  select coalesce(array_agg(distinct p), '{}') into v_new
    from unnest(p_paths) p
   where p <> all (v_old);
  update public.load_deletions set orphan_paths = orphan_paths || v_new where id = v_id;
  return cardinality(v_new);
end
$fn$;

revoke all on function public.record_load_deletion_orphans(uuid, text[]) from public, anon, authenticated;
grant execute on function public.record_load_deletion_orphans(uuid, text[]) to authenticated, service_role;

drop policy if exists documents_insert on storage.objects;
create policy documents_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and public.dlv_can_access_doc(name, true));

drop policy if exists load_documents_insert on public.load_documents;
create policy load_documents_insert on public.load_documents for insert to authenticated
  with check (uploaded_by = auth.uid() and public.dlv_can_access_doc(storage_path, true));

alter table public.load_documents drop constraint if exists load_documents_path_ck;
alter table public.load_documents add constraint load_documents_path_ck check (
  storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(bol|pod)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$'
  and left(storage_path, 38 + length(kind)) = load_id::text || '/' || kind || '/'
);
alter table public.load_documents drop constraint if exists load_documents_kind_check;
alter table public.load_documents add constraint load_documents_kind_check check (kind in ('bol','pod'));
alter table public.load_documents drop column if exists captured_at;
SQL
  m=$(echo "select count(*) from storage.objects where bucket_id = 'documents' and (name like '%/pickup_photo/%' or name like '%/delivery_photo/%');" | psql "$DATABASE_URL_DIRECT" -X -A -t -q -v ON_ERROR_STOP=1 -f - 2>/dev/null) || m="unknown"
  echo "  photo files left in the bucket (unreachable, owner decides): $m"
  echo ROLLBACK_0018_OK
)
```

## 6. Post-check (read only)

Block C. Expected values come from the same run: the counts saved by block A are compared with fresh counts, and the security posture of the changed objects is checked against the catalog. It changes nothing.

```zsh
# BLOCK postcheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-8}"
  STATE="$DIR/state.env"
  [[ -f "$STATE" ]] || { echo "FAIL: no state file, run block A before the apply"; exit 1; }
  source "$STATE" || exit 1
  q() { { echo "set default_transaction_read_only = on;"; cat; } | psql "$DATABASE_URL_DIRECT" -X -A -t -q -v ON_ERROR_STOP=1 -f - ; }
  bad=0
  need() { if [[ "$2" == "$3" ]]; then print -r -- "PASS $1"; else print -r -- "FAIL $1 (got $2, want $3)"; bad=1; fi; }
  LD="'public.load_documents'::regclass"
  SLS="pg_get_functiondef('public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure)"
  ACC="pg_get_functiondef('public.dlv_can_access_doc(text, boolean)'::regprocedure)"

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
select count(*) from public.load_documents where kind = 'bol';
SQL
  ) || exit 1; need "BOL rows unchanged" "$v" "$PRE_bols"
  v=$(q <<SQL
select count(*) from public.load_documents where kind = 'pod';
SQL
  ) || exit 1; need "POD rows unchanged" "$v" "$PRE_pods"
  v=$(q <<SQL
select count(*) from public.load_documents where kind in ('pickup_photo', 'delivery_photo');
SQL
  ) || exit 1; need "no photo row exists yet (the apply creates none)" "$v" "0"

  echo "--- 0018 load_documents: shape"
  v=$(q <<SQL
select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'load_documents';
SQL
  ) || exit 1; need "the 7 columns in order, captured_at last and nullable" "$v" "id:uuid:NO,load_id:uuid:NO,kind:text:NO,storage_path:text:NO,uploaded_by:uuid:NO,created_at:timestamp with time zone:NO,captured_at:timestamp with time zone:YES"
  v=$(q <<SQL
select count(*) from pg_constraint where conrelid = $LD and contype = 'c' and convalidated
   and ((conname = 'load_documents_kind_check' and pg_get_constraintdef(oid) like '%bol%' and pg_get_constraintdef(oid) like '%pod%' and pg_get_constraintdef(oid) like '%pickup_photo%' and pg_get_constraintdef(oid) like '%delivery_photo%')
     or (conname = 'load_documents_path_ck' and pg_get_constraintdef(oid) like '%pickup_photo|delivery_photo%' and pg_get_constraintdef(oid) like '%jpg|jpeg|png|webp%'));
SQL
  ) || exit 1; need "the kind CHECK and the path CHECK name both photo kinds, photos image only, both validated" "$v" "2"
  v=$(q <<SQL
select count(*) from pg_constraint where conrelid = $LD and contype = 'f';
SQL
  ) || exit 1; need "exactly two foreign keys on load_documents (loads, profiles), none added" "$v" "2"
  v=$(q <<SQL
select count(*) from pg_constraint where contype = 'f' and confrelid = 'public.loads'::regclass;
SQL
  ) || exit 1; need "exactly two tables reference loads (load_events, load_documents), none added" "$v" "2"
  v=$(q <<SQL
select count(*) from pg_indexes where schemaname = 'public' and tablename = 'load_documents' and indexname in ('load_documents_storage_path_uq', 'load_documents_load_idx', 'load_documents_pkey');
SQL
  ) || exit 1; need "the three indexes of load_documents are still there" "$v" "3"

  echo "--- 0018 who can do what"
  v=$(q <<SQL
select (has_table_privilege('authenticated', $LD, 'select') and has_table_privilege('authenticated', $LD, 'insert'))::int;
SQL
  ) || exit 1; need "control: authenticated can select and insert load_documents" "$v" "1"
  v=$(q <<SQL
select (has_table_privilege('authenticated', $LD, 'delete') or has_table_privilege('authenticated', $LD, 'update') or has_table_privilege('authenticated', $LD, 'truncate'))::int;
SQL
  ) || exit 1; need "authenticated holds no update, delete or truncate on load_documents (the photo delete is a function)" "$v" "0"
  v=$(q <<SQL
select (has_table_privilege('anon', $LD, 'select') or has_table_privilege('anon', $LD, 'insert') or has_table_privilege('anon', $LD, 'update') or has_table_privilege('anon', $LD, 'delete'))::int;
SQL
  ) || exit 1; need "anon holds nothing on load_documents" "$v" "0"
  v=$(q <<SQL
select count(*) from pg_policies where schemaname = 'public' and tablename = 'load_documents';
SQL
  ) || exit 1; need "load_documents still has exactly its two policies (select, insert)" "$v" "2"
  v=$(q <<SQL
select count(*) from pg_policies where schemaname = 'public' and tablename = 'load_documents' and policyname = 'load_documents_insert' and with_check like '%pickup_photo%' and with_check like '%image/jpeg%' and with_check like '%dlv_can_access_doc%' and with_check like '%uploaded_by%';
SQL
  ) || exit 1; need "the load_documents insert policy: own row, writable window, and a photo needs its image file" "$v" "1"
  v=$(q <<SQL
select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname in ('documents_select', 'documents_insert') and roles = '{authenticated}';
SQL
  ) || exit 1; need "the two storage policies on the documents bucket are still there, authenticated only" "$v" "2"
  v=$(q <<SQL
select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'documents_insert' and with_check like '%dlv_can_access_doc%' and with_check like '%pickup_photo%' and with_check like '%image/webp%';
SQL
  ) || exit 1; need "the storage insert policy also requires an image mimetype on a photo path" "$v" "1"
  v=$(q <<SQL
select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and (roles::text like '%anon%' or roles::text like '%public%') and (coalesce(qual, '') like '%documents%' or coalesce(with_check, '') like '%documents%');
SQL
  ) || exit 1; need "no storage policy for anon or public touches the documents bucket" "$v" "0"
  v=$(q <<SQL
select (allowed_mime_types @> array['image/jpeg','image/png','image/webp'] and public = false)::int from storage.buckets where id = 'documents';
SQL
  ) || exit 1; need "the documents bucket is private and still lists the image mime types" "$v" "1"

  echo "--- 0018 functions and triggers"
  v=$(q <<SQL
select (position('pickup_photo' in $ACC) > 0 and position('delivery_photo' in $ACC) > 0 and position('enroute' in $ACC) > 0 and position('at_pickup' in $ACC) > 0)::int;
SQL
  ) || exit 1; need "dlv_can_access_doc knows both photo kinds and their status windows" "$v" "1"
  v=$(q <<SQL
select (position('Take a photo of the loaded freight first' in $SLS) > 0 and position('Take a delivery photo first' in $SLS) > 0
    and position('Staff skipped the pickup photo' in $SLS) > 0 and position('Staff skipped the delivery photo' in $SLS) > 0)::int;
SQL
  ) || exit 1; need "set_load_status carries both photo gates and the staff skip note" "$v" "1"
  v=$(q <<SQL
select (position('enter the ITS load number before booking' in $SLS) > 0 and position('eta is required for enroute' in $SLS) > 0
    and position('delivered loads are final' in $SLS) > 0 and position('dlv.event_note' in $SLS) > 0 and $SLS !~* 'pod')::int;
SQL
  ) || exit 1; need "set_load_status still carries the ITS rule, the ETA rule, the final rule and the note hand-over, and no POD requirement" "$v" "1"
  v=$(q <<SQL
select count(*) from pg_proc where oid in (to_regprocedure('public.set_load_status(uuid, public.load_status, timestamptz, text)'), to_regprocedure('public.delete_load_photo(uuid)'),
       to_regprocedure('public.load_documents_photo_cap()'), to_regprocedure('public.dlv_can_access_doc(text, boolean)'), to_regprocedure('public.record_load_deletion_orphans(uuid, text[])'))
   and prosecdef and exists (select 1 from unnest(proconfig) c where c like 'search_path=%');
SQL
  ) || exit 1; need "the five functions touched or added are SECURITY DEFINER with a fixed search_path" "$v" "5"
  v=$(q <<SQL
select (has_function_privilege('authenticated', to_regprocedure('public.delete_load_photo(uuid)'), 'execute')
    and not has_function_privilege('anon', to_regprocedure('public.delete_load_photo(uuid)'), 'execute')
    and has_function_privilege('authenticated', to_regprocedure('public.set_load_status(uuid, public.load_status, timestamptz, text)'), 'execute')
    and not has_function_privilege('anon', to_regprocedure('public.set_load_status(uuid, public.load_status, timestamptz, text)'), 'execute')
    and has_function_privilege('authenticated', to_regprocedure('public.dlv_can_access_doc(text, boolean)'), 'execute')
    and not has_function_privilege('anon', to_regprocedure('public.dlv_can_access_doc(text, boolean)'), 'execute')
    and not has_function_privilege('anon', to_regprocedure('public.record_load_deletion_orphans(uuid, text[])'), 'execute'))::int;
SQL
  ) || exit 1; need "authenticated can EXECUTE the functions it could before plus delete_load_photo, anon none of them" "$v" "1"
  v=$(q <<SQL
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'load_documents_photo_cap'
   and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
SQL
  ) || exit 1; need "no client role can EXECUTE the cap trigger function" "$v" "0"
  v=$(q <<SQL
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute');
SQL
  ) || exit 1; need "anon can EXECUTE no function in public" "$v" "0"
  v=$(q <<SQL
select count(*) from pg_trigger where tgrelid = $LD and not tgisinternal and tgenabled = 'O' and tgname = 'load_documents_photo_cap' and tgtype & 2 = 2 and tgtype & 4 = 4;
SQL
  ) || exit 1; need "the photo cap trigger is enabled and is BEFORE INSERT" "$v" "1"
  v=$(q <<SQL
select (position('pickup_photo|delivery_photo' in pg_get_functiondef('public.record_load_deletion_orphans(uuid, text[])'::regprocedure)) > 0
    and position('delete_load_forever' in pg_get_functiondef('public.delete_load_forever(uuid, text)'::regprocedure)) > 0
    and position('from public.load_documents' in pg_get_functiondef('public.delete_load_forever(uuid, text)'::regprocedure)) > 0)::int;
SQL
  ) || exit 1; need "the orphan log accepts photo paths and delete_load_forever still collects every load_documents path" "$v" "1"

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
  ) || exit 1; need "public table count unchanged (0018 adds no table)" "$v" "$PRE_public_tables"
  v=$(q <<SQL
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('select'),('insert'),('update'),('delete'),('truncate'),('references'),('trigger')) p(priv)
 where n.nspname = 'public' and c.relkind in ('r','v','m','p') and has_table_privilege('anon', c.oid, p.priv);
SQL
  ) || exit 1; need "anon table grants unchanged (zero)" "$v" "$PRE_anon_table_grants"
  v=$(q <<SQL
select count(*) from pg_policies where schemaname in ('public','storage');
SQL
  ) || exit 1; need "policy count unchanged (two policies replaced, none added)" "$v" "$PRE_policies"
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

After `POSTCHECK_OK`: deploy the app from main (Vercel), then follow the "After every deploy" list in docs/RUNBOOK.md. App level smoke after the deploy: sign in as Maria and open an existing delivered load: the page has a **Photos** card ("No photos were added for this load." for an old load). Do NOT create real loads to test. Then run the manual test M12 in docs/ACCEPTANCE-CHECKLIST.md on a real iPhone and a real Android phone with a TEST load (the camera and the permission prompt cannot be verified by automation).

## Extending this pack

A later card that adds a migration (for example 0019) does exactly three things and changes no block logic:
1. Add a row to the table in section 1.
2. Append the file name to the `files=( ... )` array in block B. The "highest file equals the last file in the list" and "file count equals the highest number" checks then expect 0019 by themselves.
3. Add a group of PASS checks for the new file to block C, and any read only data check to block A. The row count, security posture and earlier migration groups stay as they are (adjust the expected function and policy counts by what the new file adds).

## Rehearsal result

Rehearsed on the LOCAL stack only (127.0.0.1:54322), never production, on 2026-10-07 by the engineering assistant (DLV-032 card).

IMPORTANT LIMIT, read first: the harness this session ran in REFUSES to run zsh files (the same refusal packs 4 to 7 recorded), so the blocks were NOT run verbatim under `zsh -f`. The lead reruns them. What was run instead: the four blocks were extracted from this file with a python regex (`` ```zsh\n# BLOCK name\n(.*?)\n``` ``; every block ends with a line that is exactly `)` and no other line in a block is exactly `)`), and a small python driver (not the shell) ran EVERY SQL statement of blocks A and C through psql (read only, `default_transaction_read_only = on`), compared each result with the value the block expects (including the values derived from the state file: `PRE_policies`, `PRE_public_functions + 2`, `PRE_rls_tables`, `PRE_public_tables`, `PRE_realtime_tables`, every row and status count), ran block B's file and count checks and its one command per file exactly as written (`psql --single-transaction -v ON_ERROR_STOP=1 -f`), and ran the rollback SQL out of block `rollback-0018` as written (the refusal test is the same count query). The driver reads the SQL and the expected values out of this file, so a wrong value in the pack shows as a FAIL there.

Method: `supabase db reset --last 1` took the local database from 0018 back to 0017 (read back from `supabase_migrations.schema_migrations`: max version 0017, 17 rows, no `delete_load_photo`, no `captured_at`). Production-like rows were inserted: 1 staff_admin, 1 customer user of Mitrex, 1 carrier owner, 6 loads (requested, booked, loading, at_delivery, delivered, cancelled), 3 documents (2 BOL, 1 POD). Afterwards `supabase db reset` restored the full local state.

| Step | Result |
| --- | --- |
| Block A pre-check (SQL through psql, read only) | 14 PASS, 0 FAIL. It REPORTED, as informational lines and not as a failure: "loads in loading now: 1", "loads at delivery now: 1", PRE_gated_loads = 2. Also PASS: 11 public tables, RLS 11 of 11, the functions of 0002, 0013, 0014 and 0017, the ITS rule in `set_load_status`, identity helpers inactive aware, customer Mitrex, anon holds zero table grants and executes no function, every stored document is a bol or a pod, and nothing of 0018 exists (no column, functions, trigger, CHECK mention or photo kind in the two functions). Recorded: 11 row counts, 8 load status counts, PRE_policies = 29, PRE_public_functions = 28, PRE_realtime_tables = 2. PRECHECK_OK. |
| Block B apply (the files array, one command each) | File checks hold (18 files, highest 0018). 0018 applied in one transaction, rc 0, 0 error lines. APPLY_OK. |
| Block C post-check (SQL through psql, read only) | 54 PASS, 0 FAIL: 19 row count comparisons (11 tables, 8 load statuses) unchanged, BOL and POD rows unchanged, no photo row, the 7 columns in order with `captured_at` last and nullable, both CHECK constraints name the photo kinds (image only) and are validated, still exactly two foreign keys on `load_documents` and two tables referencing `loads`, the three indexes, authenticated can select and insert but holds no update, delete or truncate, anon holds nothing, exactly two policies on `load_documents` (the insert policy needs the image file for a photo), the two storage policies (insert needs an image mimetype on a photo path), no anon or public storage policy, the bucket private with the image mime types, `dlv_can_access_doc` and `set_load_status` carry the new rules and the old ones (ITS, ETA, final, note hand-over, no POD requirement), the five functions SECURITY DEFINER with a fixed search_path, execute rights (anon none), the cap trigger enabled and BEFORE INSERT, the orphan log accepts photo paths and `delete_load_forever` still collects every `load_documents` path, RLS 11 of 11, policy count unchanged, function count + 2, realtime unchanged, admin and customer counts unchanged. POSTCHECK_OK. |
| Re-run of B then C | 0 error lines, then 54 PASS, 0 FAIL (idempotent). |
| Negative arm: block A after the apply | 5 FAIL (do not apply): column `captured_at` exists, two functions exist, the cap trigger exists, two CHECK constraints mention pickup_photo, the functions mention the photo kinds. The other 9 checks PASS. |
| Negative arms of block C | `grant delete` on `load_documents` to authenticated: 1 FAIL ("holds no update, delete or truncate"). Cap trigger dropped: 1 FAIL ("cap trigger is enabled and is BEFORE INSERT"). `grant select` to anon: 2 FAIL ("anon holds nothing", "anon table grants unchanged"). An extra delete policy: 2 FAIL ("exactly its two policies", "policy count unchanged"). Each was reverted and block C was green again (54 PASS). |
| Rollback 0018 | The rollback refused while a photo row existed ("load_documents holds 1 photo row(s)", rc 1) and ran (ROLLBACK_0018_OK, rc 0, "photo files left in the bucket: 0") with the override. Afterwards `load_documents` had its 3 old rows and 6 old columns, `set_load_status` no longer mentioned the photo kinds, block C gave 11 FAIL (it fails closed) and block A gave 14 PASS, PRECHECK_OK (the pre-apply state is back). Block B again restored 0018 and block C gave 54 PASS, POSTCHECK_OK. |
| Functional rules of 0018 | Not part of the blocks. supabase/tests/rls.sql section 18 (write windows per status and kind, image only, 6 photo cap, read windows for the customer, other customer and other carrier, `delete_load_photo`, the carrier and staff gates in `set_load_status` and the staff skip note, `delete_load_forever` with photo paths, the orphan log, applying 0018 a second time) and e2e/load-photos.spec.ts run on a fresh `supabase db reset`. |

### Lead rehearsal of the real blocks

To be filled in by the lead: run the four blocks verbatim under `zsh -f` against the local stack (from `supabase db reset --last 1` plus production-like rows) and record the verdicts here. Set `DATABASE_URL_DIRECT` to the LOCAL URL for that rehearsal; never leave a production value in the terminal.

