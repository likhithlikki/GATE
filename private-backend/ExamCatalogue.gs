/**
 * GATE Prep Studio PRIVATE backend: ExamCatalogue (Task 32). Owner-operated import of the validated public catalogue into EXAM_DB.questions,
 * the owner-registered paper registry, and read helpers for the private question repository.
 *
 * Standalone private Apps Script project. No doGet/doPost here. The two owner functions without a trailing underscore can be run from the
 * Apps Script editor by the project owner only; they are NOT reachable over HTTP (the router lists no such operation):
 *   admin_import_public_catalogue(options)   options (optional): { allow_withdrawals: true }
 *   admin_register_paper(paper)              paper: { paper_id, paper_code, session, title?, question_ids: [...] }
 *   admin_check_question_repository()        read-only status (counts and codes only)
 *
 * SOURCE. The public catalogue spreadsheet ID comes from Script Property PUBLIC_CATALOGUE_SPREADSHEET_ID (same name the public project uses; the
 * private project refuses it as a private database). It is opened READ-ONLY and only the "Questions_Public" tab is read. The public schema
 * (root Code.gs: schema_version 1, columns id, branch, year, subject, topic, type, marks, text, options_json, source_name) is re-validated here with
 * the same rules, plus whole-number marks <= 999 (D-23). Any forbidden, unknown or missing column, or any invalid record, rejects the whole import
 * before the repository is touched. The catalogue_version is recomputed exactly as the public project computes it, for the provenance log only.
 *
 * LICENCE. The public schema has no licence column. The licence reference therefore comes from Script Property QUESTION_LICENSE_REF (owner-supplied,
 * never inferred) and is stored on every NEW version row. The import refuses to run without it.
 *
 * VERSIONS. EXAM_DB.questions holds one row per (question_id, question_version). A row's content is never edited. content_hash = SHA-256 over a fixed
 * canonical encoding of the public record. Changed content appends version max+1; identical content changes nothing, so repeated imports are
 * idempotent. Statuses: pending (written, not yet served), active, superseded, withdrawn. The served version of an id is the highest ACTIVE one.
 * Order of writes: new rows as pending -> read back -> pending to active -> older active to superseded. A crash leaves the old content served and a
 * rerun finishes the job. Writes are not atomic across Sheets operations; this is the closest safe ordering.
 * Questions present in the repository but absent from the source are never dropped silently: the import refuses unless { allow_withdrawals: true }.
 *
 * Nothing here reads or writes KEYS_DB, so no answer key, explanation, NAT range or scoring metadata can pass through it.
 */

var QI_SCHEMA_VERSION = 1;
var QI_SHEET = 'Questions_Public';
var QI_PUBLIC_COLUMNS = ['id', 'branch', 'year', 'subject', 'topic', 'type', 'marks', 'text', 'options_json', 'source_name'];
var QI_TYPES = ['MCQ', 'MSQ', 'NAT'];
var QI_ID_RE = /^[A-Za-z0-9_.\-]{1,64}$/;
var QI_OPTION_ID_RE = /^[A-Za-z0-9_.\-]{1,16}$/;
var QI_LIMITS = { questions: 2000, text: 20000, optionText: 5000, field: 100, sourceName: 200, license: 200, issues: 20, marks: 999 };
var QI_FORBIDDEN_NAMES = ['answerkey', 'answer', 'answers', 'ans', 'correctanswer', 'correctanswers', 'correctoption', 'correctoptions', 'correct',
  'iscorrect', 'key', 'keys', 'solution', 'solutions', 'explanation', 'explanations', 'rationale', 'officialanswer', 'acceptedanswers', 'answerrange',
  'natrange', 'natmin', 'natmax', 'tolerance', 'score', 'scores', 'scoring', 'markscheme', 'markingscheme', 'markstoall', 'mta', 'secret'];
var QI_STATUSES = { pending: 1, active: 1, superseded: 1, withdrawn: 1 };
var QI_LICENSE_PROPERTY = 'QUESTION_LICENSE_REF';

