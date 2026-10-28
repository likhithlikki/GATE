/**
 * GATE Prep Studio PRIVATE backend: KeyStore (Task 25). Answer-key STAGING and INTEGRITY helpers only.
 *
 * Part of the standalone private Apps Script project (same project as Schemas.gs and Setup.gs). No doGet/doPost,
 * no web app, no HTTP route, no connection to the public website. Functions without a trailing underscore are
 * owner-run editor functions (ANSWER_KEY_SCORING_SPEC.md 5.7); everything else is internal.
 *
 * Implemented here:
 *   admin_stage_keys(batch_id, rows)    validate, then write rows to KEYS_DB.key_staging (retry-safe, read-back verified)
 *   admin_validate_batch(batch_id)      re-read the staged rows, re-validate (spec 4.4), mark the batch validated
 *   admin_approve_batch(batch_id, approver)   guarded, resumable approval of a validated batch (Task 26)
 *   admin_check_keystore_config()       read-only configuration status (booleans and codes, never values)
 *   Integrity helpers (internal): canonical row serialization, HMAC-SHA256 row_mac, key-set manifest and digest.
 *
 * NOT implemented (later tasks, deliberately): correction, withdrawal, dispute resolution, rescoring, candidate scoring.
 * Only admin_approve_batch writes answer_keys and key_sets. admin_approve_batch and admin_open_key_dispute (Task 36, end of file) append key_events;
 * each writes one audit_logs row in AUTH_DB.
 *
 * Output rules: results and logs carry row numbers and short error codes only. Never answer values, NAT bounds,
 * whole records, batch ids, spreadsheet ids or the MAC secret.
 *
 * Owner-side configuration (Script Properties of THIS private project):
 *   KEYS_DB_ID                  required. Must differ from AUTH_DB_ID, EXAM_DB_ID and PUBLIC_CATALOGUE_SPREADSHEET_ID.
 *   EXAM_DB_ID                  required for staging: staged rows are cross-checked against EXAM_DB.questions (read only).
 *   KEY_ROW_MAC_SECRET_V1       required only for the integrity helpers (at least 32 characters, random, owner-generated).
 *                               Staging does not use it. Never generated or defaulted by code.
 *   KEY_APPROVED_SOURCE_HOSTS   optional. Comma-separated extra official hosts. Without it only gate<year>.iitg.ac.in passes.
 *   KEY_ALLOW_SAME_ENTERER_VERIFIER   optional. 'true' records the owner's AK-10 decision that one person may enter and verify.
 */

var KEYSTORE_MAC_SECRET_PROPERTY = 'KEY_ROW_MAC_SECRET_V1';
var KEYSTORE_HOSTS_PROPERTY = 'KEY_APPROVED_SOURCE_HOSTS';
var KEYSTORE_SAME_PERSON_PROPERTY = 'KEY_ALLOW_SAME_ENTERER_VERIFIER';
var KEYSTORE_PUBLIC_ID_PROPERTY = 'PUBLIC_CATALOGUE_SPREADSHEET_ID';   /* same name the public project uses; refused as a private DB */
var KEYSTORE_LOCK_WAIT_MS = 30000;
var KEYSTORE_MAX_BATCH_ROWS = 200;
var KEYSTORE_MAX_ERRORS = 200;
var KEYSTORE_MIN_SECRET_LENGTH = 32;

/* Verified marking-profile references. ANSWER_KEY_SCORING_SPEC.md S-5 and S-9: only GATE 2026 is verified; every other year stays
 * unverified. This list records that fact; it approves nothing new. Any other profile_id@version returns blocked_policy. */
var KEYSTORE_VERIFIED_PROFILES = { 'GATE-2026@1': { year: '2026' } };

/* Codes that mean "an owner decision is unresolved", not "the record is malformed". */
var KEYSTORE_POLICY_CODES = {
  profile_reference_missing: true,
  profile_unverified: true,
  source_host_not_approved: true,
  same_person_not_permitted: true,
  approver_not_distinct: true
};

var KS_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
var KS_HEX64_RE = /^[0-9a-f]{64}$/;
var KS_INT_FIELDS = { year: /^\d{4}$/, question_version: /^[1-9]\d{0,8}$/, master_qno: /^[1-9]\d{0,4}$/, marks: /^[1-9]\d{0,2}$/,
  nat_scale: /^(0|[1-9]\d?)$/, profile_version: /^[1-9]\d{0,8}$/, revision: /^[1-9]\d{0,8}$/ };
var KS_BOOL_FIELDS = { nat_lo_inclusive: true, nat_hi_inclusive: true };
var KS_BATCH_CONSTANT_FIELDS = ['paper_id', 'year', 'paper_code', 'session', 'profile_id', 'profile_version', 'source_name',
  'source_url', 'source_sha256', 'source_stage', 'entered_by', 'verified_by'];
var KS_SYSTEM_STAGING_COLUMNS = { batch_id: true, staging_row: true, staging_status: true, staged_at: true, validated_at: true,
  decided_at: true, decided_by: true };

/* ======================================================================================================
 * Errors, locking, configuration
 * ==================================================================================================== */
function ksErr_(code) { var e = new Error('KeyStore ' + code); e.name = 'KeyStoreError'; e.ksCode = code; return e; }

function ksRun_(fn) {
  try { return fn(); }
  catch (e) {
    if (e && e.ksCode) { Logger.log('KeyStore: stopped (' + e.ksCode + ').'); return { ok: false, code: e.ksCode }; }
    Logger.log('KeyStore: unexpected error (' + String(e && e.name ? e.name : 'Error') + ').');
    return { ok: false, code: 'internal_error' };
  }
}

function ksWithLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(KEYSTORE_LOCK_WAIT_MS)) { throw ksErr_('busy'); }
  try { return fn(); } finally { lock.releaseLock(); }
}

function ksProp_(props, name) { var v = props.getProperty(name); return v && String(v).trim() ? String(v).trim() : ''; }

/* Reads and checks the three IDs, then opens KEYS_DB and EXAM_DB. AUTH_DB is never opened here. */
function ksOpen_() {
  var props = PropertiesService.getScriptProperties();
  var keysId = ksProp_(props, PRIVATE_DB_PROPERTY_KEYS.KEYS_DB);
  var examId = ksProp_(props, PRIVATE_DB_PROPERTY_KEYS.EXAM_DB);
  var authId = ksProp_(props, PRIVATE_DB_PROPERTY_KEYS.AUTH_DB);
  var publicId = ksProp_(props, KEYSTORE_PUBLIC_ID_PROPERTY);
  if (!keysId || !examId) { throw ksErr_('config_missing'); }
  if (keysId === examId || (authId && keysId === authId) || (publicId && (keysId === publicId || examId === publicId))) {
    throw ksErr_('config_conflict');
  }
  var keys, exam;
  try { keys = SpreadsheetApp.openById(keysId); } catch (e1) { throw ksErr_('keys_db_unavailable'); }
  try { exam = SpreadsheetApp.openById(examId); } catch (e2) { throw ksErr_('exam_db_unavailable'); }
  return { keys: keys, exam: exam, props: props };
}

/* The sheet header must start with exactly the schema columns. Anything else is refused, never reconciled here. */
function ksSheet_(ss, tab, columns) {
  var sh = ss.getSheetByName(tab);
  if (!sh) { throw ksErr_('schema_missing'); }
  var n = columns.length;
  if (sh.getLastRow() < 1 || sh.getLastColumn() < n) { throw ksErr_('schema_mismatch'); }
  var head = sh.getRange(1, 1, 1, n).getValues()[0];
  for (var i = 0; i < n; i++) { if (String(head[i]).trim() !== columns[i]) { throw ksErr_('schema_mismatch'); } }
  return sh;
}

function ksStagingColumns_() { return PRIVATE_DB_SCHEMAS.KEYS_DB.key_staging.columns; }
function ksInputFields_() { return ksStagingColumns_().filter(function (c) { return !KS_SYSTEM_STAGING_COLUMNS[c]; }); }

/* Read-only configuration status. Booleans and codes only; no IDs, no secret. */
function admin_check_keystore_config() {
  return ksRun_(function () {
    var props = PropertiesService.getScriptProperties();
    var secret = ksProp_(props, KEYSTORE_MAC_SECRET_PROPERTY);
    var report = { ok: true, code: 'ok', mac_secret: !secret ? 'missing' : secret.length < KEYSTORE_MIN_SECRET_LENGTH ? 'too_short' : 'present' };
    var ctx = ksOpen_();
    ksSheet_(ctx.keys, 'key_staging', ksStagingColumns_());
    ksSheet_(ctx.keys, 'answer_keys', ANSWER_KEY_COLUMNS);
    report.keys_db = 'ok'; report.exam_db = 'ok'; report.staging_schema = 'ok';
    Logger.log('KeyStore config: mac_secret=' + report.mac_secret + ', databases and schemas reachable.');
    return report;
  });
}

/* ======================================================================================================
 * Cell and decimal helpers
 * ==================================================================================================== */
function ksCellString_(v) {
  if (v === null || v === undefined) { return ''; }
  if (v instanceof Date) { return '\u0000date'; }   /* never equals any valid text: a coerced date is a mismatch */
  if (typeof v === 'boolean') { return v ? 'true' : 'false'; }
  return String(v);
}

function ksNowIso_() { return new Date().toISOString(); }
function ksHasControl_(s) { return /[\u0000-\u001f\u007f]/.test(s); }

/* Strict decimal: optional minus, digits, optional .digits. No plus, no exponent, no comma. */
function ksParseDecimal_(s) {
  if (typeof s !== 'string' || s.length > 32 || !/^-?\d+(\.\d+)?$/.test(s)) { return null; }
  var neg = s.charAt(0) === '-', body = neg ? s.slice(1) : s, parts = body.split('.');
  var ip = parts[0].replace(/^0+(?=\d)/, ''), fp = parts.length > 1 ? parts[1] : '';
  if (/^0*$/.test(ip) && /^0*$/.test(fp)) { neg = false; }   /* -0 equals 0 */
  return { neg: neg, ip: ip, fp: fp };
}

function ksCmpDecimal_(a, b) {
  if (a.neg !== b.neg) { return a.neg ? -1 : 1; }
  var sign = a.neg ? -1 : 1, ia = a.ip, ib = b.ip;
  if (ia.length !== ib.length) { return (ia.length < ib.length ? -1 : 1) * sign; }
  if (ia !== ib) { return (ia < ib ? -1 : 1) * sign; }
  var w = Math.max(a.fp.length, b.fp.length), fa = a.fp, fb = b.fp;
  while (fa.length < w) { fa += '0'; }
  while (fb.length < w) { fb += '0'; }
  if (fa === fb) { return 0; }
  return (fa < fb ? -1 : 1) * sign;
}

