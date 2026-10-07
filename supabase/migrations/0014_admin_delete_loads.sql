-- 0014: admin only permanent delete of a load (DLV-027, R38).
-- Catalog check (pg_constraint, confrelid = public.loads): exactly two foreign keys reference loads, load_events
-- and load_documents, both ON DELETE CASCADE. No delete trigger exists on loads, load_events or load_documents.
-- So deleting a load row removes its timeline and its document rows and nothing else can block it. The files in the
-- private 'documents' bucket are NOT removed by the database (storage.objects is protected); the function returns
-- their paths and the server action removes them.
--   * public.load_deletions: minimal audit record that stays after a delete (request ref, ITS number, last status,
--     who, when, and any storage paths that could not be removed). No foreign keys, so removing a user or a load
--     never blocks. Readable by an active staff_admin only. No client insert, update or delete; written only by
--     the two functions below.
--   * public.delete_load_forever(p_load, p_confirm): active staff_admin only, locks the load row, requires the typed
--     text to equal the ITS number (else the request ref), writes the audit row, deletes the load (cascade), returns
--     the storage paths. One transaction. The lock on the load row also makes a concurrent document insert wait
--     and then fail on its foreign key, so no document row can survive a delete.
--   * public.record_load_deletion_orphans(p_load, p_paths): active staff_admin only, appends storage paths that could
--     not be removed to the audit row of a load that no longer exists.
--   * NO general DELETE privilege on loads and NO delete policy: the function is the only path.
-- Existing rows are untouched. Idempotent (IF NOT EXISTS, CREATE OR REPLACE, grants restated by name).

create table if not exists public.load_deletions (
  id uuid primary key default gen_random_uuid(),
  load_id uuid not null,
  request_ref text not null,
  its_load_number text,
  last_status public.load_status,
  deleted_by uuid,
  deleted_at timestamptz not null default now(),
  orphan_paths text[] not null default '{}'
);
create index if not exists load_deletions_load_idx on public.load_deletions (load_id);
create index if not exists load_deletions_deleted_at_idx on public.load_deletions (deleted_at desc);

alter table public.load_deletions enable row level security;
revoke all on public.load_deletions from public, anon, authenticated;
grant select on public.load_deletions to authenticated;
grant all on public.load_deletions to service_role;

drop policy if exists load_deletions_admin_select on public.load_deletions;
create policy load_deletions_admin_select on public.load_deletions for select to authenticated
  using (public.dlv_is_admin());

create or replace function public.delete_load_forever(p_load uuid, p_confirm text)
returns text[]
language plpgsql security definer set search_path = ''
as $fn$
declare
  l public.loads;
  v_expected text;
  v_paths text[];
begin
  if auth.uid() is null or not public.dlv_is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into l from public.loads where id = p_load for update;
  if not found then raise exception 'load not found' using errcode = 'P0002'; end if;

  v_expected := coalesce(nullif(btrim(l.its_load_number), ''), l.load_number);
  if btrim(coalesce(p_confirm, '')) is distinct from v_expected then
    raise exception 'confirmation does not match' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(d.storage_path order by d.created_at, d.id), '{}')
    into v_paths
    from public.load_documents d where d.load_id = l.id;

  insert into public.load_deletions (load_id, request_ref, its_load_number, last_status, deleted_by, deleted_at)
  values (l.id, l.load_number, l.its_load_number, l.status, auth.uid(), now());

  delete from public.loads where id = l.id;  -- load_events and load_documents cascade
  return v_paths;
end
$fn$;

revoke all on function public.delete_load_forever(uuid, text) from public, anon, authenticated;
grant execute on function public.delete_load_forever(uuid, text) to authenticated, service_role;

create or replace function public.record_load_deletion_orphans(p_load uuid, p_paths text[])
returns integer
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_id uuid;
  v_new text[];
  v_old text[];
  v_bad int;
begin
  if auth.uid() is null or not public.dlv_is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_paths is null or cardinality(p_paths) = 0 then return 0; end if;
  -- Only strict document paths of THIS load can be recorded (same shape as dlv_can_access_doc).
  select count(*) into v_bad from unnest(p_paths) p
   where p is null
      or p !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(bol|pod)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$'
      or split_part(p, '/', 1) <> p_load::text;
  if v_bad > 0 then
    raise exception 'path does not belong to this load' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.loads where id = p_load) then
    raise exception 'load still exists' using errcode = 'P0001';
  end if;
  select d.id, d.orphan_paths into v_id, v_old from public.load_deletions d
   where d.load_id = p_load order by d.deleted_at desc, d.id limit 1 for update;
  if v_id is null then raise exception 'no deletion record for this load' using errcode = 'P0002'; end if;
  select coalesce(array_agg(distinct p), '{}') into v_new
    from unnest(p_paths) p
   where p <> all (v_old);
  update public.load_deletions set orphan_paths = orphan_paths || v_new where id = v_id;
  return cardinality(v_new);
end
$fn$;

revoke all on function public.record_load_deletion_orphans(uuid, text[]) from public, anon, authenticated;
grant execute on function public.record_load_deletion_orphans(uuid, text[]) to authenticated, service_role;
