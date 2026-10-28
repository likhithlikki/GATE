/**
 * GATE Prep Studio PRIVATE backend: ScoringService (Task 30). Private score-and-commit pipeline for persisted, terminal attempts.
 *
 * Standalone private Apps Script project. No doGet/doPost, no endpoint. Every function name ends in an underscore, so none can be run
 * from the editor or reached from a browser. Trusted server code calls them, after it has authorised the request itself.
 *
 *   ssScoreAndCommitAttempt_(attempt_id)   load attempt -> load approved keys -> scScoreAttempt_ -> commit results/result_items
 *   ssGetCommittedResult_(attempt_id)      read and structurally verify a committed result (no scoring, no writes)
 *   ssVerifyCommittedResult_(attempt_id)   as above, then re-score with the current approved keys and compare (no writes)
 *
 * One script lock covers the whole state-changing run. ksLoadApprovedKeySet_ takes that lock itself and LockService locks are not
 * re-entrant, so this file calls ksLoadApprovedKeySetLocked_ after repeating the checks the public wrapper makes.
 *
 * Nothing the browser sends is read here: the user id, deadline, profile, responses and keys come from EXAM_DB / KEYS_DB and the
 * private profile table. Scoring policy comes only from Script Properties via scPolicyFromProperties_ (every gate off by default).
 * This file never turns a gate on, never edits a profile, and never changes a scoring rule.
 *
 * Commit order (spec 5.5 / 8.6): re-read the attempt, write missing result_items, read them back, write the results header LAST (it
 * is the commit marker), read it back, then set the attempt to 'scored'. Existing rows are never overwritten. A committed result is
 * returned as is; automatic rescoring and revision replacement are not implemented. A blocked score writes no result and shows no total.
 *
 * Returned values and audit rows carry ids, codes, counts and digests only: no answers, key values, NAT bounds or whole records.
 */

var SS_SCORE_REVISION = 1;
var SS_PAPER_RE = /^gate-(\d{4})-[a-z0-9]+(-[a-z0-9]+)*$/;
var SS_PROFILE_REF_RE = /^([A-Za-z0-9._-]+)@(\d+)@([0-9a-f]{64})$/;
var SS_FLAG_RE = /^[a-z_]{1,48}$/;
/* Loader/scorer codes that mean stored data disagree with itself or with its integrity checks. Audited as integrity_error. */
var SS_INTEGRITY_CODES = {
  answers_hash_mismatch: 1, answers_hash_invalid: 1, answers_hash_missing: 1, answers_invalid: 1, pinned_questions_invalid: 1, key_set_pin_invalid: 1,
  question_crosscheck_failed: 1, question_count_mismatch: 1, total_marks_mismatch: 1, profile_hash_mismatch: 1, attempt_timing_invalid: 1,
  attempt_metadata_invalid: 1, attempt_duplicate: 1
};
var SS_KEY_INTEGRITY_RE = /^(key_integrity_failed|key_set_duplicate|key_set_malformed|key_row_not_text|foreign_key_rows_for_paper|item_count_mismatch|mac_secret_.*)$/;

/* ---------------------------------------------------------------------------------------------------
 * Errors and runner
 * ------------------------------------------------------------------------------------------------- */
function ssErr_(code, status) { var e = new Error('ScoringService ' + code); e.name = 'ScoringServiceError'; e.ssCode = code; e.ssStatus = status || 'error'; return e; }

function ssRun_(fn) {
  try { return fn(); }
  catch (e) {
    if (e && e.ssCode) { Logger.log('ScoringService: stopped (' + e.ssCode + ').'); return { ok: false, status: e.ssStatus, code: e.ssCode }; }
    if (e && e.ksCode) { Logger.log('ScoringService: stopped (' + e.ksCode + ').'); return { ok: false, status: 'error', code: e.ksCode }; }
    Logger.log('ScoringService: unexpected error (' + String(e && e.name ? e.name : 'Error') + ').');
    return { ok: false, status: 'error', code: 'internal_error' };
  }
}

/* ---------------------------------------------------------------------------------------------------
 * Audit (AUTH_DB.audit_logs). Best effort: returns 'written' | 'already_present' | a code. Never throws, never stores secrets.
 * ------------------------------------------------------------------------------------------------- */
