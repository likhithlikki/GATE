/**
 * GATE Prep Studio PRIVATE backend: ExamService (Task 32). Authenticated exam attempt lifecycle on EXAM_DB.
 *
 * Called only by the router (AuthRouter.gs) as protected SESSION operations: list_papers, start_attempt, get_attempt, save_answers, submit_attempt.
 * Identity ALWAYS comes from the validated session (asRequireSession_). Nothing in a payload names a user, a profile, marks, a deadline, a status or
 * a correctness flag; those fields are ignored if sent. A request about an attempt that is not the session user's answers exactly like an unknown
 * attempt (not_found), so identifiers cannot be enumerated.
 *
 * GATES AND UNRESOLVED POLICY (nothing here turns a gate on or settles a decision):
 *   - Authentication/session: the session gates in AuthCore.gs (session_standard / session_remember) must be on, else no session validates.
 *   - Question source (D-07): Script Property EXAM_POLICY_QUESTION_PUBLICATION = 'true' (default OFF). Until then questions are not served at all.
 *   - Paper identity: every attempt needs a paper registered by the owner (admin_register_paper). Nothing is inferred from questions.
 *   - Marking profile: the pinned profile is looked up in SC_PROFILES via scProfileFor_ (verified for exactly the paper's year; today only 2026).
 *   - Duration: round(total_marks x 10800 / 65) seconds. A selection that totals exactly 100 marks is refused (D-11 unresolved).
 *   - Mock composition and subsets (D-12): mode 'mock' is refused; a practice request for fewer questions than match is refused. Only "all matching
 *     questions of one registered paper" can start.
 * Blocked requests answer feature_disabled with a lowercase reason code that the browser can explain; they never start a partial attempt.
 *
 * STATE (attempts.status, as used by AttemptStore.gs): in_progress -> closed (close_reason 'submitted' | 'expired') -> scored (set by ScoringService).
 * DEADLINE: deadline_at = started_at + duration_seconds, written once at start and never changed. Every operation compares the SERVER clock with it.
 * At or after the deadline an attempt is closed as expired (by whichever operation touches it first); no answer is accepted at or after it.
 * The browser clock and timer are display only.
 *
 * WRITES: all state changes run inside one script lock (acWithLock_). Session validation happens BEFORE the lock (it takes the lock itself to touch
 * the session). Order: pinned rows first, the attempts row LAST at start (commit marker); answer rows first, then last_seq/answers_hash. Every write
 * is read back. answers_hash is always recomputed from the STORED rows with atAnswersHash_ (the exact format AttemptStore.gs verifies), so a write
 * that was interrupted between rows and header is repaired by the next save or by the closing step.
 *
 * Audit rows (AUTH_DB.audit_logs via acAudit_) carry ids and codes only. Responses, keys, tokens and secrets are never logged.
 */

var EX_MAX_UPDATES = 20;
var EX_MAX_SAVE_CHARS = 6000;
var EX_STARTS_PER_HOUR = 10;          /* spec 11: at most 10 starts per hour (owner-stated policy, PROPOSED) */
var EX_REQUEST_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
var EX_FILTER_KEYS = { subject: 1, topic: 1, type: 1 };
var EX_IGNORED_FIELDS = { correct: 1, awarded_marks: 1, score: 1, marks: 1, deadline: 1, deadline_at: 1, user_id: 1, owner: 1, status: 1, profile: 1, profile_set: 1, saved_at: 1, seq: 1, started_at: 1 };

