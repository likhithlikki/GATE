/* GATE Prep Studio: browser adapter for the PRIVATE authentication service (auth.js)
 *
 * Talks only to the private Apps Script web app (private-backend/AuthRouter.gs). It is not the public catalogue adapter (api.js) and it
 * never uses JSONP: passwords, OTPs, proofs and session tokens travel only in the body of an HTTPS POST sent as text/plain (a "simple"
 * cross-origin request, so no preflight; Apps Script does not answer OPTIONS). Nothing is ever put in a URL. This file never logs a
 * request, a response, a password, a code or a token.
 *
 * NOT CONNECTED until the owner replaces AUTH_ENDPOINT_URL with a real deployment URL. Until then every action says so and sends nothing.
 *
 * Password handling (D-01 option A, provisional): the page asks the server for the account's salt and iteration count (kdf_params), derives
 * H1 = PBKDF2-HMAC-SHA256(NFKC(password), salt, iterations) with Web Crypto, and sends only H1 (64 hex characters). The password itself is
 * never sent. H1 is password-equivalent for this site. Hostile page code could still read the typed password: this does not defend against that.
 *
 * Session token storage (D-21): sessionStorage for a normal login, localStorage only when "keep me logged in" was chosen AND the server
 * confirmed a remember session. Both are readable by injected scripts.
 *
 * The server decides what is enabled (auth_status). A feature whose approval gate is off is reported as not enabled, never faked.
 */
