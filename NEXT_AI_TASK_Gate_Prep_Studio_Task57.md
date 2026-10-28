# NEXT AI TASK — Task 57 finalization: owner-configured scoring validation (blocked)

Use this ZIP as the source of truth. The Task 57 code-level integration is already implemented in `private-backend/ExamService.gs`, `AttemptStore.gs`, `Scoring.gs`, `ScoringService.gs`, `Schemas.gs` and `Readiness.gs`. Do **not** rewrite it or mark Task 57 done based only on local tests.

## Current evidence

- Local Task 57 contract tests: 10/10 passed.
- Unit tests 24/24, exam unit 30/30, manifest loader 426/426 with 19/19 mutations detected, release-builder 4/4, project/public-site link checks each 488 links and zero broken/duplicate IDs.
- `TASK_STATUS/COMPLETED/TASK57_SERVER_SCORING.md` records code and limitations.

## What still blocks closure

1. `ANSWER_KEY_SCORING_SPEC.md` is DRAFT / NOT APPROVED. Do not set `EXAM_POLICY_APPROVED`, `EXAM_POLICY_MARKING_RULES_CONFIRMED`, `EXAM_POLICY_SCORING_BACKEND_READY`, or `EXAM_POLICY_EXAM_ENGINE_AVAILABLE` to true unless the owner has made and recorded the corresponding decisions/readiness.
2. Do not enable `SCORING_POLICY_UNANSWERED_ZERO`, `SCORING_POLICY_MARKS_TO_ALL`, `SCORING_POLICY_NAT_SYNTAX`, `SCORING_POLICY_NAT_BOUNDARIES`, `SCORING_POLICY_NAT_ROUNDING`, or `SCORING_POLICY_MIXED_YEAR` without explicit owner evidence. Start is intentionally blocked when a policy needed by the selected question types is off.
3. No owner Script Properties or live Google Sheets are present in this project copy. The private deployment requires configuration per `private-backend/Readiness.gs` and `private-backend/Setup.gs`; never fabricate IDs, URLs, secrets, or approved key rows.
4. Back up the real private EXAM_DB before running `migratePrivateDatabaseHeaders()` in the actual GAS project. The appended attempt fields are `key_set_id` and `key_set_digest`. Legacy attempts without pins are deliberately not scoreable.
5. Confirm that an owner-approved key set is present and its hashes/coverage match the official immutable question versions; then run readiness and a controlled live start/save/submit/score/get-result test. `get_result_review` stays off until D-18/AK-08 is approved.

## Work rules

- If the owner has not supplied authorization/configuration, leave Task 57 active/blocked and return a ZIP with exact remaining actions. Do not pretend to execute live Google operations.
- Do not proceed to Task 58 as the current task until Task 57 runtime blockers can be cleared. Keep Tasks 60–65 deferred.
- Preserve all original files and private staging data. Do not publish real question content: redistribution rights remain unconfirmed. Public site stays synthetic-only.
- Never expose answer keys, correct options, NAT bounds, explanations, private hashes, or private key-set metadata to the public frontend.
