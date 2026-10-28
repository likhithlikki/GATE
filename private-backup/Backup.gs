/**
 * GATE Prep Studio PRIVATE BACKUP project (Task 41). A SEPARATE Apps Script project from private-backend, run manually by its owner.
 *
 *   admin_backup_private_databases()      run from the Apps Script editor only
 *   admin_verify_private_backup(id)       run from the Apps Script editor only; READ-ONLY check of one existing run folder (Task 43)
 *
 * This project has no doGet/doPost, no web-app deployment, no trigger, no restore, no schedule and no deletion. It is the only place the
 * Drive scope is declared (appsscript.json). It copies the three private databases into a private Drive folder and verifies the copies.
 *
 * Script Properties (all required unless marked optional; nothing is hardcoded):
 *   AUTH_DB_ID, EXAM_DB_ID, KEYS_DB_ID   the source spreadsheets (same values as in private-backend)
 *   PRIVATE_BACKUP_FOLDER_ID             Drive folder dedicated to backups, owned by the backup owner
 *   BACKUP_OWNER_EMAIL                   the one identity allowed to run this: it must equal the executing user AND the folder owner
 *   PUBLIC_CATALOGUE_SPREADSHEET_ID      optional: if set, refused as a source or destination
 *   BACKUP_VERIFY_RUN_FOLDER_ID          optional: needed ONLY to run admin_verify_private_backup() with no argument (e.g. Run button in the editor).
 *                                        It is read only after the owner check, only when no argument was supplied, and never when an argument was
 *                                        supplied (an invalid argument is an error, never replaced by this value). Missing or malformed -> short code,
 *                                        no Drive or Sheets access. Not used by the backup. The ID lives only here or in the argument: never in source, logs or results.
 *
 * Order (nothing is written before step 4 succeeds): 1 owner identity; 2 configuration; 3 all three sources open and match their schema;
 * 4 destination policy; 5 new run folder; 6 copy and verify each database, stopping at the first failure; 7 manifest LAST
 * (manifest.json only when all three verified, else manifest.INCOMPLETE.json), read back.
 *
 * Destination policy is read-only and never changes sharing: folder reachable, not trashed, not My Drive root, owned by BACKUP_OWNER_EMAIL,
 * general access PRIVATE, no editor/viewer/commenter besides the owner, every ancestor up to My Drive root private and unshared, one parent each.
 *
 * Content integrity (Task 45): every tab of every copy gets a SHA-256 fingerprint over its typed cell values and formulas (blank cells included),
 * recorded in manifest version 2. A copy only passes when its fingerprints equal the source's (read before the copy, or, if the source moved
 * meanwhile, after it). admin_verify_private_backup() recomputes them from the copies alone. Version-1 manifests carry no fingerprints and are
 * never reported as content-verified (backup_integrity_not_recorded). Fingerprints do not make three sequential copies an atomic snapshot.
 *
 * Nothing already in the destination is deleted, renamed or overwritten. Results carry short codes and counts, never IDs, links or data.
 * Three separate spreadsheets copied one after another are NOT an atomic snapshot (and this project cannot hold the private backend's lock).
 */
var BK_MAX_ANCESTORS = 20;
var BK_NOTE = 'Three separate spreadsheets are copied one after another; this is not an atomic cross-spreadsheet snapshot.';

function bkAuthError_(e) { return /permission to call|required permissions|authorization is required|not authorized/i.test(String(e && e.message ? e.message : '')); }
function bkDriveFail_(e, fallback) { return bkAuthError_(e) ? 'drive_scope_not_authorized' : (e && e.bkCode ? e.bkCode : fallback); }

/* '' when the item is private and shared with nobody but the owner; else a short reason. Read-only. */
function bkSharingProblem_(item, ownerEmail) {
  if (item.getSharingAccess() !== DriveApp.Access.PRIVATE) { return 'not_private'; }
  var others = 0;
  [item.getEditors(), item.getViewers()].forEach(function (list) {
    (list || []).forEach(function (u) { if (String(u.getEmail() || '').trim().toLowerCase() !== ownerEmail) { others++; } });
  });
  return others ? 'shared_with_others' : '';
}

function bkVerifyDestination_(folderId, ownerEmail) {
  var folder;
  try { folder = DriveApp.getFolderById(folderId); } catch (e) { throw (bkAuthError_(e) ? bkErr_('drive_scope_not_authorized') : bkErr_('backup_folder_unavailable')); }
  try {
    if (folder.isTrashed()) { throw bkErr_('backup_folder_trashed'); }
    var rootId = DriveApp.getRootFolder().getId();
    if (folder.getId() === rootId) { throw bkErr_('backup_folder_is_root'); }
    var owner = folder.getOwner();
    if (!owner) { throw bkErr_('backup_folder_owner_unavailable'); }                     /* shared-drive folders have no single owner */
    if (String(owner.getEmail() || '').trim().toLowerCase() !== ownerEmail) { throw bkErr_('backup_folder_not_owned'); }
    var problem = bkSharingProblem_(folder, ownerEmail);
    if (problem) { throw bkErr_(problem === 'not_private' ? 'backup_folder_not_private' : 'backup_folder_shared'); }
    var cur = folder;
    for (var depth = 0; ; depth++) {
      var parents = cur.getParents(), first = null, extra = false;
      if (parents.hasNext()) { first = parents.next(); extra = parents.hasNext(); }
      if (!first) { break; }
      if (extra) { throw bkErr_('backup_folder_multiple_parents'); }
      if (first.getId() === rootId) { break; }
      if (depth >= BK_MAX_ANCESTORS) { throw bkErr_('backup_folder_ancestry_too_deep'); }
      if (bkSharingProblem_(first, ownerEmail)) { throw bkErr_('backup_folder_inherits_sharing'); }
      cur = first;
    }
    return folder;
  } catch (e2) {
    if (e2 && e2.bkCode) { throw e2; }
    throw (bkAuthError_(e2) ? bkErr_('drive_scope_not_authorized') : bkErr_('backup_folder_unverifiable'));
  }
}

