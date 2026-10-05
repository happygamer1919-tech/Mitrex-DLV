-- DLV Mitrex portal: RLS and grants. SR-52/56: revoke from PUBLIC and anon by name,
-- then grant narrowly to authenticated. Default privileges are revoked too.

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

alter table public.customers enable row level security;
alter table public.carriers enable row level security;
alter table public.profiles enable row level security;
alter table public.locations enable row level security;
alter table public.location_requests enable row level security;
alter table public.loads enable row level security;
alter table public.load_events enable row level security;
alter table public.load_documents enable row level security;

-- Table grants (RLS then narrows rows).
grant select on public.customers, public.carriers, public.profiles, public.locations,
  public.location_requests, public.loads, public.load_events, public.load_documents to authenticated;
grant insert, update, delete on public.customers, public.carriers to authenticated;
grant insert, update, delete on public.locations to authenticated;
grant insert, update on public.location_requests to authenticated;
grant insert, update on public.loads to authenticated;
grant insert on public.load_documents to authenticated;
grant usage on sequence public.load_seq to authenticated;

-- Function grants.
grant execute on function
  public.dlv_role(), public.dlv_is_staff(), public.dlv_is_admin(),
  public.dlv_customer_id(), public.dlv_carrier_id(),
  public.dlv_carrier_can_see_location(uuid), public.dlv_customer_can_see_carrier(uuid),
  public.dlv_can_access_doc(text, boolean),
  public.dlv_check_load_locations(public.loads), public.dlv_step_index(public.load_status),
  public.set_load_status(uuid, public.load_status, timestamptz, text),
  public.set_load_eta(uuid, timestamptz, text),
  public.approve_location_request(uuid), public.reject_location_request(uuid)
  to authenticated;

-- customers: staff_admin manages; a customer reads its own row; staff read all.
create policy customers_select on public.customers for select to authenticated
  using (public.dlv_is_staff() or id = public.dlv_customer_id());
create policy customers_admin_write on public.customers for all to authenticated
  using (public.dlv_is_admin()) with check (public.dlv_is_admin());

-- carriers
create policy carriers_select on public.carriers for select to authenticated
  using (public.dlv_is_staff()
         or id = public.dlv_carrier_id()
         or public.dlv_customer_can_see_carrier(id));
create policy carriers_admin_write on public.carriers for all to authenticated
  using (public.dlv_is_admin()) with check (public.dlv_is_admin());

-- profiles are written by the service role only. Reads: self, staff, same carrier owner.
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid()
         or public.dlv_is_staff()
         or (public.dlv_role() = 'carrier_owner' and carrier_id = public.dlv_carrier_id()));

-- locations
create policy locations_select on public.locations for select to authenticated
  using (public.dlv_is_staff()
         or (public.dlv_role() = 'customer' and is_active)
         or public.dlv_carrier_can_see_location(id));
create policy locations_staff_insert on public.locations for insert to authenticated
  with check (public.dlv_is_staff());
create policy locations_staff_delete on public.locations for delete to authenticated
  using (public.dlv_is_staff());
create policy locations_update on public.locations for update to authenticated
  using (public.dlv_is_staff() or public.dlv_role() = 'customer')
  with check (public.dlv_is_staff() or public.dlv_role() = 'customer');

-- location_requests
create policy location_requests_select on public.location_requests for select to authenticated
  using (public.dlv_is_staff() or requested_by = auth.uid());
create policy location_requests_insert on public.location_requests for insert to authenticated
  with check (public.dlv_role() = 'customer' and requested_by = auth.uid() and status = 'pending');
create policy location_requests_staff_update on public.location_requests for update to authenticated
  using (public.dlv_is_staff()) with check (public.dlv_is_staff());

-- loads
create policy loads_select on public.loads for select to authenticated
  using (public.dlv_is_staff()
         or (public.dlv_role() = 'customer' and customer_id = public.dlv_customer_id())
         or (public.dlv_role() in ('carrier_owner','carrier_driver')
             and carrier_id = public.dlv_carrier_id() and status <> 'requested'));
create policy loads_customer_insert on public.loads for insert to authenticated
  with check (public.dlv_role() = 'customer'
              and customer_id = public.dlv_customer_id()
              and created_by = auth.uid()
              and status = 'requested');
create policy loads_staff_insert on public.loads for insert to authenticated
  with check (public.dlv_is_staff());
create policy loads_customer_update on public.loads for update to authenticated
  using (public.dlv_role() = 'customer' and customer_id = public.dlv_customer_id() and status = 'requested')
  with check (public.dlv_role() = 'customer' and customer_id = public.dlv_customer_id() and status = 'requested');
create policy loads_staff_update on public.loads for update to authenticated
  using (public.dlv_is_staff()) with check (public.dlv_is_staff());

-- load_events: read mirrors load access; written only by the definer functions and triggers.
create policy load_events_select on public.load_events for select to authenticated
  using (exists (select 1 from public.loads l where l.id = load_events.load_id));

-- load_documents
create policy load_documents_select on public.load_documents for select to authenticated
  using (exists (select 1 from public.loads l where l.id = load_documents.load_id)
         and public.dlv_can_access_doc(storage_path, false));
create policy load_documents_insert on public.load_documents for insert to authenticated
  with check (uploaded_by = auth.uid() and public.dlv_can_access_doc(storage_path, true));