function ksValidDate_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})(T(\d{2}):(\d{2})(:(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(s);
  if (!m) { return false; }
  var y = +m[1], mo = +m[2], d = +m[3], t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) { return false; }
  if (m[5] !== undefined && (+m[5] > 23 || +m[6] > 59 || (m[8] !== undefined && +m[8] > 59))) { return false; }
  return true;
}

/* ======================================================================================================
 * Row normalisation and validation
 * ==================================================================================================== */
/* Turns one input row into a map of plain strings. Records errors; never alters a value except integer/boolean text form. */
function ksNormalizeRow_(raw, rowNo, errs) {
  var out = {}, fields = ksInputFields_(), allowed = {};
  fields.forEach(function (f) { allowed[f] = true; });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { ksAddErr_(errs, rowNo, '', 'row_not_object'); return null; }
  Object.keys(raw).forEach(function (k) {
    if (!allowed[k]) { ksAddErr_(errs, rowNo, '', 'unknown_field'); }   /* includes system-assigned fields: key_id, row_mac, status, ... */
  });
  fields.forEach(function (f) {
    var v = raw[f], s;
    if (v === null || v === undefined) { out[f] = ''; return; }
    if (KS_BOOL_FIELDS[f]) {
      if (typeof v === 'boolean') { s = v ? 'true' : 'false'; }
      else if (typeof v === 'string' && /^(true|false)$/i.test(v)) { s = v.toLowerCase(); }
      else { ksAddErr_(errs, rowNo, f, 'bad_type'); out[f] = ''; return; }
      out[f] = s; return;
    }
    if (KS_INT_FIELDS[f] && typeof v === 'number') {
      if (!isFinite(v) || Math.floor(v) !== v) { ksAddErr_(errs, rowNo, f, 'bad_type'); out[f] = ''; return; }
      out[f] = String(v); return;
    }
    if (typeof v !== 'string') { ksAddErr_(errs, rowNo, f, 'bad_type'); out[f] = ''; return; }   /* NAT bounds must arrive as text, never as numbers */
    if (v !== v.trim() || ksHasControl_(v) || v.length > 2048) { ksAddErr_(errs, rowNo, f, 'bad_format'); out[f] = ''; return; }
    out[f] = v;
  });
  return out;
}

function ksAddErr_(errs, rowNo, field, code) {
  if (errs.length < KEYSTORE_MAX_ERRORS) { errs.push({ row: rowNo, field: field, code: code }); }
}

function ksParseOptionIds_(json) {
  var parsed;
  try { parsed = JSON.parse(json); } catch (e) { return null; }
  var ids = [];
  if (Array.isArray(parsed)) {
    for (var i = 0; i < parsed.length; i++) {
      if (!parsed[i] || typeof parsed[i] !== 'object' || typeof parsed[i].id !== 'string' || !KS_ID_RE.test(parsed[i].id)) { return null; }
      ids.push(parsed[i].id);
    }
  } else if (parsed && typeof parsed === 'object') {
    ids = Object.keys(parsed);
    for (var j = 0; j < ids.length; j++) { if (!KS_ID_RE.test(ids[j])) { return null; } }
  } else { return null; }
  var seen = {};
  for (var k = 0; k < ids.length; k++) { if (seen[ids[k]]) { return null; } seen[ids[k]] = true; }
  return ids.length ? seen : null;
}

/* Reads the EXAM_DB.questions columns the cross-check needs, by header name. Returns a lookup by question_id. */
function ksLoadQuestions_(examSs, ids) {
  var sh = examSs.getSheetByName('questions');
  if (!sh || sh.getLastRow() < 1) { throw ksErr_('exam_schema_missing'); }
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (v) { return String(v).trim(); });
  var need = ['question_id', 'type', 'marks', 'year', 'content_hash', 'question_version', 'options_json'], col = {};
  for (var i = 0; i < need.length; i++) {
    col[need[i]] = head.indexOf(need[i]);
    if (col[need[i]] < 0) { throw ksErr_('exam_schema_mismatch'); }
  }
  var n = sh.getLastRow() - 1, out = {}, want = {};
  ids.forEach(function (id) { want[id] = true; });
  if (n < 1) { return out; }
  var cols = {};
  need.forEach(function (c) { cols[c] = sh.getRange(2, col[c] + 1, n, 1).getValues(); });
  for (var r = 0; r < n; r++) {
    var id = ksCellString_(cols.question_id[r][0]);
    if (!want[id]) { continue; }
    (out[id] = out[id] || []).push({
      type: ksCellString_(cols.type[r][0]), marks: ksCellString_(cols.marks[r][0]), year: ksCellString_(cols.year[r][0]),
      content_hash: ksCellString_(cols.content_hash[r][0]), question_version: ksCellString_(cols.question_version[r][0]),
      options_json: ksCellString_(cols.options_json[r][0])
    });
  }
  return out;
}

/* Existing approved keys (read only), to check revision continuity. Returns map "id|version" -> [{key_id, revision}]. */
function ksLoadExistingKeys_(keysSs, excludeKeySetId) {
  var sh = ksSheet_(keysSs, 'answer_keys', ANSWER_KEY_COLUMNS), n = sh.getLastRow() - 1, out = {};
  if (n < 1) { return out; }
  var c = ANSWER_KEY_COLUMNS, vals = sh.getRange(2, 1, n, c.length).getValues();
  var iSet = c.indexOf('key_set_id'), iId = c.indexOf('key_id'), iQ = c.indexOf('question_id'), iV = c.indexOf('question_version'), iR = c.indexOf('revision');
  vals.forEach(function (row) {
    var q = ksCellString_(row[iQ]);
    if (!q) { return; }
    if (excludeKeySetId && ksCellString_(row[iSet]) === excludeKeySetId) { return; }   /* rows of the batch being (re)approved */
    var k = q + '|' + ksCellString_(row[iV]);
    (out[k] = out[k] || []).push({ key_id: ksCellString_(row[iId]), revision: ksCellString_(row[iR]) });
  });
  return out;
}

