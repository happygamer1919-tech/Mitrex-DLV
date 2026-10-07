-- 0018: load photos (DLV-032). Carrier Kaja Transport asked for a forced photo of the loaded freight and a forced
-- photo at delivery, taken INSIDE the app (in-app camera), with the time known automatically.
--   * load_documents.kind also allows 'pickup_photo' and 'delivery_photo' (next to 'bol' and 'pod'). The path CHECK
--     keeps the strict anchored shape {load uuid}/{kind}/{file uuid}.{ext}; the two photo kinds accept ONLY
--     jpg, jpeg, png or webp, so a photo path can never name a pdf or heic file.
--   * load_documents.captured_at (nullable): the time the browser says the photo was taken. It is stored for
--     reference only and is never trusted or shown as the official time. The official time is created_at, the
--     server time of the insert.
--   * dlv_can_access_doc: the 0011 definition with the new kinds. Staff read and write everything. A carrier owner
--     or driver of the load's OWN carrier may WRITE a pickup_photo only while the load is at_pickup or loading and a
--     delivery_photo only while it is at_delivery (POD and BOL rules unchanged), and reads their own loads'
--     documents as before. A customer READS (never writes) a pickup_photo once the load is enroute, at_delivery or
--     delivered, and a delivery_photo once it is delivered; never another customer's. The storage policies
--     documents_select and documents_insert already delegate to this function, so they follow without a change
--     to the select policy; the insert policy is restated below with one extra clause (images only for photo paths).
--   * The load_documents insert policy restates the 0003 rule and adds, for a photo kind only, that the file must already
--     be in the bucket with an image mimetype. A photo row can therefore not be inserted without its picture (that
--     would satisfy the set_load_status gate with nothing behind it), and a pdf cannot hide behind a photo name.
--   * Max 6 photos per kind per load, enforced by a BEFORE INSERT trigger (advisory lock per load and kind, so two
--     concurrent inserts cannot both pass).
--   * set_load_status: the 0013 body with ONLY two additions (marked "0018"): a carrier role cannot move a load to
--     enroute without a pickup_photo row, nor to delivered without a delivery_photo row. Staff are exempt and when
--     they skip a missing photo the event note says so. Nothing else changed (diff the two bodies to confirm).
--   * delete_load_photo(p_doc): the only way to remove a photo row (NO DELETE privilege on load_documents is
--     granted). A carrier may remove a photo it uploaded itself while the step is still open; staff may remove any
--     photo; the function returns the storage path and the server action removes the file.
--   * record_load_deletion_orphans: the 0014 body with the path shape extended to the photo kinds, so photo files
--     that could not be removed by delete_load_forever can be logged. delete_load_forever itself is unchanged: it
--     already collects EVERY storage_path of the load from load_documents, whatever the kind.
-- Existing rows are untouched. Idempotent (IF NOT EXISTS, drop-then-add constraints, CREATE OR REPLACE, grants restated).

alter table public.load_documents add column if not exists captured_at timestamptz;

alter table public.load_documents drop constraint if exists load_documents_kind_check;
alter table public.load_documents add constraint load_documents_kind_check
  check (kind in ('bol','pod','pickup_photo','delivery_photo'));

alter table public.load_documents drop constraint if exists load_documents_path_ck;
alter table public.load_documents add constraint load_documents_path_ck check (
  storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/((bol|pod)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}|(pickup_photo|delivery_photo)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp))$'
  and left(storage_path, 38 + length(kind)) = load_id::text || '/' || kind || '/'
);

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
  -- carrier_owner, carrier_driver
  if l.carrier_id is distinct from public.dlv_carrier_id() or l.status = 'requested' then
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

revoke all on function public.dlv_can_access_doc(text, boolean) from public, anon;
grant execute on function public.dlv_can_access_doc(text, boolean) to authenticated, service_role;

-- Storage insert policy: the same function, plus "a photo object is declared as an image". The Storage API sets the
-- mimetype of the object it writes; a PDF sent to a photo path is refused here (the bucket list alone would allow it).
drop policy if exists documents_insert on storage.objects;
create policy documents_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'documents'
    and public.dlv_can_access_doc(name, true)
    and (name !~ '^[^/]+/(pickup_photo|delivery_photo)/'
         or coalesce(metadata ->> 'mimetype', '') in ('image/jpeg', 'image/png', 'image/webp'))
  );

-- load_documents insert: the 0003 rule (own row, writable window) plus, for a photo kind, "the file exists and is an image".
drop policy if exists load_documents_insert on public.load_documents;
create policy load_documents_insert on public.load_documents for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and public.dlv_can_access_doc(storage_path, true)
    and (kind not in ('pickup_photo','delivery_photo')
         or exists (select 1 from storage.objects o
                     where o.bucket_id = 'documents' and o.name = storage_path
                       and coalesce(o.metadata ->> 'mimetype', '') in ('image/jpeg', 'image/png', 'image/webp')))
  );

