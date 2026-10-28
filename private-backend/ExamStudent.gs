/**
 * GATE Prep Studio PRIVATE backend: ExamStudent (Task 34 support). Per-user read operations and bookmarks for the student pages.
 * Router operations: list_attempts, list_bookmarks, add_bookmark, remove_bookmark, profile_get. All are session operations: the user id is the
 * validated session's, never a payload field, and every row touched is filtered by that id.
 *
 * list_attempts returns only the session user's attempts (status and timing, no answers, no scores; a score is fetched per attempt through the
 * ownership-checked, integrity-verified get_result). Expired in-progress attempts are closed when listed.
 * Bookmarks live in EXAM_DB.bookmarks (user_id, question_id, created_at). Adding requires a question that is currently served; question text is
 * returned only while the question-publication gate (D-07) is on.
 * profile_get returns the account fields the users schema holds. The schema has no branch or target-year field and none is invented.
 */

var ES_MAX_BOOKMARKS = 500;
var ES_LIST_LIMIT = 50;

function opListAttempts_(p, token) {
  acDb_();
  var s = asRequireSession_(token), uid = s.user.user_id;
  exCheckKeys_(p, {});
  var C = exCtx_(), now = acNow_(), list = [], unreadable = 0;
  exRowsWhere_(C.A.sh, C.A.cols, 'user_id', uid).forEach(function (r) { try { list.push(exParseAttempt_(r)); } catch (e) { unreadable++; } });
  if (list.some(function (a) { return a.status === 'in_progress' && now >= a.deadline; })) {
    acWithLock_(function () {
      list = list.map(function (a) {
        if (a.status !== 'in_progress' || acNow_() < a.deadline) { return a; }
        var fresh = exOwned_(C, a.attempt_id, uid);
        return exCloseDue_(C, fresh, uid, acNow_());
      });
    });
  }
  var counts = { total: list.length, in_progress: 0, closed: 0, scored: 0 };
  list.forEach(function (a) { if (counts[a.status] !== undefined) { counts[a.status]++; } });
  list.sort(function (a, b) { return b.started - a.started; });
  var out = list.slice(0, ES_LIST_LIMIT).map(function (a) {
    var m = exAttemptMeta_(a, now);
    return { attempt_id: m.attempt_id, mode: m.mode, paper_id: m.paper_id, status: m.status, close_reason: m.close_reason, question_count: m.question_count, total_marks: m.total_marks,
      duration_seconds: m.duration_seconds, started_at: m.started_at, deadline_at: m.deadline_at, closed_at: m.closed_at, submitted_at: m.submitted_at, remaining_ms: m.remaining_ms,
      result_available: a.status === 'scored' };
  });
  return { code: 'ok', data: { attempts: out, counts: counts, unreadable: unreadable, truncated: list.length > ES_LIST_LIMIT, server_time: exIso_(now) } };
}

function opListBookmarks_(p, token) {
  acDb_();
  var s = asRequireSession_(token), uid = s.user.user_id;
  exRequireOpen_();
  exCheckKeys_(p, {});
  var ss = atOpenExam_(), B = atSheet_(ss, 'bookmarks'), repo = qiReadRepo_(ss);
  var rows = exRowsWhere_(B.sh, B.cols, 'user_id', uid).sort(function (a, b) { return a.o.created_at < b.o.created_at ? 1 : -1; });
  var items = rows.map(function (r) {
    var act = qiActiveRow_(repo.byId[r.o.question_id]);
    if (!act) { return { question_id: r.o.question_id, created_at: r.o.created_at, available: false }; }
    var v = qiPublicView_(act); v.created_at = r.o.created_at; v.available = true;
    return v;
  });
  return { code: 'ok', data: { bookmarks: items, count: items.length } };
}

function esQuestionId_(p) {
  exCheckKeys_(p, { question_id: 1 });
  if (typeof p.question_id !== 'string' || !AT_ID_RE.test(p.question_id)) { throw acErr_('payload_invalid'); }
  return p.question_id;
}

function opAddBookmark_(p, token) {
  acDb_();
  var s = asRequireSession_(token), uid = s.user.user_id;
  exRequireOpen_();
  var qid = esQuestionId_(p), ss = atOpenExam_(), B = atSheet_(ss, 'bookmarks');
  return acWithLock_(function () {
    if (!qiActiveRow_(qiReadRepo_(ss).byId[qid])) { throw acErr_('not_found'); }
    var mine = exRowsWhere_(B.sh, B.cols, 'user_id', uid);
    if (mine.some(function (r) { return r.o.question_id === qid; })) { return { code: 'ok', data: { question_id: qid, bookmarked: true, created: false } }; }
    if (mine.length >= ES_MAX_BOOKMARKS) { throw acErr_('conflict', 'bookmark_limit'); }
    exAppend_(B.sh, B.cols, [{ user_id: uid, question_id: qid, created_at: exIso_(acNow_()) }]);
    return { code: 'ok', data: { question_id: qid, bookmarked: true, created: true } };
  });
}

function opRemoveBookmark_(p, token) {
  acDb_();
  var s = asRequireSession_(token), uid = s.user.user_id;
  var qid = esQuestionId_(p), ss = atOpenExam_(), B = atSheet_(ss, 'bookmarks');
  return acWithLock_(function () {
    var hits = exRowsWhere_(B.sh, B.cols, 'user_id', uid).filter(function (r) { return r.o.question_id === qid; });
    hits.sort(function (a, b) { return b.rowNo - a.rowNo; }).forEach(function (r) { B.sh.deleteRow(r.rowNo); });   /* bottom-up so row numbers stay valid */
    SpreadsheetApp.flush();
    if (exRowsWhere_(B.sh, B.cols, 'user_id', uid).some(function (r) { return r.o.question_id === qid; })) { throw acErr_('write_failed'); }
    return { code: 'ok', data: { question_id: qid, bookmarked: false, removed: hits.length > 0 } };
  });
}

function opProfileGet_(p, token) {
  acDb_();
  var s = asRequireSession_(token);
  exCheckKeys_(p, {});
  var u = s.user;
  return { code: 'ok', data: { username: u.username, full_name: u.full_name, email: u.email, email_verified_at: u.email_verified_at || null, role: u.role, created_at: u.created_at || null,
    last_login_at: u.last_login_at || null, consent_version: u.consent_version || null, consent_at: u.consent_at || null } };
}
