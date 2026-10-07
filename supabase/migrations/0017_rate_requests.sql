-- 0017: rate requests (DLV-030, R40). A customer asks for a RATE for a lane that is not in the system; staff enter the
-- rate; the customer sees it in the app. A rate request is NOT a load and creates no load. Touches no existing table.
--   * public.rate_requests: ref RQ-0001 style (own sequence rate_request_seq), customer_id, requested_by, pickup and
--     delivery city and state (trimmed, 1 to 80 characters, state = US state, DC or Canadian province code in upper
--     case), equipment_size 26 / 36 / 53, optional weight (1 to 100000 lbs), dims (200), notes (1000), status
--     open / quoted / cancelled, the quote (amount > 0, currency CAD or USD, notes, valid until, quoted_by,
--     quoted_at), created_at, updated_at (shared touch trigger). CHECK: the four quote fields are set exactly when
--     status = 'quoted', and quote_notes / quote_valid_until are null otherwise.
--   * Insert: customers only, only for their own customer_id (policy WITH CHECK). The insert grant is COLUMN level
--     (no id, ref, requested_by, status, quote columns, timestamps), and a BEFORE INSERT trigger forces
--     requested_by = auth.uid(), status = open and every quote column null for any signed in user.
--   * Select: a customer reads rows of its own customer_id, active staff read all. Carriers read nothing.
--   * NO UPDATE and NO DELETE grant or policy for any client role. The only writes after the insert are two SECURITY
--     DEFINER functions: set_rate_quote (active staff_admin or staff_csr; refuses a cancelled request; correcting an
--     already quoted request is allowed and restamps quoted_by and quoted_at) and cancel_rate_request (the customer
--     of the request, open requests only).
--   * Not added to the realtime publication (the pages poll every 15 seconds).
-- Additive and idempotent (IF NOT EXISTS, CREATE OR REPLACE, grants restated by name).

create sequence if not exists public.rate_request_seq start 1;

create table if not exists public.rate_requests (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique default ('RQ-' || lpad(nextval('public.rate_request_seq')::text, 4, '0')),
  customer_id uuid not null references public.customers(id),
  requested_by uuid not null references public.profiles(id),
  pickup_city text not null,
  pickup_state text not null,
  delivery_city text not null,
  delivery_state text not null,
  equipment_size int not null,
  weight_lbs int,
  dims text,
  notes text,
  status text not null default 'open',
  quoted_amount numeric(12,2),
  quoted_currency text,
  quote_notes text,
  quote_valid_until date,
  quoted_by uuid,
  quoted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rate_requests_city_ck check (
    pickup_city = btrim(pickup_city) and char_length(pickup_city) between 1 and 80
    and delivery_city = btrim(delivery_city) and char_length(delivery_city) between 1 and 80),
  constraint rate_requests_state_ck check (
    pickup_state = any (array['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'])
    and delivery_state = any (array['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'])),
  constraint rate_requests_size_ck check (equipment_size in (26, 36, 53)),
  constraint rate_requests_weight_ck check (weight_lbs is null or (weight_lbs > 0 and weight_lbs <= 100000)),
  constraint rate_requests_dims_ck check (dims is null or (dims = btrim(dims) and char_length(dims) between 1 and 200)),
  constraint rate_requests_notes_ck check (notes is null or (notes = btrim(notes) and char_length(notes) between 1 and 1000)),
  constraint rate_requests_status_ck check (status in ('open', 'quoted', 'cancelled')),
  constraint rate_requests_amount_ck check (quoted_amount is null or (quoted_amount > 0 and quoted_amount < 100000000)),
  constraint rate_requests_currency_ck check (quoted_currency is null or quoted_currency in ('CAD', 'USD')),
  constraint rate_requests_quote_notes_ck check (quote_notes is null or char_length(quote_notes) between 1 and 1000),
  constraint rate_requests_quote_set_ck check (
    (status = 'quoted' and quoted_amount is not null and quoted_currency is not null and quoted_by is not null and quoted_at is not null)
    or (status <> 'quoted' and quoted_amount is null and quoted_currency is null and quoted_by is null and quoted_at is null
        and quote_notes is null and quote_valid_until is null))
);
create index if not exists rate_requests_customer_idx on public.rate_requests (customer_id, created_at desc);
create index if not exists rate_requests_status_idx on public.rate_requests (status, created_at desc);

-- BEFORE INSERT: normalise the text, and for any signed in user force the server owned columns. A service role write
-- (auth.uid() null, owner tooling and the e2e seeding) keeps the values it sends.
create or replace function public.dlv_rate_requests_before_insert() returns trigger
language plpgsql set search_path = ''
as $fn$
begin
  new.pickup_city := btrim(new.pickup_city);
  new.delivery_city := btrim(new.delivery_city);
  new.pickup_state := upper(btrim(new.pickup_state));
  new.delivery_state := upper(btrim(new.delivery_state));
  new.dims := nullif(btrim(new.dims), '');
  new.notes := nullif(btrim(new.notes), '');
  if auth.uid() is not null then
    new.requested_by := auth.uid();
    new.status := 'open';
    new.quoted_amount := null;
    new.quoted_currency := null;
    new.quote_notes := null;
    new.quote_valid_until := null;
    new.quoted_by := null;
    new.quoted_at := null;
    new.created_at := now();
    new.updated_at := now();
  end if;
  return new;
