# Owner acceptance checklist (M1 to M15)

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

## M11. Rate requests (a rate for a new lane, not a load)
- [ ] Maria: the top menu has **Rates** (Loads, Book a load, Rates, Locations). Carriers have no Rates item and staff have **Rate requests** instead.
- [ ] Maria: **Rates**, ask for a TEST rate: pickup Toronto ON, delivery Buffalo NY, 53 ft, notes "TEST-RATE". The page says "Rate request RQ-000n sent" and the request shows **Waiting for rate**. No load appears in **Loads**.
- [ ] Try a wrong state (ZZ), an empty city and a huge weight (1000000): each shows a clear message under the field, keeps what you typed and creates nothing.
- [ ] Admin (chris@): an email "Rate request RQ-000n: Toronto, ON to Buffalo, NY, 53 ft" arrived with the lane, notes, the customer name and a working link. Luca (CSR) did not get it. Maria did not get it.
- [ ] Admin or Luca: **Rate requests** lists it under **Open**; the board shows "Open rate requests" with the count. Open it, enter 1850.50, CAD, a note and a valid until date, tap **Save rate**: "Rate saved. The customer was emailed ...".
- [ ] Maria: the email "Your rate is ready in the app (RQ-000n)" arrived and does NOT show the price. **Rates** now shows **Rate ready**, 1,850.50 CAD, the note and the valid until date, and a **Book this lane** button that opens the booking page.
- [ ] Admin: open the request again, change the amount and tap **Correct the rate**. Maria gets "Your rate was updated in the app" and sees the new amount.
- [ ] Maria: ask for a second TEST rate and tap **Cancel request** before staff answer: it shows **Cancelled** and staff see it under **Cancelled** with no rate form. A request with **Rate ready** has no cancel button.
- [ ] A carrier user cannot open /rates or /admin/rates (lands on My loads). Maria cannot open /admin/rates (lands on Loads).
- [ ] iPhone: the Rates page and the staff pages fit the screen, nothing scrolls sideways, the truck size buttons and all other buttons are easy to tap.
- [ ] Real Resend delivery of both emails (M1 covers the account): the staff email reaches the admin inbox and the customer email reaches Maria's.

## M12. Load photos with the real camera (a real iPhone AND a real Android phone)
Automation cannot verify a real camera, the permission prompt or the installed app, so this is a manual test. Use a TEST load, assigned to a TEST driver login, with the app installed on the phone's home screen. Do it once on an iPhone (Safari install) and once on an Android phone (Chrome install).
- [ ] Driver: tap **Arrived at pickup**, then **Start loading**. A white **Loaded photo** box shows **Take loaded photo**. **Leave for delivery** is grey and does nothing.
- [ ] Tap **Take loaded photo**. The phone asks to allow the camera (first time only): tap Allow. The live camera appears inside the app, the rear camera, filling the dialog. Nothing offers the photo library or "Choose file".
- [ ] Tap **Take photo**, then **Retake**, take it again, then **Use this photo**. The dialog closes, the photo shows in the box with a time in Eastern time that matches the clock now (not the phone clock if you set it wrong on purpose).
- [ ] **Leave for delivery** is now green. Tap it, confirm the ETA.
- [ ] Maria (laptop): before the driver left, her load page showed the Photos card with "appears here once the load leaves for delivery". After the driver left, the loaded photo is there, with its time. Tap it: it opens full size.
- [ ] Driver: **Arrived at delivery**. **Mark delivered** is grey until **Take delivery photo** is done. Take it. Tap **Mark delivered**.
- [ ] POD: in the dialog tap **Take POD photo**, take it, **Use this POD photo**, **Mark delivered**. The POD is stored. Also try a delivery with no POD: it works.
- [ ] Maria: after Delivered, the delivery photo appears too.
- [ ] Block the camera: phone settings, turn the camera off for the app. Open the photo step: it explains the camera is blocked and shows **Open the phone camera**. Tap it, take a picture in the phone's camera, confirm, then **Use this photo**: it works. Turn the camera on again and tap **Try the camera again**. Note whether this phone offers the gallery in that fallback (it is allowed there, see docs/QUESTIONS.md).
- [ ] The photo is sharp enough to read a label and the page is not slow on a normal mobile connection (each photo is about 100 to 400 kB).
- [ ] Take 7 photos in a row: the 7th is refused and the box says the load has 6.
- [ ] **Remove** a photo you took: it disappears. With none left the button is grey again.
- [ ] Staff: on another TEST load, **Override status** to **Enroute** without a photo works; the timeline says "Staff skipped the pickup photo (none on file)."
- [ ] iPhone and Android: the screens fit, nothing scrolls sideways, buttons are easy to tap with a work glove.
- [ ] Leave the dialog open and lock the phone, then unlock: the camera shows again or the dialog can be closed and reopened. After closing the dialog the camera light is off.

## M13. Board filters and sorting (staff, a computer AND a phone)
- [ ] Open /admin, tap Tomorrow: only loads picking up tomorrow remain and the counts read "n of m".
- [ ] Open Filters, choose a carrier and a shipper, tap Apply: chips appear, tap one chip to remove it.
- [ ] Switch View to One list and sort by Pickup time, then by Shipper (descending): the order changes as expected.
- [ ] On a phone (375 px wide) nothing scrolls sideways and every button is easy to tap.
- [ ] Clear all returns the full board.

