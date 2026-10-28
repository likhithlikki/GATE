/**
 * GATE Prep Studio PRIVATE backend: Scoring core (Task 28). Pure, deterministic scoring logic only.
 *
 * Part of the standalone private Apps Script project. No doGet/doPost, no endpoint, no browser-accessible API, and no
 * function here is runnable from the editor (every name ends in an underscore). Trusted server-side code calls it.
 *
 * Not in this file, deliberately: attempt retrieval, writes to EXAM_DB (results / result_items), result delivery, review,
 * corrections, rescoring. Nothing here reads or writes a spreadsheet except through ksLoadApprovedKeySet_ (KeyStore.gs), and
 * only the convenience wrapper scLoadAndScoreAttempt_ calls it.
 *
 * Inputs are never trusted for rules: scores, marking rules, correctness flags and keys supplied by a browser have no entry
 * point here. Keys come from the verified loader result, and are re-verified (row_mac and digest) before use.
 *
 * Outputs carry outcomes, exact fractions and ids. Error and diagnostic values are codes only: no answer values, NAT bounds,
 * secrets or whole records are ever returned in a blocked result or logged.
 *
 * POLICY GATES (default OFF; Script Property SCORING_POLICY_<NAME> = 'true' turns one on, read by scPolicyFromProperties_):
 *   UNANSWERED_ZERO   unanswered scores 0 (site INTERPRETATION, not an official statement)
 *   MARKS_TO_ALL      Marks To All gives the marks regardless of the response, including unanswered (AK-03)
 *   NAT_SYNTAX        accepted NAT response syntax, currently [+-]?digits[.digits] only (AK-02)
 *   NAT_BOUNDARIES    the stored per-key inclusivity flags are confirmed against the official key files (AK-01)
 *   NAT_ROUNDING      confirmation that responses are compared without rounding (AK-02)
 *   MIXED_YEAR        an attempt may mix years, each scored by its own verified profile (AK-13)
 * A required gate that is off returns {status:'blocked', code:'blocked_policy', reason:'<gate>_not_approved'}. This file never
 * switches a gate on, so scoring stays blocked until the owner decides.
 */

var SC_MAX_QUESTIONS = 200;
var SC_DEC_MAX_INT_DIGITS = 20;    /* documented NAT safety limits: integer digits and fractional digits after trimming leading zeros */
var SC_DEC_MAX_FRAC_DIGITS = 15;
var SC_GATE_NAMES = ['unanswered_zero', 'marks_to_all', 'nat_syntax', 'nat_boundaries', 'nat_rounding', 'mixed_year'];
var SC_OUTCOMES = ['correct', 'wrong', 'unanswered', 'marks_to_all'];

/* Global operational approvals are separate from the six detailed scoring-policy decisions below. All are absent/off by default.
 * They mirror Task 56's owner-controlled gates on the private backend; frontend constants are informational only and cannot authorize scoring.
 * Set a property to the literal text 'true' only after the owner has recorded the corresponding approval/readiness evidence. */
var SC_OPERATIONAL_GATES = [
  { property: 'EXAM_POLICY_APPROVED', reason: 'scoring_spec_unapproved' },
  { property: 'EXAM_POLICY_MARKING_RULES_CONFIRMED', reason: 'marking_rules_unconfirmed' },
  { property: 'EXAM_POLICY_SCORING_BACKEND_READY', reason: 'scoring_backend_not_ready' },
  { property: 'EXAM_POLICY_EXAM_ENGINE_AVAILABLE', reason: 'exam_engine_not_available' }
];

/* Read only; returns gate names/reason codes only, never property values or secrets. */
function ssOperationalGateStatus_() {
  var props = PropertiesService.getScriptProperties(), missing = [];
  SC_OPERATIONAL_GATES.forEach(function (g) {
    var v = props.getProperty(g.property);
    if (v === null || v === undefined || String(v).trim().toLowerCase() !== 'true') {
      missing.push({ property: g.property, reason: g.reason });
    }
  });
  return { ok: missing.length === 0, missing: missing };
}

function ssFirstOperationalBlock_() {
  var s = ssOperationalGateStatus_();
  return s.ok ? null : s.missing[0];
}

