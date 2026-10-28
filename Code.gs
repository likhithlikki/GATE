/**
 * GATE Prep Studio: read-only public question catalogue (Google Apps Script web app).
 *
 * SCOPE (Task 20): public question delivery only. This script has NO write operations, accounts, sessions,
 * exam attempts or scoring, and it never reads answer keys. It must be bound to a DEDICATED public spreadsheet
 * whose only sheet used is "Questions_Public". Never point it at a spreadsheet that holds private data.
 *
 * Configuration (Project Settings > Script properties, never sent to the browser):
 *   PUBLIC_CATALOGUE_SPREADSHEET_ID = <ID of the dedicated public spreadsheet>
 *   PUBLIC_CATALOGUE_PUBLISHED_AT   = <optional, owner-supplied ISO 8601 UTC time, e.g. 2026-10-28T09:30:00Z>
 *                                     Reported as published_at. Never guessed; absent or invalid means null.
 *
 * catalogue_version = lowercase hex SHA-256 of the validated, normalized public payload
 * ({schema_version, questions} with a fixed key order, in sheet order). It changes whenever public question
 * content or metadata changes. It is computed with Utilities.computeDigest (no extra permissions).
 *
 * Operations (GET only, query parameter "op"):
 *   ?op=health                         -> { ok, service, schema_version, status, checks }
 *   ?op=catalogue                      -> { ok:true, schema_version:1, catalogue_version, count, published_at, questions:[...] }
 *   ?op=metadata                       -> { ok:true, schema_version:1, catalogue_version, count, published_at } (no question text)
 *   add &callback=gatePublicCatalogueCallback for JSONP. Any other callback name is refused (plain JSON error).
 *
 * Sheet "Questions_Public" header row (row 1) must contain exactly these columns, in any order:
 *   id, branch, year, subject, topic, type, marks, text, options_json, source_name
 *   options_json: for MCQ/MSQ a JSON array like [{"id":"A","text":"..."}, ...]; blank for NAT.
 * Any other non-blank header, or any answer-key / explanation / scoring-type header, rejects the whole catalogue
 * BEFORE any data row is read. Any invalid record rejects the whole catalogue (nothing is published partially).
 */

var SERVICE_NAME = 'gate-prep-public-catalogue';
var SCHEMA_VERSION = 1;
var SHEET_NAME = 'Questions_Public';
var PROPERTY_SPREADSHEET_ID = 'PUBLIC_CATALOGUE_SPREADSHEET_ID';
var PROPERTY_PUBLISHED_AT = 'PUBLIC_CATALOGUE_PUBLISHED_AT';
var PUBLISHED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
var ALLOWED_CALLBACK = 'gatePublicCatalogueCallback'; // the ONLY JSONP callback name ever emitted

var PUBLIC_COLUMNS = ['id', 'branch', 'year', 'subject', 'topic', 'type', 'marks', 'text', 'options_json', 'source_name'];
var TYPES = ['MCQ', 'MSQ', 'NAT'];
var ID_RE = /^[A-Za-z0-9_.\-]{1,64}$/;
var OPTION_ID_RE = /^[A-Za-z0-9_.\-]{1,16}$/;
var LIMITS = { questions: 2000, text: 20000, optionText: 5000, field: 100, sourceName: 200, payloadChars: 4500000, issues: 20 };

/* Same normalisation as the browser (lower-case, letters and digits only), so answer_key, answerKey and "Answer Key" all match. */
var FORBIDDEN_NAMES = ['answerkey', 'answer', 'answers', 'ans', 'correctanswer', 'correctanswers', 'correctoption',
  'correctoptions', 'correct', 'iscorrect', 'key', 'keys', 'solution', 'solutions', 'explanation', 'explanations',
  'rationale', 'officialanswer', 'acceptedanswers', 'answerrange', 'natrange', 'natmin', 'natmax', 'tolerance',
  'score', 'scores', 'scoring', 'markscheme', 'markingscheme', 'markstoall', 'mta', 'secret'];

var ERRORS = {
  bad_request: 'The request was not understood. Use op=health, op=metadata or op=catalogue.',
  bad_callback: 'This callback name is not accepted.',
  not_configured: 'The catalogue service is not configured yet.',
  source_unavailable: 'The catalogue source could not be opened.',
  sheet_missing: 'The public catalogue sheet was not found.',
  forbidden_columns: 'The catalogue sheet contains answer-key, explanation or scoring-type columns, so nothing was published.',
  bad_columns: 'The catalogue sheet columns do not match the public schema, so nothing was published.',
  empty_catalogue: 'The catalogue contains no questions.',
  too_large: 'The catalogue is larger than this service can publish.',
  malformed_data: 'Some catalogue records are invalid, so nothing was published.',
  internal_error: 'The catalogue service had an unexpected problem.'
};

