-- C6.3: updated_at on every mutable table. loads already has it (kept by dlv_loads_before_update).
-- The shared function public.dlv_touch_updated_at() exists since 0002; this migration attaches it.
-- C6.2 (indexes) needs no DDL: loads(status), loads(pickup_date), loads(carrier_id, status),
-- loads(customer_id, created_at) and load_events(load_id, created_at) already lead an index (tested in rls.sql).
-- Adding a column with a default of now() is a metadata only change; existing rows take the apply time.
-- Idempotent.

alter table public.locations         add column if not exists updated_at timestamptz not null default now();
alter table public.carriers          add column if not exists updated_at timestamptz not null default now();
alter table public.customers         add column if not exists updated_at timestamptz not null default now();
alter table public.profiles          add column if not exists updated_at timestamptz not null default now();
alter table public.location_requests add column if not exists updated_at timestamptz not null default now();

-- The customer edit guard on locations compares the whole row apart from the contact fields; the new
-- column must not count as an edit, whatever the trigger firing order.
create or replace function public.dlv_locations_before_update() returns trigger
language plpgsql set search_path = ''
as $fn$
begin
  if auth.uid() is null or public.dlv_is_staff() then return new; end if;
  if (to_jsonb(new) - 'default_contact_name' - 'default_contact_phone' - 'updated_at')
     is distinct from
     (to_jsonb(old) - 'default_contact_name' - 'default_contact_phone' - 'updated_at') then
    raise exception 'only default contact fields are editable' using errcode = '42501';
  end if;
  return new;
end
$fn$;

drop trigger if exists locations_touch_updated_at on public.locations;
create trigger locations_touch_updated_at before update on public.locations
  for each row execute function public.dlv_touch_updated_at();
drop trigger if exists carriers_touch_updated_at on public.carriers;
create trigger carriers_touch_updated_at before update on public.carriers
  for each row execute function public.dlv_touch_updated_at();
drop trigger if exists customers_touch_updated_at on public.customers;
create trigger customers_touch_updated_at before update on public.customers
  for each row execute function public.dlv_touch_updated_at();
drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at before update on public.profiles
  for each row execute function public.dlv_touch_updated_at();
drop trigger if exists location_requests_touch_updated_at on public.location_requests;
create trigger location_requests_touch_updated_at before update on public.location_requests
  for each row execute function public.dlv_touch_updated_at();

-- Trigger functions, never called by clients. Restated by name.
revoke all on function public.dlv_locations_before_update(), public.dlv_touch_updated_at() from public, anon, authenticated;
grant execute on function public.dlv_locations_before_update(), public.dlv_touch_updated_at() to service_role;