/* ---------------------------------------------------------------------------------------------------
 * Errors
 * ------------------------------------------------------------------------------------------------- */
function scErr_(code, reason) { var e = new Error('Scoring ' + code); e.name = 'ScoringError'; e.scCode = code; e.scReason = reason || ''; return e; }
function scPolicyBlock_(gate) { return scErr_('blocked_policy', gate + '_not_approved'); }

function scBlockedFrom_(e) {
  if (e && e.scCode) { return { status: 'blocked', code: e.scCode, reason: e.scReason || '' }; }
  if (e && e.ksCode) { return { status: 'blocked', code: e.ksCode, reason: '' }; }
  return { status: 'blocked', code: 'internal_error', reason: '' };
}

/* ---------------------------------------------------------------------------------------------------
 * Exact fractions: integer numerator/denominator pairs, matching results.total_num/total_den and result_items.awarded_*.
 * Every integer must be a JavaScript safe integer and every intermediate product is checked; overflow throws rather than
 * losing precision. Zero is always {num:0, den:1}: never negative zero.
 * ------------------------------------------------------------------------------------------------- */
function scSafeInt_(n) {
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) { throw scErr_('invalid_integer'); }
  return n === 0 ? 0 : n;   /* -0 becomes 0 */
}
function scMulSafe_(a, b) {
  var p = a * b;
  if (!Number.isSafeInteger(p)) { throw scErr_('fraction_overflow'); }
  return p === 0 ? 0 : p;
}
function scAddSafe_(a, b) {
  var s = a + b;
  if (!Number.isSafeInteger(s)) { throw scErr_('fraction_overflow'); }
  return s === 0 ? 0 : s;
}
function scGcd_(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { var t = a % b; a = b; b = t; } return a || 1; }

function scFrac_(n, d) {
  scSafeInt_(n); scSafeInt_(d);
  if (d === 0) { throw scErr_('invalid_integer'); }
  if (d < 0) { n = -n; d = -d; }
  var g = scGcd_(n, d);
  n = n / g; d = d / g;
  if (n === 0) { n = 0; d = 1; }
  return Object.freeze({ num: n, den: d });
}
function scIsFrac_(f) {
  return !!f && typeof f === 'object' && typeof f.num === 'number' && typeof f.den === 'number' && Number.isSafeInteger(f.num) && Number.isSafeInteger(f.den) && f.den > 0;
}
function scCheckFrac_(f) { if (!scIsFrac_(f)) { throw scErr_('invalid_fraction'); } return f; }
function scMul_(f, k) { scCheckFrac_(f); scSafeInt_(k); return scFrac_(scMulSafe_(f.num, k), f.den); }
function scAdd_(a, b) {
  scCheckFrac_(a); scCheckFrac_(b);
  var g = scGcd_(a.den, b.den), da = a.den / g, db = b.den / g;
  return scFrac_(scAddSafe_(scMulSafe_(a.num, db), scMulSafe_(b.num, da)), scMulSafe_(a.den, db));
}
function scSum_(list) {
  var t = scFrac_(0, 1);
  for (var i = 0; i < list.length; i++) { t = scAdd_(t, list[i]); }
  return t;
}
function scCmp_(a, b) {
  scCheckFrac_(a); scCheckFrac_(b);
  var l = scMulSafe_(a.num, b.den), r = scMulSafe_(b.num, a.den);
  return l < r ? -1 : l > r ? 1 : 0;
}
function scEq_(a, b) { return scCmp_(a, b) === 0; }
function scText_(f) { scCheckFrac_(f); return f.den === 1 ? String(f.num) : f.num + '/' + f.den; }

/* ---------------------------------------------------------------------------------------------------
 * Exact NAT decimals. Text in, exact comparison out; Number is never used. Shape matches ksParseDecimal_ so the existing
 * ksCmpDecimal_ does the comparison. Limits: total length <= 32, <= 20 integer digits, <= 15 fractional digits.
 * ------------------------------------------------------------------------------------------------- */
