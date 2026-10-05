# Decisions (append only)

## 2026-10-05 build session 1
- Header uses a text wordmark "DLV" + neon dot on an ink bar. The supplied logo is mint on transparent and vanishes on the mint page background (spec allows the text fallback). The logo is used on the login page (on an ink tile).
- Load status can change only through set_load_status (SECURITY DEFINER). A BEFORE UPDATE trigger rejects direct changes to status, eta, booked_at, delivered_at, cancelled_at, load_number, customer_id, created_by for everyone, and to carrier_id for non-staff. Service role (no JWT) bypasses the trigger.
- Staff may assign carrier_id by direct UPDATE (RLS staff policy); booking needs a carrier.
- Carriers can read POD rows of their own loads (needed so INSERT ... RETURNING and the delivery flow work). They cannot upload BOL.
- Carriers can upload POD only while the load is enroute or at_delivery.
- The BEFORE INSERT trigger overwrites status, carrier_id, eta and created_by for non-staff so a forged value is neutralised instead of erroring (tested).
- A staff override that is not the next forward step requires a note. Enroute always requires an ETA (staff included). Delivered always requires a POD (staff included).
- Moffett is forced true by the DB when either location requires it.
- profiles are written only by the service role (invite flows). Authenticated users cannot write profiles.
- The test script never calls a function as anon: that segfaults the local Supabase Postgres. It asserts has_function_privilege instead.
- Magic link uses PKCE: the link must be opened in the same browser that requested it.