/* Reopens a copy and checks it: same sheet names and sizes as the source (read before or after the copy), schema headers, private, and (Task 45)
 * the same cell-content fingerprints as the source. fp = { ss: source spreadsheet, before: fingerprints read before the copy, afterDims }.
 * The source is re-fingerprinted after the copy only when the copy does not match the earlier read. Returns { dims, fp } of the copy. */
function bkVerifyCopy_(copyId, db, before, after, ownerEmail, file, fp) {
  var ss = SpreadsheetApp.openById(copyId), dims = bkDims_(ss);
  if (!bkSameDims_(dims, before) && !bkSameDims_(dims, after)) { throw bkErr_('copy_content_mismatch'); }
  var tabs = BACKUP_DB_SCHEMAS[db];
  Object.keys(tabs).forEach(function (tab) { if (bkTabState_(ss, tab, tabs[tab]) !== 'ok') { throw bkErr_('copy_schema_mismatch'); } });
  if (bkSharingProblem_(file, ownerEmail)) { throw bkErr_('copy_not_private'); }
  var copyFp = bkFingerprints_(ss, dims), same = bkSameFps_(copyFp, fp.before);
  if (!same) { same = bkSameFps_(copyFp, bkFingerprints_(fp.ss, fp.afterDims)); }
  if (!same) { throw bkErr_('copy_fingerprint_mismatch'); }
  return { dims: dims, fp: copyFp };
}

function admin_backup_private_databases() {
  try {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) { throw bkErr_('busy'); }
    try { return bkRun_(); } finally { lock.releaseLock(); }
  } catch (e) {
    if (e && e.bkCode) { Logger.log('Backup stopped (' + e.bkCode + ').'); return { ok: false, code: e.bkCode, atomic_snapshot: false }; }
    Logger.log('Backup: unexpected error (' + String(e && e.name ? e.name : 'Error') + ').');
    return { ok: false, code: 'internal_error', atomic_snapshot: false };
  }
}

function bkRun_() {
  var props = PropertiesService.getScriptProperties();
  var ownerEmail = bkOwnerConfig_(props);                    /* 1. who may run this */
  bkRequireOwner_(ownerEmail);
  var cfg = bkReadConfig_(props);                            /* 2. configuration */
  var sources = bkValidateSources_(cfg.ids);                 /* 3. every source opens and matches its schema, before any write */
  var folder = bkVerifyDestination_(cfg.folderId, ownerEmail);   /* 4. destination policy */

  var startedAt = bkNowIso_(), stamp = startedAt.replace(/[:.]/g, '-');   /* 5. unique run folder */
  var runId = 'gps-backup-' + stamp + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8), runFolder;
  try {
    if (folder.getFoldersByName(runId).hasNext()) { throw bkErr_('backup_run_folder_exists'); }
    runFolder = folder.createFolder(runId);
    if (bkSharingProblem_(runFolder, ownerEmail)) { return bkFinish_(runFolder, runId, startedAt, [], 'backup_run_folder_not_private', 0, 0); }
  } catch (eR) { throw bkErr_(bkDriveFail_(eR, 'backup_run_folder_failed')); }

  var records = [], created = 0, verified = 0, failCode = '';   /* 6. copy and verify, stop at the first failure */
  BK_DB_NAMES.forEach(function (db) {
    var rec = { type: db, copy_name: db + '_backup_' + stamp, verification: failCode ? 'not_attempted' : 'pending', code: '', tabs: [] };
    records.push(rec);
    if (failCode) { return; }
    try {
      var before = bkDims_(sources[db]);
      var fpBefore = bkFingerprints_(sources[db], before);               /* source content, read BEFORE anything is copied */
      var file = DriveApp.getFileById(cfg.ids[db]).makeCopy(rec.copy_name, runFolder);
      created++;
      var after = bkDims_(sources[db]);
      var vr = bkVerifyCopy_(file.getId(), db, before, after, ownerEmail, file, { ss: sources[db], before: fpBefore, afterDims: after });
      var dims = vr.dims;
      rec.tabs = Object.keys(dims).map(function (t) { return { tab: t, last_row: dims[t].last_row, last_column: dims[t].last_column, sha256: vr.fp[t] }; });
      rec.verification = 'passed'; verified++;
    } catch (eC) { rec.verification = 'failed'; rec.code = bkDriveFail_(eC, 'copy_failed'); failCode = rec.code; }
  });
  return bkFinish_(runFolder, runId, startedAt, records, failCode, created, verified);
}

