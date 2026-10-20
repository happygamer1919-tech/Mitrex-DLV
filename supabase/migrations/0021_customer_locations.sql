-- 0021: Customer locations (DLV-041, R45). Maria (an ACTIVE customer user) adds new locations herself and edits every
-- business field of an active location, without a request that staff approve. Staff rights are unchanged; carriers
-- still cannot write a location at all; delete stays staff only.
--   * locations gets created_at (default now(); rows that exist at the apply take the apply time), created_by and
--     updated_by (uuid, references profiles, ON DELETE SET NULL).
--   * dlv_locations_before_insert() (new, SECURITY DEFINER, fixed search_path), trigger locations_before_insert: for a
--     signed-in caller (auth.uid() not null) it stamps created_at = now(), updated_at = now(), created_by = auth.uid()
--     and updated_by = NULL, whatever the client sent. For a customer caller it also forces is_active = true and
--     needs_review = false, and checks the customer rules below.
--   * dlv_locations_before_update() (replaced; now SECURITY DEFINER, fixed search_path; the trigger
--     locations_before_update of 0002 stays): for a signed-in caller, staff keep every right they had but can never
--     write created_at or created_by (the old values are kept) and updated_by becomes the staff user. A customer may
--     change only name, address_line, city, province, postal_code, can_ship, can_receive, requires_moffett,
--     default_contact_name, default_contact_phone and notes; anything else (is_active, needs_review, id, created_at,
--     created_by, updated_by, any future column) is refused with 42501. updated_by becomes the customer user. Any
--     other signed-in caller (carrier, inactive user) is refused with 42501. This replaces the contact only guard of
--     0002 and 0009. The service role and owner tooling (auth.uid() null) stay unrestricted, as before. The ON DELETE
--     SET NULL of a deleted profile is let through (it is not a client edit).
--   * Customer rules (insert and update): the name is not blank and at most 120 characters, the notes at most 1000
--     characters, and the location ships or receives (at least one). Refused with 23514.
--   * Policies: locations_customer_insert (new): an active customer may insert (the trigger forces the flags);
--     locations_update (replaced): staff, or an active customer on an ACTIVE location only. Delete stays
--     locations_staff_delete. The unique name constraint stays.
-- Idempotent (ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF EXISTS, DROP POLICY IF EXISTS, grants
-- restated by name). No existing row changes except the three new columns.

alter table public.locations add column if not exists created_at timestamptz not null default now();
alter table public.locations add column if not exists created_by uuid references public.profiles(id) on delete set null;
alter table public.locations add column if not exists updated_by uuid references public.profiles(id) on delete set null;

-- The customer rules shared by insert and update. Plain messages, the app shows its own before this is reached.
create or replace function public.dlv_location_customer_rules(p public.locations) returns void
language plpgsql stable set search_path = ''
as $fn$
begin
  if p.name is null or btrim(p.name) = '' then
    raise exception 'a location needs a name' using errcode = '23514';
  end if;
  if length(p.name) > 120 then
    raise exception 'a location name has at most 120 characters' using errcode = '23514';
  end if;
  if p.notes is not null and length(p.notes) > 1000 then
    raise exception 'location notes have at most 1000 characters' using errcode = '23514';
  end if;
  if not (p.can_ship or p.can_receive) then
    raise exception 'a location must ship, receive or both' using errcode = '23514';
  end if;
end
$fn$;

create or replace function public.dlv_locations_before_insert() returns trigger
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return new; end if;
  new.created_at := now();
  new.updated_at := now();
  new.created_by := v_uid;
  new.updated_by := null;
  if public.dlv_role() = 'customer' then
    new.is_active := true;
    new.needs_review := false;
    perform public.dlv_location_customer_rules(new);
  end if;
  return new;
end
$fn$;

create or replace function public.dlv_locations_before_update() returns trigger
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid uuid := auth.uid();
  v_old jsonb := to_jsonb(old);
  v_business text[] := array['name', 'address_line', 'city', 'province', 'postal_code', 'can_ship', 'can_receive',
    'requires_moffett', 'default_contact_name', 'default_contact_phone', 'notes', 'updated_at'];
begin
  if v_uid is null then return new; end if;
  -- ON DELETE SET NULL of a deleted profile: the referenced profile is gone, so NULL is the only possible value.
  if old.created_by is not null and new.created_by is null
     and not exists (select 1 from public.profiles p where p.id = old.created_by) then
    v_old := v_old || jsonb_build_object('created_by', null);
  end if;
  if old.updated_by is not null and new.updated_by is null
     and not exists (select 1 from public.profiles p where p.id = old.updated_by) then
    v_old := v_old || jsonb_build_object('updated_by', null);
  end if;

  if public.dlv_is_staff() then
    new.created_at := old.created_at;
    new.created_by := (v_old ->> 'created_by')::uuid;
    new.updated_by := v_uid;
    return new;
  end if;

  if public.dlv_role() = 'customer' then
    if (to_jsonb(new) - v_business) is distinct from (v_old - v_business) then
      raise exception 'a customer can change only the name, address, ship and receive flags, Moffett, default contact and notes of a location'
        using errcode = '42501';
    end if;
    perform public.dlv_location_customer_rules(new);
    new.updated_by := v_uid;
    return new;
  end if;

  raise exception 'only staff or a customer can change a location' using errcode = '42501';
end
$fn$;

drop trigger if exists locations_before_insert on public.locations;
create trigger locations_before_insert before insert on public.locations
  for each row execute function public.dlv_locations_before_insert();
-- locations_before_update (0002) already calls dlv_locations_before_update(); restated so a fresh apply is complete.
drop trigger if exists locations_before_update on public.locations;
create trigger locations_before_update before update on public.locations
  for each row execute function public.dlv_locations_before_update();

drop policy if exists locations_customer_insert on public.locations;
create policy locations_customer_insert on public.locations for insert to authenticated
  with check (public.dlv_role() = 'customer' and is_active and not needs_review and created_by = auth.uid());

drop policy if exists locations_update on public.locations;
create policy locations_update on public.locations for update to authenticated
  using (public.dlv_is_staff() or (public.dlv_role() = 'customer' and is_active))
  with check (public.dlv_is_staff() or (public.dlv_role() = 'customer' and is_active));

-- Trigger and helper functions, never called by clients. Restated by name.
revoke all on function public.dlv_locations_before_insert(), public.dlv_locations_before_update(),
  public.dlv_location_customer_rules(public.locations) from public, anon, authenticated;
grant execute on function public.dlv_locations_before_insert(), public.dlv_locations_before_update(),
  public.dlv_location_customer_rules(public.locations) to service_role;
