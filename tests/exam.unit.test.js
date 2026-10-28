// Pure-function tests for the exam-window prototype. Run: node exam.unit.test.js
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const G = require('../app.js'); const X = G.exam;
const queue = []; const t = (name, fn) => queue.push([name, fn]);
const mk = () => X.create([{ id: 'a', type: 'MCQ', options: ['A', 'B', 'C'] }, { id: 'b', type: 'MSQ', options: ['A', 'B', 'C'] },
  { id: 'c', type: 'NAT' }, { id: 'd', type: 'MCQ', options: ['A', 'B'] }]);

t('duration formula is unchanged: round(marks x 10800 / 65)', () => {
  for (let m = 1; m <= 200; m++) assert.strictEqual(G.durationSeconds(m), Math.round(m * 10800 / 65), 'marks ' + m);
  assert.strictEqual(G.durationSeconds(65), 10800);
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8'); assert.ok(src.includes('Math.round(totalMarks * 10800 / 65)'));
});
t('formatClock: zero-padded, clamps negatives, dashes when there is no value', () => {
  assert.strictEqual(X.formatClock(10800), '03:00:00'); assert.strictEqual(X.formatClock(1495), '00:24:55'); assert.strictEqual(X.formatClock(59.9), '00:00:59');
  assert.strictEqual(X.formatClock(0), '00:00:00'); assert.strictEqual(X.formatClock(-5), '00:00:00'); assert.strictEqual(X.formatClock(360000), '100:00:00');
  [null, undefined, NaN, Infinity, '10', {}].forEach(v => assert.strictEqual(X.formatClock(v), '--:--:--'));
});
t('formatClock agrees with the duration formula for 65 marks', () => { assert.strictEqual(X.formatClock(G.durationSeconds(65)), '03:00:00'); });
t('remainingSeconds: rounds up, never negative, null on bad input', () => {
  assert.ok(Object.is(X.remainingSeconds(0, 500), 0), 'no negative zero'); assert.strictEqual(X.remainingSeconds(10000, 0), 10); assert.strictEqual(X.remainingSeconds(10001, 0), 11); assert.strictEqual(X.remainingSeconds(0, 5000), 0);
  assert.strictEqual(X.remainingSeconds(NaN, 0), null); assert.strictEqual(X.remainingSeconds('1', 0), null); assert.strictEqual(X.remainingSeconds(1, undefined), null);
});
t('attempts are never enabled: blockers list is non-empty for every bank status', () => {
  ['ready', 'missing', 'invalid', 'empty', 'unreachable', 'loading', undefined].forEach(s => {
    assert.ok(X.blockers(s).length >= 3, String(s)); assert.strictEqual(X.attemptsEnabled(s), false, String(s));
  });
  assert.ok(X.blockers('ready').some(b => /Marking rules/.test(b))); assert.ok(X.blockers('ready').some(b => /exam engine is not built/.test(b)));
  assert.ok(X.blockers('ready').some(b => /not approved\/enforced by a configured backend yet/.test(b))); assert.ok(!X.blockers('ready').some(b => /question bank/.test(b)));
  assert.ok(X.blockers('missing').some(b => /No usable question bank/.test(b)));
});
t('create: validates ids, types and options; first question counts as visited', () => {
  const ex = mk(); assert.strictEqual(ex.current, 0); assert.deepStrictEqual(X.summary(ex), { total: 4, answered: 0, notAnswered: 1, notVisited: 3, marked: 0, answeredAndMarked: 0 });
  const bad = [null, [{ id: 'x', type: 'XYZ' }], [{ id: 'bad id', type: 'NAT' }], [{ id: 'x', type: 'MCQ' }], [{ id: 'x', type: 'MCQ', options: ['A'] }],
    [{ id: 'x', type: 'MCQ', options: ['A', 'A'] }], [{ id: 'x', type: 'NAT' }, { id: 'x', type: 'NAT' }], [{ id: 'x', type: 'MCQ', options: ['A', ''] }]];
  bad.forEach(b => assert.throws(() => X.create(b), TypeError, JSON.stringify(b)));
  const empty = X.create([]); assert.strictEqual(empty.current, -1); assert.strictEqual(X.next(empty), false); assert.strictEqual(X.prev(empty), false);
  assert.deepStrictEqual(X.summary(empty), { total: 0, answered: 0, notAnswered: 0, notVisited: 0, marked: 0, answeredAndMarked: 0 });
});
t('navigation: bounded, no wrap, marks questions visited', () => {
  const ex = mk(); assert.strictEqual(X.prev(ex), false); assert.strictEqual(X.next(ex), true); assert.strictEqual(ex.current, 1);
  assert.strictEqual(X.goTo(ex, 3), true); assert.strictEqual(X.next(ex), false); assert.strictEqual(ex.current, 3);
  [-1, 4, 1.5, NaN, '2', null].forEach(i => assert.strictEqual(X.goTo(ex, i), false, String(i))); assert.strictEqual(ex.current, 3);
  assert.strictEqual(X.paletteState(ex, 2).status, 'none'); assert.strictEqual(X.paletteState(ex, 3).status, 'unanswered'); assert.strictEqual(X.paletteState(ex, 9), null);
});
t('MCQ answers: valid option only; replacing keeps one answer', () => {
  const ex = mk(); assert.strictEqual(X.setAnswer(ex, 'a', 'B'), true); assert.strictEqual(ex.responses.a, 'B'); assert.strictEqual(X.setAnswer(ex, 'a', 'C'), true); assert.strictEqual(ex.responses.a, 'C');
  ['Z', '', 1, null, ['A']].forEach(v => assert.strictEqual(X.setAnswer(ex, 'a', v), false, String(v))); assert.strictEqual(ex.responses.a, 'C');
  assert.strictEqual(X.setAnswer(ex, 'nope', 'A'), false);
});
t('MSQ answers: list of valid unique options, stored in option order; empty list clears', () => {
  const ex = mk(); assert.strictEqual(X.setAnswer(ex, 'b', ['C', 'A']), true); assert.deepStrictEqual(ex.responses.b, ['A', 'C']); assert.strictEqual(X.hasAnswer(ex, 'b'), true);
  assert.strictEqual(X.setAnswer(ex, 'b', ['A', 'A']), false); assert.strictEqual(X.setAnswer(ex, 'b', ['Z']), false); assert.strictEqual(X.setAnswer(ex, 'b', 'A'), false);
  assert.deepStrictEqual(ex.responses.b, ['A', 'C']); assert.strictEqual(X.setAnswer(ex, 'b', []), true); assert.strictEqual(X.hasAnswer(ex, 'b'), false);
});
t('NAT answers: trimmed text; blank clears; control characters and oversize rejected; no numeric policy imposed', () => {
  const ex = mk(); assert.strictEqual(X.setAnswer(ex, 'c', '  12.5 '), true); assert.strictEqual(ex.responses.c, '12.5');
  assert.strictEqual(X.setAnswer(ex, 'c', '1e3'), true); assert.strictEqual(X.setAnswer(ex, 'c', '   '), true); assert.strictEqual(X.hasAnswer(ex, 'c'), false);
  assert.strictEqual(X.setAnswer(ex, 'c', '1\u0000'), false); assert.strictEqual(X.setAnswer(ex, 'c', 'x'.repeat(65)), false); assert.strictEqual(X.setAnswer(ex, 'c', 5), false);
});
t('clear response removes only the response, keeps mark and visited', () => {
  const ex = mk(); X.setAnswer(ex, 'a', 'A'); X.toggleMark(ex, 'a');
  assert.strictEqual(X.clear(ex, 'a'), true); assert.strictEqual(X.hasAnswer(ex, 'a'), false); assert.strictEqual(ex.marked.a, true); assert.strictEqual(ex.visited.a, true);
  assert.strictEqual(X.clear(ex, 'a'), false); assert.strictEqual(X.clear(ex, 'nope'), false);
});
t('mark for review toggles; marking counts as visited; unknown id -> null', () => {
  const ex = mk(); assert.strictEqual(X.toggleMark(ex, 'd'), true); assert.strictEqual(ex.visited.d, true); assert.strictEqual(X.paletteState(ex, 3).status, 'review');
  assert.strictEqual(X.toggleMark(ex, 'd'), false); assert.strictEqual(X.paletteState(ex, 3).status, 'unanswered'); assert.strictEqual(X.toggleMark(ex, 'nope'), null);
});
t('palette status precedence: review > answered > not answered > not visited; answered+marked is flagged', () => {
  const ex = mk(); X.goTo(ex, 1); X.setAnswer(ex, 'b', ['A']); X.toggleMark(ex, 'b');
  const p = X.paletteState(ex, 1); assert.strictEqual(p.status, 'review'); assert.strictEqual(p.answered, true); assert.strictEqual(p.marked, true); assert.strictEqual(p.current, true);
  assert.strictEqual(X.paletteState(ex, 0).status, 'unanswered'); assert.strictEqual(X.paletteState(ex, 2).status, 'none');
  X.setAnswer(ex, 'c', '4'); assert.strictEqual(X.paletteState(ex, 2).status, 'answered');
});
t('summary: answered + notAnswered + notVisited always equals total (randomised)', () => {
  let seed = 7; const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let round = 0; round < 200; round++) {
    const ex = mk();
    for (let step = 0; step < 25; step++) {
      const id = ex.ids[rnd(4)], act = rnd(6);
      if (act === 0) X.goTo(ex, rnd(4)); else if (act === 1) X.toggleMark(ex, id); else if (act === 2) X.clear(ex, id);
      else if (act === 3) X.setAnswer(ex, id, ex.byId[id].type === 'MCQ' ? 'A' : ex.byId[id].type === 'MSQ' ? ['A', 'B'] : '3'); else if (act === 4) X.setAnswer(ex, id, ex.byId[id].type === 'NAT' ? ' ' : []); else X.next(ex);
      const s = X.summary(ex); assert.strictEqual(s.answered + s.notAnswered + s.notVisited, s.total);
      assert.ok(s.answeredAndMarked <= s.marked && s.answeredAndMarked <= s.answered);
    }
  }
});
t('exam state exposes no answer key, marks or score', () => {
  const ex = mk(); assert.deepStrictEqual(Object.keys(ex).sort(), ['byId', 'clock', 'closed', 'current', 'ids', 'marked', 'responses', 'status', 'visited']);
  assert.deepStrictEqual(Object.keys(ex.byId.a).sort(), ['id', 'options', 'type']);
  assert.deepStrictEqual(Object.keys(X).sort(), ['attemptsEnabled', 'blockers', 'clear', 'create', 'finalSubmitAccepted', 'formatClock', 'goTo', 'hasAnswer', 'isOpen', 'next', 'paletteState', 'policy', 'policyStatus', 'prev', 'remaining', 'remainingSeconds', 'responseText', 'restore', 'setAnswer', 'snapshot', 'startCheck', 'status', 'submit', 'summary', 'timeOut', 'toggleMark']);
});

