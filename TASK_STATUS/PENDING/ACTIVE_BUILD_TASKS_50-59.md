# Pending Tasks — Active Build Phase (Tasks 50–59)

**Current owner priority:** Make the existing frontend usable from a GitHub Pages direct link and bring the Apps Script/Sheets backend as close to runnable as possible. Focus on implementation, not a documentation-only or test-only phase. Run only the targeted checks needed to avoid shipping a broken build.

Do not execute Tasks 60–65 in this phase; they remain deferred in `DEFERRED_TASKS_60-65.md`.

## Status board (updated after Task 55)

| Task | Status |
|---|---|
| 50 | **completed** |
| 51 | **completed** (gate implemented; rights decision pending) |
| 52 | **completed** |
| 53 | **completed** |
| 54 | **completed** |
| 55 | **completed** (local manifest-to-preview flow implemented; browser/DOM validation constrained) |
| 56 | **completed** (owner approval remains off) |
| 57 | **implemented, operationally blocked; remains current task** |
| 58-59 | pending until Task 57 blockers are resolved |

## Task 50 — baseline and dataset reconciliation — COMPLETED

- [x] Start from the attached `gate-prep-studio-build-handoff.zip` / current complete project, inspect actual files, and preserve all files.
- [x] Reconcile the known count mismatch enough to avoid silently losing records: current sanitized staging has 15,110 IDs; prior extractor summary reports 15,140 unique IDs and unresolved duplicate/conflict groups. If source audit files are not present, record the exact limitation and continue building from the included staging master without inventing the missing 30 IDs.
- [x] Confirm exact project/file paths, current Task 49 loader, existing app UI and backend modules. Do not use screenshots or another AI's working directory as a substitute for inspecting the ZIP.

