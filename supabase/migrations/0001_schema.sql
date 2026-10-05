-- DLV Mitrex portal: core schema. RLS is enabled in 0003.

create type public.load_status as enum
  ('requested','booked','at_pickup','loading','enroute','at_delivery','delivered','cancelled');

create type public.app_role as enum
  ('staff_admin','staff_csr','customer','carrier_owner','carrier_driver');

create sequence public.load_seq start 1;

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table public.carriers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  role public.app_role not null,
  customer_id uuid references public.customers(id),
  carrier_id uuid references public.carriers(id),
  created_at timestamptz not null default now(),
  constraint profiles_scope_ck check (
    (role in ('staff_admin','staff_csr') and customer_id is null and carrier_id is null)
    or (role = 'customer' and customer_id is not null and carrier_id is null)
    or (role in ('carrier_owner','carrier_driver') and carrier_id is not null and customer_id is null)
  )
);
create unique index profiles_email_lower_uq on public.profiles (lower(email));
create index profiles_carrier_idx on public.profiles (carrier_id);
create index profiles_customer_idx on public.profiles (customer_id);

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  address_line text not null,
  city text not null,
  province text not null,
  postal_code text,
  can_ship boolean not null default false,
  can_receive boolean not null default false,
  requires_moffett boolean not null default false,
  default_contact_name text,
  default_contact_phone text,
  is_active boolean not null default true,
  needs_review boolean not null default false,
  notes text
);

create table public.location_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('new','change')),
  location_id uuid references public.locations(id),
  payload jsonb not null,
  requested_by uuid not null references public.profiles(id),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  constraint location_requests_change_ck check (kind = 'new' or location_id is not null)
);

create table public.loads (
  id uuid primary key default gen_random_uuid(),
  load_number text not null unique
    default ('MTX-' || lpad(nextval('public.load_seq')::text, 4, '0')),
  customer_id uuid not null references public.customers(id),
  created_by uuid not null references public.profiles(id),
  pickup_location_id uuid not null references public.locations(id),
  delivery_location_id uuid not null references public.locations(id),
  equipment_size int not null check (equipment_size in (26,36,48,53)),
  moffett boolean not null default false,
  weight_lbs numeric check (weight_lbs is null or weight_lbs > 0),
  pieces int check (pieces is null or pieces > 0),
  po_number text,
  notes text,
  pickup_timing text not null check (pickup_timing in ('appointment','window')),
  pickup_date date not null,
  pickup_time_start time not null,
  pickup_time_end time,
  delivery_timing text not null check (delivery_timing in ('appointment','window')),
  delivery_date date not null,
  delivery_time_start time not null,
  delivery_time_end time,
  pickup_contact_name text not null,
  pickup_contact_phone text not null,
  delivery_contact_name text not null,
  delivery_contact_phone text not null,
  status public.load_status not null default 'requested',
  carrier_id uuid references public.carriers(id),
  eta timestamptz,
  booked_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint loads_locations_differ_ck check (pickup_location_id <> delivery_location_id),
  constraint loads_delivery_not_before_pickup_ck check (delivery_date >= pickup_date),
  constraint loads_pickup_timing_ck check (
    (pickup_timing = 'appointment' and pickup_time_end is null)
    or (pickup_timing = 'window' and pickup_time_end is not null and pickup_time_end > pickup_time_start)),
  constraint loads_delivery_timing_ck check (
    (delivery_timing = 'appointment' and delivery_time_end is null)
    or (delivery_timing = 'window' and delivery_time_end is not null and delivery_time_end > delivery_time_start)),
  constraint loads_contacts_ck check (
    length(btrim(pickup_contact_name)) > 0 and length(btrim(pickup_contact_phone)) > 0
    and length(btrim(delivery_contact_name)) > 0 and length(btrim(delivery_contact_phone)) > 0)
);
create index loads_customer_idx on public.loads (customer_id, created_at desc);
create index loads_carrier_idx on public.loads (carrier_id, status);
create index loads_status_idx on public.loads (status);
create index loads_pickup_date_idx on public.loads (pickup_date);

create table public.load_events (
  id bigint generated always as identity primary key,
  load_id uuid not null references public.loads(id) on delete cascade,
  from_status public.load_status,
  to_status public.load_status not null,
  actor_id uuid references public.profiles(id),
  note text,
  created_at timestamptz not null default now()
);
create index load_events_load_idx on public.load_events (load_id, created_at);

create table public.load_documents (
  id uuid primary key default gen_random_uuid(),
  load_id uuid not null references public.loads(id) on delete cascade,
  kind text not null check (kind in ('bol','pod')),
  storage_path text not null,
  uploaded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  constraint load_documents_path_ck check (storage_path like load_id::text || '/' || kind || '/%')
);
create index load_documents_load_idx on public.load_documents (load_id, kind);