const clocked = (start = 1000, dur = 100) => X.create([{ id: 'a', type: 'MCQ', options: ['A', 'B', 'C'] }, { id: 'b', type: 'MSQ', options: ['A', 'B', 'C'] }, { id: 'c', type: 'NAT' }], { durationSeconds: dur, startedAtMs: start });

t('clock is frozen; deadline = start + duration and never moves with navigation or answers', () => {
  const ex = clocked(); assert.strictEqual(ex.clock.deadlineMs, 101000); assert.ok(Object.isFrozen(ex.clock));
  X.goTo(ex, 2, 5000); X.setAnswer(ex, 'a', 'A', 6000); X.toggleMark(ex, 'b', 7000); assert.strictEqual(ex.clock.deadlineMs, 101000);
  assert.strictEqual(X.remaining(ex, 51000), 50); assert.strictEqual(X.remaining(ex, 51000), 50);
  ['bad', { durationSeconds: 0, startedAtMs: 1 }, { durationSeconds: 1.5, startedAtMs: 1 }, { durationSeconds: 5 }].forEach(o => assert.throws(() => X.create([], o), TypeError));
});
t('answered and marked keep both flags and are counted once', () => {
  const ex = mk(); X.setAnswer(ex, 'a', 'B'); X.toggleMark(ex, 'a');
  const p = X.paletteState(ex, 0); assert.ok(p.answered && p.marked && p.status === 'review');
  assert.deepStrictEqual(X.summary(ex), { total: 4, answered: 1, notAnswered: 0, notVisited: 3, marked: 1, answeredAndMarked: 1 });
  X.toggleMark(ex, 'a'); assert.strictEqual(X.hasAnswer(ex, 'a'), true); assert.strictEqual(X.responseText(ex, 'a'), 'B');
  X.setAnswer(ex, 'b', ['C', 'A']); assert.strictEqual(X.responseText(ex, 'b'), 'A, C'); assert.strictEqual(X.responseText(ex, 'c'), '');
});
t('submit makes the attempt read-only and freezes the summary', () => {
  const ex = clocked(); X.setAnswer(ex, 'a', 'A', 2000); X.toggleMark(ex, 'a', 2000); assert.strictEqual(X.submit(ex, 3000), true); assert.strictEqual(ex.status, 'submitted');
  const before = JSON.stringify(X.summary(ex)), snap = JSON.stringify(X.snapshot(ex));
  assert.strictEqual(X.setAnswer(ex, 'a', 'B', 3500), false); assert.strictEqual(X.setAnswer(ex, 'c', '4', 3500), false); assert.strictEqual(X.clear(ex, 'a', 3500), false);
  assert.strictEqual(X.toggleMark(ex, 'a', 3500), null); assert.strictEqual(X.submit(ex, 3600), false);
  assert.strictEqual(X.goTo(ex, 2, 3600), true); assert.strictEqual(ex.current, 2); assert.strictEqual(ex.visited.c, undefined);
  assert.strictEqual(JSON.stringify(X.summary(ex)), before); ex.current = 0; assert.strictEqual(JSON.stringify(X.snapshot(ex)).replace(/"current":\d/, ''), snap.replace(/"current":\d/, ''));
  assert.strictEqual(X.remaining(ex, 90000), 98);   /* frozen at the submit moment */
});
t('deadline closes the attempt as timed_out, keeps saved responses, rejects later changes', () => {
  const ex = clocked(); X.setAnswer(ex, 'a', 'C', 50000);
  assert.strictEqual(X.status(ex, 100999), 'in_progress'); assert.strictEqual(X.setAnswer(ex, 'c', '9', 101000), false);
  assert.strictEqual(ex.status, 'timed_out'); assert.strictEqual(ex.closed.atMs, 101000); assert.strictEqual(ex.responses.a, 'C'); assert.strictEqual(X.hasAnswer(ex, 'c'), false);
  assert.strictEqual(X.submit(ex, 101001), false); assert.strictEqual(X.remaining(ex, 999999), 0); assert.ok(Object.is(X.remaining(ex, 999999), 0));
  const late = clocked(); assert.strictEqual(X.submit(late, 200000), false); assert.strictEqual(late.status, 'timed_out'); assert.strictEqual(X.timeOut(late), false);
});
t('preview (no clock) can be closed by timeOut and then stays read-only', () => {
  const ex = mk(); X.setAnswer(ex, 'a', 'A'); assert.strictEqual(X.remaining(ex), null); assert.strictEqual(X.timeOut(ex), true);
  assert.strictEqual(ex.status, 'timed_out'); assert.strictEqual(X.setAnswer(ex, 'a', 'B'), false); assert.strictEqual(ex.responses.a, 'A'); assert.strictEqual(X.submit(ex), false);
});
t('snapshot and restore keep the original deadline; restoring later cannot extend it', () => {
  const items = [{ id: 'a', type: 'MCQ', options: ['A', 'B'] }, { id: 'b', type: 'MSQ', options: ['A', 'B'] }, { id: 'c', type: 'NAT' }];
  const ex = clocked(); X.setAnswer(ex, 'a', 'A', 2000); X.toggleMark(ex, 'a', 2000); X.setAnswer(ex, 'b', ['B'], 3000); X.goTo(ex, 2, 4000);
  const snap = JSON.parse(JSON.stringify(X.snapshot(ex))); const r = X.restore(items, snap, 60000);
  assert.strictEqual(r.clock.deadlineMs, 101000); assert.strictEqual(X.remaining(r, 60000), 41); assert.strictEqual(r.current, 2);
  assert.deepStrictEqual(X.summary(r), X.summary(ex)); assert.deepStrictEqual(r.responses.b, ['B']); assert.strictEqual(r.marked.a, true);
  const late = X.restore(items, snap, 500000); assert.strictEqual(late.status, 'timed_out'); assert.strictEqual(late.responses.a, 'A'); assert.strictEqual(X.setAnswer(late, 'c', '1', 500001), false);
  const sub = X.restore(items, JSON.parse(JSON.stringify(X.snapshot((() => { const e = clocked(); X.submit(e, 5000); return e; })()))), 6000); assert.strictEqual(sub.status, 'submitted'); assert.strictEqual(X.remaining(sub, 90000), 96);
  [null, {}, { version: 2, status: 'in_progress' }, { version: 1, status: 'paused' }, { ...snap, responses: { a: 'Z' } }, { ...snap, clock: { durationSeconds: -1, startedAtMs: 0 } }].forEach(b => assert.throws(() => X.restore(items, b, 0), TypeError));
});
t('attempt policy is as the owner stated and is not enforced by this site', () => {
  assert.deepStrictEqual({ ...X.policy }, { manualPause: false, resumeExtendsDeadline: false, closeAtDeadlineBy: 'exam service', acceptAnswersAfterDeadline: false, activeAttemptsPerModePerUser: 1, maxStartsPerHour: 10, finalSubmitGraceSeconds: 15, approvalStatus: 'draft_unapproved', enforcedBy: 'backend (not built)', enforcedNow: false });
  assert.ok(Object.isFrozen(X.policy));
});
t('startCheck reports policy limits separately from the engine being off, and is never enforced', () => {
  const now = 10 * 3600000, within = n => Array.from({ length: n }, (_, i) => now - 1000 * (i + 1));
  const codes = r => r.reasons.map(x => x.code);
  let r = X.startCheck({ mode: 'year', activeModes: [], startTimesMs: within(3), nowMs: now }); assert.deepStrictEqual(codes(r), ['policy_unapproved', 'engine_unavailable']); assert.strictEqual(r.allowed, false); assert.strictEqual(r.enforced, false);
  assert.deepStrictEqual(codes(X.startCheck({ mode: 'year', activeModes: ['year'], startTimesMs: [], nowMs: now })), ['active_attempt_exists', 'policy_unapproved', 'engine_unavailable']);
  assert.ok(!codes(X.startCheck({ mode: 'topic', activeModes: ['year'], startTimesMs: [], nowMs: now })).includes('active_attempt_exists'));
  assert.ok(!codes(X.startCheck({ mode: 'year', startTimesMs: within(9), nowMs: now })).includes('hourly_limit'));
  assert.ok(codes(X.startCheck({ mode: 'year', startTimesMs: within(10), nowMs: now })).includes('hourly_limit'));
  assert.ok(!codes(X.startCheck({ mode: 'year', startTimesMs: within(9).concat([now - 3600000]), nowMs: now })).includes('hourly_limit'));
  assert.ok(codes(X.startCheck({ mode: 'nope', nowMs: 'x' })).includes('bad_mode')); assert.ok(codes(X.startCheck()).includes('bad_time'));
});
t('final-submit grace: only a request sent by the deadline, received within 15 s; never admits new answers', () => {
  const d = 100000; assert.strictEqual(X.finalSubmitAccepted(d, d, d + 15000), true); assert.strictEqual(X.finalSubmitAccepted(d, d, d + 15001), false);
  assert.strictEqual(X.finalSubmitAccepted(d, d + 1, d + 2), false); assert.strictEqual(X.finalSubmitAccepted(d, 'x', d), false);
});
t('marking profiles: every year is unverified and cannot score; nothing is invented', () => {
  const M = G.marking;
  [2012, 2020, 2024, 2025, 1850, 'x', undefined].forEach(y => { const p = M.profileFor(y); assert.strictEqual(p.verified, false); assert.strictEqual(p.canScore, false); assert.strictEqual(p.rules, null); assert.ok(p.pending.length === M.decisions.length); });
  assert.strictEqual(M.profileFor(2024).year, 2024); assert.strictEqual(M.profileFor('x').year, null);
  assert.ok(M.scoringBlockers(2024)[0].includes('unverified')); assert.ok(X.blockers('ready', 2024).some(b => /GATE 2024 is unverified/.test(b)));
  assert.strictEqual(X.attemptsEnabled('ready', 2024), false);
  const reasons = M.validateProfile({ year: 2024, source: { name: 'x', urls: ['u'] }, rules: {} }); assert.strictEqual(reasons.length, M.decisions.length);
  assert.ok(M.validateProfile({ year: 2024, rules: {} }).some(r => /source/.test(r)));
  assert.ok(M.decisions.some(d => d.id === 'NAT.tolerance') && M.decisions.some(d => d.id === 'MSQ.partial'));
});
t('GATE 2026 rules are source-verified reference only; owner/scoring gates stay closed', () => {
  const M = G.marking, p = M.profileFor(2026), T = M.fracText;
  assert.strictEqual(p.status, 'reference_only'); assert.strictEqual(p.verified, true); assert.strictEqual(p.sourceVerified, true);
  assert.strictEqual(p.ownerApproved, false); assert.strictEqual(p.year, 2026); assert.strictEqual(p.canScore, false);
  assert.strictEqual(p.operationalStatus, 'blocked'); assert.strictEqual(p.pending.length, 0);
  assert.deepStrictEqual([...p.source.urls], ['https://gate2026.iitg.ac.in/question-paper-pattern.html', 'https://gate2026.iitg.ac.in/QPs-answer-keys.html']);
  assert.deepStrictEqual([...p.source.ownerCitedUrls], ['https://gate2026.iitg.ac.in/doc/IB/GATE2026-IB-v22082025-1300.pdf']);
  assert.strictEqual(T(p.rules.MCQ.wrong), '-1/3'); assert.strictEqual(T(p.rules.MSQ.wrong), '0'); assert.strictEqual(T(p.rules.NAT.wrong), '0'); assert.strictEqual(p.rules.MSQ.partial, 'none'); assert.strictEqual(p.rules.NAT.tolerance, 'answer_key_range'); assert.strictEqual(p.marksToAll, true);
  ['MCQ', 'MSQ', 'NAT'].forEach(ty => { assert.strictEqual(T(p.rules[ty].unattempted), '0'); assert.strictEqual(p.provenance[ty + '.unattempted'], 'interpretation'); });
  const interp = Object.keys(p.provenance).filter(k => p.provenance[k] === 'interpretation').sort(); assert.deepStrictEqual(interp, ['MCQ.unattempted', 'MSQ.unattempted', 'NAT.unattempted']);
  assert.ok(Object.keys(p.provenance).filter(k => !/unattempted/.test(k)).every(k => p.provenance[k] === 'official'));
  assert.match(p.interpretationNote, /not an official statement/); assert.ok(M.describeProfile(2026).some(l => /reference-only/.test(l)));
  assert.deepStrictEqual(M.validateProfile({ ...p, source: p.source }), []);
  assert.ok(M.validateProfile({ ...p, provenance: {} }).some(r => /provenance/.test(r)));
  assert.ok(M.validateProfile({ ...p, unresolved: ['MCQ.unattempted'] }).some(r => /unresolved but has a value/.test(r)));
  [2025, 2024, 2020, 2012, 2027, '2026', 'x', undefined, null].forEach(y => { const q = M.profileFor(y); assert.strictEqual(q.verified, false, String(y)); assert.strictEqual(q.sourceVerified, false); assert.strictEqual(q.canScore, false); assert.strictEqual(q.rules, null); });
  const m1 = M.frac(-1, 3), m2 = M.frac(-2, 3);
  assert.strictEqual(T(m1), '-1/3'); assert.strictEqual(T(m2), '-2/3'); assert.strictEqual(T(M.sumMarks([m1, m1, m1])), '-1'); assert.strictEqual(T(M.sumMarks([m1, M.frac(1, 1), m1, m1])), '0');
  assert.ok(Object.is(M.fracValue(M.sumMarks([m1, m1, m1, M.frac(1, 1)])), 0)); assert.ok(Object.is(M.fracValue(M.frac(0, -5)), 0));
  assert.strictEqual(M.sumMarks([m1, null]), null);
  assert.strictEqual(M.awardedMarks(p, { type: 'MCQ', marks: 1 }, 'wrong'), null);
  assert.strictEqual(M.awardedMarks(p, { type: 'MCQ', marks: 1 }, 'correct'), null);
  assert.strictEqual(M.awardedMarks(M.profileFor(2025), { type: 'MCQ', marks: 1 }, 'wrong'), null);
  const sb = M.scoringBlockers(2026); assert.ok(sb.some(x => /DRAFT.*NOT APPROVED/.test(x))); assert.ok(sb.some(x => /confirmation gate is OFF/.test(x)));
  assert.ok(sb.some(x => /server-side scoring backend/.test(x))); assert.ok(sb.some(x => /private answer keys/.test(x))); assert.ok(sb.some(x => /AK-01 \/ AK-02/.test(x)));
  const ps = M.policyStatus(2026); assert.strictEqual(ps.specStatus, 'draft_unapproved'); assert.strictEqual(ps.canScore, false); assert.strictEqual(ps.canStartOnlineExam, false); assert.strictEqual(ps.canReviewAnswers, false);
  assert.strictEqual(X.attemptsEnabled('ready', 2026), false); assert.ok(X.blockers('ready', 2026).some(b => /exam engine is not built/.test(b)));
});
t('browser scoreResponse fails closed even when a caller supplies a key', () => {
  const M = G.marking, p = M.profileFor(2026), S = M.scoreResponse;
  assert.deepStrictEqual(S(p, { type: 'MCQ', marks: 1 }, 'A', { answer: 'A' }), { outcome: null, marks: null });
  assert.deepStrictEqual(S(p, { type: 'NAT', marks: 1 }, '1.5', { min: 1, max: 2 }), { outcome: null, marks: null });
  assert.deepStrictEqual(S(M.profileFor(2025), { type: 'MCQ', marks: 1 }, '', { answer: 'A' }), { outcome: null, marks: null });
});
t('response classification uses a key passed in; MSQ is all-or-nothing; NAT uses the key range; MTA wins', () => {
  const c = G.marking.classifyResponse;
  assert.strictEqual(c('MCQ', 'A', { answer: 'A' }), 'correct'); assert.strictEqual(c('MCQ', 'B', { answer: 'A' }), 'wrong'); assert.strictEqual(c('MCQ', undefined, { answer: 'A' }), 'unattempted');
  assert.strictEqual(c('MSQ', ['B', 'A'], { answers: ['A', 'B'] }), 'correct'); assert.strictEqual(c('MSQ', ['A'], { answers: ['A', 'B'] }), 'wrong'); assert.strictEqual(c('MSQ', ['A', 'C'], { answers: ['A', 'B'] }), 'wrong'); assert.strictEqual(c('MSQ', [], { answers: ['A'] }), 'unattempted');
  assert.strictEqual(c('NAT', '4.5', { min: 4, max: 5 }), 'correct'); assert.strictEqual(c('NAT', '5.01', { min: 4, max: 5 }), 'wrong'); assert.strictEqual(c('NAT', 'abc', { min: 4, max: 5 }), 'wrong'); assert.strictEqual(c('NAT', '', { min: 4, max: 5 }), 'unattempted');
  assert.strictEqual(c('MCQ', '', { marksToAll: true }), 'marks_to_all'); assert.strictEqual(c('NAT', '9', { marksToAll: true }), 'marks_to_all');
});
t('public app.js holds no answer keys and auth transport remains a separate module', () => {
  const root = path.join(__dirname, '..');
  assert.ok(fs.existsSync(path.join(root, 'auth.js')), 'auth.js exists as the separate auth transport module');
  assert.ok(!/answer_key\s*[:=]/.test(fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/has\.call\(rec, 'answer_key'\)/g, '')));
});

