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
