# DLV Mitrex shipping portal

Booking and live-status portal for Mitrex loads brokered by DLV Logistics. Production URL: https://portal.dlvlogistics.com (Vercel project `mitrex-dlv`). All times are shown in America/Toronto and labelled ET.

Stack: Next.js (App Router, TypeScript), Tailwind, Supabase (Postgres, magic-link Auth, Storage, Realtime, RLS), Resend for email, installable PWA (no push).

## Roles

| Role | Sees | Does |
| --- | --- | --- |
| staff_admin | everything | all staff work, plus carriers, customers, users |
| staff_csr | everything operational | board, calendar, assign, BOL, book, override, locations, requests, CSV |
| customer (Maria) | own loads | book, edit and cancel while Requested, edit location contacts, request locations |
| carrier_owner | own carrier loads (booked and later) | status buttons, POD, ETA, manage drivers |
| carrier_driver | same as owner | status buttons, POD, ETA |

Login is by emailed 6 digit code (works from the installed iPhone PWA), with the emailed link as a fallback. Public signup is off. Users are created by invite (server side, service role).

## Environment variable names

Set in `.env.local` (git-ignored) and in the Vercel project. Names only here.

| Name | Used by |
| --- | --- |
| NEXT_PUBLIC_SUPABASE_URL | app, scripts |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | app |
| SUPABASE_SERVICE_ROLE_KEY | server only (invites, notifications emails list), scripts |
| DATABASE_URL_DIRECT | psql migrations (never the app) |
| RESEND_API_KEY | server email |
| NOTIFY_FROM | sender address for notifications |
| NEXT_PUBLIC_SITE_URL | links inside emails |
| SEED_ADMIN_EMAIL, SEED_CSR_EMAIL, SEED_MARIA_EMAIL | scripts/seed-users.mjs |
| SEED_CARRIER_A_NAME, SEED_CARRIER_A_EMAIL, SEED_CARRIER_B_NAME, SEED_CARRIER_B_EMAIL | scripts/seed-users.mjs |

## Local development

```
supabase start            # needs Docker
supabase db reset         # applies supabase/migrations then supabase/seed.sql
npm install
npm run dev
```

Point `.env.local` at the local stack (`supabase status -o env` shows the local URL and keys).

## Database

Migrations are plain SQL in `supabase/migrations`, applied in filename order:

```
set -o allexport; source ~/.zshenvmitrex; set +o allexport
for f in supabase/migrations/*.sql supabase/seed.sql; do
  psql "$DATABASE_URL_DIRECT" -v ON_ERROR_STOP=1 -f "$f" || break
done
```

Pre-check on a new project: `select count(*) from information_schema.tables where table_schema = 'public'` must be 0.

Status changes go only through the `set_load_status` and `set_load_eta` functions. See `docs/DECISIONS.md`.

## Tests and gates

- `GATES.md` is the completion ledger.
- `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql` simulates the five roles and prints `RLS_OK <n> OK / <m> VACUOUS / <k> FAIL`.
- `node scripts/check-no-dashes.mjs` fails on any em or en dash.

## Users

```
set -o allexport; source ~/.zshenvmitrex; set +o allexport
node scripts/seed-users.mjs --i-know-this-is-production
```

Without the flag the script only runs against a local Supabase. It is idempotent.

## Deploy notes

1. Vercel project `mitrex-dlv`, domain `portal.dlvlogistics.com`, all env names above set for Production.
2. Supabase Auth: Site URL `https://portal.dlvlogistics.com`; Redirect URLs include `https://portal.dlvlogistics.com/auth/callback`; public signup disabled; SMTP is Resend.
3. Login is code entry: the user types the 6 digit code from the email, so it works inside the installed iPhone PWA. The emailed link is only a fallback and, being PKCE, must open in the browser that requested it. The code needs the production email template below.
4. Realtime: `loads` and `load_events` are added to the `supabase_realtime` publication by migration 0004.
5. Storage bucket `documents` is private and created by migration 0004. Access is enforced by storage RLS (`dlv_can_access_doc`).

## Owner step: production email template

Login sends a 6 digit code. Supabase only includes the code if the template contains it. In Supabase Dashboard > Authentication > Email Templates > Magic Link, the body must contain both `{{ .ConfirmationURL }}` and `{{ .Token }}`. Paste this body (subject: `Your DLV sign-in code`):

```html
<h2>Your DLV sign-in code</h2>
<p>Enter this 6 digit code in the DLV portal:</p>
<p style="font-size:32px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
<p>The code expires soon. Or tap the link to sign in on this device:</p>
<p><a href="{{ .ConfirmationURL }}">Sign in to DLV</a></p>
<p>If you did not ask for this, ignore this email.</p>
```

Also check Authentication > Providers > Email: OTP length 6 and expiry 900 seconds or similar. The Confirm signup template is irrelevant (invite only, public signup off). The code is what works from the installed iPhone PWA, because an emailed link opens in Safari and the PWA does not receive the session.

Local: `supabase start` serves the same template (supabase/templates/magic_link.html) and a mail catcher (Mailpit) at http://127.0.0.1:54324.
