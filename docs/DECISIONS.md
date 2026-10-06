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

## 2026-10-05 T2 OTP login
- Owner overrule of QUESTIONS item 5: login is by 6 digit emailed code (signInWithOtp then verifyOtp type email), because an emailed link opens in Safari and the installed iPhone PWA loses the session.
- Invite-only is unchanged: shouldCreateUser is false. The UI answer after sending is generic ("If <email> has access, a code is on its way") for every outcome except throttling and network failure, so emails cannot be enumerated. Wrong and expired codes share one message.
- The code field auto-submits on the 6th digit. Resend is disabled for 30 seconds with a visible countdown. After success the page hard navigates to / so the server sees the cookie and routes by role.
- The emailed link stays as a fallback (/auth/callback unchanged). The Magic Link template must contain both {{ .ConfirmationURL }} and {{ .Token }} (README owner step).
- Local config: [auth.email] enable_signup must be true or GoTrue disables the email provider entirely (otp 422 email_provider_disabled). New user creation stays blocked by [auth] enable_signup = false and shouldCreateUser false. OTP length 6, expiry 900 s. Mail catcher on 54324.


## 2026-10-05 T3 admin users: deactivation
- profiles.is_active (boolean not null default true, migration 0005). Deactivation is two layers: the flag and an auth ban (updateUserById ban_duration 876000h, "none" to reactivate). Verified locally: a banned user's OTP verify returns "User is banned"; unbanning restores sign in.
- dlv_role, dlv_is_staff, dlv_is_admin, dlv_customer_id and dlv_carrier_id all filter on is_active. An inactive user has a NULL role, so every policy, set_load_status, set_load_eta, the approve/reject functions and the storage helper dlv_can_access_doc (it returns false on a NULL role) deny them with no per-policy edits.
- profiles_select read the table directly for the "self" branch, so it now requires is_active too. An inactive user whose JWT is still valid (up to the token lifetime) therefore gets no profile, and the app sends them to /login.
- The profiles scope CHECK is unchanged: is_active is orthogonal to role, customer_id and carrier_id. Authenticated still has no INSERT, UPDATE or DELETE on profiles (service role only); the new column adds no grant. Tested: authenticated cannot update is_active.
- Server actions (deactivateUser, reactivateUser, inviteUser, removeUser) call requireAdmin first. Deactivate refuses self and the last active staff_admin; remove also refuses the last active staff_admin. If the ban call fails after the flag was set, the flag is rolled back.
- inviteUser validates scope against the database (customer exists, carrier exists and is active), lowercases the email, and returns one generic message for a duplicate email. Auth user is created with email_confirm true; it is deleted if the profile insert fails.
- Follow-up for other owners: src/app/team/actions.ts (owner adds drivers) and notify.ts files read profiles through the service role and do not yet filter is_active, so an inactive user could still be emailed or listed there.

## 2026-10-05 OTP length
- Hosted Supabase sends 8 digit codes (project default); the first build assumed 6 and rejected real codes. The form now auto-submits at 8 digits, has a Sign in button that accepts 6 to 8 digits, and no longer states a digit count in the copy. Local config otp_length is 8 to match production, and the e2e mail reader accepts 6 to 8 digits. Supersedes the "6 digit" wording in the OTP LOGIN entry above.