function scDecimalWithinLimits_(d) {
  if (!d) { return null; }
  if (d.ip.length > SC_DEC_MAX_INT_DIGITS || d.fp.length > SC_DEC_MAX_FRAC_DIGITS) { return null; }
  return d;
}
/* Key values: no plus sign (same syntax as the staged values). */
function scParseKeyDecimal_(s) { return scDecimalWithinLimits_(ksParseDecimal_(s)); }
/* Candidate responses: trimmed, optional leading plus, plain digits and one optional fractional part. No exponent, comma or rounding. */
function scParseResponseDecimal_(s) {
  if (typeof s !== 'string') { return null; }
  var t = s.trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(t)) { return null; }
  return scDecimalWithinLimits_(ksParseDecimal_(t.charAt(0) === '+' ? t.slice(1) : t));
}
function scBoolFlag_(v) {
  if (v === true || v === 'true') { return true; }
  if (v === false || v === 'false') { return false; }
  throw scErr_('key_invalid', 'nat_boundary_unspecified');   /* never defaulted */
}
/* Exact range test using the key's stored inclusivity flags. */
function scNatWithin_(value, key) {
  var lo = scParseKeyDecimal_(key.nat_lo), hi = scParseKeyDecimal_(key.nat_hi);
  if (!lo || !hi || ksCmpDecimal_(lo, hi) > 0) { throw scErr_('key_invalid', 'nat_range_invalid'); }
  var loIn = scBoolFlag_(key.nat_lo_inclusive), hiIn = scBoolFlag_(key.nat_hi_inclusive);
  var cl = ksCmpDecimal_(value, lo), ch = ksCmpDecimal_(value, hi);
  return (loIn ? cl >= 0 : cl > 0) && (hiIn ? ch <= 0 : ch < 0);
}

/* ---------------------------------------------------------------------------------------------------
 * Policy gates
 * ------------------------------------------------------------------------------------------------- */
function scNormPolicy_(p) {
  var out = {};
  SC_GATE_NAMES.forEach(function (g) { out[g] = !!p && typeof p === 'object' && p[g] === true; });   /* only literal true opens a gate */
  return out;
}
/* Owner-side switches. Not called by the scorers: the caller passes the result in explicitly. */
function scPolicyFromProperties_() {
  var props = PropertiesService.getScriptProperties(), out = {};
  SC_GATE_NAMES.forEach(function (g) {
    var v = props.getProperty('SCORING_POLICY_' + g.toUpperCase());
    out[g] = v !== null && v !== undefined && String(v).trim().toLowerCase() === 'true';
  });
  return out;
}

/* ---------------------------------------------------------------------------------------------------
 * Versioned private marking profile. GATE-2026@1 mirrors the source-verified browser profile (app.js, spec section 6) without
 * reading it: the server holds its own copy. Fractions are [num, den] pairs applied to the question's marks.
 * Provenance per rule: 'official' (stated on the official GATE 2026 pages read by this project) or 'interpretation' (the site's
 * reading; the unanswered score is NOT an official statement). Only profiles listed here exist; other years are unverified and
 * never inherit these rules.
 * ------------------------------------------------------------------------------------------------- */
var SC_PROFILES = Object.freeze({
  'GATE-2026@1': Object.freeze({
    profile_id: 'GATE-2026', profile_version: 1, year: 2026, status: 'verified', marks_to_all: true,
    rules: Object.freeze({
      MCQ: Object.freeze({ correct: [1, 1], wrong: [-1, 3], unanswered: [0, 1] }),
      MSQ: Object.freeze({ correct: [1, 1], wrong: [0, 1], unanswered: [0, 1] }),   /* no partial marking */
      NAT: Object.freeze({ correct: [1, 1], wrong: [0, 1], unanswered: [0, 1] })    /* range comes from the key, never a global tolerance */
    }),
    provenance: Object.freeze({
      'MCQ.correct': 'official', 'MCQ.wrong': 'official', 'MCQ.unanswered': 'interpretation',
      'MSQ.correct': 'official', 'MSQ.wrong': 'official', 'MSQ.unanswered': 'interpretation',
      'NAT.correct': 'official', 'NAT.wrong': 'official', 'NAT.unanswered': 'interpretation',
      'MTA': 'official'
    })
  })
});
var SC_PROFILE_HASHES_ = {};