/* Validates a list of normalised rows. rows[i] corresponds to row number i+1. Returns {errors:[...]} (policy codes included). */
function ksValidateRows_(rows, ctx, errs) {
  var props = ctx.props;
  var extraHosts = ksProp_(props, KEYSTORE_HOSTS_PROPERTY).toLowerCase().split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var samePersonOk = !!ctx.approvedSet || ksProp_(props, KEYSTORE_SAME_PERSON_PROPERTY).toLowerCase() === 'true';   /* ctx.approvedSet: approval-time policies are not re-litigated by the loader */
  var ids = [];
  rows.forEach(function (r) { if (r && KS_ID_RE.test(r.question_id)) { ids.push(r.question_id); } });
  var questions = ksLoadQuestions_(ctx.exam, ids);
  var existing = ksLoadExistingKeys_(ctx.keys, ctx.excludeKeySetId || '');
  var seenQ = {}, seenNo = {}, first = null;

  rows.forEach(function (r, idx) {
    var n = idx + 1;
    if (!r) { return; }
    function bad(field, code) { ksAddErr_(errs, n, field, code); }
    function req(field) { if (r[field] === '') { bad(field, 'missing_field'); return false; } return true; }

    ['paper_id', 'year', 'paper_code', 'session', 'question_id', 'question_version', 'content_hash', 'master_qno', 'section', 'type',
      'marks', 'key_kind', 'source_name', 'source_url', 'source_sha256', 'source_retrieved_at', 'source_stage', 'entered_by',
      'verified_by', 'entry_method', 'revision'].forEach(req);

    /* Field formats. */
    Object.keys(KS_INT_FIELDS).forEach(function (f) { if (r[f] !== '' && !KS_INT_FIELDS[f].test(r[f])) { bad(f, 'bad_format'); } });
    if (r.paper_code && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(r.paper_code) || r.paper_code.length > 32) { bad('paper_code', 'bad_format'); }
    if (r.session && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/.test(r.session)) { bad('session', 'bad_format'); }
    if (r.year && r.paper_code && r.paper_id && r.paper_id !== 'gate-' + r.year + '-' + r.paper_code) { bad('paper_id', 'paper_id_mismatch'); }
    if (r.question_id && !KS_ID_RE.test(r.question_id)) { bad('question_id', 'bad_format'); }
    if (r.section && !/^[A-Za-z0-9][A-Za-z0-9 ._&-]{0,63}$/.test(r.section)) { bad('section', 'bad_format'); }
    if (r.type && !/^(MCQ|MSQ|NAT)$/.test(r.type)) { bad('type', 'bad_value'); }
    if (r.key_kind && !/^(answer|marks_to_all)$/.test(r.key_kind)) { bad('key_kind', 'bad_value'); }
    if (r.entry_method && !/^(manual_double_entry|csv_import)$/.test(r.entry_method)) { bad('entry_method', 'bad_value'); }
    if (r.source_stage && !/^(provisional|final|unknown)$/.test(r.source_stage)) { bad('source_stage', 'bad_value'); }
    ['content_hash', 'source_sha256'].forEach(function (f) { if (r[f] && !KS_HEX64_RE.test(r[f])) { bad(f, 'bad_sha256'); } });
    ['source_retrieved_at', 'source_published_at'].forEach(function (f) { if (r[f] && !ksValidDate_(r[f])) { bad(f, 'bad_date'); } });
    ['source_name', 'entered_by', 'verified_by'].forEach(function (f) { if (r[f] && r[f].length > 256) { bad(f, 'bad_format'); } });

    /* Source URL: https, no credentials, official host. An unapproved host is a policy block, not a format error. */
    if (r.source_url) {
      var hm = /^https:\/\/([^\/?#:@\s]+)(?::\d+)?(?:[\/?#]|$)/i.exec(r.source_url);
      if (!hm || /\s/.test(r.source_url)) { bad('source_url', 'bad_format'); }
      else {
        var host = hm[1].toLowerCase();
        if (host !== 'gate' + r.year + '.iitg.ac.in' && extraHosts.indexOf(host) < 0 && !ctx.approvedSet) { bad('source_url', 'source_host_not_approved'); }
      }
    }

    /* Marking-profile reference: must exist and be a verified one for this row's year. */
    if (!r.profile_id || !r.profile_version) { bad('profile_id', 'profile_reference_missing'); }
    else {
      var prof = KEYSTORE_VERIFIED_PROFILES[r.profile_id + '@' + r.profile_version];
      if (!prof || prof.year !== r.year) { bad('profile_id', 'profile_unverified'); }
    }

    /* Provenance people. */
    if (r.entered_by && r.verified_by && r.entered_by === r.verified_by && !samePersonOk) { bad('verified_by', 'same_person_not_permitted'); }

    /* Revision chain. */
    var qv = r.question_id + '|' + r.question_version;
    if (r.question_id && r.question_version) {
      if (seenQ[qv]) { bad('question_id', 'duplicate_question_in_batch'); } else { seenQ[qv] = true; }
    }
    if (r.master_qno) { if (seenNo[r.master_qno]) { bad('master_qno', 'duplicate_master_qno'); } else { seenNo[r.master_qno] = true; } }
    if (r.revision && KS_INT_FIELDS.revision.test(r.revision)) {
      var rev = parseInt(r.revision, 10), prior = existing[qv] || [];
      if (rev === 1) {
        if (r.supersedes_key_id) { bad('supersedes_key_id', 'field_not_allowed'); }
        if (prior.length) { bad('revision', 'key_already_exists'); }
      } else if (!r.supersedes_key_id || !KS_ID_RE.test(r.supersedes_key_id)) { bad('supersedes_key_id', 'missing_field'); }
      else {
        var hit = prior.filter(function (p) { return p.key_id === r.supersedes_key_id; })[0];
        var maxRev = prior.reduce(function (m, p) { return Math.max(m, parseInt(p.revision, 10) || 0); }, 0);
        if (!hit || parseInt(hit.revision, 10) !== rev - 1 || maxRev !== rev - 1) { bad('supersedes_key_id', 'supersedes_invalid'); }
      }
    }

    /* Cross-check against the matching EXAM_DB.questions version. Conflicts and gaps are rejected, never filled in. */
    var q = null;
    if (r.question_id && r.question_version && KS_ID_RE.test(r.question_id)) {
      var list = questions[r.question_id] || [];
      if (!list.length) { bad('question_id', 'question_not_found'); }
      else {
        var match = list.filter(function (x) { return x.question_version === r.question_version; });
        if (!match.length) { bad('question_version', 'question_version_mismatch'); }
        else if (match.length > 1) { bad('question_id', 'question_ambiguous'); }
        else { q = match[0]; }
      }
    }
    var optionSet = null;
    if (q) {
      ['type', 'marks', 'year', 'content_hash'].forEach(function (f) {
        if (q[f] === '') { bad(f, 'question_field_missing'); }
        else if (r[f] !== '' && q[f] !== r[f]) { bad(f, 'question_conflict'); }
      });
      if (r.type === 'MCQ' || r.type === 'MSQ') {
        if (r.key_kind === 'answer') {
          optionSet = ksParseOptionIds_(q.options_json);
          if (!optionSet) { bad('question_id', 'question_options_unavailable'); }
        }
      }
    }

    /* Type / kind structure. */
    var mcq = r.mcq_answer, msq = r.msq_answers;
    var natFields = ['nat_lo', 'nat_hi', 'nat_lo_inclusive', 'nat_hi_inclusive', 'nat_scale', 'nat_source_form'];
    function forbid(list) { list.forEach(function (f) { if (r[f] !== '') { bad(f, 'field_not_allowed'); } }); }
    if (r.key_kind === 'marks_to_all') {
      forbid(['mcq_answer', 'msq_answers'].concat(natFields));   /* Marks To All carries no answer data and no boundary flags */
    } else if (r.key_kind === 'answer' && r.type === 'MCQ') {
      forbid(['msq_answers'].concat(natFields));
      if (!mcq) { bad('mcq_answer', 'missing_field'); }
      else if (!KS_ID_RE.test(mcq)) { bad('mcq_answer', 'bad_format'); }
      else if (optionSet && !optionSet[mcq]) { bad('mcq_answer', 'option_not_in_question'); }
    } else if (r.key_kind === 'answer' && r.type === 'MSQ') {
      forbid(['mcq_answer'].concat(natFields));
      if (!msq) { bad('msq_answers', 'missing_field'); }
      else {
        var parts = msq.split(','), okParts = parts.every(function (p) { return KS_ID_RE.test(p); });
        if (!okParts) { bad('msq_answers', 'bad_format'); }
        else {
          var sorted = parts.slice().sort();
          var unique = sorted.every(function (p, i) { return i === 0 || p !== sorted[i - 1]; });
          if (!unique || sorted.join(',') !== msq) { bad('msq_answers', 'msq_not_canonical'); }   /* sorted, unique, comma-joined */
          else if (optionSet && !sorted.every(function (p) { return optionSet[p]; })) { bad('msq_answers', 'option_not_in_question'); }
        }
      }
    } else if (r.key_kind === 'answer' && r.type === 'NAT') {
      forbid(['mcq_answer', 'msq_answers']);
      ['nat_lo', 'nat_hi', 'nat_lo_inclusive', 'nat_hi_inclusive', 'nat_scale', 'nat_source_form'].forEach(function (f) {
        if (r[f] === '') { bad(f, f.indexOf('inclusive') > 0 ? 'nat_boundary_unspecified' : 'missing_field'); }   /* inclusivity is never defaulted */
      });
      if (r.nat_source_form && !/^(value|range)$/.test(r.nat_source_form)) { bad('nat_source_form', 'bad_value'); }
      var lo = ksParseDecimal_(r.nat_lo), hi = ksParseDecimal_(r.nat_hi);
      if (r.nat_lo && !lo) { bad('nat_lo', 'bad_decimal'); }
      if (r.nat_hi && !hi) { bad('nat_hi', 'bad_decimal'); }
      if (lo && hi) {
        var c = ksCmpDecimal_(lo, hi);
        if (c > 0) { bad('nat_lo', 'nat_range_inverted'); }
        else if (c === 0 && (r.nat_lo_inclusive === 'false' || r.nat_hi_inclusive === 'false')) { bad('nat_lo_inclusive', 'nat_range_empty'); }
        if (r.nat_source_form === 'value' && c !== 0) { bad('nat_source_form', 'nat_form_conflict'); }
        if (r.nat_scale && KS_INT_FIELDS.nat_scale.test(r.nat_scale)) {
          var sc = parseInt(r.nat_scale, 10);
          if (lo.fp.length > sc || hi.fp.length > sc) { bad('nat_scale', 'nat_scale_too_small'); }
        }
      }
    }

    /* Everything the key_sets row will hold once must be identical across the batch. */
    if (!first) { first = r; }
    else {
      KS_BATCH_CONSTANT_FIELDS.forEach(function (f) { if (first[f] !== r[f]) { bad(f, 'batch_field_inconsistent'); } });
    }
  });
}

function ksSummarize_(errs, rowCount) {
  if (!errs.length) { return null; }
  var hard = errs.some(function (e) { return !KEYSTORE_POLICY_CODES[e.code]; });
  return { ok: false, code: hard ? 'invalid' : 'blocked_policy', row_count: rowCount, errors: errs };
}

/* ======================================================================================================
 * Staging sheet access
 * ==================================================================================================== */
function ksReadBatch_(sh, cols, batchId) {
  var n = sh.getLastRow() - 1, out = [];
  if (n < 1) { return out; }
  var vals = sh.getRange(2, 1, n, cols.length).getValues(), iB = cols.indexOf('batch_id');
  for (var i = 0; i < n; i++) {
    if (ksCellString_(vals[i][iB]) === batchId) { out.push({ sheetRow: i + 2, cells: vals[i] }); }
  }
  return out;
}

/* Writes one column for the given entries, one contiguous run at a time, forcing plain text first. */
function ksWriteColumn_(sh, col1, entries, valueFn) {
  var sorted = entries.slice().sort(function (a, b) { return a.sheetRow - b.sheetRow; }), i = 0;
  while (i < sorted.length) {
    var j = i;
    while (j + 1 < sorted.length && sorted[j + 1].sheetRow === sorted[j].sheetRow + 1) { j++; }
    var run = sorted.slice(i, j + 1), rng = sh.getRange(run[0].sheetRow, col1, run.length, 1);
    rng.setNumberFormat('@');
    rng.setValues(run.map(function (e) { return [valueFn(e)]; }));
    i = j + 1;
  }
}

function ksValidBatchId_(id) { return typeof id === 'string' && KS_ID_RE.test(id); }

/* ======================================================================================================
 * admin_stage_keys
 * ==================================================================================================== */
function admin_stage_keys(batch_id, rows) {
  return ksRun_(function () {
    if (!ksValidBatchId_(batch_id)) { return { ok: false, code: 'bad_batch_id' }; }
    if (!Array.isArray(rows) || !rows.length) { return { ok: false, code: 'bad_rows' }; }
    if (rows.length > KEYSTORE_MAX_BATCH_ROWS) { return { ok: false, code: 'too_many_rows' }; }
    return ksWithLock_(function () {
      var ctx = ksOpen_(), cols = ksStagingColumns_(), fields = ksInputFields_();
      var sh = ksSheet_(ctx.keys, 'key_staging', cols);
      var errs = [], norm = rows.map(function (raw, i) { return ksNormalizeRow_(raw, i + 1, errs); });
      ksValidateRows_(norm, ctx, errs);
      var bad = ksSummarize_(errs, rows.length);
      if (bad) { Logger.log('KeyStore stage: refused (' + bad.code + '), ' + errs.length + ' error(s); nothing written.'); return bad; }

      var dataCols = ['batch_id', 'staging_row'].concat(fields);
      function expectedCell(r, i, name) { return name === 'batch_id' ? batch_id : name === 'staging_row' ? String(i + 1) : r[name]; }

      /* Existing rows of this batch: an identical retry is accepted, anything else is a conflict. */
      var existing = ksReadBatch_(sh, cols, batch_id), byRow = {}, conflicts = [];
      var iRow = cols.indexOf('staging_row'), iDec = cols.indexOf('decided_at');
      existing.forEach(function (e) {
        var no = parseInt(ksCellString_(e.cells[iRow]), 10);
        if (ksCellString_(e.cells[iDec]) !== '') { conflicts.push({ row: isNaN(no) ? 0 : no, field: '', code: 'batch_decided' }); return; }
        if (isNaN(no) || no < 1 || no > norm.length || byRow[no]) { conflicts.push({ row: isNaN(no) ? 0 : no, field: '', code: 'row_conflict' }); return; }
        byRow[no] = e;
        for (var d = 0; d < dataCols.length; d++) {
          if (ksCellString_(e.cells[cols.indexOf(dataCols[d])]) !== expectedCell(norm[no - 1], no - 1, dataCols[d])) {
            conflicts.push({ row: no, field: '', code: 'row_conflict' }); return;
          }
        }
      });
      if (conflicts.length) {
        Logger.log('KeyStore stage: refused (conflict), ' + conflicts.length + ' conflicting row(s); nothing written.');
        return { ok: false, code: 'conflict', row_count: norm.length, errors: conflicts.slice(0, KEYSTORE_MAX_ERRORS) };
      }

      /* Append the rows that are not there yet, as 'staging' (incomplete) until everything has been read back. */
      var missing = [];
      for (var m = 0; m < norm.length; m++) { if (!byRow[m + 1]) { missing.push(m); } }
      if (missing.length) {
        var now = ksNowIso_();
        var block = missing.map(function (i) {
          return cols.map(function (c) {
            if (c === 'staging_status') { return 'staging'; }
            if (c === 'staged_at') { return now; }
            if (c === 'batch_id' || c === 'staging_row' || KS_SYSTEM_STAGING_COLUMNS[c]) { return expectedCell(norm[i], i, c) || ''; }
            return norm[i][c];
          });
        });
        var start = sh.getLastRow() + 1, end = start + block.length - 1;
        if (sh.getMaxRows() < end) { sh.insertRowsAfter(sh.getMaxRows(), end - sh.getMaxRows()); }
        var rng = sh.getRange(start, 1, block.length, cols.length);
        rng.setNumberFormat('@');   /* plain text BEFORE the values, so Sheets cannot coerce decimals, hashes or dates */
        rng.setValues(block);
        SpreadsheetApp.flush();
      }

      /* Read back the whole batch and compare with what was intended. */
      var after = ksReadBatch_(sh, cols, batch_id), seen = {}, mismatch = [];
      after.forEach(function (e) {
        var no = parseInt(ksCellString_(e.cells[iRow]), 10);
        if (isNaN(no) || no < 1 || no > norm.length || seen[no]) { mismatch.push({ row: isNaN(no) ? 0 : no, field: '', code: 'readback_mismatch' }); return; }
        seen[no] = e;
        for (var d = 0; d < dataCols.length; d++) {
          var cell = e.cells[cols.indexOf(dataCols[d])];
          if (typeof cell !== 'string' || cell !== expectedCell(norm[no - 1], no - 1, dataCols[d])) {
            mismatch.push({ row: no, field: '', code: 'readback_mismatch' }); return;
          }
        }
      });
      for (var k = 1; k <= norm.length; k++) { if (!seen[k]) { mismatch.push({ row: k, field: '', code: 'readback_mismatch' }); } }
      if (mismatch.length) {
        Logger.log('KeyStore stage: read-back failed for ' + mismatch.length + ' row(s). The batch stays incomplete and cannot be validated; retry with identical rows.');
        return { ok: false, code: 'readback_failed', row_count: norm.length, errors: mismatch.slice(0, KEYSTORE_MAX_ERRORS) };
      }

      /* Complete: mark rows 'staged'. If rows were appended, any earlier 'validated' mark is no longer true: reset it. */
      var iSt = cols.indexOf('staging_status'), iVal = cols.indexOf('validated_at');
      var flip = after.filter(function (e) {
        var s = ksCellString_(e.cells[iSt]);
        return s === 'staging' || (missing.length && s === 'validated');
      });
      if (flip.length) {
        ksWriteColumn_(sh, iSt + 1, flip, function () { return 'staged'; });
        if (missing.length) { ksWriteColumn_(sh, iVal + 1, flip, function () { return ''; }); }
        SpreadsheetApp.flush();
        var chk = ksReadBatch_(sh, cols, batch_id);
        var allOk = chk.length === norm.length && chk.every(function (e) { var s = ksCellString_(e.cells[iSt]); return s === 'staged' || s === 'validated'; });
        if (!allOk) { return { ok: false, code: 'readback_failed', row_count: norm.length, errors: [] }; }
      }
      Logger.log('KeyStore stage: ok, ' + norm.length + ' row(s), ' + missing.length + ' newly written.');
      return { ok: true, code: 'ok', row_count: norm.length, rows_written: missing.length, already_staged: missing.length === 0 };
    });
  });
}

/* ======================================================================================================
 * Shared batch loader and admin_validate_batch
 * ==================================================================================================== */
/* Re-reads a staged batch and normalises it. allowDecided=true is used only by approval, which owns the 'approving' and
 * 'approved' states. Does NOT run the cross-checks: callers do that (ksValidateRows_). Never acquires the lock. */
function ksLoadBatch_(sh, cols, fields, batchId, allowDecided) {
  var stored = ksReadBatch_(sh, cols, batchId);
  if (!stored.length) { return { notFound: true }; }
  var iRow = cols.indexOf('staging_row'), iSt = cols.indexOf('staging_status'), iDec = cols.indexOf('decided_at');
  var errs = [], byNo = {}, total = stored.length, rows = [];
  stored.forEach(function (e) {
    var no = parseInt(ksCellString_(e.cells[iRow]), 10);
    if (isNaN(no) || no < 1 || no > total || byNo[no]) { ksAddErr_(errs, isNaN(no) ? 0 : no, '', 'batch_structure_invalid'); return; }
    byNo[no] = e;
    if (!allowDecided && ksCellString_(e.cells[iDec]) !== '') { ksAddErr_(errs, no, '', 'batch_decided'); }
    if (ksCellString_(e.cells[iSt]) === 'staging') { ksAddErr_(errs, no, '', 'batch_incomplete'); }
  });
  if (!errs.length) {
    for (var n = 1; n <= total; n++) {
      var e = byNo[n], raw = {};
      fields.forEach(function (f) {
        var cell = e.cells[cols.indexOf(f)];
        if (typeof cell !== 'string') { ksAddErr_(errs, n, f, 'cell_not_text'); raw[f] = ''; }   /* Sheets coerced it: never trusted */
        else { raw[f] = cell; }
      });
      var norm = ksNormalizeRow_(raw, n, errs);
      if (norm) { fields.forEach(function (f) { if (norm[f] !== raw[f] && raw[f] !== '') { ksAddErr_(errs, n, f, 'not_canonical'); } }); }
      rows.push(norm);
    }
  }
  return { stored: stored, byNo: byNo, total: total, rows: rows, errs: errs };
}

function admin_validate_batch(batch_id) {
  return ksRun_(function () {
    if (!ksValidBatchId_(batch_id)) { return { ok: false, code: 'bad_batch_id' }; }
    return ksWithLock_(function () {
      var ctx = ksOpen_(), cols = ksStagingColumns_(), fields = ksInputFields_();
      var sh = ksSheet_(ctx.keys, 'key_staging', cols);
      var L = ksLoadBatch_(sh, cols, fields, batch_id, false);
      if (L.notFound) { return { ok: false, code: 'batch_not_found' }; }
      var stored = L.stored, total = L.total, errs = L.errs;
      var iSt = cols.indexOf('staging_status'), iVal = cols.indexOf('validated_at');
      if (!errs.length) { ksValidateRows_(L.rows, ctx, errs); }
      var bad = ksSummarize_(errs, total);
      if (bad) {
        var stale = stored.filter(function (e) { return ksCellString_(e.cells[iSt]) === 'validated'; });
        if (stale.length) {   /* a batch that no longer validates must not keep a validated mark */
          ksWriteColumn_(sh, iSt + 1, stale, function () { return 'staged'; });
          ksWriteColumn_(sh, iVal + 1, stale, function () { return ''; });
        }
        Logger.log('KeyStore validate: ' + bad.code + ', ' + errs.length + ' error(s).');
        return bad;
      }
      var now = ksNowIso_();
      ksWriteColumn_(sh, iSt + 1, stored, function () { return 'validated'; });
      ksWriteColumn_(sh, iVal + 1, stored, function () { return now; });
      SpreadsheetApp.flush();
      var back = ksReadBatch_(sh, cols, batch_id);
      var okBack = back.length === total && back.every(function (e) {
        return ksCellString_(e.cells[iSt]) === 'validated' && ksCellString_(e.cells[iVal]) === now;
      });
      if (!okBack) { return { ok: false, code: 'readback_failed', row_count: total, errors: [] }; }
      Logger.log('KeyStore validate: ok, ' + total + ' row(s).');
      return { ok: true, code: 'ok', row_count: total, status: 'validated' };
    });
  });
}

/* ======================================================================================================
 * admin_approve_batch (Task 26). Owner-run editor function. Not reachable over HTTP.
 *
 * Sequence (spec 5.7, 8.6): identity -> lock -> full re-read and re-validation -> persist approval intent in key_staging
 * (staging_status 'approving', decided_at = approval time, decided_by = authenticated identity) -> append answer_keys
 * (children) -> append key_events -> verify rows, MACs, manifest -> append key_sets row LAST (the commit marker) ->
 * mark staging 'approved' -> audit row in AUTH_DB.audit_logs. Every step reconciles with what already exists, so an
 * interrupted run can be repeated. Existing rows are never changed or deleted; unknown or conflicting state stops the run.
 * ==================================================================================================== */
function ksIdentity_() {
  var email = '';
  try { email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase(); } catch (e) { email = ''; }
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) { throw ksErr_('identity_unavailable'); }   /* no fallback to the caller's string */
  return email;
}

/* Deterministic, non-guessable identifiers: HMAC of the batch coordinates under the row-integrity secret. */
function ksDerivedId_(prefix, parts) {
  return prefix + ksHex_(Utilities.computeHmacSha256Signature('GPS-ID-V1|' + parts.join('|'), ksMacSecret_())).slice(0, 40);
}

/* Appends the expected rows that are missing, after checking that every existing row that belongs to this approval matches
 * exactly. Reads everything back (plain-text cells only) and returns the stored cells in expected order. */
function ksSyncRows_(sh, cols, expected, ownCol, ownValue, idCol) {
  var iOwn = cols.indexOf(ownCol), iId = cols.indexOf(idCol), expById = {}, seen = {};
  expected.forEach(function (row) { expById[row[iId]] = row; });
  var n = sh.getLastRow() - 1;
  if (n >= 1) {
    sh.getRange(2, 1, n, cols.length).getValues().forEach(function (cells) {
      var id = ksCellString_(cells[iId]), own = ksCellString_(cells[iOwn]) === ownValue;
      if (!own && !expById[id]) { return; }
      var exp = expById[id];
      if (!exp || seen[id]) { throw ksErr_('orphan_conflict'); }
      for (var c = 0; c < cols.length; c++) { if (ksCellString_(cells[c]) !== exp[c]) { throw ksErr_('orphan_conflict'); } }
      seen[id] = true;
    });
  }
  var missing = expected.filter(function (r) { return !seen[r[iId]]; });
  if (missing.length) {
    var start = sh.getLastRow() + 1, end = start + missing.length - 1;
    if (sh.getMaxRows() < end) { sh.insertRowsAfter(sh.getMaxRows(), end - sh.getMaxRows()); }
    var rng = sh.getRange(start, 1, missing.length, cols.length);
    rng.setNumberFormat('@');   /* plain text before the values */
    rng.setValues(missing);
    SpreadsheetApp.flush();
  }
  var m = sh.getLastRow() - 1, found = {};
  if (m >= 1) {
    sh.getRange(2, 1, m, cols.length).getValues().forEach(function (cells) {
      var id = ksCellString_(cells[iId]);
      if (!expById[id] && ksCellString_(cells[iOwn]) !== ownValue) { return; }
      if (!expById[id] || found[id]) { throw ksErr_('readback_failed'); }
      for (var c = 0; c < cols.length; c++) {
        if (typeof cells[c] !== 'string' || cells[c] !== expById[id][c]) { throw ksErr_('readback_failed'); }
      }
      found[id] = cells;
    });
  }
  var out = expected.map(function (r) { if (!found[r[iId]]) { throw ksErr_('readback_failed'); } return found[r[iId]]; });
  return { written: missing.length, cells: out };
}

function ksRowObject_(cols, cells) { var o = {}; cols.forEach(function (c, i) { o[c] = cells[i]; }); return o; }

/* Audit row in AUTH_DB.audit_logs. Never throws: returns 'written' | 'already_present' | an error code. No key material. */
function ksAudit_(ctx, actor, keySetId, paperId, keyCount, eventCount) {
  try {
    var authId = ksProp_(ctx.props, PRIVATE_DB_PROPERTY_KEYS.AUTH_DB);
    var keysId = ksProp_(ctx.props, PRIVATE_DB_PROPERTY_KEYS.KEYS_DB), examId = ksProp_(ctx.props, PRIVATE_DB_PROPERTY_KEYS.EXAM_DB);
    var publicId = ksProp_(ctx.props, KEYSTORE_PUBLIC_ID_PROPERTY);
    if (!authId) { return 'audit_config_missing'; }
    if (authId === keysId || authId === examId || (publicId && authId === publicId)) { return 'audit_config_conflict'; }
    var ss;
    try { ss = SpreadsheetApp.openById(authId); } catch (e) { return 'audit_db_unavailable'; }
    var cols = PRIVATE_DB_SCHEMAS.AUTH_DB.audit_logs.columns, sh;
    try { sh = ksSheet_(ss, 'audit_logs', cols); } catch (e2) { return e2 && e2.ksCode ? 'audit_' + e2.ksCode : 'audit_schema_error'; }
    var event = 'key_import_approved', iEv = cols.indexOf('event'), iT = cols.indexOf('target_id'), n = sh.getLastRow() - 1;
    if (n >= 1) {
      var vals = sh.getRange(2, 1, n, cols.length).getValues();
      for (var i = 0; i < n; i++) {
        if (ksCellString_(vals[i][iEv]) === event && ksCellString_(vals[i][iT]) === keySetId) { return 'already_present'; }
      }
    }
    var row = cols.map(function (c) {
      return c === 'ts' ? ksNowIso_() : c === 'event' ? event : c === 'user_id' ? actor : c === 'target_id' ? keySetId : c === 'result' ? 'ok' :
        c === 'detail' ? 'paper=' + paperId + ';keys=' + keyCount + ';events=' + eventCount : '';
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

function admin_approve_batch(batch_id, approver) {
  return ksRun_(function () {
    if (!ksValidBatchId_(batch_id)) { return { ok: false, code: 'bad_batch_id' }; }
    if (typeof approver !== 'string' || !approver.trim()) { return { ok: false, code: 'bad_approver' }; }
    var actor = ksIdentity_();                                   /* authenticated Google identity */
    if (approver.trim().toLowerCase() !== actor) { return { ok: false, code: 'approver_mismatch' }; }   /* the argument proves nothing */
    ksMacSecret_();                                              /* refuse early if the secret is missing or weak */
    return ksWithLock_(function () {
      var ctx = ksOpen_(), cols = ksStagingColumns_(), fields = ksInputFields_();
      var sh = ksSheet_(ctx.keys, 'key_staging', cols);
      var akCols = ANSWER_KEY_COLUMNS, ksCols = PRIVATE_DB_SCHEMAS.KEYS_DB.key_sets.columns, evCols = PRIVATE_DB_SCHEMAS.KEYS_DB.key_events.columns;
      var akSh = ksSheet_(ctx.keys, 'answer_keys', akCols), setSh = ksSheet_(ctx.keys, 'key_sets', ksCols), evSh = ksSheet_(ctx.keys, 'key_events', evCols);
      var keySetId = ksDerivedId_('ks-', [batch_id]);
      ctx.excludeKeySetId = keySetId;

      /* 1. Re-read the complete staged batch. */
      var L = ksLoadBatch_(sh, cols, fields, batch_id, true);
      if (L.notFound) { return { ok: false, code: 'batch_not_found' }; }
      if (L.errs.length) { return ksSummarize_(L.errs, L.total); }
      var total = L.total, rows = L.rows, stored = L.stored;
      var iSt = cols.indexOf('staging_status'), iDecAt = cols.indexOf('decided_at'), iDecBy = cols.indexOf('decided_by');

      /* 2. Classify the batch state: fresh rows, or rows already carrying this approval's intent. */
      var intentRows = [], freshRows = [], odd = [];
      stored.forEach(function (e) {
        var s = ksCellString_(e.cells[iSt]), at = ksCellString_(e.cells[iDecAt]), by = ksCellString_(e.cells[iDecBy]);
        if ((s === 'staged' || s === 'validated') && !at && !by) { freshRows.push(e); }
        else if ((s === 'approving' || s === 'approved') && at && by) { intentRows.push(e); }
        else { odd.push(e); }
      });
      if (odd.length) { return { ok: false, code: 'batch_decided', row_count: total, errors: [] }; }   /* decided otherwise, or unknown partial state */
      var intentAt = '', intentBy = '';
      if (intentRows.length) {
        intentAt = ksCellString_(intentRows[0].cells[iDecAt]); intentBy = ksCellString_(intentRows[0].cells[iDecBy]);
        var consistent = intentRows.every(function (e) { return ksCellString_(e.cells[iDecAt]) === intentAt && ksCellString_(e.cells[iDecBy]) === intentBy; });
        if (!consistent || !ksValidDate_(intentAt)) { return { ok: false, code: 'intent_inconsistent', row_count: total, errors: [] }; }
        if (intentBy !== actor) { return { ok: false, code: 'approval_pending_other_actor', row_count: total, errors: [] }; }
      }

      /* 3. Is the set already committed (key_sets row present for this batch)? Then only the follow-ups remain. */
      var setN = setSh.getLastRow() - 1, committed = false, paperId = rows[0].paper_id, otherPaperSet = false;
      if (setN >= 1) {
        var setVals = setSh.getRange(2, 1, setN, ksCols.length).getValues(), iSB = ksCols.indexOf('batch_id'), iSP = ksCols.indexOf('paper_id');
        setVals.forEach(function (v) {
          if (ksCellString_(v[iSB]) === batch_id) { committed = true; }
          else if (ksCellString_(v[iSP]) === paperId) { otherPaperSet = true; }
        });
      }
      if (committed && !intentRows.length) { return { ok: false, code: 'committed_state_inconsistent' }; }
      if (otherPaperSet && !committed) { return { ok: false, code: 'blocked_policy', row_count: total, errors: [{ row: 0, field: 'paper_id', code: 'paper_already_has_key_set' }] }; }

      /* 4. Re-validate everything against the current questions and the policy gates (skipped only for a committed set,
       *    whose content is then compared against the stored rows below, not against later question edits). */
      var errs = [];
      if (!committed) { ksValidateRows_(rows, ctx, errs); }
      rows.forEach(function (r, i) {
        if (r.revision !== '1') { ksAddErr_(errs, i + 1, 'revision', 'correction_not_supported'); }   /* corrections are a later task */
        if (r.entered_by.toLowerCase() === actor || r.verified_by.toLowerCase() === actor) { ksAddErr_(errs, i + 1, 'verified_by', 'approver_not_distinct'); }
      });
      if (errs.length) {
        var bad = ksSummarize_(errs, total);
        Logger.log('KeyStore approve: refused (' + bad.code + '), ' + errs.length + ' error(s).');
        return bad;
      }

      /* 5. Persist the approval intent so a retry recovers the same approver and timestamp. */
      var changed = false;
      if (!intentRows.length) { intentAt = ksNowIso_(); intentBy = actor; }
      if (freshRows.length) {
        ksWriteColumn_(sh, iSt + 1, freshRows, function () { return 'approving'; });
        ksWriteColumn_(sh, iDecAt + 1, freshRows, function () { return intentAt; });
        ksWriteColumn_(sh, iDecBy + 1, freshRows, function () { return intentBy; });
        SpreadsheetApp.flush();
        var chk = ksReadBatch_(sh, cols, batch_id);
        if (chk.length !== total || !chk.every(function (e) {
          return /^(approving|approved)$/.test(ksCellString_(e.cells[iSt])) && ksCellString_(e.cells[iDecAt]) === intentAt && ksCellString_(e.cells[iDecBy]) === intentBy;
        })) { return { ok: false, code: 'intent_write_failed', row_count: total, errors: [] }; }
        changed = true;
      }

      /* 6. Build the approved rows in exact schema order, with deterministic ids and a row_mac each. */
      var keyObjs = [], keyRows = [], evRows = [];
      rows.forEach(function (r, i) {
        var o = {};
        akCols.forEach(function (c) {
          if (c === 'key_set_id') { o[c] = keySetId; }
          else if (c === 'key_id') { o[c] = ksDerivedId_('key-', [batch_id, String(i + 1), r.question_id, r.question_version, r.revision]); }
          else if (c === 'status') { o[c] = 'approved'; }
          else if (c === 'dispute_state') { o[c] = 'none'; }
          else if (c === 'approved_at') { o[c] = intentAt; }
          else if (c === 'approved_by') { o[c] = intentBy; }
          else if (c === 'row_mac') { o[c] = ''; }
          else { if (typeof r[c] !== 'string') { throw ksErr_('build_incomplete'); } o[c] = r[c]; }
        });
        o.row_mac = ksComputeRowMac_(o);
        keyObjs.push(o);
        keyRows.push(akCols.map(function (c) { return o[c]; }));
        var ev = {
          event_id: ksDerivedId_('evt-', ['approved', o.key_id]), ts: intentAt, event_type: 'approved', key_id: o.key_id, key_set_id: keySetId,
          batch_id: batch_id, question_id: o.question_id, question_version: o.question_version, revision: o.revision, actor: intentBy,
          reason: 'batch_approval', official_reference_url: o.source_url, official_reference_date: o.source_published_at, old_value_json: '',
          new_value_json: JSON.stringify({ key_kind: o.key_kind, type: o.type, marks: o.marks, mcq_answer: o.mcq_answer, msq_answers: o.msq_answers,
            nat_lo: o.nat_lo, nat_hi: o.nat_hi, nat_lo_inclusive: o.nat_lo_inclusive, nat_hi_inclusive: o.nat_hi_inclusive,
            nat_scale: o.nat_scale, nat_source_form: o.nat_source_form }),
          linked_key_id: ''
        };
        evRows.push(evCols.map(function (c) { return ev[c]; }));
      });

      /* 7. Append (or reconcile) the answer_keys rows, then verify canonical content and HMACs from what was stored. */
      var akRes = ksSyncRows_(akSh, akCols, keyRows, 'key_set_id', keySetId, 'key_id');
      var storedObjs = akRes.cells.map(function (cells) { return ksRowObject_(akCols, cells); });
      storedObjs.forEach(function (o, i) {
        if (ksCanonicalKeyRow_(o) !== ksCanonicalKeyRow_(keyObjs[i]) || !ksVerifyRowMac_(o)) { throw ksErr_('integrity_check_failed'); }
      });

      /* 8. Append (or reconcile) the key_events rows. */
      var evRes = ksSyncRows_(evSh, evCols, evRows, 'batch_id', batch_id, 'event_id');

      /* 9. Manifest and digest from the stored rows; must equal the manifest of what was intended. */
      var manifest = ksKeySetManifest_(storedObjs);
      if (manifest !== ksKeySetManifest_(keyObjs)) { throw ksErr_('manifest_mismatch'); }
      var digest = ksSha256Hex_(manifest), first = keyObjs[0];

      /* 10. The key_sets row is written LAST: it is the commit marker. */
      var setObj = { key_set_id: keySetId, batch_id: batch_id, paper_id: first.paper_id, year: first.year, paper_code: first.paper_code,
        session: first.session, profile_id: first.profile_id, profile_version: first.profile_version, item_count: String(total),
        source_name: first.source_name, source_url: first.source_url, source_sha256: first.source_sha256, source_stage: first.source_stage,
        entered_by: first.entered_by, verified_by: first.verified_by, approved_by: intentBy, approved_at: intentAt, key_set_digest: digest };
      var setRes = ksSyncRows_(setSh, ksCols, [ksCols.map(function (c) { return setObj[c]; })], 'batch_id', batch_id, 'key_set_id');
      if (akRes.written || evRes.written || setRes.written) { changed = true; }

      /* 11. Mark the staged batch approved (a follow-up; the key_sets row is the real commit). */
      var latest = ksReadBatch_(sh, cols, batch_id).filter(function (e) { return ksCellString_(e.cells[iSt]) !== 'approved'; });
      if (latest.length) {
        ksWriteColumn_(sh, iSt + 1, latest, function () { return 'approved'; });
        SpreadsheetApp.flush();
        var fin = ksReadBatch_(sh, cols, batch_id);
        if (!fin.every(function (e) { return ksCellString_(e.cells[iSt]) === 'approved'; })) {
          return { ok: true, code: 'committed_staging_flag_outstanding', committed: true, key_count: total, event_count: total };
        }
        changed = true;
      }

      /* 12. Audit. A failure here never undoes or repeats the approval; it is reported as outstanding. */
      var audit = ksAudit_(ctx, actor, keySetId, first.paper_id, total, total);
      if (audit === 'written') { changed = true; }
      var auditOk = audit === 'written' || audit === 'already_present';
      if (!changed && auditOk) { return { ok: false, code: 'already_approved' }; }
      Logger.log('KeyStore approve: committed, ' + total + ' key(s); audit ' + (auditOk ? 'recorded' : 'OUTSTANDING (' + audit + ')') + '.');
      var res = { ok: true, code: auditOk ? 'approved' : 'approved_audit_outstanding', committed: true, key_count: total, event_count: total,
        audit: auditOk ? audit : 'outstanding' };
      if (!auditOk) { res.audit_code = audit; }
      return res;
    });
  });
}

/* ======================================================================================================
 * Integrity helpers (internal). Spec 4.2 row_mac, 4.6 key_set_digest, 8.1.
 * ==================================================================================================== */
function ksHex_(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) { var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i]; s += (b < 16 ? '0' : '') + b.toString(16); }
  return s;
}

function ksSha256Hex_(text) {
  return ksHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8));
}

/* The MAC secret comes only from Script Properties. Missing or short: refuse. Never generated, never defaulted. */
function ksMacSecret_() {
  var s = ksProp_(PropertiesService.getScriptProperties(), KEYSTORE_MAC_SECRET_PROPERTY);
  if (!s) { throw ksErr_('mac_secret_missing'); }
  if (s.length < KEYSTORE_MIN_SECRET_LENGTH) { throw ksErr_('mac_secret_weak'); }
  return s;
}

function ksCanonValue_(name, v) {
  if (v === null || v === undefined || v === '') { return ''; }
  if (v instanceof Date) { throw ksErr_('canonical_bad_value'); }   /* a coerced date means the cell was not plain text */
  if (KS_BOOL_FIELDS[name]) {
    if (v === true || v === 'true' || v === 'TRUE') { return 'true'; }
    if (v === false || v === 'false' || v === 'FALSE') { return 'false'; }
    throw ksErr_('canonical_bad_value');
  }
  if (typeof v === 'number') {
    if (!isFinite(v) || Math.floor(v) !== v) { throw ksErr_('canonical_bad_value'); }
    return String(v);
  }
  if (typeof v === 'boolean') { throw ksErr_('canonical_bad_value'); }
  return String(v);
}

/* Canonical form of an answer_keys row: every ANSWER_KEY_COLUMNS column except row_mac, in schema order, each as
 * name:length:value, under a version header. Length-prefixing makes the encoding unambiguous. Missing columns are refused. */
function ksCanonicalKeyRow_(row) {
  if (!row || typeof row !== 'object') { throw ksErr_('canonical_bad_row'); }
  var out = 'GPS-KEYROW-V1\n';
  ANSWER_KEY_COLUMNS.forEach(function (c) {
    if (c === 'row_mac') { return; }
    if (!Object.prototype.hasOwnProperty.call(row, c)) { throw ksErr_('canonical_incomplete'); }
    var v = ksCanonValue_(c, row[c]);
    out += c + ':' + v.length + ':' + v + '\n';
  });
  return out;
}

function ksComputeRowMac_(row) {
  var secret = ksMacSecret_();
  return ksHex_(Utilities.computeHmacSha256Signature(ksCanonicalKeyRow_(row), secret));
}

function ksConstantTimeEquals_(a, b) {
  a = String(a); b = String(b);
  var diff = a.length ^ b.length, len = Math.max(a.length, b.length);
  for (var i = 0; i < len; i++) { diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); }
  return diff === 0;
}