function exGate_(name) {
  var v = PropertiesService.getScriptProperties().getProperty('EXAM_POLICY_' + name.toUpperCase());
  return v !== null && v !== undefined && String(v).trim().toLowerCase() === 'true';
}
function exRequireOpen_() { if (!exGate_('question_publication')) { throw acErr_('feature_disabled', 'question_publication_unapproved'); } }
function exIso_(ms) { return new Date(ms).toISOString(); }
function exPlain_(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
function exAttemptId_(p) { var s = typeof p.attempt_id === 'string' && AT_ID_RE.test(p.attempt_id) ? p.attempt_id : null; if (!s) { throw acErr_('payload_invalid'); } return s; }
/* Only these keys may appear; fields in EX_IGNORED_FIELDS are silently dropped, anything else is malformed. */
function exCheckKeys_(obj, allowed) {
  Object.keys(obj).forEach(function (k) { if (!allowed[k] && !EX_IGNORED_FIELDS[k]) { throw acErr_('payload_invalid'); } });
}

/* ---------------------------------------------------------------------------------------------------
 * Duration and profile (pure)
 * ------------------------------------------------------------------------------------------------- */
function exDurationPlan_(totalMarks) {
  if (!Number.isSafeInteger(totalMarks) || totalMarks < 1) { return { ok: false, reason: 'duration_marks_invalid' }; }
  if (totalMarks === 100) { return { ok: false, reason: 'duration_policy_unresolved_d11' }; }
  return { ok: true, seconds: Math.floor((2 * totalMarks * 10800 + 65) / 130) };   /* round(marks x 10800 / 65); 65 is odd so no tie exists */
}
function exProfileFor_(year) {
  var keys = Object.keys(SC_PROFILES);
  for (var i = 0; i < keys.length; i++) {
    var p = SC_PROFILES[keys[i]];
    if (scProfileFor_(p.profile_id, p.profile_version, year)) { return { ref: scProfileRefText_(p), label: p.profile_id + '@' + p.profile_version }; }
  }
  return null;
}
function exProfileLabels_(profileSet) { return String(profileSet || '').split(',').filter(Boolean).map(function (r) { var m = SS_PROFILE_REF_RE.exec(r); return m ? m[1] + '@' + m[2] : ''; }); }

/* ---------------------------------------------------------------------------------------------------
 * Context and low-level row access
 * ------------------------------------------------------------------------------------------------- */
function exCtx_() {
  var ss = atOpenExam_();
  return { ss: ss, A: atSheet_(ss, 'attempts'), Q: atSheet_(ss, 'attempt_questions'), N: atSheet_(ss, 'answers') };
}

/* Overwrites some cells of one row (text format), flushes and verifies each. */
function exPatch_(sh, cols, rowNo, patch) {
  Object.keys(patch).forEach(function (c) {
    var idx = cols.indexOf(c);
    if (idx < 0) { throw acErr_('write_failed'); }
    var cell = sh.getRange(rowNo, idx + 1);
    cell.setNumberFormat('@'); cell.setValue(patch[c] === null || patch[c] === undefined ? '' : String(patch[c]));
  });
  SpreadsheetApp.flush();
  Object.keys(patch).forEach(function (c) {
    var want = patch[c] === null || patch[c] === undefined ? '' : String(patch[c]);
    if (ksCellString_(sh.getRange(rowNo, cols.indexOf(c) + 1).getValue()) !== want) { throw acErr_('write_failed'); }
  });
}
function exWriteRow_(sh, cols, rowNo, obj) {
  var cells = qiCells_(cols, obj), rng = sh.getRange(rowNo, 1, 1, cols.length);
  rng.setNumberFormat('@'); rng.setValues([cells]); SpreadsheetApp.flush();
  if (!qiSameCells_(sh.getRange(rowNo, 1, 1, cols.length).getValues()[0], cells)) { throw acErr_('write_failed'); }
}
function exAppend_(sh, cols, objs) { try { return qiAppendRows_(sh, cols.length, objs.map(function (o) { return qiCells_(cols, o); })); } catch (e) { if (e && e.ksCode) { throw acErr_('write_failed'); } throw e; } }

/* ---------------------------------------------------------------------------------------------------
 * Attempt rows
 * ------------------------------------------------------------------------------------------------- */
function exParseAttempt_(r) {
  var o = r.o, started = atTime_(o.started_at), deadline = atTime_(o.deadline_at), duration = atInt_(o.duration_seconds, 1), count = atInt_(o.question_count, 1);
  var total = atInt_(o.total_marks, 1), lastSeq = atInt_(o.last_seq, 0);
  if (!AT_ID_RE.test(o.attempt_id) || !AT_ID_RE.test(o.user_id) || started === null || deadline === null || duration === null || count === null || total === null ||
      lastSeq === null || deadline - started !== duration * 1000) { throw acErr_('attempt_corrupt'); }
  return { rowNo: r.rowNo, o: o, attempt_id: o.attempt_id, user_id: o.user_id, mode: o.mode, status: o.status, close_reason: o.close_reason, started: started, deadline: deadline,
    duration: duration, count: count, total: total, lastSeq: lastSeq, paper_id: o.paper_id, answers_hash: o.answers_hash, profile_set: o.profile_set,
    key_set_id: o.key_set_id || '', key_set_digest: o.key_set_digest || '' };
}
function exFindAttempt_(C, attemptId) {
  var rows = exRowsWhere_(C.A.sh, C.A.cols, 'attempt_id', attemptId);
  if (rows.length > 1) { throw acErr_('attempt_corrupt'); }
  return rows.length ? exParseAttempt_(rows[0]) : null;
}
/* The session user's attempt or not_found (identical for "missing" and "someone else's"). */
function exOwned_(C, attemptId, userId) {
  var att = exFindAttempt_(C, attemptId);
  if (!att || att.user_id !== userId) { Logger.log('Exam: attempt request refused (not found or not owner).'); throw acErr_('not_found'); }
  return att;
}

/* Pinned questions joined with their stored version row. Returns [{position, question_id, version, marks, type, optionIds, row}] in position order. */
function exPinnedInfo_(C, att) {
  var rows = exRowsWhere_(C.Q.sh, C.Q.cols, 'attempt_id', att.attempt_id), pinned = [], seenPos = Object.create(null), seenId = Object.create(null), sum = 0;
  if (rows.length !== att.count) { throw acErr_('attempt_corrupt'); }
  rows.forEach(function (r) {
    var pos = atInt_(r.o.position, 1), ver = atInt_(r.o.question_version, 1), marks = atInt_(r.o.marks, 1);
    if (pos === null || pos > att.count || ver === null || marks === null || !AT_ID_RE.test(r.o.question_id) || seenPos[pos] || seenId[r.o.question_id]) { throw acErr_('attempt_corrupt'); }
    seenPos[pos] = true; seenId[r.o.question_id] = true; sum += marks;
    pinned.push({ position: pos, question_id: r.o.question_id, version: ver, marks: marks });
  });
  if (sum !== att.total) { throw acErr_('attempt_corrupt'); }
  pinned.sort(function (a, b) { return a.position - b.position; });
  var repo = qiReadRepo_(C.ss);
  pinned.forEach(function (x) {
    var row = (repo.byId[x.question_id] || []).filter(function (r) { return r.version === x.version; })[0];
    if (!row || row.o.marks !== String(x.marks) || QI_TYPES.indexOf(row.o.type) < 0) { throw acErr_('attempt_corrupt'); }
    x.row = row; x.type = row.o.type; x.optionIds = null;
    if (x.type !== 'NAT') { x.optionIds = ksParseOptionIds_(row.o.options_json); if (!x.optionIds) { throw acErr_('attempt_corrupt'); } }
  });
  return pinned;
}

/* Saved answer rows, validated against the pinned questions. Returns { byQ:{qid:{rowNo,value,json,review,seq}}, entries, maxSeq }. Corrupt state throws. */
function exStored_(C, att, info) {
  var rows = exRowsWhere_(C.N.sh, C.N.cols, 'attempt_id', att.attempt_id), pin = Object.create(null), byQ = Object.create(null), entries = [], maxSeq = 0;
  info.forEach(function (x) { pin[x.question_id] = x; });
  rows.forEach(function (r) {
    var x = pin[r.o.question_id];
    if (!x || byQ[r.o.question_id] || r.o.response_json === '') { throw acErr_('answers_corrupt'); }
    var parsed = atParseResponse_(x.type, r.o.response_json, x.optionIds), seq = atInt_(r.o.seq, 1);
    if (!parsed.ok || seq === null || (r.o.review_flag !== 'true' && r.o.review_flag !== 'false' && r.o.review_flag !== '')) { throw acErr_('answers_corrupt'); }
    if (seq > maxSeq) { maxSeq = seq; }
    byQ[r.o.question_id] = { rowNo: r.rowNo, value: parsed.value, json: JSON.stringify(parsed.value), review: r.o.review_flag === 'true', seq: seq };
    entries.push({ position: x.position, question_id: x.question_id, value: parsed.value });
  });
  return { byQ: byQ, entries: entries, maxSeq: maxSeq };
}

/* ---------------------------------------------------------------------------------------------------
 * Closing (lock held by the caller)
 * ------------------------------------------------------------------------------------------------- */
function exCloseLocked_(C, att, userId, now) {
  if (att.status !== 'in_progress') { return att; }
  var info = exPinnedInfo_(C, att), st = exStored_(C, att, info), expired = now >= att.deadline;
  var hash = atAnswersHash_(st.entries), seq = Math.max(att.lastSeq, st.maxSeq);
  var patch = { status: 'closed', close_reason: expired ? 'expired' : 'submitted', closed_at: exIso_(expired ? att.deadline : now), submitted_at: expired ? '' : exIso_(now),
    answers_hash: hash, last_seq: String(seq) };
  exPatch_(C.A.sh, C.A.cols, att.rowNo, patch);
  var back = exFindAttempt_(C, att.attempt_id);
  if (!back || back.status !== 'closed' || back.answers_hash !== hash || back.lastSeq !== seq || back.close_reason !== patch.close_reason) { throw acErr_('close_verification_failed'); }
  acAudit_(expired ? 'attempt_expired' : 'attempt_submitted', userId, att.attempt_id, 'ok', 'answers=' + st.entries.length);
  return back;
}

/* If the attempt is in progress and past its deadline, closes it as expired (takes the lock only when needed). Returns the current attempt. */
function exExpireIfDue_(C, att, userId) {
  if (att.status !== 'in_progress' || acNow_() < att.deadline) { return att; }
  return acWithLock_(function () {
    var fresh = exOwned_(C, att.attempt_id, userId);
    return fresh.status === 'in_progress' && acNow_() >= fresh.deadline ? exCloseLocked_(C, fresh, userId, acNow_()) : fresh;
  });
}

/* ---------------------------------------------------------------------------------------------------
 * Views (public question content only: the private repository holds no keys, and none is ever read here)
 * ------------------------------------------------------------------------------------------------- */
function exAttemptMeta_(att, now) {
  var filters = {};
  try { filters = JSON.parse(att.o.filters_json || '{}'); } catch (e) { filters = {}; }
  var m = { attempt_id: att.attempt_id, mode: att.mode, paper_id: att.paper_id, filters: exPlain_(filters) ? filters : {}, question_count: att.count, total_marks: att.total,
    duration_seconds: att.duration, started_at: exIso_(att.started), deadline_at: exIso_(att.deadline), status: att.status, close_reason: att.close_reason || null,
    submitted_at: att.o.submitted_at || null, closed_at: att.o.closed_at || null, last_seq: att.lastSeq, profile: exProfileLabels_(att.profile_set), server_time: exIso_(now) };
  m.remaining_ms = att.status === 'in_progress' ? Math.max(0, att.deadline - now) : 0;
  return m;
}
function exAttemptView_(C, att, now) {
  var info = exPinnedInfo_(C, att), st = exStored_(C, att, info), responses = {};
  Object.keys(st.byQ).forEach(function (q) { responses[q] = { response: st.byQ[q].value, review_flag: st.byQ[q].review, seq: st.byQ[q].seq }; });
  var meta = exAttemptMeta_(att, now);
  meta.last_seq = Math.max(att.lastSeq, st.maxSeq);
  return { attempt: meta, questions: info.map(function (x) { var v = qiPublicView_(x.row, x.position); v.marks = x.marks; return v; }), responses: responses };
}

/* ---------------------------------------------------------------------------------------------------
 * list_papers: registered papers the user could start, with facets for filtered practice (no question text).
 * ------------------------------------------------------------------------------------------------- */
function opListPapers_(p, token) {
  acDb_();
  asRequireSession_(token);
  exRequireOpen_();
  var ss = atOpenExam_(), repo = qiReadRepo_(ss), papers = [];
  exAllPaperIds_(ss).forEach(function (pid) {
    var loaded = exLoadPaper_(ss, pid);
    if (!loaded) { return; }
    var entry = { paper_id: pid, year: loaded.paper.year, paper_code: loaded.paper.paper_code, session: loaded.paper.session, title: loaded.paper.title, question_count: loaded.members.length,
      total_marks: 0, facets: [], available: true, reason: '', profile: null, paper_mode: { available: false, reason: '' }, practice_mode: { available: false, reason: '' }, duration_seconds: null };
    var facets = Object.create(null), missing = false;
    loaded.members.forEach(function (id) {
      var act = qiActiveRow_(repo.byId[id]);
      if (!act || parseInt(act.o.year, 10) !== loaded.paper.year) { missing = true; return; }
      var marks = Number(act.o.marks), key = act.o.subject + '\u0001' + act.o.topic + '\u0001' + act.o.type;
      entry.total_marks += marks;
      var f = facets[key] = facets[key] || { subject: act.o.subject, topic: act.o.topic, type: act.o.type, count: 0, marks: 0 };
      f.count++; f.marks += marks;
    });
    entry.facets = Object.keys(facets).map(function (k) { return facets[k]; });
    var prof = exProfileFor_(loaded.paper.year);
    entry.profile = prof ? prof.label : null;
    if (missing) { entry.available = false; entry.reason = 'paper_questions_unavailable'; }
    else if (!prof) { entry.available = false; entry.reason = 'profile_unverified'; }
    if (entry.available) {
      var plan = exDurationPlan_(entry.total_marks);
      entry.paper_mode = plan.ok ? { available: true, reason: '' } : { available: false, reason: plan.reason };
      entry.practice_mode = { available: true, reason: '' };
      entry.duration_seconds = plan.ok ? plan.seconds : null;
    } else { entry.paper_mode.reason = entry.reason; entry.practice_mode.reason = entry.reason; }
    papers.push(entry);
  });
  return { code: 'ok', data: { papers: papers, modes: [
    { mode: 'paper', note: 'Every question of one registered paper.' },
    { mode: 'practice', note: 'All questions of one registered paper that match your filters. Smaller random or fixed subsets are not available (D-12 undecided).' },
    { mode: 'mock', available: false, reason: 'mock_composition_unresolved_d12' }] } };
}

/* Server-only owner approval gates. These checks are independent of public-site flags. No request payload can open them. */
function exRequireScoringOperations_() {
  var b = ssFirstOperationalBlock_();
  if (b) { throw acErr_('feature_disabled', b.reason); }
}

/* Called only while the single script lock is held. It deliberately uses the locked loader, not the wrapper that takes the same lock. */
function exLoadKeySetForStartLocked_(paperId) {
  try {
    ksMacSecret_();
    var r = ksLoadApprovedKeySetLocked_(paperId);
    if (!r || r.ok !== true || !r.key_set || !Array.isArray(r.keys)) { throw new Error('blocked'); }
    return r;
  } catch (e) {
    /* Do not expose DB ids, key-store row details, key values or digest contents through the candidate API. */
    throw acErr_('feature_disabled', 'answer_keys_unavailable');
  }
}

function exValidateStartKeyCoverage_(paper, profile, eligible, loadedKeys) {
  var m = loadedKeys.key_set, pm = /^([^@]+)@(\d+)@([0-9a-f]{64})$/.exec(profile.ref || '');
  if (!pm || m.paper_id !== paper.paper_id || String(m.year) !== String(paper.year) ||
      m.profile_id !== pm[1] || String(m.profile_version) !== pm[2] || typeof m.key_set_id !== 'string' || !/^ks-[0-9a-f]{40}$/.test(m.key_set_id) ||
      typeof m.key_set_digest !== 'string' || !KS_HEX64_RE.test(m.key_set_digest)) {
    throw acErr_('feature_disabled', 'answer_key_profile_mismatch');
  }
  var byVersion = Object.create(null);
  loadedKeys.keys.forEach(function (k) { byVersion[k.question_id + '|' + k.question_version] = k; });
  for (var i = 0; i < eligible.length; i++) {
    var q = eligible[i], k = byVersion[q.o.question_id + '|' + String(q.version)];
    if (!k || k.content_hash !== q.o.content_hash || k.type !== q.o.type || String(k.marks) !== String(q.o.marks) || String(k.year) !== String(paper.year)) {
      throw acErr_('feature_disabled', 'answer_key_coverage_missing');
    }
  }
  return { key_set_id: m.key_set_id, key_set_digest: m.key_set_digest };
}

/* Do not start an attempt that cannot be scored under the currently approved policy set. `unanswered_zero` is required
 * for every attempt because a user may leave any response blank. NAT and Marks-To-All decisions are required only when
 * the selected immutable key set actually contains those cases. Mixed-year policy is not required: this service refuses
 * mixed-year attempts structurally. This helper reports only a safe gate reason, never key values. */
function exFirstMissingStartScoringPolicy_(eligible, loadedKeys) {
  var policy = scPolicyFromProperties_(), keys = Object.create(null);
  (loadedKeys && Array.isArray(loadedKeys.keys) ? loadedKeys.keys : []).forEach(function (k) {
    keys[k.question_id + '|' + String(k.question_version)] = k;
  });
  if (!policy.unanswered_zero) { return 'unanswered_zero_not_approved'; }
  for (var i = 0; i < eligible.length; i++) {
    var q = eligible[i], k = keys[q.o.question_id + '|' + String(q.version)];
    if (!k) { return 'answer_key_coverage_missing'; }
    if (k.key_kind === 'marks_to_all' && !policy.marks_to_all) { return 'marks_to_all_not_approved'; }
    if (q.o.type === 'NAT') {
      if (!policy.nat_syntax) { return 'nat_syntax_not_approved'; }
      if (!policy.nat_boundaries) { return 'nat_boundaries_not_approved'; }
      if (!policy.nat_rounding) { return 'nat_rounding_not_approved'; }
    }
  }
  return '';
}

/* ---------------------------------------------------------------------------------------------------
 * start_attempt
 * payload: { mode:'paper'|'practice', paper_id, filters?:{subject?,topic?,type?}, count?, request_key }
 * ------------------------------------------------------------------------------------------------- */
function opStartAttempt_(p, token) {
  acDb_();
  var s = asRequireSession_(token), uid = s.user.user_id;
  exRequireOpen_();
  exCheckKeys_(p, { mode: 1, paper_id: 1, filters: 1, count: 1, request_key: 1 });
  if (typeof p.mode !== 'string') { throw acErr_('payload_invalid'); }
  if (p.mode === 'mock') { throw acErr_('feature_disabled', 'mock_composition_unresolved_d12'); }
  if (p.mode !== 'paper' && p.mode !== 'practice') { throw acErr_('payload_invalid'); }
  if (typeof p.request_key !== 'string' || !EX_REQUEST_KEY_RE.test(p.request_key)) { throw acErr_('payload_invalid'); }
  if (typeof p.paper_id !== 'string' || !AT_PAPER_RE.test(p.paper_id) || p.paper_id.length > 64) { throw acErr_('feature_disabled', 'paper_identity_missing'); }
  /* The server itself refuses online attempts until Task 56's global owner gates are explicitly approved. */
  exRequireScoringOperations_();
  var filters = {};
  if (p.filters !== undefined) {
    if (!exPlain_(p.filters)) { throw acErr_('payload_invalid'); }
    Object.keys(p.filters).forEach(function (k) {
      var v = p.filters[k];
      if (!EX_FILTER_KEYS[k] || typeof v !== 'string' || !v.length || v.length > QI_LIMITS.field || ksHasControl_(v) || (k === 'type' && QI_TYPES.indexOf(v) < 0)) { throw acErr_('payload_invalid'); }
      filters[k] = v;
    });
  }
  if (p.mode === 'paper' && (Object.keys(filters).length || p.count !== undefined)) { throw acErr_('payload_invalid'); }
  var wantCount = null;
  if (p.count !== undefined) { if (typeof p.count !== 'number' || !Number.isSafeInteger(p.count) || p.count < 1 || p.count > AT_MAX_QUESTIONS) { throw acErr_('payload_invalid'); } wantCount = p.count; }

  var C = exCtx_();
  return acWithLock_(function () {
    /* Re-check the owner gates inside the critical section as well as before taking the lock. */
    exRequireScoringOperations_();
    /* Re-read the approved key set under the same lock used by owner approval. It is never returned to the browser. */
    var startKeySet = exLoadKeySetForStartLocked_(p.paper_id);
    var now = acNow_(), attemptId = 'att-' + ksSha256Hex_('GPS-ATTEMPT-V1\n' + uid + '\n' + p.request_key).slice(0, 40);
    var filtersJson = JSON.stringify(filters, Object.keys(filters).sort());

    /* Retry of the same start: return the same attempt only if its original key-set pin still matches. */
    var again = exFindAttempt_(C, attemptId);
    if (again) {
      if (again.user_id !== uid || again.mode !== p.mode || again.paper_id !== p.paper_id || again.o.filters_json !== filtersJson) { throw acErr_('conflict', 'request_key_reused'); }
      if (again.key_set_id !== startKeySet.key_set.key_set_id || again.key_set_digest !== startKeySet.key_set.key_set_digest) { throw acErr_('feature_disabled', 'key_set_revision_mismatch'); }
      again = exCloseDue_(C, again, uid, now);
      return { code: 'ok', data: { started: false, resumed: true, view: exAttemptView_(C, again, acNow_()) } };
    }

    /* Paper, profile, questions. */
    var loaded = exLoadPaper_(C.ss, p.paper_id);
    if (!loaded) { throw acErr_('feature_disabled', 'paper_not_registered'); }
    var prof = exProfileFor_(loaded.paper.year);
    if (!prof) { throw acErr_('feature_disabled', 'profile_unverified'); }
    var repo = qiReadRepo_(C.ss), eligible = [];
    loaded.members.forEach(function (id) {
      var act = qiActiveRow_(repo.byId[id]);
      if (!act || parseInt(act.o.year, 10) !== loaded.paper.year) { throw acErr_('feature_disabled', 'paper_questions_unavailable'); }
      if ((filters.subject !== undefined && act.o.subject !== filters.subject) || (filters.topic !== undefined && act.o.topic !== filters.topic) ||
          (filters.type !== undefined && act.o.type !== filters.type)) { return; }
      eligible.push(act);
    });
    if (!eligible.length) { throw acErr_('payload_invalid', 'selection_empty'); }
    if (wantCount !== null) {
      if (wantCount > eligible.length) { throw acErr_('payload_invalid'); }
      if (wantCount < eligible.length) { throw acErr_('feature_disabled', 'subset_policy_unresolved_d12'); }
    }
    if (eligible.length > AT_MAX_QUESTIONS) { throw acErr_('feature_disabled', 'selection_too_large'); }
    var pinnedKeySet = exValidateStartKeyCoverage_(loaded.paper, prof, eligible, startKeySet);
    var policyBlock = exFirstMissingStartScoringPolicy_(eligible, startKeySet);
    if (policyBlock) { throw acErr_('feature_disabled', policyBlock); }
    var total = 0;
    eligible.forEach(function (r) { total += Number(r.o.marks); });
    var plan = exDurationPlan_(total);
    if (!plan.ok) { throw acErr_('feature_disabled', plan.reason); }

    /* One active attempt per mode; expired ones are closed first. Starts are limited per hour. */
    var mine = exRowsWhere_(C.A.sh, C.A.cols, 'user_id', uid).map(exParseAttempt_), recent = 0, active = null;
    mine.forEach(function (a) {
      if (now - a.started < 3600000) { recent++; }
      if (a.mode === p.mode && a.status === 'in_progress') {
        var cur = exCloseDue_(C, a, uid, now);
        if (cur.status === 'in_progress') { active = cur; }
      }
    });
    if (active) { return { code: 'ok', data: { started: false, resumed: false, active_attempt_id: active.attempt_id } }; }
    if (recent >= EX_STARTS_PER_HOUR) { throw acErr_('try_later'); }

    /* Pin: questions first (orphans from an interrupted start are verified and reused), the attempts row last. */
    var expected = eligible.map(function (r, i) { return { attempt_id: attemptId, position: String(i + 1), question_id: r.o.question_id, question_version: String(r.version), marks: r.o.marks }; });
    var have = exRowsWhere_(C.Q.sh, C.Q.cols, 'attempt_id', attemptId), haveByPos = Object.create(null);
    have.forEach(function (r) {
      var pos = atInt_(r.o.position, 1), want = pos === null ? null : expected[pos - 1];
      if (!want || haveByPos[pos] || r.o.question_id !== want.question_id || r.o.question_version !== want.question_version || r.o.marks !== want.marks) { throw acErr_('attempt_corrupt'); }
      haveByPos[pos] = true;
    });
    var toWrite = expected.filter(function (e) { return !haveByPos[Number(e.position)]; });
    if (toWrite.length) { exAppend_(C.Q.sh, C.Q.cols, toWrite); }
    var emptyHash = atAnswersHash_([]), deadline = now + plan.seconds * 1000;
    exAppend_(C.A.sh, C.A.cols, [{ attempt_id: attemptId, user_id: uid, mode: p.mode, filters_json: filtersJson, question_count: String(eligible.length), total_marks: String(total),
      duration_seconds: String(plan.seconds), started_at: exIso_(now), deadline_at: exIso_(deadline), status: 'in_progress', submitted_at: '', score: '', rules_version: '',
      request_id: p.request_key, last_seq: '0', answers_hash: emptyHash, closed_at: '', close_reason: '', profile_set: prof.ref, paper_id: p.paper_id,
      key_set_id: pinnedKeySet.key_set_id, key_set_digest: pinnedKeySet.key_set_digest }]);
    var made = exFindAttempt_(C, attemptId);
    if (!made || made.user_id !== uid || made.count !== eligible.length || made.total !== total || made.deadline !== deadline ||
        made.key_set_id !== pinnedKeySet.key_set_id || made.key_set_digest !== pinnedKeySet.key_set_digest) { throw acErr_('start_verification_failed'); }
    if (exPinnedInfo_(C, made).length !== eligible.length) { throw acErr_('start_verification_failed'); }
    acAudit_('attempt_started', uid, attemptId, 'ok', 'paper=' + p.paper_id + ';mode=' + p.mode + ';questions=' + eligible.length);
    return { code: 'ok', data: { started: true, resumed: false, view: exAttemptView_(C, made, acNow_()) } };
  });
}

/* Lock held. Closes an in-progress attempt that is past its deadline; otherwise returns it unchanged. */
function exCloseDue_(C, att, userId, now) { return att.status === 'in_progress' && now >= att.deadline ? exCloseLocked_(C, att, userId, now) : att; }

/* ---------------------------------------------------------------------------------------------------
 * get_attempt: ownership-checked; resumes with the ORIGINAL deadline; closes the attempt if it has expired.
 * ------------------------------------------------------------------------------------------------- */
function opGetAttempt_(p, token) {
  acDb_();
  var s = asRequireSession_(token), uid = s.user.user_id;
  exRequireOpen_();
  exCheckKeys_(p, { attempt_id: 1 });
  var id = exAttemptId_(p), C = exCtx_(), att = exExpireIfDue_(C, exOwned_(C, id, uid), uid);
  return { code: 'ok', data: exAttemptView_(C, att, acNow_()) };
}

/* ---------------------------------------------------------------------------------------------------
 * save_answers: { attempt_id, expected_seq, updates:[{question_id, response?, review_flag?}] }
 * Responses are validated against the PINNED type and options. A save with no real change writes nothing and does not advance the sequence.
 * ------------------------------------------------------------------------------------------------- */
function opSaveAnswers_(p, token) {
  acDb_();
  var s = asRequireSession_(token), uid = s.user.user_id;
  exRequireOpen_();
  exCheckKeys_(p, { attempt_id: 1, expected_seq: 1, updates: 1 });
  var id = exAttemptId_(p);
  if (typeof p.expected_seq !== 'number' || !Number.isSafeInteger(p.expected_seq) || p.expected_seq < 0) { throw acErr_('payload_invalid'); }
  if (!Array.isArray(p.updates) || !p.updates.length || p.updates.length > EX_MAX_UPDATES || JSON.stringify(p.updates).length > EX_MAX_SAVE_CHARS) { throw acErr_('payload_invalid'); }
  var seenQ = Object.create(null), updates = p.updates.map(function (u) {
    if (!exPlain_(u)) { throw acErr_('payload_invalid'); }
    exCheckKeys_(u, { question_id: 1, response: 1, review_flag: 1 });
    if (typeof u.question_id !== 'string' || !AT_ID_RE.test(u.question_id) || seenQ[u.question_id]) { throw acErr_('payload_invalid'); }
    seenQ[u.question_id] = true;
    var hasResp = Object.prototype.hasOwnProperty.call(u, 'response'), hasFlag = Object.prototype.hasOwnProperty.call(u, 'review_flag');
    if (!hasResp && !hasFlag) { throw acErr_('payload_invalid'); }
    if (hasFlag && typeof u.review_flag !== 'boolean') { throw acErr_('payload_invalid'); }
    return { question_id: u.question_id, hasResp: hasResp, response: u.response, hasFlag: hasFlag, review_flag: u.review_flag };
  });

  var C = exCtx_();
  return acWithLock_(function () {
    var now = acNow_(), att = exOwned_(C, id, uid);
    if (att.status !== 'in_progress') { throw acErr_('attempt_closed'); }
    if (now >= att.deadline) { exCloseLocked_(C, att, uid, now); throw acErr_('attempt_expired'); }
    var info = exPinnedInfo_(C, att), pin = Object.create(null);
    info.forEach(function (x) { pin[x.question_id] = x; });
    var st = exStored_(C, att, info), hash = atAnswersHash_(st.entries), seq = Math.max(att.lastSeq, st.maxSeq);
    if (st.maxSeq > att.lastSeq || hash !== att.answers_hash) {   /* an earlier save was interrupted between its rows and its header: finish it from the stored rows */
      exPatch_(C.A.sh, C.A.cols, att.rowNo, { last_seq: String(seq), answers_hash: hash });
      att = exOwned_(C, id, uid);
    }

    /* Validate every update against the pinned question, then work out what would really change. */
    var plan = updates.map(function (u) {
      var x = pin[u.question_id];
      if (!x) { throw acErr_('payload_invalid'); }
      var cur = st.byQ[u.question_id], curJson = cur ? cur.json : (x.type === 'MSQ' ? '[]' : '""'), curFlag = cur ? cur.review : false, newJson = curJson, value = cur ? cur.value : (x.type === 'MSQ' ? [] : '');
      if (u.hasResp) {
        var text; try { text = JSON.stringify(u.response); } catch (e) { throw acErr_('payload_invalid'); }
        if (text === undefined) { throw acErr_('payload_invalid'); }
        var parsed = atParseResponse_(x.type, text, x.optionIds);
        if (!parsed.ok) { throw acErr_('payload_invalid'); }
        value = parsed.value; newJson = JSON.stringify(parsed.value);
      }
      var newFlag = u.hasFlag ? u.review_flag : curFlag;
      return { x: x, cur: cur, value: value, json: newJson, flag: newFlag, changed: newJson !== curJson || newFlag !== curFlag };
    });
    var changed = plan.filter(function (c) { return c.changed; });
    if (p.expected_seq !== seq) {
      if (!changed.length) { return { code: 'ok', data: exSaveReply_(att, seq, [], plan, now, true) }; }   /* a replay of an already applied save */
      throw acErr_('conflict', 'sequence_mismatch');
    }
    if (!changed.length) { return { code: 'ok', data: exSaveReply_(att, seq, [], plan, now, false) }; }

    /* Rows first, then the header. */
    var newSeq = seq + 1, stamp = exIso_(now), fresh = [];
    changed.forEach(function (c) {
      var row = { attempt_id: id, question_id: c.x.question_id, response_json: c.json, review_flag: c.flag ? 'true' : 'false', seq: String(newSeq), saved_at: stamp, correct: '', awarded_marks: '' };
      if (c.cur) { exWriteRow_(C.N.sh, C.N.cols, c.cur.rowNo, row); } else { fresh.push(row); }
    });
    if (fresh.length) { exAppend_(C.N.sh, C.N.cols, fresh); }
    var after = exStored_(C, att, info);
    changed.forEach(function (c) {
      var got = after.byQ[c.x.question_id];
      if (!got || got.json !== c.json || got.review !== c.flag || got.seq !== newSeq) { throw acErr_('save_verification_failed'); }
    });
    var newHash = atAnswersHash_(after.entries);
    exPatch_(C.A.sh, C.A.cols, att.rowNo, { last_seq: String(newSeq), answers_hash: newHash });
    var done = exOwned_(C, id, uid);
    if (done.lastSeq !== newSeq || done.answers_hash !== newHash || done.status !== 'in_progress') { throw acErr_('save_verification_failed'); }
    return { code: 'ok', data: exSaveReply_(done, newSeq, changed, plan, now, false) };
  });
}
function exSaveReply_(att, seq, changed, plan, now, replay) {
  return { attempt_id: att.attempt_id, status: att.status, seq: seq, saved: changed.map(function (c) { return c.x.question_id; }),
    unchanged: plan.filter(function (c) { return !c.changed; }).map(function (c) { return c.x.question_id; }), replay: replay, deadline_at: exIso_(att.deadline), server_time: exIso_(now),
    remaining_ms: Math.max(0, att.deadline - now) };
}

/* ---------------------------------------------------------------------------------------------------
 * submit_attempt: idempotent. Returns the terminal state; never a score.
 * ------------------------------------------------------------------------------------------------- */
function opSubmitAttempt_(p, token) {
  acDb_();
  var s = asRequireSession_(token), uid = s.user.user_id;
  exCheckKeys_(p, { attempt_id: 1 });
  var id = exAttemptId_(p), C = exCtx_();
  return acWithLock_(function () {
    var att = exOwned_(C, id, uid), already = att.status !== 'in_progress';
    if (!already) { att = exCloseLocked_(C, att, uid, acNow_()); }
    /* Verify the terminal state with the same loader scoring uses. A policy block is not an integrity problem; an integrity code is. */
    var check = atLoadAttemptForScoring_(id), integrity = 'verified';
    if (!check.ok && SS_INTEGRITY_CODES[check.code]) { integrity = 'check_failed'; Logger.log('Exam: terminal state check reported ' + check.code + '.'); }
    return { code: 'ok', data: { attempt_id: id, status: att.status, close_reason: att.close_reason || null, submitted_at: att.o.submitted_at || null, closed_at: att.o.closed_at || null,
      already_closed: already, integrity: integrity, result_available: att.status === 'scored', score_released: false } };
  });
}

/* ---------------------------------------------------------------------------------------------------
 * Owner-run sweep: closes every in-progress attempt past its deadline. Safe to attach to a time-driven trigger. Writes ids and counts to the log only.
 * ------------------------------------------------------------------------------------------------- */
function admin_close_expired_attempts() {
  return ksRun_(function () {
    var C = exCtx_(), closed = 0, failed = 0;
    return ksWithLock_(function () {
      var now = acNow_();
      C.A.sh.getLastRow() > 1 && exRowsWhere_(C.A.sh, C.A.cols, 'status', 'in_progress').forEach(function (r) {
        try { var a = exParseAttempt_(r); if (now >= a.deadline) { exCloseLocked_(C, a, a.user_id, now); closed++; } } catch (e) { failed++; }
      });
      Logger.log('Expired attempts closed: ' + closed + '; failed: ' + failed + '.');
      return { ok: true, code: 'ok', closed: closed, failed: failed };
    });
  });
}
