-- 0015: lane references (DLV-028, R39). STAFF ONLY.
-- DLV dispatches in ITS. For each repeat lane staff copy an old ITS load. A scenario is pickup location + delivery
-- location + truck size (26, 36, 53); this table records WHICH old ITS load to copy for each scenario.
--   * public.lane_references: one row per scenario (UNIQUE on the three key columns), the ITS load number to copy
--     (digits with an optional dash and digits, at most 30 characters, same shape as loads.its_load_number), an
--     optional note, created_at, updated_at (shared touch trigger from 0009), updated_by (set from auth.uid()).
--   * RLS on. All privileges revoked from PUBLIC and anon by name; select, insert, update, delete granted to
--     authenticated, and ONE policy per command that admits only an ACTIVE staff user (dlv_is_staff(): staff_admin
--     and staff_csr have identical rights here). There is NO policy for customer, carrier_owner or carrier_driver,
--     so those roles read and write nothing. The table is NOT added to the realtime publication.
--   * The Moffett column of the owner's table is NOT stored: it is derived from the two locations (requires_moffett
--     of pickup or delivery), see 0016 for the data.
-- No existing row or function is touched. Idempotent (IF NOT EXISTS, CREATE OR REPLACE, grants restated by name).

create table if not exists public.lane_references (
  id uuid primary key default gen_random_uuid(),
  pickup_location_id uuid not null references public.locations(id),
  delivery_location_id uuid not null references public.locations(id),
  equipment_size int not null,
  its_reference_load text not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint lane_references_size_ck check (equipment_size in (26, 36, 53)),
  constraint lane_references_number_ck check (its_reference_load ~ '^[0-9]+(-[0-9]+)?$' and length(its_reference_load) <= 30),
  constraint lane_references_distinct_ck check (pickup_location_id <> delivery_location_id),
  constraint lane_references_scenario_uq unique (pickup_location_id, delivery_location_id, equipment_size)
);
create index if not exists lane_references_delivery_idx on public.lane_references (delivery_location_id);

-- updated_by comes from the session (the staff user), never from the client payload. A service role write has no
-- auth.uid() and records null.
create or replace function public.dlv_lane_references_before_write() returns trigger
language plpgsql set search_path = ''
as $fn$
begin
  new.updated_by := auth.uid();
  return new;
end
$fn$;

drop trigger if exists lane_references_set_actor on public.lane_references;
create trigger lane_references_set_actor before insert or update on public.lane_references
  for each row execute function public.dlv_lane_references_before_write();
drop trigger if exists lane_references_touch_updated_at on public.lane_references;
create trigger lane_references_touch_updated_at before update on public.lane_references
  for each row execute function public.dlv_touch_updated_at();

alter table public.lane_references enable row level security;
revoke all on public.lane_references from public, anon, authenticated;
grant select, insert, update, delete on public.lane_references to authenticated;
grant all on public.lane_references to service_role;

drop policy if exists lane_references_staff_select on public.lane_references;
create policy lane_references_staff_select on public.lane_references for select to authenticated
  using (public.dlv_is_staff());
drop policy if exists lane_references_staff_insert on public.lane_references;
create policy lane_references_staff_insert on public.lane_references for insert to authenticated
  with check (public.dlv_is_staff());
drop policy if exists lane_references_staff_update on public.lane_references;
create policy lane_references_staff_update on public.lane_references for update to authenticated
  using (public.dlv_is_staff()) with check (public.dlv_is_staff());
drop policy if exists lane_references_staff_delete on public.lane_references;
create policy lane_references_staff_delete on public.lane_references for delete to authenticated
  using (public.dlv_is_staff());

-- Trigger function, never called by clients. Restated by name.
revoke all on function public.dlv_lane_references_before_write() from public, anon, authenticated;
grant execute on function public.dlv_lane_references_before_write() to service_role;
