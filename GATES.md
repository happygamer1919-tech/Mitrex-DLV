# Gates: DLV Mitrex shipping portal v1

OWNS: **

Scope: booking and live-status portal (Next.js, Supabase) for Mitrex loads, with RLS verified on a local throwaway database.

- [ ] G1: typecheck passes
  CHECK: npx tsc --noEmit && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: pending

- [ ] G2: production build passes
  CHECK: npm run build && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: pending

- [ ] G3: no em or en dashes anywhere in the repo
  CHECK: node scripts/check-no-dashes.mjs
  EXPECT: GATE_OK
  EVIDENCE: pending

- [ ] G4: .env.local is git-ignored
  CHECK: git check-ignore .env.local
  EXPECT: .env.local
  EVIDENCE: pending

- [ ] G5: PWA manifest exists
  CHECK: test -f public/manifest.webmanifest && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: pending

- [ ] G6: migrations and seed apply on the local throwaway DB, 19 locations
  CHECK: psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -tA -c "select count(*) from public.locations"
  EXPECT: /^19$/m
  EVIDENCE: pending

- [ ] G7: RLS and status transitions hold for all five roles, 0 FAIL
  CHECK: psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql
  EXPECT: /RLS_OK \d+ OK \/ \d+ VACUOUS \/ 0 FAIL/
  EVIDENCE: pending