function qiNorm_(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function qiNonEmpty_(v, max) { return typeof v === 'string' && v.trim().length > 0 && (!max || v.trim().length <= max); }
function qiWhole_(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }

/* ---------------------------------------------------------------------------------------------------
 * Source: open and validate the public catalogue (read-only; all-or-nothing)
 * ------------------------------------------------------------------------------------------------- */
function qiOpenPublicSheet_(props) {
  var id = ksProp_(props, KEYSTORE_PUBLIC_ID_PROPERTY);
  if (!id) { throw ksErr_('catalogue_source_unconfigured'); }
  var others = [PRIVATE_DB_PROPERTY_KEYS.AUTH_DB, PRIVATE_DB_PROPERTY_KEYS.EXAM_DB, PRIVATE_DB_PROPERTY_KEYS.KEYS_DB].map(function (k) { return ksProp_(props, k); });
  if (others.some(function (o) { return o && o === id; })) { throw ksErr_('config_conflict'); }
  var ss;
  try { ss = SpreadsheetApp.openById(id); } catch (e) { throw ksErr_('catalogue_source_unavailable'); }
  var sh = ss.getSheetByName(QI_SHEET);
  if (!sh) { throw ksErr_('catalogue_sheet_missing'); }
  return sh;
}

function qiReadHeader_(sh) {
  var lastCol = sh.getLastColumn();
  if (lastCol < 1) { throw ksErr_('catalogue_bad_columns'); }
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0], columns = {}, forbidden = false, unexpected = false, dupe = false;
  headers.forEach(function (h, i) {
    var name = String(h === null || h === undefined ? '' : h).trim();
    if (!name) { return; }
    if (QI_FORBIDDEN_NAMES.indexOf(qiNorm_(name)) >= 0) { forbidden = true; return; }
    if (QI_PUBLIC_COLUMNS.indexOf(name) < 0) { unexpected = true; return; }
    if (columns[name]) { dupe = true; return; }
    columns[name] = i + 1;
  });
  if (forbidden) { throw ksErr_('catalogue_forbidden_columns'); }
  if (unexpected || dupe) { throw ksErr_('catalogue_bad_columns'); }
  for (var i = 0; i < QI_PUBLIC_COLUMNS.length; i++) { if (!columns[QI_PUBLIC_COLUMNS[i]]) { throw ksErr_('catalogue_bad_columns'); } }
  return columns;
}

function qiValidateRow_(r) {
  var p = [];
  if (typeof r.id !== 'string' || !QI_ID_RE.test(r.id)) { p.push('id'); }
  ['branch', 'subject', 'topic'].forEach(function (f) { if (!qiNonEmpty_(r[f], QI_LIMITS.field)) { p.push(f); } });
  if (!qiWhole_(r.year) || r.year < 1900 || r.year > 2100) { p.push('year'); }
  if (QI_TYPES.indexOf(r.type) < 0) { p.push('type'); }
  if (!qiWhole_(r.marks) || r.marks <= 0 || r.marks > QI_LIMITS.marks) { p.push('marks'); }
  if (!qiNonEmpty_(r.text, QI_LIMITS.text)) { p.push('text'); }
  if (!qiNonEmpty_(r.source_name, QI_LIMITS.sourceName)) { p.push('source_name'); }
  return p;
}

function qiParseOptions_(raw, type) {
  var blank = raw === '' || raw === null || raw === undefined;
  if (type === 'NAT') { return blank ? { options: null } : { problem: 'options_json' }; }
  if (typeof raw !== 'string' || blank) { return { problem: 'options_json' }; }
  var arr;
  try { arr = JSON.parse(raw); } catch (e) { return { problem: 'options_json' }; }
  if (!Array.isArray(arr) || arr.length < 2 || arr.length > 26) { return { problem: 'options_json' }; }
  var seen = {}, out = [];
  for (var i = 0; i < arr.length; i++) {
    var o = arr[i];
    if (!o || typeof o !== 'object' || Array.isArray(o)) { return { problem: 'options_json' }; }
    var keys = Object.keys(o);
    for (var k = 0; k < keys.length; k++) { if (keys[k] !== 'id' && keys[k] !== 'text') { return { problem: 'options_json' }; } }
    if (!qiNonEmpty_(o.id, 16) || !QI_OPTION_ID_RE.test(o.id.trim()) || !qiNonEmpty_(o.text, QI_LIMITS.optionText)) { return { problem: 'options_json' }; }
    var oid = o.id.trim();
    if (seen[oid]) { return { problem: 'options_json' }; }
    seen[oid] = true;
    out.push({ id: oid, text: o.text.trim() });
  }
  return { options: out };
}

