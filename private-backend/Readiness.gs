/**
 * GATE Prep Studio PRIVATE backend: Readiness (Task 35). Owner-run, read-only platform readiness report.
 *
 *   admin_get_platform_readiness()   run from the Apps Script editor by the project owner; returns (and logs) the report.
 *
 * Not an HTTP operation: it is not in AuthRouter.gs, there is no doGet/doPost here, and nothing here is reachable from a browser.
 * It only READS. It enables no gate, writes no row, creates no record, approves no decision and changes no sharing. It reuses
 * checkPrivateDatabases() (Setup.gs), the schema definitions, opAuthStatus_ and the auth configuration checks, the registry and repository readers
 * (ExamCatalogue.gs), ksLoadApprovedKeySet_ (KeyStore.gs), SC_PROFILES / scPolicyFromProperties_ (Scoring.gs) and the exam policy gates.
 *
 * STATUS per component (worst check wins; order of severity from worst to best):
 *   unavailable         something is configured but cannot be opened, or stored data fails an integrity/schema check
 *   needs_migration     an existing tab has an older header that migratePrivateDatabaseHeaders() can extend
 *   needs_configuration a Script Property, database, tab, import, paper or key set the owner has not provided yet
 *                       (setupPrivateDatabases() creates spreadsheets, tabs and headers; the owner never makes them by hand)
 *   blocked_policy      configured, but an owner decision/policy gate is off or unresolved (the checker never turns one on)
 *   unverified          cannot be established from inside the script (for example that a web app is deployed, current and reachable)
 *   ready               every check this script CAN make passed. It never means "live": see the `layers` note in the report.
 *
 * Source code present, configuration present, data available and deployed are four different things. Each component reports `source`
 * (the function exists in this project) separately from its configuration and data checks, and `deployment` is always reported as
 * unverified or needs_configuration: the script cannot prove that a deployment exists, runs this code version or accepts browser requests.
 *
 * The report contains statuses, counts, booleans, short codes, Script Property NAMES, gate names and paper identifiers chosen by the owner.
 * It never contains spreadsheet IDs, secrets, the endpoint URL, answer keys, NAT bounds, explanations, OTPs, session tokens, user data or responses.
 */

var RD_SEVERITY = ['unavailable', 'needs_migration', 'needs_configuration', 'blocked_policy', 'unverified', 'ready'];
var RD_UNRESOLVED_DECISIONS = [
  { id: 'D-11', what: 'duration for a selection totalling exactly 100 marks', always_blocked_in_code: true },
  { id: 'D-12', what: 'full-length mock composition', always_blocked_in_code: true },
  { id: 'D-12', what: 'subsets smaller than all matching questions', always_blocked_in_code: true },
  { id: 'D-14', what: 'Google sign-in token verification (no code path exists)', always_blocked_in_code: true }
];

function rdWorst_(statuses) {
  var worst = 'ready';
  statuses.forEach(function (s) { if (RD_SEVERITY.indexOf(s) < RD_SEVERITY.indexOf(worst)) { worst = s; } });
  return worst;
}
function rdCheck_(name, status, code, extra) {
  var c = { name: name, status: status };
  if (code) { c.code = code; }
  if (extra) { Object.keys(extra).forEach(function (k) { c[k] = extra[k]; }); }
  return c;
}
function rdComponent_(checks, extra) {
  var out = { status: rdWorst_(checks.map(function (c) { return c.status; })), checks: checks };
  if (extra) { Object.keys(extra).forEach(function (k) { out[k] = extra[k]; }); }
  return out;
}
/* Runs fn; returns {ok:true, value} or {ok:false, code} with a short code only (never a message that could hold a value). */
function rdTry_(fn) {
  try { return { ok: true, value: fn() }; }
  catch (e) { return { ok: false, code: e && e.acCode ? e.acCode + (e.acDetail ? ':' + e.acDetail : '') : e && e.ksCode ? e.ksCode : e && e.ssCode ? e.ssCode : String(e && e.name ? e.name : 'Error') }; }
}
function rdHas_(props, name) { return !!ksProp_(props, name); }
function rdSource_(names) { var missing = names.filter(function (n) { return typeof globalThis[n] !== 'function'; }); return { present: missing.length === 0, missing: missing }; }

/* ---------------------------------------------------------------------------------------------------
 * 1. Databases (reuses checkPrivateDatabases(); read-only)
 * ------------------------------------------------------------------------------------------------- */
