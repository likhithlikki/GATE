/**
 * GATE Prep Studio PRIVATE backend: owner-run database provisioning and header migration.
 *
 * Run MANUALLY from the Apps Script editor by the project owner:
 *   setupPrivateDatabases()           create or initialise AUTH_DB, EXAM_DB and KEYS_DB (safe to repeat)
 *   checkPrivateDatabases()           read-only status report; changes nothing
 *   migratePrivateDatabaseHeaders()   append newly required trailing columns, create missing tabs, write headers
 *                                     for empty tabs, in already-configured spreadsheets
 *
 * There are no HTTP endpoints here (no doGet/doPost, no web app deployment). Do not deploy this project as a web app.
 *
 * Rules shared by every function:
 *  - Spreadsheet IDs live only in Script Properties (AUTH_DB_ID, EXAM_DB_ID, KEYS_DB_ID). Nothing is hardcoded.
 *  - All three databases and every tab header are inspected BEFORE any write. Any incompatibility stops the run with
 *    nothing changed. Nothing is deleted, cleared or overwritten, and a configured spreadsheet that cannot be opened
 *    never gets a replacement.
 *  - Google Sheets has no cross-spreadsheet transaction, so writes are NOT atomic. Each step is idempotent and
 *    re-inspected just before it is applied, so after a failure a rerun is safe; a failure reports which steps
 *    completed and which remain.
 *  - Sharing is never changed. Logs contain resource names, tab names, statuses and safe messages only: no IDs, user
 *    data, keys, OTPs, tokens, passwords or responses.
 *  - No data rows are written.
 */

var SETUP_LOCK_WAIT_MS = 30000;
var DB_NAMES = ['AUTH_DB', 'EXAM_DB', 'KEYS_DB'];

function SetupError_(message) { var e = new Error(message); e.name = 'SetupError'; e.safe = true; return e; }

/* ---------------- Public entry points (owner runs these) ---------------- */
function setupPrivateDatabases() {
  return runLocked_(function () {
    var report = setup_();
    logReport_('Setup finished', report);
    return report;
  });
}

function checkPrivateDatabases() {
  return runLocked_(function () {
    var plan = inspectAll_(false);
    var report = buildReport_(plan);
    logReport_('Status check (no changes made)', report);
    return report;
  });
}

function migratePrivateDatabaseHeaders() {
  return runLocked_(function () {
    var report = migrate_();
    logReport_('Migration finished', report);
    return report;
  });
}