/* Returns { questions, catalogue_version } or throws ksErr_ (issues, if any, are in err.qiIssues: row numbers and field names only). */
function qiBuildCatalogue_(sh) {
  var cols = qiReadHeader_(sh), rowCount = sh.getLastRow() - 1;
  if (rowCount < 1) { throw ksErr_('catalogue_empty'); }
  if (rowCount > QI_LIMITS.questions + 500) { throw ksErr_('catalogue_too_large'); }
  var values = sh.getRange(2, 1, rowCount, sh.getLastColumn()).getValues(), questions = [], issues = [], seen = {};
  for (var i = 0; i < values.length; i++) {
    var row = values[i], r = {}, blank = true;
    QI_PUBLIC_COLUMNS.forEach(function (name) { var v = row[cols[name] - 1]; r[name] = v; if (v !== '' && v !== null && v !== undefined) { blank = false; } });
    if (blank) { continue; }
    var problems = qiValidateRow_(r), opt = { options: null };
    if (QI_TYPES.indexOf(r.type) >= 0) { opt = qiParseOptions_(r.options_json, r.type); if (opt.problem) { problems.push(opt.problem); } }
    if (!problems.length && seen[r.id]) { problems.push('id (duplicate)'); }
    if (problems.length) { issues.push('row ' + (i + 2) + ': ' + problems.join(', ')); continue; }
    seen[r.id] = true;
    var q = { id: r.id, branch: r.branch.trim(), year: r.year, subject: r.subject.trim(), topic: r.topic.trim(), type: r.type, marks: r.marks, text: r.text.trim(), source: { name: r.source_name.trim() } };
    if (opt.options) { q.options = opt.options; }
    questions.push(q);
  }
  if (issues.length) { var e = ksErr_('catalogue_malformed'); e.qiIssues = issues.slice(0, QI_LIMITS.issues); throw e; }
  if (!questions.length) { throw ksErr_('catalogue_empty'); }
  if (questions.length > QI_LIMITS.questions) { throw ksErr_('catalogue_too_large'); }
  return { questions: questions, catalogue_version: ksSha256Hex_(JSON.stringify({ schema_version: QI_SCHEMA_VERSION, questions: questions })) };
}

/* ---------------------------------------------------------------------------------------------------
 * Explicit mapping public record -> EXAM_DB.questions row. Fixed canonical encoding, so the hash is deterministic.
 * ------------------------------------------------------------------------------------------------- */
function qiContentHash_(q) {
  return ksSha256Hex_('GPS-QUESTION-V1\n' + JSON.stringify({ id: q.id, branch: q.branch, year: q.year, subject: q.subject, topic: q.topic, type: q.type, marks: q.marks,
    text: q.text, options: q.options ? q.options.map(function (o) { return { id: o.id, text: o.text }; }) : null, source_name: q.source.name }));
}
function qiRowFor_(q, version, status, hash, license) {
  return { question_id: q.id, type: q.type, marks: String(q.marks), branch: q.branch, year: String(q.year), subject: q.subject, topic: q.topic, text: q.text,
    options_json: q.options ? JSON.stringify(q.options.map(function (o) { return { id: o.id, text: o.text }; })) : '', source_ref: q.source.name, status: status,
    content_hash: hash, license_ref: license, question_version: String(version) };
}
function qiCells_(cols, obj) { return cols.map(function (c) { return obj[c] === undefined || obj[c] === null ? '' : String(obj[c]); }); }

/* ---------------------------------------------------------------------------------------------------
 * EXAM_DB write helpers (text-formatted cells, flush, read back). Callers hold the script lock.
 * ------------------------------------------------------------------------------------------------- */
