-- 0012: equipment sizes become 26, 36 and 53 only (48 ft is removed; 36 stays for upcoming projects).
-- 1. Refuse cleanly, before any change, if a load still has size 48: the owner decides what to do with it.
-- 2. Drop the existing equipment_size CHECK(s), found through pg_constraint (never by a guessed name), and add the
--    new validated CHECK under the standard name loads_equipment_size_check.
-- Idempotent: a second run drops the new CHECK and recreates it identically.

do $mig$
declare
  v_bad bigint;
  r record;
begin
  select count(*) into v_bad from public.loads where equipment_size = 48;
  if v_bad > 0 then
    raise exception '0012 refused: % load(s) still have equipment_size 48. 48 ft is being removed. Change or cancel those loads first, then run this migration again.', v_bad
      using errcode = 'P0001';
  end if;

  for r in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.loads'::regclass
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) like '%equipment_size%'
  loop
    execute format('alter table public.loads drop constraint %I', r.conname);
  end loop;

  alter table public.loads
    add constraint loads_equipment_size_check check (equipment_size in (26, 36, 53));
end
$mig$;