-- Max 6 photos of each kind per load, and created_at forced to the server time for a signed-in user.
create or replace function public.load_documents_photo_cap() returns trigger
language plpgsql security definer set search_path = ''
as $fn$
begin
  if new.kind in ('pickup_photo','delivery_photo') then
    -- The official time is the server time of the insert. A signed-in user (the browser inserts this row itself
    -- with the table grant) cannot back-date or forward-date a photo by sending created_at; service paths keep theirs.
    if auth.uid() is not null then new.created_at := now(); end if;
    perform pg_advisory_xact_lock(hashtextextended(new.load_id::text || '/' || new.kind, 0));
    if (select count(*) from public.load_documents d where d.load_id = new.load_id and d.kind = new.kind) >= 6 then
      raise exception 'A load can have at most 6 photos of this kind. Remove one first.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end
$fn$;
revoke all on function public.load_documents_photo_cap() from public, anon, authenticated;

drop trigger if exists load_documents_photo_cap on public.load_documents;
create trigger load_documents_photo_cap before insert on public.load_documents
  for each row execute function public.load_documents_photo_cap();

-- Remove one photo row (the only delete path). Returns the storage path; the server action removes the file.
create or replace function public.delete_load_photo(p_doc uuid) returns text
language plpgsql security definer set search_path = ''
as $fn$
declare
  d public.load_documents;
  l public.loads;
  v_role text := public.dlv_role();
begin
  if auth.uid() is null or v_role is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into d from public.load_documents where id = p_doc for update;
  if not found then raise exception 'photo not found' using errcode = 'P0002'; end if;
  if d.kind not in ('pickup_photo','delivery_photo') then
    raise exception 'only photos can be removed' using errcode = '42501';
  end if;
  select * into l from public.loads where id = d.load_id for update;
  if not public.dlv_is_staff() then
    -- a carrier removes only the photo it took itself, and only while the step is still open
    if v_role not in ('carrier_owner','carrier_driver')
       or l.carrier_id is distinct from public.dlv_carrier_id()
       or d.uploaded_by is distinct from auth.uid()
       or not public.dlv_can_access_doc(d.storage_path, true) then
      raise exception 'you cannot remove this photo' using errcode = '42501';
    end if;
  end if;
  delete from public.load_documents where id = d.id;
  return d.storage_path;
end
$fn$;

revoke all on function public.delete_load_photo(uuid) from public, anon;
grant execute on function public.delete_load_photo(uuid) to authenticated, service_role;

-- set_load_status: the 0013 body plus the two photo gates (0018).
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
  v_note text := p_note; -- 0018: the staff skip is appended to the event note
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

  -- 0013: ITS is the source of truth for the load number. A request leaves 'requested' (booked, or a staff
  -- override jump) only once the ITS load number is on the load. Cancelling needs none, and legacy loads that
  -- are already booked without a number move forward normally (the rule needs old status = requested).
  if l.status = 'requested' and p_status <> 'cancelled' and l.its_load_number is null then
    raise exception 'enter the ITS load number before booking' using errcode = 'P0001';
  end if;

  v_eta := coalesce(p_eta, l.eta);
  if p_status = 'enroute' and v_eta is null then
    raise exception 'eta is required for enroute' using errcode = 'P0001';
  end if;

  -- 0018: photo gates. A carrier cannot leave for delivery without a pickup photo, nor mark delivered without a
  -- delivery photo. Staff are exempt (dispatch can fix a stuck load); the skip is recorded in the event note.
  if p_status = 'enroute' and l.status in ('requested','booked','at_pickup','loading')
     and not exists (select 1 from public.load_documents d where d.load_id = l.id and d.kind = 'pickup_photo') then
    if not v_staff then
      raise exception 'Take a photo of the loaded freight first. The load cannot leave for delivery without it.' using errcode = 'P0001';
    end if;
    v_note := case when coalesce(btrim(v_note), '') = '' then '' else btrim(v_note) || '. ' end
      || 'Staff skipped the pickup photo (none on file).';
  end if;
  if p_status = 'delivered' and l.status in ('requested','booked','at_pickup','loading','enroute','at_delivery')
     and not exists (select 1 from public.load_documents d where d.load_id = l.id and d.kind = 'delivery_photo') then
    if not v_staff then
      raise exception 'Take a delivery photo first. The load cannot be marked delivered without it.' using errcode = 'P0001';
    end if;
    v_note := case when coalesce(btrim(v_note), '') = '' then '' else btrim(v_note) || '. ' end
      || 'Staff skipped the delivery photo (none on file).';
  end if;

  -- The load_events row is written by the loads_status_event trigger; it reads the note from here.
  perform set_config('dlv.event_note', coalesce(v_note, ''), true);
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

-- record_load_deletion_orphans: the 0014 body, path shape extended to the photo kinds.
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
  -- Only strict document paths of THIS load can be recorded (same shape as dlv_can_access_doc, 0018).
  select count(*) into v_bad from unnest(p_paths) p
   where p is null
      or p !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/((bol|pod)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}|(pickup_photo|delivery_photo)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp))$'
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