/* ---------------- Entry point (read-only: there is no doPost) ---------------- */
function doGet(e) {
  var params = (e && e.parameter) || {};
  var callback = null;
  try {
    if (Object.prototype.hasOwnProperty.call(params, 'callback')) {
      if (params.callback !== ALLOWED_CALLBACK) { return respond_(errorBody_('bad_callback'), null); }
      callback = ALLOWED_CALLBACK;
    }
    var op = typeof params.op === 'string' ? params.op : 'health';
    if (op === 'health') { return respond_(healthBody_(), callback); }
    if (op === 'catalogue') { return respond_(catalogueBody_(), callback); }
    if (op === 'metadata') { return respond_(metadataBody_(), callback); }
    return respond_(errorBody_('bad_request'), callback);
  } catch (err) {
    console.error('doGet failed: ' + safeMessage_(err)); // server-side log only; never returned
    return respond_(errorBody_('internal_error'), callback);
  }
}

/* ---------------- Responses ---------------- */
function errorBody_(code, details) {
  var body = { ok: false, schema_version: SCHEMA_VERSION, error: { code: code, message: ERRORS[code] || ERRORS.internal_error } };
  if (details && details.length) { body.error.issues = details.slice(0, LIMITS.issues); } // row numbers and field names only
  return body;
}

function respond_(body, callback) {
  var json = JSON.stringify(body)
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); // keep the payload valid inside JavaScript
  var out = ContentService.createTextOutput();
  if (callback === ALLOWED_CALLBACK) {
    out.setMimeType(ContentService.MimeType.JAVASCRIPT);
    out.setContent(ALLOWED_CALLBACK + '(' + json + ');'); // constant name; the payload is JSON data only
  } else {
    out.setMimeType(ContentService.MimeType.JSON);
    out.setContent(json);
  }
  return out;
}

function safeMessage_(err) { return String(err && err.message ? err.message : err).slice(0, 300); }

/* ---------------- Sheet access (read-only, one dedicated sheet) ---------------- */
function openSheet_() {
  var id = PropertiesService.getScriptProperties().getProperty(PROPERTY_SPREADSHEET_ID);
  if (!id || !String(id).trim()) { return { error: 'not_configured' }; }
  var ss;
  try { ss = SpreadsheetApp.openById(String(id).trim()); }
  catch (err) { console.error('openById failed: ' + safeMessage_(err)); return { error: 'source_unavailable' }; }
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) { return { error: 'sheet_missing' }; }
  return { sheet: sheet };
}

function normName_(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }

/* Reads ONLY the header row and checks it. Returns { error } or { columns: {name: 1-based index}, lastRow }. */
function readHeader_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) { return { error: 'bad_columns' }; }
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var columns = {}, forbidden = false, unexpected = false, dupe = false;
  headers.forEach(function (h, i) {
    var name = String(h === null || h === undefined ? '' : h).trim();
    if (!name) { return; }
    if (FORBIDDEN_NAMES.indexOf(normName_(name)) >= 0) { forbidden = true; return; }
    if (PUBLIC_COLUMNS.indexOf(name) < 0) { unexpected = true; return; }
    if (columns[name]) { dupe = true; return; }
    columns[name] = i + 1;
  });
  if (forbidden) { return { error: 'forbidden_columns' }; }
  if (unexpected || dupe) { return { error: 'bad_columns' }; }
  for (var i = 0; i < PUBLIC_COLUMNS.length; i++) { if (!columns[PUBLIC_COLUMNS[i]]) { return { error: 'bad_columns' }; } }
  return { columns: columns };
}

/* ---------------- Health ---------------- */
function healthBody_() {
  var checks = { configured: false, sheet_found: false, columns_ok: false };
  var opened = openSheet_();
  if (opened.error !== 'not_configured') { checks.configured = true; }
  if (opened.sheet) {
    checks.sheet_found = true;
    checks.columns_ok = !readHeader_(opened.sheet).error;
  }
  return { ok: true, service: SERVICE_NAME, schema_version: SCHEMA_VERSION, read_only: true,
           status: (checks.configured && checks.sheet_found && checks.columns_ok) ? 'ready' : 'not_ready', checks: checks };
}

/* ---------------- Catalogue ---------------- */
function nonEmpty_(v, max) { return typeof v === 'string' && v.trim().length > 0 && (!max || v.trim().length <= max); }
function whole_(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }

/* Returns a list of problem labels (field names only, never cell contents). */
function validateRow_(r) {
  var p = [];
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) { p.push('id'); }
  ['branch', 'subject', 'topic'].forEach(function (f) { if (!nonEmpty_(r[f], LIMITS.field)) { p.push(f); } });
  if (!whole_(r.year) || r.year < 1900 || r.year > 2100) { p.push('year'); }
  if (TYPES.indexOf(r.type) < 0) { p.push('type'); }
  if (!whole_(r.marks) || r.marks <= 0) { p.push('marks'); }
  if (!nonEmpty_(r.text, LIMITS.text)) { p.push('text'); }
  if (!nonEmpty_(r.source_name, LIMITS.sourceName)) { p.push('source_name'); }
  return p;
}

