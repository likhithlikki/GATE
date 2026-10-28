/* GATE Prep Studio: browser adapter for the AUTHENTICATED online examination operations (exam-api.js)
 *
 * It does not open a second connection. Every call goes through GateAuth.call (auth.js): HTTPS POST, JSON string body sent as text/plain,
 * credentials omitted, nothing in a URL, never JSONP. The session token comes from GateAuth.readSession() at the moment of each call, is passed
 * straight to the transport and is never copied into a URL, a DOM node, a log or this module's state.
 *
 * Identity is decided by the server from the session token. This module has no user id and sends none; nothing it sends names a user, a score,
 * marks, a deadline, a profile or a correctness flag. The server ignores or rejects such fields anyway.
 *
 * NOT CONNECTED until the owner sets AUTH_ENDPOINT_URL in auth.js to the deployed private web app: until then every call rejects with
 * kind 'not_configured' and sends nothing.
 *
 * Errors are Error objects with { kind, code, reason }:
 *   kind 'not_configured' | 'not_signed_in' | 'timeout' | 'connection' | 'bad_response' | 'server' | 'crypto_unavailable'
 *   for kind 'server', code is the service's public code (feature_disabled, conflict, attempt_expired, ...) and reason a lowercase gate/condition name.
 * describe(err) turns any of them into text a student can read.
 */
