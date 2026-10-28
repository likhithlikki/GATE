/**
 * GATE Prep Studio PRIVATE backend: AuthCore (Task 31). Shared authentication primitives: policy gates, secrets, randomness,
 * keyed hashing, AUTH_DB row access, rate-limit counters, audit rows, mail.
 *
 * Standalone private Apps Script project. Nothing here is a web operation; every name ends in an underscore. The request router
 * (AuthRouter.gs) is the only entry point and it calls AuthService.gs.
 *
 * POLICY GATES (default OFF). Script Property AUTH_POLICY_<NAME> = 'true' turns a gate on; nothing in this project does it for the owner.
 * Each gate is an owner decision from SECURITY_DECISION_REVIEW.md that is recorded there only as a RECOMMENDATION, not an approval:
 *   PASSWORD_SCHEME_A       D-01  browser PBKDF2 pre-hash + server HMAC wrap (provisional; iteration count must also be configured)
 *   PASSWORD_POLICY         D-02  the owner accepts that password rules (min 8 / max 128, blocklist) are enforced in the browser only
 *   EMAIL_CANONICALISATION  D-19  Gmail canonical form (dots, +tag, case) used for account uniqueness
 *   OTP_PROFILE             D-03  6 digits, 10 min, 5 tries, 60 s gap, 3/hour, 5/day
 *   RATE_LIMITS             D-05  identifier throttles for logins, verification and unknown operations
 *   SESSION_STANDARD        D-04/D-21  12 h absolute / 2 h idle, token kept in sessionStorage
 *   SESSION_REMEMBER        D-04/D-21  30 d absolute / 7 d idle ("keep me logged in"), token kept in localStorage
 * Google sign-in (D-14) and account linking (D-19) have NO code path: there is no verifier to enable, so no gate can switch them on.
 *
 * Required Script Properties (never in a Sheet, never returned, never logged):
 *   AUTH_DB_ID (written by setupPrivateDatabases), AUTH_PEPPER_CURRENT_VERSION (e.g. 1), AUTH_PEPPER_V<n> (>= 32 chars, one per version),
 *   AUTH_KDF_SALT_SECRET (>= 32 chars, never rotated: it makes the per-account client salt stable), AUTH_KDF_ITERATIONS (positive integer; chosen from benchmarks V-01..V-03, so it has NO default), AUTH_CONSENT_VERSION (text id).
 *
 * Randomness follows SECURITY_DESIGN.md 1.6: HMAC-SHA256 keyed with a server secret over several UUIDs, the clock and a counter.
 * Nothing secret (password hash, OTP, proof, token, pepper) is ever logged or returned except the one value a flow must hand the caller.
 */

var AUTH_GATE_NAMES = ['password_scheme_a', 'password_policy', 'email_canonicalisation', 'otp_profile', 'rate_limits', 'session_standard', 'session_remember'];

/* Values from SECURITY_DESIGN.md 1.5 and 2.2 (D-03, D-04, D-05). They are not tuned or invented here. */
var AUTH_LIMITS = Object.freeze({
  otp_digits: 6, otp_ttl_ms: 10 * 60000, otp_max_tries: 5, otp_cooldown_ms: 60000, otp_per_hour: 3, otp_per_day: 5,
  register_proof_ttl_ms: 15 * 60000, reset_proof_ttl_ms: 10 * 60000,
  verify_per_hour: 10, register_complete_per_hour: 10,
  login_fail_max: 5, login_fail_window_ms: 15 * 60000, login_delays_ms: [60000, 5 * 60000, 15 * 60000], login_global_per_hour: 600,
  unknown_op_per_minute: 60,
  kdf_params_per_minute: 60,   /* no value is given for this new operation; it inherits the read-operation figure (60/min) */
  session_standard_abs_ms: 12 * 3600000, session_standard_idle_ms: 2 * 3600000,
  session_remember_abs_ms: 30 * 86400000, session_remember_idle_ms: 7 * 86400000,
  session_touch_ms: 5 * 60000,   /* idle expiry is extended at most this often: it can only make idle expiry earlier, never later */
  lock_wait_ms: 10000
});