function ssAudit_(event, userId, targetId, result, detail) {
  try {
    var props = PropertiesService.getScriptProperties();
    var authId = ksProp_(props, PRIVATE_DB_PROPERTY_KEYS.AUTH_DB), examId = ksProp_(props, PRIVATE_DB_PROPERTY_KEYS.EXAM_DB);
    var keysId = ksProp_(props, PRIVATE_DB_PROPERTY_KEYS.KEYS_DB), publicId = ksProp_(props, KEYSTORE_PUBLIC_ID_PROPERTY);
    if (!authId) { return 'audit_config_missing'; }
    if (authId === keysId || authId === examId || (publicId && authId === publicId)) { return 'audit_config_conflict'; }
    var ss;
    try { ss = SpreadsheetApp.openById(authId); } catch (e) { return 'audit_db_unavailable'; }
    var cols = PRIVATE_DB_SCHEMAS.AUTH_DB.audit_logs.columns, sh;
    try { sh = ksSheet_(ss, 'audit_logs', cols); } catch (e2) { return e2 && e2.ksCode ? 'audit_' + e2.ksCode : 'audit_schema_error'; }
    var iEv = cols.indexOf('event'), iT = cols.indexOf('target_id'), iD = cols.indexOf('detail'), n = sh.getLastRow() - 1;
    if (n >= 1) {   /* the same event for the same target with the same detail is recorded once, so retries do not flood the log */
      var vals = sh.getRange(2, 1, n, cols.length).getValues();
      for (var i = 0; i < n; i++) {
        if (ksCellString_(vals[i][iEv]) === event && ksCellString_(vals[i][iT]) === targetId && ksCellString_(vals[i][iD]) === detail) { return 'already_present'; }
      }
    }
    var row = cols.map(function (c) {
      return c === 'ts' ? ksNowIso_() : c === 'event' ? event : c === 'user_id' ? userId : c === 'target_id' ? targetId : c === 'result' ? result : c === 'detail' ? detail : '';
    });
    var start = sh.getLastRow() + 1;
    if (sh.getMaxRows() < start) { sh.insertRowsAfter(sh.getMaxRows(), 1); }
    var rng = sh.getRange(start, 1, 1, cols.length);
    rng.setNumberFormat('@'); rng.setValues([row]); SpreadsheetApp.flush();
    var back = sh.getRange(start, 1, 1, cols.length).getValues()[0];
    for (var c = 0; c < cols.length; c++) { if (typeof back[c] !== 'string' || back[c] !== row[c]) { return 'audit_readback_failed'; } }
    return 'written';
  } catch (err) { return 'audit_failed'; }
}

/* Failure response with a best-effort audit row. user may be '' (unknown). */
function ssFail_(status, code, reason, event, attemptId, userId, extra) {
  var detail = 'attempt=' + attemptId + ';code=' + code + (reason ? ';reason=' + reason : '');
  var out = { ok: false, status: status, code: code };
  if (reason) { out.reason = reason; }
  out.audit = ssAudit_(event, userId || '', attemptId, 'blocked', detail);
  if (extra) { Object.keys(extra).forEach(function (k) { out[k] = extra[k]; }); }
  return out;
}

/* ---------------------------------------------------------------------------------------------------
 * Independent validation of each stage's output
 * ------------------------------------------------------------------------------------------------- */
function ssIsInt_(v, min) { return typeof v === 'number' && Number.isSafeInteger(v) && v >= min; }
function ssIsPlain_(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }

/* Returns a normalised copy of the loader result, or throws. */
function ssValidateLoaded_(attemptId, r) {
  if (!ssIsPlain_(r) || r.ok !== true || !ssIsPlain_(r.attempt) || !ssIsPlain_(r.scoring_input)) { throw ssErr_('loader_output_invalid'); }
  var a = r.attempt, si = r.scoring_input;
  if (a.attempt_id !== attemptId || typeof a.user_id !== 'string' || !AT_ID_RE.test(a.user_id)) { throw ssErr_('loader_output_invalid'); }
  var pm = typeof a.paper_id === 'string' && a.paper_id.length <= 64 ? SS_PAPER_RE.exec(a.paper_id) : null;
  if (!pm || a.year !== parseInt(pm[1], 10)) { throw ssErr_('loader_output_invalid'); }
  if (a.status !== 'closed' && a.status !== 'scored') { throw ssErr_('loader_output_invalid'); }
  if (a.close_reason !== 'submitted' && a.close_reason !== 'expired') { throw ssErr_('loader_output_invalid'); }
  if (!ssIsInt_(a.question_count, 1) || a.question_count > AT_MAX_QUESTIONS || !ssIsInt_(a.total_marks, 1) || !ssIsInt_(a.duration_seconds, 1)) { throw ssErr_('loader_output_invalid'); }
  if (typeof a.answers_hash !== 'string' || !KS_HEX64_RE.test(a.answers_hash)) { throw ssErr_('loader_output_invalid'); }
  if (typeof a.key_set_id !== 'string' || !/^ks-[0-9a-f]{40}$/.test(a.key_set_id) || typeof a.key_set_digest !== 'string' || !KS_HEX64_RE.test(a.key_set_digest)) { throw ssErr_('loader_output_invalid'); }
  var t = [a.started_at, a.deadline_at, a.closed_at].map(function (s) { return typeof s === 'string' ? Date.parse(s) : NaN; });
  if (t.some(isNaN) || t[1] - t[0] !== a.duration_seconds * 1000 || t[2] < t[0]) { throw ssErr_('loader_output_invalid'); }
  if (!Array.isArray(a.profile_set) || !a.profile_set.length) { throw ssErr_('loader_output_invalid'); }
  a.profile_set.forEach(function (ref) { if (typeof ref !== 'string' || !SS_PROFILE_REF_RE.test(ref)) { throw ssErr_('loader_output_invalid'); } });

  var qs = si.questions, resp = si.responses;
  if (!Array.isArray(qs) || qs.length !== a.question_count || !ssIsPlain_(resp)) { throw ssErr_('loader_output_invalid'); }
  var seen = Object.create(null), marks = 0;
  qs.forEach(function (q) {
    if (!ssIsPlain_(q) || typeof q.question_id !== 'string' || !AT_ID_RE.test(q.question_id) || seen[q.question_id]) { throw ssErr_('loader_output_invalid'); }
    seen[q.question_id] = q.type;
    if (!ssIsInt_(q.question_version, 1) || !ssIsInt_(q.marks, 1) || q.year !== a.year || !/^(MCQ|MSQ|NAT)$/.test(q.type) ||
        typeof q.content_hash !== 'string' || !KS_HEX64_RE.test(q.content_hash)) { throw ssErr_('loader_output_invalid'); }
    if (q.type !== 'NAT' && (!Array.isArray(q.option_ids) || !q.option_ids.length)) { throw ssErr_('loader_output_invalid'); }
    marks += q.marks;
  });
  if (marks !== a.total_marks) { throw ssErr_('loader_output_invalid'); }
  Object.keys(resp).forEach(function (id) {
    var type = seen[id], v = resp[id];
    if (!type) { throw ssErr_('loader_output_invalid'); }
    if (type === 'MSQ' ? !Array.isArray(v) : typeof v !== 'string') { throw ssErr_('loader_output_invalid'); }
  });
  return r;
}

