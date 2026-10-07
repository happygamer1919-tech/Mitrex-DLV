# Open questions for the owner (append only)

1. Should Maria be emailed when a load is delivered (POD available)? Proposed default: no, v1 spec says she checks live.
2. Staff notification recipients: all staff_admin and staff_csr profiles. Proposed default: keep. Add a per-user mute later if noisy.
3. A requested load that is never booked: auto-cancel after N days? Proposed default: no auto-cancel in v1.
4. Customer-visible carrier contact (phone)? Proposed default: name only.
5. Magic links must be opened in the same browser that requested them (PKCE). Drivers who request on one phone and open on another will fail. Proposed default: keep PKCE; revisit with an OTP code entry if it bites.

## BLOCKED 2026-10-05: production apply and seed-users cannot run (env values wrong)
Measured from ~/.zshenvmitrex (and the same URL shape in Vercel, Production):
- NEXT_PUBLIC_SUPABASE_URL ends in /rest/v1/. supabase-js needs the bare project URL (https://<ref>.supabase.co). Auth, Storage and Realtime break otherwise.
- SUPABASE_SERVICE_ROLE_KEY is a URL (starts with https:/), not a key (should start eyJ or sb_secret_).
- DATABASE_URL_DIRECT is one token with no ":" "@" or "://": not a postgresql:// connection string (Supabase direct connection or session pooler URI, with the DB password).
Proposed default: owner fixes the three values in ~/.zshenvmitrex AND in Vercel (Production), then runs the apply commands in README. Nothing was written to production.

5 ANSWERED 2026-10-05 (owner overrule): build OTP code entry so login works from the installed iPhone PWA. The link remains as a fallback. See DECISIONS "T2 OTP login".


## 2026-10-05 C4 security headers: no full Content-Security-Policy
next.config.ts sends X-Content-Type-Options, Referrer-Policy, X-Frame-Options DENY, Permissions-Policy (camera=(self), microphone=(), geolocation=()), HSTS, and a CSP containing ONLY frame-ancestors 'none'. A full CSP is not set because Next inline scripts would break without a nonce setup. Open question: adopt a nonce-based CSP via proxy.ts? Proposed default: no for v1; revisit after launch.

## 2026-10-05 C4 npm audit --omit=dev
Result: 0 vulnerabilities (0 high, 0 critical). No upgrades needed. Re-run before each release.

## C3: booking has no duplicate protection (2026-10-06)
If a booking request is slow, the 25 second watchdog frees the button, and the request then lands, a second tap creates a second requested load. Closing it needs a request id column on loads (migration) so a repeated request is ignored. Proposed default: leave as is for v1 (one customer, staff see duplicates on the board and can cancel one); add the request id before a second customer is onboarded.

## C3: magic-link fallback does not carry the return path (2026-10-06)
The emailed link fallback lands on the role home, not the original page; only the code login returns to the original path. Proposed default: leave (the code is the primary login).

## C9 M1 real Resend delivery (2026-10-05)
The notification emails (R21, R31) are proved end to end against a local mock of the Resend API (e2e/emails.spec.ts: recipients, subject, body, links, no mail to Maria, a failing service does not fail the booking). A real message from the real Resend account to a real inbox is not proved by any automated test and needs the production RESEND_API_KEY and a verified sending domain.
Proposed default: manual gate M1 after the production apply. The owner books one test load as Maria on production and confirms that every staff address receives "New load requested MTX-nnnn", then assigns a carrier and confirms the carrier users receive "Load MTX-nnnn assigned to you". Until then R21 and R31 are covered by the mock only.

## C9 M2 Realtime on production infrastructure (2026-10-05)
R19 is proved locally (e2e/realtime.spec.ts: Realtime frames carry the change within 5 s without a reload, and the 15 second poll is covered by e2e/admin-board.spec.ts). Realtime on the hosted Supabase project (publication from migration 0004, websocket reachable from portal.dlvlogistics.com, the user JWT accepted) cannot be tested from the local stack.
Proposed default: manual gate M2 after the production apply. Open /loads as Maria and /admin as staff on production, mark a load booked from a second browser and see the first page change within 5 seconds without a reload. If it does not, the 15 second poll still updates it.

## Owner answers 2026-10-06
- All proposed defaults accepted (duplicate booking protection, per-customer location contacts, CSP, magic-link return path, TRUNCATE gap, Realtime and Resend as manual gates M1 and M2).
- Migrations 0006 to 0010: applied (see docs/APPLY-PACK.md, Production result).
- Open for the owner: the phone and email placeholder lines in the guides and runbook (see docs/ACCEPTANCE-CHECKLIST.md for the checks).

## DLV-020 multi-truck booking (defaults, owner may change)
- Maximum trucks per booking: 10 (default). Raising it is a one line change (MAX_TRUCKS in src/lib/customer/bulk.ts).
- Runaway cap: at most 30 loads created per customer user in any 10 minutes (default), friendly error beyond it.
- Known deferred item: no idempotency key. The client lock stops a double click and the quantity control is disabled while sending, but if the response is lost after the server created the loads and Maria resubmits, she gets another N loads (she can cancel them while requested). Fixing it needs a migration (a unique request token on loads). Deferred with the earlier duplicate booking item.
- A failed multi-truck insert consumes load numbers from the sequence (gaps such as MTX-0007 missing are possible and harmless).


## DLV-022 Request again: delivered only, PO and notes copied (2026-10-06)
Defaults used, owner may change: (1) Request again only for delivered loads, not cancelled ones. (2) PO number and notes are copied (editable), because Maria often repeats a PO; the "Truck i of N" line is dropped. (3) Last contact comes from the 200 most recent loads; an older load at a location is not seen and the saved default contact is used. (4) The hint offers the last contact with a button instead of filling it automatically when a location is chosen.
Open question: should the PO number be left empty on a repeat (a new shipment usually has a new PO)? Proposed default: copied, editable.


## DLV-025 ITS load number (defaults used, owner may change)
1. Is a BOL required before a load can be booked? Default used: NO. Staff can book without a BOL; the "BOL pending" badge stays and the booking email tells Maria "The BOL will follow once uploaded". The BOL is emailed on its own when uploaded later. Making it mandatory is one extra condition in BookLoadForm (src/components/admin/LoadControls.tsx) and in bookLoad (src/lib/admin/load-actions.ts).
2. Legacy loads that were booked before this change have no ITS number. Default: they keep working, Maria sees "Number pending" with the request ref, carriers see the request ref, and staff can add the number with "Edit ITS number". Should staff back-fill them? (needs the ITS numbers, only the owner has them)
3. Should the booking email also go to Maria when staff correct the ITS number afterwards? Default: no (the correction is logged in the timeline only).


## DLV-027 Admin delete of loads (defaults used, owner may change)
1. Should a record of the delete stay? Default used: YES, a minimal audit row (request ref, ITS number, last status, who, when). It holds no load details. If you want no trace, it is one change: stop writing the row in delete_load_forever (and drop load_deletions); the files step then has nowhere to log a failure, so it would only show the message.
2. Should the CSR (Luca) ever delete? Default used: NO, admin only, as asked. Giving the CSR the button is a role check change in the function and the page.
3. Can a delivered load with a POD be deleted? Default used: yes, any status, because the owner asked for "delete forever" and typing the number is the safeguard. A rule such as "only cancelled loads" would be one condition in the function.
4. Should deleting a load email anyone (the carrier, Maria)? Default used: no email.



## DLV-028 Lane references (defaults used, owner may change)
1. Is the lane key pickup + delivery + truck size, with direction? Default used: YES (Mitrex to 481 and 481 to Mitrex are separate rows, as in the owner's table). Merging the two directions would be a different key.
2. 36 ft has no rows yet (the owner said it exists for upcoming projects). Default used: allowed in the table and the forms, no rows, so a 36 ft request says "No ITS reference for this lane and size".
3. Snapshot or live? Default used: LIVE. The number is read from the load's current route and size every time, nothing is copied onto the load. A lane edit therefore changes what existing Requested loads show.
4. Who may edit lanes? Default used: both staff roles (admin and CSR), as for all operational work. Limiting edits to the admin is a one line change in the four policies of 0015 (dlv_is_staff() to dlv_is_admin()) and in requireStaff on the lanes actions.
5. The five lanes the owner left out on purpose (125G, D Express and MTD to Etobicoke, 481 to Brampton, Mitrex to Winnipeg) are not in the data. Staff add them from the "Add it" link the first time they are needed, or by CSV once the old ITS numbers are known.
6. Should the staff email include the lane note? Default used: no (number and scenario only). The note shows on the Lanes page.
7. Maria will see the Moffett toggle locked on for 1HAM, 152 Sh, 831 Queen, Glengarry, Kitney site, Military Trailsite and PrimeFab from the day 0016 is applied (it already does for SAMIH). Please tell her. If a site should stay optional, untick Requires Moffett on the Locations page (the lane keeps its Y or N derived from the location).