var AC_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
var AC_HEX64_RE = /^[0-9a-f]{64}$/;
var AC_USERNAME_RE = /^[A-Za-z0-9_]{3,30}$/;
var AC_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
var AC_SESSION_TOKEN_RE = /^[0-9a-f]{32}\.[0-9a-f]{64}$/;
var AC_PROOF_TOKEN_RE = /^[0-9a-f]{32}\.[0-9a-f]{64}$/;
var AC_OTP_RE = /^\d{6}$/;
var AC_KDF_SCHEME = 'A1';

/* ---------------------------------------------------------------------------------------------------
 * Errors. acErr_(code) carries an internal code. Only codes in AC_PUBLIC_CODES ever reach a browser; anything else becomes server_error.
 * ------------------------------------------------------------------------------------------------- */
var AC_PUBLIC_CODES = {
  bad_request: 1, unsupported_method: 1, unknown_op: 1, payload_invalid: 1, feature_disabled: 1, not_initialized: 1, busy: 1, try_later: 1,
  invalid_credentials: 1, unauthenticated: 1, otp_requested: 1, otp_invalid: 1, proof_invalid: 1, registration_failed: 1, username_unavailable: 1,
  reset_requested: 1, temporarily_unavailable: 1, ok: 1, server_error: 1, session_standard_disabled: 1, session_remember_disabled: 1,
  not_found: 1, conflict: 1, attempt_closed: 1, attempt_expired: 1   /* Tasks 32-34: exam operations */
};
function acErr_(code, detail) { var e = new Error('Auth ' + code); e.name = 'AuthError'; e.acCode = code; e.acDetail = detail || ''; return e; }

/* ---------------------------------------------------------------------------------------------------
 * Policy gates and configuration
 * ------------------------------------------------------------------------------------------------- */
function acGate_(name) {
  var v = PropertiesService.getScriptProperties().getProperty('AUTH_POLICY_' + name.toUpperCase());
  return v !== null && v !== undefined && String(v).trim().toLowerCase() === 'true';
}
/* Throws feature_disabled (detail = the first missing gate) unless every named gate is on. */
function acRequireGates_(names) {
  for (var i = 0; i < names.length; i++) { if (!acGate_(names[i])) { throw acErr_('feature_disabled', names[i]); } }
}
function acPepperVersion_() {
  var v = ksProp_(PropertiesService.getScriptProperties(), 'AUTH_PEPPER_CURRENT_VERSION');
  if (!/^[1-9]\d{0,3}$/.test(v)) { throw acErr_('feature_disabled', 'pepper_version_unset'); }
  return v;
}
function acPepper_(version) {
  var v = String(version);
  if (!/^[1-9]\d{0,3}$/.test(v)) { throw acErr_('feature_disabled', 'pepper_unavailable'); }
  var s = ksProp_(PropertiesService.getScriptProperties(), 'AUTH_PEPPER_V' + v);
  if (!s || s.length < KEYSTORE_MIN_SECRET_LENGTH) { throw acErr_('feature_disabled', 'pepper_unavailable'); }
  return s;
}
function acKdfIterations_() {
  var s = ksProp_(PropertiesService.getScriptProperties(), 'AUTH_KDF_ITERATIONS');
  if (!/^[1-9]\d{0,8}$/.test(s)) { throw acErr_('feature_disabled', 'kdf_iterations_unset'); }
  return parseInt(s, 10);
}
function acKdfSaltSecret_() {
  var s = ksProp_(PropertiesService.getScriptProperties(), 'AUTH_KDF_SALT_SECRET');
  if (!s || s.length < KEYSTORE_MIN_SECRET_LENGTH) { throw acErr_('feature_disabled', 'kdf_salt_secret_unset'); }
  return s;
}
function acConsentVersion_() {
  var s = ksProp_(PropertiesService.getScriptProperties(), 'AUTH_CONSENT_VERSION');
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(s)) { throw acErr_('feature_disabled', 'consent_version_unset'); }
  return s;
}
function acNow_() { return Date.now(); }
function acIso_(ms) { return new Date(ms).toISOString(); }