function scProfileCanonical_(p) {
  /* Fixed key order so the hash is deterministic. */
  var r = p.rules, prov = p.provenance;
  return JSON.stringify({
    profile_id: p.profile_id, profile_version: p.profile_version, year: p.year, marks_to_all: p.marks_to_all,
    rules: { MCQ: r.MCQ, MSQ: r.MSQ, NAT: r.NAT },
    provenance: Object.keys(prov).sort().map(function (k) { return [k, prov[k]]; })
  });
}
function scProfileHash_(p) {
  var k = p.profile_id + '@' + p.profile_version;
  if (!SC_PROFILE_HASHES_[k]) { SC_PROFILE_HASHES_[k] = ksSha256Hex_(scProfileCanonical_(p)); }
  return SC_PROFILE_HASHES_[k];
}
/* Returns the profile only if it exists, is verified for exactly this year, and is also in KeyStore's verified list. */
function scProfileFor_(profileId, profileVersion, year) {
  var ref = String(profileId) + '@' + String(profileVersion), p = Object.prototype.hasOwnProperty.call(SC_PROFILES, ref) ? SC_PROFILES[ref] : null;
  if (!p || p.status !== 'verified' || p.year !== year) { return null; }
  var ks = Object.prototype.hasOwnProperty.call(KEYSTORE_VERIFIED_PROFILES, ref) ? KEYSTORE_VERIFIED_PROFILES[ref] : null;
  if (!ks || ks.year !== String(year)) { return null; }
  return p;
}
function scProfileRefText_(p) { return p.profile_id + '@' + p.profile_version + '@' + scProfileHash_(p); }

/* ---------------------------------------------------------------------------------------------------
 * Single question
 * ------------------------------------------------------------------------------------------------- */
function scToInt_(v, min) {
  var n = null;
  if (typeof v === 'number') { n = v; }
  else if (typeof v === 'string' && /^(0|[1-9]\d{0,15})$/.test(v)) { n = Number(v); }
  return n !== null && Number.isSafeInteger(n) && n >= min ? n : null;
}

/* Question record: { question_id, question_version, type, marks, year, content_hash, option_ids? }. All pinned fields are required. */
function scNormQuestion_(q) {
  if (!q || typeof q !== 'object') { throw scErr_('question_invalid'); }
  var id = q.question_id, ver = scToInt_(q.question_version, 1), marks = scToInt_(q.marks, 1), year = scToInt_(q.year, 1);
  if (typeof id !== 'string' || !KS_ID_RE.test(id) || ver === null || marks === null || year === null) { throw scErr_('question_invalid'); }
  if (q.type !== 'MCQ' && q.type !== 'MSQ' && q.type !== 'NAT') { throw scErr_('question_invalid', 'type'); }
  if (typeof q.content_hash !== 'string' || !KS_HEX64_RE.test(q.content_hash)) { throw scErr_('question_invalid', 'content_hash_missing'); }
  var opts = null;
  if (q.option_ids !== undefined && q.option_ids !== null) {
    if (!Array.isArray(q.option_ids) || !q.option_ids.length) { throw scErr_('question_invalid', 'options'); }
    opts = {};
    q.option_ids.forEach(function (o) { if (typeof o !== 'string' || !KS_ID_RE.test(o) || opts[o]) { throw scErr_('question_invalid', 'options'); } opts[o] = true; });
  }
  return { question_id: id, question_version: ver, type: q.type, marks: marks, year: year, content_hash: q.content_hash, options: opts };
}

function scIsBlankResponse_(r) {
  return r === undefined || r === null || (typeof r === 'string' && !r.trim()) || (Array.isArray(r) && !r.length);
}

function scAward_(prof, type, rule, marks) {
  var r = prof.rules[type][rule];
  return scMul_(scFrac_(r[0], r[1]), marks);
}

