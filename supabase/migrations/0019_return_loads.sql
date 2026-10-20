-- 0019: Return loads (DLV-038, R43). A truck that just delivered to a site is often asked to reload the empty frames
-- and bring them back, to the original shipper or to a scrapyard. A return load is an ordinary load that names the load
-- it returns from.
--   * loads.return_of_load_id uuid NULL references public.loads(id) ON DELETE SET NULL, with an index. Nullable and
--     without a default: adding it is metadata only, no existing row changes.
--   * dlv_return_original(p_id): SECURITY DEFINER, fixed search_path. Returns the original's customer, pickup,
--     delivery and status, but ONLY to a caller who may already read that load (service role or auth.uid() null, an
--     active staff user, or a customer user of the load's own customer). Everyone else gets no row, so it reveals
--     nothing that RLS on loads does not already show.
--   * dlv_check_load_locations (0002 body + one rule): for a return load whose pickup IS the original's delivery
--     location, the pickup only needs to be active (a site is often not can_ship); its delivery must be active and
--     either can_receive or the original's pickup location (the original shipper may not be can_receive). Every
--     other load keeps the 0002 rule exactly.
--   * dlv_loads_before_insert (0013 body + one rule): an authenticated insert that names return_of_load_id needs an
--     original that exists with the SAME customer_id, a pickup equal to the original's delivery location and, for a
--     non staff caller, an original that is at_delivery or delivered (staff: any status). The service role and
--     auth.uid() null stay unrestricted like today.
--   * dlv_loads_before_update (0013 body + two rules): return_of_load_id is immutable for every authenticated caller
--     (the only change allowed is the ON DELETE SET NULL of a deleted original); a non staff caller cannot move the
--     pickup of a return load away from the original's delivery location.
-- Idempotent (IF NOT EXISTS, CREATE OR REPLACE, constraint added only when missing, grants restated by name).

alter table public.loads add column if not exists return_of_load_id uuid;

do $do$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.loads'::regclass and conname = 'loads_return_of_load_id_fkey') then
    alter table public.loads add constraint loads_return_of_load_id_fkey
      foreign key (return_of_load_id) references public.loads(id) on delete set null;
  end if;
end
$do$;

create index if not exists loads_return_of_load_id_idx on public.loads (return_of_load_id) where return_of_load_id is not null;

-- The original of a return, for a caller who may read it. No row otherwise.
create or replace function public.dlv_return_original(p_id uuid)
returns table (customer_id uuid, pickup_location_id uuid, delivery_location_id uuid, status public.load_status)
language sql stable security definer set search_path = ''
as $fn$
  select l.customer_id, l.pickup_location_id, l.delivery_location_id, l.status
  from public.loads l
  where l.id = p_id
    and (auth.uid() is null
         or public.dlv_is_staff()
         or (public.dlv_role() = 'customer' and l.customer_id = public.dlv_customer_id()))
$fn$;

revoke all on function public.dlv_return_original(uuid) from public, anon, authenticated;
grant execute on function public.dlv_return_original(uuid) to authenticated, service_role;

-- Location rules shared by insert and update of a load. 0002 body; the return rule is marked "0019".
create or replace function public.dlv_check_load_locations(p public.loads) returns boolean
language plpgsql stable security definer set search_path = ''
as $fn$
declare
  pu public.locations;
  de public.locations;
  o record;
  v_return boolean := false;
begin
  select * into pu from public.locations where id = p.pickup_location_id;
  select * into de from public.locations where id = p.delivery_location_id;
  -- 0019: a return load picking up where its original delivered
  if p.return_of_load_id is not null then
    select * into o from public.dlv_return_original(p.return_of_load_id);
    v_return := found and o.delivery_location_id = p.pickup_location_id;
  end if;
  if v_return then
    if not pu.is_active then
      raise exception 'pickup location cannot ship' using errcode = 'P0001';
    end if;
    if not de.is_active or not (de.can_receive or de.id = o.pickup_location_id) then
      raise exception 'delivery location cannot receive' using errcode = 'P0001';
    end if;
    return pu.requires_moffett or de.requires_moffett;
  end if;
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

-- BEFORE INSERT. 0013 body; the return rule is marked "0019".
create or replace function public.dlv_loads_before_insert() returns trigger
language plpgsql set search_path = ''
as $fn$
declare
  v_moff boolean;
  o record;
begin
  -- 0019: a return load names an original the caller may read, of the same customer, and picks up where it delivered
  if new.return_of_load_id is not null and auth.uid() is not null then
    select * into o from public.dlv_return_original(new.return_of_load_id);
    if not found or o.customer_id is distinct from new.customer_id then
      raise exception 'return load: the original load was not found' using errcode = '42501';
    end if;
    if new.pickup_location_id is distinct from o.delivery_location_id then
      raise exception 'return load: the pickup must be the delivery location of the original load' using errcode = 'P0001';
    end if;
    if not public.dlv_is_staff() and o.status not in ('at_delivery', 'delivered') then
      raise exception 'return load: the original load must be at delivery or delivered' using errcode = 'P0001';
    end if;
  end if;
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

-- BEFORE UPDATE. 0013 body; the return rules are marked "0019" and sit before the status function shortcut, so no
-- path of a signed-in user skips them.
create or replace function public.dlv_loads_before_update() returns trigger
language plpgsql set search_path = ''
as $fn$
declare
  v_moff boolean;
  o record;
begin
  new.updated_at := now();
  if auth.uid() is null then return new; end if;  -- service role / owner tooling
  if new.its_load_number is distinct from old.its_load_number
     and coalesce(current_setting('dlv.its_fn', true), '') <> '1' then
    raise exception 'its_load_number changes only through set_its_load_number' using errcode = '42501';
  end if;
  -- 0019: the link to the original never changes, except the ON DELETE SET NULL of an original that is gone (read
  -- through the definer helper, so row level security cannot make an existing original look gone)
  if new.return_of_load_id is distinct from old.return_of_load_id
     and not (new.return_of_load_id is null
              and not exists (select 1 from public.dlv_return_original(old.return_of_load_id))) then
    raise exception 'return_of_load_id is immutable' using errcode = '42501';
  end if;
  -- 0019: a customer edit keeps a return load's pickup at the original's delivery location
  if new.return_of_load_id is not null and not public.dlv_is_staff()
     and new.pickup_location_id is distinct from old.pickup_location_id then
    select * into o from public.dlv_return_original(new.return_of_load_id);
    if not found or new.pickup_location_id is distinct from o.delivery_location_id then
      raise exception 'return load: the pickup must be the delivery location of the original load' using errcode = 'P0001';
    end if;
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