/* ---- Manifest verification (Task 42) ---- */
/* Structural equality: same types, same object keys (order-independent), arrays compared element by element IN ORDER. */
function bkDeepEqual_(a, b) {
  if (a === b) { return true; }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') { return false; }
  var aa = Array.isArray(a), ab = Array.isArray(b);
  if (aa !== ab) { return false; }
  if (aa) {
    if (a.length !== b.length) { return false; }
    for (var i = 0; i < a.length; i++) { if (!bkDeepEqual_(a[i], b[i])) { return false; } }
    return true;
  }
  var ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.length !== kb.length) { return false; }
  for (var j = 0; j < ka.length; j++) { if (ka[j] !== kb[j] || !bkDeepEqual_(a[ka[j]], b[kb[j]])) { return false; } }
  return true;
}

/* Task 47: strict manifest timestamp, exactly YYYY-MM-DDTHH:mm:ss.sssZ (UTC, as bkNowIso_ writes it). Each component is range-checked against the Gregorian
 * calendar (days per month, leap years, hour 0-23, minute 0-59, second 0-59; no leap second, no 24:00), and the value must survive a round trip through Date
 * unchanged, so nothing that JavaScript would silently normalise into another instant (e.g. 2023-02-29 -> 2023-03-01) is ever accepted. */
function bkIsIso_(s) {
  if (typeof s !== 'string') { return false; }
  var p = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/.exec(s);
  if (!p) { return false; }
  var y = +p[1], mo = +p[2], d = +p[3], h = +p[4], mi = +p[5], sec = +p[6], ms = +p[7];
  var leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  var dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (mo < 1 || mo > 12 || d < 1 || d > dim[mo - 1] || h > 23 || mi > 59 || sec > 59 || ms > 999) { return false; }
  var t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);                                         /* setUTCFullYear, not Date.UTC: years 0-99 must not be mapped to 1900-1999 */
  t.setUTCHours(h, mi, sec, ms);
  return !isNaN(t.getTime()) && t.toISOString() === s;
}

/* Task 46: '' when (rows, cols) is a legitimate size pair for one tab, else a short reason. Both must be non-negative safe integers (no coercion, no -0);
 * they are either BOTH zero (an empty tab, allowed only when mustHaveContent is false) or BOTH at least 1. Zero with nonzero is never valid. */
function bkDimPairProblem_(rows, cols, mustHaveContent) {
  if (typeof rows !== 'number' || typeof cols !== 'number' || !Number.isSafeInteger(rows) || !Number.isSafeInteger(cols)) { return 'not_integer'; }
  if (rows < 0 || cols < 0 || Object.is(rows, -0) || Object.is(cols, -0)) { return 'negative'; }
  if ((rows === 0) !== (cols === 0)) { return 'mixed_zero'; }
  if (rows === 0 && mustHaveContent) { return 'empty'; }
  return '';
}

/* Independent sanity check of a manifest against what a run must look like. '' when sound, else a short reason (never logged with data). */
function bkManifestProblem_(m, runId, wantComplete) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) { return 'shape'; }
  if ((m.manifest_version !== 1 && m.manifest_version !== 2) || m.run_id !== runId || m.atomic_snapshot !== false || m.note !== BK_NOTE) { return 'header'; }   /* 1 = legacy, read-only support (Task 45) */
  if (m.manifest_version === 2 && m.fingerprint_scheme !== BK_FP_SCHEME) { return 'header'; }
  if (m.status !== 'complete' && m.status !== 'incomplete') { return 'status'; }
  if (!bkIsIso_(m.started_at) || !bkIsIso_(m.finished_at) || Date.parse(m.finished_at) < Date.parse(m.started_at)) { return 'timestamps'; }
  if (typeof m.failure_code !== 'string' || (m.status === 'complete') !== (m.failure_code === '')) { return 'failure_code'; }
  if (wantComplete && m.status !== 'complete') { return 'status'; }
  if (!Array.isArray(m.databases) || m.databases.length !== BK_DB_NAMES.length) { return 'database_count'; }
  for (var i = 0; i < BK_DB_NAMES.length; i++) {
    var d = m.databases[i], db = BK_DB_NAMES[i];
    if (!d || d.type !== db || typeof d.copy_name !== 'string' || d.copy_name.indexOf(db + '_backup_') !== 0) { return 'database_record'; }
    if (['passed', 'failed', 'not_attempted', 'pending'].indexOf(d.verification) < 0 || typeof d.code !== 'string' || !Array.isArray(d.tabs)) { return 'database_record'; }
    if (m.status === 'complete' && (d.verification !== 'passed' || d.code !== '')) { return 'database_record'; }
    if (d.verification === 'passed') {
      var need = Object.keys(BACKUP_DB_SCHEMAS[db]), have = Object.create(null);
      for (var t = 0; t < d.tabs.length; t++) {
        var x = d.tabs[t];
        if (!x || typeof x.tab !== 'string' || !x.tab || have[x.tab] === true) { return 'tab_counts'; }
        /* Task 46: a schema tab must be non-empty (it holds its header); a non-schema tab may be empty (0, 0) in a version-2 manifest only.
         * Version-1 manifests never recorded an empty tab (the version-1 code refused to), so they keep refusing it. */
        if (bkDimPairProblem_(x.last_row, x.last_column, Object.prototype.hasOwnProperty.call(BACKUP_DB_SCHEMAS[db], x.tab) || m.manifest_version !== 2)) { return 'tab_counts'; }
        if (m.manifest_version === 2 && (typeof x.sha256 !== 'string' || !BK_SHA_RE.test(x.sha256))) { return 'fingerprint'; }   /* v2: every recorded tab needs a well-formed digest */   /* Task 43: also refuses empty/duplicate tab entries and non-integer sizes */
        have[x.tab] = true;
      }
      if (need.some(function (n) { return !have[n]; })) { return 'tab_counts'; }
    }
  }
  return '';
}

