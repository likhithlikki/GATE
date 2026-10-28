# NEXT AI TASK — GATE Prep Studio — Task 59

You are continuing the existing GATE Prep Studio source project. Start with the attached `gate_prep_studio_task58.zip` (or the latest full project ZIP if the owner gives you a newer checkpoint). Inspect its actual source and task tracker before editing. **Do the implementation in this task; do not respond with only a plan.** Preserve the whole owner archive and private staging master byte-for-byte unless a specific authorized task requires otherwise.

## Current facts

- Task 57 server-side scoring/key pinning is implemented in source but remains operationally blocked: the scoring spec is DRAFT/NOT APPROVED, relevant owner `EXAM_POLICY_*` and `SCORING_POLICY_*` gates remain OFF, owner Google Sheet IDs/secret properties/approved key set/live deployment are unavailable, and no live Apps Script round trip was validated. Do not turn these gates on or mark Task 57 operationally complete.
- Task 58 auth/account lifecycle source safeguards are implemented and locally checked. The private auth endpoint remains `REPLACE_WITH_PRIVATE_AUTH_WEB_APP_URL`, and owner `AUTH_POLICY_*` gates remain OFF. A live auth flow is not yet verified.
- Task 54 created a public release containing one visibly synthetic question. Real extracted question data remains private because redistribution permission is not confirmed.
- The top-level `auth.js` private auth endpoint is separate from the top-level `api.js` public-catalogue endpoint. Only top-level website files plus the explicitly allowed public data should be deployed to GitHub Pages.
- Tasks 60–65 are deferred by the owner; do not start them.

## Task 59 scope

1. Inspect actual `Code.gs`, `api.js`, `auth.js`, `exam-api.js`, `private-backend/*.gs`, `tools/export_public_site.py`, `.gitignore`, and generated `public-site/` before changing anything.
2. Make browser adapters, Apps Script operation names, request/response envelopes and error handling consistent for only the operations actually implemented. Do not invent an endpoint, spreadsheet ID, consent version, policy approval or secret.
3. Prepare a repository-ready GitHub Pages build and Apps Script deployment package. Add a GitHub Pages Actions workflow if missing, but ensure it publishes only `public-site/` (regenerated from `tools/export_public_site.py`), never the private project root.
4. Protect public/private boundaries. Before any publish, inspect tracked paths and ensure `data/questions-staging-v1.json`, `output/website-all-questions-staging.json`, `data/PUBLICATION_GATE.json`, `data/.build-release-output.json`, `private-release/`, `reports/private/`, private backend source, tests and task/audit reports are not in the Pages artifact. Never delete the owner's private local data just to hide it from the artifact. Do not publish real question content unless an explicit source-rights approval is present and confirmed by the owner.
5. Keep secrets and private database IDs in Apps Script Script Properties. The frontend may contain the relevant deployed `/exec` URL only in its specific adapter constant (`auth.js` for private auth; `api.js` only for public catalogue), once the owner actually supplies the URL. Do not put URLs/IDs/secrets into unrelated files.
6. Add a small, reproducible package/build check for export allowlisting, subpath-compatible relative links, and fail-closed behavior when endpoint placeholders remain. Run the minimum critical-path checks; do not turn this into a long test/docs-only sprint.
7. If authorized connected GitHub/Google tools are actually available and the user has given deployment authority, deploy and report the real URL/result. Otherwise do not claim deployment. Return a ready ZIP and the exact minimal owner steps: create/choose the two script projects, set the documented properties, deploy private web apps, set the correct endpoint constants, verify a test account/attempt round trip, and publish only the safe `public-site/` artifact.
8. Update `TASK_STATUS/TASK_BOARD.json`, `TASK_STATUS/PENDING/ACTIVE_BUILD_TASKS_50-59.md`, completed evidence, and `NEXT_AI_TASK.md`. Keep Task 57 flagged as operationally blocked until its real owner decisions/properties/migration/round-trip are done. Keep Tasks 60–65 deferred.
9. Return the **complete updated ZIP** preserving original project files and staging masters. Include the next-step prompt for Task 60 only if the owner changes the deferral; otherwise leave Task 60 in the deferred tracker and point the immediate owner action at unresolved Task 57/58 deployment dependencies. Run `zipfile.testzip()` or equivalent and report actual test results and limitations.

## Acceptance requirements

- Do not assert that GitHub Pages or Apps Script is live unless the deployed URL was directly verified.
- Do not silently change any owner approval gate from false to true.
- Do not include real staging data or answers in the public artifact.
- Do not claim 100% readiness when owner endpoints, properties, DB IDs or live validation are missing.
- Deliver the ZIP and an accurate tracker in this response.
