-- 0022: A carrier never sees a load that was never booked to it (DLV-043, CAR-01).
-- Before this file every carrier rule tested only status <> 'requested'. Staff may save a carrier on a load while it
-- is still requested; when that request is then CANCELLED (by Maria or by staff) without ever being booked, the
-- status leaves 'requested' and the carrier suddenly saw the load, its addresses and contacts, its BOL and other
-- documents, and the locations it uses (also private ones), and Maria saw that carrier's row.
-- Now a carrier sees a load only when it is past requested AND it is not a cancelled load that was never booked:
--   status <> 'requested' and (status <> 'cancelled' or booked_at is not null)
-- booked_at is stamped by set_load_status the first time a load leaves requested for anything but cancelled.
-- The narrow form is on purpose: loads put at a later status directly (owner tooling, test fixtures) have no
-- booked_at and must stay visible to their carrier. A load that was booked and later cancelled stays visible.
--   * loads_select (replaced): the carrier branch gets the condition. Staff and customer branches unchanged.
--   * dlv_can_access_doc (replaced, the 0018 text): the carrier branch gets the condition. Staff, customer, the path
--     shape and every write rule unchanged.
--   * dlv_carrier_can_see_location (replaced, the 0002 text) and dlv_customer_can_see_carrier (replaced, the 0002
--     text): the same condition.
-- load_events and load_documents read loads through RLS and follow loads_select by themselves.
-- Idempotent (CREATE OR REPLACE, DROP POLICY IF EXISTS, grants restated by name). No row changes.

create or replace function public.dlv_carrier_can_see_location(loc uuid) returns boolean
language sql stable security definer set search_path = ''
as $fn$
  select exists (
    select 1 from public.loads l
    where l.carrier_id = public.dlv_carrier_id()
      and l.status <> 'requested'
      and (l.status <> 'cancelled' or l.booked_at is not null)
      and (l.pickup_location_id = loc or l.delivery_location_id = loc))
$fn$;

create or replace function public.dlv_customer_can_see_carrier(car uuid) returns boolean
language sql stable security definer set search_path = ''
as $fn$
  select exists (
    select 1 from public.loads l
    where l.customer_id = public.dlv_customer_id()
      and l.carrier_id = car and l.status <> 'requested'
      and (l.status <> 'cancelled' or l.booked_at is not null))
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
  -- carrier_owner, carrier_driver (0022: a cancelled load that was never booked is not theirs to see)
  if l.carrier_id is distinct from public.dlv_carrier_id() or l.status = 'requested'
     or (l.status = 'cancelled' and l.booked_at is null) then
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
             and carrier_id = public.dlv_carrier_id() and status <> 'requested'
             and (status <> 'cancelled' or booked_at is not null)));

revoke all on function public.dlv_carrier_can_see_location(uuid) from public, anon;
grant execute on function public.dlv_carrier_can_see_location(uuid) to authenticated, service_role;
revoke all on function public.dlv_customer_can_see_carrier(uuid) from public, anon;
grant execute on function public.dlv_customer_can_see_carrier(uuid) to authenticated, service_role;
revoke all on function public.dlv_can_access_doc(text, boolean) from public, anon;
grant execute on function public.dlv_can_access_doc(text, boolean) to authenticated, service_role;