function rdDatabases_() {
  var r = rdTry_(function () { return checkPrivateDatabases(); }), out = {}, byDb = {};
  if (!r.ok) {
    DB_NAMES.forEach(function (db) { out[db] = rdComponent_([rdCheck_('database_check', 'unavailable', 'check_failed')]); });
    return { components: out, ok: false };
  }
  var rep = r.value;
  DB_NAMES.forEach(function (db) {
    var d = rep.databases[db], checks = [], tabs = Object.keys(d.tabs), counts = { ready: 0, migration: 0, missing: 0, incompatible: 0, unreachable: 0 };
    tabs.forEach(function (t) {
      var txt = d.tabs[t];
      if (/^schema ready/.test(txt)) { counts.ready++; } else if (/^MIGRATION/.test(txt)) { counts.migration++; } else if (/^INCOMPATIBLE/.test(txt)) { counts.incompatible++; }
      else if (/^UNREACHABLE/.test(txt)) { counts.unreachable++; } else { counts.missing++; }
    });
    if (/not created yet/.test(d.spreadsheet)) { checks.push(rdCheck_('spreadsheet', 'needs_configuration', 'not_created', { action: 'run setupPrivateDatabases()' })); }
    else if (/UNREACHABLE/.test(d.spreadsheet)) { checks.push(rdCheck_('spreadsheet', 'unavailable', 'configured_but_unreachable')); }
    else { checks.push(rdCheck_('spreadsheet', 'ready')); }
    checks.push(rdCheck_('tab_schemas', counts.incompatible ? 'unavailable' : counts.unreachable ? 'unavailable' : counts.migration ? 'needs_migration' : counts.missing ? 'needs_configuration' : 'ready',
      counts.incompatible ? 'incompatible_tabs' : counts.migration ? 'older_headers' : counts.missing ? 'missing_or_empty_tabs' : '',
      { tabs_total: tabs.length, tabs_ready: counts.ready, tabs_needing_migration: counts.migration, tabs_missing_or_empty: counts.missing, tabs_incompatible: counts.incompatible,
        action: counts.migration ? 'run migratePrivateDatabaseHeaders()' : counts.missing ? 'run setupPrivateDatabases()' : '' }));
    out[db] = rdComponent_(checks);
    byDb[db] = out[db].status;
  });
  return { components: out, ok: true, summary: rep.summary };
}

/* ---------------------------------------------------------------------------------------------------
 * 2. Authentication policy and configuration (reuses opAuthStatus_ and the ac* configuration readers)
 * ------------------------------------------------------------------------------------------------- */
function rdAuth_(dbStatus) {
  var props = PropertiesService.getScriptProperties(), checks = [], gates = {};
  var src = rdSource_(['opAuthStatus_', 'opLoginPassword_', 'asRequireSession_', 'opRegisterComplete_', 'acGate_']);
  checks.push(rdCheck_('source_present', src.present ? 'ready' : 'unavailable', src.present ? '' : 'missing_functions'));
  AUTH_GATE_NAMES.forEach(function (g) { gates[g] = acGate_(g); });
  var cfg = {
    pepper_version: rdTry_(acPepperVersion_).ok, pepper_secret: rdTry_(function () { return acPepper_(acPepperVersion_()); }).ok, kdf_iterations: rdTry_(acKdfIterations_).ok,
    kdf_salt_secret: rdTry_(acKdfSaltSecret_).ok, consent_version: rdTry_(acConsentVersion_).ok
  };
  var cfgMissing = Object.keys(cfg).filter(function (k) { return !cfg[k]; });
  checks.push(rdCheck_('auth_configuration', cfgMissing.length ? 'needs_configuration' : 'ready', cfgMissing.length ? 'missing_properties' : '', { present: cfg, note: 'consent_version is only needed for registration' }));
  var status = rdTry_(function () { return opAuthStatus_().data; }), feat = status.ok ? status.value : null;
  if (dbStatus === 'unavailable' || dbStatus === 'needs_configuration' || dbStatus === 'needs_migration' || !feat || feat.initialized !== true) {
    checks.push(rdCheck_('auth_database_ready', dbStatus === 'ready' ? 'unavailable' : (dbStatus === 'needs_migration' ? 'needs_migration' : dbStatus === 'unavailable' ? 'unavailable' : 'needs_configuration'), 'auth_db_not_initialised'));
  } else { checks.push(rdCheck_('auth_database_ready', 'ready')); }
  var disabled = [];
  if (feat) { ['login', 'remember', 'register', 'reset'].forEach(function (k) { if (feat[k] !== true) { disabled.push(k); } }); }
  disabled.push('google_sign_in');   /* always: D-14 has no verifier */
  var gatesOff = AUTH_GATE_NAMES.filter(function (g) { return !gates[g]; });
  checks.push(rdCheck_('policy_gates', gatesOff.length ? 'blocked_policy' : 'ready', gatesOff.length ? 'gates_off' : '', { gates_on: AUTH_GATE_NAMES.filter(function (g) { return gates[g]; }), gates_off: gatesOff }));
  var sessionOn = gates.session_standard === true;
  checks.push(rdCheck_('sessions_for_exam_operations', sessionOn ? 'ready' : 'blocked_policy', sessionOn ? '' : 'session_standard_off', { note: 'every exam operation needs a valid session' }));
  var mail = rdTry_(function () { return MailApp.getRemainingDailyQuota(); });
  checks.push(rdCheck_('mail_quota_for_otp', !mail.ok ? 'unverified' : mail.value >= 1 ? 'ready' : 'unavailable', !mail.ok ? 'quota_unreadable' : mail.value >= 1 ? '' : 'quota_exhausted', { remaining: mail.ok ? mail.value : null }));
  return rdComponent_(checks, { features_enabled: feat ? { login: feat.login === true, remember: feat.remember === true, register: feat.register === true, reset: feat.reset === true, google: false } : null, features_disabled: disabled });
}

