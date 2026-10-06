# Gates: DLV portal hardening run (C0 to C9)

OWNS: **

Scope: CI, e2e coverage on two engines, failure UX, security sweep, accessibility, PWA, data integrity migrations (local only), ops workflows, handover docs and a spec coverage audit. Production is read-only.

- [x] G1: typecheck passes
  CHECK: npx tsc --noEmit && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=3a2bb869b3539ca40aa01b61be0298a2c39580d49f9c66e3e94b8ab19ea90b6a; exit=0; EXPECT=matched; output-sha256=b44fa4c748d30a711988cc25a513a4aed03edcc203b7b90f6b1c6fd51c6d6e2a; output-bytes=8; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G2: production build passes
  CHECK: npm run build && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=e9a683c2495f49cbcf94335039e07d1c98284830bc553d24def599213ddefbaa; exit=0; EXPECT=matched; output-sha256=995bf867a9e4fb5608c8c7154ac20188573533e7a676a3501db7bbe16c0afb84; output-bytes=1193; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G3: no em or en dashes anywhere
  CHECK: node scripts/check-no-dashes.mjs
  EXPECT: GATE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=691429974f5f23b9a9c6f88dd16cbe9ad500387f81bf606e9f52591da2a64a25; exit=0; EXPECT=matched; output-sha256=b44fa4c748d30a711988cc25a513a4aed03edcc203b7b90f6b1c6fd51c6d6e2a; output-bytes=8; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G4: RLS suite on a clean DB, 0 FAIL
  CHECK: sh -c 'supabase db reset >/dev/null 2>&1 && psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql'
  EXPECT: /RLS_OK \d+ OK \/ \d+ VACUOUS \/ 0 FAIL/
  EVIDENCE: automatic-evidence=v1; definition-sha256=62aa3d083ccc5d7b9090317f58d51af73e8325b6c7846fac7c94ad3224805f5c; exit=0; EXPECT=matched; output-sha256=368d894b59faf53467ebf92fddcacaff450fa66db66220846fd7262e4ab06c94; output-bytes=1405; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G5: e2e passes on chromium and webkit (iPhone 13)
  CHECK: npx playwright test --project=chromium --project=webkit && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=b171ff5ea058c054dd76a992674c6ca3f56893dcf33b71a3277f187dd98b7269; exit=0; EXPECT=matched; output-sha256=095972e2c865445d144241fc390bf08d3c4bb52820b27cd34957644596d4b04e; output-bytes=37300; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G6: no secret values in the client bundle
  CHECK: node scripts/check-bundle-secrets.mjs
  EXPECT: BUNDLE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=e2f6c9d92038e0b63d53774df3a00f78f9ebbe59b372952daca8e7fc34d3684a; exit=0; EXPECT=matched; output-sha256=c825c26c30a344fa98ba1ad885705b4a65ea337f71849be1088276efdadbd76a; output-bytes=84; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G7: security headers present on /login
  CHECK: node scripts/check-headers.mjs
  EXPECT: HEADERS_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=cc04bd6b4ab0098dc45865fa16cb36a116a4d084fd027d8311a1233b5c56a18b; exit=0; EXPECT=matched; output-sha256=b7038dbc52963ecae9ca4ccc832e1332f693868456d9dd56fa32dfccee379639; output-bytes=11; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G8: axe finds no serious or critical violations at 375px
  CHECK: npx playwright test e2e/a11y.spec.ts --project=chromium && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=0e5338741bcd5879b8fd4fdf6ae8d3d43ba8d37f192318b8cb69346e87720b52; exit=0; EXPECT=matched; output-sha256=3fd0b063a2822986fc6dc887f75694723522105d8513c71ebe407279358496e9; output-bytes=4665; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G9: PWA requirements hold
  CHECK: node scripts/check-pwa.mjs
  EXPECT: PWA_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=dedae499e916a429e5a5ffd41897bc286bd459a0c45243abf95c9cf3a85935b8; exit=0; EXPECT=matched; output-sha256=1e67e424d70d4a169d454239c4f1b25166326b6ddd49c06de541de1a155ca5a7; output-bytes=492; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G10: apply pack exists
  CHECK: test -f docs/APPLY-PACK.md && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=5a21dff1653934714aaba05ffb536f47cdc3fecba197d7859b0703ebec5bfc15; exit=0; EXPECT=matched; output-sha256=b44fa4c748d30a711988cc25a513a4aed03edcc203b7b90f6b1c6fd51c6d6e2a; output-bytes=8; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G11: CI, keepalive and backup workflows exist
  CHECK: test -f .github/workflows/ci.yml && test -f .github/workflows/keepalive.yml && test -f .github/workflows/backup.yml && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=59b304b9a1cbe62cf135348e2d86888f2e40e2f40c17b2093296607d3ab883ec; exit=0; EXPECT=matched; output-sha256=b44fa4c748d30a711988cc25a513a4aed03edcc203b7b90f6b1c6fd51c6d6e2a; output-bytes=8; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G12: guides and runbook exist
  CHECK: test -s docs/MARIA-GUIDE.md && test -s docs/DRIVER-GUIDE.md && test -s docs/RUNBOOK.md && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=b19fc47f8b9e89245078f03d8dbc64233fd4b5283aaf9e809640f53948d81ccc; exit=0; EXPECT=matched; output-sha256=b44fa4c748d30a711988cc25a513a4aed03edcc203b7b90f6b1c6fd51c6d6e2a; output-bytes=8; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G13: every R-number has evidence or an explicit GAP row
  CHECK: node scripts/check-spec-coverage.mjs
  EXPECT: COVERAGE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=4d5474355c713eb157e7c7f4f05fd55095a46f616dbfd5e31bbe75bc239e8f97; exit=0; EXPECT=matched; output-sha256=fe847c5efadb44d1381d0f10bf1f6809b9c166573177ca6d73eff8233fbf62c1; output-bytes=46; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [ ] G14: production untouched (read-only count: 0 loads, 5 profiles)
  CHECK: sh -c 'set -o allexport; . ~/.zshenvmitrex; set +o allexport; psql "$DATABASE_URL_DIRECT" -tA -c "select (select count(*) from public.loads) || chr(124) || (select count(*) from public.profiles)"'
  EXPECT: /^0\|5$/m
  EVIDENCE: pending

- [x] G15: no open PRs
  CHECK: gh pr list --state open --json number --jq length
  EXPECT: /^0$/m
  EVIDENCE: automatic-evidence=v1; definition-sha256=5b7e33cf9949aacbfbea4568d0143f4d043fb6ad14deccc6e562ba56c7b5c747; exit=0; EXPECT=matched; output-sha256=9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa; output-bytes=2; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G16: production serves /login
  CHECK: curl -s -o /dev/null -w "%{http_code}" https://portal.dlvlogistics.com/login
  EXPECT: /^200$/
  EVIDENCE: automatic-evidence=v1; definition-sha256=dda3a3e906871471e0bac63563b8d3279d518c246ef83bae14d520557c1825b5; exit=0; EXPECT=matched; output-sha256=27badc983df1780b60c2b3fa9d3a19a00e46aac798451f0febdca52920faaddf; output-bytes=3; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

