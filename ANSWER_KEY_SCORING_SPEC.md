# GATE Prep Studio — Private Answer-Key Storage and Server-Side Scoring: Specification

| | |
|---|---|
| **Status** | **DRAFT for owner review. NOT APPROVED.** Authoring this document does not approve it (§12). |
| **Date** | 2026-10-28 |
| **Scope** | Specification only. No backend, no application code, no sample keys. |
| **Extends** | `SECURITY_DESIGN.md` (§2.3, §3, §4, §5, §6, §7, §10) and `SECURITY_DECISION_REVIEW.md`. Where this document narrows or conflicts with them, §0.3 says so. |
| **Architecture (fixed by the owner)** | GitHub Pages frontend, Google Apps Script backend, Google Sheets persistence. |

---

## 0. How to read this document

### 0.1 Labels

| Label | Meaning |
|---|---|
| **[IMPLEMENTED]** | Exists in the current project files (`app.js`, `exam.html`, tests). Browser-side or pure-function only. |
| **[OFFICIAL]** | Stated on an official GATE 2026 page read by this project (see §0.2). |
| **[INTERPRETATION]** | This site's own reading. **Not** an official statement. |
| **[PROPOSED]** | Proposed design or parameter. Not built. Needs approval. |
| **[OPEN]** | Needs an owner decision. Tracked as `AK-xx` in §12.2 (new) or `D-xx` (existing register). |
| **[ASSUMPTION]** | Believed true, not verified. Verify at implementation. |
| **ENFORCEABLE / BEST-EFFORT / NOT POSSIBLE** | Same meaning as `SECURITY_DESIGN.md` §0.2. |

### 0.2 Official sources and what they actually say

Read by this project on 2026-10-28:

- `https://gate2026.iitg.ac.in/question-paper-pattern.html`
- `https://gate2026.iitg.ac.in/QPs-answer-keys.html`

The Information Brochure PDF (`.../doc/IB/GATE2026-IB-v22082025-1300.pdf`) was cited by the owner. Its text could not be read here, so **no rule in this document is attributed to it.**

**[OFFICIAL] statements used:**

1. Questions carry 1 or 2 marks. MCQ wrong answer: 1/3 mark deducted for a 1-mark question, 2/3 for a 2-mark question.
2. No negative marking for MSQ or NAT. No partial marking for MSQ.
3. MSQ: all correct options must be chosen and no wrong option chosen, for full marks.
4. NAT: the numerical response must be **within the range given in the Answer Key** for full marks.
5. "MTA" = Marks To All: the marks allotted to that question are given to all candidates appearing for the test paper.
6. The answer key follows the order of questions in the **Master Question Paper**; the order on the candidate console may differ.
7. The keys "were open to challenges by candidates during February 25 to February 28, 2026."
8. Answer-key files are published per paper and per session, e.g. `.../doc/download/2026/Keys/CS1_Keys.pdf`, with CS-1/CS-2, CE-1/CE-2, GG-1/GG-2 and XH-C1…C6 as separate papers.
9. Official pattern page: every 2026 paper is listed with **100 total marks and 180 minutes**.

**[INTERPRETATION] (not official):** an unanswered question scores **0** (no correct-answer credit, no wrong-answer penalty). None of the reviewed sources states an unanswered score.

**Not stated by the reviewed pages (these are open, not assumed):** whether NAT range ends are inclusive; how a NAT response is rounded or formatted; whether the published keys are final or may be revised after the challenge window; how an official correction is announced.

### 0.3 Reconciliation with existing documents

| Topic | `SECURITY_DESIGN.md` says | This document |
|---|---|---|
| Admin API | None in v1 (§4.3, D-09) | **Kept.** Key import and correction are owner-run editor functions, not web endpoints (§5.7). An admin API stays an open decision (AK-10). |
| Saves near the deadline | §3.1 scores answers saved up to `deadline + 15 s`; §3.4 accepts saves until `deadline + grace` | **Narrowed** to the owner's stated policy: **no answer change is accepted after the deadline.** The 15 s grace applies only to a final-submit request already in flight, and that request carries no answers (§5.3). Needs the owner to confirm the change (AK-14). |
| Marking rules | Unresolved (D-06) | GATE 2026 only is now defined (§6). Every other year remains unverified. |
| Per-attempt pin | `attempts.rules_version` | Extended to profile id, version and hash, plus pinned key revisions (§4.6). |

---

## 1. Current state: implemented, proposed, unresolved

### 1.1 [IMPLEMENTED] today (browser only, in `app.js`)

- Exam attempt state machine: `in_progress`, `submitted`, `timed_out`; frozen deadline clock; read-only once closed; snapshot/restore that keeps the original deadline.
- Intended attempt policy as a frozen description with `enforcedNow: false`.
- Year-specific marking profiles. **Only 2026 is verified**; every other year resolves to `unverified`, `canScore: false`.
- Exact fractions `{num, den}`; no negative zero; `awardedMarks`, `sumMarks`, `classifyResponse`, `scoreResponse`, which take a key **as an argument** and hold none.
- `EXAM_ENGINE_AVAILABLE = false`. Exam attempts stay disabled. `exam.html` is a preview over placeholder questions.

### 1.2 Limits of what exists

- **Nothing server-side exists.** No private key store, no authenticated session, no server deadline, no answer persistence, no scoring service. Anything `app.js` computes is a **browser display or a specification mirror**; it is never trusted.
- `app.js` is public. The marking *rules* in it are public by design. Real keys, NAT ranges and explanations must never enter it.
- The helper compares NAT values with JavaScript `Number` and treats the range as **inclusive**. That inclusivity is an unverified assumption (AK-01), and floating-point comparison is not adequate for the server (§7.5).
- The existing public `data/questions.json` is metadata plus question text; keys are ignored if present and a warning is shown. That is a convenience guard, not security: anything in that file is world-readable.

### 1.3 [PROPOSED] by this document

Everything in §2 to §11.

### 1.4 [OPEN]

