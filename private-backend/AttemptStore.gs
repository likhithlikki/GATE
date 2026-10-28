/**
 * GATE Prep Studio PRIVATE backend: AttemptStore (Task 29). Read-only loader that prepares a persisted attempt for scoring.
 *
 * Standalone private Apps Script project. No doGet/doPost, no endpoint, no browser-accessible operation. The function name ends in
 * an underscore, so it cannot be run from the editor either. Trusted server code calls it.
 *
 * It opens ONLY EXAM_DB (never KEYS_DB or AUTH_DB) and writes nothing: no rows in attempts, attempt_questions, answers, results or
 * result_items. It does not start, save, submit or score an attempt, and it returns NO answer keys: the caller gets verified keys
 * separately from ksLoadApprovedKeySet_(paper_id) and passes both to scScoreAttempt_().
 *
 * The user id in the result comes from the stored attempt row only. Nothing a browser supplies is an authorisation proof; whoever
 * calls this must already have authorised the request.
 *
 * Failures return {ok:false, code, errors?} with row positions and short codes only. No response values, NAT text, ids of other users
 * or whole records are ever logged or reported. The browser-derived answers.correct / answers.awarded_marks columns are never read.
 *
 * Status semantics used (ANSWER_KEY_SCORING_SPEC.md 5.4, 5.5, 9): a scorable attempt is 'closed' (close_reason 'submitted' or
 * 'expired') or already 'scored'. 'in_progress' is refused. The older SECURITY_DESIGN.md values 'submitted' / 'expired' as a status are
 * not mapped here: they return attempt_status_unresolved rather than guessing a product rule.
 */

var AT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
var AT_PAPER_RE = /^gate-(\d{4})-[a-z0-9]+(-[a-z0-9]+)*$/;
var AT_MAX_QUESTIONS = 200;
var AT_MAX_NAT_RESPONSE_LENGTH = 64;   /* spec 5.3 */

/* ---------------------------------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------------------------------- */
function atOpenExam_() {
  var props = PropertiesService.getScriptProperties();
  var examId = ksProp_(props, PRIVATE_DB_PROPERTY_KEYS.EXAM_DB);
  if (!examId) { throw ksErr_('config_missing'); }
  var others = [ksProp_(props, PRIVATE_DB_PROPERTY_KEYS.KEYS_DB), ksProp_(props, PRIVATE_DB_PROPERTY_KEYS.AUTH_DB), ksProp_(props, KEYSTORE_PUBLIC_ID_PROPERTY)];
  if (others.some(function (o) { return o && o === examId; })) { throw ksErr_('config_conflict'); }
  try { return SpreadsheetApp.openById(examId); } catch (e) { throw ksErr_('exam_db_unavailable'); }
}

/* Header must start with the schema columns exactly. The attempts tab may predate the paper_id column. */
function atSheet_(ss, tab) {
  var cols = PRIVATE_DB_SCHEMAS.EXAM_DB[tab].columns;
  try { return { sh: ksSheet_(ss, tab, cols), cols: cols }; }
  catch (e) {
    if (tab === 'attempts' && e && e.ksCode === 'schema_mismatch') { throw ksErr_('attempts_migration_required'); }
    throw e;
  }
}

function atRowsFor_(sh, cols, keyCol, value) {
  var n = sh.getLastRow() - 1, out = [];
  if (n < 1) { return out; }
  var iK = cols.indexOf(keyCol), vals = sh.getRange(2, 1, n, cols.length).getValues();
  for (var i = 0; i < n; i++) { if (ksCellString_(vals[i][iK]) === value) { out.push(vals[i]); } }
  return out;
}

function atInt_(cell, min) {
  var s = ksCellString_(cell);
  if (!/^(0|[1-9]\d{0,15})$/.test(s)) { return null; }
  var n = Number(s);
  return Number.isSafeInteger(n) && n >= min ? n : null;
}

/* Instant as epoch ms from an ISO text cell or a Date Sheets produced. Null if it is neither. */
function atTime_(cell) {
  if (cell instanceof Date) { var t = cell.getTime(); return isNaN(t) ? null : t; }
  if (typeof cell !== 'string' || cell.indexOf('T') < 0 || !ksValidDate_(cell)) { return null; }
  var ms = Date.parse(cell);
  return isNaN(ms) ? null : ms;
}

/* Strict response contract (spec 5.3): MCQ one option id; MSQ array of unique option ids (order-insensitive); NAT a string of at most
 * 64 characters without control characters. "" and [] mean cleared. Anything else is malformed; nothing is repaired. Returns
 * {ok:true, value} or {ok:false}. NAT syntax is judged later by the scorer, not here. */
