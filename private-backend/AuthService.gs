/**
 * GATE Prep Studio PRIVATE backend: AuthService (Task 31). Account, OTP, password and session operations on AUTH_DB.
 *
 * Called only by the router (AuthRouter.gs). Every operation validates its own input, checks its policy gates first (AuthCore.gs; all
 * default OFF) and returns {code, data?} or throws acErr_(code). Nothing the browser sends decides identity, role or session status.
 *
 * Password scheme (D-01 option A, provisional, gate PASSWORD_SCHEME_A): the browser sends H1 = PBKDF2-HMAC-SHA256(NFKC(password), salt, N)
 * as 64 hex characters. The server stores H2 = keyed hash(pepper, server salt, H1), the server salt, the scheme 'A1.<N>' and the pepper
 * version in `credentials`. The client salt comes from kdf_params (SECURITY_DECISION_REVIEW F-01): a keyed hash of the account's canonical
 * email, or of the identifier for unknown accounts, so known and unknown identifiers look alike. Under this scheme the server can check only
 * that H1 is 64 hex characters: password length and blocklist rules are browser-side (D-02, gate PASSWORD_POLICY). F-10 (upgrading N for
 * existing users) is not implemented.
 *
 * Responses never say whether a Gmail address or username exists, except one deliberate case: username_unavailable at register_complete,
 * reachable only with a proof of a verified Gmail address and rate-limited. Login, reset and OTP requests answer identically either way.
 *
 * Everything that reads then writes state runs inside one script lock (acWithLock_), kept short: hashing and validation happen outside it,
 * and mail is sent between two short lock sections, never inside one.
 */

var AS_PW_GATES = ['password_scheme_a', 'password_policy'];

/* ---------------------------------------------------------------------------------------------------
 * Lookups
 * ------------------------------------------------------------------------------------------------- */
function asFindUser_(id) {
  var hits = id.kind === 'email' ? acFind_('users', 'email_canonical', id.value) : acFind_('users', 'username_lower', id.value);
  return hits.length === 1 ? hits[0] : null;   /* more than one is corrupt state: treated as not found */
}
function asFindCred_(userId) {
  var hits = acFind_('credentials', 'user_id', userId);
  return hits.length === 1 ? hits[0] : null;
}
function asKdfSalt_(seed) { return acHmacHex_(acKdfSaltSecret_(), 'GPS-KDF-SALT-V1|' + seed); }
function asSchemeText_(n) { return AC_KDF_SCHEME + '.' + n; }
function asSchemeIterations_(text) { var m = /^A1\.([1-9]\d{0,8})$/.exec(text || ''); return m ? parseInt(m[1], 10) : null; }
function asUnknownKey_(id) { return 'x-' + acMac_('unk', [id.kind, id.value]).slice(0, 32); }   /* stands in for an email in otps rows of unknown accounts */

function asPwRecord_(h1) {
  var version = acPepperVersion_(), salt = acRandHex_(16);
  return { pw_hash: acMac_('pw', [salt, h1], version), pw_salt: salt, pw_scheme: asSchemeText_(acKdfIterations_()), pepper_version: version };
}
function asPwMatches_(cred, h1) {
  var c = cred.o;
  if (!/^[1-9]\d{0,3}$/.test(c.pepper_version) || asSchemeIterations_(c.pw_scheme) === null || !AC_HEX64_RE.test(c.pw_hash) || !AC_HEX64_RE.test(c.pw_salt)) { return false; }
  return ksConstantTimeEquals_(acMac_('pw', [c.pw_salt, h1], c.pepper_version), c.pw_hash);
}

/* ---------------------------------------------------------------------------------------------------
 * auth_status: which operations are enabled. Reads configuration only; reveals no account data or secret.
 * ------------------------------------------------------------------------------------------------- */