end
$fn$;

drop trigger if exists rate_requests_before_insert on public.rate_requests;
create trigger rate_requests_before_insert before insert on public.rate_requests
  for each row execute function public.dlv_rate_requests_before_insert();
drop trigger if exists rate_requests_touch_updated_at on public.rate_requests;
create trigger rate_requests_touch_updated_at before update on public.rate_requests
  for each row execute function public.dlv_touch_updated_at();

alter table public.rate_requests enable row level security;
revoke all on public.rate_requests from public, anon, authenticated;
grant select on public.rate_requests to authenticated;
grant insert (customer_id, pickup_city, pickup_state, delivery_city, delivery_state, equipment_size, weight_lbs, dims, notes)
  on public.rate_requests to authenticated;
grant all on public.rate_requests to service_role;
revoke all on sequence public.rate_request_seq from public, anon, authenticated;
grant usage on sequence public.rate_request_seq to authenticated;
grant all on sequence public.rate_request_seq to service_role;

drop policy if exists rate_requests_select on public.rate_requests;
create policy rate_requests_select on public.rate_requests for select to authenticated
  using (public.dlv_is_staff() or (public.dlv_role() = 'customer' and customer_id = public.dlv_customer_id()));
drop policy if exists rate_requests_insert on public.rate_requests;
create policy rate_requests_insert on public.rate_requests for insert to authenticated
  with check (public.dlv_role() = 'customer' and customer_id = public.dlv_customer_id());

-- Staff enter (or correct) the rate. Returns the status the request had BEFORE the call ('open' for a first rate,
-- 'quoted' for a correction) so the caller knows which email to send.
create or replace function public.set_rate_quote(p_id uuid, p_amount numeric, p_currency text, p_notes text, p_valid_until date)
returns text
language plpgsql security definer set search_path = ''
as $fn$
declare
  r public.rate_requests;
  v_amount numeric(12,2);
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  if auth.uid() is null or not public.dlv_is_staff() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into r from public.rate_requests where id = p_id for update;
  if not found then raise exception 'rate request not found' using errcode = 'P0002'; end if;
  if r.status = 'cancelled' then raise exception 'this request was cancelled' using errcode = 'P0001'; end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 100000000 then
    raise exception 'amount must be greater than 0' using errcode = 'P0001';
  end if;
  v_amount := round(p_amount, 2);
  if v_amount <= 0 then raise exception 'amount must be greater than 0' using errcode = 'P0001'; end if;
  if p_currency is null or p_currency not in ('CAD', 'USD') then
    raise exception 'currency must be CAD or USD' using errcode = 'P0001';
  end if;
  if v_notes is not null and char_length(v_notes) > 1000 then
    raise exception 'notes are too long' using errcode = 'P0001';
  end if;
  if p_valid_until is not null and p_valid_until < (now() at time zone 'America/Toronto')::date then
    raise exception 'valid until cannot be in the past' using errcode = 'P0001';
  end if;
  update public.rate_requests set
    status = 'quoted', quoted_amount = v_amount, quoted_currency = p_currency, quote_notes = v_notes,
    quote_valid_until = p_valid_until, quoted_by = auth.uid(), quoted_at = now()
   where id = r.id;
  return r.status;
end
$fn$;

-- The customer of the request cancels it while it is open. A request of another customer reads as not found.
create or replace function public.cancel_rate_request(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $fn$
declare r public.rate_requests;
begin
  if auth.uid() is null or public.dlv_role() is distinct from 'customer' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into r from public.rate_requests where id = p_id and customer_id = public.dlv_customer_id() for update;
  if not found then raise exception 'rate request not found' using errcode = 'P0002'; end if;
  if r.status <> 'open' then raise exception 'only an open request can be cancelled' using errcode = 'P0001'; end if;
  update public.rate_requests set status = 'cancelled' where id = r.id;
end
$fn$;

-- Restated by name: nobody but signed in users (and the service role) can execute them; the trigger function is never
-- called by clients.
revoke all on function public.set_rate_quote(uuid, numeric, text, text, date) from public, anon, authenticated;
grant execute on function public.set_rate_quote(uuid, numeric, text, text, date) to authenticated, service_role;
revoke all on function public.cancel_rate_request(uuid) from public, anon, authenticated;
grant execute on function public.cancel_rate_request(uuid) to authenticated, service_role;
revoke all on function public.dlv_rate_requests_before_insert() from public, anon, authenticated;
grant execute on function public.dlv_rate_requests_before_insert() to service_role;
