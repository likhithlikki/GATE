# Task 55 — Complete the actual practice/custom-test frontend

**Status:** Completed in code; runtime/browser verification is partially constrained by the local environment.

## Implementation delivered

- Connected the existing manifest-backed Official Papers picker to the actual safe question payload, not just paper metadata. Shard payload is copied through an explicit allowlist only after the existing manifest digest, count, schema, paper/year/set, duplicate-ID and private-field checks succeed.
- Kept `records` as metadata-only for the catalogue/filter contract. Question text and MCQ/MSQ option text are held separately in `questions`, then revalidated by the existing local-bank validator before being staged for the current browser tab.
- Implemented a selected-paper local-preview action and reuse of the existing `exam.html` local preview flow. Replacing a selected manifest paper is supported; local file/external catalogue sources must be cleared first rather than silently mixing banks.
- Added manifest provenance (`origin: manifest`, release ID) to the tab-scoped handoff. `exam.html` freshness UI identifies this as a digest/count/schema/public-safe static release, not an online attempt or server-persisted session.
- Updated selected-paper/loaded-bank controls and empty/loading/error handling. The exam engine/marking gates remain off (`MARKING_RULES_CONFIRMED=false`, `EXAM_ENGINE_AVAILABLE=false`).
- Updated `public-site/` through `tools/export_public_site.py`. It remains a synthetic demo only: one visibly synthetic placeholder question. It does not contain the private staging master, private-release shards, backend source, or private reports.

## Verification

- `node --check app.js`, `node --check tests/dom.test.js`, `node --check tests/exam.unit.test.js`: passed during implementation.
- `node tests/unit.test.js`: **24/24 passed**.
- `node tests/manifest.loader.test.js`: **426/426 checks passed; all 19 mutation variants detected**. This uses mocked fetch and is not a real-browser test.
- `node tests/exam.unit.test.js`: **29/29 passed**.
- `python tests/test_release_builder.py`: **4/4 passed**.
- Link check against the project and clean `public-site/` tree: **16 HTML pages, 488 links, zero broken links, zero duplicate IDs**.
- `python tools/export_public_site.py`: passed; reported `placeholder=true`, `public_question_count=1`, and staging/private backend/private reports all excluded.
- DOM suite: **not run**. Installing its `jsdom` dependency timed out and `jsdom` was not available.
- Browser/E2E smoke test: **not run**. Chromium navigation was blocked by the environment's browser policy (`ERR_BLOCKED_BY_ADMINISTRATOR`).
- GitHub Pages and Apps Script deployment/live calls: **not performed**; no live URL or backend deployment is claimed.

## Known limitations / next work

- Public data contains only the synthetic placeholder because redistribution rights for source-derived question text/options remain unconfirmed. The private 152-shard, 10,098-record release remains owner-only under `private-release/`.
- Paper/year/set choices in the public build therefore demonstrate the current placeholder only. Wider real-paper choice depends on an authorized release manifest; do not move private source-derived text into `public-site/` until the owner confirms rights.
- The 30-ID mismatch between the 15,110-record staging master and prior 15,140 extractor summary remains unresolved. No IDs or paper identities were invented.
- Owner-approved marking policy, secure server-side scoring, authentication lifecycle, and deployment remain Tasks 56–59. Tasks 60–65 remain deferred.