/* ---------------------------------------------------------------------------------------------------
 * Keyed hashing and randomness
 * ------------------------------------------------------------------------------------------------- */
function acEncode_(parts) { return parts.map(function (p) { p = String(p); return p.length + ':' + p; }).join('|'); }
function acHmacHex_(secret, message) { return ksHex_(Utilities.computeHmacSha256Signature(String(message), String(secret))); }
/* Domain-separated keyed hash: label + parts, keyed by the pepper of the given (default current) version. */
function acMac_(label, parts, version) {
  return acHmacHex_(acPepper_(version === undefined ? acPepperVersion_() : version), 'GPS-AUTH-V1|' + label + '|' + acEncode_(parts));
}
var AC_RAND_COUNTER_ = 0;
/* n bytes as hex (n <= 32 per round; rounds are concatenated). */
function acRandHex_(n) {
  var out = '';
  while (out.length < n * 2) {
    AC_RAND_COUNTER_++;
    var mix = [Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid(), String(Date.now()), String(AC_RAND_COUNTER_), String(Math.random())].join('|');
    out += acMac_('rand', [mix]);
  }
  return out.slice(0, n * 2);
}
/* Uniform 6-digit code by rejection sampling over 32-bit values. */
function acOtpCode_() {
  for (var i = 0; i < 20; i++) {
    var n = parseInt(acRandHex_(4), 16);
    if (n < 4294000000) { var d = String(n % 1000000); return ('000000' + d).slice(-6); }
  }
  throw acErr_('random_failed');
}

/* ---------------------------------------------------------------------------------------------------
 * Input validation (server side only; the browser's checks are advisory)
 * ------------------------------------------------------------------------------------------------- */
function acStr_(v, max) { return typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null; }

/* Gmail only (matches the form). Returns {email, canonical} or null. Canonical = local part lower-cased, dots and +tag removed. */
function acEmail_(v) {
  var s = acStr_(v, 254);
  if (s === null) { return null; }
  s = s.trim().toLowerCase();
  var m = /^([a-z0-9._%+\-]+)@gmail\.com$/.exec(s);
  if (!m) { return null; }
  var local = m[1].split('+')[0].replace(/\./g, '');
  if (!local) { return null; }
  return { email: s, canonical: local + '@gmail.com' };
}
function acUsername_(v) { var s = acStr_(v, 30); return s !== null && AC_USERNAME_RE.test(s) ? s : null; }
function acFullName_(v) { var s = acStr_(v, 100); if (s === null) { return null; } s = s.trim(); return s.length >= 1 ? s : null; }
/* Login/reset identifier: a Gmail address or a username. Returns {kind:'email'|'username', value, lower} or null. */
function acIdentifier_(v) {
  var s = acStr_(v, 254);
  if (s === null) { return null; }
  s = s.trim();
  if (s.indexOf('@') >= 0) { var e = acEmail_(s); return e ? { kind: 'email', value: e.canonical, lower: s.toLowerCase() } : null; }
  var u = acUsername_(s);
  return u ? { kind: 'username', value: u.toLowerCase(), lower: u.toLowerCase() } : null;
}
function acH1_(v) { return typeof v === 'string' && AC_HEX64_RE.test(v) ? v : null; }

/* ---------------------------------------------------------------------------------------------------
 * AUTH_DB access. Refuses to run unless every auth tab exists with the schema header (setupPrivateDatabases creates them).
 * ------------------------------------------------------------------------------------------------- */