/* Core: throws scErr_ / ksErr_ on any block. Wrapped by scScoreQuestion_. */
function scScoreQuestionCore_(question, response, key, profileRef, policy) {
  var pol = scNormPolicy_(policy), q = scNormQuestion_(question);
  if (!key || typeof key !== 'object') { throw scErr_('key_missing'); }

  /* The key must belong to exactly this question version, type, marks, year and content. Never a different version. */
  if (key.question_id !== q.question_id) { throw scErr_('key_invalid', 'question_mismatch'); }
  if (scToInt_(key.question_version, 1) !== q.question_version) { throw scErr_('key_invalid', 'version_mismatch'); }
  if (key.type !== q.type) { throw scErr_('key_invalid', 'type_mismatch'); }
  if (scToInt_(key.marks, 1) !== q.marks) { throw scErr_('key_invalid', 'marks_mismatch'); }
  if (scToInt_(key.year, 1) !== q.year) { throw scErr_('key_invalid', 'year_mismatch'); }
  if (key.content_hash !== q.content_hash) { throw scErr_('key_invalid', 'content_hash_mismatch'); }
  if (key.status !== 'approved' || key.dispute_state !== 'none') { throw scErr_('key_not_current'); }
  if (key.key_kind !== 'answer' && key.key_kind !== 'marks_to_all') { throw scErr_('key_invalid', 'key_kind'); }
  var keyRevision = scToInt_(key.revision, 1);
  if (typeof key.key_id !== 'string' || !KS_ID_RE.test(key.key_id) || keyRevision === null) { throw scErr_('key_invalid', 'identity'); }

  /* The profile is named explicitly, must match the key, and must be verified for the question's own year. */
  if (!profileRef || profileRef.profile_id !== key.profile_id || String(profileRef.profile_version) !== String(key.profile_version)) { throw scErr_('key_invalid', 'profile_mismatch'); }
  var prof = scProfileFor_(profileRef.profile_id, profileRef.profile_version, q.year);
  if (!prof) { throw scErr_('blocked_policy', 'profile_unverified'); }

  function done(outcome, ruleId, award, provenance) {
    var flags = [];
    if (provenance === 'interpretation') { flags.push('interpretation_' + outcome); }
    return { status: 'scored', question_id: q.question_id, question_version: q.question_version, type: q.type, marks: q.marks,
      outcome: outcome, award: { num: award.num, den: award.den }, key_id: key.key_id, key_revision: keyRevision,
      rule: ruleId, provenance: provenance, flags: flags };
  }

  /* 1. Marks To All: its own outcome, regardless of the response. Gated (AK-03). */
  if (key.key_kind === 'marks_to_all') {
    ['mcq_answer', 'msq_answers', 'nat_lo', 'nat_hi', 'nat_lo_inclusive', 'nat_hi_inclusive', 'nat_scale', 'nat_source_form'].forEach(function (f) {
      if (key[f] !== '' && key[f] !== undefined && key[f] !== null) { throw scErr_('key_invalid', 'mta_has_answer_fields'); }
    });
    if (!pol.marks_to_all) { throw scPolicyBlock_('marks_to_all'); }
    if (!prof.marks_to_all) { throw scErr_('blocked_policy', 'profile_has_no_marks_to_all'); }
    return done('marks_to_all', 'MTA', scFrac_(q.marks, 1), prof.provenance['MTA']);
  }

  /* 2. Unanswered / cleared: zero under the site's interpretation. Gated. */
  if (scIsBlankResponse_(response)) {
    if (!pol.unanswered_zero) { throw scPolicyBlock_('unanswered_zero'); }
    return done('unanswered', q.type + '.unanswered', scAward_(prof, q.type, 'unanswered', q.marks), prof.provenance[q.type + '.unanswered']);
  }

  /* 3. Type rules. A malformed or unknown response blocks; it is never treated as correct and never silently as wrong. */
  var correct;
  if (q.type === 'MCQ') {
    var ans = key.mcq_answer;
    if (typeof ans !== 'string' || !KS_ID_RE.test(ans) || (q.options && !q.options[ans])) { throw scErr_('key_invalid', 'mcq_answer'); }
    if (typeof response !== 'string' || !KS_ID_RE.test(response) || (q.options && !q.options[response])) { throw scErr_('response_malformed'); }
    correct = response === ans;
  } else if (q.type === 'MSQ') {
    var keyIds = typeof key.msq_answers === 'string' && key.msq_answers ? key.msq_answers.split(',') : null;
    if (!keyIds || !keyIds.every(function (o) { return KS_ID_RE.test(o) && (!q.options || q.options[o]); })) { throw scErr_('key_invalid', 'msq_answers'); }
    keyIds = keyIds.slice().sort();
    if (keyIds.some(function (o, i) { return i > 0 && o === keyIds[i - 1]; })) { throw scErr_('key_invalid', 'msq_answers'); }
    if (!Array.isArray(response)) { throw scErr_('response_malformed'); }
    var seen = {};
    response.forEach(function (o) {
      if (typeof o !== 'string' || !KS_ID_RE.test(o) || seen[o] || (q.options && !q.options[o])) { throw scErr_('response_malformed'); }   /* duplicates and unknown ids */
      seen[o] = true;
    });
    var got = response.slice().sort();
    correct = got.length === keyIds.length && got.every(function (o, i) { return o === keyIds[i]; });   /* set equality, order ignored, no partial credit */
  } else {
    if (!pol.nat_syntax) { throw scPolicyBlock_('nat_syntax'); }
    if (!pol.nat_boundaries) { throw scPolicyBlock_('nat_boundaries'); }
    if (!pol.nat_rounding) { throw scPolicyBlock_('nat_rounding'); }
    if (typeof response !== 'string') { throw scErr_('response_malformed'); }
    var v = scParseResponseDecimal_(response);   /* exact, unrounded */
    if (!v) { throw scErr_('response_malformed'); }
    correct = scNatWithin_(v, key);              /* uses the key's explicit inclusivity flags; throws if absent or invalid */
  }
  var rule = q.type + (correct ? '.correct' : '.wrong');
  return done(correct ? 'correct' : 'wrong', rule, scAward_(prof, q.type, correct ? 'correct' : 'wrong', q.marks), prof.provenance[rule]);
}