function ksVerifyRowMac_(row) {
  var stored = row && row.row_mac !== undefined ? String(row.row_mac) : '';
  if (!KS_HEX64_RE.test(stored)) { return false; }
  return ksConstantTimeEquals_(ksComputeRowMac_(row), stored);
}

/* Key-set manifest: the (key_id, revision, row_mac) triples (spec 4.6) in a fixed order: question_id, question_version,
 * revision, key_id (plain code-unit comparison). The same rows in any input order give the same manifest and digest.
 * Needs no secret: it hashes the stored row_mac values; use ksVerifyRowMac_ separately to check them. */
function ksKeySetManifest_(rows) {
  if (!Array.isArray(rows) || !rows.length) { throw ksErr_('manifest_empty'); }
  var seen = {};
  var items = rows.map(function (r) {
    var kid = ksCellString_(r.key_id), rev = ksCellString_(r.revision), mac = ksCellString_(r.row_mac);
    var qid = ksCellString_(r.question_id), qv = ksCellString_(r.question_version);
    if (!KS_ID_RE.test(kid) || !/^[1-9]\d*$/.test(rev) || !KS_HEX64_RE.test(mac) || !KS_ID_RE.test(qid) || !/^[1-9]\d*$/.test(qv)) { throw ksErr_('manifest_bad_row'); }
    if (seen[kid]) { throw ksErr_('manifest_duplicate_key'); }
    seen[kid] = true;
    return { qid: qid, qv: parseInt(qv, 10), rev: parseInt(rev, 10), kid: kid, mac: mac };
  });
  items.sort(function (a, b) {
    if (a.qid !== b.qid) { return a.qid < b.qid ? -1 : 1; }
    if (a.qv !== b.qv) { return a.qv - b.qv; }
    if (a.rev !== b.rev) { return a.rev - b.rev; }
    return a.kid < b.kid ? -1 : a.kid > b.kid ? 1 : 0;
  });
  return 'GPS-KEYSET-V1\n' + items.map(function (it) {
    var t = it.kid + '|' + it.rev + '|' + it.mac;
    return t.length + ':' + t + '\n';
  }).join('');
}

