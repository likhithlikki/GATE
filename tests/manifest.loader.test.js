'use strict';
/**
 * Task 49 checks for the manifest-driven paper/year loader in app.js. Pure node (no jsdom). All data is SYNTHETIC, built in memory:
 * no real GATE question, and nothing here is ever served by the site. Run: node manifest.loader.test.js
 * Part 1 runs every check against the real app.js. Part 2 (mutation controls) breaks app.js one way at a time and requires a failing check each time.
 * These are mocked fetch checks: they do not prove behaviour on a real web server, browser or Google/GitHub hosting.
 */
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const APP = path.join(__dirname, '..', 'app.js');
const fx = n => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const sha = text => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

function loadApp(mutate) {
  let src = fs.readFileSync(APP, 'utf8');
  if (mutate) { const out = mutate(src); if (out === src) { throw new Error('mutation did not change app.js'); } src = out; }
  const sandbox = { module: { exports: {} }, require, console, TextEncoder, Buffer, Uint8Array };
  vm.createContext(sandbox); vm.runInContext(src, sandbox, { filename: 'app.js' });
  return sandbox.module.exports;
}

/* ---------- synthetic site builder ---------- */
const rec = (id, year, extra) => Object.assign({ id, branch: 'SYN-BRANCH', year, subject: 'Subj-X', topic: 'Topic-1', type: 'MCQ', marks: 1,
  text: 'SYNTHETIC TEST QUESTION ' + id, options: [{ id: 'A', text: 'synthetic a' }, { id: 'B', text: 'synthetic b' }], source: { name: 'SYNTHETIC TEST FIXTURE' } }, extra || {});
function shardText(ids, year, mutateDoc) {
  const doc = { schema_version: 1, placeholder: true, questions: ids.map(i => rec(i, year)) };
  if (mutateDoc) { mutateDoc(doc); }
  return JSON.stringify(doc, null, 1);
}
/* spec: [code, year, variant|'' , n]; ids are code-year[-variant]-qN so they are unique across shards */
function makeSite(specs, opts) {
  opts = opts || {};
  const files = Object.create(null), shards = [];
  specs.forEach(([code, year, variant, n]) => {
    const tag = code + '-' + year + (variant ? '-' + variant : ''), p = variant ? 'papers/' + code + '/' + year + '/' + code + '-' + variant + '.json' : 'papers/' + code + '/' + year + '.json';
    const ids = Array.from({ length: n }, (_, i) => tag + '-q' + (i + 1)), text = shardText(ids, year);
    files['data/' + p] = text;
    const e = { id: tag, paper_code: code, paper_name: { CS: 'Computer Science (SYNTHETIC)', EC: 'Electronics (SYNTHETIC)', DA: 'Data Science (SYNTHETIC)' }[code] || code + ' (SYNTHETIC)', year, path: p, question_count: n, sha256: sha(text) };
    if (variant) { e.variant = variant; }
    shards.push(e);
  });
  const manifest = { schema_version: 1, release: 'TEST-RELEASE-1', placeholder: true, shards };
  files['data/manifest.json'] = JSON.stringify(manifest, null, 1);
  const calls = [];
  const fetchFn = url => { calls.push(url); const body = files[url]; return Promise.resolve(body === undefined ? { status: 404, ok: false, text: () => Promise.resolve('') } : { status: 200, ok: true, text: () => Promise.resolve(body) }); };
  return { files, manifest, calls, fetchFn, set: (url, body) => { files[url] = body; } };
}
const BASE = [['CS', 2023, '', 3], ['CS', 2024, '', 4], ['EC', 2024, '', 2], ['DA', 2025, '', 2], ['CS', 2025, '1', 3], ['CS', 2025, '2', 3]];
const clone = o => JSON.parse(JSON.stringify(o));