Everything in §12.2, plus the existing blockers D-06 (non-2026 years), D-07, D-11, D-12, D-13, D-17, D-18.

---

## 2. Separation of keys from public content

- **Public (GitHub Pages):** `data/questions.json` and all site files. Contain no key, no explanation, no NAT range, no `marks_to_all` flag, no correct-option flag.
- **`EXAM_DB` (private Sheet):** question content served per attempt, attempts, answers, results.
- **`KEYS_DB` (private Sheet, separate file):** keys, key revisions, key staging, explanations. Readable only by the script owner identity and the break-glass owner (`SECURITY_DESIGN.md` §4.1, §6.1).
- **Rule:** only server-side functions in a single module (`KeyStore`) may open `KEYS_DB`. No other module receives a spreadsheet handle for it. Spreadsheet IDs live in Script Properties, never in the repo.
- **Rule:** every client response is built by an explicit allow-list serializer (field-by-field), never by returning a stored row or spreading an object.
- **Canary test [PROPOSED]:** a test deployment seeds a unique marker string into a key and an explanation, runs every non-admin operation in every attempt state, and fails if the marker appears in any response or log. See §11.
- **Open (AK-09):** whether full question text and options also remain in the public `data/questions.json`. If they do, keys stay private but the text is public, so hiding text in attempts gives no integrity benefit.

---

## 3. Identifiers

| Identifier | Format | Notes |
|---|---|---|
| `question_id` | Existing `ID_RE`: 1-64 of `A-Za-z0-9._-` | Same id as the public catalogue. Stable. |
| `question_version` | Positive integer | Incremented when text, options, marks or type change. A key applies to **one** `(question_id, question_version)`. |
| `content_hash` | SHA-256 hex of the canonical question content | Stored on the key; proves the key was entered against that content. |
| `paper_id` | `gate-<year>-<paper_code>` | `paper_code` is the official label lower-cased, session included, e.g. `gate-2026-cs-1`, `gate-2026-xh-c3`. Sessions are **separate papers** (AK-12). |
| `key_id` | Random, non-sequential | One per key record revision. |
| `key_set_id` | Random | Groups the key records approved together for one paper. |
| `attempt_id`, `result_id`, `user_id` | Random, non-sequential | As in `SECURITY_DESIGN.md` §4.2. |

The catalogue and `questions` tab need new fields `paper_code`, `session`, `master_qno` (question number in the official Master Question Paper) and `section` (e.g. GA, subject). **[OPEN]** (AK-12): the current catalogue has only `branch` and `year`.

Because the official key follows Master Question Paper order, and options on the real console may be shuffled, this site **must display options in master order** (D-20, no shuffling). A key's option ids are master-order ids.

---

## 4. Private answer-key data model [PROPOSED]

### 4.1 Tabs in `KEYS_DB`

| Tab | Purpose | Mutability |
|---|---|---|
| `key_sets` | One row per approved set for a paper | Append-only |
| `answer_keys` | One row per question per **revision** | **Append-only.** Rows are never edited or deleted. |
| `key_staging` | Rows being imported or corrected, not yet live | Mutable until approved or rejected |
| `key_events` | Revision, approval, withdrawal and dispute history with before/after values | Append-only by convention |
| `explanations` | Explanation text per question version, if kept (D-18, D-07) | Append-only |

### 4.2 `answer_keys` columns

| Column | Type | Rule |
|---|---|---|
| `key_id` | text | Random. Primary identifier of this revision. |
| `key_set_id` | text | Set this row was approved in. |
| `paper_id`, `year`, `paper_code`, `session` | text/int | `year` must equal the question's year. |
| `question_id`, `question_version`, `content_hash` | text/int/text | Must match the live question row at approval, else rejected. |
| `master_qno`, `section` | int/text | For checking against the official file. |
| `type` | `MCQ`\|`MSQ`\|`NAT` | Must equal the question's type. |
| `marks` | integer 1 or 2 | Must equal the question's `marks`. (Existing rule: positive integer, D-23. 1 or 2 per **[OFFICIAL]** pattern page; the validator accepts any positive integer unless AK-18 narrows it.) |
| `key_kind` | `answer`\|`marks_to_all` | `marks_to_all` rows carry **no** answer fields. |
| `mcq_answer` | text | MCQ only; exactly one option id that exists in the question. |
| `msq_answers` | text, sorted unique ids joined by `,` | MSQ only; at least 1; each exists in the question; not "all options" unless that is the key. |
| `nat_lo`, `nat_hi` | **text** decimal strings, e.g. `4.0`, `-0.25` | NAT only. `lo ≤ hi`. A single-value key sets both equal. |
| `nat_lo_inclusive`, `nat_hi_inclusive` | boolean | **Always explicit.** The importer must not default them silently. Their value for 2026 is [OPEN] (AK-01). |
| `nat_scale` | integer | Decimal places in the official key values (for display and exact comparison). |
| `nat_source_form` | `value`\|`range` | How the official file presented it. |
| `profile_id`, `profile_version` | text/int | e.g. `GATE-2026`, `1`. Must be a **verified** profile. |
| `source_name`, `source_url`, `source_sha256` | text | Official file name, its URL, and the SHA-256 of the file as downloaded. |
| `source_retrieved_at`, `source_published_at` | ISO date | `published_at` empty if the file states none; never guessed. |
| `source_stage` | `provisional`\|`final`\|`unknown` | Official stage. For the 2026 page read, **`unknown`** unless the owner establishes otherwise (AK-04). |
| `entered_by`, `verified_by`, `entry_method` | text | `entry_method`: `manual_double_entry` \| `csv_import`. `entered_by ≠ verified_by` unless AK-10 allows a single owner. |
| `revision` | integer | 1, 2, 3… per `(question_id, question_version)`. |
| `supersedes_key_id` | text | Empty for revision 1. |
| `status` | `approved`\|`superseded`\|`withdrawn` | Only `approved` rows are scored from. Status changes are recorded as new `key_events`; the row itself keeps its original `status` value as of approval, and the **current** status is derived from events (so history is never rewritten). |
| `dispute_state` | `none`\|`disputed`\|`corrected` | Derived from events. |
| `approved_at`, `approved_by` | ISO time/text | |
| `row_mac` | text | `HMAC-SHA256` over the canonical row with a secret in Script Properties (§8.3). |