function ssAssertKeySetPin_(attempt, keySet) {
  if (!ssIsPlain_(attempt) || !ssIsPlain_(keySet) || typeof attempt.key_set_id !== 'string' || !/^ks-[0-9a-f]{40}$/.test(attempt.key_set_id) ||
      typeof attempt.key_set_digest !== 'string' || !KS_HEX64_RE.test(attempt.key_set_digest)) { throw ssErr_('key_set_pin_invalid'); }
  if (keySet.key_set_id !== attempt.key_set_id || keySet.key_set_digest !== attempt.key_set_digest) {
    var e = ssErr_('key_set_pin_mismatch', 'blocked'); e.ssReason = 'key_set_revision_mismatch'; throw e;
  }
  return true;
}

function ssValidateKeySet_(paperId, attempt, loaded) {
  if (!ssIsPlain_(loaded) || loaded.ok !== true || !ssIsPlain_(loaded.key_set) || !Array.isArray(loaded.keys)) { throw ssErr_('key_loader_output_invalid'); }
  var m = loaded.key_set;
  if (m.paper_id !== paperId || String(m.year) !== String(attempt.year) || typeof m.key_set_digest !== 'string' || !KS_HEX64_RE.test(m.key_set_digest) ||
      loaded.keys.length !== m.item_count || !loaded.keys.length) { throw ssErr_('key_loader_output_invalid'); }
  ssAssertKeySetPin_(attempt, m);
  var ref = m.profile_id + '@' + m.profile_version;
  var prof = Object.prototype.hasOwnProperty.call(SC_PROFILES, ref) ? SC_PROFILES[ref] : null;
  if (!prof || !scProfileFor_(m.profile_id, parseInt(m.profile_version, 10), attempt.year)) { throw ssErr_('blocked_policy', 'blocked'); }
  if (attempt.profile_set.indexOf(scProfileRefText_(prof)) < 0) { throw ssErr_('key_profile_not_pinned', 'blocked'); }
  var ids = Object.create(null);
  loaded.keys.forEach(function (k) {
    if (!ssIsPlain_(k) || k.key_set_id !== m.key_set_id || typeof k.question_id !== 'string') { throw ssErr_('key_loader_output_invalid'); }
    var id = k.question_id + '|' + k.question_version;
    if (ids[id]) { throw ssErr_('key_loader_output_invalid'); }
    ids[id] = k;
  });
  return ids;
}

function ssCountsOf_(items) {
  var c = { correct: 0, wrong: 0, unanswered: 0, marks_to_all: 0 };
  items.forEach(function (it) { c[it.outcome]++; });
  return c;
}

