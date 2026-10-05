# Gates: DLV portal v1.1 (code login, admin users, e2e, merge, production apply)

OWNS: **

Scope: OTP code login that works from an installed PWA, verified admin user management, Playwright e2e on local Supabase, merge, and production apply.

- [x] G1: typecheck passes
  CHECK: npx tsc --noEmit && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=3a2bb869b3539ca40aa01b61be0298a2c39580d49f9c66e3e94b8ab19ea90b6a; exit=0; EXPECT=matched; output-sha256=b44fa4c748d30a711988cc25a513a4aed03edcc203b7b90f6b1c6fd51c6d6e2a; output-bytes=8; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G2: production build passes
  CHECK: npm run build && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=e9a683c2495f49cbcf94335039e07d1c98284830bc553d24def599213ddefbaa; exit=0; EXPECT=matched; output-sha256=93e065bdc6b19802c62134b254c199402fa29ed91dfd9f905561ca9eb2435ed0; output-bytes=1172; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G3: no em or en dashes anywhere in the repo
  CHECK: node scripts/check-no-dashes.mjs
  EXPECT: GATE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=691429974f5f23b9a9c6f88dd16cbe9ad500387f81bf606e9f52591da2a64a25; exit=0; EXPECT=matched; output-sha256=b44fa4c748d30a711988cc25a513a4aed03edcc203b7b90f6b1c6fd51c6d6e2a; output-bytes=8; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G4: RLS suite green after the OTP and admin-users changes, 0 FAIL
  CHECK: sh -c 'supabase db reset >/dev/null 2>&1 && psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql'
  EXPECT: /RLS_OK \d+ OK \/ \d+ VACUOUS \/ 0 FAIL/
  EVIDENCE: automatic-evidence=v1; definition-sha256=62aa3d083ccc5d7b9090317f58d51af73e8325b6c7846fac7c94ad3224805f5c; exit=0; EXPECT=matched; output-sha256=732dd228523b4d619d6d4dacd64aa045ca451a8ba5a88230a107150a6b4a182a; output-bytes=739; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G5: Playwright e2e passes against the local Supabase stack (negative control run once and shown to fail, then removed)
  CHECK: npx playwright test && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=3b2fa58149f328627bee8d865c8aa6b1b7c4b01c348e7e00a2ae0b10e36a56f2; exit=0; EXPECT=matched; output-sha256=a533cde57246ebba48a70863d4995c51255c5ea206552992c90e8cda7db65e44; output-bytes=837; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G6: production env preflight passes (names and OK/BAD only)
  CHECK: sh -c 'set -o allexport; . ~/.zshenvmitrex; set +o allexport; node scripts/preflight-env.mjs'
  EXPECT: PREFLIGHT_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=068d27e228f10898d9668f1598ff024c998ed840088966e907a5d5be37731b4d; exit=0; EXPECT=matched; output-sha256=8bd8e45d566a1ba6160a65f7847443ba312164e95a83fe2cd6569327adff8be2; output-bytes=156; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G7: production has the 19 seeded locations
  CHECK: sh -c 'set -o allexport; . ~/.zshenvmitrex; set +o allexport; psql "$DATABASE_URL_DIRECT" -tA -c "select count(*) from public.locations"'
  EXPECT: /^19$/m
  EVIDENCE: automatic-evidence=v1; definition-sha256=423a8065e61e004e924381546d0ca67a1ae4466b69fabb48b4ed9bf544320b09; exit=0; EXPECT=matched; output-sha256=a9742eb8ee320e006666aef25ae9aeed948247f3125c9cafa7cf97b7e7467dd5; output-bytes=3; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries
