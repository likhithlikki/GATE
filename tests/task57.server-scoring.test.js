'use strict';

/* Focused contract tests for Task 57's private GAS scoring gates and pinned key-set identity.
 * This is a local VM test with mocked Script Properties; it is not a live Google Apps Script / Sheets integration test. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const propertyValues = Object.create(null);
const context = vm.createContext({
  KS_HEX64_RE: /^[0-9a-f]{64}$/,
  PropertiesService: {
    getScriptProperties() {
      return { getProperty(name) { return Object.prototype.hasOwnProperty.call(propertyValues, name) ? propertyValues[name] : null; } };
    }
  },
  Logger: { log() {} }
});

for (const rel of ['private-backend/Scoring.gs', 'private-backend/ScoringService.gs', 'private-backend/ExamService.gs']) {
  vm.runInContext(fs.readFileSync(path.join(root, rel), 'utf8'), context, { filename: rel });
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}

const gateProps = [
  'EXAM_POLICY_APPROVED',
  'EXAM_POLICY_MARKING_RULES_CONFIRMED',
  'EXAM_POLICY_SCORING_BACKEND_READY',
  'EXAM_POLICY_EXAM_ENGINE_AVAILABLE'
];

test('all global operational gates default off when Script Properties are missing', () => {
  for (const k of Object.keys(propertyValues)) delete propertyValues[k];
  const s = context.ssOperationalGateStatus_();
  assert.equal(s.ok, false);
  assert.deepEqual(Array.from(s.missing, x => x.property), gateProps);
  assert.equal(context.ssFirstOperationalBlock_().reason, 'scoring_spec_unapproved');
});

test('all global operational gates must be explicitly enabled', () => {
  for (const k of gateProps) propertyValues[k] = 'true';
  assert.equal(context.ssOperationalGateStatus_().ok, true);
  propertyValues.EXAM_POLICY_EXAM_ENGINE_AVAILABLE = 'false';
  assert.equal(context.ssOperationalGateStatus_().ok, false);
  assert.equal(context.ssFirstOperationalBlock_().reason, 'exam_engine_not_available');
});

test('non-true values never open a global operational gate', () => {
  for (const k of gateProps) propertyValues[k] = 'true';
  for (const value of ['', 'false', '1', 'yes', null]) {
    propertyValues.EXAM_POLICY_APPROVED = value;
    assert.equal(context.ssOperationalGateStatus_().ok, false, `value ${String(value)} must stay off`);
  }
});

test('pinned key-set id and digest must match the loaded approved key-set metadata', () => {
  const attempt = { key_set_id: 'ks-' + 'a'.repeat(40), key_set_digest: 'b'.repeat(64) };
  const keySet = { key_set_id: attempt.key_set_id, key_set_digest: attempt.key_set_digest };
  assert.equal(context.ssAssertKeySetPin_(attempt, keySet), true);
  assert.throws(() => context.ssAssertKeySetPin_(attempt, { key_set_id: attempt.key_set_id, key_set_digest: 'c'.repeat(64) }), e =>
    e.ssCode === 'key_set_pin_mismatch' && e.ssStatus === 'blocked' && e.ssReason === 'key_set_revision_mismatch');
});

test('missing or malformed attempt key-set pins fail closed', () => {
  assert.throws(() => context.ssAssertKeySetPin_({}, {}), e => e.ssCode === 'key_set_pin_invalid');
  assert.throws(() => context.ssAssertKeySetPin_({ key_set_id: 'bad', key_set_digest: 'bad' }, {}), e => e.ssCode === 'key_set_pin_invalid');
});

test('attempt start refuses policies required by the selected question/key types', () => {
  for (const k of Object.keys(propertyValues)) delete propertyValues[k];
  const eligible = [{ o: { question_id: 'Q1', type: 'MCQ' }, version: 1 }];
  const loadedKeys = { keys: [{ question_id: 'Q1', question_version: '1', key_kind: 'answer' }] };
  assert.equal(context.exFirstMissingStartScoringPolicy_(eligible, loadedKeys), 'unanswered_zero_not_approved');
  propertyValues.SCORING_POLICY_UNANSWERED_ZERO = 'true';
  assert.equal(context.exFirstMissingStartScoringPolicy_(eligible, loadedKeys), '');
  const natEligible = [{ o: { question_id: 'Q2', type: 'NAT' }, version: 1 }];
  const natKeys = { keys: [{ question_id: 'Q2', question_version: '1', key_kind: 'answer' }] };
  assert.equal(context.exFirstMissingStartScoringPolicy_(natEligible, natKeys), 'nat_syntax_not_approved');
  propertyValues.SCORING_POLICY_NAT_SYNTAX = 'true';
  assert.equal(context.exFirstMissingStartScoringPolicy_(natEligible, natKeys), 'nat_boundaries_not_approved');
  propertyValues.SCORING_POLICY_NAT_BOUNDARIES = 'true';
  assert.equal(context.exFirstMissingStartScoringPolicy_(natEligible, natKeys), 'nat_rounding_not_approved');
  propertyValues.SCORING_POLICY_NAT_ROUNDING = 'true';
  assert.equal(context.exFirstMissingStartScoringPolicy_(natEligible, natKeys), '');
  const mtaKeys = { keys: [{ question_id: 'Q1', question_version: '1', key_kind: 'marks_to_all' }] };
  assert.equal(context.exFirstMissingStartScoringPolicy_(eligible, mtaKeys), 'marks_to_all_not_approved');
  propertyValues.SCORING_POLICY_MARKS_TO_ALL = 'true';
  assert.equal(context.exFirstMissingStartScoringPolicy_(eligible, mtaKeys), '');
});

test('attempt schema appends key-set pin columns and the stored-attempt loader refuses unpinned historical rows', () => {
  const schema = fs.readFileSync(path.join(root, 'private-backend/Schemas.gs'), 'utf8');
  const loader = fs.readFileSync(path.join(root, 'private-backend/AttemptStore.gs'), 'utf8');
  assert.match(schema, /'paper_id', 'key_set_id', 'key_set_digest'\]/);
  assert.match(loader, /pinnedKeySetId[\s\S]*key_set_pin_missing/);
  assert.match(loader, /key_set_id: pinnedKeySetId, key_set_digest: pinnedKeySetDigest/);
});

test('start and score paths enforce private approval gates and key coverage/pinning', () => {
  const exam = fs.readFileSync(path.join(root, 'private-backend/ExamService.gs'), 'utf8');
  const score = fs.readFileSync(path.join(root, 'private-backend/ScoringService.gs'), 'utf8');
  assert.match(exam, /exRequireScoringOperations_\(\)/);
  assert.match(exam, /exLoadKeySetForStartLocked_\(p\.paper_id\)/);
  assert.match(exam, /exValidateStartKeyCoverage_\(loaded\.paper, prof, eligible, startKeySet\)/);
  assert.match(exam, /exFirstMissingStartScoringPolicy_\(eligible, startKeySet\)/);
  assert.match(exam, /unanswered_zero_not_approved/);
  assert.match(exam, /nat_boundaries_not_approved/);
  assert.match(exam, /key_set_id: pinnedKeySet\.key_set_id, key_set_digest: pinnedKeySet\.key_set_digest/);
  assert.match(score, /var globalBlock = ssFirstOperationalBlock_\(\)/);
  assert.match(score, /ssAssertKeySetPin_\(attempt, m\)/);
  assert.match(score, /h\.key_set_digest !== attempt\.key_set_digest/);
});

test('result-review route remains gated and result summary omits key identifiers and digest', () => {
  const results = fs.readFileSync(path.join(root, 'private-backend/ExamResults.gs'), 'utf8');
  assert.match(results, /if \(!exGate_\('answer_review'\)\)[\s\S]*answer_review_unresolved_d18/);
  const summary = results.match(/function exResultSummary_\(res\) \{([\s\S]*?)\n\}/);
  assert.ok(summary);
  assert.doesNotMatch(summary[1], /key_set_digest|key_id|nat_lo|nat_hi|correct_answer|explanation/);
});

const publicSite = path.join(root, 'public-site');
if (fs.existsSync(publicSite)) {
  test('public-site export contains no private key-store/scoring source files', () => {
    const files = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p); else files.push(path.relative(publicSite, p).replace(/\\/g, '/'));
      }
    })(publicSite);
    assert.equal(files.some(x => /KeyStore\.gs$|Scoring(Service)?\.gs$|AttemptStore\.gs$/.test(x)), false);
  });
}

process.stdout.write(`\nTask 57 private scoring contract tests: ${passed}/${passed} passed. Mocked/local checks only; no live GAS or Sheets access.\n`);
