/* GATE Prep Studio: System status page (status.js)
 *
 * Runs READ-ONLY health checks against every backend the site depends on and shows a green / amber / red indicator for each one,
 * with the exact thing to fix when something is wrong.
 *
 * It reuses the existing adapters and adds no new endpoint, no new server operation and no new transport:
 *   - public catalogue  -> GatePublicApi.loadCatalogueMetadata()  (api.js, JSONP "metadata" op: no question content)
 *   - private auth/exam -> GateAuth.call('auth_status')           (auth.js, HTTPS POST, no session needed, reveals no account data)
 *   - exam operations   -> GateAuth.call('list_papers')           (only when the visitor is already logged in; the token never leaves auth.js)
 *   - website data      -> fetch('data/manifest.json')            (same-origin static file)
 * The private backup project has no web app by design, so a browser cannot test it; it is shown as "not checked".
 *
 * States:  ok = working (green) | warn = reachable but something is switched off or incomplete (amber)
 *          fail = broken or unreachable (red) | skip = cannot be checked from a browser (grey)
 * Every state is also written as text and a symbol, so the page never relies on colour alone.
 * Nothing here logs, stores or displays a password, token, id or response body. Text is inserted with textContent only.
 */
(function (root) {
  'use strict';

  var doc = root.document;
  var SYMBOL = { ok: '\u2713', warn: '!', fail: '\u2715', skip: '\u2013', run: '\u2026' };
  var LABEL = { ok: 'Working', warn: 'Needs attention', fail: 'Problem', skip: 'Not checked', run: 'Checking' };

  function res(state, summary, details, fix) { return { state: state, summary: summary, details: details || [], fix: fix || '' }; }

  /* ---------------- individual checks (each resolves with res(...), never rejects) ---------------- */

  function checkWebsiteData() {
    if (typeof root.fetch !== 'function') { return Promise.resolve(res('skip', 'This browser cannot run the check.')); }
    return root.fetch('data/manifest.json', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) { return res('fail', 'data/manifest.json returned HTTP ' + r.status + '.', [], 'Run: python tools/build_release.py --mode public, then python tools/export_public_site.py, and redeploy.'); }
      return r.json().then(function (m) {
        if (!m || m.schema_version !== 1 || !Array.isArray(m.shards) || !m.shards.length) {
          return res('fail', 'The manifest is not valid (no shards listed).', [], 'Rebuild with tools/build_release.py and re-export.');
        }
        var count = m.shards.reduce(function (n, s) { return n + (s && typeof s.question_count === 'number' ? s.question_count : 0); }, 0);
        if (m.placeholder === true) {
          return res('warn', 'Only synthetic placeholder data is published (' + count + ' sample question' + (count === 1 ? '' : 's') + ').', [m.shards.length + ' shard file(s) listed'],
            'Expected until the owner approves real publication. Nothing to fix if this is intentional.');
        }
        return res('ok', count + ' questions in ' + m.shards.length + ' shard files.');
      }, function () { return res('fail', 'data/manifest.json is not valid JSON.', [], 'Rebuild with tools/build_release.py and re-export.'); });
    }, function () { return res('fail', 'Could not load data/manifest.json.', [], 'The file is missing from the deployed site. Re-run the export and redeploy.'); });
  }

  var PUBLIC_FIX = {
    not_configured: 'Set ENDPOINT_URL in frontend/api.js to the Public catalogue web app /exec URL, then run python tools/export_public_site.py and redeploy.',
    timeout: 'The script loaded but never answered. Usually the web app is not deployed with "Who has access: Anyone", so Google returned a sign-in page. Redeploy it as Anyone.',
    connection: 'The URL could not be loaded. Check ENDPOINT_URL is the /exec URL of a live deployment (not /dev) and that the deployment still exists.',
    bad_response: 'The service answered in an unexpected format. Make sure the deployed code is the latest PublicCatalogue.gs (Deploy > Manage deployments > New version).',
    busy: 'Another catalogue request was running. Press "Check again".'
  };
  var PUBLIC_SERVER = {
    not_configured: ['The catalogue service has no spreadsheet configured.', 'In the Public catalogue Apps Script project, run setupPublicCatalogue() so PUBLIC_DB_ID is stored.'],
    source_unavailable: ['The catalogue spreadsheet could not be opened.', 'Check PUBLIC_DB_ID in Script Properties and that the script owner can open that sheet.'],
    sheet_missing: ['The Questions_Public tab was not found.', 'Run setupPublicCatalogue() or restore the Questions_Public tab.'],
    forbidden_columns: ['The sheet contains answer-key or scoring columns, so nothing is published.', 'Remove those columns from the public sheet. They belong only in the private projects.'],
    bad_columns: ['The sheet columns do not match the public schema.', 'Run checkPublicCatalogue() in the editor and fix the header row it reports.'],
    empty_catalogue: ['The catalogue sheet has no questions.', 'Add rows, or run addPublicCatalogueSampleRow() for a synthetic test row.'],
    too_large: ['The catalogue is larger than the service can publish.', 'Split the catalogue or reduce the rows.'],
    malformed_data: ['Some catalogue rows are invalid, so nothing was published.', 'Run checkPublicCatalogue() in the editor; it lists the row numbers.'],
    internal_error: ['The catalogue service hit an unexpected error.', 'Open Apps Script > Executions and read the latest error.']
  };

  function checkPublicCatalogue() {
    var api = root.GatePublicApi;
    if (!api) { return Promise.resolve(res('fail', 'api.js did not load.', [], 'Check that status.html includes api.js and that the file exists on the site.')); }
    if (!api.isConfigured()) { return Promise.resolve(res('fail', 'Not connected: the endpoint URL is still the placeholder.', [], PUBLIC_FIX.not_configured)); }
    return api.loadCatalogueMetadata().then(function (m) {
      var details = ['Catalogue version ' + m.catalogue_version.slice(0, 12) + '\u2026'];
      if (m.published_at) { details.push('Published ' + m.published_at); }
      return res('ok', m.count + ' questions served.', details);
    }, function (e) {
      if (e && e.code === 'server_error') {
        var known = PUBLIC_SERVER[e.serverCode];
        var details = (e.issues || []).slice(0, 5);
        return res('fail', known ? known[0] : 'The service reported an error' + (e.serverCode ? ' (' + e.serverCode + ')' : '') + '.', details, known ? known[1] : 'Open Apps Script > Executions for details.');
      }
      var code = e && e.code ? e.code : 'connection';
      return res('fail', 'Could not reach the public catalogue (' + code + ').', [], PUBLIC_FIX[code] || PUBLIC_FIX.connection);
    });
  }

  var AUTH_FIX = {
    not_configured: 'Set AUTH_ENDPOINT_URL in frontend/auth.js to the Private auth/exam web app /exec URL, then run python tools/export_public_site.py and redeploy.',
    timeout: 'No answer in time. Apps Script may be cold-starting (press "Check again") or the deployment is missing or not set to "Anyone".',
    connection: 'The service could not be reached. Check AUTH_ENDPOINT_URL is a live /exec deployment and that it is deployed as "Execute as: Me, Who has access: Anyone".',
    bad_response: 'The reply was not the expected format. Make sure the deployed code is the latest PrivateAuthExam.gs (Deploy > Manage deployments > New version).'
  };
  var FEATURES = [['login', 'Login'], ['remember', 'Keep me logged in'], ['register', 'Registration'], ['reset', 'Password reset']];

  function checkPrivateAuth() {
    var auth = root.GateAuth;
    if (!auth) { return Promise.resolve(res('fail', 'auth.js did not load.', [], 'Check that status.html includes auth.js and that the file exists on the site.')); }
    if (!auth.isConfigured()) { return Promise.resolve(res('fail', 'Not connected: the endpoint URL is still the placeholder.', [], AUTH_FIX.not_configured)); }
    return auth.call('auth_status', {}).then(function (r) {
      var s = r.data || {};
      if (s.initialized !== true) {
        return res('fail', 'Reachable, but its databases are not set up.', [], 'In the Private auth/exam Apps Script project run setupPrivateDatabases(), then checkPrivateDatabases().');
      }
      var off = [], on = [];
      FEATURES.forEach(function (f) { (s[f[0]] === true ? on : off).push(f[1]); });
      var details = ['Enabled: ' + (on.length ? on.join(', ') : 'none'), 'Google sign-in: off by design (owner decision D-14)'];
      if (off.length) {
        details.unshift('Switched off: ' + off.join(', '));
        return res('warn', 'Service is up, but ' + off.length + ' of ' + FEATURES.length + ' features are switched off.', details,
          'Each feature needs its approval gates (AUTH_POLICY_*) and secrets (pepper, KDF salt) in Script Properties. Run checkPrivateDatabases() and see SETUP_GUIDE.md.');
      }
      return res('ok', 'Service is up and all account features are enabled.', details);
    }, function (e) {
      var kind = e && e.kind ? e.kind : 'connection';
      if (kind === 'server') {
        if (e.code === 'not_initialized') { return res('fail', 'Reachable, but not initialised.', [], 'Run setupPrivateDatabases() in the Private auth/exam project.'); }
        return res('fail', 'The service returned an error (' + (e.code || 'unknown') + ').', e.reason ? ['Reason: ' + e.reason] : [], 'Open Apps Script > Executions and read the latest error.');
      }
      return res('fail', 'Could not reach the private service (' + kind + ').', [], AUTH_FIX[kind] || AUTH_FIX.connection);
    });
  }

  var EXAM_REASON = {
    question_publication_unapproved: 'Question publication is not approved yet (D-07).',
    mock_composition_unresolved_d12: 'Mock exam composition is not decided yet (D-12).',
    duration_policy_unresolved_d11: 'Duration policy is not decided yet (D-11).'
  };

  function checkExamService() {
    var auth = root.GateAuth;
    if (!auth || !auth.isConfigured()) { return Promise.resolve(res('skip', 'Needs the private service to be connected first.')); }
    var s = auth.readSession();
    if (!s) { return Promise.resolve(res('skip', 'Log in to test the exam service. It only answers to a signed-in session.', [], 'Log in, then press "Check again".')); }
    return auth.call('list_papers', {}, s.token).then(function (r) {
      var n = r.data && Array.isArray(r.data.papers) ? r.data.papers.length : null;
      return res('ok', n === null ? 'Exam service answered.' : n + ' paper' + (n === 1 ? '' : 's') + ' available online.');
    }, function (e) {
      if (e && e.kind === 'server') {
        if (e.code === 'unauthenticated') { return res('skip', 'Your session has expired. Log in again to test the exam service.'); }
        if (e.code === 'feature_disabled') { return res('warn', 'Reachable, but online exams are switched off.', [EXAM_REASON[e.reason] || (e.reason ? 'Gate: ' + e.reason : 'An approval gate is off.')], 'Set the missing approval in the private project\u2019s Script Properties. See SETUP_GUIDE.md.'); }
        return res('fail', 'The exam service returned an error (' + (e.code || 'unknown') + ').', e.reason ? ['Reason: ' + e.reason] : [], 'Open Apps Script > Executions and read the latest error. Run checkPrivateDatabases().');
      }
      return res('fail', 'Could not reach the exam service (' + (e && e.kind ? e.kind : 'connection') + ').', [], AUTH_FIX[e && e.kind] || AUTH_FIX.connection);
    });
  }

  var CHECKS = [
    { id: 'data', name: 'Website data files', where: 'GitHub Pages: data/manifest.json', run: checkWebsiteData },
    { id: 'public', name: 'Public catalogue service', where: 'Apps Script project 1 (PublicCatalogue.gs)', run: checkPublicCatalogue },
    { id: 'auth', name: 'Private login / account service', where: 'Apps Script project 2 (PrivateAuthExam.gs)', run: checkPrivateAuth },
    { id: 'exam', name: 'Online exam service', where: 'Apps Script project 2, session operations', run: checkExamService },
    { id: 'backup', name: 'Private backup service', where: 'Apps Script project 3 (owner-run, no web app)',
      run: function () { return Promise.resolve(res('skip', 'Cannot be checked from a website: it has no web address by design.', [], 'In that project\u2019s editor run checkPrivateBackupSetup() and read the log.')); } }
  ];

  /* ---------------- rendering ---------------- */

  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) { n.className = cls; } if (text !== undefined) { n.textContent = text; } return n; }

  function paint(card, id, r) {
    card.setAttribute('data-state', r.state);
    card.querySelector('.status-badge').textContent = SYMBOL[r.state] + ' ' + LABEL[r.state];
    card.querySelector('.status-dot').textContent = SYMBOL[r.state];
    var body = card.querySelector('.status-body');
    while (body.firstChild) { body.removeChild(body.firstChild); }
    body.appendChild(el('p', 'status-summary', r.summary));
    if (r.details.length) {
      var ul = el('ul', 'status-details');
      r.details.forEach(function (d) { ul.appendChild(el('li', '', d)); });
      body.appendChild(ul);
    }
    if (r.fix && r.state !== 'ok') {
      var fix = el('p', 'status-fix');
      fix.appendChild(el('strong', '', r.state === 'skip' ? 'How to check: ' : 'How to fix: '));
      fix.appendChild(doc.createTextNode(r.fix));
      body.appendChild(fix);
    }
  }

  function buildCards(list) {
    list.textContent = '';
    CHECKS.forEach(function (c) {
      var li = el('li', 'status-card'); li.id = 'status-' + c.id; li.setAttribute('data-state', 'run');
      var head = el('div', 'status-head');
      head.appendChild(el('span', 'status-dot', SYMBOL.run));
      var titles = el('div', 'status-titles');
      titles.appendChild(el('h2', 'status-name', c.name));
      titles.appendChild(el('p', 'status-where', c.where));
      head.appendChild(titles);
      head.appendChild(el('span', 'status-badge', SYMBOL.run + ' ' + LABEL.run));
      li.appendChild(head);
      li.appendChild(el('div', 'status-body'));
      list.appendChild(li);
    });
  }

  function overall(results) {
    var fail = 0, warn = 0, ok = 0;
    Object.keys(results).forEach(function (k) { var s = results[k].state; if (s === 'fail') { fail++; } else if (s === 'warn') { warn++; } else if (s === 'ok') { ok++; } });
    if (fail) { return { state: 'fail', text: fail + ' service' + (fail === 1 ? '' : 's') + ' not working' + (warn ? ', ' + warn + ' need attention' : '') + '.' }; }
    if (warn) { return { state: 'warn', text: 'All reachable, but ' + warn + ' need' + (warn === 1 ? 's' : '') + ' attention.' }; }
    return { state: 'ok', text: 'All checked services are working.' };
  }

  var running = false;
  function runAll() {
    if (running) { return; }
    running = true;
    var list = doc.getElementById('status-list'), banner = doc.getElementById('status-overall'), btn = doc.getElementById('status-recheck'), when = doc.getElementById('status-time');
    buildCards(list);
    banner.setAttribute('data-state', 'run'); banner.textContent = SYMBOL.run + ' Running checks\u2026';
    if (btn) { btn.disabled = true; }
    var results = {};
    Promise.all(CHECKS.map(function (c) {
      return c.run().catch(function () { return res('fail', 'The check itself failed unexpectedly.'); }).then(function (r) {
        results[c.id] = r; paint(doc.getElementById('status-' + c.id), c.id, r);
      });
    })).then(function () {
      var o = overall(results);
      banner.setAttribute('data-state', o.state); banner.textContent = SYMBOL[o.state] + ' ' + o.text;
      if (when) { when.textContent = 'Last checked ' + new Date().toLocaleTimeString(); }
      running = false; if (btn) { btn.disabled = false; }
    });
  }

  function init() {
    var btn = doc.getElementById('status-recheck');
    if (btn) { btn.addEventListener('click', runAll); }
    runAll();
  }

  if (doc) { if (doc.readyState === 'loading') { doc.addEventListener('DOMContentLoaded', init); } else { init(); } }
})(typeof window !== 'undefined' ? window : this);
