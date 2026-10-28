# GATE Prep Studio — Security Design

| | |
|---|---|
| **Document status** | DRAFT for owner review. No backend exists yet. Nothing here is implemented. |
| **Task** | Task 8 — Security Design Review |
| **Date** | 28 October 2026 |
| **Scope** | Design only. No `Code.gs`, API, or authentication code is written by this task. |
| **Architecture (fixed)** | GitHub Pages frontend → Google Apps Script web app (`Code.gs`) → Google Sheets. Google Sign-In (server-verified) + username/password + Gmail OTP. Public registration. No Apple login. Three JS files: `app.js`, `api.js`, `auth.js`. One `style.css`. |

---

## 0. How to read this document

### 0.1 Evidence labels

| Label | Meaning |
|---|---|
| **[CONFIRMED]** | Seen in an official Google page during this review (extracts read via search results; see §0.3). |
| **[COMMUNITY]** | Reported by non-official sources (blogs, repos, books). Plausible but **not** officially confirmed. Must be re-tested at implementation. |
| **[REC]** | Recommendation by this review. A design choice, not a fact. |
| **[ASSUMPTION]** | Believed true, not verified in this review. Verify before relying on it. |
| **[UNRESOLVED]** | Needs an owner decision. Tracked in §10 (Decision register, IDs `D-xx`). |
| **[PROPOSED]** | A numeric parameter suggested as a starting value. Not derived from a source. Needs approval and testing. |

### 0.2 Control strength labels

| Label | Meaning |
|---|---|
| **ENFORCEABLE** | The server can enforce it deterministically, given correct code and correct sharing settings. |
| **BEST-EFFORT** | Reduces risk, but can be bypassed, evaded, or fail under load/quota. Must not be described to users as a guarantee. |
| **NOT POSSIBLE** | The platform cannot provide it. Stated so no one assumes otherwise. |

### 0.3 Sources checked and verification limits

I could not open the Google documentation pages with a direct page fetch. The fetch tool only opens URLs that already appeared in search results, and several pages came back as search-result extracts (some translated or truncated). **Everything marked [CONFIRMED] comes from those extracts.** Extracts of the quota page differ between snapshots (one omitted the "Triggers total runtime" row), and the meaning of the `*` footnotes on the email rows was not retrievable. **Re-read each URL in full before implementation.**

| Topic | URL | Result |
|---|---|---|
| Apps Script quotas | https://developers.google.com/apps-script/guides/services/quotas (also `/apps-script/quotas`) | Extracts read. Footnotes (`*`) not retrieved. |
| Web apps (`doGet`/`doPost`, execute-as, access) | https://developers.google.com/apps-script/guides/web | Extract read. Does not state what headers/IP are exposed. |
| `LockService` / `Lock` | https://developers.google.com/apps-script/reference/lock/lock | Extracts read. |
| Google ID-token backend verification | https://developers.google.com/identity/sign-in/web/backend-auth (and iOS/Android variants) | Extracts read. This is the older Sign-In guide; the Google Identity Services page was **not** checked (see below). |
| Sheets/Drive file limits | https://support.google.com/drive/answer/37603 | Extract says 10 million cells. A third-party page claims 20 million. **Conflict — see §7.3.** |
| Sheets cell-limit history | https://workspaceupdates.googleblog.com/2022/03/ten-million-cells-google-sheets.html | 5M → 10M in March 2022. |
| Non-official (labelled [COMMUNITY]) | tanaikech "Web Apps" guide (GitHub); O'Reilly *Going Gas* ch. 4 | Used only for context. |

**Not checked (URLs recorded for later review):**

- Google Identity Services (nonce, `g_csrf_token`, button flow): https://developers.google.com/identity/gsi/web/guides/overview
- Apps Script `Utilities` (digest/HMAC/UUID/RSA functions): https://developers.google.com/apps-script/reference/utilities/utilities
- `CacheService`, `PropertiesService`, `MailApp`, `UrlFetchApp` (UrlFetch daily quota row was not captured), `appsscript.json` OAuth scopes.
- Sheets API/Apps Script spreadsheet service limits and concurrency behaviour.
- OWASP Password Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- OWASP Session Management Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- NIST SP 800-63B (password/OTP guidance): https://pages.nist.gov/800-63-4/sp800-63b.html
- Official GATE information brochure (marks, duration, marking scheme): the current GATE organising-institute website.
- Indian data-protection law applicability (the owner appears to be in India): needs qualified legal advice.

### 0.4 What the existing project contains (inspection result)

I reviewed the 9 files actually provided: `index.html`, `style.css`, `login.html`, `register.html`, `forgot-password.html`, `privacy.html`, `terms.html`, `practice.html`, `dashboard.html`. I did not modify them.

**Not provided for review** (listed in the task but not uploaded): `help.html`, `contact.html`, `security.html`. `practice.html` links to `security.html#scoring` and says scoring and answer-key handling are described there. That page must be reconciled with this document after approval (D-24).

**Findings that affect this design:**

1. All pages are static. Every action button is `aria-disabled="true"` and there is **no JavaScript yet**. The three-JS-file plan is not yet started.
2. `register.html`: username `[A-Za-z0-9_]{3,30}`; Gmail-only email pattern (`@gmail\.com`); password `minlength=8`, `maxlength=128`; OTP field `maxlength=12` numeric; consent checkbox; flow is *details → Send OTP → Verify OTP → Create account*. OTP is therefore verified **before** the account exists — the API must handle this (§4.3).
3. `login.html`: "Username or email" + password + a **"Keep me logged in on this device"** checkbox. That implies two session lifetimes (§1.5).
4. `forgot-password.html` promises the **same message whether or not an account matches**. The design must honour this (§1.4).
5. `privacy.html` / `terms.html` leave retention, minimum age, hashing method, question-source rights, liability, and contact as placeholders. These match decisions D-08, D-16, D-01, D-07.
6. `practice.html` says marking rules, mock-exam composition, and the duration formula are planned; marking rules and mock composition are explicitly "to be confirmed/defined" (D-06, D-12).
7. `index.html` links to `history.html`, `bookmarks.html`, `profile.html`, which are **not** in the declared project list. They will 404 unless created (D-24).
8. Pages declare no Content-Security-Policy. See §5.7.

---

## 1. Authentication

### 1.1 Transport and request shape

- **[REC]** All API calls are HTTPS `POST` with a JSON body from `api.js` to the Apps Script `/exec` URL. Credentials and session tokens go **in the body**, never in the URL/query string (URLs end up in logs and history).
- **[COMMUNITY]** `doPost(e)` does not expose request headers to the script, and the client IP is not available. Treat as true for design purposes and **test at implementation**. Consequence: no `Authorization` header, no `Origin` check, no IP-based control (§2.4).
- **[COMMUNITY]** Apps Script does not answer CORS preflight (`OPTIONS`). The usual workaround is a "simple" request, e.g. `Content-Type: text/plain` with a JSON string. **Test at implementation.** Do not rely on custom request headers.
- **[REC]** Every request carries `{ op, requestId, sessionToken?, payload }`. The server must return a uniform envelope `{ ok, code, data? }` and never leak stack traces or sheet names.
- **[REC]** Whitelist `op` values; unknown ops return a generic error and are rate-limited.

### 1.2 Password hashing suitable for Apps Script

**Facts**

