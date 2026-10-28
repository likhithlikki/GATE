/**
 * GATE Prep Studio PRIVATE backend: AuthRouter (Task 31). The only web entry point of the private project.
 *
 * Deployment (owner, once real configuration exists): Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone. The public
 * catalogue project (repository root) is a different script and never receives these operations.
 *
 * Transport (SECURITY_DESIGN.md 1.1, deliberately not JSONP): HTTPS POST with a JSON string body sent as Content-Type text/plain, which a
 * browser treats as a "simple" cross-origin request, so no preflight is needed (Apps Script does not answer OPTIONS). The body carries
 * { op, requestId, sessionToken?, payload }. Credentials, OTPs and tokens are never accepted in a URL: any query string is refused. doGet
 * answers every request with unsupported_method and returns no data, so no operation can be reached through a script tag.
 * Constraints this transport cannot remove: no request headers, no Origin check and no client IP are visible to the script, and the
 * browser can read the response only because Apps Script's redirect target allows it. This is untested here: verify against a real deployment.
 *
 * Every response is {ok, code, requestId?, data?, reason?}. Only codes listed in AC_PUBLIC_CODES leave this file; any other failure becomes
 * server_error with nothing else. reason is only ever a gate, configuration or conflict name (lowercase code) for feature_disabled, conflict and payload_invalid. Stack traces, sheet names, ids of
 * other users, hashes, OTPs and tokens are never in a response, and request bodies are never logged.
 */

var AR_MAX_BODY = 8192;
var AR_OPS = Object.freeze({
  auth_status: { fn: function () { return opAuthStatus_(); } },
  kdf_params: { fn: function (p) { return opKdfParams_(p); } },
  register_start: { fn: function (p) { return opRegisterStart_(p); } },
  register_verify_otp: { fn: function (p) { return opRegisterVerifyOtp_(p); } },
  register_complete: { fn: function (p) { return opRegisterComplete_(p); } },
  login_password: { fn: function (p) { return opLoginPassword_(p); } },
  login_google: { fn: function () { return opLoginGoogle_(); } },
  forgot_start: { fn: function (p) { return opForgotStart_(p); } },
  forgot_verify_otp: { fn: function (p) { return opForgotVerifyOtp_(p); } },
  forgot_complete: { fn: function (p) { return opForgotComplete_(p); } },
  change_password: { session: true, fn: function (p, t) { return opChangePassword_(p, t); } },
  session_get: { session: true, fn: function (p, t) { return opSessionGet_(p, t); } },
  logout: { fn: function (p, t) { return opLogout_(p, t); } },
  logout_all: { session: true, fn: function (p, t) { return opLogoutAll_(p, t); } },
  /* Tasks 32-34: protected session operations. The user id is the validated session's; no payload field can name a user. */
  list_papers: { session: true, fn: function (p, t) { return opListPapers_(p, t); } },
  start_attempt: { session: true, fn: function (p, t) { return opStartAttempt_(p, t); } },
  get_attempt: { session: true, fn: function (p, t) { return opGetAttempt_(p, t); } },
  save_answers: { session: true, fn: function (p, t) { return opSaveAnswers_(p, t); } },
  submit_attempt: { session: true, fn: function (p, t) { return opSubmitAttempt_(p, t); } },
  score_attempt: { session: true, fn: function (p, t) { return opScoreAttempt_(p, t); } },
  get_result: { session: true, fn: function (p, t) { return opGetResult_(p, t); } },
  get_result_review: { session: true, fn: function (p, t) { return opGetResultReview_(p, t); } },
  list_attempts: { session: true, fn: function (p, t) { return opListAttempts_(p, t); } },
  list_bookmarks: { session: true, fn: function (p, t) { return opListBookmarks_(p, t); } },
  add_bookmark: { session: true, fn: function (p, t) { return opAddBookmark_(p, t); } },
  remove_bookmark: { session: true, fn: function (p, t) { return opRemoveBookmark_(p, t); } },
  profile_get: { session: true, fn: function (p, t) { return opProfileGet_(p, t); } }
});

function arIsPlain_(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
function arReply_(env) {
  return ContentService.createTextOutput(JSON.stringify(env)).setMimeType(ContentService.MimeType.JSON);
}
function arFail_(code, requestId, reason) {
  var env = { ok: false, code: AC_PUBLIC_CODES[code] === 1 ? code : 'server_error' };
  if (requestId) { env.requestId = requestId; }
  if ((env.code === 'feature_disabled' || env.code === 'conflict' || env.code === 'payload_invalid') && typeof reason === 'string' && /^[a-z0-9_]{1,64}$/.test(reason)) { env.reason = reason; }
  return arReply_(env);
}

function doGet() { return arFail_('unsupported_method', ''); }

function doPost(e) {
  var requestId = '';
  try {
    if (!e || !e.postData || typeof e.postData.contents !== 'string') { return arFail_('bad_request', ''); }
    if (e.parameter && Object.keys(e.parameter).length) { return arFail_('bad_request', ''); }   /* nothing may travel in a URL */
    var text = e.postData.contents;
    if (!text.length || text.length > AR_MAX_BODY) { return arFail_('bad_request', ''); }
    var req;
    try { req = JSON.parse(text); } catch (e1) { return arFail_('bad_request', ''); }
    if (!arIsPlain_(req)) { return arFail_('bad_request', ''); }
    var allowed = { op: 1, requestId: 1, sessionToken: 1, payload: 1 };
    if (Object.keys(req).some(function (k) { return !allowed[k]; })) { return arFail_('bad_request', ''); }
    if (typeof req.requestId !== 'string' || !AC_REQUEST_ID_RE.test(req.requestId)) { return arFail_('bad_request', ''); }
    requestId = req.requestId;
    var token = req.sessionToken === undefined ? '' : req.sessionToken;
    if (typeof token !== 'string' || token.length > 100) { return arFail_('bad_request', requestId); }
    var payload = req.payload === undefined ? {} : req.payload;
    if (!arIsPlain_(payload)) { return arFail_('bad_request', requestId); }
    var op = typeof req.op === 'string' && Object.prototype.hasOwnProperty.call(AR_OPS, req.op) ? AR_OPS[req.op] : null;
    if (!op) { arCountUnknown_(); return arFail_('unknown_op', requestId); }
    if (op.session && !token) { return arFail_('unauthenticated', requestId); }

    var out = op.fn(payload, token);
    var env = { ok: true, code: out && out.code ? out.code : 'ok', requestId: requestId };
    if (out && out.data !== undefined) { env.data = out.data; }
    return arReply_(env);
  } catch (err) {
    if (err && err.acCode) { Logger.log('AuthRouter: ' + err.acCode); return arFail_(err.acCode, requestId, err.acDetail); }
    if (err && err.ksCode) { Logger.log('AuthRouter: ' + err.ksCode); return arFail_(err.ksCode === 'busy' ? 'busy' : 'server_error', requestId); }
    Logger.log('AuthRouter: unexpected error (' + String(err && err.name ? err.name : 'Error') + ').');
    return arFail_('server_error', requestId);
  }
}

/* Unknown operations are counted globally (60/minute, D-05). Best effort: skipped when the gate is off, the database is not ready or the lock is busy. */
function arCountUnknown_() {
  try { if (acGate_('rate_limits')) { acDb_(); acWithLock_(function () { acRlHit_('unknownop', 'all', AUTH_LIMITS.unknown_op_per_minute, 60000); }); } }
  catch (e) { /* nothing to do: the caller already answers unknown_op */ }
}
