# Task 58 — Authentication and account lifecycle

**Status:** Source implementation completed; live activation remains owner-config blocked.

## Implemented

- Hardened session reads: malformed session records are removed and are never treated as authenticated.
- Login clears the password field before redirect/storage-result handling. If the server creates a session but browser storage fails, the client attempts remote logout with the returned token, clears local state, and does not pretend the browser is signed in.
- Added a safe, allowlisted `sessionStorage` return target for `dashboard.html`, `history.html`, `bookmarks.html`, and `profile.html`. It is a local filename only; no auth data or return destination is put in a URL.
- Protected account pages now fail closed in the UI: the main content stays hidden until the private backend confirms the current session. Unauthenticated or unconfigured states return to login; a transient network/bad-response failure leaves content hidden and offers a retry rather than asserting success.
- Revalidates the session via `session_get` on protected-page entry and when a visible page resumes after the throttled interval. The existing backend `asSession_()` touch behavior controls idle-expiry extension; the client does not invent a new expiry policy.
- Added a common signed-in strip with a logout action. Local tokens are cleared even when the remote logout request fails. Server-side protected operations remain responsible for authorization.
- Added `AUTH_ENDPOINT_CONFIGURATION.md`, identifying the single frontend location for the private auth `/exec` URL and distinguishing it from the public catalogue endpoint. It contains no real URL, spreadsheet ID, or secret.
- Regenerated `public-site/` from the source using the safe exporter. It remains synthetic-only and excludes private source data.
- Added `tests/auth.lifecycle.test.js` and included it in the focused npm test script.

## Verification

- Task 58 lifecycle checks: **7/7 passed** (mocked local storage and unconfigured endpoint; no live call).
- Existing unit suite: **24/24 passed**.
- Exam unit suite: **30/30 passed**.
- Manifest loader: **426/426 checks passed; 19/19 mutation cases detected**.
- Release-builder tests: **4/4 passed**.
- Link check: **492 links, 0 broken, 0 duplicate IDs** for both source and regenerated `public-site/`.
- JavaScript syntax check: `auth.js` and `app.js` passed.
- Archive CRC validation passed after packaging.

## Not verified / owner blockers

- The private endpoint still uses `REPLACE_WITH_PRIVATE_AUTH_WEB_APP_URL`; therefore the focused lifecycle test confirms unconfigured behavior, not real account login.
- Auth approval gates and Task 57 scoring/key prerequisites remain owner-controlled and OFF. No Google Apps Script deployment, Script Properties, database IDs, email delivery, live registration/login/reset, or real session round trip was run.
- DOM/browser suite was **not run** because `jsdom` is not installed in this environment. Do not interpret these local checks as full browser acceptance.
- Client-side page hiding is navigation/UX, not an authorization boundary. The private backend must validate every account/attempt/result operation. Static pages contain no private account data.

## Next

Task 59: prepare the repository-ready GitHub Pages and Apps Script deployment package, align operation contracts/configuration, audit publish boundaries, and provide exact owner actions without inventing deployment IDs or claiming a live deployment. Tasks 60–65 remain deferred.
