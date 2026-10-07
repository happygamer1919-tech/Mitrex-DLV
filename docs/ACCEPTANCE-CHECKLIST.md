# Owner acceptance checklist (M1 to M7)

Run these on the live portal, https://portal.dlvlogistics.com. Each step says what you do and what you must see. Tick a box only when you saw the expected result. If something differs, write what you saw next to it and tell dispatch/engineering.

## Before you start

- Five people sign in with their own email: DLV admin, DLV CSR, Maria (customer), Kaja Transport owner, FreightPro Systems owner.
- Sign in = open the portal, type your email, tap **Send code**, type the 8 digit code from the email (check spam once).
- Use the PO number `TEST-` plus the date for every test load, so test loads are easy to find and clean up.
- Keep two browsers or devices handy: staff on a laptop, the carrier on a phone.

Test load used below: Pickup **Mitrex**, Delivery **Howden**, 53 ft, pickup window tomorrow 8:00 AM to 11:00 AM, delivery appointment tomorrow 2:00 PM, contacts any name and phone, PO `TEST-<date>-1`.

## M1. Maria books a load and staff get the email
- [ ] Maria: **Book a load**, fill the test load, tap **Request load**. You land on the load page with status **Requested**. The title says **Number pending** with a small grey "Request MTX-0001" next to it.
- [ ] Within about 1 minute the admin AND the CSR each receive an email "New load requested (Request MTX-0001)" with the route, equipment, times marked ET, contacts, the line "ITS load number: not assigned yet. Enter it when you book." and a link to the load. (Check spam. The sender is DLV.)
- [ ] The link opens the load in the staff view after sign-in. The title there reads "Request MTX-0001".
- [ ] Maria receives no email at this point (she is emailed when the load is booked, see M2).

## M2. Carrier isolation
- [ ] Staff: open the load (Admin, Board, the load). Choose carrier **Kaja Transport**, tap **Save carrier**.
- [ ] Staff: **Upload BOL** (any small PDF or photo): drop the file on the dashed box or tap it, then tap **Upload BOL**. The "BOL pending" badge disappears after the upload.
- [ ] Staff: **Mark booked** is greyed out and says what is missing ("Enter the ITS load number"). Type a real new ITS number from ITS (for a test, any unused number such as 9001) in the field **ITS load number (required to book)**, then tap **Mark booked**. Status becomes **Booked** and the title shows the ITS number. Try a letter or a number already used by another load: you get a clear message and nothing changes.
- [ ] Kaja owner receives an email "Load 9001 assigned to you" (the ITS number) with addresses, contacts, times and a link. The link opens the load.
- [ ] Maria and every other active user of Mitrex receive ONE email "Load 9001 booked" with the carrier, addresses, times (ET), contacts, equipment, a link to the load and the BOL attached as BOL-9001.pdf (open it: it is the file you uploaded).
- [ ] Maria's **Loads** list and the load page now show 9001, not "Number pending".
- [ ] Staff: **Edit ITS number** on the load, change it, save. The title and Maria's page show the new number and the timeline says "ITS load number changed from ... to ...".
- [ ] Kaja owner: **My loads** shows the load with the ITS number.
- [ ] FreightPro owner: **My loads** does NOT show it. Pasting the link from Kaja's email while signed in as FreightPro shows nothing (not found).
- [ ] Maria's load page now says "Contact DLV to change this load" and has no Edit button.

## M3. Status buttons on a real phone, with the camera
Kaja owner on a phone (any mobile browser is fine).
- [ ] Open the load: contacts are tap-to-call. Only ONE big button is shown: **Arrived at pickup**. Tap it.
- [ ] Next big buttons in order: **Start loading**, then **Leave for delivery**.
- [ ] **Leave for delivery** opens a window asking for the delivery ETA. Clear the time and confirm: you get an error. Enter a time and confirm: status **Enroute**.
- [ ] **Update ETA** works while enroute.
- [ ] **Arrived at delivery**, then **Mark delivered**. The window says "Add the signed POD photo now if you have it. You can add it later from this load." Tap **Mark delivered** WITHOUT a photo: status **Delivered** (a POD is optional).
- [ ] The load page now shows **Proof of delivery** with an orange **POD not uploaded yet**. Tap the box (or **Choose file**), take a real photo with the phone camera, tap **Add POD photo**: the card shows **View POD** and **Add another**.
- [ ] Staff: before the photo the board card and the load page show a **POD pending** badge; after the photo it is gone. Maria's load says **POD not uploaded yet.** and then shows **View POD**.
- [ ] Optional: on another load, choose a photo, switch on airplane mode and tap **Mark delivered**. You get an error with **Try again** and **Mark delivered without photo**; turn airplane mode off and tap **Try again**: delivered once with the photo.

## M4. Maria sees live status, ETA, BOL and POD
- [ ] Maria: keep **Loads** open on her screen (do not refresh) while staff and the carrier do M2 and M3 on another load or a repeat of the test. The status on her list changes by itself within a few seconds.
- [ ] Maria: open the load. She sees the timeline, the carrier name (Kaja Transport), the ETA (in ET), **Download BOL** (opens the file you uploaded) and **View POD** (shows the photo).

## M5. SAMIH locks Moffett
- [ ] Maria: **Book a load**, choose **SAMIH** as delivery. "Moffett (forklift on truck) needed" is switched on AND cannot be changed, with a short reason underneath. (You do not need to submit.)

