-- DLV Mitrex portal: helpers, guards, status machine.

-- Identity helpers (SECURITY DEFINER so policies never recurse into profiles RLS).
create function public.dlv_role() returns text
language sql stable security definer set search_path = ''
as $fn$ select p.role::text from public.profiles p where p.id = auth.uid() $fn$;

create function public.dlv_is_staff() returns boolean
language sql stable security definer set search_path = ''
as $fn$ select coalesce((select p.role in ('staff_admin','staff_csr') from public.profiles p where p.id = auth.uid()), false) $fn$;

create function public.dlv_is_admin() returns boolean
language sql stable security definer set search_path = ''
as $fn$ select coalesce((select p.role = 'staff_admin' from public.profiles p where p.id = auth.uid()), false) $fn$;

create function public.dlv_customer_id() returns uuid
language sql stable security definer set search_path = ''
as $fn$ select p.customer_id from public.profiles p where p.id = auth.uid() $fn$;

create function public.dlv_carrier_id() returns uuid
language sql stable security definer set search_path = ''
as $fn$ select p.carrier_id from public.profiles p where p.id = auth.uid() $fn$;

-- Carrier may see a location only when one of its loads uses it.
create function public.dlv_carrier_can_see_location(loc uuid) returns boolean
language sql stable security definer set search_path = ''
as $fn$
  select exists (
    select 1 from public.loads l
    where l.carrier_id = public.dlv_carrier_id()
      and l.status <> 'requested'
      and (l.pickup_location_id = loc or l.delivery_location_id = loc))
$fn$;

-- Customer may see a carrier only when it carries one of its loads.
create function public.dlv_customer_can_see_carrier(car uuid) returns boolean
language sql stable security definer set search_path = ''
as $fn$
  select exists (
    select 1 from public.loads l
    where l.customer_id = public.dlv_customer_id()
      and l.carrier_id = car and l.status <> 'requested')
$fn$;

-- Document access by storage path {load_id}/{kind}/{file}. write = upload.
create function public.dlv_can_access_doc(path text, write boolean) returns boolean
language plpgsql stable security definer set search_path = ''
as $fn$
declare
  v_load uuid;
  v_kind text;
  l public.loads;
  v_role text := public.dlv_role();
begin
  if v_role is null then return false; end if;
  begin
    v_load := split_part(path, '/', 1)::uuid;
  exception when others then
    return false;
  end;
  v_kind := split_part(path, '/', 2);
  if v_kind not in ('bol','pod') then return false; end if;
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
    return v_kind = 'pod' and l.status in ('enroute','at_delivery');
  end if;
  return true;
end
$fn$;

-- updated_at
create function public.dlv_touch_updated_at() returns trigger
language plpgsql set search_path = ''
as $fn$ begin new.updated_at := now(); return new; end $fn$;

-- Location rules shared by insert and update of a load.
create function public.dlv_check_load_locations(p public.loads) returns boolean
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

-- BEFORE INSERT: non-staff cannot smuggle workflow fields.
create function public.dlv_loads_before_insert() returns trigger
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
  end if;
  return new;
end
$fn$;

create function public.dlv_loads_after_insert() returns trigger
language plpgsql security definer set search_path = ''
as $fn$
begin
  insert into public.load_events (load_id, from_status, to_status, actor_id, note)
  values (new.id, null, new.status, new.created_by, 'Load requested');
  return new;
end
$fn$;

-- BEFORE UPDATE: protected columns never change by direct UPDATE.
create function public.dlv_loads_before_update() returns trigger
language plpgsql set search_path = ''
as $fn$
declare v_moff boolean;
begin
  new.updated_at := now();
  if auth.uid() is null then return new; end if;  -- service role / owner tooling
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

create trigger loads_before_insert before insert on public.loads
  for each row execute function public.dlv_loads_before_insert();
create trigger loads_after_insert after insert on public.loads
  for each row execute function public.dlv_loads_after_insert();
create trigger loads_before_update before update on public.loads
  for each row execute function public.dlv_loads_before_update();

-- Customers may change only the default contact on a location.
create function public.dlv_locations_before_update() returns trigger
language plpgsql set search_path = ''
as $fn$
begin
  if auth.uid() is null or public.dlv_is_staff() then return new; end if;
  if (to_jsonb(new) - 'default_contact_name' - 'default_contact_phone')
     is distinct from
     (to_jsonb(old) - 'default_contact_name' - 'default_contact_phone') then
    raise exception 'only default contact fields are editable' using errcode = '42501';
  end if;
  return new;
end
$fn$;
create trigger locations_before_update before update on public.locations
  for each row execute function public.dlv_locations_before_update();

-- Status machine ---------------------------------------------------------

