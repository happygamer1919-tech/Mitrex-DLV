# Owner runbook

Admin pages are in the top menu when you sign in as staff admin. Never paste keys into chat, email or git.

## Book a load (staff)
DLV dispatches in ITS. Maria's request has only an internal request reference (MTX-0005) and shows "Number pending" to her. To book it:
1. Open the load (Board, then the load). The title reads "Request MTX-0005".
2. In **Carrier and booking**: pick the carrier and tap **Save carrier**.
3. Upload the BOL in **Documents** (drop the file or tap the box, then **Upload BOL**). A BOL is not required to book: without it the load shows "BOL pending" and the booking email to Maria says the BOL will follow. If you upload the BOL after booking, Maria is emailed the file at once.
4. Create the load in ITS first, then type the new ITS load number in **ITS load number (required to book)** (digits, a split such as 313-2 is fine). **Mark booked** stays grey until a carrier is saved and a number is typed, and says which is missing.
5. Tap **Mark booked**. The carrier users and all active Mitrex users are emailed; the load is now named by the ITS number everywhere.
6. Typed the wrong number? **Edit ITS number** on the load (any time after booking). The change is logged in the timeline. Two loads can never share an ITS number.
A status override out of Requested also asks for the ITS number. A load booked before this feature has no ITS number: it keeps working, and **Edit ITS number** adds one.

## Lanes: which old ITS load to copy (staff only)
Open **Lanes** in the top menu (admin and CSR alike). Each row says: for this pickup, this delivery and this truck size, copy that old ITS load. Customers and carriers never see the page or the numbers.
**Add a lane.**
1. Tap **Add lane**, choose the pickup, the delivery and the truck size (26, 36 or 53), type the ITS load to copy (digits, a split such as 313-2 is fine) and an optional note, tap **Add lane**.
2. The quick way: open a Requested load that shows "No ITS reference for this lane and size" and tap **Add it**. The form opens with the pickup, delivery and size already filled in; type the number.
3. A scenario can have only one row. Adding it again says so; edit the existing row instead.
**Edit or delete.** **Edit** on the row changes the number and note (it saves at once and shows who changed it and when). **Delete** asks first. Loads read the lane live, so an edit shows on every load straight away (reload the load page).
**Moffett column.** It is read from the two locations (a lane needs a Moffett when the pickup or the delivery location requires one). To change it, edit the location on the Locations page, not the lane.
**Find a lane.** Search, or filter by pickup, delivery and truck size. Rows are grouped by pickup.
**Export and import (CSV).**
1. **Export CSV** downloads every lane (columns shipper, receiver, truck_size, load_to_copy, note). Open it in Excel or Sheets.
2. To change many lanes at once, edit the file and use **Import CSV**: drop the file or paste the rows. Names in shipper and receiver must be exactly as on the Locations page. A table shows every row with OK or what is wrong (unknown location, size not 26, 36 or 53, number not digits with an optional dash, the same lane twice in the file, shipper equal to receiver).
3. **Apply import** stays grey until every row is OK, and imports nothing otherwise (at most 500 rows). Rows that already exist are updated, new rows are added; nothing is ever deleted by an import.
**The request email.** Each "New load requested" email to staff has a line "ITS load to copy: 1269 (Mitrex to 481 University Ave, 26 ft)" or "No ITS reference for this lane and size yet. Add it: <link>" (the link opens Lanes with the lane filled in). Maria does not get that line, nor the carrier.

## Rate requests (staff)
Open **Rate requests** in the top menu (admin and CSR alike). Maria asks for a rate on a new lane on her **Rates** page; the active admins are emailed. Open the request, type the amount, choose CAD or USD, add notes and a valid until date if you want, tap **Save rate**. Maria is emailed that the rate is in the app (the email never carries the amount) and sees it on her Rates page. To change a rate open the request again and tap **Correct the rate**. A request Maria cancelled cannot be quoted. A rate request is not a load: nothing is created on the board. Table: rate_requests (migration 0017); the only writes after the insert are the functions set_rate_quote and cancel_rate_request, there is no delete.