/* Scores one question. Returns {status:'scored', outcome, award:{num,den}, ...} or {status:'blocked', code, reason}. Never throws. */
function scScoreQuestion_(question, response, key, profileRef, policy) {
  try { return scScoreQuestionCore_(question, response, key, profileRef, policy); }
  catch (e) { return scBlockedFrom_(e); }
}

/* ---------------------------------------------------------------------------------------------------
 * Attempt-level scoring. Pure given its inputs (apart from the HMAC secret used to re-verify the supplied keys).
 *
 * input = {
 *   questions: [ question records as for scScoreQuestion_, in attempt order, one pinned version per question_id ],
 *   responses: { question_id: response } (missing id = unanswered; an id not in questions blocks),
 *   keySets:   [ results of ksLoadApprovedKeySet_ (ok:true), covering the questions ],
 *   policy:    { gate: true } (explicit; default off)
 * }
 * Returns {status:'scored', total, max_marks, item_count, counts, items, profile_set, key_set_digest, key_set_digests, ...} or
 * {status:'blocked', code, reason, blocked:[{index, question_id, code, reason}]} with NO total and no partial score.
 * ------------------------------------------------------------------------------------------------- */
function scScoreAttempt_(input) {
  try { return scScoreAttemptCore_(input); }
  catch (e) { return scBlockedFrom_(e); }
}