var AC_CTX_ = null;
function acDb_() {
  if (AC_CTX_) { return AC_CTX_; }
  var props = PropertiesService.getScriptProperties();
  var authId = ksProp_(props, PRIVATE_DB_PROPERTY_KEYS.AUTH_DB);
  if (!authId) { throw acErr_('not_initialized', 'auth_db_unset'); }
  var others = [ksProp_(props, PRIVATE_DB_PROPERTY_KEYS.EXAM_DB), ksProp_(props, PRIVATE_DB_PROPERTY_KEYS.KEYS_DB), ksProp_(props, KEYSTORE_PUBLIC_ID_PROPERTY)];
  if (others.some(function (o) { return o && o === authId; })) { throw acErr_('not_initialized', 'auth_db_conflict'); }
  var ss;
  try { ss = SpreadsheetApp.openById(authId); } catch (e) { throw acErr_('not_initialized', 'auth_db_unavailable'); }
  var sheets = {};
  Object.keys(PRIVATE_DB_SCHEMAS.AUTH_DB).forEach(function (tab) {
    try { sheets[tab] = ksSheet_(ss, tab, PRIVATE_DB_SCHEMAS.AUTH_DB[tab].columns); }
    catch (e2) { throw acErr_('not_initialized', 'auth_schema_' + tab); }
  });
  AC_CTX_ = { ss: ss, sheets: sheets };
  return AC_CTX_;
}
function acCols_(tab) { return PRIVATE_DB_SCHEMAS.AUTH_DB[tab].columns; }

/* All rows of a tab whose column equals value: [{rowNo, o}] with every cell as text. Reads only the key column first. */
function acFind_(tab, col, value) {
  var sh = acDb_().sheets[tab], cols = acCols_(tab), n = sh.getLastRow() - 1, out = [];
  if (n < 1) { return out; }
  var keys = sh.getRange(2, cols.indexOf(col) + 1, n, 1).getValues(), hits = [];
  for (var i = 0; i < n; i++) { if (ksCellString_(keys[i][0]) === value) { hits.push(i + 2); } }
  hits.forEach(function (rowNo) {
    var cells = sh.getRange(rowNo, 1, 1, cols.length).getValues()[0].map(ksCellString_);
    out.push({ rowNo: rowNo, o: ksRowObject_(cols, cells) });
  });
  return out;
}
function acAll_(tab) {
  var sh = acDb_().sheets[tab], cols = acCols_(tab), n = sh.getLastRow() - 1;
  if (n < 1) { return []; }
  return sh.getRange(2, 1, n, cols.length).getValues().map(function (r, i) { return { rowNo: i + 2, o: ksRowObject_(cols, r.map(ksCellString_)) }; });
}
/* Callers hold the script lock for every write. Text format first, then values, then read back. */
function acAppend_(tab, obj) {
  var sh = acDb_().sheets[tab], cols = acCols_(tab);
  var row = cols.map(function (c) { var v = obj[c]; return v === undefined || v === null ? '' : String(v); });
  var start = sh.getLastRow() + 1;
  if (sh.getMaxRows() < start) { sh.insertRowsAfter(sh.getMaxRows(), 1); }
  var rng = sh.getRange(start, 1, 1, cols.length);
  rng.setNumberFormat('@'); rng.setValues([row]); SpreadsheetApp.flush();
  var back = sh.getRange(start, 1, 1, cols.length).getValues()[0];
  for (var i = 0; i < cols.length; i++) { if (ksCellString_(back[i]) !== row[i]) { throw acErr_('write_failed'); } }
  return start;
}
function acUpdate_(tab, rowNo, patch) {
  var sh = acDb_().sheets[tab], cols = acCols_(tab);
  Object.keys(patch).forEach(function (c) {
    var idx = cols.indexOf(c);
    if (idx < 0) { throw acErr_('write_failed'); }
    var cell = sh.getRange(rowNo, idx + 1), v = patch[c] === null || patch[c] === undefined ? '' : String(patch[c]);
    cell.setNumberFormat('@'); cell.setValue(v);
  });
  SpreadsheetApp.flush();
  Object.keys(patch).forEach(function (c) {
    var v = patch[c] === null || patch[c] === undefined ? '' : String(patch[c]);
    if (ksCellString_(sh.getRange(rowNo, cols.indexOf(c) + 1).getValue()) !== v) { throw acErr_('write_failed'); }
  });
}
function acInt_(s, min) { return /^(0|[1-9]\d{0,15})$/.test(s) && Number(s) >= min ? Number(s) : null; }
function acTime_(s) { var t = atTime_(s); return t === null ? null : t; }