function asEnabled_(gates, needs) {
  for (var i = 0; i < gates.length; i++) { if (!acGate_(gates[i])) { return false; } }
  try { needs.forEach(function (f) { f(); }); return true; } catch (e) { return false; }
}
function opAuthStatus_() {
  var initialized = true;
  try { acDb_(); } catch (e) { initialized = false; }
  var core = [acPepperVersion_, function () { acPepper_(acPepperVersion_()); }, acKdfIterations_, acKdfSaltSecret_];
  var data = { initialized: initialized, google: false, google_reason: 'verification_unresolved_D14', linking: false,
    login: initialized && asEnabled_(['password_scheme_a', 'rate_limits', 'session_standard'], core),
    remember: initialized && asEnabled_(['password_scheme_a', 'rate_limits', 'session_standard', 'session_remember'], core),
    register: initialized && asEnabled_(AS_PW_GATES.concat(['email_canonicalisation', 'otp_profile', 'rate_limits']), core.concat([acConsentVersion_])),
    reset: initialized && asEnabled_(AS_PW_GATES.concat(['otp_profile', 'rate_limits']), core) };
  if (data.register) { data.consent_version = acConsentVersion_(); }
  return { code: 'ok', data: data };
}

/* ---------------------------------------------------------------------------------------------------
 * kdf_params(identifier): {scheme, algorithm, iterations, salt}. Same shape for known and unknown identifiers.
 * ------------------------------------------------------------------------------------------------- */
function opKdfParams_(p) {
  acRequireGates_(['password_scheme_a', 'rate_limits']);
  var id = acIdentifier_(p.identifier);
  if (!id) { throw acErr_('payload_invalid'); }
  var current = acKdfIterations_();
  acDb_();
  if (!acWithLock_(function () { return acRlHit_('kdf', id.kind + ':' + id.value, AUTH_LIMITS.kdf_params_per_minute, 60000); })) { throw acErr_('try_later'); }
  var user = asFindUser_(id), seed, iterations = current;
  if (user) {
    seed = user.o.email_canonical;
    var cred = asFindCred_(user.o.user_id), n = cred ? asSchemeIterations_(cred.o.pw_scheme) : null;
    if (n !== null) { iterations = n; }
  } else { seed = id.kind === 'email' ? id.value : 'u:' + id.value; }
  return { code: 'ok', data: { scheme: AC_KDF_SCHEME, algorithm: 'PBKDF2-HMAC-SHA256', iterations: iterations, salt: asKdfSalt_(seed) } };
}

/* ---------------------------------------------------------------------------------------------------
 * OTP and proofs (AUTH_DB.otps). Proof rows reuse the table with purpose 'register_proof' / 'reset_proof'.
 * ------------------------------------------------------------------------------------------------- */
function asOtpMac_(otpId, purpose, canonical, code) { return acMac_('otp', [otpId, purpose, canonical, code]); }
function asProofMac_(otpId, purpose, canonical, secret) { return acMac_('proof', [otpId, purpose, canonical, secret]); }

/* Records an OTP request (rate-limited, one active code per email+purpose) and, when `deliverTo` is set, emails the code between two short
 * lock sections. `deliverTo` '' records the request without sending (existing account on register, unknown account on reset). Returns nothing:
 * callers answer the same way whatever happened. Throws only for gates, configuration, a missing mail budget and lock contention. */
function asRequestOtp_(purpose, canonical, deliverTo) {
  if (!acMailBudgetOk_()) { throw acErr_('temporarily_unavailable'); }   /* global, so it says nothing about any account */
  var now = acNow_(), code = acOtpCode_(), otpId = acRandHex_(16), mac = asOtpMac_(otpId, purpose, canonical, code), A = AUTH_LIMITS;
  var rowNo = acWithLock_(function () {
    var rows = acFind_('otps', 'email_canonical', canonical).filter(function (r) { return r.o.purpose === purpose; });
    var last = 0, hour = 0, day = 0;
    rows.forEach(function (r) {
      var t = acTime_(r.o.created_at) || 0;
      if (t > last) { last = t; }
      if (now - t < 3600000) { hour++; }
      if (now - t < 86400000) { day++; }
    });
    if ((last && now - last < A.otp_cooldown_ms) || hour >= A.otp_per_hour || day >= A.otp_per_day) { return 0; }
    rows.forEach(function (r) { if (r.o.status === 'active' || r.o.status === 'pending_send') { acUpdate_('otps', r.rowNo, { status: 'superseded' }); } });
    return acAppend_('otps', { otp_id: otpId, purpose: purpose, email_canonical: canonical, code_hmac: mac, created_at: acIso_(now), expires_at: acIso_(now + A.otp_ttl_ms),
      attempts: '0', status: deliverTo ? 'pending_send' : 'suppressed', used_at: '' });
  });
  if (!rowNo || !deliverTo) { return; }
  var subject = purpose === 'register' ? 'Your GATE Prep Studio verification code' : 'Your GATE Prep Studio password reset code';
  var body = 'Your one-time code is ' + code + '.\n\nIt expires in 10 minutes and can be used once. If you did not ask for it, ignore this message; nothing will change.';
  var sent = acSendMail_(deliverTo, subject, body);
  acWithLock_(function () {
    var rows = acFind_('otps', 'otp_id', otpId);
    if (rows.length === 1 && rows[0].o.status === 'pending_send') { acUpdate_('otps', rows[0].rowNo, { status: sent ? 'active' : 'send_failed' }); }
  });
}