function ksKeySetDigest_(rows) { return ksSha256Hex_(ksKeySetManifest_(rows)); }

/* ======================================================================================================
 * ksLoadApprovedKeySet_(paper_id) (Task 27). INTERNAL, READ-ONLY. For trusted server-side code in this private project only.
 * Not an owner-run editor function (trailing underscore), not an endpoint, never called from the browser or the public project.
 *
 * Returns {ok:true, code:'ok', key_set:{...metadata}, keys:[...verified answer_keys rows, by master_qno]} or {ok:false, code, errors?}.
 * Fail-closed: on any failure NO keys are returned, only a short code and row indexes (1-based, master_qno order). No values are
 * logged or reported. It writes nothing and never touches key_events history.
 *
 * Do not call it while holding the script lock; a caller that already holds it uses ksLoadApprovedKeySetLocked_ instead.
 * ==================================================================================================== */
function ksLoadApprovedKeySet_(paper_id) {
  return ksRun_(function () {
    if (typeof paper_id !== 'string' || paper_id.length > 64 || !/^gate-\d{4}-[a-z0-9]+(-[a-z0-9]+)*$/.test(paper_id)) { return { ok: false, code: 'bad_paper_id' }; }
    ksMacSecret_();   /* refuse before reading anything if the secret is missing or weak */
    return ksWithLock_(function () { return ksLoadApprovedKeySetLocked_(paper_id); });
  });
}

