# Task 49 — Manifest-driven paper/year question loader

## Package basis

The requested baseline `gate-prep-studio (43).zip` and the continuation package `gate-prep-studio (44).zip` were both available for inspection. The (43) ZIP contains 68 archive entries; (44) preserves every (43) path, changes four existing files, and adds `tests/manifest.loader.test.js`. This final package is built from (44), so it retains the full baseline project plus the Task 49 implementation, with this report and an updated explanatory comment in `app.js`.

The compared Task 49 files are:
- `app.js`: manifest-driven validation and lazy-loading implementation.
- `practice.html`: Official papers paper/year/set picker and load status UI.
- `tests/dom.test.js`: legacy fallback harness adjustment plus 3 manifest-page tests.
- `tests/package.json`: adds the Task 49 loader test to the test command.
- `tests/manifest.loader.test.js`: newly added focused synthetic loader tests and mutation controls.

No original (43) files were removed. The final ZIP contains all files from (44), plus `TASK49_IMPLEMENTATION_REPORT.md`. No real question-bank extraction output, generated production questions, `data/manifest.json`, or production shard files were added.

No Apps Script backend, OAuth scope, answer-key handling, scoring policy gate, or backup implementation was changed for this task.

## Task 49 behaviour verified in source

- Validates the schema-versioned manifest before any shard fetch and rejects missing metadata, unknown fields, duplicate shard IDs/paths/identities, malformed paper/year/set values, unsafe paths and invalid digest formats.
- Builds paper/year/set choices from the manifest and supports distinct files for official sets.
- Fetches only selected shard paths, checks SHA-256, schema, declared count, record validity, duplicate question IDs and answer-related/private fields.
- Treats a missing/invalid shard or any partial failure as a failed selection with zero accepted records.
- Uses `data/questions.json` only when the manifest is absent (HTTP 404/410); invalid or unreachable manifests do not silently fall back.
- Keeps the local file-import path separate; its 5 MB and 2,000-record limits and public-safe checks remain covered by the existing tests.
- Adds only clearly synthetic, in-memory fixtures in tests; no fake production data is packaged.

## Validation performed in this packaging run

| Check | Result |
|---|---|
| `node --check app.js` | PASS |
| `node unit.test.js` | PASS — 24/24 |
| `node manifest.loader.test.js` | PASS — 423/423 checks; 19/19 mutation controls detected |
| `python3 linkcheck.py ..` | PASS — 16 pages, 488 links checked, 0 broken links, 0 duplicate HTML IDs |

## Failures and tests not completed

- `node exam.unit.test.js`: 28/29. The single failing assertion expects `auth.js` not to exist, while the project includes `auth.js`. I reran this test against the (43) baseline and it fails there the same way, confirming it is pre-existing. Neither `auth.js` nor the test was modified.
- `node dom.test.js`: not completed in this packaging run because `jsdom` was not installed. An `npm ci --ignore-scripts --no-audit --no-fund` attempt timed out; `tests/package.json` and `tests/package-lock.json` declare jsdom. The continuation log provided with the task reported the 3 new Task 49 DOM cases passing in an earlier run, but that DOM run could not be reproduced here; the full DOM result therefore remains unverified in this run.
- `node backup.empty-tab.test.js`: attempted, but this packaging run exceeded the 120-second command timeout before all mutation controls completed. The continuation log supplied with the task reports 478/478 checks and 36/36 mutations passing earlier; this was not reproduced to completion here.
- The full `npm test` chain was not completed because the exam unit test has the pre-existing assertion failure and the DOM dependency was unavailable.
- No real browser/host, GitHub Pages, static deployment, or production deployment was tested or claimed.

## Remaining limitations

- There is intentionally no production `data/manifest.json` or shard data in this ZIP; data publication is a separate step.
- Paper codes are checked for the required two-uppercase-letter format; a hard-coded list of official codes is intentionally not used so the manifest remains extensible. Publishers must list only valid official GATE paper codes.
- If a browser cannot calculate SHA-256, a shard is rejected rather than trusted.
- Manifest and shard files must be published consistently; missing or mismatched files intentionally fail as a whole instead of appearing as a complete result.


## Dataset integration addendum (later packaging step)

No original (43) project files were removed. The final ZIP retains the Task 49 project and, following a later explicit request, now also includes the sanitized complete staging dataset at `output/website-all-questions-staging.json` and an identical webapp staging copy at `data/questions-staging-v1.json`. The answer/solution-bearing legacy `data/questions.json` provided in the separate data ZIP was deliberately excluded. This staging add-on does not create a production `data/manifest.json` or paper/year shard files; see the dataset integration addendum below.

## Complete staging dataset added (later user request)

Two identical, sanitized dataset files are now included in the package:

- `output/website-all-questions-staging.json` — master staging dataset.
- `data/questions-staging-v1.json` — staging copy under the app data directory.

Validation performed for these files:

- JSON `schema_version: 1`; `15110` questions and `15110` unique IDs.
- No duplicate IDs.
- Recursive private-key scan found no answer, solution, correctness, raw-source, source-file, source-ID, or quality-flag fields.
- The two bundled copies are byte-identical (SHA-256 `caf9eb63c5fbf053e04e9fdd917b2e411fd4e65bd722fdc6f4772594732ca000`).
- Source mapping status counts: {'paper_year_confident': 13900, 'paper_topic_only_no_year': 1145, 'ambiguous_identity_needs_review': 60, 'generic_topic_no_paper_year': 5}.
- Data-quality flags in the complete master: 4 questions with missing text, 65 without a paper branch, 4 flagged for image review.

**Important limitation:** these files are a complete private staging dataset, not a manifest/shard release. The Task 49 official-paper picker loads `data/manifest.json` and then explicit `data/papers/...` shards. This add-on intentionally does not synthesize paper/year identities for unresolved records, and `questions-staging-v1.json` is not automatically loaded by that picker. To activate the Task 49 loader, a separate release-preparation step must create and validate manifest-compliant public-safe shards for records with confirmed identities and handle incomplete records without presenting partial papers as complete.

The separately uploaded `data/questions.json` was not included because it contains answer/solution-bearing fields. No deployment was performed.