/* Checks the scorer output against the attempt and the loaded keys; returns the canonical items. Throws on any disagreement. */
function ssValidateScored_(attempt, questions, keyIndex, s) {
  if (!ssIsPlain_(s) || s.status !== 'scored' || !Array.isArray(s.items) || s.items.length !== questions.length) { throw ssErr_('scorer_output_invalid'); }
  var awards = [], used = [], items = [];
  s.items.forEach(function (it, i) {
    var q = questions[i];
    if (!ssIsPlain_(it) || it.status !== 'scored' || it.question_id !== q.question_id || it.question_version !== q.question_version || it.type !== q.type ||
        it.marks !== q.marks || it.position !== i + 1 || SC_OUTCOMES.indexOf(it.outcome) < 0 || !scIsFrac_(it.award)) { throw ssErr_('scorer_output_invalid'); }
    var f = scFrac_(it.award.num, it.award.den);
    if (f.num !== it.award.num || f.den !== it.award.den) { throw ssErr_('scorer_output_invalid'); }
    var key = keyIndex[q.question_id + '|' + q.question_version];
    if (!key || key.key_id !== it.key_id || scToInt_(key.revision, 1) !== it.key_revision || !ssIsInt_(it.key_revision, 1)) { throw ssErr_('scorer_output_invalid'); }
    if (!Array.isArray(it.flags) || it.flags.some(function (x) { return typeof x !== 'string' || !SS_FLAG_RE.test(x); })) { throw ssErr_('scorer_output_invalid'); }
    awards.push(f); used.push(key);
    items.push({ position: i + 1, question_id: q.question_id, outcome: it.outcome, awarded: { num: f.num, den: f.den }, key_id: it.key_id, key_revision: it.key_revision, flags: it.flags.slice() });
  });
  var total = scSum_(awards);
  if (!ssIsPlain_(s.total) || s.total.num !== total.num || s.total.den !== total.den) { throw ssErr_('scorer_output_invalid'); }
  if (s.max_marks !== attempt.total_marks || s.item_count !== questions.length) { throw ssErr_('scorer_output_invalid'); }
  var c = ssCountsOf_(items);
  if (!ssIsPlain_(s.counts) || SC_OUTCOMES.some(function (o) { return s.counts[o] !== c[o]; })) { throw ssErr_('scorer_output_invalid'); }
  if (typeof s.key_set_digest !== 'string' || !KS_HEX64_RE.test(s.key_set_digest) || !ksConstantTimeEquals_(ksKeySetDigest_(used), s.key_set_digest)) { throw ssErr_('scorer_output_invalid'); }
  if (typeof s.profile_set !== 'string' || !s.profile_set) { throw ssErr_('scorer_output_invalid'); }
  var refs = s.profile_set.split(',');
  refs.forEach(function (r) { if (!SS_PROFILE_REF_RE.test(r) || attempt.profile_set.indexOf(r) < 0) { throw ssErr_('scorer_output_invalid'); } });
  return { total: { num: total.num, den: total.den }, total_text: scText_(total), max_marks: s.max_marks, item_count: items.length, counts: c, items: items,
    profile_set: s.profile_set, key_set_digest: s.key_set_digest };
}

/* ---------------------------------------------------------------------------------------------------
 * Canonical rows and stable ids
 * ------------------------------------------------------------------------------------------------- */
function ssResultId_(attemptId, digest, profileSet) {
  return 'res-' + ksSha256Hex_('GPS-RESULT-V1\n' + attemptId + '\n' + digest + '\n' + profileSet).slice(0, 40);
}
var SS_RESULT_ID_RE = /^res-[0-9a-f]{40}$/;

/* All cells are text: the written range is formatted '@' first, so Sheets cannot turn ids, fractions or timestamps into numbers or dates. */
function ssHeaderRow_(rid, attempt, scored, createdAt) {
  return [rid, attempt.attempt_id, attempt.user_id, String(SS_SCORE_REVISION), 'scored', String(scored.total.num), String(scored.total.den), String(scored.max_marks),
    scored.profile_set, scored.key_set_digest, String(scored.item_count), createdAt, ''];
}
function ssItemRow_(rid, it) {
  return [rid, it.question_id, it.outcome, String(it.awarded.num), String(it.awarded.den), it.key_id, String(it.key_revision), it.flags.join(',')];
}
function ssRowText_(cells) { return cells.map(function (c) { return ksCellString_(c); }); }
function ssSameRow_(a, b, skip) {
  for (var i = 0; i < a.length; i++) { if (i !== skip && a[i] !== b[i]) { return false; } }
  return a.length === b.length;
}

function ssSheets_() {
  var ss = atOpenExam_();
  var rc = PRIVATE_DB_SCHEMAS.EXAM_DB.results.columns, ic = PRIVATE_DB_SCHEMAS.EXAM_DB.result_items.columns;
  return { ss: ss, R: ksSheet_(ss, 'results', rc), rc: rc, I: ksSheet_(ss, 'result_items', ic), ic: ic };
}

function ssRowsMatching_(sh, ncols, col, wanted) {
  var n = sh.getLastRow() - 1, out = [];
  if (n < 1) { return out; }
  var vals = sh.getRange(2, 1, n, ncols).getValues();
  for (var i = 0; i < n; i++) {
    var t = ssRowText_(vals[i]);
    if (wanted(t[col])) { out.push({ rowNo: i + 2, cells: t }); }
  }
  return out;
}

function ssAppend_(sh, ncols, rows) {
  var start = sh.getLastRow() + 1, need = start + rows.length - 1;
  if (sh.getMaxRows() < need) { sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows()); }
  var rng = sh.getRange(start, 1, rows.length, ncols);
  rng.setNumberFormat('@'); rng.setValues(rows); SpreadsheetApp.flush();
  var back = sh.getRange(start, 1, rows.length, ncols).getValues();
  for (var i = 0; i < rows.length; i++) { if (!ssSameRow_(ssRowText_(back[i]), rows[i], -1)) { throw ssErr_('write_readback_failed'); } }
}