/* true / false / null (could not tell). Read-only. */
function bkHasFile_(folder, name) { try { return folder.getFilesByName(name).hasNext(); } catch (e) { return null; } }

/* Writes one manifest file and reads it back; '' only when the stored content equals the manifest object exactly. Never replaces a file:
 * if that name already exists nothing is written. Returns a short code. */
function bkWriteVerify_(runFolder, name, manifest) {
  if (bkHasFile_(runFolder, name) === true) { return 'manifest_file_exists'; }
  var mf;
  try { mf = runFolder.createFile(name, JSON.stringify(manifest, null, 2), MimeType.PLAIN_TEXT); } catch (e) { return bkAuthError_(e) ? 'drive_scope_not_authorized' : 'manifest_write_failed'; }
  var back;
  try { back = JSON.parse(DriveApp.getFileById(mf.getId()).getBlob().getDataAsString()); } catch (e2) { return 'manifest_read_failed'; }
  return bkDeepEqual_(back, manifest) ? '' : 'manifest_verification_failed';
}

/* 7. Manifest last, read back and compared in full. Complete only when all three copies passed AND the whole manifest verified.
 * If that fails, try to leave a verified manifest.INCOMPLETE.json (never deleting or replacing anything) and say so. */
function bkFinish_(runFolder, runId, startedAt, records, failCode, created, verified) {
  var wantComplete = !failCode && records.length === BK_DB_NAMES.length && verified === BK_DB_NAMES.length;
  function build(status, code) {
    return { manifest_version: BK_MANIFEST_VERSION, run_id: runId, status: status, started_at: startedAt, finished_at: bkNowIso_(), atomic_snapshot: false, fingerprint_scheme: BK_FP_SCHEME, note: BK_NOTE, failure_code: code, databases: records };
  }
  var issue = '', state = '', completeFile = 'absent';
  var primary = build(wantComplete ? 'complete' : 'incomplete', failCode);
  if (wantComplete && bkManifestProblem_(primary, runId, true)) { issue = 'manifest_verification_failed'; }   /* our own record is inconsistent: never write it as complete */
  else { issue = bkWriteVerify_(runFolder, wantComplete ? 'manifest.json' : 'manifest.INCOMPLETE.json', primary); }

  if (!issue) {
    state = wantComplete ? 'complete' : 'incomplete';
    completeFile = wantComplete ? 'verified' : 'absent';
  } else {
    if (wantComplete) {                                                 /* a complete manifest may exist but is NOT verified */
      var present = bkHasFile_(runFolder, 'manifest.json');
      completeFile = present === true ? 'present_unverified' : present === false ? 'absent' : 'unknown';
      if (issue === 'manifest_file_exists') { completeFile = 'present_unverified'; }
      var fallback = build('incomplete', issue);
      state = bkWriteVerify_(runFolder, 'manifest.INCOMPLETE.json', fallback) === '' ? 'incomplete' : '';
    }
    if (!state) { state = bkHasFile_(runFolder, 'manifest.INCOMPLETE.json') === false && completeFile === 'absent' ? 'not_written' : 'unverified'; }   /* nothing verified: say which */
  }
  var complete = wantComplete && !issue;
  var tabs = 0;
  records.forEach(function (r) { tabs += r.tabs.length; });
  Logger.log('Backup run ' + (complete ? 'complete' : 'INCOMPLETE') + ': ' + verified + ' of ' + BK_DB_NAMES.length + ' copies verified. Manifest ' + state +
    (issue ? ' (' + issue + '); complete manifest file: ' + completeFile : '') + '.');
  return { ok: complete, code: complete ? 'backup_complete' : (failCode || issue || 'backup_incomplete'), run_id: runId, databases: BK_DB_NAMES.length, copies_created: created,
    copies_verified: verified, tabs_verified: tabs, manifest: state, manifest_code: issue, complete_manifest_file: completeFile, atomic_snapshot: false, note: BK_NOTE };
}

/* ---- Read-only verification of an existing run (Task 43) ----
 * admin_verify_private_backup(run_folder_id): manual, owner-only, run from the Apps Script editor. It only READS Drive and Sheets: it creates,
 * copies, edits, renames, trashes, deletes and re-shares nothing, writes no manifest, opens no source database and calls nothing in the
 * private backend. Results carry short codes and counts only (never IDs, links, e-mail addresses or data); logs carry the same.
 *
 * Result: { ok, status, code, copies_checked, copies_verified, tabs_checked }
 *   status 'verified'    ok true,  code 'backup_verified'    complete manifest and all three copies re-checked
 *   status 'incomplete'  ok false, code 'backup_incomplete'  a sound manifest.INCOMPLETE.json: this run is not a usable backup (copies not opened)
 *   status 'legacy'      ok false, code 'backup_integrity_not_recorded'  a sound complete version-1 manifest: names, sizes, headers and sharing were
 *                        re-checked but no content fingerprints exist; copies_verified stays 0 (it counts content-verified copies only)
 *   status 'failed'      ok false, code <reason>             anything else, including every unverifiable or inconsistent run
 * Extra, non-schema tabs are tolerated only when the manifest records them and the copy matches them exactly (the backup tolerates them in a source).
 * Empty tabs (Task 46): a non-schema tab with no content is recorded as last_row 0, last_column 0 together with its fingerprint (name + 0 x 0 size) in a
 * version-2 manifest. Sizes must be non-negative safe integers that are both 0 or both >= 1. Every schema tab must still be non-empty with its exact header. */
