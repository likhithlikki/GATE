# GATE Prep Studio — Security Decision Review

| | |
|---|---|
| **Document status** | Review artifact for the owner. Not a design revision. |
| **Task** | Task 9 — Security Design Decision Review |
| **Date** | 28 October 2026 |
| **Reviewed document** | `SECURITY_DESIGN.md` (Task 8, 630 lines, 24 decisions D-01…D-24), read in full this turn |
| **Files changed** | None. `SECURITY_DESIGN.md` and all HTML/CSS/JS files are untouched. This file is the only new artifact. No `Code.gs`, no APIs. |

---

## 0. Reading guide

### 0.1 Evidence labels (same spirit as `SECURITY_DESIGN.md` §0.1, with one change)

| Label | Meaning |
|---|---|
| **[DOCUMENTED]** | Seen in an official Google page **extract** returned by search this turn or last turn. Extracts can be truncated, translated, or snapshot-dated, so "documented" ≠ "read in full". |
| **[COMMUNITY]** | Non-official source (blog, forum, book). Plausible, unconfirmed. |
| **[ASSUMPTION]** | Believed true, not verified by any source I read. |
| **[UNCHECKED]** | A source that exists but I did not read. URL given. |
| **[REC]** | A recommendation from this review. Not a fact. |
| **[PROPOSED]** | A starting number I suggest. Not derived from a source. |
| **[CONFLICT]** | Two sources disagree. Unresolved. |

### 0.2 What I verified this turn (and what I did not)

I could not open pages directly; the fetch tool only opens URLs that appeared in earlier results. Everything below is from **search-result extracts**.

| Topic | Source | What the extract showed |
|---|---|---|
| Apps Script quota table | https://developers.google.com/apps-script/guides/services/quotas | Per-user quotas "reset 24 hours after the first request"; URL Fetch calls **20,000/day consumer, 100,000/day Workspace**; Properties read/write **50,000/day consumer, 500,000/day Workspace**; email recipients 100\*/1,500\*; script runtime 6 min; triggers 20/user/script; **"Simultaneous executions per script: 1,000"**. The `*` footnote is still not retrieved. |
| `Utilities` service | https://developers.google.com/apps-script/reference/utilities/utilities | `computeHmacSha256Signature` and `computeRsaSha256Signature` (**signing**) listed. `getUuid()` documented as "equivalent to `java.util.UUID.randomUUID()`". The extract's method list is incomplete, so absence of a method (e.g. RSA *verify*, PBKDF2) is **not proof** it doesn't exist. |
| Google Identity Services — server verification | https://developers.google.com/identity/gsi/web/guides/verify-google-id-token | Redirect mode POSTs the token as `credential` plus a `g_csrf_token` **cookie** double-submit. Validity criteria shown: signature, `aud` (with a stated reason), `exp`. Libraries for Java/Node/PHP/Python shown. `tokeninfo` is not mentioned in the extract. |
| Older Sign-In backend guide (read last turn) | https://developers.google.com/identity/sign-in/web/backend-auth | Adds `iss` check; says the `tokeninfo` endpoint is "for development and debugging"; libraries are the production recommendation. |
| Android Credential Manager | https://developer.android.com/identity/sign-in/credential-manager-siwg | Says to set a **nonce** "to avoid replay attacks". **Android only** — web GIS nonce handling is still unchecked. |
| Others from Task 8 | See `SECURITY_DESIGN.md` §0.3 | Lock reference, web-app deployment, Drive 10M-cell page. |

**Still [UNCHECKED]** (not read by me, any task): OWASP Password Storage and Session Management cheat sheets, NIST SP 800-63B, MDN/W3C Web Crypto (`SubtleCrypto.deriveBits`/PBKDF2), `PropertiesService`, `CacheService`, `MailApp` (and the `*` footnote), `ContentService` (headers), GitHub Pages header/CSP behaviour, Google Cloud OAuth consent-screen/publishing rules, the official GATE brochure, and Indian data-protection law. URLs are in §5.

---

## 1. Critical technical review

**Ground rule used throughout:** *feasible in Apps Script ≠ secure.* For each of D-01 and D-14 I separate (a) what is feasible, (b) what security property it actually gives, and (c) what has not been established.

### 1.1 D-01 — Password hashing

#### Verdict

Option A (browser PBKDF2 pre-hash + server HMAC wrap) is **feasible**. It **may** raise the cost of offline password cracking, but only if three conditions hold, none of which is yet established: (1) the iteration count is set from real measurements, (2) the pepper is not stolen together with the data, and (3) the JavaScript served to browsers is trustworthy. **As written in `SECURITY_DESIGN.md` it also contains a design defect (F-01).** It should be approved only as a *provisional* target.

#### What is documented vs assumed

| Claim | Status |
|---|---|
| HMAC-SHA256 is available (`computeHmacSha256Signature`) | **[DOCUMENTED]** |
| No built-in bcrypt/scrypt/Argon2/PBKDF2 in Apps Script | **[ASSUMPTION]** — not seen in the (incomplete) method list; absence in an extract is not proof |
| A pure-script HMAC loop is slow and bounded by 6 min/execution | 6-min limit **[DOCUMENTED]**; "slow" **[ASSUMPTION]** — never measured |
| Browser Web Crypto can run PBKDF2-HMAC-SHA256 at high iteration counts | **[UNCHECKED]** (MDN); typical speed on target devices **unknown** |
| OWASP/NIST iteration/policy figures | **[UNCHECKED]** — I recalled them from memory in Task 8 and must not hard-code them |
| Pepper in Script Properties is hidden from script editors | **[ASSUMPTION], probably false** — editors can usually read properties; `PropertiesService` **[UNCHECKED]** |

#### Findings

