# Handoff: DLV Mitrex portal (written 2026-10-07, session paused by the owner)

Audience: the next Claude Code session. Read this first, then CLAUDE.md (global), docs/SPEC.md and docs/DECISIONS.md.
The owner (Ivan, owns DLV Logistics) does not read code. He checks behavior, reads plain-language PR summaries and answers questions in batches. All quality assurance must be machine-verifiable.

## 1. State in one paragraph

The portal at https://portal.dlvlogistics.com is LIVE with real loads and real users. Production database is at migrations 0001 to 0018, every apply was pre-checked and post-checked (docs/APPLY-PACK*.md, each ends with a recorded production result). Main is at the merge of PR #34 (branded sign-in email). Two feature cards were paused mid-build and exist only as LOCAL, UNPUSHED, UNVERIFIED WIP commits (section 4). Nothing else is half done: no half-applied migration, no push or release in progress, no background job running.

## 2. What is live (all shipped and verified)

| Feature | PR | Migration |
| --- | --- | --- |
| Request again plus last-contact hints | #22 | none |
| Admin board layout (status bands, jump bar, swipeable phone menu) | #23 | none |
| ITS load number (mandatory to leave Requested), booking confirmation email with BOL | #24 | 0013 |
| Admin-only permanent delete of loads (Danger zone, audit table) | #26 | 0014 |
| Lane references: staff-only "ITS load to copy", Lanes page, Moffett lock on 7 sites | #28 | 0015, 0016 |
| Rate requests (customer asks, staff quote, emails both ways, Rates pages) | #30 | 0017 |
| Required pickup and delivery photos, in-app camera, customer sees photos after the status change | #32 | 0018 |
| Branded sign-in email template (file only, see section 6) | #34 | none |

Docs PRs #25, #27, #29, #31, #33 record production results of packs 4 to 8.

## 3. Users and accounts (production, masked on purpose)

- staff_admin: chris@dlvlogistics.com (owner side). staff_csr: Luca.
- customer Mitrex: Maria (mariaelena.c at mitrex.com). The old m.chris@dlvlogistics.com login is DEACTIVATED (is_active=false), history kept.
- carrier Kaja Transport: owner login kajatransportltd@hotmail.com (the drivers will share this login). The old testing Gmail owner is DEACTIVATED.
- carrier FreightPro Systems: owners jesse@freightprosystems.ca and sk@freightprosystems.ca (both active, created 2026-10-07; the owner said "put jesse, and CC sk", read as two owner logins because carriers receive no emails today). The old placeholder Gmail owner is DEACTIVATED.
- Removal policy used so far: deactivate (is_active=false), never delete an auth user. Deleting data is owner-confirmable.
- Login is invite-only email OTP (8 digit code, link fallback). Codes to hotmail.com and mitrex.com may land in spam: tell users to check Junk.

## 4. The two paused cards (local WIP, NOT pushed, NOT reviewed)

