# Spec

Source of truth for WHAT the DLV portal does. Requirements are numbered R1..Rn. `docs/SPEC-COVERAGE.md` maps each R-number to evidence. Decisions that refine this spec are in DECISIONS.md.

DLV Logistics is a freight brokerage (Canada/US). Client Mitrex (also Cladify) ships flatbed loads, mostly from Etobicoke to construction sites in the GTA and Ontario. Their rep Maria books by email today. The portal is "DLV" at https://portal.dlvlogistics.com (Vercel project mitrex-dlv).

## Platform
- R1 Next.js (App Router, TypeScript), Tailwind, Supabase (Postgres, Auth, Storage, Realtime, RLS). Installable PWA: manifest, icons (192, 512, maskable), minimal service worker, standalone display, theme color #020814. No push.
- R2 All times display in America/Toronto and are labelled "ET".
- R3 Invite-only login, no passwords, public signup off. Login is by emailed code (8 digits on hosted Supabase) with the emailed link as fallback; the code works from the installed iPhone PWA.
- R4 Roles: staff_admin, staff_csr, customer, carrier_owner, carrier_driver, stored in profiles. staff_admin and staff_csr have identical operational rights. Only staff_admin manages users, carriers and customers.
- R5 Customers are modelled (customers table, profiles.customer_id). Customer Mitrex is seeded. Maria is its only user.
- R6 One carrier_owner login per carrier company. The owner adds and removes drivers by email (carrier_driver, same carrier). Drivers see exactly what the carrier sees.
- R7 scripts/seed-users.mjs creates the invited users and carriers from SEED_* env names, idempotently, and refuses non-local targets without an explicit flag.
- R8 Every table has RLS on. All privileges are revoked from PUBLIC and anon, then granted narrowly to authenticated.

## Data and rules
- R9 locations table and the 19 seeded locations (supabase/seed.sql, idempotent). SAMIH requires Moffett. Scion Powder Coatings is flagged needs_review.
- R10 location_requests (kind new or change, payload, status pending, approved or rejected).
- R11 loads carry the specified columns and constraints: load_number MTX-0001 style, equipment 26/36/48/53, appointment or window timing for pickup and delivery, per-load contact snapshots, status enum, carrier, ETA and timestamps.
- R12 load_events is an append-only audit of every status change.
- R13 load_documents (bol, pod) in a private bucket "documents", path {load_id}/{kind}/{uuid}.{ext}, with storage RLS mirroring load access. Customers read BOL and POD of own loads, carriers read BOL and upload POD for own loads, staff do everything, only staff upload BOL.
- R14 Status flow runs only through set_load_status: requested, booked (staff, needs carrier), at_pickup, loading, enroute (needs ETA), at_delivery, delivered (needs at least one POD). Carriers move one step forward at a time. Staff can set any status with a note.
- R15 Cancel: the customer only while requested; staff any time before delivered.
- R16 The customer may edit own load only while requested. A trigger blocks non-staff changes to status, carrier_id, eta, load_number, customer_id. From booked through at_delivery the load is read-only with the message "Contact DLV to change this load". Delivered shows "Delivered" with the delivered date; cancelled shows "Cancelled".
- R17 A carrier owner or driver can update ETA only while enroute or at_delivery, through set_load_eta.
- R18 INSERT ... RETURNING for a customer works only for their own customer_id (SR-60).
- R19 Live status: Supabase Realtime on loads with a 15 second polling fallback.

## Screens
- R20 /book: pickup (can_ship) and delivery (can_receive) selects, contacts auto-filled from location defaults and editable per load with "save as default for this location", equipment chips, Moffett toggle (auto on and locked if a selected location requires it), appointment or time window independently for pickup and delivery, optional weight, pieces, PO number, notes. Validation: contacts required, pickup and delivery differ, delivery not before pickup.
- R21 Submitting creates a requested load and emails all staff.
- R22 /loads: list with status filter, live. /loads/[id]: timeline from load_events, carrier name once booked, ETA when set, BOL download, POD view, edit and cancel while requested.
- R23 /locations: list, edit default contact name and phone, request a new location, request an address change (location_requests pending).
- R24 Staff /admin board (columns by status) and calendar (week and month by pickup date).
- R25 Staff load detail: assign carrier, upload BOL, mark booked, override status with note, cancel. "BOL pending" badge on booked loads without BOL.
- R26 Staff: locations manager (CRUD, needs_review), approve or reject location_requests (approve applies the payload), carriers manager, users invite and deactivate (staff_admin only).
- R27 CSV export with date range and status filter.

CSV_COLUMNS: load_number, created_at, pickup_location, delivery_location, equipment_size, moffett, weight_lbs, pieces, po_number, pickup_timing, pickup_date, pickup_time_start, pickup_time_end, delivery_timing, delivery_date, delivery_time_start, delivery_time_end, carrier, status, eta, delivered_at

- R28 Carrier /my-loads: cards for loads of own carrier (booked and later).
- R29 Carrier load detail: addresses, contacts with tap-to-call, timing, ONE big next-step button only. Enroute asks for a required ETA; Delivered requires a POD photo (camera capture, compressed client side to max 1600px JPEG before upload). ETA editable while enroute.
- R30 /team (carrier_owner only): add and remove drivers by email.
- R31 Notifications by email: all staff when a load is requested; carrier users when a load is assigned. No status-change emails to Maria. No SMS, no push.

## Design and rules
- R32 Plus Jakarta Sans 400/500/700. Pill buttons, card radius 16px, input radius 12px, touch targets at least 44px (48px on driver screens). Colors: ink #020814, neon #2BFF88, mint #E8FBF0, amber #F28C28, card #FFFFFF, border #CFE6D9, muted #4E5F57. Customer and staff pages on mint, driver pages on ink. Status chip colors as specified; Delivered green stays distinct from the mint background and the neon accent.
- R33 Header shows the wordmark "DLV", a neon dot and "Mitrex shipping portal".
- R34 No em or en dashes anywhere in the repository. English only.
- R35 No secrets, .env files or credentials are committed.
- R36 Admin can deactivate and reactivate users; a deactivated user is denied at the database and cannot sign in.
- R37 Deliverables: supabase/migrations, supabase/seed.sql, supabase/tests/rls.sql, scripts/seed-users.mjs, scripts/check-no-dashes.mjs, .env.example (names only), public/manifest.webmanifest and icons, README.
