-- C6.4: exactly one load_events row per status change, enforced in the database for every writer.
-- Before: only set_load_status wrote the event, so a direct status UPDATE (service role, SQL editor, e2e
-- helpers) changed the status silently. Now an AFTER UPDATE OF status trigger on loads writes it.
--   * actor_id: auth.uid() when it maps to a profile, else NULL (service role, owner tooling).
--   * note: transaction local GUC dlv.event_note, set by set_load_status just before its UPDATE and cleared
--     right after (the trigger clears it too). An empty note is stored as NULL.
--   * The AFTER INSERT trigger keeps writing the creation event (from NULL), so an INSERT that already
--     carries a non requested status still yields exactly one event.
--   * set_load_eta keeps writing its own from=to event (an eta change does not change status).
-- set_load_status below is the 0002 definition with ONLY the event insert removed and the GUC added.
-- Idempotent.

create or replace function public.dlv_loads_status_event() returns trigger
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_actor uuid;
  v_note text := nullif(current_setting('dlv.event_note', true), '');
begin
  select p.id into v_actor from public.profiles p where p.id = auth.uid();
  insert into public.load_events (load_id, from_status, to_status, actor_id, note)
  values (new.id, old.status, new.status, v_actor, v_note);
  perform set_config('dlv.event_note', '', true);
  return null;
end
$fn$;

drop trigger if exists loads_status_event on public.loads;
create trigger loads_status_event after update of status on public.loads
  for each row when (old.status is distinct from new.status)
  execute function public.dlv_loads_status_event();

revoke all on function public.dlv_loads_status_event() from public, anon, authenticated;
grant execute on function public.dlv_loads_status_event() to service_role;

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
  v_has_pod boolean;
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