function ksAllText_(cells) {
  for (var i = 0; i < cells.length; i++) { if (typeof cells[i] !== 'string') { return false; } }
  return true;
}

/* Core of the loader. The caller holds the script lock and has validated paper_id and the secret. Throws ksErr_ codes. */
function ksLoadApprovedKeySetLocked_(paperId) {
  var ctx = ksOpen_();
  var setCols = PRIVATE_DB_SCHEMAS.KEYS_DB.key_sets.columns, evCols = PRIVATE_DB_SCHEMAS.KEYS_DB.key_events.columns, akCols = ANSWER_KEY_COLUMNS;
  var setSh = ksSheet_(ctx.keys, 'key_sets', setCols), akSh = ksSheet_(ctx.keys, 'answer_keys', akCols), evSh = ksSheet_(ctx.keys, 'key_events', evCols);

  /* 1. The commit marker: exactly one key_sets row for the paper, and no duplicated set or batch id anywhere. */
  var sn = setSh.getLastRow() - 1, marker = null, seenSet = {}, seenBatch = {}, hits = 0;
  if (sn < 1) { throw ksErr_('key_set_not_found'); }
  setSh.getRange(2, 1, sn, setCols.length).getValues().forEach(function (cells) {
    var o = ksRowObject_(setCols, cells.map(function (v) { return typeof v === 'string' ? v : '\u0000bad'; }));
    if (!o.key_set_id && !o.paper_id && !o.batch_id) { return; }   /* blank line */
    if (seenSet[o.key_set_id] || seenBatch[o.batch_id]) { throw ksErr_('key_set_duplicate'); }
    seenSet[o.key_set_id] = true; seenBatch[o.batch_id] = true;
    if (o.paper_id === paperId) { hits++; marker = ksAllText_(cells) ? o : { malformed: true }; }
  });
  if (!hits) { throw ksErr_('key_set_not_found'); }
  if (hits > 1) { throw ksErr_('key_set_duplicate'); }
  if (marker.malformed) { throw ksErr_('key_set_malformed'); }
  var m = marker, prof = KEYSTORE_VERIFIED_PROFILES[m.profile_id + '@' + m.profile_version];
  if (!/^ks-[0-9a-f]{40}$/.test(m.key_set_id) || !KS_ID_RE.test(m.batch_id) || !/^[1-9]\d{0,3}$/.test(m.item_count) ||
      !/^\d{4}$/.test(m.year) || m.paper_id !== 'gate-' + m.year + '-' + m.paper_code || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.paper_code) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/.test(m.session) || !KS_HEX64_RE.test(m.key_set_digest) || !KS_HEX64_RE.test(m.source_sha256) ||
      !/^(provisional|final|unknown)$/.test(m.source_stage) || !/^[^@\s]+@[^@\s]+$/.test(m.approved_by) ||
      m.approved_at.indexOf('T') < 0 || !ksValidDate_(m.approved_at) ||
      !m.source_name || !m.source_url || !m.entered_by || !m.verified_by) { throw ksErr_('key_set_malformed'); }
  if (!prof || prof.year !== m.year) { throw ksErr_('profile_unverified'); }
  var expected = parseInt(m.item_count, 10);

  /* 2. The key rows of this set. Foreign rows for the same paper are unknown state: stop for owner review. */
  var an = akSh.getLastRow() - 1, keyObjs = [];
  var iSet = akCols.indexOf('key_set_id'), iPaper = akCols.indexOf('paper_id');
  if (an >= 1) {
    akSh.getRange(2, 1, an, akCols.length).getValues().forEach(function (cells) {
      var inSet = ksCellString_(cells[iSet]) === m.key_set_id, samePaper = ksCellString_(cells[iPaper]) === paperId;
      if (!inSet && !samePaper) { return; }
      if (!inSet) { throw ksErr_('foreign_key_rows_for_paper'); }
      if (!ksAllText_(cells)) { throw ksErr_('key_row_not_text'); }
      keyObjs.push(ksRowObject_(akCols, cells));
    });
  }
  if (keyObjs.length !== expected) { throw ksErr_('item_count_mismatch'); }
  keyObjs.sort(function (a, b) { return (parseInt(a.master_qno, 10) || 0) - (parseInt(b.master_qno, 10) || 0); });

  /* 3. Per-row identity and set-level agreement. */
  var errs = [], seenKey = {}, seenQ = {};
  var shared = ['paper_id', 'year', 'paper_code', 'session', 'profile_id', 'profile_version', 'source_name', 'source_url', 'source_sha256',
    'source_stage', 'entered_by', 'verified_by'];
  keyObjs.forEach(function (o, i) {
    var n = i + 1;
    function bad(code) { ksAddErr_(errs, n, '', code); }
    if (!KS_ID_RE.test(o.key_id) || !KS_ID_RE.test(o.question_id) || !KS_INT_FIELDS.question_version.test(o.question_version)) { bad('bad_identifier'); }
    if (seenKey[o.key_id]) { bad('duplicate_key_id'); } seenKey[o.key_id] = true;
    var qv = o.question_id + '|' + o.question_version;
    if (seenQ[qv]) { bad('duplicate_question_version'); } seenQ[qv] = true;
    if (o.revision !== '1' || o.supersedes_key_id !== '') { bad('revision_unsupported'); }   /* only revision 1 exists until corrections are built */
    if (o.status !== 'approved' || o.dispute_state !== 'none') { bad('row_status_unexpected'); }
    if (o.approved_at !== m.approved_at || o.approved_by !== m.approved_by) { bad('approval_mismatch'); }
    if (!/^key-[0-9a-f]{40}$/.test(o.key_id)) { bad('bad_identifier'); }   /* derived-id format; the staging order is not recoverable here */
    shared.forEach(function (f) { if (o[f] !== m[f]) { bad('set_field_mismatch'); } });
  });
  if (errs.length) { return { ok: false, code: 'key_rows_invalid', errors: errs }; }

  /* 4. HMAC of every row, then manifest and digest recomputed from the stored rows. */
  keyObjs.forEach(function (o, i) {
    var ok = false;
    try { ok = ksVerifyRowMac_(o); } catch (e) { ok = false; }
    if (!ok) { ksAddErr_(errs, i + 1, 'row_mac', 'row_mac_failed'); }
  });
  if (errs.length) { Logger.log('KeyStore load: row_mac failed for ' + errs.length + ' row(s).'); return { ok: false, code: 'integrity_failed', errors: errs }; }
  var digest;
  try { digest = ksKeySetDigest_(keyObjs); } catch (e2) { throw ksErr_('manifest_invalid'); }
  if (!ksConstantTimeEquals_(digest, m.key_set_digest)) { throw ksErr_('digest_mismatch'); }

  /* 5. Cross-check against the pinned question version in EXAM_DB (type, marks, year, content hash, options) with the existing
   *    validator. Approval-time policies (host list, same-person flag) are not re-applied; the profile gate is. */
  var vctx = { props: ctx.props, keys: ctx.keys, exam: ctx.exam, excludeKeySetId: m.key_set_id, approvedSet: true };
  var fields = ksInputFields_(), vrows = keyObjs.map(function (o) { var r = {}; fields.forEach(function (f) { r[f] = o[f]; }); return r; });
  ksValidateRows_(vrows, vctx, errs);
  if (errs.length) {
    var sum = ksSummarize_(errs, keyObjs.length);
    Logger.log('KeyStore load: cross-check failed (' + sum.code + '), ' + errs.length + ' error(s).');
    return { ok: false, code: sum.code === 'blocked_policy' ? 'blocked_policy' : 'question_crosscheck_failed', errors: errs };
  }

  /* 6. Current status from key_events: exactly one matching 'approved' event per key and nothing else about these keys. */
  var byKey = {}, qvSet = {}, evErrs = [];
  keyObjs.forEach(function (o) { byKey[o.key_id] = { o: o, events: [] }; qvSet[o.question_id + '|' + o.question_version] = true; });
  var iK = evCols.indexOf('key_id'), iS = evCols.indexOf('key_set_id'), iB = evCols.indexOf('batch_id'), iQ = evCols.indexOf('question_id'), iV = evCols.indexOf('question_version');
  var en = evSh.getLastRow() - 1;
  if (en >= 1) {
    evSh.getRange(2, 1, en, evCols.length).getValues().forEach(function (cells) {
      var kid = ksCellString_(cells[iK]), related = !!byKey[kid] || ksCellString_(cells[iS]) === m.key_set_id || ksCellString_(cells[iB]) === m.batch_id ||
        !!qvSet[ksCellString_(cells[iQ]) + '|' + ksCellString_(cells[iV])];
      if (!related) { return; }
      if (!ksAllText_(cells)) { throw ksErr_('event_row_not_text'); }
      var e = ksRowObject_(evCols, cells);
      if (!byKey[kid]) { evErrs.push({ row: 0, field: '', code: 'event_unrelated_to_set_keys' }); return; }   /* foreign event for a pinned question or this set */
      byKey[kid].events.push(e);
    });
  }
  keyObjs.forEach(function (o, i) {
    var n = i + 1, evs = byKey[o.key_id].events;
    if (!evs.length) { ksAddErr_(evErrs, n, '', 'key_event_missing'); return; }
    evs.forEach(function (e) {
      if (e.event_type !== 'approved') {
        ksAddErr_(evErrs, n, '', /^(disputed|withdrawn|superseded|corrected)$/.test(e.event_type) ? 'key_not_current' : 'key_event_unexpected');
      }
    });
    var approved = evs.filter(function (e) { return e.event_type === 'approved'; });
    if (approved.length > 1) { ksAddErr_(evErrs, n, '', 'key_event_duplicate'); return; }
    if (!approved.length) { ksAddErr_(evErrs, n, '', 'key_event_missing'); return; }
    var e = approved[0];
    var newJson = JSON.stringify({ key_kind: o.key_kind, type: o.type, marks: o.marks, mcq_answer: o.mcq_answer, msq_answers: o.msq_answers,
      nat_lo: o.nat_lo, nat_hi: o.nat_hi, nat_lo_inclusive: o.nat_lo_inclusive, nat_hi_inclusive: o.nat_hi_inclusive,
      nat_scale: o.nat_scale, nat_source_form: o.nat_source_form });
    if (e.event_id !== ksDerivedId_('evt-', ['approved', o.key_id]) || e.key_set_id !== m.key_set_id || e.batch_id !== m.batch_id ||
        e.question_id !== o.question_id || e.question_version !== o.question_version || e.revision !== o.revision ||
        e.actor !== m.approved_by || e.ts !== m.approved_at || e.new_value_json !== newJson || e.linked_key_id !== '') {
      ksAddErr_(evErrs, n, '', 'key_event_inconsistent');
    }
  });
  if (evErrs.length) { Logger.log('KeyStore load: event check failed, ' + evErrs.length + ' error(s).'); return { ok: false, code: 'key_events_invalid', errors: evErrs }; }

  Logger.log('KeyStore load: verified key set, ' + keyObjs.length + ' key(s).');
  return {
    ok: true, code: 'ok',
    key_set: { key_set_id: m.key_set_id, batch_id: m.batch_id, paper_id: m.paper_id, year: m.year, paper_code: m.paper_code, session: m.session,
      profile_id: m.profile_id, profile_version: m.profile_version, item_count: expected, key_set_digest: m.key_set_digest,
      approved_by: m.approved_by, approved_at: m.approved_at, source_name: m.source_name, source_url: m.source_url,
      source_sha256: m.source_sha256, source_stage: m.source_stage, entered_by: m.entered_by, verified_by: m.verified_by },
    keys: keyObjs
  };
}

