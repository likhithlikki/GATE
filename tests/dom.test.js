// Simulated-browser tests (jsdom) against the real HTML files. Run: node dom.test.js
const { JSDOM } = require('jsdom'); const fs = require('fs'); const path = require('path'); const assert = require('assert');
const SITE = path.join(__dirname, '..') + '/'; const FX = path.join(__dirname, 'fixtures') + '/';
const js = fs.readFileSync(SITE + 'app.js', 'utf8'); const G = require('../app.js');
const results = []; const queue = []; const t = (name, fn) => queue.push([name, fn]);
const fetchOf = (status, body) => () => Promise.resolve({ status, ok: status >= 200 && status < 300, text: () => Promise.resolve(body) });
const fx = n => fs.readFileSync(FX + n, 'utf8');
const $ = (w, id) => w.document.getElementById(id);
const fire = (w, el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
const click = (w, id) => fire(w, $(w, id), 'click');
const choose = (w, id, value) => { $(w, id).value = value; fire(w, $(w, id), 'change'); };
const typeCount = (w, v) => { $(w, 'pf-count').value = v; fire(w, $(w, 'pf-count'), 'input'); };

function load(page, { query = '', fetchImpl } = {}) {
  const dom = new JSDOM(fs.readFileSync(SITE + page, 'utf8'), { runScripts: 'outside-only', url: 'https://example.test/' + page + query });
  if (fetchImpl) dom.window.fetch = fetchImpl;
  dom.window.eval(js); return dom.window;
}
/* Task 49: the page now asks for data/manifest.json first. These legacy-bank tests model a site WITHOUT a manifest, so that URL answers 404 and the page falls
 * back to data/questions.json exactly as before. Tests of the manifest path pass their own fetch and set manifestAware. */
async function practice(query, fetchImpl, { manifestAware = false } = {}) {
  const wrapped = manifestAware ? fetchImpl : (u, o) => (/manifest\.json$/.test(String(u)) ? Promise.resolve({ status: 404, ok: false, text: () => Promise.resolve('') }) : fetchImpl(u, o));
  const w = load('practice.html', { query, fetchImpl: wrapped });
  for (let i = 0; i < 100 && !w.__practiceReady; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(w.__practiceReady, 'practice page finished loading'); return w;
}
const opts = (w, id) => [...$(w, id).options].map(o => o.textContent);
const blockersText = w => [...$(w, 'blockers').children].map(li => li.textContent).join(' | ');

// ---------- Task 10 behaviour (auth forms) still works ----------
t('register: empty submit -> errors; valid -> not connected, nothing sent', () => {
  let w = load('register.html'); click(w, 'register-submit');
  assert.match($(w, 'register-status').textContent, /fix the highlighted/); assert.ok($(w, 'reg-email-error').textContent);
  w = load('register.html');
  Object.entries({ 'reg-username': 'likith_1', 'reg-fullname': 'A Student', 'reg-email': 'a@gmail.com', 'reg-password': 'longenough1', 'reg-confirm': 'longenough1' }).forEach(([k, v]) => $(w, k).value = v);
  $(w, 'reg-consent').checked = true; click(w, 'register-submit');
  assert.match($(w, 'register-status').textContent, /No account was created/); assert.strictEqual(w.localStorage.length + w.sessionStorage.length, 0);
});
t('login/forgot/OTP buttons never claim success', () => {
  let w = load('login.html'); $(w, 'login-identifier').value = 'u'; $(w, 'login-password').value = 'p'; click(w, 'login-submit');
  assert.match($(w, 'login-status').textContent, /not connected/); click(w, 'google-signin'); assert.match(w.document.querySelector('.status-inline').textContent, /Google sign-in is not enabled|not connected/);
  w = load('forgot-password.html'); $(w, 'forgot-identifier').value = 'x'; click(w, 'forgot-submit'); assert.match($(w, 'forgot-status').textContent, /no code was sent/);
});
t('static pages still load with app.js', () => { ['index.html', 'help.html', '404.html', 'profile.html', 'dashboard.html'].forEach(p => load(p)); });

// ---------- Practice page ----------
t('TEST 1 (page) missing bank: clear message, filters disabled, summary blocked, no fake data', async () => {
  const w = await practice('', fetchOf(404, ''));
  assert.match($(w, 'bank-note').textContent, /No question bank has been imported/);
  ['branch', 'year', 'subject', 'topic', 'type'].forEach(f => assert.ok($(w, 'pf-' + f).disabled, f));
  assert.ok($(w, 'pf-count').disabled); assert.strictEqual($(w, 'sum-matching').textContent, '—'); assert.strictEqual($(w, 'sum-ready').textContent, 'No');
  assert.match(blockersText(w), /No usable question bank/); click(w, 'start-test'); assert.match($(w, 'summary-status').textContent, /cannot start yet/);
});
t('TEST 2/3 (page) invalid JSON, empty bank, bad schema, network error each show their own message', async () => {
  const cases = [[fetchOf(200, fx('not-json.txt')), /not valid JSON/], [fetchOf(200, fx('empty.json')), /no usable questions/],
    [fetchOf(200, fx('bad-schema.json')), /expected format/], [() => Promise.reject(new TypeError('offline')), /could not be loaded/]];
  for (const [f, re] of cases) { const w = await practice('', f); assert.match($(w, 'bank-note').textContent, re); assert.ok($(w, 'pf-branch').disabled); assert.strictEqual($(w, 'sum-ready').textContent, 'No'); }
});
t('no fetch at all (e.g. very old browser) does not crash', async () => { const w = load('practice.html'); w.fetch = undefined; });
t('TEST 4 (page) valid bank: placeholder warning shown, source named, options come from data', async () => {
  const w = await practice('', fetchOf(200, fx('valid.json')));
  assert.match($(w, 'bank-note').textContent, /12 usable questions/); assert.match($(w, 'bank-note').textContent, /SYNTHETIC TEST FIXTURE/);
  assert.match($(w, 'bank-detail').textContent, /placeholder data/); assert.strictEqual($(w, 'bank-detail').hidden, false);
  assert.deepStrictEqual(opts(w, 'pf-branch'), ['Any', 'SYN-BRANCH-1 (6)', 'SYN-BRANCH-2 (6)']);
  assert.deepStrictEqual(opts(w, 'pf-year'), ['Any', '2021 (4)', '2020 (5)', '2019 (3)']);
  assert.deepStrictEqual(opts(w, 'pf-type'), ['Any', 'MCQ (6)', 'MSQ (3)', 'NAT (3)'].map(x => x));
});
t('TEST 5/7/8 (page) custom mode: filter, count bounds, marks, duration, breakdown', async () => {
  const w = await practice('?mode=custom', fetchOf(200, fx('valid.json')));
  assert.strictEqual($(w, 'sum-matching').textContent, '12'); assert.strictEqual($(w, 'sum-marks').textContent, '18 (all matching questions)');
  choose(w, 'pf-branch', 'SYN-BRANCH-1');
  assert.strictEqual($(w, 'match-status').textContent, '6 questions match your filters.');
  assert.strictEqual($(w, 'sum-matching').textContent, '6'); assert.strictEqual($(w, 'sum-requested').textContent, '6');
  assert.strictEqual($(w, 'sum-marks').textContent, '9'); assert.strictEqual($(w, 'sum-duration').textContent, '0 h 24 min 55 s (1495 s)');
  assert.match($(w, 'sum-types').textContent, /MCQ: 3 questions, 4 marks; MSQ: 1 question, 2 marks; NAT: 2 questions, 3 marks/);
  assert.strictEqual($(w, 'pf-count').max, '6');
  typeCount(w, '3'); assert.strictEqual($(w, 'sum-requested').textContent, '3');
  assert.match($(w, 'sum-marks').textContent, /^Between 3 and 6 /); assert.match($(w, 'sum-duration').textContent, /^Between /);
  assert.match($(w, 'sum-types').textContent, /^In the matching pool/); assert.match(blockersText(w), /subset is drawn/);
  typeCount(w, '99');   // above availability -> clamped, announced
  assert.strictEqual($(w, 'pf-count').value, '6'); assert.strictEqual($(w, 'sum-requested').textContent, '6');
  assert.match($(w, 'match-status').textContent, /Only 6 match, so the request was reduced to 6/);
  typeCount(w, '6'); assert.strictEqual($(w, 'sum-marks').textContent, '9');
  typeCount(w, '0'); assert.match($(w, 'pf-count-error').textContent, /whole number from 1 to 6/); assert.strictEqual($(w, 'pf-count').getAttribute('aria-invalid'), 'true'); assert.strictEqual($(w, 'sum-requested').textContent, 'Not a valid number');
  typeCount(w, ''); assert.ok($(w, 'pf-count-error').textContent); typeCount(w, '2.5'); assert.ok($(w, 'pf-count-error').textContent);
  typeCount(w, '2'); assert.strictEqual($(w, 'pf-count-error').textContent, ''); assert.strictEqual($(w, 'pf-count').hasAttribute('aria-invalid'), false);
});
t('TEST 5 (page) every filter narrows the count', async () => {
  const w = await practice('?mode=custom', fetchOf(200, fx('valid.json')));
  choose(w, 'pf-year', '2019'); assert.strictEqual($(w, 'sum-matching').textContent, '3');
  choose(w, 'pf-subject', 'Subj-Z'); assert.deepStrictEqual(opts(w, 'pf-topic'), ['Any', 'Topic-4 (2)', 'Topic-5 (1)']);
  choose(w, 'pf-topic', 'Topic-4'); assert.strictEqual($(w, 'sum-matching').textContent, '2');
  choose(w, 'pf-type', 'NAT'); assert.strictEqual($(w, 'sum-matching').textContent, '1'); assert.match($(w, 'match-status').textContent, /^1 question matches/);
  assert.match($(w, 'sum-filters').textContent, /Branch: any; Year: 2019; Subject: Subj-Z; Topic: Topic-4; Question type: NAT/);
});
t('TEST 6 (page) zero matches -> empty state, nothing fabricated, recoverable', async () => {
  const w = await practice('?mode=custom', fetchOf(200, fx('valid.json')));
  choose(w, 'pf-branch', 'SYN-BRANCH-1'); choose(w, 'pf-year', '2019');
  assert.strictEqual($(w, 'empty-state').hidden, false); assert.match($(w, 'empty-state').textContent, /broaden/);
  assert.strictEqual($(w, 'sum-matching').textContent, '0'); assert.strictEqual($(w, 'sum-marks').textContent, '—'); assert.strictEqual($(w, 'sum-duration').textContent, '—');
  assert.ok($(w, 'pf-count').disabled); assert.match(blockersText(w), /No questions match/); assert.match($(w, 'match-status').textContent, /No questions match/);
  assert.ok(opts(w, 'pf-year').includes('2019 (0)'), 'zero-count option is visible and labelled');
  click(w, 'pf-reset'); assert.strictEqual($(w, 'empty-state').hidden, true); assert.strictEqual($(w, 'sum-matching').textContent, '12'); assert.strictEqual($(w, 'pf-branch').value, '');
});
t('TEST 10 (page) ?mode= preselects each mode and shows the right filters', async () => {
  const want = { year: ['branch', 'year'], subject: ['branch', 'subject'], topic: ['branch', 'subject', 'topic'], custom: ['branch', 'year', 'subject', 'topic', 'type'], full: [] };
  for (const [m, shown] of Object.entries(want)) {
    const w = await practice('?mode=' + m, fetchOf(200, fx('valid.json')));
    assert.ok($(w, 'mode-' + m).checked, m);
    ['branch', 'year', 'subject', 'topic', 'type'].forEach(f => assert.strictEqual(w.document.querySelector(`[data-filter="${f}"]`).hidden, !shown.includes(f), m + '/' + f));
    assert.strictEqual($(w, 'sum-mode').textContent, G.MODES[m].label);
  }
  for (const q of ['', '?mode=bogus', '?mode=constructor', '?mode=']) { const w = await practice(q, fetchOf(200, fx('valid.json'))); assert.ok($(w, 'mode-custom').checked, 'fallback for "' + q + '"'); }
});
t('year/subject/topic modes require their filters before counting', async () => {
  let w = await practice('?mode=year', fetchOf(200, fx('valid.json')));
  assert.strictEqual($(w, 'sum-matching').textContent, '—'); assert.match($(w, 'match-status').textContent, /Choose branch and year/); assert.match(blockersText(w), /Choose: Branch, Year\./);
  assert.match(w.document.querySelector('[data-filter="year"] .req').textContent, /required/);
  choose(w, 'pf-branch', 'SYN-BRANCH-1'); assert.strictEqual($(w, 'sum-matching').textContent, '—'); choose(w, 'pf-year', '2021');
  assert.strictEqual($(w, 'sum-matching').textContent, '3'); assert.strictEqual($(w, 'sum-marks').textContent, '5 (all matching questions)');
  w = await practice('?mode=topic', fetchOf(200, fx('valid.json'))); choose(w, 'pf-subject', 'Subj-X'); assert.match(blockersText(w), /Choose: Topic\./);
  choose(w, 'pf-topic', 'Topic-1'); assert.strictEqual($(w, 'sum-matching').textContent, '3');
});
t('switching mode via the radios updates the URL and resets the count request', async () => {
  const w = await practice('?mode=custom', fetchOf(200, fx('valid.json'))); typeCount(w, '2');
  $(w, 'mode-subject').checked = true; fire(w, $(w, 'mode-subject'), 'change');
  assert.strictEqual(new w.URL(w.location.href).searchParams.get('mode'), 'subject'); assert.strictEqual($(w, 'sum-mode').textContent, 'Subject-wise tests'); assert.strictEqual($(w, 'pf-count').disabled, true);
});
t('full mock: awaiting configuration, no questions selected, nothing invented', async () => {
  const w = await practice('?mode=full', fetchOf(200, fx('valid.json')));
  assert.strictEqual($(w, 'mock-note').hidden, false); assert.strictEqual($(w, 'pf-count-field').hidden, true);
  assert.strictEqual($(w, 'sum-matching').textContent, '—'); assert.strictEqual($(w, 'sum-marks').textContent, '—'); assert.match(blockersText(w), /awaiting configuration/);
});
t('start is never possible; message lists exactly what is missing', async () => {
  const w = await practice('?mode=custom', fetchOf(200, fx('valid.json'))); click(w, 'start-test');
  const msg = $(w, 'summary-status').textContent;
  assert.match(msg, /Marking rules for MCQ, MSQ and NAT have not been confirmed/); assert.match(msg, /exam window, answer saving, answer keys and scoring are not built/);
  assert.strictEqual($(w, 'sum-ready').textContent, 'No'); assert.match($(w, 'sum-rules').textContent, /Not confirmed/);
  assert.strictEqual($(w, 'start-test').getAttribute('aria-disabled'), 'true');
});
t('malformed records: usable ones listed, rejected ones explained (not silently dropped)', async () => {
  const w = await practice('', fetchOf(200, fx('mixed-invalid.json')));
  assert.match($(w, 'bank-note').textContent, /2 usable questions, 9 record\(s\) not used/); const d = $(w, 'bank-detail').textContent;
  assert.match(d, /duplicate id "m01"/); assert.match(d, /marks must be a positive whole number/); assert.strictEqual($(w, 'sum-matching').textContent, '2');
});
t('answer keys in the public file: warned about, never shown anywhere on the page', async () => {
  const w = await practice('', fetchOf(200, fx('with-answer-keys.json')));
  assert.match($(w, 'bank-detail').textContent, /anyone can read data\/questions\.json/); assert.ok(!w.document.body.textContent.includes('SYNTHETIC SECRET EXPLANATION'));
});
t('untrusted data cannot inject markup (values are inserted as text)', async () => {
  const evil = JSON.parse(fx('valid.json')); evil.questions[0].branch = '<img src=x onerror=alert(1)>'; evil.questions[0].source.name = '<script>alert(1)</script>';
  const w = await practice('', fetchOf(200, JSON.stringify(evil)));
  assert.strictEqual(w.document.querySelectorAll('img').length, 0); assert.strictEqual(w.document.querySelectorAll('#practice-form script').length, 0);
  assert.ok(opts(w, 'pf-branch').some(o => o.includes('<img')));
});
t('accessibility wiring: every control has a label; live regions and ids are present', async () => {
  const w = await practice('', fetchOf(200, fx('valid.json'))); const d = w.document;
  d.querySelectorAll('#practice-form select, #practice-form input').forEach(c => assert.ok(d.querySelector(`label[for="${c.id}"]`), 'label for ' + c.id));
  assert.strictEqual($(w, 'match-status').getAttribute('aria-live'), 'polite'); assert.strictEqual($(w, 'summary-status').getAttribute('role'), 'status');
  assert.strictEqual($(w, 'bank-note').getAttribute('role'), 'status'); assert.strictEqual($(w, 'pf-count-error').getAttribute('role'), 'alert');
  assert.ok(d.querySelector('fieldset.mode-fieldset legend')); assert.strictEqual(d.querySelectorAll('input[name="practice-mode"]').length, 5);
  const ids = [...d.querySelectorAll('[id]')].map(e => e.id); assert.strictEqual(ids.length, new Set(ids).size, 'unique ids');
  d.querySelectorAll('[aria-describedby]').forEach(e => e.getAttribute('aria-describedby').split(' ').forEach(i => assert.ok(d.getElementById(i), 'describedby target ' + i)));
});

// ---------- Task 49: manifest-driven paper/year picker (synthetic data only) ----------
const { webcrypto } = require('crypto'); const sha256 = t => require('crypto').createHash('sha256').update(Buffer.from(t, 'utf8')).digest('hex');
function manifestSite(opts = {}) {
  const mk = (code, year, n) => { const text = JSON.stringify({ schema_version: 1, placeholder: true, questions: Array.from({ length: n }, (_, i) => ({ id: code + year + '-q' + i, branch: 'SYN-BRANCH', year, subject: 'Subj-X', topic: 'Topic-1', type: 'NAT', marks: 1, text: 'SYNTHETIC TEST QUESTION', source: { name: 'SYNTHETIC TEST FIXTURE' } })) });
    return { text, entry: { id: code + '-' + year, paper_code: code, paper_name: code + ' (SYNTHETIC)', year, path: 'papers/' + code + '/' + year + '.json', question_count: n, sha256: sha256(text) } }; };
  const a = mk('CS', 2024, 3), b = mk('EC', 2023, 2); if (opts.breakB) { b.text += ' '; }
  const files = { 'data/manifest.json': opts.rawManifest || JSON.stringify({ schema_version: 1, release: 'TEST', placeholder: true, shards: [a.entry, b.entry] }), 'data/papers/CS/2024.json': a.text, 'data/papers/EC/2023.json': b.text, 'data/questions.json': fx('valid.json') };
  const calls = [];
  return { calls, fetchImpl: u => { calls.push(u); const body = files[u]; return Promise.resolve(body === undefined ? { status: 404, ok: false, text: () => Promise.resolve('') } : { status: 200, ok: true, text: () => Promise.resolve(body) }); } };
}
async function manifestPage(site) {
  const w = load('practice.html', { fetchImpl: site.fetchImpl }); Object.defineProperty(w.crypto, 'subtle', { value: webcrypto.subtle, configurable: true });
  for (let i = 0; i < 100 && !w.__practiceReady; i++) await new Promise(r => setTimeout(r, 5)); assert.ok(w.__practiceReady); return w;
}
const settle = () => new Promise(r => setTimeout(r, 40));
t('T49 page: choices come from the manifest; nothing is loaded until a paper and year are chosen', async () => {
  const site = manifestSite(), w = await manifestPage(site);
  assert.strictEqual($(w, 'paper-card').hidden, false); assert.deepStrictEqual(opts(w, 'pp-paper'), ['Choose a paper', 'CS – CS (SYNTHETIC)', 'EC – EC (SYNTHETIC)']);
  assert.deepStrictEqual(site.calls, ['data/manifest.json'], 'only the manifest fetched'); assert.match($(w, 'bank-note').textContent, /Choose a paper and year/); assert.ok($(w, 'pf-branch').disabled); assert.strictEqual($(w, 'pp-load').disabled, true);
  choose(w, 'pp-paper', 'CS'); assert.deepStrictEqual(opts(w, 'pp-year'), ['Choose a year', '2024']); choose(w, 'pp-year', '2024'); assert.strictEqual($(w, 'pp-load').disabled, false);
  click(w, 'pp-load'); await settle();
  assert.deepStrictEqual(site.calls, ['data/manifest.json', 'data/papers/CS/2024.json'], 'only the selected shard fetched'); assert.match($(w, 'bank-note').textContent, /CS 2024: 3 usable questions/); assert.strictEqual($(w, 'pf-branch').disabled, false);
  assert.strictEqual($(w, 'sum-matching').textContent, '3', 'filters use the actual selected shard records');
  assert.strictEqual($(w, 'import-open-preview').disabled, false, 'selected manifest data enables local preview when the selection is valid');
  assert.strictEqual($(w, 'pp-open-preview').hidden, false, 'official-paper card exposes its own preview action');
  assert.strictEqual($(w, 'pp-open-preview').disabled, false, 'direct preview action follows selected-count validation');
  assert.strictEqual($(w, 'import-clear').textContent, 'Clear selected paper', 'clear action describes the selected manifest paper accurately');
});
t('T49 page: a failing shard shows a failure and loads nothing', async () => {
  const site = manifestSite({ breakB: true }), w = await manifestPage(site); choose(w, 'pp-paper', 'EC'); choose(w, 'pp-year', '2023'); click(w, 'pp-load'); await settle();
  assert.match($(w, 'pp-status').textContent, /^Not loaded\./); assert.match($(w, 'bank-note').textContent, /nothing was loaded/); assert.ok($(w, 'pf-branch').disabled); assert.strictEqual($(w, 'sum-ready').textContent, 'No');
});
t('T49 page: a malformed manifest is an error and the legacy file is NOT used instead', async () => {
  const site = manifestSite({ rawManifest: '{"schema_version":1,"release":"r","shards":[{"id":"x"}]}' }), w = await manifestPage(site);
  assert.match($(w, 'bank-note').textContent, /malformed/); assert.strictEqual($(w, 'paper-card').hidden, true); assert.ok($(w, 'pf-branch').disabled); assert.ok(!site.calls.includes('data/questions.json'), 'legacy file not fetched');
});

(async () => {
  let n = 0;
  for (const [name, fn] of queue) { try { await fn(); n++; console.log('ok -', name); } catch (e) { console.error('FAIL -', name, '\n', e.message); process.exitCode = 1; } }
  console.log(`\n${n}/${queue.length} DOM tests passed`);
})();
