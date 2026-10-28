# GATE Prep Studio — Production Roadmap (Tasks 50–65)

## Verified handoff baseline

Use **`gate-prep-studio-with-staging-dataset.zip`** as the latest handoff archive available from the previous work. It is based on the Task 49 project and contains the Task 49 loader, test/report files, and two sanitized staging copies. Do not start from `gate-prep-studio (40).zip` unless explicitly comparing history: (40) predates the later Task 48/49 work.

Relevant files in the latest archive:

- `private-backup/Backup.gs`: Task 48 bounded fingerprint-range implementation is present. Each range is segmented to at most `BK_FP_CHUNK_CELLS = 5000`; version 2 and `gps-tab-sha256-v1` remain unchanged.
- `tests/backup.empty-tab.test.js`: contains Task 46/48 coverage, including 5,001- and 18,278-column tabs, independent digest reference, changed last-cell checks, and zero-write verification checks.
- `app.js`, `practice.html`, `tests/manifest.loader.test.js`: Task 49 manifest loader and paper/year/set picker are implemented.
- `data/questions-staging-v1.json` and `output/website-all-questions-staging.json`: identical, sanitized staging dataset; 15,110 records.
- `TASK49_IMPLEMENTATION_REPORT.md`: Task 49 behavior and known test/deployment limitations.

## Confirmed blockers from inspection

1. There is **no production `data/manifest.json` or `data/papers/...` release**. Task 49's UI therefore cannot list/load the real published paper/year shards yet. `questions-staging-v1.json` is not automatically consumed by the manifest-driven picker.
2. Staging has 15,110 unique IDs but is not release-clean: mapping status counts are 13,900 `paper_year_confident`, 1,145 `paper_topic_only_no_year`, 60 `ambiguous_identity_needs_review`, and 5 `generic_topic_no_paper_year`; 4 questions have missing text, 65 lack a paper branch, and 4 are flagged for image review.
3. The separate extraction audit summary reports a different unique-ID total (15,140) and outstanding conflicting-ID groups/answer warnings. This discrepancy must be reconciled against the 15,110 staged records before declaring the dataset complete.
4. `api.js` and `auth.js` contain placeholder Apps Script endpoint URLs. Backend deployment and browser-to-backend connectivity are unverified.
5. `app.js` still has `EXAM_ENGINE_AVAILABLE = false` and `MARKING_RULES_CONFIRMED = false`; real online scored exams are not enabled.
6. Owner/security decisions still gate launch, including marking scheme and duration decisions, content rights/licensing, workload target, legal/privacy review and Google Sign-In acceptance/configuration.
7. Task 49's report records successful focused manifest tests (423/423 and 19/19 mutation controls), 24/24 unit tests and a 488-link check. It also documents a baseline exam-test assertion failure, an uncompleted jsdom DOM test run in the final packaging run, an earlier timed-out backup suite in that packaging run, and no live hosting/deployment validation. Re-run the full regression suite in an environment with dependencies installed.

**Readiness conclusion:** the project is not 99% production-ready. Source implementation is substantial, but the public dataset release, live backend wiring, policy decisions, end-to-end scored exam, operational testing and deployment are not complete/verified. Do not assign a numeric completion percentage without a measured acceptance checklist.

---

# Sequential task plan

For every task: inspect the actual ZIP before editing, preserve all files, avoid unrelated refactoring, keep credentials/secrets out of source, run targeted tests plus applicable regressions, report exact passed/failed/not-run counts, and return a complete updated ZIP and a concise report. Never claim live Google or production-hosting validation unless actually performed. Do not use synthetic test data as production data. Do not modify OAuth scopes or Apps Script manifest files unless a separately approved task explicitly requires it.

## Task 50 — Baseline freeze and dataset reconciliation

**Prompt to AI:**

> Inspect `gate-prep-studio-with-staging-dataset.zip` before editing. Preserve the complete project. Establish a reproducible baseline report for archive integrity, file list, checksums, test inventory, Task 48/49 code, staging dataset and extractor audit summaries. Reconcile why the staging dataset has 15,110 records while the full-mirror audit reports 15,140 unique IDs. Do not delete, merge or rewrite records based only on counts. Produce an ID-level reconciliation (staged-only, extraction-only, matching, duplicate/conflict groups), map the outstanding 29 conflict groups/88 records and answer-validation warnings if their files are included, and identify which report/file is authoritative. No public release or app behavior changes in this task. Re-run safe offline checks where practical and state unavailable tests clearly. Return complete ZIP plus baseline/reconciliation report.
>
**Done when:** counts reconcile by ID or every discrepancy has a documented reason and review status; full archive remains intact.