var BK_VERIFY_TARGET_PROPERTY = 'BACKUP_VERIFY_RUN_FOLDER_ID';   /* optional Script Property: run-folder ID for an argument-less run */
var BK_RUN_NAME_RE = /^gps-backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-([0-9a-f]{8})$/;
var BK_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
var BK_MANIFEST_KEYS = ['manifest_version', 'run_id', 'status', 'started_at', 'finished_at', 'atomic_snapshot', 'note', 'failure_code', 'databases'];
var BK_RECORD_KEYS = ['type', 'copy_name', 'verification', 'code', 'tabs'];
var BK_TAB_KEYS = ['tab', 'last_row', 'last_column'];
var BK_MANIFEST_KEYS_V2 = BK_MANIFEST_KEYS.concat(['fingerprint_scheme']), BK_TAB_KEYS_V2 = BK_TAB_KEYS.concat(['sha256']);   /* version 2 (Task 45) */
var BK_MAX_MANIFEST_CHARS = 262144, BK_MAX_TABS_PER_DB = 200, BK_MAX_TAB_NAME = 100, BK_MAX_RUN_FILES = 200;

function bkOwnKeys_(o, keys) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) { return false; }
  var a = Object.keys(o).sort(), b = keys.slice().sort();
  if (a.length !== b.length) { return false; }
  for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) { return false; } }
  return true;
}

/* '' when a manifest read from Drive is sound for this run folder and for the file it was found in; else a fixed reason token (no data).
 * Runs the Task 42 check first, unchanged, then adds checks a manifest produced by this project always satisfies. */
function bkHistoricManifestProblem_(m, runName, stamp, fileStatus) {
  var base = bkManifestProblem_(m, runName, false);
  if (base) { return base; }
  if (m.status !== fileStatus) { return 'status_file_mismatch'; }       /* manifest.json must say complete; manifest.INCOMPLETE.json must say incomplete */
  var v2 = m.manifest_version === 2;
  if (!bkOwnKeys_(m, v2 ? BK_MANIFEST_KEYS_V2 : BK_MANIFEST_KEYS)) { return 'keys'; }
  if (m.started_at.replace(/[:.]/g, '-') !== stamp) { return 'run_stamp'; }
  if (m.failure_code !== '' && !BK_CODE_RE.test(m.failure_code)) { return 'failure_code_format'; }
  var nonPassed = false, firstFailed = '';
  for (var i = 0; i < BK_DB_NAMES.length; i++) {
    var d = m.databases[i], v = d.verification;
    if (!bkOwnKeys_(d, BK_RECORD_KEYS)) { return 'record_keys'; }
    if (d.copy_name !== BK_DB_NAMES[i] + '_backup_' + stamp) { return 'copy_name'; }
    if (d.code !== '' && !BK_CODE_RE.test(d.code)) { return 'record_code'; }
    if (d.tabs.length > BK_MAX_TABS_PER_DB) { return 'tab_counts'; }
    for (var t = 0; t < d.tabs.length; t++) {
      if (!bkOwnKeys_(d.tabs[t], v2 ? BK_TAB_KEYS_V2 : BK_TAB_KEYS) || d.tabs[t].tab.length > BK_MAX_TAB_NAME) { return 'tab_counts'; }
    }
    if (v === 'pending') { return 'record_state'; }                      /* never a final state */
    if (v === 'passed') { if (nonPassed || d.code !== '') { return 'record_state'; } }
    else {
      if (d.tabs.length) { return 'record_state'; }
      if (v === 'failed') { if (nonPassed || !d.code) { return 'record_state'; } nonPassed = true; firstFailed = d.code; }
      else if (!nonPassed || d.code !== '') { return 'record_state'; }   /* not_attempted only after a failure */
    }
  }
  if (firstFailed && m.failure_code !== firstFailed) { return 'failure_code'; }
  return '';
}

/* Run folder: reachable, live, named like a run, exactly one parent which is the configured backup folder, owned by the owner, private. Read-only. */
function bkOpenRunFolder_(runFolderId, parentId, ownerEmail) {
  var folder;
  try { folder = DriveApp.getFolderById(runFolderId); } catch (e) { throw bkErr_(bkAuthError_(e) ? 'drive_scope_not_authorized' : 'run_folder_unavailable'); }
  try {
    if (folder.getId() !== runFolderId) { throw bkErr_('run_folder_unavailable'); }
    if (folder.isTrashed()) { throw bkErr_('run_folder_trashed'); }
    var name = String(folder.getName()), nm = BK_RUN_NAME_RE.exec(name);
    if (!nm) { throw bkErr_('run_folder_name_invalid'); }
    var parents = folder.getParents(), first = null, extra = false;
    if (parents.hasNext()) { first = parents.next(); extra = parents.hasNext(); }
    if (!first) { throw bkErr_('run_folder_not_nested'); }
    if (extra) { throw bkErr_('run_folder_multiple_parents'); }
    if (first.getId() !== parentId) { throw bkErr_('run_folder_wrong_parent'); }
    var owner = folder.getOwner();
    if (!owner) { throw bkErr_('run_folder_owner_unavailable'); }
    if (String(owner.getEmail() || '').trim().toLowerCase() !== ownerEmail) { throw bkErr_('run_folder_not_owned'); }
    var problem = bkSharingProblem_(folder, ownerEmail);
    if (problem) { throw bkErr_(problem === 'not_private' ? 'run_folder_not_private' : 'run_folder_shared'); }
    return { folder: folder, name: name, stamp: nm[1] };
  } catch (e2) {
    if (e2 && e2.bkCode) { throw e2; }
    throw bkErr_(bkAuthError_(e2) ? 'drive_scope_not_authorized' : 'run_folder_unverifiable');
  }
}

