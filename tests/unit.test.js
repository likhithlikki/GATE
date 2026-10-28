// Pure-function tests. Run: node unit.test.js  (fixtures are synthetic; see ./fixtures)
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const G = require('../app.js');
const fx = n => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
let n = 0; const queue = [];
const t = (name, fn) => queue.push([name, fn]);
const mockFetch = (status, body) => () => Promise.resolve({ status, ok: status >= 200 && status < 300, text: () => Promise.resolve(body) });

// ---------- duration rule and form checks (from Task 10) ----------
const { durationSeconds, formatDuration, check } = G;
t('65 marks = 10800 s = 3 h exactly', () => { assert.strictEqual(durationSeconds(65), 10800); assert.strictEqual(formatDuration(10800), '3 h 00 min 00 s'); });
t('10 and 30 marks', () => { assert.strictEqual(durationSeconds(10), 1662); assert.strictEqual(formatDuration(4985), '1 h 23 min 05 s'); assert.strictEqual(durationSeconds(30), 4985); });
t('formula matches spec for every integer 1..300', () => { for (let m = 1; m <= 300; m++) assert.strictEqual(durationSeconds(m), Math.round(m / 65 * 180 * 60), 'marks ' + m); });
t('duration rejects 0, negatives, NaN, strings', () => { [0, -5, NaN, Infinity, '65', null, undefined].forEach(v => assert.throws(() => durationSeconds(v), RangeError)); });
t('form checks: username, gmail, password', () => {
  assert.strictEqual(check.username('a_b9'), ''); assert.notStrictEqual(check.username('a b'), '');
  assert.strictEqual(check.gmail('a.b+c@gmail.com'), ''); ['', 'a@yahoo.com', 'a@gmail.com.evil.com'].forEach(v => assert.notStrictEqual(check.gmail(v), ''));
  assert.notStrictEqual(check.newPassword('1234567'), ''); assert.strictEqual(check.newPassword('12345678'), ''); assert.notStrictEqual(check.confirm('a', 'b'), '');
});

// ---------- loader: test cases 1-4, 9 ----------
t('TEST 1 missing file (404) -> status missing, clear message', async () => {
  const r = await G.loadBank(mockFetch(404, ''), 'x'); assert.strictEqual(r.status, 'missing'); assert.match(r.message, /No question bank has been imported/); assert.strictEqual(r.records.length, 0);
});
t('network failure / no fetch -> unreachable; HTTP 500 -> error', async () => {
  assert.strictEqual((await G.loadBank(() => Promise.reject(new TypeError('x')), 'x')).status, 'unreachable');
  assert.strictEqual((await G.loadBank(null, 'x')).status, 'unreachable');
  assert.strictEqual((await G.loadBank(mockFetch(500, ''), 'x')).status, 'error');
});
t('TEST 2 invalid JSON (and an HTML page served with 200) -> invalid_json', async () => {
  assert.strictEqual((await G.loadBank(mockFetch(200, fx('not-json.txt')), 'x')).status, 'invalid_json');
  assert.strictEqual((await G.loadBank(mockFetch(200, '<!doctype html><p>hi'), 'x')).status, 'invalid_json');
  assert.strictEqual((await G.loadBank(mockFetch(200, ''), 'x')).status, 'invalid_json');
});
t('wrong schema (no schema_version / bare array / null) -> invalid', async () => {
  for (const body of [fx('bad-schema.json'), '[]', 'null', '{"schema_version":2,"questions":[]}', '{"schema_version":1,"questions":{}}'])
    assert.strictEqual((await G.loadBank(mockFetch(200, body), 'x')).status, 'invalid', body);
});
t('TEST 3 empty bank -> status empty, never throws', async () => {
  const r = await G.loadBank(mockFetch(200, fx('empty.json')), 'x'); assert.strictEqual(r.status, 'empty'); assert.match(r.message, /no usable questions/);
});
t('TEST 4 valid fixture covers MCQ, MSQ, NAT; 12 usable, 0 rejected', async () => {
  const r = await G.loadBank(mockFetch(200, fx('valid.json')), 'x');
  assert.strictEqual(r.status, 'ready'); assert.strictEqual(r.records.length, 12); assert.strictEqual(r.rejected.length, 0);
  assert.deepStrictEqual([...new Set(r.records.map(x => x.type))].sort(), ['MCQ', 'MSQ', 'NAT']);
  assert.ok(r.warnings.some(w => /placeholder/.test(w)), 'placeholder flag must warn');
  assert.deepStrictEqual(r.sources, ['SYNTHETIC TEST FIXTURE']);
});
t('catalogue holds metadata only: no text, options, answer key or explanation', async () => {
  const r = G.prepareCatalogue(JSON.parse(fx('with-answer-keys.json')));
  assert.strictEqual(r.records.length, 2);
  r.records.forEach(x => assert.deepStrictEqual(Object.keys(x).sort(), ['branch', 'id', 'marks', 'source', 'subject', 'topic', 'type', 'year']));
  assert.ok(!JSON.stringify(r).includes('SYNTHETIC SECRET EXPLANATION'));
  assert.ok(r.warnings.some(w => /anyone can read/.test(w)));
});
t('TEST 9 duplicate/invalid records are rejected with reasons; good ones kept', () => {
  const r = G.prepareCatalogue(JSON.parse(fx('mixed-invalid.json')));
  assert.deepStrictEqual(r.records.map(x => x.id), ['m01', 'm02']); assert.strictEqual(r.rejected.length, 9);
  const why = r.rejected.map(x => x.reasons.join('|')).join('\n');
  for (const re of [/duplicate id/, /type must be/, /marks must be a positive whole number/, /source\.name/, /at least 2 options/, /not an object/, /year must be/, /option ids must be unique/])
    assert.match(why, re);
  assert.strictEqual(r.records.find(x => x.id === 'm01').year, 2020, 'first duplicate is the one kept');
  assert.strictEqual(new Set(r.records.map(x => x.id)).size, r.records.length, 'no duplicate ids in catalogue');
});
t('all-invalid bank -> empty with rejected list', () => {
  const r = G.prepareCatalogue({ schema_version: 1, questions: [{}, 5, null] }); assert.strictEqual(r.status, 'empty'); assert.strictEqual(r.rejected.length, 3);
});
t('validateRecord: prototype-ish ids and oversize fields', () => {
  const ok = JSON.parse(fx('valid.json')).questions[0];
  assert.deepStrictEqual(G.validateRecord(ok), []);
  assert.deepStrictEqual(G.validateRecord({ ...ok, id: '__proto__' }), []); // allowed by pattern, must not poison maps
  assert.notStrictEqual(G.validateRecord({ ...ok, id: 'has space' }).length, 0);
  assert.notStrictEqual(G.validateRecord({ ...ok, branch: 'x'.repeat(101) }).length, 0);
  const c = G.prepareCatalogue({ schema_version: 1, questions: [{ ...ok, id: '__proto__' }, { ...ok, id: 'constructor' }] });
  assert.strictEqual(c.records.length, 2);
});