- **[ASSUMPTION]** Apps Script offers SHA-256 digest and HMAC-SHA256 primitives (`Utilities.computeDigest`, `Utilities.computeHmacSha256Signature`). It has **no built-in bcrypt, scrypt, or Argon2**. Not re-verified here (Utilities reference not fetched).
- **[ASSUMPTION]** A pure-script PBKDF2 loop over `computeHmacSha256Signature` is slow per call and bounded by the 6-minute-per-execution limit **[CONFIRMED]** and by lock hold time. Achievable iteration counts are likely far below modern guidance (OWASP's PBKDF2-HMAC-SHA256 figure is in the hundreds of thousands — **[NOT VERIFIED]**, see §0.3). **Benchmark before deciding.**

**Options**

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Client pre-hash + server wrap** | Browser derives `H1 = PBKDF2-HMAC-SHA256(password, clientSalt, N)` with Web Crypto (`auth.js`), sends `H1`. Server stores `H2 = HMAC-SHA256(pepper, serverSalt ‖ H1)` plus `serverSalt`, scheme version, pepper version. | High iteration count is affordable on the user's device. Offline cracking of a leaked sheet is costly. Server never handles the raw password. | `H1` is a password-equivalent secret. **Server cannot enforce password policy beyond format of `H1`** (blocklist/length checks are client-side only, i.e. advisory). Needs a deterministic client salt (e.g. derived from normalised username/email + site label) because the client must hash before login. Depends on Web Crypto and the integrity of the JS served by GitHub Pages. |
| **B. Server-side iterated HMAC** | Server runs PBKDF2-style loop in Apps Script. | Server can enforce policy and blocklist on the raw password. | Low achievable iterations → weak against offline cracking. Burns execution time per login (an attacker can force this). Server sees the plaintext password. |
| **C. Single salted SHA-256** | — | Trivial. | **Rejected.** Fast hash; not suitable for passwords. |

**[REC] Option A**, with a mandatory **benchmark of Option B** in the implementation task so the owner can compare real numbers. **[UNRESOLVED] — D-01, approval required.**

**Common to A and B**

- **[REC]** A server-side **pepper** (secret, in `PropertiesService` Script Properties, never in a Sheet) is applied via HMAC. Store `pepper_version` per user so the pepper can be rotated. **[CONFIRMED]** only that Script Properties exist as a service; **[NOT VERIFIED]** whether they are encrypted at rest. Anyone with edit access to the script can read them (§6.2).
- **[REC]** Verification uses constant-time-style comparison (compare full digests; avoid early exit). **BEST-EFFORT** — script-level timing is noisy.
- **[REC]** Store `pw_scheme` (e.g. `A1`) so the scheme can be upgraded and users re-hashed at next login.
- **[REC]** Never log passwords, hashes, OTPs, or tokens (§6.4).

### 1.3 Password policy

- **[REC]** Minimum 8 characters (matches `register.html`), maximum 128 (matches HTML). No forced composition rules. Block a bundled list of the most common passwords and values equal to the username/email local part. This follows NIST SP 800-63B guidance as I recall it — **[NOT VERIFIED]**, see §0.3.
- **[REC]** Under Option A the blocklist runs in `auth.js`; state this limitation honestly in §7.
- **[REC]** Optional breached-password check (k-anonymity API via `UrlFetchApp`) — costs fetch quota and sends a hash prefix to a third party; **[UNRESOLVED]** within D-02.
- **[REC]** Reject passwords containing control characters; normalise to Unicode NFKC before hashing (client side under A).

### 1.4 Registration, login, and password reset flows

**Account-enumeration stance**

- Registration necessarily reveals whether a username or email is taken. **Accepted**, mitigated by rate limits.
- Login and password reset must return **identical responses** for unknown and known identifiers. **[ASSUMPTION]** Response time differs because mail sending is slow; equalising is **BEST-EFFORT** only.

**Registration** (matches the three-step UI)

1. `register_start(email)` — validate Gmail address; canonicalise (§1.4.1); rate-limit; create OTP (§1.5); send mail.
2. `register_verify_otp(email, otp)` — on success under lock, mark OTP used and return a single-use **`email_proof`** (random, stored hashed, bound to canonical email, expires in 15 min **[PROPOSED]**).
3. `register_complete(username, fullName, email, pwPayload, emailProof, consentVersion)` — under lock: re-validate everything, check username and email uniqueness, consume `email_proof`, write user + credentials, create a session, write audit event.

**1.4.1 Email canonicalisation [ASSUMPTION]:** Gmail ignores dots and `+tag` suffixes in the local part, and case. To stop duplicate accounts, store both `email` (as entered, lower-cased) and `email_canonical`, and enforce uniqueness on the canonical value. Whether `googlemail.com` should be accepted is not verified — the form currently accepts only `@gmail.com` (D-19 covers linking).

**Login**

- `login_password(identifier, pwPayload, remember)` — identifier is username (case-insensitive) or email. Under A the client must know the salt before it sees the server; therefore the client salt is deterministic (see §1.2). Failures return one generic message and increment counters (§2).
- `login_google(idToken)` — see §1.7.

**Password reset** (matches `forgot-password.html`)

1. `forgot_start(identifier)` — always returns the same message. If an account exists, send OTP to its **registered** Gmail (never to an address supplied in the request).
2. `forgot_verify_otp(identifier, otp)` — returns a single-use `reset_proof` (10 min **[PROPOSED]**).
3. `forgot_complete(identifier, reset_proof, newPwPayload)` — set new credential, **revoke all sessions**, write audit event, send a "password changed" notice if email budget allows (**BEST-EFFORT**, quota-bound).

Accounts created only via Google have no password until the user sets one (D-19).

### 1.5 Gmail OTP, sessions: parameters

All values **[PROPOSED]**; approval via D-03 / D-04.

**OTP**

| Parameter | Proposed value | Notes |
|---|---|---|
| Length / alphabet | 6 digits | `register.html` allows up to 12; align `maxlength` later. |
| Generation | Server-side, random | **[ASSUMPTION]** Apps Script has no documented cryptographic RNG. `Utilities.getUuid()` / `Math.random()` randomness quality is not documented as cryptographic. See §1.6. |
| Storage | `HMAC-SHA256(pepper, otp_id ‖ purpose ‖ email_canonical ‖ code)`, never the code | Sheet leak does not reveal live codes. |
| Expiry | 10 minutes | Server clock only. |
| Single use | Enforced **under `LockService`**: check `status='active'`, `now<expires_at`, `attempts<max`, then set `status='used'` before returning success | **ENFORCEABLE** if all OTP operations take the lock. |
| Verify attempts | 5 per OTP, then `status='locked'` | 1-in-200,000 chance per OTP by random guessing at 6 digits (arithmetic only). |
| Resend cooldown | 60 seconds between sends per email+purpose | A new send invalidates the previous OTP. |
| Send limits | 3 per hour, 5 per day per email+purpose | Plus global budget (§2.2). |
| Purpose binding | `register` / `reset` | A register OTP cannot reset a password. |

**Sessions**

| Parameter | Default session | "Keep me logged in" |
|---|---|---|
| Absolute lifetime | 12 hours | 30 days |
| Idle timeout | 2 hours | 7 days |
| Browser storage | `sessionStorage` | `localStorage` |

- **[REC]** Token = 256 bits of server-generated randomness (see §1.6). Store only `HMAC(pepper, token)` in `sessions`. Rotate token on privilege change (login, password change).
- **[REC]** Revocation: logout, logout-all, password change/reset, admin action, account deletion. Each lookup checks `revoked_at`, `expires_at`, `last_seen_at`.
- **[REC]** During an active exam, activity extends idle time. Expiry mid-exam must not lose answers: re-login resumes the same attempt (§3.4).
- **[REC]** Session storage location (JS-readable) is an XSS exposure — D-21, §5.7. `HttpOnly` cookies are **[ASSUMPTION] not available** because `ContentService` responses cannot set headers.

### 1.6 Randomness (important caveat)

- **[ASSUMPTION]** No cryptographically-secure random API is documented for Apps Script. **[REC]** Build tokens/OTPs as `HMAC-SHA256(secretKey, uuid1 ‖ uuid2 ‖ uuid3 ‖ timestampMs ‖ counter)`, truncated as needed. If the generator is weak, an attacker without `secretKey` still cannot predict outputs. This is **BEST-EFFORT**; confirm `Utilities` documentation at implementation. A fallback is to have the browser contribute entropy via `crypto.getRandomValues` when creating a session — not recommended for server secrets.
- Exam question ordering does **not** need cryptographic randomness (answer keys are withheld), so `Math.random()` Fisher–Yates is acceptable there.

### 1.7 Google Sign-In token verification

**[CONFIRMED]** (official extracts): after sign-in, send the ID token to your backend over HTTPS; the backend must verify it before use: signature valid (Google public keys), `aud` equals one of your client IDs, `iss` is `accounts.google.com` or `https://accounts.google.com`, and `exp` not passed. Google documents a **`tokeninfo` endpoint for development and debugging** and says official client libraries are the recommended production method. If more than one client accesses the backend, check `aud` manually. For Workspace-only restriction, check `hd`.

**Problem for this architecture:** Google's recommended libraries (Java, Node, PHP, Python) are not available in Apps Script. **[ASSUMPTION]** Apps Script cannot verify an RS256 signature natively (it can sign, not verify). So the options are:

| Option | Description | Assessment |
|---|---|---|
| **A. `tokeninfo` via `UrlFetchApp`** | Server sends the ID token to Google; Google validates signature/expiry. Server **also** checks `aud`, `iss`, `exp`, `email_verified`. | Practical. **Deviates from Google's own production recommendation**, which says tokeninfo is for debugging. Adds latency, consumes URL-fetch quota (**value not captured**), and depends on Google continuing to support it. |
| **B. Manual JWT verification in script** | Fetch Google JWKS, implement RSA-SHA256 verification in JS (e.g. BigInt) | Complex, risky to get wrong, CPU-heavy. Not recommended without strong testing. |

**[REC] Option A**, with explicit documentation of the deviation, and **[UNRESOLVED] D-14 (approval required).** Required checks regardless of option:

1. `aud` equals the configured Web client ID (stored in Script Properties).
2. `iss` ∈ {`accounts.google.com`, `https://accounts.google.com`}.
3. `exp` in the future (with small skew allowance **[PROPOSED]** 60 s).
4. `email_verified` is true and email ends in `@gmail.com` (to match the Gmail-only policy).
5. **Link accounts by `sub`**, not by email. Store `google_sub` on first link.
6. **Replay protection [ASSUMPTION — verify GIS nonce support]:** have the server issue a one-time nonce before sign-in, require it in the token, and reject reuse. If GIS nonce handling cannot be confirmed, state in the implementation that ID-token replay within `exp` is only mitigated by HTTPS and short `exp`.
7. Rate-limit `login_google` (§2) — each call costs a URL fetch.

---

## 2. Rate limiting and quotas

### 2.1 Confirmed platform quotas

**[CONFIRMED]** (official extracts; all stated to be "subject to elimination, reduction, or change at any time, without notice"). Columns are consumer (`gmail.com`) vs Google Workspace.

| Quota | Consumer | Workspace |
|---|---|---|
| Email recipients per day | 100* / day | 1,500* / day |
| Email recipients per day within domain | 100* / day | 2,000 / day |
| Triggers total runtime | 90 min / day | 6 hr / day |
| Script runtime | 6 min / execution | 6 min / execution |
| Email recipients per message | 50 / msg | 50 / msg |
| Triggers | 20 / user / script | 20 / user / script |
| Apps Script projects | 50 / day | 50 / day |

- `*` footnote text was not retrievable (§0.3). Read it before sizing.
- `MailApp.getRemainingDailyQuota()` exists and returns remaining email recipients **[CONFIRMED]**.
- **[CONFIRMED]** Exceeding a quota throws an exception and stops execution. The app must catch this and fail safely.
- **[COMMUNITY]** About 30 simultaneous executions per script is often cited for web apps. Not confirmed officially. Test it (§9).
- Some products add their own quotas on top **[CONFIRMED]** (e.g. Gmail sending).

**Email budget arithmetic (illustrative, from the table above):** each registration needs ≥1 OTP email (more if a resend occurs) and each reset ≥1. At 100 recipients/day (consumer owner), the system can complete well under 100 verified registrations per day; at 1,500 (Workspace) roughly 15× that. Failed sends and attacker-triggered sends count too. **The owner's account type (D-22) is therefore a launch-capacity decision.**

### 2.2 Proposed rate limits

All values **[PROPOSED]**; D-05. Keys cannot use IP (§2.4), so they use identifier, account, session, and global scope. Counters live in a `rate_limits` tab (security-critical) — see §2.3.

| Endpoint | Key | Limit | On exceed |
|---|---|---|---|
| `login_password` | identifier hash | 5 failures / 15 min → progressive delay (1, 5, 15 min) | Generic "try later"; audit |
| `login_password` | global | 600 failures / hour → "elevated mode" (stricter delays for all) | Alert admin by email if budget allows |
| `login_google` | `sub` and global | 10 / min per `sub`; global cap | Reject |
| `register_start` / `forgot_start` | email canonical | 60 s cooldown, 3 / hour, 5 / day | Generic response; no email |
| OTP send (all) | **global email budget** | Stop non-essential email when remaining daily quota < 20% of capacity; reserve the rest for OTPs | Return "temporarily unavailable" |
| `*_verify_otp` | OTP id / email | 5 attempts per OTP; 10 / hour per email | Invalidate OTP |
| `register_complete` | email_proof / username | 1 use; 10 attempts / hour per username | Reject |
| `start_attempt` | user | 10 / hour; one active attempt per mode (D-17) | Reject |
| `save_answers` | attempt | min 2 s interval; payload ≤ 20 KB | Ignore/queue; return server state |
| `submit_attempt` | attempt | idempotent; 5 / minute | Return stored result |
| Read ops (`get_*`, `list_*`) | session | 60 / min | Reject |
| Unknown `op` | global | 60 / min | Reject |

### 2.3 Enforcement mechanism and `LockService`

- **[CONFIRMED]** `LockService.getScriptLock()` lets only one script instance run a protected block at a time; `tryLock(ms)` returns false on timeout, `waitLock(ms)` throws; the lock auto-releases at script end, but should be released as soon as possible.
- **[REC]** Use the script lock for every read-modify-write on: OTP state, session creation, username/email uniqueness, rate counters, attempt creation, attempt submission, and any sequence-number update.
- **[REC]** Keep the critical section minimal: validate and compute **outside** the lock; take the lock only to re-check state and write. Use `tryLock` with a short timeout (e.g. 10 s **[PROPOSED]**), and return a retryable `busy` code on failure.
- **Throughput consequence:** one script lock means all locked operations are serialised. Throughput ≈ 1 ÷ (average lock hold time). If a write cycle takes ~0.5 s **[ASSUMPTION — measure]**, that is ≈ 2 locked operations per second across the **whole** application. This is the main scale limit (§7).
- **[REC]** Do cheap rejections **before** taking the lock (format checks, session lookup from cache, known-blocked identifiers) so garbage traffic does not queue for the lock.
- **[REC]** `CacheService` may speed up session and counter lookups **[NOT VERIFIED — size and TTL limits not checked]**. Cache is evictable and therefore **BEST-EFFORT**. Revocation must delete the cache entry, and the sheet remains the source of truth.

### 2.4 Limits of IP-based rate limiting

- **[COMMUNITY]** The web app does not receive client IP or headers. **NOT POSSIBLE** to rate-limit per IP or by `User-Agent` inside Apps Script. Test this.
- Even if an IP were available, shared NAT (colleges, hostels) would punish many legitimate users, and attackers rotate IPs.
- GitHub Pages cannot add a rate-limiting layer in front of the script. Anyone can call the `/exec` URL directly, bypassing the frontend entirely.
- Consequences: (a) identifier-based limits let an attacker **lock out a victim** (denial of service); soft escalating delays are used instead of permanent lock; (b) an attacker rotating many identifiers faces only the **global** limits; (c) **credential stuffing across many accounts is only partially mitigable** — see §5.
- **[REC]** Consider an optional CAPTCHA/Turnstile-style challenge on `register_start` and `forgot_start`, verified server-side via `UrlFetchApp` (costs fetch quota, adds a third party, **[NOT VERIFIED]**). **D-15.**

### 2.5 Sheets contention and quotas

- Every request that touches Sheets is slow relative to a database (hundreds of ms per sheet open/read **[ASSUMPTION — measure]**). Reduce by: opening each spreadsheet once per execution, reading ranges in bulk, writing with `setValues` on whole ranges, avoiding per-cell loops, and pre-creating answer rows at attempt start so saves update fixed cells.
- Sheets is not transactional. All integrity rests on the script lock being held around every writer. **A writer that skips the lock (including a human editing the sheet by hand) can corrupt state.**
- Locked operations run **per script project**. If the app is ever split into multiple scripts, locks no longer cover shared sheets.

---

## 3. Exam integrity

### 3.1 Server-authoritative timing and the duration rule

**Fixed rule (not changed by this document):**

`duration_minutes = total_selected_marks / 65 × 180`, rounded to the nearest **second**. 65 marks → 180 minutes. Duration depends on **total selected marks**, not the number of questions.

- **[REC]** Compute in integer seconds: `duration_seconds = round(total_selected_marks × 10800 / 65)` (because 180 min × 60 = 10,800 s). **If marks are integers**, the fractional part is `k/65`, which can never equal exactly one half (65 is odd), so there is no rounding-tie ambiguity. If fractional marks exist, rounding of ties must be specified (**D-23**).
- `total_selected_marks` is computed **by the server** from the `questions` sheet for the server-selected question IDs. The client never supplies marks, question counts, or duration.

Worked examples (arithmetic only; the 65-mark example is the stated requirement):

| Total marks | Exact seconds | Rounded | Duration |
|---|---|---|---|
| 1 | 166.15 | 166 | 2 min 46 s |
| 10 | 1661.54 | 1662 | 27 min 42 s |
| 30 | 4984.62 | 4985 | 1 h 23 min 05 s |
| 65 | 10800.00 | 10800 | 3 h 00 min 00 s |
| 100 *(unresolved, see below)* | 16615.38 | 16615 | 4 h 36 min 55 s |

**100-mark papers — UNRESOLVED (D-11, approval required).** The existing rule is stated for 65 marks. Applying the formula unchanged to a 100-mark paper gives **4 h 36 min 55 s**. **[ASSUMPTION — verify against the official GATE brochure]** The real GATE paper is commonly described as 65 questions carrying 100 marks in 3 hours; if so, the formula and the real exam disagree for a full paper, which the owner must resolve. Options: (1) apply the formula unchanged to all totals; (2) use a fixed 180 minutes for 100-mark full papers and the formula elsewhere; (3) another rule. **This document does not choose. No implementation should proceed on 100-mark papers until approved.**

**Timing model**

- `attempts` stores `started_at` (server time), `duration_seconds`, `deadline_at = started_at + duration_seconds`. Client clocks are advisory only (display countdown).
- Every state-changing call re-checks `now < deadline_at`. Every response includes `server_now` and `remaining_seconds` so the client can re-sync.
- **No pause.** Interrupted attempts resume against the **same** deadline (D-17).
- **Expiry without a running client:** **[CONFIRMED]** time-driven triggers exist but are limited (20 per user per script; 90 min/day total runtime consumer). So expiry is **lazy**: an attempt past its deadline is treated as expired on the next access, and optionally finalised by a periodic sweeper trigger (**BEST-EFFORT**). Results are computed from answers saved with `saved_at ≤ deadline_at + grace` (grace **[PROPOSED]** 15 s to absorb network delay; D-17).

### 3.2 Question selection, randomisation, and no duplicates

- Selection happens **server-side** at `start_attempt`: filter `questions` by branch/year/subject/topic/type, select the requested count (up to the number that match, as `practice.html` states), then order.
- **[REC]** Use unique `question_id`s: build the filtered ID list, de-duplicate with a set, shuffle by Fisher–Yates, take the first *n*. This yields no duplicates by construction. Assert `n ≤ matches` and `unique(ids).length = n` before saving.
- The resulting ordered list is written once to `attempt_questions` (`attempt_id, position, question_id, marks`) and is **immutable** for that attempt. Recovery and scoring use this stored list, not a re-run of the filter (the bank may change later).
- Whether a subset is random or fixed when *n* < matches, and how a **full-length mock** is composed, is **[UNRESOLVED]** (D-12). Whether MCQ/MSQ options are shuffled: D-20 (default: no).
- Cross-year duplicate questions in the bank itself (same question in two years) must be handled at import via a stable `question_id`/`content_hash`; flagged for the import task.

### 3.3 Answer-key withholding, scoring, and marking rules

- **[REC]** Answer keys live in a **separate spreadsheet** (`KEYS_DB`) readable only by the script's owner identity. They are never included in any response before submission, never logged, never cached in client-visible form.
- Question payloads sent to the client include: id, type, text, options (for MCQ/MSQ), marks, section/subject metadata for display. **Exclude** key, explanation, tags that hint the answer, and `correct` flags.
- Scoring happens **only on the server**, in `submit_attempt` (or lazy expiry), from the saved answers, the attempt's immutable question list, and the keys.
- **[UNRESOLVED] Marking rules (D-06).** `practice.html` says marking rules are "to be confirmed". **This document deliberately does not define negative marking, partial credit, MSQ scoring, or NAT tolerance.** It specifies only the mechanism:
  - A versioned `marking_rules` config (per question type) is created by the owner. `attempts.rules_version` pins the version used so later rule changes do not rewrite old scores.
  - The scoring function is a pure function `score(response, key, rule) → marks` with unit tests supplied by the owner's rules table.
  - Rules table (all values **[UNRESOLVED]**): MCQ correct/incorrect/unattempted; MSQ correct/incorrect/partial/unattempted; NAT format, tolerance, correct/incorrect/unattempted.
- Results returned after submit: score, per-question correctness, and (if D-18 approves) keys/explanations **for that attempt's questions only**.
- Whether to show feedback during practice modes (before submit): **[REC] no** — keep one rule (answers revealed after submit). D-18.

### 3.4 Answer saving and recovery

- `save_answers(attempt_id, [{question_id, response, review_flag, seq}])`. Server checks: session user owns attempt; attempt `in_progress`; `now < deadline_at (+grace)`; each `question_id` is in that attempt's `attempt_questions`; response shape validates against the question type (no free text longer than a small limit); `seq` is strictly greater than the last stored `seq` (rejects stale or replayed saves).
- **[REC]** Batch saves (e.g. on navigation and every ~30 s **[PROPOSED]**) rather than one write per click, to reduce lock load (§2.3).
- Server writes `saved_at` itself. Client timestamps are ignored.
- `get_attempt(attempt_id)` (resume) returns: ordered question payloads (no keys), saved responses, review flags, `server_now`, `remaining_seconds`, `status`. This is what makes interrupted-attempt recovery work.
- **Multiple tabs/devices:** `seq` + last-write-wins by server order; the UI shows server state on resume. Whether more than one active attempt per user is allowed: D-17.

### 3.5 Ownership, replay, and audit

- **Ownership:** every attempt, answer, bookmark, and result operation resolves `user_id` from the **session** (never from the request body) and compares it to the record's `user_id`. A non-matching ID returns the same response as "not found" (no existence oracle).
- **Replay/idempotency:** `submit_attempt` is a state transition `in_progress → submitted|expired` under lock; a repeat returns the **stored** result and never re-scores. `start_attempt` accepts a client `requestId`, stored with the attempt, so a retried request returns the same attempt rather than creating another. Save replays are blocked by `seq`. OTP, `email_proof`, and `reset_proof` are single-use under lock.
- **Audit log** (append-only by convention; see limits in §5.10): `register`, `login_success`, `login_failure` (identifier **hash**, not raw), `otp_sent`, `otp_verified`, `otp_failed`, `password_reset`, `password_changed`, `session_revoked`, `attempt_started`, `attempt_submitted`, `attempt_expired`, `score_computed`, `authz_denied`, `rate_limited`, `account_deleted`, `admin_action`. Per-answer saves are **not** audited (volume).

---

## 4. Data model and authorization

### 4.1 Spreadsheet split (all **[REC]**)

| Spreadsheet | Tabs | Why separate |
|---|---|---|
| `AUTH_DB` | `users`, `credentials`, `otps`, `sessions`, `rate_limits`, `audit_logs` | Highest-sensitivity auth material in one tightly-shared file. |
| `EXAM_DB` | `questions`, `attempts`, `attempt_questions`, `answers`, `bookmarks`, `config` (incl. `marking_rules`) | Content and user progress. |
| `KEYS_DB` | `answer_keys` (and explanations, if kept separate) | Answer keys must not be visible to anyone with only `EXAM_DB` access. |

Trade-off: three spreadsheets → three `openById` calls (latency) and three places to back up. Accepted. IDs are stored in Script Properties, not in code.

### 4.2 Tabs (proposed columns)

- **users:** `user_id`, `username`, `username_lower`, `full_name`, `email`, `email_canonical`, `email_verified_at`, `google_sub`, `status` (`active|suspended|deleted`), `role` (`user|admin`), `consent_version`, `consent_at`, `created_at`, `last_login_at`, plus profile fields shown on `dashboard.html` (`branch`, `target_exam_year`) — **profile fields not yet defined by the owner**.
- **credentials:** `user_id`, `pw_hash`, `pw_salt`, `pw_scheme`, `pepper_version`, `password_changed_at`.
- **otps:** `otp_id`, `purpose`, `email_canonical`, `code_hmac`, `created_at`, `expires_at`, `attempts`, `status` (`active|used|expired|locked|superseded`), `used_at`.
- **sessions:** `session_id`, `user_id`, `token_hmac`, `created_at`, `last_seen_at`, `expires_at`, `idle_expires_at`, `remember`, `revoked_at`, `revoked_reason`.
- **rate_limits:** `key_hmac`, `scope`, `window_start`, `count`, `blocked_until`.
- **questions** (metadata + content): `question_id`, `type` (`MCQ|MSQ|NAT`), `marks` (integer), `branch`, `year`, `subject`, `topic`, `text`, `options_json`, `source_ref`, `status` (`draft|approved|retired`), `content_hash`, `license_ref`.
- **answer_keys:** `question_id`, `key_json`, `explanation`, `key_version`.
- **attempts:** `attempt_id`, `user_id`, `mode`, `filters_json`, `question_count`, `total_marks`, `duration_seconds`, `started_at`, `deadline_at`, `status` (`in_progress|submitted|expired`), `submitted_at`, `score`, `rules_version`, `request_id`, `last_seq`.
- **attempt_questions:** `attempt_id`, `position`, `question_id`, `marks`.
- **answers:** `attempt_id`, `question_id`, `response_json`, `review_flag`, `seq`, `saved_at`, `correct` (set at scoring), `awarded_marks` (set at scoring).
- **bookmarks:** `user_id`, `question_id`, `created_at`.
- **audit_logs:** `ts`, `event`, `user_id` (or hashed identifier), `target_id`, `result`, `detail` (non-sensitive).
- **IDs:** `user_id`, `attempt_id`, `session_id`, `otp_id` are random and non-sequential, to avoid guessable IDs (IDOR hardening). Random quality: see §1.6.

**Sheet-cell capacity (arithmetic only):** official extract says 10 million cells per spreadsheet **[CONFIRMED]**; a third-party page claims 20 million **[CONFLICT — D-13]**. Planning at 10M: e.g. 65 answers × ~9 columns ≈ 585 cells per full attempt, so on the order of 10,000+ full attempts before reaching 10M cells in `EXAM_DB` if nothing else grows. Performance degrades well before the hard cap **[COMMUNITY]**.

### 4.3 Authorization and validation per API operation

General rules for **every** operation:

1. Parse and validate `op`, `requestId` (≤ 64 chars `[A-Za-z0-9_-]`), payload size (≤ 20 KB **[PROPOSED]**), field types and lengths.
2. Where "Session" is required: resolve `token_hmac` → active, unexpired, unrevoked session → `user_id`; user `status=active`. Never accept `user_id` from the body.
3. All writes under the script lock; all outputs are plain JSON (no HTML) and the client must render text via `textContent` (§5.7).
4. Errors are generic; details go to `audit_logs`.

| # | Operation | Auth | Authorization | Validation | Notes |
|---|---|---|---|---|---|
| 1 | `register_start` | None | — | Gmail pattern, ≤ 254 chars, canonicalise; not already registered *or* respond generically per D-19 | Rate limits §2.2. Sends OTP. |
| 2 | `register_verify_otp` | None | — | email, 6-digit numeric | Attempt limit. Returns `email_proof`. |
| 3 | `register_complete` | `email_proof` | proof bound to this email, unused, unexpired | username `[A-Za-z0-9_]{3,30}` not reserved and unique (lower-cased); full name 1–100 chars, no control characters; password payload format; `consentVersion` equals current | Lock; creates user, credential, session. |
| 4 | `login_password` | None | — | identifier ≤ 254; payload format; `remember` boolean | Generic failure; progressive delay. |
| 5 | `login_google` | ID token | Token verified per §1.7 | token ≤ size limit | Link by `sub`; new account policy D-19. |
| 6 | `forgot_start` | None | — | identifier ≤ 254 | Same response always. Sends to registered email only. |
| 7 | `forgot_verify_otp` | None | — | identifier, code | Returns `reset_proof`. |
| 8 | `forgot_complete` | `reset_proof` | proof bound to user, unused, unexpired | new password payload | Revokes all sessions. |
| 9 | `logout` | Session | own session only | — | Sets `revoked_at`. |
| 10 | `logout_all` | Session | own sessions only | — | Revokes all of user's sessions. |
| 11 | `get_profile` | Session | self only | — | No hashes or internal fields. |
| 12 | `update_profile` | Session | self only | whitelist of fields; lengths; no `role`/`status`/`email` here | Email change is out of scope (needs OTP; D-19). |
| 13 | `change_password` | Session | self only | old credential verified; new payload | Revokes other sessions. |
| 14 | `get_filters` | Session | — | — | Metadata only (branches/years/subjects/topics/types/counts). |
| 15 | `preview_test` | Session | — | filters whitelist; count integer ≥ 1 and ≤ matches | Returns matching count, selected count, marks, types, rules, **duration** computed server-side. Creates nothing. |
| 16 | `start_attempt` | Session | self | same as 15 + `requestId`; mode whitelist; active-attempt policy (D-17) | Lock; selects questions; writes attempt, `attempt_questions`, empty `answers`. Returns first payload. |
| 17 | `get_attempt` | Session | `attempt.user_id == session.user_id` | `attempt_id` format | Resume; no keys. May trigger lazy expiry. |
| 18 | `save_answers` | Session | owner; `in_progress`; before deadline (+grace) | question in attempt; response type/size; `seq` monotonic | Lock; per-attempt rate limit. |
| 19 | `submit_attempt` | Session | owner | `attempt_id` | Lock; idempotent; scores on server; returns result. |
| 20 | `get_result` | Session | owner; status `submitted|expired` | `attempt_id` | Keys/explanations only per D-18. Never for `in_progress`. |
| 21 | `list_history` | Session | rows filtered by `user_id` on the server | page size ≤ 50 | No other users' data. |
| 22 | `get_dashboard` | Session | self | — | Aggregates computed from the user's own attempts. |
| 23 | `toggle_bookmark` | Session | self | `question_id` exists and is `approved`; bookmarks per user ≤ cap **[PROPOSED]** 500 | Idempotent set/unset. |
| 24 | `list_bookmarks` | Session | self | page size ≤ 50 | Returns question payloads **without keys**. |
| 25 | `delete_account` | Session | self; recent re-auth (password or fresh OTP) | confirmation token | Per D-08; revokes sessions; audit. |

**No admin API in v1 [REC].** Admin work is done in the Sheets/script editor by the owner (§6.1). This removes an entire attack surface (admin endpoints reachable by anyone who finds the URL). D-09.

---

## 5. Threat model

"Strength" uses §0.2 labels.

| # | Threat | Vector | Controls | Strength | Residual risk |
|---|---|---|---|---|---|
| 5.1 | **Account takeover** | Stolen password/session, phished OTP, reset abuse, Google-account linking | Hashing (§1.2), OTP limits, reset revokes sessions, link by `sub`, notice email, generic reset response | Mixed: logic **ENFORCEABLE**; notice email **BEST-EFFORT** | Phishing of password+OTP cannot be stopped. Compromised Gmail = compromised account (reset goes to Gmail). |
| 5.2 | **OTP abuse** | Brute force; email bombing; quota drain by attacker | 5 attempts/OTP, cooldown, per-email caps, global email budget, purpose binding | Limits **ENFORCEABLE**; quota drain only **BEST-EFFORT** | An attacker with many fake emails can exhaust the daily quota (**DoS of registration/reset**). Optional CAPTCHA (D-15). |
| 5.3 | **Credential stuffing** | Leaked username/password lists across many accounts | Per-identifier delays, global elevated mode, breached-password blocklist, generic errors | **BEST-EFFORT** | **No per-IP limit possible (§2.4).** Slow, distributed attacks will largely succeed against reused passwords. Be honest in the privacy/security pages. |
| 5.4 | **Session theft** | XSS reads token; malware; shared device | Token hashed server-side, short sessions, revocation, `sessionStorage` default, CSP (§5.7) | **BEST-EFFORT** | JS-readable token (no `HttpOnly`). Anyone with the token can use it until expiry/revocation. |
| 5.5 | **IDOR** | Changing `attempt_id`, `question_id`, `user_id` in requests | `user_id` only from session; ownership checks on all attempt/answer/bookmark ops; random IDs; uniform not-found | **ENFORCEABLE** | Bugs in one operation re-open it → authorization test matrix (§9). |
| 5.6 | **Answer-key leakage** | Keys in payloads, DevTools, cached responses, shared sheet | Keys in separate spreadsheet; payload allow-list; no key before submit; no feedback mid-exam | **ENFORCEABLE** server-side; sheet exposure see 5.9 | After submit the user sees keys by design; **bulk scraping of the bank via repeated attempts** is only rate-limited (D-17), not prevented. |
| 5.7 | **XSS / CSRF / clickjacking** | Injected HTML in names/question text; forged cross-site requests; framing | Render all server text with `textContent`; no `innerHTML` on dynamic data; CSP via `<meta>`; token in body (no ambient cookie auth) | XSS: **BEST-EFFORT**. CSRF: largely **N/A** since no cookies authenticate requests (but the endpoint is anonymously callable). Clickjacking: **NOT POSSIBLE** to fully prevent | **[COMMUNITY/ASSUMPTION]** GitHub Pages does not allow custom response headers; `<meta>` CSP cannot set `frame-ancestors`; add JS frame-busting as best-effort. Question text imported from third-party sources is untrusted — sanitise at import. |
| 5.8 | **Score tampering** | Client sends scores; replays submissions; edits timer | Server-only scoring; scores computed from stored answers; submit idempotent; timer server-side | **ENFORCEABLE** | Anyone with write access to the sheet can alter scores (5.10). |
| 5.9 | **Accidental Sheet exposure** | Link-sharing "anyone with link", sharing to wrong person, public publish, copy shared | Sheets private to owner; no link sharing; three-file split; periodic sharing audit | **BEST-EFFORT** (human process) | One mis-click exposes hashes/keys. Hashes then matter (§1.2). |
| 5.10 | **Admin abuse / insider** | Owner/editor reads data, edits scores, rewrites audit log | Minimum editors, 2-Step Verification, separate accounts, Drive revision history, off-sheet backup | **BEST-EFFORT**; audit log is **NOT tamper-proof** (an editor can rewrite it) | Trust in the owner and any editor is unavoidable on this platform. |
| 5.11 | **Quota exhaustion / DoS** | Mail drain, lock-queue flooding, execution-time exhaustion, anonymous endpoint | Cheap pre-lock rejection, global budgets, short lock holds, graceful degradation | **BEST-EFFORT** | **An anonymous public endpoint with no IP controls cannot be made DoS-proof.** Expect outages under deliberate attack. |
| 5.12 | **Replay attacks** | Resending captured requests | HTTPS; single-use proofs under lock; `seq`; idempotent submit; ID-token nonce (if verified) | **ENFORCEABLE** for state-based replays; ID-token replay **BEST-EFFORT** | Replay of a still-valid session token is session theft (5.4). |
| 5.13 | **Account enumeration** | Register/login/reset response differences, timing | Uniform responses (login, reset); registration necessarily reveals | **BEST-EFFORT** | Registration reveals username/email existence. |
| 5.14 | **Clock manipulation** | User alters device clock | Server-authoritative deadlines | **ENFORCEABLE** | Only the on-screen countdown is affected. |
| 5.15 | **Scraping / bot attempts** | Automation to harvest questions (forbidden by `terms.html`) | Rate limits, attempt caps, terms | **BEST-EFFORT** | A patient scraper with many accounts succeeds. |
| 5.16 | **Deployment mistakes** | "Execute as: user" misconfiguration; public repo with IDs/secrets; test deployment exposed | Execute as owner only; secrets in Script Properties; checklist (§6.2) | **BEST-EFFORT** (human) | Frontend repo is public — the `/exec` URL and Google client ID are public by design; secrets must never be there. |

---

## 6. Operations

### 6.1 Admin provisioning

- **[REC]** One dedicated Google account owns the script and all three spreadsheets, with 2-Step Verification, a recovery method, and no personal use. A second trusted person is a break-glass owner/editor (documented).
- **[REC]** No admin endpoints in v1. The `role` column exists but no operation reads it yet. Any future admin API requires a fresh design review (D-09).
- **[REC]** Maintain a written list of everyone with edit access to the script and each spreadsheet; review quarterly **[PROPOSED]**.

### 6.2 Deployment permissions and secrets

- **[CONFIRMED]** A web app can execute as the owner (always runs as the owner regardless of caller) or as the accessing user. **[REC]** *Execute as: Me*; *Who has access: Anyone*. Reason: users reach the API via cross-origin `fetch` from GitHub Pages without a Google login; "as user" would force sign-in/authorization prompts and cannot work for username/password users.
- **Consequence:** every caller runs with the **owner's authority**. A single authorization bug is a full-data bug. Treat the script as a privileged service.
- **[REC]** Secrets (`pepper`, `tokenSecret`, spreadsheet IDs, Google client ID, sender config) live in Script Properties, never in `Code.gs`, the repo, or Sheets. Script editors can read them.
- **[REC]** Pin explicit `oauthScopes` in `appsscript.json` (least privilege; verify exact scope names at implementation — **[NOT VERIFIED]**).
- **[REC]** Use a numbered deployment, not "HEAD/test" deployment, for the public URL. **[COMMUNITY]** Editing and redeploying as a *new version of the same deployment* keeps the URL; creating a *new deployment* changes it. Verify before first release.
- **[REC]** The public repo contains only the `/exec` URL and the Google client ID. Never commit spreadsheet IDs or keys.
- Rotation: changing `pepper` invalidates every password hash (users must reset). Support `pepper_version` so a rotation can be gradual (D-10).

### 6.3 Data minimisation

Collect only: username, full name, Gmail, credential hash, Google `sub`, consent record, session metadata, attempts/answers/scores/bookmarks, audit events. **Do not collect** IP, device fingerprints, or phone numbers (IP is unavailable anyway). Do not store plaintext OTPs, passwords, tokens, or ID tokens. Align `privacy.html` once decided (it currently says hashing method and retention are not finalised).

### 6.4 Logging

- Log events in §3.5. Never log secrets, raw credentials, raw OTPs, tokens, answer keys, or full request bodies.
- Log unknown-identifier failures as `HMAC(identifier)` to avoid storing passwords mistyped into the username field.
- Cap log growth (§6.6). **[CONFIRMED]** the Apps Script dashboard shows execution history; do not rely on it as the security log (retention not verified).

### 6.5 Backups and restoration

All **[REC]**; D-10.

- **Backup:** daily time-trigger copies each spreadsheet (`makeCopy`) into a restricted Drive folder owned by a *different* account if possible. **[CONFIRMED]** triggers exist but are quota-limited (§2.1: 90 min/day consumer, 20 triggers). Keep N copies **[PROPOSED]** 14 daily + 8 weekly.
- Google's version history is a convenience, not a backup **[ASSUMPTION — retention not verified]**.
- **Restoration test:** quarterly **[PROPOSED]**, restore to a scratch environment, verify row counts, hash check of `users`, and that an old attempt resumes/scores correctly. A backup never restored is not a backup.
- Backups contain hashes and keys → same access restrictions as production; included in deletion/retention analysis (§6.6).

### 6.6 Retention and deletion (all **[PROPOSED]**, D-08)

| Data | Proposed retention |
|---|---|
| OTP rows | Purge after 24 h |
| Expired/revoked sessions | Purge after 30 days |
| `rate_limits` | Purge windows older than 7 days |
| Audit logs | 12 months |
| Attempts/answers/bookmarks | Until the user deletes the account |
| Account on deletion | Remove `users`, `credentials`, sessions, bookmarks; anonymise attempts/answers (or delete) per owner choice |
| Backups | Rolling expiry ≤ 30 days; the policy must state that deleted data can persist in backups until they expire |

A scheduled purge uses a trigger (**BEST-EFFORT**, quota-bound). Legal basis, minimum age, and any statutory retention or deletion duty are **not determined here** (D-16).

### 6.7 Incident response (outline)

1. **Detect:** unusual `rate_limited`/`login_failure` volume; unexpected quota exhaustion; owner-reported sheet-sharing change.
2. **Contain:** switch the web app deployment to a maintenance version; revoke all sessions (set `revoked_at` on all rows); disable Google client ID if token abuse.
3. **Eradicate/recover:** rotate `pepper`, `tokenSecret`, Google client secret if any; force password resets; restore from backup if data was altered.
4. **Notify:** owner decides legal/user notification with advice (D-16).
5. **Review:** record timeline, root cause, and design changes in this document.

### 6.8 Security testing (to be performed during/after implementation)

- Authorization matrix: for each op in §4.3, test with no session, expired session, revoked session, other user's IDs.
- OTP: double-submit race (two simultaneous verifies — only one succeeds), expiry boundary, attempt cap, purpose mismatch, resend invalidation.
- Exam: late save, replayed `seq`, duplicate submit, tampered `question_id`, key-leak search across all responses, resume after session expiry, deadline computation vs table in §3.1.
- Load: simulate the target concurrent users with synchronised start (§7); record lock wait, errors, and quota consumption. Verify the ~30 concurrent-execution claim.
- Static review: no `innerHTML` with server data; no secrets in repo; CSP in place.
- Sharing audit: confirm no spreadsheet is link-shared; confirm the deployed access setting.
- Quota drill: simulate `MailApp` quota exhaustion and verify graceful behaviour.

---

## 7. Platform feasibility: Apps Script + Sheets

### 7.1 Overall assessment

**Expected workload is not specified by the owner [ASSUMPTION]**, so the assessment is conditional (D-13, D-22).

| Workload | Verdict | Why |
|---|---|---|
| Personal/small cohort pilot (tens of users, mostly non-synchronised) | **Feasible** | Low lock contention; email quota adequate if the owner uses a Workspace account for headroom. |
| A few hundred registered users, occasional concurrent mocks | **Marginal — requires load testing** | Serialised locked writes; synchronised exam start/submit creates bursts; Gmail-account email quota (100/day) is a hard registration ceiling. |
| Large launches, synchronised timed mock exams for many users, public viral traffic | **Not suitable** | Single script lock, execution/email quotas, no IP controls, no DoS protection, and quotas that Google may reduce "without notice" **[CONFIRMED]**. |

The architecture is fixed by the owner; this assessment is a risk statement, not a request to change it. **[REC]** Set explicit go/no-go thresholds from a load test before public launch (D-13), and define in advance what the migration trigger is.

### 7.2 Enforceable vs best-effort vs not possible

| Control | Strength | Condition / caveat |
|---|---|---|
| Server-side scoring, key withholding, server timing | **ENFORCEABLE** | Only while sheets stay private and code is correct. |
| Ownership checks, authorization per op | **ENFORCEABLE** | Per-op tests needed. |
| OTP single use, attempt caps, state machines | **ENFORCEABLE** | All writers must hold the lock. |
| Hard uniqueness (username/email) | **ENFORCEABLE** | Under lock. Sheets has no unique constraint. |
| Session revocation | **ENFORCEABLE** (sheet is truth) | Cached lookups must be invalidated. |
| Per-identifier throttles | **BEST-EFFORT** | Evictable cache / lock timeouts; enables victim lockout. |
| Credential-stuffing defence | **BEST-EFFORT** | No IP; distributed attacks pass. |
| Email-quota protection | **BEST-EFFORT** | Quota is shared by attacker and legitimate users. |
| Token randomness | **BEST-EFFORT** | No documented CSPRNG (§1.6). |
| XSS/session theft mitigation | **BEST-EFFORT** | JS-readable token; no response headers on GitHub Pages **[ASSUMPTION]**. |
| Password policy under Option A | **BEST-EFFORT** (client-side) | Server cannot read the password. |
| Audit-log tamper resistance | **NOT POSSIBLE** | Any editor can edit sheets. |
| Per-IP rate limiting | **NOT POSSIBLE** | IP not exposed **[COMMUNITY]**. |
| `HttpOnly` cookies, CSP `frame-ancestors`, HSTS control | **NOT POSSIBLE** | Platform cannot set headers **[ASSUMPTION]**. |
| Origin/CORS enforcement | **NOT POSSIBLE** | Endpoint is anonymous; headers unavailable **[COMMUNITY]**. |
| DoS resistance | **NOT POSSIBLE** | Public endpoint, shared quotas. |
| Transactions / atomic multi-sheet writes | **NOT POSSIBLE** | Emulate with lock + idempotent retries + repair job. |
| Guaranteed autosubmit at deadline | **BEST-EFFORT** | Lazy expiry + trigger sweeper; quota-bound. |

### 7.3 Confirmed-fact conflict to resolve

Sheets cell limit: official Drive help extract says **10 million**; a third-party page dated 2026 states **20 million**. This document uses **10 million** as the planning limit until the official page is re-read in full (D-13).

---

## 8. Consistency checks against the existing pages

| Item | Existing page says | This design |
|---|---|---|
| Duration | `practice.html`, `index.html`: total marks ÷ 65 × 180 min, nearest second, user does not set it | Unchanged (§3.1). 100-mark extension unresolved (D-11). |
| OTP expires, single use | `register.html`, `forgot-password.html` | §1.5 (10 min, single use) |
| Generic reset message | `forgot-password.html` | §1.4 |
| Gmail only | `register.html`, `terms.html` | §1.4.1, §1.7 |
| Autosave and recovery | `index.html` | §3.4 |
| Keys never sent before submit; server scoring | `privacy.html` | §3.3 |
| Hashing method not finalised | `privacy.html` | D-01 |
| Retention/min-age/liability/contact placeholders | `privacy.html`, `terms.html` | D-08, D-16 |
| "Keep me logged in" | `login.html` | §1.5 (two lifetimes) |
| Marking rules, mock composition TBD | `practice.html` | D-06, D-12 |
| `history.html`, `bookmarks.html`, `profile.html` links | `index.html` | Not in project list (D-24) |
| `security.html#scoring` | `practice.html` | Page not reviewed; reconcile after approval (D-24) |

No existing page claims a protection this design cannot provide. After approval, `privacy.html` should state clearly that per-IP throttling and tamper-proof audit are **not** available.

---

## 9. Implementation-time verification checklist (carry-over)

1. Re-read all Google URLs in §0.3 in full; capture the `*` footnotes and the UrlFetch quota.
2. Test: `doPost` exposes no headers/IP; text/plain POST works cross-origin from a `github.io` origin; redirect behaviour; error responses on quota exceed.
3. Benchmark Option B hashing and lock hold times; measure real concurrency.
4. Verify GIS nonce handling and tokeninfo behaviour; confirm `UrlFetchApp` quota.
5. Confirm `Utilities` randomness and RSA features.
6. Confirm GitHub Pages header/CSP constraints.
7. Verify GATE official duration/marks/marking scheme.

---

## 10. Decision register

"Approval" = owner approval needed before the backend is built. Recommendations are not decisions.

| ID | Decision | Recommendation | Rationale | Trade-offs | Approval? |
|---|---|---|---|---|---|
| **D-01** | Password hashing scheme | Option A: client PBKDF2-HMAC-SHA256 pre-hash (Web Crypto) + server HMAC-wrap with pepper and per-user salt; benchmark Option B before final | Apps Script lacks a slow password hash; client device can afford high iterations | Pre-hash is password-equivalent; server cannot enforce policy; depends on served JS integrity; iteration count needs tuning/approval | **Yes** |
| **D-02** | Password policy | Min 8, max 128, no composition rules, common-password blocklist, block username/email-derived; optional breached-password check | Matches current forms and common guidance (guidance **not verified**, §0.3) | Weak under Option A (client-side only); breach check adds third-party call/quota | **Yes** |
| **D-03** | OTP parameters | 6 digits, 10 min expiry, single use under lock, 5 attempts, 60 s cooldown, 3/hour and 5/day per email+purpose, hashed storage | Balances guess resistance and usability; limits email drain | Low caps frustrate legitimate users on bad mail delivery; quota remains the real ceiling | **Yes** |
| **D-04** | Session parameters | Default: 12 h absolute / 2 h idle, `sessionStorage`; remember: 30 d / 7 d, `localStorage`; hashed tokens; revoke on password change | Supports existing "Keep me logged in" checkbox with bounded exposure | Longer remember sessions raise theft risk; JS-readable tokens | **Yes** |
| **D-05** | Rate-limit values | Table in §2.2, identifier/global scope, no IP | IP unavailable | Victim lockout risk; weak against distributed attacks | **Yes** |
| **D-06** | Scoring/marking rules (MCQ, MSQ, NAT; negative marking; partial credit; NAT tolerance) | **No recommendation on values.** Owner supplies rules (ideally verified against the official GATE scheme); implement versioned `marking_rules` and pin `rules_version` per attempt | Cannot invent rules; scores must be reproducible | Scoring cannot be built or tested until defined | **Yes — blocking** |
| **D-07** | Question-source licensing | Do not import questions until each source's rights/licence and attribution are confirmed; store `source_ref`, `license_ref`; start with questions the owner authored or has rights to; obtain legal advice | Past-paper copyright status is **not established here**; `terms.html` leaves it open | May reduce the initial bank size; delays launch | **Yes — blocking for content import** |
| **D-08** | Retention and deletion | §6.6 table; deletion removes account data, backups expire ≤ 30 days; state backup persistence | Fills `privacy.html` placeholders; minimises stored data | Shorter log retention weakens investigations | **Yes** |
| **D-09** | Admin provisioning | One dedicated owner account + one break-glass person; **no admin API in v1**; edit-access register | Removes admin endpoint attack surface | Manual admin; no in-app moderation | **Yes** |
| **D-10** | Backup/recovery and secret rotation | Daily `makeCopy` of all three sheets to a restricted folder (14 daily + 8 weekly); quarterly restore test; `pepper_version` for rotation | Sheets lacks real DB guarantees | Trigger runtime quota; backups hold sensitive data | **Yes** |
| **D-11** | Duration rule for 100-mark papers | **Do not extend silently.** Compute and show options: (1) formula unchanged = 16,615 s (4 h 36 min 55 s); (2) fixed 180 min for 100-mark full papers; (3) other. Verify the official GATE structure first | 65-mark rule is fixed; the 100-mark extension is expressly unresolved; real-exam conflict possible | Option 1 is consistent but may not match the real exam; option 2 breaks uniform proportionality | **Yes — blocking for 100-mark papers** |
| **D-12** | Mock-exam composition and subset selection | Server-side random without replacement from the filtered set; mock composition rules defined by owner | `practice.html` says composition "to be defined" | Randomness vs reproducibility; composition needs content metadata | **Yes** |
| **D-13** | Expected workload and go/no-go thresholds; Sheets cell limit | Owner states target users and peak concurrency; run load test; set explicit thresholds and migration trigger; plan at 10M cells until the 10M/20M conflict is resolved | Feasibility is workload-dependent (§7) | Over-promising vs under-building | **Yes** |
| **D-14** | Google ID-token verification method | `tokeninfo` via `UrlFetchApp` plus own `aud`/`iss`/`exp`/`email_verified` checks; document the deviation from Google's production advice; server nonce if GIS supports it | No native RSA verification in Apps Script (assumption) | Depends on a debug-labelled endpoint; latency and fetch quota | **Yes** |
| **D-15** | Bot challenge (CAPTCHA/Turnstile) on OTP-sending endpoints | Add if abuse is observed or at launch for `register_start`/`forgot_start` | Mitigates quota drain and email bombing | Third-party dependency, privacy impact, accessibility, extra fetch | **Yes** |
| **D-16** | Minimum age, legal review, statutory obligations | Obtain qualified legal advice (including whether Indian data-protection law applies) before launch; set minimum age | Privacy/terms drafts state these are undecided and unreviewed | Cost/time | **Yes** |
| **D-17** | Attempt policy | No pause; one active attempt per mode per user; 10 starts/hour; 15 s submit grace; lazy expiry plus optional sweeper | Server-authoritative timing; limits bank scraping | Strictness may annoy users on flaky connections | **Yes** |
| **D-18** | Feedback visibility | Keys and explanations only after submission, only for that attempt's questions; no per-question feedback during the attempt | Preserves exam integrity | Less immediate learning feedback in practice modes | **Yes** |
| **D-19** | Account linking and Google-only accounts | Link by `sub`; auto-link to an existing account only if the existing Gmail was OTP-verified and Google `email_verified` is true; Google-only users may later add a password via OTP-confirmed flow; canonicalise Gmail for uniqueness | Prevents duplicate/takeover accounts | Added flows and edge cases | **Yes** |
| **D-20** | Option shuffling for MCQ/MSQ | Do not shuffle options in v1 | Simpler; avoids display/key mapping bugs | Weaker deterrence against answer sharing | No (low) |
| **D-21** | Browser session-token storage | `sessionStorage` by default, `localStorage` only when "keep me logged in" is ticked; strict CSP via `<meta>` | No `HttpOnly` option exists | Both are XSS-readable | **Yes** |
| **D-22** | Owner Google account type (consumer vs Workspace) | Prefer a Workspace owner account for email quota headroom (1,500 vs 100 recipients/day per the official table) | Email quota is a launch-capacity ceiling | Cost; Workspace admin controls | **Yes** |
| **D-23** | Integer marks assumption | Require marks to be positive integers (as in GATE's 1- and 2-mark questions — **assumption**); if fractional marks appear, specify tie rounding | Integer marks make duration rounding tie-free (§3.1) | Limits question formats | No (confirm assumption) |
| **D-24** | Project-structure gaps | Create or remove links for `history.html`, `bookmarks.html`, `profile.html`; review `security.html`, `help.html`, `contact.html` against this document | Dead links; `practice.html` points to `security.html#scoring` | Extra pages vs minimal codebase | **Yes** (low priority) |

---

## 11. Review completion and handoff

### 11.1 Document status

- Created: `SECURITY_DESIGN.md` only. No other file was created or modified.
- All numeric parameters are **[PROPOSED]** and must be approved; none are sourced facts except the quota table in §2.1 and the duration formula arithmetic in §3.1.
- Items verified only via search-result extracts are labelled; items not verified are listed in §0.3.

### 11.2 Handoff checkpoint

**State:** Security design drafted; approval-required decisions open: D-01 through D-19, D-21, D-22, D-24 (D-20 and D-23 are low-risk confirmations). **Blocking decisions:** D-06 (marking rules), D-07 (question licensing), D-11 (100-mark duration), D-13 (workload), D-14 (Google token method).

**Next task (exact):** **review `SECURITY_DESIGN.md` and resolve the approval-required decisions before implementing the backend.**
