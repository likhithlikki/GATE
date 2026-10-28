# Private authentication endpoint configuration (Task 58)

This project deliberately uses two separate Apps Script web apps:

- **Private auth / exam service:** `private-backend/AuthRouter.gs`; browser adapter: top-level `auth.js`.
- **Public question catalogue:** top-level `api.js`. It is not the authentication service and must not receive passwords, OTPs, proofs, or session tokens.

## Owner configuration path

1. Deploy the owner-managed `private-backend/` Apps Script project as a Web app using the reviewed deployment settings. Do not deploy the repository root as the private service.
2. In the **top-level `auth.js` only**, replace `REPLACE_WITH_PRIVATE_AUTH_WEB_APP_URL` in `AUTH_ENDPOINT_URL` with that private web app's HTTPS `/exec` URL. Do not add credentials, spreadsheet IDs, pepper values, KDF secrets, OTP values, or session tokens to source files.
3. Run `python tools/export_public_site.py` to regenerate `public-site/` from the approved website-facing files. Do not hand-edit the generated `public-site/auth.js`; the exporter overwrites it from the top-level source.
4. Keep private script properties (including `AUTH_DB_ID`, `AUTH_PEPPER_CURRENT_VERSION`, `AUTH_PEPPER_V<n>`, `AUTH_KDF_SALT_SECRET`, `AUTH_KDF_ITERATIONS`, `AUTH_CONSENT_VERSION` and every `AUTH_POLICY_*` approval) in Apps Script **Script Properties**, never in Sheets, HTML, JavaScript, the public site, or a browser URL.
5. Validate `auth_status`, OTP delivery, registration, login, session revalidation, reset and logout against a test account before enabling real users. The current approval gates are intentionally OFF; configuring a URL alone must not enable them.

## Fail-closed behavior

If the endpoint is still the placeholder, account requests are rejected locally without invoking `fetch`. Protected account pages redirect to `login.html`, remember only an allowlisted local filename in `sessionStorage`, and do not put return targets or authentication values in the URL. If the endpoint is configured but the server cannot be reached, protected content stays hidden and the page offers a retry instead of silently treating the user as authenticated.

This client-side page guard is a navigation/UX control, not an access-control boundary. Every private operation and every answer/result operation must validate the session and policy gates in the private Apps Script backend.

## Current limitation

The authentication flow is implemented in source but cannot be considered live until Task 57's owner decisions and private database/key prerequisites are resolved, Script Properties are configured in the owner project, the private web app is deployed, and a real account/session round trip succeeds. No deployment URL or spreadsheet ID is supplied in this archive.
