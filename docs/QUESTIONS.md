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

## DLV-030 Rate requests (defaults used, owner may change)
1. Should a quoted rate expire by itself (status "expired" after valid until)? Default used: NO. The date is shown, the status stays Rate ready.
2. Should staff be able to cancel a request (a duplicate or a mistake)? Default used: NO, only the customer cancels. Staff can simply leave it open or quote it.
3. Should a correction of an already entered rate email the customer? Default used: YES, one short message "Your rate was updated in the app", with no amount.
4. Should csr staff get the new-request email too? Default used: NO, only active staff_admin, as specified. Adding csr is one query change in notifyAdminsOfRateRequest.
5. Mexican lanes: the state field accepts US states, DC and Canadian provinces only. Default used: Mexico is refused ("must be a two letter US state or Canadian province code"). Tell us if Mitrex ships to Mexico.
6. Should "Book this lane" prefill /book? Default used: no, a plain link. The booking form needs saved locations; the request holds free text cities.
7. Should a won rate be remembered as a lane (a lane reference or a saved route) so the next request for the same lane is answered automatically? Default used: NO, rates stay separate from lanes and loads.
8. Limit 30 requests per 10 minutes per user: same default as loads. Change it in src/lib/rates/validate.ts.

## DLV-032 Load photos (defaults used, owner may change)
1. Should "Unloading" be its own status between At delivery and Delivered? Default used: NO, no status was added. At delivery already means the truck is at the receiver, and "Mark delivered" is the step after unloading. The photo gate sits on that step. Adding a status touches the enum, the board, the calendar, the emails, the customer timeline and every guide; say so if the owner really wants it.
2. (Relaxed by the owner on 2026-10-07: the photo steps now also offer "Choose a photo from your phone"; the in-app camera stays primary and the time stays the server time.) Can the "no gallery" rule be fully enforced? Default used: it is enforced when the in-app camera opens (there is no file picker in that path). It cannot be enforced in the fallback: on some Android phones an input with capture=environment still offers the gallery, and a browser that refuses getUserMedia leaves only that fallback. The server also cannot tell a fresh picture from an old one. The photo time shown to everyone is the server time of the upload, so an old gallery picture would show today's time. Check on the real phones (M12).
3. Should the POD file choice stay? Default used: YES, keep a small "Choose a file instead" link under the in-app POD camera, for a PDF POD the receiver hands over. Recommend keeping it. Removing it is one component change (PodPicker).
4. Staff exemption. Default used: staff_admin and staff_csr can move a load past a missing photo and the skip is written in the timeline. Say so if staff should also be blocked.
5. How many photos? Default used: at least 1 to unlock, at most 6 per kind per load.
6. Should the customer be emailed when photos arrive? Default used: NO. Maria sees them on the load page after the status change (the page refreshes by itself). No email was added.
7. Should Maria see the photos while the load is still loading? Default used: NO (pickup photos once enroute, delivery photos once delivered, as requested: "after proper status changing").
8. Old loads and the day of the apply. Loads that sit in loading or at delivery when the migration is applied need a photo before the carrier can advance them. Block A of the apply pack prints the number. Staff can override a stuck load; the carrier on the old app (before the deploy) is refused at those two steps with a plain message.
9. A broken camera. If a driver's camera does not work at all, the fallback opens the phone camera app; if that fails too, dispatch uses the staff upload on behalf of the carrier or the status override (recorded in the timeline).
10. Photo retention. Photos are kept for the life of the load and deleted with it (Delete forever). There is no automatic cleanup.
11. Real devices. The camera, the permission prompt and the installed PWA were tested only with Chromium's fake video device (WebKit has no fake camera). The manual gate M12 asks for a real iPhone and a real Android phone before the drivers rely on it.

## DLV-038 Return loads (defaults used, owner may change)
1. When is Return offered? Default used: only when the load is At delivery or Delivered (the truck is at the site or has unloaded). Staff may still make a return of any load later (DLV-039).
2. How many trucks per return? Default used: ONE. The form has no trucks stepper and the server refuses any other number. Book a second return for a second truck.
3. What is copied? Default used: truck size, Moffett, weight, pieces, PO number and notes (without the "Truck i of N" line). Dates and times are always empty. Say so if the weight or the PO should start empty for a return of empty frames.
4. A return picks up at a site that is not a shipper (can_ship off). Default used: allowed for returns only, as long as the site is active. Ordinary loads still need a shipper.
5. Email subject for staff. Default used: "New return load requested (Request MTX-0007)" with the line "Return of <number>, original carrier: <name or Not assigned>".
6. Should the CSV export get a return_of column? Default used: NO, the CSV columns are unchanged in this card. Adding one is a small change in the export.
7. Several returns for one load. Default used: allowed. A second Return shows "A return was already requested for this load: <number>." but does not block.
8. Should Maria see the original carrier's name on the return form? Default used: no, only staff see it (email and the staff load page).