function qiSameCells_(back, want) {
  if (back.length !== want.length) { return false; }
  for (var i = 0; i < want.length; i++) { if (ksCellString_(back[i]) !== want[i]) { return false; } }
  return true;
}
/* Appends rows (arrays of text cells) and verifies them. Returns the first row number. */
function qiAppendRows_(sh, ncols, rows) {
  if (!rows.length) { return sh.getLastRow() + 1; }
  var start = sh.getLastRow() + 1, need = start + rows.length - 1;
  if (sh.getMaxRows() < need) { sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows()); }
  var rng = sh.getRange(start, 1, rows.length, ncols);
  rng.setNumberFormat('@'); rng.setValues(rows); SpreadsheetApp.flush();
  var back = sh.getRange(start, 1, rows.length, ncols).getValues();
  for (var i = 0; i < rows.length; i++) { if (!qiSameCells_(back[i], rows[i])) { throw ksErr_('write_readback_failed'); } }
  return start;
}
function qiSetCell_(sh, rowNo, colIdx0, value) {
  var cell = sh.getRange(rowNo, colIdx0 + 1);
  cell.setNumberFormat('@'); cell.setValue(value); SpreadsheetApp.flush();
  if (ksCellString_(sh.getRange(rowNo, colIdx0 + 1).getValue()) !== value) { throw ksErr_('write_readback_failed'); }
}

/* ---------------------------------------------------------------------------------------------------
 * Repository reader. Validates stored state; inconsistent state is refused, never repaired silently.
 * Returns { sh, cols, rows:[{rowNo, o}], byId: { id: [row] } }.
 * ------------------------------------------------------------------------------------------------- */
function qiReadRepo_(ss) {
  var Q = atSheet_(ss, 'questions'), cols = Q.cols, n = Q.sh.getLastRow() - 1, rows = [], byId = Object.create(null), seen = Object.create(null);
  if (n >= 1) {
    var vals = Q.sh.getRange(2, 1, n, cols.length).getValues();
    for (var i = 0; i < n; i++) {
      var o = ksRowObject_(cols, vals[i].map(ksCellString_));
      if (o.question_id === '' && o.content_hash === '' && o.text === '') { continue; }   /* a blank spacer row */
      var ver = atInt_(o.question_version, 1);
      if (!QI_ID_RE.test(o.question_id) || ver === null || !QI_STATUSES[o.status] || !KS_HEX64_RE.test(o.content_hash)) { throw ksErr_('repository_inconsistent'); }
      var k = o.question_id + '|' + ver;
      if (seen[k]) { throw ksErr_('repository_inconsistent'); }
      seen[k] = true;
      var row = { rowNo: i + 2, o: o, version: ver };
      rows.push(row);
      (byId[o.question_id] = byId[o.question_id] || []).push(row);
    }
  }
  return { sh: Q.sh, cols: cols, rows: rows, byId: byId };
}
function qiActiveRow_(list) {
  var best = null;
  (list || []).forEach(function (r) { if (r.o.status === 'active' && (!best || r.version > best.version)) { best = r; } });
  return best;
}
function qiMaxVersion_(list) { var m = 0; (list || []).forEach(function (r) { if (r.version > m) { m = r.version; } }); return m; }

/* Public view of a stored question row. Never includes keys: the repository has none. */
function qiPublicView_(row, position) {
  var o = row.o, view = { question_id: o.question_id, question_version: row.version, type: o.type, marks: Number(o.marks), branch: o.branch, year: Number(o.year),
    subject: o.subject, topic: o.topic, text: o.text, options: null, source: o.source_ref };
  if (position) { view.position = position; }
  if (o.type !== 'NAT') {
    var arr;
    try { arr = JSON.parse(o.options_json); } catch (e) { throw ksErr_('repository_inconsistent'); }
    if (!Array.isArray(arr)) { throw ksErr_('repository_inconsistent'); }
    view.options = arr.map(function (x) { return { id: String(x.id), text: String(x.text) }; });
  }
  return view;
}

/* ---------------------------------------------------------------------------------------------------
 * admin_import_public_catalogue(options)
 * ------------------------------------------------------------------------------------------------- */