function atParseResponse_(type, text, optionIds) {
  var v;
  try { v = JSON.parse(text); } catch (e) { return { ok: false }; }
  if (type === 'MCQ') {
    if (typeof v !== 'string') { return { ok: false }; }
    if (v === '') { return { ok: true, value: '' }; }
    if (!AT_ID_RE.test(v) || (optionIds && !optionIds[v])) { return { ok: false }; }
    return { ok: true, value: v };
  }
  if (type === 'MSQ') {
    if (!Array.isArray(v)) { return { ok: false }; }
    var seen = Object.create(null);
    for (var i = 0; i < v.length; i++) {
      if (typeof v[i] !== 'string' || !AT_ID_RE.test(v[i]) || seen[v[i]] || (optionIds && !optionIds[v[i]])) { return { ok: false }; }
      seen[v[i]] = true;
    }
    return { ok: true, value: v.slice().sort() };   /* canonical order: sets are compared without regard to order */
  }
  if (type === 'NAT') {
    if (typeof v !== 'string' || v.length > AT_MAX_NAT_RESPONSE_LENGTH || /[\u0000-\u001f\u007f]/.test(v)) { return { ok: false }; }
    return { ok: true, value: v };
  }
  return { ok: false };
}

/* answers_hash contract (spec 5.4 / 5.5 "hash over the canonical saved answers"): SHA-256 of 'GPS-ANSWERS-V1\n' followed by one line per
 * STORED answer row in pinned position order: position:question_id:length:canonical_json, where canonical_json is JSON.stringify of
 * the parsed response with an MSQ array sorted. Absent answers contribute nothing. A future submit_attempt must use this same function. */
function atAnswersHash_(entries) {
  var sorted = entries.slice().sort(function (a, b) { return a.position - b.position; });
  return ksSha256Hex_('GPS-ANSWERS-V1\n' + sorted.map(function (e) {
    var c = JSON.stringify(e.value);
    return e.position + ':' + e.question_id + ':' + c.length + ':' + c + '\n';
  }).join(''));
}

/* ---------------------------------------------------------------------------------------------------
 * atLoadAttemptForScoring_(attempt_id)
 *
 * Success: { ok:true, code:'ok', attempt:{...metadata}, scoring_input:{ questions:[...], responses:{question_id: response} } }
 *   scoring_input is exactly the questions/responses part of scScoreAttempt_ input; the caller adds keySets (from the key loader) and an
 *   explicit policy. attempt.profile_set lists the pinned profile references (id@version@hash), already checked against the private
 *   profiles in Scoring.gs.
 * Failure: { ok:false, code, errors?:[{row (= pinned position, 0 if unknown), field:"", code}] } and nothing else.
 * ------------------------------------------------------------------------------------------------- */
