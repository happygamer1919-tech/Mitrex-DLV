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
select rlstest.ok('control: enroute with eta', $q$select public.set_load_status('30000000-0000-0000-0000-000000000002', 'enroute', now() + interval '3 hours')$q$);
select rlstest.ok('control: eta editable while enroute', $q$select public.set_load_eta('30000000-0000-0000-0000-000000000002', now() + interval '4 hours')$q$);
select rlstest.ok('control: carrier moves to at_delivery', $q$select public.set_load_status('30000000-0000-0000-0000-000000000002', 'at_delivery')$q$);
select rlstest.err('carrier cannot upload a BOL', $q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values ('30000000-0000-0000-0000-000000000002', 'bol', '30000000-0000-0000-0000-000000000002/bol/a0000000-0000-0000-0000-0000000000f2.pdf', '00000000-0000-0000-0000-0000000000b1')$q$, 'row-level security');
select rlstest.err('carrier A cannot upload POD to carrier B load', $q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values ('30000000-0000-0000-0000-000000000003', 'pod', '30000000-0000-0000-0000-000000000003/pod/a0000000-0000-0000-0000-0000000000f1.jpg', '00000000-0000-0000-0000-0000000000b1')$q$, 'row-level security');
select rlstest.ok('control: carrier uploads POD row', $q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values ('30000000-0000-0000-0000-000000000002', 'pod', '30000000-0000-0000-0000-000000000002/pod/a0000000-0000-0000-0000-0000000000f1.jpg', '00000000-0000-0000-0000-0000000000b1')$q$);
select rlstest.ok('control: carrier uploads POD file', $q$insert into storage.objects (bucket_id, name, owner) values ('documents', '30000000-0000-0000-0000-000000000002/pod/a0000000-0000-0000-0000-0000000000f1.jpg', '00000000-0000-0000-0000-0000000000b1')$q$);
select rlstest.err('carrier cannot upload a BOL file', $q$insert into storage.objects (bucket_id, name, owner) values ('documents', '30000000-0000-0000-0000-000000000002/bol/a0000000-0000-0000-0000-0000000000f2.pdf', '00000000-0000-0000-0000-0000000000b1')$q$, 'row-level security');
select rlstest.ok('control: delivered with POD', $q$select public.set_load_status('30000000-0000-0000-0000-000000000002', 'delivered')$q$);
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
select rlstest.err('customer cannot edit an address', $q$update public.locations set address_line = 'x' where name = 'Howden'$q$, 'only default contact');
select rlstest.err('customer cannot create a location', $q$insert into public.locations (name, address_line, city, province) values ('N','a','b','ON')$q$, 'row-level security');
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
select rlstest.err('customer still cannot edit an address (updated_at is not a loophole)', $q$update public.locations set address_line = 'y', updated_at = now() where name = 'Howden'$q$, 'only default contact');
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
select rlstest.ok('walk: carrier enroute', format($q$select public.set_load_status(%L, 'enroute', now() + interval '3 hours')$q$, :'L20'));
select rlstest.ok('walk: carrier at_delivery', format($q$select public.set_load_status(%L, 'at_delivery')$q$, :'L20'));
select rlstest.ok('walk: carrier uploads POD row', format($q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values (%L, 'pod', %L, '00000000-0000-0000-0000-0000000000b1')$q$, :'L20', :'L20' || '/pod/a0000000-0000-0000-0000-000000000020.jpg'));
select rlstest.ok('walk: carrier delivered', format($q$select public.set_load_status(%L, 'delivered')$q$, :'L20'));
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
select rlstest.as_user('00000000-0000-0000-0000-0000000000b1');
select rlstest.ok('delivered without a POD is allowed (carrier owner)', $q$select public.set_load_status('30000000-0000-0000-0000-000000000040', 'delivered')$q$);
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
