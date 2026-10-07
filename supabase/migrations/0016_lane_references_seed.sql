-- 0016: lane references data (DLV-028, R39). The owner's table of 25 lanes (shipper, receiver, truck size, ITS load
-- to copy) plus the Moffett flag on the seven sites the owner marked Y (SAMIH already requires it).
--   * All or nothing: every shipper and receiver name is resolved against public.locations BEFORE anything is
--     written; a missing or ambiguous name raises one clear exception and the whole statement rolls back.
--   * Idempotent: an upsert on the scenario key (a second apply changes nothing; a row whose number was edited
--     afterwards is set back to the owner's number), and the Moffett update only touches rows that are still false.
--   * Lanes the owner left out on purpose (125G to Etobicoke, D Express to Etobicoke, MTD to Etobicoke, 481 to
--     Brampton, Mitrex to Winnipeg) are NOT invented.
--   * The Moffett column of the owner's table is derived (pickup or delivery requires Moffett), never stored.
--   * Fresh database: the migrations run before supabase/seed.sql, so the locations are not there yet. With no
--     location at all this block does nothing and seed.sql applies the same block. Production always has them.

do $lane_seed$
declare
  v_seed jsonb := '[
    ["D Express Transport", "481 University Ave", 53, "653"],
    ["Mitrex", "481 University Ave", 26, "1269"],
    ["Mitrex", "481 University Ave", 53, "1264"],
    ["481 University Ave", "QuickScrap Metal", 26, "1275"],
    ["481 University Ave", "QuickScrap Metal", 53, "1265"],
    ["481 University Ave", "Mitrex", 53, "829"],
    ["481 University Ave", "Mitrex", 26, "752"],
    ["Mitrex", "125G", 26, "1488"],
    ["Mitrex", "QuickScrap Metal", 26, "1278"],
    ["Valley Metal Finishing Ltd", "Mitrex", 26, "1292"],
    ["Mitrex", "Spadina", 26, "810"],
    ["Mitrex", "Sherbourne", 26, "1484"],
    ["Howden", "Sherbourne", 26, "1475"],
    ["Sherbourne", "Howden", 26, "1486"],
    ["Sherbourne", "QuickScrap Metal", 26, "1439"],
    ["Mitrex", "1HAM", 26, "158"],
    ["Mitrex", "152 Sh", 26, "292"],
    ["Mitrex", "831 Queen", 26, "1468"],
    ["Mitrex", "SAMIH", 26, "1469"],
    ["SAMIH", "Mitrex", 26, "1241"],
    ["SAMIH", "QuickScrap Metal", 26, "1471"],
    ["Mitrex", "Glengarry", 26, "1470"],
    ["Mitrex", "Kitney site", 26, "1084"],
    ["Mitrex", "Military Trailsite", 26, "776"],
    ["Mitrex", "PrimeFab", 26, "1293"]
  ]';
  v_missing text;
  v_ambiguous text;
begin
  -- supabase/seed.sql also runs after a partial reset (supabase db reset --last N) that stops before 0015.
  if to_regclass('public.lane_references') is null then
    raise notice '0016: public.lane_references does not exist yet (0015 not applied), nothing to seed';
    return;
  end if;
  -- A fresh database has no locations yet when the migrations run; supabase/seed.sql then applies this same block
  -- after the locations exist. A database WITH locations must resolve every name, or nothing at all is written.
  if not exists (select 1 from public.locations) then
    raise notice '0016: no locations yet, lane references are applied by supabase/seed.sql';
    return;
  end if;

  select string_agg(distinct n, ', ' order by n) into v_missing
    from (select e ->> 0 as n from jsonb_array_elements(v_seed) e union select e ->> 1 from jsonb_array_elements(v_seed) e) s
   where not exists (select 1 from public.locations l where l.name = s.n);
  if v_missing is not null then
    raise exception '0016: location name(s) not found, nothing was written: %', v_missing;
  end if;

  select string_agg(distinct n, ', ' order by n) into v_ambiguous
    from (select e ->> 0 as n from jsonb_array_elements(v_seed) e union select e ->> 1 from jsonb_array_elements(v_seed) e) s
   where (select count(*) from public.locations l where l.name = s.n) > 1;
  if v_ambiguous is not null then
    raise exception '0016: location name(s) match more than one row, nothing was written: %', v_ambiguous;
  end if;

  -- The seven sites that need a Moffett (SAMIH already does). Only where it is currently false.
  update public.locations set requires_moffett = true
   where name in ('1HAM', '152 Sh', '831 Queen', 'Glengarry', 'Kitney site', 'Military Trailsite', 'PrimeFab')
     and not requires_moffett;

  insert into public.lane_references (pickup_location_id, delivery_location_id, equipment_size, its_reference_load)
  select p.id, d.id, (e ->> 2)::int, e ->> 3
    from jsonb_array_elements(v_seed) e
    join public.locations p on p.name = e ->> 0
    join public.locations d on d.name = e ->> 1
  on conflict (pickup_location_id, delivery_location_id, equipment_size) do update
    set its_reference_load = excluded.its_reference_load
    where public.lane_references.its_reference_load is distinct from excluded.its_reference_load;
end
$lane_seed$;