function admin_import_public_catalogue(options) {
  return ksRun_(function () {
    var opts = options && typeof options === 'object' ? options : {}, props = PropertiesService.getScriptProperties();
    var license = ksProp_(props, QI_LICENSE_PROPERTY);
    if (!license) { throw ksErr_('license_ref_unset'); }
    if (license.length > QI_LIMITS.license || ksHasControl_(license)) { throw ksErr_('license_ref_invalid'); }
    var built;
    try { built = qiBuildCatalogue_(qiOpenPublicSheet_(props)); }
    catch (e) {
      if (e && e.qiIssues) { Logger.log('Import: invalid catalogue records: ' + e.qiIssues.join('; ')); return { ok: false, code: e.ksCode, issues: e.qiIssues }; }
      throw e;
    }
    var ss = atOpenExam_();
    return ksWithLock_(function () {
      var repo = qiReadRepo_(ss), qcols = repo.cols, iStatus = qcols.indexOf('status'), srcIds = Object.create(null);
      built.questions.forEach(function (q) { srcIds[q.id] = true; });

      var withdraw = [];
      Object.keys(repo.byId).forEach(function (id) { if (!srcIds[id] && repo.byId[id].some(function (r) { return r.o.status === 'active'; })) { withdraw.push(id); } });
      if (withdraw.length && opts.allow_withdrawals !== true) { return { ok: false, code: 'would_withdraw_questions', count: withdraw.length }; }

      var newRows = [], promote = [], supersede = [], unchanged = 0;
      built.questions.forEach(function (q) {
        var list = repo.byId[q.id] || [], hash = qiContentHash_(q), active = qiActiveRow_(list);
        if (active && active.o.content_hash === hash) {
          unchanged++;
          list.forEach(function (r) { if (r.o.status === 'active' && r.version < active.version) { supersede.push(r.rowNo); } });   /* repair of an interrupted run */
          return;
        }
        var pend = null;
        list.forEach(function (r) { if (r.o.status === 'pending' && r.o.content_hash === hash && r.version > (active ? active.version : 0) && (!pend || r.version > pend.version)) { pend = r; } });
        if (pend) { promote.push(pend.rowNo); }
        else { newRows.push({ id: q.id, cells: qiCells_(qcols, qiRowFor_(q, qiMaxVersion_(list) + 1, 'pending', hash, license)) }); }
        list.forEach(function (r) { if (r.o.status === 'active') { supersede.push(r.rowNo); } });
      });
      var withdrawRows = [];
      withdraw.forEach(function (id) { repo.byId[id].forEach(function (r) { if (r.o.status === 'active') { withdrawRows.push(r.rowNo); } }); });

      if (!newRows.length && !promote.length && !supersede.length && !withdrawRows.length) {
        return { ok: true, code: 'unchanged', catalogue_version: built.catalogue_version, question_count: built.questions.length, new_versions: 0, unchanged: unchanged };
      }

      /* 1. New versions, written as pending and verified before anything is served. */
      var start = qiAppendRows_(repo.sh, qcols.length, newRows.map(function (r) { return r.cells; }));
      /* 2. Promote: new and previously pending rows become active. 3. Older active versions become superseded. 4. Absent ids become withdrawn. */
      for (var i = 0; i < newRows.length; i++) { qiSetCell_(repo.sh, start + i, iStatus, 'active'); }
      promote.forEach(function (rowNo) { qiSetCell_(repo.sh, rowNo, iStatus, 'active'); });
      supersede.forEach(function (rowNo) { qiSetCell_(repo.sh, rowNo, iStatus, 'superseded'); });
      withdrawRows.forEach(function (rowNo) { qiSetCell_(repo.sh, rowNo, iStatus, 'withdrawn'); });

      /* 5. Verify the end state against the source: the served version of every source id carries the source hash; no id is served twice. */
      var after = qiReadRepo_(ss);
      built.questions.forEach(function (q) {
        var act = qiActiveRow_(after.byId[q.id]);
        if (!act || act.o.content_hash !== qiContentHash_(q)) { throw ksErr_('import_verification_failed'); }
        if (after.byId[q.id].some(function (r) { return r.o.status === 'active' && r.version !== act.version; })) { throw ksErr_('import_verification_failed'); }
      });

      /* 6. Provenance log (a failure is reported, it does not undo the verified import). */
      var logStatus = 'written';
      try {
        var L = atSheet_(ss, 'question_imports');
        qiAppendRows_(L.sh, L.cols.length, [qiCells_(L.cols, { import_id: 'imp-' + ksSha256Hex_(built.catalogue_version + '\n' + ksNowIso_()).slice(0, 24), imported_at: ksNowIso_(),
          catalogue_version: built.catalogue_version, schema_version: String(QI_SCHEMA_VERSION), question_count: String(built.questions.length), new_versions: String(newRows.length),
          promoted: String(promote.length), unchanged: String(unchanged), withdrawn: String(withdraw.length), license_ref: license })]);
      } catch (e2) { logStatus = 'failed'; }
      Logger.log('Import: ' + newRows.length + ' new version(s), ' + promote.length + ' promoted, ' + unchanged + ' unchanged, ' + withdraw.length + ' withdrawn.');
      return { ok: true, code: 'imported', catalogue_version: built.catalogue_version, question_count: built.questions.length, new_versions: newRows.length, promoted: promote.length,
        unchanged: unchanged, withdrawn: withdraw.length, import_log: logStatus };
    });
  });
}