## DLV-039 Staff edit (defaults used, owner may change)
1. Should a cancelled load be editable? Default used: NO. Every other status can be edited (requested through delivered). A cancelled load shows no Edit details button and the server refuses it. If a cancelled load needs a fix, move it back with the status override first.
2. Past dates. Default used: ALLOWED for staff (a load that is moving or delivered has dates in the past), still refused for Maria. Delivery before pickup and a window that ends before it starts are refused for everyone.
3. "Email the updated details to the carrier". Default used: the box starts UNCHECKED, so a quiet correction sends nothing. Tick it when the carrier must know. Say so if it should start ticked.
4. Should Maria be emailed when staff change a booked load? Default used: NO. She sees the new values on her load page straight away and the "Details edited" line in her timeline. Adding an email to Maria is one call in the save.
5. Should the carrier email go to the carrier for a Requested load? Default used: NO. Carriers do not see Requested loads, so the box is offered only once the load is past Requested and has a carrier.
6. Who may edit? Default used: staff_admin and staff_csr alike (identical operational rights, R4).
7. Changing ONE place when the OTHER one was switched off since (inactive, or no longer ships or receives). Default used: refused with a plain message naming the place, because the database checks both places whenever one changes. Keeping both places as they are always works. Say so if staff should be able to keep a switched off place while changing the other one (a database change).
8. Should the carrier email include weight and pieces? Default used: YES, with the other details (equipment, Moffett, PO, notes). Say so if they should be left out.
9. A return created by staff (Create return) accepts dates in the past, like the staff edit form (the brief allows past dates for the staff form). Default used: YES. Maria's own Return still refuses past dates. Say so if a staff created return should only take today or later.

## DLV-041 Customer locations (defaults used, owner may change)
1. Should staff get an email when Maria adds or changes a location? Default used: NO email. Staff see "Added by" and "Last edited by" on the Locations page. Adding an email is one call in the two save actions.
2. Locations are shared by all customers. Default used: they stay global (Mitrex is the only customer, so Maria sees and edits every active location). If a second customer is added, give locations an owner customer first, so one customer cannot see or change another customer's places.
3. A changed address shows everywhere the location is used, including loads already booked or on the road (the pages read the location live; emails already sent do not change). Default used: allowed, no warning and no email. Tell Maria to call DLV when a load already on its way must go to a new address. Say so if edits should be blocked while a load at that place is moving.
4. Maria can switch off "Needs a Moffett" on any location, also on SAMIH and the seven lane sites where you made it required (DLV-028). Default used: allowed, as the card says she is in charge of her locations. The booking form follows her setting at once.
5. A location Maria adds without a postal code is NOT flagged "Needs review" (staff-made locations without one still are). Default used: as the card says (her locations never need review). Staff can still tick Needs review.
6. Province: Default used: a two letter code is required (ON, QC, or a US state such as NY), stored upper case, the same as the staff form.
7. Names that differ only in capital letters ("MITREX" and "Mitrex") count as different names, exactly as the database rule does. Default used: allowed. Say so if they should be refused.
8. Locations that existed before migration 0021 have no known author. Default used: no "Added by" line for them (their created_at is the apply time, which is not their real age, so it is not shown).
9. Old requests: the database still lets a customer file a location request (the app no longer offers it, and "nothing else in Maria's rights changes" in this card). Default used: kept. Removing that right is one policy change.
10. "Last edited by" shows the last person who saved the location in the app (staff or Maria) with the last change time. A change made by owner tooling (no signed-in user) moves the time but not the name.
11. (Review) An address change request Maria sent BEFORE this change and that is still pending can be approved after she has already edited that location herself; approving then writes the older values from the request over her newer ones. Default used: nothing automatic; the STAFF-GUIDE and the RUNBOOK tell staff to open the location first and reject the request if Maria already made the change. Say so if pending requests should be closed automatically (a data change on production, so it needs your go).

## DLV-040 Compact views and Maria's list tools (defaults used, owner may change)
1. How far back the finished lists reach before "Show older". Default used: 30 days everywhere. Staff board Delivered and Cancelled by PICKUP date, Maria's Delivered by DELIVERY date (the card says so), the carrier list by pickup date.
2. Page sizes. Default used: an open board band shows 12 cards before "Show all"; staff "Show older" adds 50; the One list shows 50 rows per "Show more"; Maria's and the carrier's "Show older" add 25.
3. Which sections start collapsed. Default used: board Delivered and Cancelled; Maria's Delivered and Cancelled; the carrier's Delivered and cancelled; Lanes groups (unless a search or filter is on); Rate requests Quoted and Cancelled; Location requests Recently reviewed; Users deactivated users; on a load page the older timeline events, the staff upload areas and More actions (Override status and Cancel load). Everything else starts open.
4. Maria's calendar view: not added (the card's "nearly all the features he has" was read as the list tools; the staff calendar stays staff only). Say so if she should get one.
5. Cancelled loads on the staff board: the card names only Delivered for the 30 day window. Default used: Cancelled follows the same rule (pickups of the last 30 days, Show older 50 at a time), so a year of cancelled loads never lands on the board at once. Maria's Cancelled group shows the newest 25 (by date requested) with Show older 25 at a time.
6. A search or filter: Default used: it reaches every delivered and cancelled load, not only the last 30 days (the filters and the search words are sent to the database, newest 500 matches per group). Without a filter the 30 day window applies. Say so if a search should stay inside the window.
7. Sort order of the finished groups: Default used: while the sort is the default (pickup time, ascending) the Delivered and Cancelled bands on the board list the most recent pickup first, Maria's Delivered the newest delivery first and her Cancelled the newest request first. Any sort she or staff choose applies to every group.
8. Maria's Active group is now in pickup time order (soonest first, the card's default sort). Before this card her list was newest request first. Say so if Active should stay newest request first.
9. Board card details: Default used: Details shows both contacts with tap to call, size with Moffett yes or no, PO, notes and ETA. The weight and pieces stay on the load page.
10. Maria's CSV has the same columns as the staff CSV (R27), including the carrier name and the request ref, and never an ITS load to copy number. Default used: as the card says.