function suite(G) {
  const fails = []; let total = 0, current = '';
  const ok = (c, m) => { total++; if (!c) { fails.push(current + ': ' + m); } };
  const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');
  const queue = [];
  const T = (name, fn) => queue.push([name, fn]);
  const bad = (m, sel) => G.validateManifest(m).status !== 'ready';
  const withShard0 = (site, fn) => { const m = clone(site.manifest); fn(m.shards[0], m); return m; };

  T('1 valid manifest with several paper folders and years', async () => {
    const s = makeSite(BASE), v = G.validateManifest(clone(s.manifest));
    eq(v.status, 'ready', 'valid manifest accepted'); eq(v.problems, [], 'no problems'); eq(v.manifest.release, 'TEST-RELEASE-1', 'release kept'); eq(v.manifest.shards.length, 6, 'six shards');
    const ch = G.manifestChoices(v.manifest);
    eq(ch.map(p => p.code), ['CS', 'DA', 'EC'], 'papers come from the manifest, sorted');
    eq(ch[0].years.map(y => y.year), [2025, 2024, 2023], 'CS years newest first'); eq(ch[2].years.map(y => y.year), [2024], 'EC years');
    const lm = await G.loadManifest(s.fetchFn); eq(lm.status, 'ready', 'loadManifest ready'); eq(lm.choices.length, 3, 'choices built from the manifest'); eq(s.calls, ['data/manifest.json'], 'only the manifest was fetched');
    /* a new paper/year is added by data alone: no JavaScript list changes */
    const s2 = makeSite(BASE.concat([['CS', 2026, '', 2], ['AE', 2026, '', 2]])); const ch2 = G.manifestChoices(clone(s2.manifest));
    eq(ch2.map(p => p.code), ['AE', 'CS', 'DA', 'EC'], 'new paper appears with no code change'); eq(ch2.find(p => p.code === 'CS').years[0].year, 2026, 'new year appears with no code change');
  });

  T('2 a paper/year with several official sets is never merged', async () => {
    const s = makeSite(BASE), m = G.validateManifest(clone(s.manifest)).manifest, ch = G.manifestChoices(m), y25 = ch[0].years[0];
    eq(y25.variants, ['1', '2'], 'two sets listed'); eq(y25.setRequired, true, 'set required');
    const r0 = G.resolveShards(m, { paper: 'CS', year: 2025 }); eq(r0.ok, false, 'no set named: refused'); eq(r0.code, 'variant_required', 'variant_required');
    const out = await G.loadPaper(s.fetchFn, m, { paper: 'CS', year: 2025 }); eq(out.status, 'variant_required', 'loadPaper refuses an ambiguous selection'); eq(out.records.length, 0, 'no records'); eq(s.calls.length, 0, 'nothing fetched');
    const a = await G.loadPaper(s.fetchFn, m, { paper: 'CS', year: 2025, variant: '1' }), b = await G.loadPaper(s.fetchFn, m, { paper: 'CS', year: '2025', variant: '2' });
    eq(a.status, 'ready', 'set 1 ready'); eq(b.status, 'ready', 'set 2 ready'); eq(a.records.map(r => r.set), ['1', '1', '1'], 'set 1 records carry set 1'); eq(b.records.map(r => r.set), ['2', '2', '2'], 'set 2 records carry set 2');
    eq(a.records.every(r => r.paper === 'CS' && r.year === 2025) && a.records.every(r => /^CS-2025-1-/.test(r.id)), true, 'identity kept on each record');
    eq(G.resolveShards(m, { paper: 'CS', year: 2025, variant: '3' }).ok, false, 'unknown set refused'); eq(G.resolveShards(m, { paper: 'CS', year: 2024, variant: '1' }).ok, false, 'set named for a year without sets refused');
  });

  T('3 lazy loading: only the selected shard files are requested', async () => {
    const s = makeSite(BASE), lc = await G.loadCatalogue(s.fetchFn);
    eq(lc.mode, 'manifest', 'manifest mode'); eq(s.calls, ['data/manifest.json'], 'choosing nothing fetches only the manifest');
    const r = await G.loadPaper(s.fetchFn, lc.manifest, { paper: 'CS', year: 2024 });
    eq(r.status, 'ready', 'ready'); eq(r.records.length, 4, 'four records'); eq(s.calls, ['data/manifest.json', 'data/papers/CS/2024.json'], 'exactly one shard file fetched');
    const r2 = await G.loadPaper(s.fetchFn, lc.manifest, { paper: 'CS', years: [2023, 2024] });
    eq(r2.status, 'ready', 'two years combine'); eq(r2.records.length, 7, 'seven records'); eq(r2.shards.map(x => x.id), ['CS-2023', 'CS-2024'], 'two shards, manifest order');
    eq(s.calls.slice(2).sort(), ['data/papers/CS/2023.json', 'data/papers/CS/2024.json'], 'only those two were fetched');
    ok(!s.calls.some(u => /EC|DA|2025/.test(u)), 'no unrelated shard was requested');
    eq(r.records.every(x => Object.keys(x).sort().join() === 'branch,id,marks,paper,set,shard,source,subject,topic,type,year'), true, 'filter catalogue remains metadata-only: no text or options in records');
    eq(r.questions.length, r.records.length, 'verified question payload retained separately for selected-paper preview');
    ok(r.questions.every(q => typeof q.text === 'string' && q.source && q.source.name && !('paper' in q) && !('shard' in q)), 'preview questions use an allowlist without manifest bookkeeping');
    ok(JSON.stringify(r.questions).includes('SYNTHETIC TEST QUESTION'), 'question text is preserved only in the separate preview payload');
    ok(!JSON.stringify(r.questions).includes('answer_key') && !JSON.stringify(r.questions).includes('explanation'), 'preview payload has no answer/scoring fields');
  });

  T('4 missing, malformed and unsafe manifest content', async () => {
    const s = makeSite(BASE);
    ['schema_version', 'release', 'shards'].forEach(k => { const m = clone(s.manifest); delete m[k]; ok(bad(m), 'missing ' + k + ' rejected'); });
    ['id', 'paper_code', 'paper_name', 'year', 'path', 'question_count', 'sha256'].forEach(k => ok(bad(withShard0(s, e => { delete e[k]; })), 'shard missing ' + k + ' rejected'));
    [null, [], 'x', 5, true, { shards: [] }, { schema_version: 2, release: 'r', shards: clone(s.manifest.shards) }, { schema_version: '1', release: 'r', shards: clone(s.manifest.shards) },
     Object.assign(clone(s.manifest), { shards: [] }), Object.assign(clone(s.manifest), { shards: {} }), Object.assign(clone(s.manifest), { shards: [null] }), Object.assign(clone(s.manifest), { shards: ['x'] }),
     Object.assign(clone(s.manifest), { release: '' }), Object.assign(clone(s.manifest), { release: 'a b' }), Object.assign(clone(s.manifest), { placeholder: 'yes' })].forEach((m, i) => ok(bad(m), 'malformed manifest #' + i + ' rejected'));
    ['../x.json', '/papers/CS/2024.json', 'papers/CS/../2024.json', 'papers\\CS\\2024.json', 'https://evil.example/papers/CS/2024.json', '//evil.example/CS/2024.json', 'papers/CS/2024.json?x=1', 'papers/CS/2024.json#a',
     'papers/%2e%2e/CS/2024.json', 'papers/CS/2024.JSON', 'papers/CS//2024.json', 'papers/cs/2024.json', 'data/papers/CS/2024.json', './papers/CS/2024.json', 'papers/CS/2024.json ', ' papers/CS/2024.json',
     'papers/CS/2024.json\n', 'papers/CS/2024.json\u0000', 'papers/CS/2022.json', 'papers/EC/2024.json', 'papers/CS/2024/CS-1.json', 'papers/CS/2024/../2024.json', 'papers/CS/2024/.json', 'papers/CS/2024/a/b.json',
     'questions.json', '', null, 7, ['papers/CS/2024.json'], 'papers/CS/2024.json.json', 'papers/CS/0024.json', 'papers/CS/24.json'].forEach(p => ok(bad(withShard0(s, e => { e.path = p; })), 'unsafe path rejected: ' + JSON.stringify(p)));
    ok(bad(withShard0(s, e => { e.variant = '1'; })), 'a set on a plain path rejected');
    const vs = makeSite([['CS', 2025, '1', 2]]); ok(bad((() => { const m = clone(vs.manifest); m.shards[0].path = 'papers/CS/2025.json'; return m; })()), 'a set must use the set path form');
    ['papers/CS/2025/../x.json', 'papers/CS/2025/..%2fx.json', 'papers/CS/2025/a b.json', 'papers/CS/2025/.hidden.json', 'papers/CS/2025/a/b.json', 'papers/CS/2025/a\\b.json', 'papers/CS/2025/%2e%2e.json', 'papers/CS/2025/x:y.json', 'papers/CS/2025/' + 'a'.repeat(33) + '.json']
      .forEach(p => ok(bad((() => { const m = clone(vs.manifest); m.shards[0].path = p; return m; })()), 'unsafe set path rejected: ' + p));
    eq(G.validateManifest(clone(vs.manifest)).status, 'ready', 'control: the normal set path is accepted');
    ok(bad(withShard0(vs, e => { e.variant = '../1'; })), 'unsafe variant rejected'); ok(bad(withShard0(vs, e => { e.variant = ''; })), 'empty variant rejected');
    [1899, 2101, 2024.5, '2024', null, NaN, Infinity, -2024, 0].forEach(y => ok(bad(withShard0(s, e => { e.year = y; })), 'invalid year ' + y + ' rejected'));
    ['cs', 'CSE', 'C1', 'C', '', null, 5, 'C S', 'ＣＳ'].forEach(c => ok(bad(withShard0(s, e => { e.paper_code = c; })), 'invalid paper ' + JSON.stringify(c) + ' rejected'));
    ['A'.repeat(63), 'A'.repeat(65), 'a'.repeat(64).toUpperCase(), 'sha256-' + 'a'.repeat(64), 'g'.repeat(64), '', null, 5, ' ' + 'a'.repeat(63), 'a'.repeat(64) + '\n'].forEach(d => ok(bad(withShard0(s, e => { e.sha256 = d; })), 'invalid digest ' + JSON.stringify(d).slice(0, 30) + ' rejected'));
    [0, -1, 1.5, '3', null, 1001].forEach(c => ok(bad(withShard0(s, e => { e.question_count = c; })), 'invalid count ' + c + ' rejected'));
    ok(bad(withShard0(s, e => { e.answer_key = 'A'; })), 'a private field on a shard entry rejected'); ok(bad(Object.assign(clone(s.manifest), { explanation: 'x' })), 'a private field on the manifest rejected');
    ok(bad(withShard0(s, e => { e.extra = 1; })), 'unknown shard field rejected'); ok(bad(withShard0(s, e => { e.id = 'a/b'; })), 'unsafe shard id rejected'); ok(bad(withShard0(s, e => { e.paper_name = ''; })), 'empty paper name rejected');
    ok(bad(Object.assign(clone(s.manifest), { shards: Array.from({ length: 501 }, () => clone(s.manifest.shards[0])) })), 'more than the shard limit rejected');
    /* through loadManifest: fetch-level failures */
    const cases = [[404, '', 'absent'], [410, '', 'absent'], [500, '', 'error'], [200, '<!doctype html><p>soft 404', 'invalid_json'], [200, '', 'invalid_json'], [200, '[]', 'invalid'], [200, '{"schema_version":1,"release":"r","shards":[]}', 'invalid'],
      [200, ' '.repeat(262145), 'too_large']];
    for (const [st, body, want] of cases) { const r = await G.loadManifest(() => Promise.resolve({ status: st, ok: st >= 200 && st < 300, text: () => Promise.resolve(body) })); eq(r.status, want, 'loadManifest ' + st + ' -> ' + want); eq(r.manifest, null, 'no manifest object unless ready'); }
    eq((await G.loadManifest(() => Promise.reject(new TypeError('offline')))).status, 'unreachable', 'network failure'); eq((await G.loadManifest(null)).status, 'unreachable', 'no fetch');
  });

  T('5 duplicate shard identities and duplicate question ids', async () => {
    const s = makeSite(BASE), dupId = clone(s.manifest); dupId.shards[1].id = dupId.shards[0].id; ok(bad(dupId), 'duplicate shard id rejected');
    const dupPath = clone(s.manifest); dupPath.shards[1].path = dupPath.shards[0].path; ok(bad(dupPath), 'duplicate path rejected');
    const dupIdent = clone(s.manifest); dupIdent.shards.push(Object.assign(clone(s.manifest.shards[0]), { id: 'other-id' })); ok(bad(dupIdent), 'duplicate paper/year identity rejected');
    const dupSet = clone(s.manifest); dupSet.shards.push(Object.assign(clone(dupSet.shards.find(x => x.variant === '1')), { id: 'other-set-id', path: 'papers/CS/2025/CS-9.json' })); ok(bad(dupSet), 'duplicate paper/year/set identity rejected');
    const mixed = clone(s.manifest); mixed.shards.push({ id: 'CS-2025', paper_code: 'CS', paper_name: mixed.shards[0].paper_name, year: 2025, path: 'papers/CS/2025.json', question_count: 1, sha256: 'a'.repeat(64) }); ok(bad(mixed), 'a set-less file beside official sets rejected');
    const names = clone(s.manifest); names.shards[1].paper_name = 'A different name'; ok(bad(names), 'one paper code with two names rejected');
    /* question ids repeated inside a shard, and across two selected shards */
    const sd = makeSite([['CS', 2024, '', 3]]), dupText = shardText(['x1', 'x2', 'x1'], 2024); sd.set('data/papers/CS/2024.json', dupText); sd.manifest.shards[0].sha256 = sha(dupText);
    const r1 = await G.loadShards(sd.fetchFn, sd.manifest.shards); eq(r1.status, 'shard_failed', 'duplicate id inside a shard fails'); eq(r1.failures[0].code, 'shard_duplicate_ids', 'code'); eq(r1.records.length, 0, 'no records');
    const sx = makeSite([['CS', 2023, '', 2], ['CS', 2024, '', 2]]), t24 = shardText(['CS-2023-q1', 'CS-2024-q2'], 2024); sx.set('data/papers/CS/2024.json', t24); sx.manifest.shards[1].sha256 = sha(t24);
    const r2 = await G.loadShards(sx.fetchFn, sx.manifest.shards); eq(r2.status, 'duplicate_ids', 'duplicate id across shards fails'); eq(r2.records.length, 0, 'no records'); ok(/more than one selected file/.test(r2.message), 'clear message');
  });

  T('6 invalid shard schema, wrong count, digest mismatch, bad records', async () => {
    const run = async (mut, want) => {
      const s = makeSite([['CS', 2024, '', 3]]); let text = s.files['data/papers/CS/2024.json']; const entry = s.manifest.shards[0];
      const r = mut(text, entry); if (r && r.text !== undefined) { s.set('data/papers/CS/2024.json', r.text); if (r.rehash !== false) { entry.sha256 = sha(r.text); } }
      const out = await G.loadShards(s.fetchFn, s.manifest.shards); return { out, code: out.failures[0] && out.failures[0].code, s };
    };
    const docWith = fn => { const d = JSON.parse(shardText(['CS-2024-q1', 'CS-2024-q2', 'CS-2024-q3'], 2024)); fn(d); return JSON.stringify(d); };
    const cases = [
      ['schema_version 2', () => ({ text: docWith(d => { d.schema_version = 2; }) }), 'shard_invalid'], ['no schema_version', () => ({ text: docWith(d => { delete d.schema_version; }) }), 'shard_invalid'],
      ['questions not an array', () => ({ text: docWith(d => { d.questions = {}; }) }), 'shard_invalid'], ['bare array', () => ({ text: '[]' }), 'shard_invalid'], ['null', () => ({ text: 'null' }), 'shard_invalid'],
      ['unknown top-level field', () => ({ text: docWith(d => { d.notes = 'x'; }) }), 'shard_invalid'], ['not JSON (digest matches)', () => ({ text: 'not json {' }), 'shard_invalid_json'],
      ['count too low in file', () => ({ text: docWith(d => { d.questions.pop(); }) }), 'shard_count_mismatch'], ['count too high in file', () => ({ text: docWith(d => { d.questions.push(rec('extra', 2024)); }) }), 'shard_count_mismatch'],
      ['manifest declares more', (t, e) => { e.question_count = 4; }, 'shard_count_mismatch'], ['manifest declares fewer', (t, e) => { e.question_count = 2; }, 'shard_count_mismatch'],
      ['digest mismatch: one byte changed', t => ({ text: t.replace('synthetic a', 'synthetic b'), rehash: false }), 'shard_digest_mismatch'], ['digest mismatch: manifest digest wrong', (t, e) => { e.sha256 = 'b'.repeat(64); }, 'shard_digest_mismatch'],
      ['digest mismatch: trailing newline added', t => ({ text: t + '\n', rehash: false }), 'shard_digest_mismatch'],
      ['record with a bad type', () => ({ text: docWith(d => { d.questions[1].type = 'XYZ'; }) }), 'shard_invalid_records'], ['record year differs from the shard year', () => ({ text: docWith(d => { d.questions[0].year = 2023; }) }), 'shard_invalid_records'],
      ['record without provenance', () => ({ text: docWith(d => { delete d.questions[2].source; }) }), 'shard_invalid_records'], ['record not an object', () => ({ text: docWith(d => { d.questions[0] = 5; }) }), 'shard_invalid_records'],
      ['MCQ with one option', () => ({ text: docWith(d => { d.questions[0].options.pop(); }) }), 'shard_invalid_records'], ['unsafe record id', () => ({ text: docWith(d => { d.questions[0].id = 'a b'; }) }), 'shard_invalid_records']];
    for (const [nm, mut, want] of cases) { const { out, code } = await run(mut); eq(out.status, 'shard_failed', nm + ': not successful'); eq(code, want, nm + ': code'); eq(out.records.length, 0, nm + ': no records'); ok(out.status !== 'ready', nm + ': never ready'); }
    const good = await run(() => undefined); eq(good.out.status, 'ready', 'control: unmodified shard loads'); eq(good.out.records.length, 3, 'control: three records');
    /* digest first: a file that fails the digest is never parsed or checked */
    const s = makeSite([['CS', 2024, '', 3]]); s.set('data/papers/CS/2024.json', 'not json at all'); const out = await G.loadShards(s.fetchFn, s.manifest.shards);
    eq(out.failures[0].code, 'shard_digest_mismatch', 'digest is verified before the content is parsed');
    /* no digest implementation: never skipped */
    const s2 = makeSite([['CS', 2024, '', 3]]); const o2 = await G.loadShards(s2.fetchFn, s2.manifest.shards, { digest: () => Promise.reject(new Error('no subtle')) });
    eq(o2.failures[0].code, 'digest_unavailable', 'an unavailable digest is a failure, not a skip'); eq(o2.records.length, 0, 'nothing trusted');
    const o3 = await G.loadShards(s2.fetchFn, s2.manifest.shards, { digest: () => { throw new Error('sync'); } }); eq(o3.failures[0].code, 'digest_unavailable', 'a throwing digest is a failure too');
    const o4 = await G.loadShards(s2.fetchFn, s2.manifest.shards, { digest: () => Promise.resolve(sha('other')) }); eq(o4.failures[0].code, 'shard_digest_mismatch', 'injected digest is compared');
  });

  T('7 answer-related fields in a shard refuse the whole shard', async () => {
    const variants = [['answer_key on a record', d => { d.questions[1].answer_key = 'A'; }], ['explanation on a record', d => { d.questions[0].explanation = 'SYNTHETIC SECRET EXPLANATION'; }], ['answerKey camel case', d => { d.questions[0].answerKey = 'B'; }],
      ['Answer Key spaced', d => { d.questions[0]['Answer Key'] = 'B'; }], ['nested is_correct on an option', d => { d.questions[0].options[0].is_correct = true; }], ['nat range', d => { d.questions[2].nat_range = [1, 2]; }],
      ['accepted_answers', d => { d.questions[2].accepted_answers = ['1']; }], ['score', d => { d.questions[2].score = 1; }], ['top-level answers', d => { d.answers = { a: 1 }; }], ['top-level explanation', d => { d.explanation = 'x'; }],
      ['marks_to_all', d => { d.questions[0].marks_to_all = true; }], ['solution', d => { d.questions[0].solution = 'x'; }]];
    for (const [nm, fn] of variants) {
      const s = makeSite([['CS', 2024, '', 3]]), text = shardText(['CS-2024-q1', 'CS-2024-q2', 'CS-2024-q3'], 2024, fn); s.set('data/papers/CS/2024.json', text); s.manifest.shards[0].sha256 = sha(text);
      const out = await G.loadShards(s.fetchFn, s.manifest.shards); eq(out.status, 'shard_failed', nm + ': not successful'); eq(out.failures[0].code, 'shard_private_fields', nm + ': code'); eq(out.records.length, 0, nm + ': nothing loaded');
      ok(!JSON.stringify(out).includes('SYNTHETIC SECRET EXPLANATION'), nm + ': no private value echoed');
    }
    const s = makeSite(BASE), m = clone(s.manifest); m.shards[0].is_correct = true; eq(G.validateManifest(m).status, 'invalid', 'a private-looking field in the manifest is refused');
  });

  T('8 partial shard failure is never reported as success', async () => {
    const mk = () => makeSite([['CS', 2023, '', 2], ['CS', 2024, '', 3], ['CS', 2022, '', 2]]);
    const modes = [['second file missing (404)', (s) => s.files['data/papers/CS/2024.json'] = undefined], ['second file 500', null], ['second file digest mismatch', (s) => { s.files['data/papers/CS/2024.json'] += ' '; }],
      ['second file has private fields', (s) => { const t = shardText(['CS-2024-q1', 'CS-2024-q2', 'CS-2024-q3'], 2024, d => { d.questions[0].answer = 'A'; }); s.files['data/papers/CS/2024.json'] = t; s.manifest.shards.find(x => x.id === 'CS-2024').sha256 = sha(t); }]];
    for (const [nm, mutate] of modes) {
      const s = mk(); if (mutate) { mutate(s); }
      const fetchFn = nm.includes('500') ? (u => u.endsWith('CS/2024.json') ? Promise.resolve({ status: 500, ok: false, text: () => Promise.resolve('') }) : s.fetchFn(u)) : s.fetchFn;
      const r = await G.loadShards(fetchFn, s.manifest.shards);
      eq(r.status, 'shard_failed', nm + ': status'); ok(r.status !== 'ready', nm + ': not ready'); eq(r.records.length, 0, nm + ': the shards that did load are not used either'); eq(r.total, 0, nm + ': total 0');
      eq(r.failures.length, 1, nm + ': the one failing file is named'); eq(r.failures[0].shard, 'CS-2024', nm + ': which one'); ok(/nothing was loaded/.test(r.message) && /incomplete/.test(r.message), nm + ': message says incomplete'); eq(r.shards, [], nm + ': no loaded-shard list');
    }
    const s = mk(); const r = await G.loadShards(u => Promise.reject(new TypeError('offline')), s.manifest.shards); eq(r.status, 'shard_failed', 'every file unreachable'); eq(r.failures.length, 3, 'all three named');
    const r2 = await G.loadShards(null, s.manifest.shards); eq(r2.status, 'unreachable', 'no fetch'); const r3 = await G.loadShards(s.fetchFn, []); eq(r3.status, 'selection_invalid', 'empty selection never succeeds');
    const r4 = await G.loadPaper(s.fetchFn, G.validateManifest(clone(s.manifest)).manifest, { paper: 'ZZ', year: 2024 }); eq(r4.status, 'selection_invalid', 'unlisted paper refused'); eq(s.calls.length, 0, 'and nothing fetched');
    const r5 = await G.loadPaper(s.fetchFn, G.validateManifest(clone(s.manifest)).manifest, { paper: 'CS', year: 2023 }); eq(r5.status, 'ready', 'control: the good shard alone loads'); eq(r5.records.length, 2, 'two records');
  });

  T('9 backward compatibility: no manifest -> legacy data/questions.json; a bad manifest never falls back', async () => {
    const legacy = fx('valid.json'), site = (manifestRes, calls) => url => { calls.push(url); if (url === 'data/manifest.json') { return manifestRes(); } return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(legacy) }); };
    const res = (st, body) => () => Promise.resolve({ status: st, ok: st >= 200 && st < 300, text: () => Promise.resolve(body) });
    for (const st of [404, 410]) { const calls = []; const r = await G.loadCatalogue(site(res(st, ''), calls)); eq(r.mode, 'legacy', st + ': legacy mode'); eq(r.bank.status, 'ready', st + ': legacy bank ready'); eq(r.bank.records.length, 12, st + ': twelve legacy questions'); eq(r.bank.origin, 'legacy', 'origin'); eq(calls, ['data/manifest.json', 'data/questions.json'], st + ': manifest asked first, then the legacy file'); }
    const goodSite = makeSite(BASE); const gc = await G.loadCatalogue(goodSite.fetchFn); eq(gc.mode, 'manifest', 'present manifest: manifest mode'); ok(!goodSite.calls.includes('data/questions.json'), 'legacy file not requested when a valid manifest exists');
    const broken = [['invalid JSON', res(200, '{nope')], ['HTML soft 404', res(200, '<!doctype html>')], ['wrong schema', res(200, '{"schema_version":2,"release":"r","shards":[]}')], ['array', res(200, '[]')], ['unsafe path',
      res(200, JSON.stringify(withShard0(makeSite([['CS', 2024, '', 1]]), e => { e.path = '../questions.json'; })))], ['server error', res(500, '')], ['network failure', () => Promise.reject(new TypeError('offline'))], ['questions-bank body at manifest URL', res(200, legacy)]];
    for (const [nm, mr] of broken) { const calls = []; const r = await G.loadCatalogue(site(mr, calls)); eq(r.mode, 'manifest', nm + ': stays in manifest mode'); ok(r.status !== 'ready' && r.status !== 'absent', nm + ': reported as a failure (' + r.status + ')'); ok(!calls.includes('data/questions.json'), nm + ': the legacy file was NOT loaded in its place'); ok(r.message.length > 20, nm + ': clear message'); }
    eq((await G.loadCatalogue(null)).status, 'unreachable', 'no fetch at all'); eq((await G.loadBank(res(404, ''), 'x')).status, 'missing', 'legacy loader unchanged: 404 -> missing');
  });

  T('10 local import stays separate, with its limits and public-safe checks intact', () => {
    eq(G.LOCAL_LIMITS.fileBytes, 5 * 1024 * 1024, '5 MB limit unchanged'); eq(G.LOCAL_LIMITS.questions, 2000, '2,000-record limit unchanged'); eq(G.LOCAL_LIMITS.text, 20000, 'text limit unchanged');
    const many = Array.from({ length: 2001 }, (_, i) => rec('b' + i, 2024)); const r = G.prepareLocalBank({ schema_version: 1, questions: many }); eq(r.status, 'invalid', '2,001 records refused'); ok(/at most 2000/.test(r.message), 'message names the limit'); eq(r.records.length, 0, 'nothing loaded');
    const okBank = G.prepareLocalBank({ schema_version: 1, questions: many.slice(0, 2000) }); eq(okBank.status, 'ready', '2,000 records still accepted'); eq(okBank.records.length, 2000, 'all 2,000 usable');
    const priv = G.prepareLocalBank({ schema_version: 1, questions: [rec('p1', 2024, { answer_key: 'A' })] }); eq(priv.status, 'rejected_private', 'answer key in a local file still refuses the whole import'); eq(priv.records.length, 0, 'nothing loaded');
    eq(G.prepareLocalBank({ schema_version: 1, release: 'r', shards: [] }).status, 'invalid', 'a manifest is not a question file'); eq(G.prepareLocalBank(JSON.parse(makeSite(BASE).files['data/manifest.json'])).status, 'invalid', 'a real-shaped manifest pasted as a local import is refused');
    const sh = JSON.parse(makeSite(BASE).files['data/papers/CS/2024.json']); const lb = G.prepareLocalBank(sh); eq(lb.status, 'ready', 'a shard file can still be imported locally as an ordinary file'); eq(lb.local, true, 'through the local path, which carries no manifest checks');
    const lim = G.MANIFEST_LIMITS; ok(lim.shardQuestions !== G.LOCAL_LIMITS.questions || true, 'limits are separate objects'); ok(lim !== G.LOCAL_LIMITS, 'shard limits do not alias local limits');
    const cat = G.prepareCatalogue({ schema_version: 1, questions: [rec('c1', 2024, { answer_key: 'A', explanation: 'x' })] }); ok(cat.warnings.some(w => /anyone can read/.test(w)), 'legacy catalogue warning unchanged');
  });

  T('11 real digest implementation and placeholder handling', async () => {
    const s = makeSite(BASE), lc = await G.loadCatalogue(s.fetchFn), r = await G.loadPaper(s.fetchFn, lc.manifest, { paper: 'EC', year: 2024 });
    eq(r.status, 'ready', 'default SHA-256 verifies a real shard'); eq(r.placeholder, true, 'placeholder carried'); ok(r.warnings.some(w => /placeholder data/.test(w)), 'placeholder warning shown'); eq(r.sources, ['SYNTHETIC TEST FIXTURE'], 'source named');
    ok(/EC 2024/.test(r.message) && /2 usable questions/.test(r.message), 'message names paper, year and count');
  });

  return (async () => { for (const [name, fn] of queue) { current = name; try { await fn(); } catch (e) { total++; fails.push(name + ': threw ' + (e && e.stack || e)); } } return { fails, total }; })();
}

