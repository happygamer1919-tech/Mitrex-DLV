-- C4b: documents bucket hardening. A document path is exactly
--   {load uuid}/{bol|pod}/{file uuid}.{ext}
-- all lower case, no other characters. Before this, dlv_can_access_doc only split on '/', so a name such as
-- '<load>/pod/../<other load>/bol/x.pdf' or '<load>/pod//x' was accepted, and the load_documents CHECK
-- (storage_path like load_id/kind/%) accepted the same names.

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
    return v_kind = 'pod' and l.status in ('enroute','at_delivery');
  end if;
  return true;
end
$fn$;

revoke all on function public.dlv_can_access_doc(text, boolean) from public, anon;
grant execute on function public.dlv_can_access_doc(text, boolean) to authenticated, service_role;

-- load_documents: same shape, and the folder and kind must equal the row's own load_id and kind.
-- The production table is empty, so the constraint validates cleanly.
alter table public.load_documents drop constraint if exists load_documents_path_ck;
alter table public.load_documents add constraint load_documents_path_ck check (
  storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(bol|pod)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$'
  and left(storage_path, 38 + length(kind)) = load_id::text || '/' || kind || '/'
);

-- Bucket limits matching the UI (BOL: pdf, png, jpg, jpeg, webp, heic up to 15 MB; POD: compressed jpeg).
-- image/heif is allowed because some browsers label a .heic file that way.
update storage.buckets
   set public = false,
       file_size_limit = 15728640,
       allowed_mime_types = array['application/pdf','image/png','image/jpeg','image/webp','image/heic','image/heif']
 where id = 'documents';