/* ---------------------------------------------------------------------------------------------------
 * Paper registry. paper_id is supplied by the owner; year is read from it (gate-YYYY-...), never guessed from the questions.
 * ------------------------------------------------------------------------------------------------- */
function qiMembershipDigest_(paperId, ids) { return ksSha256Hex_('GPS-PAPER-V1\n' + paperId + '\n' + ids.join('\n')); }

function admin_register_paper(paper) {
  return ksRun_(function () {
    if (!paper || typeof paper !== 'object' || Array.isArray(paper)) { throw ksErr_('paper_invalid'); }
    var paperId = paper.paper_id, pm = typeof paperId === 'string' && paperId.length <= 64 ? AT_PAPER_RE.exec(paperId) : null;
    if (!pm) { throw ksErr_('paper_id_invalid'); }
    var year = parseInt(pm[1], 10), code = paper.paper_code, session = paper.session, title = paper.title === undefined ? '' : paper.title;
    var field = /^[A-Za-z0-9._ \-]{1,64}$/;
    if (typeof code !== 'string' || !field.test(code) || typeof session !== 'string' || !field.test(session)) { throw ksErr_('paper_fields_missing'); }   /* never inferred */
    if (typeof title !== 'string' || title.length > 120 || ksHasControl_(title)) { throw ksErr_('paper_title_invalid'); }
    var ids = paper.question_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > AT_MAX_QUESTIONS) { throw ksErr_('paper_questions_invalid'); }
    var dup = Object.create(null);
    ids.forEach(function (id) { if (typeof id !== 'string' || !QI_ID_RE.test(id) || dup[id]) { throw ksErr_('paper_questions_invalid'); } dup[id] = true; });
    var ss = atOpenExam_();
    return ksWithLock_(function () {
      var repo = qiReadRepo_(ss);
      ids.forEach(function (id) {
        var act = qiActiveRow_(repo.byId[id]);
        if (!act) { throw ksErr_('paper_question_not_active'); }
        if (parseInt(act.o.year, 10) !== year) { throw ksErr_('paper_question_year_mismatch'); }
      });
      var P = atSheet_(ss, 'papers'), M = atSheet_(ss, 'paper_questions'), digest = qiMembershipDigest_(paperId, ids);
      var existing = exRowsWhere_(P.sh, P.cols, 'paper_id', paperId);
      if (existing.length > 1) { throw ksErr_('paper_registry_inconsistent'); }
      var have = exRowsWhere_(M.sh, M.cols, 'paper_id', paperId), haveByPos = Object.create(null), missing = [];
      have.forEach(function (r) {
        var pos = atInt_(r.o.position, 1);
        if (pos === null || haveByPos[pos] || ids[pos - 1] !== r.o.question_id) { throw ksErr_('paper_conflict'); }   /* membership is immutable */
        haveByPos[pos] = true;
      });
      if (existing.length) {
        var e = existing[0].o;
        if (e.membership_digest !== digest || e.paper_code !== code || e.session !== session || e.year !== String(year) || e.question_count !== String(ids.length)) { throw ksErr_('paper_conflict'); }
      }
      for (var i = 0; i < ids.length; i++) { if (!haveByPos[i + 1]) { missing.push(qiCells_(M.cols, { paper_id: paperId, position: String(i + 1), question_id: ids[i] })); } }
      if (missing.length) { qiAppendRows_(M.sh, M.cols.length, missing); }
      var created = false;
      if (!existing.length) {   /* the papers row is written LAST: it is the commit marker */
        qiAppendRows_(P.sh, P.cols.length, [qiCells_(P.cols, { paper_id: paperId, year: String(year), paper_code: code, session: session, title: title, status: 'active',
          question_count: String(ids.length), membership_digest: digest, created_at: ksNowIso_(), created_by: 'owner' })]);
        created = true;
      }
      var back = exRowsWhere_(M.sh, M.cols, 'paper_id', paperId);
      if (back.length !== ids.length) { throw ksErr_('paper_readback_failed'); }
      return { ok: true, code: created ? 'registered' : (missing.length ? 'membership_completed' : 'unchanged'), paper_id: paperId, question_count: ids.length };
    });
  });
}