create function public.dlv_step_index(s public.load_status) returns int
language sql immutable set search_path = ''
as $fn$
  select case s
    when 'requested' then 0 when 'booked' then 1 when 'at_pickup' then 2
    when 'loading' then 3 when 'enroute' then 4 when 'at_delivery' then 5
    when 'delivered' then 6 else null end
$fn$;

create function public.set_load_status(
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
  v_has_pod boolean;
  v_old public.load_status;
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

  v_eta := coalesce(p_eta, l.eta);
  if p_status = 'enroute' and v_eta is null then
    raise exception 'eta is required for enroute' using errcode = 'P0001';
  end if;
  if p_status = 'delivered' then
    select exists (select 1 from public.load_documents d where d.load_id = l.id and d.kind = 'pod')
      into v_has_pod;
    if not v_has_pod then
      raise exception 'a POD document is required for delivered' using errcode = 'P0001';
    end if;
  end if;

  v_old := l.status;
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

  insert into public.load_events (load_id, from_status, to_status, actor_id, note)
  values (l.id, v_old, p_status, auth.uid(), p_note);
  return l;
end
$fn$;

-- ETA edit for carrier (and staff) only while enroute or at_delivery.
create function public.set_load_eta(p_load uuid, p_eta timestamptz, p_note text default null)
returns public.loads
language plpgsql security definer set search_path = ''
as $fn$
declare l public.loads;
begin
  if auth.uid() is null or public.dlv_role() is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_eta is null then raise exception 'eta is required' using errcode = 'P0001'; end if;
  select * into l from public.loads where id = p_load for update;
  if not found then raise exception 'load not found' using errcode = 'P0002'; end if;
  if not public.dlv_is_staff() and (
       public.dlv_role() not in ('carrier_owner','carrier_driver')
       or l.carrier_id is distinct from public.dlv_carrier_id()) then
    raise exception 'not your load' using errcode = '42501';
  end if;
  if l.status not in ('enroute','at_delivery') then
    raise exception 'eta can change only while enroute or at delivery' using errcode = 'P0001';
  end if;
  perform set_config('dlv.status_fn', '1', true);
  update public.loads set eta = p_eta where id = l.id returning * into l;
  perform set_config('dlv.status_fn', '0', true);
  insert into public.load_events (load_id, from_status, to_status, actor_id, note)
  values (l.id, l.status, l.status, auth.uid(), coalesce(p_note, 'ETA updated'));
  return l;
end
$fn$;

-- Location request review (staff only).
create function public.approve_location_request(p_request uuid)
returns public.location_requests
language plpgsql security definer set search_path = ''
as $fn$
declare r public.location_requests; v_id uuid;
begin
  if not public.dlv_is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  select * into r from public.location_requests where id = p_request for update;
  if not found then raise exception 'request not found' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then raise exception 'request already reviewed' using errcode = 'P0001'; end if;
  if r.kind = 'new' then
    insert into public.locations (name, address_line, city, province, postal_code,
      can_ship, can_receive, requires_moffett, default_contact_name, default_contact_phone, notes, needs_review)
    values (r.payload->>'name', r.payload->>'address_line', r.payload->>'city',
      coalesce(r.payload->>'province', 'ON'), nullif(r.payload->>'postal_code', ''),
      coalesce((r.payload->>'can_ship')::boolean, false),
      coalesce((r.payload->>'can_receive')::boolean, true),
      coalesce((r.payload->>'requires_moffett')::boolean, false),
      r.payload->>'default_contact_name', r.payload->>'default_contact_phone',
      r.payload->>'notes', (r.payload->>'postal_code') is null or (r.payload->>'postal_code') = '')
    returning id into v_id;
    update public.location_requests set location_id = v_id where id = r.id;
  else
    update public.locations set
      name = coalesce(r.payload->>'name', name),
      address_line = coalesce(r.payload->>'address_line', address_line),
      city = coalesce(r.payload->>'city', city),
      province = coalesce(r.payload->>'province', province),
      postal_code = coalesce(nullif(r.payload->>'postal_code', ''), postal_code),
      needs_review = case when coalesce(nullif(r.payload->>'postal_code', ''), postal_code) is null
                          then true else false end
    where id = r.location_id;
  end if;
  update public.location_requests set status = 'approved' where id = r.id returning * into r;
  return r;
end
$fn$;

create function public.reject_location_request(p_request uuid)
returns public.location_requests
language plpgsql security definer set search_path = ''
as $fn$
declare r public.location_requests;
begin
  if not public.dlv_is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  update public.location_requests set status = 'rejected'
    where id = p_request and status = 'pending' returning * into r;
  if not found then raise exception 'pending request not found' using errcode = 'P0002'; end if;
  return r;
end
$fn$;