/* ---------------------------------------------------------------------------------------------------
 * Reading and verifying a committed result against the (already validated) attempt
 * ------------------------------------------------------------------------------------------------- */
function ssParseHeader_(cells, rc) {
  var h = ksRowObject_(rc, cells);
  var num = atInt_(h.total_num, 0), den = atInt_(h.total_den, 1), max = atInt_(h.max_marks, 1), cnt = atInt_(h.item_count, 1), rev = atInt_(h.score_revision, 1);
  if (!SS_RESULT_ID_RE.test(h.result_id) || !AT_ID_RE.test(h.attempt_id) || !AT_ID_RE.test(h.user_id) || num === null || den === null || max === null || cnt === null || rev === null ||
      !KS_HEX64_RE.test(h.key_set_digest) || !h.profile_set || atTime_(h.created_at) === null && !/^\d{4}-\d{2}-\d{2}T/.test(h.created_at)) { throw ssErr_('result_header_malformed'); }
  return { raw: h, num: num, den: den, max: max, count: cnt, revision: rev };
}

/* Verifies header + items for the attempt. Returns the view. Throws ssErr_ on any inconsistency. */
function ssReadCommitted_(S, attempt, questions, headerCells) {
  var H = ssParseHeader_(headerCells, S.rc), h = H.raw;
  if (h.attempt_id !== attempt.attempt_id || h.user_id !== attempt.user_id || H.revision !== SS_SCORE_REVISION || h.status !== 'scored' || h.supersedes_result_id !== '' ||
      H.max !== attempt.total_marks || H.count !== questions.length || scFrac_(H.num, H.den).den !== H.den || h.key_set_digest !== attempt.key_set_digest) { throw ssErr_('result_header_conflict'); }
  if (h.result_id !== ssResultId_(h.attempt_id, h.key_set_digest, h.profile_set)) { throw ssErr_('result_id_mismatch'); }
  h.profile_set.split(',').forEach(function (r) { if (!SS_PROFILE_REF_RE.test(r) || attempt.profile_set.indexOf(r) < 0) { throw ssErr_('result_profile_mismatch'); } });
  var rows = ssRowsMatching_(S.I, S.ic.length, 0, function (v) { return v === h.result_id; });
  if (rows.length !== H.count) { throw ssErr_('result_items_incomplete'); }
  var byQ = Object.create(null), sum = scFrac_(0, 1), items = [];
  rows.forEach(function (r) {
    var o = ksRowObject_(S.ic, r.cells);
    if (byQ[o.question_id]) { throw ssErr_('result_items_conflict'); }
    byQ[o.question_id] = o;
  });
  questions.forEach(function (q, i) {
    var o = byQ[q.question_id];
    if (!o) { throw ssErr_('result_items_conflict'); }
    var n = /^(0|-?[1-9]\d{0,15})$/.test(o.awarded_num) ? Number(o.awarded_num) : null, d = atInt_(o.awarded_den, 1), rev = atInt_(o.key_revision, 1);
    if (n === null || d === null || rev === null || SC_OUTCOMES.indexOf(o.outcome) < 0 || !AT_ID_RE.test(o.key_id)) { throw ssErr_('result_items_conflict'); }
    var f = scFrac_(n, d), flags = o.flags === '' ? [] : o.flags.split(',');
    if (f.num !== n || f.den !== d || flags.some(function (x) { return !SS_FLAG_RE.test(x); })) { throw ssErr_('result_items_conflict'); }
    sum = scAdd_(sum, f);
    items.push({ position: i + 1, question_id: q.question_id, outcome: o.outcome, awarded: { num: f.num, den: f.den }, key_id: o.key_id, key_revision: rev, flags: flags });
  });
  if (sum.num !== H.num || sum.den !== H.den) { throw ssErr_('result_total_mismatch'); }
  var counts = ssCountsOf_(items);
  return { result: { result_id: h.result_id, attempt_id: h.attempt_id, user_id: h.user_id, score_revision: H.revision, status: 'scored', total: { num: H.num, den: H.den },
      total_text: scText_(sum), max_marks: H.max, item_count: H.count, profile_set: h.profile_set, key_set_digest: h.key_set_digest, created_at: h.created_at, counts: counts }, items: items };
}

/* ---------------------------------------------------------------------------------------------------
 * Shared lock-free steps. The caller holds the script lock.
 * ------------------------------------------------------------------------------------------------- */
function ssLoadAttempt_(attemptId) {
  var r = atLoadAttemptForScoring_(attemptId);
  if (!r || r.ok !== true) { return { fail: r && typeof r.code === 'string' ? r : { code: 'loader_failed' } }; }
  return { loaded: ssValidateLoaded_(attemptId, r) };
}