**Task 50 evidence (code + measured results):**
- `tools/audit_staging.py` (read-only, deterministic) writes `reports/private/staging-audit-v1.json` (IDs and counts only; PRIVATE, never publish). Staging master untouched.
- 15,110 records, 15,110 unique IDs, no duplicates. Mapping: 13,900 `paper_year_confident`, 1,145 `paper_topic_only_no_year`, 60 `ambiguous_identity_needs_review` (all `future_paper_year_needs_review`), 5 `generic_topic_no_paper_year`. 1,210 without year; 65 without branch (the 60+5).
- 4 blank-text records = the same 4 image-review records (`REQUIRES_IMAGE_RENDERING`); all four are tagged paper_year_confident, so they must be excluded explicitly (13,900 - 4 = **13,896 official candidates in 201 paper/year/set groups**, largest 105, 87 groups carry a SET-n variant, all under the loader's 1,000-question shard cap).
- 48 records have an unusual option count for their type (MCQ/MSQ not 4 options). The private audit still flags all 48; seven one-option MCQs are excluded by the existing app schema, while other non-four-option rows remain only when the existing schema accepts them.
- Media: 4,972 records carry 10,566 media refs, all unresolved source paths. Task 52 corrected the audit metric to check real file existence (`resolved_to_local_file: 0`); no images can be published.
- **30-ID gap vs the earlier 15,140 figure: UNRESOLVED.** The extractor/audit files are not in this ZIP; no IDs were invented.
- Existing loader: `app.js` DATA_BASE is relative (`data/`), strict manifest validator present; no `.github/` workflow yet; `api.js` still `REPLACE_WITH_APPS_SCRIPT_WEB_APP_URL`; `MARKING_RULES_CONFIRMED=false`, `EXAM_ENGINE_AVAILABLE=false` (unchanged).
- Baseline tests (before edits): unit 24/24; manifest loader 423 checks/19 mutations; linkcheck 16 pages/488 links/0 broken; exam.unit 28/29 and DOM 19/22 because assertions were stale. Task 55 updated the `exam.unit` auth-module assertion and the known DOM summary/login copy expectations. After Task 55, exam.unit is 29/29. The DOM suite could not be rerun because `jsdom` was unavailable and installing its dependency timed out; this remains an explicit validation gap, not a pass.

## Tasks 51–54 — data release checkpoint — COMPLETED

Evidence and detailed limitations are preserved in `TASK_STATUS/COMPLETED/TASKS_50-54.md`.

- **51:** `data/PUBLICATION_GATE.json` defaults to false. Real public output requires explicit owner confirmation and an approval reference, plus `--publish-real`. Actual rights are still **unconfirmed**, so the public build is synthetic.
- **52:** staging master and audit lists are preserved. Official candidates require a confident, non-conflicting two-letter paper code and year, non-empty text, no image-review flag, no unresolved question/option image dependencies, and the `app.js` public-record schema. Invalid rows are excluded with ID/reason notes; missing paper/year data is never invented.
- **53:** `tools/build_release.py` uses explicit field allowlists, duplicate-ID abort, schema checks, private-field scanning, stable JSON serialization and SHA-256; deterministic builder tests pass 4/4.
- **54:** public `data/manifest.json` is a valid one-question synthetic placeholder. Private output under `private-release/data/` contains 152 shards / 10,098 eligible records; repeated build output is byte-identical. `tools/export_public_site.py` creates a clean `public-site/` tree with 23 top-level website files, excluding private staging, backend source and reports.
- The actual source masters remain preserved in this owner-only ZIP. Do not deploy the repository root directly; Task 59 must deploy the clean `public-site/` artifact.
- Current blocking owner decision: content redistribution rights remain unconfirmed. No real source-derived question data is in the public export.
- Current data exclusions: 3,627 unresolved question/option image dependencies and 171 invalid projected records; details/IDs are in `reports/private/build-release-v1.json` and must not be published.
- The unresolved 30-ID discrepancy remains unresolved; no extra IDs were fabricated.

## Task 55 — finish the actual frontend selection flow — COMPLETED WITH VALIDATION LIMITS

- [x] Inspected and edited the actual `practice.html`, `exam.html`, and `app.js`; no mock UI or screenshot substituted for project source.
- [x] Wired the manifest-backed Official Papers picker to the digest/count/schema/private-field-verified shard loader. Metadata stays separate from question text/options.
- [x] Staged a safely allowlisted selected-paper payload, revalidated it with the existing bank validator, preserved manifest release provenance, and connected the selected questions to the existing local preview in `exam.html`.
- [x] Added/repaired selected-paper preview, replace/clear states, loading/error handling and relative project-path-compatible URLs. The filter/count/marks/type/duration computation continues to use loaded bank data.
- [x] Kept online attempts, final scoring and unconfirmed marking policy disabled. `MARKING_RULES_CONFIRMED=false` and `EXAM_ENGINE_AVAILABLE=false` remain unchanged.
- [x] Regenerated `public-site/` with the actual current source. It remains a one-question synthetic placeholder and excludes the staging master, private shard release, backend source and private reports.

**Task 55 verification evidence:**
- Unit suite: **24/24 passed**.
- Manifest loader: **426/426 checks passed**, and all 19 mutation variants detected; mocked fetch only.
- Exam unit suite: **29/29 passed**.
- Release builder: **4/4 passed**.
- Link check: **16 pages, 488 links, 0 broken, 0 duplicate IDs** for both the project and `public-site/` export.
- Exporter reports `placeholder=true`, `public_question_count=1`, `staging_master_copied=false`, `private_backend_copied=false`, `private_reports_copied=false`.
- DOM suite **not run** because `jsdom` was unavailable and the dependency install timed out. Browser smoke test **not run** because Chromium navigation was blocked by the environment policy (`ERR_BLOCKED_BY_ADMINISTRATOR`). No live GitHub Pages or Apps Script deployment was performed. Details: `TASK_STATUS/COMPLETED/TASKS_55.md`.

**Rights limitation:** real source-derived questions stay in the owner-only `private-release/` and staging paths. Redistribution rights remain unconfirmed, so no real question content was moved into `data/` or `public-site/`. Public users see only the synthetic example. The unresolved 30-ID discrepancy remains open.

## Task 56 — owner-approved marking and exam policy gates — IMPLEMENTATION COMPLETED; OWNER APPROVAL STILL BLOCKED

- [x] Separated source review from operational authorization: GATE 2026 is `source_verified_reference_only`; all other years remain unverified. No year is currently eligible for operational scoring.
- [x] Corrected the unsafe prior flag `EXAM_POLICY_APPROVED = true` to `false`. Runtime gates remain fail-closed: `MARKING_RULES_CONFIRMED = false`, `EXAM_ENGINE_AVAILABLE = false`, `SCORING_BACKEND_READY = false`, and `ANSWER_REVIEW_POLICY_APPROVED = false`.
- [x] `marking.profileFor(year)`, `marking.policyStatus(year)`, `exam.policyStatus(year)`, `scoringBlockers(year)`, and `exam.blockers(...)` expose distinct source/reference, unverified, approved-but-blocked, operational, scoring and review statuses. Public config is informational and cannot open runtime gates.
- [x] `awardedMarks` and `scoreResponse` now fail closed in the browser while operational scoring is not enabled; key classification and score awards are reserved for the secure server implementation.
- [x] Updated the actual `exam.html` status panel with a year lookup; it labels GATE 2026 as reference-only, states that unanswered=0 is an interpretation, and displays owner/backend/NAT/answer-review blockers. `online-exam.js` suppresses online start requests while local policy gates are closed; it tells users no request was sent.
- [x] Added `data/EXAM_POLICY_STATUS.json` as a public-safe, informational status snapshot and taught `tools/export_public_site.py` to include only this explicit allowlisted status file (not the publication gate or private data).
- [x] Added regression coverage for fail-closed policy flags, unknown-year behavior, browser score refusal and the year-status controls.

**Task 56 verification:** `node --check app.js`, `node --check online-exam.js`, and `node --check tests/exam.unit.test.js` pass. Updated exam unit suite: **30/30 passed**; unit suite: **24/24 passed**; manifest loader: **426/426 passed and 19/19 mutation variants detected**. Release-builder tests: 4/4 passed. Public export: 23 web files, synthetic placeholder question only, public policy-status snapshot copied, private staging/backend/reports excluded. Project and public-site link checks: each 16 pages / 488 links / 0 broken / 0 duplicate IDs. DOM/browser tests were not run; no live backend or deploy was claimed. The DOM/browser/live-backend suites were not run unless explicitly listed in the package final verification summary.

**Not owner-approved / still blocked:** `ANSWER_KEY_SCORING_SPEC.md` is still DRAFT / NOT APPROVED. No scoring, online attempts or answer review are enabled. Private answer keys are not connected to a live configured key store. NAT boundary inclusivity, numeric syntax/rounding, unanswered scoring interpretation and other `D-xx` / `AK-xx` decisions remain open. This task implemented the gate and status plumbing; it did not approve policy or deploy the backend. Full details: `TASK_STATUS/COMPLETED/TASK56_MARKING_POLICY_GATES.md`.

## Task 57 — private answer-key and server-side scoring integration — IMPLEMENTED IN SOURCE; RUNTIME BLOCKED

- [x] Connected attempt start to the private approved-key loader. Checks paper/year/profile metadata and exact selected-question version/content hash/type/marks coverage before an attempt can be written.
- [x] Added immutable `key_set_id` and `key_set_digest` columns at the END of the attempts schema. New attempts store pins and verify readback. Historical/unmigrated attempts with blank pins are rejected; no key set is retroactively assigned.
- [x] Added server-side global operational gates using the Task 56 policy approval names. Missing/non-true Script Properties stay off; gates are checked before and inside the start lock and before score computation.
- [x] Attempt start also checks relevant detailed `SCORING_POLICY_*` gates so a selected paper cannot begin if unanswered, NAT, or Marks-To-All policy needed for scoring is not approved.
- [x] Scoring validates the key-set id/digest pin and committed-result digest; result summaries stay free of key ids, key digest, correct options, NAT bounds and explanations. Repeated result commits stay idempotent.
- [x] Readiness diagnostics report names/reasons of missing owner gates only; answer review remains blocked by the existing D-18/AK-08 gate.
- [x] Added `tests/task57.server-scoring.test.js`: **10/10 local contract checks passed**.

**Focused verification:** backend `.gs` syntax parse 6/6; unit 24/24; exam unit 30/30; manifest loader 426/426 and 19/19 mutations; release builder 4/4; project and `public-site/` link checks each 488 links / 0 broken / 0 duplicate IDs. See `TASK_STATUS/COMPLETED/TASK57_SERVER_SCORING.md`.

**Task 57 remains active/blocked at runtime:** `ANSWER_KEY_SCORING_SPEC.md` is still DRAFT / NOT APPROVED; relevant global and `SCORING_POLICY_*` properties stay off; no owner DB ids, MAC secret, configured live key set or live GAS deployment were available; `migratePrivateDatabaseHeaders()` has not been run against actual owner Sheets; no live round trip was tested. These actions cannot be simulated by writing source code. Task 58 source safeguards have been prepared per the owner’s explicit request to continue, but live activation/deployment must still wait for these Task 57 owner blockers.


## Task 58 — authentication and account lifecycle — SOURCE IMPLEMENTED; LIVE AUTH BLOCKED

- [x] Harden session storage reads, clear malformed values, clear password fields on login, and attempt server logout if a session was created but browser storage failed.
- [x] Fail-closed protected-page navigation for dashboard/history/bookmarks/profile. Content stays hidden until `session_get` confirms the server session; unauthenticated/unconfigured pages return to login. Only an allowlisted local filename is stored in `sessionStorage` for return navigation; it is never added to the URL.
- [x] Revalidate session on protected-page entry and visible-page resume. Existing `session_get` / server `asSession_()` behavior remains the expiry authority. Logout clears local token state even when remote transport fails.
- [x] Added `AUTH_ENDPOINT_CONFIGURATION.md`, documenting the single private-endpoint location and separating the private auth adapter from the public-catalogue adapter without adding real endpoint IDs or secrets.
- [x] Added `tests/auth.lifecycle.test.js` and included it in the focused test script.
- [x] Checks: auth lifecycle 7/7; unit 24/24; exam unit 30/30; manifest loader 426/426 plus 19/19 mutations; release builder 4/4; source and public-site link checks 492 links / 0 broken / 0 duplicate IDs; `auth.js` syntax passes.
- [ ] Live login/register/email OTP/reset/session refresh still awaits owner endpoint and `AUTH_POLICY_*` configuration; Task 57 operational prerequisites remain unresolved. DOM/browser suite not run because `jsdom` is unavailable. See `TASK_STATUS/COMPLETED/TASK58_AUTH_LIFECYCLE.md`.

**Important:** static page hiding is navigation/UX only. Every private operation must continue to authorize the session in the backend.

## Task 59 — Apps Script / Sheets configuration and runnable deployment package

- [ ] Inspect the actual `Code.gs`, `api.js`, `auth.js`, `exam-api.js` and `private-backend/*.gs` before editing.
- [ ] Make frontend-to-backend transport, operation names, response schemas and error handling consistent. Configure the owner-managed Apps Script projects and spreadsheet Script Properties without fabricating deployment URLs or spreadsheet IDs.
- [ ] Prepare a repository-ready GitHub Pages build and an Apps Script deployment package. Add a GitHub Pages workflow if missing and preserve all original files.
- [ ] Deploy only the `public-site/` output created by `tools/export_public_site.py` (or recreate it in CI), never the repository root: the full owner archive intentionally preserves private staging files.
- [ ] Before a public push, verify the staging masters, `data/PUBLICATION_GATE.json`, `data/.build-release-output.json`, `private-release/` and `reports/private/` are not tracked; if tracked, remove them from the Git index without deleting the owner's local copies.
- [ ] If connected GitHub/Google permissions permit actual deployment, use them only with explicit authority and report the real URL/result. Otherwise, return a ready ZIP and the exact minimal owner actions needed; never claim deployment occurred.
- [ ] Run only quick critical-path checks: app loads, manifest/shard load, practice setup selection works, configured backend operations call the right route, and unconfigured operations fail clearly. Do not spend the sprint primarily on long test suites or documentation.

## Done criteria for the current phase

1. Frontend is usable via a verified GitHub Pages direct URL, or the ZIP is genuinely ready for the owner to publish with exact minimal steps if account access is unavailable.
2. Paper/year/set selection and custom practice setup work against real eligible shard files when publication rights and inputs allow it.
3. The private backend is implemented/configured as far as possible and can run after the explicit owner properties/endpoints are supplied. Any remaining owner action is named precisely; no fake “100% connected” claim.
4. Full project ZIP is returned with all original files, a clear completed/pending task board and the next task prompt updated.