## Task 51 — Source rights, provenance and release eligibility

**Prompt to AI:**

> Add a source-by-source release eligibility register for every intended question source: source identity, owner/rightsholder, license/permission evidence, attribution requirements, allowed public use, asset/image rights, reviewer, status and evidence reference. Do not assume that publicly accessible GATE papers can be republished. Exclude sources without documented approval from the candidate public release builder, but preserve them in private staging. Do not provide legal conclusions or fabricate license evidence. Flag decisions that require owner/legal confirmation. Do not change backend/auth/scoring or publish data.
>
**Done when:** every candidate source has traceable rights status, and an explicit deny-by-default release gate exists.

## Task 52 — Final question/content quality triage

**Prompt to AI:**

> Use the Task 50 reconciled IDs and Task 51 release register. Resolve or explicitly quarantine all conflicting question IDs, the 60 ambiguous identity records, 1,145 topic-only/no-year records, 5 generic records, 4 missing-text records, 4 image-based records, and answer-validation warnings. Do not guess official paper/year/set identity or answers. Preserve all source records and create auditable row-level decisions with evidence. Where an issue requires human judgment, leave it `REVIEW_REQUIRED` and block it from publication. No public production dataset yet.
>
**Done when:** each source record has an explicit keep/review/exclude reason, with no silently discarded records.

## Task 53 — Deterministic public-release builder

**Prompt to AI:**

> Implement or repair a deterministic, repeatable release-builder that reads only the approved records from Tasks 50–52 and emits the public-safe schema already required by Task 49. Use an explicit allowlist of public fields. Reject answer keys, solutions/explanations, NAT accepted ranges, correctness/grading fields, raw source, private IDs/paths, and unknown fields recursively. Keep private answer-key data in its separately approved private store. Preserve canonical IDs and paper/year/set identity. Add focused unit tests for unsafe-field rejection, missing metadata, invalid questions, deterministic output, and no source mutation. Do not create fake production records or publish the release.
>
**Done when:** identical inputs and approvals produce byte-stable release artifacts and unsafe records fail closed.

## Task 54 — Build production manifest and paper/year/set shards

**Prompt to AI:**

> Generate a release candidate using Task 53. Create `data/manifest.json` and explicit `data/papers/<CODE>/<YEAR>.json` or `data/papers/<CODE>/<YEAR>/<SET-FILE>.json` shards. Use only confirmed official GATE paper codes and verified year/set identity. Every manifest entry must have schema version, release ID, paper code/name, year, optional variant, explicit safe relative path, expected question count and lowercase SHA-256 digest. Every shard must use `schema_version: 1` and `questions`. Never put answers, explanations, NAT ranges or scoring fields in public files. Keep the 1,145 no-year rows and all other unresolved/ineligible rows out of year-specific shards, with a report explaining exclusions. Validate count/digest/ID uniqueness and that every manifest entry maps to exactly one file. Do not deploy.
>
**Done when:** a production-candidate manifest/shard tree passes independent validation and has an auditable release report.

## Task 55 — Connect real shards to the practice/custom-test setup

**Prompt to AI:**

> Starting from Task 49's loader, integrate the approved manifest/shards from Task 54 into the actual practice and exam setup UI. Verify paper/year/set choices populate from manifest data; selected shards load only on demand; branch, year, subject, topic and MCQ/MSQ/NAT filters use the loaded records; official variants never get merged indistinguishably. Wire filtered questions into the custom-test setup so a user can choose a permitted question count, see available/matching count and summary, and choose fixed-order or random-without-replacement selection according to the approved policy. Keep local file import separate and preserve its 5 MB/2,000-record limits. Do not enable server scoring or change answer-key handling.
>
**Done when:** real release data (not synthetic fixtures) can be selected and previewed locally, including zero-match, missing-shard and official-set cases.

## Task 56 — Owner-approved marking and exam policy

**Prompt to AI:**

