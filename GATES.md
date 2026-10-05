# Gates: DLV Mitrex shipping portal v1

OWNS: **

Scope: booking and live-status portal (Next.js, Supabase) for Mitrex loads, with RLS verified on a local throwaway database.

- [x] G1: typecheck passes
  CHECK: npx tsc --noEmit && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=3a2bb869b3539ca40aa01b61be0298a2c39580d49f9c66e3e94b8ab19ea90b6a; exit=0; EXPECT=matched; output-sha256=b44fa4c748d30a711988cc25a513a4aed03edcc203b7b90f6b1c6fd51c6d6e2a; output-bytes=8; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G2: production build passes
  CHECK: npm run build && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=e9a683c2495f49cbcf94335039e07d1c98284830bc553d24def599213ddefbaa; exit=0; EXPECT=matched; output-sha256=5f08e50dd88577a00882d37ffcb6202c6055f2d1f36913cce4d38e87bf59ae0c; output-bytes=1172; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G3: no em or en dashes anywhere in the repo
  CHECK: node scripts/check-no-dashes.mjs
  EXPECT: GATE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=691429974f5f23b9a9c6f88dd16cbe9ad500387f81bf606e9f52591da2a64a25; exit=0; EXPECT=matched; output-sha256=b44fa4c748d30a711988cc25a513a4aed03edcc203b7b90f6b1c6fd51c6d6e2a; output-bytes=8; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G4: .env.local is git-ignored
  CHECK: git check-ignore .env.local
  EXPECT: .env.local
  EVIDENCE: automatic-evidence=v1; definition-sha256=1711713d256f119a2d21959e26d85bd5022db736416ed2a8673fbaf962de3ed5; exit=0; EXPECT=matched; output-sha256=10edf395121888b825269ff19c83f8531dc38df96c5927b2e09a6cfc6e86d06a; output-bytes=11; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G5: PWA manifest exists
  CHECK: test -f public/manifest.webmanifest && echo GATE_OK
  EXPECT: GATE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=dfed29e75f9e5fb139a5639cd8f58a538b6099429d907f20f5802d6a2708f33c; exit=0; EXPECT=matched; output-sha256=b44fa4c748d30a711988cc25a513a4aed03edcc203b7b90f6b1c6fd51c6d6e2a; output-bytes=8; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G6: migrations and seed apply on the local throwaway DB, 19 locations
  CHECK: psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -tA -c "select count(*) from public.locations"
  EXPECT: /^19$/m
  EVIDENCE: automatic-evidence=v1; definition-sha256=4116d945a82e8a581dcd0399dee060840c2a1743a74efe5bff98630521ede335; exit=0; EXPECT=matched; output-sha256=a9742eb8ee320e006666aef25ae9aeed948247f3125c9cafa7cf97b7e7467dd5; output-bytes=3; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries

- [x] G7: RLS and status transitions hold for all five roles, 0 FAIL
  CHECK: psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql
  EXPECT: /RLS_OK \d+ OK \/ \d+ VACUOUS \/ 0 FAIL/
  EVIDENCE: automatic-evidence=v1; definition-sha256=f219115551c3522de4781920611981cbfa9fd970f8278c0004ea16c51ffe4211; exit=0; EXPECT=matched; output-sha256=b45e92c4d1975d2bf1b2710b32321c8c0c1dd549603c0947596f00fa0c628847; output-bytes=691; shell=/bin/sh; cwd=/Users/ivan/Documents/Projects/GitHub/Mitrex-DLV; path=b81828cf6b01/17 entries
