-- 0011: a POD is optional at delivery (owner acceptance feedback).
-- Carriers often have no POD photo at the moment of delivery. The load must still be markable delivered, and the
-- carrier uploads the POD later from the load page.
--   * set_load_status: the 0010 definition with ONLY the "a POD document is required for delivered" rule (and its
--     v_has_pod variable) removed. Nothing else changed (diff the two bodies to confirm).
--   * dlv_can_access_doc: the 0007 definition with ONE change: a carrier owner or driver may also WRITE a POD while
--     the load is delivered (own carrier only, BOL never, customers never write). The path regex is unchanged.
-- Idempotent (CREATE OR REPLACE, grants restated).

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