/* Maps a loader failure to a status and audit event. Terminal-state refusals are not audited as faults. */
function ssLoaderFailure_(attemptId, f) {
  var code = String(f.code), reason = typeof f.reason === 'string' ? f.reason : '';
  if (code === 'attempt_not_found' || code === 'bad_attempt_id') { return { ok: false, status: 'not_found', code: code }; }
  if (code === 'attempt_not_closed' || code === 'attempt_status_unresolved' || code === 'attempt_status_invalid' || code === 'attempt_close_reason_invalid' ||
      code === 'paper_id_unresolved' || code === 'paper_id_invalid' || code === 'attempts_migration_required') { return { ok: false, status: 'not_scorable', code: code }; }
  if (SS_INTEGRITY_CODES[code]) { return ssFail_('integrity_error', code, reason, 'integrity_error', attemptId, ''); }
  if (code === 'key_set_pin_missing') { return ssFail_('blocked', 'key_set_pin_missing', 'attempt_key_set_unpinned', 'score_blocked', attemptId, ''); }
  if (code === 'blocked_policy' || code === 'profile_set_missing' || code === 'profile_set_invalid') { return ssFail_('blocked', code, reason, 'score_blocked', attemptId, ''); }
  return { ok: false, status: 'error', code: code };
}

function ssMarkScored_(attemptId, S) {
  var A = atSheet_(S.ss, 'attempts'), cols = A.cols, iA = cols.indexOf('attempt_id'), iS = cols.indexOf('status');
  var hits = ssRowsMatching_(A.sh, cols.length, iA, function (v) { return v === attemptId; });
  if (hits.length !== 1) { throw ssErr_('attempt_row_ambiguous'); }
  if (hits[0].cells[iS] === 'scored') { return true; }
  if (hits[0].cells[iS] !== 'closed') { throw ssErr_('attempt_status_changed'); }
  A.sh.getRange(hits[0].rowNo, iS + 1).setValue('scored'); SpreadsheetApp.flush();
  return ksCellString_(A.sh.getRange(hits[0].rowNo, iS + 1).getValue()) === 'scored';
}

function ssOutput_(code, view, extra) {
  var out = { ok: true, status: 'scored', code: code, result: view.result, items: view.items };
  if (extra) { Object.keys(extra).forEach(function (k) { out[k] = extra[k]; }); }
  return out;
}

/* Loads keys under the already-held lock. Mirrors the checks ksLoadApprovedKeySet_ makes before it locks. */
function ssLoadKeys_(paperId) {
  if (typeof paperId !== 'string' || paperId.length > 64 || !SS_PAPER_RE.test(paperId)) { throw ssErr_('bad_paper_id'); }
  ksMacSecret_();
  return ksLoadApprovedKeySetLocked_(paperId);
}

/* Load attempt + keys and score. Returns {fail} (already a response), or {attempt, questions, responses, keyIndex, scored}. */
function ssComputeScore_(attemptId, attempt) {
  var A = attempt.attempt, si = attempt.scoring_input, loadedKeys, policy = scPolicyFromProperties_();
  var globalBlock = ssFirstOperationalBlock_();
  if (globalBlock) { return { fail: ssFail_('blocked', 'blocked_policy', globalBlock.reason, 'score_blocked', attemptId, A.user_id) }; }
  try { loadedKeys = ssLoadKeys_(A.paper_id); }
  catch (e) { loadedKeys = { ok: false, code: e && e.ksCode ? e.ksCode : e && e.ssCode ? e.ssCode : 'keys_unavailable' }; }
  if (!ssIsPlain_(loadedKeys) || loadedKeys.ok !== true) {
    var kc = loadedKeys && typeof loadedKeys.code === 'string' ? loadedKeys.code : 'keys_unavailable';
    return { fail: SS_KEY_INTEGRITY_RE.test(kc) ? ssFail_('blocked', 'keys_unavailable', kc, 'key_mac_failed', attemptId, A.user_id) : ssFail_('blocked', 'keys_unavailable', kc, 'score_blocked', attemptId, A.user_id) };
  }
  var keyIndex;
  try { keyIndex = ssValidateKeySet_(A.paper_id, A, loadedKeys); }
  catch (e2) {
    if (e2 && e2.ssStatus === 'blocked') { return { fail: ssFail_('blocked', e2.ssCode, e2.ssReason || '', 'score_blocked', attemptId, A.user_id) }; }
    throw e2;
  }
  var s = scScoreAttempt_({ questions: si.questions, responses: si.responses, keySets: [loadedKeys], policy: policy });
  if (!ssIsPlain_(s) || s.status !== 'scored') {
    var code = s && typeof s.code === 'string' ? s.code : 'scorer_failed', reason = s && typeof s.reason === 'string' ? s.reason : '';
    var ev = code === 'key_integrity_failed' ? 'key_mac_failed' : 'score_blocked';
    return { fail: ssFail_('blocked', code, reason, ev, attemptId, A.user_id, { blocked_count: s && Array.isArray(s.blocked) ? s.blocked.length : 0 }) };
  }
  return { scored: ssValidateScored_(A, si.questions, keyIndex, s), keyIndex: keyIndex };
}

