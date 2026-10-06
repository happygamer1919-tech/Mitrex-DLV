-- C6.1: the database refuses to leave the portal without an active staff_admin.
-- Binds every writer (service role, SQL editor, a future policy slip): the trigger does not look at auth.uid().
-- Covered changes on public.profiles: deactivate (is_active true to false), demote (role staff_admin to
-- anything else) and delete (including the cascade from auth.users) of the LAST active staff_admin.
-- Concurrency: a transaction scoped advisory lock serialises every change that takes an active staff_admin
-- out of the active set, and the count of the OTHER active admins is taken after the lock is held
-- (READ COMMITTED sees the first committer's change), so two simultaneous deactivations cannot both pass.
-- TRUNCATE is not covered. Idempotent.

create or replace function public.dlv_profiles_last_admin_guard() returns trigger
language plpgsql set search_path = ''
as $fn$
declare v_others int;
begin
  -- Only a change that takes an ACTIVE staff_admin out of the active admin set matters.
  if not (old.role = 'staff_admin' and old.is_active) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and new.role = 'staff_admin' and new.is_active then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('dlv.last_active_staff_admin', 0));

  select count(*) into v_others
    from public.profiles p
   where p.role = 'staff_admin' and p.is_active and p.id <> old.id;
  if v_others = 0 then
    raise exception 'cannot leave the portal without an active staff admin'
      using errcode = '23514', hint = 'last_active_staff_admin';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$fn$;

drop trigger if exists profiles_last_admin_guard_update on public.profiles;
create trigger profiles_last_admin_guard_update before update of role, is_active on public.profiles
  for each row execute function public.dlv_profiles_last_admin_guard();
drop trigger if exists profiles_last_admin_guard_delete on public.profiles;
create trigger profiles_last_admin_guard_delete before delete on public.profiles
  for each row execute function public.dlv_profiles_last_admin_guard();

-- Trigger function: never called by clients. Revoke by name (default privileges give PUBLIC execute).
revoke all on function public.dlv_profiles_last_admin_guard() from public, anon, authenticated;
grant execute on function public.dlv_profiles_last_admin_guard() to service_role;
