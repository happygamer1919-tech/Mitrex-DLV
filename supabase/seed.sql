-- DLV Mitrex portal seed. Idempotent. Carriers and users come from scripts/seed-users.mjs.

insert into public.customers (name) values ('Mitrex')
on conflict (name) do nothing;

insert into public.locations
  (name, address_line, city, province, postal_code, can_ship, can_receive, requires_moffett, needs_review)
values
  ('Mitrex', '41 Racine Rd', 'Toronto', 'ON', 'M9W 2Z4', true, true, false, false),
  ('481 University Ave', '481 University Ave', 'Toronto', 'ON', 'M5G 1W2', true, true, false, false),
  ('125G', '125 George St', 'Toronto', 'ON', 'M5A 2N4', true, true, false, false),
  ('Sherbourne', '591 Sherbourne St', 'Toronto', 'ON', 'M4X 1W7', true, true, false, false),
  ('SAMIH', '840 Military Trail', 'Scarborough', 'ON', 'M1C 0C7', true, true, true, false),
  ('Howden', '38 Howden Rd', 'Scarborough', 'ON', 'M1R 3E9', true, true, false, false),
  ('D Express Transport', '30 Bethridge Rd', 'Etobicoke', 'ON', 'M9W 1N1', true, true, false, false),
  ('Scion Powder Coatings Inc', '120 Woodbine Downs Blvd', 'Toronto', 'ON', null, true, false, false, true),
  ('MTD MetroTool & Die Limited', '1065 Pantera Dr', 'Mississauga', 'ON', 'L4W 2X4', true, false, false, false),
  ('Valley Metal Finishing Ltd', '211 Snidercroft Rd', 'Concord', 'ON', 'L4K 2J9', true, false, false, false),
  ('QuickScrap Metal', '407 Rexdale Blvd', 'Etobicoke', 'ON', 'M9W 6P8', false, true, false, false),
  ('Spadina', '315 Spadina Ave', 'Toronto', 'ON', 'M5T 2E9', false, true, false, false),
  ('Military Trailsite', '1050 Military Trail', 'Scarborough', 'ON', 'M1C 1G9', false, true, false, false),
  ('1HAM', '1 Hamilton St S', 'Hamilton', 'ON', 'L8B 1A6', false, true, false, false),
  ('831 Queen', '831 Queenston Rd', 'Hamilton', 'ON', 'L8G 1B2', false, true, false, false),
  ('152 Sh', '152 Shanley St', 'Kitchener', 'ON', 'N2H 5P5', false, true, false, false),
  ('Kitney site', '25 Kitney Dr', 'Ajax', 'ON', 'L1S 0G6', false, true, false, false),
  ('PrimeFab', '111 Pilsbury Drive', 'Midland', 'ON', 'L4R 0A3', false, true, false, false),
  ('Glengarry', '94 Wright Crescent', 'Kingston', 'ON', 'K7L 5M3', false, true, false, false)
on conflict (name) do update set
  address_line = excluded.address_line,
  city = excluded.city,
  province = excluded.province,
  postal_code = excluded.postal_code,
  can_ship = excluded.can_ship,
  can_receive = excluded.can_receive,
  requires_moffett = excluded.requires_moffett,
  needs_review = excluded.needs_review;