## M14. Return loads (Maria on a phone, staff on a computer). Needs migration 0019 applied.
- [ ] Staff: move a TEST load (PO starting `TEST-`) to **At delivery** with an override. Maria: open it. A **Return** button shows. On a Requested or Booked TEST load there is no Return button.
- [ ] Maria: tap **Return**. The page says "Book a return" and "Return of <number>. The truck reloads at <site>." The pickup is the site and cannot be changed; its contact is the delivery contact of the first load.
- [ ] **Delivery location** shows the first load's shipper with "(original shipper)" and the first load's pickup contact. Choose **QuickScrap Metal**: its contact fills in. Choose the original shipper again: the first contact comes back.
- [ ] Size, Moffett, weight, pieces, PO and notes match the first load; dates are empty; there is no "How many trucks?". Choose dates, tap **Request return**.
- [ ] The new load says "Return of <number>" and the link opens the first load, which lists it under "Return loads" with its status.
- [ ] Staff email: subject "New return load requested (Request MTX-...)", the line "Return of <number>, original carrier: <name>".
- [ ] Staff: the board and the calendar show a **Return** badge on it. Open it: "Original carrier: <name>" and **Use the same carrier**. Tap it: the carrier is saved and the select shows it.
- [ ] Open the Return button on the same first load again: the note "A return was already requested for this load" shows. Cancel the TEST return afterwards.
- [ ] Phone (375 px): nothing scrolls sideways, the Return button is easy to tap.

## M15. Staff edit of a load (staff on a computer and a phone). Steps 3 and 4 need migration 0020 applied (the timeline line).
- [ ] Open a booked TEST load (PO starting `TEST-`) that has a carrier. Near the top tap **Edit details**. The form shows the current details; "Email the updated details to the carrier" is there and NOT ticked.
- [ ] Change the delivery place, the delivery contact, the pickup date and the truck size. Leave the box unticked and tap **Save changes**. The load page says "Saved." and shows the new details. No email reaches the carrier.
- [ ] The Timeline shows "Details edited: Delivery: <old> to <new>; ..." with your name. Maria opens the load: she sees the new details and the same line. The carrier opens the load in the app: the new place and contact show.
- [ ] Edit again, change the PO number, TICK the box, save. The page says "Saved. The carrier was emailed." The carrier gets "Load <number> updated" listing "PO number: <old> to <new>" and all the details. The email has no "ITS load to copy" number.
- [ ] In **Carrier and booking** tap **Email the details to the carrier again**: the page says "Details emailed to ..." and the carrier gets "Load <number> details".
- [ ] Open a delivered TEST load: **Edit details** works with a date in the past. Set the delivery date before the pickup date: the form refuses it. A cancelled TEST load has no Edit details button.
- [ ] Open a delivered TEST load and tap **Create return**: "Create a return", pickup fixed to the site, delivery preset to the first shipper. Add dates and tap **Create return**: you land on the new load ("Return created."), it is Requested for the same customer, says "Return of <number>", and no request email arrives. Tap **Use the same carrier**.
- [ ] Open **Lanes**, tap **Edit** on a row, change the delivery or the size, tap **Save**: the row moves to its new place. Edit it to a pickup, delivery and size that another row already has: the page says it already exists and nothing changes. (Put it back afterwards.)
- [ ] Sign in as Maria and open `/admin/loads/<id>/edit` of her load: "not found". Phone (375 px): the edit form and the return form do not scroll sideways.

## M16. Maria adds and edits locations herself (Maria on a phone, staff on a computer). Needs migration 0021 applied.
- [ ] Sign in as Maria and open **Locations**. There is an **Add location** link at the top and an **Add location** form at the bottom; there is no "Request new location" or "Request address change" form any more.
- [ ] Add a TEST location: name starting `TEST-`, a street, a city, ON, tick only **Can receive (delivery)** and **Needs a Moffett**, a contact name and phone. Tap **Add location**: the page says "<name> was added. You can book with it now." and the location is in the list.
- [ ] Add it again with the same name: the form says "A location with this name already exists." and nothing is added.
- [ ] Open **Book a load**: the TEST location is in the delivery list, not in the pickup list. Choose it as the delivery: the Moffett box is ticked and locked, and its contact fills in. (Do not submit.)
- [ ] Back on **Locations**, tap **Edit** on the TEST location. Change the address, tick **Can ship (pickup)**, untick **Needs a Moffett**, change the notes, tap **Save changes**: "Saved." and the new details show. In **Book a load** it is now also a pickup and the Moffett box is no longer locked.
- [ ] The location card offers no Deactivate, Delete or Needs review control to Maria.
- [ ] As staff open **Locations**, search for the TEST location: it shows "Added by <Maria>, <date> ET" and "Last edited by <Maria>, <date> ET", and no Needs review badge. Deactivate it afterwards (it then leaves Maria's lists).
- [ ] Phone (375 px): the Locations page with the edit form open does not scroll sideways.

## After testing
- [ ] Tell engineering the results (M1 to M16: pass or what you saw). Test loads stay in the system with the `TEST-` PO number. Staff can cancel any not-delivered one; ask engineering if you want them removed from the database (that needs your explicit approval).