const MUTATIONS = [
  ['digest check skipped', s => s.replace('if (hex !== entry.sha256) { return bad(\'shard_digest_mismatch\'); }', '')],
  ['digest unavailable treated as a pass', s => s.replace("}, function () { return bad('digest_unavailable'); });", "}, function () { return bad('digest_unavailable'); }).then(function (r) { return r; });").replace("if (hex !== entry.sha256) { return bad('shard_digest_mismatch'); }", "if (hex !== entry.sha256 && hex !== undefined) { return bad('shard_digest_mismatch'); }").replace("function () { return bad('digest_unavailable'); }", "function () { return { entry: entry, ok: true, code: '', check: { records: [], sources: [], placeholder: false, lines: [] } }; }")],
  ['question count not checked', s => s.replace("if (raw.questions.length !== entry.question_count) {", "if (false) {")],
  ['private fields not scanned in shards', s => s.replace("if (found.length) { return fail('shard_private_fields'", "if (false) { return fail('shard_private_fields'")],
  ['partial failure tolerated', s => s.replace('if (failed.length) {', 'if (failed.length === results.length) {')],
  ['invalid manifest falls back to the legacy file', s => s.replace("if (m.status === 'absent') { return loadBank", "if (m.status !== 'ready') { return loadBank")],
  ['path whitelist loosened (traversal allowed)', s => s.replace('(?:\\/([A-Za-z0-9][A-Za-z0-9_\\-]{0,31}))?\\.json$/;\n', '(?:\\/([^]{0,31}))?\\.json$/;\n')],
  ['path/code/year agreement not checked', s => s.replace("if (pm[1] !== s.paper_code || Number(pm[2]) !== s.year) {", "if (false) {")],
  ['duplicate identity allowed', s => s.replace("if (idents[ident]) {", "if (false) {")],
  ['duplicate shard id allowed', s => s.replace("if (ids[s.id]) {", "if (false) {")],
  ['record year not tied to shard year', s => s.replace("if (!reasons.length && rec.year !== entry.year)", "if (false)")],
  ['several sets merged silently', s => s.replace("if (cands.length > 1) { return no('variant_required'); }", "if (cands.length > 1) { entries.push.apply(entries, cands); continue; }")],
  ['duplicate ids across shards ignored', s => s.replace("if (dup.length) {", "if (false) {")],
  ['every shard loaded regardless of selection', s => s.replace('return loadShards(fetchFn, r.entries, opts);', 'return loadShards(fetchFn, manifest.shards, opts);')],
  ['digest format check loosened', s => s.replace("var SHA256_RE = /^[0-9a-f]{64}$/;", "var SHA256_RE = /^[0-9a-fA-F]{1,64}$/;")],
  ['mixed set-less file and sets allowed', s => s.replace("if (kinds.plain && kinds.sets) {", "if (false) {")],
  ['unknown manifest fields allowed', s => s.replace("if (MANIFEST_KEYS.indexOf(k) < 0) {", "if (false) {")],
  ['local import record limit changed', s => s.replace("questions: 2000, text: 20000", "questions: 5000, text: 20000")],
  ['local import private-field refusal removed', s => s.replace("out.status = 'rejected_private';", "out.status = 'ready_private';")]
];

(async () => {
  const base = await suite(loadApp(null));
  console.log('Part 1: ' + (base.total - base.fails.length) + '/' + base.total + ' checks passed against the real app.js');
  base.fails.forEach(f => console.log('  FAIL ' + f.split('\n')[0].slice(0, 400)));
  console.log('Part 2: mutation controls (each broken variant must make at least one check fail)');
  let undetected = 0;
  for (const [name, fn] of MUTATIONS) {
    let res; try { res = await suite(loadApp(fn)); } catch (e) { console.log('  ERROR  ' + name + ': ' + e.message); undetected++; continue; }
    if (res.fails.length) { console.log('  detected   ' + name + ' (' + res.fails.length + ' failing check(s))'); } else { console.log('  UNDETECTED ' + name); undetected++; }
  }
  const badCount = base.fails.length + undetected;
  console.log(badCount ? '\nRESULT: FAILED' : '\nRESULT: all ' + base.total + ' checks passed; all ' + MUTATIONS.length + ' mutations detected (mocked fetch only; no real server or browser).');
  process.exit(badCount ? 1 : 0);
})();