/* ---------------------------------------------------------------------------------------------------
 * 3. Public catalogue source and private repository / papers
 * ------------------------------------------------------------------------------------------------- */
function rdCatalogue_(examStatus) {
  var props = PropertiesService.getScriptProperties(), checks = [];
  var src = rdSource_(['admin_import_public_catalogue', 'admin_register_paper', 'qiBuildCatalogue_', 'exLoadPaper_']);
  checks.push(rdCheck_('source_present', src.present ? 'ready' : 'unavailable', src.present ? '' : 'missing_functions'));
  checks.push(rdCheck_('license_reference', rdHas_(props, QI_LICENSE_PROPERTY) ? 'ready' : 'needs_configuration', rdHas_(props, QI_LICENSE_PROPERTY) ? '' : QI_LICENSE_PROPERTY + '_unset'));
  var details = { source_records: null, served_questions: null, registered_papers: null, usable_papers: null, papers: [] };

  if (!rdHas_(props, KEYSTORE_PUBLIC_ID_PROPERTY)) { checks.push(rdCheck_('public_catalogue_source', 'needs_configuration', KEYSTORE_PUBLIC_ID_PROPERTY + '_unset')); }
  else {
    var b = rdTry_(function () { return qiBuildCatalogue_(qiOpenPublicSheet_(props)); });
    checks.push(b.ok ? rdCheck_('public_catalogue_source', 'ready', '', { valid_records: b.value.questions.length }) : rdCheck_('public_catalogue_source', 'unavailable', b.code));
    if (b.ok) { details.source_records = b.value.questions.length; }
  }
  if (examStatus !== 'ready') {
    checks.push(rdCheck_('private_repository', examStatus === 'needs_migration' ? 'needs_migration' : examStatus === 'unavailable' ? 'unavailable' : 'needs_configuration', 'exam_db_not_ready'));
    return rdComponent_(checks, details);
  }
  var repo = rdTry_(function () { var ss = atOpenExam_(); return { ss: ss, repo: qiReadRepo_(ss) }; });
  if (!repo.ok) { checks.push(rdCheck_('private_repository', 'unavailable', repo.code)); return rdComponent_(checks, details); }
  var ss = repo.value.ss, R = repo.value.repo, served = 0;
  Object.keys(R.byId).forEach(function (id) { if (qiActiveRow_(R.byId[id])) { served++; } });
  details.served_questions = served;
  checks.push(rdCheck_('private_repository', served ? 'ready' : 'needs_configuration', served ? '' : 'no_questions_imported', { served_questions: served, action: served ? '' : 'run admin_import_public_catalogue()' }));
  if (details.source_records !== null && served) {
    checks.push(rdCheck_('repository_matches_source_count', served === details.source_records ? 'ready' : 'unverified', served === details.source_records ? '' : 'counts_differ_import_may_be_needed'));
  }
  var ids = rdTry_(function () { return exAllPaperIds_(ss); });
  if (!ids.ok) { checks.push(rdCheck_('paper_registry', 'unavailable', ids.code)); return rdComponent_(checks, details); }
  details.registered_papers = ids.value.length; var usable = 0;
  ids.value.forEach(function (pid) {
    var p = rdTry_(function () { return exLoadPaper_(ss, pid); }), entry = { paper_id: pid, status: 'unavailable', code: '' };
    if (!p.ok || !p.value) { entry.code = p.ok ? 'not_active' : p.code; details.papers.push(entry); return; }
    var missing = 0, wrongYear = 0;
    p.value.members.forEach(function (qid) { var a = qiActiveRow_(R.byId[qid]); if (!a) { missing++; } else if (parseInt(a.o.year, 10) !== p.value.paper.year) { wrongYear++; } });
    var prof = rdTry_(function () { return exProfileFor_(p.value.paper.year); });
    entry.year = p.value.paper.year; entry.questions = p.value.members.length;
    if (missing || wrongYear) { entry.status = 'needs_configuration'; entry.code = 'member_questions_not_served'; }
    else if (!prof.ok || !prof.value) { entry.status = 'blocked_policy'; entry.code = 'profile_unverified'; }
    else { entry.status = 'ready'; usable++; }
    details.papers.push(entry);
  });
  details.usable_papers = usable;
  checks.push(rdCheck_('paper_registry', ids.value.length ? (usable ? 'ready' : 'needs_configuration') : 'needs_configuration', ids.value.length ? (usable ? '' : 'no_usable_paper') : 'no_paper_registered',
    { registered: ids.value.length, usable: usable, action: ids.value.length ? '' : 'run admin_register_paper({...})' }));
  var pub = exGate_('question_publication');
  checks.push(rdCheck_('question_publication_gate_d07', pub ? 'ready' : 'blocked_policy', pub ? '' : 'EXAM_POLICY_QUESTION_PUBLICATION_off'));
  return rdComponent_(checks, details);
}