(function (root) {
  'use strict';

  /* OWNER ACTION: replace with the private auth web app URL (Apps Script > Deploy > Manage deployments, ends in /exec). */
  var AUTH_ENDPOINT_URL = 'https://script.google.com/macros/s/AKfycbyeo-R6JBjmR3g7JqIKrVvvfIMg5SDs09AhDuhA5COOnUhcGCpbyp_vjOAlOSN6ULA/exec';
  var ENDPOINT_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_\-]{10,200}\/exec$/;
  var TIMEOUT_MS = 25000;
  var STORE_KEY = 'gps.session.v1';
  var RETURN_TO_KEY = 'gps.auth.returnTo.v1';
  var SAFE_RETURN_PAGES = { 'dashboard.html': 1, 'history.html': 1, 'bookmarks.html': 1, 'profile.html': 1 };
  var MAX_ITERATIONS = 10000000;   /* sanity bound against a hostile or broken response; not a security parameter */

  function configured() { return typeof AUTH_ENDPOINT_URL === 'string' && ENDPOINT_RE.test(AUTH_ENDPOINT_URL); }

  /* ---------- session token store ---------- */
  function storeFor(remember) { try { return remember ? root.localStorage : root.sessionStorage; } catch (e) { return null; } }
  function readSession() {
    var found = null;
    [false, true].forEach(function (remember) {
      var st = storeFor(remember), text = null;
      try { text = st ? st.getItem(STORE_KEY) : null; } catch (e) { text = null; }
      if (!text) { return; }
      try {
        var o = JSON.parse(text);
        if (o && typeof o.token === 'string' && /^[0-9a-f]{32}\.[0-9a-f]{64}$/.test(o.token)) {
          if (!found) { found = { token: o.token, remember: remember }; }
        } else if (st) { st.removeItem(STORE_KEY); }
      } catch (e2) { try { if (st) { st.removeItem(STORE_KEY); } } catch (e3) { /* storage is best-effort */ } }
    });
    return found;
  }
  function safeReturnTarget(value) { return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SAFE_RETURN_PAGES, value) ? value : ''; }
  function saveReturnTarget(value) {
    var page = safeReturnTarget(value), st = storeFor(false);
    if (!page || !st) { return false; }
    try { st.setItem(RETURN_TO_KEY, page); return true; } catch (e) { return false; }
  }
  function takeReturnTarget() {
    var st = storeFor(false), value = '';
    try { if (st) { value = st.getItem(RETURN_TO_KEY) || ''; st.removeItem(RETURN_TO_KEY); } } catch (e) { value = ''; }
    return safeReturnTarget(value);
  }
  function currentPage() {
    var path = root.location && typeof root.location.pathname === 'string' ? root.location.pathname : '';
    return path.split('/').pop() || 'index.html';
  }
  function clearSession() { [false, true].forEach(function (r) { var st = storeFor(r); try { if (st) { st.removeItem(STORE_KEY); } } catch (e) { /* nothing to clear */ } }); }
  function saveSession(data) {
    clearSession();
    var st = storeFor(data.remember === true);
    if (!st) { return false; }
    try { st.setItem(STORE_KEY, JSON.stringify({ token: data.sessionToken })); return true; }
    catch (e) { clearSession(); return false; }
  }

  /* ---------- transport ---------- */
  function failure(kind, code, reason) { var e = new Error(kind); e.kind = kind; e.code = code || ''; e.reason = reason || ''; return e; }
  function newRequestId() {
    var a = new Uint8Array(16);
    if (!root.crypto || !root.crypto.getRandomValues) { throw failure('crypto_unavailable'); }
    root.crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  /* POST one operation. Resolves with the response data (or {}) on ok:true; rejects with {kind:'server', code, reason} or a transport kind. */
  function call(op, payload, sessionToken) {
    if (!configured()) { return Promise.reject(failure('not_configured')); }
    if (typeof root.fetch !== 'function') { return Promise.reject(failure('connection')); }
    var rid;
    try { rid = newRequestId(); } catch (e) { return Promise.reject(e); }
    var body = { op: op, requestId: rid, payload: payload || {} };
    if (sessionToken) { body.sessionToken = sessionToken; }
    var ctl = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    var timer = ctl ? root.setTimeout(function () { ctl.abort(); }, TIMEOUT_MS) : null;
    return root.fetch(AUTH_ENDPOINT_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body),
      credentials: 'omit', cache: 'no-store', redirect: 'follow', referrerPolicy: 'no-referrer', signal: ctl ? ctl.signal : undefined
    }).then(function (res) { return res.text(); }, function () { throw failure('connection'); })
      .then(function (text) {
        if (timer) { root.clearTimeout(timer); }
        var env;
        try { env = JSON.parse(text); } catch (e) { throw failure('bad_response'); }
        if (!env || typeof env !== 'object' || Array.isArray(env) || typeof env.ok !== 'boolean' || typeof env.code !== 'string') { throw failure('bad_response'); }
        if (env.requestId !== undefined && env.requestId !== rid) { throw failure('bad_response'); }
        if (!env.ok) { throw failure('server', env.code.slice(0, 48), typeof env.reason === 'string' ? env.reason.slice(0, 64) : ''); }
        return { code: env.code, data: env.data && typeof env.data === 'object' ? env.data : {} };
      }, function (e) {
        if (timer) { root.clearTimeout(timer); }
        throw e && e.kind ? e : failure(e && e.name === 'AbortError' ? 'timeout' : 'connection');
      });
  }

  /* ---------- password derivation (Web Crypto) ---------- */
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function deriveH1(password, params) {
    if (!root.crypto || !root.crypto.subtle || !root.isSecureContext && root.location && root.location.protocol !== 'https:') { return Promise.reject(failure('crypto_unavailable')); }
    if (!params || params.scheme !== 'A1' || params.algorithm !== 'PBKDF2-HMAC-SHA256' || !/^[0-9a-f]{64}$/.test(params.salt || '') ||
        typeof params.iterations !== 'number' || !isFinite(params.iterations) || Math.floor(params.iterations) !== params.iterations || params.iterations < 1 || params.iterations > MAX_ITERATIONS) {
      return Promise.reject(failure('bad_response'));
    }
    var enc = new TextEncoder();
    return root.crypto.subtle.importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits'])
      .then(function (key) { return root.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(params.salt), iterations: params.iterations }, key, 256); })
      .then(hex, function () { throw failure('crypto_unavailable'); });
  }
  /* Fetches the account's parameters and derives H1 for `identifier`. */
  function h1For(identifier, password) {
    return call('kdf_params', { identifier: identifier }).then(function (r) { return deriveH1(password, r.data); });
  }

  /* ---------- messages ---------- */
  var DISABLED_TEXT = 'This feature is not enabled yet: the site owner has not approved the security settings it needs. Nothing was sent or saved.';
  function messageFor(e, what) {
    var k = e && e.kind, c = e && e.code;
    if (k === 'not_configured') { return 'The account service is not connected: no private backend address has been configured for this site. Nothing was sent or saved.'; }
    if (k === 'crypto_unavailable') { return 'This browser cannot protect your password here (it needs Web Crypto on a secure https page). Nothing was sent.'; }
    if (k === 'timeout') { return 'The service did not answer in time. Try again in a moment. Your request may or may not have been processed.'; }
    if (k === 'connection') { return 'Could not reach the account service. Check your connection and try again.'; }
    if (k === 'bad_response') { return 'The account service sent a reply this page does not understand. Nothing was assumed.'; }
    if (c === 'feature_disabled') { return DISABLED_TEXT; }
    if (c === 'try_later' || c === 'busy' || c === 'temporarily_unavailable') { return 'The service is busy or limiting requests right now. Please wait a little and try again.'; }
    if (c === 'invalid_credentials') { return 'The username/email or password is not correct.'; }
    if (c === 'otp_invalid') { return 'That code is not valid, has expired or was used. Request a new code if needed.'; }
    if (c === 'proof_invalid') { return 'The verification has expired or was already used. Verify the code again.'; }
    if (c === 'username_unavailable') { return 'That username is not available. Choose another one.'; }
    if (c === 'not_initialized') { return 'The account service is not set up yet.'; }
    if (c === 'unauthenticated') { return 'You are not logged in.'; }
    return what + ' could not be completed.';
  }

  /* ---------- UI helpers ---------- */
  function $(id) { return root.document.getElementById(id); }
  var pending = {};
  /* Runs `fn` once at a time per key; the button is disabled while it runs. Returns false if already running. */
  function exclusive(key, button, fn) {
    if (pending[key]) { return false; }
    pending[key] = true;
    if (button) { button.setAttribute('aria-disabled', 'true'); button.disabled = true; }
    function release() { pending[key] = false; if (button) { button.disabled = false; button.setAttribute('aria-disabled', 'false'); } }
    var p;
    try { p = fn(); } catch (e) { release(); throw e; }
    Promise.resolve(p).then(release, release);
    return true;
  }
  function setNote(text) { var n = $('auth-note'); if (n && text) { n.textContent = text; } }

  var statusCache = null;
  function loadStatus() {
    if (statusCache) { return statusCache; }
    statusCache = call('auth_status', {}).then(function (r) { return r.data; });
    return statusCache;
  }
  function resetStatus() { statusCache = null; }

  /* ---------- page wiring ---------- */
  var registerState = { proof: '', email: '' };
  var resetState = { proof: '' };

  function describeAvailability(feature) {
    if (!configured()) { setNote('The account service is not connected: no private backend address has been configured for this site. Nothing you type here is sent anywhere.'); return; }
    loadStatus().then(function (s) {
      var on = s && s[feature] === true;
      if (!s || s.initialized !== true) { setNote('The account service is not set up yet. Nothing you type here is sent anywhere.'); return; }
      if (on) { setNote('The account service is connected for this feature. Your details are sent over HTTPS to the private service; your password is never sent, only a derived value.'); return; }
      setNote('This feature is not enabled yet: the site owner has not approved the security settings it needs. Nothing you type here is sent anywhere.');
    }, function (e) { setNote(messageFor(e, 'The status check')); });
  }

  var ui = {
    login: function (c) {
      exclusive('login', c.button, function () {
        c.setStatus('login-status', 'Logging in…');
        var remember = c.remember === true, token;
        return h1For(c.identifier, c.password)
          .then(function (h1) { return call('login_password', { identifier: c.identifier, pwPayload: h1, remember: remember }); })
          .then(function (r) {
            var d = r.data;
            if (typeof d.sessionToken !== 'string' || !/^[0-9a-f]{32}\.[0-9a-f]{64}$/.test(d.sessionToken)) { throw failure('bad_response'); }
            if (d.remember !== remember) { throw failure('bad_response'); }
            c.$('login-password').value = '';
            if (!saveSession(d)) {
              /* A session that cannot be stored must not be left active after a failed browser login. */
              return call('logout', {}, d.sessionToken).catch(function () { return null; }).then(function () {
                clearSession();
                c.setStatus('login-status', 'The server accepted the login, but this browser could not safely keep the session. Storage is blocked, so you have been signed out.');
              });
            }
            c.setStatus('login-status', 'Logged in. Opening your page…');
            var destination = takeReturnTarget() || 'dashboard.html';
            root.setTimeout(function () { root.location.href = destination; }, 250);
          })
          .catch(function (e) { c.$('login-password').value = ''; c.setStatus('login-status', messageFor(e, 'Log in')); });
      });
    },

    registerSendOtp: function (c) {
      exclusive('otp-send', c.button, function () {
        registerState.proof = ''; registerState.email = '';
        c.setStatus('otp-status', 'Requesting a code…');
        return call('register_start', { email: c.email }).then(function () {
          c.setStatus('otp-status', 'Request accepted. If this Gmail address can be registered, a code has been emailed to it. It can take a minute, and a new code can be requested after a short wait.');
        }).catch(function (e) { c.setStatus('otp-status', messageFor(e, 'The request')); });
      });
    },

    registerVerifyOtp: function (c) {
      exclusive('otp-verify', c.button, function () {
        c.setStatus('otp-status', 'Checking the code…');
        return call('register_verify_otp', { email: c.email, otp: c.otp }).then(function (r) {
          if (typeof r.data.emailProof !== 'string') { throw failure('bad_response'); }
          registerState.proof = r.data.emailProof; registerState.email = c.email.toLowerCase();
          c.$('reg-otp').value = '';
          c.setStatus('otp-status', 'Gmail address verified. You can now create your account.');
        }).catch(function (e) { registerState.proof = ''; c.setStatus('otp-status', messageFor(e, 'The check')); });
      });
    },

    register: function (c) {
      if (!registerState.proof || registerState.email !== c.email.toLowerCase()) {
        c.setStatus('register-status', 'Verify your Gmail address with the one-time code first.'); return;
      }
      exclusive('register', c.button, function () {
        c.setStatus('register-status', 'Creating your account…');
        var proof = registerState.proof;
        return loadStatus().then(function (s) {
          if (!s || s.register !== true || typeof s.consent_version !== 'string') { throw failure('server', 'feature_disabled'); }
          return h1For(c.email, c.password).then(function (h1) {
            return call('register_complete', { username: c.username, fullName: c.fullName, email: c.email, pwPayload: h1, emailProof: proof, consentVersion: s.consent_version });
          });
        }).then(function () {
          registerState.proof = '';
          c.$('reg-password').value = ''; c.$('reg-confirm').value = '';
          c.setStatus('register-status', 'Your account was created. You can now log in.');
        }).catch(function (e) {
          if (e && e.code === 'username_unavailable') { c.setError('reg-username', 'That username is not available. Choose another one.'); }
          if (e && e.code === 'proof_invalid') { registerState.proof = ''; }
          c.setStatus('register-status', messageFor(e, 'Registration'));
        });
      });
    },

    forgotStart: function (c) {
      exclusive('forgot', c.button, function () {
        resetState.proof = '';
        c.setStatus('forgot-status', 'Sending request…');
        return call('forgot_start', { identifier: c.identifier }).then(function () {
          c.setStatus('forgot-status', 'Request accepted. If an account matches, a code has been emailed to its Gmail address. Enter it below.');
          var f = $('forgot-code-form'); if (f) { f.hidden = false; }
        }).catch(function (e) { c.setStatus('forgot-status', messageFor(e, 'The request')); });
      });
    },

    forgotVerify: function (c) {
      exclusive('forgot-verify', c.button, function () {
        c.setStatus('forgot-otp-status', 'Checking the code…');
        return call('forgot_verify_otp', { identifier: c.identifier, otp: c.otp }).then(function (r) {
          if (typeof r.data.resetProof !== 'string') { throw failure('bad_response'); }
          resetState.proof = r.data.resetProof;
          c.$('forgot-otp').value = '';
          c.setStatus('forgot-otp-status', 'Code accepted. Choose a new password below.');
          var f = $('forgot-new-form'); if (f) { f.hidden = false; }
        }).catch(function (e) { resetState.proof = ''; c.setStatus('forgot-otp-status', messageFor(e, 'The check')); });
      });
    },

    forgotComplete: function (c) {
      if (!resetState.proof) { c.setStatus('forgot-new-status', 'Check the emailed code first.'); return; }
      exclusive('forgot-complete', c.button, function () {
        c.setStatus('forgot-new-status', 'Saving your new password…');
        var proof = resetState.proof;
        return h1For(c.identifier, c.password).then(function (h1) {
          return call('forgot_complete', { identifier: c.identifier, resetProof: proof, pwPayload: h1 });
        }).then(function () {
          resetState.proof = '';
          c.$('forgot-newpw').value = ''; c.$('forgot-confirm').value = '';
          clearSession();
          c.setStatus('forgot-new-status', 'Your password was changed and all sessions were signed out. You can now log in.');
        }).catch(function (e) { if (e && e.code === 'proof_invalid') { resetState.proof = ''; } c.setStatus('forgot-new-status', messageFor(e, 'The password change')); });
      });
    }
  };

  /* ---------- protected navigation and session lifecycle ----------
   * The server remains the authority. A client guard only protects the page experience; every private data operation must still
   * validate its session on the server. Tokens stay in tab/session or opted-in local storage, never in a URL. */
  var lastSessionCheckAt = 0;
  var sessionCheckInFlight = null;
  var resumeHooksAttached = false;

  function pageBody() { return root.document && root.document.body ? root.document.body : null; }
  function gateScreen() {
    var screen = $('auth-gate-screen');
    if (screen) { return screen; }
    if (!root.document || !root.document.createElement) { return null; }
    screen = root.document.createElement('section');
    screen.id = 'auth-gate-screen'; screen.className = 'wrap auth-gate-screen';
    screen.setAttribute('role', 'status'); screen.setAttribute('aria-live', 'polite');
    var main = $('main');
    if (main && main.parentNode) { main.parentNode.insertBefore(screen, main); }
    else if (root.document.body) { root.document.body.appendChild(screen); }
    return screen;
  }
  function setGateStatus(message, retry) {
    var screen = gateScreen();
    var body = pageBody();
    if (body) { body.setAttribute('data-auth-state', 'blocked'); }
    if (!screen) { return; }
    while (screen.firstChild) { screen.removeChild(screen.firstChild); }
    var p = root.document.createElement('p'); p.className = 'formula'; p.textContent = message; screen.appendChild(p);
    if (retry) {
      var b = root.document.createElement('button'); b.type = 'button'; b.className = 'btn btn-primary'; b.textContent = 'Retry session check';
      b.addEventListener('click', function () { verifyProtectedPage(currentPage()); }); screen.appendChild(b);
    }
    var link = root.document.createElement('a'); link.className = 'btn btn-quiet'; link.href = 'login.html'; link.textContent = 'Go to login'; screen.appendChild(link);
  }
  function redirectLogin(page) {
    saveReturnTarget(page);
    clearSession();
    if (root.location && typeof root.location.replace === 'function') { root.location.replace('login.html'); }
    else if (root.location) { root.location.href = 'login.html'; }
  }
  function attachSessionControls(user, token) {
    var main = $('main');
    if (!main || !root.document) { return; }
    var existing = $('auth-session-strip'); if (existing && existing.parentNode) { existing.parentNode.removeChild(existing); }
    var box = root.document.createElement('div'); box.id = 'auth-session-strip'; box.className = 'wrap';
    var p = root.document.createElement('p'); p.className = 'formula'; p.setAttribute('role', 'status');
    p.appendChild(root.document.createTextNode('You are signed in as ' + user.username + '. '));
    var b = root.document.createElement('button'); b.type = 'button'; b.className = 'btn btn-quiet btn-sm'; b.textContent = 'Log out';
    b.addEventListener('click', function () {
      exclusive('logout', b, function () {
        return call('logout', {}, token).then(function () { return null; }, function () { return null; }).then(function () {
          clearSession(); root.location.href = 'login.html';
        });
      });
    });
    p.appendChild(b); box.appendChild(p); main.insertBefore(box, main.firstChild);
  }
  function wireSessionResume(page) {
    if (resumeHooksAttached || !root.document || !root.addEventListener) { return; }
    resumeHooksAttached = true;
    function maybeRefresh() {
      if (root.document.visibilityState && root.document.visibilityState !== 'visible') { return; }
      if (Date.now() - lastSessionCheckAt < 60000) { return; }
      verifyProtectedPage(page);
    }
    root.addEventListener('pageshow', maybeRefresh);
    root.document.addEventListener('visibilitychange', maybeRefresh);
  }
  function refreshSession() {
    var s = readSession();
    if (!s) { return Promise.reject(failure('server', 'unauthenticated')); }
    return call('session_get', {}, s.token).then(function (r) {
      var d = r.data || {}, u = d.user;
      if (!u || typeof u.username !== 'string' || typeof d.expires_at !== 'string' || typeof d.idle_expires_at !== 'string') { throw failure('bad_response'); }
      lastSessionCheckAt = Date.now();
      return { data: d, session: s };
    }).catch(function (e) {
      if (e && e.code === 'unauthenticated') { clearSession(); }
      throw e;
    });
  }
  function verifyProtectedPage(page) {
    page = safeReturnTarget(page) || currentPage();
    var body = pageBody();
    if (body) { body.setAttribute('data-auth-state', 'checking'); }
    if (!configured()) { redirectLogin(page); return Promise.resolve(false); }
    var s = readSession();
    if (!s) { redirectLogin(page); return Promise.resolve(false); }
    if (sessionCheckInFlight) { return sessionCheckInFlight; }
    sessionCheckInFlight = refreshSession().then(function (r) {
      if (body) { body.setAttribute('data-auth-state', 'ready'); }
      attachSessionControls(r.data.user, r.session.token);
      wireSessionResume(page);
      sessionCheckInFlight = null;
      return true;
    }).catch(function (e) {
      sessionCheckInFlight = null;
      if (e && e.code === 'unauthenticated') { redirectLogin(page); return false; }
      /* Keep a token during an outage; hide protected content until a server response is verified. */
      setGateStatus(messageFor(e, 'The session check'), true);
      return false;
    });
    return sessionCheckInFlight;
  }
  function logout() {
    var s = readSession();
    if (!s || !configured()) { clearSession(); return Promise.resolve(true); }
    return call('logout', {}, s.token).then(function () { clearSession(); return true; }, function (e) { clearSession(); throw e; });
  }

  function init() {
    var path = currentPage();
    if (path === 'login.html') { describeAvailability('login'); }
    else if (path === 'register.html') { describeAvailability('register'); }
    else if (path === 'forgot-password.html') { describeAvailability('reset'); }
    else if (Object.prototype.hasOwnProperty.call(SAFE_RETURN_PAGES, path)) { verifyProtectedPage(path); }
    var email = $('reg-email');
    if (email) { email.addEventListener('input', function () { registerState.proof = ''; }); }   /* a proof belongs to one address */
  }

  var api = Object.freeze({ isConfigured: configured, call: call, readSession: readSession, clearSession: clearSession, refreshSession: refreshSession, logout: logout, deriveH1: deriveH1 });
  root.GateAuth = api;
  root.GateAuthUI = Object.freeze(ui);
  if (root.document) {
    if (root.document.readyState === 'loading') { root.document.addEventListener('DOMContentLoaded', init); } else { init(); }
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof window !== 'undefined' ? window : this);