function scScoreAttemptCore_(input) {
  if (!input || typeof input !== 'object') { throw scErr_('bad_input'); }
  var pol = scNormPolicy_(input.policy);
  var questions = input.questions;
  if (!Array.isArray(questions) || !questions.length || questions.length > SC_MAX_QUESTIONS) { throw scErr_('bad_input', 'questions'); }
  var responses = input.responses === undefined || input.responses === null ? {} : input.responses;
  if (typeof responses !== 'object' || Array.isArray(responses)) { throw scErr_('bad_input', 'responses'); }
  var sets = input.keySets;
  if (!Array.isArray(sets) || !sets.length) { throw scErr_('keys_unavailable', 'no_key_set'); }

  /* Keys: only a verified loader result is accepted, and it is re-verified (count, row_mac, digest) before any use. */
  var keyIndex = {}, setRefs = [], digests = [];
  sets.forEach(function (ks) {
    if (!ks || ks.ok !== true || !ks.key_set || !Array.isArray(ks.keys)) { throw scErr_('keys_unavailable', ks && typeof ks.code === 'string' ? ks.code : 'not_loaded'); }
    var meta = ks.key_set;
    if (ks.keys.length !== meta.item_count || !KS_HEX64_RE.test(String(meta.key_set_digest))) { throw scErr_('key_integrity_failed'); }
    ks.keys.forEach(function (k) {
      if (!k || k.key_set_id !== meta.key_set_id) { throw scErr_('key_integrity_failed'); }
      var ok = false;
      try { ok = ksVerifyRowMac_(k); } catch (e) { if (e && e.ksCode && /^mac_secret/.test(e.ksCode)) { throw e; } ok = false; }
      if (!ok) { throw scErr_('key_integrity_failed', 'row_mac'); }
    });
    if (!ksConstantTimeEquals_(ksKeySetDigest_(ks.keys), meta.key_set_digest)) { throw scErr_('key_integrity_failed', 'digest'); }
    var ref = { profile_id: meta.profile_id, profile_version: meta.profile_version };
    ks.keys.forEach(function (k) {
      var id = k.question_id + '|' + k.question_version;
      if (keyIndex[id]) { throw scErr_('key_ambiguous'); }
      keyIndex[id] = { key: k, ref: ref };
    });
    digests.push(meta.key_set_digest);
  });

  /* Questions: one pinned version per question_id; responses only for those questions. */
  var norm = questions.map(function (q) { return scNormQuestion_(q); }), byId = {}, years = {};
  norm.forEach(function (q) {
    if (byId[q.question_id]) { throw scErr_('bad_input', 'duplicate_question'); }
    byId[q.question_id] = true; years[q.year] = true;
  });
  Object.keys(responses).forEach(function (id) { if (!byId[id]) { throw scErr_('bad_input', 'response_for_unknown_question'); } });
  if (Object.keys(years).length > 1 && !pol.mixed_year) { throw scPolicyBlock_('mixed_year'); }

  var items = [], blocked = [], awards = [], used = [], profiles = {}, counts = { correct: 0, wrong: 0, unanswered: 0, marks_to_all: 0 }, max = 0;
  norm.forEach(function (q, i) {
    var entry = keyIndex[q.question_id + '|' + q.question_version], res;
    var response = Object.prototype.hasOwnProperty.call(responses, q.question_id) ? responses[q.question_id] : undefined;
    if (!entry) { res = { status: 'blocked', code: 'key_missing', reason: '' }; }
    else { res = scScoreQuestion_(questions[i], response, entry.key, entry.ref, input.policy); }
    if (res.status !== 'scored') {
      if (blocked.length < SC_MAX_QUESTIONS) { blocked.push({ index: i + 1, question_id: q.question_id, code: res.code, reason: res.reason }); }
      return;
    }
    res.position = i + 1;
    items.push(res); used.push(entry.key); counts[res.outcome]++;
    awards.push(scFrac_(res.award.num, res.award.den));
    max = scAddSafe_(max, q.marks);
    var p = scProfileFor_(entry.ref.profile_id, entry.ref.profile_version, q.year);
    profiles[scProfileRefText_(p)] = true;
  });
  if (blocked.length) {
    var policy = blocked.some(function (b) { return b.code === 'blocked_policy'; });
    return { status: 'blocked', code: policy ? 'blocked_policy' : blocked[0].code, reason: policy ? blocked.filter(function (b) { return b.code === 'blocked_policy'; })[0].reason : blocked[0].reason, blocked: blocked };
  }
  var total = scSum_(awards);
  return {
    status: 'scored', total: { num: total.num, den: total.den }, total_text: scText_(total), max_marks: max, item_count: items.length,
    counts: counts, items: items,
    profile_set: Object.keys(profiles).sort().join(','),
    key_set_digest: ksKeySetDigest_(used),   /* SHA-256 over the ordered (key_id, revision, row_mac) triples USED (spec 4.6) */
    key_set_digests: digests
  };
}

/* Convenience: load one verified key set through KeyStore, then score. Scoring itself runs outside the script lock. */
function scLoadAndScoreAttempt_(paperId, questions, responses, policy) {
  var loaded = ksLoadApprovedKeySet_(paperId);
  if (!loaded || loaded.ok !== true) { return { status: 'blocked', code: 'keys_unavailable', reason: loaded && loaded.code ? loaded.code : 'not_loaded' }; }
  return scScoreAttempt_({ questions: questions, responses: responses, keySets: [loaded], policy: policy });
}