> Do not invent policy defaults. Use the current `ANSWER_KEY_SCORING_SPEC.md` and `SECURITY_DECISION_REVIEW.md` to prepare a compact decision worksheet for the owner covering MCQ wrong-answer penalties, MSQ credit rules, NAT tolerance, marks, missing/disputed keys, explanation visibility, option order, full mock composition, random subsets, attempt limits and duration for 100-mark papers. Identify which decisions already have an explicit answer and which remain open. Implement policies only after approval, using versioned policy profiles linked to official source/year and tests. Keep `MARKING_RULES_CONFIRMED` false until all required decisions and parity tests pass.
>
**Done when:** every score-affecting policy has evidence, an owner-approved value, a version, and tests; otherwise exam starts remain blocked.

## Task 57 — Private answer-key and server-scoring integration

**Prompt to AI:**

> Audit the existing private Apps Script key store, staging/import functions and scoring modules against `ANSWER_KEY_SCORING_SPEC.md`. Implement only missing pieces required by approved Task 56 decisions. Keep answer keys, accepted NAT ranges and explanations server-side; public catalogues, manifests, static files, browser responses and logs must never expose them before the approved reveal state. Add canary tests that search every public operation/state for a synthetic private marker, plus key provenance, two-entry verification, revisions, invalid/missing/disputed-key fail-closed behavior, idempotency and score revision tests. Do not create an admin API or modify OAuth scopes. Keep exam engine disabled until complete.
>
**Done when:** private key import, attempt scoring, result retrieval and answer reveal are tested end-to-end in a non-production Apps Script test project.

## Task 58 — Authentication and account lifecycle completion

**Prompt to AI:**

> Audit `auth.js`, `AuthCore.gs`, `AuthService.gs`, `AuthRouter.gs`, registration/reset pages and security decisions. Replace no URL values with guesses. Implement or finish the approved password/OTP/session/Google Sign-In/account-linking flows, request validation, one-time use, replay protection, rate limiting and revocation under the documented policy. Resolve open security decisions with the owner; where approval or provider configuration is missing, leave the feature disabled and document it. Add tests for abuse limits, expired/replayed OTP/session, wrong audience/issuer/expiry, account linking, logout/password change and quota failure. Do not expose secrets in frontend code or change OAuth scopes without explicit approval.
>
**Done when:** auth works against a dedicated test deployment with negative/security cases passing; production credentials stay outside the ZIP.

## Task 59 — Apps Script provisioning and endpoint configuration

**Prompt to AI:**

> Create an owner-run provisioning/deployment checklist for the public API, private auth service, exam/scoring service and backup project. Verify required spreadsheet IDs, property names, owners, access roles, trigger assumptions, deployment URLs and `Readiness.gs` results. Replace endpoint placeholders only in a local deployment configuration approved for the relevant environment; never place secrets or real IDs in a public ZIP. Preserve all three `appsscript.json` files and OAuth scopes. Add a configuration audit script that reports presence/format without printing secret values. Do not claim a deployment exists until the owner runs and confirms it.
>
**Done when:** separate test environment configuration is complete and all deployment/readiness outputs are recorded without secrets.

## Task 60 — Browser end-to-end and regression suite

**Prompt to AI:**

> Install declared test dependencies reproducibly in the test workspace and run the complete existing suite plus Task 48/49 tests. Fix only defects proven to be in scope; document baseline failures with a baseline comparison rather than silently changing tests. Add browser E2E coverage for manifest selection, each filter, random sample size, test summary, interrupted network, bad digest/count, partial shard failure, import size/count limits, login/logout, start/save/submit/reconnect, timer/deadline and results. Use only synthetic fixtures for tests and make fixtures clearly synthetic. Record exact pass/fail/skip numbers and environment.
>
**Done when:** there is a repeatable single test command with all in-scope tests passing and any external-service tests explicitly isolated.

## Task 61 — Security, privacy and legal launch gate

**Prompt to AI:**

