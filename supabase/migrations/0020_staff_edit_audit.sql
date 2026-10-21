-- 0020: Staff edit audit (DLV-039, R44). Staff (staff_admin and staff_csr, identical rights) may now change every
-- detail of a load at any status except cancelled, through the session client (the loads_staff_update policy of 0003
-- already allows the UPDATE; nothing about who may write changes here). This migration only makes such an edit
-- visible in the timeline.
--   * dlv_fmt_slot(timing, date, start, end): IMMUTABLE, fixed search_path. The pickup or delivery time exactly as the
--     app prints it (src/lib/format.ts fmtSlot): "Wed, Oct 21, 2026, 8:30 AM ET (appointment)" or
--     "Wed, Oct 21, 2026, 8:00 AM to 10:00 AM ET (window)".
--   * dlv_loads_detail_event(): SECURITY DEFINER, fixed search_path, the function of a new AFTER UPDATE trigger
--     loads_detail_event. When the actor is an ACTIVE staff user (auth.uid() not null and dlv_is_staff()) and at
--     least one detail column changed, it inserts ONE load_events row: from_status = to_status = the current status,
--     actor_id = auth.uid(), note "Details edited: <Field>: <old> to <new>; ..." with human labels, location NAMES
--     instead of ids, times as the app shows them, at most 1000 characters. A customer edit (while requested), a
--     carrier, the service role and owner tooling (auth.uid() null) write nothing, exactly as today. Status, carrier,
--     ETA and ITS number changes are not detail columns (they keep their own events).
-- load_events stays append only: no grant or policy changes, clients still cannot insert, update or delete events.
-- No existing row is touched. Idempotent (CREATE OR REPLACE, DROP TRIGGER IF EXISTS, grants restated by name).

create or replace function public.dlv_fmt_slot(p_timing text, p_date date, p_start time, p_end time) returns text
language sql immutable set search_path = ''
as $fn$
  select to_char(p_date, 'Dy, Mon FMDD, YYYY') || ', '
    || case when p_timing = 'window'
            then to_char(p_start, 'FMHH12:MI AM') || ' to ' || coalesce(to_char(p_end, 'FMHH12:MI AM'), '') || ' ET (window)'
            else to_char(p_start, 'FMHH12:MI AM') || ' ET (appointment)' end
$fn$;

revoke all on function public.dlv_fmt_slot(text, date, time, time) from public, anon, authenticated;
grant execute on function public.dlv_fmt_slot(text, date, time, time) to service_role;

create or replace function public.dlv_loads_detail_event() returns trigger
language plpgsql security definer set search_path = ''
as $fn$
declare
  parts text[] := '{}';
  v_note text;
  v_old text;
  v_new text;
