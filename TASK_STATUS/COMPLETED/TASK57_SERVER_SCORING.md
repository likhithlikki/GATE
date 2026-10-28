# Task 57 — Private answer-key and server-side scoring integration

**Status: implementation integrated and locally verified; operational activation remains blocked.** This is not a claim that the private backend is deployed, connected to real Sheets, or approved to score real exams.

## Implemented in the project source

- The authenticated route chain remains private: `start_attempt` / `save_answers` / `submit_attempt` / `score_attempt` / `get_result` / `get_result_review` are registered in `private-backend/AuthRouter.gs` as session-protected operations. Task 57 changes connect the attempt start and scoring paths to the existing private KeyStore and scoring service; no key data is sent to the frontend.
- `private-backend/Scoring.gs` now checks the four global owner-controlled Script Properties that mirror Task 56 gates: `EXAM_POLICY_APPROVED`, `EXAM_POLICY_MARKING_RULES_CONFIRMED`, `EXAM_POLICY_SCORING_BACKEND_READY`, and `EXAM_POLICY_EXAM_ENGINE_AVAILABLE`. Missing or non-literal-true values remain off; readiness reports only gate names/reasons.
- `private-backend/ExamService.gs` rechecks these operational gates inside the start critical section, loads the current approved key set under the lock, verifies paper/year/profile agreement, and checks every selected question version/content hash/type/marks has matching key coverage. It stores immutable `key_set_id` and `key_set_digest` pins with the attempt and verifies readback.
- Attempt start also blocks when a scoring policy required by the selected paper is not approved: `unanswered_zero` is required for every attempt, NAT syntax/boundary/rounding gates are required for NAT questions, and `marks_to_all` is required when a key is of Marks-To-All kind. This prevents starting a session whose policy would necessarily prevent scoring.
- `private-backend/Schemas.gs` appends `key_set_id` and `key_set_digest` to the attempts schema. `private-backend/AttemptStore.gs` refuses historical/unmigrated attempts without these pins instead of retroactively assigning a current key set.
- `private-backend/ScoringService.gs` validates the pinned key-set identity/digest against the approved loader result and the committed result header, rejects mismatches, and preserves the existing result commit/readback/idempotency design. Existing result summaries do not include key ids, key-set digests, accepted NAT bounds, correct responses, or explanations.
- `private-backend/Readiness.gs` reports the new global gates without exposing property values/secrets. `get_result_review` remains separately blocked by the existing owner gate for D-18/AK-08.
- Added `tests/task57.server-scoring.test.js` for policy gates, policy-specific start prerequisites, pin mismatch, legacy unpinned rows, route guards, review gating, and public/private source separation.

## Local verification evidence

| Check | Result |
|---|---:|
| Task 57 local contract checks | **10/10 passed** |
| Existing unit suite | **24/24 passed** |
| Exam unit suite | **30/30 passed** |
| Manifest loader | **426/426 checks passed**; **19/19** invalid mutations detected |
| Release builder tests | **4/4 passed** |
| Link check (project) | **488 links; 0 broken; 0 duplicate IDs** |
| Link check (`public-site/`) | **488 links; 0 broken; 0 duplicate IDs** |
| JavaScript syntax parse of 5 touched private `.gs` files | **5/5 passed** (`node --check` syntax check only, not a GAS runtime validation) |

The contract suite uses a local Node VM and mocked Script Properties. It is not a live Google Apps Script, Google Sheets, browser, or deployed backend integration test. DOM/browser suites and the separate backup test were not run in this checkpoint.

## Still blocked — do not fake completion

1. `ANSWER_KEY_SCORING_SPEC.md` remains **DRAFT / NOT APPROVED**. Do not set `EXAM_POLICY_APPROVED=true` or `MARKING_RULES_CONFIRMED=true` until explicit owner decisions/evidence resolve the applicable `D-xx` / `AK-xx` questions.
2. All relevant `SCORING_POLICY_*` Script Properties remain closed by default. Required decisions include unanswered scoring interpretation; Marks-To-All; and NAT syntax, boundaries and rounding when those question types are present. Do not enable gates merely to make an exam start.
3. The private Apps Script project has not been connected to owner-provided live Google Sheets in this work. Required properties include `AUTH_DB_ID`, `EXAM_DB_ID`, `KEYS_DB_ID`, `KEY_ROW_MAC_SECRET_V1`, the existing auth/security properties, `PUBLIC_CATALOGUE_SPREADSHEET_ID`, and `QUESTION_LICENSE_REF` as documented in `private-backend/Readiness.gs`. Values are intentionally not present in the source ZIP. `EXAM_POLICY_QUESTION_PUBLICATION` is also a separate prerequisite for backend question access and must not be enabled until the corresponding source/license eligibility is resolved.
4. The owner must back up the private EXAM_DB, then run `migratePrivateDatabaseHeaders()` in the actual private GAS project to append the two new attempt columns. This code environment cannot migrate the owner's Sheets. Existing historical attempts with blank pins deliberately remain unscorable.
5. No approved real key set is confirmed in the live key store, and no live start/save/submit/score/get-result round trip has been run. No deployment URL or spreadsheet ID has been invented.
6. The public site still contains only the synthetic placeholder. Real question redistribution rights remain unconfirmed; no answer keys or source-derived questions are added to public files.

## Next action

**Keep Task 57 active/blocked.** After the owner has approved the policy decisions and configured/backed up the private Apps Script/Sheets environment, run the platform readiness check, perform `migratePrivateDatabaseHeaders()`, verify approved key-set coverage and properties, and execute a controlled live integration test. Only once those checks succeed should Task 57 be closed and Task 58 become the next task. Tasks 60–65 remain deferred.