/* One pass over the run folder's files: manifests and per-database copies, by name. A trashed file with a relevant name is refused. */
function bkListRunFiles_(folder) {
  var out = { complete: [], incomplete: [], copies: {} }, n = 0;
  BK_DB_NAMES.forEach(function (db) { out.copies[db] = []; });
  try {
    var it = folder.getFiles();
    while (it.hasNext()) {
      if (++n > BK_MAX_RUN_FILES) { throw bkErr_('run_folder_too_large'); }
      var f = it.next(), name = String(f.getName()), list = null;
      if (name === 'manifest.json') { list = out.complete; }
      else if (name === 'manifest.INCOMPLETE.json') { list = out.incomplete; }
      else { BK_DB_NAMES.forEach(function (db) { if (name.indexOf(db + '_backup_') === 0) { list = out.copies[db]; } }); }
      if (!list) { continue; }
      if (f.isTrashed()) { throw bkErr_('backup_file_trashed'); }
      list.push({ file: f, name: name });
    }
  } catch (e) {
    if (e && e.bkCode) { throw e; }
    throw bkErr_(bkAuthError_(e) ? 'drive_scope_not_authorized' : 'run_folder_unverifiable');
  }
  return out;
}

/* Exactly one manifest, private, readable, sound. Returns { manifest, status }. */
function bkReadRunManifest_(found, runName, stamp, ownerEmail) {
  var nc = found.complete.length, ni = found.incomplete.length;
  if (nc + ni === 0) { throw bkErr_('manifest_missing'); }
  if (nc > 1 || ni > 1) { throw bkErr_('manifest_duplicate'); }
  if (nc && ni) { throw bkErr_('manifest_conflict'); }
  var file = (nc ? found.complete : found.incomplete)[0].file, fileStatus = nc ? 'complete' : 'incomplete', text, m;
  try {
    if (bkSharingProblem_(file, ownerEmail)) { throw bkErr_('manifest_not_private'); }
    try { text = file.getBlob().getDataAsString(); } catch (eR) { throw bkErr_(bkAuthError_(eR) ? 'drive_scope_not_authorized' : 'manifest_unreadable'); }
    if (typeof text !== 'string' || !text || text.length > BK_MAX_MANIFEST_CHARS) { throw bkErr_('manifest_unreadable'); }
    try { m = JSON.parse(text); } catch (eP) { throw bkErr_('manifest_unreadable'); }
  } catch (e) {
    if (e && e.bkCode) { throw e; }
    throw bkErr_(bkAuthError_(e) ? 'drive_scope_not_authorized' : 'manifest_unreadable');
  }
  var reason = bkHistoricManifestProblem_(m, runName, stamp, fileStatus);
  if (reason) { Logger.log('Backup verification: manifest rejected (' + reason + ').'); throw bkErr_('manifest_invalid'); }
  return { manifest: m, status: fileStatus };
}

/* One database copy against its manifest record. Returns the number of tabs compared. Opens the copy read-only. */
function bkVerifyStoredCopy_(db, rec, candidates, avoidIds, ownerEmail, checkContent) {
  var own = Object.prototype.hasOwnProperty, match = candidates.filter(function (c) { return c.name === rec.copy_name; });
  if (!match.length) { throw bkErr_('copy_missing'); }
  if (candidates.length > 1) { throw bkErr_('copy_duplicate'); }
  var file = match[0].file, id, ss;
  try {
    if (file.getMimeType() !== MimeType.GOOGLE_SHEETS) { throw bkErr_('copy_not_spreadsheet'); }
    id = file.getId();
    if (avoidIds.indexOf(id) >= 0) { throw bkErr_('copy_is_not_a_copy'); }           /* the "copy" is a source database, the public catalogue or a folder */
    if (bkSharingProblem_(file, ownerEmail)) { throw bkErr_('copy_not_private'); }
  } catch (e) {
    if (e && e.bkCode) { throw e; }
    throw bkErr_(bkAuthError_(e) ? 'drive_scope_not_authorized' : 'copy_unverifiable');
  }
  try { ss = SpreadsheetApp.openById(id); } catch (e2) { throw bkErr_(bkAuthError_(e2) ? 'drive_scope_not_authorized' : 'copy_unavailable'); }
  var dims, want = Object.create(null);
  try { dims = bkDims_(ss); } catch (e3) { throw bkErr_('copy_unverifiable'); }
  rec.tabs.forEach(function (x) { want[x.tab] = x; });
  Object.keys(dims).forEach(function (k) { if (!want[k]) { throw bkErr_('copy_tabs_mismatch'); } });                  /* extra tab in the copy */
  rec.tabs.forEach(function (x) { if (!own.call(dims, x.tab)) { throw bkErr_('copy_tabs_mismatch'); } });           /* tab recorded but absent */
  rec.tabs.forEach(function (x) { if (dims[x.tab].last_row !== x.last_row || dims[x.tab].last_column !== x.last_column) { throw bkErr_('copy_dimensions_mismatch'); } });
  var schema = BACKUP_DB_SCHEMAS[db];
  Object.keys(schema).forEach(function (tab) {
    var state;
    try { state = bkTabState_(ss, tab, schema[tab]); } catch (e4) { throw bkErr_('copy_unverifiable'); }
    if (state !== 'ok') { throw bkErr_('copy_schema_mismatch'); }
  });
  if (checkContent) {                                                       /* Task 45: recompute from the copy alone and compare with the manifest */
    var fp = bkFingerprints_(ss, dims);
    rec.tabs.forEach(function (x) { if (fp[x.tab] !== x.sha256) { throw bkErr_('copy_fingerprint_mismatch'); } });
  }
  return rec.tabs.length;
}