/* Checks a code. Success returns a single-use proof token and consumes the code; every failure returns null. Counts a verify attempt per email. */
function asVerifyOtp_(purpose, canonical, code, proofPurpose, proofTtl) {
  var now = acNow_(), A = AUTH_LIMITS;
  return acWithLock_(function () {
    if (!acRlHit_('verify', canonical, A.verify_per_hour, 3600000)) { throw acErr_('try_later'); }
    var rows = acFind_('otps', 'email_canonical', canonical).filter(function (r) { return r.o.purpose === purpose && r.o.status === 'active'; });
    if (rows.length !== 1) { return null; }
    var r = rows[0], o = r.o, exp = acTime_(o.expires_at), attempts = acInt_(o.attempts, 0);
    if (exp === null || attempts === null || !AC_HEX64_RE.test(o.code_hmac)) { acUpdate_('otps', r.rowNo, { status: 'invalid' }); return null; }
    if (now >= exp) { acUpdate_('otps', r.rowNo, { status: 'expired' }); return null; }
    if (attempts >= A.otp_max_tries) { acUpdate_('otps', r.rowNo, { status: 'locked' }); return null; }
    if (!ksConstantTimeEquals_(asOtpMac_(o.otp_id, purpose, canonical, code), o.code_hmac)) {
      attempts++;
      acUpdate_('otps', r.rowNo, attempts >= A.otp_max_tries ? { attempts: String(attempts), status: 'locked' } : { attempts: String(attempts) });
      return null;
    }
    acUpdate_('otps', r.rowNo, { status: 'used', used_at: acIso_(now) });
    var pid = acRandHex_(16), secret = acRandHex_(32);
    acAppend_('otps', { otp_id: pid, purpose: proofPurpose, email_canonical: canonical, code_hmac: asProofMac_(pid, proofPurpose, canonical, secret),
      created_at: acIso_(now), expires_at: acIso_(now + proofTtl), attempts: '0', status: 'active', used_at: '' });
    return pid + '.' + secret;
  });
}

/* Finds an unexpired, unused proof bound to this purpose and email. Returns the row or null. Caller holds the lock and consumes it. */
function asFindProof_(token, proofPurpose, canonical) {
  if (typeof token !== 'string' || !AC_PROOF_TOKEN_RE.test(token)) { return null; }
  var parts = token.split('.'), rows = acFind_('otps', 'otp_id', parts[0]);
  if (rows.length !== 1) { return null; }
  var o = rows[0].o, exp = acTime_(o.expires_at);
  if (o.purpose !== proofPurpose || o.status !== 'active' || o.email_canonical !== canonical || exp === null || acNow_() >= exp || !AC_HEX64_RE.test(o.code_hmac)) { return null; }
  return ksConstantTimeEquals_(asProofMac_(parts[0], proofPurpose, canonical, parts[1]), o.code_hmac) ? rows[0] : null;
}

/* ---------------------------------------------------------------------------------------------------
 * Registration
 * ------------------------------------------------------------------------------------------------- */
var AS_REGISTER_GATES = ['password_scheme_a', 'password_policy', 'email_canonicalisation', 'otp_profile', 'rate_limits'];
function asRegisterReady_() { acRequireGates_(AS_REGISTER_GATES); acPepperVersion_(); acPepper_(acPepperVersion_()); acKdfIterations_(); acKdfSaltSecret_(); acConsentVersion_(); acDb_(); }