**Sheet-coercion rule:** columns holding decimals, option ids and hashes are formatted **plain text** and written as strings; the importer reads back and compares what was stored. Sheets can silently turn `1/3`, `4.10` or `1e3` into dates or numbers. Fractions are never stored as `a/b` text; see §4.6.

### 4.3 What is deliberately not stored in public or in this table

No explanation in `answer_keys`; no answer in `questions`, `attempts` or `answers`; no key in any log; no key in any cache entry visible to a client.

### 4.4 Validity checks (run at import and again at scoring)

A key record is **valid** only if all hold: required fields present for its `type`/`key_kind`; ids exist in the pinned question version; `content_hash` matches; `marks` and `type` match; NAT values parse as exact decimals with `lo ≤ hi` and explicit booleans; profile is verified for that `year`; `row_mac` verifies; `source_url` is on the `gate<year>.iitg.ac.in` host or another owner-approved official host [PROPOSED]; the latest event is `approved`.

### 4.5 Corrections never overwrite history

- A correction is a **new row** (`revision + 1`, `supersedes_key_id` set, new `key_id`) staged, validated and approved like an import. The previous row remains, with an event `superseded` linking to the new one.
- A withdrawn key is an event, not a deletion. A question with no approved, valid key is unscorable (§7.7).
- **Disputed** is a flag event set by the owner when an official correction is being awaited or a challenge is credible. It does not change the key value.
- Each event stores: who, when, reason, official reference (URL, notice date if any), and the old and new values (these values stay inside `KEYS_DB`).
- Historical attempts keep the revision they were scored with (§4.6). A correction never changes a past result in place; it can produce a **new score revision** (§7.8).

### 4.6 Pinning on attempts and results (in `EXAM_DB`)

| Table | Pinned fields |
|---|---|
| `attempt_questions` | `attempt_id`, `position`, `question_id`, `question_version`, `marks` (existing design, plus version) |
| `attempts` | adds `answers_hash`, `closed_at`, `close_reason`, `profile_set` (list of `profile_id@version@hash` used) |
| `results` | `result_id`, `attempt_id`, `user_id`, `score_revision`, `status` (`scored`\|`provisional`\|`blocked`), `total_num`, `total_den`, `max_marks`, `profile_set`, `key_set_digest`, `item_count`, `created_at`, `supersedes_result_id` |
| `result_items` | `result_id`, `question_id`, `outcome`, `awarded_num`, `awarded_den`, `key_id`, `key_revision`, `flags` |

Fractions are stored as **two integer columns**, never as a decimal or `a/b` text. `key_set_digest` is SHA-256 over the ordered `(key_id, key_revision, row_mac)` triples used.

---

## 5. Scoring service interface [PROPOSED]

### 5.1 Common rules (every operation)

- **Transport:** HTTPS `POST`, uniform envelope from `SECURITY_DESIGN.md` §1.1: request `{ op, requestId, sessionToken, payload }`; response `{ ok, code, data?, server_now }`. `op` is whitelisted. No stack traces, sheet names or key fields in errors.
- **Browser may supply only:** `op`, `requestId`, the session token, `attempt_id`, `question_id`s, response values, review flags, `seq`. **The browser never supplies** a score, a marks value, a marking rule or profile, a deadline, a time, a user id, a role, or an outcome. Any such field in a payload is rejected, not ignored.
- **Identity:** `user_id` comes only from the session lookup; `status=active` required.
- **Ownership:** `attempt.user_id == session.user_id`, else return the same `not_found` as a missing id (no existence oracle).
- **Time:** the server clock only. Every response carries `server_now`; in-progress responses also carry `remaining_seconds`.
- **Locking:** validate and compute outside the lock; take `LockService` script lock only to re-check state and write (`SECURITY_DESIGN.md` §2.3). `tryLock` failure returns the retryable `busy`.
- **Error codes:** `bad_request`, `unauthenticated`, `not_found`, `attempt_closed`, `deadline_passed`, `conflict` (stale `seq`), `busy` (retry), `scoring_pending`, `scoring_blocked`, `rate_limited`, `internal`. Detail goes to the audit log only.
- **Failure handling:** an unexpected error returns `internal` and logs `internal_error` with the operation and ids, never payloads.

### 5.2 Operation 1: `get_attempt` (retrieve questions without keys)

| | |
|---|---|
| **Inputs** | `attempt_id` (random-id format). |
| **Auth** | Valid session; owner of the attempt. |
| **Returns** | `status`, `server_now`, `remaining_seconds`, ordered question payloads from the **immutable** `attempt_questions` list, saved responses, review flags, `last_seq`. |
| **Question payload allow-list** | `question_id`, `question_version`, `position`, `type`, `text`, `options[{id,text}]` (MCQ/MSQ), `marks`, display metadata (`section`, `subject`). **Never:** key, `marks_to_all`, NAT bounds, explanation, `correct` flags, any hint field. |
| **Deadline** | Read triggers **lazy close** if `now ≥ deadline_at` and still `in_progress` (§5.4 path). |
| **Idempotency** | Read-only apart from lazy close, which is idempotent. |
| **Audit** | `authz_denied` on ownership failure; `attempt_closed` if lazy close fired. |
| **Failure** | If the question row is missing, return `internal` and `integrity_error` audit. Never skip a question silently. |