function bkVerifyResult_(status, code, ctx) {
  return { ok: status === 'verified', status: status, code: code, copies_checked: ctx.checked, copies_verified: ctx.verified, tabs_checked: ctx.tabs };
}

function bkVerifyRun_(runFolderId, ctx) {
  var props = PropertiesService.getScriptProperties();
  var ownerEmail = bkOwnerConfig_(props);                                   /* 1. who may run this */
  bkRequireOwner_(ownerEmail);
  if (runFolderId === undefined) {                                          /* no argument (editor Run): the property, resolved only now that the owner is proven */
    runFolderId = bkProp_(props, BK_VERIFY_TARGET_PROPERTY);
    if (!runFolderId) { throw bkErr_('verify_target_not_configured'); }
    if (!BK_ID_RE.test(runFolderId)) { throw bkErr_('verify_target_invalid'); }
  } else if (typeof runFolderId !== 'string' || !BK_ID_RE.test(runFolderId)) { throw bkErr_('run_folder_id_invalid'); }   /* explicit input is never replaced by the property */
  var cfg = bkReadConfig_(props), publicId = bkProp_(props, BK_PUBLIC_ID_PROPERTY);   /* 2. configuration (properties only; no source is opened) */
  var avoid = [cfg.folderId, runFolderId];
  BK_DB_NAMES.forEach(function (db) { avoid.push(cfg.ids[db]); });
  if (publicId) { avoid.push(publicId); }
  if (runFolderId === cfg.folderId || avoid.indexOf(runFolderId) !== avoid.lastIndexOf(runFolderId)) { throw bkErr_('run_folder_id_invalid'); }   /* must be a different thing from every configured ID */
  bkVerifyDestination_(cfg.folderId, ownerEmail);                           /* 3. configured parent: owned, private, unshared ancestry */
  var run = bkOpenRunFolder_(runFolderId, cfg.folderId, ownerEmail);        /* 4. the run folder itself and its nesting */
  var found = bkListRunFiles_(run.folder);
  var got = bkReadRunManifest_(found, run.name, run.stamp, ownerEmail);     /* 5. exactly one sound manifest */
  if (got.status === 'incomplete') { return bkVerifyResult_('incomplete', 'backup_incomplete', ctx); }   /* never a success */
  var legacy = got.manifest.manifest_version === 1;                         /* version 1: no fingerprints exist, so content can never be confirmed */
  BK_DB_NAMES.forEach(function (db, i) {                                    /* 6. all three copies must pass; stop at the first failure */
    ctx.checked++;
    ctx.tabs += bkVerifyStoredCopy_(db, got.manifest.databases[i], found.copies[db], avoid, ownerEmail, !legacy);
    if (!legacy) { ctx.verified++; }                                        /* "verified" always means content-verified */
  });
  if (legacy) { return bkVerifyResult_('legacy', 'backup_integrity_not_recorded', ctx); }   /* structure re-checked only; never ok */
  return bkVerifyResult_('verified', 'backup_verified', ctx);
}

function admin_verify_private_backup(run_folder_id) {
  var ctx = { checked: 0, verified: 0, tabs: 0 }, res;
  try {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) { throw bkErr_('busy'); }
    try { res = bkVerifyRun_(run_folder_id, ctx); } finally { lock.releaseLock(); }
  } catch (e) {
    var code = e && e.bkCode ? e.bkCode : 'internal_error';
    if (!(e && e.bkCode)) { Logger.log('Backup verification: unexpected error (' + String(e && e.name ? e.name : 'Error') + ').'); }
    res = bkVerifyResult_('failed', code, ctx);
  }
  Logger.log('Backup verification ' + res.status + ' (' + res.code + '): ' + res.copies_verified + ' of ' + res.copies_checked + ' copies verified, ' + res.tabs_checked + ' tabs checked.');
  return res;
}