## 2026-10-05 C3 failure UX
- Status writes are guarded twice. Client: a ref lock plus the busy state disable every mutation button on the first tap. Server: advanceLoad takes expectedFrom (the status the client acted on) and, if the load has moved on, writes nothing and answers "already updated" (code stale); the client refreshes. set_load_status stays the only status writer and still enforces one step forward, which settles a race between the read and the write.
- Watchdog: every browser side mutation (status, ETA, POD, booking submit, cancel) is wrapped in withTimeout (default 25000 ms, NEXT_PUBLIC_ACTION_TIMEOUT_MS overrides, 4000 for the e2e server). On timeout the busy state clears and the message says it is taking too long. The request cannot be cancelled, so a late result is ignored and a timed out POD attempt stops before the next step.
- POD upload keeps one storage path per chosen photo and reuses it on retry ("already exists" counts as uploaded). Carriers cannot delete storage objects, so a fresh path per attempt would orphan files. The saved POD is reused (podDone) so a retry never adds a second POD row.
- Session expiry: the proxy redirects a page visit to /login?next=<path and query>. A server action call without a session gets 401 text/plain "SESSION_EXPIRED" (a redirect would break the action response); the client then goes to /login?next=<current page>. safeNext accepts only a single slash path (no //, backslash, control characters, /login or /auth/*, also checked after decoding). The login form and /auth/callback both apply it.
- Known gap: createLoad has no idempotency key. If a booking request lands after the watchdog fired and the user submits again, two requested loads can exist. Closing it needs a client request id column (migration), left for an owner decision.

## 2026-10-05 C4b documents bucket security (migration 0007)
- Finding: before 0007, dlv_can_access_doc only split the name on '/', and the load_documents CHECK was "storage_path like load_id/kind/%". Names with '..' segments, empty segments, '%2e%2e', trailing space or newline, extra segments and non-uuid file names were accepted by both (measured: 16 of 22 malformed shapes accepted by the function for staff, and the same names inserted into load_documents). No real file was reachable through them, but a name is what the RLS and the app trust.
- Fix: a document path must match exactly {load uuid}/(bol|pod)/{file uuid}.{2 to 5 char lower case alphanumeric extension}, lower case, anchored at both ends. dlv_can_access_doc checks the shape first, before any role or load lookup. The load_documents CHECK uses the same regex and also requires the folder and kind to equal the row's load_id and kind. Both apps already build paths this way (BOL: random uuid plus the lower-cased extension from pdf, png, jpg, jpeg, webp, heic; POD: random uuid plus .jpg), so real uploads stay valid.
- Bucket: private (unchanged), file_size_limit 15 MB, allowed_mime_types pdf, png, jpeg, webp, heic, plus image/heif (some browsers label .heic that way). Matches the UI limits; the server now enforces them too.
- Anon: no storage.objects policy for anon or public touches the bucket (both documents policies are to authenticated); anon has no EXECUTE on dlv_can_access_doc (asserted by grant, never called as anon).
- Tests: supabase/tests/rls.sql section 10 (read isolation across carriers and customers, upload rights by role and load status, 24 malformed path shapes on both tables for a staff user and a carrier, bucket settings). The older fixtures that used the file name x.jpg or x.pdf now use uuid names, since those names are no longer valid.
- Apply: 0007 must go in docs/APPLY-PACK.md. It is idempotent (create or replace, drop constraint if exists, update by bucket id) and needs the load_documents table to hold only conforming rows (production is empty).

## 2026-10-05 C5b accessibility (e2e/a11y.spec.ts)
- Gate: axe (wcag2a, wcag2aa, wcag21a, wcag21aa, best-practice) at 375x812 on every page and state; only serious and critical fail. Contrast and focus are asserted by computed style and relative luminance, not assumed.
- No R32 brand token changed. Measured ratios (WCAG 2.x): neon on ink 15.05, ink on neon 15.05, white on ink 20.05, muted #4E5F57 on mint 6.29 and on white 6.78, #2B1500 on amber 7.07; chips Requested 15.93, Booked 20.05, At pickup and Loading 7.84, Enroute 7.07, At delivery 8.87, Delivered white on #12875A 4.53 (passes narrowly, do not darken the text or lighten the green), Cancelled 7.77. Delivered #12875A against mint 4.20, against neon 3.40, against card 4.53 (all at least 3:1).
- Focus ring changed (a rule, not a palette token): the amber outline measured 2.45:1 on white cards and 2.2:1 on mint, below 3:1. The ring is now a 3px ink outline with a 2px white inner ring (box-shadow). Measured 18.6 to 20.1 on mint, white, card and ink surfaces including driver modals (white sheet on an ink page), so one rule serves every surface.
- Touch targets: text inputs inside .driver-surface (Shell driver) are at least 48px, via an unlayered rule that beats the 44px field utility. Found on /team (44px) and the driver Update ETA modal.
- Heading order: the locations list used h3 directly under the h1; now h2.
- Selects: WebKit clamps the min-height of a native select (measured 26px against the 44px rule), so selects use appearance none with an ink chevron and the 44px rule now holds on every engine. Date and time inputs also get the focus ring through :focus-within (WebKit focuses an inner field).

## 2026-10-05 C6 data integrity (migrations 0008 to 0010)
- Last active staff_admin (0008): BEFORE UPDATE OF role, is_active and BEFORE DELETE triggers on profiles refuse to leave zero active staff_admin, for every writer (no auth.uid() test, so the service role and the auth.users cascade are bound). Race safe with a transaction advisory lock taken before the count of the other active admins. Error 23514, message "cannot leave the portal without an active staff admin". Proven with two real sessions by scripts/test-last-admin-race.mjs (local only) and in rls.sql section 11a. The app keeps its own pre-check and maps the trigger error to the same plain message.
- Indexes: no change. The five hot columns already lead an index (loads status, pickup_date, carrier_id, customer_id; load_events load_id); rls.sql 11b asserts it so a future drop fails the suite.
- updated_at (0009): added to locations, carriers, customers, profiles, location_requests with the existing dlv_touch_updated_at(). The customer edit guard on locations now ignores updated_at.
- One event per status change (0010): an AFTER UPDATE OF status trigger on loads writes the load_events row (actor = auth.uid() if it is a profile else NULL; note from the transaction local GUC dlv.event_note that set_load_status sets and clears). set_load_status keeps every rule and no longer inserts. Consequence for fixtures: a direct status UPDATE now writes an event, so rls.sql mkload fixtures that start at booked have one more event (the timeline control for L2 moved from 7 to 8) and the new tests assert the exact walk (7 events, consistent chain).
- rls.sql needs a second staff_admin fixture (a3) because section 9 deactivates the only admin.
- Apply: docs/APPLY-PACK.md (0006 to 0010, migrations first, then the app).

## 2026-10-06 production apply and repository settings
- Migrations 0006 to 0010 applied to production under the owner's explicit authorization (migrations first, then deploy). Result in docs/APPLY-PACK.md.
- The GitHub default branch was still the first feature branch, so scheduled workflows (keepalive, backup) could never have run. Default branch is now main. Keepalive and backup were run manually once and succeeded; the backup artifact (private, 14 day retention) exists.
- Production was redeployed after the owner rotated the Resend key and the database URL, so new environment values apply.
- Owner accepted all defaults listed in docs/QUESTIONS.md for the hardening run (duplicate booking protection deferred, per-customer location contacts before a second customer, no full CSP in v1, magic-link fallback keeps role home, TRUNCATE gap accepted).