/* ---------------------------------------------------------------------------------------------------
 * 4. Answer-key integrity configuration and verified-key availability (reuses ksLoadApprovedKeySet_; key values never leave this function)
 * ------------------------------------------------------------------------------------------------- */
function rdKeys_(keysStatus, examStatus, papers) {
  var props = PropertiesService.getScriptProperties(), checks = [];
  var src = rdSource_(['ksLoadApprovedKeySet_', 'admin_stage_keys', 'admin_validate_batch', 'admin_approve_batch', 'ssScoreAndCommitAttempt_']);
  checks.push(rdCheck_('source_present', src.present ? 'ready' : 'unavailable', src.present ? '' : 'missing_functions'));
  var secret = ksProp_(props, KEYSTORE_MAC_SECRET_PROPERTY), sec = !secret ? 'missing' : secret.length < KEYSTORE_MIN_SECRET_LENGTH ? 'too_short' : 'present';
  checks.push(rdCheck_('row_mac_secret', sec === 'present' ? 'ready' : 'needs_configuration', sec === 'present' ? '' : 'mac_secret_' + sec));
  var hosts = rdHas_(props, KEYSTORE_HOSTS_PROPERTY);
  checks.push(rdCheck_('approved_source_hosts', hosts ? 'ready' : 'needs_configuration', hosts ? '' : KEYSTORE_HOSTS_PROPERTY + '_unset', { note: 'needed to stage and approve keys' }));
  var details = { key_sets_total: null, papers: [] };
  if (keysStatus !== 'ready') { checks.push(rdCheck_('keys_database', keysStatus === 'needs_migration' ? 'needs_migration' : keysStatus === 'unavailable' ? 'unavailable' : 'needs_configuration', 'keys_db_not_ready')); return rdComponent_(checks, details); }
  var n = rdTry_(function () { var sh = ksSheet_(ksOpen_().keys, 'key_sets', PRIVATE_DB_SCHEMAS.KEYS_DB.key_sets.columns); return Math.max(0, sh.getLastRow() - 1); });
  if (!n.ok) { checks.push(rdCheck_('key_sets_tab', 'unavailable', n.code)); return rdComponent_(checks, details); }
  details.key_sets_total = n.value;
  checks.push(rdCheck_('approved_key_sets', n.value ? 'ready' : 'needs_configuration', n.value ? '' : 'no_key_set_approved'));
  if (sec !== 'present' || examStatus !== 'ready' || !papers || !papers.length) { return rdComponent_(checks, details); }
  var verified = 0, R = rdTry_(function () { return qiReadRepo_(atOpenExam_()); });
  papers.forEach(function (p) {
    if (!p.questions) { return; }
    var entry = { paper_id: p.paper_id, status: 'needs_configuration', code: '' };
    var k = ksLoadApprovedKeySet_(p.paper_id);
    if (!k || k.ok !== true) {
      var code = String(k && k.code || 'keys_unavailable'), disputed = !!(k && Array.isArray(k.errors) && k.errors.some(function (x) { return x && x.code === 'key_not_current'; }));
      entry.code = disputed ? 'key_set_disputed_or_not_current' : code;
      entry.status = disputed ? 'blocked_policy' : /^(key_integrity_failed|key_set_duplicate|key_set_malformed|key_row_not_text|foreign_key_rows_for_paper|item_count_mismatch|key_rows_invalid|mac_secret_.*)$/.test(code) ? 'unavailable' : code === 'profile_unverified' ? 'blocked_policy' : 'needs_configuration';
    } else {
      entry.status = 'ready'; entry.key_count = k.keys.length;
      var loaded = rdTry_(function () { return exLoadPaper_(atOpenExam_(), p.paper_id); });
      if (loaded.ok && loaded.value && R.ok) {   /* do the approved keys cover the question versions the exam would pin? ids/versions/hashes only */
        var have = {}; k.keys.forEach(function (row) { have[row.question_id + '|' + row.question_version + '|' + row.content_hash] = true; });
        var uncovered = 0;
        loaded.value.members.forEach(function (qid) { var a = qiActiveRow_(R.value.byId[qid]); if (!a || !have[qid + '|' + a.version + '|' + a.o.content_hash]) { uncovered++; } });
        entry.questions_without_matching_key = uncovered;
        if (uncovered) { entry.status = 'needs_configuration'; entry.code = 'keys_do_not_cover_served_versions'; }
      }
    }
    if (entry.status === 'ready') { verified++; }
    details.papers.push(entry);
  });
  details.papers_with_verified_keys = verified;
  checks.push(rdCheck_('verified_keys_per_paper', details.papers.length && verified === details.papers.length ? 'ready' : details.papers.some(function (e) { return e.status === 'unavailable'; }) ? 'unavailable' : 'needs_configuration',
    verified ? '' : 'no_paper_has_verified_keys', { papers_checked: details.papers.length, papers_verified: verified }));
  return rdComponent_(checks, details);
}