/* ======================================================================================================
 * admin_open_key_dispute (Task 36). Owner-run editor function. Not reachable over HTTP; no router entry.
 *
 *   admin_open_key_dispute(key_id, reason, official_reference_url, official_reference_date)   (the last two are optional: pass '' or omit)
 *
 * Appends ONE 'disputed' row to KEYS_DB.key_events. Nothing else is written to KEYS_DB: answer_keys rows (status, dispute_state), the key_sets
 * commit marker and every earlier event stay exactly as they are. The dispute is enforced by the existing loader, not by editing a row:
 * ksLoadApprovedKeySetLocked_ step 6 accepts only an 'approved' event per key and reports any other event type for a key of the set as
 * key_not_current, so after this event is committed ksLoadApprovedKeySet_ for the whole set answers {ok:false, code:'key_events_invalid'} and the
 * scoring service refuses to score with it. This function does not touch that check. It re-runs the loader after the append and reports
 * loader_refuses; if the loader still returned the set it would answer dispute_not_enforced.
 *
 * Identity: the executing user's e-mail from Session.getActiveUser() (ksIdentity_). No caller-supplied name is accepted or used.
 * Input: key_id (key-<40 hex>), a non-empty plain-text reason (<= 500 chars), optional https reference URL and optional YYYY-MM-DD date. No answer
 * value, NAT bound or key field is an input, and the event's old/new value fields carry only the state words approved -> disputed.
 *
 * Idempotency: event_id = derived id of ('disputed', key_id), so a key has at most one dispute event. A retry whose canonical fields (everything but
 * the timestamp) match the stored event appends nothing and returns already_disputed (and retries the audit row if it was missing). Any difference
 * (another reason, reference, actor, or a second dispute row shape) stops with dispute_conflict.
 * Not implemented here: resolving a dispute, correction, withdrawal, rescoring, notifications.
 * ==================================================================================================== */
var KS_DISPUTE_REASON_MAX = 500;
var KS_DISPUTE_URL_MAX = 300;

