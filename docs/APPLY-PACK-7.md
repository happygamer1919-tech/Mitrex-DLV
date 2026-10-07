# Apply pack 7: migration 0017 (rate requests) to production

For a SEPARATE, owner supervised production session. Nothing in this pack was run against production. It was
rehearsed against the local stack only (see "Rehearsal result"). Production holds migrations 0001 to 0016 (packs 2 to 6).

More migrations will be appended to this pack by later cards. The file list in section 1 and the `files=( ... )`
array at the top of block B are the only places that name migrations; every count and "highest number"
check is derived from that list (see "Extending this pack"). Do not edit block logic to add a migration.

Rules for the session
- The owner runs every block. Do not paste a connection string, key or password anywhere. Blocks print counts and PASS or FAIL only.
- Run in a quiet window (no customer or staff actions). The post-check compares row counts with the pre-check, so live traffic between the two shows as a FAIL to investigate, not as a silent pass.
- Every block is zsh and runs inside a subshell `( ... )`, so a failure ends the block and never closes your terminal. Each block exits non-zero on failure and prints its own verdict. No block relies on `set -e`.
- Blocks keep state in `$DLV_APPLY_DIR` (default `~/dlv-apply-7`, mode 700). The state file holds counts and 0/1 flags, no secrets.
- 0017 creates one table, one sequence and three functions. It changes, deletes and rewrites nothing that exists: no load, user, document, lane, policy or function is touched.

## 1. Migrations not yet in production (in order)

| File | What it does | Risk |
| --- | --- | --- |
| 0017_rate_requests.sql | Rate requests (DLV-030, R40). New sequence `rate_request_seq`, new table `rate_requests` (ref RQ-0001 style, customer, requested_by, pickup and delivery city and state, truck size 26 / 36 / 53, optional weight, dimensions and notes, status open / quoted / cancelled, the quote columns, created_at, updated_at) with CHECK constraints (the four quote fields are set exactly when status is quoted). RLS on; all privileges revoked from PUBLIC and anon by name; `select` granted to authenticated and `insert` granted to authenticated on NINE named columns only (no status, no quote columns, no ref, no requested_by); exactly two policies (select: active staff, or a customer for its own customer_id; insert: a customer for its own customer_id). NO update or delete privilege and no such policy for anyone. A BEFORE INSERT trigger forces requested_by to the signed in user, status open and empty quote columns, and refuses a 31st request by one user within 10 minutes. Two SECURITY DEFINER functions are the only way to change a row: `set_rate_quote` (active staff_admin or staff_csr) and `cancel_rate_request` (a customer of the request, open requests only). Not in the realtime publication. | Low. One new empty table, one sequence, three functions. Nothing existing is altered. Idempotent (IF NOT EXISTS, CREATE OR REPLACE, drop and recreate of its own policies and triggers, grants restated by name). Rolling back means section 5. |

Visible effect: the app gets a Rates page for customers and a Rate requests page for staff. Nothing changes for loads, lanes or carriers. Tell Maria about the new **Rates** menu item.

## 2. Order of operations: migration first, then the app

Recommendation: apply 0017 first, then deploy the app from main straight away.

Reasons
1. 0017 is additive and backward compatible. The app that is live now never reads `rate_requests`.
2. The new app needs 0017: the Rates page, the staff Rate requests pages and the "Open rate requests" count on the board all read `rate_requests`. Deploying the app first does not break loads, but the board shows the count as 0 and the Rates pages show an error until the migration is applied.
3. If the migration fails, nothing user visible has changed yet and the app is untouched.

## 3. Pre-check (read only)

Session setup. Run this in the terminal you will use for every block below. It loads DATABASE_URL_DIRECT without printing it.

```
set -o allexport; source ~/.zshenvmitrex; set +o allexport
cd ~/Documents/Projects/GitHub/Mitrex-DLV && git fetch origin && git checkout feat/dlv-030-rate-requests
```

(If this branch was merged, `git checkout main && git pull` instead. The migration files must be exactly the ones listed above.)

Block A, pre-check. Read only: every statement runs with `default_transaction_read_only = on`, so it cannot change data even by mistake.

