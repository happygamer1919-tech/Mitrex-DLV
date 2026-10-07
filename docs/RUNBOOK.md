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