function opRegisterStart_(p) {
  asRegisterReady_();
  var e = acEmail_(p.email);
  if (!e) { throw acErr_('payload_invalid'); }
  var exists = acFind_('users', 'email_canonical', e.canonical).length > 0;
  asRequestOtp_('register', e.canonical, exists ? '' : e.email);
  return { code: 'otp_requested' };
}

function opRegisterVerifyOtp_(p) {
  asRegisterReady_();
  var e = acEmail_(p.email);
  if (!e || typeof p.otp !== 'string' || !AC_OTP_RE.test(p.otp)) { throw acErr_('payload_invalid'); }
  var proof = asVerifyOtp_('register', e.canonical, p.otp, 'register_proof', AUTH_LIMITS.register_proof_ttl_ms);
  if (!proof) { throw acErr_('otp_invalid'); }
  acWithLock_(function () { acAudit_('register_email_verified', '', acMac_('aud', [e.canonical]).slice(0, 16), 'ok', ''); });
  return { code: 'ok', data: { emailProof: proof } };
}

function opRegisterComplete_(p) {
  asRegisterReady_();
  var username = acUsername_(p.username), fullName = acFullName_(p.fullName), e = acEmail_(p.email), h1 = acH1_(p.pwPayload);
  if (!username || !fullName || !e || !h1 || typeof p.emailProof !== 'string' || !AC_PROOF_TOKEN_RE.test(p.emailProof)) { throw acErr_('payload_invalid'); }
  if (p.consentVersion !== acConsentVersion_()) { throw acErr_('payload_invalid'); }
  var rec = asPwRecord_(h1), userId = 'usr_' + acRandHex_(12), now = acNow_();
  return acWithLock_(function () {
    if (!acRlHit_('regcomplete', username.toLowerCase(), AUTH_LIMITS.register_complete_per_hour, 3600000)) { throw acErr_('try_later'); }
    var proof = asFindProof_(p.emailProof, 'register_proof', e.canonical);
    if (!proof) { throw acErr_('proof_invalid'); }
    if (acFind_('users', 'username_lower', username.toLowerCase()).length) { throw acErr_('username_unavailable'); }   /* proof stays usable: pick another name */
    if (acFind_('users', 'email_canonical', e.canonical).length) { throw acErr_('registration_failed'); }
    acUpdate_('otps', proof.rowNo, { status: 'used', used_at: acIso_(now) });   /* consumed before any account row exists */
    acAppend_('credentials', { user_id: userId, pw_hash: rec.pw_hash, pw_salt: rec.pw_salt, pw_scheme: rec.pw_scheme, pepper_version: rec.pepper_version, password_changed_at: acIso_(now) });
    acAppend_('users', { user_id: userId, username: username, username_lower: username.toLowerCase(), full_name: fullName, email: e.email, email_canonical: e.canonical,
      email_verified_at: acIso_(now), google_sub: '', status: 'active', role: 'user', consent_version: p.consentVersion, consent_at: acIso_(now), created_at: acIso_(now), last_login_at: '' });
    acAudit_('register_completed', userId, userId, 'ok', '');
    return { code: 'ok', data: { created: true } };
  });
}

/* ---------------------------------------------------------------------------------------------------
 * Sessions (AUTH_DB.sessions). Token = session_id '.' secret. Only a keyed hash of the pair is stored.
 * A pepper rotation invalidates live sessions (they fail closed and users log in again).
 * ------------------------------------------------------------------------------------------------- */
function asSessionGatesFor_(remember) { acRequireGates_(remember ? ['session_standard', 'session_remember'] : ['session_standard']); }

