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
  ('00000000-0000-0000-0000-0000000000b3', 'authenticated', 'authenticated', 'ownerb@t.test');

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
  ('00000000-0000-0000-0000-0000000000b3', 'ownerb@t.test', 'carrier_owner', null, '20000000-0000-0000-0000-00000000000b');

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
    48, 'appointment', current_date + 1, '08:00', 'appointment', current_date + 1, '14:00',
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

-- staff positive control for carrier_id and status
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

-- 4. carrier steps: cannot skip, eta required, POD required --------------
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
select rlstest.err('delivered without POD rejected', $q$select public.set_load_status('30000000-0000-0000-0000-000000000002', 'delivered')$q$, 'POD');
select rlstest.err('carrier cannot upload a BOL', $q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values ('30000000-0000-0000-0000-000000000002', 'bol', '30000000-0000-0000-0000-000000000002/bol/x.pdf', '00000000-0000-0000-0000-0000000000b1')$q$, 'row-level security');
select rlstest.err('carrier A cannot upload POD to carrier B load', $q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values ('30000000-0000-0000-0000-000000000003', 'pod', '30000000-0000-0000-0000-000000000003/pod/x.jpg', '00000000-0000-0000-0000-0000000000b1')$q$, 'row-level security');
select rlstest.ok('control: carrier uploads POD row', $q$insert into public.load_documents (load_id, kind, storage_path, uploaded_by) values ('30000000-0000-0000-0000-000000000002', 'pod', '30000000-0000-0000-0000-000000000002/pod/x.jpg', '00000000-0000-0000-0000-0000000000b1')$q$);
select rlstest.ok('control: carrier uploads POD file', $q$insert into storage.objects (bucket_id, name, owner) values ('documents', '30000000-0000-0000-0000-000000000002/pod/x.jpg', '00000000-0000-0000-0000-0000000000b1')$q$);
select rlstest.err('carrier cannot upload a BOL file', $q$insert into storage.objects (bucket_id, name, owner) values ('documents', '30000000-0000-0000-0000-000000000002/bol/x.pdf', '00000000-0000-0000-0000-0000000000b1')$q$, 'row-level security');
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
select rlstest.cnt('control: Maria reads timeline of own load', $q$select 1 from public.load_events where load_id = '30000000-0000-0000-0000-000000000002'$q$, 7);
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
          and not public.dlv_can_access_doc('30000000-0000-0000-0000-000000000006/pod/x.pdf', false) then 'OK' else 'FAIL' end);
  perform rlstest.back();
  perform rlstest.set_active(v_adm, true);
  perform rlstest.as_user(v_adm);
  perform rlstest.rec('control: active admin: dlv_is_admin true, doc access allowed',
    case when public.dlv_is_admin() and public.dlv_role() = 'staff_admin'
          and public.dlv_can_access_doc('30000000-0000-0000-0000-000000000006/pod/x.pdf', false) then 'OK' else 'FAIL' end);
  perform rlstest.back();

  -- authenticated cannot write profiles
  perform rlstest.as_user(v_adm);
  perform rlstest.err('authenticated cannot update profiles.is_active',
    $q$update public.profiles set is_active = false where id = '00000000-0000-0000-0000-0000000000c1'$q$, 'permission denied');
  perform rlstest.back();
end $t$;

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
