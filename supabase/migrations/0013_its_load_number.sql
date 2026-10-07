-- 0013: ITS load number (DLV-025). DLV dispatches in ITS and the ITS load number is the source of truth.
-- Maria's request keeps the generated MTX-0001 style value in loads.load_number as the internal REQUEST REF
-- (unchanged, still unique, still generated at insert). Staff enter the new ITS number before a load can be booked.
--   * loads.its_load_number text NULL, CHECK digits with an optional dash and digits (313 or 313-2), partial
--     UNIQUE index where not null. Adding a nullable column is metadata only; existing loads stay valid.
--   * set_its_load_number(p_load, p_number): staff only, trims, validates, refuses duplicates (names the other
--     load's request ref), logs a load_events row (from=to=current status), sets the number. Equal number is a no-op.
--   * dlv_loads_before_insert (0002 body + one rule): a non staff insert gets its_load_number = NULL.
--   * dlv_loads_before_update (0002 body + one rule): no direct change of its_load_number for any signed in user,
--     only through set_its_load_number (GUC dlv.its_fn). Service role / owner tooling (auth.uid() null) is unchanged.
--   * set_load_status: the 0011 body with ONE added rule (marked "0013" below), nothing else changed. Diff the two
--     bodies to confirm.
-- Idempotent (IF NOT EXISTS, CREATE OR REPLACE, grants restated by name).

alter table public.loads add column if not exists its_load_number text;

do $do$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.loads'::regclass and conname = 'loads_its_load_number_format') then
    alter table public.loads add constraint loads_its_load_number_format
      check (its_load_number is null or its_load_number ~ '^[0-9]+(-[0-9]+)?$');
  end if;
end
$do$;

create unique index if not exists loads_its_load_number_key on public.loads (its_load_number) where its_load_number is not null;

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

create or replace function public.set_its_load_number(p_load uuid, p_number text)
returns public.loads
language plpgsql security definer set search_path = ''
as $fn$
declare
  l public.loads;
  v_num text := btrim(coalesce(p_number, ''));
  v_other text;
  v_old text;
begin
  if auth.uid() is null or not public.dlv_is_staff() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_num = '' then
    raise exception 'enter the ITS load number' using errcode = 'P0001';
  end if;
  if v_num !~ '^[0-9]+(-[0-9]+)?$' then
    raise exception 'ITS load number must be digits, optionally with a dash and digits (for example 313 or 313-2)' using errcode = 'P0001';
  end if;
  select * into l from public.loads where id = p_load for update;
  if not found then raise exception 'load not found' using errcode = 'P0002'; end if;
  select o.load_number into v_other from public.loads o where o.its_load_number = v_num and o.id <> l.id limit 1;
  if v_other is not null then
    raise exception 'ITS load number % is already used by another load (request %)', v_num, v_other using errcode = 'P0001';
  end if;
  v_old := l.its_load_number;
  if v_old is not distinct from v_num then return l; end if;  -- nothing to change, no event
  perform set_config('dlv.its_fn', '1', true);
  update public.loads set its_load_number = v_num where id = l.id returning * into l;
  perform set_config('dlv.its_fn', '0', true);
  insert into public.load_events (load_id, from_status, to_status, actor_id, note)
  values (l.id, l.status, l.status, auth.uid(),
    case when v_old is null then 'ITS load number set to ' || v_num
         else 'ITS load number changed from ' || v_old || ' to ' || v_num end);
  return l;
end
$fn$;

revoke all on function public.set_its_load_number(uuid, text) from public, anon;
grant execute on function public.set_its_load_number(uuid, text) to authenticated, service_role;

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

-- Grants are kept by CREATE OR REPLACE, restated by name for safety (SR-52/56).
revoke all on function public.set_load_status(uuid, public.load_status, timestamptz, text) from public, anon;
grant execute on function public.set_load_status(uuid, public.load_status, timestamptz, text) to authenticated, service_role;