`start_attempt` (existing, `SECURITY_DESIGN.md` §4.3 #16) is unchanged except that it pins `question_version` and the **profile set** for the selected questions, and refuses to start when any selected question's year has no verified profile or any selected question lacks an approved valid key (§7.7). This makes unscorable attempts impossible to start. **[OPEN]** (AK-07) whether a missing key should block the start or only block the result.

### 5.3 Operation 2: `save_answers`

| | |
|---|---|
| **Inputs** | `attempt_id`, `items[{question_id, response, review_flag, seq}]`, at most 70 items and 20 KB [PROPOSED]. |
| **Validation** | Each `question_id` is in this attempt's `attempt_questions`. MCQ: one option id of that question. MSQ: unique option ids of that question, order-insensitive, empty list = cleared. NAT: string ≤ 64 chars, no control characters, canonical decimal syntax per AK-02, blank = cleared. `seq` strictly greater than stored `last_seq`. |
| **Auth** | Session; owner; attempt `in_progress`. |
| **Deadline** | **`now < deadline_at`, strictly. No grace.** At or after the deadline, the attempt is closed (lazy close) and the call returns `deadline_passed`; nothing is written. |
| **Writes (locked)** | Answer rows, `saved_at` (server time), `last_seq`. Client timestamps ignored. |
| **Idempotency** | Replays and duplicates are rejected by `seq` (`conflict`); resending the identical batch with the same `seq` returns the stored state, not an error [PROPOSED]. |
| **Audit** | Not per save (volume). `authz_denied`, `rate_limited`, `deadline_passed` counts. |
| **Failure** | Whole batch is validated before any write; one bad item rejects the batch. A failed write leaves `last_seq` unchanged so the client can resend. |

Consequence of the no-grace rule: edits typed in the last moments before the deadline may not be saved. The client should flush pending saves shortly before the countdown ends [PROPOSED], but the server does not depend on it.

### 5.4 Operation 3: `submit_attempt`

| | |
|---|---|
| **Inputs** | `attempt_id`, `requestId`. **No answers.** |
| **Auth** | Session; owner. |
| **Deadline** | If `now < deadline_at` → close as `submitted`. If `deadline_at ≤ now ≤ deadline_at + 15 s` → close as `expired`, using only answers already saved; reply `ok` with `close_reason: "expired"`. If later → already closed by lazy close. **Grace admits no answer** because submit carries none; its only effect is a friendlier response to an in-flight final request. The server cannot verify when the client sent it, so it does not pretend to. |
| **Phase 1 (locked)** | Re-read the attempt. If `in_progress`: set `closed_at`, `close_reason`, compute and store `answers_hash` over the canonical saved answers, status `closed`. If already `closed` or `scored`: change nothing. |
| **Phase 2** | Call `score_attempt` (§5.5). |
| **Idempotency** | A repeat returns the stored state or result; never re-closes, never re-scores. `requestId` is stored with the close event. |
| **Audit** | `attempt_closed` (reason), then `score_computed` / `score_blocked`. |
| **Failure** | If phase 2 fails (quota, timeout, error), the attempt stays `closed`, the response is `scoring_pending`, and the result is produced later by `get_result`, the sweeper, or the repair job (§8.6). **Answers are already frozen**, so a scoring failure never costs the user marks or lets answers change. |

### 5.5 Operation 4: `score_attempt` (internal)

Not a web operation. Called only by `submit_attempt`, lazy close, `get_result`, the sweeper and the owner's admin tooling.

| | |
|---|---|
| **Inputs** | `attempt_id` (from server code). Never from a request body for a different user. |
| **Preconditions** | Attempt is `closed` (not `in_progress`). Stored `answers_hash` equals a fresh hash of the saved answers; mismatch → `integrity_error`, no score, owner alert. |
| **Reads** | Attempt, pinned question list and versions, saved answers, the **approved valid key revision** for each pinned `(question_id, question_version)` from `KeyStore`, and the server-side marking profile for each question's year (§6). |
| **Computation** | Pure function per §7, in exact fractions. Outside the lock. |
| **Commit (locked)** | (1) If a `results` header already exists for this attempt with the same `key_set_digest` and `profile_set`, return it. (2) Write all `result_items`. (3) Write the `results` header with `item_count` — **the header is the commit marker**. (4) Set attempt status `scored`. |
| **Outputs** | `result_id`, `status`, total as `{num, den}` plus display text, per-question outcomes. |
| **Audit** | `score_computed` (result id, status, key set digest — no key values), `score_blocked`, `integrity_error`, `key_mac_failed`. |
| **Failure** | Any invalid or missing key, unverified profile, malformed stored response, or MAC failure produces `blocked` (§7.7), not a partial or guessed score. |

### 5.6 Operation 5: `get_result`

| | |
|---|---|
| **Inputs** | `attempt_id`, optional `review: true`. |
| **Auth** | Session; owner. Status must be `closed` or later. **Never for `in_progress`.** |
| **Returns (base)** | `status`, `score_revision`, total `{num, den}` + display text, `max_marks`, counts by outcome, per-question `outcome` and `awarded` fraction. If the attempt is `closed` with no result, run `score_attempt` and return `scoring_pending` if it still cannot finish. |
| **Returns (review)** | Correct option / option set / NAT accepted value or range / `marks_to_all` flag / explanation **only for this attempt's questions**, **only after close**, **only at the level the owner approves** (`score_only`, `outcome`, `full`). **[OPEN]** (D-18, AK-08). Default until approved: `outcome` (no key values). |
| **Audit** | `review_viewed` (attempt id, level). Used to spot bulk scraping; not tamper-proof. |
| **Failure** | A `blocked` result returns `scoring_blocked` with a generic reason code, never the offending key. |
| **Idempotency** | Read-only apart from the retry of scoring, which is idempotent. |

### 5.7 Operation 6: administrative key import and correction

**Not a web endpoint (D-09).** Implemented as functions run by the owner in the Apps Script editor, under the owner's authority. Nothing in the doPost route table maps to them.

| Function | Effect |
|---|---|
| `admin_stage_keys(batch_id, rows)` | Writes rows to `key_staging` with `batch_id` unique; rejects a reused `batch_id`. |
| `admin_validate_batch(batch_id)` | Runs §4.4 checks and a read-back comparison against the staged text; produces a report of errors with row numbers but **no key values in logs**. |
| `admin_approve_batch(batch_id, approver)` | Under lock: re-validates, appends `answer_keys` rows and a `key_sets` row, appends `key_events`, writes `row_mac`s, invalidates any key cache for the paper. Refuses if `entered_by == verified_by` unless AK-10 permits. All-or-nothing check: it writes rows first and the `key_sets` row last; the set row is the commit marker (§8.6). |
| `admin_correct_key(batch_id, ...)` | Same path; requires `reason` and `official_reference`; creates the next revision and a `superseded` event. |
| `admin_withdraw_key`, `admin_set_dispute(question_id, state, reason)` | Append events only. |
| `admin_rescore(paper_id \| attempt_id, reason)` | Runs `score_attempt` under a new `score_revision` (§7.8). |

Every admin function records `admin_action` in `audit_logs` with function name, ids and counts. Key values appear only in `KEYS_DB` `key_events`. **[OPEN]** AK-10: whether an authenticated admin web API is ever approved. If so it needs its own design review, a distinct admin credential, step-up authentication and its own rate limits.

---

## 6. Marking profile on the server [PROPOSED]

- The server holds its **own** copy of each verified profile, as a versioned constant in server code (`profile_id`, `version`, canonical JSON, `hash`). The browser copy in `app.js` is display-only and is never read by the server.
- **Parity check:** a test compares the server profile to `app.js` `markingProfileFor(2026)` field by field. A mismatch fails the build. A profile change is a new version; old attempts keep the version they were scored with.
- **GATE 2026 profile v1** (from `app.js`):

| Type | Correct | Wrong | Unanswered | Other | Provenance |
|---|---|---|---|---|---|
| MCQ | marks × 1 | marks × (−1/3) → 1-mark −1/3, 2-mark −2/3 | 0 | | correct/wrong **[OFFICIAL]**; unanswered **[INTERPRETATION]** |
| MSQ | marks × 1 only if the selected set equals the key set | 0 | 0 | no partial marking | MSQ rules **[OFFICIAL]**; unanswered **[INTERPRETATION]** |
| NAT | marks × 1 if within the key's range | 0 | 0 | range comes from the key, never a global tolerance | NAT rules **[OFFICIAL]**; unanswered **[INTERPRETATION]** |
| MTA | marks × 1 to every candidate appearing | | | | **[OFFICIAL]** |

- **Year isolation:** a question is scored with the profile of **its own year**. No other year borrows 2026's rules. Any question whose year has no verified profile makes the attempt unscorable (§7.7). **[OPEN]** (AK-13): whether a custom or subject-wise attempt that mixes years may be scored per question, or must be restricted to a single verified year.
- The 100-mark timing conflict is untouched here. It affects attempt duration (D-11), not scoring semantics.

---

## 7. Scoring semantics [PROPOSED]

All arithmetic uses exact fractions of integers. Per-question awards are `marks × rule`, where `rule ∈ {1, 0, −1/3}`. Totals are sums of reduced fractions. Results never pass through a floating-point number, and a zero total is stored as `0/1`, never negative zero.

### 7.1 Precedence (evaluated top to bottom, first match wins)

1. **No approved valid key, unverified profile, malformed stored response, or MAC failure** → the question is **unscorable**; the attempt is `blocked` (§7.7). This check comes first so nothing below can paper over a bad record.
2. **Marks To All** (`key_kind = marks_to_all`) → full question marks, **regardless of the response**, including unanswered, malformed-but-stored, or wrong. [OFFICIAL] says the marks go to all candidates appearing. This matches the existing helper, which checks MTA before everything else. Confirmation is requested in AK-03.
3. **Unanswered** → 0 [INTERPRETATION].
4. **Type rule** (MCQ, MSQ, NAT) → correct or wrong.

### 7.2 MCQ

Response is one option id.
- Equal to `mcq_answer` → `+marks`.
- Different → `−marks/3`. 1-mark: `−1/3`. 2-mark: `−2/3`. Exact fractions.
- Unanswered → 0.

### 7.3 MSQ

Compare the response **set** to `msq_answers` as sets (order ignored, duplicates impossible by validation).
- Equal sets → `+marks`.
- Any other non-empty selection (missing a correct option, any wrong option, or both) → 0. No partial credit, no penalty.
- Empty selection → unanswered → 0.

### 7.4 Unanswered

An unanswered MCQ, MSQ or NAT scores exactly 0. Unanswered means: no saved response, a cleared response, an empty MSQ list, or a blank NAT string. **This is the site's [INTERPRETATION]**, not an official statement, and must be labelled that way wherever shown to users.

### 7.5 NAT

- The stored response is a string. The server parses it with a **strict decimal parser** into an exact scaled integer (for example with `BigInt`; **[ASSUMPTION]** that the Apps Script runtime supports it, else a string-based decimal comparator). `Number` and floating point are not used.
- `-0`, `0`, `0.0` are equal. Leading/trailing spaces are trimmed (the existing state machine trims).
- The response is **never rounded** before comparison **[PROPOSED]**. Whether to round is [OPEN] (AK-02).
- Within range ⇔ `nat_lo ≤ v ≤ nat_hi`, with each end comparing as inclusive or exclusive **according to that record's explicit boolean**.
- **[OPEN] (AK-01):** the reviewed pages say "within the range" but not whether the ends count. The existing browser helper assumes inclusive; that is an unverified assumption, not a rule. The owner must settle it from the official answer-key files and record the booleans per key.
- **[OPEN] (AK-02):** which response syntaxes are accepted (leading `+`, exponent form such as `1e3`, comma as decimal separator, maximum digits). Until decided, the server accepts only `[+-]?digits[.digits]` and rejects the rest at save time with `bad_request`; it never treats an unparseable stored value as "wrong".
- Wrong or out-of-range → 0 (no negative marking).
- Unanswered → 0.

### 7.6 Marks To All

- Awarded `marks` to every attempt containing that question, answered or not (§7.1).
- The question remains in `max_marks`.
- **[OPEN] (AK-03):** whether an MTA question counts as "attempted" or "correct" in dashboard accuracy figures. Proposed: report it with its own outcome `marks_to_all` and exclude it from accuracy percentages.

### 7.7 Invalid, malformed or missing key records

**Fail closed.** The service never guesses a key, never defaults a missing key to "everyone correct" or "everyone wrong", and never scores around the gap.

- Any unscorable question → result `status = blocked`, no total is shown, `scoring_blocked` is returned, `score_blocked` and the reason code (`key_missing`, `key_invalid`, `key_mac_failed`, `profile_unverified`, `response_malformed`, `integrity_error`) are audited, and the owner is alerted.
- The attempt stays closed with answers frozen. When the cause is fixed, `admin_rescore` produces a scored result. The user loses nothing.
- **[OPEN] (AK-07):** withhold the whole result (proposed) versus show a partial total with the unscorable questions listed.

### 7.8 Disputed and corrected keys

- **Disputed** (owner flag, AK-06): proposed behaviour is to score with the last approved revision, label the result `provisional`, and tell the user the key is under review. The alternative is to withhold.
- **Corrected** (new revision approved): attempts already scored are **not edited**. `admin_rescore` creates a new `results` row with `score_revision + 1` and `supersedes_result_id`. The old result and its `result_items` stay for audit. The user sees the latest revision with a note that it replaced an earlier one. **[OPEN] (AK-05):** automatic rescoring of all affected attempts (proposed) versus on request only.
- A correction's effect on each question is limited to that question's key; the profile version does not change.

### 7.9 Display

Stored totals are exact fractions. Showing `-1/3` as `-0.33` is a presentation choice, never used in later arithmetic. **[OPEN] (AK-16):** display format (exact fraction, decimal to 2 places, or both).

---

## 8. Security and persistence

### 8.1 Answer keys at rest and in transit

- **At rest:** protected by **access control only**: private Sheet file, owner plus one break-glass account, no link sharing, 2-Step Verification, written editor list (`SECURITY_DESIGN.md` §6.1, 5.9). Google encrypts stored data at rest **[ASSUMPTION — not verified here]**, but anyone with Sheet access reads keys in clear. This document does **not** claim application-level encryption of keys. Apps Script has no documented native symmetric encryption **[ASSUMPTION]**; hand-rolled encryption with a key in Script Properties would protect little, because script editors can read Script Properties.
- **In transit:** HTTPS between browser and Apps Script. Keys are never sent to a browser before the attempt is closed, and afterwards only as the approved review level allows.
- **Integrity:** `row_mac` per key row, and `key_set_digest` per result. A mismatch fails closed (§7.7). Detects edits made without the MAC secret. **BEST-EFFORT:** any person who can read Script Properties can recompute MACs.

### 8.2 Key imports and corrections

- Staged, validated, read-back compared, then approved by a second step. Two-person entry/verification is proposed (AK-10, AK-11).
- Source file SHA-256 and URL recorded so a later reader can re-check the transcription.
- No automated PDF parsing is assumed; the official PDFs were not machine-readable in this project's earlier attempts.
- Import and correction run only as owner-executed editor functions. No network path reaches them.

### 8.3 Administrative access

Only the owner and break-glass account can open `KEYS_DB` or run `admin_*`. Every admin run is audited. A weekly diff of `key_events` since the last review is read by a second person [PROPOSED]. An optional daily email digest of admin events to a separate address detects silent edits but uses mail quota (D-22).

### 8.4 Per-user attempt data and results

- `user_id` only from session; ownership check on `get_attempt`, `save_answers`, `submit_attempt`, `get_result`, `list_history`.
- Uniform `not_found` for non-owned ids; random non-sequential ids.
- `result_items` contain outcomes and fractions, not key values, so a leaked `EXAM_DB` does not leak keys. It does leak users' answers and scores, which is why it stays private.

### 8.5 Audit logs

Events added to the existing list: `attempt_closed`, `score_computed`, `score_blocked`, `score_superseded`, `review_viewed`, `integrity_error`, `key_mac_failed`, `key_import_staged`, `key_import_approved`, `key_corrected`, `key_withdrawn`, `key_disputed`, `admin_action`. Never logged: key values, NAT bounds, explanations, answers, tokens.

**NOT POSSIBLE:** tamper-proof logs. Any editor can rewrite a Sheet. A per-row hash chain (`prev_hash`) detects casual edits and is **BEST-EFFORT** only.

### 8.6 Retries, concurrent submissions, partial failures

Sheets has no transactions. Integrity rests on three mechanisms:

1. **Script lock around every writer** (`SECURITY_DESIGN.md` §2.3). A writer that skips the lock, including a person editing a cell by hand, can corrupt state.
2. **Idempotency records:** `attempts.request_id` for start; `last_seq` for saves; the attempt state transition for submit; `UNIQUE`-by-check `(attempt_id, key_set_digest, profile_set)` for results; unique `batch_id` for key imports.
3. **Commit markers and a repair job:** multi-row writes write children first and the header last (`results` header for scoring, `key_sets` row for key approval). A header without its `item_count` children, or children without a header, is detectable. A periodic repair job (BEST-EFFORT, trigger quota-bound, `SECURITY_DESIGN.md` §3.1) finds attempts `closed` with no result, partial result rows, and key batches without a set row, and finishes or flags them.

Concurrent `submit_attempt` calls: the first to take the lock closes the attempt; the others see `closed` or `scored` and return the stored state. Concurrent scoring: the commit step re-checks for an existing header, so duplicates are not written. A process killed mid-scoring leaves the attempt `closed` and re-scorable.

### 8.7 Backups and restoration

- Follows D-10: daily `makeCopy` of the three Sheets to a restricted folder, preferably under a different account, with retention as approved. **KEYS_DB backups contain keys** and carry the same access restriction as the live file.
- Restore drill [PROPOSED]: after restoring, recompute every `row_mac` and every `key_set_digest`, confirm each `results.key_set_digest` still resolves, and confirm no `answer_keys` row is missing. Restoring an older `answer_keys` tab would otherwise silently re-expose superseded keys, so restore replaces the file as a whole and then re-runs the digest check.
- Because key rows are append-only, a restore to an earlier point is detectable as a missing revision.

### 8.8 Unauthorized requests and score manipulation

| Attack | Control | Strength |
|---|---|---|
| Client sends a score, marks, rule, deadline or user id | Rejected fields; server recomputes everything | **ENFORCEABLE** |
| Access another user's attempt or result | Session ownership; uniform `not_found` | **ENFORCEABLE** |
| Replay or double-submit | State transition; stored result; `seq` | **ENFORCEABLE** |
| Late answer after the deadline | Server clock; strict `now < deadline_at`; no grace on saves | **ENFORCEABLE** |
| Read keys through any normal operation | Allow-list serializers; canary test | **ENFORCEABLE** while code is correct |
| Scrape the bank and keys by repeated attempts | Attempt-start limits (D-17), review audit | **BEST-EFFORT** |
| Edit key or result rows in the Sheet | MACs, digests, audit | **BEST-EFFORT** (editors can recompute) |
| Anonymous flooding of the endpoint | Pre-lock rejection, global budgets | **BEST-EFFORT**; DoS resistance **NOT POSSIBLE** |
| Authorization bug | Every request runs with the **owner's** authority, so one bug is a full-data bug | Needs the §11 test matrix |

### 8.9 Limits of Google Apps Script and Google Sheets

- **Access control:** Sheet permissions are file-level. There is no row or column permission that separates a key from the rest of a Sheet, so keys must sit in a **separate file**. Every editor of that file reads every key.
- **Transactions and isolation:** none. Emulated with lock, idempotency and commit markers (§8.6). Not equivalent to database isolation.
- **Single script lock:** all locked operations are serialised. Throughput is roughly one divided by the average lock hold time; a synchronised exam submit by many users queues behind it. Scoring computation is deliberately kept outside the lock to shorten it. Measure before launch (D-13).
- **Quotas:** execution time per run, trigger runtime and count, mail quota, `UrlFetchApp` quota (`SECURITY_DESIGN.md` §2.1). Scoring a full paper must fit within one execution; a large sweeper run may not.
- **Read cost and lookup:** Sheets has no index. Reading keys for one attempt by scanning `answer_keys` is expensive. Mitigation [PROPOSED]: read each paper's approved key set as one block and cache it in `CacheService` keyed by `key_set_digest`, delete on approval or correction. The cache is evictable and its size limits are **[NOT VERIFIED]**; the Sheet remains the truth. Cached key material is never client-visible.
- **Scale:** cell limit and degradation (D-13); append-only revisions and `result_items` grow quickly. Plan a migration trigger from the load test.
- **Where another store may be required:** if measured lock contention or quotas fail the go/no-go thresholds (D-13), key storage and scoring are the first components to move to a real database with row-level access control and transactions. This document does not choose one.
- **Data typing:** Sheets coerces types. See the plain-text column rule in §4.2.

---

## 9. Behaviour with the exam state machine [IMPLEMENTED] and policy

The browser's state machine (`in_progress`, `submitted`, `timed_out`, frozen clock) is a **display and input model**. The server states map as follows, and the server wins on any disagreement.

| Browser | Server |
|---|---|
| `in_progress` | `in_progress` |
| `submitted` | `closed` (`submitted`) then `scored` or blocked |
| `timed_out` | `closed` (`expired`) then `scored` or blocked |

Policy mirrored on the server [PROPOSED, owner-stated policy]: no pause; resuming returns the same deadline; at the deadline the service closes the attempt with the responses already saved; no answer change after the deadline; one active attempt per mode per user; at most 10 starts per hour; a 15 s technical grace for an in-flight final submit only. `SECURITY_DESIGN.md` §3.1/§3.4 are narrowed accordingly (§0.3). Duration remains `round(total_marks × 10800 / 65)` seconds; the 100-mark conflict (D-11) remains **unresolved and blocking** for papers where it applies. Nothing here resolves it, and the 2026 pattern page listing every paper at 100 marks and 180 minutes (§0.2 item 9) makes that decision more pressing.

---

## 10. Implementation sequence [PROPOSED]

0. Owner approves this specification and answers §12.2. **Nothing below starts before this.**
1. Server-side pure modules: fractions, the 2026 profile, scoring function, strict NAT decimal comparator. Port the existing test cases; add the parity test with `app.js`. No Sheets, no auth needed.
2. `KeyStore` module and `KEYS_DB` layout, `row_mac`, plain-text column handling, `admin_*` editor functions, import read-back verification. Test with synthetic keys only (clearly fake ids).
3. Authentication and sessions per `SECURITY_DESIGN.md` §1 (prerequisite for everything user-facing).
4. `start_attempt`, `get_attempt` with the allow-list serializer, `save_answers` with `seq`.
5. Lazy close, `submit_attempt`, `score_attempt`, `results`, commit markers, repair job.
6. `get_result` and the approved review level.
7. Canary and authorization-matrix tests (§11), concurrency and failure-injection tests.
8. Load test against D-13 thresholds; decide go/no-go and migration trigger.
9. Backup and restore drill including digest re-verification.
10. Controlled pilot with one verified paper whose keys the owner has double-entered. Exam attempts stay disabled elsewhere.

---

## 11. Acceptance criteria for approving this design

The design may be approved only when **all** hold:

1. Every item in §12.2 marked *required before build* has an owner answer recorded.
2. The owner confirms the §0.3 reconciliation, especially the narrowing of grace behaviour (AK-14) and the editor-only admin model (AK-10).
3. The owner confirms the keys live in a separate private file with the access list written down.
4. The NAT boundary and syntax decisions (AK-01, AK-02) are checked against the official key files and recorded per key.
5. The unanswered-zero rule is accepted as a labelled **interpretation**, or replaced by an official statement if one is found.
6. A workload target and go/no-go thresholds exist (D-13).
7. For the implementation phase to pass: the canary test shows no key or explanation in any non-admin response or log in any attempt state; the authorization matrix proves a user cannot read or alter another user's attempt or result; a replayed or concurrent submit scores once; an answer sent at or after the deadline is rejected; a killed scoring run is recovered by the repair job; a restore passes the digest check; the server-profile parity test passes.

---

## 12. Decisions, assumptions and limitations

### 12.1 Settled

| # | Decision | Basis |
|---|---|---|
| S-1 | Architecture: GitHub Pages, Apps Script, Sheets | Owner |
| S-2 | Keys, explanations and NAT ranges never in public files | Owner |
| S-3 | Only authorized server-side code reads keys; scoring is server-side only | Owner |
| S-4 | The browser never supplies trusted scores, rules, deadlines or identities | Owner / `SECURITY_DESIGN.md` §3 |
| S-5 | GATE 2026 profile: MCQ −1/3 and −2/3; MSQ all-or-nothing, no negatives; NAT no negatives, range from the key | **[OFFICIAL]** |
| S-6 | MTA exists and gives the question's marks to all candidates appearing | **[OFFICIAL]** |
| S-7 | Unanswered = 0, labelled as the site's interpretation | **[INTERPRETATION]**, owner-directed |
| S-8 | Exact fractional arithmetic; no negative zero | Owner |
| S-9 | Other years stay unverified; 2026 rules are not applied to them | Owner |
| S-10 | Duration `round(total_marks × 10800 / 65)` unchanged; the 100-mark conflict stays blocked | Owner |
| S-11 | Attempt policy: no pause, resume keeps the deadline, close at the deadline with saved answers, no answer change after it, one active attempt per mode, 10 starts per hour, 15 s grace for an in-flight final submit only | Owner |
| S-12 | Key revisions are append-only; corrections never overwrite history | This document, proposed for approval but a property of the design, not a choice |
| S-13 | Fail closed on invalid or missing keys | This document, same |

S-12 and S-13 are design properties proposed here; they become settled only when the owner approves the document.

### 12.2 Owner decisions still required

"Required" = must be answered before backend implementation of the part it affects.

| ID | Decision | Recommendation | Required before |
|---|---|---|---|
| **AK-01** | NAT range ends inclusive or exclusive; confirm from the official key files | Verify per key; store explicit booleans; default none | Key import |
| **AK-02** | Accepted NAT response syntax; rounding of the candidate's response | Plain decimal only; no rounding | `save_answers` |
| **AK-03** | Confirm MTA overrides the response, including unanswered; MTA in accuracy statistics | Override; own outcome, excluded from accuracy | Scoring |
| **AK-04** | Are the published 2026 keys final? How are later official revisions handled and detected? | Record `source_stage`; owner re-checks the official page on a schedule | Key import |
| **AK-05** | Rescore all affected attempts on correction, or on request | Automatic, history retained | Corrections |
| **AK-06** | Disputed keys: provisional result or withhold | Provisional, clearly labelled | Scoring |
| **AK-07** | Missing or invalid key: block attempt start, block result only, or partial total | Block start; if it happens later, withhold result | `start_attempt`, scoring |
| **AK-08** | Review detail after submission; explanation source and licence (links to D-18, D-07) | `outcome` until approved | `get_result` |
| **AK-09** | Does full question text stay in public `data/questions.json`? | Serve text via `get_attempt`; keep only catalogue metadata public | Content import |
| **AK-10** | Admin model: editor-only functions (proposed) or an admin API; one person or two-person approval | Editor-only; two-person if a second person exists | Key import |
| **AK-11** | Key transcription method and verification (double entry, source hash) and who is responsible | Two independent entries compared | Key import |
| **AK-12** | Catalogue fields for paper code, session, master question number, section; sessions as separate papers | Add fields; separate papers | Content import |
| **AK-13** | Mixed-year custom attempts: per-question profiles or single-year only | Single verified year until more profiles exist | `start_attempt` |
| **AK-14** | Confirm narrowing of `SECURITY_DESIGN.md` §3.1/§3.4 grace to the owner's stated policy | Confirm | Save/submit |
| **AK-15** | Where the server profile lives and how profile changes are approved | Versioned constant; parity test; version bump per change | Scoring |
| **AK-16** | Display format for fractional totals | Exact fraction plus 2-decimal display | Results UI |
| **AK-17** | Scoring-service go/no-go thresholds (ties to D-13) | Set from load test | Public launch |
| **AK-18** | Restrict question marks to 1 or 2 (per the official pattern) or keep "any positive integer" (D-23) | Restrict to 1 or 2 for GATE papers | Content import |

Existing decisions still open and relevant: **D-06** (non-2026 years), **D-07**, **D-11**, **D-12**, **D-13**, **D-17**, **D-18**, **D-20**, **D-23**.

### 12.3 Security assumptions and limitations

- Every request to the web app runs with the **owner's authority** (`SECURITY_DESIGN.md` §6.2). One authorization bug exposes everything.
- Anyone with edit access to a Sheet or the script can read keys, change keys and results, and rewrite logs. This platform cannot prevent it. MACs and hash chains detect only casual edits.
- No per-IP limits, no request headers, no DoS resistance (`SECURITY_DESIGN.md` §2.4, §7.2).
- Sheets provides no transactions or strong isolation. Correctness depends on the script lock being held by every writer, on idempotency, and on a repair job that is itself quota-bound.
- Google at-rest encryption, `BigInt` support, `CacheService` limits and the behaviour of Sheets type coercion are **[ASSUMPTION / NOT VERIFIED]** and must be tested at implementation.
- After a result is released, review details are intentionally visible to that user. Scraping the bank through many accounts is only rate-limited, not prevented.
- The unanswered-zero rule is an interpretation. If the official brochure or a later notice says otherwise, the profile version must be bumped and affected results rescored.

### 12.4 Statement of status

This specification is **a proposal awaiting owner review**. No private key store, no server-side scoring service, no authenticated session, no server deadline and no answer persistence exist today. Real exam attempts remain disabled.
