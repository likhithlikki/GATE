# Completed Tasks 50–54 — Data Release Checkpoint

Checkpoint date: 2026-10-28  
Base archive: `gate-prep-studio-task50.zip`  
Private staging master: preserved byte-for-byte at `data/questions-staging-v1.json` and `output/website-all-questions-staging.json`.

## Task 50 — Baseline and dataset reconciliation

Completed in the previous checkpoint. `tools/audit_staging.py` and `reports/private/staging-audit-v1.json` retain the verified 15,110-record/15,110-unique-ID counts. The earlier extractor count of 15,140 remains unexplained; no IDs were invented.

## Task 51 — Source rights and public-data gate — IMPLEMENTED

- `data/PUBLICATION_GATE.json` defaults to `redistribution_confirmed: false`, with no approval reference.
- `tools/build_release.py --mode public` generates synthetic placeholder data by default.
- `--publish-real` is refused unless the gate is confirmed and has a non-empty `approval_reference`.
- **Owner decision still pending:** rights have not been confirmed. Do not publish real source-derived question text/options yet.

## Task 52 — Minimum quality triage — IMPLEMENTED

The deterministic builder requires `mapping.status == paper_year_confident`, a verified two-letter branch and valid year, non-conflicting identity, non-empty question text, no `requires_image_review`, and no unresolved image reference in question text/options. It validates the projected record against the same public record shape expected by `app.js` and excludes invalid records with reason/ID-only private report entries.

The private audit keeps the known groups distinct: 60 ambiguous identity rows, 5 generic/no-paper rows, 1,145 topic-only/no-year rows, 4 missing-text rows and 4 image-review rows. Topic-only rows remain in private staging/review; no year or paper identity is invented. The unexplained 30-ID gap remains open.

## Task 53 — Deterministic release builder — IMPLEMENTED

- `tools/build_release.py` emits explicit allowlisted fields only: `id`, `branch`, `year`, `subject`, `topic`, `type`, `marks`, `text`, option `{id,text}`, and `source.name`.
- Duplicate source IDs abort before release; each emitted row and shard is validated; any private answer/scoring field is rejected; shard count and SHA-256 are recorded.
- JSON ordering and release output are deterministic.
- `tests/test_release_builder.py`: 4/4 pass.
- Private review/build report: `reports/private/build-release-v1.json` (IDs/counts only; PRIVATE).

## Task 54 — Manifest, shards and safe site export — IMPLEMENTED

### Public/default build

- `data/manifest.json`: `schema_version: 1`, `placeholder: true`, one explicitly marked synthetic demo shard.
- `data/papers/ZZ/2099.json`: one invented-for-demo question; paper name says it is **not an official GATE paper**.
- `data/questions.json`: matching synthetic fallback fixture only.
- Manifest validator accepted the manifest. Shard digest/count/schema checks passed.

### Private owner-only build

- `private-release/data/manifest.json` and 152 source-derived shards.
- 10,098 rows passed the current app schema and data-quality gate. Exclusions: 1,145 topic-only/no-year, 60 ambiguous, 5 generic, 4 blank-text, 3,627 unresolved question/option-image dependencies, and 171 invalid public-shape rows (164 blank topics and 7 MCQs with only one option).
- The 48 odd MCQ/MSQ option counts are listed in the staging audit. The staging audit re-run is deterministic, and its media existence check reports 0 local files. Seven one-option MCQs are excluded by the app's minimum of two options; other non-four-option rows remain when they pass schema validation.
- Private build repeat run produced an identical 154-file tree; private release remains owner-only and ignored by `.gitignore`.

### Deployable static-site export

- `tools/export_public_site.py` creates `public-site/`, copying 23 top-level HTML/JS/CSS files plus only the generated public manifest, synthetic fallback and manifest-listed shards.
- It explicitly excludes the private staging master, publication gate, raw output staging copy, backend source, test suite, task files and private reports.
- Link check against `public-site/`: 16 pages, 488 links, 0 broken. Loader tests against the actual `app.js`: 423/423 checks and 19/19 mutation detections. Existing unit tests: 24/24.

**Important hosting note:** this complete handoff ZIP intentionally preserves the private staging masters and private source-derived shards. Do **not** publish the repository root or ZIP contents as-is via GitHub Pages. Use the `public-site/` export as the Pages artifact. No website or Apps Script endpoint has been deployed/verified live.