| ID | Severity | Finding | Required action |
|---|---|---|---|
| **F-01** | **High — design defect** | `SECURITY_DESIGN.md` §1.2/§1.4 says the client salt is "derived from normalised username/email". But `login.html` accepts **username *or* email**. A browser cannot derive one salt that is identical whichever identifier the user types, and the username→email mapping is on the server. | Add a pre-login step (e.g. `get_kdf_params(identifier)`) returning `{salt, iterations, scheme}`. For unknown identifiers return a **stable fake** salt (derived by HMAC with a server secret) so the response does not reveal whether an account exists. Costs: one extra round trip, one more unauthenticated operation to rate-limit (it does a user lookup, a Sheets read and a Properties read), and enumeration/timing still only **best-effort**. |
| **F-02** | **High** | Under Option A the server sees only `H1`. It **cannot** enforce length, blocklist, or breached-password rules. Anyone calling the API directly can register `H1("password1")`. Policy becomes advisory (UI-only). This also removes any chance of a server-side breached-password check. | Owner must **accept this explicitly** (D-02) or choose Option B. The main real-world risks (weak, reused passwords → credential stuffing) are **not improved** by Option A at all. |
| **F-03** | **High** | The iteration count is **undetermined**, and any figure I would give now is invention. Whether a target phone can run a "good" count within an acceptable login delay is unmeasured. | Verification V-01..V-03 (§5). Rule: set *N* from (a) the owner's login-latency budget on a low-end phone and (b) the current OWASP guidance read at that time. If the budget forces *N* below guidance, record a **named accepted deviation** rather than quietly proceeding. |
| **F-04** | Medium | The pepper protects against a **sheet-only** leak (mis-shared spreadsheet, stolen backup file, wrong-person share — the likeliest scenarios, threat 5.9). It does **nothing** against anyone with script-editor access, or a compromise of the owner Google account, because pepper and sheets live in the same account. | State this scope in the owner-facing docs. Do not describe the pepper as protecting against insider/account compromise. |
| **F-05** | Medium | Client-side hashing offers **no protection against hostile front-end code**. If the GitHub repo/account, a dependency, or a script loaded on the login page is compromised, `auth.js` can capture the raw password before hashing. The Google Sign-In client script will be on the same pages as password fields. | Front-end integrity controls (2-factor on the GitHub account, protected branch, no third-party scripts beyond Google's, CSP via `<meta>`). Best-effort only; GitHub Pages header limits **[ASSUMPTION]**. |
| **F-06** | Medium | `H1` is a **password-equivalent**: whoever holds `H1` can log in to this site. Benefit that remains: `H1` is site-specific (salted), so it cannot be replayed to *other* sites where the user reused the password. | Document honestly. Never log request bodies. |
| **F-07** | Medium | Option B (server-side loop) risks: low achievable iterations (unmeasured); the **server handles the plaintext**; and an attacker can force CPU-heavy executions with junk logins (DoS amplification) — unless cheap pre-checks run first. | Only consider if the benchmark (V-02) shows an acceptable count; keep hashing **outside** `LockService`. |
| **F-08** | Low–Medium | Browser support: Web Crypto PBKDF2 needs a modern browser and (per general knowledge) a secure context **[UNCHECKED]**. No fallback is designed. An embedded/old browser could be unable to log in. | Decide the minimum-browser policy; fail with a clear message rather than silently weakening hashing. |
| **F-09** | Low | Password normalisation (NFKC) must behave identically on all devices, or non-ASCII passwords lock users out. | Include non-ASCII test vectors. |
| **F-10** | Low | Credential upgrade path (raising *N* later) must exist: login with old params, then the client re-derives with new params and sends it via an authenticated `upgrade_credential`. | Add to the design; do not store *N* as a global constant. |
| **F-11** | Low | **Randomness:** `getUuid()` is **[DOCUMENTED]** as equivalent to Java's `randomUUID()`. Whether that is a cryptographically strong source in Google's runtime is **[UNCHECKED]** (Java's documentation, not read). `SECURITY_DESIGN.md` §1.6 ("no documented CSPRNG") was therefore too absolute. | Keep the HMAC-with-secret mixing as defence in depth, but soften the claim (see §1.3, C-01). |

#### What each option actually buys (by scenario)

| Scenario | Option A | Option B |
|---|---|---|
| Spreadsheet leak, pepper **not** leaked | Strong: attacker cannot even test guesses without the pepper | Same |
| Spreadsheet **and** pepper leaked (editor/insider/account takeover) | Attacker pays *N* PBKDF2 iterations **per guess** — as strong as *N* is high | Attacker pays whatever small count Apps Script could afford |
| Online guessing through the API | Throttled by rate limits (§2 of the design); attacker also pays *N* per guess to compute `H1` | Throttled; server pays CPU per attempt |
| Hostile or tampered front-end JS | **No protection** | No protection |
| Passwords chosen weak or reused | **No improvement**; policy only client-side | Server can enforce policy |
| Password seen by the server | Never (only `H1`) | Yes, in memory |

#### Recommendation (not an approval of security)

**[REC]** Approve Option A **provisionally**, subject to these conditions, and revisit if any fails:

1. Fix F-01 (`get_kdf_params`) in the design before any code.
2. *N* is chosen only after V-01, V-02, V-03.
3. The owner accepts F-02 (policy client-side only) and F-04/F-05 (limits of pepper and client-side hashing) in writing.
4. Front-end integrity controls are in place before launch.
5. The Option B benchmark result is shown to the owner; if Option B reaches then-current guidance, its simplicity and server-side policy enforcement may be preferable.

**Consequence of not deciding:** no registration, login, or reset can be implemented, and therefore nothing needing a session.

### 1.2 D-14 — Google ID-token verification

#### Verdict

Using `tokeninfo` through `UrlFetchApp` is **feasible**. It is **not Google's production-recommended method** [DOCUMENTED, older guide]. Whether it is *secure enough* depends on endpoint behaviour, claim checks, and replay defence — **none of which has been tested live.** It should be approved only as a *provisional* option gated by a live test, or the Google sign-in feature should be deferred.

#### What is documented vs assumed

| Claim | Status |
|---|---|
| Verify signature, `aud`, `exp` (and `iss`) before trusting the token | **[DOCUMENTED]** (GIS page: signature, `aud`, `exp`; older page adds `iss`) |
| The `aud` check prevents tokens issued to another app being accepted | **[DOCUMENTED]** (GIS page wording) |
| `tokeninfo` is for "development and debugging"; libraries are recommended for production | **[DOCUMENTED]** (older guide only; current GIS page extract does not mention `tokeninfo` — **[UNCHECKED]** whether still supported/unchanged) |
| Apps Script has no RSA **verify** | **[ASSUMPTION]** — only RSA-SHA256 *signing* seen in an incomplete listing |
| GIS web nonce can be bound into the token and read back from `tokeninfo` | **[UNCHECKED]** — nonce is documented for Android only |
| `tokeninfo` quotas/rate limits | **[UNCHECKED]**; no figure found |
| UrlFetch quota: 20,000/day consumer, 100,000/day Workspace | **[DOCUMENTED]** (extract); third-party posts agree |

#### Findings

| ID | Severity | Finding | Required action |
|---|---|---|---|
| **G-01** | **High** | `tokeninfo` is labelled debug-grade. Its rate limits, latency, and long-term support are undocumented in what I read. It could throttle or change when you need it. | Live test (S-1..S-6 below). Fail **closed** (reject login) on any error. Monitor failures. Google sign-in outage must never block password login. |
| **G-02** | **High** | **Replay window.** A stolen valid ID token logs in as the victim until it expires. A server-issued, single-use **nonce** is the documented-for-Android mitigation; web support **[UNCHECKED]**. If the nonce is not echoed by `tokeninfo`, this protection **does not exist**. | Verify nonce echo (S-3). Add a cheap complementary control: reject tokens whose `iat` is older than a short window **[PROPOSED]** (e.g. 5 minutes). Design stateless signed nonces (HMAC with expiry) plus single-use tracking, and rate-limit the nonce-issuing operation (it is another unauthenticated endpoint). |
| **G-03** | Medium | The GIS redirect mode relies on a **cookie** double-submit (`g_csrf_token`) **[DOCUMENTED]**. Apps Script web apps likely cannot read cookies/headers **[COMMUNITY]**. | Use the **JavaScript-callback** mode (the credential is handed to `auth.js`, then sent in the JSON body). Confirm in S-2. State why a cookie CSRF check is not used. |
| **G-04** | Medium | `tokeninfo` returns claim values as **strings** in the sample seen (`exp`, `iat`). Boolean-like claims (`email_verified`) may also be strings. Naive truthiness checks are classic bugs. | Explicit type-aware parsing and tests: `"false"` must reject. |
| **G-05** | Medium | Each Google login costs one URL fetch, shared with every other fetch use (CAPTCHA, breach checks) against the owner's daily quota. A junk-token flood burns executions and fetches. | Reject malformed tokens locally (size, three segments) **before** fetching. **Never trust** locally decoded claims; they are only for early rejection. Global cap. |
| **G-06** | Medium | Account linking/takeover (D-19): link by `sub`, not email; require `email_verified`; Gmail canonicalisation. | Settle D-19 first. |
| **G-07** | Medium | **Public registration needs a production-ready OAuth configuration** (authorised JavaScript origin for the GitHub Pages site, consent-screen publishing status). Rules for apps left in "testing" mode (e.g. limits on who can sign in) are **[UNCHECKED]**. | Verify before promising Google sign-in to the public (V-12). |
| **G-08** | Low–Medium | Option B (manual RSA verification in Apps Script): would require fetching Google's public keys, handling key rotation, and implementing RSA verification in plain JS. No vetted library is known to me **[ASSUMPTION]**. High risk of subtle error. | **Not recommended.** If ever chosen: test vectors and an independent crypto review. |
| **G-09** | Low | TLS verification behaviour of `UrlFetchApp` (default certificate validation) **[UNCHECKED]**. | Confirm; never disable certificate validation. |

#### Live acceptance tests (a throwaway test project, S-1…S-6; no production code)

- **S-1** Call `tokeninfo` with a real token. Record returned fields, types, latency, error shapes for expired/forged/wrong-audience tokens.
- **S-2** Confirm GIS JS-callback sign-in works from a `github.io` origin and the credential reaches an Apps Script `doPost`.
- **S-3** Set a nonce at GIS initialisation; check whether it appears in `tokeninfo` output.
- **S-4** Repeat 100–200 sequential calls (modest rate); observe throttling/errors.
- **S-5** Verify `aud` rejection with a token from a different client ID; `email_verified` handling; non-Gmail accounts.
- **S-6** Check current Google docs for any deprecation notice for `tokeninfo`.

**Recommendation [REC]:** approve **provisionally**: `tokeninfo` + own `aud`/`iss`/`exp`/`iat`/`email_verified`/type checks + nonce (if S-3 passes). If S-1..S-6 fail or if you prefer not to rely on a debug-labelled endpoint, **defer Google sign-in** (feature-level block only). Password registration and login are unaffected by this decision.

### 1.3 Corrections needed in `SECURITY_DESIGN.md` (NOT applied; I was told not to modify it)

| ID | Where | Issue |
|---|---|---|
| **C-01** | §1.5, §1.6, §7.2 | Soften "no documented CSPRNG": `getUuid()` is documented as equivalent to Java `randomUUID()`. Strength in Google's runtime is unchecked. Keep HMAC mixing. |
| **C-02** | §1.2, §1.4 | Replace "deterministic client salt from username/email" with a `get_kdf_params` operation (F-01). Add it to the §4.3 API table and the §2.2 rate-limit table. |
| **C-03** | §2.1, §6.8, §7 | The "about 30 simultaneous executions" figure is **[COMMUNITY]**; an official-page extract this turn shows **1,000 simultaneous executions per script**. Mark as **[CONFLICT]**; the load test decides. Also note quotas are **per user** (the owner, since *Execute as: Me*) and reset 24 h after first request. |
| **C-04** | §2.1, §1.7, §0.3 | UrlFetch quota is now **[DOCUMENTED]**: 20,000/100,000 per day. Add Properties read/write 50,000/500,000 per day. |
| **C-05** | New | **Properties-quota impact:** reading the pepper, token secret and three spreadsheet IDs one by one on every request could burn the Properties quota. Read them in **one** call per request and/or cache them. (Does a bulk read count once? **[UNCHECKED]**.) |
| **C-06** | §5.5 | Cross-reference says "authorization test matrix (§9)"; it is §6.8. |
| **C-07** | §11.2 | D-14 is listed as blocking in general. It blocks **only Google sign-in** (feature-level). Also, "approval-required" in §11.2 omits D-23's confirmation need. Rewrite the handoff to the slice model in §7 of this review. |
| **C-08** | §1.7 | Add `iat` freshness check and string-type claim parsing (G-02, G-04); state JS-callback mode (G-03). |

---

## 2. Owner decisions

"Blocks" uses these scopes: **ALL** = no backend work should start; **AUTH** = registration/login/reset/sessions; **GOOGLE** = Google sign-in only; **EXAM** = attempts/scoring features; **CONTENT** = importing the question bank; **LAUNCH** = public go-live only, coding may proceed; **NONE** = does not block code.

Numbers are grouped into profiles in the worksheet (§6) so you do not have to approve every value separately.

| ID | Exact question | Recommended default | If you choose differently | Blocks |
|---|---|---|---|---|
| **D-01** | Which password-storage approach do you approve to start building: **A** (browser PBKDF2 pre-hash + server HMAC wrap, with `get_kdf_params`), **B** (server-side iterated HMAC), or **defer** password sign-in? | **A, provisional**, final iteration count set after benchmarks V-01..V-03; conditions in §1.1 | **B**: server sees plaintext, iteration count probably lower (unmeasured), but policy can be enforced server-side. **Defer**: contradicts the fixed architecture and the existing login/register pages, but removes the weakest area. | **AUTH** (and, through sessions, everything else) |
| **D-02** | Do you accept: minimum 8 / maximum 128 characters, no composition rules, a built-in common-password blocklist enforced **only in the browser**, and no breached-password lookup? | Yes | Composition rules: guidance generally argues against them (**[UNCHECKED]**). Breached lookup: third-party call + fetch quota + privacy cost; impossible under Option A anyway. | AUTH (registration/reset) |
| **D-03** | Do you accept the OTP profile in §6 Q3: 6 digits, expires in 10 min, 5 wrong tries, 60 s between sends, ≤3 sends/hour and ≤5/day per email and purpose? | Yes (Standard profile) | Longer or looser: easier for users, more guessing and email-quota drain. Stricter: more failed sign-ups from slow email delivery. | AUTH (registration/reset) |
| **D-04** | Do you accept the session profile: normal login 12 h max / 2 h idle; "keep me logged in" 30 d max / 7 d idle? | Yes (Standard) | Longer sessions: more exposure if a token is stolen. Shorter: more re-logins (a re-login mid-exam must still resume the attempt). | AUTH (login) |
| **D-05** | Do you accept identifier-based throttles (e.g. 5 failed logins / 15 min → escalating delay, global caps) knowing they cannot stop distributed attacks and enable victim lock-out delays? | Yes (Standard); values re-tuned after load test | Stricter: more legitimate lock-outs. Looser: more guessing and quota abuse. No IP limit is possible either way. | LAUNCH (values); code can start |
| **D-06** | What are the marking rules for MCQ, MSQ and NAT (marks for correct, wrong, unattempted; partial credit; NAT tolerance)? | **No default.** You supply them, preferably from the official GATE scheme once verified | Whatever you choose changes every score and the answer-key format (see §3.2) | **EXAM** (scoring, results); not auth |
| **D-07** | For each intended question source, do you have the right to use, store and display it? | Start only with material you authored or can document rights for; get legal advice for past papers | Importing unlicensed material is a legal risk to you and invalidates `terms.html` claims | **CONTENT** (import); not code |
| **D-08** | Do you accept the retention profile: OTP rows 24 h, sessions 30 d after expiry, audit logs 12 months, attempts until account deletion, backups ≤30 days? | Yes (Standard); wording to go into `privacy.html` | Longer retention: more data at risk and more to delete. Shorter: weaker investigations. | LAUNCH; purge defaults for OTP/sessions needed for AUTH |
| **D-09** | Do you accept **no admin API in v1** (admin work via Sheets/script editor by one dedicated owner account plus one break-glass person)? | Yes | An admin API adds an anonymous-reachable privileged surface needing its own design review. | NONE for code; LAUNCH (account setup) |
| **D-10** | Do you accept daily backups to a restricted folder (14 daily + 8 weekly), a quarterly restore test, and a versioned pepper for rotation? | Yes | No backups: terms already warn of loss; a mis-edit or deletion could be permanent. | LAUNCH (before real user data) |
| **D-11** | What duration applies to a **100-mark** paper? (The 65-mark formula stays fixed.) | **No default — see §3.1.** Option "hold": do not offer 100-mark totals until decided | See §3.1 | **EXAM**, only for attempts whose total is 100 marks |
| **D-12** | When fewer questions are requested than match, is the subset random or fixed? How is a full-length mock composed (and by whom)? | Random without replacement for subsets; mock composition defined by you | Fixed subsets: repeatable but predictable. Undefined mock composition: mock mode cannot be built. | **EXAM** (mock mode, custom subsets) |
| **D-13** | What workload must this system support (users, peak concurrent exam takers, simultaneous starts)? | Answer the §4 questions; run the small load test before building exam features | Guessing the workload risks building on a platform that cannot carry it | Should precede **EXAM**; not auth |
| **D-14** | Do you approve `tokeninfo` verification (with own checks and nonce) as a **provisional** method, subject to the live test in §1.2? Or defer Google sign-in? | Provisional approval + live test | Defer: no Google button at launch (static button stays disabled). Manual RSA: not recommended. | **GOOGLE** only |
| **D-15** | Do you want a bot challenge (CAPTCHA/Turnstile) on OTP-sending forms? | **Not in the first build**; keep a hook; decide after load/abuse testing | Adding it: reduces email-quota abuse, adds a third party, accessibility and privacy cost, and more fetches | NONE (decide before LAUNCH) |
| **D-16** | Will you obtain legal advice on applicable law (including Indian data-protection requirements), a minimum age, and breach-notification duties before public registration? | Yes, before launch | Launching without it leaves `privacy.html`/`terms.html` placeholders unresolved | **LAUNCH** |
| **D-17** | Attempt policy: allow pause? how many active attempts? grace after the deadline? how many starts per hour? | Standard profile: no pause, one active attempt per mode, 15 s grace, 10 starts/hour | Allowing pause breaks server-authoritative timing; more concurrent attempts increase load and scraping; longer grace weakens the deadline | **EXAM** |
| **D-18** | When may users see correct answers and explanations? | Only after submitting, only for that attempt's questions | Immediate feedback (practice) weakens exam integrity and complicates keys-in-payload rules | **EXAM** (results) |
| **D-19** | When a Google sign-in matches an existing password account's Gmail, do we auto-link? Can Google-only users add a password? | Link by Google `sub`; auto-link only if the existing Gmail was OTP-verified and Google reports it verified; allow adding a password via OTP-confirmed flow | Auto-linking without verification enables account takeover; no linking creates duplicate accounts | **GOOGLE**; and the **AUTH** schema (canonical email) |
| **D-21** | Where may the browser keep the session token? | `sessionStorage` normally; `localStorage` only with "keep me logged in" | Both are readable by injected scripts; `HttpOnly` cookies are not available **[ASSUMPTION]** | AUTH (login) |
| **D-22** | Will the owner Google account be a **consumer Gmail** or **Google Workspace** account? | Workspace if possible | Consumer: only 100 email recipients/day and lower fetch/properties/trigger quotas **[DOCUMENTED]**; that caps sign-ups | LAUNCH (capacity); informs D-03 |
| **D-24** | Create or remove the links to `history.html`, `bookmarks.html`, `profile.html`, and share `help.html`, `contact.html`, `security.html` for review? | Share the three pages; decide per link | Dead links; `practice.html` points at `security.html#scoring` which was never reviewed | NONE |

**Quick confirmations (not blockers):** **D-20** do not shuffle MCQ/MSQ options in v1 (low impact). **D-23** confirm every question's marks is a whole number (it makes duration rounding tie-free: §3.1); if fractional marks exist, rounding of exact halves must be specified — this slightly affects question-schema and duration tests.

---

## 3. Exam policy

### 3.1 D-11 — Duration for 100-mark papers

**Fixed and preserved:** `duration_minutes = total_selected_marks / 65 × 180`, rounded to the nearest second. A 65-mark paper lasts 180 minutes. Duration depends on total selected **marks**, not question count. I do not change this and I do not decide the 100-mark case.

**Reference values** (integer seconds = `round(marks × 10800 / 65)`; I re-computed these):

| Total marks | Seconds | Duration |
|---|---|---|
| 65 (fixed rule) | 10,800 | 3 h 00 min 00 s |
| 99 | 16,449 | 4 h 34 min 09 s |
| **100, formula applied unchanged** | **16,615** | **4 h 36 min 55 s** |

**[ASSUMPTION — verify against the official GATE brochure]** I recall a real GATE paper as 65 questions worth 100 marks in 3 hours. If true, the formula as stated gives 1.54× the real time for the same total marks (276.9 min vs 180 min), i.e. about 2.77 minutes per mark versus 1.80 in the real paper. I have not verified this, so it is a question to settle, not a finding.

**Options**

| Option | Rule | 100-mark result | Consequences |
|---|---|---|---|
| **O1 — formula unchanged for all totals** | One rule, no special case | 16,615 s (4 h 36 min 55 s) | Simplest and fully consistent with the stated principle. If the real exam is 180 min for 100 marks, mock practice is much more relaxed than the real thing. |
| **O2 — fixed 180 min whenever total = 100 marks, formula otherwise** | Special case keyed on marks | 10,800 s (3 h) | Matches the real exam (if the assumption holds) for full papers. Creates a discontinuity: 99 marks → 4 h 34 min 09 s but 100 marks → 3 h 00 min 00 s (94 min 9 s shorter). Need to define what a "100-mark" custom test is. Breaks "duration depends only on marks". |
| **O3 — duration keyed on **mode**: full-length mocks use a fixed duration you specify; all other modes use the formula** | Special case keyed on mode | Whatever you specify for mocks | Avoids the marks discontinuity; mimics the real exam in mock mode. But two tests with identical questions can have different durations depending on how they were started. Depends on D-12 (mock composition). |
| **O4 — hold** | Do not offer any 100-mark total until decided | Not offered | Zero risk of a wrong rule. Full-paper mocks cannot ship. |
| *(Excluded)* — rescale to 100 (`marks / 100 × 180`) | Changes the formula | 180 min for 100; **117 min for 65** | Contradicts the fixed rule (65 marks = 180 min). Only valid if you explicitly retire the fixed rule. |

**Scope:** D-11 blocks only attempts whose total is 100 marks (and the preview that shows their duration). Other totals can use the fixed formula.

**Decision needed from you:** O1, O2, O3 (with the duration value), or O4. **I recommend no option until the official structure is verified** (V-14).

### 3.2 D-06 — Marking rules

I do **not** propose any marking value. Below are the choices you must make, and what each one changes. Duration is **not** affected by marking choices (it depends on marks selected).

| Choice | Options | What it changes |
|---|---|---|
| **Wrong-answer penalty (negative marking)**, per type | None / for some types / proportional to the question's marks (you supply the numbers) | Score can go below zero; changes the incentive to guess; changes how "accuracy" and "score" on the dashboard must be defined; stored `awarded_marks` must allow negatives; ranking and comparison to real exam. |
| **Unattempted** | Zero / other | Simple; any other value is unusual and needs explanation on the test summary. |
| **MSQ scoring** | All-or-nothing / partial credit for a subset of the correct options (without wrong ones) / partial with penalties | Key format (set of options), complexity of tests, the explanation shown to users, and fairness expectations. Partial credit multiplies edge cases. |
| **MCQ scoring** | Correct = full marks of the question; any other rule | Usually straightforward; confirm. |
| **NAT answers** | Exact match / absolute tolerance / range / per-question tolerance | Key storage (value vs range), input normalisation (decimal point, spaces, rounding), number of grading disputes, and a per-question tolerance field. |
| **One rule set vs per-mode rules** | Same for all modes / different for practice and mocks | Rule-version bookkeeping; users could see different scoring for the same question. |
| **Rule source** | Mirror the official GATE scheme (after verification) / your own | Mirroring avoids contradicting `terms.html`'s statement that scores "may differ from the real GATE examination", but only if the official scheme is verified (V-14). |
| **Rules versioning** | Pin a version per attempt (design already proposes `rules_version`) | Later rule changes do not rewrite old scores. |

**What I need from you (fill in the blanks; do not guess):**

| Type | Correct | Wrong | Unattempted | Partial credit? | Tolerance |
|---|---|---|---|---|---|
| MCQ | ___ | ___ | ___ | n/a | n/a |
| MSQ | ___ | ___ | ___ | ___ | n/a |
| NAT | ___ | ___ | ___ | n/a | ___ |

**Related policy gaps not in the register** (no D-ID assigned; add them if you agree): what happens if an **answer key is corrected after people have submitted** (rescore or not); what happens if a **question is withdrawn or ambiguous** (these change scores and may need a rule); how bookmarks/history behave when a question is **retired**. These affect scoring but are not decided anywhere.

**Scope:** D-06 blocks scoring, results, and everything that reports a score (dashboard progress). It does **not** block registration, login, or reset.

---

## 4. Capacity — D-13

### 4.1 Workload information needed

Please answer in rough ranges; the point is order of magnitude.

1. **Users:** registered users expected at 1, 6 and 12 months; new sign-ups per day at the busiest time.
2. **Concurrency:** highest number of people **taking an exam at the same time**; and whether starts are **simultaneous** (a scheduled mock event) or spread out.
3. **Exam shape:** typical question count and length (a full 65-question paper vs 10-question practice); how often you want answers autosaved.
4. **Stakes:** is a lost or delayed autosave during a timed exam tolerable, or does a failure make the product unacceptable?
5. **Question bank:** approximate number of questions; whether questions contain **images or equations** (cell size limits and hosting need thought; a 50,000-character cell limit appeared in the Drive limits page [DOCUMENTED]).
6. **Owner account type:** consumer Gmail or Workspace (D-22).
7. **Acceptable latency:** the slowest save/submit response a student would accept.
8. **Availability:** can the service be down for hours without serious harm?

**Quota facts that bear on capacity** (labels as in §0.2):

| Fact | Status | Illustrative impact (arithmetic only) |
|---|---|---|
| Email recipients: 100\*/day consumer, 1,500\*/day Workspace; `*` footnote unread | [DOCUMENTED] | Every sign-up/reset needs ≥1 OTP email; 100/day is a hard ceiling for consumer |
| URL Fetch: 20,000/day consumer, 100,000/day Workspace | [DOCUMENTED] | One fetch per Google login; fine at small scale |
| Properties read/write: 50,000/day consumer, 500,000/day Workspace | [DOCUMENTED] | If each request costs 1 Properties read and a student saves every 30 s for 180 min (360 saves), the quota covers ~138 such full-length sessions/day on consumer (~1,388 on Workspace), ignoring other traffic. Whether a request counts as 1 read is **[UNCHECKED]**. |
| Simultaneous executions: 1,000 (official extract) vs ~30 (community) | **[CONFLICT]** | The load test must decide |
| One script lock serialises all locked writes | [DOCUMENTED] | Throughput ≈ 1 ÷ lock hold time |
| Quotas are per user and "subject to change without notice" | [DOCUMENTED] | Capacity is not guaranteed |
| Sheets: 10M cells (Drive help) vs 20M (third party) | **[CONFLICT]** | Plan at 10M |

### 4.2 A small, measurable load test (spec only — nothing is built in this task)

**Safety first:** run it against a **separate test copy** (script + three spreadsheets) owned by a **separate test Google account of the same type** as your planned owner (consumer vs Workspace). Quotas are per owner account, so exhausting them would lock your real account. Send only a handful of real OTP emails; stub the rest. Keep request rates modest and within Google's terms.

**Scenarios:**

| # | Scenario | Purpose |
|---|---|---|
| L-1 | Single-user baseline: each operation × 30 | Latency of each op, cold-start delay after idle |
| L-2 | Autosave ramp: *K* simulated exam takers saving every 30 s plus a save on each navigation; *K* = 5, 10, 20, 40, 80 (10 min each) | Sustained lock contention and error rate |
| L-3 | Simultaneous start: *K* `start_attempt` calls within 10 s | Start burst |
| L-4 | Simultaneous submit: *K* `submit_attempt` within 30 s | Most likely lock-timeout case |
| L-5 | Login burst: *K* logins in 60 s | Hashing/lookup cost |
| L-6 | Abuse sanity: 100 failed logins on one identifier; a 50-request junk flood while *K* users save | Throttle works; flood does not starve real users |
| L-7 | One-hour soak at expected average load | Quota consumption extrapolated to a full day |

**Measure:** p50/p95/p99 latency per operation; error rate by cause (lock timeout "busy", quota exception, HTML error page); server-measured **lock wait and lock hold time**; executions, Properties reads, fetches, emails consumed; rows written; and **data integrity**: every acknowledged save must be present after the test, no double submissions, and scores must match a reference calculation.

**Capacity arithmetic to use (illustrative inputs, not measurements):**
- Locked-write capacity ≈ 1 ÷ *h* per second, where *h* is the mean lock hold time. With *h* = 0.4 s: 2.5 writes/s; at 50% utilisation, 1.25/s; with 30 s autosave, ≈ 37 concurrent takers.
- Burst effect: if 40 submits each hold the lock 1.5 s, the last waits ≈ 60 s. With a 10 s lock timeout only about 6 succeed on the first try; the rest need retry with backoff. Scoring should be computed **outside** the lock.

**Go / conditional / no-go thresholds** — **[PROPOSED]**; you only need to supply three inputs (target peak concurrent takers *K*, acceptable p95 save latency, acceptable failure rate). The rest follow.

| Criterion | Proposed threshold |
|---|---|
| Acknowledged saves lost or corrupted | **0** (hard requirement) |
| Double scoring, duplicate attempts, score ≠ reference | **0** (hard requirement) |
| Save success after one client retry at 1.5 × *K* | ≥ 99.5% |
| p95 save latency | ≤ 3 s |
| p95 submit latency | ≤ 8 s |
| Lock-timeout ("busy") rate at *K* | ≤ 1% |
| Login p95 | ≤ 5 s |
| Extrapolated daily quota use at expected load | ≤ 50% of every relevant quota |

**Outcomes:** *Go* = all met at 1.5 × *K*. *Conditional* = met only at *K*: launch with a **server-enforced cap on concurrent active attempts** and staggered mock starts. *No-go* = fails at *K*: do not build timed exams on this stack for that workload (the architecture is fixed by you, so this is your decision: reduce scope or revisit).

---

## 5. Evidence gaps before the design is production-ready

**Status key:** DOC = documented in an official extract; COM = community only; ASM = assumption; UNC = unchecked; CNF = conflict; REC = recommendation.

| # | Claim in the design | Status | How to verify | Source |
|---|---|---|---|---|
| V-01 | Browser PBKDF2 at a chosen *N* meets login-latency budget on low-end phones | UNC | Measure on real devices | https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveBits |
| V-02 | Server-side HMAC loop speed (Option B) | ASM | Benchmark in test project | Apps Script `Utilities` |
| V-03 | Current password-storage guidance (iteration counts) | UNC | Read the pages | https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html ; https://pages.nist.gov/800-63-4/sp800-63b.html |
| V-04 | Script Properties readable by editors; encryption at rest | UNC | Read docs; test with a second editor | https://developers.google.com/apps-script/reference/properties |
| V-05 | Request headers/IP/origin not exposed to `doPost`; no cookies | COM | Test deployed web app | https://developers.google.com/apps-script/guides/web |
| V-06 | Cross-origin `text/plain` POST works; redirect/CORS behaviour; error pages on quota failure | COM | Test from a `github.io` origin | same |
| V-07 | `ContentService` cannot set response headers (no `HttpOnly` cookie) | ASM | Read docs | https://developers.google.com/apps-script/reference/content |
| V-08 | GitHub Pages cannot add headers; `<meta>` CSP limits (no `frame-ancestors`) | ASM | Read docs; test | GitHub Pages documentation |
| V-09 | `tokeninfo` behaviour, limits, support status | DOC (debug-labelled) / UNC (current) | Spikes S-1..S-6 | https://developers.google.com/identity/sign-in/web/backend-auth |
| V-10 | Web GIS nonce echoed in verification output | UNC | Spike S-3 | https://developers.google.com/identity/gsi/web/guides/overview |
| V-11 | JS-callback GIS flow from GitHub Pages into `doPost` | UNC | Spike S-2 | same |
| V-12 | OAuth consent screen/publishing status for public sign-in | UNC | Read Google Cloud docs | Google Cloud OAuth consent documentation |
| V-13 | Email quota `*` footnote; Gmail sending limits; `MailApp` OAuth scope names | UNC | Read the quota page in full; `MailApp` reference | https://developers.google.com/apps-script/guides/services/quotas |
| V-14 | Official GATE structure: marks, question count, duration, marking scheme | UNC | Read the current brochure | The GATE organising-institute website |
| V-15 | Simultaneous executions: 1,000 vs ~30 | CNF | Load test L-2..L-4 | quota page |
| V-16 | `getUuid()` randomness quality; `Math.random()` for shuffling is acceptable | DOC (equivalence) / UNC (strength) | Read `Utilities` page in full; Java docs | https://developers.google.com/apps-script/reference/utilities/utilities |
| V-17 | Sheets cell limit 10M vs 20M | CNF | Re-read Drive help page | https://support.google.com/drive/answer/37603 |
| V-18 | `CacheService` size/TTL; whether a bulk Properties read counts once | UNC | Read docs; measure | https://developers.google.com/apps-script/reference/cache |
| V-19 | Trigger limits suffice for expiry sweeps, purges, backups | DOC (limits) | Plan trigger runtime | quota page |
| V-20 | Gmail canonicalisation rules (dots, `+`, `googlemail.com`) | ASM | Read Google help | Google Account/Gmail help |
| V-21 | Legal: data-protection law, minimum age, retention duties | UNC | Qualified advice | n/a |
| V-22 | Lock semantics under concurrent web-app executions; script lock covers all users | DOC (class) | Test double-submit race | https://developers.google.com/apps-script/reference/lock/lock |

**Documented facts I would treat as established (still from extracts):** quota rows in §0.2, HMAC/RSA signing and `getUuid` equivalence, GIS verification criteria, the nonce note for Android, lock method behaviour, execute-as semantics, Drive's 10M-cell statement.
**Recommendations (not facts):** every proposed number in `SECURITY_DESIGN.md`, the three-spreadsheet split, Option A, `tokeninfo` use, "no admin API v1", lazy expiry.

---

## 6. Decision worksheet

Answer by letter. "Default" is my recommendation; a bare "default" answer accepts it. Every original D-ID is covered.

**Q1 (D-01).** Password storage: **A** browser PBKDF2 pre-hash + server wrap with `get_kdf_params` *(default, provisional)*; **B** server-side iterated HMAC; **C** defer password sign-in.
**Q2 (D-02).** Password policy: **A** min 8/max 128, no composition rules, browser-only blocklist, no breach lookup *(default)*; **B** add composition rules; **C** also add a breached-password lookup (not possible under Q1-A).
**Q3 (D-03 + D-05).** Abuse/OTP profile: **Standard** *(default)* = OTP 6 digits, 10 min expiry, 5 wrong tries, 60 s resend gap, ≤3/hour and ≤5/day per email; 5 failed logins per 15 min then escalating delay; **Stricter** (fewer tries, longer waits: fewer abuse risks, more locked-out real users); **Lenient** (more tolerance, more email-quota and guessing exposure). Values will be re-tuned after the load test.
**Q4 (D-04 + D-21).** Session profile: **Standard** *(default)* = normal 12 h max / 2 h idle in `sessionStorage`; "keep me logged in" 30 d / 7 d in `localStorage`; **Shorter** (e.g. 4 h / 30 min; 7 d / 24 h) or **Longer**. Longer = more theft exposure; shorter = more re-logins.
**Q5 (D-22).** Owner account: **A** Workspace *(default)*; **B** consumer Gmail (100 emails/day cap).
**Q6 (D-13).** Give: (a) expected registered users at 6 months; (b) peak concurrent exam takers; (c) simultaneous scheduled mocks (yes/no); (d) is losing an in-progress attempt acceptable (yes/no); (e) slowest acceptable save/submit time. Also: **approve the small load test in §4.2 on a separate test account? (yes/no)** *(default yes)*.
**Q7 (D-19).** Account linking: **A** link by Google `sub`; auto-link to an existing account only if its Gmail was OTP-verified; allow later password addition via OTP *(default)*; **B** never auto-link (separate accounts per method; duplicates possible).
**Q8 (D-14).** Google sign-in verification: **A** provisional `tokeninfo` + own checks + nonce, gated by spikes S-1..S-6 *(default)*; **B** defer Google sign-in; **C** manual RSA verification (not recommended).
**Q9 (D-15).** Bot challenge: **A** not in first build, decide later *(default)*; **B** include from the start; **C** never.
**Q10 (D-06).** Marking rules: fill the table in §3.2, **or** state "mirror the official GATE scheme once verified" and authorise me to read the brochure and present it for your confirmation.
**Q11 (D-11).** 100-mark duration: **O1** formula unchanged (16,615 s); **O2** fixed 180 min at exactly 100 marks; **O3** fixed duration for full mocks (give the value) and formula elsewhere; **O4** hold, don't offer 100-mark totals yet *(my suggestion pending the official structure)*.
**Q12 (D-12 + D-23).** Subset and marks: (a) when fewer questions than matches are requested: **random without replacement** *(default)* or fixed; (b) who defines full-length mock composition; (c) are all question marks whole numbers? (yes/no).
**Q13 (D-17).** Attempt profile: **Standard** *(default)* = no pause, one active attempt per mode, 15 s grace after the deadline, 10 starts/hour; **Stricter** or **Lenient** (state which parameter). Pausing would break server-authoritative timing.
**Q14 (D-18 + D-20).** (a) Answers and explanations visible: **only after submit** *(default)* or also during practice; (b) shuffle MCQ/MSQ options? **no** *(default)*.
**Q15 (D-07).** For each intended question source (your own, past GATE papers, third-party), do you have documented rights? List sources and status; or confirm you will start with material you authored only *(default)*.
**Q16 (D-08 + D-10).** Retention and backups: **Standard** *(default)* = OTPs 24 h, sessions 30 d after expiry, audit logs 12 months, attempts until account deletion, backups ≤30 days, daily backups (14 daily + 8 weekly), quarterly restore test; or give changes.
**Q17 (D-09).** Admin: accept **no admin API in v1**, one dedicated owner account, one break-glass person? *(default yes)*
**Q18 (D-16).** Will you get legal advice (applicable law, minimum age, breach-notification duties) before public registration? *(default yes, before launch)* What minimum age do you propose?
**Q19 (D-24).** For `history.html`, `bookmarks.html`, `profile.html`: **create later** or **remove the links**? And please share `help.html`, `contact.html`, `security.html` for review.

**Minimum set for the first implementation slice (registration, OTP, password login, sessions):** Q1, Q2, Q3, Q4, Q5, Q7 (canonical-email part), Q16 (OTP/session purge values), Q17. Q6 and Q18 should be answered before launch.

---

## 7. Handoff

### 7.1 Status

**Backend implementation remains BLOCKED.** It stays blocked until:
1. the critical security decisions are resolved — **D-01** (password storage), plus **D-02–D-05**, **D-21** and **D-19** (account schema), and **D-22/D-13** for capacity sizing; and
2. the decisions needed for the **first implemented features** are resolved, per the slices below.

Approvals of D-01 and D-14 are **provisional** until the verification spikes (V-01–V-03, S-1–S-6) are run in a throwaway test project. Those spikes measure and test; they are **not** production code and need your permission and a separate test Google account.

### 7.2 Decisions by implementation slice

| Slice | Feature | Decisions that must be resolved first |
|---|---|---|
| **1** | Registration, OTP, password login, sessions, logout, password reset | D-01, D-02, D-03, D-04, D-05, D-21, D-19 (canonical email), D-22, D-09, D-08 (OTP/session purge), and corrections C-01, C-02, C-05 |
| **2** | Google sign-in | D-14, D-19, plus slice-1 decisions; verification V-09..V-12 |
| **3** | Practice and exams (preview, start, save, submit, results) | D-06, D-11 (for 100-mark totals), D-12, D-17, D-18, D-23, D-13 (load test first), D-07 for any real question content |
| **4** | Dashboard, history, bookmarks | Slice 1 + 3; D-24 for the missing pages |
| **5** | Account deletion, retention jobs, backups, go-live | D-08, D-10, D-16, D-15 |

### 7.3 Verification report

- **Files created:** `SECURITY_DECISION_REVIEW.md` only. **No other file was created or modified.** `SECURITY_DESIGN.md` and all HTML/CSS/JS files were opened read-only or not touched. No `Code.gs` or API code was written.
- **Documents read:** all 630 lines of `SECURITY_DESIGN.md` (viewed in ranges this turn), including all 24 decisions.
- **Sources checked this turn (via search-result extracts only):** Apps Script quota page (current table incl. UrlFetch, Properties, simultaneous executions), `Utilities` reference, Google Identity Services ID-token verification page, Android Credential Manager sign-in page (nonce note). Carried over from Task 8: older Sign-In backend guide, web-apps guide, `Lock` reference, Drive file-limits page.
- **Not read:** all items marked [UNCHECKED] in §0.2 and §5. I did not open any page in full.
- **Findings that change the design:** the salt defect (F-01), the quota conflict on simultaneous executions (C-03), the Properties-quota exposure (C-05), the over-absolute randomness claim (C-01), and a wrong cross-reference (C-06).
- **Arithmetic re-computed:** duration values in §3.1 (65 → 10,800 s; 99 → 16,449 s; 100 → 16,615 s; 100-mark drop under O2 = 5,649 s), pace ratios (276.9 min vs 180 min = 1.54×), Properties-quota example (50,000 ÷ 360 ≈ 138; 500,000 ÷ 360 ≈ 1,388), and the lock-throughput illustration.
- **Limitations:** the real-GATE structure (100 marks, 180 minutes) is my recollection and is **not verified**; every proposed numeric parameter remains [PROPOSED]; nothing here has been tested live.

### 7.4 Exact next task

**Answer the Decision Worksheet in §6 of `SECURITY_DECISION_REVIEW.md` (at minimum the slice-1 set: Q1–Q5, Q7, Q16, Q17), and approve or reject corrections C-01…C-08. Backend implementation stays blocked until then.** After that, the following task is: *issue `SECURITY_DESIGN.md` v2 incorporating your answers and the corrections, and define the throwaway verification-spike plan (no production code).*