function atLoadAttemptForScoring_(attempt_id) {
  return ksRun_(function () {
    if (typeof attempt_id !== 'string' || !AT_ID_RE.test(attempt_id)) { return { ok: false, code: 'bad_attempt_id' }; }
    var ss = atOpenExam_();
    var A = atSheet_(ss, 'attempts'), Q = atSheet_(ss, 'attempt_questions'), N = atSheet_(ss, 'answers');

    /* 1. Exactly one attempt row, in a state that can be scored. */
    var rows = atRowsFor_(A.sh, A.cols, 'attempt_id', attempt_id);
    if (!rows.length) { return { ok: false, code: 'attempt_not_found' }; }
    if (rows.length > 1) { return { ok: false, code: 'attempt_duplicate' }; }
    var a = {};
    A.cols.forEach(function (c, i) { a[c] = rows[0][i]; });
    var status = ksCellString_(a.status);
    if (status === 'in_progress') { return { ok: false, code: 'attempt_not_closed' }; }
    if (status === 'submitted' || status === 'expired') { return { ok: false, code: 'attempt_status_unresolved' }; }
    if (status !== 'closed' && status !== 'scored') { return { ok: false, code: 'attempt_status_invalid' }; }
    var reason = ksCellString_(a.close_reason);
    if (reason !== 'submitted' && reason !== 'expired') { return { ok: false, code: 'attempt_close_reason_invalid' }; }

    /* 2. Paper identity. Historical rows have none and are never inferred. */
    var paperId = ksCellString_(a.paper_id), pm = AT_PAPER_RE.exec(paperId);
    if (!paperId) { return { ok: false, code: 'paper_id_unresolved' }; }
    if (!pm || paperId.length > 64) { return { ok: false, code: 'paper_id_invalid' }; }
    var paperYear = parseInt(pm[1], 10);

    /* 3. Attempt metadata: identity, counts, marks, timing. */
    var userId = ksCellString_(a.user_id), count = atInt_(a.question_count, 1), totalMarks = atInt_(a.total_marks, 1);
    var duration = atInt_(a.duration_seconds, 1), lastSeq = atInt_(a.last_seq, 0);
    var started = atTime_(a.started_at), deadline = atTime_(a.deadline_at), closedAt = atTime_(a.closed_at);
    if (!AT_ID_RE.test(userId) || ksCellString_(a.mode) === '' || count === null || count > AT_MAX_QUESTIONS || totalMarks === null || duration === null || lastSeq === null) {
      return { ok: false, code: 'attempt_metadata_invalid' };
    }
    if (started === null || deadline === null || closedAt === null || deadline - started !== duration * 1000 || closedAt < started) {
      return { ok: false, code: 'attempt_timing_invalid' };   /* the pinned deadline must equal start + pinned duration */
    }
    var answersHash = a.answers_hash;
    if (typeof answersHash !== 'string' || !answersHash) { return { ok: false, code: 'answers_hash_missing' }; }
    if (!KS_HEX64_RE.test(answersHash)) { return { ok: false, code: 'answers_hash_invalid' }; }

    /* 3b. Key-set identity is pinned when the attempt starts. Old rows without a pin are not backfilled from today's key set. */
    var pinnedKeySetId = ksCellString_(a.key_set_id), pinnedKeySetDigest = ksCellString_(a.key_set_digest);
    if (!pinnedKeySetId || !pinnedKeySetDigest) { return { ok: false, code: 'key_set_pin_missing' }; }
    if (!/^ks-[0-9a-f]{40}$/.test(pinnedKeySetId) || !KS_HEX64_RE.test(pinnedKeySetDigest)) { return { ok: false, code: 'key_set_pin_invalid' }; }

    /* 4. Pinned profile references: present, known privately, hash-identical, and one of them is verified for this paper's year. */
    var profileText = ksCellString_(a.profile_set);
    if (!profileText) { return { ok: false, code: 'profile_set_missing' }; }
    var profileRefs = profileText.split(','), yearCovered = false;
    for (var p = 0; p < profileRefs.length; p++) {
      var pr = /^([A-Za-z0-9._-]+)@(\d+)@([0-9a-f]{64})$/.exec(profileRefs[p]);
      if (!pr) { return { ok: false, code: 'profile_set_invalid' }; }
      var known = Object.prototype.hasOwnProperty.call(SC_PROFILES, pr[1] + '@' + pr[2]) ? SC_PROFILES[pr[1] + '@' + pr[2]] : null;
      if (!known || !scProfileFor_(pr[1], parseInt(pr[2], 10), known.year)) { return { ok: false, code: 'blocked_policy', reason: 'profile_unverified' }; }
      if (scProfileHash_(known) !== pr[3]) { return { ok: false, code: 'profile_hash_mismatch' }; }
      if (known.year === paperYear) { yearCovered = true; }
    }
    if (!yearCovered) { return { ok: false, code: 'blocked_policy', reason: 'profile_unverified' }; }

    /* 5. Pinned questions: complete, contiguous, unique, consistent with the attempt totals. */
    var qRows = atRowsFor_(Q.sh, Q.cols, 'attempt_id', attempt_id), errs = [], pinned = [], seenPos = Object.create(null), seenId = Object.create(null), marksSum = 0;
    if (qRows.length !== count) { return { ok: false, code: 'question_count_mismatch' }; }
    qRows.forEach(function (r) {
      var o = {};
      Q.cols.forEach(function (c, i) { o[c] = r[i]; });
      var pos = atInt_(o.position, 1), qid = ksCellString_(o.question_id), ver = atInt_(o.question_version, 1), marks = atInt_(o.marks, 1);
      if (pos === null || pos > count || !AT_ID_RE.test(qid) || ver === null || marks === null) { ksAddErr_(errs, pos === null ? 0 : pos, '', 'pinned_row_invalid'); return; }
      if (seenPos[pos]) { ksAddErr_(errs, pos, '', 'duplicate_position'); return; }
      if (seenId[qid]) { ksAddErr_(errs, pos, '', 'duplicate_question'); return; }
      seenPos[pos] = true; seenId[qid] = true; marksSum += marks;
      pinned.push({ position: pos, question_id: qid, question_version: ver, marks: marks });
    });
    for (var k = 1; k <= count && !errs.length; k++) { if (!seenPos[k]) { ksAddErr_(errs, k, '', 'position_gap'); } }
    if (errs.length) { return { ok: false, code: 'pinned_questions_invalid', errors: errs }; }
    if (marksSum !== totalMarks) { return { ok: false, code: 'total_marks_mismatch' }; }
    pinned.sort(function (x, y) { return x.position - y.position; });

    /* 6. Cross-check each pinned version in EXAM_DB.questions. Never substitute another version. */
    var ids = pinned.map(function (x) { return x.question_id; }), bank = ksLoadQuestions_(ss, ids), questions = [], optionMaps = Object.create(null);
    pinned.forEach(function (x) {
      var list = bank[x.question_id] || [];
      if (!list.length) { ksAddErr_(errs, x.position, '', 'question_not_found'); return; }
      var match = list.filter(function (b) { return b.question_version === String(x.question_version); });
      if (!match.length) { ksAddErr_(errs, x.position, '', 'question_version_missing'); return; }
      if (match.length > 1) { ksAddErr_(errs, x.position, '', 'question_ambiguous'); return; }
      var b = match[0];
      if (b.type === '' || b.marks === '' || b.year === '' || b.content_hash === '') { ksAddErr_(errs, x.position, '', 'question_field_missing'); return; }
      if (!/^(MCQ|MSQ|NAT)$/.test(b.type) || !KS_HEX64_RE.test(b.content_hash) || !/^[1-9]\d{3}$/.test(b.year)) { ksAddErr_(errs, x.position, '', 'question_field_invalid'); return; }
      if (b.marks !== String(x.marks)) { ksAddErr_(errs, x.position, '', 'question_marks_mismatch'); return; }
      if (parseInt(b.year, 10) !== paperYear) { ksAddErr_(errs, x.position, '', 'question_year_mismatch'); return; }   /* mixed years need a policy this loader does not have */
      var rec = { question_id: x.question_id, question_version: x.question_version, type: b.type, marks: x.marks, year: paperYear, content_hash: b.content_hash };
      if (b.type === 'MCQ' || b.type === 'MSQ') {
        var set = ksParseOptionIds_(b.options_json);
        if (!set) { ksAddErr_(errs, x.position, '', 'question_options_unavailable'); return; }
        optionMaps[x.question_id] = set;
        rec.option_ids = Object.keys(set);
      }
      questions.push(rec);
    });
    if (errs.length) { return { ok: false, code: 'question_crosscheck_failed', errors: errs }; }

    /* 7. Saved answers: no duplicates, no unknown questions, strict response shapes, sane sequence and timing. correct/awarded_marks are never read. */
    var aRows = atRowsFor_(N.sh, N.cols, 'attempt_id', attempt_id), byId = Object.create(null), responses = Object.create(null), hashEntries = [];
    questions.forEach(function (q, i) { byId[q.question_id] = { q: q, position: i + 1 }; });
    var iQ = N.cols.indexOf('question_id'), iR = N.cols.indexOf('response_json'), iS = N.cols.indexOf('seq'), iT = N.cols.indexOf('saved_at');
    aRows.forEach(function (r) {
      var qid = ksCellString_(r[iQ]), hit = byId[qid];
      if (!hit) { ksAddErr_(errs, 0, '', 'answer_unknown_question'); return; }
      if (Object.prototype.hasOwnProperty.call(responses, qid)) { ksAddErr_(errs, hit.position, '', 'answer_duplicate'); return; }
      if (typeof r[iR] !== 'string' || r[iR] === '') { ksAddErr_(errs, hit.position, '', 'response_malformed'); return; }
      var parsed = atParseResponse_(hit.q.type, r[iR], optionMaps[qid] || null);
      if (!parsed.ok) { ksAddErr_(errs, hit.position, '', 'response_malformed'); return; }
      var seq = atInt_(r[iS], 1), savedAt = atTime_(r[iT]);
      if (seq === null || seq > lastSeq) { ksAddErr_(errs, hit.position, '', 'answer_seq_invalid'); return; }
      if (savedAt === null || savedAt < started || savedAt >= deadline) { ksAddErr_(errs, hit.position, '', 'answer_time_invalid'); return; }   /* no answer at or after the deadline */
      responses[qid] = parsed.value;
      hashEntries.push({ position: hit.position, question_id: qid, value: parsed.value });
    });
    if (errs.length) { return { ok: false, code: 'answers_invalid', errors: errs }; }

    /* 8. Integrity: the stored hash must equal a fresh hash of the saved answers. Only then are absent answers treated as unanswered. */
    if (!ksConstantTimeEquals_(atAnswersHash_(hashEntries), answersHash)) { return { ok: false, code: 'answers_hash_mismatch' }; }

    Logger.log('AttemptStore: loaded attempt for scoring, ' + questions.length + ' question(s), ' + hashEntries.length + ' saved answer(s).');
    return {
      ok: true, code: 'ok',
      attempt: { attempt_id: attempt_id, user_id: userId, paper_id: paperId, year: paperYear, mode: ksCellString_(a.mode), status: status,
        close_reason: reason, started_at: new Date(started).toISOString(), deadline_at: new Date(deadline).toISOString(), closed_at: new Date(closedAt).toISOString(),
        duration_seconds: duration, question_count: count, total_marks: totalMarks, answers_hash: answersHash, profile_set: profileRefs,
        key_set_id: pinnedKeySetId, key_set_digest: pinnedKeySetDigest },
      scoring_input: { questions: questions, responses: responses }
    };
  });
}