function ksDisputeInput_(keyId, reason, url, date) {
  if (typeof keyId !== 'string' || !/^key-[0-9a-f]{40}$/.test(keyId)) { throw ksErr_('dispute_key_id_invalid'); }
  if (typeof reason !== 'string') { throw ksErr_('dispute_reason_invalid'); }
  var r = reason.trim();
  if (!r || r.length > KS_DISPUTE_REASON_MAX || ksHasControl_(r)) { throw ksErr_('dispute_reason_invalid'); }
  var u = url === undefined || url === null ? '' : url, d = date === undefined || date === null ? '' : date;
  if (typeof u !== 'string' || typeof d !== 'string') { throw ksErr_('dispute_reference_invalid'); }
  u = u.trim(); d = d.trim();
  if (u && (u.length > KS_DISPUTE_URL_MAX || /\s/.test(u) || ksHasControl_(u) || !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:[\/?#][^\s@]*)?$/.test(u))) { throw ksErr_('dispute_reference_invalid'); }
  if (d && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !ksValidDate_(d))) { throw ksErr_('dispute_reference_invalid'); }
  return { key_id: keyId, reason: r, url: u, date: d };
}

/* Audit row for a dispute (same AUTH_DB.audit_logs conventions as ksAudit_; the event is recorded once per event id). Never throws. */
function ksAuditDispute_(ctx, actor, eventId, detail) {
  try {
    var authId = ksProp_(ctx.props, PRIVATE_DB_PROPERTY_KEYS.AUTH_DB), keysId = ksProp_(ctx.props, PRIVATE_DB_PROPERTY_KEYS.KEYS_DB), examId = ksProp_(ctx.props, PRIVATE_DB_PROPERTY_KEYS.EXAM_DB);
    var publicId = ksProp_(ctx.props, KEYSTORE_PUBLIC_ID_PROPERTY);
    if (!authId) { return 'audit_config_missing'; }
    if (authId === keysId || authId === examId || (publicId && authId === publicId)) { return 'audit_config_conflict'; }
    var ss;
    try { ss = SpreadsheetApp.openById(authId); } catch (e) { return 'audit_db_unavailable'; }
    var cols = PRIVATE_DB_SCHEMAS.AUTH_DB.audit_logs.columns, sh;
    try { sh = ksSheet_(ss, 'audit_logs', cols); } catch (e2) { return e2 && e2.ksCode ? 'audit_' + e2.ksCode : 'audit_schema_error'; }
    var event = 'key_dispute_opened', iEv = cols.indexOf('event'), iT = cols.indexOf('target_id'), n = sh.getLastRow() - 1;
    if (n >= 1) {
      var vals = sh.getRange(2, 1, n, cols.length).getValues();
      for (var i = 0; i < n; i++) { if (ksCellString_(vals[i][iEv]) === event && ksCellString_(vals[i][iT]) === eventId) { return 'already_present'; } }
    }
    var row = cols.map(function (c) { return c === 'ts' ? ksNowIso_() : c === 'event' ? event : c === 'user_id' ? actor : c === 'target_id' ? eventId : c === 'result' ? 'ok' : c === 'detail' ? detail : ''; });
    var start = sh.getLastRow() + 1;
    if (sh.getMaxRows() < start) { sh.insertRowsAfter(sh.getMaxRows(), 1); }
    var rng = sh.getRange(start, 1, 1, cols.length);
    rng.setNumberFormat('@'); rng.setValues([row]); SpreadsheetApp.flush();
    var back = sh.getRange(start, 1, 1, cols.length).getValues()[0];
    for (var c = 0; c < cols.length; c++) { if (typeof back[c] !== 'string' || back[c] !== row[c]) { return 'audit_readback_failed'; } }
    return 'written';
  } catch (err) { return 'audit_failed'; }
}

function admin_open_key_dispute(key_id, reason, official_reference_url, official_reference_date) {
  return ksRun_(function () {
    var actor = ksIdentity_();                                   /* authenticated executing user, never a parameter */
    var inp = ksDisputeInput_(key_id, reason, official_reference_url, official_reference_date);
    ksMacSecret_();                                              /* refuse before reading anything if the integrity secret is missing or weak */
    return ksWithLock_(function () {
      var ctx = ksOpen_();
      var akCols = ANSWER_KEY_COLUMNS, setCols = PRIVATE_DB_SCHEMAS.KEYS_DB.key_sets.columns, evCols = PRIVATE_DB_SCHEMAS.KEYS_DB.key_events.columns;
      var akSh = ksSheet_(ctx.keys, 'answer_keys', akCols), setSh = ksSheet_(ctx.keys, 'key_sets', setCols), evSh = ksSheet_(ctx.keys, 'key_events', evCols);

      /* 1. Exactly one approved key row, intact. */
      var an = akSh.getLastRow() - 1, iKey = akCols.indexOf('key_id'), found = [];
      if (an >= 1) {
        akSh.getRange(2, 1, an, akCols.length).getValues().forEach(function (cells) { if (ksCellString_(cells[iKey]) === inp.key_id) { found.push(cells); } });
      }
      if (!found.length) { throw ksErr_('dispute_key_not_found'); }
      if (found.length > 1) { throw ksErr_('key_duplicate'); }
      if (!ksAllText_(found[0])) { throw ksErr_('key_row_not_text'); }
      var key = ksRowObject_(akCols, found[0]);
      if (!ksVerifyRowMac_(key)) { throw ksErr_('key_integrity_failed'); }
      if (key.status !== 'approved' || key.dispute_state !== 'none') { throw ksErr_('key_not_approved'); }   /* already invalid: nothing to dispute here */

      /* 2. Its committed key set: exactly one commit-marker row that agrees with the key. */
      var sn = setSh.getLastRow() - 1, marker = null, hits = 0;
      if (sn >= 1) {
        setSh.getRange(2, 1, sn, setCols.length).getValues().forEach(function (cells) {
          if (ksCellString_(cells[setCols.indexOf('key_set_id')]) !== key.key_set_id) { return; }
          hits++; marker = ksAllText_(cells) ? ksRowObject_(setCols, cells) : { malformed: true };
        });
      }
      if (!hits) { throw ksErr_('key_set_uncommitted'); }
      if (hits > 1) { throw ksErr_('key_set_duplicate'); }
      if (marker.malformed) { throw ksErr_('key_set_malformed'); }
      if (marker.paper_id !== key.paper_id || marker.approved_at !== key.approved_at || marker.approved_by !== key.approved_by || !KS_ID_RE.test(marker.batch_id)) { throw ksErr_('key_set_mismatch'); }

      /* 3. The event this call stands for, and what already exists about this key. */
      var eventId = ksDerivedId_('evt-', ['disputed', inp.key_id]);
      var expected = { event_id: eventId, ts: '', event_type: 'disputed', key_id: key.key_id, key_set_id: key.key_set_id, batch_id: marker.batch_id, question_id: key.question_id,
        question_version: key.question_version, revision: key.revision, actor: actor, reason: inp.reason, official_reference_url: inp.url, official_reference_date: inp.date,
        old_value_json: '{"state":"approved"}', new_value_json: '{"state":"disputed"}', linked_key_id: '' };   /* no key material; a dispute links to no other key */
      var en = evSh.getLastRow() - 1, same = null, disputedOther = 0, otherInvalid = false, idRows = 0;
      if (en >= 1) {
        evSh.getRange(2, 1, en, evCols.length).getValues().forEach(function (cells) {
          var kid = ksCellString_(cells[evCols.indexOf('key_id')]), eid = ksCellString_(cells[evCols.indexOf('event_id')]);
          if (kid !== key.key_id && eid !== eventId) { return; }
          if (!ksAllText_(cells)) { throw ksErr_('event_row_not_text'); }
          var e = ksRowObject_(evCols, cells);
          if (eid === eventId) { idRows++; same = e; return; }
          if (e.event_type === 'disputed') { disputedOther++; } else if (e.event_type !== 'approved') { otherInvalid = true; }
        });
      }
      if (idRows > 1 || disputedOther) { throw ksErr_('dispute_conflict'); }
      if (same) {   /* identical retry: compare every canonical field except the timestamp */
        var keys = Object.keys(expected);
        for (var i = 0; i < keys.length; i++) { if (keys[i] !== 'ts' && same[keys[i]] !== expected[keys[i]]) { throw ksErr_('dispute_conflict'); } }
        if (!/^\d{4}-\d{2}-\d{2}T/.test(same.ts) || !ksValidDate_(same.ts)) { throw ksErr_('dispute_conflict'); }
        var auditAgain = ksAuditDispute_(ctx, actor, eventId, 'paper=' + key.paper_id + ';key_set=' + key.key_set_id + ';question=' + key.question_id + '@' + key.question_version);
        var refuses = null;
        try { refuses = ksLoadApprovedKeySetLocked_(key.paper_id); } catch (eLoad) { refuses = null; }   /* a throw is also a refusal */
        return { ok: true, code: 'already_disputed', event_id: eventId, ts: same.ts, key_set_id: key.key_set_id, question_id: key.question_id, question_version: key.question_version,
          appended: false, audit: auditAgain, loader_refuses: !(refuses && refuses.ok === true) };
      }
      if (otherInvalid) { throw ksErr_('key_not_current'); }   /* a withdrawal, supersession or correction already exists */

      /* 4. The committed set must currently verify end to end (existing loader, locked variant) and contain this key. */
      var loaded = ksLoadApprovedKeySetLocked_(key.paper_id);
      if (!loaded || loaded.ok !== true) { return { ok: false, code: 'key_set_not_usable', reason: loaded && typeof loaded.code === 'string' ? loaded.code : 'unknown' }; }
      var inSet = loaded.keys.filter(function (k) { return k.key_id === key.key_id && k.key_set_id === key.key_set_id && k.question_id === key.question_id && k.question_version === key.question_version && k.revision === key.revision; });
      if (inSet.length !== 1) { throw ksErr_('key_set_mismatch'); }

      /* 5. Append exactly one row (plain text first), read it back, confirm it is the only row with this id. */
      expected.ts = ksNowIso_();
      var row = evCols.map(function (c) { return expected[c] === undefined ? '' : String(expected[c]); });
      var start = evSh.getLastRow() + 1;
      if (evSh.getMaxRows() < start) { evSh.insertRowsAfter(evSh.getMaxRows(), 1); }
      var rng = evSh.getRange(start, 1, 1, evCols.length);
      rng.setNumberFormat('@'); rng.setValues([row]); SpreadsheetApp.flush();
      var back = evSh.getRange(start, 1, 1, evCols.length).getValues()[0];
      for (var c = 0; c < evCols.length; c++) { if (typeof back[c] !== 'string' || back[c] !== row[c]) { throw ksErr_('readback_failed'); } }
      var all = evSh.getLastRow() - 1, count = 0;
      evSh.getRange(2, 1, all, evCols.length).getValues().forEach(function (cells) { if (ksCellString_(cells[evCols.indexOf('event_id')]) === eventId) { count++; } });
      if (count !== 1) { throw ksErr_('readback_failed'); }

      /* 6. The existing loader must now refuse the set. It is not modified; this only checks that the event is being enforced. */
      var after = ksLoadApprovedKeySetLocked_(key.paper_id);
      var enforced = !(after && after.ok === true);
      var audit = ksAuditDispute_(ctx, actor, eventId, 'paper=' + key.paper_id + ';key_set=' + key.key_set_id + ';question=' + key.question_id + '@' + key.question_version);
      if (!enforced) { return { ok: false, code: 'dispute_not_enforced', event_id: eventId, appended: true, audit: audit }; }
      Logger.log('KeyStore: dispute event recorded for one key; the key set is now refused by the loader. Audit: ' + audit + '.');
      return { ok: true, code: 'dispute_opened', event_id: eventId, ts: expected.ts, key_set_id: key.key_set_id, question_id: key.question_id, question_version: key.question_version,
        appended: true, audit: audit, loader_refuses: true };
    });
  });
}

/* Task 38 helpers (read-only validation; no writes). */
/* ISO date-time: a calendar-valid date, a 'T' time part with an explicit zone, nothing else (a bare date is not a date-time). */
function ksValidIsoDateTime_(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(s) || !ksValidDate_(s)) { return false; }   /* ksValidDate_ checks the calendar date, the time and that a zone is present */
  var z = /(?:Z|[+-](\d{2}):(\d{2}))$/.exec(s);                                                         /* ksValidDate_ does not range-check the offset: do it here */
  return !!z && (z[1] === undefined || (+z[1] <= 23 && +z[2] <= 59));
}
/* Canonical e-mail: exactly what ksIdentity_ produces (trimmed, lower-case, one '@', no whitespace or control characters). */
function ksCanonicalEmail_(s) { return typeof s === 'string' && s === s.trim().toLowerCase() && /^[^@\s]+@[^@\s]+$/.test(s) && !ksHasControl_(s); }

/* ======================================================================================================
 * admin_repair_key_dispute_audit (Task 37). Owner-run editor function. Not reachable over HTTP; no router entry.
 *
 *   admin_repair_key_dispute_audit(key_id)
 *
 * Restores a missing 'key_dispute_opened' row in AUTH_DB.audit_logs for a dispute event ALREADY committed in KEYS_DB.key_events (for example when
 * admin_open_key_dispute reported audit_failed). It writes nothing else: key_events, answer_keys and key_sets are only read, and existing audit rows
 * are never edited or deleted. It does not use the key-set loader (a disputed set is expected to be refused), does not resolve the dispute, rescore,
 * or touch any policy gate.
 *
 * The executing user is authenticated with ksIdentity_() (required to run) but is NOT written: the audit row keeps the ORIGINAL actor of the event.
 * The row has the same shape ksAuditDispute_ writes: event key_dispute_opened, user_id = event actor, target_id = event id, result ok, detail =
 * paper/key set/question@version. No reason text, reference, answer value or NAT bound is copied. Its ts is the time of the repair (the original
 * audit time is unknown; the event's own ts stays in key_events).
 * Existing rows for this event id: none -> append, read back, verify; exactly one consistent -> ok without appending; duplicate or different -> fail closed.
 * Results carry short codes only.
 * ==================================================================================================== */
function admin_repair_key_dispute_audit(key_id) {
  return ksRun_(function () {
    ksIdentity_();                                               /* must be an identifiable executing user; never an argument */
    if (typeof key_id !== 'string' || !/^key-[0-9a-f]{40}$/.test(key_id)) { throw ksErr_('dispute_key_id_invalid'); }
    ksMacSecret_();
    return ksWithLock_(function () {
      var ctx = ksOpen_();
      var akCols = ANSWER_KEY_COLUMNS, setCols = PRIVATE_DB_SCHEMAS.KEYS_DB.key_sets.columns, evCols = PRIVATE_DB_SCHEMAS.KEYS_DB.key_events.columns;
      var akSh = ksSheet_(ctx.keys, 'answer_keys', akCols), setSh = ksSheet_(ctx.keys, 'key_sets', setCols), evSh = ksSheet_(ctx.keys, 'key_events', evCols);

      /* 1. Exactly one valid key row. */
      var an = akSh.getLastRow() - 1, rows = [];
      if (an >= 1) { akSh.getRange(2, 1, an, akCols.length).getValues().forEach(function (c) { if (ksCellString_(c[akCols.indexOf('key_id')]) === key_id) { rows.push(c); } }); }
      if (!rows.length) { throw ksErr_('dispute_key_not_found'); }
      if (rows.length > 1) { throw ksErr_('key_duplicate'); }
      if (!ksAllText_(rows[0])) { throw ksErr_('key_row_not_text'); }
      var key = ksRowObject_(akCols, rows[0]);
      if (!ksVerifyRowMac_(key)) { throw ksErr_('key_integrity_failed'); }
      if (key.status !== 'approved' || key.dispute_state !== 'none') { throw ksErr_('key_not_approved'); }   /* the dispute task must leave the key row unchanged */

      /* 2. Exactly one commit marker for its set, checked against the key like admin_open_key_dispute does. */
      var sn = setSh.getLastRow() - 1, markers = [];
      if (sn >= 1) { setSh.getRange(2, 1, sn, setCols.length).getValues().forEach(function (c) { if (ksCellString_(c[setCols.indexOf('key_set_id')]) === key.key_set_id) { markers.push(c); } }); }
      if (!markers.length) { throw ksErr_('key_set_uncommitted'); }
      if (markers.length > 1) { throw ksErr_('key_set_duplicate'); }
      if (!ksAllText_(markers[0])) { throw ksErr_('key_set_malformed'); }
      var marker = ksRowObject_(setCols, markers[0]);
      if (marker.paper_id !== key.paper_id || marker.approved_at !== key.approved_at || marker.approved_by !== key.approved_by || !KS_ID_RE.test(marker.batch_id)) { throw ksErr_('key_set_mismatch'); }

      /* 3. Exactly one dispute event, with the deterministic id; every field is checked against the stored records and the original function's rules. */
      var eventId = ksDerivedId_('evt-', ['disputed', key_id]), en = evSh.getLastRow() - 1, idRows = [], disputedForKey = 0;
      if (en >= 1) {
        evSh.getRange(2, 1, en, evCols.length).getValues().forEach(function (c) {
          var kid = ksCellString_(c[evCols.indexOf('key_id')]), eid = ksCellString_(c[evCols.indexOf('event_id')]);
          if (kid !== key_id && eid !== eventId) { return; }
          if (!ksAllText_(c)) { throw ksErr_('event_row_not_text'); }
          var e = ksRowObject_(evCols, c);
          if (eid === eventId) { idRows.push(e); }
          if (e.event_type === 'disputed' && kid === key_id) { disputedForKey++; }
        });
      }
      if (!idRows.length) { throw ksErr_('dispute_event_not_found'); }
      if (idRows.length > 1 || disputedForKey > 1) { throw ksErr_('dispute_event_duplicate'); }
      var ev = idRows[0];
      if (ev.event_type !== 'disputed') { throw ksErr_('dispute_event_inconsistent'); }
      var inp = null;
      try { inp = ksDisputeInput_(key_id, ev.reason, ev.official_reference_url, ev.official_reference_date); } catch (eInp) { throw ksErr_('dispute_event_inconsistent'); }
      if (ev.event_id !== eventId || ev.key_id !== key.key_id || ev.key_set_id !== key.key_set_id || ev.batch_id !== marker.batch_id || ev.question_id !== key.question_id ||
          ev.question_version !== key.question_version || ev.revision !== key.revision ||
          ev.old_value_json !== '{"state":"approved"}' || ev.new_value_json !== '{"state":"disputed"}' || ev.linked_key_id !== '' ||
          !ksCanonicalEmail_(ev.actor) || !ksValidIsoDateTime_(ev.ts) ||
          inp.reason !== ev.reason || inp.url !== ev.official_reference_url || inp.date !== ev.official_reference_date) { throw ksErr_('dispute_event_inconsistent'); }   /* stored text must already be in the canonical (trimmed) form the original wrote */

      /* 4. The audit row this event should have (original actor; no reason, reference or key material). */
      var detail = 'paper=' + key.paper_id + ';key_set=' + key.key_set_id + ';question=' + key.question_id + '@' + key.question_version;
      var authId = ksProp_(ctx.props, PRIVATE_DB_PROPERTY_KEYS.AUTH_DB), keysId = ksProp_(ctx.props, PRIVATE_DB_PROPERTY_KEYS.KEYS_DB), examId = ksProp_(ctx.props, PRIVATE_DB_PROPERTY_KEYS.EXAM_DB);
      var publicId = ksProp_(ctx.props, KEYSTORE_PUBLIC_ID_PROPERTY);
      if (!authId) { throw ksErr_('audit_config_missing'); }
      if (authId === keysId || authId === examId || (publicId && authId === publicId)) { throw ksErr_('audit_config_conflict'); }
      var ass;
      try { ass = SpreadsheetApp.openById(authId); } catch (e1) { throw ksErr_('audit_db_unavailable'); }
      var aCols = PRIVATE_DB_SCHEMAS.AUTH_DB.audit_logs.columns, aSh = ksSheet_(ass, 'audit_logs', aCols);
      var iEv = aCols.indexOf('event'), iT = aCols.indexOf('target_id'), n = aSh.getLastRow() - 1, existing = [];
      if (n >= 1) {
        aSh.getRange(2, 1, n, aCols.length).getValues().forEach(function (c) { if (ksCellString_(c[iEv]) === 'key_dispute_opened' && ksCellString_(c[iT]) === eventId) { existing.push(c); } });
      }
      if (existing.length > 1) { throw ksErr_('audit_duplicate'); }
      if (existing.length === 1) {
        if (!ksAllText_(existing[0])) { throw ksErr_('audit_conflict'); }
        var a = ksRowObject_(aCols, existing[0]);
        if (a.event !== 'key_dispute_opened' || a.target_id !== eventId || !ksValidIsoDateTime_(a.ts) || a.user_id !== ev.actor || a.result !== 'ok' || a.detail !== detail) { throw ksErr_('audit_conflict'); }
        return { ok: true, code: 'audit_present', event_id: eventId, appended: false };
      }

      /* 5. Append one row (plain text first), read it back, confirm it is the only row for this event. */
      var row = aCols.map(function (c) { return c === 'ts' ? ksNowIso_() : c === 'event' ? 'key_dispute_opened' : c === 'user_id' ? ev.actor : c === 'target_id' ? eventId : c === 'result' ? 'ok' : c === 'detail' ? detail : ''; });
      var start = aSh.getLastRow() + 1;
      if (aSh.getMaxRows() < start) { aSh.insertRowsAfter(aSh.getMaxRows(), 1); }
      var rng = aSh.getRange(start, 1, 1, aCols.length);
      rng.setNumberFormat('@'); rng.setValues([row]); SpreadsheetApp.flush();
      var back = aSh.getRange(start, 1, 1, aCols.length).getValues()[0];
      for (var k = 0; k < aCols.length; k++) { if (typeof back[k] !== 'string' || back[k] !== row[k]) { throw ksErr_('audit_readback_failed'); } }
      var total = aSh.getLastRow() - 1, count = 0;
      aSh.getRange(2, 1, total, aCols.length).getValues().forEach(function (c) { if (ksCellString_(c[iEv]) === 'key_dispute_opened' && ksCellString_(c[iT]) === eventId) { count++; } });
      if (count !== 1) { throw ksErr_('audit_readback_failed'); }
      Logger.log('KeyStore: missing dispute audit record restored for one event.');
      return { ok: true, code: 'audit_repaired', event_id: eventId, appended: true };
    });
  });
}