// ---------- filtering: test cases 5, 6 ----------
const records = () => G.prepareCatalogue(JSON.parse(fx('valid.json'))).records;
const ids = a => a.map(x => x.id).join(',');
t('TEST 5 filter by branch, year, subject, topic, type', () => {
  const R = records();
  assert.strictEqual(G.filterRecords(R, { branch: 'SYN-BRANCH-1' }).length, 6);
  assert.strictEqual(ids(G.filterRecords(R, { year: '2019' })), 'q08,q09,q10');
  assert.strictEqual(G.filterRecords(R, { subject: 'Subj-Z' }).length, 4);
  assert.strictEqual(ids(G.filterRecords(R, { topic: 'Topic-4' })), 'q08,q09');
  assert.strictEqual(ids(G.filterRecords(R, { type: 'NAT' })), 'q03,q06,q09');
  assert.strictEqual(ids(G.filterRecords(R, { branch: 'SYN-BRANCH-2', year: '2020', subject: 'Subj-X', topic: 'Topic-1', type: 'MCQ' })), 'q11');
  assert.strictEqual(G.filterRecords(R, {}).length, 12);
});
t('TEST 6 zero-match combination', () => {
  const R = records(); assert.strictEqual(G.filterRecords(R, { branch: 'SYN-BRANCH-1', year: '2019' }).length, 0);
  const s = G.summarise(R, 'custom', { branch: 'SYN-BRANCH-1', year: '2019' }, null);
  assert.strictEqual(s.state, 'no_matches'); assert.strictEqual(s.pool, 0);
  assert.ok(G.blockers(s, 'ready').some(b => /No questions match/.test(b)));
});
t('facet options come from data: values, counts (incl. 0), numeric year order, topic scoped by subject', () => {
  const R = records();
  assert.deepStrictEqual(G.facetOptions(R, {}, 'year'), [{ value: '2021', count: 4 }, { value: '2020', count: 5 }, { value: '2019', count: 3 }]);
  const withBranch = G.facetOptions(R, { branch: 'SYN-BRANCH-1' }, 'year');
  assert.deepStrictEqual(withBranch.find(o => o.value === '2019'), { value: '2019', count: 0 });
  assert.deepStrictEqual(G.facetOptions(R, { subject: 'Subj-Z' }, 'topic').map(o => o.value), ['Topic-4', 'Topic-5']);
  assert.deepStrictEqual(G.facetOptions([], {}, 'branch'), []);
  assert.deepStrictEqual(G.facetOptions(R, { branch: 'GONE' }, 'branch').find(o => o.value === 'GONE'), { value: 'GONE', count: 0 });
});