```zsh
# BLOCK precheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-7}"
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
  for t in loads profiles load_events load_documents locations customers carriers location_requests load_deletions lane_references; do
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
  print -r -- "  (informational: loads that exist now stay exactly as they are; 0017 touches no load)"

  echo "--- production migration state is 0001 to 0016"
  v=$(q <<'SQL'
select count(*) from pg_tables where schemaname = 'public';
SQL
  ) || exit 1; need "10 public tables (the 9 of 0001 to 0014 plus lane_references)" "$v" "10"; rec PRE_public_tables "$v"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity;
SQL
  ) || exit 1; need "RLS enabled on all 10 tables" "$v" "10"; rec PRE_rls_tables "$v"
  v=$(q <<'SQL'
select (to_regprocedure('public.set_load_status(uuid, public.load_status, timestamptz, text)') is not null
    and to_regprocedure('public.set_its_load_number(uuid, text)') is not null
    and to_regprocedure('public.delete_load_forever(uuid, text)') is not null
    and to_regprocedure('public.dlv_lane_references_before_write()') is not null)::int;
SQL
  ) || exit 1; need "functions of 0002, 0013, 0014 and 0015 present" "$v" "1"
  v=$(q <<'SQL'
select (to_regprocedure('public.dlv_role()') is not null
    and to_regprocedure('public.dlv_is_staff()') is not null
    and to_regprocedure('public.dlv_customer_id()') is not null
    and to_regprocedure('public.dlv_touch_updated_at()') is not null)::int;
SQL
  ) || exit 1; need "identity helpers and the touch trigger function that 0017 uses are present" "$v" "1"
  v=$(q <<'SQL'
select (position('is_active' in pg_get_functiondef('public.dlv_is_staff()'::regprocedure)) > 0
    and position('is_active' in pg_get_functiondef('public.dlv_role()'::regprocedure)) > 0)::int;
SQL
  ) || exit 1; need "dlv_is_staff and dlv_role are inactive aware (0005)" "$v" "1"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'lane_references' and c.relkind = 'r' and c.relrowsecurity;
SQL
  ) || exit 1; need "lane_references (0015) exists with RLS enabled" "$v" "1"
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

  echo "--- nothing of 0017 exists yet (must be absent)"
  v=$(q <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in ('rate_requests', 'rate_request_seq');
SQL
  ) || exit 1; need "no table or sequence named rate_requests / rate_request_seq" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('set_rate_quote', 'cancel_rate_request', 'dlv_rate_requests_before_insert');
SQL
  ) || exit 1; need "no function named set_rate_quote, cancel_rate_request or dlv_rate_requests_before_insert" "$v" "0"
  v=$(q <<'SQL'
select count(*) from pg_policies where schemaname = 'public' and tablename = 'rate_requests';
SQL
  ) || exit 1; need "no policy on rate_requests" "$v" "0"

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

Stop here unless it printed `PRECHECK_OK`. A FAIL on "0001 to 0016 state" means an earlier pack is not fully applied: do not apply. A FAIL on "must be absent" means something of 0017 already exists: stop and investigate (do not run block B). The loads count and the per status counts are informational.

## 4. Apply

Block B. One transaction per migration (`--single-transaction`), stops at the first failure, full transcript in `apply-transcript-7.txt` (repo root, it contains no connection string). The migration list and the expected highest number live in the `files` array.

```zsh
# BLOCK apply
(
  setopt pipefail
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-7}"
  [[ -f "$DIR/state.env" ]] || { echo "FAIL: run the pre-check (block A) first"; exit 1; }
  grep -qx 'PRECHECK_RESULT=OK' "$DIR/state.env" || { echo "FAIL: the last pre-check (block A) did not end in PRECHECK_OK. Do not apply. Fix the cause and run block A again."; exit 1; }
  files=(
    0017_rate_requests.sql
  )
  for f in $files; do
    [[ -f "supabase/migrations/$f" ]] || { echo "FAIL: missing supabase/migrations/$f (run from the repo root)"; exit 1; }
  done
  last="${files[-1]%%_*}"
  highest=$(ls supabase/migrations | grep '^[0-9]' | sort | tail -1)
  [[ "${highest%%_*}" == "$last" ]] || { echo "FAIL: the highest migration file is ${highest%%_*} but the last file in this pack is $last"; exit 1; }
  count=$(ls supabase/migrations | grep -c '^[0-9]')
  [[ "$count" -eq $((10#$last)) ]] || { echo "FAIL: expected $((10#$last)) migration files (0001 to $last, none missing), found $count"; exit 1; }
  print -r -- "apply started $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-7.txt
  for f in $files; do
    print -r -- "=== $f" | tee -a apply-transcript-7.txt
    psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f "supabase/migrations/$f" 2>&1 | tee -a apply-transcript-7.txt || { echo "APPLY_FAIL at $f (that file was rolled back as one transaction; earlier files stay applied; see section 5)"; exit 1; }
  done
  print -r -- "APPLY_OK $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a apply-transcript-7.txt
)
```

If a block fails midway: the failing file is one transaction, so it left nothing behind. Earlier files stay applied. Fix the cause and run block B again (every file is idempotent).

## 5. Rollback notes (per migration)

Every migration runs as one transaction, so a failure inside a file undoes that whole file. This is only for undoing a file that APPLIED and that you then decide to back out. Do not run it against production without the owner's explicit go. Reuse `$DATABASE_URL_DIRECT`. Roll back together with a rollback of the app to a build without the Rates pages.

- 0017: drops the table `rate_requests`, the three functions and the sequence, as ONE transaction. WARNING: every rate request and every entered rate goes with the table. The block refuses to run while the table holds rows unless `DLV_ALLOW_RATE_LOSS=1` is exported (use it only with the owner's explicit go; copy the rows out first if anyone needs them). Nothing else is touched: 0017 changed no existing object.

```zsh
# BLOCK rollback-0017
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  n=$(echo "select count(*) from public.rate_requests;" | psql "$DATABASE_URL_DIRECT" -X -A -t -q -v ON_ERROR_STOP=1 -f -) || { echo "FAIL: cannot count rate_requests (is 0017 applied?)"; exit 1; }
  if [[ "$n" != "0" && "$DLV_ALLOW_RATE_LOSS" != "1" ]]; then
    echo "FAIL: rate_requests holds $n row(s). Rolling back 0017 drops them for good. Export DLV_ALLOW_RATE_LOSS=1 only with the owner's explicit go."
    exit 1
  fi
  psql "$DATABASE_URL_DIRECT" -X --single-transaction -v ON_ERROR_STOP=1 -f - <<'SQL' || exit 1
drop table if exists public.rate_requests;
drop function if exists public.set_rate_quote(uuid, numeric, text, text, date);
drop function if exists public.cancel_rate_request(uuid);
drop function if exists public.dlv_rate_requests_before_insert();
drop sequence if exists public.rate_request_seq;
SQL
  echo ROLLBACK_0017_OK
)
```

## 6. Post-check (read only)

Block C. Expected values come from the same run: the counts saved by block A are compared with fresh counts, and the security posture of the new table is checked against the catalog. It changes nothing.

```zsh
# BLOCK postcheck
(
  [[ -n "$DATABASE_URL_DIRECT" ]] || { echo "FAIL: DATABASE_URL_DIRECT is not set"; exit 1; }
  DIR="${DLV_APPLY_DIR:-$HOME/dlv-apply-7}"
  STATE="$DIR/state.env"
  [[ -f "$STATE" ]] || { echo "FAIL: no state file, run block A before the apply"; exit 1; }
  source "$STATE" || exit 1
  q() { { echo "set default_transaction_read_only = on;"; cat; } | psql "$DATABASE_URL_DIRECT" -X -A -t -q -v ON_ERROR_STOP=1 -f - ; }
  bad=0
  need() { if [[ "$2" == "$3" ]]; then print -r -- "PASS $1"; else print -r -- "FAIL $1 (got $2, want $3)"; bad=1; fi; }
  RT="'public.rate_requests'::regclass"
  CK="select count(*) from pg_constraint where conrelid = 'public.rate_requests'::regclass and contype = 'c' and convalidated and conname"

  echo "--- row counts unchanged"
  for t in loads profiles load_events load_documents locations customers carriers location_requests load_deletions lane_references; do
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

  echo "--- 0017 rate_requests: shape"
  v=$(q <<SQL
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'rate_requests' and c.relkind = 'r' and c.relrowsecurity;
SQL
  ) || exit 1; need "table rate_requests exists with RLS enabled" "$v" "1"
  v=$(q <<SQL
select count(*) from public.rate_requests;
SQL
  ) 2>/dev/null || v="query failed"; need "rate_requests is empty after the apply" "$v" "0"
  v=$(q <<SQL
select string_agg(column_name || ':' || data_type, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'rate_requests';
SQL
  ) || exit 1; need "the 21 columns in order" "$v" "id:uuid,ref:text,customer_id:uuid,requested_by:uuid,pickup_city:text,pickup_state:text,delivery_city:text,delivery_state:text,equipment_size:integer,weight_lbs:integer,dims:text,notes:text,status:text,quoted_amount:numeric,quoted_currency:text,quote_notes:text,quote_valid_until:date,quoted_by:uuid,quoted_at:timestamp with time zone,created_at:timestamp with time zone,updated_at:timestamp with time zone"
  v=$(q <<SQL
$CK in ('rate_requests_city_ck','rate_requests_state_ck','rate_requests_size_ck','rate_requests_weight_ck','rate_requests_dims_ck','rate_requests_notes_ck','rate_requests_status_ck','rate_requests_amount_ck','rate_requests_currency_ck','rate_requests_quote_notes_ck','rate_requests_quote_set_ck');
SQL
  ) || exit 1; need "the 11 CHECK constraints are present and validated" "$v" "11"
  v=$(q <<SQL
select count(*) from pg_constraint where conrelid = $RT and contype = 'f'
   and confrelid in ('public.customers'::regclass, 'public.profiles'::regclass);
SQL
  ) || exit 1; need "two foreign keys (customers, profiles) and no others" "$v" "2"
  v=$(q <<SQL
select count(*) from pg_constraint where conrelid = $RT and contype = 'f';
SQL
  ) || exit 1; need "exactly two foreign keys on rate_requests" "$v" "2"
  v=$(q <<SQL
select count(*) from pg_constraint where contype = 'f' and confrelid = $RT;
SQL
  ) || exit 1; need "no table references rate_requests (a rate request is not a load)" "$v" "0"
  v=$(q <<SQL
select count(*) from pg_indexes where schemaname = 'public' and tablename = 'rate_requests' and (indexdef ilike '%unique%(ref)%' or indexname in ('rate_requests_customer_idx','rate_requests_status_idx'));
SQL
  ) || exit 1; need "unique index on ref and the two lookup indexes" "$v" "3"
  v=$(q <<SQL
select (to_regclass('public.rate_request_seq') is not null
   and has_sequence_privilege('authenticated', 'public.rate_request_seq', 'usage')
   and not has_sequence_privilege('anon', 'public.rate_request_seq', 'usage')
   and not has_sequence_privilege('authenticated', 'public.rate_request_seq', 'update'))::int;
SQL
  ) || exit 1; need "sequence rate_request_seq: usage for authenticated, nothing for anon" "$v" "1"

  echo "--- 0017 rate_requests: who can do what"
  v=$(q <<SQL
select (has_table_privilege('anon', $RT, 'select') or has_table_privilege('anon', $RT, 'insert') or has_table_privilege('anon', $RT, 'update')
     or has_table_privilege('anon', $RT, 'delete') or has_any_column_privilege('anon', $RT, 'insert') or has_any_column_privilege('anon', $RT, 'update'))::int;
SQL
  ) || exit 1; need "anon holds nothing on rate_requests" "$v" "0"
  v=$(q <<SQL
select count(*) from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where c.oid = $RT and a.grantee = 0;
SQL
  ) || exit 1; need "PUBLIC holds nothing on rate_requests" "$v" "0"
  v=$(q <<SQL
select (has_table_privilege('authenticated', $RT, 'select') and has_any_column_privilege('authenticated', $RT, 'insert'))::int;
SQL
  ) || exit 1; need "control: authenticated can select and insert (column level)" "$v" "1"
  v=$(q <<SQL
select (has_table_privilege('authenticated', $RT, 'update') or has_table_privilege('authenticated', $RT, 'delete') or has_table_privilege('authenticated', $RT, 'truncate')
     or has_table_privilege('authenticated', $RT, 'references') or has_table_privilege('authenticated', $RT, 'trigger') or has_table_privilege('authenticated', $RT, 'insert'))::int;
SQL
  ) || exit 1; need "authenticated holds no table level insert, update, delete, truncate, references or trigger" "$v" "0"
  v=$(q <<SQL
select count(*) from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'rate_requests'
   and has_column_privilege('authenticated', $RT, c.column_name, 'update');
SQL
  ) || exit 1; need "no column of rate_requests is updatable by authenticated" "$v" "0"
  v=$(q <<SQL
select string_agg(c.column_name, ',' order by c.column_name) from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'rate_requests'
   and has_column_privilege('authenticated', $RT, c.column_name, 'insert');
SQL
  ) || exit 1; need "authenticated can insert exactly the nine request columns" "$v" "customer_id,delivery_city,delivery_state,dims,equipment_size,notes,pickup_city,pickup_state,weight_lbs"
  v=$(q <<SQL
select count(*) from pg_policies where schemaname = 'public' and tablename = 'rate_requests' and cmd in ('SELECT', 'INSERT') and roles = '{authenticated}';
SQL
  ) || exit 1; need "exactly the select and insert policies, authenticated only" "$v" "2"
  v=$(q <<SQL
select count(*) from pg_policies where schemaname = 'public' and tablename = 'rate_requests';
SQL
  ) || exit 1; need "no other policy (no update, delete or all)" "$v" "2"
  v=$(q <<SQL
select count(*) from pg_policies where schemaname = 'public' and tablename = 'rate_requests'
   and coalesce(qual, with_check) !~ 'carrier' and coalesce(qual, with_check) like '%dlv_%';
SQL
  ) || exit 1; need "both policies go through the identity helpers and name no carrier role" "$v" "2"
  v=$(q <<SQL
select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'rate_requests';
SQL
  ) || exit 1; need "rate_requests is not in the realtime publication" "$v" "0"
  v=$(q <<SQL
select count(*) from pg_publication_tables where pubname = 'supabase_realtime';
SQL
  ) || exit 1; need "the realtime publication holds the same tables as before" "$v" "$PRE_realtime_tables"

  echo "--- 0017 functions and triggers"
  v=$(q <<SQL
select count(*) from pg_proc where oid in (to_regprocedure('public.set_rate_quote(uuid, numeric, text, text, date)'), to_regprocedure('public.cancel_rate_request(uuid)'))
   and prosecdef and exists (select 1 from unnest(proconfig) c where c like 'search_path=%');
SQL
  ) || exit 1; need "set_rate_quote and cancel_rate_request are SECURITY DEFINER with a fixed search_path" "$v" "2"
  v=$(q <<SQL
select (has_function_privilege('authenticated', to_regprocedure('public.set_rate_quote(uuid, numeric, text, text, date)'), 'execute')
    and has_function_privilege('authenticated', to_regprocedure('public.cancel_rate_request(uuid)'), 'execute')
    and not has_function_privilege('anon', to_regprocedure('public.set_rate_quote(uuid, numeric, text, text, date)'), 'execute')
    and not has_function_privilege('anon', to_regprocedure('public.cancel_rate_request(uuid)'), 'execute'))::int;
SQL
  ) || exit 1; need "authenticated can EXECUTE the two functions, anon cannot" "$v" "1"
  v=$(q <<SQL
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'dlv_rate_requests_before_insert'
   and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
SQL
  ) || exit 1; need "no client role can EXECUTE the insert trigger function" "$v" "0"
  v=$(q <<SQL
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute');
SQL
  ) || exit 1; need "anon can EXECUTE no function in public" "$v" "0"
  v=$(q <<SQL
select count(*) from pg_trigger where tgrelid = $RT and not tgisinternal and tgenabled = 'O' and tgname in ('rate_requests_before_insert', 'rate_requests_touch_updated_at');
SQL
  ) || exit 1; need "the insert trigger and the touch trigger are enabled" "$v" "2"

  echo "--- security posture unchanged"
  v=$(q <<SQL
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity;
SQL
  ) || exit 1; need "RLS enabled on every public table (the 10 before plus rate_requests)" "$v" "$((PRE_rls_tables + 1))"
  v=$(q <<SQL
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
SQL
  ) || exit 1; need "no public table without RLS" "$v" "0"
  v=$(q <<SQL
select count(*) from pg_tables where schemaname = 'public';
SQL
  ) || exit 1; need "public table count is the old count plus one" "$v" "$((PRE_public_tables + 1))"
  v=$(q <<SQL
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('select'),('insert'),('update'),('delete'),('truncate'),('references'),('trigger')) p(priv)
 where n.nspname = 'public' and c.relkind in ('r','v','m','p') and has_table_privilege('anon', c.oid, p.priv);
SQL
  ) || exit 1; need "anon table grants unchanged (zero)" "$v" "$PRE_anon_table_grants"
  v=$(q <<SQL
select count(*) from pg_policies where schemaname in ('public','storage');
SQL
  ) || exit 1; need "policy count is the old count plus the two rate_requests policies" "$v" "$((PRE_policies + 2))"
  v=$(q <<SQL
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';
SQL
  ) || exit 1; need "function count is the old count plus three" "$v" "$((PRE_public_functions + 3))"
  v=$(q <<SQL
select count(*) from pg_policies where schemaname = 'public' and tablename = 'lane_references';
SQL
  ) || exit 1; need "lane_references still has its four policies (untouched)" "$v" "4"
  v=$(q <<SQL
select (position('enter the ITS load number before booking' in pg_get_functiondef('public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure)) > 0
    and to_regprocedure('public.delete_load_forever(uuid, text)') is not null)::int;
SQL
  ) || exit 1; need "set_load_status still carries the ITS rule and delete_load_forever still exists" "$v" "1"
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

After `POSTCHECK_OK`: deploy the app from main (Vercel), then follow the "After every deploy" list in docs/RUNBOOK.md. App level smoke after the deploy: sign in as Maria, the top menu has **Rates**; open it (an empty list and the form). Sign in as staff: **Rate requests** is in the menu and the board shows "Open rate requests 0". Do not create real requests to test: ask for a throwaway rate as Maria ("TEST-RATE" in the notes), enter a rate as staff, check the two emails (the one to Maria must not show the price), then cancel a second throwaway request as Maria. Test rows stay in the table (there is no delete); say "TEST" in the notes so they are recognisable.

## Extending this pack

A later card that adds a migration (for example 0018) does exactly three things and changes no block logic:
1. Add a row to the table in section 1.
2. Append the file name to the `files=( ... )` array in block B. The "highest file equals the last file in the list" and "file count equals the highest number" checks then expect 0018 by themselves.
3. Add a group of PASS checks for the new file to block C, and any read only data check to block A. The row count, security posture and earlier migration groups stay as they are (adjust the expected RLS table, policy and function counts by what the new file adds).

## Rehearsal result

Rehearsed on the LOCAL stack only (127.0.0.1:54322), never production, on 2026-10-07 by the engineering assistant (DLV-030 card).

IMPORTANT LIMIT, read first: the harness this session ran in REFUSES to run zsh files (the same refusal packs 4, 5 and 6 recorded), so the blocks were NOT run verbatim under `zsh -f`. The lead reruns them. What was run instead: the four blocks were extracted from this file with a python regex (`` ```zsh\n# BLOCK name\n(.*?)\n``` ``; every block ends with a line that is exactly `)`), and a small python driver (not the shell) ran EVERY SQL statement of blocks A and C through psql (read only, `default_transaction_read_only = on`), compared each result with the value the block expects (including the values derived from the state file: `PRE_rls_tables + 1`, `PRE_public_tables + 1`, `PRE_policies + 2`, `PRE_public_functions + 3`, `PRE_realtime_tables`), and ran block B's file and count checks and its one command per file exactly as written (`psql --single-transaction -v ON_ERROR_STOP=1 -f`). The driver reads the SQL and the expected values out of this file, so a wrong value in the pack shows as a FAIL there.

Method: `supabase db reset --last 1` took the local database from 0017 back to 0016 (read back from `supabase_migrations.schema_migrations`: max version 0016, 16 rows, no `rate_requests`, no sequence, no function). Production-like rows were inserted: 1 staff_admin, 1 customer user of Mitrex, 2 loads (one requested, one cancelled); the seed already gives 25 lane rows and 19 locations. Afterwards `supabase db reset` restored the full local state.

| Step | Result |
| --- | --- |
| Block A pre-check (SQL through psql, read only) | 12 PASS, 0 FAIL: 10 public tables, RLS 10 of 10, the functions of 0002, 0013, 0014 and 0015, identity helpers and the touch function, dlv_is_staff and dlv_role inactive aware, lane_references with RLS, customer Mitrex, anon holds zero table grants and executes no function, no table / sequence / function / policy of 0017. Recorded: 10 row counts, 8 load status counts, PRE_active_admins = 1, PRE_active_customer_users = 1, PRE_policies = 27, PRE_public_functions = 25, PRE_realtime_tables = 2. PRECHECK_OK. |
| Block B apply (the files array, one command each) | File checks hold (17 files, highest 0017). 0017 applied in one transaction, rc 0, 0 error lines. APPLY_OK. |
| Block C post-check (SQL through psql, read only) | 53 PASS, 0 FAIL: 18 row count comparisons (10 tables, 8 load statuses) unchanged, rate_requests with RLS and empty, the 21 columns in order, the 11 CHECK constraints validated, exactly two foreign keys (customers, profiles) and nothing references the table, unique ref and two lookup indexes, the sequence (usage for authenticated, nothing for anon), anon and PUBLIC hold nothing, authenticated has no table level insert, update, delete, truncate, references or trigger and no updatable column, authenticated can insert exactly the nine request columns, exactly two policies (select, insert) naming no carrier role, not in the realtime publication, the two functions SECURITY DEFINER with a fixed search_path and executable by authenticated but not anon, the trigger function not executable by clients, both triggers enabled, RLS on 11 of 11 tables (before + 1), policies before + 2, functions before + 3, lane_references still has its four policies, the ITS rule in set_load_status, admin and customer counts unchanged. POSTCHECK_OK. |
| Re-run of B then C | 0 error lines, then 53 PASS, 0 FAIL (idempotent). |
| Negative arm: block A after the apply | 5 FAIL (do not apply): "10 public tables" got 11, "RLS enabled on all 10 tables" got 11, "no table or sequence" got 2, "no function" got 3, "no policy" got 2. The other 7 checks PASS. PRECHECK_FAIL. |
| Negative arms of block C | `grant update (status)` to authenticated: 1 FAIL ("no column of rate_requests is updatable by authenticated"). A delete policy added: 2 FAIL ("no other policy", "policy count"). `grant select` to anon: 2 FAIL ("anon holds nothing on rate_requests", "anon table grants unchanged"). Each was reverted and block C was green again (53 PASS). |
| Rollback 0017 | The rollback SQL refused while the table held 1 row ("rate_requests holds 1 row(s)"), and ran (ROLLBACK_0017_OK) on the empty table. Block C after the rollback stops at its first query against the missing table with a psql error and a non-zero exit (it fails closed; it prints no POSTCHECK_OK). Block B again restored the table and block C gave 53 PASS, POSTCHECK_OK. |
| Functional rules of 0017 | Not part of the blocks. supabase/tests/rls.sql section 16 (grants and policies, customer insert with forged columns, who reads what, no direct update or delete, set_rate_quote for staff only with every refusal, correction, cancel rules, all CHECK constraints, applying 0017 a second time) and e2e/rate-requests.spec.ts run on a fresh `supabase db reset`. |

### Lead rehearsal of the real blocks

To be filled in by the lead: run the four blocks verbatim under `zsh -f` against the local stack (from `supabase db reset --last 1` plus production-like rows) and record the verdicts here.

### Lead rehearsal of the real blocks (2026-10-07)

The blocks were extracted verbatim and run under `zsh -f` against the local stack only, from `supabase db reset --last 1` (state 0016) plus production-like rows. Block A: PRECHECK_OK. Block B: APPLY_OK. Block C: 53 PASS, POSTCHECK_OK. Block B again: APPLY_OK (idempotent). Block C again: POSTCHECK_OK. Rollback-0017, then block C: POSTCHECK_FAIL on the table, empty and column checks. Block B again restored it and block C gave POSTCHECK_OK.

## Production result (2026-10-07)

- Block A: PRECHECK_OK. Block B: APPLY_OK at 2026-10-07T14:25:02Z, 0017 applied with no errors.
- Block C: POSTCHECK_OK, 53 PASS, 0 FAIL. No live traffic disturbed the counts this time.
- App PR #30 merged as d6d2dab after all three checks passed. The production deploy of that commit succeeded; /api/health returned ok and /login returned 200.
