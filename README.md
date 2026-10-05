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

Login is magic link only. Public signup is off. Users are created by invite (server side, service role).

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
3. Magic links use PKCE: open the link in the same browser that requested it.
4. Realtime: `loads` and `load_events` are added to the `supabase_realtime` publication by migration 0004.
5. Storage bucket `documents` is private and created by migration 0004. Access is enforced by storage RLS (`dlv_can_access_doc`).
