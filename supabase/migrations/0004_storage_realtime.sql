-- Private documents bucket, storage RLS mirroring load access, realtime publication.

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do update set public = false;

create policy documents_select on storage.objects for select to authenticated
  using (bucket_id = 'documents' and public.dlv_can_access_doc(name, false));
create policy documents_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and public.dlv_can_access_doc(name, true));

do $do$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.loads;
    alter publication supabase_realtime add table public.load_events;
  end if;
end
$do$;