/* Lock held. Creates a session row and returns the browser-facing payload. */
function asCreateSession_(user, remember) {
  var A = AUTH_LIMITS, now = acNow_(), abs = remember ? A.session_remember_abs_ms : A.session_standard_abs_ms, idle = remember ? A.session_remember_idle_ms : A.session_standard_idle_ms;
  var sid = acRandHex_(16), secret = acRandHex_(32), expires = now + abs, idleExp = Math.min(now + idle, expires);
  acAppend_('sessions', { session_id: sid, user_id: user.user_id, token_hmac: acMac_('session', [sid, secret]), created_at: acIso_(now), last_seen_at: acIso_(now),
    expires_at: acIso_(expires), idle_expires_at: acIso_(idleExp), remember: remember ? 'true' : 'false', revoked_at: '', revoked_reason: '' });
  return { sessionToken: sid + '.' + secret, expires_at: acIso_(expires), idle_expires_at: acIso_(idleExp), remember: remember, user: { username: user.username, full_name: user.full_name } };
}

/* Lock held. Revokes every live session of the user except `keepId`. */
function asRevokeUserSessions_(userId, reason, keepId) {
  var now = acIso_(acNow_());
  acFind_('sessions', 'user_id', userId).forEach(function (r) {
    if (r.o.revoked_at === '' && r.o.session_id !== keepId) { acUpdate_('sessions', r.rowNo, { revoked_at: now, revoked_reason: reason }); }
  });
}

/* Returns {row, user} for a live session, else null. Reads outside the lock; extends idle time (rarely) inside it. */
function asSession_(token) {
  if (typeof token !== 'string' || !AC_SESSION_TOKEN_RE.test(token)) { return null; }
  var parts = token.split('.'), rows = acFind_('sessions', 'session_id', parts[0]);
  if (rows.length !== 1) { return null; }
  var r = rows[0], o = r.o, now = acNow_();
  if (!AC_HEX64_RE.test(o.token_hmac) || !ksConstantTimeEquals_(acMac_('session', [parts[0], parts[1]]), o.token_hmac)) { return null; }
  var exp = acTime_(o.expires_at), idleExp = acTime_(o.idle_expires_at), seen = acTime_(o.last_seen_at);
  if (o.revoked_at !== '' || exp === null || idleExp === null || seen === null || now >= exp || now >= idleExp) { return null; }
  var remember = o.remember === 'true';
  if (o.remember !== 'true' && o.remember !== 'false') { return null; }
  if (!acGate_('session_standard') || (remember && !acGate_('session_remember'))) { return null; }   /* a switched-off mode stops working at once */
  var users = acFind_('users', 'user_id', o.user_id);
  if (users.length !== 1 || users[0].o.status !== 'active') { return null; }
  if (now - seen >= AUTH_LIMITS.session_touch_ms) {
    var idle = remember ? AUTH_LIMITS.session_remember_idle_ms : AUTH_LIMITS.session_standard_idle_ms;
    acWithLock_(function () { acUpdate_('sessions', r.rowNo, { last_seen_at: acIso_(now), idle_expires_at: acIso_(Math.min(now + idle, exp)) }); });
  }
  return { row: r, user: users[0].o, remember: remember };
}
function asRequireSession_(token) { var s = asSession_(token); if (!s) { throw acErr_('unauthenticated'); } return s; }

function opSessionGet_(p, token) {
  acDb_();
  var s = asRequireSession_(token);
  return { code: 'ok', data: { user: { username: s.user.username, full_name: s.user.full_name, role: s.user.role }, expires_at: s.row.o.expires_at, idle_expires_at: s.row.o.idle_expires_at, remember: s.remember } };
}

function opLogout_(p, token) {
  acDb_();
  if (typeof token === 'string' && AC_SESSION_TOKEN_RE.test(token)) {
    var parts = token.split('.');
    acWithLock_(function () {
      var rows = acFind_('sessions', 'session_id', parts[0]);
      if (rows.length === 1 && rows[0].o.revoked_at === '' && AC_HEX64_RE.test(rows[0].o.token_hmac) && ksConstantTimeEquals_(acMac_('session', [parts[0], parts[1]]), rows[0].o.token_hmac)) {
        acUpdate_('sessions', rows[0].rowNo, { revoked_at: acIso_(acNow_()), revoked_reason: 'logout' });
        acAudit_('logout', rows[0].o.user_id, parts[0], 'ok', '');
      }
    });
  }
  return { code: 'ok' };   /* identical whether or not the token was valid */
}