/* ---------------------------------------------------------------------------------------------------
 * ssScoreAndCommitAttempt_(attempt_id)
 *
 * Success: {ok:true, status:'scored', code:'committed'|'already_committed'|'committed_attempt_status_pending', result:{...}, items:[...]}
 * Failure: {ok:false, status:'blocked'|'not_scorable'|'not_found'|'integrity_error'|'refused'|'error', code, reason?, audit?} and no total.
 * ------------------------------------------------------------------------------------------------- */
function ssScoreAndCommitAttempt_(attempt_id) {
  return ssRun_(function () {
    if (typeof attempt_id !== 'string' || !AT_ID_RE.test(attempt_id)) { return { ok: false, status: 'not_found', code: 'bad_attempt_id' }; }
    return ksWithLock_(function () {
      /* 1. Attempt (read-only loader, independently re-validated). */
      var first = ssLoadAttempt_(attempt_id);
      if (first.fail) { return ssLoaderFailure_(attempt_id, first.fail); }
      var A = first.loaded.attempt, questions = first.loaded.scoring_input.questions;
      var S = ssSheets_();

      /* 2. An attempt that already has a committed result gets that result back: no rescoring, no new rows. */
      var heads = ssRowsMatching_(S.R, S.rc.length, S.rc.indexOf('attempt_id'), function (v) { return v === attempt_id; });
      if (heads.length > 1) { return ssFail_('integrity_error', 'result_duplicate', '', 'integrity_error', attempt_id, A.user_id); }
      if (heads.length === 1) {
        var view;
        try { view = ssReadCommitted_(S, A, questions, heads[0].cells); }
        catch (e) { if (e && e.ssCode) { return ssFail_('integrity_error', e.ssCode, '', 'integrity_error', attempt_id, A.user_id); } throw e; }
        var marked = ssMarkScored_(attempt_id, S);
        return ssOutput_(marked ? 'already_committed' : 'committed_attempt_status_pending', view, { rescored: false });
      }

      /* 3. Keys and scoring (pure; gates come only from Script Properties, default off). */
      var c = ssComputeScore_(attempt_id, first.loaded);
      if (c.fail) { return c.fail; }
      var scored = c.scored, rid = ssResultId_(attempt_id, scored.key_set_digest, scored.profile_set);

      /* 4. Re-read the attempt after scoring: it must be unchanged, with the same saved-answer hash. */
      var second = ssLoadAttempt_(attempt_id);
      if (second.fail) { return ssLoaderFailure_(attempt_id, second.fail); }
      if (JSON.stringify(second.loaded) !== JSON.stringify(first.loaded) || second.loaded.attempt.answers_hash !== A.answers_hash) {
        return ssFail_('integrity_error', 'attempt_changed_during_scoring', '', 'integrity_error', attempt_id, A.user_id);
      }

      /* 5. Another result header for this id (different attempt) or one that appeared meanwhile is a conflict, never overwritten. */
      var clash = ssRowsMatching_(S.R, S.rc.length, 0, function (v) { return v === rid; });
      if (clash.length) { return ssFail_('integrity_error', 'result_header_conflict', '', 'integrity_error', attempt_id, A.user_id); }

      /* 6. Items first. Existing rows for this result id must equal the expected rows; missing ones are appended. Nothing is overwritten. */
      var expected = scored.items.map(function (it) { return ssItemRow_(rid, it); });
      var have = ssRowsMatching_(S.I, S.ic.length, 0, function (v) { return v === rid; }), haveByQ = Object.create(null), qCol = S.ic.indexOf('question_id'), missing = [];
      for (var i = 0; i < have.length; i++) {
        if (haveByQ[have[i].cells[qCol]]) { return ssFail_('integrity_error', 'result_items_conflict', '', 'integrity_error', attempt_id, A.user_id); }
        haveByQ[have[i].cells[qCol]] = have[i].cells;
      }
      for (var j = 0; j < expected.length; j++) {
        var existing = haveByQ[expected[j][qCol]];
        if (!existing) { missing.push(expected[j]); continue; }
        if (!ssSameRow_(existing, expected[j], -1)) { return ssFail_('integrity_error', 'result_items_conflict', '', 'integrity_error', attempt_id, A.user_id); }
        delete haveByQ[expected[j][qCol]];
      }
      if (Object.keys(haveByQ).length) { return ssFail_('integrity_error', 'result_items_conflict', '', 'integrity_error', attempt_id, A.user_id); }   /* rows for questions not in this attempt */
      if (missing.length) { ssAppend_(S.I, S.ic.length, missing); }

      /* 7. Read the items back as a whole before the commit marker exists. */
      var back = ssRowsMatching_(S.I, S.ic.length, 0, function (v) { return v === rid; });
      if (back.length !== expected.length) { throw ssErr_('items_readback_failed'); }
      var backByQ = Object.create(null);
      back.forEach(function (r) { backByQ[r.cells[qCol]] = r.cells; });
      expected.forEach(function (row) { if (!backByQ[row[qCol]] || !ssSameRow_(backByQ[row[qCol]], row, -1)) { throw ssErr_('items_readback_failed'); } });

      /* 8. Header last (commit marker), then verify it and its items together. */
      var createdAt = ksNowIso_();
      ssAppend_(S.R, S.rc.length, [ssHeaderRow_(rid, A, scored, createdAt)]);
      var hs = ssRowsMatching_(S.R, S.rc.length, 0, function (v) { return v === rid; });
      if (hs.length !== 1) { throw ssErr_('header_readback_failed'); }
      var view2 = ssReadCommitted_(S, A, questions, hs[0].cells);
      if (view2.result.key_set_digest !== scored.key_set_digest || view2.result.total.num !== scored.total.num || view2.result.total.den !== scored.total.den) { throw ssErr_('header_readback_failed'); }

      /* 9. Only now mark the attempt scored. A failure here leaves a committed result and a closed attempt; a retry finishes it. */
      var audit = ssAudit_('score_computed', A.user_id, rid, 'ok', 'attempt=' + attempt_id + ';status=scored;items=' + scored.item_count + ';digest=' + scored.key_set_digest);
      var done;
      try { done = ssMarkScored_(attempt_id, S); } catch (e3) { done = false; }
      return ssOutput_(done ? 'committed' : 'committed_attempt_status_pending', view2, { rescored: true, audit: audit });
    });
  });
}