## Delete a load forever (admin only)
Only the staff admin account (chris@dlvlogistics.com) can do this. The CSR (Luca), customers and carriers never see the button and the database refuses them. **This cannot be undone.** The only way back is the weekly backup, which brings back everything else from that day too, so use **Cancel load** instead unless the load must disappear (a test load, a duplicate, a load entered by mistake).
1. Open the load (Board, then the load). Scroll to the bottom: the **Danger zone** card.
2. Tap **Delete this load forever**. A window lists what will go: the load number, route, status and how many BOL, POD and photo files.
3. Type the load number exactly as shown (the ITS number, or "MTX-0005" style while it has none). **Delete forever** stays grey until it matches. **Cancel** or Escape closes the window and changes nothing.
4. Tap **Delete forever**. You land on the board with "Load 313 deleted forever". The load, its timeline and its BOL, POD and photo files are gone for good, and it disappears from Maria's list, the carrier's list, the board, the calendar and new CSV exports.
5. If the banner says "The load was deleted. N files could not be removed and were logged for cleanup.", the load is gone but N files are still in storage. Tell the developer; the file names are in the audit table (load_deletions.orphan_paths).
6. A small record stays after a delete (request ref, ITS number, last status, who deleted it and when) so there is a trace. It holds no load details. If you would rather keep no trace at all, tell the developer.
Deleting one truck of a multi-truck booking only deletes that truck; the others stay.

## Add a location
1. Open **Locations**.
2. Tap **New location**.
3. Fill in name, address, city, province and postal code. Add a default contact if you have one.
4. Tick **Can ship (pickup)**, **Can receive (delivery)** and **Requires Moffett** as needed.
5. Tap **Create location**. A blank postal code flags it "Needs review".
6. **Deactivate** hides it from customers without deleting it.

## Add a carrier
1. Open **Carriers**.
2. Type the name, tap **Add carrier**.
3. **Rename** and **Deactivate** or **Activate** are on the same row.
4. Then add the carrier owner as a user (next task).

## Invite a user
1. Open **Users**, section **Add a user**.
2. Enter email and full name. Choose the role. Customer needs a customer, carrier owner or driver needs a carrier.
3. Tap **Add user**.
4. No email is sent. Tell the person to open the portal and request a sign-in code with that email.

## Deactivate or reactivate a user
1. Open **Users**, find the person.
2. Tap **Deactivate**, then **Yes, deactivate**.
3. The person cannot sign in and loses access at once. Their history stays.
4. To undo, tap **Reactivate**, then **Yes, reactivate**. They can sign in again.
5. **Remove** (only shown for inactive users) is permanent. Avoid it.
6. You cannot deactivate yourself or the last active admin.

## Approve a location request
1. Open **Requests**. Pending ones are at the top.
2. Read the details. For a change, the existing location is named.
3. Tap **Approve**, or **Reject** then **Yes, reject**.
4. The customer sees the result under "My location requests".

## Restore a paused Supabase project
1. Open the Supabase dashboard and select the project.
2. Tap **Restore** and wait until the project is Active.
3. Open https://portal.dlvlogistics.com and sign in with a code. A loaded load list means it works.
4. Free projects pause after about a week of no use. Set up a weekly keepalive request. None is in the code today, so confirm one exists.

## Rotate keys
Do one key at a time. For each: create the new value, update everywhere below, redeploy, test login.
1. **Supabase anon and service role keys**: Supabase dashboard > Project Settings > API (regenerate the JWT secret or keys). Names: NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
2. **Database password**: Supabase dashboard > Project Settings > Database > reset password. Name: DATABASE_URL_DIRECT.
3. **Resend API key**: Resend dashboard > API Keys > create a new one, delete the old one. Name: RESEND_API_KEY. Supabase sign-in email SMTP also uses it: update it in Supabase > Authentication > SMTP.
4. Update the same names in Vercel > project mitrex-dlv > Settings > Environment Variables (Production).
5. Update the same values in your local env file.
6. Redeploy in Vercel (Deployments > Redeploy).
7. Run the deploy checks below. Never commit the env file.

## Sign-in says "Network problem" or no code arrives
Most likely the sign-in email cannot be sent. Check, in this order:
1. Supabase dashboard > Authentication > SMTP Settings: the Password must be the CURRENT Resend API key (the same one as in Vercel). After any Resend key rotation this must be updated too, or every sign-in fails.
2. Resend dashboard > Domains: the sending domain (send.dlvlogistics.com) shows Verified.
3. Resend dashboard > Logs: look for a rejected or bounced message to that address.
4. Try again after saving. The portal itself and the database are separate and keep working while this is broken.

## After every deploy
1. Open https://portal.dlvlogistics.com. It must load the login page.
2. Request a sign-in code. The email must arrive with an 8 digit code.
3. Sign in as staff. The board loads.
4. Open one load. Documents and Timeline show.
5. Check Vercel > Deployments says Ready, with no errors in the logs.

## Who to call
- DLV dispatch: (226) 703-3034, chris@dlvlogistics.com
- Developer: info@a-and-i-automation.com
- Supabase account email: info@a-and-i-automation.com
- Vercel account email: info@a-and-i-automation.com
