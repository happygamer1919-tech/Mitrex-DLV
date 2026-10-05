-- DLV Mitrex portal: deactivation. An inactive profile is denied everywhere.
-- Writes to profiles stay service role only (no new grant). Idempotent.

alter table public.profiles add column if not exists is_active boolean not null default true;

-- Every identity helper is inactive aware. dlv_role() returns NULL for an inactive user,
-- so every role comparison in every policy and function evaluates to false or null.
create or replace function public.dlv_role() returns text
language sql stable security definer set search_path = ''
as $fn$ select p.role::text from public.profiles p where p.id = auth.uid() and p.is_active $fn$;

create or replace function public.dlv_is_staff() returns boolean
language sql stable security definer set search_path = ''
as $fn$ select coalesce((select p.role in ('staff_admin','staff_csr') from public.profiles p where p.id = auth.uid() and p.is_active), false) $fn$;

create or replace function public.dlv_is_admin() returns boolean
language sql stable security definer set search_path = ''
as $fn$ select coalesce((select p.role = 'staff_admin' from public.profiles p where p.id = auth.uid() and p.is_active), false) $fn$;

create or replace function public.dlv_customer_id() returns uuid
language sql stable security definer set search_path = ''
as $fn$ select p.customer_id from public.profiles p where p.id = auth.uid() and p.is_active $fn$;

create or replace function public.dlv_carrier_id() returns uuid
language sql stable security definer set search_path = ''
as $fn$ select p.carrier_id from public.profiles p where p.id = auth.uid() and p.is_active $fn$;

-- profiles_select read the table directly for "self", so an inactive user could still read
-- their own row. Require is_active there too (staff and owner branches already go through helpers).
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using ((id = auth.uid() and is_active)
         or public.dlv_is_staff()
         or (public.dlv_role() = 'carrier_owner' and carrier_id = public.dlv_carrier_id()));

-- Grants are unchanged by CREATE OR REPLACE, restated by name for safety (SR-52/56).
revoke all on function public.dlv_role(), public.dlv_is_staff(), public.dlv_is_admin(),
  public.dlv_customer_id(), public.dlv_carrier_id() from public, anon;
grant execute on function public.dlv_role(), public.dlv_is_staff(), public.dlv_is_admin(),
  public.dlv_customer_id(), public.dlv_carrier_id() to authenticated, service_role;