> Cross-check all live flows against `SECURITY_DESIGN.md`, `SECURITY_DECISION_REVIEW.md`, `ANSWER_KEY_SCORING_SPEC.md`, privacy.html and terms.html. Prepare a launch checklist covering legal review, age policy, data protection obligations, rights/licensing, retention/deletion, incident response, security contact, data minimisation, CSP/XSS/CSRF posture, endpoint trust, Google OAuth origins/consent status, quotas, abuse controls and account/data deletion. Fix concrete code/document inconsistencies that are within the project scope; send unapproved legal/owner decisions back as blockers rather than answering them yourself. No public launch until required sign-offs are recorded.
>
**Done when:** no critical launch decision is silently assumed; owner/legal sign-offs are auditable.

## Task 62 — Capacity, quotas and performance validation

**Prompt to AI:**

> Ask for or use explicitly documented workload targets; do not invent peak users/concurrency. Implement a repeatable load/performance test plan for static shard loading and Apps Script/Sheets endpoints, including concurrent starts, answer saves, OTP traffic, result scoring and rate-limit contention. Measure latencies, error rates, quota consumption and spreadsheet growth against owner-approved go/no-go thresholds. Document the migration trigger/plan if Apps Script and Sheets cannot meet targets. Do not use production users or real private data in load tests.
>
**Done when:** measured capacity is compared to approved thresholds, and limits/failure behavior are documented.

## Task 63 — Backup, verification and recovery operational drill

**Prompt to AI:**

> Re-run Task 46, Task 47 and Task 48 focused tests plus the complete `backup.empty-tab.test.js` suite. Confirm every fingerprint range is ≤ 5,000 cells, version-2 digest compatibility, empty-tab semantics, strict timestamps and zero writes in verification. Then run a controlled, owner-approved non-production live Google Drive/Sheets backup and restore drill, checking privacy permissions, complete/incomplete manifests, copied content hashes, `BACKUP_VERIFY_RUN_FOLDER_ID` behavior and recovery evidence. Never modify or delete historical backups/manifests. Do not claim live validation if credentials/service access is unavailable.
>
**Done when:** offline tests pass and a separate non-production recovery drill is evidenced, or the live drill remains an explicit blocker.

## Task 64 — Deployment pipeline, release promotion and rollback

**Prompt to AI:**

> Add a reproducible release process for the static webapp (e.g., GitHub Pages if the owner selects it) and separately versioned Apps Script deployments. Ensure the selected release contains only approved public assets, manifest/shards and frontend files—never raw extraction outputs, answer keys, private configs, service credentials, test data marked synthetic or local filesystem paths. Include staging validation, cache/digest consistency, smoke tests, rollback to the last known-good release, and a checklist for publishing the manifest only when all referenced shards are already available. Test a staging deployment first, not production.
>
**Done when:** staging deployment and rollback are verified, with explicit owner approval required for production promotion.

## Task 65 — Final release acceptance and operations handoff

**Prompt to AI:**

> Run the final launch acceptance checklist across data provenance, release counts, manifest/shard integrity, UI filters/custom-test selection, auth, server-side exam timing/scoring, privacy/security, load thresholds, backups and restore, accessibility/basic device behavior, monitoring and rollback. Produce a release manifest/checksums, test report, known-limitations list, owner runbook, incident/revocation steps and rollback procedure. Confirm exact code/data versions. If any legal, licensing, auth, scoring, capacity, backup or deployment gate is unverified, mark the release **NOT READY** rather than rounding up to 99%. Return the complete ZIP and final report.
>
**Done when:** all required acceptance gates are evidence-backed and the owner approves production promotion.

---

## Count and order

- Task 48: bounded fingerprint reads — implementation present; focused test cases are in the project. Re-run the full backup suite in Task 63 because final packaging reports noted a timeout.
- Task 49: manifest-driven loader — implementation present; production manifest/shards and real-data integration remain outstanding.
- **Remaining planned tasks: 16 (Tasks 50–65).** Some owner/legal decisions and rights review are approval gates, not tasks an AI can autonomously sign off. Tasks 50–54 should precede public data publication. Tasks 56–59 require owner decisions and a dedicated non-production service environment. Tasks 60–65 are verification and release gates.

## Current files to give the next AI

1. `gate-prep-studio-with-staging-dataset.zip` — latest complete project package from the prior handoff.
2. The reconciled source extraction/audit/resolution files, if Task 50 needs to reproduce the 15,110 vs 15,140 count difference.
3. This roadmap file.

Always require the next AI to inspect the uploaded ZIP itself, preserve the entire project and return the complete ZIP plus test report after each checkpoint.