/* ---------------------------------------------------------------------------------------------------
 * 5. Marking profiles and scoring/exam policy gates (reads gates; never changes one)
 * ------------------------------------------------------------------------------------------------- */
function rdPolicy_() {
  var checks = [], profiles = [];
  Object.keys(SC_PROFILES).forEach(function (ref) {
    var p = SC_PROFILES[ref], ok = !!scProfileFor_(p.profile_id, p.profile_version, p.year);
    profiles.push({ profile: ref, year: p.year, verified: ok });
  });
  var anyVerified = profiles.some(function (p) { return p.verified; });
  checks.push(rdCheck_('verified_marking_profiles', anyVerified ? 'ready' : 'blocked_policy', anyVerified ? '' : 'no_verified_profile', { profiles: profiles, note: 'years without a profile stay blocked' }));
  var operational = ssOperationalGateStatus_(), operationalOff = operational.missing.map(function (g) { return g.reason; });
  checks.push(rdCheck_('global_operational_scoring_gates', operational.ok ? 'ready' : 'blocked_policy', operational.ok ? '' : 'owner_gates_off', {
    gates_off: operationalOff, properties: operational.missing.map(function (g) { return g.property; }),
    note: 'explicit private Script Properties are required in addition to the six per-rule gates; absent values are OFF and no gate is changed here' }));
  var pol = scPolicyFromProperties_(), off = SC_GATE_NAMES.filter(function (g) { return !pol[g]; });
  checks.push(rdCheck_('scoring_policy_gates', off.length ? 'blocked_policy' : 'ready', off.length ? 'gates_off' : '', { gates_on: SC_GATE_NAMES.filter(function (g) { return pol[g]; }), gates_off: off,
    note: 'a gate that is off blocks scoring of attempts that need it; the checker never turns one on' }));
  checks.push(rdCheck_('answer_review_gate_d18', exGate_('answer_review') ? 'ready' : 'blocked_policy', exGate_('answer_review') ? '' : 'EXAM_POLICY_ANSWER_REVIEW_off', { note: 'keys and explanations are never released by any gate (AK-08)' }));
  checks.push(rdCheck_('permanent_blocks_in_code', 'blocked_policy', 'unresolved_decisions', { decisions: RD_UNRESOLVED_DECISIONS }));
  return rdComponent_(checks, { profiles: profiles, scoring_gates_off: off });
}