t('public exam-policy status snapshot is fail-closed and cannot authorize runtime scoring', () => {
  const file = path.join(__dirname, '..', 'data', 'EXAM_POLICY_STATUS.json');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(d.snapshot_type, 'informational_public_status_only');
  assert.strictEqual(d.spec_status, 'draft_unapproved');
  assert.strictEqual(d.owner_approval_reference, null);
  assert.strictEqual(d.gates.marking_rules_confirmed, false);
  assert.strictEqual(d.gates.exam_policy_approved, false);
  assert.strictEqual(d.gates.scoring_backend_ready, false);
  assert.strictEqual(d.gates.exam_engine_available, false);
  assert.strictEqual(d.gates.attempt_policy_enforced, false);
  assert.strictEqual(d.gates.answer_review_approved, false);
  assert.strictEqual(G.marking.policyStatus(2026).canScore, false);
  assert.strictEqual(G.marking.policyStatus(2026).canStartOnlineExam, false);
  assert.strictEqual(G.marking.policyStatus(2024).profileStatus, 'unverified');
  assert.strictEqual(G.marking.policyStatus(2024).canScore, false);
  const html = fs.readFileSync(path.join(__dirname, '..', 'exam.html'), 'utf8');
  assert.ok(html.includes('id=\"mark-policy-year\"')); assert.ok(html.includes('id=\"mark-policy-check\"'));
  assert.ok(html.includes('Reference only') && html.includes('not an approved scoring profile') && html.includes('not owner-approved'));
});

(async () => {
  let n = 0;
  for (const [name, fn] of queue) { try { await fn(); n++; console.log('ok -', name); } catch (e) { console.error('FAIL -', name, '\n', e.message); process.exitCode = 1; } }
  console.log(`\n${n}/${queue.length} exam unit tests passed`);
})();
