# Task 56 — Marking and exam policy gates

**Status:** implementation checkpoint completed; owner approvals and live backend readiness remain pending. Date: 2026-10-28.

## What changed

- `app.js`: corrected `EXAM_POLICY_APPROVED` to `false` to match `ANSWER_KEY_SCORING_SPEC.md` (DRAFT / NOT APPROVED). Added fail-closed constants `SCORING_BACKEND_READY = false` and `ANSWER_REVIEW_POLICY_APPROVED = false`; left `MARKING_RULES_CONFIRMED = false` and `EXAM_ENGINE_AVAILABLE = false`. The attempt policy is explicitly labeled `draft_unapproved` and `enforcedNow: false`.
- `app.js`: GATE 2026 is now `source_verified_reference_only`, not an operational scoring profile. Source verification is kept distinct from owner approval and execution readiness. `canScore` only becomes true if pending profile items are absent and owner approval, marking confirmation, server scoring, exam engine and attempt enforcement are all ready. No other year borrows its rules.
- `app.js`: `awardedMarks` and `scoreResponse` fail closed while browser-side scoring is not authorized. Scoring blockers name owner approval, rule confirmation, absent secure backend/engine, unavailable private answer keys, unresolved NAT response boundaries/syntax and the unanswered-score interpretation.
- `app.js` + `exam.html`: added status reporting and an informational whole-number year lookup. The UI distinguishes source-reviewed reference-only rules from unverified years, and shows scoring, exam-attempt and answer-review state. The lookup cannot change any gates.
- `online-exam.js`: online start is blocked in the client while owner-controlled policy gates are closed, with clear text that no start request was sent. Server-side gates remain necessary and authoritative; this browser check is not a security boundary.
- `data/EXAM_POLICY_STATUS.json`: added an informational, answer-key-free public snapshot. It cannot authorize anything and records all current gates as false plus known open decisions.
- `tools/export_public_site.py`: copies this explicitly allowlisted public status file to the `public-site/data/` export. It still excludes private staging masters, publication gate, backend source, tests and reports.
- `tests/exam.unit.test.js`: updated attempt-policy assertions and added coverage for blocked browser scoring, policy status snapshots, unsupported years and the status UI controls.

## Policy status at checkpoint

| Gate | Value | Meaning |
|---|---:|---|
| `MARKING_RULES_CONFIRMED` | `false` | No owner approval has been recorded. |
| `EXAM_POLICY_APPROVED` | `false` | The scoring/attempt specification remains draft and unapproved. |
| `SCORING_BACKEND_READY` | `false` | No approved live server-scoring readiness is asserted. |
| `EXAM_ENGINE_AVAILABLE` | `false` | Online attempts are unavailable. |
| `ATTEMPT_POLICY.enforcedNow` | `false` | The proposed policy is not enforced by a configured live backend. |
| `ANSWER_REVIEW_POLICY_APPROVED` | `false` | Answer review remains blocked. |
| GATE 2026 | reference-only | Source-reviewed rules only; cannot score. |
| Other years | unverified | No cross-year fallback. |

No correct answers, answer-key rows, accepted NAT ranges, explanations or per-question scores were introduced into public files. The real staging master and private release are preserved and remain owner-only. Redistribution rights are still unconfirmed.

## Verification

- `node --check app.js` — passed.
- `node --check online-exam.js` — passed.
- `node --check tests/exam.unit.test.js` — passed.
- `node tests/unit.test.js` — 24/24 passed.
- `node tests/exam.unit.test.js` — 30/30 passed.
- `node tests/manifest.loader.test.js` — 426/426 checks passed; all 19 mutation variants detected.
- `python3 -m unittest tests/test_release_builder.py -v` — **4/4 passed**.
- `python3 tools/export_public_site.py` — passed; exports 23 top-level web files, the one synthetic placeholder question, and the public-safe policy-status JSON; staging master, private backend and private reports are not copied.
- `python3 linkcheck.py ..` and `python3 linkcheck.py ../public-site` — each checked **16 pages / 488 links / 0 broken / 0 duplicate IDs**.
- Public-export consistency/safety assertion — passed: status JSON matches the source; all gates false; placeholder manifest retained; staging master, publication gate and private release absent from export.
- DOM and full browser tests were **not run**. No live Apps Script/Google/GitHub deployment or backend validation was performed.

## Remaining owner decisions and next task

`ANSWER_KEY_SCORING_SPEC.md` remains **DRAFT for owner review. NOT APPROVED.** Open questions include NAT boundary inclusivity and syntax/rounding, unanswered scoring interpretation, key revisions/rescoring, answer review, paper/session metadata, subset/full mock composition and related `D-xx` / `AK-xx` items. This checkpoint does not resolve or silently accept them.

**Next: Task 57 — Private answer-key and server-side scoring integration.** Inspect and connect the existing private GAS modules to the authenticated attempt lifecycle, but keep every key and scoring value private; all policy gates remain off until explicit owner approval and configured service readiness.