/* ---------------------------------------------------------------------------------------------------
 * 6. Services: source present vs prerequisites met. `deployed` is never asserted here.
 * ------------------------------------------------------------------------------------------------- */
function rdServices_(C) {
  function routed(op) { return typeof AR_OPS !== 'undefined' && Object.prototype.hasOwnProperty.call(AR_OPS, op); }
  function svc(label, fns, ops, prereqs) {
    var s = rdSource_(fns), missingOps = ops.filter(function (o) { return !routed(o); });
    var checks = [rdCheck_('source_present', s.present ? 'ready' : 'unavailable', s.present ? '' : 'missing_functions'), rdCheck_('router_registration', missingOps.length ? 'unavailable' : 'ready', missingOps.length ? 'operations_not_registered' : '', { operations: ops })];
    prereqs.forEach(function (p) { checks.push(rdCheck_('prerequisite:' + p.name, p.status, p.status === 'ready' ? '' : 'depends_on_component')); });
    return rdComponent_(checks, { deployed: 'unverified' });
  }
  return {
    attempt_service: svc('attempt', ['opStartAttempt_', 'opGetAttempt_', 'opSaveAnswers_', 'opSubmitAttempt_', 'opListPapers_', 'exCloseLocked_'],
      ['start_attempt', 'get_attempt', 'save_answers', 'submit_attempt', 'list_papers'],
      [{ name: 'AUTH_DB', status: C.AUTH_DB.status }, { name: 'EXAM_DB', status: C.EXAM_DB.status }, { name: 'authentication', status: C.authentication.status }, { name: 'question_catalogue', status: C.question_catalogue.status }]),
    scoring_service: svc('scoring', ['ssScoreAndCommitAttempt_', 'scScoreAttempt_', 'atLoadAttemptForScoring_', 'opScoreAttempt_'], ['score_attempt'],
      [{ name: 'EXAM_DB', status: C.EXAM_DB.status }, { name: 'KEYS_DB', status: C.KEYS_DB.status }, { name: 'answer_keys', status: C.answer_keys.status }, { name: 'marking_and_scoring_policy', status: C.policy.status }]),
    result_service: svc('result', ['ssGetCommittedResult_', 'opGetResult_', 'opGetResultReview_'], ['get_result', 'get_result_review'],
      [{ name: 'EXAM_DB', status: C.EXAM_DB.status }, { name: 'authentication', status: C.authentication.status }]),
    student_pages_service: svc('student', ['opListAttempts_', 'opListBookmarks_', 'opAddBookmark_', 'opRemoveBookmark_', 'opProfileGet_'], ['list_attempts', 'list_bookmarks', 'add_bookmark', 'remove_bookmark', 'profile_get'],
      [{ name: 'AUTH_DB', status: C.AUTH_DB.status }, { name: 'EXAM_DB', status: C.EXAM_DB.status }])
  };
}

/* ---------------------------------------------------------------------------------------------------
 * 7. Endpoint and deployment configuration
 * ------------------------------------------------------------------------------------------------- */