/* One script lock around every read-modify-write (SECURITY_DESIGN.md 2.3). Not re-entrant: callers never nest it. */
function acWithLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(AUTH_LIMITS.lock_wait_ms)) { throw acErr_('busy'); }
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------------------------------------------------------------------------------------------------
 * Audit (AUTH_DB.audit_logs). Caller holds the lock. Never throws into the caller's flow unless asked; never records secrets.
 * ------------------------------------------------------------------------------------------------- */
function acAudit_(event, userId, targetId, result, detail) {
  try { acAppend_('audit_logs', { ts: acIso_(acNow_()), event: event, user_id: userId || '', target_id: targetId || '', result: result, detail: detail || '' }); return true; }
  catch (e) { Logger.log('Auth: audit write failed.'); return false; }
}

/* ---------------------------------------------------------------------------------------------------
 * Rate-limit counters (AUTH_DB.rate_limits). Caller holds the lock. key_hmac = keyed hash of scope + key: no identifiers at rest.
 * ------------------------------------------------------------------------------------------------- */
function acRlRow_(scope, key) {
  var kh = acMac_('rl', [scope, key]), hits = acFind_('rate_limits', 'key_hmac', kh);
  if (hits.length > 1) { throw acErr_('rate_limit_state_invalid'); }
  var r = hits[0];
  return { kh: kh, rowNo: r ? r.rowNo : 0, count: r ? (acInt_(r.o.count, 0) || 0) : 0, windowStart: r ? (acTime_(r.o.window_start) || 0) : 0, blockedUntil: r ? (acTime_(r.o.blocked_until) || 0) : 0 };
}
function acRlSave_(scope, row, count, windowStart, blockedUntil) {
  var patch = { count: String(count), window_start: acIso_(windowStart), blocked_until: blockedUntil ? acIso_(blockedUntil) : '' };
  if (row.rowNo) { acUpdate_('rate_limits', row.rowNo, patch); }
  else { acAppend_('rate_limits', { key_hmac: row.kh, scope: scope, count: patch.count, window_start: patch.window_start, blocked_until: patch.blocked_until }); }
}
/* True while a progressive delay is in force. */
function acRlBlocked_(scope, key) { return acRlRow_(scope, key).blockedUntil > acNow_(); }
/* Counts one event in a fixed window. Returns true if it is within the limit, false once the limit is exceeded (no state change beyond the count). */
function acRlHit_(scope, key, limit, windowMs) {
  var now = acNow_(), row = acRlRow_(scope, key), count = row.count, ws = row.windowStart;
  if (!ws || now - ws >= windowMs) { count = 0; ws = now; }
  if (count >= limit) { return false; }
  acRlSave_(scope, row, count + 1, ws, 0);
  return true;
}
/* Counts a failure. From the limit on, sets the escalating delay (delays[min(overflow, last)]). */
function acRlFail_(scope, key, limit, windowMs, delays) {
  var now = acNow_(), row = acRlRow_(scope, key), count = row.count, ws = row.windowStart;
  if (!ws || now - ws >= windowMs) { count = 0; ws = now; }
  count++;
  var until = 0;
  if (count >= limit) { until = now + delays[Math.min(count - limit, delays.length - 1)]; }
  acRlSave_(scope, row, count, ws, until);
}
function acRlClear_(scope, key) {
  var row = acRlRow_(scope, key);
  if (row.rowNo) { acRlSave_(scope, row, 0, acNow_(), 0); }
}

/* ---------------------------------------------------------------------------------------------------
 * Mail. The OTP is the only secret ever put in a message. Returns true only if the mail service accepted it. Never logs the body.
 * ------------------------------------------------------------------------------------------------- */
function acMailBudgetOk_() { try { return MailApp.getRemainingDailyQuota() >= 1; } catch (e) { return false; } }
function acSendMail_(to, subject, body) {
  try { MailApp.sendEmail({ to: to, subject: subject, body: body, name: 'GATE Prep Studio', noReply: true }); return true; }
  catch (e) { Logger.log('Auth: mail send failed.'); return false; }
}
