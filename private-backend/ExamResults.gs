/**
 * GATE Prep Studio PRIVATE backend: ExamResults (Task 33). Protected scoring and result operations, connecting the authenticated session to the
 * existing scoring pipeline. Router operations: score_attempt, get_result, get_result_review.
 *
 * This file adds NO scoring logic. It calls ssScoreAndCommitAttempt_ / ssGetCommittedResult_ (ScoringService.gs), which in turn use AttemptStore.gs,
 * KeyStore.gs and Scoring.gs unchanged: exact fractions, the results header as the commit marker, no automatic rescoring, no revision replacement,
 * and every SCORING_POLICY_* gate default OFF (scPolicyFromProperties_). A blocked score shows no total.
 *
 * Authorisation: the user id comes from the validated session. The attempt row is read FIRST and must belong to that user, otherwise the answer is
 * the same not_found as for an unknown id. ScoringService itself performs no authorisation, so nothing is delegated to it. After retrieval the
 * committed result's user_id is compared with the session user once more.
 *
 * What leaves this file: ids, status, counts, exact fractions (num/den) and marks. Never key ids, key digests, correct options, NAT ranges or
 * explanations. get_result_review stays blocked until the owner turns on EXAM_POLICY_ANSWER_REVIEW (D-18). Even then it returns only the user's
 * own response and the per-question outcome and award; answer keys, correct options, NAT ranges and explanations have NO code path here
 * (release is AK-08 and is not implemented).
 *
 * Failure mapping: a blocked policy becomes feature_disabled with a lowercase reason; integrity errors become server_error (the audit row is already
 * written by ScoringService); the commit status and the audit status ScoringService reports are passed through unchanged so a persistence or audit
 * failure is visible, and a retry is safe because commit is idempotent.
 */

function exReasonOf_(r) {
  if (r.code === 'keys_unavailable') { return 'answer_keys_unavailable'; }
  var s = typeof r.reason === 'string' && r.reason ? r.reason : String(r.code || 'blocked');
  return /^[a-z0-9_]{1,64}$/.test(s) ? s : 'blocked';
}

function exResultSummary_(res) {
  return { result_id: res.result_id, attempt_id: res.attempt_id, status: res.status, score_revision: res.score_revision, total: { num: res.total.num, den: res.total.den },
    total_text: res.total_text, max_marks: res.max_marks, item_count: res.item_count, counts: { correct: res.counts.correct, wrong: res.counts.wrong,
    unanswered: res.counts.unanswered, marks_to_all: res.counts.marks_to_all }, profile: exProfileLabels_(res.profile_set), created_at: res.created_at };
}

/* Throws for failures; returns r unchanged for ok results. */
function exRequireScoringOk_(r, uid) {
  if (r && r.ok === true) {
    if (!r.result || r.result.user_id !== uid) { Logger.log('Exam: result owner mismatch.'); throw acErr_('not_found'); }
    return r;
  }
  var st = r && r.status, code = r && r.code ? String(r.code) : 'error';
  if (st === 'blocked') { throw acErr_('feature_disabled', exReasonOf_(r)); }
  if (st === 'not_found') { throw acErr_('not_found'); }
  if (st === 'not_scorable') { throw acErr_('conflict', /^[a-z0-9_]{1,64}$/.test(code) ? code : 'not_scorable'); }
  if (code === 'busy') { throw acErr_('busy'); }
  throw acErr_('scoring_' + (st || 'error'));   /* integrity_error, error, refused: not shown to the browser */
}

function opScoreAttempt_(p, token) {
  acDb_();
  var s = asRequireSession_(token), uid = s.user.user_id;
  exCheckKeys_(p, { attempt_id: 1 });
  var id = exAttemptId_(p), C = exCtx_(), att = exExpireIfDue_(C, exOwned_(C, id, uid), uid);
  if (att.status === 'in_progress') { throw acErr_('conflict', 'attempt_not_closed'); }
  var r = exRequireScoringOk_(ssScoreAndCommitAttempt_(id), uid);
  return { code: 'ok', data: { attempt_id: id, status: 'scored', commit_status: r.code, rescored: r.rescored === true, audit: typeof r.audit === 'string' ? r.audit : null, result: exResultSummary_(r.result) } };
}

function opGetResult_(p, token) {
  acDb_();
  var s = asRequireSession_(token), uid = s.user.user_id;
  exCheckKeys_(p, { attempt_id: 1 });
  var id = exAttemptId_(p), C = exCtx_(), att = exOwned_(C, id, uid);
  if (att.status === 'in_progress') { return { code: 'ok', data: { attempt_id: id, available: false, attempt_status: att.status, reason: 'attempt_not_closed' } }; }
  var r = ssGetCommittedResult_(id);
  if (r && r.ok === false && r.status === 'not_scorable' && (r.code === 'result_not_committed' || r.code === 'attempt_not_closed')) {
    return { code: 'ok', data: { attempt_id: id, available: false, attempt_status: att.status, reason: r.code } };
  }
  r = exRequireScoringOk_(r, uid);
  return { code: 'ok', data: { attempt_id: id, available: true, attempt_status: att.status, result: exResultSummary_(r.result) } };
}

function opGetResultReview_(p, token) {
  acDb_();
  var s = asRequireSession_(token), uid = s.user.user_id;
  exCheckKeys_(p, { attempt_id: 1 });
  var id = exAttemptId_(p);
  if (!exGate_('answer_review')) { throw acErr_('feature_disabled', 'answer_review_unresolved_d18'); }
  var C = exCtx_(), att = exOwned_(C, id, uid);
  var r = exRequireScoringOk_(ssGetCommittedResult_(id), uid);
  var info = exPinnedInfo_(C, att), st = exStored_(C, att, info), byQ = Object.create(null);
  r.items.forEach(function (it) { byQ[it.question_id] = it; });
  var items = info.map(function (x) {
    var it = byQ[x.question_id], saved = st.byQ[x.question_id];
    if (!it) { throw acErr_('scoring_integrity_error'); }
    return { position: x.position, question_id: x.question_id, type: x.type, marks: x.marks, your_response: saved ? saved.value : (x.type === 'MSQ' ? [] : ''), outcome: it.outcome,
      awarded: { num: it.awarded.num, den: it.awarded.den } };
  });
  return { code: 'ok', data: { attempt_id: id, result: exResultSummary_(r.result), items: items, answer_keys_released: false, explanations_released: false } };
}