## M6. CSV export opens in a spreadsheet
- [ ] Staff: **Export**. Pick dates covering today and tomorrow, all statuses, download.
- [ ] Open the file in Excel, Numbers or Google Sheets: columns are readable (22 columns starting load_number, request_ref, created_at and ending eta, delivered_at; load_number holds the ITS number, request_ref the MTX reference), your TEST load row is there, times are Eastern, and nothing shows a formula error.

## M7. Code login from the installed iPhone app
- [ ] iPhone, Safari: open the portal, tap Share, **Add to Home Screen**, **Add**.
- [ ] Open the app from the new home-screen icon (not from Safari).
- [ ] Type your email, **Send code**. Switch to Mail, read the code, come back to the app (it must still be on the code screen). Type the 8 digits.
- [ ] You land on your home page inside the app, and you were never thrown into Safari.
- [ ] Close the app completely and open it again: still signed in.

## M8. Request again
- [ ] Maria: **Loads**, tap **Completed**. Delivered loads are listed newest first, each with its delivered date and a **Request again** button. A cancelled or open load has no such button.
- [ ] Tap **Request again** on one. The booking form opens with the same locations, contacts, truck size, weight, pieces, PO and notes, and a note "Copied from 9001. Choose the new dates and times." (the ITS number of the source load) Every date and time is empty.
- [ ] Choose new dates and times, change one contact name, tap **Request load**. The new load shows the same details and the changed contact (use a TEST- PO number, and cancel it afterwards).
- [ ] On **Book a load**, choose a pickup location you used before. Under the contact a line shows "Last contact at ...". Tap **Use last contact** and the line changes to "Same as last time".

## M9. Delete a load forever (admin only)
- [ ] Maria: book a TEST load (PO "TEST-DELETE"). Staff: assign a carrier, enter an ITS number, mark booked, upload a BOL. This is the throwaway load. Never use a real load for this check.
- [ ] Sign in as chris@dlvlogistics.com, open that load, scroll down: a **Danger zone** card with **Delete this load forever**.
- [ ] Sign in as the CSR (Luca) and open the same load: there is no Danger zone card anywhere on the page.
- [ ] As admin tap the button: the window warns "This permanently deletes the load, its timeline, and its BOL and POD files. This cannot be undone." and shows the load number, route, status and "1 file". **Delete forever** is grey. Type a wrong number: still grey. **Cancel** closes it and the load is unchanged.
- [ ] Open it again, type the ITS number exactly, tap **Delete forever**. You land on the board with "Load <number> deleted forever" and the load is no longer on the board or the calendar.
- [ ] Maria's **Loads** list no longer shows it, and opening its old link shows "not found".
- [ ] On the iPhone (portrait) the window fits the screen, nothing scrolls sideways, and the buttons are easy to tap.

## M10. ITS load to copy (lane references, staff only)
- [ ] Staff: open **Lanes**. About 25 rows are listed, grouped by pickup. Mitrex to 481 University Ave shows 1269 at 26 ft and 1264 at 53 ft. Mitrex to 1HAM shows "Moffett", Mitrex to 481 University Ave shows "No Moffett".
- [ ] Maria: book a TEST load (PO "TEST-LANE") from Mitrex to 481 University Ave, 26 ft. Staff: the email "New load requested" has the line "ITS load to copy: 1269 (Mitrex to 481 University Ave, 26 ft)". Maria's confirmation page and any email to Maria do not show 1269 anywhere.
- [ ] Staff: open that load. The **ITS load to copy** box is above **Carrier and booking**, with 1269 in large type. Tap **Copy**: it says "Copied 1269", and pasting somewhere gives 1269. On the **Board**, the Requested card shows "Copy ITS 1269".
- [ ] Maria: book another TEST load, same route, 53 ft. Staff see 1264 (a different number for a different size).
- [ ] Maria: book a TEST load Mitrex to 125G, 53 ft (no row). Staff: the email says "No ITS reference for this lane and size yet. Add it: <link>"; the load box is amber with **Add it**. Tap **Add it**: Lanes opens with Mitrex, 125G and 53 ft filled in. Type 9999 and tap **Add lane**. Back on the load, the box now says 9999. Then **Delete** that lane row again (it is a test value).
- [ ] Luca (CSR): can open Lanes, add, edit, delete, export and import exactly like the admin.
- [ ] Maria and a carrier user: the address /admin/lanes does not open for them (they land on their own home page). The carrier's load page and Maria's load page show no ITS load to copy.
- [ ] **Export CSV** on Lanes downloads a file that opens in Excel with the columns shipper, receiver, truck_size, load_to_copy, note.
- [ ] **Import CSV**: paste a row with a wrong location name and a row with size 48. The table marks both rows and **Apply import** stays grey. Fix them (use a TEST row) and apply; it says how many were added or updated. Delete the test rows.
- [ ] Maria, **Book a load**: choose 1HAM as delivery. The Moffett box turns on and cannot be changed (like SAMIH). Choose 481 University Ave: it is free again.
- [ ] iPhone: the Lanes page and the load box fit the screen, nothing scrolls sideways, buttons are easy to tap.

## After testing
- [ ] Tell engineering the results (M1 to M10: pass or what you saw). Test loads stay in the system with the `TEST-` PO number. Staff can cancel any not-delivered one; ask engineering if you want them removed from the database (that needs your explicit approval).