/* Parses options_json. Returns { options } or { problem }. Only {id, text} objects are accepted. */
function parseOptions_(raw, type) {
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
    for (var k = 0; k < keys.length; k++) { if (keys[k] !== 'id' && keys[k] !== 'text') { return { problem: 'options_json' }; } } // rejects e.g. "correct"
    if (!nonEmpty_(o.id, 16) || !OPTION_ID_RE.test(o.id.trim()) || !nonEmpty_(o.text, LIMITS.optionText)) { return { problem: 'options_json' }; }
    var oid = o.id.trim();
    if (seen[oid]) { return { problem: 'options_json' }; }
    seen[oid] = true;
    out.push({ id: oid, text: o.text.trim() });
  }
  return { options: out };
}

/* Validates the sheet and returns { questions } or an error body ({ ok:false, ... }). */
function buildCatalogue_() {
  var opened = openSheet_();
  if (opened.error) { return errorBody_(opened.error); }
  var sheet = opened.sheet;
  var header = readHeader_(sheet);
  if (header.error) { return errorBody_(header.error); }

  var lastRow = sheet.getLastRow();
  var rowCount = lastRow - 1;
  if (rowCount < 1) { return errorBody_('empty_catalogue'); }
  if (rowCount > LIMITS.questions + 500) { return errorBody_('too_large'); } // guards against reading a huge sheet at all

  var cols = header.columns;
  var width = sheet.getLastColumn();
  var values = sheet.getRange(2, 1, rowCount, width).getValues();

  var questions = [], issues = [], seenIds = {};
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var r = {};
    var allBlank = true;
    PUBLIC_COLUMNS.forEach(function (name) { // only allowlisted columns are ever read from the row
      var v = row[cols[name] - 1];
      r[name] = v;
      if (v !== '' && v !== null && v !== undefined) { allBlank = false; }
    });
    if (allBlank) { continue; }
    var sheetRow = i + 2;
    var problems = validateRow_(r);
    var opt = { options: null };
    if (TYPES.indexOf(r.type) >= 0) {
      opt = parseOptions_(r.options_json, r.type);
      if (opt.problem) { problems.push(opt.problem); }
    }
    if (!problems.length && seenIds[r.id]) { problems.push('id (duplicate)'); }
    if (problems.length) { issues.push('row ' + sheetRow + ': ' + problems.join(', ')); continue; }
    seenIds[r.id] = true;
    var q = { id: r.id, branch: r.branch.trim(), year: r.year, subject: r.subject.trim(), topic: r.topic.trim(),
              type: r.type, marks: r.marks, text: r.text.trim(), source: { name: r.source_name.trim() } };
    if (opt.options) { q.options = opt.options; }
    questions.push(q);
  }

  if (issues.length) { return errorBody_('malformed_data', issues); }
  if (!questions.length) { return errorBody_('empty_catalogue'); }
  if (questions.length > LIMITS.questions) { return errorBody_('too_large'); }

  var payload = { schema_version: SCHEMA_VERSION, questions: questions };
  if (JSON.stringify(payload).length > LIMITS.payloadChars) { return errorBody_('too_large'); }
  return { questions: questions };
}

/* SHA-256 (lowercase hex) of the canonical JSON of the validated payload. Key order is fixed by construction in
 * buildCatalogue_, so the same content always gives the same version. */
function computeVersion_(questions) {
  var canonical = JSON.stringify({ schema_version: SCHEMA_VERSION, questions: questions });
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, canonical, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length < 2 ? '0' + v : v; }).join('');
}

/* Owner-supplied only. Returns an ISO string or null (absent or not a valid ISO 8601 UTC time). */
function publishedAt_() {
  var v = PropertiesService.getScriptProperties().getProperty(PROPERTY_PUBLISHED_AT);
  if (!v) { return null; }
  v = String(v).trim();
  return PUBLISHED_AT_RE.test(v) && !isNaN(new Date(v).getTime()) ? v : null;
}

function catalogueBody_() {
  var built = buildCatalogue_();
  if (built.ok === false) { return built; }
  return { ok: true, schema_version: SCHEMA_VERSION, catalogue_version: computeVersion_(built.questions),
           count: built.questions.length, published_at: publishedAt_(), questions: built.questions };
}

/* No question text or options. Still validates the whole catalogue, so no version is ever claimed for bad data. */
function metadataBody_() {
  var built = buildCatalogue_();
  if (built.ok === false) { return built; }
  return { ok: true, schema_version: SCHEMA_VERSION, catalogue_version: computeVersion_(built.questions),
           count: built.questions.length, published_at: publishedAt_() };
}