Both branches were cut from main at aebb616 (PR #34 merge). Each has ONE commit titled "WIP UNVERIFIED". The worktrees are under `.claude/worktrees/wf_1796bc3a-3a0-1` and `-2`. No gate was run after the pause. Treat the code as a draft: read it critically, finish it, prove it with tests, mutation-check, then ship through the normal flow (section 7).

### Card A: gallery option on the photo steps, branch `feat/dlv-035-gallery-upload`
Owner request: besides the in-app camera, add "Choose a photo from your phone" (gallery or files) on the pickup photo, delivery photo and the staff upload on behalf. This deliberately relaxes R41 ("no gallery"): update R41, DECISIONS, QUESTIONS.
Rules to keep: the in-app camera stays the primary button; at least one photo from either source unlocks the next step; the official photo time is the SERVER time of the upload, labelled "Uploaded" (never "Taken"); same 1600 px JPEG downscale; max 6 per kind per load; database rules from 0018 unchanged, NO migration; accept attribute image/jpeg, image/png, image/webp so iOS converts HEIC to JPEG; 44px targets; 375px no overflow.
Files touched so far: src/components/camera/{CameraCapture,PodPicker,GalleryPicker}.tsx (GalleryPicker new), src/components/carrier/{LoadActions,PhotoThumbs,PodCard}.tsx, src/components/admin/LoadControls.tsx, src/lib/carrier/gallery.ts (new), the two load detail pages, e2e/load-photos.spec.ts, e2e/load-photos-gallery.spec.ts (new), docs edits (SPEC, SPEC-COVERAGE, DECISIONS, QUESTIONS, DRIVER-GUIDE, STAFF-GUIDE, ACCEPTANCE-CHECKLIST).
Unknown: whether it type-checks, whether the specs pass, whether the docs rows match real test titles (check-spec-coverage).

### Card B: board filters and sorting, branch `feat/dlv-036-board-filters`
Owner request: the staff board (/admin) already shows many loads for tomorrow (6 booked Howden to Sherbourne loads and others). He wants filtering and sorting: by pickup time, by shipper and so on.
Design (agreed in the brief): state in the URL query string (q, status, carrier, shipper, receiver, size, when, sort, dir, view), validated strictly on the server (bad values ignored, never an error page). Search over ITS number, request ref, PO, pickup and delivery location names, carrier name. Filters: status, carrier (id or none), shipper (pickup location), receiver (delivery location), size 26/36/53, when (today, tomorrow, next 7 days, custom dates by pickup date in the Eastern calendar). Sort keys: pickup_time (default), shipper, receiver, carrier, its_number, size, created, with asc or desc and stable tie-breaks (null times last, windows sort by window start). Two views: "By status" (current bands, sorting within each band, counts show "n of m" when filtered) and "One list" (table at desktop with aria-sort headers, cards at 375px). Phone: controls behind a "Filters" button with a count badge. Quick pills: Today, Tomorrow, Next 7 days, Not assigned, Needs BOL, Needs ITS number. Removable chips plus Clear all. Staff only, no migration, customer and carrier pages untouched. Docs: SPEC R42, STAFF-GUIDE section, ACCEPTANCE-CHECKLIST M13.
Files touched so far: src/app/admin/page.tsx, src/lib/admin/queries.ts, src/lib/admin/board-filters.ts (new), src/components/admin/BoardFilters.tsx (new), e2e/board-filters.spec.ts (new), e2e/a11y.spec.ts. Docs not yet done as far as known (SPEC R42 and guides need checking).
Unknown: everything, nothing was verified.

Both cards were meant to be reviewed adversarially by a second agent (reviewer branches `review/dlv-035` and `review/dlv-036` were never created).

## 5. How to verify (the gates)

All commands run in the repo root. Use the LOCAL Supabase stack only (127.0.0.1); e2e refuses anything else (assertLocalUrl).
- Types: `npx tsc --noEmit`
- No dashes in text: `node scripts/check-no-dashes.mjs` (must print GATE_OK; em and en dashes are forbidden everywhere)
- Spec coverage: `node scripts/check-spec-coverage.mjs` (COVERAGE_OK; every R-number in docs/SPEC.md needs a row in docs/SPEC-COVERAGE.md citing real test titles)
- Database tests: `supabase db reset` then `PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql | grep -aE 'RLS_OK|FAIL'`. Last measured on main: `RLS_OK 917 OK / 0 VACUOUS / 0 FAIL`. Run it from the host with psql (running it inside the container breaks the file includes). Never call functions as anon in rls.sql (it segfaults local Postgres); assert has_function_privilege.
- End to end: `E2E_PORT=<free port> npx playwright test --project=chromium --project=webkit` (webkit is an iPhone 13). Mail mock default port 3299. Last full run on main: all green except the known flakes below.
- Other checks in scripts/: check-bundle-secrets, check-headers, check-pwa, preflight-env.
- Known flakes (not defects): `realtime.spec.ts` "Maria's list shows Booked within 5 s" right after a `supabase db reset`, and the webkit `multi-truck.spec.ts` "server cap". Both pass when rerun alone. Webkit has no fake camera, so camera specs are skipped there by design.
- Every new behavior test must be mutation-checked once (break the code, see the test fail, revert).

## 6. Hard rules that already burned us

1. SECRETS. `~/.zshenvmitrex` holds production secrets (env variable NAMES only may be printed). NEVER use `set -x`, `zsh -x`, `bash -x`, `env`, `printenv` or `set` without arguments, and never cat a shell profile. `zsh -x` leaked the Resend key once (it was rotated). Run snippets with `zsh -f`. Scan every diff for secret shapes before committing (counts only). Never commit .env files.
2. PRODUCTION. Never run tests or seeds against production. A production write needs the owner's authorization for that action. During this project the owner gave a STANDING approval, stated in the earlier session as "yes, apply the migrations when ready", for the feature queue that is now finished. Treat it as spent: ask the owner before the next production migration or data change.
3. Never commit or push directly to main. Feature branches `<area>/<ticket>-<slug>`, PR with a plain-language summary, a verification checklist ("open this URL, click this, expect that"), log entries and gates. Squash merge only after quality, rls and Vercel checks are green.
4. Never guess a product decision: log it in docs/QUESTIONS.md with a recommended default and move on.
5. No new third-party dependency or vendor without asking.
6. Failure ceiling: after 3 failed fix attempts on one ticket, stop, log it, mark it blocked.
7. Plain hyphens only in all text: no em or en dashes, anywhere.
8. Hosted Supabase does NOT read `supabase/templates/magic_link.html`. After any change the owner pastes it in the dashboard (Authentication, Emails, Magic Link). Steps are in docs/RUNBOOK.md. The owner was asked to do this; whether he did is unknown.
9. Supabase Auth SMTP password must equal the current Resend key, otherwise login shows "Network problem".
10. Workflow agents run in worktrees under `.claude/worktrees/` and can start from a stale base: every brief must say `git fetch origin && git checkout -b <branch> origin/main`. Agents cannot run zsh files in their sandbox, so the lead reruns the apply-pack blocks verbatim (section 7).
11. Do not let subagents touch the shared local database at the same time (db reset by one breaks the other). Give each its own ports.
12. Squash merges make later branches conflict in docs/PROGRESS.md: resolve by keeping both rows (union).

## 7. Procedures

### Ship a card without a migration
Branch from origin/main, commit, append a docs/PROGRESS.md row with the NEXT PR number (`gh api repos/happygamer1919-tech/Mitrex-DLV/issues?state=all&per_page=1&sort=created&direction=desc --jq '.[0].number'` plus 1), run check-no-dashes, push, `gh pr create`, wait for the three checks (`gh pr checks N`), `gh pr merge N --squash`, then wait for the production deploy of the merge commit (GitHub deployments API, environment Production) and check `/api/health` returns `{"ok":true}` and `/login` returns 200.

### Ship a card WITH a migration (apply pack pattern)
1. Write supabase/migrations/00NN_*.sql (additive, idempotent) and docs/APPLY-PACK-N.md in the format of docs/APPLY-PACK-8.md: zsh code fences starting with `# BLOCK precheck`, `apply`, `rollback-00NN`, `postcheck`; each block runs in a subshell and closes with a line that is exactly `)`; a lone `)` line inside SQL breaks extraction.
2. Extract blocks with python (never awk on a lone `)`): regex on triple-backtick zsh fence, `# BLOCK name`, lazy body, closing fence. Run them yourself under `zsh -f` against local, from `supabase db reset --last 1` plus production-like rows (one staff admin, one customer user, one load; a fixture is easy to rebuild). Expect: precheck OK, apply OK, postcheck OK, apply again OK (idempotent), rollback then postcheck FAIL, apply restores.
3. Open the PR WITHOUT merging, wait for CI.
4. Production (owner approval first): `DLV_APPLY_DIR=<fresh dir> zsh -f -c 'set -o allexport; source ~/.zshenvmitrex; set +o allexport; zsh -f <block file>'` for precheck, then apply, then postcheck. Merge only after POSTCHECK_OK. Count FAILs in postcheck can be live traffic (owner deleted loads during one run): investigate with read-only queries (`default_transaction_read_only=on`) before deciding.
5. Merge, confirm the deploy, then a small docs PR records the production result in the pack.

### Account changes in production
Done with a throwaway node script using the service role (`@supabase/supabase-js`, `auth.admin.createUser` with `email_confirm: true`, upsert into `profiles`), run under `zsh -f` after sourcing `~/.zshenvmitrex`, deleted right after, printing masked emails only. Deactivate with `profiles.is_active=false`.

## 8. Architecture facts you need

- Stack: Next.js 16, TypeScript, Tailwind v4, Supabase (Postgres, Auth, Storage, Realtime, RLS), Resend, Vercel project `mitrex-dlv`, installable PWA. Repo happygamer1919-tech/Mitrex-DLV.
- Roles: staff_admin, staff_csr, customer, carrier_owner, carrier_driver.
- Status changes go ONLY through SECURITY DEFINER `set_load_status`; carriers move one step at a time. Since 0018 a carrier needs a pickup photo to go loading to enroute and a delivery photo to go at_delivery to delivered (staff exempt, skip noted in the event). Since 0013 an ITS load number is required to leave requested. POD is optional (owner ruling).
- Documents: private bucket `documents`, 15 MB, image kinds pickup_photo and delivery_photo plus bol and pod; access through `dlv_can_access_doc(path, write)` with a strict anchored path regex. Customers see pickup photos from enroute on and delivery photos from delivered on. Maximum 6 photos per kind per load. Photo `created_at` is forced to server time.
- Lane references and rate requests are staff-facing or per-customer tables with RLS; lane numbers must never reach customers or carriers.
- Realtime: `LiveRefresh` (authenticated Realtime plus a 15 s poll).
- Emails: `src/lib/email.ts`, Resend, honors RESEND_BASE_URL (the e2e mail mock). Customers get the booking confirmation (with BOL) and rate-ready emails; staff get request and rate-request emails; carriers receive no emails.

## 9. Open items for the owner (ask, do not guess)

1. Paste the new sign-in email template into Supabase (section 6, rule 8) and confirm.
2. Real-phone test of the camera and install (checklist M12): the owner said the camera works; the Android install and the new gallery option are still untested on a real phone.
3. Maria has not been told that Moffett is now locked on for 1HAM, 152 Sh, 831 Queen, Glengarry, Kitney site, Military Trailsite and PrimeFab.
4. Whether Maria should also hide the request ref (default: shown small).
5. Sign-in code deliverability to mitrex.com, hotmail.com and freightprosystems.ca.
6. No separate "Unloading" status (owner confirmed not needed). The POD "Choose a file instead" link was kept.

## 10. Suggested next steps, in order

1. Ask the owner whether to continue Card A and Card B (he asked for both). Then verify each branch from scratch: `git diff origin/main` secret scan, tsc, check-no-dashes, check-spec-coverage, rls.sql, the specs for the files touched plus a11y, on both projects.
2. Finish and review Card B first if the owner wants the board filters soonest (it is staff only, no database change, lowest risk). Card A changes what drivers see: test it carefully on 375px and on chromium and webkit.
3. Ship each through section 7 (no migrations, so no production apply needed).
4. Add the new docs rows (R41 update, R42) and keep check-spec-coverage green.
5. Keep the board and the driver screens fast and the production health check green after each deploy.