function opLogoutAll_(p, token) {
  acDb_();
  var s = asRequireSession_(token);
  acWithLock_(function () { asRevokeUserSessions_(s.user.user_id, 'logout_all', ''); acAudit_('logout_all', s.user.user_id, s.user.user_id, 'ok', ''); });
  return { code: 'ok' };
}

/* ---------------------------------------------------------------------------------------------------
 * Login
 * ------------------------------------------------------------------------------------------------- */
function asLoginKey_(user, id) { return user ? 'u:' + user.o.user_id : 'i:' + id.kind + ':' + id.value; }

function opLoginPassword_(p) {
  var id = acIdentifier_(p.identifier), h1 = acH1_(p.pwPayload), remember = p.remember === true;
  if (!id || !h1 || (p.remember !== undefined && typeof p.remember !== 'boolean')) { throw acErr_('payload_invalid'); }
  acRequireGates_(['password_scheme_a', 'rate_limits']);
  asSessionGatesFor_(remember);
  acPepper_(acPepperVersion_()); acKdfSaltSecret_(); acDb_();
  var A = AUTH_LIMITS, user = asFindUser_(id), key = asLoginKey_(user, id), now = acNow_();
  var glob = acRlRow_('loginglobal', 'all');
  if (acRlBlocked_('login', key) || (glob.windowStart && now - glob.windowStart < 3600000 && glob.count >= A.login_global_per_hour)) { throw acErr_('try_later'); }
  var cred = user ? asFindCred_(user.o.user_id) : null, ok = false;
  if (user && cred) { var match = asPwMatches_(cred, h1); ok = match && user.o.status === 'active'; }
  else { acMac_('pw', [asKdfSalt_('dummy'), h1]); }   /* similar work for unknown accounts (best effort) */
  return acWithLock_(function () {
    if (!ok) {
      acRlFail_('login', key, A.login_fail_max, A.login_fail_window_ms, A.login_delays_ms);
      acRlHit_('loginglobal', 'all', 1e9, 3600000);
      acAudit_('login_failed', user ? user.o.user_id : '', '', 'denied', '');
      throw acErr_('invalid_credentials');
    }
    var fresh = acFind_('users', 'user_id', user.o.user_id);
    if (fresh.length !== 1 || fresh[0].o.status !== 'active') { throw acErr_('invalid_credentials'); }
    var session = asCreateSession_(fresh[0].o, remember);
    acUpdate_('users', fresh[0].rowNo, { last_login_at: acIso_(acNow_()) });
    acRlClear_('login', key);
    acAudit_('login_success', fresh[0].o.user_id, '', 'ok', remember ? 'remember' : 'standard');
    return { code: 'ok', data: session };
  });
}

function opLoginGoogle_() { throw acErr_('feature_disabled', 'google_verification_unresolved_D14'); }

/* ---------------------------------------------------------------------------------------------------
 * Password reset
 * ------------------------------------------------------------------------------------------------- */
var AS_RESET_GATES = ['password_scheme_a', 'password_policy', 'otp_profile', 'rate_limits'];
function asResetReady_() { acRequireGates_(AS_RESET_GATES); acPepper_(acPepperVersion_()); acKdfIterations_(); acKdfSaltSecret_(); acDb_(); }
function asResetTarget_(id) {
  var u = asFindUser_(id);
  return u && u.o.status === 'active' && AC_ID_RE.test(u.o.user_id) && u.o.email_canonical ? u : null;
}

function opForgotStart_(p) {
  asResetReady_();
  var id = acIdentifier_(p.identifier);
  if (!id) { throw acErr_('payload_invalid'); }
  var u = asResetTarget_(id);
  if (u) { asRequestOtp_('reset', u.o.email_canonical, u.o.email); } else { asRequestOtp_('reset', asUnknownKey_(id), ''); }
  return { code: 'reset_requested' };
}

function opForgotVerifyOtp_(p) {
  asResetReady_();
  var id = acIdentifier_(p.identifier);
  if (!id || typeof p.otp !== 'string' || !AC_OTP_RE.test(p.otp)) { throw acErr_('payload_invalid'); }
  var u = asResetTarget_(id), canonical = u ? u.o.email_canonical : asUnknownKey_(id);
  var proof = asVerifyOtp_('reset', canonical, p.otp, 'reset_proof', AUTH_LIMITS.reset_proof_ttl_ms);
  if (!proof) { throw acErr_('otp_invalid'); }
  return { code: 'ok', data: { resetProof: proof } };
}

