-- RLS and status-transition tests. Runs inside one transaction that is rolled back.
-- Roles are simulated with request.jwt.claims plus SET LOCAL ROLE.
-- Every negative assertion has a guard (the subject exists) and a positive control.
\set ON_ERROR_STOP on
\pset tuples_only on
begin;

create schema rlstest;
create table rlstest.res (n serial, name text, outcome text, detail text);
grant usage on schema rlstest to authenticated, anon;

create function rlstest.rec(p_name text, p_outcome text, p_detail text default null) returns void
language sql security definer as $f$
  insert into rlstest.res (name, outcome, detail) values (p_name, p_outcome, p_detail) $f$;

create function rlstest.su_count(p_sql text) returns bigint
language plpgsql security definer as $f$
declare n bigint; begin execute 'select count(*) from (' || p_sql || ') q' into n; return n; end $f$;

create function rlstest.as_user(p_uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $f$;

create function rlstest.as_anon() returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  execute 'set local role anon';
end $f$;

create function rlstest.back() returns void language plpgsql as $f$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $f$;

-- positive control: statement must succeed
create function rlstest.ok(p_name text, p_sql text) returns void language plpgsql as $f$
begin
  begin
    execute p_sql;
    perform rlstest.rec(p_name, 'OK');
  exception when others then
    perform rlstest.rec(p_name, 'FAIL', 'unexpected error: ' || sqlerrm);
  end;
end $f$;

-- negative: statement must raise an error matching p_pattern
create function rlstest.err(p_name text, p_sql text, p_pattern text) returns void language plpgsql as $f$
begin
  begin
    execute p_sql;
    perform rlstest.rec(p_name, 'FAIL', 'no error raised');
  exception when others then
    if sqlerrm ~* p_pattern then perform rlstest.rec(p_name, 'OK');
    else perform rlstest.rec(p_name, 'FAIL', 'wrong error: ' || sqlerrm); end if;
  end;
end $f$;

-- row count of a statement equals p_expected (guard: subject must exist for p_expected = 0)
create function rlstest.rows(p_name text, p_sql text, p_expected int, p_subject text default null)
returns void language plpgsql as $f$
declare n int;
begin
  if p_expected = 0 and p_subject is not null and rlstest.su_count(p_subject) = 0 then
    perform rlstest.rec(p_name, 'VACUOUS', 'subject has no rows'); return;
  end if;
  execute p_sql;
  get diagnostics n = row_count;
  if n = p_expected then perform rlstest.rec(p_name, 'OK');
  else perform rlstest.rec(p_name, 'FAIL', 'rows=' || n || ' expected=' || p_expected); end if;
end $f$;

-- select count equals p_expected (same guard rule)
create function rlstest.cnt(p_name text, p_sql text, p_expected bigint, p_subject text default null)
returns void language plpgsql as $f$
declare n bigint;
begin
  if p_expected = 0 and p_subject is not null and rlstest.su_count(p_subject) = 0 then
    perform rlstest.rec(p_name, 'VACUOUS', 'subject has no rows'); return;
  end if;
  execute 'select count(*) from (' || p_sql || ') q' into n;
  if n = p_expected then perform rlstest.rec(p_name, 'OK');
  else perform rlstest.rec(p_name, 'FAIL', 'count=' || n || ' expected=' || p_expected); end if;
end $f$;

-- 0018: a photo row needs its picture in the bucket first (the app uploads, then inserts). Text of a DO block that stores
-- the image object and the row as the CURRENT user, in that order.
create function rlstest.pdins(p_load text, p_kind text, p_path text) returns text language sql immutable as $f$
  select format($q$do $x$ begin insert into storage.objects (bucket_id, name, owner, metadata) values ('documents', %L, auth.uid(), '{"mimetype":"image/jpeg"}'::jsonb); insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values (%L::uuid, %L, %L, auth.uid()); end $x$$q$, p_path, p_load, p_kind, p_path) $f$;

grant execute on all functions in schema rlstest to authenticated, anon;

-- Fixtures -------------------------------------------------------------
insert into auth.users (id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', 'admin@t.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'authenticated', 'authenticated', 'csr@t.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'authenticated', 'authenticated', 'maria@t.test'),
  ('00000000-0000-0000-0000-0000000000c2', 'authenticated', 'authenticated', 'other@t.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'authenticated', 'authenticated', 'ownera@t.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'authenticated', 'drivera@t.test'),
  ('00000000-0000-0000-0000-0000000000b3', 'authenticated', 'authenticated', 'ownerb@t.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'authenticated', 'authenticated', 'admin2@t.test');

insert into public.customers (id, name) values
  ('10000000-0000-0000-0000-000000000002', 'Other Customer');
insert into public.carriers (id, name) values
  ('20000000-0000-0000-0000-00000000000a', 'Carrier A'),
  ('20000000-0000-0000-0000-00000000000b', 'Carrier B');

insert into public.profiles (id, email, role, customer_id, carrier_id) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'staff_admin', null, null),
  ('00000000-0000-0000-0000-0000000000a2', 'csr@t.test', 'staff_csr', null, null),
  ('00000000-0000-0000-0000-0000000000c1', 'maria@t.test', 'customer', (select id from public.customers where name = 'Mitrex'), null),
  ('00000000-0000-0000-0000-0000000000c2', 'other@t.test', 'customer', '10000000-0000-0000-0000-000000000002', null),
  ('00000000-0000-0000-0000-0000000000b1', 'ownera@t.test', 'carrier_owner', null, '20000000-0000-0000-0000-00000000000a'),
  ('00000000-0000-0000-0000-0000000000b2', 'drivera@t.test', 'carrier_driver', null, '20000000-0000-0000-0000-00000000000a'),
  ('00000000-0000-0000-0000-0000000000b3', 'ownerb@t.test', 'carrier_owner', null, '20000000-0000-0000-0000-00000000000b'),
  -- second staff_admin: migration 0008 refuses to deactivate the last active one (section 9 deactivates a1)
  ('00000000-0000-0000-0000-0000000000a3', 'admin2@t.test', 'staff_admin', null, null);

create function rlstest.mkload(p_id uuid, p_status public.load_status, p_carrier uuid) returns void
language plpgsql security definer as $f$
begin
  insert into public.loads (id, customer_id, created_by, pickup_location_id, delivery_location_id,
    equipment_size, pickup_timing, pickup_date, pickup_time_start, delivery_timing, delivery_date,
    delivery_time_start, pickup_contact_name, pickup_contact_phone, delivery_contact_name, delivery_contact_phone)
  values (p_id, (select id from public.customers where name = 'Mitrex'),
    '00000000-0000-0000-0000-0000000000c1',
    (select id from public.locations where name = 'Mitrex'),
    (select id from public.locations where name = 'Howden'),
    53, 'appointment', current_date + 1, '08:00', 'appointment', current_date + 1, '14:00',
    'P Contact', '416-000-0001', 'D Contact', '416-000-0002');
  perform set_config('dlv.status_fn', '1', true);
  update public.loads set status = p_status, carrier_id = p_carrier where id = p_id;
  perform set_config('dlv.status_fn', '0', true);
end $f$;

-- L1 requested (Maria), L2 booked carrier A, L3 booked carrier B, L4 requested for cancel tests
select rlstest.mkload('30000000-0000-0000-0000-000000000001', 'requested', null);
select rlstest.mkload('30000000-0000-0000-0000-000000000002', 'booked', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload('30000000-0000-0000-0000-000000000003', 'booked', '20000000-0000-0000-0000-00000000000b');
select rlstest.mkload('30000000-0000-0000-0000-000000000004', 'requested', null);

-- 1. anon reads nothing --------------------------------------------------
select rlstest.cnt('control: staff sees loads', 'select 1 from public.loads', 4) from (select rlstest.as_user('00000000-0000-0000-0000-0000000000a1')) s;
select rlstest.back();
select rlstest.as_anon();
select rlstest.err('anon cannot read loads', 'select * from public.loads', 'permission denied');
select rlstest.err('anon cannot read locations', 'select * from public.locations', 'permission denied');
select rlstest.err('anon cannot read profiles', 'select * from public.profiles', 'permission denied');
do $t$
begin
  perform rlstest.rec('anon has no EXECUTE on set_load_status',
    case when has_function_privilege('anon', 'public.set_load_status(uuid, public.load_status, timestamptz, text)', 'execute') then 'FAIL' else 'OK' end);
  perform rlstest.rec('control: authenticated has EXECUTE on set_load_status',
    case when has_function_privilege('authenticated', 'public.set_load_status(uuid, public.load_status, timestamptz, text)', 'execute') then 'OK' else 'FAIL' end);
end $t$;
select rlstest.back();

-- 2. carrier A cannot read carrier B loads; driver = owner ----------------
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.cnt('control: owner A sees own booked load', $q$select 1 from public.loads where carrier_id = '20000000-0000-0000-0000-00000000000a'$q$, 1);
select rlstest.cnt('carrier A cannot read carrier B loads', $q$select 1 from public.loads where carrier_id = '20000000-0000-0000-0000-00000000000b'$q$, 0,
  $q$select 1 from public.loads where carrier_id = '20000000-0000-0000-0000-00000000000b'$q$);
select rlstest.cnt('carrier A cannot read requested loads', $q$select 1 from public.loads where status = 'requested'$q$, 0,
  $q$select 1 from public.loads where status = 'requested'$q$);
select rlstest.cnt('control: owner A sees location of own load', $q$select 1 from public.locations where name = 'Howden'$q$, 1);
select rlstest.cnt('carrier A cannot read unrelated locations', $q$select 1 from public.locations where name = 'Glengarry'$q$, 0,
  $q$select 1 from public.locations where name = 'Glengarry'$q$);
select rlstest.cnt('control: owner A reads own carrier row', $q$select 1 from public.carriers where name = 'Carrier A'$q$, 1);
select rlstest.cnt('carrier A cannot read carrier B row', $q$select 1 from public.carriers where name = 'Carrier B'$q$, 0,
  $q$select 1 from public.carriers where name = 'Carrier B'$q$);
select rlstest.back();

create function rlstest.ids_as(p_uid uuid) returns text language plpgsql as $f$
declare r text;
begin
  perform rlstest.as_user(p_uid);
  select coalesce(string_agg(id::text, ',' order by id), '') into r from public.loads;
  perform rlstest.back();
  return r;
end $f$;
do $t$
declare o text; d text;
begin
  o := rlstest.ids_as('00000000-0000-0000-0000-0000000000b1');
  d := rlstest.ids_as('00000000-0000-0000-0000-0000000000b2');
  if o = '' then perform rlstest.rec('driver sees same loads as owner', 'VACUOUS', 'owner sees none');
  elsif o = d then perform rlstest.rec('driver sees same loads as owner', 'OK');
  else perform rlstest.rec('driver sees same loads as owner', 'FAIL', o || ' vs ' || d); end if;
end $t$;

-- 3. customer cannot update booked load; cannot change status or carrier ---
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.rows('control: customer edits own requested load', $q$update public.loads set notes = 'edited' where id = '30000000-0000-0000-0000-000000000001'$q$, 1);
select rlstest.rows('customer cannot update a booked load', $q$update public.loads set notes = 'edited' where id = '30000000-0000-0000-0000-000000000002'$q$, 0,
  $q$select 1 from public.loads where id = '30000000-0000-0000-0000-000000000002'$q$);
select rlstest.err('customer cannot change status directly', $q$update public.loads set status = 'booked' where id = '30000000-0000-0000-0000-000000000001'$q$, 'set_load_status');
select rlstest.err('customer cannot change carrier_id', $q$update public.loads set carrier_id = '20000000-0000-0000-0000-00000000000a' where id = '30000000-0000-0000-0000-000000000001'$q$, 'staff only');
select rlstest.err('customer cannot change eta', $q$update public.loads set eta = now() where id = '30000000-0000-0000-0000-000000000001'$q$, 'set_load_status');
select rlstest.err('customer cannot change load_number', $q$update public.loads set load_number = 'MTX-9999' where id = '30000000-0000-0000-0000-000000000001'$q$, 'immutable');
select rlstest.err('customer cannot move load to another customer', $q$update public.loads set customer_id = '10000000-0000-0000-0000-000000000002' where id = '30000000-0000-0000-0000-000000000001'$q$, 'immutable');
select rlstest.err('customer cannot cancel a booked load', $q$select public.set_load_status('30000000-0000-0000-0000-000000000002', 'cancelled')$q$, 'only cancel');
select rlstest.ok('control: customer cancels own requested load', $q$select public.set_load_status('30000000-0000-0000-0000-000000000004', 'cancelled')$q$);
select rlstest.err('customer cannot move a load forward', $q$select public.set_load_status('30000000-0000-0000-0000-000000000001', 'booked')$q$, 'only cancel');
select rlstest.cnt('customer cannot read other customer loads', $q$select 1 from public.loads where customer_id = '10000000-0000-0000-0000-000000000002'$q$, 0);
select rlstest.back();

-- staff positive control for carrier_id and status (0013: a request needs its ITS number before booking; seeded as the owner so no event is written, section 13 tests the function)
update public.loads set its_load_number = '9001' where id = '30000000-0000-0000-0000-000000000001';
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.rows('control: staff assigns carrier', $q$update public.loads set carrier_id = '20000000-0000-0000-0000-00000000000a' where id = '30000000-0000-0000-0000-000000000001'$q$, 1);
select rlstest.err('staff cannot set status by direct update', $q$update public.loads set status = 'booked' where id = '30000000-0000-0000-0000-000000000001'$q$, 'set_load_status');
select rlstest.ok('control: staff books via function', $q$select public.set_load_status('30000000-0000-0000-0000-000000000001', 'booked', null, null)$q$);
select rlstest.err('staff jump needs a note', $q$select public.set_load_status('30000000-0000-0000-0000-000000000001', 'delivered')$q$, 'note is required');
select rlstest.ok('control: staff override with note', $q$select public.set_load_status('30000000-0000-0000-0000-000000000001', 'loading', null, 'manual fix')$q$);
select rlstest.ok('control: staff cancels before delivered', $q$select public.set_load_status('30000000-0000-0000-0000-000000000001', 'cancelled', null, 'test')$q$);
select rlstest.err('staff cannot book without carrier', $q$select public.set_load_status('30000000-0000-0000-0000-000000000004', 'booked', null, 'x')$q$, 'assign a carrier');
select rlstest.cnt('control: staff reads all carriers', 'select 1 from public.carriers', 2);
select rlstest.err('csr cannot create a carrier', $q$insert into public.carriers (name) values ('Nope')$q$, 'row-level security');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.ok('control: admin creates a carrier', $q$insert into public.carriers (name) values ('Carrier C')$q$);
select rlstest.back();

-- 4. carrier steps: cannot skip, eta required, POD is optional at delivery (0011, see section 12) --------------
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.err('carrier cannot skip a step', $q$select public.set_load_status('30000000-0000-0000-0000-000000000002', 'loading')$q$, 'one step');
select rlstest.err('carrier cannot book', $q$select public.set_load_status('30000000-0000-0000-0000-000000000002', 'booked')$q$, 'one step|already');
select rlstest.err('carrier A cannot touch carrier B load', $q$select public.set_load_status('30000000-0000-0000-0000-000000000003', 'at_pickup')$q$, 'not your load');
select rlstest.ok('control: carrier moves one step', $q$select public.set_load_status('30000000-0000-0000-0000-000000000002', 'at_pickup')$q$);
select rlstest.ok('control: carrier moves to loading', $q$select public.set_load_status('30000000-0000-0000-0000-000000000002', 'loading')$q$);
select rlstest.err('enroute without eta rejected', $q$select public.set_load_status('30000000-0000-0000-0000-000000000002', 'enroute')$q$, 'eta is required');
select rlstest.err('eta cannot change before enroute', $q$select public.set_load_eta('30000000-0000-0000-0000-000000000002', now() + interval '2 hours')$q$, 'only while enroute');
select rlstest.err('enroute with an eta but without a pickup photo is refused (0018)', $q$select public.set_load_status('30000000-0000-0000-0000-000000000002', 'enroute', now() + interval '3 hours')$q$, 'photo of the loaded freight');
select rlstest.ok('control: carrier adds the pickup photo while loading (0018)', rlstest.pdins('30000000-0000-0000-0000-000000000002', 'pickup_photo', '30000000-0000-0000-0000-000000000002/pickup_photo/a0000000-0000-0000-0000-0000000000f5.jpg'));
select rlstest.ok('control: enroute with eta',$q$select public.set_load_status('30000000-0000-0000-0000-000000000002', 'enroute', now() + interval '3 hours')$q$);
select rlstest.ok('control: eta editable while enroute', $q$select public.set_load_eta('30000000-0000-0000-0000-000000000002', now() + interval '4 hours')$q$);
select rlstest.ok('control: carrier moves to at_delivery', $q$select public.set_load_status('30000000-0000-0000-0000-000000000002', 'at_delivery')$q$);
select rlstest.err('carrier cannot upload a BOL', $q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values ('30000000-0000-0000-0000-000000000002', 'bol', '30000000-0000-0000-0000-000000000002/bol/a0000000-0000-0000-0000-0000000000f2.pdf', '00000000-0000-0000-0000-0000000000b1')$q$, 'row-level security');
select rlstest.err('carrier A cannot upload POD to carrier B load', $q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values ('30000000-0000-0000-0000-000000000003', 'pod', '30000000-0000-0000-0000-000000000003/pod/a0000000-0000-0000-0000-0000000000f1.jpg', '00000000-0000-0000-0000-0000000000b1')$q$, 'row-level security');
select rlstest.ok('control: carrier uploads POD row', $q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values ('30000000-0000-0000-0000-000000000002', 'pod', '30000000-0000-0000-0000-000000000002/pod/a0000000-0000-0000-0000-0000000000f1.jpg', '00000000-0000-0000-0000-0000000000b1')$q$);
select rlstest.ok('control: carrier uploads POD file', $q$insert into storage.objects (bucket_id, name, owner) values ('documents', '30000000-0000-0000-0000-000000000002/pod/a0000000-0000-0000-0000-0000000000f1.jpg', '00000000-0000-0000-0000-0000000000b1')$q$);
select rlstest.err('carrier cannot upload a BOL file', $q$insert into storage.objects (bucket_id, name, owner) values ('documents', '30000000-0000-0000-0000-000000000002/bol/a0000000-0000-0000-0000-0000000000f2.pdf', '00000000-0000-0000-0000-0000000000b1')$q$, 'row-level security');
select rlstest.err('delivered without a delivery photo is refused even with a POD on file (0018)', $q$select public.set_load_status('30000000-0000-0000-0000-000000000002', 'delivered')$q$, 'Take a delivery photo first');
select rlstest.ok('control: carrier adds the delivery photo at_delivery (0018)', rlstest.pdins('30000000-0000-0000-0000-000000000002', 'delivery_photo', '30000000-0000-0000-0000-000000000002/delivery_photo/a0000000-0000-0000-0000-0000000000f6.jpg'));
select rlstest.ok('control: delivered with POD',$q$select public.set_load_status('30000000-0000-0000-0000-000000000002', 'delivered')$q$);
select rlstest.err('delivered load is final for carrier', $q$select public.set_load_status('30000000-0000-0000-0000-000000000002', 'at_delivery')$q$, 'one step|final');
select rlstest.back();

-- driver of carrier A: same powers on own carrier, none on B ---------------
select rlstest.as_user('00000000-0000-0000-0000-0000000000b2');
select rlstest.cnt('control: driver sees delivered load', $q$select 1 from public.loads where status = 'delivered'$q$, 1);
select rlstest.cnt('driver cannot see carrier B load', $q$select 1 from public.loads where id = '30000000-0000-0000-0000-000000000003'$q$, 0,
  $q$select 1 from public.loads where id = '30000000-0000-0000-0000-000000000003'$q$);
select rlstest.cnt('driver cannot read profiles of teammates', 'select 1 from public.profiles', 1);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.cnt('control: owner reads team profiles', 'select 1 from public.profiles', 2);
select rlstest.back();

-- 5. customer INSERT ... RETURNING only for own customer_id ---------------
create function rlstest.ins_load(p_uid uuid, p_customer uuid) returns text language plpgsql as $f$
declare v uuid; cb uuid;
begin
  insert into public.loads (customer_id, created_by, pickup_location_id, delivery_location_id,
    equipment_size, pickup_timing, pickup_date, pickup_time_start, delivery_timing, delivery_date,
    delivery_time_start, pickup_contact_name, pickup_contact_phone, delivery_contact_name, delivery_contact_phone)
  values (p_customer, p_uid,
    (select id from public.locations where name = 'Mitrex'), (select id from public.locations where name = 'Howden'),
    26, 'appointment', current_date + 2, '08:00', 'appointment', current_date + 2, '14:00',
    'A', '1', 'B', '2')
  returning id, created_by into v, cb;
  return cb::text;
end $f$;
grant execute on function rlstest.ins_load(uuid, uuid) to authenticated;

select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.ok('control: Maria INSERT RETURNING own customer_id',
  $q$select rlstest.ins_load('00000000-0000-0000-0000-0000000000c1', (select id from public.customers where name = 'Mitrex'))$q$);
select rlstest.err('Maria INSERT with another customer_id rejected',
  $q$select rlstest.ins_load('00000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-000000000002')$q$, 'row-level security');
do $t$
declare v text;
begin
  v := rlstest.ins_load('00000000-0000-0000-0000-0000000000c2', (select id from public.customers where name = 'Mitrex'));
  perform rlstest.rec('forged created_by is overwritten with the caller',
    case when v = '00000000-0000-0000-0000-0000000000c1' then 'OK' else 'FAIL' end, v);
end $t$;
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000c2');
select rlstest.ok('control: Other customer INSERT RETURNING own customer_id',
  $q$select rlstest.ins_load('00000000-0000-0000-0000-0000000000c2', '10000000-0000-0000-0000-000000000002')$q$);
select rlstest.cnt('Other customer cannot see Mitrex loads', $q$select 1 from public.loads where customer_id <> '10000000-0000-0000-0000-000000000002'$q$, 0,
  $q$select 1 from public.loads where customer_id <> '10000000-0000-0000-0000-000000000002'$q$);
select rlstest.back();

-- 6. locations and requests ------------------------------------------------
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.rows('control: customer edits default contact', $q$update public.locations set default_contact_name = 'Zed' where name = 'Howden'$q$, 1);
-- 0021 (DLV-041): the address is now the customer's to edit and she may create locations; section 21 has the full set.
select rlstest.err('customer cannot deactivate a location', $q$update public.locations set is_active = false where name = 'Howden'$q$, 'customer can change only');
select rlstest.err('customer cannot create a location that neither ships nor receives', $q$insert into public.locations (name, address_line, city, province) values ('N','a','b','ON')$q$, 'ship, receive or both');
select rlstest.ok('control: customer files a location request', $q$insert into public.location_requests (kind, payload, requested_by) values ('new', '{"name":"New Site","address_line":"1 A St","city":"Toronto"}', '00000000-0000-0000-0000-0000000000c1')$q$);
select rlstest.err('customer cannot approve a request', $q$select public.approve_location_request((select id from public.location_requests limit 1))$q$, 'staff only');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.ok('control: staff approves a request', $q$select public.approve_location_request((select id from public.location_requests limit 1))$q$);
select rlstest.cnt('approved request created the location', $q$select 1 from public.locations where name = 'New Site'$q$, 1);
select rlstest.back();

-- 7. Moffett lock and location rules ----------------------------------------
create function rlstest.moffett_forced() returns text language plpgsql as $f$
declare v boolean;
begin
  insert into public.loads (customer_id, created_by, pickup_location_id, delivery_location_id,
    equipment_size, moffett, pickup_timing, pickup_date, pickup_time_start, delivery_timing, delivery_date,
    delivery_time_start, pickup_contact_name, pickup_contact_phone, delivery_contact_name, delivery_contact_phone)
  values ((select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c1',
    (select id from public.locations where name = 'Mitrex'), (select id from public.locations where name = 'SAMIH'),
    53, false, 'appointment', current_date + 3, '08:00', 'appointment', current_date + 3, '14:00', 'A', '1', 'B', '2')
  returning moffett into v;
  return v::text;
end $f$;
grant execute on function rlstest.moffett_forced() to authenticated;
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
do $t$
declare v text;
begin
  v := rlstest.moffett_forced();
  perform rlstest.rec('SAMIH forces moffett on', case when v = 'true' then 'OK' else 'FAIL' end, v);
end $t$;
select rlstest.err('cannot ship from a receive-only location', $q$insert into public.loads (customer_id, created_by, pickup_location_id, delivery_location_id, equipment_size, pickup_timing, pickup_date, pickup_time_start, delivery_timing, delivery_date, delivery_time_start, pickup_contact_name, pickup_contact_phone, delivery_contact_name, delivery_contact_phone) values ((select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c1', (select id from public.locations where name = 'Spadina'), (select id from public.locations where name = 'Howden'), 26, 'appointment', current_date, '08:00', 'appointment', current_date, '09:00', 'A','1','B','2')$q$, 'cannot ship');
select rlstest.err('pickup and delivery must differ', $q$insert into public.loads (customer_id, created_by, pickup_location_id, delivery_location_id, equipment_size, pickup_timing, pickup_date, pickup_time_start, delivery_timing, delivery_date, delivery_time_start, pickup_contact_name, pickup_contact_phone, delivery_contact_name, delivery_contact_phone) values ((select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c1', (select id from public.locations where name = 'Mitrex'), (select id from public.locations where name = 'Mitrex'), 26, 'appointment', current_date, '08:00', 'appointment', current_date, '09:00', 'A','1','B','2')$q$, 'differ');
select rlstest.err('delivery cannot be before pickup', $q$insert into public.loads (customer_id, created_by, pickup_location_id, delivery_location_id, equipment_size, pickup_timing, pickup_date, pickup_time_start, delivery_timing, delivery_date, delivery_time_start, pickup_contact_name, pickup_contact_phone, delivery_contact_name, delivery_contact_phone) values ((select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c1', (select id from public.locations where name = 'Mitrex'), (select id from public.locations where name = 'Howden'), 26, 'appointment', current_date + 2, '08:00', 'appointment', current_date, '09:00', 'A','1','B','2')$q$, 'not_before_pickup');
select rlstest.back();

-- 8. audit log is append-only for everyone ------------------------------------
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.err('admin cannot write load_events directly', $q$insert into public.load_events (load_id, to_status) values ('30000000-0000-0000-0000-000000000001', 'booked')$q$, 'permission denied');
select rlstest.err('admin cannot delete load_events', $q$delete from public.load_events$q$, 'permission denied');
select rlstest.cnt('control: events exist for delivered load', $q$select 1 from public.load_events where load_id = '30000000-0000-0000-0000-000000000002' and to_status = 'delivered'$q$, 1);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
-- 8 since 0010: the fixture's direct requested -> booked UPDATE (mkload) now writes its own event.
select rlstest.cnt('control: Maria reads timeline of own load', $q$select 1 from public.load_events where load_id = '30000000-0000-0000-0000-000000000002'$q$, 8);
select rlstest.back();

-- 9. Deactivation: an inactive profile is denied everywhere ---------------
create function rlstest.loads_seen(p_uid uuid) returns bigint language plpgsql as $f$
declare n bigint;
begin
  perform rlstest.as_user(p_uid);
  select count(*) into n from public.loads;
  perform rlstest.back();
  return n;
end $f$;
create function rlstest.set_active(p_uid uuid, p_active boolean) returns void language sql security definer as $f$
  update public.profiles set is_active = p_active where id = p_uid $f$;
grant execute on all functions in schema rlstest to authenticated, anon;
-- Fresh loads so earlier sections cannot have moved them: L5 requested, L6 booked (carrier A).
select rlstest.mkload('30000000-0000-0000-0000-000000000005', 'requested', null);
select rlstest.mkload('30000000-0000-0000-0000-000000000006', 'booked', '20000000-0000-0000-0000-00000000000a');

do $t$
declare
  v_cust uuid := '00000000-0000-0000-0000-0000000000c1';
  v_own  uuid := '00000000-0000-0000-0000-0000000000b1';
  v_csr  uuid := '00000000-0000-0000-0000-0000000000a2';
  v_adm  uuid := '00000000-0000-0000-0000-0000000000a1';
  v_all bigint; v_before bigint; v_after bigint;
begin
  v_all := rlstest.su_count('select 1 from public.loads');
  perform rlstest.rec('guard: loads exist for deactivation tests', case when v_all > 0 then 'OK' else 'VACUOUS' end);
  perform rlstest.rec('profiles default is_active true',
    case when not exists (select 1 from public.profiles where not is_active) then 'OK' else 'FAIL' end);

  -- customer
  v_before := rlstest.loads_seen(v_cust);
  perform rlstest.rec('control: active customer sees loads', case when v_before > 0 then 'OK' else 'FAIL' end, 'seen=' || v_before);
  perform rlstest.set_active(v_cust, false);
  v_after := rlstest.loads_seen(v_cust);
  perform rlstest.rec('inactive customer sees zero loads',
    case when v_before > 0 and v_after = 0 then 'OK' else 'FAIL' end, 'before=' || v_before || ' after=' || v_after);
  perform rlstest.as_user(v_cust);
  perform rlstest.err('inactive customer cannot call set_load_status',
    $q$select public.set_load_status('30000000-0000-0000-0000-000000000005', 'cancelled')$q$, 'not authorized');
  perform rlstest.cnt('inactive customer cannot read profiles', 'select 1 from public.profiles', 0, 'select 1 from public.profiles');
  perform rlstest.cnt('inactive customer cannot read customers', 'select 1 from public.customers', 0, 'select 1 from public.customers');
  perform rlstest.back();
  perform rlstest.set_active(v_cust, true);
  perform rlstest.as_user(v_cust);
  perform rlstest.ok('control: reactivated customer can call set_load_status',
    $q$select public.set_load_status('30000000-0000-0000-0000-000000000005', 'cancelled')$q$);
  perform rlstest.back();
  perform rlstest.rec('control: reactivated customer sees loads again',
    case when rlstest.loads_seen(v_cust) = v_before then 'OK' else 'FAIL' end);

  -- carrier owner
  v_before := rlstest.loads_seen(v_own);
  perform rlstest.rec('control: active carrier owner sees loads', case when v_before > 0 then 'OK' else 'FAIL' end, 'seen=' || v_before);
  perform rlstest.set_active(v_own, false);
  v_after := rlstest.loads_seen(v_own);
  perform rlstest.rec('inactive carrier owner sees zero loads',
    case when v_before > 0 and v_after = 0 then 'OK' else 'FAIL' end, 'before=' || v_before || ' after=' || v_after);
  perform rlstest.as_user(v_own);
  perform rlstest.err('inactive carrier owner cannot advance a load',
    $q$select public.set_load_status('30000000-0000-0000-0000-000000000006', 'at_pickup')$q$, 'not authorized');
  perform rlstest.cnt('inactive carrier owner cannot read team profiles', 'select 1 from public.profiles', 0, 'select 1 from public.profiles');
  perform rlstest.back();
  perform rlstest.set_active(v_own, true);
  perform rlstest.as_user(v_own);
  perform rlstest.ok('control: reactivated carrier owner advances own load',
    $q$select public.set_load_status('30000000-0000-0000-0000-000000000006', 'at_pickup')$q$);
  perform rlstest.back();

  -- staff
  v_before := rlstest.loads_seen(v_csr);
  perform rlstest.rec('control: active staff reads all loads', case when v_before = v_all and v_all > 0 then 'OK' else 'FAIL' end, 'seen=' || v_before || ' all=' || v_all);
  perform rlstest.set_active(v_csr, false);
  v_after := rlstest.loads_seen(v_csr);
  perform rlstest.rec('inactive staff cannot read all loads',
    case when v_all > 0 and v_after = 0 then 'OK' else 'FAIL' end, 'after=' || v_after);
  perform rlstest.as_user(v_csr);
  perform rlstest.err('inactive staff cannot set load status',
    $q$select public.set_load_status('30000000-0000-0000-0000-000000000003', 'cancelled')$q$, 'not authorized');
  perform rlstest.err('inactive staff cannot approve location requests',
    $q$select public.approve_location_request(gen_random_uuid())$q$, 'staff only');
  perform rlstest.cnt('inactive staff cannot read profiles', 'select 1 from public.profiles', 0, 'select 1 from public.profiles');
  perform rlstest.back();
  perform rlstest.set_active(v_csr, true);
  perform rlstest.rec('control: reactivated staff reads all loads again',
    case when rlstest.loads_seen(v_csr) = v_all then 'OK' else 'FAIL' end);

  -- admin helpers and storage helper
  perform rlstest.set_active(v_adm, false);
  perform rlstest.as_user(v_adm);
  perform rlstest.rec('inactive admin: dlv_is_admin false, dlv_role null, no doc access',
    case when not public.dlv_is_admin() and public.dlv_role() is null
          and not public.dlv_can_access_doc('30000000-0000-0000-0000-000000000006/pod/a0000000-0000-0000-0000-0000000000f3.pdf', false) then 'OK' else 'FAIL' end);
  perform rlstest.back();
  perform rlstest.set_active(v_adm, true);
  perform rlstest.as_user(v_adm);
  perform rlstest.rec('control: active admin: dlv_is_admin true, doc access allowed',
    case when public.dlv_is_admin() and public.dlv_role() = 'staff_admin'
          and public.dlv_can_access_doc('30000000-0000-0000-0000-000000000006/pod/a0000000-0000-0000-0000-0000000000f3.pdf', false) then 'OK' else 'FAIL' end);
  perform rlstest.back();

  -- authenticated cannot write profiles
  perform rlstest.as_user(v_adm);
  perform rlstest.err('authenticated cannot update profiles.is_active',
    $q$update public.profiles set is_active = false where id = '00000000-0000-0000-0000-0000000000c1'$q$, 'permission denied');
  perform rlstest.back();
end $t$;

-- 10. Documents bucket and load_documents ------------------------------------
\set L10 '30000000-0000-0000-0000-000000000010'
\set L11 '30000000-0000-0000-0000-000000000011'
\set L12 '30000000-0000-0000-0000-000000000012'
\set L13 '30000000-0000-0000-0000-000000000013'
\set L14 '30000000-0000-0000-0000-000000000014'
\set L15 '30000000-0000-0000-0000-000000000015'

create function rlstest.mkload2(p_id uuid, p_cust uuid, p_user uuid, p_status public.load_status, p_carrier uuid) returns void
language plpgsql security definer as $f$
begin
  insert into public.loads (id, customer_id, created_by, pickup_location_id, delivery_location_id,
    equipment_size, pickup_timing, pickup_date, pickup_time_start, delivery_timing, delivery_date,
    delivery_time_start, pickup_contact_name, pickup_contact_phone, delivery_contact_name, delivery_contact_phone)
  values (p_id, p_cust, p_user,
    (select id from public.locations where name = 'Mitrex'),
    (select id from public.locations where name = 'Howden'),
    53, 'appointment', current_date + 1, '08:00', 'appointment', current_date + 1, '14:00',
    'P Contact', '416-000-0001', 'D Contact', '416-000-0002');
  perform set_config('dlv.status_fn', '1', true);
  update public.loads set status = p_status, carrier_id = p_carrier where id = p_id;
  perform set_config('dlv.status_fn', '0', true);
end $f$;

-- L10 enroute carrier A (Maria's), L11 enroute carrier B (Maria's), L12 booked A, L13 loading A,
-- L14 at_delivery A, L15 enroute carrier B owned by the OTHER customer.
select rlstest.mkload(:'L10', 'enroute', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload(:'L11', 'enroute', '20000000-0000-0000-0000-00000000000b');
select rlstest.mkload(:'L12', 'booked', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload(:'L13', 'loading', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload(:'L14', 'at_delivery', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload2(:'L15', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000c2', 'enroute', '20000000-0000-0000-0000-00000000000b');

-- existing documents (superuser fixtures): a BOL and a POD on L10, L11 and L15
insert into storage.objects (bucket_id, name) values
  ('documents', :'L10' || '/bol/b0000000-0000-0000-0000-000000000010.pdf'),
  ('documents', :'L10' || '/pod/b0000000-0000-0000-0000-000000000110.jpg'),
  ('documents', :'L11' || '/bol/b0000000-0000-0000-0000-000000000011.pdf'),
  ('documents', :'L11' || '/pod/b0000000-0000-0000-0000-000000000111.jpg'),
  ('documents', :'L15' || '/bol/b0000000-0000-0000-0000-000000000015.pdf'),
  ('documents', :'L15' || '/pod/b0000000-0000-0000-0000-000000000115.jpg');
insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values
  (:'L10', 'bol', :'L10' || '/bol/b0000000-0000-0000-0000-000000000010.pdf', '00000000-0000-0000-0000-0000000000a1'),
  (:'L10', 'pod', :'L10' || '/pod/b0000000-0000-0000-0000-000000000110.jpg', '00000000-0000-0000-0000-0000000000a1'),
  (:'L11', 'bol', :'L11' || '/bol/b0000000-0000-0000-0000-000000000011.pdf', '00000000-0000-0000-0000-0000000000a1'),
  (:'L11', 'pod', :'L11' || '/pod/b0000000-0000-0000-0000-000000000111.jpg', '00000000-0000-0000-0000-0000000000a1'),
  (:'L15', 'bol', :'L15' || '/bol/b0000000-0000-0000-0000-000000000015.pdf', '00000000-0000-0000-0000-0000000000a1'),
  (:'L15', 'pod', :'L15' || '/pod/b0000000-0000-0000-0000-000000000115.jpg', '00000000-0000-0000-0000-0000000000a1');

create function rlstest.sins(p_path text) returns text language sql immutable as $f$
  select format($q$insert into storage.objects (bucket_id, name) values ('documents', %L)$q$, p_path) $f$;
create function rlstest.dins(p_load text, p_kind text, p_path text) returns text language sql immutable as $f$
  select format($q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values (%L::uuid, %L, %L, auth.uid())$q$, p_load, p_kind, p_path) $f$;

-- 10a. reads: both tables, BOL and POD
create function rlstest.read_pair(p_name text, p_load text, p_expected int) returns void language plpgsql as $f$
declare k text;
begin
  foreach k in array array['bol','pod'] loop
    perform rlstest.cnt(p_name || ' (' || k || ', storage.objects)',
      format($q$select 1 from storage.objects where bucket_id = 'documents' and name like %L$q$, p_load || '/' || k || '/%'), p_expected,
      format($q$select 1 from storage.objects where bucket_id = 'documents' and name like %L$q$, p_load || '/' || k || '/%'));
    perform rlstest.cnt(p_name || ' (' || k || ', load_documents)',
      format($q$select 1 from public.load_documents where load_id = %L::uuid and kind = %L$q$, p_load, k), p_expected,
      format($q$select 1 from public.load_documents where load_id = %L::uuid and kind = %L$q$, p_load, k));
  end loop;
end $f$;

grant execute on all functions in schema rlstest to authenticated, anon;

select rlstest.as_user('00000000-0000-0000-0000-0000000000b3');
select rlstest.read_pair('control: carrier B reads own load documents', :'L11', 1);
select rlstest.read_pair('carrier B cannot read carrier A documents', :'L10', 0);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.read_pair('control: carrier A reads own load documents', :'L10', 1);
select rlstest.read_pair('carrier A cannot read carrier B documents', :'L11', 0);
select rlstest.read_pair('carrier A cannot read documents of an unrelated load', :'L15', 0);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b2');
select rlstest.read_pair('control: driver A reads own load documents', :'L10', 1);
select rlstest.read_pair('driver A cannot read carrier B documents', :'L11', 0);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.read_pair('control: customer reads own load documents', :'L10', 1);
select rlstest.read_pair('customer cannot read another customer documents', :'L15', 0);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000c2');
select rlstest.read_pair('control: other customer reads own load documents', :'L15', 1);
select rlstest.read_pair('other customer cannot read first customer documents', :'L10', 0);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.read_pair('control: staff reads any load documents', :'L15', 1);
select rlstest.back();

-- 10b. uploads, valid paths (a unique file uuid per attempt)
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.err('customer cannot upload a BOL (storage)', rlstest.sins(:'L10' || '/bol/c0000000-0000-0000-0000-000000000001.pdf'), 'row-level security');
select rlstest.err('customer cannot upload a BOL (load_documents)', rlstest.dins(:'L10', 'bol', :'L10' || '/bol/c0000000-0000-0000-0000-000000000002.pdf'), 'row-level security');
select rlstest.err('customer cannot upload a POD (storage)', rlstest.sins(:'L10' || '/pod/c0000000-0000-0000-0000-000000000003.jpg'), 'row-level security');
select rlstest.err('customer cannot upload a POD (load_documents)', rlstest.dins(:'L10', 'pod', :'L10' || '/pod/c0000000-0000-0000-0000-000000000004.jpg'), 'row-level security');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.err('carrier cannot upload a BOL to own load (storage)', rlstest.sins(:'L10' || '/bol/c0000000-0000-0000-0000-000000000005.pdf'), 'row-level security');
select rlstest.err('carrier cannot upload a BOL to own load (load_documents)', rlstest.dins(:'L10', 'bol', :'L10' || '/bol/c0000000-0000-0000-0000-000000000006.pdf'), 'row-level security');
select rlstest.err('carrier A cannot upload POD to carrier B load (storage)', rlstest.sins(:'L11' || '/pod/c0000000-0000-0000-0000-000000000007.jpg'), 'row-level security');
select rlstest.err('carrier A cannot upload POD to carrier B load (load_documents)', rlstest.dins(:'L11', 'pod', :'L11' || '/pod/c0000000-0000-0000-0000-000000000008.jpg'), 'row-level security');
select rlstest.err('carrier cannot upload POD while booked (storage)', rlstest.sins(:'L12' || '/pod/c0000000-0000-0000-0000-000000000009.jpg'), 'row-level security');
select rlstest.err('carrier cannot upload POD while booked (load_documents)', rlstest.dins(:'L12', 'pod', :'L12' || '/pod/c0000000-0000-0000-0000-00000000000a.jpg'), 'row-level security');
select rlstest.err('carrier cannot upload POD while loading (storage)', rlstest.sins(:'L13' || '/pod/c0000000-0000-0000-0000-00000000000b.jpg'), 'row-level security');
select rlstest.err('carrier cannot upload POD while loading (load_documents)', rlstest.dins(:'L13', 'pod', :'L13' || '/pod/c0000000-0000-0000-0000-00000000000c.jpg'), 'row-level security');
select rlstest.ok('control: carrier uploads POD while enroute (storage)', rlstest.sins(:'L10' || '/pod/c0000000-0000-0000-0000-00000000000d.jpg'));
select rlstest.ok('control: carrier uploads POD while enroute (load_documents)', rlstest.dins(:'L10', 'pod', :'L10' || '/pod/c0000000-0000-0000-0000-00000000000e.jpg'));
select rlstest.ok('control: carrier uploads POD at_delivery (storage)', rlstest.sins(:'L14' || '/pod/c0000000-0000-0000-0000-00000000000f.jpg'));
select rlstest.ok('control: carrier uploads POD at_delivery (load_documents)', rlstest.dins(:'L14', 'pod', :'L14' || '/pod/c0000000-0000-0000-0000-000000000010.jpg'));
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.ok('control: staff uploads a BOL (storage)', rlstest.sins(:'L12' || '/bol/c0000000-0000-0000-0000-000000000011.pdf'));
select rlstest.ok('control: staff uploads a BOL (load_documents)', rlstest.dins(:'L12', 'bol', :'L12' || '/bol/c0000000-0000-0000-0000-000000000012.pdf'));
select rlstest.ok('control: staff uploads a POD (storage)', rlstest.sins(:'L12' || '/pod/c0000000-0000-0000-0000-000000000013.jpg'));
select rlstest.ok('control: staff uploads a POD (load_documents)', rlstest.dins(:'L12', 'pod', :'L12' || '/pod/c0000000-0000-0000-0000-000000000014.jpg'));
select rlstest.ok('control: staff uploads a png name', rlstest.sins(:'L12' || '/bol/c0000000-0000-0000-0000-000000000015.png'));
select rlstest.ok('control: staff uploads a jpeg name', rlstest.sins(:'L12' || '/bol/c0000000-0000-0000-0000-000000000016.jpeg'));
select rlstest.ok('control: staff uploads a webp name', rlstest.sins(:'L12' || '/bol/c0000000-0000-0000-0000-000000000017.webp'));
select rlstest.ok('control: staff uploads a heic name', rlstest.sins(:'L12' || '/bol/c0000000-0000-0000-0000-000000000018.heic'));
select rlstest.back();

-- 10c. path traversal and malformed paths, on both tables, for staff and for a carrier.
create table rlstest.bad (label text, path text, load text, kind text, storage_bad boolean);
insert into rlstest.bad values
  ('dotdot to another load',      :'L10' || '/pod/../' || :'L11' || '/bol/d0000000-0000-0000-0000-000000000001.pdf', :'L10', 'pod', true),
  ('dotdot to root',              :'L10' || '/pod/../../x', :'L10', 'pod', true),
  ('empty segment',               :'L10' || '/pod//x', :'L10', 'pod', true),
  ('empty segment before file',   :'L10' || '/pod//d0000000-0000-0000-0000-000000000002.jpg', :'L10', 'pod', true),
  ('leading slash',               '/' || :'L10' || '/pod/d0000000-0000-0000-0000-000000000003.jpg', :'L10', 'pod', true),
  ('backslashes',                 :'L10' || E'\\pod\\d0000000-0000-0000-0000-000000000004.jpg', :'L10', 'pod', true),
  ('backslash separator inside',  :'L10' || E'/pod\\..\\d0000000-0000-0000-0000-000000000005.jpg', :'L10', 'pod', true),
  ('encoded dotdot',              :'L10' || '/pod/%2e%2e/d0000000-0000-0000-0000-000000000006.jpg', :'L10', 'pod', true),
  ('encoded dotdot as file',      :'L10' || '/pod/%2e%2e', :'L10', 'pod', true),
  ('trailing space',              :'L10' || '/pod/d0000000-0000-0000-0000-000000000007.jpg ', :'L10', 'pod', true),
  ('trailing newline',            :'L10' || E'/pod/d0000000-0000-0000-0000-000000000008.jpg\n', :'L10', 'pod', true),
  ('upper-case kind',             :'L10' || '/POD/d0000000-0000-0000-0000-000000000009.jpg', :'L10', 'pod', true),
  ('extra segment',               :'L10' || '/pod/extra/d0000000-0000-0000-0000-00000000000a.jpg', :'L10', 'pod', true),
  ('non-uuid file name',          :'L10' || '/pod/x.jpg', :'L10', 'pod', true),
  ('upper-case file uuid',        :'L10' || '/pod/D0000000-0000-0000-0000-00000000000B.jpg', :'L10', 'pod', true),
  ('upper-case extension',        :'L10' || '/pod/d0000000-0000-0000-0000-00000000000c.JPG', :'L10', 'pod', true),
  ('no extension',                :'L10' || '/pod/d0000000-0000-0000-0000-00000000000d', :'L10', 'pod', true),
  ('extension too long',          :'L10' || '/pod/d0000000-0000-0000-0000-00000000000e.jpegxx', :'L10', 'pod', true),
  ('one char extension',          :'L10' || '/pod/d0000000-0000-0000-0000-00000000000f.j', :'L10', 'pod', true),
  ('double extension',            :'L10' || '/pod/d0000000-0000-0000-0000-000000000010.jpg.exe', :'L10', 'pod', true),
  ('unknown kind',                :'L10' || '/doc/d0000000-0000-0000-0000-000000000012.jpg', :'L10', 'pod', true),
  ('only a load folder',          :'L10' || '/', :'L10', 'pod', true),
  ('first segment is another load', :'L11' || '/pod/d0000000-0000-0000-0000-000000000013.jpg', :'L10', 'pod', false),
  ('kind column differs from path', :'L10' || '/pod/d0000000-0000-0000-0000-000000000014.jpg', :'L10', 'bol', false);
grant select on rlstest.bad to authenticated;

-- subjects: malformed objects as they could land through a hole, plus a valid control, as superuser
insert into storage.objects (bucket_id, name)
  select 'documents', path from rlstest.bad where storage_bad;
insert into storage.objects (bucket_id, name) values ('documents', :'L10' || '/pod/d0000000-0000-0000-0000-0000000000ff.jpg');

do $t$
declare
  b jsonb;
  r jsonb;
  v_actor text;
  v_uid uuid;
begin
  select jsonb_agg(to_jsonb(x)) into b from rlstest.bad x;
  foreach v_actor in array array['staff', 'carrier'] loop
    v_uid := case v_actor when 'staff' then '00000000-0000-0000-0000-0000000000a1' else '00000000-0000-0000-0000-0000000000b1' end;
    perform rlstest.as_user(v_uid);
    perform rlstest.ok('control: ' || v_actor || ' uploads a well-formed POD path (storage)',
      rlstest.sins('30000000-0000-0000-0000-000000000010/pod/e0000000-0000-0000-0000-0000000000a' || case v_actor when 'staff' then '1' else '2' end || '.webp'));
    perform rlstest.ok('control: ' || v_actor || ' uploads a well-formed POD path (load_documents)',
      rlstest.dins('30000000-0000-0000-0000-000000000010', 'pod', '30000000-0000-0000-0000-000000000010/pod/e0000000-0000-0000-0000-0000000000b' || case v_actor when 'staff' then '1' else '2' end || '.webp'));
    for r in select * from jsonb_array_elements(b) loop
      if (r->>'storage_bad')::boolean then
        perform rlstest.err(v_actor || ' storage insert rejects: ' || (r->>'label'), rlstest.sins(r->>'path'), 'row-level security');
      end if;
      perform rlstest.err(v_actor || ' load_documents insert rejects: ' || (r->>'label'),
        rlstest.dins(r->>'load', r->>'kind', r->>'path'), 'row-level security|check constraint|violates');
    end loop;
    perform rlstest.back();
  end loop;

  -- reads: malformed objects that exist are invisible even to staff, the valid one is visible
  perform rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
  perform rlstest.cnt('control: staff reads the well-formed object', $q$select 1 from storage.objects where name = '30000000-0000-0000-0000-000000000010/pod/d0000000-0000-0000-0000-0000000000ff.jpg'$q$, 1);
  perform rlstest.cnt('staff cannot read malformed object names',
    $q$select 1 from storage.objects where bucket_id = 'documents' and (name like '%/../%' or name like '%\%' or name like '%//%' or name like '/%' or name like '%/POD/%' or name like '%/extra/%' or name like '%x.jpg' or name like '%.exe' or name like '%.JPG' or name like '%\n')$q$, 0,
    $q$select 1 from storage.objects where bucket_id = 'documents' and (name like '%/../%' or name like '%\%' or name like '%//%' or name like '/%' or name like '%/POD/%' or name like '%/extra/%' or name like '%x.jpg' or name like '%.exe' or name like '%.JPG' or name like '%\n')$q$);
  perform rlstest.back();
end $t$;

-- 10d. dlv_can_access_doc directly, as admin, on every malformed shape (read and write)
do $t$
declare r record; v_bad int := 0; v_n int := 0;
begin
  perform rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
  perform rlstest.rec('control: dlv_can_access_doc accepts a well-formed path',
    case when public.dlv_can_access_doc('30000000-0000-0000-0000-000000000010/pod/d0000000-0000-0000-0000-0000000000ff.jpg', true) then 'OK' else 'FAIL' end);
  for r in select path from rlstest.bad where storage_bad loop
    v_n := v_n + 1;
    if public.dlv_can_access_doc(r.path, false) or public.dlv_can_access_doc(r.path, true) then v_bad := v_bad + 1; end if;
  end loop;
  perform rlstest.back();
  perform rlstest.rec('dlv_can_access_doc rejects every malformed path (read and write)',
    case when v_n = 0 then 'VACUOUS' when v_bad = 0 then 'OK' else 'FAIL' end, 'accepted ' || v_bad || ' of ' || v_n);
end $t$;

-- 10e. bucket configuration and anon
do $t$
declare bk record; n int;
begin
  select * into bk from storage.buckets where id = 'documents';
  perform rlstest.rec('bucket documents exists', case when found then 'OK' else 'FAIL' end);
  perform rlstest.rec('bucket documents is private', case when bk.public is false then 'OK' else 'FAIL' end);
  perform rlstest.rec('bucket documents has a 15 MB file size limit', case when bk.file_size_limit = 15728640 then 'OK' else 'FAIL' end, 'limit=' || coalesce(bk.file_size_limit::text, 'null'));
  perform rlstest.rec('bucket documents allows only pdf, png, jpeg, webp, heic',
    case when bk.allowed_mime_types is not null
          and bk.allowed_mime_types @> array['application/pdf','image/png','image/jpeg','image/webp','image/heic']
          and bk.allowed_mime_types <@ array['application/pdf','image/png','image/jpeg','image/webp','image/heic','image/heif']
         then 'OK' else 'FAIL' end, 'types=' || coalesce(bk.allowed_mime_types::text, 'null'));
  perform rlstest.rec('RLS is enabled on storage.objects',
    case when (select relrowsecurity from pg_class where oid = 'storage.objects'::regclass) then 'OK' else 'FAIL' end);
  select count(*) into n from pg_policies p where p.schemaname = 'storage' and p.tablename = 'objects'
    and (p.roles && array['anon'::name, 'public'::name]) and (coalesce(p.qual, '') || coalesce(p.with_check, '')) ~ 'documents';
  perform rlstest.rec('no storage.objects policy for anon or public touches the documents bucket', case when n = 0 then 'OK' else 'FAIL' end, 'policies=' || n);
  select count(*) into n from pg_policies p where p.schemaname = 'storage' and p.tablename = 'objects'
    and 'authenticated'::name = any (p.roles) and p.cmd in ('SELECT', 'INSERT') and p.policyname in ('documents_select', 'documents_insert');
  perform rlstest.rec('control: authenticated has the documents select and insert policies', case when n = 2 then 'OK' else 'FAIL' end, 'policies=' || n);
  select count(*) into n from pg_policies p where p.schemaname = 'storage' and p.tablename = 'objects' and p.cmd in ('UPDATE', 'DELETE', 'ALL')
    and (coalesce(p.qual, '') || coalesce(p.with_check, '')) ~ 'documents';
  perform rlstest.rec('no UPDATE, DELETE or ALL policy on documents (objects are immutable for users)', case when n = 0 then 'OK' else 'FAIL' end, 'policies=' || n);
  perform rlstest.rec('anon has no EXECUTE on dlv_can_access_doc',
    case when has_function_privilege('anon', 'public.dlv_can_access_doc(text, boolean)', 'execute') then 'FAIL' else 'OK' end);
  perform rlstest.rec('control: authenticated has EXECUTE on dlv_can_access_doc',
    case when has_function_privilege('authenticated', 'public.dlv_can_access_doc(text, boolean)', 'execute') then 'OK' else 'FAIL' end);
  perform rlstest.rec('anon has no privilege on load_documents',
    case when has_table_privilege('anon', 'public.load_documents', 'insert') or has_table_privilege('anon', 'public.load_documents', 'select') then 'FAIL' else 'OK' end);
end $t$;
select rlstest.as_anon();
select rlstest.cnt('anon reads no document objects', $q$select 1 from storage.objects where bucket_id = 'documents'$q$, 0, $q$select 1 from storage.objects where bucket_id = 'documents'$q$);
select rlstest.err('anon cannot insert a document object', rlstest.sins('30000000-0000-0000-0000-000000000010/pod/f0000000-0000-0000-0000-000000000001.jpg'), 'row-level security|permission denied');
select rlstest.back();

-- 10f. the load_documents CHECK itself, as the table owner (RLS bypassed: service role, SQL editor, a future policy slip)
do $t$
declare b jsonb; r jsonb;
begin
  select jsonb_agg(to_jsonb(x)) into b from rlstest.bad x;
  perform rlstest.ok('control: owner inserts a well-formed load_documents row',
    format($q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values (%L::uuid, 'bol', %L, '00000000-0000-0000-0000-0000000000a1')$q$,
      '30000000-0000-0000-0000-000000000013', '30000000-0000-0000-0000-000000000013/bol/e0000000-0000-0000-0000-0000000000c1.pdf'));
  for r in select * from jsonb_array_elements(b) loop
    perform rlstest.err('CHECK rejects (owner, RLS bypassed): ' || (r->>'label'),
      format($q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values (%L::uuid, %L, %L, '00000000-0000-0000-0000-0000000000a1')$q$,
        r->>'load', r->>'kind', r->>'path'), 'load_documents_path_ck');
  end loop;
end $t$;

-- 11. C6 data integrity (migrations 0008 to 0010) ---------------------------------
grant usage on schema rlstest to service_role;
create function rlstest.as_service() returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  execute 'set local role service_role';
end $f$;
-- boolean assertion
create function rlstest.chk(p_name text, p_cond boolean, p_detail text default null) returns void language plpgsql as $f$
begin
  perform rlstest.rec(p_name, case when p_cond is true then 'OK' else 'FAIL' end, p_detail);
end $f$;
create function rlstest.evcount(p_load uuid) returns bigint language sql security definer as $f$
  select count(*) from public.load_events where load_id = p_load $f$;
-- direct insert at an arbitrary status (what the e2e helper does)
create function rlstest.mkload_direct(p_id uuid, p_status public.load_status, p_carrier uuid) returns void
language plpgsql security definer as $f$
begin
  insert into public.loads (id, customer_id, created_by, pickup_location_id, delivery_location_id,
    equipment_size, pickup_timing, pickup_date, pickup_time_start, delivery_timing, delivery_date,
    delivery_time_start, pickup_contact_name, pickup_contact_phone, delivery_contact_name, delivery_contact_phone,
    status, carrier_id)
  values (p_id, (select id from public.customers where name = 'Mitrex'),
    '00000000-0000-0000-0000-0000000000c1',
    (select id from public.locations where name = 'Mitrex'),
    (select id from public.locations where name = 'Howden'),
    53, 'appointment', current_date + 1, '08:00', 'appointment', current_date + 1, '14:00',
    'P Contact', '416-000-0001', 'D Contact', '416-000-0002', p_status, p_carrier);
end $f$;
grant execute on all functions in schema rlstest to authenticated, anon, service_role;

-- 11a. the last active staff_admin cannot be deactivated, demoted or deleted, by any writer ----------------
do $t$
declare
  a1 uuid := '00000000-0000-0000-0000-0000000000a1';
  a3 uuid := '00000000-0000-0000-0000-0000000000a3';
  n int;
begin
  select count(*) into n from public.profiles where role = 'staff_admin' and is_active;
  perform rlstest.rec('guard: two active staff admins before the last-admin tests', case when n = 2 then 'OK' else 'VACUOUS' end, 'active admins=' || n);

  select count(*) into n from pg_trigger where tgrelid = 'public.profiles'::regclass and not tgisinternal and tgenabled = 'O'
    and tgname in ('profiles_last_admin_guard_update', 'profiles_last_admin_guard_delete');
  perform rlstest.chk('last-admin triggers (update and delete) exist and are enabled', n = 2, 'found=' || n);

  -- two admins: every change is allowed (positive controls, table owner = no JWT)
  perform rlstest.ok('control: deactivating one of two admins is allowed', format('update public.profiles set is_active = false where id = %L', a3));
  perform rlstest.ok('control: reactivating an admin is allowed', format('update public.profiles set is_active = true where id = %L', a3));
  perform rlstest.ok('control: demoting one of two admins is allowed', format('update public.profiles set role = %L where id = %L', 'staff_csr', a3));
  perform rlstest.ok('control: promoting back to staff_admin is allowed', format('update public.profiles set role = %L where id = %L', 'staff_admin', a3));

  -- an inactive admin does not count: with a3 inactive, a1 is the last ACTIVE admin
  perform rlstest.ok('control: deactivate a3', format('update public.profiles set is_active = false where id = %L', a3));
  perform rlstest.err('table owner cannot deactivate the last active admin (an inactive admin does not count)',
    format('update public.profiles set is_active = false where id = %L', a1), 'active staff admin');
  perform rlstest.err('table owner cannot demote the last active admin',
    format('update public.profiles set role = %L where id = %L', 'staff_csr', a1), 'active staff admin');
  perform rlstest.err('table owner cannot delete the last active admin profile',
    format('delete from public.profiles where id = %L', a1), 'active staff admin');
  perform rlstest.err('deleting the auth user of the last active admin is refused (cascade)',
    format('delete from auth.users where id = %L', a1), 'active staff admin');
  perform rlstest.ok('control: other columns of the last admin stay editable',
    format('update public.profiles set full_name = %L where id = %L', 'Admin One', a1));
  perform rlstest.ok('control: deleting the profile of an INACTIVE admin is allowed (it is not the last active one)',
    format('delete from public.profiles where id = %L and not is_active', a3));
  perform rlstest.rec('guard: last-admin subject a1 still exists and is active',
    case when exists (select 1 from public.profiles where id = a1 and role = 'staff_admin' and is_active) then 'OK' else 'FAIL' end);
end $t$;
-- restore a3 (deleted above) for the next tests
insert into public.profiles (id, email, role) values ('00000000-0000-0000-0000-0000000000a3', 'admin2@t.test', 'staff_admin');

-- the service role is bound too
select rlstest.as_service();
select rlstest.ok('control: service role deactivates one of two admins', $q$update public.profiles set is_active = false where id = '00000000-0000-0000-0000-0000000000a3'$q$);
select rlstest.err('service role cannot deactivate the last active admin', $q$update public.profiles set is_active = false where id = '00000000-0000-0000-0000-0000000000a1'$q$, 'active staff admin');
select rlstest.err('service role cannot demote the last active admin', $q$update public.profiles set role = 'customer' where id = '00000000-0000-0000-0000-0000000000a1'$q$, 'active staff admin|violates');
select rlstest.err('service role cannot delete the last active admin', $q$delete from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'$q$, 'active staff admin');
select rlstest.ok('control: service role reactivates the second admin', $q$update public.profiles set is_active = true where id = '00000000-0000-0000-0000-0000000000a3'$q$);
select rlstest.back();

-- one statement that deactivates BOTH admins: the second row must see the first row's change
do $t$
declare n int;
begin
  select count(*) into n from public.profiles where role = 'staff_admin' and is_active;
  perform rlstest.rec('guard: two active admins before the multi-row test', case when n = 2 then 'OK' else 'VACUOUS' end, 'active admins=' || n);
  perform rlstest.err('one UPDATE deactivating every admin is refused', $q$update public.profiles set is_active = false where role = 'staff_admin'$q$, 'active staff admin');
  perform rlstest.err('one DELETE removing every admin is refused', $q$delete from public.profiles where role = 'staff_admin'$q$, 'active staff admin');
  select count(*) into n from public.profiles where role = 'staff_admin' and is_active;
  perform rlstest.chk('both admins are still active after the refused statements', n = 2, 'active admins=' || n);
end $t$;

-- the guard function is not callable by clients
do $t$
begin
  perform rlstest.chk('anon and authenticated have no EXECUTE on the last-admin guard function',
    not has_function_privilege('anon', 'public.dlv_profiles_last_admin_guard()', 'execute')
    and not has_function_privilege('authenticated', 'public.dlv_profiles_last_admin_guard()', 'execute'));
  perform rlstest.chk('control: service_role has EXECUTE on the last-admin guard function',
    has_function_privilege('service_role', 'public.dlv_profiles_last_admin_guard()', 'execute'));
end $t$;

-- 11b. the five hot columns each LEAD at least one valid index ---------------------------------------------
create function rlstest.leads_index(p_table regclass, p_col text) returns boolean language sql stable as $f$
  select exists (
    select 1 from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = p_table and i.indisvalid and a.attname = p_col) $f$;
select rlstest.chk('loads(status) leads an index', rlstest.leads_index('public.loads', 'status'));
select rlstest.chk('loads(pickup_date) leads an index', rlstest.leads_index('public.loads', 'pickup_date'));
select rlstest.chk('loads(carrier_id) leads an index', rlstest.leads_index('public.loads', 'carrier_id'));
select rlstest.chk('loads(customer_id) leads an index', rlstest.leads_index('public.loads', 'customer_id'));
select rlstest.chk('load_events(load_id) leads an index', rlstest.leads_index('public.load_events', 'load_id'));
-- negative controls: the probe is not vacuously true
select rlstest.chk('control: loads(notes) leads no index (the probe can say no)', not rlstest.leads_index('public.loads', 'notes'));
select rlstest.chk('control: a non leading column is not counted (loads.created_at)', not rlstest.leads_index('public.loads', 'created_at'));

-- 11c. updated_at moves forward on UPDATE for every mutable table ----------------------------------------
do $t$
declare
  r record;
  v_old constant timestamptz := '2000-01-01 00:00:00+00';
  v_new timestamptz;
  v_cnt bigint;
  v_has boolean;
begin
  for r in
    select * from (values
      ('locations',         'locations_touch_updated_at',         $q$update public.locations set notes = 'touch' where name = 'Howden'$q$,              $q$name = 'Howden'$q$),
      ('carriers',          'carriers_touch_updated_at',          $q$update public.carriers set name = name || ' x' where name = 'Carrier A'$q$,         $q$name like 'Carrier A%'$q$),
      ('customers',         'customers_touch_updated_at',         $q$update public.customers set name = name || ' x' where name = 'Other Customer'$q$,   $q$name like 'Other Customer%'$q$),
      ('profiles',          'profiles_touch_updated_at',          $q$update public.profiles set full_name = 'Touch' where email = 'csr@t.test'$q$,       $q$email = 'csr@t.test'$q$),
      ('location_requests', 'location_requests_touch_updated_at', $q$update public.location_requests set payload = payload || '{"z":1}'$q$,             $q$true$q$),
      ('loads',             'loads_before_update',                $q$update public.loads set notes = 'touch' where id = '30000000-0000-0000-0000-000000000002'$q$, $q$id = '30000000-0000-0000-0000-000000000002'$q$)
    ) v(tbl, trg, upd, filt)
  loop
    select exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = r.tbl
                   and c.column_name = 'updated_at' and c.is_nullable = 'NO' and c.data_type = 'timestamp with time zone') into v_has;
    perform rlstest.chk(r.tbl || ' has updated_at timestamptz not null', v_has);
    execute format('select count(*) from public.%I where %s', r.tbl, r.filt) into v_cnt;
    if v_cnt = 0 then perform rlstest.rec(r.tbl || ' updated_at moves forward on UPDATE', 'VACUOUS', 'subject has no rows'); continue; end if;
    -- age the rows as table owner with the touch trigger off, then UPDATE a normal column
    execute format('alter table public.%I disable trigger %I', r.tbl, r.trg);
    execute format('update public.%I set updated_at = %L where %s', r.tbl, v_old, r.filt);
    execute format('alter table public.%I enable trigger %I', r.tbl, r.trg);
    execute format('select min(updated_at) from public.%I where %s', r.tbl, r.filt) into v_new;
    perform rlstest.chk('guard: ' || r.tbl || ' row aged to 2000-01-01', v_new = v_old);
    execute r.upd;
    execute format('select min(updated_at) from public.%I where %s', r.tbl, r.filt) into v_new;
    perform rlstest.chk(r.tbl || ' updated_at moves forward on UPDATE', v_new > v_old and v_new <= clock_timestamp(), 'updated_at=' || v_new);
  end loop;
end $t$;
-- a customer's allowed edit (default contact) still passes the locations guard
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.rows('control: customer contact edit still allowed with updated_at present', $q$update public.locations set default_contact_phone = '416-111-2222' where name = 'Howden'$q$, 1);
select rlstest.err('customer still cannot change needs_review (updated_at is not a loophole)', $q$update public.locations set needs_review = true, updated_at = now() where name = 'Howden'$q$, 'customer can change only');
select rlstest.back();

-- 11d. one load_events row per status change, for every writer --------------------------------------------
\set L20 '30000000-0000-0000-0000-000000000020'
\set L21 '30000000-0000-0000-0000-000000000021'
\set L22 '30000000-0000-0000-0000-000000000022'
\set L23 '30000000-0000-0000-0000-000000000023'
\set L24 '30000000-0000-0000-0000-000000000024'
\set L25 '30000000-0000-0000-0000-000000000025'
\set L26 '30000000-0000-0000-0000-000000000026'
\set L27 '30000000-0000-0000-0000-000000000027'

-- the definitions moved: set_load_status no longer inserts, the trigger does; set_load_eta still does
do $t$
declare v_ls text; v_eta text; n int;
begin
  v_ls := pg_get_functiondef('public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure);
  v_eta := pg_get_functiondef('public.set_load_eta(uuid, timestamptz, text)'::regprocedure);
  perform rlstest.chk('set_load_status no longer inserts into load_events', v_ls !~* 'insert into public\.load_events');
  perform rlstest.chk('set_load_status hands the note to the trigger (dlv.event_note)', v_ls ~ 'dlv\.event_note');
  perform rlstest.chk('control: set_load_eta still writes its own event', v_eta ~* 'insert into public\.load_events');
  select count(*) into n from pg_trigger where tgrelid = 'public.loads'::regclass and not tgisinternal and tgenabled = 'O'
    and tgname in ('loads_status_event', 'loads_after_insert');
  perform rlstest.chk('loads_status_event and loads_after_insert triggers exist and are enabled', n = 2, 'found=' || n);
end $t$;

-- full walk by the proper actors: staff books, the carrier owner drives it to delivered
select rlstest.mkload(:'L20', 'requested', null);
update public.loads set its_load_number = '9020' where id = :'L20';
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.rows('control: staff assigns carrier A to L20', format($q$update public.loads set carrier_id = '20000000-0000-0000-0000-00000000000a' where id = %L$q$, :'L20'), 1);
select rlstest.ok('walk: staff books', format($q$select public.set_load_status(%L, 'booked')$q$, :'L20'));
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.ok('walk: carrier at_pickup', format($q$select public.set_load_status(%L, 'at_pickup')$q$, :'L20'));
select rlstest.ok('walk: carrier loading', format($q$select public.set_load_status(%L, 'loading')$q$, :'L20'));
select rlstest.ok('walk: carrier pickup photo', rlstest.pdins(:'L20', 'pickup_photo', :'L20' || '/pickup_photo/a0000000-0000-0000-0000-000000000021.jpg'));
select rlstest.ok('walk: carrier enroute',format($q$select public.set_load_status(%L, 'enroute', now() + interval '3 hours')$q$, :'L20'));
select rlstest.ok('walk: carrier at_delivery', format($q$select public.set_load_status(%L, 'at_delivery')$q$, :'L20'));
select rlstest.ok('walk: carrier uploads POD row', format($q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values (%L, 'pod', %L, '00000000-0000-0000-0000-0000000000b1')$q$, :'L20', :'L20' || '/pod/a0000000-0000-0000-0000-000000000020.jpg'));
select rlstest.ok('walk: carrier delivery photo', rlstest.pdins(:'L20', 'delivery_photo', :'L20' || '/delivery_photo/a0000000-0000-0000-0000-000000000022.jpg'));
select rlstest.ok('walk: carrier delivered',format($q$select public.set_load_status(%L, 'delivered')$q$, :'L20'));
select rlstest.back();
do $t$
declare
  l uuid := '30000000-0000-0000-0000-000000000020';
  n bigint; broken bigint; nulls bigint; st text;
begin
  select status::text into st from public.loads where id = l;
  perform rlstest.chk('guard: walked load reached delivered', st = 'delivered', 'status=' || coalesce(st, 'null'));
  n := rlstest.evcount(l);
  perform rlstest.chk('full walk requested..delivered yields exactly 7 events', n = 7, 'events=' || n);
  select count(*) into broken from (
    select from_status, lag(to_status) over (order by id) as prev_to, row_number() over (order by id) as rn
    from public.load_events where load_id = l) q
   where rn > 1 and from_status is distinct from prev_to;
  perform rlstest.chk('event chain is consistent (each from_status equals the previous to_status)', n = 7 and broken = 0, 'broken links=' || broken);
  perform rlstest.chk('first event is the creation event (from NULL, to requested)',
    (select from_status is null and to_status = 'requested' from public.load_events where load_id = l order by id limit 1));
  select count(*) into nulls from public.load_events where load_id = l and from_status is not null and actor_id is null;
  perform rlstest.chk('every walked event carries the acting user', n = 7 and nulls = 0, 'events without actor=' || nulls);
  perform rlstest.chk('booked event actor is the staff user, the delivered one the carrier owner',
    (select count(*) from public.load_events where load_id = l and to_status = 'booked' and actor_id = '00000000-0000-0000-0000-0000000000a2') = 1
    and (select count(*) from public.load_events where load_id = l and to_status = 'delivered' and actor_id = '00000000-0000-0000-0000-0000000000b1') = 1);
end $t$;

-- note handoff, no leak into the next writer; a staff override carries its note
select rlstest.mkload(:'L21', 'booked', '20000000-0000-0000-0000-00000000000a');
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.ok('override with note', format($q$select public.set_load_status(%L, 'loading', null, 'manual fix')$q$, :'L21'));
select rlstest.back();
do $t$
declare l uuid := '30000000-0000-0000-0000-000000000021'; v_note text; v_actor uuid; v_guc text;
begin
  select note, actor_id into v_note, v_actor from public.load_events where load_id = l and to_status = 'loading';
  perform rlstest.chk('staff override: the event carries the note', v_note = 'manual fix', 'note=' || coalesce(v_note, 'null'));
  perform rlstest.chk('staff override: the event carries the actor', v_actor = '00000000-0000-0000-0000-0000000000a2');
  v_guc := coalesce(current_setting('dlv.event_note', true), '');
  perform rlstest.chk('the note GUC is cleared after set_load_status', v_guc = '', 'guc=' || v_guc);
  -- a direct update right after, same transaction: must not inherit the note
  perform set_config('dlv.status_fn', '1', true);
  update public.loads set status = 'enroute', eta = now() + interval '1 hour' where id = l;
  perform set_config('dlv.status_fn', '0', true);
  select note, actor_id into v_note, v_actor from public.load_events where load_id = l and to_status = 'enroute';
  perform rlstest.chk('a later direct UPDATE does not inherit the previous note', v_note is null, 'note=' || coalesce(v_note, 'null'));
  perform rlstest.chk('a direct UPDATE with no JWT records a NULL actor', v_actor is null);
end $t$;

-- service-role style direct status UPDATE (table owner, status_fn set, as the fixtures do) writes exactly one event
select rlstest.mkload_direct(:'L22', 'requested', null);
do $t$
declare l uuid := '30000000-0000-0000-0000-000000000022'; n0 bigint; n1 bigint; last_from public.load_status; last_to public.load_status;
begin
  n0 := rlstest.evcount(l);
  perform rlstest.chk('guard: fresh load has its creation event', n0 = 1, 'events=' || n0);
  perform set_config('dlv.status_fn', '1', true);
  update public.loads set status = 'booked', carrier_id = '20000000-0000-0000-0000-00000000000a' where id = l;
  perform set_config('dlv.status_fn', '0', true);
  n1 := rlstest.evcount(l);
  perform rlstest.chk('direct status UPDATE (owner, status_fn) writes exactly one event', n1 = n0 + 1, 'before=' || n0 || ' after=' || n1);
  select from_status, to_status into last_from, last_to from public.load_events where load_id = l order by id desc limit 1;
  perform rlstest.chk('that event is requested to booked', last_from = 'requested' and last_to = 'booked');
  -- without status_fn and without a JWT (plain owner tooling)
  update public.loads set status = 'at_pickup' where id = l;
  perform rlstest.chk('direct status UPDATE with no status_fn writes exactly one event', rlstest.evcount(l) = n1 + 1);
end $t$;
select rlstest.as_service();
select rlstest.ok('service role moves L22 forward', format($q$update public.loads set status = 'loading' where id = %L$q$, :'L22'));
select rlstest.back();
select rlstest.chk('service role status UPDATE wrote exactly one more event (4 in total)', rlstest.evcount(:'L22') = 4, 'events=' || rlstest.evcount(:'L22'));
-- a JWT subject that has no profile row: actor NULL, no FK error
do $t$
declare l uuid := '30000000-0000-0000-0000-000000000022'; v_actor uuid; n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  perform set_config('dlv.status_fn', '1', true);
  update public.loads set status = 'enroute', eta = now() + interval '2 hours' where id = l;
  perform set_config('dlv.status_fn', '0', true);
  perform set_config('request.jwt.claims', '', true);
  select actor_id into v_actor from public.load_events where load_id = l order by id desc limit 1;
  n := rlstest.evcount(l);
  perform rlstest.chk('a JWT subject without a profile records a NULL actor', n = 5 and v_actor is null, 'events=' || n);
end $t$;

-- an UPDATE that does not change status produces no event
do $t$
declare l uuid := '30000000-0000-0000-0000-000000000022'; n0 bigint;
begin
  n0 := rlstest.evcount(l);
  perform rlstest.chk('guard: events exist before the no-change updates', n0 > 0, 'events=' || n0);
  update public.loads set notes = 'no status change' where id = l;
  perform rlstest.chk('UPDATE of another column writes no event', rlstest.evcount(l) = n0);
  update public.loads set status = status where id = l;
  perform rlstest.chk('UPDATE status = status (same value) writes no event', rlstest.evcount(l) = n0);
  update public.loads set carrier_id = '20000000-0000-0000-0000-00000000000b' where id = l;
  perform rlstest.chk('carrier reassignment writes no event', rlstest.evcount(l) = n0);
end $t$;

-- INSERT at a non requested status still yields exactly ONE event
select rlstest.mkload_direct(:'L23', 'booked', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload_direct(:'L24', 'delivered', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload_direct(:'L25', 'requested', null);
select rlstest.chk('INSERT at status booked yields exactly one event', rlstest.evcount(:'L23') = 1, 'events=' || rlstest.evcount(:'L23'));
select rlstest.chk('INSERT at status delivered yields exactly one event', rlstest.evcount(:'L24') = 1, 'events=' || rlstest.evcount(:'L24'));
select rlstest.chk('INSERT at status requested yields exactly one event', rlstest.evcount(:'L25') = 1, 'events=' || rlstest.evcount(:'L25'));
select rlstest.chk('the insert event of a booked load is (NULL to booked)',
  (select coalesce(bool_and(from_status is null and to_status = 'booked'), false) from public.load_events where load_id = :'L23'::uuid));

-- set_load_eta keeps its own from=to event, and changes no status
select rlstest.mkload(:'L26', 'enroute', '20000000-0000-0000-0000-00000000000a');
do $t$
declare l uuid := '30000000-0000-0000-0000-000000000026'; n0 bigint; same bigint;
begin
  n0 := rlstest.evcount(l);
  perform rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
  perform rlstest.ok('control: owner edits the eta', format($q$select public.set_load_eta(%L, now() + interval '5 hours', 'late')$q$, l));
  perform rlstest.back();
  select count(*) into same from public.load_events where load_id = l and from_status = to_status;
  perform rlstest.chk('set_load_eta writes exactly one from=to event', rlstest.evcount(l) = n0 + 1 and same = 1, 'before=' || n0 || ' after=' || rlstest.evcount(l) || ' same=' || same);
end $t$;

-- a customer cancel: one event, actor and note kept
select rlstest.mkload(:'L27', 'requested', null);
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.ok('customer cancels own requested load with a note', format($q$select public.set_load_status(%L, 'cancelled', null, 'Cancelled by customer')$q$, :'L27'));
select rlstest.back();
select rlstest.chk('customer cancel writes exactly one cancelled event with actor and note',
  (select count(*) = 1 and bool_and(from_status = 'requested' and actor_id = '00000000-0000-0000-0000-0000000000c1' and note = 'Cancelled by customer')
     from public.load_events where load_id = :'L27'::uuid and to_status = 'cancelled'));

-- events are append-only for clients
do $t$
declare p text; bad boolean := false;
begin
  foreach p in array array['insert', 'update', 'delete', 'truncate'] loop
    if has_table_privilege('authenticated', 'public.load_events', p) or has_table_privilege('anon', 'public.load_events', p) then bad := true; end if;
  end loop;
  perform rlstest.chk('authenticated and anon hold no INSERT, UPDATE, DELETE or TRUNCATE on load_events', not bad);
  perform rlstest.chk('control: authenticated can SELECT load_events', has_table_privilege('authenticated', 'public.load_events', 'select'));
  perform rlstest.chk('anon and authenticated have no EXECUTE on the status event trigger function',
    not has_function_privilege('anon', 'public.dlv_loads_status_event()', 'execute')
    and not has_function_privilege('authenticated', 'public.dlv_loads_status_event()', 'execute'));
  perform rlstest.chk('control: service_role has EXECUTE on the status event trigger function',
    has_function_privilege('service_role', 'public.dlv_loads_status_event()', 'execute'));
end $t$;
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.err('admin cannot UPDATE load_events', $q$update public.load_events set note = 'x'$q$, 'permission denied');
select rlstest.err('admin cannot insert a status event by hand', $q$insert into public.load_events (load_id, to_status) values ('30000000-0000-0000-0000-000000000020', 'booked')$q$, 'permission denied');
select rlstest.err('admin cannot change status by direct UPDATE (so no event can be forged that way)', $q$update public.loads set status = 'cancelled' where id = '30000000-0000-0000-0000-000000000023'$q$, 'set_load_status');
select rlstest.cnt('control: admin reads the L20 timeline', $q$select 1 from public.load_events where load_id = '30000000-0000-0000-0000-000000000020'$q$, 7);
select rlstest.back();

-- 12. POD is optional at delivery (0011): delivering needs no POD, and a POD can be added after delivered --------
\set L40 '30000000-0000-0000-0000-000000000040'
\set L41 '30000000-0000-0000-0000-000000000041'
\set L42 '30000000-0000-0000-0000-000000000042'
-- L40 at_delivery A (no POD, no document at all), L41 delivered A, L42 delivered B
select rlstest.mkload(:'L40', 'at_delivery', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload(:'L41', 'delivered', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload(:'L42', 'delivered', '20000000-0000-0000-0000-00000000000b');
select rlstest.chk('guard: L40 has no document and sits at_delivery',
  (select count(*) from public.load_documents where load_id = :'L40') = 0
  and (select status from public.loads where id = :'L40') = 'at_delivery');
select rlstest.chk('guard: L41 and L42 are delivered with no document',
  (select count(*) from public.loads where id in (:'L41', :'L42') and status = 'delivered') = 2
  and (select count(*) from public.load_documents where load_id in (:'L41', :'L42')) = 0);
insert into public.load_documents (load_id, kind, storage_path, uploaded_by)
  values (:'L40', 'delivery_photo', :'L40' || '/delivery_photo/c1000000-0000-0000-0000-0000000000f0.jpg', '00000000-0000-0000-0000-0000000000b1');
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.ok('delivered without a POD is allowed (carrier owner)',$q$select public.set_load_status('30000000-0000-0000-0000-000000000040', 'delivered')$q$);
select rlstest.err('control: delivered stays final for a carrier', $q$select public.set_load_status('30000000-0000-0000-0000-000000000040', 'at_delivery')$q$, 'one step|final');
select rlstest.ok('carrier owner uploads a POD after delivered (storage)', rlstest.sins(:'L41' || '/pod/c1000000-0000-0000-0000-000000000001.jpg'));
select rlstest.ok('carrier owner uploads a POD after delivered (load_documents)', rlstest.dins(:'L41', 'pod', :'L41' || '/pod/c1000000-0000-0000-0000-000000000001.jpg'));
select rlstest.ok('carrier owner adds a second POD after delivered', rlstest.dins(:'L41', 'pod', :'L41' || '/pod/c1000000-0000-0000-0000-000000000002.jpg'));
select rlstest.ok('carrier owner uploads a POD to the load it just delivered', rlstest.dins(:'L40', 'pod', :'L40' || '/pod/c1000000-0000-0000-0000-000000000003.jpg'));
select rlstest.err('carrier A cannot upload a POD to carrier B delivered load (storage)', rlstest.sins(:'L42' || '/pod/c1000000-0000-0000-0000-000000000004.jpg'), 'row-level security');
select rlstest.err('carrier A cannot upload a POD to carrier B delivered load (load_documents)', rlstest.dins(:'L42', 'pod', :'L42' || '/pod/c1000000-0000-0000-0000-000000000005.jpg'), 'row-level security');
select rlstest.err('carrier cannot upload a BOL after delivered (storage)', rlstest.sins(:'L41' || '/bol/c1000000-0000-0000-0000-000000000006.pdf'), 'row-level security');
select rlstest.err('carrier cannot upload a BOL after delivered (load_documents)', rlstest.dins(:'L41', 'bol', :'L41' || '/bol/c1000000-0000-0000-0000-000000000006.pdf'), 'row-level security');
select rlstest.err('path regex still enforced after delivered: dotdot', rlstest.sins(:'L41' || '/pod/../' || :'L42' || '/pod/c1000000-0000-0000-0000-000000000007.jpg'), 'row-level security');
select rlstest.err('path regex still enforced after delivered: non uuid name', rlstest.sins(:'L41' || '/pod/photo.jpg'), 'row-level security');
select rlstest.err('path regex still enforced after delivered: upper case kind', rlstest.sins(:'L41' || '/POD/c1000000-0000-0000-0000-000000000008.jpg'), 'row-level security');
select rlstest.err('path regex still enforced after delivered: load_documents row', rlstest.dins(:'L41', 'pod', :'L41' || '/pod/photo.jpg'), 'row-level security|violates check');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b2');
select rlstest.ok('driver uploads a POD after delivered (storage)', rlstest.sins(:'L41' || '/pod/c1000000-0000-0000-0000-000000000009.jpg'));
select rlstest.ok('driver uploads a POD after delivered (load_documents)', rlstest.dins(:'L41', 'pod', :'L41' || '/pod/c1000000-0000-0000-0000-000000000009.jpg'));
select rlstest.err('driver A cannot upload a POD to carrier B delivered load', rlstest.dins(:'L42', 'pod', :'L42' || '/pod/c1000000-0000-0000-0000-00000000000a.jpg'), 'row-level security');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b3');
select rlstest.ok('control: carrier B uploads a POD to its own delivered load', rlstest.dins(:'L42', 'pod', :'L42' || '/pod/c1000000-0000-0000-0000-00000000000b.jpg'));
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.err('customer cannot upload a POD to a delivered load (storage)', rlstest.sins(:'L41' || '/pod/c1000000-0000-0000-0000-00000000000c.jpg'), 'row-level security');
select rlstest.err('customer cannot upload a POD to a delivered load (load_documents)', rlstest.dins(:'L41', 'pod', :'L41' || '/pod/c1000000-0000-0000-0000-00000000000c.jpg'), 'row-level security');
select rlstest.cnt('control: customer reads the POD of the delivered load afterwards', $q$select 1 from public.load_documents where load_id = '30000000-0000-0000-0000-000000000041' and kind = 'pod'$q$, 3);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.ok('control: staff uploads a POD to a delivered load', rlstest.dins(:'L42', 'pod', :'L42' || '/pod/c1000000-0000-0000-0000-00000000000d.jpg'));
select rlstest.back();
do $t$
begin
  perform rlstest.chk('set_load_status no longer mentions a POD requirement',
    pg_get_functiondef('public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure) !~* 'pod');
  perform rlstest.chk('equipment_size CHECK allows exactly 26, 36, 53 and refuses 48',
    (select count(*) from pg_constraint where conrelid = 'public.loads'::regclass and contype = 'c' and convalidated
        and pg_get_constraintdef(oid) like '%equipment_size%' and pg_get_constraintdef(oid) not like '%48%') = 1);
end $t$;
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.err('DB refuses a load with equipment_size 48', $q$insert into public.loads (customer_id, created_by, pickup_location_id, delivery_location_id, equipment_size, pickup_timing, pickup_date, pickup_time_start, delivery_timing, delivery_date, delivery_time_start, pickup_contact_name, pickup_contact_phone, delivery_contact_name, delivery_contact_phone)
  values ((select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000a1', (select id from public.locations where name = 'Mitrex'), (select id from public.locations where name = 'Howden'), 48, 'appointment', current_date + 1, '08:00', 'appointment', current_date + 1, '14:00', 'P', '1', 'D', '2')$q$, 'equipment_size');
select rlstest.ok('control: DB accepts equipment_size 36', $q$insert into public.loads (customer_id, created_by, pickup_location_id, delivery_location_id, equipment_size, pickup_timing, pickup_date, pickup_time_start, delivery_timing, delivery_date, delivery_time_start, pickup_contact_name, pickup_contact_phone, delivery_contact_name, delivery_contact_phone)
  values ((select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000a1', (select id from public.locations where name = 'Mitrex'), (select id from public.locations where name = 'Howden'), 36, 'appointment', current_date + 1, '08:00', 'appointment', current_date + 1, '14:00', 'P', '1', 'D', '2')$q$);
select rlstest.back();

-- 13. ITS load number (0013): set only through set_its_load_number, required before a request is booked -----------
\set L50 '30000000-0000-0000-0000-000000000050'
\set L51 '30000000-0000-0000-0000-000000000051'
\set L52 '30000000-0000-0000-0000-000000000052'
\set L53 '30000000-0000-0000-0000-000000000053'
-- L50 and L51 requested with carrier A (no number), L52 legacy booked carrier A with no number, L53 requested for cancel
select rlstest.mkload(:'L50', 'requested', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload(:'L51', 'requested', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload(:'L52', 'booked', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload(:'L53', 'requested', null);
select rlstest.chk('guard: L50 and L51 are requested with a carrier and no ITS number',
  (select count(*) from public.loads where id in (:'L50', :'L51') and status = 'requested' and carrier_id is not null and its_load_number is null) = 2);
select rlstest.chk('guard: L52 is a legacy booked load without an ITS number',
  (select count(*) from public.loads where id = :'L52' and status = 'booked' and its_load_number is null) = 1);
select rlstest.chk('request ref is still generated for every load (load_number kept)',
  (select count(*) from public.loads where id in (:'L50', :'L51', :'L52', :'L53') and load_number ~ '^MTX-[0-9]{4,}$') = 4);

-- customer and carriers cannot set the number (function) nor write it directly
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.err('customer cannot call set_its_load_number', format($q$select public.set_its_load_number(%L, '5001')$q$, :'L50'), 'not authorized');
select rlstest.err('customer cannot write its_load_number directly', format($q$update public.loads set its_load_number = '5001' where id = %L$q$, :'L50'), 'only through set_its_load_number');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.err('carrier owner cannot call set_its_load_number', format($q$select public.set_its_load_number(%L, '5001')$q$, :'L52'), 'not authorized');
select rlstest.rows('carrier owner cannot write its_load_number directly (row not updatable)', format($q$update public.loads set its_load_number = '5001' where id = %L$q$, :'L52'), 0,
  format($q$select 1 from public.loads where id = %L$q$, :'L52'));
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b2');
select rlstest.err('carrier driver cannot call set_its_load_number', format($q$select public.set_its_load_number(%L, '5001')$q$, :'L52'), 'not authorized');
select rlstest.back();
select rlstest.chk('nothing was written by the refused attempts',
  (select count(*) from public.loads where id in (:'L50', :'L52') and its_load_number is not null) = 0);

-- staff: guard, format, duplicate, set, change, book
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.err('staff cannot write its_load_number by direct update', format($q$update public.loads set its_load_number = '5002' where id = %L$q$, :'L50'), 'only through set_its_load_number');
select rlstest.err('a request cannot be booked without an ITS number', format($q$select public.set_load_status(%L, 'booked')$q$, :'L50'), 'enter the ITS load number before booking');
select rlstest.err('a staff override jump out of requested needs the ITS number too', format($q$select public.set_load_status(%L, 'loading', null, 'jump')$q$, :'L50'), 'enter the ITS load number before booking');
select rlstest.ok('control: a request without a number can still be cancelled', format($q$select public.set_load_status(%L, 'cancelled', null, 'dup')$q$, :'L53'));
select rlstest.err('format refused: abc', format($q$select public.set_its_load_number(%L, 'abc')$q$, :'L50'), 'must be digits');
select rlstest.err('format refused: 12 3', format($q$select public.set_its_load_number(%L, '12 3')$q$, :'L50'), 'must be digits');
select rlstest.err('format refused: 1-', format($q$select public.set_its_load_number(%L, '1-')$q$, :'L50'), 'must be digits');
select rlstest.err('format refused: a1', format($q$select public.set_its_load_number(%L, 'a1')$q$, :'L50'), 'must be digits');
select rlstest.err('format refused: unicode lookalike digits (Arabic-Indic)', format($q$select public.set_its_load_number(%L, U&'\0663\0661\0663')$q$, :'L50'), 'must be digits');
select rlstest.err('format refused: fullwidth digits', format($q$select public.set_its_load_number(%L, U&'\FF13\FF11\FF13')$q$, :'L50'), 'must be digits');
select rlstest.err('format refused: trailing newline', format($q$select public.set_its_load_number(%L, E'313\n')$q$, :'L50'), 'must be digits');
select rlstest.err('format refused: SQL-looking text', format($q$select public.set_its_load_number(%L, '1; drop table loads--')$q$, :'L50'), 'must be digits');
select rlstest.err('length refused: 31 digits', format($q$select public.set_its_load_number(%L, repeat('9', 31))$q$, :'L50'), 'too long');
select rlstest.err('length refused: 3000 digits', format($q$select public.set_its_load_number(%L, repeat('7', 3000))$q$, :'L50'), 'too long');
select rlstest.ok('control: exactly 30 digits is accepted', format($q$select public.set_its_load_number(%L, repeat('8', 30))$q$, :'L53'));
select rlstest.err('format refused: 1-2-3', format($q$select public.set_its_load_number(%L, '1-2-3')$q$, :'L50'), 'must be digits');
select rlstest.err('format refused: empty', format($q$select public.set_its_load_number(%L, '')$q$, :'L50'), 'enter the ITS load number');
select rlstest.err('format refused: spaces only', format($q$select public.set_its_load_number(%L, '   ')$q$, :'L50'), 'enter the ITS load number');
select rlstest.err('format refused: null', format($q$select public.set_its_load_number(%L, null)$q$, :'L50'), 'enter the ITS load number');
select rlstest.err('unknown load refused', $q$select public.set_its_load_number('30000000-0000-0000-0000-0000000000ff', '5003')$q$, 'load not found');
select rlstest.chk('guard: every refused format left the load without a number',
  (select its_load_number from public.loads where id = :'L50') is null);
select rlstest.ok('313-2 (a split) is accepted, and trimmed', format($q$select public.set_its_load_number(%L, '  313-2 ')$q$, :'L50'));
select rlstest.chk('the stored number is exactly 313-2', (select its_load_number from public.loads where id = :'L50') = '313-2');
select rlstest.err('duplicate refused, naming the other load request ref', format($q$select public.set_its_load_number(%L, '313-2')$q$, :'L51'), 'already used by another load \(request MTX-[0-9]+\)');
select rlstest.ok('control: the same number on its own load is a no-op', format($q$select public.set_its_load_number(%L, '313-2')$q$, :'L50'));
select rlstest.ok('control: another number is accepted for the other load', format($q$select public.set_its_load_number(%L, '314')$q$, :'L51'));
select rlstest.ok('control: staff books a request that has a number', format($q$select public.set_load_status(%L, 'booked')$q$, :'L50'));
select rlstest.ok('staff corrects the number after booking', format($q$select public.set_its_load_number(%L, '315')$q$, :'L50'));
select rlstest.ok('legacy booked load without a number still advances', format($q$select public.set_load_status(%L, 'at_pickup')$q$, :'L52'));
select rlstest.back();
do $t$
begin
  perform rlstest.chk('L50 is booked with the corrected number', (select status::text || ':' || its_load_number from public.loads where id = '30000000-0000-0000-0000-000000000050') = 'booked:315');
  perform rlstest.chk('the function wrote the set event (from = to = requested)',
    (select count(*) from public.load_events where load_id = '30000000-0000-0000-0000-000000000050' and note = 'ITS load number set to 313-2' and from_status = 'requested' and to_status = 'requested' and actor_id = '00000000-0000-0000-0000-0000000000a2') = 1);
  perform rlstest.chk('the function wrote the changed event (from = to = booked)',
    (select count(*) from public.load_events where load_id = '30000000-0000-0000-0000-000000000050' and note = 'ITS load number changed from 313-2 to 315' and from_status = 'booked' and to_status = 'booked') = 1);
  perform rlstest.chk('the no-op and every refusal wrote no event',
    (select count(*) from public.load_events where load_id = '30000000-0000-0000-0000-000000000050' and note like 'ITS load number%') = 2);
  perform rlstest.chk('legacy load L52 is still without a number after it advanced',
    (select status::text || ':' || coalesce(its_load_number, 'none') from public.loads where id = '30000000-0000-0000-0000-000000000052') = 'at_pickup:none');
end $t$;

-- customers read the number of their own load, not of another customer's
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.cnt('customer reads the ITS number of their own booked load', format($q$select 1 from public.loads where id = %L and its_load_number = '315'$q$, :'L50'), 1);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000c2');
select rlstest.cnt('another customer cannot read that load or its number', $q$select 1 from public.loads where its_load_number = '315'$q$, 0,
  $q$select 1 from public.loads where its_load_number = '315'$q$);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.cnt('carrier owner reads the ITS number of its booked load', format($q$select 1 from public.loads where id = %L and its_load_number = '315'$q$, :'L50'), 1);
select rlstest.back();

-- a customer insert cannot smuggle a number
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
do $t$
declare v text; v_id uuid;
begin
  insert into public.loads (customer_id, created_by, pickup_location_id, delivery_location_id, equipment_size, pickup_timing, pickup_date,
    pickup_time_start, delivery_timing, delivery_date, delivery_time_start, pickup_contact_name, pickup_contact_phone, delivery_contact_name,
    delivery_contact_phone, its_load_number)
  values ((select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c1',
    (select id from public.locations where name = 'Mitrex'), (select id from public.locations where name = 'Howden'),
    53, 'appointment', current_date + 1, '08:00', 'appointment', current_date + 1, '14:00', 'P', '416-000-0001', 'D', '416-000-0002', '777')
  returning id, its_load_number into v_id, v;
  perform rlstest.chk('a customer insert carrying an ITS number stores NULL', v is null, 'stored=' || coalesce(v, 'null'));
end $t$;
select rlstest.back();

-- grants and definitions
do $t$
begin
  perform rlstest.chk('anon has no EXECUTE on set_its_load_number', not has_function_privilege('anon', 'public.set_its_load_number(uuid, text)', 'execute'));
  perform rlstest.chk('control: authenticated has EXECUTE on set_its_load_number', has_function_privilege('authenticated', 'public.set_its_load_number(uuid, text)', 'execute'));
  perform rlstest.chk('PUBLIC has no EXECUTE on set_its_load_number',
    not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = 'public.set_its_load_number(uuid, text)'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  perform rlstest.chk('the partial UNIQUE index on its_load_number exists',
    (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'loads' and indexdef ilike '%unique%' and indexdef like '%(its_load_number)%' and indexdef ilike '%where%') = 1);
  perform rlstest.chk('the format CHECK exists and is validated',
    (select count(*) from pg_constraint where conrelid = 'public.loads'::regclass and conname = 'loads_its_load_number_format' and convalidated) = 1);
  perform rlstest.chk('set_load_status carries the ITS rule',
    pg_get_functiondef('public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure) like '%enter the ITS load number before booking%');
end $t$;
-- the table owner (service role path) is bound by the CHECK and the unique index too
select rlstest.err('CHECK refuses a bad number even for the owner', format($q$update public.loads set its_load_number = 'abc' where id = %L$q$, :'L51'), 'loads_its_load_number_format');
select rlstest.err('UNIQUE refuses a duplicate even for the owner', format($q$update public.loads set its_load_number = '315' where id = %L$q$, :'L51'), 'duplicate key|loads_its_load_number_key');
select rlstest.ok('control: the owner may set a free number directly (service role path)', format($q$update public.loads set its_load_number = '316' where id = %L$q$, :'L51'));

-- 14. Admin delete of a load (0014): only an active staff_admin, typed confirmation, audit row, nothing else deletes --------
\set L60 '30000000-0000-0000-0000-000000000060'
\set L61 '30000000-0000-0000-0000-000000000061'
\set L62 '30000000-0000-0000-0000-000000000062'
\set L63 '30000000-0000-0000-0000-000000000063'
\set L64 '30000000-0000-0000-0000-000000000064'
\set L65 '30000000-0000-0000-0000-000000000065'
\set L66 '30000000-0000-0000-0000-000000000066'
\set L67 '30000000-0000-0000-0000-000000000067'
-- L60 delivered with ITS 9060 (BOL + POD), L61 requested without ITS (BOL), L62 booked victim with ITS 9062 (BOL),
-- L63 booked with ITS 9063 (confirmation tests), L64 L65 L66 three trucks of one booking, L67 for the direct DELETE tests
select rlstest.mkload(:'L60', 'delivered', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload(:'L61', 'requested', null);
select rlstest.mkload(:'L62', 'booked', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload(:'L63', 'booked', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload(:'L64', 'booked', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload(:'L65', 'booked', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload(:'L66', 'booked', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload(:'L67', 'booked', '20000000-0000-0000-0000-00000000000a');
update public.loads set its_load_number = '9060' where id = :'L60';
update public.loads set its_load_number = '9062' where id = :'L62';
update public.loads set its_load_number = '9063' where id = :'L63';
update public.loads set its_load_number = '9064' where id = :'L64';
update public.loads set its_load_number = '9065' where id = :'L65';
update public.loads set its_load_number = '9066' where id = :'L66';
update public.loads set its_load_number = '9067' where id = :'L67';
update public.loads set po_number = 'MULTI-14' where id in (:'L64', :'L65', :'L66');
insert into public.load_documents (load_id, kind, storage_path, uploaded_by)
select l, k, l::text || '/' || k || '/' || f || '.' || e, '00000000-0000-0000-0000-0000000000a1'
from (values
  (:'L60'::uuid, 'bol', 'd0000000-0000-0000-0000-000000000601', 'pdf'),
  (:'L60'::uuid, 'pod', 'd0000000-0000-0000-0000-000000000602', 'jpg'),
  (:'L61'::uuid, 'bol', 'd0000000-0000-0000-0000-000000000611', 'pdf'),
  (:'L62'::uuid, 'bol', 'd0000000-0000-0000-0000-000000000621', 'pdf'),
  (:'L64'::uuid, 'bol', 'd0000000-0000-0000-0000-000000000641', 'pdf'),
  (:'L66'::uuid, 'bol', 'd0000000-0000-0000-0000-000000000661', 'pdf'),
  (:'L65'::uuid, 'bol', 'd0000000-0000-0000-0000-000000000651', 'pdf'),
  (:'L67'::uuid, 'bol', 'd0000000-0000-0000-0000-000000000671', 'pdf')) v(l, k, f, e);
select rlstest.chk('guard: L60..L67 exist, each with events and a document row (the delete has something to remove)',
  (select count(*) from public.loads where id in (:'L60',:'L61',:'L62',:'L63',:'L64',:'L65',:'L66',:'L67')) = 8
  and (select count(distinct load_id) from public.load_events where load_id in (:'L60',:'L61',:'L62',:'L64',:'L65',:'L66',:'L67')) = 7
  and (select count(*) from public.load_documents where load_id in (:'L60',:'L61',:'L62',:'L64',:'L65',:'L66',:'L67')) = 8);
select rlstest.chk('guard: the active admin a1 and a3 exist and are active, no deletion record yet',
  (select count(*) from public.profiles where id in ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a3') and is_active and role = 'staff_admin') = 2
  and (select count(*) from public.load_deletions) = 0);

-- 14a. grants, definitions, no general DELETE ----------------------------------------------------------------------
do $t$
begin
  perform rlstest.chk('anon has no EXECUTE on delete_load_forever', not has_function_privilege('anon', 'public.delete_load_forever(uuid, text)', 'execute'));
  perform rlstest.chk('anon has no EXECUTE on record_load_deletion_orphans', not has_function_privilege('anon', 'public.record_load_deletion_orphans(uuid, text[])', 'execute'));
  perform rlstest.chk('control: authenticated has EXECUTE on delete_load_forever', has_function_privilege('authenticated', 'public.delete_load_forever(uuid, text)', 'execute'));
  perform rlstest.chk('control: authenticated has EXECUTE on record_load_deletion_orphans', has_function_privilege('authenticated', 'public.record_load_deletion_orphans(uuid, text[])', 'execute'));
  perform rlstest.chk('PUBLIC has no EXECUTE on either function',
    not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid in ('public.delete_load_forever(uuid, text)'::regprocedure, 'public.record_load_deletion_orphans(uuid, text[])'::regprocedure)
        and a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  perform rlstest.chk('delete_load_forever is SECURITY DEFINER with a pinned search_path',
    (select prosecdef and exists (select 1 from unnest(proconfig) c where c like 'search_path=%') from pg_proc where oid = 'public.delete_load_forever(uuid, text)'::regprocedure));
  perform rlstest.chk('record_load_deletion_orphans is SECURITY DEFINER with a pinned search_path',
    (select prosecdef and exists (select 1 from unnest(proconfig) c where c like 'search_path=%') from pg_proc where oid = 'public.record_load_deletion_orphans(uuid, text[])'::regprocedure));
  perform rlstest.chk('no client role holds DELETE on loads (anon, authenticated)',
    not has_table_privilege('anon', 'public.loads', 'delete') and not has_table_privilege('authenticated', 'public.loads', 'delete'));
  perform rlstest.chk('control: authenticated still holds SELECT and UPDATE on loads (the check reads the real grant)',
    has_table_privilege('authenticated', 'public.loads', 'select') and has_table_privilege('authenticated', 'public.loads', 'update'));
  perform rlstest.chk('no DELETE or ALL policy exists on loads',
    (select count(*) from pg_policy where polrelid = 'public.loads'::regclass and polcmd in ('d', '*')) = 0);
  perform rlstest.chk('control: loads still has its select policy (the policy check counts something)',
    (select count(*) from pg_policy where polrelid = 'public.loads'::regclass and polcmd = 'r') >= 1);
  perform rlstest.chk('load_deletions: RLS enabled, no write grant for anon or authenticated, select only for authenticated',
    (select relrowsecurity from pg_class where oid = 'public.load_deletions'::regclass)
    and not has_table_privilege('anon', 'public.load_deletions', 'select')
    and not has_table_privilege('anon', 'public.load_deletions', 'insert')
    and has_table_privilege('authenticated', 'public.load_deletions', 'select')
    and not has_table_privilege('authenticated', 'public.load_deletions', 'insert')
    and not has_table_privilege('authenticated', 'public.load_deletions', 'update')
    and not has_table_privilege('authenticated', 'public.load_deletions', 'delete'));
  perform rlstest.chk('load_deletions has no foreign key (a removed user or load never blocks)',
    (select count(*) from pg_constraint where conrelid = 'public.load_deletions'::regclass and contype = 'f') = 0);
  -- 0019 added the third reference (a return load names its original, ON DELETE SET NULL): a delete is still never blocked.
  perform rlstest.chk('only load_events and load_documents (ON DELETE CASCADE) and loads.return_of_load_id (ON DELETE SET NULL) reference loads (catalog)',
    (select count(*) from pg_constraint where confrelid = 'public.loads'::regclass and contype = 'f') = 3
    and (select count(*) from pg_constraint where confrelid = 'public.loads'::regclass and contype = 'f' and confdeltype = 'c'
           and conrelid in ('public.load_events'::regclass, 'public.load_documents'::regclass)) = 2
    and (select count(*) from pg_constraint where confrelid = 'public.loads'::regclass and contype = 'f' and confdeltype = 'n'
           and conrelid = 'public.loads'::regclass and conname = 'loads_return_of_load_id_fkey') = 1);
end $t$;

-- 14b. everyone who is not an active staff_admin is refused (each with the right confirmation text, so the ROLE is what refuses)
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.err('csr cannot delete a load', format($q$select public.delete_load_forever(%L, '9062')$q$, :'L62'), 'not authorized');
select rlstest.err('csr cannot record orphans', format($q$select public.record_load_deletion_orphans(%L, array[%L])$q$, :'L62', :'L62' || '/bol/d0000000-0000-0000-0000-000000000621.pdf'), 'not authorized');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.err('customer (owner of the load) cannot delete it', format($q$select public.delete_load_forever(%L, '9062')$q$, :'L62'), 'not authorized');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.err('carrier owner of the load cannot delete it', format($q$select public.delete_load_forever(%L, '9062')$q$, :'L62'), 'not authorized');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b2');
select rlstest.err('carrier driver of the load cannot delete it', format($q$select public.delete_load_forever(%L, '9062')$q$, :'L62'), 'not authorized');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b3');
select rlstest.err('another carrier owner cannot delete it', format($q$select public.delete_load_forever(%L, '9062')$q$, :'L62'), 'not authorized');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000c2');
select rlstest.err('another customer cannot delete it', format($q$select public.delete_load_forever(%L, '9062')$q$, :'L62'), 'not authorized');
select rlstest.back();
-- no JWT at all (the anon path reaches the function only through the grant, asserted above; here the null uid case)
select rlstest.err('a call with no signed in user is refused (auth.uid() is null)', format($q$select public.delete_load_forever(%L, '9062')$q$, :'L62'), 'not authorized');
-- an INACTIVE staff_admin
select rlstest.set_active('00000000-0000-0000-0000-0000000000a3', false);
select rlstest.chk('guard: a3 is now an inactive staff_admin and a1 is still active',
  (select count(*) from public.profiles where id = '00000000-0000-0000-0000-0000000000a3' and role = 'staff_admin' and not is_active) = 1
  and (select count(*) from public.profiles where id = '00000000-0000-0000-0000-0000000000a1' and role = 'staff_admin' and is_active) = 1);
select rlstest.as_user('00000000-0000-0000-0000-0000000000a3');
select rlstest.err('an inactive staff_admin cannot delete a load', format($q$select public.delete_load_forever(%L, '9062')$q$, :'L62'), 'not authorized');
select rlstest.back();
select rlstest.set_active('00000000-0000-0000-0000-0000000000a3', true);
do $t$
begin
  perform rlstest.chk('nothing was deleted by any refused attempt: L62 with its events and document, no audit row',
    (select count(*) from public.loads where id = '30000000-0000-0000-0000-000000000062') = 1
    and (select count(*) from public.load_events where load_id = '30000000-0000-0000-0000-000000000062') > 0
    and (select count(*) from public.load_documents where load_id = '30000000-0000-0000-0000-000000000062') = 1
    and (select count(*) from public.load_deletions) = 0);
end $t$;

-- 14c. confirmation: wrong, empty, null, the OTHER number, an unknown load; nothing is deleted
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.err('wrong confirmation refused', format($q$select public.delete_load_forever(%L, '1234')$q$, :'L63'), 'confirmation does not match');
select rlstest.err('empty confirmation refused', format($q$select public.delete_load_forever(%L, '')$q$, :'L63'), 'confirmation does not match');
select rlstest.err('spaces only confirmation refused', format($q$select public.delete_load_forever(%L, '   ')$q$, :'L63'), 'confirmation does not match');
select rlstest.err('null confirmation refused', format($q$select public.delete_load_forever(%L, null)$q$, :'L63'), 'confirmation does not match');
select rlstest.err('a prefix of the number is refused', format($q$select public.delete_load_forever(%L, '906')$q$, :'L63'), 'confirmation does not match');
select rlstest.err('the number of ANOTHER load is refused', format($q$select public.delete_load_forever(%L, '9062')$q$, :'L63'), 'confirmation does not match');
select rlstest.err('the request ref is refused while an ITS number is set', format($q$select public.delete_load_forever(%L, %L)$q$, :'L63', (select load_number from public.loads where id = :'L63')), 'confirmation does not match');
select rlstest.err('a request without an ITS number refuses a made up number', format($q$select public.delete_load_forever(%L, '9061')$q$, :'L61'), 'confirmation does not match');
select rlstest.err('an unknown load is refused', $q$select public.delete_load_forever('30000000-0000-0000-0000-0000000000ee', '1')$q$, 'load not found');
select rlstest.back();
do $t$
begin
  perform rlstest.chk('nothing was deleted by a wrong confirmation: L63 and L61 with events and documents, no audit row',
    (select count(*) from public.loads where id in ('30000000-0000-0000-0000-000000000063', '30000000-0000-0000-0000-000000000061')) = 2
    and (select count(*) from public.load_events where load_id in ('30000000-0000-0000-0000-000000000063', '30000000-0000-0000-0000-000000000061')) >= 2
    and (select count(*) from public.load_documents where load_id = '30000000-0000-0000-0000-000000000061') = 1
    and (select count(*) from public.load_deletions) = 0);
end $t$;

-- 14d. direct DELETE on loads is refused for every client role (the function is the only path)
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.err('admin cannot DELETE loads directly', format($q$delete from public.loads where id = %L$q$, :'L67'), 'permission denied');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.err('csr cannot DELETE loads directly', format($q$delete from public.loads where id = %L$q$, :'L67'), 'permission denied');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.err('customer cannot DELETE loads directly', format($q$delete from public.loads where id = %L$q$, :'L67'), 'permission denied');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.err('carrier owner cannot DELETE loads directly', format($q$delete from public.loads where id = %L$q$, :'L67'), 'permission denied');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b2');
select rlstest.err('carrier driver cannot DELETE loads directly', format($q$delete from public.loads where id = %L$q$, :'L67'), 'permission denied');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.err('admin cannot DELETE load_documents directly either', format($q$delete from public.load_documents where load_id = %L$q$, :'L67'), 'permission denied');
select rlstest.err('admin cannot DELETE load_events directly', format($q$delete from public.load_events where load_id = %L$q$, :'L67'), 'permission denied');
select rlstest.back();
do $t$
begin
  perform rlstest.chk('L67 is untouched after every direct DELETE attempt', (select count(*) from public.loads where id = '30000000-0000-0000-0000-000000000067') = 1
    and (select count(*) from public.load_documents where load_id = '30000000-0000-0000-0000-000000000067') = 1);
end $t$;
-- positive control: the table owner can delete, and the cascade removes events and documents (the FK behaviour the function relies on)
delete from public.loads where id = :'L67';
select rlstest.chk('control: the owner delete of L67 cascades to its events and document rows',
  (select count(*) from public.loads where id = :'L67') = 0
  and (select count(*) from public.load_events where load_id = :'L67') = 0
  and (select count(*) from public.load_documents where load_id = :'L67') = 0);

-- 14e. positive: the active admin deletes by ITS number, by request ref, and trims the typed text
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
do $t$
declare v text[];
begin
  v := public.delete_load_forever('30000000-0000-0000-0000-000000000060', '9060');
  perform rlstest.chk('admin deletes L60 by its ITS number and the function returns exactly the two storage paths',
    v is not null and cardinality(v) = 2
    and v @> array['30000000-0000-0000-0000-000000000060/bol/d0000000-0000-0000-0000-000000000601.pdf', '30000000-0000-0000-0000-000000000060/pod/d0000000-0000-0000-0000-000000000602.jpg']);
end $t$;
do $t$
declare v text[]; v_ref text;
begin
  select load_number into v_ref from public.loads where id = '30000000-0000-0000-0000-000000000061';
  v := public.delete_load_forever('30000000-0000-0000-0000-000000000061', '  ' || v_ref || '  ');
  perform rlstest.chk('admin deletes L61 (no ITS number) by its request ref, spaces around the text are trimmed, one path returned', cardinality(v) = 1);
end $t$;
select rlstest.ok('control: admin deletes L62 with the right text (so every earlier refusal was the ROLE)', format($q$select public.delete_load_forever(%L, '9062')$q$, :'L62'));
select rlstest.err('deleting the same load again is refused (not found), no second audit row', format($q$select public.delete_load_forever(%L, '9062')$q$, :'L62'), 'load not found');
select rlstest.back();
do $t$
begin
  perform rlstest.chk('L60, L61, L62 are gone with their events and document rows',
    (select count(*) from public.loads where id in ('30000000-0000-0000-0000-000000000060','30000000-0000-0000-0000-000000000061','30000000-0000-0000-0000-000000000062')) = 0
    and (select count(*) from public.load_events where load_id in ('30000000-0000-0000-0000-000000000060','30000000-0000-0000-0000-000000000061','30000000-0000-0000-0000-000000000062')) = 0
    and (select count(*) from public.load_documents where load_id in ('30000000-0000-0000-0000-000000000060','30000000-0000-0000-0000-000000000061','30000000-0000-0000-0000-000000000062')) = 0);
  perform rlstest.chk('exactly three audit rows, one per delete',
    (select count(*) from public.load_deletions) = 3);
  perform rlstest.chk('audit row of L60: ITS 9060, last status delivered, deleted by a1, now, no orphans, request ref kept',
    (select count(*) from public.load_deletions d where d.load_id = '30000000-0000-0000-0000-000000000060' and d.its_load_number = '9060'
       and d.last_status = 'delivered' and d.deleted_by = '00000000-0000-0000-0000-0000000000a1'
       and d.deleted_at > now() - interval '1 minute' and d.deleted_at <= now()
       and d.orphan_paths = '{}' and d.request_ref ~ '^MTX-[0-9]{4,}$') = 1);
  perform rlstest.chk('audit row of L61: no ITS number (null), last status requested',
    (select count(*) from public.load_deletions d where d.load_id = '30000000-0000-0000-0000-000000000061' and d.its_load_number is null and d.last_status = 'requested'
       and d.deleted_by = '00000000-0000-0000-0000-0000000000a1') = 1);
end $t$;

-- 14f. one truck of a multi-truck booking: the others stay, with their events and documents
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.ok('admin deletes truck L65 of the three truck booking', format($q$select public.delete_load_forever(%L, '9065')$q$, :'L65'));
select rlstest.back();
do $t$
begin
  perform rlstest.chk('L65 is gone',
    (select count(*) from public.loads where id = '30000000-0000-0000-0000-000000000065') = 0);
  perform rlstest.chk('the other two trucks (same PO) remain with their events and documents',
    (select count(*) from public.loads where po_number = 'MULTI-14') = 2
    and (select count(distinct load_id) from public.load_events where load_id in ('30000000-0000-0000-0000-000000000064', '30000000-0000-0000-0000-000000000066')) = 2
    and (select count(*) from public.load_documents where load_id in ('30000000-0000-0000-0000-000000000064', '30000000-0000-0000-0000-000000000066')) = 2);
end $t$;

-- 14g. load_deletions: readable by an active admin only, never writable by a client
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.cnt('admin reads the audit rows', 'select 1 from public.load_deletions', 4);
select rlstest.err('admin cannot INSERT into load_deletions', format($q$insert into public.load_deletions (load_id, request_ref) values (%L, 'MTX-9999')$q$, :'L63'), 'permission denied');
select rlstest.err('admin cannot UPDATE load_deletions', $q$update public.load_deletions set request_ref = 'X'$q$, 'permission denied');
select rlstest.err('admin cannot DELETE from load_deletions', $q$delete from public.load_deletions$q$, 'permission denied');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.cnt('csr reads no audit rows', 'select 1 from public.load_deletions', 0, 'select 1 from public.load_deletions');
select rlstest.err('csr cannot INSERT into load_deletions', format($q$insert into public.load_deletions (load_id, request_ref) values (%L, 'MTX-9999')$q$, :'L63'), 'permission denied');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.cnt('customer reads no audit rows', 'select 1 from public.load_deletions', 0, 'select 1 from public.load_deletions');
select rlstest.err('customer cannot INSERT into load_deletions', format($q$insert into public.load_deletions (load_id, request_ref) values (%L, 'MTX-9999')$q$, :'L63'), 'permission denied');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.cnt('carrier owner reads no audit rows', 'select 1 from public.load_deletions', 0, 'select 1 from public.load_deletions');
select rlstest.err('carrier owner cannot INSERT into load_deletions', format($q$insert into public.load_deletions (load_id, request_ref) values (%L, 'MTX-9999')$q$, :'L63'), 'permission denied');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b2');
select rlstest.cnt('carrier driver reads no audit rows', 'select 1 from public.load_deletions', 0, 'select 1 from public.load_deletions');
select rlstest.back();
select rlstest.set_active('00000000-0000-0000-0000-0000000000a3', false);
select rlstest.as_user('00000000-0000-0000-0000-0000000000a3');
select rlstest.cnt('an inactive staff_admin reads no audit rows', 'select 1 from public.load_deletions', 0, 'select 1 from public.load_deletions');
select rlstest.back();
select rlstest.set_active('00000000-0000-0000-0000-0000000000a3', true);

-- 14h. record_load_deletion_orphans
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.err('orphans: a path of ANOTHER load is refused', format($q$select public.record_load_deletion_orphans(%L, array[%L])$q$, :'L60', :'L64' || '/bol/d0000000-0000-0000-0000-000000000641.pdf'), 'does not belong');
select rlstest.err('orphans: a malformed path is refused', format($q$select public.record_load_deletion_orphans(%L, array[%L])$q$, :'L60', :'L60' || '/bol/../x.pdf'), 'does not belong');
select rlstest.err('orphans: a load that still exists is refused', format($q$select public.record_load_deletion_orphans(%L, array[%L])$q$, :'L64', :'L64' || '/bol/d0000000-0000-0000-0000-000000000641.pdf'), 'still exists');
select rlstest.err('orphans: an unknown load (no deletion record) is refused', format($q$select public.record_load_deletion_orphans(%L, array[%L])$q$, '30000000-0000-0000-0000-0000000000ee', '30000000-0000-0000-0000-0000000000ee/bol/d0000000-0000-0000-0000-000000000641.pdf'), 'no deletion record');
select rlstest.ok('control: admin records the two orphan paths of L60',
  format($q$select public.record_load_deletion_orphans(%L, array[%L, %L])$q$, :'L60', :'L60' || '/bol/d0000000-0000-0000-0000-000000000601.pdf', :'L60' || '/pod/d0000000-0000-0000-0000-000000000602.jpg'));
do $t$
declare n int;
begin
  n := public.record_load_deletion_orphans('30000000-0000-0000-0000-000000000060', array['30000000-0000-0000-0000-000000000060/bol/d0000000-0000-0000-0000-000000000601.pdf']);
  perform rlstest.chk('orphans: recording a path twice appends nothing (returns 0)', n = 0);
end $t$;
select rlstest.back();
do $t$
begin
  perform rlstest.chk('orphans: the L60 audit row holds exactly the two paths, the other audit rows none',
    (select cardinality(orphan_paths) from public.load_deletions where load_id = '30000000-0000-0000-0000-000000000060') = 2
    and (select count(*) from public.load_deletions where load_id <> '30000000-0000-0000-0000-000000000060' and cardinality(orphan_paths) > 0) = 0);
end $t$;
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.err('orphans: csr is refused on a real deletion record', format($q$select public.record_load_deletion_orphans(%L, array[%L])$q$, :'L61', :'L61' || '/bol/d0000000-0000-0000-0000-000000000611.pdf'), 'not authorized');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.err('orphans: customer is refused', format($q$select public.record_load_deletion_orphans(%L, array[%L])$q$, :'L61', :'L61' || '/bol/d0000000-0000-0000-0000-000000000611.pdf'), 'not authorized');
select rlstest.back();
select rlstest.chk('orphans: the refused callers appended nothing to L61', (select cardinality(orphan_paths) from public.load_deletions where load_id = :'L61') = 0);

-- 15. Lane references (0015, 0016): staff only ---------------------------------------------------------------------
-- The owner's table, embedded here independently of the migration (shipper, receiver, size, ITS load, Moffett Y or N).
create table rlstest.lane_exp (shipper text, receiver text, size int, its text, moffett boolean);
insert into rlstest.lane_exp values
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
  ('Mitrex', 'PrimeFab', 26, '1293', true);

create function rlstest.lane_actual() returns table (shipper text, receiver text, size int, its text)
language sql security definer as $f$
  select p.name, d.name, l.equipment_size, l.its_reference_load
    from public.lane_references l
    join public.locations p on p.id = l.pickup_location_id
    join public.locations d on d.id = l.delivery_location_id $f$;
grant execute on all functions in schema rlstest to authenticated, anon;

-- 15a. the seed: exactly the owner's 25 rows, the seven sites, the derived Moffett column ------------------------------
do $t$
declare n_join int; n_bad int;
begin
  perform rlstest.chk('lane seed: exactly 25 lane_references rows', (select count(*) from public.lane_references) = 25);
  perform rlstest.chk('lane seed: the expectation here has 25 distinct scenarios',
    (select count(*) from rlstest.lane_exp) = 25 and (select count(distinct (shipper, receiver, size)) from rlstest.lane_exp) = 25);
  perform rlstest.chk('lane seed: the full set (shipper, receiver, size, number) equals the owner table, nothing missing',
    (select count(*) from (select shipper, receiver, size, its from rlstest.lane_exp except select * from rlstest.lane_actual()) q) = 0);
  perform rlstest.chk('lane seed: the full set equals the owner table, nothing extra',
    (select count(*) from (select * from rlstest.lane_actual() except select shipper, receiver, size, its from rlstest.lane_exp) q) = 0);
  perform rlstest.chk('lane seed: Mitrex to 481 University Ave is 1269 at 26 and 1264 at 53',
    (select its from rlstest.lane_actual() where shipper = 'Mitrex' and receiver = '481 University Ave' and size = 26) = '1269'
    and (select its from rlstest.lane_actual() where shipper = 'Mitrex' and receiver = '481 University Ave' and size = 53) = '1264');
  perform rlstest.chk('lane seed: no 36 ft row yet (upcoming projects)', (select count(*) from public.lane_references where equipment_size = 36) = 0);
  perform rlstest.chk('lane seed: the left out lanes were not invented (no 125G or MTD pickup, one D Express lane)',
    (select count(*) from rlstest.lane_actual() where shipper in ('125G', 'MTD MetroTool & Die Limited')) = 0
    and (select count(*) from rlstest.lane_actual() where shipper = 'D Express Transport') = 1);
  perform rlstest.chk('Moffett: the 7 sites now require Moffett',
    (select count(*) from public.locations where name in ('1HAM', '152 Sh', '831 Queen', 'Glengarry', 'Kitney site', 'Military Trailsite', 'PrimeFab') and requires_moffett) = 7);
  perform rlstest.chk('Moffett: SAMIH still requires it', (select requires_moffett from public.locations where name = 'SAMIH'));
  perform rlstest.chk('Moffett: Mitrex, 481 University Ave and Howden do not require it',
    (select count(*) from public.locations where name in ('Mitrex', '481 University Ave', 'Howden') and requires_moffett) = 0);
  -- derived Moffett (pickup or delivery) equals the owner's Y or N for ALL 25 rows
  select count(*), count(*) filter (where (p.requires_moffett or d.requires_moffett) is distinct from e.moffett)
    into n_join, n_bad
    from rlstest.lane_exp e
    join public.locations p on p.name = e.shipper
    join public.locations d on d.name = e.receiver;
  perform rlstest.chk('Moffett derivation: all 25 rows resolve to a pickup and a delivery location (guard)', n_join = 25);
  perform rlstest.chk('Moffett derivation: (pickup or delivery requires_moffett) equals the owner Y or N for all 25 rows', n_bad = 0, 'mismatches=' || n_bad);
  perform rlstest.chk('Moffett derivation: the owner table has 10 Y and 15 N (guard against an all-N expectation)',
    (select count(*) from rlstest.lane_exp where moffett) = 10 and (select count(*) from rlstest.lane_exp where not moffett) = 15);
end $t$;

-- 15b. grants, RLS flag and policies: staff only ----------------------------------------------------------------------
do $t$
begin
  perform rlstest.chk('lane_references: RLS is enabled', (select relrowsecurity from pg_class where oid = 'public.lane_references'::regclass));
  perform rlstest.chk('lane_references: anon holds no table privilege (grants only, never called as anon)',
    not has_table_privilege('anon', 'public.lane_references', 'select')
    and not has_table_privilege('anon', 'public.lane_references', 'insert')
    and not has_table_privilege('anon', 'public.lane_references', 'update')
    and not has_table_privilege('anon', 'public.lane_references', 'delete'));
  perform rlstest.chk('lane_references: PUBLIC holds no privilege',
    not exists (select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where c.oid = 'public.lane_references'::regclass and a.grantee = 0));
  perform rlstest.chk('control: authenticated holds select, insert, update and delete on lane_references',
    has_table_privilege('authenticated', 'public.lane_references', 'select') and has_table_privilege('authenticated', 'public.lane_references', 'insert')
    and has_table_privilege('authenticated', 'public.lane_references', 'update') and has_table_privilege('authenticated', 'public.lane_references', 'delete'));
  perform rlstest.chk('lane_references: no TRUNCATE, REFERENCES or TRIGGER for authenticated',
    not has_table_privilege('authenticated', 'public.lane_references', 'truncate')
    and not has_table_privilege('authenticated', 'public.lane_references', 'references')
    and not has_table_privilege('authenticated', 'public.lane_references', 'trigger'));
  perform rlstest.chk('lane_references: exactly four policies, one per command, all for authenticated only',
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'lane_references') = 4
    and (select count(distinct cmd) from pg_policies where schemaname = 'public' and tablename = 'lane_references') = 4
    and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'lane_references' and roles = '{authenticated}') = 4);
  perform rlstest.chk('lane_references: every policy is gated by dlv_is_staff() and names no customer or carrier role',
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'lane_references'
       and coalesce(qual, with_check) like '%dlv_is_staff()%'
       and coalesce(qual, '') !~ 'customer|carrier|dlv_role|true' and coalesce(with_check, '') !~ 'customer|carrier|dlv_role|true') = 4);
  perform rlstest.chk('lane_references: the actor trigger function is not executable by anon or authenticated',
    not has_function_privilege('anon', 'public.dlv_lane_references_before_write()', 'execute')
    and not has_function_privilege('authenticated', 'public.dlv_lane_references_before_write()', 'execute'));
end $t$;

-- 15c. staff admin and staff csr: read, insert, update, delete (positive controls) ----------------------------------
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.cnt('control: staff_admin reads all 25 lane references', 'select 1 from public.lane_references', 25);
select rlstest.ok('staff_admin inserts a lane reference (Howden to Mitrex, 36 ft)',
  $q$insert into public.lane_references (pickup_location_id, delivery_location_id, equipment_size, its_reference_load, note)
     values ((select id from public.locations where name = 'Howden'), (select id from public.locations where name = 'Mitrex'), 36, '9001', 'admin made')$q$);
select rlstest.rows('staff_admin updates the number and note of that row',
  $q$update public.lane_references set its_reference_load = '9002-1', note = 'edited' where note = 'admin made'$q$, 1);
select rlstest.cnt('staff_admin reads the edited row back', $q$select 1 from public.lane_references where its_reference_load = '9002-1' and note = 'edited'$q$, 1);
select rlstest.rows('staff_admin deletes that row', $q$delete from public.lane_references where its_reference_load = '9002-1'$q$, 1);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.cnt('control: staff_csr reads all 25 lane references', 'select 1 from public.lane_references', 25);
select rlstest.ok('staff_csr inserts a lane reference (Howden to Mitrex, 36 ft)',
  $q$insert into public.lane_references (pickup_location_id, delivery_location_id, equipment_size, its_reference_load, note)
     values ((select id from public.locations where name = 'Howden'), (select id from public.locations where name = 'Mitrex'), 36, '9003', 'csr made')$q$);
select rlstest.rows('staff_csr updates the number of that row', $q$update public.lane_references set its_reference_load = '9004' where note = 'csr made'$q$, 1);
select rlstest.rows('staff_csr updates a SEEDED row too (Mitrex to Spadina 810 becomes 811)',
  $q$update public.lane_references set its_reference_load = '811' where its_reference_load = '810'$q$, 1);
select rlstest.rows('staff_csr deletes the row it made', $q$delete from public.lane_references where note = 'csr made'$q$, 1);
select rlstest.rows('staff_csr deletes a seeded row (Mitrex to Spadina) and can put it back',
  $q$delete from public.lane_references where its_reference_load = '811'$q$, 1);
select rlstest.ok('staff_csr re-inserts Mitrex to Spadina 26 ft = 810',
  $q$insert into public.lane_references (pickup_location_id, delivery_location_id, equipment_size, its_reference_load)
     values ((select id from public.locations where name = 'Mitrex'), (select id from public.locations where name = 'Spadina'), 26, '810')$q$);
select rlstest.back();
do $t$
begin
  perform rlstest.chk('after the staff writes the table holds the owner set again (25 rows, same set)',
    (select count(*) from public.lane_references) = 25
    and (select count(*) from (select shipper, receiver, size, its from rlstest.lane_exp except select * from rlstest.lane_actual()) q) = 0);
end $t$;

-- 15d. updated_by comes from the session, updated_at moves ------------------------------------------------------------
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.ok('staff_admin inserts a row that claims another updated_by',
  $q$insert into public.lane_references (pickup_location_id, delivery_location_id, equipment_size, its_reference_load, note, updated_by)
     values ((select id from public.locations where name = 'Howden'), (select id from public.locations where name = 'Mitrex'), 36, '9010', 'actor', '00000000-0000-0000-0000-0000000000c1')$q$);
select rlstest.back();
do $t$
begin
  perform rlstest.chk('updated_by is the inserting admin, not the value the client sent',
    (select updated_by from public.lane_references where note = 'actor') = '00000000-0000-0000-0000-0000000000a1');
end $t$;
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.rows('staff_csr edits that row', $q$update public.lane_references set its_reference_load = '9011' where note = 'actor'$q$, 1);
select rlstest.back();
do $t$
begin
  perform rlstest.chk('updated_by follows the last editor (csr)', (select updated_by from public.lane_references where note = 'actor') = '00000000-0000-0000-0000-0000000000a2');
  perform rlstest.chk('updated_at is now() after the edit and a seeded row keeps an earlier updated_at',
    (select updated_at = now() from public.lane_references where note = 'actor')
    and (select updated_at < now() from public.lane_references where its_reference_load = '1269'));
end $t$;
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.rows('cleanup: admin deletes the actor row', $q$delete from public.lane_references where note = 'actor'$q$, 1);
select rlstest.back();

-- 15e. nobody else: customer, carrier owner, carrier driver, inactive staff ----------------------------------------------
create function rlstest.lane_denied(p_who text, p_uid uuid) returns void language plpgsql as $f$
begin
  perform rlstest.as_user(p_uid);
  perform rlstest.cnt(p_who || ' reads no lane references (rows exist: guard)', 'select 1 from public.lane_references', 0, 'select 1 from public.lane_references');
  perform rlstest.err(p_who || ' cannot INSERT a lane reference',
    $q$insert into public.lane_references (pickup_location_id, delivery_location_id, equipment_size, its_reference_load)
       values ((select id from public.locations where name = 'Howden'), (select id from public.locations where name = 'Mitrex'), 36, '9020')$q$, 'row-level security');
  perform rlstest.rows(p_who || ' cannot UPDATE a lane reference (0 rows)', $q$update public.lane_references set its_reference_load = '9021'$q$, 0, 'select 1 from public.lane_references');
  perform rlstest.rows(p_who || ' cannot DELETE a lane reference (0 rows)', $q$delete from public.lane_references$q$, 0, 'select 1 from public.lane_references');
  perform rlstest.back();
end $f$;
grant execute on function rlstest.lane_denied(text, uuid) to authenticated, anon;
select rlstest.lane_denied('customer', '00000000-0000-0000-0000-0000000000c1');
select rlstest.lane_denied('other customer', '00000000-0000-0000-0000-0000000000c2');
select rlstest.lane_denied('carrier owner', '00000000-0000-0000-0000-0000000000b1');
select rlstest.lane_denied('carrier driver', '00000000-0000-0000-0000-0000000000b2');
select rlstest.set_active('00000000-0000-0000-0000-0000000000a3', false);
select rlstest.lane_denied('inactive staff_admin', '00000000-0000-0000-0000-0000000000a3');
select rlstest.set_active('00000000-0000-0000-0000-0000000000a3', true);
select rlstest.as_user('00000000-0000-0000-0000-0000000000a3');
select rlstest.cnt('control: the same user reads all 25 once active again', 'select 1 from public.lane_references', 25);
select rlstest.back();
do $t$
begin
  perform rlstest.chk('after every refused write the table still holds the owner set (25 rows, same set)',
    (select count(*) from public.lane_references) = 25
    and (select count(*) from (select shipper, receiver, size, its from rlstest.lane_exp except select * from rlstest.lane_actual()) q) = 0);
end $t$;

-- 15f. constraints (as the table owner: RLS bypassed, so only the constraint can refuse) ----------------------------------
select rlstest.ok('control: a valid row (size 36, number 313-2) is accepted',
  $q$insert into public.lane_references (pickup_location_id, delivery_location_id, equipment_size, its_reference_load)
     values ((select id from public.locations where name = 'Howden'), (select id from public.locations where name = 'Mitrex'), 36, '313-2')$q$);
select rlstest.err('uniqueness: the same pickup, delivery and size twice is refused',
  $q$insert into public.lane_references (pickup_location_id, delivery_location_id, equipment_size, its_reference_load)
     values ((select id from public.locations where name = 'Howden'), (select id from public.locations where name = 'Mitrex'), 36, '9030')$q$, 'lane_references_scenario_uq');
select rlstest.ok('control: the same pair at another size (53) is a different scenario',
  $q$insert into public.lane_references (pickup_location_id, delivery_location_id, equipment_size, its_reference_load)
     values ((select id from public.locations where name = 'Howden'), (select id from public.locations where name = 'Mitrex'), 53, '9031')$q$);
select rlstest.ok('control: the reverse direction is a different scenario',
  $q$insert into public.lane_references (pickup_location_id, delivery_location_id, equipment_size, its_reference_load)
     values ((select id from public.locations where name = 'Mitrex'), (select id from public.locations where name = 'Howden'), 36, '9032')$q$);
select rlstest.err('size 48 is refused', $q$insert into public.lane_references (pickup_location_id, delivery_location_id, equipment_size, its_reference_load)
  values ((select id from public.locations where name = 'Howden'), (select id from public.locations where name = 'Mitrex'), 48, '9033')$q$, 'lane_references_size_ck');
select rlstest.err('size 0 is refused', $q$insert into public.lane_references (pickup_location_id, delivery_location_id, equipment_size, its_reference_load)
  values ((select id from public.locations where name = 'Howden'), (select id from public.locations where name = 'Mitrex'), 0, '9034')$q$, 'lane_references_size_ck');
select rlstest.err('size null is refused', $q$insert into public.lane_references (pickup_location_id, delivery_location_id, equipment_size, its_reference_load)
  values ((select id from public.locations where name = 'Howden'), (select id from public.locations where name = 'Mitrex'), null, '9035')$q$, 'null value');
select rlstest.err('pickup equal to delivery is refused', $q$insert into public.lane_references (pickup_location_id, delivery_location_id, equipment_size, its_reference_load)
  values ((select id from public.locations where name = 'Howden'), (select id from public.locations where name = 'Howden'), 26, '9036')$q$, 'lane_references_distinct_ck');
select rlstest.err('an unknown location is refused', $q$insert into public.lane_references (pickup_location_id, delivery_location_id, equipment_size, its_reference_load)
  values ('99999999-9999-9999-9999-999999999999', (select id from public.locations where name = 'Mitrex'), 26, '9037')$q$, 'foreign key');
select rlstest.err('number "abc" is refused', $q$update public.lane_references set its_reference_load = 'abc' where its_reference_load = '9031'$q$, 'lane_references_number_ck');
select rlstest.err('number "12 3" (inner space) is refused', $q$update public.lane_references set its_reference_load = '12 3' where its_reference_load = '9031'$q$, 'lane_references_number_ck');
select rlstest.err('number "" (empty) is refused', $q$update public.lane_references set its_reference_load = '' where its_reference_load = '9031'$q$, 'lane_references_number_ck');
select rlstest.err('number "-5" is refused', $q$update public.lane_references set its_reference_load = '-5' where its_reference_load = '9031'$q$, 'lane_references_number_ck');
select rlstest.err('number "5-" is refused', $q$update public.lane_references set its_reference_load = '5-' where its_reference_load = '9031'$q$, 'lane_references_number_ck');
select rlstest.err('number "1-2-3" is refused', $q$update public.lane_references set its_reference_load = '1-2-3' where its_reference_load = '9031'$q$, 'lane_references_number_ck');
select rlstest.err('number "12a" is refused', $q$update public.lane_references set its_reference_load = '12a' where its_reference_load = '9031'$q$, 'lane_references_number_ck');
select rlstest.err('a 31 character number is refused', $q$update public.lane_references set its_reference_load = repeat('7', 31) where its_reference_load = '9031'$q$, 'lane_references_number_ck');
select rlstest.ok('control: a 30 character number is accepted', $q$update public.lane_references set its_reference_load = repeat('7', 30) where its_reference_load = '9031'$q$);
select rlstest.err('a null number is refused', $q$update public.lane_references set its_reference_load = null where its_reference_load = repeat('7', 30)$q$, 'null value');
select rlstest.rows('cleanup: the three test rows are removed', $q$delete from public.lane_references where its_reference_load in ('313-2', repeat('7', 30), '9032')$q$, 3);
do $t$
begin
  perform rlstest.chk('after the constraint tests the table holds the owner set again',
    (select count(*) from public.lane_references) = 25
    and (select count(*) from (select shipper, receiver, size, its from rlstest.lane_exp except select * from rlstest.lane_actual()) q) = 0);
end $t$;

-- 15g. the seed is idempotent: apply the REAL migration file again (twice), still the same 25 rows ------------------------
-- (a hand edited number is put back to the owner's number, a second apply adds nothing)
select rlstest.rows('idempotency setup: one seeded row is edited by hand first (1269 becomes 1)', $q$update public.lane_references set its_reference_load = '1' where its_reference_load = '1269'$q$, 1);
\i supabase/migrations/0016_lane_references_seed.sql
do $t$
begin
  perform rlstest.chk('0016 applied again: 25 rows, the same set, the edited number is back to 1269',
    (select count(*) from public.lane_references) = 25
    and (select count(*) from (select shipper, receiver, size, its from rlstest.lane_exp except select * from rlstest.lane_actual()) q) = 0);
end $t$;
\i supabase/migrations/0016_lane_references_seed.sql
do $t$
begin
  perform rlstest.chk('0016 applied a third time: still 25 rows, still the same set',
    (select count(*) from public.lane_references) = 25
    and (select count(*) from (select * from rlstest.lane_actual() except select shipper, receiver, size, its from rlstest.lane_exp) q) = 0);
  perform rlstest.chk('0016 applied again: the 7 sites and SAMIH require Moffett and no other location was turned on',
    (select count(*) from public.locations where requires_moffett and name not in ('SAMIH', '1HAM', '152 Sh', '831 Queen', 'Glengarry', 'Kitney site', 'Military Trailsite', 'PrimeFab')) = 0
    and (select count(*) from public.locations where requires_moffett and name in ('SAMIH', '1HAM', '152 Sh', '831 Queen', 'Glengarry', 'Kitney site', 'Military Trailsite', 'PrimeFab')) = 8);
end $t$;

-- 15h. all or nothing: a missing location name raises and writes nothing -----------------------------------------------
savepoint lane_a;
delete from public.lane_references;
update public.locations set name = 'Howden RENAMED' where name = 'Howden';
update public.locations set requires_moffett = false where name = '1HAM';
savepoint lane_b;
\set ON_ERROR_STOP off
\i supabase/migrations/0016_lane_references_seed.sql
\set ON_ERROR_STOP on
rollback to savepoint lane_b;
-- the results are carried out of the savepoint with \gset (rlstest.res rows written inside it would be rolled back too)
select (select count(*) from public.locations where name = 'Howden RENAMED') = 1
         and (select not requires_moffett from public.locations where name = '1HAM') as g_setup,
       (select count(*) from public.lane_references) = 0 as g_nolanes,
       (select not requires_moffett from public.locations where name = '1HAM') as g_nomoffett \gset
rollback to savepoint lane_a;
select rlstest.chk('guard: the setup was in place (lane table emptied, Howden renamed, 1HAM Moffett off)', :'g_setup'::boolean);
select rlstest.chk('a missing location name: the migration wrote NO lane row at all (the resolvable lanes were not inserted)', :'g_nolanes'::boolean);
select rlstest.chk('a missing location name: the Moffett update did not run either (1HAM still off)', :'g_nomoffett'::boolean);
do $t$
begin
  perform rlstest.chk('after the rollback of the failed apply the owner set is back (25 rows) and Howden has its name',
    (select count(*) from public.lane_references) = 25 and (select count(*) from public.locations where name = 'Howden') = 1);
end $t$;

-- 16. Rate requests (0017): customers request, staff quote through a function, nobody deletes -------------------------
-- Ids are fixed so the statements below can name them. Rows are written as the table owner (no auth.uid(), so the
-- insert trigger keeps what is sent); the client paths are then tested as each role.
insert into auth.users (id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000000c3', 'authenticated', 'authenticated', 'maria2@t.test');
insert into public.profiles (id, email, role, customer_id, carrier_id) values
  ('00000000-0000-0000-0000-0000000000c3', 'maria2@t.test', 'customer', (select id from public.customers where name = 'Mitrex'), null);
insert into public.rate_requests (id, customer_id, requested_by, pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, notes) values
  ('40000000-0000-0000-0000-000000000001', (select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c1', 'Toronto', 'ON', 'Buffalo', 'NY', 53, 'RQ-A open'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000c2', 'Windsor', 'ON', 'Detroit', 'MI', 36, 'RQ-B other customer open');

-- 16a. grants, flags, policies, definitions ---------------------------------------------------------------------------
do $t$
begin
  perform rlstest.chk('rate_requests: RLS is enabled', (select relrowsecurity from pg_class where oid = 'public.rate_requests'::regclass));
  perform rlstest.chk('rate_requests: anon holds no table privilege (grants only, never called as anon)',
    not has_table_privilege('anon', 'public.rate_requests', 'select') and not has_table_privilege('anon', 'public.rate_requests', 'insert')
    and not has_table_privilege('anon', 'public.rate_requests', 'update') and not has_table_privilege('anon', 'public.rate_requests', 'delete'));
  perform rlstest.chk('rate_requests: PUBLIC holds no privilege',
    not exists (select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where c.oid = 'public.rate_requests'::regclass and a.grantee = 0));
  perform rlstest.chk('control: authenticated holds select and insert on rate_requests', has_table_privilege('authenticated', 'public.rate_requests', 'select') and has_any_column_privilege('authenticated', 'public.rate_requests', 'insert'));
  perform rlstest.chk('rate_requests: authenticated holds no update, delete, truncate, references or trigger',
    not has_table_privilege('authenticated', 'public.rate_requests', 'update') and not has_table_privilege('authenticated', 'public.rate_requests', 'delete')
    and not has_table_privilege('authenticated', 'public.rate_requests', 'truncate') and not has_table_privilege('authenticated', 'public.rate_requests', 'references')
    and not has_table_privilege('authenticated', 'public.rate_requests', 'trigger'));
  perform rlstest.chk('rate_requests: no column UPDATE privilege on any column for authenticated',
    (select count(*) from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'rate_requests'
       and has_column_privilege('authenticated', 'public.rate_requests', c.column_name, 'update')) = 0);
  perform rlstest.chk('rate_requests: the INSERT grant is column level and names exactly the 9 request columns',
    (select count(*) from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'rate_requests'
       and has_column_privilege('authenticated', 'public.rate_requests', c.column_name, 'insert')) = 9
    and has_column_privilege('authenticated', 'public.rate_requests', 'pickup_city', 'insert')
    and has_column_privilege('authenticated', 'public.rate_requests', 'customer_id', 'insert'));
  perform rlstest.chk('rate_requests: no INSERT privilege on id, ref, requested_by, status, any quote column or timestamp',
    (select count(*) from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'rate_requests'
       and c.column_name in ('id','ref','requested_by','status','quoted_amount','quoted_currency','quote_notes','quote_valid_until','quoted_by','quoted_at','created_at','updated_at')
       and has_column_privilege('authenticated', 'public.rate_requests', c.column_name, 'insert')) = 0);
  perform rlstest.chk('rate_requests: exactly two policies (select, insert), authenticated only, no update, delete or all policy',
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'rate_requests') = 2
    and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'rate_requests' and cmd in ('SELECT', 'INSERT') and roles = '{authenticated}') = 2);
  perform rlstest.chk('rate_requests: no policy is open (true) and none names a carrier role',
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'rate_requests'
       and coalesce(qual, '') !~ '(^|[^a-z_])true([^a-z_]|$)' and coalesce(with_check, '') !~ '(^|[^a-z_])true([^a-z_]|$)' and coalesce(qual, with_check) !~ 'carrier') = 2);
  perform rlstest.chk('anon has no EXECUTE on set_rate_quote', not has_function_privilege('anon', 'public.set_rate_quote(uuid, numeric, text, text, date)', 'execute'));
  perform rlstest.chk('anon has no EXECUTE on cancel_rate_request', not has_function_privilege('anon', 'public.cancel_rate_request(uuid)', 'execute'));
  perform rlstest.chk('control: authenticated has EXECUTE on set_rate_quote and cancel_rate_request',
    has_function_privilege('authenticated', 'public.set_rate_quote(uuid, numeric, text, text, date)', 'execute') and has_function_privilege('authenticated', 'public.cancel_rate_request(uuid)', 'execute'));
  perform rlstest.chk('the insert trigger function is not executable by anon or authenticated',
    not has_function_privilege('anon', 'public.dlv_rate_requests_before_insert()', 'execute') and not has_function_privilege('authenticated', 'public.dlv_rate_requests_before_insert()', 'execute'));
  perform rlstest.chk('control: the insert trigger function is executable by service_role', has_function_privilege('service_role', 'public.dlv_rate_requests_before_insert()', 'execute'));
  perform rlstest.chk('set_rate_quote and cancel_rate_request are SECURITY DEFINER with a fixed search_path',
    (select count(*) from pg_proc where oid in ('public.set_rate_quote(uuid, numeric, text, text, date)'::regprocedure, 'public.cancel_rate_request(uuid)'::regprocedure)
       and prosecdef and exists (select 1 from unnest(proconfig) c where c like 'search_path=%')) = 2);
  perform rlstest.chk('control: the realtime publication exists and carries loads', exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'loads'));
  perform rlstest.chk('rate_requests is NOT in the realtime publication', not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'rate_requests'));
  perform rlstest.chk('rate_requests has no foreign key to or from loads (a rate request is not a load)',
    (select count(*) from pg_constraint where contype = 'f' and (conrelid = 'public.rate_requests'::regclass and confrelid = 'public.loads'::regclass or confrelid = 'public.rate_requests'::regclass)) = 0);
  perform rlstest.chk('the owner inserted fixtures are in place (guard)', (select count(*) from public.rate_requests where id in ('40000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002')) = 2);
end $t$;

-- 16b. customer insert -------------------------------------------------------------------------------------------------
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.ok('maria inserts a rate request (padded city, lower case state, blank dims)',
  $q$insert into public.rate_requests (customer_id, pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, weight_lbs, dims, notes)
     values ((select id from public.customers where name = 'Mitrex'), '  Toronto ', 'on', 'Chicago', 'il', 26, 12000, '   ', 'maria made')$q$);
select rlstest.err('maria cannot name status on insert', $q$insert into public.rate_requests (customer_id, pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, status)
  values ((select id from public.customers where name = 'Mitrex'), 'A', 'ON', 'B', 'NY', 26, 'quoted')$q$, 'permission denied');
select rlstest.err('maria cannot name a quote amount on insert', $q$insert into public.rate_requests (customer_id, pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, quoted_amount)
  values ((select id from public.customers where name = 'Mitrex'), 'A', 'ON', 'B', 'NY', 26, 1)$q$, 'permission denied');
select rlstest.err('maria cannot name requested_by on insert', $q$insert into public.rate_requests (customer_id, requested_by, pickup_city, pickup_state, delivery_city, delivery_state, equipment_size)
  values ((select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c2', 'A', 'ON', 'B', 'NY', 26)$q$, 'permission denied');
select rlstest.err('maria cannot name ref or id on insert', $q$insert into public.rate_requests (id, ref, customer_id, pickup_city, pickup_state, delivery_city, delivery_state, equipment_size)
  values (gen_random_uuid(), 'RQ-9999', (select id from public.customers where name = 'Mitrex'), 'A', 'ON', 'B', 'NY', 26)$q$, 'permission denied');
select rlstest.err('maria cannot insert for ANOTHER customer', $q$insert into public.rate_requests (customer_id, pickup_city, pickup_state, delivery_city, delivery_state, equipment_size)
  values ('10000000-0000-0000-0000-000000000002', 'A', 'ON', 'B', 'NY', 26)$q$, 'row-level security');
select rlstest.back();
do $t$
begin
  perform rlstest.chk('maria row: requested_by is maria, status open, no quote, ref RQ-nnnn, text normalised, blank dims is null',
    (select count(*) from public.rate_requests where notes = 'maria made' and requested_by = '00000000-0000-0000-0000-0000000000c1' and status = 'open'
       and quoted_amount is null and quoted_currency is null and quoted_by is null and quoted_at is null and quote_notes is null and quote_valid_until is null
       and ref ~ '^RQ-[0-9]{4,}$' and pickup_city = 'Toronto' and pickup_state = 'ON' and delivery_state = 'IL' and dims is null and weight_lbs = 12000) = 1);
  perform rlstest.chk('the refused maria inserts left no row (only the two fixtures and the one valid insert exist)', (select count(*) from public.rate_requests) = 3);
end $t$;
select rlstest.as_user('00000000-0000-0000-0000-0000000000c3');
select rlstest.ok('control: a second Mitrex user inserts too', $q$insert into public.rate_requests (customer_id, pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, notes)
  values ((select id from public.customers where name = 'Mitrex'), 'Oshawa', 'ON', 'Albany', 'NY', 36, 'maria2 made')$q$);
select rlstest.back();
create function rlstest.rq_insert_denied(p_who text, p_uid uuid) returns void language plpgsql as $f$
begin
  perform rlstest.as_user(p_uid);
  perform rlstest.err(p_who || ' cannot INSERT a rate request',
    $q$insert into public.rate_requests (customer_id, pickup_city, pickup_state, delivery_city, delivery_state, equipment_size)
       values ((select id from public.customers where name = 'Mitrex'), 'A', 'ON', 'B', 'NY', 26)$q$, 'row-level security');
  perform rlstest.back();
end $f$;
grant execute on function rlstest.rq_insert_denied(text, uuid) to authenticated, anon;
select rlstest.rq_insert_denied('staff_admin', '00000000-0000-0000-0000-0000000000a1');
select rlstest.rq_insert_denied('staff_csr', '00000000-0000-0000-0000-0000000000a2');
select rlstest.rq_insert_denied('carrier owner', '00000000-0000-0000-0000-0000000000b1');
select rlstest.rq_insert_denied('carrier driver', '00000000-0000-0000-0000-0000000000b2');
select rlstest.set_active('00000000-0000-0000-0000-0000000000c3', false);
select rlstest.rq_insert_denied('inactive customer user', '00000000-0000-0000-0000-0000000000c3');
select rlstest.set_active('00000000-0000-0000-0000-0000000000c3', true);
select rlstest.as_user('00000000-0000-0000-0000-0000000000c3');
select rlstest.ok('control: the same customer user inserts once active again', $q$insert into public.rate_requests (customer_id, pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, notes)
  values ((select id from public.customers where name = 'Mitrex'), 'Oshawa', 'ON', 'Albany', 'NY', 36, 'maria2 again')$q$);
select rlstest.back();

-- 16c. who reads what --------------------------------------------------------------------------------------------------
-- 5 rows now: Mitrex has A, 'maria made', 'maria2 made', 'maria2 again' (4); the other customer has B (1).
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.cnt('maria reads the 4 Mitrex requests, including a colleague''s', 'select 1 from public.rate_requests', 4);
select rlstest.cnt('maria cannot read the other customer''s request (row exists: guard)', format($q$select 1 from public.rate_requests where id = %L$q$, '40000000-0000-0000-0000-000000000002'), 0, format($q$select 1 from public.rate_requests where id = %L$q$, '40000000-0000-0000-0000-000000000002'));
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000c2');
select rlstest.cnt('the other customer reads exactly its 1 request', 'select 1 from public.rate_requests', 1);
select rlstest.cnt('the other customer cannot read a Mitrex request (row exists: guard)', format($q$select 1 from public.rate_requests where id = %L$q$, '40000000-0000-0000-0000-000000000001'), 0, format($q$select 1 from public.rate_requests where id = %L$q$, '40000000-0000-0000-0000-000000000001'));
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.cnt('staff_admin reads all 5', 'select 1 from public.rate_requests', 5);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.cnt('staff_csr reads all 5', 'select 1 from public.rate_requests', 5);
select rlstest.back();
create function rlstest.rq_read_denied(p_who text, p_uid uuid) returns void language plpgsql as $f$
begin
  perform rlstest.as_user(p_uid);
  perform rlstest.cnt(p_who || ' reads no rate request (rows exist: guard)', 'select 1 from public.rate_requests', 0, 'select 1 from public.rate_requests');
  perform rlstest.back();
end $f$;
grant execute on function rlstest.rq_read_denied(text, uuid) to authenticated, anon;
select rlstest.rq_read_denied('carrier owner', '00000000-0000-0000-0000-0000000000b1');
select rlstest.rq_read_denied('carrier driver', '00000000-0000-0000-0000-0000000000b2');
select rlstest.set_active('00000000-0000-0000-0000-0000000000c1', false);
select rlstest.rq_read_denied('inactive customer', '00000000-0000-0000-0000-0000000000c1');
select rlstest.set_active('00000000-0000-0000-0000-0000000000c1', true);
select rlstest.set_active('00000000-0000-0000-0000-0000000000a3', false);
select rlstest.rq_read_denied('inactive staff_admin', '00000000-0000-0000-0000-0000000000a3');
select rlstest.set_active('00000000-0000-0000-0000-0000000000a3', true);
select rlstest.as_user('00000000-0000-0000-0000-0000000000a3');
select rlstest.cnt('control: the same admin reads all 5 once active again', 'select 1 from public.rate_requests', 5);
select rlstest.back();

-- 16d. no direct UPDATE or DELETE for any client role -------------------------------------------------------------------
create function rlstest.rq_write_denied(p_who text, p_uid uuid) returns void language plpgsql as $f$
begin
  perform rlstest.as_user(p_uid);
  perform rlstest.err(p_who || ' cannot UPDATE status directly', format($q$update public.rate_requests set status = 'cancelled' where id = %L$q$, '40000000-0000-0000-0000-000000000001'), 'permission denied');
  perform rlstest.err(p_who || ' cannot UPDATE quote fields directly', $q$update public.rate_requests set quoted_amount = 1, quoted_currency = 'CAD', status = 'quoted'$q$, 'permission denied');
  perform rlstest.err(p_who || ' cannot DELETE a rate request', $q$delete from public.rate_requests$q$, 'permission denied');
  perform rlstest.back();
end $f$;
grant execute on function rlstest.rq_write_denied(text, uuid) to authenticated, anon;
select rlstest.rq_write_denied('maria', '00000000-0000-0000-0000-0000000000c1');
select rlstest.rq_write_denied('other customer', '00000000-0000-0000-0000-0000000000c2');
select rlstest.rq_write_denied('staff_admin', '00000000-0000-0000-0000-0000000000a1');
select rlstest.rq_write_denied('staff_csr', '00000000-0000-0000-0000-0000000000a2');
select rlstest.rq_write_denied('carrier owner', '00000000-0000-0000-0000-0000000000b1');
do $t$
begin
  perform rlstest.chk('after the refused writes all 5 rows are open and unquoted (guard: they exist)',
    (select count(*) from public.rate_requests) = 5 and (select count(*) from public.rate_requests where status = 'open' and quoted_amount is null) = 5);
end $t$;

-- 16e. set_rate_quote: active staff only --------------------------------------------------------------------------------
create function rlstest.rq_quote_denied(p_who text, p_uid uuid) returns void language plpgsql as $f$
begin
  perform rlstest.as_user(p_uid);
  perform rlstest.err(p_who || ' cannot call set_rate_quote', format($q$select public.set_rate_quote(%L, 1500, 'CAD', 'x', null)$q$, '40000000-0000-0000-0000-000000000001'), 'not authorized');
  perform rlstest.back();
end $f$;
grant execute on function rlstest.rq_quote_denied(text, uuid) to authenticated, anon;
select rlstest.rq_quote_denied('maria', '00000000-0000-0000-0000-0000000000c1');
select rlstest.rq_quote_denied('other customer', '00000000-0000-0000-0000-0000000000c2');
select rlstest.rq_quote_denied('carrier owner', '00000000-0000-0000-0000-0000000000b1');
select rlstest.rq_quote_denied('carrier driver', '00000000-0000-0000-0000-0000000000b2');
select rlstest.set_active('00000000-0000-0000-0000-0000000000a3', false);
select rlstest.rq_quote_denied('inactive staff_admin', '00000000-0000-0000-0000-0000000000a3');
select rlstest.set_active('00000000-0000-0000-0000-0000000000a3', true);
do $t$
begin
  perform rlstest.chk('after the refused quote calls request A is still open and unquoted (guard: it exists)',
    (select count(*) from public.rate_requests where id = '40000000-0000-0000-0000-000000000001' and status = 'open' and quoted_amount is null and quoted_by is null) = 1);
end $t$;
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.err('csr: amount 0 is refused', format($q$select public.set_rate_quote(%L, 0, 'CAD', null, null)$q$, '40000000-0000-0000-0000-000000000001'), 'amount must be greater than 0');
select rlstest.err('csr: a negative amount is refused', format($q$select public.set_rate_quote(%L, -5, 'CAD', null, null)$q$, '40000000-0000-0000-0000-000000000001'), 'amount must be greater than 0');
select rlstest.err('csr: a null amount is refused', format($q$select public.set_rate_quote(%L, null, 'CAD', null, null)$q$, '40000000-0000-0000-0000-000000000001'), 'amount must be greater than 0');
select rlstest.err('csr: an amount that rounds to 0.00 is refused', format($q$select public.set_rate_quote(%L, 0.004, 'CAD', null, null)$q$, '40000000-0000-0000-0000-000000000001'), 'amount must be greater than 0');
select rlstest.err('csr: an absurd amount is refused', format($q$select public.set_rate_quote(%L, 100000000, 'CAD', null, null)$q$, '40000000-0000-0000-0000-000000000001'), 'amount must be greater than 0');
select rlstest.err('csr: currency EUR is refused', format($q$select public.set_rate_quote(%L, 1500, 'EUR', null, null)$q$, '40000000-0000-0000-0000-000000000001'), 'currency must be CAD or USD');
select rlstest.err('csr: lower case currency is refused', format($q$select public.set_rate_quote(%L, 1500, 'cad', null, null)$q$, '40000000-0000-0000-0000-000000000001'), 'currency must be CAD or USD');
select rlstest.err('csr: a null currency is refused', format($q$select public.set_rate_quote(%L, 1500, null, null, null)$q$, '40000000-0000-0000-0000-000000000001'), 'currency must be CAD or USD');
select rlstest.err('csr: a past valid until is refused', format($q$select public.set_rate_quote(%L, 1500, 'CAD', null, '2000-01-01')$q$, '40000000-0000-0000-0000-000000000001'), 'valid until cannot be in the past');
select rlstest.err('csr: notes over 1000 characters are refused', format($q$select public.set_rate_quote(%L, 1500, 'CAD', repeat('n', 1001), null)$q$, '40000000-0000-0000-0000-000000000001'), 'notes are too long');
select rlstest.err('csr: an unknown request is refused', $q$select public.set_rate_quote('99999999-9999-9999-9999-999999999999', 1500, 'CAD', null, null)$q$, 'not found');
select rlstest.back();
do $t$
begin
  perform rlstest.chk('after the refused amounts, currencies and dates request A is still open and unquoted', (select count(*) from public.rate_requests where id = '40000000-0000-0000-0000-000000000001' and status = 'open' and quoted_amount is null) = 1);
end $t$;
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.chk('staff_csr quotes A: returns the previous status open',
  public.set_rate_quote('40000000-0000-0000-0000-000000000001', 1850.5, 'CAD', '  fuel included ', current_date + 30) = 'open');
select rlstest.back();
do $t$
begin
  perform rlstest.chk('request A is quoted: amount 1850.50 CAD, trimmed notes, valid until, quoted_by csr, quoted_at set, updated_at moved',
    (select count(*) from public.rate_requests where id = '40000000-0000-0000-0000-000000000001' and status = 'quoted' and quoted_amount = 1850.50 and quoted_currency = 'CAD' and quote_notes = 'fuel included'
       and quote_valid_until = current_date + 30 and quoted_by = '00000000-0000-0000-0000-0000000000a2' and quoted_at is not null and updated_at >= quoted_at) = 1);
end $t$;
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.chk('staff_admin corrects the rate on A: returns the previous status quoted',
  public.set_rate_quote('40000000-0000-0000-0000-000000000001', 1900, 'USD', null, null) = 'quoted');
select rlstest.back();
do $t$
begin
  perform rlstest.chk('the correction replaced every quote field and restamped the actor (admin, USD, no notes, no valid until)',
    (select count(*) from public.rate_requests where id = '40000000-0000-0000-0000-000000000001' and status = 'quoted' and quoted_amount = 1900 and quoted_currency = 'USD' and quote_notes is null
       and quote_valid_until is null and quoted_by = '00000000-0000-0000-0000-0000000000a1') = 1);
end $t$;
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.cnt('maria sees the quote on A (status quoted, amount 1900 USD)', format($q$select 1 from public.rate_requests where id = %L and status = 'quoted' and quoted_amount = 1900 and quoted_currency = 'USD'$q$, '40000000-0000-0000-0000-000000000001'), 1);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000c2');
select rlstest.cnt('the other customer does not see the quote on A (row exists: guard)', format($q$select 1 from public.rate_requests where id = %L$q$, '40000000-0000-0000-0000-000000000001'), 0, format($q$select 1 from public.rate_requests where id = %L$q$, '40000000-0000-0000-0000-000000000001'));
select rlstest.back();

-- 16f. cancel_rate_request: the customer of the request, open only ----------------------------------------------------------
create function rlstest.rq_cancel_denied(p_who text, p_uid uuid, p_id uuid) returns void language plpgsql as $f$
begin
  perform rlstest.as_user(p_uid);
  perform rlstest.err(p_who || ' cannot cancel request B', format($q$select public.cancel_rate_request(%L)$q$, p_id), 'not authorized');
  perform rlstest.back();
end $f$;
grant execute on function rlstest.rq_cancel_denied(text, uuid, uuid) to authenticated, anon;
select rlstest.rq_cancel_denied('staff_admin', '00000000-0000-0000-0000-0000000000a1', '40000000-0000-0000-0000-000000000002');
select rlstest.rq_cancel_denied('staff_csr', '00000000-0000-0000-0000-0000000000a2', '40000000-0000-0000-0000-000000000002');
select rlstest.rq_cancel_denied('carrier owner', '00000000-0000-0000-0000-0000000000b1', '40000000-0000-0000-0000-000000000002');
select rlstest.rq_cancel_denied('carrier driver', '00000000-0000-0000-0000-0000000000b2', '40000000-0000-0000-0000-000000000002');
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.err('maria cannot cancel the OTHER customer''s open request (reads as not found)', format($q$select public.cancel_rate_request(%L)$q$, '40000000-0000-0000-0000-000000000002'), 'not found');
select rlstest.err('maria cannot cancel an unknown id', $q$select public.cancel_rate_request('99999999-9999-9999-9999-999999999999')$q$, 'not found');
select rlstest.err('maria cannot cancel a QUOTED request of her own (A)', format($q$select public.cancel_rate_request(%L)$q$, '40000000-0000-0000-0000-000000000001'), 'only an open request');
select rlstest.back();
do $t$
begin
  perform rlstest.chk('after the refused cancels B is still open and A is still quoted (guard: both exist)',
    (select count(*) from public.rate_requests where id = '40000000-0000-0000-0000-000000000002' and status = 'open') = 1 and (select count(*) from public.rate_requests where id = '40000000-0000-0000-0000-000000000001' and status = 'quoted') = 1);
end $t$;
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.ok('control: maria cancels her own open request', $q$select public.cancel_rate_request((select id from public.rate_requests where notes = 'maria made'))$q$);
select rlstest.err('maria cancelling it again is refused', $q$select public.cancel_rate_request((select id from public.rate_requests where notes = 'maria made'))$q$, 'only an open request');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000c3');
select rlstest.ok('control: a colleague of the same customer cancels a request made by maria2 (customer wide)', $q$select public.cancel_rate_request((select id from public.rate_requests where notes = 'maria2 made'))$q$);
select rlstest.back();
do $t$
begin
  perform rlstest.chk('the two cancelled rows are cancelled with no quote fields; the other customer''s B and the untouched row stay open',
    (select count(*) from public.rate_requests where notes in ('maria made', 'maria2 made') and status = 'cancelled' and quoted_amount is null and quoted_by is null) = 2
    and (select count(*) from public.rate_requests where id = '40000000-0000-0000-0000-000000000002' and status = 'open') = 1
    and (select count(*) from public.rate_requests where notes = 'maria2 again' and status = 'open') = 1);
end $t$;
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.err('staff cannot quote a cancelled request', $q$select public.set_rate_quote((select id from public.rate_requests where notes = 'maria made'), 1500, 'CAD', null, null)$q$, 'was cancelled');
select rlstest.ok('control: staff quotes the other customer''s open request B', format($q$select public.set_rate_quote(%L, 2200, 'CAD', 'ok', null)$q$, '40000000-0000-0000-0000-000000000002'));
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000c2');
select rlstest.err('the other customer cannot cancel its own request once it is quoted', format($q$select public.cancel_rate_request(%L)$q$, '40000000-0000-0000-0000-000000000002'), 'only an open request');
select rlstest.back();

-- 16g. constraints (as the table owner: RLS bypassed, so only the constraint can refuse) -------------------------------------
create function rlstest.rq_row(p_cols text, p_vals text) returns text language sql as $f$
  select format($q$insert into public.rate_requests (customer_id, requested_by, %s) values ((select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c1', %s)$q$, p_cols, p_vals) $f$;
select rlstest.ok('control: a valid owner insert', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size', $v$'A', 'on', 'B', 'qc', 53$v$));
select rlstest.err('state ZZ is refused', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size', $v$'A', 'ZZ', 'B', 'NY', 53$v$), 'rate_requests_state_ck');
select rlstest.err('state ONT (3 letters) is refused', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size', $v$'A', 'ON', 'B', 'ONT', 53$v$), 'rate_requests_state_ck');
select rlstest.err('state "O" (1 letter) is refused', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size', $v$'A', 'O', 'B', 'NY', 53$v$), 'rate_requests_state_ck');
select rlstest.err('a blank city is refused', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size', $v$'   ', 'ON', 'B', 'NY', 53$v$), 'rate_requests_city_ck');
select rlstest.err('an 81 character city is refused', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size', $v$'A', 'ON', repeat('c', 81), 'NY', 53$v$), 'rate_requests_city_ck');
select rlstest.ok('control: an 80 character city is accepted', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size', $v$'A', 'ON', repeat('c', 80), 'NY', 53$v$));
select rlstest.err('size 48 is refused', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size', $v$'A', 'ON', 'B', 'NY', 48$v$), 'rate_requests_size_ck');
select rlstest.err('size null is refused', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size', $v$'A', 'ON', 'B', 'NY', null$v$), 'null value');
select rlstest.err('weight 0 is refused', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, weight_lbs', $v$'A', 'ON', 'B', 'NY', 53, 0$v$), 'rate_requests_weight_ck');
select rlstest.err('weight 100001 is refused', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, weight_lbs', $v$'A', 'ON', 'B', 'NY', 53, 100001$v$), 'rate_requests_weight_ck');
select rlstest.ok('control: weight 100000 is accepted', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, weight_lbs', $v$'A', 'ON', 'B', 'NY', 53, 100000$v$));
select rlstest.err('notes of 1001 characters are refused', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, notes', $v$'A', 'ON', 'B', 'NY', 53, repeat('n', 1001)$v$), 'rate_requests_notes_ck');
select rlstest.ok('control: notes of 1000 characters are accepted', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, notes', $v$'A', 'ON', 'B', 'NY', 53, repeat('n', 1000)$v$));
select rlstest.err('dims of 201 characters are refused', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, dims', $v$'A', 'ON', 'B', 'NY', 53, repeat('d', 201)$v$), 'rate_requests_dims_ck');
select rlstest.err('status "won" is refused', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, status', $v$'A', 'ON', 'B', 'NY', 53, 'won'$v$), 'rate_requests_status_ck');
select rlstest.err('quoted without an amount is refused', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, status', $v$'A', 'ON', 'B', 'NY', 53, 'quoted'$v$), 'rate_requests_quote_set_ck');
select rlstest.err('open WITH an amount is refused', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, quoted_amount, quoted_currency, quoted_by, quoted_at', $v$'A', 'ON', 'B', 'NY', 53, 5, 'CAD', '00000000-0000-0000-0000-0000000000a1', now()$v$), 'rate_requests_quote_set_ck');
select rlstest.err('open WITH quote notes is refused', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, quote_notes', $v$'A', 'ON', 'B', 'NY', 53, 'n'$v$), 'rate_requests_quote_set_ck');
select rlstest.err('quoted with a missing quoted_by is refused', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, status, quoted_amount, quoted_currency, quoted_at', $v$'A', 'ON', 'B', 'NY', 53, 'quoted', 5, 'CAD', now()$v$), 'rate_requests_quote_set_ck');
select rlstest.err('quoted with amount 0 is refused', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, status, quoted_amount, quoted_currency, quoted_by, quoted_at', $v$'A', 'ON', 'B', 'NY', 53, 'quoted', 0, 'CAD', '00000000-0000-0000-0000-0000000000a1', now()$v$), 'rate_requests_amount_ck');
select rlstest.err('quoted with currency EUR is refused', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, status, quoted_amount, quoted_currency, quoted_by, quoted_at', $v$'A', 'ON', 'B', 'NY', 53, 'quoted', 5, 'EUR', '00000000-0000-0000-0000-0000000000a1', now()$v$), 'rate_requests_currency_ck');
select rlstest.ok('control: a fully quoted owner insert is accepted', rlstest.rq_row('pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, status, quoted_amount, quoted_currency, quoted_by, quoted_at', $v$'A', 'ON', 'B', 'NY', 53, 'quoted', 5, 'CAD', '00000000-0000-0000-0000-0000000000a1', now()$v$));
select rlstest.err('an unknown customer is refused', $q$insert into public.rate_requests (customer_id, requested_by, pickup_city, pickup_state, delivery_city, delivery_state, equipment_size)
  values ('99999999-9999-9999-9999-999999999999', '00000000-0000-0000-0000-0000000000c1', 'A', 'ON', 'B', 'NY', 53)$q$, 'foreign key');
select rlstest.err('an unknown requested_by is refused', $q$insert into public.rate_requests (customer_id, requested_by, pickup_city, pickup_state, delivery_city, delivery_state, equipment_size)
  values ((select id from public.customers where name = 'Mitrex'), '99999999-9999-9999-9999-999999999999', 'A', 'ON', 'B', 'NY', 53)$q$, 'foreign key');
do $t$
begin
  perform rlstest.chk('refs are unique and all have the RQ-nnnn shape', (select count(distinct ref) = count(*) and bool_and(ref ~ '^RQ-[0-9]{4,}$') from public.rate_requests));
  perform rlstest.chk('no refused insert left a row (guard: the control rows exist)',
    (select count(*) from public.rate_requests where pickup_city = 'A' and delivery_state = 'QC') = 1 and (select count(*) from public.rate_requests where weight_lbs in (0, 100001)) = 0
    and (select count(*) from public.rate_requests where pickup_state = 'ZZ' or delivery_state in ('ONT')) = 0);
  perform rlstest.chk('a rate request created no load (no load carries a request note or an RQ po number)', (select count(*) from public.loads where notes like 'maria%' or po_number like 'RQ-%') = 0);
end $t$;

-- 16h. the migration is idempotent: apply the REAL file again, nothing changes -------------------------------------------------
create table rlstest.rq_before as select id, ref, status, quoted_amount from public.rate_requests;
\i supabase/migrations/0017_rate_requests.sql
do $t$
begin
  perform rlstest.chk('0017 applied again: the same rows, refs, statuses and amounts (guard: rows exist)',
    (select count(*) from rlstest.rq_before) > 5
    and (select count(*) from (select id, ref, status, quoted_amount from public.rate_requests except select * from rlstest.rq_before) q) = 0
    and (select count(*) from (select * from rlstest.rq_before except select id, ref, status, quoted_amount from public.rate_requests) q) = 0);
  perform rlstest.chk('0017 applied again: still exactly two policies, no update or delete privilege, anon still has no EXECUTE',
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'rate_requests') = 2
    and not has_table_privilege('authenticated', 'public.rate_requests', 'update') and not has_table_privilege('authenticated', 'public.rate_requests', 'delete')
    and not has_function_privilege('anon', 'public.set_rate_quote(uuid, numeric, text, text, date)', 'execute')
    and not has_function_privilege('anon', 'public.cancel_rate_request(uuid)', 'execute'));
end $t$;

-- 16i. database level rate cap (review fix): 30 recent requests by one user, the 31st direct insert is refused ----------------
insert into public.rate_requests (customer_id, requested_by, pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, notes)
  select (select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c3', 'Cap', 'ON', 'Cap', 'NY', 26, 'cap seed' from generate_series(1, 30);
select rlstest.as_user('00000000-0000-0000-0000-0000000000c3');
select rlstest.err('a user with 30 recent requests cannot insert a 31st directly', $q$insert into public.rate_requests (customer_id, pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, notes)
  values ((select id from public.customers where name = 'Mitrex'), 'A', 'ON', 'B', 'NY', 26, 'cap over')$q$, 'too many rate requests');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.ok('control: another user (under the cap) still inserts', $q$insert into public.rate_requests (customer_id, pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, notes)
  values ((select id from public.customers where name = 'Mitrex'), 'A', 'ON', 'B', 'NY', 26, 'cap control')$q$);
select rlstest.back();
do $t$
begin
  perform rlstest.chk('the cap refusal left no row (guard: the 30 seed rows and the control row exist)',
    (select count(*) from public.rate_requests where notes = 'cap seed') = 30 and (select count(*) from public.rate_requests where notes = 'cap control') = 1
    and (select count(*) from public.rate_requests where notes = 'cap over') = 0);
end $t$;

-- 18. load photos (0018) ------------------------------------------------------------------------------------------------------
\set LP1 '30000000-0000-0000-0000-0000000000e1'
\set LP2 '30000000-0000-0000-0000-0000000000e2'
\set LP3 '30000000-0000-0000-0000-0000000000e3'
\set LP4 '30000000-0000-0000-0000-0000000000e4'
\set LP5 '30000000-0000-0000-0000-0000000000e5'
\set LP6 '30000000-0000-0000-0000-0000000000e6'
\set LP7 '30000000-0000-0000-0000-0000000000e7'
\set LP8 '30000000-0000-0000-0000-0000000000e8'
\set LP9 '30000000-0000-0000-0000-0000000000e9'
-- LP1 booked A, LP2 at_pickup A, LP3 loading A, LP4 enroute A, LP5 at_delivery A, LP6 delivered A,
-- LP7 loading B (Maria's), LP8 delivered A owned by the OTHER customer, LP9 loading A (cap and delete tests)
select rlstest.mkload(:'LP1', 'booked', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload(:'LP2', 'at_pickup', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload(:'LP3', 'loading', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload(:'LP4', 'enroute', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload(:'LP5', 'at_delivery', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload(:'LP6', 'delivered', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload(:'LP7', 'loading', '20000000-0000-0000-0000-00000000000b');
select rlstest.mkload2(:'LP8', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000c2', 'delivered', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload(:'LP9', 'loading', '20000000-0000-0000-0000-00000000000a');
update public.loads set eta = now() + interval '5 hours' where id in (:'LP4', :'LP5');

-- 18a. the table shape (as the table owner, RLS bypassed)
select rlstest.ok('control: owner inserts a well-formed pickup_photo row', format($q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values (%L::uuid, 'pickup_photo', %L, '00000000-0000-0000-0000-0000000000b1')$q$, :'LP6', :'LP6' || '/pickup_photo/e0000000-0000-0000-0000-000000000001.jpg'));
select rlstest.ok('control: owner inserts a well-formed delivery_photo row (webp)', format($q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values (%L::uuid, 'delivery_photo', %L, '00000000-0000-0000-0000-0000000000b1')$q$, :'LP6', :'LP6' || '/delivery_photo/e0000000-0000-0000-0000-000000000002.webp'));
select rlstest.err('a photo kind cannot name a pdf', format($q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values (%L::uuid, 'pickup_photo', %L, '00000000-0000-0000-0000-0000000000b1')$q$, :'LP6', :'LP6' || '/pickup_photo/e0000000-0000-0000-0000-000000000003.pdf'), 'load_documents_path_ck');
select rlstest.err('a photo kind cannot name a heic file', format($q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values (%L::uuid, 'delivery_photo', %L, '00000000-0000-0000-0000-0000000000b1')$q$, :'LP6', :'LP6' || '/delivery_photo/e0000000-0000-0000-0000-000000000004.heic'), 'load_documents_path_ck');
select rlstest.err('the folder must equal the kind (pickup_photo row in the delivery_photo folder)', format($q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values (%L::uuid, 'pickup_photo', %L, '00000000-0000-0000-0000-0000000000b1')$q$, :'LP6', :'LP6' || '/delivery_photo/e0000000-0000-0000-0000-000000000005.jpg'), 'load_documents_path_ck');
select rlstest.err('an unknown kind is refused', format($q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values (%L::uuid, 'selfie', %L, '00000000-0000-0000-0000-0000000000b1')$q$, :'LP6', :'LP6' || '/selfie/e0000000-0000-0000-0000-000000000006.jpg'), 'load_documents_kind_check');
select rlstest.ok('control: a bol still takes a pdf', format($q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values (%L::uuid, 'bol', %L, '00000000-0000-0000-0000-0000000000a1')$q$, :'LP6', :'LP6' || '/bol/e0000000-0000-0000-0000-000000000007.pdf'));
do $t$
begin
  perform rlstest.chk('captured_at exists, is timestamptz and nullable',
    (select data_type = 'timestamp with time zone' and is_nullable = 'YES' from information_schema.columns
      where table_schema = 'public' and table_name = 'load_documents' and column_name = 'captured_at'));
end $t$;
-- the official time is the server time of the insert, whatever captured_at claims
insert into public.load_documents (load_id, kind, storage_path, uploaded_by, captured_at)
  values (:'LP6', 'delivery_photo', :'LP6' || '/delivery_photo/e0000000-0000-0000-0000-000000000008.jpg', '00000000-0000-0000-0000-0000000000b1', '2001-02-03 04:05:06+00');
do $t$
begin
  perform rlstest.chk('created_at is the server time (now), not the captured_at the browser sent (guard: both set)',
    (select captured_at = '2001-02-03 04:05:06+00' and created_at > now() - interval '1 minute' and created_at <= now() + interval '1 minute'
       from public.load_documents where storage_path like '%/e0000000-0000-0000-0000-000000000008.jpg'));
end $t$;

-- 18b. who may write a photo, and when (row and object)
insert into storage.objects (bucket_id, name, metadata) values
  ('documents', :'LP3' || '/pickup_photo/e1000000-0000-0000-0000-000000000020.jpg', '{"mimetype":"application/pdf"}'::jsonb);
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.err('carrier A cannot write a pickup photo while booked', rlstest.dins(:'LP1', 'pickup_photo', :'LP1' || '/pickup_photo/e1000000-0000-0000-0000-000000000001.jpg'), 'row-level security');
select rlstest.ok('control: carrier A writes a pickup photo at_pickup', rlstest.pdins(:'LP2', 'pickup_photo', :'LP2' || '/pickup_photo/e1000000-0000-0000-0000-000000000002.jpg'));
select rlstest.err('carrier A cannot write a delivery photo at_pickup', rlstest.dins(:'LP2', 'delivery_photo', :'LP2' || '/delivery_photo/e1000000-0000-0000-0000-000000000003.jpg'), 'row-level security');
select rlstest.ok('control: carrier A writes a pickup photo while loading', rlstest.pdins(:'LP3', 'pickup_photo', :'LP3' || '/pickup_photo/e1000000-0000-0000-0000-000000000004.jpg'));
select rlstest.err('carrier A cannot write a delivery photo while loading', rlstest.dins(:'LP3', 'delivery_photo', :'LP3' || '/delivery_photo/e1000000-0000-0000-0000-000000000005.jpg'), 'row-level security');
select rlstest.err('carrier A cannot write a pickup photo once enroute', rlstest.dins(:'LP4', 'pickup_photo', :'LP4' || '/pickup_photo/e1000000-0000-0000-0000-000000000006.jpg'), 'row-level security');
select rlstest.err('carrier A cannot write a delivery photo while enroute', rlstest.dins(:'LP4', 'delivery_photo', :'LP4' || '/delivery_photo/e1000000-0000-0000-0000-000000000007.jpg'), 'row-level security');
select rlstest.ok('control: carrier A writes a delivery photo at_delivery', rlstest.pdins(:'LP5', 'delivery_photo', :'LP5' || '/delivery_photo/e1000000-0000-0000-0000-000000000008.jpg'));
select rlstest.err('carrier A cannot write a pickup photo at_delivery', rlstest.dins(:'LP5', 'pickup_photo', :'LP5' || '/pickup_photo/e1000000-0000-0000-0000-000000000009.jpg'), 'row-level security');
select rlstest.err('carrier A cannot write a delivery photo once delivered', rlstest.dins(:'LP6', 'delivery_photo', :'LP6' || '/delivery_photo/e1000000-0000-0000-0000-00000000000a.jpg'), 'row-level security');
select rlstest.err('carrier A cannot write a photo to carrier B load (loading, so only the carrier is wrong)', rlstest.dins(:'LP7', 'pickup_photo', :'LP7' || '/pickup_photo/e1000000-0000-0000-0000-00000000000b.jpg'), 'row-level security');
select rlstest.err('a photo row is refused when its file is not an image (a stored pdf under a photo name)', rlstest.dins(:'LP3', 'pickup_photo', :'LP3' || '/pickup_photo/e1000000-0000-0000-0000-000000000020.jpg'), 'row-level security');
select rlstest.err('a photo row is refused when there is no file at all (the gate cannot be satisfied with an empty row)', rlstest.dins(:'LP3', 'pickup_photo', :'LP3' || '/pickup_photo/e1000000-0000-0000-0000-000000000021.jpg'), 'row-level security');
select rlstest.err('a photo row cannot name another load folder', rlstest.dins(:'LP3', 'pickup_photo', :'LP9' || '/pickup_photo/e1000000-0000-0000-0000-00000000000c.jpg'), 'row-level security|violates check');
select rlstest.ok('control: carrier A writes a pickup photo OBJECT while loading (image/jpeg)', format($q$insert into storage.objects (bucket_id, name, owner, metadata) values ('documents', %L, '00000000-0000-0000-0000-0000000000b1', '{"mimetype":"image/jpeg"}'::jsonb)$q$, :'LP3' || '/pickup_photo/e1000000-0000-0000-0000-00000000000d.jpg'));
select rlstest.err('a pdf mimetype is refused on a photo path (object)', format($q$insert into storage.objects (bucket_id, name, owner, metadata) values ('documents', %L, '00000000-0000-0000-0000-0000000000b1', '{"mimetype":"application/pdf"}'::jsonb)$q$, :'LP3' || '/pickup_photo/e1000000-0000-0000-0000-00000000000e.jpg'), 'row-level security');
select rlstest.err('a photo object with no declared mimetype is refused', format($q$insert into storage.objects (bucket_id, name, owner) values ('documents', %L, '00000000-0000-0000-0000-0000000000b1')$q$, :'LP3' || '/pickup_photo/e1000000-0000-0000-0000-00000000000f.jpg'), 'row-level security');
select rlstest.err('a photo object is refused in a closed window (enroute)', format($q$insert into storage.objects (bucket_id, name, owner, metadata) values ('documents', %L, '00000000-0000-0000-0000-0000000000b1', '{"mimetype":"image/jpeg"}'::jsonb)$q$, :'LP4' || '/pickup_photo/e1000000-0000-0000-0000-000000000010.jpg'), 'row-level security');
select rlstest.ok('control: a POD object needs no mimetype (rules unchanged)', format($q$insert into storage.objects (bucket_id, name, owner) values ('documents', %L, '00000000-0000-0000-0000-0000000000b1')$q$, :'LP4' || '/pod/e1000000-0000-0000-0000-000000000011.jpg'));
select rlstest.back();

select rlstest.as_user('00000000-0000-0000-0000-0000000000b2');
select rlstest.ok('control: a DRIVER of carrier A writes a pickup photo while loading', rlstest.pdins(:'LP3', 'pickup_photo', :'LP3' || '/pickup_photo/e1000000-0000-0000-0000-000000000012.jpg'));
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b3');
select rlstest.err('carrier B cannot write a photo to carrier A load', rlstest.dins(:'LP3', 'pickup_photo', :'LP3' || '/pickup_photo/e1000000-0000-0000-0000-000000000013.jpg'), 'row-level security');
select rlstest.ok('control: carrier B writes a pickup photo to its OWN loading load', rlstest.pdins(:'LP7', 'pickup_photo', :'LP7' || '/pickup_photo/e1000000-0000-0000-0000-000000000014.jpg'));
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.err('a customer cannot write a pickup photo (row)', rlstest.dins(:'LP3', 'pickup_photo', :'LP3' || '/pickup_photo/e1000000-0000-0000-0000-000000000015.jpg'), 'row-level security');
select rlstest.err('a customer cannot write a delivery photo (row)', rlstest.dins(:'LP5', 'delivery_photo', :'LP5' || '/delivery_photo/e1000000-0000-0000-0000-000000000016.jpg'), 'row-level security');
select rlstest.err('a customer cannot write a photo object', format($q$insert into storage.objects (bucket_id, name, owner, metadata) values ('documents', %L, '00000000-0000-0000-0000-0000000000c1', '{"mimetype":"image/jpeg"}'::jsonb)$q$, :'LP3' || '/pickup_photo/e1000000-0000-0000-0000-000000000017.jpg'), 'row-level security');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.ok('control: staff writes a pickup photo on a booked load (any status)', rlstest.pdins(:'LP1', 'pickup_photo', :'LP1' || '/pickup_photo/e1000000-0000-0000-0000-000000000018.jpg'));
select rlstest.ok('control: staff writes a delivery photo object on a delivered load', format($q$insert into storage.objects (bucket_id, name, owner, metadata) values ('documents', %L, '00000000-0000-0000-0000-0000000000a2', '{"mimetype":"image/png"}'::jsonb)$q$, :'LP6' || '/delivery_photo/e1000000-0000-0000-0000-000000000019.png'));
select rlstest.back();

-- 18c. who may read a photo, and when (customer by status; never another customer; never another carrier)
insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values
  (:'LP3', 'delivery_photo', :'LP3' || '/delivery_photo/e2000000-0000-0000-0000-000000000001.jpg', '00000000-0000-0000-0000-0000000000a1'),
  (:'LP4', 'pickup_photo', :'LP4' || '/pickup_photo/e2000000-0000-0000-0000-000000000002.jpg', '00000000-0000-0000-0000-0000000000a1'),
  (:'LP4', 'delivery_photo', :'LP4' || '/delivery_photo/e2000000-0000-0000-0000-000000000003.jpg', '00000000-0000-0000-0000-0000000000a1'),
  (:'LP5', 'pickup_photo', :'LP5' || '/pickup_photo/e2000000-0000-0000-0000-000000000004.jpg', '00000000-0000-0000-0000-0000000000a1'),
  (:'LP8', 'pickup_photo', :'LP8' || '/pickup_photo/e2000000-0000-0000-0000-000000000005.jpg', '00000000-0000-0000-0000-0000000000a1'),
  (:'LP8', 'delivery_photo', :'LP8' || '/delivery_photo/e2000000-0000-0000-0000-000000000006.jpg', '00000000-0000-0000-0000-0000000000a1');
insert into storage.objects (bucket_id, name, metadata) values
  ('documents', :'LP3' || '/pickup_photo/e1000000-0000-0000-0000-00000000000d.jpg', '{"mimetype":"image/jpeg"}'),
  ('documents', :'LP4' || '/pickup_photo/e2000000-0000-0000-0000-000000000002.jpg', '{"mimetype":"image/jpeg"}'),
  ('documents', :'LP6' || '/delivery_photo/e1000000-0000-0000-0000-000000000019.png', '{"mimetype":"image/png"}'),
  ('documents', :'LP8' || '/delivery_photo/e2000000-0000-0000-0000-000000000006.jpg', '{"mimetype":"image/jpeg"}')
  on conflict do nothing;
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.cnt('control: the customer sees the pickup photo once the load is enroute', format($q$select 1 from public.load_documents where load_id = %L and kind = 'pickup_photo'$q$, :'LP4'), 1);
select rlstest.cnt('control: the customer sees the pickup photo at_delivery', format($q$select 1 from public.load_documents where load_id = %L and kind = 'pickup_photo'$q$, :'LP5'), 1);
select rlstest.cnt('the customer sees NO pickup photo while the load is still loading', format($q$select 1 from public.load_documents where load_id = %L and kind = 'pickup_photo'$q$, :'LP3'), 0,
  format($q$select 1 from public.load_documents where load_id = %L and kind = 'pickup_photo'$q$, :'LP3'));
select rlstest.cnt('the customer sees NO delivery photo while the load is enroute', format($q$select 1 from public.load_documents where load_id = %L and kind = 'delivery_photo'$q$, :'LP4'), 0,
  format($q$select 1 from public.load_documents where load_id = %L and kind = 'delivery_photo'$q$, :'LP4'));
select rlstest.cnt('the customer sees NO delivery photo while the load is loading', format($q$select 1 from public.load_documents where load_id = %L and kind = 'delivery_photo'$q$, :'LP3'), 0,
  format($q$select 1 from public.load_documents where load_id = %L and kind = 'delivery_photo'$q$, :'LP3'));
select rlstest.cnt('control: the customer sees both photo kinds once delivered', format($q$select 1 from public.load_documents where load_id = %L and kind in ('pickup_photo','delivery_photo')$q$, :'LP6'), 3);
select rlstest.cnt('the customer cannot see the photos of ANOTHER customer load', format($q$select 1 from public.load_documents where load_id = %L$q$, :'LP8'), 0,
  format($q$select 1 from public.load_documents where load_id = %L$q$, :'LP8'));
select rlstest.cnt('the customer cannot list the objects of another customer load either', format($q$select 1 from storage.objects where bucket_id = 'documents' and name like %L$q$, :'LP8' || '/%'), 0,
  format($q$select 1 from storage.objects where bucket_id = 'documents' and name like %L$q$, :'LP8' || '/%'));
select rlstest.cnt('the customer sees NO pickup photo object while loading', format($q$select 1 from storage.objects where bucket_id = 'documents' and name like %L$q$, :'LP3' || '/pickup_photo/%'), 0,
  format($q$select 1 from storage.objects where bucket_id = 'documents' and name like %L$q$, :'LP3' || '/pickup_photo/%'));
select rlstest.cnt('control: the customer sees the pickup photo object once enroute', format($q$select 1 from storage.objects where bucket_id = 'documents' and name like %L$q$, :'LP4' || '/pickup_photo/%'), 1);
select rlstest.cnt('control: the customer sees the delivery photo object once delivered', format($q$select 1 from storage.objects where bucket_id = 'documents' and name like %L$q$, :'LP6' || '/delivery_photo/%'), 1);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000c2');
select rlstest.cnt('control: the other customer sees the photos of its own delivered load', format($q$select 1 from public.load_documents where load_id = %L$q$, :'LP8'), 2);
select rlstest.cnt('the other customer cannot see the first customer delivered photos', format($q$select 1 from public.load_documents where load_id = %L$q$, :'LP6'), 0,
  format($q$select 1 from public.load_documents where load_id = %L$q$, :'LP6'));
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b3');
select rlstest.cnt('carrier B cannot read carrier A photos', format($q$select 1 from public.load_documents where load_id = %L and kind in ('pickup_photo','delivery_photo')$q$, :'LP3'), 0,
  format($q$select 1 from public.load_documents where load_id = %L and kind in ('pickup_photo','delivery_photo')$q$, :'LP3'));
select rlstest.cnt('control: carrier B reads its own load photos', format($q$select 1 from public.load_documents where load_id = %L and kind = 'pickup_photo'$q$, :'LP7'), 1);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.cnt('control: carrier A reads the photos of its own loading load (pickup and the staff seeded delivery photo)', format($q$select 1 from public.load_documents where load_id = %L and kind in ('pickup_photo','delivery_photo')$q$, :'LP3'), 3);
select rlstest.back();

-- 18d. max 6 photos per kind per load (database trigger)
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.ok('cap: photo 1 of 6 on LP9', rlstest.pdins(:'LP9', 'pickup_photo', :'LP9' || '/pickup_photo/e3000000-0000-0000-0000-000000000001.jpg'));
select rlstest.ok('cap: photo 2 of 6 on LP9', rlstest.pdins(:'LP9', 'pickup_photo', :'LP9' || '/pickup_photo/e3000000-0000-0000-0000-000000000002.jpg'));
select rlstest.ok('cap: photo 3 of 6 on LP9', rlstest.pdins(:'LP9', 'pickup_photo', :'LP9' || '/pickup_photo/e3000000-0000-0000-0000-000000000003.jpg'));
select rlstest.ok('cap: photo 4 of 6 on LP9', rlstest.pdins(:'LP9', 'pickup_photo', :'LP9' || '/pickup_photo/e3000000-0000-0000-0000-000000000004.jpg'));
select rlstest.ok('cap: photo 5 of 6 on LP9', rlstest.pdins(:'LP9', 'pickup_photo', :'LP9' || '/pickup_photo/e3000000-0000-0000-0000-000000000005.jpg'));
select rlstest.ok('cap: photo 6 of 6 on LP9', rlstest.pdins(:'LP9', 'pickup_photo', :'LP9' || '/pickup_photo/e3000000-0000-0000-0000-000000000006.jpg'));
select rlstest.err('cap: the 7th pickup photo on LP9 is refused (file stored first, so only the cap can refuse)', rlstest.pdins(:'LP9', 'pickup_photo', :'LP9' || '/pickup_photo/e3000000-0000-0000-0000-000000000007.jpg'), 'at most 6 photos');
select rlstest.back();
do $t$
begin
  perform rlstest.chk('cap: exactly 6 pickup photos are stored on LP9 (the refusal left no row)',
    (select count(*) from public.load_documents where load_id = '30000000-0000-0000-0000-0000000000e9' and kind = 'pickup_photo') = 6);
end $t$;
-- the cap is per kind and per load: another kind and another load are unaffected; a staff insert is capped too
insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values
  (:'LP9', 'delivery_photo', :'LP9' || '/delivery_photo/e3000000-0000-0000-0000-000000000008.jpg', '00000000-0000-0000-0000-0000000000a1');
select rlstest.err('cap: the owner (table owner, no RLS) is capped as well', format($q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values (%L::uuid, 'pickup_photo', %L, '00000000-0000-0000-0000-0000000000a1')$q$, :'LP9', :'LP9' || '/pickup_photo/e3000000-0000-0000-0000-000000000009.jpg'), 'at most 6 photos');
select rlstest.ok('control: the cap does not touch a POD or BOL on the same load', format($q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values (%L::uuid, 'pod', %L, '00000000-0000-0000-0000-0000000000a1')$q$, :'LP9', :'LP9' || '/pod/e3000000-0000-0000-0000-00000000000a.jpg'));

-- 18e. delete_load_photo: the only delete path
create function rlstest.docid(p_path text) returns uuid language sql security definer as $f$
  select id from public.load_documents where storage_path = p_path $f$;
grant execute on function rlstest.docid(text) to authenticated;
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.err('carrier A cannot remove a photo uploaded by staff', format($q$select public.delete_load_photo((select id from public.load_documents where storage_path = %L))$q$, :'LP3' || '/delivery_photo/e2000000-0000-0000-0000-000000000001.jpg'), 'cannot remove');
select rlstest.err('carrier A cannot remove the photo of a driver (own photos only)', format($q$select public.delete_load_photo((select id from public.load_documents where storage_path = %L))$q$, :'LP3' || '/pickup_photo/e1000000-0000-0000-0000-000000000012.jpg'), 'cannot remove');
select rlstest.err('carrier A cannot remove a BOL with this function', format($q$select public.delete_load_photo((select id from public.load_documents where storage_path = %L))$q$, :'LP6' || '/bol/e0000000-0000-0000-0000-000000000007.pdf'), 'only photos');
select rlstest.err('carrier A cannot remove the photo of a closed step (enroute)', format($q$select public.delete_load_photo((select id from public.load_documents where storage_path = %L))$q$, :'LP4' || '/pickup_photo/e2000000-0000-0000-0000-000000000002.jpg'), 'cannot remove');
select rlstest.err('an unknown photo id is refused', $q$select public.delete_load_photo('00000000-0000-0000-0000-0000000000ff')$q$, 'photo not found');
do $t$
declare p text;
begin
  p := public.delete_load_photo((select id from public.load_documents where storage_path = '30000000-0000-0000-0000-0000000000e3/pickup_photo/e1000000-0000-0000-0000-000000000004.jpg'));
  perform rlstest.chk('control: carrier A removes its OWN photo while the step is open; the function returns its path', p = '30000000-0000-0000-0000-0000000000e3/pickup_photo/e1000000-0000-0000-0000-000000000004.jpg');
end $t$;
select rlstest.back();
do $t$
begin
  perform rlstest.chk('the removed photo row is gone and the refused ones are still there',
    (select count(*) from public.load_documents where storage_path = '30000000-0000-0000-0000-0000000000e3/pickup_photo/e1000000-0000-0000-0000-000000000004.jpg') = 0
    and (select count(*) from public.load_documents where storage_path in (
      '30000000-0000-0000-0000-0000000000e3/delivery_photo/e2000000-0000-0000-0000-000000000001.jpg',
      '30000000-0000-0000-0000-0000000000e3/pickup_photo/e1000000-0000-0000-0000-000000000012.jpg',
      '30000000-0000-0000-0000-0000000000e4/pickup_photo/e2000000-0000-0000-0000-000000000002.jpg')) = 3);
end $t$;
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.err('a customer cannot remove a photo', format($q$select public.delete_load_photo((select id from public.load_documents where storage_path = %L))$q$, :'LP4' || '/pickup_photo/e2000000-0000-0000-0000-000000000002.jpg'), 'cannot remove');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b3');
select rlstest.err('carrier B cannot remove a photo of carrier A (it cannot even see the id)', format($q$select public.delete_load_photo((select id from public.load_documents where storage_path = %L))$q$, :'LP3' || '/pickup_photo/e1000000-0000-0000-0000-000000000012.jpg'), 'photo not found');
select rlstest.err('carrier B cannot remove a photo of carrier A even with the id in hand', format($q$select public.delete_load_photo(%L::uuid)$q$, rlstest.docid(:'LP3' || '/pickup_photo/e1000000-0000-0000-0000-000000000012.jpg')), 'cannot remove');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.ok('control: staff removes any photo (even on a closed step)', format($q$select public.delete_load_photo((select id from public.load_documents where storage_path = %L))$q$, :'LP4' || '/pickup_photo/e2000000-0000-0000-0000-000000000002.jpg'));
select rlstest.err('staff cannot remove a BOL with this function either', format($q$select public.delete_load_photo((select id from public.load_documents where storage_path = %L))$q$, :'LP6' || '/bol/e0000000-0000-0000-0000-000000000007.pdf'), 'only photos');
select rlstest.err('nobody has a DELETE privilege on load_documents (staff direct delete)', format($q$delete from public.load_documents where load_id = %L$q$, :'LP3'), 'permission denied');
select rlstest.back();
do $t$
begin
  perform rlstest.chk('anon has no EXECUTE on delete_load_photo', not has_function_privilege('anon', 'public.delete_load_photo(uuid)', 'execute'));
  perform rlstest.chk('control: authenticated has EXECUTE on delete_load_photo', has_function_privilege('authenticated', 'public.delete_load_photo(uuid)', 'execute'));
  perform rlstest.chk('authenticated and anon have no EXECUTE on the cap trigger function',
    not has_function_privilege('authenticated', 'public.load_documents_photo_cap()', 'execute') and not has_function_privilege('anon', 'public.load_documents_photo_cap()', 'execute'));
  perform rlstest.chk('control: the cap trigger exists on load_documents',
    exists (select 1 from pg_trigger where tgrelid = 'public.load_documents'::regclass and tgname = 'load_documents_photo_cap' and not tgisinternal));
  perform rlstest.chk('control: authenticated still has no DELETE privilege on load_documents', not has_table_privilege('authenticated', 'public.load_documents', 'delete'));
  perform rlstest.chk('delete_load_photo and the cap trigger are SECURITY DEFINER with a pinned search_path',
    (select count(*) from pg_proc where oid in ('public.delete_load_photo(uuid)'::regprocedure, 'public.load_documents_photo_cap()'::regprocedure)
        and prosecdef and exists (select 1 from unnest(proconfig) c where c like 'search_path=%')) = 2);
end $t$;

-- 18f. set_load_status photo gates: carrier roles refused, staff exempt and the skip is recorded in the event note
select rlstest.mkload('30000000-0000-0000-0000-0000000000f1', 'loading', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload('30000000-0000-0000-0000-0000000000f2', 'at_delivery', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload('30000000-0000-0000-0000-0000000000f3', 'loading', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload('30000000-0000-0000-0000-0000000000f4', 'at_delivery', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkload('30000000-0000-0000-0000-0000000000f5', 'loading', '20000000-0000-0000-0000-00000000000a');
update public.loads set eta = now() + interval '5 hours' where id in ('30000000-0000-0000-0000-0000000000f2', '30000000-0000-0000-0000-0000000000f4');
select rlstest.chk('guard: F1..F5 exist and none has a photo', (select count(*) from public.loads where id::text like '30000000-0000-0000-0000-0000000000f%') = 5
  and (select count(*) from public.load_documents where load_id::text like '30000000-0000-0000-0000-0000000000f%') = 0);
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.err('carrier OWNER: loading to enroute is refused without a pickup photo', $q$select public.set_load_status('30000000-0000-0000-0000-0000000000f1', 'enroute', now() + interval '3 hours')$q$, 'photo of the loaded freight');
select rlstest.err('carrier OWNER: at_delivery to delivered is refused without a delivery photo', $q$select public.set_load_status('30000000-0000-0000-0000-0000000000f2', 'delivered')$q$, 'Take a delivery photo first');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b2');
select rlstest.err('carrier DRIVER: loading to enroute is refused without a pickup photo', $q$select public.set_load_status('30000000-0000-0000-0000-0000000000f1', 'enroute', now() + interval '3 hours')$q$, 'photo of the loaded freight');
select rlstest.err('carrier DRIVER: at_delivery to delivered is refused without a delivery photo', $q$select public.set_load_status('30000000-0000-0000-0000-0000000000f2', 'delivered')$q$, 'Take a delivery photo first');
select rlstest.ok('control: the driver adds the pickup photo', rlstest.pdins('30000000-0000-0000-0000-0000000000f1', 'pickup_photo', '30000000-0000-0000-0000-0000000000f1/pickup_photo/f1000000-0000-0000-0000-000000000001.jpg'));
select rlstest.ok('control: the driver then leaves for delivery', $q$select public.set_load_status('30000000-0000-0000-0000-0000000000f1', 'enroute', now() + interval '3 hours')$q$);
select rlstest.ok('control: the driver adds the delivery photo', rlstest.pdins('30000000-0000-0000-0000-0000000000f2', 'delivery_photo', '30000000-0000-0000-0000-0000000000f2/delivery_photo/f1000000-0000-0000-0000-000000000002.jpg'));
select rlstest.ok('control: the driver then marks delivered', $q$select public.set_load_status('30000000-0000-0000-0000-0000000000f2', 'delivered')$q$);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.ok('staff override loading to enroute works without a photo', $q$select public.set_load_status('30000000-0000-0000-0000-0000000000f3', 'enroute', now() + interval '3 hours', 'dispatch fix')$q$);
select rlstest.ok('staff next step at_delivery to delivered works without a photo and without a note', $q$select public.set_load_status('30000000-0000-0000-0000-0000000000f4', 'delivered')$q$);
select rlstest.ok('staff jump loading to delivered works without any photo', $q$select public.set_load_status('30000000-0000-0000-0000-0000000000f5', 'delivered', null, 'manual close')$q$);
select rlstest.back();
do $t$
declare n text;
begin
  select note into n from public.load_events where load_id = '30000000-0000-0000-0000-0000000000f3' and to_status = 'enroute';
  perform rlstest.chk('the staff skip of the pickup photo is in the event note, together with the staff note', n = 'dispatch fix. Staff skipped the pickup photo (none on file).', 'note=' || coalesce(n, 'null'));
  select note into n from public.load_events where load_id = '30000000-0000-0000-0000-0000000000f4' and to_status = 'delivered';
  perform rlstest.chk('the staff skip of the delivery photo is the whole note when staff gave none', n = 'Staff skipped the delivery photo (none on file).', 'note=' || coalesce(n, 'null'));
  select note into n from public.load_events where load_id = '30000000-0000-0000-0000-0000000000f5' and to_status = 'delivered';
  perform rlstest.chk('a staff jump over both steps records the missing delivery photo',  n like 'manual close. Staff skipped the delivery photo%', 'note=' || coalesce(n, 'null'));
  select note into n from public.load_events where load_id = '30000000-0000-0000-0000-0000000000f1' and to_status = 'enroute';
  perform rlstest.chk('control: a carrier move WITH a photo has no skip text in its note', coalesce(n, '') !~* 'skipped', 'note=' || coalesce(n, 'null'));
end $t$;
-- staff move WITH the photo present: nothing to skip, so no skip text
select rlstest.mkload('30000000-0000-0000-0000-0000000000f6', 'loading', '20000000-0000-0000-0000-00000000000a');
insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values ('30000000-0000-0000-0000-0000000000f6', 'pickup_photo', '30000000-0000-0000-0000-0000000000f6/pickup_photo/f1000000-0000-0000-0000-000000000006.jpg', '00000000-0000-0000-0000-0000000000a1');
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.ok('staff moves a load that HAS its pickup photo', $q$select public.set_load_status('30000000-0000-0000-0000-0000000000f6', 'enroute', now() + interval '3 hours', 'with photo')$q$);
select rlstest.back();
do $t$
declare n text;
begin
  select note into n from public.load_events where load_id = '30000000-0000-0000-0000-0000000000f6' and to_status = 'enroute';
  perform rlstest.chk('control: no skip text when the photo exists', n = 'with photo', 'note=' || coalesce(n, 'null'));
  perform rlstest.chk('set_load_status carries both photo gates and still has no POD requirement',
    pg_get_functiondef('public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure) like '%pickup_photo%'
    and pg_get_functiondef('public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure) like '%delivery_photo%'
    and pg_get_functiondef('public.set_load_status(uuid, public.load_status, timestamptz, text)'::regprocedure) !~* 'pod');
end $t$;

-- 18g. delete_load_forever returns the photo paths too, and the orphan log accepts them
select rlstest.mkload('30000000-0000-0000-0000-0000000000fa', 'delivered', '20000000-0000-0000-0000-00000000000a');
update public.loads set its_load_number = '9918' where id = '30000000-0000-0000-0000-0000000000fa';
insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values
  ('30000000-0000-0000-0000-0000000000fa', 'bol', '30000000-0000-0000-0000-0000000000fa/bol/fa000000-0000-0000-0000-000000000001.pdf', '00000000-0000-0000-0000-0000000000a1'),
  ('30000000-0000-0000-0000-0000000000fa', 'pickup_photo', '30000000-0000-0000-0000-0000000000fa/pickup_photo/fa000000-0000-0000-0000-000000000002.jpg', '00000000-0000-0000-0000-0000000000a1'),
  ('30000000-0000-0000-0000-0000000000fa', 'delivery_photo', '30000000-0000-0000-0000-0000000000fa/delivery_photo/fa000000-0000-0000-0000-000000000003.webp', '00000000-0000-0000-0000-0000000000a1');
select rlstest.as_user('00000000-0000-0000-0000-0000000000a3');
do $t$
declare v text[];
begin
  v := public.delete_load_forever('30000000-0000-0000-0000-0000000000fa', '9918');
  perform rlstest.chk('delete_load_forever returns the BOL and BOTH photo paths',
    v is not null and cardinality(v) = 3
    and v @> array['30000000-0000-0000-0000-0000000000fa/bol/fa000000-0000-0000-0000-000000000001.pdf',
                   '30000000-0000-0000-0000-0000000000fa/pickup_photo/fa000000-0000-0000-0000-000000000002.jpg',
                   '30000000-0000-0000-0000-0000000000fa/delivery_photo/fa000000-0000-0000-0000-000000000003.webp']);
end $t$;
select rlstest.ok('control: the orphan log accepts the photo paths of the deleted load', format($q$select public.record_load_deletion_orphans(%L, array[%L, %L])$q$, '30000000-0000-0000-0000-0000000000fa',
  '30000000-0000-0000-0000-0000000000fa/pickup_photo/fa000000-0000-0000-0000-000000000002.jpg', '30000000-0000-0000-0000-0000000000fa/delivery_photo/fa000000-0000-0000-0000-000000000003.webp'));
select rlstest.err('the orphan log still refuses a photo path with a pdf extension', format($q$select public.record_load_deletion_orphans(%L, array[%L])$q$, '30000000-0000-0000-0000-0000000000fa',
  '30000000-0000-0000-0000-0000000000fa/pickup_photo/fa000000-0000-0000-0000-000000000004.pdf'), 'does not belong');
select rlstest.back();
do $t$
begin
  perform rlstest.chk('the orphan row holds exactly the two photo paths and the load is gone (cascade removed the document rows)',
    (select cardinality(orphan_paths) from public.load_deletions where load_id = '30000000-0000-0000-0000-0000000000fa') = 2
    and (select count(*) from public.load_documents where load_id = '30000000-0000-0000-0000-0000000000fa') = 0);
end $t$;

-- 18h. dlv_can_access_doc directly (never as anon: assert the privilege instead)
do $t$
begin
  perform rlstest.chk('anon has no EXECUTE on dlv_can_access_doc (photo kinds change nothing)', not has_function_privilege('anon', 'public.dlv_can_access_doc(text, boolean)', 'execute'));
end $t$;
select rlstest.as_user('00000000-0000-0000-0000-0000000000a3');
do $t$
declare v_bad int := 0; p text;
begin
  perform rlstest.chk('control: admin can read and write a well-formed photo path',
    public.dlv_can_access_doc('30000000-0000-0000-0000-0000000000e3/pickup_photo/e9000000-0000-0000-0000-000000000001.jpg', true));
  foreach p in array array[
    '30000000-0000-0000-0000-0000000000e3/pickup_photo/e9000000-0000-0000-0000-000000000001.pdf',
    '30000000-0000-0000-0000-0000000000e3/pickup_photo/e9000000-0000-0000-0000-000000000001.heic',
    '30000000-0000-0000-0000-0000000000e3/pickup_photo/e9000000-0000-0000-0000-000000000001.JPG',
    '30000000-0000-0000-0000-0000000000e3/pickup_photo/../e9000000-0000-0000-0000-000000000001.jpg',
    '30000000-0000-0000-0000-0000000000e3/Pickup_Photo/e9000000-0000-0000-0000-000000000001.jpg',
    '30000000-0000-0000-0000-0000000000e3/selfie/e9000000-0000-0000-0000-000000000001.jpg',
    '30000000-0000-0000-0000-0000000000e3/delivery_photo/e9000000-0000-0000-0000-000000000001.jpg
'] loop
    if public.dlv_can_access_doc(p, false) or public.dlv_can_access_doc(p, true) then v_bad := v_bad + 1; end if;
  end loop;
  perform rlstest.chk('dlv_can_access_doc rejects every malformed photo path (read and write)', v_bad = 0, 'bad=' || v_bad);
end $t$;
select rlstest.back();

-- 18j. review fix (DLV-032 review): a signed-in carrier cannot back-date a photo by sending created_at; the server time wins
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.ok('control: carrier A inserts a pickup photo row that claims created_at 2001 (the insert itself is allowed)', $q$do $x$ begin
  insert into storage.objects (bucket_id, name, owner, metadata) values ('documents', '30000000-0000-0000-0000-0000000000e2/pickup_photo/ea000000-0000-0000-0000-000000000001.jpg', auth.uid(), '{"mimetype":"image/jpeg"}'::jsonb);
  insert into public.load_documents (load_id, kind, storage_path, uploaded_by, created_at) values ('30000000-0000-0000-0000-0000000000e2', 'pickup_photo', '30000000-0000-0000-0000-0000000000e2/pickup_photo/ea000000-0000-0000-0000-000000000001.jpg', auth.uid(), '2001-01-01 00:00:00+00');
end $x$$q$);
select rlstest.back();
do $t$
begin
  perform rlstest.chk('a carrier cannot back-date a photo: created_at is the server time (guard: the row exists)',
    (select count(*) from public.load_documents where storage_path like '%/ea000000-0000-0000-0000-000000000001.jpg') = 1
    and (select created_at > now() - interval '1 minute' and created_at <= now() + interval '1 minute'
           from public.load_documents where storage_path like '%/ea000000-0000-0000-0000-000000000001.jpg'));
end $t$;

-- 18i. the migration is idempotent: apply the REAL file again, nothing changes -------------------------------------------------
create table rlstest.ph_before as select id, load_id, kind, storage_path, created_at from public.load_documents;
\i supabase/migrations/0018_load_photos.sql
do $t$
begin
  perform rlstest.chk('0018 applied again: the same document rows (guard: rows exist)',
    (select count(*) from rlstest.ph_before) > 20
    and (select count(*) from (select id, load_id, kind, storage_path, created_at from public.load_documents except select * from rlstest.ph_before) q) = 0
    and (select count(*) from (select * from rlstest.ph_before except select id, load_id, kind, storage_path, created_at from public.load_documents) q) = 0);
  perform rlstest.chk('0018 applied again: still exactly one cap trigger, one insert policy, and no DELETE privilege',
    (select count(*) from pg_trigger where tgrelid = 'public.load_documents'::regclass and tgname = 'load_documents_photo_cap' and not tgisinternal) = 1
    and (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'documents_insert') = 1
    and not has_table_privilege('authenticated', 'public.load_documents', 'delete')
    and not has_function_privilege('anon', 'public.delete_load_photo(uuid)', 'execute'));
end $t$;
-- 0018 restates dlv_can_access_doc; production runs every migration once, in order, so the later file that restates it
-- again (0022, DLV-043) is applied right after to put the function back to the migrated state for every section below.
\i supabase/migrations/0022_carrier_never_booked_cancel.sql

-- 19. Return loads (0019, DLV-038) ------------------------------------------------------------------------------------------
-- Seeded places: MTD (can_ship only, the original shipper that cannot receive), 1HAM (a site: can_receive only, requires
-- Moffett), QuickScrap Metal (a scrapyard: can_receive only), Valley Metal (can_ship only: neither can_receive nor the
-- original shipper of these loads), Mitrex and Howden (both).
\set RO1 '31900000-0000-0000-0000-0000000000f1'
\set RO2 '31900000-0000-0000-0000-0000000000f2'
\set RO3 '31900000-0000-0000-0000-0000000000f3'
\set RO4 '31900000-0000-0000-0000-0000000000f4'
\set RO5 '31900000-0000-0000-0000-0000000000f5'
\set RO6 '31900000-0000-0000-0000-0000000000f6'
\set RT1 '31900000-0000-0000-0000-0000000000d1'
\set RT2 '31900000-0000-0000-0000-0000000000d2'
\set RT3 '31900000-0000-0000-0000-0000000000d3'
\set RT4 '31900000-0000-0000-0000-0000000000d4'
\set RT5 '31900000-0000-0000-0000-0000000000d5'
\set RT6 '31900000-0000-0000-0000-0000000000d6'
\set RT7 '31900000-0000-0000-0000-0000000000d7'
select rlstest.set_active('00000000-0000-0000-0000-0000000000a1', true);
select rlstest.set_active('00000000-0000-0000-0000-0000000000a2', true);
select rlstest.set_active('00000000-0000-0000-0000-0000000000c1', true);
select rlstest.set_active('00000000-0000-0000-0000-0000000000c2', true);
select rlstest.set_active('00000000-0000-0000-0000-0000000000b1', true);
select rlstest.set_active('00000000-0000-0000-0000-0000000000b3', true);

-- An original load (as the table owner, no JWT): any customer, pickup, delivery, status and carrier.
create function rlstest.mkorig(p_id uuid, p_cust uuid, p_user uuid, p_pickup text, p_delivery text, p_status public.load_status, p_carrier uuid) returns void
language plpgsql security definer as $f$
begin
  insert into public.loads (id, customer_id, created_by, pickup_location_id, delivery_location_id,
    equipment_size, pickup_timing, pickup_date, pickup_time_start, delivery_timing, delivery_date,
    delivery_time_start, pickup_contact_name, pickup_contact_phone, delivery_contact_name, delivery_contact_phone)
  values (p_id, p_cust, p_user,
    (select id from public.locations where name = p_pickup), (select id from public.locations where name = p_delivery),
    53, 'appointment', current_date + 1, '08:00', 'appointment', current_date + 1, '14:00',
    'P Contact', '416-000-0001', 'D Contact', '416-000-0002');
  perform set_config('dlv.status_fn', '1', true);
  update public.loads set status = p_status, carrier_id = p_carrier where id = p_id;
  perform set_config('dlv.status_fn', '0', true);
end $f$;

-- Text of an INSERT of a return load as the CURRENT user (ids resolved here, so the caller's RLS on locations does not matter).
create function rlstest.rins(p_id uuid, p_ret uuid, p_pickup text, p_delivery text, p_cust uuid default null, p_by uuid default null) returns text
language plpgsql stable security definer as $f$
begin
  return format($q$insert into public.loads (id, customer_id, created_by, pickup_location_id, delivery_location_id,
    equipment_size, pickup_timing, pickup_date, pickup_time_start, delivery_timing, delivery_date, delivery_time_start,
    pickup_contact_name, pickup_contact_phone, delivery_contact_name, delivery_contact_phone, status, return_of_load_id)
    values (%L::uuid, %L::uuid, coalesce(%L::uuid, auth.uid()), %L::uuid, %L::uuid, 53, 'appointment', current_date + 2, '08:00', 'appointment',
    current_date + 2, '14:00', 'Site Pat', '416-000-0011', 'Back Dee', '416-000-0012', 'requested', %L::uuid)$q$,
    p_id, coalesce(p_cust, (select id from public.customers where name = 'Mitrex')), p_by,
    (select id from public.locations where name = p_pickup), (select id from public.locations where name = p_delivery), p_ret);
end $f$;
grant execute on all functions in schema rlstest to authenticated, anon;

-- RO1 delivered (Maria, carrier A), RO2 at_delivery, RO3 requested, RO4 enroute: all MTD to 1HAM.
-- RO5 delivered MTD to 1HAM of the OTHER customer. RO6 booked Mitrex to Howden (Maria).
select rlstest.mkorig(:'RO1', (select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c1', 'MTD MetroTool & Die Limited', '1HAM', 'delivered', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkorig(:'RO2', (select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c1', 'MTD MetroTool & Die Limited', '1HAM', 'at_delivery', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkorig(:'RO3', (select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c1', 'MTD MetroTool & Die Limited', '1HAM', 'requested', null);
select rlstest.mkorig(:'RO4', (select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c1', 'MTD MetroTool & Die Limited', '1HAM', 'enroute', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkorig(:'RO5', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000c2', 'MTD MetroTool & Die Limited', '1HAM', 'delivered', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkorig(:'RO6', (select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c1', 'Mitrex', 'Howden', 'booked', '20000000-0000-0000-0000-00000000000a');

-- 19a. shape, grants, definitions (as the table owner)
do $t$
begin
  perform rlstest.chk('fixtures: MTD ships but cannot receive, 1HAM and QuickScrap receive but cannot ship, Valley Metal cannot receive',
    (select not can_receive and can_ship from public.locations where name = 'MTD MetroTool & Die Limited')
    and (select can_receive and not can_ship and requires_moffett from public.locations where name = '1HAM')
    and (select can_receive and not can_ship from public.locations where name = 'QuickScrap Metal')
    and (select can_ship and not can_receive from public.locations where name = 'Valley Metal Finishing Ltd'));
  perform rlstest.chk('return_of_load_id is a nullable uuid column of loads',
    (select data_type = 'uuid' and is_nullable = 'YES' and column_default is null from information_schema.columns
      where table_schema = 'public' and table_name = 'loads' and column_name = 'return_of_load_id'));
  perform rlstest.chk('return_of_load_id references loads(id) ON DELETE SET NULL',
    (select count(*) from pg_constraint where conrelid = 'public.loads'::regclass and conname = 'loads_return_of_load_id_fkey'
       and contype = 'f' and confrelid = 'public.loads'::regclass and confdeltype = 'n') = 1);
  perform rlstest.chk('return_of_load_id has an index',
    (select count(*) from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
       where i.indrelid = 'public.loads'::regclass and a.attname = 'return_of_load_id') = 1);
  perform rlstest.chk('dlv_return_original is SECURITY DEFINER with a fixed empty search_path',
    (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.dlv_return_original(uuid)'::regprocedure));
  perform rlstest.chk('dlv_return_original: authenticated may execute, anon and PUBLIC may not (asserted, never called as anon)',
    has_function_privilege('authenticated', 'public.dlv_return_original(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.dlv_return_original(uuid)', 'execute')
    and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    where p.oid = 'public.dlv_return_original(uuid)'::regprocedure and a.grantee = 0));
  perform rlstest.chk('the trigger functions stay unexecutable for anon and authenticated',
    not has_function_privilege('anon', 'public.dlv_loads_before_insert()', 'execute')
    and not has_function_privilege('authenticated', 'public.dlv_loads_before_update()', 'execute'));
  perform rlstest.chk('dlv_check_load_locations: no anon execute (unchanged grant)',
    not has_function_privilege('anon', 'public.dlv_check_load_locations(public.loads)', 'execute'));
end $t$;

-- 19b. customer (Maria): a return of her own at_delivery or delivered load, pickup fixed, delivery relaxed
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.ok('maria books a return of her DELIVERED load back to the original shipper MTD (not can_receive) from the site 1HAM (not can_ship)',
  rlstest.rins(:'RT1', :'RO1', '1HAM', 'MTD MetroTool & Die Limited'));
select rlstest.ok('maria books a return of the same delivered load to a scrapyard (QuickScrap, can_receive)',
  rlstest.rins(:'RT2', :'RO1', '1HAM', 'QuickScrap Metal'));
select rlstest.ok('maria books a return of her AT_DELIVERY load',
  rlstest.rins(:'RT3', :'RO2', '1HAM', 'MTD MetroTool & Die Limited'));
select rlstest.err('a return delivery that is neither can_receive nor the original shipper (Valley Metal) is refused',
  rlstest.rins('31900000-0000-0000-0000-0000000000d8', :'RO1', '1HAM', 'Valley Metal Finishing Ltd'), 'delivery location cannot receive');
select rlstest.err('pickup mismatch: a return must pick up at the original delivery location (Mitrex given)',
  rlstest.rins('31900000-0000-0000-0000-0000000000d8', :'RO1', 'Mitrex', 'MTD MetroTool & Die Limited'), 'pickup must be the delivery location');
select rlstest.err('a return of a REQUESTED original is refused for a customer',
  rlstest.rins('31900000-0000-0000-0000-0000000000d8', :'RO3', '1HAM', 'MTD MetroTool & Die Limited'), 'at delivery or delivered');
select rlstest.err('a return of an ENROUTE original is refused for a customer',
  rlstest.rins('31900000-0000-0000-0000-0000000000d8', :'RO4', '1HAM', 'MTD MetroTool & Die Limited'), 'at delivery or delivered');
select rlstest.err('a return of a BOOKED original is refused for a customer',
  rlstest.rins('31900000-0000-0000-0000-0000000000d8', :'RO6', 'Howden', 'Mitrex'), 'at delivery or delivered');
select rlstest.err('a return of the OTHER customer''s delivered load is refused (original not found for her)',
  rlstest.rins('31900000-0000-0000-0000-0000000000d8', :'RO5', '1HAM', 'MTD MetroTool & Die Limited'), 'original load was not found');
select rlstest.err('a return of the OTHER customer''s load under the other customer''s id is refused too',
  rlstest.rins('31900000-0000-0000-0000-0000000000d8', :'RO5', '1HAM', 'MTD MetroTool & Die Limited', '10000000-0000-0000-0000-000000000002'), 'original load was not found|row-level security');
select rlstest.err('a return of an unknown load is refused',
  rlstest.rins('31900000-0000-0000-0000-0000000000d8', '31900000-0000-0000-0000-00000000ffff', '1HAM', 'MTD MetroTool & Die Limited'), 'original load was not found');
select rlstest.err('control: an ORDINARY load from the site 1HAM is still refused (the relaxed pickup rule is for returns only)',
  rlstest.rins('31900000-0000-0000-0000-0000000000d8', null, '1HAM', 'Mitrex'), 'pickup location cannot ship');
select rlstest.err('control: an ORDINARY load to MTD is still refused (cannot receive)',
  rlstest.rins('31900000-0000-0000-0000-0000000000d8', null, 'Mitrex', 'MTD MetroTool & Die Limited'), 'delivery location cannot receive');
select rlstest.ok('control: an ordinary load Mitrex to Howden still works for maria',
  rlstest.rins('31900000-0000-0000-0000-0000000000d9', null, 'Mitrex', 'Howden'));
select rlstest.cnt('maria reads dlv_return_original of her own delivered load (one row)', format('select * from public.dlv_return_original(%L)', :'RO1'), 1);
select rlstest.cnt('maria reads NOTHING from dlv_return_original of the other customer''s load (guard: it exists)',
  format('select * from public.dlv_return_original(%L)', :'RO5'), 0, format('select 1 from public.loads where id = %L', :'RO5'));
-- immutability, also through the status function shortcut, and the fixed pickup on a customer edit
select rlstest.err('maria cannot change return_of_load_id of her requested return load',
  format('update public.loads set return_of_load_id = %L where id = %L', :'RO2', :'RT1'), 'return_of_load_id is immutable');
select rlstest.err('maria cannot clear return_of_load_id',
  format('update public.loads set return_of_load_id = null where id = %L', :'RT1'), 'return_of_load_id is immutable');
select rlstest.err('maria cannot turn an ordinary load into a return',
  format('update public.loads set return_of_load_id = %L where id = %L', :'RO1', '31900000-0000-0000-0000-0000000000d9'), 'return_of_load_id is immutable');
select rlstest.err('the status function shortcut (dlv.status_fn) does not skip the immutability',
  format($q$do $x$ begin perform set_config('dlv.status_fn', '1', true); update public.loads set return_of_load_id = null where id = %L; end $x$$q$, :'RT1'), 'return_of_load_id is immutable');
select set_config('dlv.status_fn', '0', true);
select rlstest.err('maria cannot move the pickup of a return load away from the original delivery location',
  format('update public.loads set pickup_location_id = (select id from public.locations where name = %L) where id = %L', 'Mitrex', :'RT1'), 'pickup must be the delivery location');
select rlstest.ok('control: maria may change the delivery of a return to a scrapyard',
  format('update public.loads set delivery_location_id = (select id from public.locations where name = %L) where id = %L', 'QuickScrap Metal', :'RT1'));
select rlstest.ok('control: and back to the original shipper (not can_receive) on an edit',
  format('update public.loads set delivery_location_id = (select id from public.locations where name = %L) where id = %L', 'MTD MetroTool & Die Limited', :'RT1'));
select rlstest.err('an edit of a return to a place that is neither can_receive nor the original shipper is refused',
  format('update public.loads set delivery_location_id = (select id from public.locations where name = %L) where id = %L', 'Valley Metal Finishing Ltd', :'RT1'), 'delivery location cannot receive');
select rlstest.back();
do $t$
begin
  perform rlstest.chk('the stored returns: link, customer, requested, no carrier, created_by maria (guard: rows exist)',
    (select count(*) from public.loads where id in ('31900000-0000-0000-0000-0000000000d1', '31900000-0000-0000-0000-0000000000d2', '31900000-0000-0000-0000-0000000000d3')
       and status = 'requested' and carrier_id is null and created_by = '00000000-0000-0000-0000-0000000000c1'
       and customer_id = (select id from public.customers where name = 'Mitrex')) = 3
    and (select return_of_load_id from public.loads where id = '31900000-0000-0000-0000-0000000000d1') = '31900000-0000-0000-0000-0000000000f1'
    and (select return_of_load_id from public.loads where id = '31900000-0000-0000-0000-0000000000d3') = '31900000-0000-0000-0000-0000000000f2');
  perform rlstest.chk('the Moffett rule still holds on a return (1HAM requires it: moffett forced on)',
    (select moffett from public.loads where id = '31900000-0000-0000-0000-0000000000d1'));
  perform rlstest.chk('the edits landed: RT1 delivers to the original shipper MTD again, pickup still 1HAM',
    (select delivery_location_id = (select id from public.locations where name = 'MTD MetroTool & Die Limited')
        and pickup_location_id = (select id from public.locations where name = '1HAM')
       from public.loads where id = '31900000-0000-0000-0000-0000000000d1'));
  perform rlstest.chk('the refused attempts wrote nothing (no d8 row)',
    (select count(*) from public.loads where id = '31900000-0000-0000-0000-0000000000d8') = 0);
end $t$;

-- 19c. another customer, a carrier
select rlstest.as_user('00000000-0000-0000-0000-0000000000c2');
select rlstest.err('the other customer cannot book a return of maria''s delivered load',
  rlstest.rins('31900000-0000-0000-0000-0000000000d8', :'RO1', '1HAM', 'MTD MetroTool & Die Limited', '10000000-0000-0000-0000-000000000002'), 'original load was not found');
select rlstest.ok('control: the other customer books a return of its OWN delivered load',
  rlstest.rins(:'RT7', :'RO5', '1HAM', 'MTD MetroTool & Die Limited', '10000000-0000-0000-0000-000000000002'));
select rlstest.cnt('the other customer reads nothing of maria''s load through dlv_return_original (guard: it exists)',
  format('select * from public.dlv_return_original(%L)', :'RO1'), 0, format('select 1 from public.loads where id = %L', :'RO1'));
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.cnt('carrier A reads nothing through dlv_return_original, even of a load it carried (guard: it exists)',
  format('select * from public.dlv_return_original(%L)', :'RO1'), 0, format('select 1 from public.loads where id = %L', :'RO1'));
select rlstest.err('carrier A cannot insert a return load',
  rlstest.rins('31900000-0000-0000-0000-0000000000d8', :'RO1', '1HAM', 'MTD MetroTool & Die Limited'), 'row-level security|original load was not found');
select rlstest.back();

-- 19d. staff: any status of the original, still the same customer and the fixed pickup
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.ok('staff_admin books a return of a BOOKED original (staff: any status)',
  rlstest.rins(:'RT4', :'RO6', 'Howden', 'Mitrex'));
select rlstest.err('staff_admin: pickup mismatch is refused',
  rlstest.rins('31900000-0000-0000-0000-0000000000d8', :'RO6', 'Mitrex', 'Howden'), 'pickup must be the delivery location');
select rlstest.err('staff_admin: a return under ANOTHER customer than the original is refused',
  rlstest.rins('31900000-0000-0000-0000-0000000000d8', :'RO5', '1HAM', 'MTD MetroTool & Die Limited'), 'original load was not found');
select rlstest.err('staff_admin cannot change return_of_load_id either',
  format('update public.loads set return_of_load_id = %L where id = %L', :'RO2', :'RT1'), 'return_of_load_id is immutable');
select rlstest.err('staff_admin cannot clear return_of_load_id while the original exists',
  format('update public.loads set return_of_load_id = null where id = %L', :'RT1'), 'return_of_load_id is immutable');
select rlstest.cnt('staff reads dlv_return_original of any load', format('select * from public.dlv_return_original(%L)', :'RO5'), 1);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.ok('staff_csr books a return of a REQUESTED original (staff: any status)',
  rlstest.rins(:'RT5', :'RO3', '1HAM', 'MTD MetroTool & Die Limited'));
select rlstest.ok('staff_csr books a return for the OTHER customer of its own original (same customer)',
  rlstest.rins(:'RT6', :'RO5', '1HAM', 'QuickScrap Metal', '10000000-0000-0000-0000-000000000002'));
select rlstest.err('staff_csr: delivery neither can_receive nor the original shipper is refused',
  rlstest.rins('31900000-0000-0000-0000-0000000000d8', :'RO3', '1HAM', 'Valley Metal Finishing Ltd'), 'delivery location cannot receive');
select rlstest.back();

-- 19e. the service role / table owner (no JWT) stays unrestricted, like today
select rlstest.ok('owner (auth.uid() null) inserts a return whose pickup is not the original delivery (unrestricted)',
  rlstest.rins('31900000-0000-0000-0000-0000000000da', :'RO3', 'Mitrex', 'Howden', null, '00000000-0000-0000-0000-0000000000c1'));
select rlstest.ok('owner (auth.uid() null) may change return_of_load_id',
  format('update public.loads set return_of_load_id = %L where id = %L', :'RO1', '31900000-0000-0000-0000-0000000000da'));

-- 19f. carriers see the column only on their own loads (no new leak)
select set_config('dlv.status_fn', '1', true);
update public.loads set status = 'booked', carrier_id = '20000000-0000-0000-0000-00000000000b' where id = :'RT2';
select set_config('dlv.status_fn', '0', true);
select rlstest.as_user('00000000-0000-0000-0000-0000000000b3');
select rlstest.cnt('carrier B sees its own booked return load with the link', format('select 1 from public.loads where id = %L and return_of_load_id = %L', :'RT2', :'RO1'), 1);
select rlstest.cnt('carrier B does not see the original (carried by A) (guard: it exists)', format('select 1 from public.loads where id = %L', :'RO1'), 0, format('select 1 from public.loads where id = %L', :'RO1'));
select rlstest.cnt('carrier B sees no requested return load (guard: RT1 exists)', format('select 1 from public.loads where id = %L', :'RT1'), 0, format('select 1 from public.loads where id = %L', :'RT1'));
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.cnt('carrier A does not see carrier B''s return load (guard: it exists)', format('select 1 from public.loads where id = %L', :'RT2'), 0, format('select 1 from public.loads where id = %L', :'RT2'));
select rlstest.cnt('carrier A sees no return_of_load_id on any load it cannot read: only its own rows come back', $q$select 1 from public.loads where return_of_load_id is not null and carrier_id is distinct from public.dlv_carrier_id()$q$, 0, $q$select 1 from public.loads where return_of_load_id is not null$q$);
select rlstest.back();

-- 19g. an inactive pickup is refused on a return too
update public.locations set is_active = false where name = 'Glengarry';
select rlstest.mkorig('31900000-0000-0000-0000-0000000000f7', (select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c1', 'Mitrex', 'Howden', 'delivered', '20000000-0000-0000-0000-00000000000a');
update public.loads set delivery_location_id = (select id from public.locations where name = 'Glengarry') where id = '31900000-0000-0000-0000-0000000000f7';
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.err('a return from an INACTIVE site is refused',
  rlstest.rins('31900000-0000-0000-0000-0000000000d8', '31900000-0000-0000-0000-0000000000f7', 'Glengarry', 'Mitrex'), 'pickup location cannot ship');
select rlstest.back();
update public.locations set is_active = true where name = 'Glengarry';

-- 19h. deleting the original keeps the returns, with the link cleared (ON DELETE SET NULL through the guard)
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.ok('the admin deletes the original RO1 forever',
  format('select public.delete_load_forever(%L, (select load_number from public.loads where id = %L))', :'RO1', :'RO1'));
select rlstest.back();
do $t$
begin
  perform rlstest.chk('after the delete: the original is gone, both returns stay with return_of_load_id null',
    (select count(*) from public.loads where id = '31900000-0000-0000-0000-0000000000f1') = 0
    and (select count(*) from public.loads where id in ('31900000-0000-0000-0000-0000000000d1', '31900000-0000-0000-0000-0000000000d2') and return_of_load_id is null) = 2);
end $t$;

-- 19i. the migration is idempotent: apply the REAL file again, nothing changes
create table rlstest.rt_before as select id, return_of_load_id, pickup_location_id, delivery_location_id, status from public.loads;
\i supabase/migrations/0019_return_loads.sql
do $t$
begin
  perform rlstest.chk('0019 applied again: the same loads and links (guard: return rows exist)',
    (select count(*) from rlstest.rt_before where return_of_load_id is not null) >= 5
    and (select count(*) from (select id, return_of_load_id, pickup_location_id, delivery_location_id, status from public.loads except select * from rlstest.rt_before) q) = 0
    and (select count(*) from (select * from rlstest.rt_before except select id, return_of_load_id, pickup_location_id, delivery_location_id, status from public.loads) q) = 0);
  perform rlstest.chk('0019 applied again: one foreign key, one index, the helper still not executable by anon',
    (select count(*) from pg_constraint where conrelid = 'public.loads'::regclass and conname = 'loads_return_of_load_id_fkey') = 1
    and (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'loads' and indexname = 'loads_return_of_load_id_idx') = 1
    and not has_function_privilege('anon', 'public.dlv_return_original(uuid)', 'execute'));
end $t$;

-- 20. Staff edit audit (0020, DLV-039) -------------------------------------------------------------------
-- A staff edit of any load detail writes ONE "Details edited" event (from = to = the current status, the staff actor,
-- human labels, location names, times as the app prints them, at most 1000 characters). A customer edit while
-- requested, the service role and owner tooling write nothing. Clients still cannot write load_events.
\set SE1 '32000000-0000-0000-0000-0000000000e1'
\set SE2 '32000000-0000-0000-0000-0000000000e2'
\set SE3 '32000000-0000-0000-0000-0000000000e3'
\set SE4 '32000000-0000-0000-0000-0000000000e4'
\set SE5 '32000000-0000-0000-0000-0000000000e5'
create function rlstest.edits(p_load uuid) returns bigint language sql security definer as $f$
  select count(*) from public.load_events where load_id = p_load and note like 'Details edited:%' $f$;
create function rlstest.lastedit(p_load uuid) returns public.load_events language sql security definer as $f$
  select * from public.load_events where load_id = p_load and note like 'Details edited:%' order by id desc limit 1 $f$;
grant execute on all functions in schema rlstest to authenticated, anon;
select rlstest.mkorig(:'SE1', (select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c1', 'Mitrex', 'Howden', 'booked', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkorig(:'SE2', (select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c1', 'Mitrex', 'Howden', 'delivered', '20000000-0000-0000-0000-00000000000a');
select rlstest.mkorig(:'SE3', (select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c1', 'Mitrex', 'Howden', 'requested', null);

-- 20a. the service role / owner (auth.uid() null) changes details: no event, like today
update public.loads set pickup_date = '2031-05-05', delivery_date = '2031-05-05', weight_lbs = 1200, pieces = 4,
  po_number = 'PO-OLD', notes = 'Old note' where id = :'SE1';
do $t$
begin
  perform rlstest.chk('owner (auth.uid() null) detail update landed (guard)',
    (select pickup_date = '2031-05-05' and po_number = 'PO-OLD' from public.loads where id = '32000000-0000-0000-0000-0000000000e1'));
  perform rlstest.chk('owner (auth.uid() null) detail update writes NO Details edited event',
    rlstest.edits('32000000-0000-0000-0000-0000000000e1') = 0);
end $t$;

-- 20b. staff_admin edits every kind of detail of a BOOKED load with a carrier: ONE event, exact text
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.rows('staff_admin edits pickup, delivery, both contacts, both times, size, weight, pieces, PO and notes of a booked load',
  format($q$update public.loads set
    pickup_location_id = (select id from public.locations where name = 'Sherbourne'),
    delivery_location_id = (select id from public.locations where name = '125G'),
    pickup_contact_name = 'New Pat', pickup_contact_phone = '905-111-0001',
    delivery_contact_name = 'New Dee', delivery_contact_phone = '905-111-0002',
    pickup_timing = 'window', pickup_date = '2031-05-06', pickup_time_start = '07:00', pickup_time_end = '09:00',
    delivery_timing = 'appointment', delivery_date = '2031-05-07', delivery_time_start = '13:30', delivery_time_end = null,
    equipment_size = 26, weight_lbs = 1200.5, pieces = null, po_number = 'PO-NEW', notes = E'Line one\nLine two'
    where id = %L$q$, :'SE1'), 1);
select rlstest.back();
do $t$
declare e public.load_events;
begin
  e := rlstest.lastedit('32000000-0000-0000-0000-0000000000e1');
  perform rlstest.chk('staff_admin edit: exactly ONE Details edited event', rlstest.edits('32000000-0000-0000-0000-0000000000e1') = 1);
  perform rlstest.chk('staff_admin edit: from = to = booked, actor = the admin',
    e.from_status = 'booked' and e.to_status = 'booked' and e.actor_id = '00000000-0000-0000-0000-0000000000a1');
  perform rlstest.chk('staff_admin edit: the note names every change with labels, location names and app formatted times',
    e.note = 'Details edited: Pickup: Mitrex to Sherbourne; Pickup contact: P Contact, 416-000-0001 to New Pat, 905-111-0001; '
      || 'Pickup time: Mon, May 5, 2031, 8:00 AM ET (appointment) to Tue, May 6, 2031, 7:00 AM to 9:00 AM ET (window); '
      || 'Delivery: Howden to 125G; Delivery contact: D Contact, 416-000-0002 to New Dee, 905-111-0002; '
      || 'Delivery time: Mon, May 5, 2031, 2:00 PM ET (appointment) to Wed, May 7, 2031, 1:30 PM ET (appointment); '
      || 'Equipment size: 53 ft to 26 ft; Weight: 1,200 lbs to 1,200.5 lbs; Pieces: 4 to Not given; '
      || 'PO number: PO-OLD to PO-NEW; Notes: Old note to Line one Line two',
    e.note);
  perform rlstest.chk('staff_admin edit: the status, carrier and ITS number are unchanged',
    (select status = 'booked' and carrier_id = '20000000-0000-0000-0000-00000000000a' from public.loads where id = '32000000-0000-0000-0000-0000000000e1'));
end $t$;

-- 20c. staff_csr edits a DELIVERED load (identical rights): one event, Moffett recomputed from the new site
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.rows('staff_csr moves the delivery of a delivered load to 1HAM (requires Moffett)',
  format($q$update public.loads set delivery_location_id = (select id from public.locations where name = '1HAM') where id = %L$q$, :'SE2'), 1);
select rlstest.rows('staff_csr changes nothing that is a detail (same notes): no event expected below',
  format($q$update public.loads set notes = notes where id = %L$q$, :'SE2'), 1);
select rlstest.rows('staff_csr assigns another carrier (not a detail column)',
  format($q$update public.loads set carrier_id = '20000000-0000-0000-0000-00000000000b' where id = %L$q$, :'SE2'), 1);
select rlstest.back();
do $t$
declare e public.load_events;
begin
  e := rlstest.lastedit('32000000-0000-0000-0000-0000000000e2');
  perform rlstest.chk('staff_csr edit: exactly ONE Details edited event (the no change update and the carrier change wrote none)',
    rlstest.edits('32000000-0000-0000-0000-0000000000e2') = 1);
  perform rlstest.chk('staff_csr edit: from = to = delivered, actor = the csr, Moffett forced on and named',
    e.from_status = 'delivered' and e.to_status = 'delivered' and e.actor_id = '00000000-0000-0000-0000-0000000000a2'
    and e.note = 'Details edited: Delivery: Howden to 1HAM; Moffett: No to Yes', e.note);
end $t$;

-- 20d. customer edit while requested: no event (today's behaviour); then a staff edit of the same requested load
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.rows('control: maria edits notes and the PO of her requested load',
  format($q$update public.loads set notes = 'Maria note', po_number = 'PO-M' where id = %L$q$, :'SE3'), 1);
select rlstest.cnt('maria''s edit wrote NO Details edited event (guard: the edit landed)',
  format($q$select 1 from public.load_events where load_id = %L and note like 'Details edited:%%'$q$, :'SE3'), 0,
  format($q$select 1 from public.loads where id = %L and notes = 'Maria note'$q$, :'SE3'));
select rlstest.err('maria cannot write a Details edited event by hand',
  format($q$insert into public.load_events (load_id, from_status, to_status, note) values (%L, 'requested', 'requested', 'Details edited: x')$q$, :'SE3'), 'permission denied');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.rows('staff_admin changes the size of the requested load',
  format($q$update public.loads set equipment_size = 36 where id = %L$q$, :'SE3'), 1);
select rlstest.ok('staff_admin sets the ITS number (its own event, not a detail)',
  format($q$select public.set_its_load_number(%L, '9020-1')$q$, :'SE3'));
select rlstest.rows('staff_admin assigns a carrier (not a detail)',
  format($q$update public.loads set carrier_id = '20000000-0000-0000-0000-00000000000a' where id = %L$q$, :'SE3'), 1);
select rlstest.ok('staff_admin books the load (status event only)',
  format($q$select public.set_load_status(%L, 'booked', null, null)$q$, :'SE3'));
select rlstest.back();
do $t$
declare e public.load_events;
begin
  e := rlstest.lastedit('32000000-0000-0000-0000-0000000000e3');
  perform rlstest.chk('requested load: one Details edited event (staff), from = to = requested',
    rlstest.edits('32000000-0000-0000-0000-0000000000e3') = 1 and e.from_status = 'requested' and e.to_status = 'requested'
    and e.note = 'Details edited: Equipment size: 53 ft to 36 ft', e.note);
  perform rlstest.chk('the ITS number and the booking kept their own events (ITS note, status change)',
    (select count(*) from public.load_events where load_id = '32000000-0000-0000-0000-0000000000e3' and note = 'ITS load number set to 9020-1') = 1
    and (select count(*) from public.load_events where load_id = '32000000-0000-0000-0000-0000000000e3' and from_status = 'requested' and to_status = 'booked') = 1);
end $t$;

-- 20e. long notes: the event note is cut at 1000 characters
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.rows('staff_csr writes 1500 characters of notes',
  format($q$update public.loads set notes = repeat('x', 1500) where id = %L$q$, :'SE1'), 1);
select rlstest.back();
do $t$
declare e public.load_events;
begin
  e := rlstest.lastedit('32000000-0000-0000-0000-0000000000e1');
  perform rlstest.chk('a long edit note is at most 1000 characters and ends with ...',
    length(e.note) = 1000 and right(e.note, 3) = '...' and e.note like 'Details edited: Notes: Line one Line two to xxx%', length(e.note)::text);
  perform rlstest.chk('the load itself keeps all 1500 characters',
    (select length(notes) from public.loads where id = '32000000-0000-0000-0000-0000000000e1') = 1500);
end $t$;

-- 20f. clients still cannot write load_events (no new grant), and a carrier cannot edit details
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.err('staff_csr cannot insert a load event by hand', format($q$insert into public.load_events (load_id, to_status, note) values (%L, 'booked', 'Details edited: forged')$q$, :'SE1'), 'permission denied');
select rlstest.err('staff_csr cannot UPDATE a Details edited event', format($q$update public.load_events set note = 'x' where load_id = %L$q$, :'SE1'), 'permission denied');
select rlstest.err('staff_csr cannot DELETE a Details edited event', format($q$delete from public.load_events where load_id = %L$q$, :'SE1'), 'permission denied');
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.rows('carrier A cannot change the details of its own booked load (guard: it reads it)',
  format($q$update public.loads set notes = 'carrier' where id = %L$q$, :'SE1'), 0, format($q$select 1 from public.loads where id = %L$q$, :'SE1'));
select rlstest.cnt('control: carrier A reads the Details edited events of its own load', format($q$select 1 from public.load_events where load_id = %L and note like 'Details edited:%%'$q$, :'SE1'), 2);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.cnt('control: maria reads the Details edited events of her booked load in her timeline', format($q$select 1 from public.load_events where load_id = %L and note like 'Details edited:%%'$q$, :'SE1'), 2);
select rlstest.back();
do $t$
declare bad boolean := false; p text;
begin
  foreach p in array array['insert', 'update', 'delete', 'truncate'] loop
    if has_table_privilege('authenticated', 'public.load_events', p) or has_table_privilege('anon', 'public.load_events', p) then bad := true; end if;
  end loop;
  perform rlstest.chk('after 0020: authenticated and anon still hold no INSERT, UPDATE, DELETE or TRUNCATE on load_events', not bad);
end $t$;

-- 20g. deleting an original (ON DELETE SET NULL on its return, run by the admin) writes no Details edited event
select rlstest.mkorig(:'SE4', (select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c1', 'Mitrex', '1HAM', 'delivered', '20000000-0000-0000-0000-00000000000a');
select rlstest.ok('owner inserts a return of SE4', rlstest.rins(:'SE5', :'SE4', '1HAM', 'Mitrex', null, '00000000-0000-0000-0000-0000000000c1'));
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.ok('the admin deletes the original SE4 forever',
  format('select public.delete_load_forever(%L, (select load_number from public.loads where id = %L))', :'SE4', :'SE4'));
select rlstest.back();
do $t$
begin
  perform rlstest.chk('the return lost its link (guard) and got NO Details edited event',
    (select return_of_load_id is null from public.loads where id = '32000000-0000-0000-0000-0000000000e5')
    and rlstest.edits('32000000-0000-0000-0000-0000000000e5') = 0);
end $t$;

-- 20h. catalog: the trigger, the definer function, the formatter, the grants
do $t$
begin
  perform rlstest.chk('loads_detail_event is an enabled AFTER UPDATE row trigger on loads calling dlv_loads_detail_event',
    (select count(*) from pg_trigger t where t.tgrelid = 'public.loads'::regclass and t.tgname = 'loads_detail_event'
       and not t.tgisinternal and t.tgenabled = 'O' and t.tgfoid = 'public.dlv_loads_detail_event()'::regprocedure
       and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 0 and (t.tgtype & 16) = 16) = 1);
  perform rlstest.chk('dlv_loads_detail_event is SECURITY DEFINER with an empty search_path',
    (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.dlv_loads_detail_event()'::regprocedure));
  perform rlstest.chk('dlv_fmt_slot is IMMUTABLE, not definer, with an empty search_path',
    (select provolatile = 'i' and not prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.dlv_fmt_slot(text, date, time, time)'::regprocedure));
  perform rlstest.chk('anon, authenticated and PUBLIC cannot execute the two 0020 functions (asserted, never called as anon)',
    not has_function_privilege('anon', 'public.dlv_loads_detail_event()', 'execute')
    and not has_function_privilege('authenticated', 'public.dlv_loads_detail_event()', 'execute')
    and not has_function_privilege('anon', 'public.dlv_fmt_slot(text, date, time, time)', 'execute')
    and not has_function_privilege('authenticated', 'public.dlv_fmt_slot(text, date, time, time)', 'execute')
    and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    where p.oid in ('public.dlv_loads_detail_event()'::regprocedure, 'public.dlv_fmt_slot(text, date, time, time)'::regprocedure)
                      and a.grantee = 0));
  perform rlstest.chk('dlv_fmt_slot prints like the app: appointment, window, noon and midnight',
    public.dlv_fmt_slot('appointment', '2031-09-01', '12:00', null) = 'Mon, Sep 1, 2031, 12:00 PM ET (appointment)'
    and public.dlv_fmt_slot('window', '2031-05-07', '00:15', '13:05') = 'Wed, May 7, 2031, 12:15 AM to 1:05 PM ET (window)');
end $t$;

-- 20i. the migration is idempotent: apply the REAL file again, one trigger, one event per edit
\i supabase/migrations/0020_staff_edit_audit.sql
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.rows('staff_csr edits the pieces after 0020 was applied again',
  format($q$update public.loads set pieces = 12 where id = %L$q$, :'SE2'), 1);
select rlstest.back();
do $t$
begin
  perform rlstest.chk('0020 applied again: still ONE trigger, and the edit wrote exactly one more event',
    (select count(*) from pg_trigger where tgrelid = 'public.loads'::regclass and tgname = 'loads_detail_event') = 1
    and rlstest.edits('32000000-0000-0000-0000-0000000000e2') = 2
    and (rlstest.lastedit('32000000-0000-0000-0000-0000000000e2')).note = 'Details edited: Pieces: Not given to 12');
end $t$;

-- 21. Customer locations (0021, DLV-041): Maria adds and edits locations herself ---------------------------------------------
-- Fixtures: an inactive customer user of Mitrex (c7) and a customer user that is deleted later (c8).
insert into auth.users (id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000000c7', 'authenticated', 'authenticated', 'mariaold@t.test'),
  ('00000000-0000-0000-0000-0000000000c8', 'authenticated', 'authenticated', 'gone@t.test');
insert into public.profiles (id, email, role, customer_id, carrier_id, is_active) values
  ('00000000-0000-0000-0000-0000000000c7', 'mariaold@t.test', 'customer', (select id from public.customers where name = 'Mitrex'), null, false),
  ('00000000-0000-0000-0000-0000000000c8', 'gone@t.test', 'customer', (select id from public.customers where name = 'Mitrex'), null, true);
create function rlstest.loc(p_name text) returns public.locations language sql security definer as $f$
  select * from public.locations where name = p_name $f$;
-- a load from Mitrex to p_dest as the CURRENT user, returning the stored moffett flag
create function rlstest.load_to(p_dest text) returns text language plpgsql as $f$
declare v boolean;
begin
  insert into public.loads (customer_id, created_by, pickup_location_id, delivery_location_id,
    equipment_size, moffett, pickup_timing, pickup_date, pickup_time_start, delivery_timing, delivery_date,
    delivery_time_start, pickup_contact_name, pickup_contact_phone, delivery_contact_name, delivery_contact_phone)
  values ((select id from public.customers where name = 'Mitrex'), auth.uid(),
    (select id from public.locations where name = 'Mitrex'), (select id from public.locations where name = p_dest),
    26, false, 'appointment', current_date + 3, '08:00', 'appointment', current_date + 3, '14:00', 'A', '1', 'B', '2')
  returning moffett into v;
  return v::text;
end $f$;
grant execute on function rlstest.load_to(text) to authenticated;

-- 21a. shape, triggers, functions, policies (as the table owner)
do $t$
begin
  perform rlstest.chk('locations.created_at is timestamptz not null with a default',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'locations' and column_name = 'created_at'
            and data_type = 'timestamp with time zone' and is_nullable = 'NO' and column_default is not null));
  perform rlstest.chk('locations.created_by and updated_by are nullable uuid references to profiles, ON DELETE SET NULL',
    (select count(*) from pg_constraint c
      where c.conrelid = 'public.locations'::regclass and c.contype = 'f' and c.confrelid = 'public.profiles'::regclass
        and c.confdeltype = 'n'
        and (select array_agg(a.attname::text order by a.attname) from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any (c.conkey))
            in (array['created_by'], array['updated_by'])) = 2
    and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'locations'
          and column_name in ('created_by', 'updated_by') and data_type = 'uuid' and is_nullable = 'YES') = 2);
  perform rlstest.chk('existing rows got a created_at and no author (the seeded Howden)',
    (rlstest.loc('Howden')).created_at is not null and (rlstest.loc('Howden')).created_by is null);
  perform rlstest.chk('locations_before_insert is an enabled BEFORE INSERT row trigger calling dlv_locations_before_insert',
    (select count(*) from pg_trigger t where t.tgrelid = 'public.locations'::regclass and t.tgname = 'locations_before_insert'
       and not t.tgisinternal and t.tgenabled = 'O' and t.tgfoid = 'public.dlv_locations_before_insert()'::regprocedure
       and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 4) = 4 and (t.tgtype & 16) = 0) = 1);
  perform rlstest.chk('locations_before_update is an enabled BEFORE UPDATE row trigger calling dlv_locations_before_update',
    (select count(*) from pg_trigger t where t.tgrelid = 'public.locations'::regclass and t.tgname = 'locations_before_update'
       and not t.tgisinternal and t.tgenabled = 'O' and t.tgfoid = 'public.dlv_locations_before_update()'::regprocedure
       and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 16) = 16 and (t.tgtype & 4) = 0) = 1);
  perform rlstest.chk('the two location trigger functions are SECURITY DEFINER with an empty search_path',
    (select count(*) from pg_proc where oid in ('public.dlv_locations_before_insert()'::regprocedure, 'public.dlv_locations_before_update()'::regprocedure)
       and prosecdef and proconfig @> array['search_path=""']) = 2);
  perform rlstest.chk('anon, authenticated and PUBLIC cannot execute the three 0021 functions (asserted, never called as anon)',
    not has_function_privilege('anon', 'public.dlv_locations_before_insert()', 'execute')
    and not has_function_privilege('authenticated', 'public.dlv_locations_before_insert()', 'execute')
    and not has_function_privilege('anon', 'public.dlv_locations_before_update()', 'execute')
    and not has_function_privilege('authenticated', 'public.dlv_locations_before_update()', 'execute')
    and not has_function_privilege('anon', 'public.dlv_location_customer_rules(public.locations)', 'execute')
    and not has_function_privilege('authenticated', 'public.dlv_location_customer_rules(public.locations)', 'execute')
    and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    where p.oid in ('public.dlv_locations_before_insert()'::regprocedure, 'public.dlv_locations_before_update()'::regprocedure,
                                    'public.dlv_location_customer_rules(public.locations)'::regprocedure)
                      and a.grantee = 0));
  perform rlstest.chk('locations policies: select, staff insert, customer insert, update, staff delete (5); the only DELETE policy is staff',
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'locations') = 5
    and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'locations' and cmd in ('DELETE', 'ALL')) = 1
    and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'locations' and policyname = 'locations_staff_delete'
                and cmd = 'DELETE' and qual like '%dlv_is_staff()%' and qual not like '%customer%'));
  perform rlstest.chk('the unique name constraint stays',
    exists (select 1 from pg_constraint where conrelid = 'public.locations'::regclass and contype = 'u'
            and pg_get_constraintdef(oid) = 'UNIQUE (name)'));
end $t$;

-- 21b. Maria inserts: the flags and the author are forced, whatever she sends
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.rows('Maria adds a location directly (no request)',
  $q$insert into public.locations (name, address_line, city, province, postal_code, can_ship, can_receive, requires_moffett,
     default_contact_name, default_contact_phone, notes, is_active, needs_review, created_by, updated_by, created_at, updated_at)
     values ('R21 Maria Site', '1 Maria Way', 'Toronto', 'ON', null, false, true, false, 'Ana', '416-555-0101', 'Gate 2',
     false, true, '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a2', '2000-01-01', '2000-01-01')$q$, 1);
select rlstest.rows('Maria adds a location and reads it back in the same statement (INSERT RETURNING)',
  $q$insert into public.locations (name, address_line, city, province, can_ship, can_receive) values ('R21 Maria Returning', '2 Maria Way', 'Toronto', 'ON', true, false) returning id, is_active$q$, 1);
select rlstest.err('Maria cannot add a second location with the same name', $q$insert into public.locations (name, address_line, city, province, can_ship) values ('R21 Maria Site', 'x', 'y', 'ON', true)$q$, 'duplicate key|locations_name_key');
select rlstest.err('Maria cannot add a location with a blank name', $q$insert into public.locations (name, address_line, city, province, can_ship) values ('   ', 'x', 'y', 'ON', true)$q$, 'needs a name');
select rlstest.err('Maria cannot add a location name of 121 characters', format($q$insert into public.locations (name, address_line, city, province, can_ship) values (%L, 'x', 'y', 'ON', true)$q$, repeat('n', 121)), 'at most 120');
select rlstest.rows('control: a name of exactly 120 characters is accepted', format($q$insert into public.locations (name, address_line, city, province, can_ship) values (%L, 'x', 'y', 'ON', true)$q$, repeat('m', 120)), 1);
select rlstest.err('Maria cannot add notes of 1001 characters', format($q$insert into public.locations (name, address_line, city, province, can_ship, notes) values ('R21 Long Notes', 'x', 'y', 'ON', true, %L)$q$, repeat('z', 1001)), 'at most 1000');
select rlstest.rows('control: notes of exactly 1000 characters are accepted', format($q$insert into public.locations (name, address_line, city, province, can_ship, notes) values ('R21 Max Notes', 'x', 'y', 'ON', true, %L)$q$, repeat('z', 1000)), 1);
select rlstest.err('Maria cannot add a location that neither ships nor receives', $q$insert into public.locations (name, address_line, city, province, can_ship, can_receive) values ('R21 Nothing', 'x', 'y', 'ON', false, false)$q$, 'ship, receive or both');
select rlstest.back();
do $t$
declare r public.locations := rlstest.loc('R21 Maria Site');
begin
  perform rlstest.chk('guard: the location Maria added exists', r.id is not null);
  perform rlstest.chk('Maria''s location is ACTIVE although she sent is_active false', r.is_active is true);
  perform rlstest.chk('Maria''s location does NOT need review although she sent needs_review true', r.needs_review is false);
  perform rlstest.chk('created_by is Maria although she sent the csr (not spoofable)', r.created_by = '00000000-0000-0000-0000-0000000000c1', coalesce(r.created_by::text, 'null'));
  perform rlstest.chk('updated_by is empty on insert although she sent the csr', r.updated_by is null);
  perform rlstest.chk('created_at and updated_at are the server time, not her 2000-01-01', r.created_at = now() and r.updated_at = now());
  perform rlstest.chk('her business fields are stored as sent',
    r.address_line = '1 Maria Way' and r.city = 'Toronto' and r.province = 'ON' and r.postal_code is null and not r.can_ship and r.can_receive
    and not r.requires_moffett and r.default_contact_name = 'Ana' and r.default_contact_phone = '416-555-0101' and r.notes = 'Gate 2');
end $t$;

-- 21c. Maria edits every business field of an active location; nothing else
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.rows('Maria edits every business field of her location at once',
  $q$update public.locations set name = 'R21 Maria Site Renamed', address_line = '9 New Road', city = 'Mississauga', province = 'ON',
     postal_code = 'L5L 1A1', can_ship = true, can_receive = true, requires_moffett = true, default_contact_name = 'Bo',
     default_contact_phone = '905-555-0199', notes = 'Back gate' where name = 'R21 Maria Site'$q$, 1);
select rlstest.rows('Maria edits the address of a seeded location (Howden)', $q$update public.locations set address_line = '40 Howden Rd', postal_code = 'M1R 3E8' where name = 'Howden'$q$, 1);
select rlstest.err('Maria cannot change is_active', $q$update public.locations set is_active = false where name = 'R21 Maria Site Renamed'$q$, 'customer can change only');
select rlstest.err('Maria cannot change needs_review', $q$update public.locations set needs_review = true where name = 'R21 Maria Site Renamed'$q$, 'customer can change only');
select rlstest.err('Maria cannot change the id', $q$update public.locations set id = gen_random_uuid() where name = 'R21 Maria Site Renamed'$q$, 'customer can change only');
select rlstest.err('Maria cannot change created_at', $q$update public.locations set created_at = '2000-01-01' where name = 'R21 Maria Site Renamed'$q$, 'customer can change only');
select rlstest.err('Maria cannot change created_by', $q$update public.locations set created_by = '00000000-0000-0000-0000-0000000000a2' where name = 'R21 Maria Site Renamed'$q$, 'customer can change only');
select rlstest.err('Maria cannot set updated_by to someone else', $q$update public.locations set updated_by = '00000000-0000-0000-0000-0000000000a2' where name = 'Howden'$q$, 'customer can change only');
select rlstest.err('Maria cannot clear created_by of her own location', $q$update public.locations set created_by = null where name = 'R21 Maria Site Renamed'$q$, 'customer can change only');
select rlstest.err('a business field together with is_active is refused as a whole', $q$update public.locations set notes = 'sneaky', is_active = false where name = 'R21 Maria Site Renamed'$q$, 'customer can change only');
select rlstest.err('Maria cannot turn both ship and receive off', $q$update public.locations set can_ship = false, can_receive = false where name = 'R21 Maria Site Renamed'$q$, 'ship, receive or both');
select rlstest.err('Maria cannot rename to a name of 121 characters', format($q$update public.locations set name = %L where name = 'R21 Maria Site Renamed'$q$, repeat('n', 121)), 'at most 120');
select rlstest.err('Maria cannot rename to an existing name', $q$update public.locations set name = 'Mitrex' where name = 'R21 Maria Site Renamed'$q$, 'duplicate key|locations_name_key');
select rlstest.rows('Maria cannot delete a location (no policy: nothing is deleted)', $q$delete from public.locations where name = 'R21 Maria Site Renamed'$q$, 0, $q$select 1 from public.locations where name = 'R21 Maria Site Renamed'$q$);
select rlstest.back();
do $t$
declare r public.locations := rlstest.loc('R21 Maria Site Renamed'); h public.locations := rlstest.loc('Howden');
begin
  perform rlstest.chk('every business field was saved',
    r.address_line = '9 New Road' and r.city = 'Mississauga' and r.postal_code = 'L5L 1A1' and r.can_ship and r.can_receive
    and r.requires_moffett and r.default_contact_name = 'Bo' and r.default_contact_phone = '905-555-0199' and r.notes = 'Back gate');
  perform rlstest.chk('the refused statements changed nothing (still active, no review, notes not sneaky, still there)',
    r.is_active and not r.needs_review and r.notes = 'Back gate');
  perform rlstest.chk('after her edit: updated_by is Maria, created_by still Maria', r.updated_by = '00000000-0000-0000-0000-0000000000c1' and r.created_by = '00000000-0000-0000-0000-0000000000c1');
  perform rlstest.chk('Howden: updated_by is Maria, created_by stays empty, the new address is stored',
    h.updated_by = '00000000-0000-0000-0000-0000000000c1' and h.created_by is null and h.address_line = '40 Howden Rd');
end $t$;

-- the booking rules read the edited flags at once: Moffett forced, receive switched off refused
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
do $t$
declare v text;
begin
  v := rlstest.load_to('R21 Maria Site Renamed');
  perform rlstest.rec('a load to her location now requiring Moffett stores moffett true (sent false)', case when v = 'true' then 'OK' else 'FAIL' end, v);
end $t$;
select rlstest.rows('Maria switches receiving off on her location (ships only)', $q$update public.locations set can_receive = false, requires_moffett = false where name = 'R21 Maria Site Renamed'$q$, 1);
select rlstest.err('a load delivering to it is refused at once', $q$select rlstest.load_to('R21 Maria Site Renamed')$q$, 'cannot receive');
select rlstest.back();

-- an inactive location: Maria neither sees nor changes it; an inactive customer user changes nothing
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.rows('control: staff deactivates the 120 character location', format($q$update public.locations set is_active = false where name = %L$q$, repeat('m', 120)), 1);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.rows('Maria cannot edit an inactive location', format($q$update public.locations set notes = 'x' where name = %L$q$, repeat('m', 120)), 0,
  format($q$select 1 from public.locations where name = %L$q$, repeat('m', 120)));
-- an UPDATE that reads no column skips the SELECT policy, so only the update policy keeps an inactive row out of reach
select rlstest.ok('Maria runs one UPDATE without a WHERE clause (it reaches only active rows)', $q$update public.locations set default_contact_phone = '416-555-0000'$q$);
select rlstest.back();
do $t$
begin
  perform rlstest.chk('guard: some active location took the blanket phone', exists (select 1 from public.locations where is_active and default_contact_phone = '416-555-0000'));
  perform rlstest.chk('the inactive location was NOT changed by that UPDATE (update policy: active only)',
    (select count(*) from public.locations where not is_active and default_contact_phone = '416-555-0000') = 0
    and (select count(*) from public.locations where not is_active) > 0);
end $t$;
select rlstest.as_user('00000000-0000-0000-0000-0000000000c7');
select rlstest.err('an inactive customer user cannot add a location', $q$insert into public.locations (name, address_line, city, province, can_ship) values ('R21 Inactive', 'x', 'y', 'ON', true)$q$, 'row-level security');
select rlstest.rows('an inactive customer user cannot edit a location', $q$update public.locations set notes = 'x' where name = 'Howden'$q$, 0, $q$select 1 from public.locations where name = 'Howden'$q$);
select rlstest.back();

-- 21d. carriers: no insert, no update, no delete (owner and driver)
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.cnt('guard: carrier A owner sees Howden (its booked load delivers there)', $q$select 1 from public.locations where name = 'Howden'$q$, 1);
select rlstest.err('carrier owner cannot add a location', $q$insert into public.locations (name, address_line, city, province, can_ship) values ('R21 Carrier', 'x', 'y', 'ON', true)$q$, 'row-level security');
select rlstest.rows('carrier owner cannot edit a location it sees', $q$update public.locations set notes = 'carrier' where name = 'Howden'$q$, 0, $q$select 1 from public.locations where name = 'Howden'$q$);
select rlstest.rows('carrier owner cannot delete a location it sees', $q$delete from public.locations where name = 'Howden'$q$, 0, $q$select 1 from public.locations where name = 'Howden'$q$);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000b2');
select rlstest.err('carrier driver cannot add a location', $q$insert into public.locations (name, address_line, city, province, can_ship) values ('R21 Driver', 'x', 'y', 'ON', true)$q$, 'row-level security');
select rlstest.rows('carrier driver cannot edit a location it sees', $q$update public.locations set notes = 'driver' where name = 'Howden'$q$, 0, $q$select 1 from public.locations where name = 'Howden'$q$);
select rlstest.back();
do $t$
begin
  perform rlstest.chk('no carrier statement changed Howden', (rlstest.loc('Howden')).notes is distinct from 'carrier' and (rlstest.loc('Howden')).notes is distinct from 'driver'
    and (rlstest.loc('Howden')).updated_by = '00000000-0000-0000-0000-0000000000c1');
end $t$;

-- 21e. staff: rights unchanged, but the author columns come from the session
select rlstest.as_user('00000000-0000-0000-0000-0000000000a2');
select rlstest.rows('staff_csr adds an inactive location that needs review (staff may set both)',
  $q$insert into public.locations (name, address_line, city, province, can_ship, can_receive, is_active, needs_review, created_by, updated_by, created_at)
     values ('R21 Staff Site', '5 Staff St', 'Toronto', 'ON', false, false, false, true, '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1', '2000-01-01')$q$, 1);
select rlstest.rows('staff_csr changes is_active and needs_review of Maria''s location', $q$update public.locations set needs_review = true, is_active = true where name = 'R21 Maria Site Renamed'$q$, 1);
select rlstest.rows('staff_csr sends created_by, created_at and updated_by on an update (kept and stamped instead)',
  $q$update public.locations set created_by = '00000000-0000-0000-0000-0000000000a2', created_at = '2000-01-01', updated_by = '00000000-0000-0000-0000-0000000000c1', notes = 'staff note' where name = 'R21 Maria Site Renamed'$q$, 1);
select rlstest.rows('staff_csr deletes an unused location', $q$delete from public.locations where name = 'R21 Max Notes'$q$, 1);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.rows('staff_admin edits Maria''s location too', $q$update public.locations set needs_review = false where name = 'R21 Maria Site Renamed'$q$, 1);
select rlstest.back();
do $t$
declare s public.locations := rlstest.loc('R21 Staff Site'); r public.locations := rlstest.loc('R21 Maria Site Renamed');
begin
  perform rlstest.chk('staff insert keeps is_active false, needs_review true and no flags (staff rights unchanged)',
    s.id is not null and not s.is_active and s.needs_review and not s.can_ship and not s.can_receive);
  perform rlstest.chk('staff insert: created_by is the csr (not the Maria it sent), updated_by empty, created_at the server time',
    s.created_by = '00000000-0000-0000-0000-0000000000a2' and s.updated_by is null and s.created_at = now());
  perform rlstest.chk('staff update: created_by stays Maria, created_at unchanged, updated_by is the LAST staff editor (staff_admin)',
    r.created_by = '00000000-0000-0000-0000-0000000000c1' and r.created_at = now() and r.updated_by = '00000000-0000-0000-0000-0000000000a1'
    and r.notes = 'staff note' and not r.needs_review);
  perform rlstest.chk('the staff delete removed the row', (rlstest.loc('R21 Max Notes')).id is null);
end $t$;

-- 21f. the service role and owner tooling (no JWT) stay unrestricted, like today
insert into public.locations (name, address_line, city, province, can_ship, created_by, created_at)
  values ('R21 Owner Tooling', '1 Owner St', 'Toronto', 'ON', true, '00000000-0000-0000-0000-0000000000a1', '2001-02-03');
update public.locations set is_active = false where name = 'R21 Owner Tooling';
do $t$
declare o public.locations := rlstest.loc('R21 Owner Tooling');
begin
  perform rlstest.chk('owner tooling keeps what it sends (created_by, created_at) and writes no updated_by',
    o.created_by = '00000000-0000-0000-0000-0000000000a1' and o.created_at = '2001-02-03' and o.updated_by is null and not o.is_active);
end $t$;

-- 21g. deleting a profile clears its author columns, even when the delete runs inside a signed-in session
select rlstest.as_user('00000000-0000-0000-0000-0000000000c8');
select rlstest.rows('control: the soon deleted customer user adds a location', $q$insert into public.locations (name, address_line, city, province, can_ship) values ('R21 Gone Author', '1 Gone St', 'Toronto', 'ON', true)$q$, 1);
select rlstest.rows('control: and edits Howden (last editor)', $q$update public.locations set notes = 'gone note' where name = 'Howden'$q$, 1);
select rlstest.back();
do $t$
begin
  -- the table owner deletes the user while a staff JWT is set (the trigger sees a signed-in staff caller)
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);
  delete from auth.users where id = '00000000-0000-0000-0000-0000000000c8';
  perform set_config('request.jwt.claims', '', true);
  perform rlstest.chk('guard: the profile is gone', not exists (select 1 from public.profiles where id = '00000000-0000-0000-0000-0000000000c8'));
  perform rlstest.chk('the location of a deleted author stays, with created_by cleared',
    (rlstest.loc('R21 Gone Author')).id is not null and (rlstest.loc('R21 Gone Author')).created_by is null);
  perform rlstest.chk('the last editor column of Howden was cleared or restamped, never left dangling',
    (rlstest.loc('Howden')).updated_by is distinct from '00000000-0000-0000-0000-0000000000c8');
end $t$;

-- 21h. the migration is idempotent: apply the REAL file again, one trigger each, five policies, the rules still hold
\i supabase/migrations/0021_customer_locations.sql
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.rows('after a second apply Maria still adds a location', $q$insert into public.locations (name, address_line, city, province, can_ship, is_active, needs_review) values ('R21 Second Apply', '1 Again St', 'Toronto', 'ON', true, false, true)$q$, 1);
select rlstest.err('after a second apply Maria still cannot change is_active', $q$update public.locations set is_active = false where name = 'R21 Second Apply'$q$, 'customer can change only');
select rlstest.back();
do $t$
begin
  perform rlstest.chk('0021 applied again: one insert trigger, one update guard trigger, five policies, flags still forced',
    (select count(*) from pg_trigger where tgrelid = 'public.locations'::regclass and tgname = 'locations_before_insert') = 1
    and (select count(*) from pg_trigger where tgrelid = 'public.locations'::regclass and tgname = 'locations_before_update') = 1
    and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'locations') = 5
    and (rlstest.loc('R21 Second Apply')).is_active and not (rlstest.loc('R21 Second Apply')).needs_review
    and (rlstest.loc('R21 Second Apply')).created_by = '00000000-0000-0000-0000-0000000000c1');
end $t$;

-- 22. A carrier never sees a load that was never booked to it (0022, DLV-043 CAR-01) ------------------------------------
-- Staff may save a carrier on a request before booking it. If that request is then cancelled (by Maria or by staff)
-- the status leaves 'requested' but the load was never booked: the carrier must see neither the load, its timeline,
-- its documents nor the locations it uses, and Maria must not see that carrier. A booked then cancelled load stays.
-- Carrier C (own owner and driver) is fresh, so no earlier section can make it visible through another load.
\set C22 '20000000-0000-0000-0000-00000000022c'
\set O22 '00000000-0000-0000-0000-0000000002b1'
\set D22 '00000000-0000-0000-0000-0000000002b2'
\set R22A '32200000-0000-0000-0000-0000000000a1'
\set R22B '32200000-0000-0000-0000-0000000000b1'
\set R22C '32200000-0000-0000-0000-0000000000c1'
\set R22D '32200000-0000-0000-0000-0000000000d1'
select rlstest.set_active('00000000-0000-0000-0000-0000000000a1', true);
select rlstest.set_active('00000000-0000-0000-0000-0000000000c1', true);
insert into public.carriers (id, name) values (:'C22', 'R22 Carrier C');
insert into auth.users (id, aud, role, email) values
  (:'O22', 'authenticated', 'authenticated', 'owner22@t.test'),
  (:'D22', 'authenticated', 'authenticated', 'driver22@t.test');
insert into public.profiles (id, email, role, customer_id, carrier_id) values
  (:'O22', 'owner22@t.test', 'carrier_owner', null, :'C22'),
  (:'D22', 'driver22@t.test', 'carrier_driver', null, :'C22');
-- one private pickup site per load, used by nothing else, so the location check is about that load alone
insert into public.locations (name, address_line, city, province, can_ship, can_receive) values
  ('R22 Secret A', '1 Hidden Rd', 'Toronto', 'ON', true, true),
  ('R22 Secret B', '2 Hidden Rd', 'Toronto', 'ON', true, true),
  ('R22 Secret C', '3 Hidden Rd', 'Toronto', 'ON', true, true),
  ('R22 Secret D', '4 Hidden Rd', 'Toronto', 'ON', true, true);
-- R22A: requested with carrier C, Maria cancels. R22B: requested with carrier C, staff cancel.
-- R22C: requested with carrier C, staff book it, then staff cancel (control: stays visible).
-- R22D: put at delivered directly with carrier C and no booked_at (owner tooling and e2e fixtures do this; control).
select rlstest.mkorig(:'R22A', (select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c1', 'R22 Secret A', 'Howden', 'requested', :'C22');
select rlstest.mkorig(:'R22B', (select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c1', 'R22 Secret B', 'Howden', 'requested', :'C22');
select rlstest.mkorig(:'R22C', (select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c1', 'R22 Secret C', 'Howden', 'requested', :'C22');
select rlstest.mkorig(:'R22D', (select id from public.customers where name = 'Mitrex'), '00000000-0000-0000-0000-0000000000c1', 'R22 Secret D', 'Howden', 'delivered', :'C22');
insert into storage.objects (bucket_id, name) values
  ('documents', :'R22A' || '/bol/b2200000-0000-0000-0000-0000000000a1.pdf'),
  ('documents', :'R22B' || '/bol/b2200000-0000-0000-0000-0000000000b1.pdf'),
  ('documents', :'R22C' || '/bol/b2200000-0000-0000-0000-0000000000c1.pdf'),
  ('documents', :'R22D' || '/bol/b2200000-0000-0000-0000-0000000000d1.pdf');
insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values
  (:'R22A', 'bol', :'R22A' || '/bol/b2200000-0000-0000-0000-0000000000a1.pdf', '00000000-0000-0000-0000-0000000000a1'),
  (:'R22B', 'bol', :'R22B' || '/bol/b2200000-0000-0000-0000-0000000000b1.pdf', '00000000-0000-0000-0000-0000000000a1'),
  (:'R22C', 'bol', :'R22C' || '/bol/b2200000-0000-0000-0000-0000000000c1.pdf', '00000000-0000-0000-0000-0000000000a1'),
  (:'R22D', 'bol', :'R22D' || '/bol/b2200000-0000-0000-0000-0000000000d1.pdf', '00000000-0000-0000-0000-0000000000a1');

-- What one carrier user sees of one load: the load, its timeline, both document tables, the doc function, its pickup site.
create function rlstest.sees22(p_name text, p_load text, p_site text, p_expected int) returns void language plpgsql as $f$
begin
  perform rlstest.cnt(p_name || ': the load', format($q$select 1 from public.loads where id = %L::uuid$q$, p_load), p_expected,
    format($q$select 1 from public.loads where id = %L::uuid$q$, p_load));
  perform rlstest.cnt(p_name || ': its timeline', format($q$select 1 from public.load_events where load_id = %L::uuid$q$, p_load),
    case when p_expected = 0 then 0 else rlstest.su_count(format($q$select 1 from public.load_events where load_id = %L::uuid$q$, p_load)) end,
    format($q$select 1 from public.load_events where load_id = %L::uuid$q$, p_load));
  perform rlstest.cnt(p_name || ': the BOL row', format($q$select 1 from public.load_documents where load_id = %L::uuid$q$, p_load), p_expected,
    format($q$select 1 from public.load_documents where load_id = %L::uuid$q$, p_load));
  perform rlstest.cnt(p_name || ': the BOL object', format($q$select 1 from storage.objects where bucket_id = 'documents' and name like %L$q$, p_load || '/bol/%'), p_expected,
    format($q$select 1 from storage.objects where bucket_id = 'documents' and name like %L$q$, p_load || '/bol/%'));
  perform rlstest.chk(p_name || ': dlv_can_access_doc read',
    public.dlv_can_access_doc(p_load || '/bol/b2200000-0000-0000-0000-0000000000' || right(p_load, 2) || '.pdf', false) = (p_expected = 1));
  perform rlstest.cnt(p_name || ': the private pickup site', format($q$select 1 from public.locations where name = %L$q$, p_site), p_expected,
    format($q$select 1 from public.locations where name = %L$q$, p_site));
end $f$;
grant execute on all functions in schema rlstest to authenticated, anon;

-- 22a. while requested (control: the old rule already hid these)
select rlstest.as_user(:'O22');
select rlstest.sees22('carrier C owner, R22A requested', :'R22A', 'R22 Secret A', 0);
select rlstest.back();

-- the cancels, through the real function: Maria cancels R22A, staff cancel R22B; staff book then cancel R22C
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.ok('Maria cancels her request R22A that has a carrier saved', format($q$select public.set_load_status(%L, 'cancelled', null, 'R22 Maria cancel')$q$, :'R22A'));
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.ok('staff cancel the request R22B that has a carrier saved', format($q$select public.set_load_status(%L, 'cancelled', null, 'R22 staff cancel')$q$, :'R22B'));
select rlstest.ok('staff set the ITS number of R22C', format($q$select public.set_its_load_number(%L, '92201')$q$, :'R22C'));
select rlstest.ok('staff book R22C', format($q$select public.set_load_status(%L, 'booked', null, null)$q$, :'R22C'));
select rlstest.ok('staff cancel the booked R22C', format($q$select public.set_load_status(%L, 'cancelled', null, 'R22 booked then cancelled')$q$, :'R22C'));
select rlstest.back();
do $t$
begin
  perform rlstest.chk('guard: R22A and R22B are cancelled with carrier C and were never booked',
    (select count(*) from public.loads where id in ('32200000-0000-0000-0000-0000000000a1', '32200000-0000-0000-0000-0000000000b1')
       and status = 'cancelled' and booked_at is null and carrier_id = '20000000-0000-0000-0000-00000000022c') = 2);
  perform rlstest.chk('guard: R22C is cancelled with carrier C and has booked_at',
    (select count(*) from public.loads where id = '32200000-0000-0000-0000-0000000000c1'
       and status = 'cancelled' and booked_at is not null and carrier_id = '20000000-0000-0000-0000-00000000022c') = 1);
  perform rlstest.chk('guard: R22D is delivered with carrier C and no booked_at',
    (select count(*) from public.loads where id = '32200000-0000-0000-0000-0000000000d1'
       and status = 'delivered' and booked_at is null and carrier_id = '20000000-0000-0000-0000-00000000022c') = 1);
end $t$;

-- 22b. the carrier owner and driver see nothing of the never booked cancelled loads, and still see the controls
select rlstest.as_user(:'O22');
select rlstest.sees22('carrier C owner, R22A cancelled by Maria, never booked', :'R22A', 'R22 Secret A', 0);
select rlstest.sees22('carrier C owner, R22B cancelled by staff, never booked', :'R22B', 'R22 Secret B', 0);
select rlstest.sees22('control: carrier C owner, R22C booked then cancelled', :'R22C', 'R22 Secret C', 1);
select rlstest.sees22('control: carrier C owner, R22D delivered without booked_at', :'R22D', 'R22 Secret D', 1);
select rlstest.cnt('carrier C owner reads the contact phone of no never booked load',
  $q$select 1 from public.loads where pickup_contact_phone = '416-000-0001' and id in ('32200000-0000-0000-0000-0000000000a1', '32200000-0000-0000-0000-0000000000b1')$q$, 0,
  $q$select 1 from public.loads where id in ('32200000-0000-0000-0000-0000000000a1', '32200000-0000-0000-0000-0000000000b1')$q$);
select rlstest.cnt('control: carrier C owner reads its own carrier row', $q$select 1 from public.carriers where id = '20000000-0000-0000-0000-00000000022c'$q$, 1);
select rlstest.err('carrier C owner cannot upload a POD to the never booked R22A',
  rlstest.sins(:'R22A' || '/pod/b2200000-0000-0000-0000-0000000001a1.jpg'), 'row-level security');
select rlstest.back();
select rlstest.as_user(:'D22');
select rlstest.sees22('carrier C driver, R22A cancelled by Maria, never booked', :'R22A', 'R22 Secret A', 0);
select rlstest.sees22('carrier C driver, R22B cancelled by staff, never booked', :'R22B', 'R22 Secret B', 0);
select rlstest.sees22('control: carrier C driver, R22C booked then cancelled', :'R22C', 'R22 Secret C', 1);
select rlstest.back();

-- 22c. Maria sees carrier C only through the load that was booked (R22C) or is live (R22D); without them, not at all
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.cnt('control: Maria sees carrier C while it carries R22C and R22D', $q$select 1 from public.carriers where id = '20000000-0000-0000-0000-00000000022c'$q$, 1);
select rlstest.back();
do $t$ begin
  perform set_config('dlv.status_fn', '1', true);
  update public.loads set carrier_id = null where id in ('32200000-0000-0000-0000-0000000000c1', '32200000-0000-0000-0000-0000000000d1');
  perform set_config('dlv.status_fn', '0', true);
end $t$;
select rlstest.as_user('00000000-0000-0000-0000-0000000000c1');
select rlstest.cnt('Maria does not see carrier C through her never booked cancelled requests', $q$select 1 from public.carriers where id = '20000000-0000-0000-0000-00000000022c'$q$, 0,
  $q$select 1 from public.carriers where id = '20000000-0000-0000-0000-00000000022c'$q$);
select rlstest.chk('dlv_customer_can_see_carrier is false for carrier C', not public.dlv_customer_can_see_carrier('20000000-0000-0000-0000-00000000022c'));
select rlstest.cnt('control: Maria still reads her cancelled requests R22A and R22B', $q$select 1 from public.loads where id in ('32200000-0000-0000-0000-0000000000a1', '32200000-0000-0000-0000-0000000000b1')$q$, 2);
select rlstest.back();
select rlstest.as_user('00000000-0000-0000-0000-0000000000a1');
select rlstest.cnt('control: staff read both never booked cancelled loads and their BOL rows',
  $q$select 1 from public.load_documents where load_id in ('32200000-0000-0000-0000-0000000000a1', '32200000-0000-0000-0000-0000000000b1')$q$, 2);
select rlstest.back();

-- 22d. definitions and grants: the four rules carry the booked_at clause; nothing else widened; the real file applies again
do $t$
begin
  perform rlstest.chk('loads_select carrier branch carries the cancelled and booked_at clause',
    (select qual from pg_policies where schemaname = 'public' and tablename = 'loads' and policyname = 'loads_select') like '%booked_at IS NOT NULL%');
  perform rlstest.chk('the three helpers carry the booked_at clause',
    position('booked_at is not null' in pg_get_functiondef('public.dlv_carrier_can_see_location(uuid)'::regprocedure)) > 0
    and position('booked_at is not null' in pg_get_functiondef('public.dlv_customer_can_see_carrier(uuid)'::regprocedure)) > 0
    and position('booked_at is null' in pg_get_functiondef('public.dlv_can_access_doc(text, boolean)'::regprocedure)) > 0);
  perform rlstest.chk('anon executes none of the three helpers; authenticated executes all three',
    not has_function_privilege('anon', 'public.dlv_carrier_can_see_location(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.dlv_customer_can_see_carrier(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.dlv_can_access_doc(text, boolean)', 'execute')
    and has_function_privilege('authenticated', 'public.dlv_carrier_can_see_location(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.dlv_customer_can_see_carrier(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.dlv_can_access_doc(text, boolean)', 'execute'));
end $t$;
\i supabase/migrations/0022_carrier_never_booked_cancel.sql
do $t$
begin
  perform rlstest.chk('0022 applied again: exactly one loads_select policy',
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'loads' and policyname = 'loads_select') = 1);
end $t$;
select rlstest.as_user(:'O22');
select rlstest.sees22('after a second apply, carrier C owner, R22A', :'R22A', 'R22 Secret A', 0);
select rlstest.back();

-- Summary ----------------------------------------------------------------
select name, outcome, detail from rlstest.res where outcome <> 'OK' order by n;
select 'RLS_OK ' || count(*) filter (where outcome = 'OK') || ' OK / '
    || count(*) filter (where outcome = 'VACUOUS') || ' VACUOUS / '
    || count(*) filter (where outcome = 'FAIL') || ' FAIL' as summary
from rlstest.res;
do $t$
begin
  if exists (select 1 from rlstest.res where outcome = 'FAIL') then
    raise exception 'RLS FAIL';
  end if;
end $t$;
rollback;