// ---------- count selection and marks/duration: test cases 7, 8 ----------
t('TEST 7 requested count below / equal / above availability (pool = 4 questions, 6 marks)', () => {
  const R = records(), sel = { branch: 'SYN-BRANCH-1', subject: 'Subj-X' };   // q01..q04 marks 1,2,1,2
  let s = G.summarise(R, 'custom', sel, 2);
  assert.strictEqual(s.n, 2); assert.strictEqual(s.pool, 4); assert.strictEqual(s.exact, false); assert.strictEqual(s.minMarks, 2); assert.strictEqual(s.maxMarks, 4); assert.strictEqual(s.adjusted, false);
  assert.strictEqual(s.minSeconds, durationSeconds(2)); assert.strictEqual(s.maxSeconds, durationSeconds(4));
  s = G.summarise(R, 'custom', sel, 4); assert.strictEqual(s.n, 4); assert.strictEqual(s.exact, true); assert.strictEqual(s.minMarks, 6); assert.strictEqual(s.minSeconds, 997);
  s = G.summarise(R, 'custom', sel, 9); assert.strictEqual(s.n, 4); assert.strictEqual(s.adjusted, true); assert.strictEqual(s.minMarks, 6);
  s = G.summarise(R, 'custom', sel, null); assert.strictEqual(s.n, 4);
  s = G.summarise(R, 'custom', sel, 1); assert.deepStrictEqual([s.minMarks, s.maxMarks], [1, 2]);
  for (const bad of [0, -1, NaN, 2.5, Infinity, '3']) assert.strictEqual(G.summarise(R, 'custom', sel, bad).state, 'bad_count', String(bad));
});
t('subset is flagged as undecided policy; full selection is not', () => {
  const R = records(), sel = { branch: 'SYN-BRANCH-1', subject: 'Subj-X' };
  assert.ok(G.blockers(G.summarise(R, 'custom', sel, 2), 'ready').some(b => /subset is drawn/.test(b)));
  assert.ok(!G.blockers(G.summarise(R, 'custom', sel, 4), 'ready').some(b => /subset is drawn/.test(b)));
});
t('TEST 8 totals: marks, per-type breakdown, hand-checked duration', () => {
  const R = records(), s = G.summarise(R, 'custom', { branch: 'SYN-BRANCH-1' }, null);
  assert.strictEqual(s.n, 6); assert.strictEqual(s.minMarks, 9); assert.strictEqual(s.maxMarks, 9);
  assert.deepStrictEqual(s.selectedBreakdown, { MCQ: { count: 3, marks: 4 }, MSQ: { count: 1, marks: 2 }, NAT: { count: 2, marks: 3 } });
  assert.strictEqual(s.minSeconds, 1495);   // 9 x 10800 / 65 = 1495.38 -> 1495 s = 24 min 55 s
  assert.strictEqual(formatDuration(s.minSeconds), '0 h 24 min 55 s');
  const all = G.summarise(R, 'custom', {}, null); assert.strictEqual(all.minMarks, 18);
});
t('TEST 8b a 65-mark selection is exactly 3 hours', () => {
  const qs = []; for (let i = 0; i < 45; i++) qs.push({ id: 'g' + i, branch: 'B', year: 2020, subject: 'S', topic: 'T', type: 'NAT', marks: i < 25 ? 1 : 2, text: 't', source: { name: 'SYNTHETIC TEST FIXTURE' } });
  const cat = G.prepareCatalogue({ schema_version: 1, questions: qs }); assert.strictEqual(cat.records.length, 45);
  const s = G.summarise(cat.records, 'custom', {}, null);
  assert.strictEqual(s.minMarks, 65); assert.strictEqual(s.minSeconds, 10800); assert.strictEqual(formatDuration(s.minSeconds), '3 h 00 min 00 s');
});
t('modes: required filters, awaiting configuration, hidden filters ignored', () => {
  const R = records();
  let s = G.summarise(R, 'year', { branch: 'SYN-BRANCH-1' }, null); assert.strictEqual(s.state, 'incomplete'); assert.deepStrictEqual(s.missing, ['year']);
  s = G.summarise(R, 'year', { branch: 'SYN-BRANCH-1', year: '2021', subject: 'Nope' }, null); assert.strictEqual(s.pool, 3); assert.deepStrictEqual(s.active, { branch: 'SYN-BRANCH-1', year: '2021' });
  s = G.summarise(R, 'subject', { subject: 'Subj-Y' }, null); assert.strictEqual(s.pool, 3);
  s = G.summarise(R, 'topic', { subject: 'Subj-Z' }, null); assert.deepStrictEqual(s.missing, ['topic']);
  s = G.summarise(R, 'full', { branch: 'SYN-BRANCH-1' }, null); assert.strictEqual(s.state, 'awaiting_config'); assert.strictEqual(s.n, 0);
  assert.ok(G.blockers(s, 'ready').some(b => /awaiting configuration/.test(b)));
});
t('a test can NEVER start today: blockers always name marking rules and the missing exam engine', () => {
  const R = records();
  for (const m of G.MODE_ORDER) { const b = G.blockers(G.summarise(R, m, { branch: 'SYN-BRANCH-1', year: '2021', subject: 'Subj-X', topic: 'Topic-1' }, null), 'ready');
    assert.ok(b.some(x => /Marking rules/.test(x)), m); assert.ok(b.some(x => /not built yet/.test(x)), m); }
  assert.ok(G.blockers({ state: 'ok', exact: true, missing: [] }, 'missing').some(b => /No usable question bank/.test(b)));
});

(async () => {
  for (const [name, fn] of queue) { await fn(); n++; console.log('ok -', name); }
  console.log(`\n${n} unit tests passed`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