function opForgotComplete_(p) {
  asResetReady_();
  var id = acIdentifier_(p.identifier), h1 = acH1_(p.pwPayload);
  if (!id || !h1 || typeof p.resetProof !== 'string' || !AC_PROOF_TOKEN_RE.test(p.resetProof)) { throw acErr_('payload_invalid'); }
  var u = asResetTarget_(id);
  if (!u) { throw acErr_('proof_invalid'); }
  var rec = asPwRecord_(h1), now = acNow_(), mail = u.o.email, userId = u.o.user_id;
  acWithLock_(function () {
    if (!acRlHit_('regcomplete', 'reset:' + userId, AUTH_LIMITS.register_complete_per_hour, 3600000)) { throw acErr_('try_later'); }
    var proof = asFindProof_(p.resetProof, 'reset_proof', u.o.email_canonical);
    if (!proof) { throw acErr_('proof_invalid'); }
    var fresh = acFind_('users', 'user_id', userId);
    if (fresh.length !== 1 || fresh[0].o.status !== 'active') { throw acErr_('proof_invalid'); }
    acUpdate_('otps', proof.rowNo, { status: 'used', used_at: acIso_(now) });
    var cred = asFindCred_(userId), patch = { pw_hash: rec.pw_hash, pw_salt: rec.pw_salt, pw_scheme: rec.pw_scheme, pepper_version: rec.pepper_version, password_changed_at: acIso_(now) };
    if (cred) { acUpdate_('credentials', cred.rowNo, patch); } else { patch.user_id = userId; acAppend_('credentials', patch); }
    asRevokeUserSessions_(userId, 'password_reset', '');
    acRlClear_('login', 'u:' + userId);
    acAudit_('password_reset', userId, userId, 'ok', '');
  });
  if (acMailBudgetOk_()) { acSendMail_(mail, 'Your GATE Prep Studio password was changed', 'The password for your GATE Prep Studio account was just reset. If this was not you, reset it again and contact support.'); }
  return { code: 'ok', data: { reset: true } };
}

/* ---------------------------------------------------------------------------------------------------
 * Password change (authenticated). Revokes every session, then issues a fresh token (rotation on privilege change).
 * ------------------------------------------------------------------------------------------------- */
function opChangePassword_(p, token) {
  var cur = acH1_(p.currentPwPayload), next = acH1_(p.newPwPayload);
  if (!cur || !next) { throw acErr_('payload_invalid'); }
  acRequireGates_(AS_PW_GATES.concat(['rate_limits']));
  acPepper_(acPepperVersion_()); acKdfIterations_(); acKdfSaltSecret_(); acDb_();
  var s = asRequireSession_(token), uid = s.user.user_id, A = AUTH_LIMITS;
  asSessionGatesFor_(s.remember);
  if (acRlBlocked_('pwchange', 'u:' + uid)) { throw acErr_('try_later'); }
  var cred = asFindCred_(uid);
  if (!cred || !asPwMatches_(cred, cur)) {
    acWithLock_(function () { acRlFail_('pwchange', 'u:' + uid, A.login_fail_max, A.login_fail_window_ms, A.login_delays_ms); acAudit_('password_change_failed', uid, '', 'denied', ''); });
    throw acErr_('invalid_credentials');
  }
  var rec = asPwRecord_(next), now = acNow_();
  return acWithLock_(function () {
    var again = asFindCred_(uid);
    if (!again) { throw acErr_('invalid_credentials'); }
    acUpdate_('credentials', again.rowNo, { pw_hash: rec.pw_hash, pw_salt: rec.pw_salt, pw_scheme: rec.pw_scheme, pepper_version: rec.pepper_version, password_changed_at: acIso_(now) });
    asRevokeUserSessions_(uid, 'password_change', '');
    var session = asCreateSession_(s.user, s.remember);
    acRlClear_('pwchange', 'u:' + uid);
    acAudit_('password_changed', uid, uid, 'ok', '');
    return { code: 'ok', data: session };
  });
}