/* All rows of a tab whose column equals value: [{rowNo, o}] with text cells. */
function exRowsWhere_(sh, cols, col, value) {
  var n = sh.getLastRow() - 1, out = [];
  if (n < 1) { return out; }
  var i0 = cols.indexOf(col), vals = sh.getRange(2, 1, n, cols.length).getValues();
  for (var i = 0; i < n; i++) { if (ksCellString_(vals[i][i0]) === value) { out.push({ rowNo: i + 2, o: ksRowObject_(cols, vals[i].map(ksCellString_)) }); } }
  return out;
}

/* A registered, active paper with verified membership. Returns { paper, members:[question_id in position order] } or null if unknown/inactive.
 * Throws ksErr_('paper_registry_inconsistent') if stored membership disagrees with its own digest. */
function exLoadPaper_(ss, paperId) {
  if (typeof paperId !== 'string' || !AT_PAPER_RE.test(paperId) || paperId.length > 64) { return null; }
  var P = atSheet_(ss, 'papers'), M = atSheet_(ss, 'paper_questions'), rows = exRowsWhere_(P.sh, P.cols, 'paper_id', paperId);
  if (!rows.length) { return null; }
  if (rows.length > 1) { throw ksErr_('paper_registry_inconsistent'); }
  var p = rows[0].o;
  if (p.status !== 'active') { return null; }
  var count = atInt_(p.question_count, 1), year = atInt_(p.year, 1), mem = exRowsWhere_(M.sh, M.cols, 'paper_id', paperId), ids = [];
  if (count === null || year === null || mem.length !== count || count > AT_MAX_QUESTIONS || year !== parseInt(AT_PAPER_RE.exec(paperId)[1], 10)) { throw ksErr_('paper_registry_inconsistent'); }
  mem.forEach(function (r) {
    var pos = atInt_(r.o.position, 1);
    if (pos === null || pos > count || ids[pos - 1] !== undefined || !QI_ID_RE.test(r.o.question_id)) { throw ksErr_('paper_registry_inconsistent'); }
    ids[pos - 1] = r.o.question_id;
  });
  for (var i = 0; i < count; i++) { if (ids[i] === undefined) { throw ksErr_('paper_registry_inconsistent'); } }
  if (!ksConstantTimeEquals_(qiMembershipDigest_(paperId, ids), p.membership_digest)) { throw ksErr_('paper_registry_inconsistent'); }
  return { paper: { paper_id: paperId, year: year, paper_code: p.paper_code, session: p.session, title: p.title }, members: ids };
}

function exAllPaperIds_(ss) {
  var P = atSheet_(ss, 'papers'), n = P.sh.getLastRow() - 1, out = [];
  if (n < 1) { return out; }
  P.sh.getRange(2, 1, n, P.cols.length).getValues().forEach(function (r) {
    var o = ksRowObject_(P.cols, r.map(ksCellString_));
    if (o.status === 'active' && AT_PAPER_RE.test(o.paper_id)) { out.push(o.paper_id); }
  });
  return out;
}

/* Read-only owner status: counts and codes only. */
function admin_check_question_repository() {
  return ksRun_(function () {
    var ss = atOpenExam_(), repo = qiReadRepo_(ss), counts = { active: 0, pending: 0, superseded: 0, withdrawn: 0 }, ids = Object.keys(repo.byId), served = 0;
    repo.rows.forEach(function (r) { counts[r.o.status]++; });
    ids.forEach(function (id) { if (qiActiveRow_(repo.byId[id])) { served++; } });
    var papers = exAllPaperIds_(ss).length, props = PropertiesService.getScriptProperties();
    var report = { ok: true, code: 'ok', question_ids: ids.length, served_questions: served, rows_by_status: counts, registered_papers: papers,
      license_ref: ksProp_(props, QI_LICENSE_PROPERTY) ? 'present' : 'missing', question_publication_gate: exGate_('question_publication') ? 'on' : 'off' };
    Logger.log('Repository: ' + served + ' served question(s), ' + papers + ' registered paper(s), publication gate ' + report.question_publication_gate + '.');
    return report;
  });
}
