# Owner runbook

Admin pages are in the top menu when you sign in as staff admin. Never paste keys into chat, email or git.

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

## After every deploy
1. Open https://portal.dlvlogistics.com. It must load the login page.
2. Request a sign-in code. The email must arrive with an 8 digit code.
3. Sign in as staff. The board loads.
4. Open one load. Documents and Timeline show.
5. Check Vercel > Deployments says Ready, with no errors in the logs.

## Who to call
- DLV dispatch: [phone/email to be filled in by owner]
- Developer: [phone/email to be filled in by owner]
- Supabase support: [account email to be filled in by owner]
- Vercel support: [account email to be filled in by owner]