/* ---- Content fingerprints (Task 45) ----
 * Per tab: SHA-256 over a canonical, unambiguous encoding of the tab name, its recorded size and every cell in rows 1..last_row, columns
 * 1..last_column. Cells are tagged and length-prefixed: b blank, s<len>:<text> string, n<number>, T/F boolean, d<epoch ms> date,
 * f<len>:<formula> formula. A formula cell is fingerprinted by its formula text only (its computed value is not included, so volatile functions
 * such as NOW() or RAND() cannot make two reads differ). A blank cell and an empty-string cell are the same thing to Apps Script.
 * Rows are read in chunks of at most BK_FP_CHUNK_CELLS cells (a row wider than that is read in column segments of at most that many cells, Task 48,
 * with unchanged digests); each chunk is hashed, then the chunk digests are chained in order:
 *   state0 = H(header) ; state(i+1) = H(state(i) + '\n' + i + '\n' + H(chunk i)) ; the last state is the tab fingerprint.
 * Changing BK_FP_CHUNK_CELLS or the encoding changes every digest, so it requires a new BK_FP_SCHEME and manifest version. Only digests are
 * ever stored or returned; cell contents are held in memory for one chunk at a time and never logged. */
var BK_MANIFEST_VERSION = 2;
var BK_FP_SCHEME = 'gps-tab-sha256-v1';
var BK_FP_CHUNK_CELLS = 5000;
var BK_SHA_RE = /^[0-9a-f]{64}$/;

function bkSha256Hex_(text) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8), h = '';
  for (var i = 0; i < d.length; i++) { var b = d[i] < 0 ? d[i] + 256 : d[i]; h += (b < 16 ? '0' : '') + b.toString(16); }
  return h;
}

function bkCellToken_(v, f) {
  if (typeof f === 'string' && f !== '') { return 'f' + f.length + ':' + f; }
  if (v === '' || v === null || v === undefined) { return 'b'; }
  if (typeof v === 'string') { return 's' + v.length + ':' + v; }
  if (typeof v === 'number') { return 'n' + String(v); }
  if (typeof v === 'boolean') { return v ? 'T' : 'F'; }
  if (Object.prototype.toString.call(v) === '[object Date]') { return 'd' + String(v.getTime()); }
  throw bkErr_('copy_fingerprint_failed');                                  /* an unknown cell type is never guessed at */
}

function bkTabFingerprint_(sh, name, rows, cols) {
  var bad = bkDimPairProblem_(rows, cols, false);                         /* Task 46: never fingerprint an invalid size pair (NaN, negative, fractional, zero/nonzero) */
  if (bad) { throw bkErr_('copy_fingerprint_failed'); }
  var state = bkSha256Hex_('GPSFP1\nchunk:' + BK_FP_CHUNK_CELLS + '\ntab:' + name.length + ':' + name + '\nrows:' + rows + '\ncols:' + cols);
  if (rows === 0) { return state; }                                       /* empty tab: the digest covers its name and 0 x 0 size only; it changes the moment the tab gains content */
  var per = Math.max(1, Math.floor(BK_FP_CHUNK_CELLS / cols)), idx = 0;   /* per = 1 whenever cols > BK_FP_CHUNK_CELLS */
  for (var r = 1; r <= rows; r += per, idx++) {
    var n = Math.min(per, rows - r + 1), text = '';
    /* Task 48: no getRange() ever covers more than BK_FP_CHUNK_CELLS cells. A chunk of whole rows (cols <= BK_FP_CHUNK_CELLS) is one range of n x cols cells.
     * A row wider than that (only ever n = 1) is read in column segments of at most BK_FP_CHUNK_CELLS cells, their tokens joined in column order, so the
     * chunk text, and therefore every digest, is byte-identical to what the unsegmented read produced: no scheme or manifest version change. */
    var segW = Math.min(cols, BK_FP_CHUNK_CELLS), toks = [];
    for (var c = 1; c <= cols; c += segW) {
      var w = Math.min(segW, cols - c + 1), rng = sh.getRange(r, c, n, w), vals = rng.getValues(), fms = rng.getFormulas();
      if (!vals || !fms || vals.length !== n || fms.length !== n) { throw bkErr_('copy_fingerprint_failed'); }
      for (var i = 0; i < n; i++) {
        if (!vals[i] || !fms[i] || vals[i].length !== w || fms[i].length !== w) { throw bkErr_('copy_fingerprint_failed'); }
        if (!toks[i]) { toks[i] = []; }
        for (var j = 0; j < w; j++) { toks[i].push(bkCellToken_(vals[i][j], fms[i][j])); }
      }
    }
    for (var k = 0; k < n; k++) { text += toks[k].join(',') + '\n'; }
    state = bkSha256Hex_(state + '\n' + idx + '\n' + bkSha256Hex_(text));
  }
  return state;
}

/* tab name -> digest for every tab in dims (as read by bkDims_). Read-only. Throws a short code on any failure. */
function bkFingerprints_(ss, dims) {
  var out = Object.create(null);
  try {
    Object.keys(dims).forEach(function (tab) {
      var sh = ss.getSheetByName(tab);
      if (!sh) { throw bkErr_('copy_fingerprint_failed'); }
      out[tab] = bkTabFingerprint_(sh, tab, dims[tab].last_row, dims[tab].last_column);
    });
  } catch (e) { throw bkErr_(e && e.bkCode ? e.bkCode : (bkAuthError_(e) ? 'drive_scope_not_authorized' : 'copy_fingerprint_failed')); }
  return out;
}

function bkSameFps_(a, b) {
  var ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) { return false; }
  return ka.every(function (k) { return typeof b[k] === 'string' && a[k] === b[k]; });
}