/* ---------------------------------------------------------------------------------------------------
 * ssGetCommittedResult_(attempt_id): read-only retrieval of the committed result, verified against the stored attempt.
 * Not an authorisation check: the caller must already have decided this user may see this attempt's result.
 * ------------------------------------------------------------------------------------------------- */
function ssGetCommittedResult_(attempt_id) {
  return ssRun_(function () {
    if (typeof attempt_id !== 'string' || !AT_ID_RE.test(attempt_id)) { return { ok: false, status: 'not_found', code: 'bad_attempt_id' }; }
    return ksWithLock_(function () { return ssGetLocked_(attempt_id); });
  });
}

function ssGetLocked_(attempt_id) {
  var L = ssLoadAttempt_(attempt_id);
  if (L.fail) { return ssLoaderFailure_(attempt_id, L.fail); }
  var S = ssSheets_(), A = L.loaded.attempt;
  var heads = ssRowsMatching_(S.R, S.rc.length, S.rc.indexOf('attempt_id'), function (v) { return v === attempt_id; });
  if (!heads.length) { return { ok: false, status: 'not_scorable', code: 'result_not_committed' }; }
  if (heads.length > 1) { return { ok: false, status: 'integrity_error', code: 'result_duplicate' }; }
  try { return ssOutput_('verified', ssReadCommitted_(S, A, L.loaded.scoring_input.questions, heads[0].cells)); }
  catch (e) { if (e && e.ssCode) { return { ok: false, status: 'integrity_error', code: e.ssCode }; } throw e; }
}

/* ---------------------------------------------------------------------------------------------------
 * ssVerifyCommittedResult_(attempt_id): verifies the committed result, then re-scores with the CURRENT approved keys and policy and
 * compares. Writes nothing and audits nothing. Answers 'matches', or why not ('key_set_changed', 'score_differs', or a blocked reason).
 * A differing outcome is a signal for the owner, never an automatic rescore.
 * ------------------------------------------------------------------------------------------------- */
function ssVerifyCommittedResult_(attempt_id) {
  return ssRun_(function () {
    if (typeof attempt_id !== 'string' || !AT_ID_RE.test(attempt_id)) { return { ok: false, status: 'not_found', code: 'bad_attempt_id' }; }
    return ksWithLock_(function () {
      var got = ssGetLocked_(attempt_id);
      if (!got.ok) { return got; }
      var L = ssLoadAttempt_(attempt_id);
      if (L.fail) { return ssLoaderFailure_(attempt_id, L.fail); }
      var A = L.loaded.attempt, keys;
      try { keys = ssLoadKeys_(A.paper_id); } catch (e) { return { ok: true, status: 'scored', code: 'committed_verified', recheck: 'keys_unavailable', result: got.result }; }
      if (!ssIsPlain_(keys) || keys.ok !== true) { return { ok: true, status: 'scored', code: 'committed_verified', recheck: 'keys_unavailable', result: got.result }; }
      var keyIndex = ssValidateKeySet_(A.paper_id, A, keys);
      var s = scScoreAttempt_({ questions: L.loaded.scoring_input.questions, responses: L.loaded.scoring_input.responses, keySets: [keys], policy: scPolicyFromProperties_() });
      if (!ssIsPlain_(s) || s.status !== 'scored') { return { ok: true, status: 'scored', code: 'committed_verified', recheck: 'blocked', result: got.result }; }
      var fresh = ssValidateScored_(A, L.loaded.scoring_input.questions, keyIndex, s), r = got.result, recheck;
      if (fresh.key_set_digest !== r.key_set_digest || fresh.profile_set !== r.profile_set) { recheck = 'key_set_changed'; }
      else if (fresh.total.num !== r.total.num || fresh.total.den !== r.total.den) { recheck = 'score_differs'; }
      else { recheck = 'matches'; }
      return { ok: true, status: 'scored', code: 'committed_verified', recheck: recheck, result: got.result };
    });
  });
}