begin
  -- Only an active staff user's edit is recorded. Customers (while requested), the service role and owner tooling
  -- (auth.uid() null) keep today's behaviour: no event.
  if auth.uid() is null or not public.dlv_is_staff() then
    return null;
  end if;

  if new.pickup_location_id is distinct from old.pickup_location_id then
    select l.name into v_old from public.locations l where l.id = old.pickup_location_id;
    select l.name into v_new from public.locations l where l.id = new.pickup_location_id;
    parts := parts || format('Pickup: %s to %s', coalesce(v_old, 'Unknown'), coalesce(v_new, 'Unknown'));
  end if;
  if new.pickup_contact_name is distinct from old.pickup_contact_name
     or new.pickup_contact_phone is distinct from old.pickup_contact_phone then
    parts := parts || format('Pickup contact: %s, %s to %s, %s',
      old.pickup_contact_name, old.pickup_contact_phone, new.pickup_contact_name, new.pickup_contact_phone);
  end if;
  if new.pickup_timing is distinct from old.pickup_timing or new.pickup_date is distinct from old.pickup_date
     or new.pickup_time_start is distinct from old.pickup_time_start or new.pickup_time_end is distinct from old.pickup_time_end then
    parts := parts || format('Pickup time: %s to %s',
      public.dlv_fmt_slot(old.pickup_timing, old.pickup_date, old.pickup_time_start, old.pickup_time_end),
      public.dlv_fmt_slot(new.pickup_timing, new.pickup_date, new.pickup_time_start, new.pickup_time_end));
  end if;
  if new.delivery_location_id is distinct from old.delivery_location_id then
    select l.name into v_old from public.locations l where l.id = old.delivery_location_id;
    select l.name into v_new from public.locations l where l.id = new.delivery_location_id;
    parts := parts || format('Delivery: %s to %s', coalesce(v_old, 'Unknown'), coalesce(v_new, 'Unknown'));
  end if;
  if new.delivery_contact_name is distinct from old.delivery_contact_name
     or new.delivery_contact_phone is distinct from old.delivery_contact_phone then
    parts := parts || format('Delivery contact: %s, %s to %s, %s',
      old.delivery_contact_name, old.delivery_contact_phone, new.delivery_contact_name, new.delivery_contact_phone);
  end if;
  if new.delivery_timing is distinct from old.delivery_timing or new.delivery_date is distinct from old.delivery_date
     or new.delivery_time_start is distinct from old.delivery_time_start or new.delivery_time_end is distinct from old.delivery_time_end then
    parts := parts || format('Delivery time: %s to %s',
      public.dlv_fmt_slot(old.delivery_timing, old.delivery_date, old.delivery_time_start, old.delivery_time_end),
      public.dlv_fmt_slot(new.delivery_timing, new.delivery_date, new.delivery_time_start, new.delivery_time_end));
  end if;
  if new.equipment_size is distinct from old.equipment_size then
    parts := parts || format('Equipment size: %s ft to %s ft', old.equipment_size, new.equipment_size);
  end if;
  if new.moffett is distinct from old.moffett then
    parts := parts || format('Moffett: %s to %s',
      case when old.moffett then 'Yes' else 'No' end, case when new.moffett then 'Yes' else 'No' end);
  end if;
  if new.weight_lbs is distinct from old.weight_lbs then
    -- As the app prints it (en-CA grouping, at most 3 decimals, "Not given" when empty).
    parts := parts || format('Weight: %s to %s',
      case when old.weight_lbs is null then 'Not given'
           when old.weight_lbs = trunc(old.weight_lbs) then to_char(old.weight_lbs, 'FM999,999,999,990') || ' lbs'
           else rtrim(rtrim(to_char(round(old.weight_lbs, 3), 'FM999,999,999,990.000'), '0'), '.') || ' lbs' end,
      case when new.weight_lbs is null then 'Not given'
           when new.weight_lbs = trunc(new.weight_lbs) then to_char(new.weight_lbs, 'FM999,999,999,990') || ' lbs'
           else rtrim(rtrim(to_char(round(new.weight_lbs, 3), 'FM999,999,999,990.000'), '0'), '.') || ' lbs' end);
  end if;
  if new.pieces is distinct from old.pieces then
    parts := parts || format('Pieces: %s to %s', coalesce(old.pieces::text, 'Not given'), coalesce(new.pieces::text, 'Not given'));
  end if;
  if new.po_number is distinct from old.po_number then
    parts := parts || format('PO number: %s to %s', coalesce(nullif(old.po_number, ''), 'None'), coalesce(nullif(new.po_number, ''), 'None'));
  end if;
  if new.notes is distinct from old.notes then
    parts := parts || format('Notes: %s to %s',
      coalesce(nullif(btrim(regexp_replace(old.notes, '\s+', ' ', 'g')), ''), 'None'),
      coalesce(nullif(btrim(regexp_replace(new.notes, '\s+', ' ', 'g')), ''), 'None'));
  end if;

  if cardinality(parts) = 0 then
    return null;
  end if;
  v_note := 'Details edited: ' || array_to_string(parts, '; ');
  if length(v_note) > 1000 then
    v_note := left(v_note, 997) || '...';
  end if;
  insert into public.load_events (load_id, from_status, to_status, actor_id, note)
  values (new.id, new.status, new.status, auth.uid(), v_note);
  return null;
end
$fn$;

drop trigger if exists loads_detail_event on public.loads;
create trigger loads_detail_event after update on public.loads
  for each row execute function public.dlv_loads_detail_event();

revoke all on function public.dlv_loads_detail_event() from public, anon, authenticated;
grant execute on function public.dlv_loads_detail_event() to service_role;
