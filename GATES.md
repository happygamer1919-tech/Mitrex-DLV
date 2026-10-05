# Gates: DLV portal hardening run (C0 to C9)

OWNS: **

Scope: CI, e2e coverage on two engines, failure UX, security sweep, accessibility, PWA, data integrity migrations (local only), ops workflows, handover docs and a spec coverage audit. Production is read-only.

- [ ] G1: typecheck passes
  CHECK: npx tsc --noEmit && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: pending

- [ ] G2: production build passes
  CHECK: npm run build && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: pending

- [ ] G3: no em or en dashes anywhere
  CHECK: node scripts/check-no-dashes.mjs
  EXPECT: GATE_OK
  EVIDENCE: pending

- [ ] G4: RLS suite on a clean DB, 0 FAIL
  CHECK: sh -c 'supabase db reset >/dev/null 2>&1 && psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql'
  EXPECT: /RLS_OK \d+ OK \/ \d+ VACUOUS \/ 0 FAIL/
  EVIDENCE: pending

- [ ] G5: e2e passes on chromium and webkit (iPhone 13)
  CHECK: npx playwright test --project=chromium --project=webkit && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: pending

- [ ] G6: no secret values in the client bundle
  CHECK: node scripts/check-bundle-secrets.mjs
  EXPECT: BUNDLE_OK
  EVIDENCE: pending

- [ ] G7: security headers present on /login
  CHECK: node scripts/check-headers.mjs
  EXPECT: HEADERS_OK
  EVIDENCE: pending

- [ ] G8: axe finds no serious or critical violations at 375px
  CHECK: npx playwright test e2e/a11y.spec.ts --project=chromium && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: pending

- [ ] G9: PWA requirements hold
  CHECK: node scripts/check-pwa.mjs
  EXPECT: PWA_OK
  EVIDENCE: pending

- [ ] G10: apply pack exists
  CHECK: test -f docs/APPLY-PACK.md && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: pending

- [ ] G11: CI, keepalive and backup workflows exist
  CHECK: test -f .github/workflows/ci.yml && test -f .github/workflows/keepalive.yml && test -f .github/workflows/backup.yml && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: pending

- [ ] G12: guides and runbook exist
  CHECK: test -s docs/MARIA-GUIDE.md && test -s docs/DRIVER-GUIDE.md && test -s docs/RUNBOOK.md && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: pending

- [ ] G13: every R-number has evidence or an explicit GAP row
  CHECK: node scripts/check-spec-coverage.mjs
  EXPECT: COVERAGE_OK
  EVIDENCE: pending

- [ ] G14: production untouched (read-only count: 0 loads, 5 profiles)
  CHECK: sh -c 'set -o allexport; . ~/.zshenvmitrex; set +o allexport; psql "$DATABASE_URL_DIRECT" -tA -c "select (select count(*) from public.loads) || chr(124) || (select count(*) from public.profiles)"'
  EXPECT: /^0\|5$/m
  EVIDENCE: pending

- [ ] G15: no open PRs
  CHECK: gh pr list --state open --json number --jq length
  EXPECT: /^0$/m
  EVIDENCE: pending

- [ ] G16: production serves /login
  CHECK: curl -s -o /dev/null -w "%{http_code}" https://portal.dlvlogistics.com/login
  EXPECT: /^200$/
  EVIDENCE: pending