(function (root) {
  'use strict';

  var REASONS = {
    question_publication_unapproved: 'The site owner has not yet approved publishing questions for online use (decision D-07), so no online questions are served.',
    mock_composition_unresolved_d12: 'Full-length mock exams are not available: how a mock is composed has not been decided (D-12).',
    subset_policy_unresolved_d12: 'Taking only some of the matching questions is not available: how a subset is chosen has not been decided (D-12). Online practice uses all matching questions.',
    duration_policy_unresolved_d11: 'This selection totals exactly 100 marks. The duration for 100-mark papers has not been decided (D-11), so it cannot start.',
    duration_marks_invalid: 'The duration cannot be worked out because the total marks are not a positive whole number.',
    profile_unverified: 'The marking profile for this paper\u2019s year has not been verified, so an online test for it cannot start or be scored.',
    paper_not_registered: 'That paper is not registered in the private catalogue.',
    paper_identity_missing: 'A registered paper must be chosen. The server does not guess a paper.',
    paper_questions_unavailable: 'Some questions of this paper are not currently available in the private catalogue, so it cannot start.',
    selection_too_large: 'The selection is larger than an online test can hold.',
    selection_empty: 'No question matches this selection.',
    answer_review_unresolved_d18: 'Answer review is not available yet: the review policy (D-18) has not been approved.',
    answer_keys_unavailable: 'The approved answer key for this paper is not available, so it cannot be scored yet.',
    attempt_not_closed: 'This attempt is still in progress. Submit it first.',
    sequence_mismatch: 'Your answers changed somewhere else (another tab or an earlier save). Reload the attempt to continue.',
    request_key_reused: 'That start request was already used for a different test.',
    bookmark_limit: 'The bookmark limit has been reached.',
    active_attempt_exists: 'You already have an active attempt in this mode.'
  };

  function A() { return root.GateAuth || null; }
  function failure(kind, code, reason) { var e = new Error(kind); e.kind = kind; e.code = code || ''; e.reason = reason || ''; return e; }
  function configured() { return !!A() && A().isConfigured(); }
  function signedIn() { return !!A() && !!A().readSession(); }

  function call(op, payload) {
    var auth = A();
    if (!auth) { return Promise.reject(failure('not_configured')); }
    if (!auth.isConfigured()) { return Promise.reject(failure('not_configured')); }
    var s = auth.readSession();
    if (!s) { return Promise.reject(failure('not_signed_in')); }
    return auth.call(op, payload || {}, s.token).then(function (r) { return r; }, function (e) {
      if (e && e.kind === 'server' && e.code === 'unauthenticated') { auth.clearSession(); e.kind = 'not_signed_in'; }
      throw e;
    });
  }

  function requestKey() {
    var a = new Uint8Array(16);
    if (!root.crypto || !root.crypto.getRandomValues) { throw failure('crypto_unavailable'); }
    root.crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  /* Student-readable text. `what` is a short noun phrase such as "Starting the test". */
  function describe(e, what) {
    what = what || 'That action';
    var k = e && e.kind, c = e && e.code, r = e && e.reason;
    if (k === 'not_configured') { return 'The online examination service is not connected: no private backend address has been configured for this site. Nothing was sent.'; }
    if (k === 'not_signed_in') { return 'You are not signed in. Log in to use online examinations.'; }
    if (k === 'timeout') { return 'The service did not answer in time. ' + what + ' may or may not have been completed; nothing is assumed saved.'; }
    if (k === 'connection') { return 'Could not reach the service. Check your connection. ' + what + ' was not confirmed.'; }
    if (k === 'bad_response') { return 'The service sent a reply this page does not understand. Nothing was assumed.'; }
    if (k === 'crypto_unavailable') { return 'This browser cannot create a secure request identifier here.'; }
    if (c === 'feature_disabled') {
      if (REASONS[r]) { return REASONS[r]; }
      if (/_not_approved$/.test(r || '')) { return 'Scoring is blocked until the site owner approves the policy setting \u201c' + String(r).replace(/_not_approved$/, '').replace(/_/g, ' ') + '\u201d.'; }
      return 'This feature is not enabled yet' + (r ? ' (' + String(r).replace(/_/g, ' ') + ')' : '') + ': a required approval or setting is missing. Nothing was changed.';
    }
    if (c === 'conflict') { return REASONS[r] || 'This conflicts with the current state of the attempt. Reload it to see the latest.'; }
    if (c === 'attempt_expired') { return 'The deadline has passed. The attempt was closed by the server and no further changes are accepted.'; }
    if (c === 'attempt_closed') { return 'This attempt is already closed, so no further changes are accepted.'; }
    if (c === 'not_found') { return 'That item was not found for your account.'; }
    if (c === 'payload_invalid') { return REASONS[r] || 'The service rejected the request as invalid.'; }
    if (c === 'try_later' || c === 'busy' || c === 'temporarily_unavailable') { return 'The service is busy or limiting requests. Wait a little and try again.'; }
    if (c === 'not_initialized') { return 'The service is not set up yet.'; }
    return what + ' could not be completed.';
  }

  /* Failures after which the SAME request may safely be repeated (the server treats repeats idempotently). */
  function isRetryable(e) { return !!e && (e.kind === 'timeout' || e.kind === 'connection' || (e.kind === 'server' && (e.code === 'busy' || e.code === 'try_later'))); }

  function d(r) { return r && r.data ? r.data : {}; }
  var api = Object.freeze({
    isConfigured: configured, isSignedIn: signedIn, describe: describe, isRetryable: isRetryable, requestKey: requestKey,
    listPapers: function () { return call('list_papers', {}).then(d); },
    startAttempt: function (req) { return call('start_attempt', req).then(d); },
    getAttempt: function (id) { return call('get_attempt', { attempt_id: id }).then(d); },
    saveAnswers: function (id, expectedSeq, updates) { return call('save_answers', { attempt_id: id, expected_seq: expectedSeq, updates: updates }).then(d); },
    submitAttempt: function (id) { return call('submit_attempt', { attempt_id: id }).then(d); },
    scoreAttempt: function (id) { return call('score_attempt', { attempt_id: id }).then(d); },
    getResult: function (id) { return call('get_result', { attempt_id: id }).then(d); },
    getResultReview: function (id) { return call('get_result_review', { attempt_id: id }).then(d); },
    listAttempts: function () { return call('list_attempts', {}).then(d); },
    listBookmarks: function () { return call('list_bookmarks', {}).then(d); },
    addBookmark: function (qid) { return call('add_bookmark', { question_id: qid }).then(d); },
    removeBookmark: function (qid) { return call('remove_bookmark', { question_id: qid }).then(d); },
    getProfile: function () { return call('profile_get', {}).then(d); }
  });
  root.GateExamApi = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof window !== 'undefined' ? window : this);