/* ---------------- Locking and error handling ---------------- */
function runLocked_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(SETUP_LOCK_WAIT_MS)) {
    throw SetupError_('Another setup or migration run is in progress. Wait for it to finish and run again.');
  }
  try {
    return fn();
  } catch (err) {
    if (err && err.safe) { Logger.log('STOPPED: ' + err.message); throw err; }
    Logger.log('STOPPED: unexpected error (' + String(err && err.name ? err.name : 'Error') + ').');
    throw SetupError_('The run stopped because of an unexpected error. Nothing was deleted or cleared. Run checkPrivateDatabases() and review the resources, then rerun (steps are safe to repeat).');
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- Inspection (never writes) ---------------- */
function readIds_(props) {
  var ids = {};
  DB_NAMES.forEach(function (db) {
    var v = props.getProperty(PRIVATE_DB_PROPERTY_KEYS[db]);
    ids[db] = v && String(v).trim() ? String(v).trim() : '';
  });
  return ids;
}

/* strict=true: an unreachable configured spreadsheet throws. strict=false (status check): it is recorded and reported. */
function inspectAll_(strict) {
  var props = PropertiesService.getScriptProperties();
  var ids = readIds_(props);
  guardIds_(ids, props);
  var plan = {};
  DB_NAMES.forEach(function (db) {
    var entry = { db: db, ss: null, configured: !!ids[db], unreachable: false, created: false, tabs: {} };
    plan[db] = entry;
    if (ids[db]) {
      try { entry.ss = SpreadsheetApp.openById(ids[db]); }
      catch (e) {
        if (strict) {
          throw SetupError_(db + ': the spreadsheet configured in Script Property ' + PRIVATE_DB_PROPERTY_KEYS[db] +
            ' could not be opened. Check that the ID is correct, the file still exists and the running account has access. ' +
            'No replacement was created and nothing was changed.');
        }
        entry.unreachable = true;
      }
    }
    Object.keys(PRIVATE_DB_SCHEMAS[db]).forEach(function (tab) {
      if (entry.unreachable) { entry.tabs[tab] = { state: 'unreachable' }; return; }
      entry.tabs[tab] = entry.ss ? inspectTab_(entry.ss, tab, PRIVATE_DB_SCHEMAS[db][tab]) : { state: 'missing_spreadsheet' };
    });
  });
  return plan;
}

/* Refuses ID mix-ups: duplicates, or reuse of the public catalogue spreadsheet ID if it was pasted here by mistake. */
function guardIds_(ids, props) {
  var seen = {}, publicId = props.getProperty('PUBLIC_CATALOGUE_SPREADSHEET_ID');
  DB_NAMES.forEach(function (db) {
    if (!ids[db]) { return; }
    if (seen[ids[db]]) { throw SetupError_('Script Properties ' + PRIVATE_DB_PROPERTY_KEYS[seen[ids[db]]] + ' and ' + PRIVATE_DB_PROPERTY_KEYS[db] + ' point to the same spreadsheet. The three databases must be separate. Nothing was changed.'); }
    seen[ids[db]] = db;
    if (publicId && String(publicId).trim() === ids[db]) { throw SetupError_(PRIVATE_DB_PROPERTY_KEYS[db] + ' is the same spreadsheet as the public catalogue. Private databases must never share a file with it. Nothing was changed.'); }
  });
}

/* Looks at one tab without changing it. States:
 *   missing | empty                       -> needs a header (setup or migration)
 *   ok | ok_extended                      -> header equals the schema (extended: extra trailing columns, left alone)
 *   needs_migration {from, add}           -> header is an exact, non-empty prefix of the schema and the columns to be
 *                                            appended are completely empty
 *   incompatible {reason}                 -> anything else; never reconciled */
function inspectTab_(ss, tab, def) {
  var sh = ss.getSheetByName(tab);
  if (!sh) { return { state: 'missing' }; }
  var cols = def && def.columns;
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (!cols) { return { state: 'incompatible', reason: lastRow === 0 ? 'no schema is defined for this tab' : 'the tab has content and no schema is defined for it' }; }
  if (lastRow === 0 && lastCol === 0) { return { state: 'empty' }; }
  var n = cols.length, width = Math.max(lastCol, n);
  var row1 = sh.getRange(1, 1, 1, width).getValues()[0].map(function (v) { return String(v === null || v === undefined ? '' : v).trim(); });
  var k = n;
  for (var i = 0; i < n; i++) {
    if (row1[i] === cols[i]) { continue; }
    if (row1[i] === '') { k = i; break; }
    return { state: 'incompatible', reason: 'header column ' + (i + 1) + ' does not match the expected schema' };
  }
  if (k === 0) { return { state: 'incompatible', reason: 'the first header cell is empty but the tab has content' }; }
  if (k === n) {
    var extra = row1.slice(n).some(function (v) { return v !== ''; });
    return { state: extra ? 'ok_extended' : 'ok' };
  }
  /* Older, shorter header: the cells where the new columns would go must be completely empty (no unknown column). */
  if (lastCol > k) {
    var block = sh.getRange(1, k + 1, Math.max(lastRow, 1), lastCol - k).getValues();
    var occupied = block.some(function (r) { return r.some(function (v) { return v !== '' && v !== null && v !== undefined; }); });
    if (occupied) { return { state: 'incompatible', reason: 'columns after position ' + k + ' already contain data or an unknown header, so new columns cannot be appended safely' }; }
  }
  return { state: 'needs_migration', from: k, add: cols.slice(k) };
}

/* ---------------- Writes (each called only after a successful preflight) ---------------- */
function ensureWidth_(sh, n) {
  var max = sh.getMaxColumns();
  if (max < n) { sh.insertColumnsAfter(max, n - max); }   /* new sheets have 26 columns; some schemas are wider */
}

function applyTextFormat_(sh, def, fromIndex) {
  (def.textColumns || []).forEach(function (name) {   /* plain text so Sheets cannot turn ids, decimals or hashes into numbers or dates */
    var idx = def.columns.indexOf(name);
    if (idx >= fromIndex) { sh.getRange(1, idx + 1, sh.getMaxRows(), 1).setNumberFormat('@'); }
  });
}

function writeHeader_(sh, def) {
  var cols = def.columns;
  ensureWidth_(sh, cols.length);
  sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
  sh.setFrozenRows(1);
  applyTextFormat_(sh, def, 0);
}

function appendColumns_(sh, def, from) {
  var cols = def.columns;
  ensureWidth_(sh, cols.length);
  sh.getRange(1, from + 1, 1, cols.length - from).setValues([cols.slice(from)]).setFontWeight('bold');
  applyTextFormat_(sh, def, from);   /* only the new columns are formatted; existing columns and data are left alone */
}

/* ---------------- setupPrivateDatabases ---------------- */
function setup_() {
  var props = PropertiesService.getScriptProperties();
  var plan = inspectAll_(true);
  var problems = [];
  DB_NAMES.forEach(function (db) {
    Object.keys(plan[db].tabs).forEach(function (tab) {
      var t = plan[db].tabs[tab];
      if (t.state === 'incompatible') { problems.push(db + '.' + tab + ': ' + t.reason); }
    });
  });
  if (problems.length) {
    throw SetupError_('Incompatible existing schema, so nothing was changed. Fix or move these tabs and run again: ' + problems.join(' | '));
  }
  /* Tabs that only need trailing columns are NOT incompatible: setup leaves them and tells the owner to migrate. */

  DB_NAMES.forEach(function (db) {
    var entry = plan[db], createdNow = false;
    if (!entry.ss) {
      entry.ss = SpreadsheetApp.create(PRIVATE_DB_TITLES[db]);   /* private to the owner; sharing is never touched */
      props.setProperty(PRIVATE_DB_PROPERTY_KEYS[db], entry.ss.getId());   /* stored at once so a rerun reuses it */
      entry.created = true; entry.configured = true; createdNow = true;
    }
    var defaultSheet = createdNow ? entry.ss.getSheets()[0] : null;
    Object.keys(PRIVATE_DB_SCHEMAS[db]).forEach(function (tab) {
      var def = PRIVATE_DB_SCHEMAS[db][tab], state = entry.tabs[tab].state;
      if (state === 'missing' || state === 'missing_spreadsheet') {
        var sh = entry.ss.insertSheet(tab);
        writeHeader_(sh, def);
        entry.tabs[tab] = { state: 'created' };
      } else if (state === 'empty') {
        writeHeader_(entry.ss.getSheetByName(tab), def);
        entry.tabs[tab] = { state: 'header_written' };
      }
    });
    /* Remove only the untouched default tab of a spreadsheet created in this run. */
    if (defaultSheet && !PRIVATE_DB_SCHEMAS[db][defaultSheet.getName()] && defaultSheet.getLastRow() === 0 && entry.ss.getSheets().length > 1) {
      entry.ss.deleteSheet(defaultSheet);
    }
  });
  return buildReport_(plan);
}

/* ---------------- migratePrivateDatabaseHeaders ---------------- */
function migrate_() {
  var plan = inspectAll_(true);
  var missingDbs = DB_NAMES.filter(function (db) { return !plan[db].ss; });
  if (missingDbs.length) {
    throw SetupError_('Migration only works on configured spreadsheets. Not configured: ' + missingDbs.join(', ') +
      '. Run setupPrivateDatabases() first. Nothing was changed.');
  }
  /* Preflight: build the full step list for all three databases and refuse everything if anything is incompatible. */
  var steps = [], problems = [];
  DB_NAMES.forEach(function (db) {
    Object.keys(PRIVATE_DB_SCHEMAS[db]).forEach(function (tab) {
      var t = plan[db].tabs[tab];
      if (t.state === 'incompatible') { problems.push(db + '.' + tab + ': ' + t.reason); }
      else if (t.state === 'missing') { steps.push({ db: db, tab: tab, action: 'create_tab', planned: 'missing' }); }
      else if (t.state === 'empty') { steps.push({ db: db, tab: tab, action: 'write_header', planned: 'empty' }); }
      else if (t.state === 'needs_migration') { steps.push({ db: db, tab: tab, action: 'append_columns', planned: 'needs_migration', from: t.from, add: t.add.length }); }
    });
  });
  if (problems.length) {
    throw SetupError_('Migration refused: incompatible schema found, so nothing was changed. Fix or move these tabs and run again: ' + problems.join(' | '));
  }

  var done = [], skipped = [];
  function label(s) { return s.db + '.' + s.tab + ' (' + s.action + (s.action === 'append_columns' ? ': +' + s.add + ' column(s)' : '') + ')'; }
  for (var i = 0; i < steps.length; i++) {
    var s = steps[i], def = PRIVATE_DB_SCHEMAS[s.db][s.tab], ss = plan[s.db].ss;
    try {
      /* Re-inspect right before writing: something may have changed since preflight (or a previous partial run). */
      var now = inspectTab_(ss, s.tab, def);
      if (now.state === 'ok' || now.state === 'ok_extended') { skipped.push(label(s)); continue; }   /* already done */
      if (now.state !== s.planned || (s.action === 'append_columns' && now.from !== s.from)) {
        throw SetupError_('The tab changed after the preflight check.');
      }
      if (s.action === 'create_tab') { writeHeader_(ss.insertSheet(s.tab), def); }
      else if (s.action === 'write_header') { writeHeader_(ss.getSheetByName(s.tab), def); }
      else { appendColumns_(ss.getSheetByName(s.tab), def, s.from); }
      done.push(label(s));
    } catch (err) {
      var remaining = steps.slice(i).map(label);
      throw SetupError_('Migration stopped part-way (writes are not atomic across spreadsheets). Completed: ' +
        (done.length ? done.join('; ') : 'none') + '. Not applied: ' + remaining.join('; ') +
        '. Run checkPrivateDatabases(), then rerun migratePrivateDatabaseHeaders(); finished steps are skipped safely.');
    }
  }
  var report = buildReport_(inspectAll_(true));   /* reflects the real state after the writes */
  report.migration = { completed_steps: done, already_done_steps: skipped };
  return report;
}

/* ---------------- Reporting (names and statuses only) ---------------- */
var STATE_TEXT = {
  ok: 'schema ready (header verified)',
  ok_extended: 'schema ready (header verified; extra trailing columns present and left alone)',
  needs_migration: 'MIGRATION REQUIRED (older header; trailing columns can be appended safely)',
  empty: 'exists but empty (header needed)',
  missing: 'MISSING (tab not found)',
  missing_spreadsheet: 'MISSING (spreadsheet not created yet)',
  incompatible: 'INCOMPATIBLE (will not be changed)',
  unreachable: 'UNREACHABLE (configured spreadsheet could not be opened)',
  created: 'created with header',
  header_written: 'header written to empty tab'
};
var READY_STATES = { ok: true, ok_extended: true, created: true, header_written: true };

function buildReport_(plan) {
  var databases = {}, summary = { schema_ready: [], needs_migration: [], missing: [], incompatible: [], unreachable: [],
                                  safe_migration_possible: false, migration_required: false };
  var pendingMigrationWork = false;
  DB_NAMES.forEach(function (db) {
    var entry = plan[db], tabs = {};
    Object.keys(entry.tabs).forEach(function (tab) {
      var t = entry.tabs[tab], name = db + '.' + tab, text = STATE_TEXT[t.state] || t.state;
      if (t.state === 'incompatible') { text += ': ' + t.reason; }
      if (t.state === 'needs_migration') { text += ': +' + t.add.length + ' column(s)'; }
      tabs[tab] = text;
      if (READY_STATES[t.state]) { summary.schema_ready.push(name); }
      else if (t.state === 'needs_migration') { summary.needs_migration.push(name); pendingMigrationWork = true; }
      else if (t.state === 'missing' || t.state === 'empty' || t.state === 'missing_spreadsheet') { summary.missing.push(name); pendingMigrationWork = true; }
      else if (t.state === 'incompatible') { summary.incompatible.push(name); }
      else if (t.state === 'unreachable') { summary.unreachable.push(name); }
    });
    var access = null;
    try { if (entry.ss) { access = { editors_listed: entry.ss.getEditors().length, viewers_listed: entry.ss.getViewers().length }; } } catch (e) { access = null; }
    databases[db] = { spreadsheet: entry.unreachable ? 'configured but UNREACHABLE' : !entry.ss ? 'not created yet' : entry.created ? 'created in this run' : 'reused (configured)', tabs: tabs, access: access };
  });
  var allConfigured = DB_NAMES.every(function (db) { return plan[db].ss; });
  summary.migration_required = summary.needs_migration.length > 0;
  summary.safe_migration_possible = allConfigured && pendingMigrationWork && !summary.incompatible.length && !summary.unreachable.length;
  return { databases: databases, summary: summary };
}

function logReport_(title, report) {
  Logger.log(title + '.');
  DB_NAMES.forEach(function (db) {
    var r = report.databases[db];
    Logger.log(db + ': spreadsheet ' + r.spreadsheet);
    Object.keys(r.tabs).forEach(function (t) { Logger.log('  ' + t + ': ' + r.tabs[t]); });
    if (r.access) {
      Logger.log('  sharing: Google lists ' + r.access.editors_listed + ' editor(s) and ' + r.access.viewers_listed +
        ' viewer(s). Confirm in the Sheets sharing dialog that only intended owners have access and that no link sharing is on. This script never changes sharing.');
    }
  });
  var s = report.summary;
  Logger.log('Summary: ' + s.schema_ready.length + ' tab(s) schema-ready; ' + s.needs_migration.length + ' need migration; ' +
    s.missing.length + ' missing or empty; ' + s.incompatible.length + ' incompatible; ' + s.unreachable.length + ' unreachable.');
  if (s.migration_required) { Logger.log('ACTION: run migratePrivateDatabaseHeaders() to append the new trailing columns (setupPrivateDatabases() does not append columns).'); }
  if (s.incompatible.length) { Logger.log('ACTION: incompatible tabs must be fixed by the owner; they will not be changed and block migration.'); }
  if (report.migration) {
    Logger.log('Migration completed ' + report.migration.completed_steps.length + ' step(s); ' + report.migration.already_done_steps.length + ' already done.');
  }
  Logger.log('Safe migration possible now: ' + (s.safe_migration_possible ? 'yes' : 'no') + '.');
}