function rdDeployment_() {
  var props = PropertiesService.getScriptProperties(), checks = [];
  var entry = rdSource_(['doPost', 'doGet']);
  checks.push(rdCheck_('web_entry_source_present', entry.present ? 'ready' : 'unavailable', entry.present ? '' : 'missing_functions', { note: 'AuthRouter.gs is the only entry; doGet refuses everything' }));
  var req = ['AUTH_DB_ID', 'EXAM_DB_ID', 'KEYS_DB_ID', 'AUTH_PEPPER_CURRENT_VERSION', 'AUTH_KDF_SALT_SECRET', 'AUTH_KDF_ITERATIONS', 'AUTH_CONSENT_VERSION', KEYSTORE_MAC_SECRET_PROPERTY, KEYSTORE_PUBLIC_ID_PROPERTY, QI_LICENSE_PROPERTY];
  var present = {}, missing = [];
  req.forEach(function (n) { present[n] = rdHas_(props, n); if (!present[n]) { missing.push(n); } });
  checks.push(rdCheck_('script_properties_present', missing.length ? 'needs_configuration' : 'ready', missing.length ? 'properties_missing' : '', { properties: present, note: 'names and presence only; values are never read out. Presence is not correctness.' }));
  var url = rdTry_(function () { var s = ScriptApp.getService(); return s.isEnabled() ? (s.getUrl() ? 'detected' : 'none') : 'not_enabled'; });
  var state = url.ok ? url.value : 'unknown';
  checks.push(rdCheck_('web_app_deployment', state === 'detected' ? 'unverified' : state === 'unknown' ? 'unverified' : 'needs_configuration',
    state === 'detected' ? 'deployment_detected_not_verified' : state === 'unknown' ? 'detection_unavailable' : 'no_web_app_deployment',
    { detected: state, note: 'the script cannot confirm the deployment runs this code version, uses Execute as: Me / Access: Anyone, or is reachable from a browser; the URL is never returned' }));
  checks.push(rdCheck_('browser_endpoint_configuration', 'unverified', 'frontend_setting_not_visible_to_backend', { owner_must_verify: ['AUTH_ENDPOINT_URL in auth.js is the deployed /exec URL of THIS private project', 'the public catalogue ENDPOINT_URL in api.js is a different deployment', 'a test login and one start/save/submit round trip work from the real site'] }));
  return rdComponent_(checks);
}

/* ---------------------------------------------------------------------------------------------------
 * admin_get_platform_readiness()
 * ------------------------------------------------------------------------------------------------- */
function admin_get_platform_readiness() {
  var dbs = rdDatabases_(), c = {};
  var D = dbs.components;
  c.AUTH_DB = D.AUTH_DB; c.EXAM_DB = D.EXAM_DB; c.KEYS_DB = D.KEYS_DB;
  c.authentication = rdTry_(function () { return rdAuth_(c.AUTH_DB.status); }).value || rdComponent_([rdCheck_('authentication_check', 'unavailable', 'check_failed')]);
  var cat = rdTry_(function () { return rdCatalogue_(c.EXAM_DB.status); });
  c.question_catalogue = cat.ok ? cat.value : rdComponent_([rdCheck_('catalogue_check', 'unavailable', cat.code)]);
  var keys = rdTry_(function () { return rdKeys_(c.KEYS_DB.status, c.EXAM_DB.status, c.question_catalogue.papers); });
  c.answer_keys = keys.ok ? keys.value : rdComponent_([rdCheck_('key_check', 'unavailable', keys.code)]);
  c.policy = rdTry_(rdPolicy_).value || rdComponent_([rdCheck_('policy_check', 'unavailable', 'check_failed')]);
  var svc = rdServices_(c);
  Object.keys(svc).forEach(function (k) { c[k] = svc[k]; });
  var dep = rdTry_(rdDeployment_);
  c.deployment = dep.ok ? dep.value : rdComponent_([rdCheck_('deployment_check', 'unverified', dep.code)]);

  var counts = {};
  RD_SEVERITY.forEach(function (s) { counts[s] = 0; });
  Object.keys(c).forEach(function (k) { counts[c[k].status]++; });
  var report = {
    ok: true, generated_at: new Date().toISOString(), overall: rdWorst_(Object.keys(c).map(function (k) { return c[k].status; })), counts: counts, components: c,
    layers: 'Each component separates source present, configuration present, data available and deployed. ready means every check the script can make passed; it never means the service is live. Deployment and the browser endpoint can only be verified by the owner with a real round trip.',
    read_only: true
  };
  Logger.log('Readiness: overall ' + report.overall + '.');
  Object.keys(c).forEach(function (k) {
    var bad = c[k].checks.filter(function (x) { return x.status !== 'ready'; }).map(function (x) { return x.name + '=' + x.status + (x.code ? '(' + x.code + ')' : ''); });
    Logger.log(k + ': ' + c[k].status + (bad.length ? ' [' + bad.join('; ') + ']' : ''));
  });
  return report;
}
