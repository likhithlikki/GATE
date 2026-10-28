/**
 * Standalone read-only validation helpers for the backup project (Task 41). Nothing here writes, and nothing depends on the private backend.
 * Errors are bkErr_ codes only; messages never contain spreadsheet IDs, folder IDs, e-mail addresses or data.
 */
var BK_DB_NAMES = ['AUTH_DB', 'EXAM_DB', 'KEYS_DB'];
var BK_SOURCE_PROPERTIES = { AUTH_DB: 'AUTH_DB_ID', EXAM_DB: 'EXAM_DB_ID', KEYS_DB: 'KEYS_DB_ID' };
var BK_FOLDER_PROPERTY = 'PRIVATE_BACKUP_FOLDER_ID';
var BK_OWNER_PROPERTY = 'BACKUP_OWNER_EMAIL';
var BK_PUBLIC_ID_PROPERTY = 'PUBLIC_CATALOGUE_SPREADSHEET_ID';   /* optional: if set, no source or destination may equal it */
var BK_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
var BK_EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

function bkErr_(code) { var e = new Error('Backup ' + code); e.name = 'BackupError'; e.bkCode = code; return e; }
function bkProp_(props, name) { var v = props.getProperty(name); return v && String(v).trim() ? String(v).trim() : ''; }
function bkNowIso_() { return new Date().toISOString(); }

/* Configured owner identity: must be a plain, lower-case-able e-mail. */
function bkOwnerConfig_(props) {
  var o = bkProp_(props, BK_OWNER_PROPERTY).toLowerCase();
  if (!o) { throw bkErr_('owner_not_configured'); }
  if (!BK_EMAIL_RE.test(o)) { throw bkErr_('owner_invalid'); }
  return o;
}

/* The person running the script must BE the configured owner; both Google identity values must be present and equal it. Fails closed otherwise. */
function bkRequireOwner_(ownerEmail) {
  var eff = '', act = '';
  try { eff = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase(); } catch (e1) { eff = ''; }
  try { act = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase(); } catch (e2) { act = ''; }
  if (!eff || !act) { throw bkErr_('identity_unavailable'); }
  if (eff !== ownerEmail || act !== ownerEmail) { throw bkErr_('owner_mismatch'); }
}

/* Reads the destination and source IDs from Script Properties and refuses anything missing, malformed, duplicated or mixed up. */
function bkReadConfig_(props) {
  var folderId = bkProp_(props, BK_FOLDER_PROPERTY);
  if (!folderId) { throw bkErr_('backup_folder_not_configured'); }
  if (!BK_ID_RE.test(folderId)) { throw bkErr_('backup_folder_id_invalid'); }
  var ids = {}, seen = {}, publicId = bkProp_(props, BK_PUBLIC_ID_PROPERTY);
  BK_DB_NAMES.forEach(function (db) {
    var v = bkProp_(props, BK_SOURCE_PROPERTIES[db]);
    if (!v) { throw bkErr_('source_not_configured'); }
    if (!BK_ID_RE.test(v)) { throw bkErr_('source_id_invalid'); }
    ids[db] = v;
  });
  BK_DB_NAMES.forEach(function (db) {
    if (seen[ids[db]] || ids[db] === folderId || (publicId && ids[db] === publicId)) { throw bkErr_('source_config_conflict'); }
    seen[ids[db]] = true;
  });
  if (publicId && publicId === folderId) { throw bkErr_('backup_config_conflict'); }
  return { folderId: folderId, ids: ids };
}

/* One tab: it exists and its header row starts with exactly the expected columns (extra trailing headers are tolerated, nothing else). */
function bkTabState_(ss, tab, columns) {
  var sh = ss.getSheetByName(tab);
  if (!sh) { return 'missing_tab'; }
  var n = columns.length;
  if (sh.getLastRow() < 1 || sh.getLastColumn() < n) { return 'header_mismatch'; }
  var row1 = sh.getRange(1, 1, 1, n).getValues()[0];
  for (var i = 0; i < n; i++) { if (String(row1[i] === null || row1[i] === undefined ? '' : row1[i]).trim() !== columns[i]) { return 'header_mismatch'; } }
  return 'ok';
}

/* Opens one database and checks every required tab. Returns the open spreadsheet; throws source_unavailable or source_not_ready. */
function bkOpenAndCheck_(db, id) {
  var ss;
  try { ss = SpreadsheetApp.openById(id); } catch (e) { throw bkErr_('source_unavailable'); }
  var tabs = BACKUP_DB_SCHEMAS[db];
  Object.keys(tabs).forEach(function (tab) { if (bkTabState_(ss, tab, tabs[tab]) !== 'ok') { throw bkErr_('source_not_ready'); } });
  return ss;
}

/* All three databases, before anything is written. Worst problem wins: unavailable over not-ready. */
function bkValidateSources_(ids) {
  var out = {}, problem = '';
  BK_DB_NAMES.forEach(function (db) {
    try { out[db] = bkOpenAndCheck_(db, ids[db]); }
    catch (e) { var c = e && e.bkCode ? e.bkCode : 'source_unavailable'; if (!problem || c === 'source_unavailable') { problem = c; } }
  });
  if (problem) { throw bkErr_(problem); }
  return out;
}

function bkDims_(ss) {
  var out = {};
  ss.getSheets().forEach(function (sh) { out[sh.getName()] = { last_row: sh.getLastRow(), last_column: sh.getLastColumn() }; });
  return out;
}
function bkSameDims_(a, b) {
  var ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) { return false; }
  return ka.every(function (k) { return b[k] && a[k].last_row === b[k].last_row && a[k].last_column === b[k].last_column; });
}
