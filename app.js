/* GATE Prep Studio: shared front-end behaviour (app.js)
 *
 * Scope today:
 *  - password show/hide toggles
 *  - in-browser input checks on the login, register and reset forms
 *  - honest "not connected" messages for every action that needs the backend
 *  - the test-duration rule as a tested pure function
 *  - the practice catalogue: loads data/manifest.json first and lazily loads only selected public-safe
 *    paper/year shards after digest, count, schema, record and private-field validation; data/questions.json
 *    remains a backward-compatible fallback only when the manifest is absent (404/410)
 *  - the test setup summary and existing local question-bank import, kept separate from automatic shard loading
 *  - the exam attempt state machine (exam.html): in_progress / submitted / timed_out, a frozen deadline clock,
 *    in-memory responses (select, clear, mark for review, palette, summary), read-only once closed, snapshots that
 *    keep the original deadline, the intended attempt policy and year-specific marking profiles.
 *    exam.html is a LOCAL PREVIEW. It shows questions from a JSON file the person selected on practice.html
 *    (read in the browser, never uploaded; handed over through this tab's sessionStorage, public question content
 *    only). With no file it shows an empty state. It never starts a real attempt, saves, sends, times or scores
 *    anything, and holds no answer keys.
 *  - local question-bank import (practice.html): prepareLocalBank() validates a selected file with the same rules
 *    as data/questions.json, copies only allowlisted fields, and REJECTS the whole file if it contains answer
 *    keys, explanations or scoring fields.
 *
 * data/questions.json format (schema_version 1). Keep it PUBLIC-SAFE: it is served to every visitor.
 *   { "schema_version": 1,
 *     "placeholder": false,            // optional; true marks synthetic data, shown as a warning
 *     "questions": [ {
 *        "id": "unique-id",            // 1-64 chars: letters, digits . _ -
 *        "branch": "...", "year": 2020, "subject": "...", "topic": "...",
 *        "type": "MCQ" | "MSQ" | "NAT",
 *        "marks": 1,                   // positive whole number
 *        "text": "...",
 *        "options": [ {"id":"A","text":"..."}, ... ],   // MCQ and MSQ only, at least 2
 *        "source": { "name": "..." }   // provenance, required
 *     } ] }
 * Answer keys and explanations must NOT be put in this file. If present they are ignored (never loaded into
 * the page) and a warning is shown, but anyone can still read the file itself.
 *
 * The catalogue keeps metadata only (id, branch, year, subject, topic, type, marks, source name). Question
 * text and options are checked and then dropped, so nothing exam-sensitive is held by the practice page.
 *
 * Nothing here sends, stores or logs what the user types. api.js (read-only published catalogue loader, JSONP)
 * exists; auth.js does not because the authentication design has not been approved. A catalogue loaded through
 * api.js is run through prepareLocalBank() exactly like a local file. Browser checks are a convenience only; the server must
 * repeat every check when it exists.
 */
(function (root) {
  'use strict';

  /* ---------- Duration rule (fixed requirement) ----------
   * duration_minutes = total_selected_marks / 65 x 180, rounded to the nearest second.
   * 180 minutes = 10,800 seconds, so seconds = round(marks x 10800 / 65). */
  function durationSeconds(totalMarks) {
    if (typeof totalMarks !== 'number' || !isFinite(totalMarks) || totalMarks <= 0) {
      throw new RangeError('Total marks must be a positive number.');
    }
    return Math.round(totalMarks * 10800 / 65);
  }

  function formatDuration(totalSeconds) {
    var s = Math.round(totalSeconds);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return h + ' h ' + pad(m) + ' min ' + pad(sec) + ' s';
  }

  /* ---------- Input checks (mirror the HTML attributes; each returns '' when fine) ---------- */
  var USERNAME_RE = /^[A-Za-z0-9_]{3,30}$/;
  var GMAIL_RE = /^[A-Za-z0-9._%+\-]+@gmail\.com$/i;
  var CONTROL_RE = /[\u0000-\u001f\u007f]/;

  var check = {
    username: function (v) {
      return USERNAME_RE.test(v) ? '' : 'Use 3 to 30 letters, numbers or underscores.';
    },
    fullName: function (v) {
      var t = v.trim();
      if (!t) { return 'Enter your full name.'; }
      if (t.length > 100) { return 'Use 100 characters or fewer.'; }
      if (CONTROL_RE.test(t)) { return 'Remove special control characters.'; }
      return '';
    },
    gmail: function (v) {
      if (!v) { return 'Enter your Gmail address.'; }
      if (v.length > 254 || !GMAIL_RE.test(v)) { return 'Enter a Gmail address ending in @gmail.com.'; }
      return '';
    },
    newPassword: function (v) {
      if (v.length < 8) { return 'Use at least 8 characters.'; }
      if (v.length > 128) { return 'Use 128 characters or fewer.'; }
      return '';
    },
    confirm: function (v, original) {
      return v === original ? '' : 'The two passwords do not match.';
    },
    required: function (v, message) {
      return v.trim() ? '' : message;
    },
    otp: function (v) {
      if (!v) { return 'Enter the code from your email.'; }
      return /^[0-9]{1,12}$/.test(v) ? '' : 'The code contains digits only.';
    }
  };

  /* ================= Question bank (pure functions, tested in node) ================= */
  var BANK_URL = 'data/questions.json';
  var TYPES = ['MCQ', 'MSQ', 'NAT'];
  var FIELDS = ['branch', 'year', 'subject', 'topic', 'type'];
  var FIELD_LABEL = { branch: 'Branch', year: 'Year', subject: 'Subject', topic: 'Topic', type: 'Question type' };
  var ID_RE = /^[A-Za-z0-9_.\-]{1,64}$/;
  var has = Object.prototype.hasOwnProperty;

  /* Runtime gates are intentionally closed. A public status JSON or a browser setting can never open them. */
  var MARKING_RULES_CONFIRMED = false;
  var EXAM_ENGINE_AVAILABLE = false;
  var SCORING_BACKEND_READY = false;
  var EXAM_POLICY_APPROVED = false;
  var ANSWER_REVIEW_POLICY_APPROVED = false;

  function nonEmpty(v, max) {
    return typeof v === 'string' && v.trim().length > 0 && (!max || v.trim().length <= max);
  }
  function wholeNumber(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }

  /* Returns a list of reasons the record is unusable; empty list means valid. */
  function validateRecord(rec) {
    var reasons = [];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { return ['record is not an object']; }
    if (typeof rec.id !== 'string' || !ID_RE.test(rec.id)) {
      reasons.push('id is missing or is not 1 to 64 letters, digits, "." "_" or "-"');
    }
    ['branch', 'subject', 'topic'].forEach(function (f) {
      if (!nonEmpty(rec[f], 100)) { reasons.push(f + ' is missing or longer than 100 characters'); }
    });
    if (!wholeNumber(rec.year) || rec.year < 1900 || rec.year > 2100) {
      reasons.push('year must be a whole number from 1900 to 2100');
    }
    if (TYPES.indexOf(rec.type) < 0) { reasons.push('type must be MCQ, MSQ or NAT'); }
    if (!wholeNumber(rec.marks) || rec.marks <= 0) { reasons.push('marks must be a positive whole number'); }
    if (!nonEmpty(rec.text)) { reasons.push('question text is missing'); }
    if (rec.type === 'MCQ' || rec.type === 'MSQ') {
      var opts = rec.options;
      if (!Array.isArray(opts) || opts.length < 2) {
        reasons.push('MCQ and MSQ need at least 2 options');
      } else {
        var seen = Object.create(null), bad = false, dupe = false;
        opts.forEach(function (o) {
          if (!o || typeof o !== 'object' || !nonEmpty(o.id, 16) || !nonEmpty(o.text, 5000)) { bad = true; return; }
          if (seen[o.id]) { dupe = true; }
          seen[o.id] = true;
        });
        if (bad) { reasons.push('every option needs a non-empty id and text'); }
        if (dupe) { reasons.push('option ids must be unique within a question'); }
      }
    }
    if (!rec.source || typeof rec.source !== 'object' || !nonEmpty(rec.source.name, 200)) {
      reasons.push('source.name (provenance) is missing');
    }
    return reasons;
  }

  var BANK_MESSAGES = {
    missing: 'No question bank has been imported yet (data/questions.json was not found). Practice cannot start until one is added.',
    unreachable: 'The question bank could not be loaded. If you opened this page as a local file, serve the folder from a web server instead; otherwise check your connection.',
    error: 'The question bank could not be loaded because the server returned an error.',
    invalid_json: 'The question bank file is not valid JSON (or the server returned something other than the file), so it was not used.',
    invalid: 'The question bank file does not follow the expected format (it needs "schema_version": 1 and a "questions" list), so it was not used.',
    empty: 'The question bank contains no usable questions.'
  };

  /* Turns parsed JSON into a catalogue of metadata-only records. Never throws. */
  function prepareCatalogue(raw) {
    var out = { status: 'ready', message: '', records: [], rejected: [], warnings: [], total: 0,
                sources: [], placeholder: false };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schema_version !== 1 || !Array.isArray(raw.questions)) {
      out.status = 'invalid'; out.message = BANK_MESSAGES.invalid; return out;
    }
    out.total = raw.questions.length;
    out.placeholder = raw.placeholder === true;
    var seenIds = Object.create(null), sourceSet = Object.create(null), withKeys = 0;
    raw.questions.forEach(function (rec, i) {
      var reasons = validateRecord(rec);
      var id = rec && typeof rec.id === 'string' ? rec.id : null;
      if (!reasons.length && seenIds[id]) { reasons.push('duplicate id "' + id + '" (the first occurrence is kept)'); }
      if (reasons.length) { out.rejected.push({ index: i, id: id, reasons: reasons }); return; }
      seenIds[id] = true;
      if (has.call(rec, 'answer_key') || has.call(rec, 'explanation')) { withKeys++; }
      sourceSet[rec.source.name.trim()] = true;
      out.records.push({ id: id, branch: rec.branch.trim(), year: rec.year, subject: rec.subject.trim(),
                         topic: rec.topic.trim(), type: rec.type, marks: rec.marks, source: rec.source.name.trim() });
    });
    out.sources = Object.keys(sourceSet).sort();
    if (withKeys) {
      out.warnings.push(withKeys + ' record(s) include an answer key or explanation. They were ignored, but anyone ' +
        'can read data/questions.json, so keep answer keys out of this file.');
    }
    if (out.placeholder) {
      out.warnings.push('This question bank is marked as placeholder data. It is not a set of real GATE questions.');
    }
    if (!out.records.length) {
      out.status = 'empty';
      out.message = out.total ? 'The question bank has ' + out.total + ' record(s), but none are usable. See the details below.'
                              : BANK_MESSAGES.empty;
      return out;
    }
    out.message = 'Question bank loaded: ' + out.records.length + ' usable question' + (out.records.length === 1 ? '' : 's') +
      (out.rejected.length ? ', ' + out.rejected.length + ' record(s) not used.' : '.');
    return out;
  }

  /* Fetches and prepares the bank. Resolves (never rejects) to an object with a status. */
  function loadBank(fetchFn, url) {
    function fail(status) {
      return { status: status, message: BANK_MESSAGES[status], records: [], rejected: [], warnings: [],
               total: 0, sources: [], placeholder: false };
    }
    if (typeof fetchFn !== 'function') { return Promise.resolve(fail('unreachable')); }
    return Promise.resolve().then(function () { return fetchFn(url || BANK_URL, { cache: 'no-cache' }); })
      .then(function (res) {
        if (res.status === 404) { return fail('missing'); }
        if (!res.ok) { return fail('error'); }
        return res.text().then(function (text) {
          var raw;
          try { raw = JSON.parse(text); } catch (e) { return fail('invalid_json'); }
          return prepareCatalogue(raw);
        });
      }, function () { return fail('unreachable'); });
  }

  /* ================= Manifest-driven paper/year loader (Task 49; pure, tested in node) =================
   * data/manifest.json lists every published shard explicitly; nothing is inferred from user input:
   *   { "schema_version": 1, "release": "2026-01", "placeholder": false,          // placeholder optional; true = synthetic data
   *     "shards": [ { "id": "CS-2024", "paper_code": "CS", "paper_name": "Computer Science and Information Technology", "year": 2024,
   *                   "path": "papers/CS/2024.json", "question_count": 65, "sha256": "<64 lowercase hex>" },
   *                 { "id": "CS-2025-1", "paper_code": "CS", "paper_name": "...", "year": 2025, "variant": "1",    // optional official set
   *                   "path": "papers/CS/2025/CS-1.json", "question_count": 65, "sha256": "..." } ] }
   * path is relative to data/ and must be papers/<CODE>/<year>.json (no variant) or papers/<CODE>/<year>/<file>.json (variant), where CODE and
   * year equal the entry's own values. sha256 is the SHA-256 of the shard file's exact bytes (UTF-8, no byte-order mark). A shard keeps the existing
   * public-safe format ({schema_version: 1, questions: [...]}); answer-related fields anywhere in it make the whole shard fail.
   * Choices (papers, years, sets) are derived from the manifest only. A paper/year with several official sets is never merged: one set is chosen. */
  var DATA_BASE = 'data/';
  var MANIFEST_URL = DATA_BASE + 'manifest.json';
  var MANIFEST_LIMITS = Object.freeze({ manifestChars: 262144, shards: 500, shardChars: 2 * 1024 * 1024, shardQuestions: 1000 });
  var MANIFEST_KEYS = ['schema_version', 'release', 'placeholder', 'shards'];
  var SHARD_ENTRY_KEYS = ['id', 'paper_code', 'paper_name', 'year', 'variant', 'path', 'question_count', 'sha256'];
  var PAPER_CODE_RE = /^[A-Z]{2}$/;                       /* official GATE paper codes are two capital letters; the list itself lives in the manifest, not here */
  var SHARD_ID_RE = /^[A-Za-z0-9._\-]{1,64}$/;
  var RELEASE_RE = /^[A-Za-z0-9._\-]{1,64}$/;
  var VARIANT_RE = /^[A-Za-z0-9_\-]{1,16}$/;
  var SHA256_RE = /^[0-9a-f]{64}$/;
  var SHARD_PATH_RE = /^papers\/([A-Z]{2})\/(\d{4})(?:\/([A-Za-z0-9][A-Za-z0-9_\-]{0,31}))?\.json$/;

  var MANIFEST_MESSAGES = {
    unreachable: 'The list of published papers (data/manifest.json) could not be loaded. If you opened this page as a local file, serve the folder from a web server instead; otherwise check your connection. No questions were loaded.',
    error: 'The list of published papers could not be loaded because the server returned an error. No questions were loaded.',
    invalid_json: 'The list of published papers (data/manifest.json) is not valid JSON, so it was not used and no questions were loaded.',
    too_large: 'The list of published papers is larger than this page accepts, so it was not used and no questions were loaded.',
    invalid: 'The list of published papers (data/manifest.json) is malformed, so it was not used and no questions were loaded. The older question file was deliberately not used instead.'
  };
  var SHARD_MESSAGES = {
    unreachable: 'The question files could not be loaded (no network access to them). Nothing was loaded.',
    selection_invalid: 'That paper and year is not in the published list. Nothing was loaded.',
    variant_required: 'This paper and year has more than one official set. Choose one set; sets are never merged. Nothing was loaded.',
    shard_missing: 'a question file listed in the manifest was not found',
    shard_error: 'the server returned an error for a question file',
    shard_unreachable: 'a question file could not be fetched',
    shard_too_large: 'a question file is larger than this page accepts',
    digest_unavailable: 'this browser cannot verify file digests here (a secure https:// or localhost page is needed), so the file was not trusted',
    shard_digest_mismatch: 'the file does not match the digest recorded in the manifest',
    shard_invalid_json: 'a question file is not valid JSON',
    shard_private_fields: 'a question file contains answer-key, explanation or scoring-type fields and was refused',
    shard_invalid: 'a question file does not follow the expected format',
    shard_count_mismatch: 'a question file does not contain the number of questions the manifest declares',
    shard_invalid_records: 'a question file contains records that fail validation',
    shard_duplicate_ids: 'a question file repeats a question id',
    shard_failed_unexpected: 'a question file could not be checked'
  };

  function isPlain(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }

  /* Strict manifest check. Returns { status: 'ready' | 'invalid', problems: [short reasons], manifest }. manifest is null unless ready. Never throws. */
  function validateManifest(raw) {
    var problems = [], out = { status: 'invalid', problems: problems, manifest: null };
    function bad(m) { if (problems.length < 25) { problems.push(m); } }
    if (!isPlain(raw)) { bad('the manifest is not a JSON object'); return out; }
    Object.keys(raw).forEach(function (k) { if (MANIFEST_KEYS.indexOf(k) < 0) { bad('unknown manifest field "' + k.slice(0, 40) + '"'); } });
    if (raw.schema_version !== 1) { bad('schema_version must be 1'); }
    if (typeof raw.release !== 'string' || !RELEASE_RE.test(raw.release)) { bad('release must be 1 to 64 letters, digits, ".", "_" or "-"'); }
    if (has.call(raw, 'placeholder') && typeof raw.placeholder !== 'boolean') { bad('placeholder must be true or false'); }
    if (!Array.isArray(raw.shards) || !raw.shards.length) { bad('shards must be a non-empty list'); return out; }
    if (raw.shards.length > MANIFEST_LIMITS.shards) { bad('more than ' + MANIFEST_LIMITS.shards + ' shards'); return out; }
    var ids = Object.create(null), paths = Object.create(null), idents = Object.create(null), names = Object.create(null), years = Object.create(null), entries = [];
    raw.shards.forEach(function (s, i) {
      var tag = 'shard #' + (i + 1), n = problems.length;
      if (!isPlain(s)) { bad(tag + ' is not an object'); return; }
      Object.keys(s).forEach(function (k) { if (SHARD_ENTRY_KEYS.indexOf(k) < 0) { bad(tag + ' has unknown field "' + k.slice(0, 40) + '"'); } });
      if (typeof s.id !== 'string' || !SHARD_ID_RE.test(s.id)) { bad(tag + ': id must be 1 to 64 letters, digits, ".", "_" or "-"'); }
      if (typeof s.paper_code !== 'string' || !PAPER_CODE_RE.test(s.paper_code)) { bad(tag + ': paper_code must be two capital letters'); }
      if (!nonEmpty(s.paper_name, 100)) { bad(tag + ': paper_name is missing or longer than 100 characters'); }
      if (!wholeNumber(s.year) || s.year < 1900 || s.year > 2100) { bad(tag + ': year must be a whole number from 1900 to 2100'); }
      var hasVariant = has.call(s, 'variant');
      if (hasVariant && (typeof s.variant !== 'string' || !VARIANT_RE.test(s.variant))) { bad(tag + ': variant must be 1 to 16 letters, digits, "_" or "-"'); }
      if (!wholeNumber(s.question_count) || s.question_count < 1 || s.question_count > MANIFEST_LIMITS.shardQuestions) { bad(tag + ': question_count must be a whole number from 1 to ' + MANIFEST_LIMITS.shardQuestions); }
      if (typeof s.sha256 !== 'string' || !SHA256_RE.test(s.sha256)) { bad(tag + ': sha256 must be 64 lowercase hex characters'); }
      var pm = typeof s.path === 'string' ? SHARD_PATH_RE.exec(s.path) : null;
      if (!pm) { bad(tag + ': path is not an allowed relative shard path'); }
      else {
        if (pm[1] !== s.paper_code || Number(pm[2]) !== s.year) { bad(tag + ': path does not match its paper_code and year'); }
        if (hasVariant !== (pm[3] !== undefined)) { bad(tag + ': a set needs a path of the form papers/<CODE>/<year>/<file>.json and a single paper/year file must not name one'); }
      }
      if (problems.length > n) { return; }                           /* this entry is unusable: skip the cross-entry checks for it */
      var ident = s.paper_code + '|' + s.year + '|' + (hasVariant ? s.variant : '');
      if (ids[s.id]) { bad(tag + ': duplicate shard id "' + s.id + '"'); }
      if (paths[s.path]) { bad(tag + ': duplicate path'); }
      if (idents[ident]) { bad(tag + ': duplicate paper/year/set identity (' + s.paper_code + ' ' + s.year + (hasVariant ? ' set ' + s.variant : '') + ')'); }
      if (names[s.paper_code] && names[s.paper_code] !== s.paper_name.trim()) { bad(tag + ': paper ' + s.paper_code + ' is given two different names'); }
      var yk = s.paper_code + '|' + s.year, kinds = years[yk] || (years[yk] = { plain: 0, sets: 0 });
      if (hasVariant) { kinds.sets++; } else { kinds.plain++; }
      if (kinds.plain && kinds.sets) { bad(tag + ': ' + s.paper_code + ' ' + s.year + ' mixes a set-less file with sets'); }
      ids[s.id] = paths[s.path] = idents[ident] = true; names[s.paper_code] = s.paper_name.trim();
      entries.push({ id: s.id, paper_code: s.paper_code, paper_name: s.paper_name.trim(), year: s.year, variant: hasVariant ? s.variant : '',
                     path: s.path, question_count: s.question_count, sha256: s.sha256 });
    });
    if (problems.length) { return out; }
    out.status = 'ready';
    out.manifest = { schema_version: 1, release: raw.release, placeholder: raw.placeholder === true, shards: entries };
    return out;
  }

  /* Papers, years and sets for the selectors, taken only from the manifest. */
  function manifestChoices(manifest) {
    var papers = Object.create(null);
    (manifest && manifest.shards || []).forEach(function (s) {
      var p = papers[s.paper_code] || (papers[s.paper_code] = { code: s.paper_code, name: s.paper_name, years: Object.create(null) });
      var y = p.years[s.year] || (p.years[s.year] = { year: s.year, variants: [] });
      if (s.variant) { y.variants.push(s.variant); }
    });
    return Object.keys(papers).sort().map(function (c) {
      var p = papers[c];
      return { code: p.code, name: p.name, years: Object.keys(p.years).map(Number).sort(function (a, b) { return b - a; }).map(function (yr) {
        var y = p.years[yr]; y.variants.sort(); return { year: yr, variants: y.variants, setRequired: y.variants.length > 1 };
      }) };
    });
  }

  /* sel: { paper, year | years, variant? }. Exactly the entries of the chosen paper/year(s); a year with several sets needs the set named. */
  function resolveShards(manifest, sel) {
    function no(code, extra) { return { ok: false, code: code, message: SHARD_MESSAGES[code], detail: extra || '', entries: [] }; }
    if (!manifest || !Array.isArray(manifest.shards) || !isPlain(sel) || typeof sel.paper !== 'string') { return no('selection_invalid'); }
    var years = Array.isArray(sel.years) ? sel.years : [sel.year];
    if (!years.length || years.length > 50) { return no('selection_invalid'); }
    var entries = [], seen = Object.create(null);
    for (var i = 0; i < years.length; i++) {
      var y = typeof years[i] === 'string' && /^\d{4}$/.test(years[i]) ? Number(years[i]) : years[i];
      if (!wholeNumber(y) || seen[y]) { return no('selection_invalid'); }
      seen[y] = true;
      var cands = manifest.shards.filter(function (s) { return s.paper_code === sel.paper && s.year === y; });
      if (sel.variant !== undefined && sel.variant !== null && sel.variant !== '') { cands = cands.filter(function (s) { return s.variant === sel.variant; }); }
      if (!cands.length) { return no('selection_invalid'); }
      if (cands.length > 1) { return no('variant_required'); }
      entries.push(cands[0]);
    }
    return { ok: true, code: '', message: '', detail: '', entries: entries };
  }

  /* ---- fetching ---- */
  function utf8Bytes(text) {
    if (typeof TextEncoder === 'function') { return new TextEncoder().encode(text); }
    var s = unescape(encodeURIComponent(text)), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) { out[i] = s.charCodeAt(i); }
    return out;
  }
  function toHex(buf) {
    var b = new Uint8Array(buf), h = '';
    for (var i = 0; i < b.length; i++) { h += (b[i] < 16 ? '0' : '') + b[i].toString(16); }
    return h;
  }
  /* SHA-256 of bytes -> lowercase hex. Rejects when no implementation exists: a digest that cannot be computed is never skipped. */
  function defaultDigest(bytes) {
    var subtle = root.crypto && root.crypto.subtle;
    if (subtle && typeof subtle.digest === 'function') { return subtle.digest('SHA-256', bytes).then(toHex); }
    if (typeof require === 'function') {
      try { var nc = require('crypto'); return Promise.resolve(nc.createHash('sha256').update(Buffer.from(bytes)).digest('hex')); } catch (e) { /* fall through */ }
    }
    return Promise.reject(new Error('no digest'));
  }

  /* Resolves (never rejects) to { status, message, manifest, problems }. status 'absent' (404/410) is the only one that permits the legacy fallback. */
  function loadManifest(fetchFn, url) {
    function done(status, problems) { return { status: status, message: MANIFEST_MESSAGES[status] || '', manifest: null, problems: problems || [], choices: [] }; }
    if (typeof fetchFn !== 'function') { return Promise.resolve(done('unreachable')); }
    return Promise.resolve().then(function () { return fetchFn(url || MANIFEST_URL, { cache: 'no-cache' }); })
      .then(function (res) {
        if (res.status === 404 || res.status === 410) { return done('absent'); }
        if (!res.ok) { return done('error'); }
        return res.text().then(function (text) {
          if (typeof text !== 'string' || text.length > MANIFEST_LIMITS.manifestChars) { return done('too_large'); }
          var raw; try { raw = JSON.parse(text); } catch (e) { return done('invalid_json'); }
          var v = validateManifest(raw);
          if (v.status !== 'ready') { return done('invalid', v.problems); }
          var r = done('ready'); r.manifest = v.manifest; r.choices = manifestChoices(v.manifest); r.message = 'Published papers loaded (release ' + v.manifest.release + '): choose a paper and year.';
          return r;
        });
      }, function () { return done('unreachable'); });
  }

  /* Public-safe check of one shard's parsed JSON against its manifest entry. Returns { ok, code, lines, rejected, records, sources, placeholder }. */
  function checkShard(raw, entry) {
    var res = { ok: false, code: '', lines: [], rejected: [], records: [], questions: [], sources: [], placeholder: false };
    function fail(code, line) { res.code = code; if (line) { res.lines.push(entry.id + ': ' + line); } return res; }
    if (!isPlain(raw) || !Array.isArray(raw.questions)) { return fail('shard_invalid'); }
    var found = [];
    Object.keys(raw).forEach(function (k) { if (k !== 'questions' && PRIVATE_FIELD_NAMES.indexOf(normKey(k)) >= 0) { found.push(k); } });
    raw.questions.forEach(function (rec, i) { if (found.length < MAX_PRIVATE_FINDINGS) { scanPrivate(rec, 'record #' + (i + 1), found, 0); } });
    if (found.length) { return fail('shard_private_fields', 'answer-related fields were found (' + found.length + '). The whole file was refused.'); }
    if (raw.schema_version !== 1) { return fail('shard_invalid', 'schema_version must be 1.'); }
    var extra = Object.keys(raw).filter(function (k) { return ['schema_version', 'questions', 'placeholder'].indexOf(k) < 0; });
    if (extra.length || (has.call(raw, 'placeholder') && typeof raw.placeholder !== 'boolean')) { return fail('shard_invalid', 'unexpected top-level fields.'); }
    if (raw.questions.length !== entry.question_count) { return fail('shard_count_mismatch', 'the manifest declares ' + entry.question_count + ' questions but the file has ' + raw.questions.length + '.'); }
    var seen = Object.create(null), src = Object.create(null), dupe = false;
    raw.questions.forEach(function (rec, i) {
      var reasons = validateRecord(rec);
      if (!reasons.length) { reasons = extraLocalChecks(rec); }
      if (!reasons.length && rec.year !== entry.year) { reasons.push('year ' + rec.year + ' does not match the shard year ' + entry.year); }
      var id = rec && typeof rec.id === 'string' && ID_RE.test(rec.id) ? rec.id : null;
      if (!reasons.length && seen[id]) { dupe = true; reasons.push('duplicate id "' + id + '" within the file'); }
      if (reasons.length) { res.rejected.push({ index: i, id: id, reasons: reasons }); return; }
      seen[id] = true; src[rec.source.name.trim()] = true;
      res.records.push({ id: id, branch: rec.branch.trim(), year: rec.year, subject: rec.subject.trim(), topic: rec.topic.trim(), type: rec.type, marks: rec.marks,
                         source: rec.source.name.trim(), paper: entry.paper_code, set: entry.variant, shard: entry.id });
      /* The manifest digest, count, schema and private-field checks have passed. Preserve a second, strict
       * allowlist so this selected shard can feed the same safe local preview as an imported bank. */
      var q = { id: id, branch: rec.branch.trim(), year: rec.year, subject: rec.subject.trim(), topic: rec.topic.trim(),
                type: rec.type, marks: rec.marks, text: rec.text.trim(), source: { name: rec.source.name.trim() } };
      if (rec.type !== 'NAT') { q.options = rec.options.map(function (o) { return { id: o.id.trim(), text: o.text.trim() }; }); }
      res.questions.push(q);
    });
    if (res.rejected.length) {
      res.records = [];
      res.rejected.slice(0, 5).forEach(function (r) { res.lines.push(entry.id + ' record #' + (r.index + 1) + (r.id ? ' (' + r.id + ')' : '') + ': ' + r.reasons.join('; ') + '.'); });
      res.code = dupe ? 'shard_duplicate_ids' : 'shard_invalid_records'; return res;
    }
    res.sources = Object.keys(src); res.placeholder = raw.placeholder === true; res.ok = true;
    return res;
  }

  /* One shard: fetch, size, DIGEST, parse, check, in that order. Resolves (never rejects) to { entry, ok, code, check }. */
  function loadOneShard(fetchFn, entry, base, digestFn) {
    function bad(code, check) { return { entry: entry, ok: false, code: code, check: check || null }; }
    return Promise.resolve().then(function () { return fetchFn(base + entry.path, { cache: 'no-cache' }); })
      .then(function (res) {
        if (res.status === 404 || res.status === 410) { return bad('shard_missing'); }
        if (!res.ok) { return bad('shard_error'); }
        return res.text().then(function (text) {
          if (typeof text !== 'string' || text.length > MANIFEST_LIMITS.shardChars) { return bad('shard_too_large'); }
          return Promise.resolve().then(function () { return digestFn(utf8Bytes(text)); }).then(function (hex) {
            if (hex !== entry.sha256) { return bad('shard_digest_mismatch'); }           /* nothing from the file is read before this passes */
            var raw; try { raw = JSON.parse(text); } catch (e) { return bad('shard_invalid_json'); }
            var c = checkShard(raw, entry);
            return c.ok ? { entry: entry, ok: true, code: '', check: c } : bad(c.code, c);
          }, function () { return bad('digest_unavailable'); });
        }, function () { return bad('shard_unreachable'); });
      }, function () { return bad('shard_unreachable'); })
      .catch(function () { return bad('shard_failed_unexpected'); });
  }

  /* Loads exactly the given manifest entries and combines them. Resolves (never rejects). status 'ready' ONLY when every file was fetched, matched its
   * digest and count and passed every check; anything else yields no records at all, so a partial set can never look like a complete one. */
  function loadShards(fetchFn, entries, opts) {
    opts = opts || {};
    var base = opts.base || DATA_BASE, digestFn = opts.digest || defaultDigest;
    function out(status, message) {
      return { origin: 'manifest', status: status, message: message, records: [], questions: [], rejected: [], warnings: [], total: 0, sources: [], placeholder: false, shards: [], failures: [] };
    }
    if (typeof fetchFn !== 'function') { return Promise.resolve(out('unreachable', SHARD_MESSAGES.unreachable)); }
    if (!Array.isArray(entries) || !entries.length) { return Promise.resolve(out('selection_invalid', SHARD_MESSAGES.selection_invalid)); }
    return Promise.all(entries.map(function (e) { return loadOneShard(fetchFn, e, base, digestFn); })).then(function (results) {
      var failed = results.filter(function (r) { return !r.ok; });
      if (failed.length) {
        var o = out('shard_failed', failed.length + ' of ' + results.length + ' question file' + (results.length === 1 ? '' : 's') + ' could not be used, so nothing was loaded. The data is incomplete and was not treated as a result.');
        failed.forEach(function (f) {
          o.failures.push({ shard: f.entry.id, code: f.code });
          o.warnings.push(f.check && f.check.lines.length ? f.check.lines.join(' ') : f.entry.id + ': ' + SHARD_MESSAGES[f.code] + '.');
        });
        return o;
      }
      var records = [], ids = Object.create(null), dup = [], src = Object.create(null), placeholder = opts.placeholder === true;
      results.forEach(function (r) {
        r.check.records.forEach(function (rec) { if (ids[rec.id]) { dup.push(rec.id); } else { ids[rec.id] = true; records.push(rec); } });
        r.check.sources.forEach(function (s) { src[s] = true; });
        if (r.check.placeholder) { placeholder = true; }
      });
      if (dup.length) {
        var d = out('duplicate_ids', dup.length + ' question id' + (dup.length === 1 ? ' is' : 's are') + ' used by more than one selected file, so nothing was loaded.');
        d.warnings.push('Repeated ids include: ' + dup.slice(0, 5).join(', ') + '.'); return d;
      }
      var r = out('ready', '');
      r.records = records; r.questions = results.reduce(function (all, x) { return all.concat(x.check.questions || []); }, []);
      r.total = records.length; r.sources = Object.keys(src).sort(); r.placeholder = placeholder;
      r.shards = results.map(function (x) { return { id: x.entry.id, paper: x.entry.paper_code, year: x.entry.year, variant: x.entry.variant, count: x.check.records.length }; });
      if (placeholder) { r.warnings.push('This question bank is marked as placeholder data. It is not a set of real GATE questions.'); }
      var label = results.map(function (x) { return x.entry.paper_code + ' ' + x.entry.year + (x.entry.variant ? ' set ' + x.entry.variant : ''); }).join(', ');
      r.message = 'Loaded ' + label + ': ' + records.length + ' usable question' + (records.length === 1 ? '' : 's') + ' from ' + results.length + ' file' + (results.length === 1 ? '' : 's') + ', each checked against the published manifest.';
      return r;
    });
  }

  /* Selection -> shards -> combined catalogue. Fetches only the chosen files. */
  function loadPaper(fetchFn, manifest, sel, opts) {
    var r = resolveShards(manifest, sel);
    opts = Object.assign({}, opts || {}, { placeholder: manifest && manifest.placeholder === true });
    if (!r.ok) {
      return Promise.resolve({ origin: 'manifest', status: r.code, message: r.message, records: [], rejected: [], warnings: [], total: 0, sources: [], placeholder: false, shards: [], failures: [] });
    }
    return loadShards(fetchFn, r.entries, opts);
  }

  /* Entry point for the practice page. Manifest first: absent (404/410) -> the legacy data/questions.json loader, unchanged. Present but unusable
   * (malformed, unreachable, server error) -> a failure with no fallback, so unrelated legacy data is never loaded instead. Resolves (never rejects). */
  function loadCatalogue(fetchFn, opts) {
    opts = opts || {};
    return loadManifest(fetchFn, opts.manifestUrl).then(function (m) {
      if (m.status === 'absent') { return loadBank(fetchFn, opts.legacyUrl).then(function (b) { b.origin = 'legacy'; return { mode: 'legacy', status: b.status, bank: b }; }); }
      if (m.status === 'ready') { return { mode: 'manifest', status: 'ready', manifest: m.manifest, choices: m.choices, message: m.message, problems: [] }; }
      return { mode: 'manifest', status: m.status, manifest: null, choices: [], message: m.message, problems: m.problems };
    });
  }

  /* ================= Local question-bank import (untrusted input; pure, tested in node) =================
   * Used when the person selects a JSON file on their own computer. The file is treated as untrusted:
   *  - only allowlisted fields are copied into the preview (RECORD_FIELDS, OPTION_FIELDS, source.name);
   *  - if ANY answer-key, explanation or scoring-type field is present anywhere in the file, the WHOLE import
   *    is rejected and nothing is loaded (the data/questions.json loader above only ignores such fields);
   *  - every record goes through the same validateRecord() used for data/questions.json, plus size and id limits;
   *  - nothing is invented: a record with missing or invalid metadata is rejected with its reasons, never repaired.
   * Returns { status: 'ready' | 'invalid' | 'empty' | 'rejected_private', message, records (metadata, same shape as
   * the catalogue), questions (allowlisted text and options for the preview), rejected, privateFields, warnings,
   * ignoredFields, total, sources, placeholder }. Never throws. */
  var LOCAL_LIMITS = Object.freeze({ fileBytes: 5 * 1024 * 1024, questions: 2000, text: 20000 });
  var RECORD_FIELDS = Object.freeze(['id', 'branch', 'year', 'subject', 'topic', 'type', 'marks', 'text', 'options', 'source']);
  var OPTION_FIELDS = Object.freeze(['id', 'text']);
  var OPTION_ID_RE = /^[A-Za-z0-9_.\-]{1,16}$/;
  /* Compared after lower-casing and removing every non-letter/digit, so answer_key, answerKey and "Answer Key" all match. */
  var PRIVATE_FIELD_NAMES = Object.freeze(['answerkey', 'answer', 'answers', 'ans', 'correctanswer', 'correctanswers',
    'correctoption', 'correctoptions', 'correct', 'iscorrect', 'key', 'keys', 'solution', 'solutions', 'explanation',
    'explanations', 'rationale', 'officialanswer', 'acceptedanswers', 'answerrange', 'natrange', 'natmin', 'natmax',
    'tolerance', 'score', 'scores', 'scoring', 'markscheme', 'markingscheme', 'markstoall', 'mta', 'secret']);
  var MAX_PRIVATE_FINDINGS = 200;

  function normKey(k) { return String(k).toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function scanPrivate(node, where, out, depth) {
    if (depth > 6 || !node || typeof node !== 'object' || out.length >= MAX_PRIVATE_FINDINGS) { return; }
    if (Array.isArray(node)) {
      node.forEach(function (v, i) { scanPrivate(v, where + '[' + (i + 1) + ']', out, depth + 1); });
      return;
    }
    Object.keys(node).forEach(function (k) {
      if (out.length >= MAX_PRIVATE_FINDINGS) { return; }
      if (PRIVATE_FIELD_NAMES.indexOf(normKey(k)) >= 0) { out.push({ where: where, field: k.slice(0, 40) }); }
      scanPrivate(node[k], where + '.' + k.slice(0, 40), out, depth + 1);
    });
  }

  /* Extra checks on top of validateRecord(); same wording style. */
  function extraLocalChecks(rec) {
    var reasons = [];
    if (rec.text.length > LOCAL_LIMITS.text) { reasons.push('question text is longer than ' + LOCAL_LIMITS.text + ' characters'); }
    if (rec.type === 'MCQ' || rec.type === 'MSQ') {
      var seen = Object.create(null), badId = false, dupe = false;
      rec.options.forEach(function (o) {
        var oid = o.id.trim();
        if (!OPTION_ID_RE.test(oid)) { badId = true; }
        if (seen[oid]) { dupe = true; }
        seen[oid] = true;
      });
      if (badId) { reasons.push('option ids must be 1 to 16 letters, digits, \".\" \"_\" or \"-\"'); }
      if (dupe) { reasons.push('option ids must be unique within a question (ignoring spaces)'); }
    }
    return reasons;
  }

  function prepareLocalBank(raw) {
    var out = { local: true, status: 'ready', message: '', records: [], questions: [], rejected: [], privateFields: [],
                warnings: [], ignoredFields: [], total: 0, sources: [], placeholder: false };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schema_version !== 1 || !Array.isArray(raw.questions)) {
      out.status = 'invalid'; out.message = BANK_MESSAGES.invalid; return out;
    }
    out.total = raw.questions.length;
    if (out.total > LOCAL_LIMITS.questions) {
      out.status = 'invalid';
      out.message = 'The file has ' + out.total + ' records. The local preview accepts at most ' + LOCAL_LIMITS.questions + '. Nothing was loaded.';
      return out;
    }
    /* 1. Private fields anywhere in the file reject the whole import. */
    var found = out.privateFields;
    Object.keys(raw).forEach(function (k) {
      if (k !== 'questions' && PRIVATE_FIELD_NAMES.indexOf(normKey(k)) >= 0) { found.push({ where: 'top level of the file', field: k.slice(0, 40) }); }
    });
    raw.questions.forEach(function (rec, i) {
      if (found.length >= MAX_PRIVATE_FINDINGS) { return; }
      var id = rec && typeof rec === 'object' && typeof rec.id === 'string' && ID_RE.test(rec.id) ? rec.id : null;
      scanPrivate(rec, 'record #' + (i + 1) + (id ? ' (' + id + ')' : ''), found, 0);
    });
    if (found.length) {
      out.status = 'rejected_private';
      out.message = 'Import rejected: the file contains answer-key, explanation or scoring-type fields (' +
        (found.length >= MAX_PRIVATE_FINDINGS ? MAX_PRIVATE_FINDINGS + '+' : found.length) + ' found). ' +
        'Questions for this preview must be public-safe. Remove those fields from the file and select it again. Nothing was loaded.';
      return out;
    }
    /* 2. Validate every record with the existing rules, then copy only allowlisted fields. */
    var seenIds = Object.create(null), sourceSet = Object.create(null), ignored = Object.create(null);
    raw.questions.forEach(function (rec, i) {
      var reasons = validateRecord(rec);
      var id = rec && typeof rec === 'object' && typeof rec.id === 'string' && ID_RE.test(rec.id) ? rec.id : null;
      if (!reasons.length) { reasons = extraLocalChecks(rec); }
      if (!reasons.length && seenIds[id]) { reasons.push('duplicate id \"' + id + '\" (the first occurrence is kept)'); }
      if (reasons.length) { out.rejected.push({ index: i, id: id, reasons: reasons }); return; }
      seenIds[id] = true;
      Object.keys(rec).forEach(function (k) { if (RECORD_FIELDS.indexOf(k) < 0) { ignored[k.slice(0, 40)] = true; } });
      Object.keys(rec.source).forEach(function (k) { if (k !== 'name') { ignored['source.' + k.slice(0, 30)] = true; } });
      var q = { id: id, branch: rec.branch.trim(), year: rec.year, subject: rec.subject.trim(), topic: rec.topic.trim(),
                type: rec.type, marks: rec.marks, text: rec.text.trim(), source: { name: rec.source.name.trim() } };
      if (rec.type === 'NAT') {
        if (has.call(rec, 'options')) { ignored['options (not used for NAT)'] = true; }
      } else {
        q.options = rec.options.map(function (o) {
          Object.keys(o).forEach(function (k) { if (OPTION_FIELDS.indexOf(k) < 0) { ignored['options.' + k.slice(0, 30)] = true; } });
          return { id: o.id.trim(), text: o.text.trim() };
        });
      }
      sourceSet[q.source.name] = true;
      out.questions.push(q);
      out.records.push({ id: id, branch: q.branch, year: q.year, subject: q.subject, topic: q.topic, type: q.type,
                         marks: q.marks, source: q.source.name });
    });
    out.sources = Object.keys(sourceSet).sort();
    out.ignoredFields = Object.keys(ignored).sort();
    out.placeholder = raw.placeholder === true;
    if (out.ignoredFields.length) {
      out.warnings.push('Fields that are not on the preview allowlist were not loaded: ' + out.ignoredFields.join(', ') + '.');
    }
    if (out.placeholder) { out.warnings.push('This question bank is marked as placeholder data. It is not a set of real GATE questions.'); }
    if (!out.records.length) {
      out.status = 'empty';
      out.message = out.total ? 'The file has ' + out.total + ' record(s), but none are usable. See the reasons below. Nothing was loaded.'
                              : BANK_MESSAGES.empty;
      return out;
    }
    out.message = 'Local question bank loaded: ' + out.records.length + ' usable question' + (out.records.length === 1 ? '' : 's') +
      (out.rejected.length ? ', ' + out.rejected.length + ' record(s) not used.' : '.');
    return out;
  }

  /* ---------- Modes (taken from the existing page wording; no new policy) ---------- */
  var MODE_ORDER = ['year', 'subject', 'topic', 'custom', 'full'];
  var MODES = {
    year: { label: 'Year-wise papers', filters: ['branch', 'year'], required: ['branch', 'year'],
            desc: 'Attempt a past GATE paper by choosing a branch and a year.' },
    subject: { label: 'Subject-wise tests', filters: ['branch', 'subject'], required: ['subject'],
               desc: 'Test one subject across the years, optionally narrowed by branch.' },
    topic: { label: 'Topic-wise practice', filters: ['branch', 'subject', 'topic'], required: ['subject', 'topic'],
             desc: 'Practise a single topic within a subject.' },
    custom: { label: 'Custom tests', filters: FIELDS.slice(), required: [],
              desc: 'Filter by branch, year, subject, topic and question type, then choose how many questions you want.' },
    full: { label: 'Full-length mock exams', filters: [], required: [], awaitingConfig: true,
            desc: 'A complete paper under exam conditions.' }
  };

  function activeSelection(modeKey, sel) {
    var out = {};
    MODES[modeKey].filters.forEach(function (f) { if (sel && sel[f]) { out[f] = String(sel[f]); } });
    return out;
  }

  function matchesSel(rec, sel) {
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      if (sel[f] && String(rec[f]) !== sel[f]) { return false; }
    }
    return true;
  }
  function filterRecords(records, sel) { return records.filter(function (r) { return matchesSel(r, sel); }); }

  /* Options for one filter. Every value that exists in the loaded data is listed (topics are limited to the
   * chosen subject). The count is how many questions have that value AND match every OTHER active filter,
   * so it can be 0. Zero-count values stay selectable, which lets the "no matches" state explain itself
   * instead of hiding the option. */
  function facetOptions(records, sel, field) {
    var others = {};
    Object.keys(sel).forEach(function (k) { if (k !== field) { others[k] = sel[k]; } });
    var counts = Object.create(null);
    var scope = field === 'topic' && sel.subject
      ? records.filter(function (r) { return r.subject === sel.subject; }) : records;
    scope.forEach(function (r) { counts[String(r[field])] = counts[String(r[field])] || 0; });
    records.forEach(function (r) {
      if (!matchesSel(r, others)) { return; }
      var v = String(r[field]);
      if (v in counts) { counts[v] += 1; }
    });
    if (sel[field] && !(sel[field] in counts)) { counts[sel[field]] = 0; }
    var values = Object.keys(counts);
    if (field === 'year') { values.sort(function (a, b) { return Number(b) - Number(a); }); }
    else { values.sort(function (a, b) { return a.localeCompare(b); }); }
    return values.map(function (v) { return { value: v, count: counts[v] }; });
  }

  function typeBreakdown(recs) {
    var out = {};
    TYPES.forEach(function (t) {
      var items = recs.filter(function (r) { return r.type === t; });
      if (items.length) { out[t] = { count: items.length, marks: items.reduce(function (s, r) { return s + r.marks; }, 0) }; }
    });
    return out;
  }

  /* Summary of a setup. `requested` is null (= all matching), or a number as typed.
   * Totals come only from the real records. When fewer than all matching questions are requested the
   * marks depend on which questions are drawn; how they are drawn is not decided, so a range is given. */
  function summarise(records, modeKey, sel, requested) {
    var mode = MODES[modeKey];
    var s = { mode: modeKey, state: 'ok', missing: [], pool: 0, n: 0, adjusted: false, exact: true,
              minMarks: 0, maxMarks: 0, minSeconds: 0, maxSeconds: 0, poolBreakdown: {}, selectedBreakdown: null,
              active: activeSelection(modeKey, sel) };
    if (mode.awaitingConfig) { s.state = 'awaiting_config'; return s; }
    s.missing = mode.required.filter(function (f) { return !s.active[f]; });
    if (s.missing.length) { s.state = 'incomplete'; return s; }
    var pool = filterRecords(records, s.active);
    s.pool = pool.length;
    if (!pool.length) { s.state = 'no_matches'; return s; }
    s.poolBreakdown = typeBreakdown(pool);
    var n;
    if (requested === null || requested === undefined) { n = pool.length; }
    else if (!wholeNumber(requested) || requested < 1) { s.state = 'bad_count'; return s; }
    else if (requested > pool.length) { n = pool.length; s.adjusted = true; }
    else { n = requested; }
    s.n = n;
    var marks = pool.map(function (r) { return r.marks; }).sort(function (a, b) { return a - b; });
    var sum = function (arr) { return arr.reduce(function (t, m) { return t + m; }, 0); };
    s.minMarks = sum(marks.slice(0, n));
    s.maxMarks = sum(marks.slice(marks.length - n));
    s.exact = n === pool.length || s.minMarks === s.maxMarks;
    s.minSeconds = durationSeconds(s.minMarks);
    s.maxSeconds = durationSeconds(s.maxMarks);
    if (n === pool.length) { s.selectedBreakdown = s.poolBreakdown; }
    return s;
  }

  /* ---------- Local preview selection (NOT a product policy) ----------
   * Decision D-12 (how a permanent subset is drawn, and how a mock is composed) is still open. These two methods
   * exist only so the local exam preview can show a chosen number of questions:
   *   file   = the first N matching questions, in file order
   *   random = N matching questions drawn without replacement with Math.random (NOT secure randomness)
   * The selected questions are always kept in file order. Asking for every matching question uses all of them
   * and the method is irrelevant ('all'). */
  var SELECTION_METHODS = Object.freeze({
    file: 'File order (first N matching questions)',
    random: 'Random sample without replacement (local preview only)',
    all: 'All matching questions'
  });

  /* pool: matching records in file order. n: whole number from 1 to pool.length (caller has validated it).
   * Returns { method, records } with records in file order and no repeated id, or null on invalid input. */
  function selectQuestions(pool, n, method, rng) {
    if (!Array.isArray(pool) || !wholeNumber(n) || n < 1 || n > pool.length || (method !== 'file' && method !== 'random')) { return null; }
    if (n === pool.length) { return { method: 'all', records: pool.slice() }; }
    var picked;
    if (method === 'file') { picked = pool.slice(0, n); }
    else {
      var rand = typeof rng === 'function' ? rng : Math.random, idx = pool.map(function (_, i) { return i; });
      for (var i = 0; i < n; i++) {   /* partial Fisher-Yates: the first n slots are a sample without replacement */
        var j = i + Math.floor(rand() * (idx.length - i));
        if (!(j >= i && j < idx.length)) { j = i; }
        var t = idx[i]; idx[i] = idx[j]; idx[j] = t;
      }
      picked = idx.slice(0, n).sort(function (a, b) { return a - b; }).map(function (k) { return pool[k]; });
    }
    var seen = Object.create(null);
    picked = picked.filter(function (r) { if (seen[r.id]) { return false; } seen[r.id] = true; return true; });
    return { method: method, records: picked };
  }

  /* ---------- Local preview timer plan (pure) ----------
   * duration_seconds = durationSeconds(total_selected_marks) = round(marks x 10800 / 65), from the marks of the
   * questions actually selected. A selection that totals EXACTLY 100 marks is blocked: the duration for 100-mark
   * papers (D-11) is unresolved, so no duration is shown as approved and the timer cannot start. The formula is
   * not changed here and D-11 is not decided. A browser timer is advisory only. */
  function localTimerPlan(totalMarks) {
    if (!wholeNumber(totalMarks) || totalMarks <= 0) {
      return { allowed: false, seconds: null, reason: 'invalid', text: 'Not calculated',
               message: 'The duration cannot be calculated safely because the total marks of the selection are not a positive whole number.' };
    }
    if (totalMarks === 100) {
      return { allowed: false, seconds: null, reason: 'conflict_100', text: 'Not shown (100-mark conflict)',
               message: 'The selected questions total exactly 100 marks. The duration for 100-mark papers (D-11) is an unresolved decision, so no duration is approved or shown and the timer cannot start.' };
    }
    var sec;
    try { sec = durationSeconds(totalMarks); } catch (e) { sec = NaN; }
    if (!wholeNumber(sec) || sec <= 0) {
      return { allowed: false, seconds: null, reason: 'invalid', text: 'Not calculated',
               message: 'The duration cannot be calculated safely for this selection.' };
    }
    return { allowed: true, seconds: sec, reason: '', text: formatDuration(sec) + ' (' + sec + ' s)', message: '' };
  }

  /* Counts, marks and type breakdown of the records that were really selected. */
  function selectionSummary(records) {
    return { count: records.length, totalMarks: records.reduce(function (t, r) { return t + r.marks; }, 0), breakdown: typeBreakdown(records) };
  }

  /* Checks a hand-off against the bank it refers to. sel: { ids, method, matching, label }. bank: questions in
   * file order. Never falls back to "all questions": anything missing or inconsistent is an error. */
  function resolvePreviewSelection(bank, sel) {
    function bad(message) { return { ok: false, error: message, questions: [] }; }
    if (!sel || typeof sel !== 'object') { return bad('No selection was passed to the preview.'); }
    if (!Array.isArray(sel.ids) || !sel.ids.length) { return bad('The selection contains no question ids.'); }
    if (sel.ids.length > LOCAL_LIMITS.questions) { return bad('The selection is larger than the preview allows.'); }
    if (!SELECTION_METHODS[sel.method]) { return bad('The selection method is missing or unknown.'); }
    if (!wholeNumber(sel.matching) || sel.matching < sel.ids.length) { return bad('The matching-question count is missing or smaller than the selection.'); }
    if (sel.method === 'all' && sel.matching !== sel.ids.length) { return bad('An \u201call matching\u201d selection must contain every matching question.'); }
    var pos = Object.create(null), seen = Object.create(null);
    bank.forEach(function (q, i) { pos[q.id] = i; });
    var last = -1, out = [];
    for (var i = 0; i < sel.ids.length; i++) {
      var id = sel.ids[i];
      if (typeof id !== 'string' || !ID_RE.test(id)) { return bad('The selection contains an invalid question id.'); }
      if (seen[id]) { return bad('The selection repeats the question id \u201c' + id + '\u201d.'); }
      seen[id] = true;
      if (!(id in pos)) { return bad('The selection names a question (\u201c' + id + '\u201d) that is not in the imported bank.'); }
      if (pos[id] <= last) { return bad('The selected questions are not in file order.'); }
      last = pos[id]; out.push(bank[pos[id]]);
    }
    return { ok: true, error: '', questions: out };
  }

  /* Everything that currently stops a test from starting. Empty list would mean ready. */
  function blockers(summary, bankStatus) {
    var list = [];
    if (bankStatus !== 'ready') { list.push('No usable question bank is loaded.'); }
    else if (summary.state === 'awaiting_config') { list.push('Full-length mock composition has not been defined, so this mode is awaiting configuration.'); }
    else if (summary.state === 'incomplete') {
      list.push('Choose: ' + summary.missing.map(function (f) { return FIELD_LABEL[f]; }).join(', ') + '.');
    }
    else if (summary.state === 'no_matches') { list.push('No questions match the current filters.'); }
    else if (summary.state === 'bad_count') { list.push('Enter a whole number of questions, at least 1.'); }
    else if (summary.state === 'ok' && !summary.exact) {
      list.push('How a subset is drawn from the matching questions has not been decided, so the marks and duration are only a range.');
    }
    if (!MARKING_RULES_CONFIRMED) { list.push('Marking rules for MCQ, MSQ and NAT have not been confirmed.'); }
    if (!EXAM_ENGINE_AVAILABLE) {
      list.push('The exam window, answer saving, answer keys and scoring are not built yet, so a test could not be taken or marked.');
    }
    return list;
  }

  function describeFilters(modeKey, sel) {
    var mode = MODES[modeKey], active = activeSelection(modeKey, sel);
    return mode.filters.map(function (f) {
      return FIELD_LABEL[f] + ': ' + (active[f] || (mode.required.indexOf(f) >= 0 ? 'not chosen' : 'any'));
    });
  }

  /* ================= Exam attempt state machine (pure state, tested in node) =================
   * Holds only ids, types and the person's own selections, in memory. It has no answer keys, no marking and
   * no scoring: those belong to a server-side engine that does not exist yet (see SECURITY_DESIGN.md 3.1-3.4).
   * Palette states follow the legend already published on the site: answered, not answered, marked for
   * review, not visited. A question that is both answered and marked keeps BOTH flags.
   *
   * Attempt lifecycle:   in_progress --submit--> submitted
   *                      in_progress --deadline passes--> timed_out
   * submitted and timed_out are terminal and read-only: answers, clear, mark and visited flags no longer change.
   * The deadline lives in a frozen clock created once (startedAtMs + durationSeconds). Navigation, re-rendering
   * and restoring a snapshot never recompute it, so none of them can extend the exam. */

  /* Proposed attempt policy from the draft specification. This is NOT owner-approved or enforced.
   * These fields document intended backend behavior only; a browser cannot enforce or authorize them. */
  var ATTEMPT_POLICY = Object.freeze({
    manualPause: false,                    /* no pause */
    resumeExtendsDeadline: false,          /* resuming never moves the deadline */
    closeAtDeadlineBy: 'exam service',     /* the authoritative service closes and submits saved responses */
    acceptAnswersAfterDeadline: false,
    activeAttemptsPerModePerUser: 1,
    maxStartsPerHour: 10,
    finalSubmitGraceSeconds: 15,           /* only for a final submit already in flight; accepts no new answers */
    approvalStatus: 'draft_unapproved',
    enforcedBy: 'backend (not built)',
    enforcedNow: false
  });

  /* ---- Year-specific marking profiles ----
   * Each profile holds scoring RULES only, never question-specific answers, NAT ranges or explanations. Those
   * live in the official answer-key PDFs and must be held server-side (none are held anywhere yet).
   * Marks are exact fractions of a question's marks ({ num, den }), so 1/3 is never a rounded decimal.
   * Only years whose rules were read from official pages are registered. Every other year stays unverified. */
  var MARKING_DECISIONS = Object.freeze([
    { id: 'MCQ.correct', label: 'MCQ: marks for a correct answer' },
    { id: 'MCQ.wrong', label: 'MCQ: marks for a wrong answer (negative marking)' },
    { id: 'MCQ.unattempted', label: 'MCQ: marks for an unattempted question' },
    { id: 'MSQ.correct', label: 'MSQ: marks for a fully correct answer' },
    { id: 'MSQ.wrong', label: 'MSQ: marks for a wrong answer' },
    { id: 'MSQ.partial', label: 'MSQ: whether partial credit exists and how it is computed' },
    { id: 'MSQ.unattempted', label: 'MSQ: marks for an unattempted question' },
    { id: 'NAT.correct', label: 'NAT: marks for a correct answer' },
    { id: 'NAT.wrong', label: 'NAT: marks for a wrong answer' },
    { id: 'NAT.tolerance', label: 'NAT: accepted tolerance or range (exact, absolute or range)' },
    { id: 'NAT.unattempted', label: 'NAT: marks for an unattempted question' }
  ]);

  /* ---- exact fractions (integers only; never -0) ---- */
  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { var t = a % b; a = b; b = t; } return a || 1; }
  function isFrac(f) { return !!f && typeof f === 'object' && wholeNumber(f.num) && wholeNumber(f.den) && f.den > 0; }
  function frac(n, d) {
    if (!wholeNumber(n) || !wholeNumber(d) || d === 0) { throw new TypeError('fraction needs whole numbers and a non-zero denominator'); }
    if (d < 0) { n = -n; d = -d; }
    var g = gcd(n, d); n = n / g; d = d / g;
    if (n === 0) { n = 0; d = 1; }
    return Object.freeze({ num: n, den: d });
  }
  function fracMul(f, k) { return frac(f.num * k, f.den); }
  function fracAdd(a, b) { return frac(a.num * b.den + b.num * a.den, a.den * b.den); }
  function fracValue(f) { var v = f.num / f.den; return v === 0 ? 0 : v; }   /* +0, never -0 */
  function fracText(f) { return f.den === 1 ? String(f.num) : f.num + '/' + f.den; }

  /* GATE 2026. Two kinds of rule are kept apart in `provenance`:
   *   'official'       = stated in the official GATE 2026 pages read on 2026-10-28: the MCQ penalty (1/3 of a
   *                      1-mark and 2/3 of a 2-mark question), no negative marking for MSQ or NAT, no partial
   *                      marking for MSQ, NAT judged against the range in the answer key, and Marks To All.
   *   'interpretation' = this implementation's reading, NOT quoted from any official source: an unanswered
   *                      question scores zero (no correct-answer credit, no wrong-answer penalty). None of the
   *                      reviewed sources states an unanswered score explicitly.
   * The question paper pattern page and the answer-key page were read by this project. The Information
   * Brochure PDF was cited by the owner as a basis but its text could not be read here, so it is listed as
   * an owner-cited source and no rule is attributed to it. */
  var GATE_2026_SOURCE = Object.freeze({
    name: 'GATE 2026, IIT Guwahati (official)',
    urls: Object.freeze(['https://gate2026.iitg.ac.in/question-paper-pattern.html', 'https://gate2026.iitg.ac.in/QPs-answer-keys.html']),
    ownerCitedUrls: Object.freeze(['https://gate2026.iitg.ac.in/doc/IB/GATE2026-IB-v22082025-1300.pdf']),
    checkedOn: '2026-10-28'
  });
  var UNATTEMPTED_INTERPRETATION = 'Implementation interpretation, not an official statement: an unanswered question earns no ' +
    'correct-answer credit and incurs no wrong-answer penalty, so it scores 0.';
  var MARKING_PROFILES = Object.freeze({
    '2026': Object.freeze({
      year: 2026, status: 'source_verified_reference_only', sourceVerified: true, source: GATE_2026_SOURCE,
      rules: Object.freeze({
        MCQ: Object.freeze({ correct: frac(1, 1), wrong: frac(-1, 3), unattempted: frac(0, 1) }),   /* of the question's marks: 1-mark -1/3, 2-mark -2/3 */
        MSQ: Object.freeze({ correct: frac(1, 1), wrong: frac(0, 1), partial: 'none', unattempted: frac(0, 1) }),
        NAT: Object.freeze({ correct: frac(1, 1), wrong: frac(0, 1), tolerance: 'answer_key_range', unattempted: frac(0, 1) })
      }),
      provenance: Object.freeze({
        'MCQ.correct': 'official', 'MCQ.wrong': 'official', 'MCQ.unattempted': 'interpretation',
        'MSQ.correct': 'official', 'MSQ.wrong': 'official', 'MSQ.partial': 'official', 'MSQ.unattempted': 'interpretation',
        'NAT.correct': 'official', 'NAT.wrong': 'official', 'NAT.tolerance': 'official', 'NAT.unattempted': 'interpretation'
      }),
      interpretationNote: UNATTEMPTED_INTERPRETATION,
      marksToAll: true,   /* official "MTA" keys: the question's marks go to every candidate appearing */
      unresolved: Object.freeze([])
    })
  });

  /* A profile is valid when it names an official source and every decision has a value, except decisions it
   * lists explicitly in `unresolved` (those must be null). */
  function validateMarkingProfile(p) {
    var reasons = [];
    if (!p || typeof p !== 'object') { return ['profile is not an object']; }
    if (!wholeNumber(p.year) || p.year < 1900 || p.year > 2100) { reasons.push('year must be a whole number from 1900 to 2100'); }
    if (!p.source || !nonEmpty(p.source.name, 200) || !Array.isArray(p.source.urls) || !p.source.urls.length) { reasons.push('an official source name and URL are required'); }
    if (!p.rules || typeof p.rules !== 'object') { reasons.push('rules are missing'); return reasons; }
    var unresolved = Array.isArray(p.unresolved) ? p.unresolved : [];
    if (p.unresolved !== undefined && !Array.isArray(p.unresolved)) { reasons.push('unresolved must be a list'); }
    MARKING_DECISIONS.forEach(function (d) {
      var parts = d.id.split('.'), group = p.rules[parts[0]], v = group ? group[parts[1]] : undefined;
      var empty = v === null || v === undefined, declared = unresolved.indexOf(d.id) >= 0;
      if (empty && !declared) { reasons.push('undecided: ' + d.label); }
      if (!empty && declared) { reasons.push('listed as unresolved but has a value: ' + d.label); }
      var pv = p.provenance && p.provenance[d.id];
      if (!empty && pv !== 'official' && pv !== 'interpretation') { reasons.push('provenance (official or interpretation) is missing: ' + d.label); }
    });
    return reasons;
  }

  /* A source-verified rule reference is NOT the same as an owner-approved executable scoring profile.
   * `verified`/`sourceVerified` refer only to source review; `canScore` stays false until explicit owner approval,
   * the rule gate, the secure server scorer, and the online engine are all ready. */
  function markingProfileFor(year) {
    var key = wholeNumber(year) ? String(year) : null, reg = key && has.call(MARKING_PROFILES, key) ? MARKING_PROFILES[key] : null;
    if (reg && reg.sourceVerified === true && reg.year === year && !validateMarkingProfile(reg).length) {
      var pending = MARKING_DECISIONS.filter(function (d) { return reg.unresolved.indexOf(d.id) >= 0; }).map(function (d) { return d.label; });
      var ownerApproved = EXAM_POLICY_APPROVED && MARKING_RULES_CONFIRMED;
      var canScore = pending.length === 0 && ownerApproved && SCORING_BACKEND_READY && EXAM_ENGINE_AVAILABLE && ATTEMPT_POLICY.enforcedNow;
      return { year: reg.year, status: 'reference_only', verified: true, sourceVerified: true, ownerApproved: ownerApproved,
               canScore: canScore, operationalStatus: canScore ? 'enabled' : 'blocked', rules: reg.rules, source: reg.source,
               marksToAll: reg.marksToAll === true, pending: pending,
               provenance: reg.provenance, interpretationNote: reg.interpretationNote || null };
    }
    return { year: wholeNumber(year) ? year : null, status: 'unverified', verified: false, sourceVerified: false, ownerApproved: false,
             canScore: false, operationalStatus: 'blocked', rules: null, source: null, marksToAll: false,
             pending: MARKING_DECISIONS.map(function (d) { return d.label; }), provenance: null, interpretationNote: null };
  }
  function scoringBlockers(year) {
    var p = markingProfileFor(year), name = p.year === null ? 'this paper' : 'GATE ' + p.year, list = [];
    if (!p.sourceVerified) { list.push("The marking profile for " + name + " is unverified; real scoring is blocked. This site will not borrow another year's rules."); }
    else if (p.pending.length) { list.push(name + ' still has undecided rules: ' + p.pending.join('; ') + '.'); }
    if (!EXAM_POLICY_APPROVED) { list.push('The scoring specification is DRAFT for owner review and NOT APPROVED; approval is required before operational scoring.'); }
    if (!MARKING_RULES_CONFIRMED) { list.push('The owner-controlled MCQ/MSQ/NAT marking confirmation gate is OFF. Source-reviewed reference rules are not enabled for scoring.'); }
    if (!SCORING_BACKEND_READY || !EXAM_ENGINE_AVAILABLE) { list.push('The secure server-side scoring backend and online exam engine are not approved as ready; browser-side score calculation is disabled.'); }
    if (!ATTEMPT_POLICY.enforcedNow) { list.push('The proposed attempt policy remains unapproved/unimplemented and is not enforced by a configured backend.'); }
    list.push('The private answer keys (correct options, per-question NAT ranges and Marks To All flags) are not configured in an approved server-side store; they must never be placed in public files.');
    if (p.sourceVerified) { list.push('NAT range-boundary behavior and response syntax/rounding remain open decisions (AK-01 / AK-02); unanswered score 0 remains an implementation interpretation, not an official statement.'); }
    return list;
  }

  function policyStatus(year) {
    var p = markingProfileFor(year), blocked = scoringBlockers(year);
    if (!ANSWER_REVIEW_POLICY_APPROVED) { blocked.push('Answer review is blocked pending approval of D-18 / AK-08; answer keys and explanations are not exposed.'); }
    var profileStatus = !p.sourceVerified ? 'unverified'
      : p.canScore ? 'owner_approved_and_operational'
      : p.ownerApproved ? 'owner_approved_but_backend_blocked' : 'source_verified_reference_only';
    return {
      schemaVersion: 1,
      specStatus: EXAM_POLICY_APPROVED ? 'owner_approved' : 'draft_unapproved',
      profileStatus: profileStatus,
      year: p.year,
      sourceVerified: p.sourceVerified,
      ownerApproved: EXAM_POLICY_APPROVED,
      profileOwnerApproved: p.ownerApproved,
      markingRulesConfirmed: MARKING_RULES_CONFIRMED,
      scoringBackendReady: SCORING_BACKEND_READY,
      examEngineAvailable: EXAM_ENGINE_AVAILABLE,
      attemptPolicyApproved: EXAM_POLICY_APPROVED,
      attemptPolicyEnforced: ATTEMPT_POLICY.enforcedNow,
      answerReviewApproved: ANSWER_REVIEW_POLICY_APPROVED,
      canScore: p.canScore,
      canStartOnlineExam: p.canScore && EXAM_POLICY_APPROVED && MARKING_RULES_CONFIRMED && EXAM_ENGINE_AVAILABLE && ATTEMPT_POLICY.enforcedNow,
      canReviewAnswers: ANSWER_REVIEW_POLICY_APPROVED && SCORING_BACKEND_READY,
      blockers: blocked
    };
  }

  /* Marks awarded for one question, as an exact fraction, or null when the profile cannot say.
   * q: { type, marks }. outcome: 'correct' | 'wrong' | 'unattempted' | 'marks_to_all'. */
  function awardedMarks(profile, q, outcome) {
    if (!profile || profile.canScore !== true || !profile.sourceVerified || !profile.rules || !q || TYPES.indexOf(q.type) < 0 || !wholeNumber(q.marks) || q.marks <= 0) { return null; }
    if (outcome === 'marks_to_all') { return profile.marksToAll ? frac(q.marks, 1) : null; }
    var rule = profile.rules[q.type][outcome === 'correct' ? 'correct' : outcome === 'wrong' ? 'wrong' : outcome === 'unattempted' ? 'unattempted' : null];
    return isFrac(rule) ? fracMul(rule, q.marks) : null;
  }
  /* Sum of awarded marks; null if any part is unknown. Never returns -0. */
  function sumMarks(list) {
    var t = frac(0, 1);
    for (var i = 0; i < list.length; i++) { if (!isFrac(list[i])) { return null; } t = fracAdd(t, list[i]); }
    return t;
  }

  /* Browser-callable score path remains blocked. The secure server-side scorer must own key lookup and scoring. */
  function scoreResponse(profile, q, response, key) {
    /* Browser-side operational scoring is disabled. Server code owns key lookup, response classification and marks. */
    if (!profile || profile.canScore !== true || !q || TYPES.indexOf(q.type) < 0) { return { outcome: null, marks: null }; }
    var outcome = classifyResponse(q.type, response, key);
    return { outcome: outcome, marks: awardedMarks(profile, q, outcome) };
  }

  /* Pure classifier retained for unit-level reference only. Real keys and tolerance decisions must remain private.
   * Current public runtime never invokes this classifier to award marks. */
  var NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  function classifyResponse(type, response, key) {
    if (key && key.marksToAll === true) { return 'marks_to_all'; }
    var none = response === undefined || response === null || (typeof response === 'string' && !response.trim()) || (Array.isArray(response) && !response.length);   /* blank = unanswered, as in the exam state */
    if (none) { return 'unattempted'; }
    if (!key) { return 'wrong'; }
    if (type === 'MCQ') { return typeof response === 'string' && response === key.answer ? 'correct' : 'wrong'; }
    if (type === 'MSQ') {
      if (!Array.isArray(response) || !Array.isArray(key.answers)) { return 'wrong'; }
      var a = response.slice().sort(), b = key.answers.slice().sort();
      return a.length === b.length && a.every(function (v, i) { return v === b[i]; }) ? 'correct' : 'wrong';   /* all correct, none wrong */
    }
    if (type === 'NAT') {
      var s = typeof response === 'string' ? response.trim() : '';
      if (!NUM_RE.test(s) || typeof key.min !== 'number' || typeof key.max !== 'number') { return 'wrong'; }
      var v = Number(s); return isFinite(v) && v >= key.min && v <= key.max ? 'correct' : 'wrong';
    }
    return 'wrong';
  }

  /* Plain-text lines describing a year's profile, for the exam page. */
  function describeProfile(year) {
    var p = markingProfileFor(year);
    if (!p.sourceVerified) { return ['Rules for ' + (p.year === null ? 'this year' : String(p.year)) + ' are unverified. No marks are defined and scoring is blocked.']; }
    var r = p.rules;
    return [
      'Source status: reference-only rules checked on ' + p.source.checkedOn + '. This profile is not owner-approved and cannot be used to score attempts.',
      'MCQ: a correct answer earns the question\u2019s full marks. A wrong answer loses ' + fracText(frac(-r.MCQ.wrong.num, r.MCQ.wrong.den)) + ' of the question\u2019s marks (1-mark: 1/3, 2-mark: 2/3).',
      'MSQ: full marks only if every correct option and no wrong option is chosen. No negative marking and no partial marking.',
      'NAT: full marks if the response is within the range given for that question in the official answer key. No negative marking. Range-boundary inclusivity and numeric response syntax/rounding remain unresolved (AK-01 / AK-02).',
      'Marks To All (MTA): where the official key says so, the question\u2019s marks go to every candidate appearing. The public site has no key or MTA flags.',
      p.pending.length ? 'Unanswered questions: unresolved.'
        : 'Unanswered questions: score 0 (no credit, no penalty). This is the implementation\u2019s interpretation. The official pages do not state it explicitly.',
      'Operational status: blocked until owner approval, marking confirmation, approved private answer keys and server-side scoring/attempt enforcement are all ready.'
    ];
  }

  /* Why a real exam attempt cannot start. Never empty while any item below is unmet. `year` is optional. */
  function examBlockers(bankStatus, year) {
    var list = [];
    if (bankStatus !== 'ready') { list.push('No usable question bank is loaded.'); }
    if (!MARKING_RULES_CONFIRMED) { list.push('Marking rules for MCQ, MSQ and NAT have not been confirmed.'); }
    if (!EXAM_POLICY_APPROVED) { list.push('The exam and scoring policy specification is DRAFT and NOT APPROVED by the owner.'); }
    if (year !== undefined) { list = list.concat(scoringBlockers(year)); }
    if (!EXAM_ENGINE_AVAILABLE) {
      list.push('The exam engine is not built. There is no backend to start an attempt, keep a server-side deadline, save answers or score them.');
    }
    if (!ATTEMPT_POLICY.enforcedNow) {
      list.push('The proposed attempt policy is not approved/enforced by a configured backend yet.');
    }
    return list;
  }
  function examAttemptsEnabled(bankStatus, year) { return examBlockers(bankStatus, year).length === 0; }

  /* Specification of the start rules, for the future backend and for tests. A browser result is advisory
   * (enforced: false). Policy-limit reasons are reported separately from "the exam engine is unavailable", so
   * a limit is never confused with the exam being switched off. */
  function attemptStartCheck(input) {
    var i = input || {}, reasons = [];
    var now = typeof i.nowMs === 'number' && isFinite(i.nowMs) ? i.nowMs : null;
    if (typeof i.mode !== 'string' || MODE_ORDER.indexOf(i.mode) < 0) { reasons.push({ code: 'bad_mode', message: 'Unknown practice mode.' }); }
    if (now === null) { reasons.push({ code: 'bad_time', message: 'A valid current time is required.' }); }
    var active = Array.isArray(i.activeModes) ? i.activeModes : [];
    if (i.mode && active.indexOf(i.mode) >= 0) {
      reasons.push({ code: 'active_attempt_exists', message: 'An attempt is already active for this mode. Finish it first.' });
    }
    if (now !== null) {
      var recent = (Array.isArray(i.startTimesMs) ? i.startTimesMs : []).filter(function (t) {
        return typeof t === 'number' && isFinite(t) && t > now - 3600000 && t <= now;
      }).length;
      if (recent >= ATTEMPT_POLICY.maxStartsPerHour) {
        reasons.push({ code: 'hourly_limit', message: 'The limit of ' + ATTEMPT_POLICY.maxStartsPerHour + ' attempt starts per hour has been reached.' });
      }
    }
    if (!EXAM_POLICY_APPROVED) { reasons.push({ code: 'policy_unapproved', message: 'The exam policy is still a draft and has not been approved by the owner.' }); }
    if (!EXAM_ENGINE_AVAILABLE) { reasons.push({ code: 'engine_unavailable', message: 'Exam attempts are switched off until the secure backend exists.' }); }
    return { allowed: reasons.length === 0, enforced: false, reasons: reasons };
  }

  /* Backend rule for a final submit already in flight: it must have been SENT by the deadline and may arrive up
   * to the grace period later. The grace never extends the exam and never admits new answers. */
  function finalSubmitAccepted(deadlineMs, sentAtMs, receivedAtMs) {
    if ([deadlineMs, sentAtMs, receivedAtMs].some(function (v) { return typeof v !== 'number' || !isFinite(v); })) { return false; }
    return sentAtMs <= deadlineMs && receivedAtMs <= deadlineMs + ATTEMPT_POLICY.finalSubmitGraceSeconds * 1000;
  }

  /* Countdown helpers: display only. A client clock is advisory; the real deadline will be server-side. */
  function formatClock(totalSeconds) {
    if (typeof totalSeconds !== 'number' || !isFinite(totalSeconds)) { return '--:--:--'; }
    var s = Math.max(0, Math.floor(totalSeconds));
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
  }
  function remainingSeconds(deadlineMs, nowMs) {
    if (typeof deadlineMs !== 'number' || typeof nowMs !== 'number' || !isFinite(deadlineMs) || !isFinite(nowMs)) { return null; }
    var r = Math.ceil((deadlineMs - nowMs) / 1000);
    return r > 0 ? r : 0;   /* never -0 or negative */
  }

  var NAT_MAX_LEN = 64;   /* input-size safety only; not a marking or format rule */
  var EXAM_STATUSES = ['in_progress', 'submitted', 'timed_out'];

  /* items: [{ id, type: 'MCQ'|'MSQ'|'NAT', options?: ['A','B',...] }]
   * opts (optional): { durationSeconds, startedAtMs } creates the frozen clock. Without it there is no timer
   * (the interface preview). The deadline is fixed here and is never recomputed. */
  function createExam(items, opts) {
    if (!Array.isArray(items)) { throw new TypeError('items must be a list'); }
    var clock = null;
    if (opts !== undefined && opts !== null) {
      if (typeof opts !== 'object' || !wholeNumber(opts.durationSeconds) || opts.durationSeconds <= 0 ||
          typeof opts.startedAtMs !== 'number' || !isFinite(opts.startedAtMs)) { throw new TypeError('bad clock options'); }
      clock = Object.freeze({ durationSeconds: opts.durationSeconds, startedAtMs: opts.startedAtMs,
                              deadlineMs: opts.startedAtMs + opts.durationSeconds * 1000 });
    }
    var ex = { ids: [], byId: Object.create(null), responses: Object.create(null), visited: Object.create(null),
               marked: Object.create(null), current: -1, status: 'in_progress', clock: clock, closed: null };
    items.forEach(function (it) {
      if (!it || typeof it.id !== 'string' || !ID_RE.test(it.id) || ex.byId[it.id]) { throw new TypeError('bad or duplicate item id'); }
      if (TYPES.indexOf(it.type) < 0) { throw new TypeError('bad item type'); }
      var opts2 = null;
      if (it.type !== 'NAT') {
        if (!Array.isArray(it.options) || it.options.length < 2 ||
            it.options.some(function (o) { return !nonEmpty(o, 16); }) ||
            new Set(it.options).size !== it.options.length) { throw new TypeError('bad options for ' + it.id); }
        opts2 = it.options.slice();
      }
      ex.byId[it.id] = { id: it.id, type: it.type, options: opts2 };
      ex.ids.push(it.id);
    });
    if (ex.ids.length) { ex.current = 0; ex.visited[ex.ids[0]] = true; }
    return ex;
  }

  /* ---- lifecycle ---- */
  function closeExam(ex, reason, atMs) {
    if (ex.status !== 'in_progress') { return false; }
    ex.status = reason; ex.closed = { reason: reason, atMs: atMs }; return true;
  }
  function clockNow(nowMs) { return typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now(); }
  /* Applies the deadline, then reports whether changes are still allowed. Every mutator calls this first. */
  function examIsOpen(ex, nowMs) {
    if (ex.status === 'in_progress' && ex.clock) {
      var now = clockNow(nowMs);
      if (now >= ex.clock.deadlineMs) { closeExam(ex, 'timed_out', ex.clock.deadlineMs); }
    }
    return ex.status === 'in_progress';
  }
  function examStatus(ex, nowMs) { examIsOpen(ex, nowMs); return ex.status; }
  /* Final submission by the person. Refused once the attempt is closed or the deadline has passed. */
  function examSubmit(ex, nowMs) {
    if (!examIsOpen(ex, nowMs)) { return false; }
    return closeExam(ex, 'submitted', ex.clock ? clockNow(nowMs) : null);
  }
  /* The transition the authoritative exam service performs at the deadline: the responses already saved stay,
   * nothing new is accepted. The interface preview calls it to show the timed-out state. */
  function examTimeOut(ex) { return closeExam(ex, 'timed_out', ex.clock ? ex.clock.deadlineMs : null); }
  /* Whole seconds left, or null when there is no clock. Frozen at the closing moment once closed. */
  function examRemaining(ex, nowMs) {
    if (!ex.clock) { return null; }
    examIsOpen(ex, nowMs);
    var at = ex.status === 'in_progress' ? clockNow(nowMs) : (ex.closed && typeof ex.closed.atMs === 'number' ? ex.closed.atMs : ex.clock.deadlineMs);
    return remainingSeconds(ex.clock.deadlineMs, at);
  }

  /* Navigation. When closed, the person may still look around (read-only) but nothing else changes:
   * the visited flags, and so the summary, stay as they were at closing. */
  function examGoTo(ex, index, nowMs) {
    if (!wholeNumber(index) || index < 0 || index >= ex.ids.length) { return false; }
    var open = examIsOpen(ex, nowMs);
    ex.current = index;
    if (open) { ex.visited[ex.ids[index]] = true; }
    return true;
  }
  function examNext(ex, nowMs) { return ex.current >= 0 && examGoTo(ex, ex.current + 1, nowMs); }
  function examPrev(ex, nowMs) { return ex.current >= 0 && examGoTo(ex, ex.current - 1, nowMs); }

  function examHasAnswer(ex, id) {
    var item = ex.byId[id]; if (!item || !has.call(ex.responses, id)) { return false; }
    var v = ex.responses[id];
    return item.type === 'MSQ' ? v.length > 0 : item.type === 'NAT' ? v.length > 0 : typeof v === 'string' && v.length > 0;
  }

  /* Validates and stores a response without touching flags or the lifecycle (internal). */
  function storeAnswer(ex, id, value) {
    var item = ex.byId[id]; if (!item) { return false; }
    if (item.type === 'MCQ') {
      if (typeof value !== 'string' || item.options.indexOf(value) < 0) { return false; }
      ex.responses[id] = value;
    } else if (item.type === 'MSQ') {
      if (!Array.isArray(value) || value.some(function (v) { return item.options.indexOf(v) < 0; }) ||
          new Set(value).size !== value.length) { return false; }
      if (!value.length) { delete ex.responses[id]; return true; }
      ex.responses[id] = item.options.filter(function (o) { return value.indexOf(o) >= 0; });   /* canonical order */
    } else {
      if (typeof value !== 'string' || value.length > NAT_MAX_LEN || CONTROL_RE.test(value)) { return false; }
      var t = value.trim();
      if (!t) { delete ex.responses[id]; return true; }
      ex.responses[id] = t;
    }
    return true;
  }

  /* MCQ: one option id. MSQ: list of option ids. NAT: text. Invalid input, or any change after the attempt
   * is closed, is rejected (returns false) and leaves the existing response untouched. An empty MSQ list or
   * empty NAT text clears the response. */
  function examSetAnswer(ex, id, value, nowMs) {
    if (!ex.byId[id] || !examIsOpen(ex, nowMs)) { return false; }
    if (!storeAnswer(ex, id, value)) { return false; }
    ex.visited[id] = true;
    return true;
  }
  function examClear(ex, id, nowMs) {
    if (!ex.byId[id] || !examIsOpen(ex, nowMs)) { return false; }
    var had = has.call(ex.responses, id);
    delete ex.responses[id];
    return had;
  }
  /* Marking never touches the response, so a question can be answered and marked at once. */
  function examToggleMark(ex, id, nowMs) {
    if (!ex.byId[id] || !examIsOpen(ex, nowMs)) { return null; }
    if (ex.marked[id]) { delete ex.marked[id]; return false; }
    ex.marked[id] = true; ex.visited[id] = true; return true;
  }

  /* status: review (marked) > answered > unanswered (visited) > none (not visited). The answered and marked
   * flags are both kept, so "review" never hides that the question has an answer. */
  function examPaletteState(ex, index) {
    var id = ex.ids[index]; if (id === undefined) { return null; }
    var answered = examHasAnswer(ex, id), marked = !!ex.marked[id], visited = !!ex.visited[id];
    return { index: index, id: id, answered: answered, marked: marked, visited: visited, current: index === ex.current,
             status: marked ? 'review' : answered ? 'answered' : visited ? 'unanswered' : 'none' };
  }
  /* answered + notAnswered + notVisited always equals total. marked and answeredAndMarked overlap them. */
  function examSummary(ex) {
    var s = { total: ex.ids.length, answered: 0, notAnswered: 0, notVisited: 0, marked: 0, answeredAndMarked: 0 };
    ex.ids.forEach(function (id) {
      var a = examHasAnswer(ex, id), m = !!ex.marked[id], v = !!ex.visited[id];
      if (a) { s.answered++; } else if (v) { s.notAnswered++; } else { s.notVisited++; }
      if (m) { s.marked++; if (a) { s.answeredAndMarked++; } }
    });
    return s;
  }
  /* The person's own response as text for the summary table ('' when none). */
  function examResponseText(ex, id) {
    if (!examHasAnswer(ex, id)) { return ''; }
    var v = ex.responses[id];
    return Array.isArray(v) ? v.join(', ') : v;
  }

  /* Plain-data copy of the state (JSON-safe). The clock is copied as stored, never refreshed. */
  function examSnapshot(ex) {
    var pick = function (o) { return ex.ids.filter(function (id) { return o[id]; }); };
    var resp = {};
    ex.ids.forEach(function (id) { if (examHasAnswer(ex, id)) { resp[id] = Array.isArray(ex.responses[id]) ? ex.responses[id].slice() : ex.responses[id]; } });
    return { version: 1, status: ex.status, current: ex.current, responses: resp, marked: pick(ex.marked), visited: pick(ex.visited),
             clock: ex.clock ? { durationSeconds: ex.clock.durationSeconds, startedAtMs: ex.clock.startedAtMs } : null,
             closed: ex.closed ? { reason: ex.closed.reason, atMs: ex.closed.atMs } : null };
  }
  /* Rebuilds an attempt from a snapshot. The deadline is startedAtMs + durationSeconds from the snapshot, NOT
   * "now + something", so resuming (or reloading the interface) cannot extend it. An expired snapshot comes
   * back timed out with its saved responses intact. Invalid data throws TypeError (fail closed). The real
   * source of truth for the snapshot will be the server; a browser copy is only a display convenience. */
  function examRestore(items, snap, nowMs) {
    if (!snap || typeof snap !== 'object' || snap.version !== 1 || EXAM_STATUSES.indexOf(snap.status) < 0) { throw new TypeError('bad snapshot'); }
    var ex = createExam(items, snap.clock ? { durationSeconds: snap.clock.durationSeconds, startedAtMs: snap.clock.startedAtMs } : undefined);
    var rs = snap.responses && typeof snap.responses === 'object' ? snap.responses : {};
    Object.keys(rs).forEach(function (id) { if (!storeAnswer(ex, id, rs[id])) { throw new TypeError('bad response for ' + id); } });
    ex.visited = Object.create(null);
    (Array.isArray(snap.visited) ? snap.visited : []).concat(ex.ids.length ? [ex.ids[0]] : []).forEach(function (id) { if (ex.byId[id]) { ex.visited[id] = true; } });
    (Array.isArray(snap.marked) ? snap.marked : []).forEach(function (id) { if (ex.byId[id]) { ex.marked[id] = true; ex.visited[id] = true; } });
    if (wholeNumber(snap.current) && snap.current >= 0 && snap.current < ex.ids.length) { ex.current = snap.current; }
    if (snap.status !== 'in_progress') {
      var at = snap.closed && typeof snap.closed.atMs === 'number' ? snap.closed.atMs : (ex.clock ? ex.clock.deadlineMs : null);
      closeExam(ex, snap.status, at);
    } else { examIsOpen(ex, nowMs); }
    return ex;
  }


  var api = {
    durationSeconds: durationSeconds, formatDuration: formatDuration, check: check,
    BANK_URL: BANK_URL, MODES: MODES, MODE_ORDER: MODE_ORDER, FIELDS: FIELDS, FIELD_LABEL: FIELD_LABEL,
    validateRecord: validateRecord, prepareCatalogue: prepareCatalogue, loadBank: loadBank,
    MANIFEST_URL: MANIFEST_URL, DATA_BASE: DATA_BASE, MANIFEST_LIMITS: MANIFEST_LIMITS, validateManifest: validateManifest, manifestChoices: manifestChoices, resolveShards: resolveShards,
    loadManifest: loadManifest, loadShards: loadShards, loadPaper: loadPaper, loadCatalogue: loadCatalogue, checkShard: checkShard,
    prepareLocalBank: prepareLocalBank, cleanProvenance: cleanProvenance, LOCAL_LIMITS: LOCAL_LIMITS, PRIVATE_FIELD_NAMES: PRIVATE_FIELD_NAMES,
    SELECTION_METHODS: SELECTION_METHODS, localTimerPlan: localTimerPlan, selectQuestions: selectQuestions, selectionSummary: selectionSummary, resolvePreviewSelection: resolvePreviewSelection,
    filterRecords: filterRecords, facetOptions: facetOptions, activeSelection: activeSelection,
    typeBreakdown: typeBreakdown, summarise: summarise, blockers: blockers, describeFilters: describeFilters,
    exam: { blockers: examBlockers, attemptsEnabled: examAttemptsEnabled, formatClock: formatClock,
            remainingSeconds: remainingSeconds, create: createExam, goTo: examGoTo, next: examNext, prev: examPrev,
            hasAnswer: examHasAnswer, setAnswer: examSetAnswer, clear: examClear, toggleMark: examToggleMark,
            paletteState: examPaletteState, summary: examSummary, responseText: examResponseText,
            status: examStatus, isOpen: examIsOpen, submit: examSubmit, timeOut: examTimeOut, remaining: examRemaining,
            snapshot: examSnapshot, restore: examRestore, startCheck: attemptStartCheck, finalSubmitAccepted: finalSubmitAccepted,
            policy: ATTEMPT_POLICY, policyStatus: policyStatus },
    marking: { decisions: MARKING_DECISIONS, profileFor: markingProfileFor, validateProfile: validateMarkingProfile,
               scoringBlockers: scoringBlockers, policyStatus: policyStatus, awardedMarks: awardedMarks, sumMarks: sumMarks, classifyResponse: classifyResponse, scoreResponse: scoreResponse,
               describeProfile: describeProfile, frac: frac, fracValue: fracValue, fracText: fracText }
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  root.GatePrep = api;

  if (typeof document === 'undefined') { return; }

  /* ---------- DOM helpers ---------- */
  function $(id) { return document.getElementById(id); }

  function setError(inputId, message) {
    var input = $(inputId);
    var out = $(inputId + '-error');
    if (out) { out.textContent = message || ''; }
    if (input) {
      if (message) { input.setAttribute('aria-invalid', 'true'); } else { input.removeAttribute('aria-invalid'); }
    }
    return !message;
  }

  function setStatus(id, message) {
    var el = $(id);
    if (el) { el.textContent = message || ''; }
  }

  /* Status message for a button that has no status region of its own (e.g. the Google buttons). */
  function statusNear(button, message) {
    var host = button.closest('p') || button.parentNode;
    var el = host.nextElementSibling;
    if (!el || !el.classList.contains('status-inline')) {
      el = document.createElement('p');
      el.className = 'status status-inline';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      host.parentNode.insertBefore(el, host.nextSibling);
    }
    el.textContent = message;
  }

  function onClick(id, handler) {
    var el = $(id);
    if (el) { el.addEventListener('click', handler); }
  }

  function clearOnInput(form) {
    if (!form) { return; }
    form.addEventListener('input', function (e) {
      var t = e.target;
      if (t && t.id) { setError(t.id, ''); }
    });
  }

  /* ---------- Password show/hide ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('[data-toggle-password]'), function (btn) {
    btn.addEventListener('click', function () {
      var ids = btn.getAttribute('data-toggle-password').split(/\s+/);
      var show = btn.getAttribute('aria-pressed') !== 'true';
      ids.forEach(function (id) {
        var input = $(id);
        if (input) { input.type = show ? 'text' : 'password'; }
      });
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      var plural = ids.length > 1;
      btn.textContent = (show ? 'Hide ' : 'Show ') + (plural ? 'passwords' : 'password');
    });
  });

  /* ---------- Not-connected notice (shared wording) ---------- */
  var NOT_SENT = 'Nothing was sent or saved.';

  /* ---------- Account forms ----------
   * auth.js (loaded after this file) provides root.GateAuthUI and does the real calls. Without it, or when the private backend is not
   * configured, these handlers only validate and say plainly that nothing was sent. */
  function authUI(name) { var ui = root.GateAuthUI; return ui && typeof ui[name] === 'function' ? ui[name] : null; }
  function ctxFor(extra) {
    var c = { $: $, setError: setError, setStatus: setStatus, statusNear: statusNear, check: check, notSent: NOT_SENT };
    Object.keys(extra || {}).forEach(function (k) { c[k] = extra[k]; });
    return c;
  }

  /* ---------- Google buttons ---------- */
  ['google-signin', 'google-signup'].forEach(function (id) {
    onClick(id, function (e) {
      statusNear(e.currentTarget, 'Google sign-in is not enabled. Its token verification method has not been approved, so no Google request was made. ' + NOT_SENT);
    });
  });

  /* ---------- Login ---------- */
  onClick('login-submit', function () {
    var ok = true;
    ok = setError('login-identifier', check.required($('login-identifier').value, 'Enter your username or email.')) && ok;
    ok = setError('login-password', check.required($('login-password').value, 'Enter your password.')) && ok;
    if (!ok) { setStatus('login-status', 'Please fix the highlighted fields.'); return; }
    var go = authUI('login');
    if (go) { go(ctxFor({ identifier: $('login-identifier').value, password: $('login-password').value, remember: $('login-remember').checked, button: $('login-submit') })); return; }
    setStatus('login-status', 'Your entries look complete, but log in is not connected yet. ' + NOT_SENT);
  });
  clearOnInput($('login-form'));

  /* ---------- Password reset ---------- */
  onClick('forgot-submit', function () {
    var ok = setError('forgot-identifier', check.required($('forgot-identifier').value, 'Enter your username or Gmail address.'));
    if (!ok) { setStatus('forgot-status', 'Please fix the highlighted field.'); return; }
    var go = authUI('forgotStart');
    if (go) { go(ctxFor({ identifier: $('forgot-identifier').value, button: $('forgot-submit') })); return; }
    setStatus('forgot-status', 'Password reset is not connected yet, so no code was sent. ' + NOT_SENT);
  });
  onClick('forgot-verify', function () {
    var ok = setError('forgot-otp', check.otp($('forgot-otp').value.trim()));
    if (!ok) { setStatus('forgot-otp-status', 'Please fix the highlighted field.'); return; }
    var go = authUI('forgotVerify');
    if (go) { go(ctxFor({ identifier: $('forgot-identifier').value, otp: $('forgot-otp').value.trim(), button: $('forgot-verify') })); return; }
    setStatus('forgot-otp-status', 'Code checking is not connected yet. ' + NOT_SENT);
  });
  onClick('forgot-complete', function () {
    var pw = $('forgot-newpw').value, ok = true;
    ok = setError('forgot-newpw', check.newPassword(pw)) && ok;
    ok = setError('forgot-confirm', check.confirm($('forgot-confirm').value, pw)) && ok;
    if (!ok) { setStatus('forgot-new-status', 'Please fix the highlighted fields.'); return; }
    var go = authUI('forgotComplete');
    if (go) { go(ctxFor({ identifier: $('forgot-identifier').value, password: pw, button: $('forgot-complete') })); return; }
    setStatus('forgot-new-status', 'Password reset is not connected yet. ' + NOT_SENT);
  });
  clearOnInput($('forgot-form'));
  clearOnInput($('forgot-code-form'));
  clearOnInput($('forgot-new-form'));

  /* ---------- Registration ---------- */
  onClick('otp-send', function () {
    var ok = setError('reg-email', check.gmail($('reg-email').value.trim()));
    if (!ok) { setStatus('otp-status', 'Enter a valid Gmail address first.'); return; }
    var go = authUI('registerSendOtp');
    if (go) { go(ctxFor({ email: $('reg-email').value.trim(), button: $('otp-send') })); return; }
    setStatus('otp-status', 'Registration is not connected yet, so no code was sent.');
  });

  onClick('otp-verify', function () {
    var ok = setError('reg-otp', check.otp($('reg-otp').value.trim()));
    if (!ok) { setStatus('otp-status', 'Please fix the highlighted field.'); return; }
    var go = authUI('registerVerifyOtp');
    if (go) { go(ctxFor({ email: $('reg-email').value.trim(), otp: $('reg-otp').value.trim(), button: $('otp-verify') })); return; }
    setStatus('otp-status', 'Code checking is not connected yet. ' + NOT_SENT);
  });

  onClick('register-submit', function () {
    var pw = $('reg-password').value;
    var ok = true;
    ok = setError('reg-username', check.username($('reg-username').value)) && ok;
    ok = setError('reg-fullname', check.fullName($('reg-fullname').value)) && ok;
    ok = setError('reg-email', check.gmail($('reg-email').value.trim())) && ok;
    ok = setError('reg-password', check.newPassword(pw)) && ok;
    ok = setError('reg-confirm', check.confirm($('reg-confirm').value, pw)) && ok;
    var consent = $('reg-consent');
    var consentMsg = consent.checked ? '' : 'You need to agree to the Terms and the Privacy Policy.';
    var out = $('reg-consent-error');
    if (out) { out.textContent = consentMsg; }
    if (consentMsg) { consent.setAttribute('aria-invalid', 'true'); } else { consent.removeAttribute('aria-invalid'); }
    ok = !consentMsg && ok;
    if (!ok) { setStatus('register-status', 'Please fix the highlighted fields.'); return; }
    var go = authUI('register');
    if (go) {
      go(ctxFor({ username: $('reg-username').value, fullName: $('reg-fullname').value.trim(), email: $('reg-email').value.trim(), password: pw, button: $('register-submit') }));
      return;
    }
    setStatus('register-status', 'Your details pass the browser checks, but registration is not connected yet. No account was created. ' + NOT_SENT);
  });
  clearOnInput($('register-form'));

  /* ---------- Practice page ---------- */
  /* ---------- Temporary preview hand-off (this browser tab only) ----------
   * The practice page passes the imported bank to the exam page through sessionStorage, which is scoped to one
   * tab and is cleared when the tab closes. It holds ONLY the allowlisted, public-safe question content and the
   * ids chosen for the preview. It never holds answer keys (the import is rejected if any are present),
   * responses, passwords or identities. Everything read back is validated again with prepareLocalBank(), because
   * storage is untrusted too. If storage is blocked, the preview simply cannot be opened; nothing else breaks. */
  var PREVIEW_BANK_KEY = 'gatePrepStudio.localPreview.bank.v1';
  var PREVIEW_SEL_KEY = 'gatePrepStudio.localPreview.selection.v1';
  var PREVIEW_PROV_KEY = 'gatePrepStudio.localPreview.provenance.v1';
  var PROV_VERSION_RE = /^[a-f0-9]{64}$/;
  var PROV_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

  /* Where a stored bank came from. Pure; never throws. Returns a NEW object holding only the known fields:
   *   { origin: 'local' }                                         a file chosen on this computer
   *   { origin: 'manifest', release }                             a static shard verified against the manifest
   *   { origin: 'published', catalogue_version, count, published_at }   from the published service (version may be null)
   *   { origin: 'unverified' }                                    stored metadata was present but not valid
   * Provenance is display and freshness metadata only. It is never merged into a question and never replaces
   * prepareLocalBank(), which still validates the questions themselves. */
  function cleanProvenance(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) { return { origin: 'unverified' }; }
    if (p.origin === 'local') { return { origin: 'local' }; }
    if (p.origin === 'manifest') {
      return typeof p.release === 'string' && RELEASE_RE.test(p.release)
        ? { origin: 'manifest', release: p.release } : { origin: 'unverified' };
    }
    if (p.origin !== 'published') { return { origin: 'unverified' }; }
    var v = p.catalogue_version, n = p.count, at = p.published_at;
    var vOk = v === null || (typeof v === 'string' && PROV_VERSION_RE.test(v));
    var nOk = n === null || (typeof n === 'number' && isFinite(n) && Math.floor(n) === n && n >= 1 && n <= 100000);
    var atOk = at === null || (typeof at === 'string' && PROV_TIME_RE.test(at) && !isNaN(new Date(at).getTime()));
    if (!vOk || !nOk || !atOk) { return { origin: 'unverified' }; }
    return { origin: 'published', catalogue_version: v, count: n, published_at: at };
  }
  var previewStore = {
    saveBank: function (local, provenance) {
      try {
        var prov = cleanProvenance(provenance || { origin: 'local' });
        root.sessionStorage.setItem(PREVIEW_BANK_KEY, JSON.stringify({ schema_version: 1, placeholder: local.placeholder, questions: local.questions }));
        root.sessionStorage.setItem(PREVIEW_PROV_KEY, JSON.stringify(prov));
        root.sessionStorage.removeItem(PREVIEW_SEL_KEY);
        return true;
      } catch (e) { return false; }
    },
    loadBank: function () {
      try {
        var text = root.sessionStorage.getItem(PREVIEW_BANK_KEY);
        return text ? prepareLocalBank(JSON.parse(text)) : null;
      } catch (e) { return null; }
    },
    /* No stored provenance (a bank saved before this existed) counts as a local import: no freshness claim is made. */
    loadProvenance: function () {
      try {
        var text = root.sessionStorage.getItem(PREVIEW_PROV_KEY);
        return text ? cleanProvenance(JSON.parse(text)) : { origin: 'local' };
      } catch (e) { return { origin: 'unverified' }; }
    },
    saveSelection: function (sel) {
      try {
        root.sessionStorage.setItem(PREVIEW_SEL_KEY, JSON.stringify({ ids: sel.ids, method: sel.method, matching: sel.matching, label: sel.label }));
        return true;
      } catch (e) { return false; }
    },
    /* Returns the stored selection as plain data, or null when absent or unreadable. It is checked afterwards
     * by resolvePreviewSelection(); nothing here falls back to "all questions". */
    loadSelection: function () {
      try {
        var sel = JSON.parse(root.sessionStorage.getItem(PREVIEW_SEL_KEY));
        if (!sel || typeof sel !== 'object') { return null; }
        return { ids: sel.ids, method: sel.method, matching: sel.matching, label: typeof sel.label === 'string' ? sel.label.slice(0, 300) : '' };
      } catch (e) { return null; }
    },
    clear: function () {
      try { root.sessionStorage.removeItem(PREVIEW_BANK_KEY); root.sessionStorage.removeItem(PREVIEW_SEL_KEY); root.sessionStorage.removeItem(PREVIEW_PROV_KEY); } catch (e) { /* nothing to clear */ }
    }
  };

  function initPractice() {
    var state = { bank: null, mode: 'custom', sel: {}, requested: null, touched: false, lastMatch: null,
                  local: null, provenance: { origin: 'local' }, fresh: { status: 'na', current: null, reason: '' }, freshSeq: 0, handoff: false, summary: null,
                  method: 'file', draw: null, bankSeq: 0, selection: null, manifest: null, choices: [], paperSeq: 0 };
    var groups = {}, selects = {}, reqSpans = {};
    FIELDS.forEach(function (f) {
      groups[f] = document.querySelector('[data-filter="' + f + '"]');
      selects[f] = $('pf-' + f);
      reqSpans[f] = $('pf-' + f + '-req');
    });
    var countInput = $('pf-count');

    function el(tag, text, cls) {
      var e = document.createElement(tag);
      if (text !== undefined) { e.textContent = text; }
      if (cls) { e.className = cls; }
      return e;
    }
    function fill(id, text) { var e = $(id); if (e) { e.textContent = text; } }

    function breakdownText(b) {
      var parts = Object.keys(b).map(function (t) {
        return t + ': ' + b[t].count + ' question' + (b[t].count === 1 ? '' : 's') + ', ' + b[t].marks + ' mark' + (b[t].marks === 1 ? '' : 's');
      });
      return parts.join('; ');
    }

    function urlSetMode() {
      try {
        var u = new URL(root.location.href);
        u.searchParams.set('mode', state.mode);
        root.history.replaceState(null, '', u.pathname + u.search + u.hash);
      } catch (e) { /* not essential */ }
    }

    function renderBankNote() {
      var b = state.bank, note = $('bank-note'), detail = $('bank-detail');
      if (!b) { note.textContent = 'Loading the question bank…'; detail.hidden = true; return; }
      var text = b.message;
      if (b.status === 'ready' && b.sources.length) { text += ' Sources named in the data: ' + b.sources.join('; ') + '.'; }
      note.textContent = text;
      detail.textContent = '';
      var items = [];
      b.warnings.forEach(function (w) { items.push(el('li', w)); });
      b.rejected.slice(0, 10).forEach(function (r) {
        items.push(el('li', 'Record #' + (r.index + 1) + (r.id ? ' (' + r.id + ')' : '') + ': ' + r.reasons.join('; ') + '.'));
      });
      if (b.rejected.length > 10) { items.push(el('li', '…and ' + (b.rejected.length - 10) + ' more record(s) not used.')); }
      if (items.length) {
        detail.appendChild(el('summary', 'Details about the question bank (' + items.length + ')'));
        var ul = el('ul', undefined, 'bank-list');
        items.forEach(function (li) { ul.appendChild(li); });
        detail.appendChild(ul);
        detail.hidden = false;
      } else { detail.hidden = true; }
    }

    function render() {
      var ready = !!state.bank && state.bank.status === 'ready';
      var records = ready ? state.bank.records : [];
      var mode = MODES[state.mode];
      var active = activeSelection(state.mode, state.sel);

      $('mode-' + state.mode).checked = true;
      fill('mode-desc', mode.desc);
      $('mock-note').hidden = !mode.awaitingConfig;
      $('pf-count-field').hidden = !!mode.awaitingConfig;

      FIELDS.forEach(function (f) {
        var shown = mode.filters.indexOf(f) >= 0;
        groups[f].hidden = !shown;
        if (!shown) { return; }
        var required = mode.required.indexOf(f) >= 0;
        reqSpans[f].textContent = required ? '(required)' : '(optional)';
        var sel = selects[f];
        sel.textContent = '';
        var first = el('option', required ? 'Choose…' : 'Any');
        first.value = '';
        sel.appendChild(first);
        facetOptions(records, active, f).forEach(function (o) {
          var opt = el('option', o.value + ' (' + o.count + ')');
          opt.value = o.value;
          sel.appendChild(opt);
        });
        sel.value = active[f] || '';
        sel.disabled = !ready;
      });

      var summary = ready ? summarise(records, state.mode, state.sel, state.requested)
                          : { state: 'no_bank', pool: 0, n: 0, exact: true, missing: [], poolBreakdown: {} };

      /* Count control */
      var countOk = summary.state === 'ok' || summary.state === 'bad_count';
      countInput.disabled = !countOk;
      var err = $('pf-count-error');
      err.textContent = '';
      if (countOk) {
        countInput.max = String(summary.pool);
        $('pf-count-hint').textContent = 'Between 1 and ' + summary.pool + ' (the number that match).';
        if (summary.state === 'ok') {
          if (summary.adjusted) { state.requested = summary.n; }
          countInput.value = String(summary.n);
        } else {
          err.textContent = 'Enter a whole number from 1 to ' + summary.pool + '.';
          countInput.setAttribute('aria-invalid', 'true');
        }
        if (summary.state === 'ok') { countInput.removeAttribute('aria-invalid'); }
      } else {
        countInput.value = '';
        countInput.removeAttribute('aria-invalid');
        $('pf-count-hint').textContent = 'Available once the filters match at least one question.';
      }

      /* Empty state */
      $('empty-state').hidden = summary.state !== 'no_matches';

      /* Live match message (updated only when it changes) */
      var msg = '';
      if (summary.state === 'awaiting_config') { msg = 'Full-length mock exams are awaiting configuration.'; }
      else if (summary.state === 'incomplete') { msg = 'Choose ' + summary.missing.map(function (f) { return FIELD_LABEL[f].toLowerCase(); }).join(' and ') + ' to see matching questions.'; }
      else if (summary.state === 'no_matches') { msg = 'No questions match these filters.'; }
      else if (summary.state === 'ok' || summary.state === 'bad_count') {
        msg = summary.pool + ' question' + (summary.pool === 1 ? '' : 's') + ' match' + (summary.pool === 1 ? 'es' : '') + ' your filters.';
        if (summary.adjusted) { msg += ' Only ' + summary.pool + ' match, so the request was reduced to ' + summary.n + '.'; }
      }
      if (msg !== state.lastMatch) { fill('match-status', msg); state.lastMatch = msg; }

      /* Summary card */
      fill('sum-mode', mode.label);
      fill('sum-filters', mode.filters.length ? describeFilters(state.mode, state.sel).join('; ') : 'None (awaiting configuration)');
      var poolText = '—', reqText = '—', marksText = '—', typesText = '—', durText = '—', selText = 'Incomplete';
      var methodText = '—', selectedText = '—';
      state.selection = summary.state === 'ok' ? chooseSelection(records, active, summary) : null;
      var chosen = state.selection;
      if (summary.state === 'ok' || summary.state === 'bad_count') { poolText = String(summary.pool); }
      else if (summary.state === 'no_matches') { poolText = '0'; }
      if (chosen) {
        reqText = String(summary.n);
        selectedText = chosen.info.count + ' of ' + summary.pool + ' matching question' + (summary.pool === 1 ? '' : 's');
        methodText = SELECTION_METHODS[chosen.method] + (chosen.method === 'all' ? '' : '. A local-preview convenience, not an approved GATE mock-composition policy.');
        marksText = chosen.info.totalMarks + ' (' + (chosen.method === 'all' ? 'all matching questions' : 'the ' + chosen.info.count + ' selected question' + (chosen.info.count === 1 ? '' : 's')) + ')';
        typesText = 'In the selected set: ' + breakdownText(chosen.info.breakdown);
        var tplan = localTimerPlan(chosen.info.totalMarks);
        durText = tplan.allowed
          ? tplan.text + ', from the marks of the selected questions. Used only by the local preview timer; it is not an approved exam duration.' + (chosen.method === 'all' ? '' : ' How a permanent subset is drawn (D-12) is still undecided.')
          : tplan.message;
        selText = 'Complete and valid';
      } else if (summary.state === 'bad_count') { reqText = 'Not a valid number'; }
      fill('sum-matching', poolText);
      fill('sum-requested', reqText);
      fill('sum-selected', selectedText);
      fill('sum-method', methodText);
      fill('sum-marks', marksText);
      fill('sum-types', typesText);
      fill('sum-duration', durText);
      fill('sum-rules', MARKING_RULES_CONFIRMED ? 'Owner-confirmed; operational scoring still requires the approved private scoring service.' : 'Not confirmed. Source-reviewed rules are reference-only; online scoring is blocked.');
      fill('sum-selection', selText);

      /* Method control: only meaningful when fewer than all matching questions are requested. */
      var subset = !!chosen && chosen.method !== 'all';
      Array.prototype.forEach.call(document.querySelectorAll('input[name="pf-method"]'), function (r) {
        r.checked = r.value === state.method;
        r.disabled = !chosen || !!mode.awaitingConfig;
      });
      var redraw = $('pf-redraw'); if (redraw) { redraw.hidden = !(subset && chosen.method === 'random'); }
      fill('pf-method-hint', !chosen ? 'Available once the filters match at least one question.'
        : subset ? 'Used now: ' + SELECTION_METHODS[chosen.method] + '.'
        : 'Not used: all ' + summary.pool + ' matching question' + (summary.pool === 1 ? ' is' : 's are') + ' requested, so every one is selected.');

      var list = blockers(summary, ready ? 'ready' : (state.bank ? state.bank.status : 'loading'));
      fill('sum-ready', list.length ? 'No' : 'Yes');
      var ul = $('blockers');
      ul.textContent = '';
      list.forEach(function (t) { ul.appendChild(el('li', t)); });
      if (chosen && chosen.method !== 'all' && !list.some(function (t) { return /subset is drawn/.test(t); })) {
        list.push('How a subset is drawn from the matching questions has not been decided (D-12). The file-order and random choices are local-preview conveniences only.');
      }
      var ul2 = $('blockers'); ul2.textContent = '';
      list.forEach(function (t) { ul2.appendChild(el('li', t)); });
      state.blockers = list;
      state.summary = summary;
      renderPreviewButton();
    }

    /* The one place a selection is made. A random draw is cached under a key built from everything that defines it,
     * so re-rendering never changes it; changing the bank, mode, filters, count or method, or pressing
     * "Draw a new sample", does. */
    function chooseSelection(records, active, summary) {
      var pool = filterRecords(records, active), n = summary.n, method = state.method;
      var key = JSON.stringify([state.bankSeq, state.mode, active, n, method]), res;
      if (method === 'random' && n < pool.length) {
        var byId = Object.create(null); pool.forEach(function (r) { byId[r.id] = r; });
        if (state.draw && state.draw.key === key && state.draw.ids.every(function (id) { return byId[id]; })) {
          res = { method: 'random', records: state.draw.ids.map(function (id) { return byId[id]; }) };
        } else {
          res = selectQuestions(pool, n, 'random');
          state.draw = res ? { key: key, ids: res.records.map(function (r) { return r.id; }) } : null;
        }
      } else { res = selectQuestions(pool, n, method); }
      if (!res) { return null; }
      return { method: res.method, records: res.records, info: selectionSummary(res.records), matching: pool.length };
    }

    /* ----- Local import (file chosen on this computer; never uploaded) ----- */
    function facetText(records, field) {
      var vals = facetOptions(records, {}, field), shown = vals.slice(0, 25).map(function (o) { return o.value + ' (' + o.count + ')'; });
      return shown.join('; ') + (vals.length > 25 ? '; …and ' + (vals.length - 25) + ' more' : '');
    }

    function renderImportReport(local) {
      var box = $('import-result'); if (!box) { return; }
      var ok = local.status === 'ready', recs = ok ? local.records : [];
      box.hidden = false;
      fill('imp-usable', ok ? String(local.records.length) : '0 (nothing loaded)');
      fill('imp-rejected', String(local.rejected.length) + (local.rejected.length ? ' (reasons below)' : ''));
      fill('imp-types', ok ? breakdownText(typeBreakdown(recs)) : '—');
      fill('imp-branches', ok ? facetText(recs, 'branch') : '—');
      fill('imp-years', ok ? facetText(recs, 'year') : '—');
      fill('imp-subjects', ok ? facetText(recs, 'subject') : '—');
      fill('imp-topics', ok ? facetText(recs, 'topic') : '—');
      fill('imp-sources', ok && local.sources.length ? local.sources.join('; ') : '—');
      var det = $('import-issues'); det.textContent = '';
      var items = [];
      local.warnings.forEach(function (w) { items.push(el('li', w)); });
      local.privateFields.slice(0, 100).forEach(function (f) {
        items.push(el('li', 'Not allowed: ' + f.where + ' has the field \u201c' + f.field + '\u201d (answer-key, explanation or scoring data).'));
      });
      if (local.privateFields.length > 100) { items.push(el('li', '…and ' + (local.privateFields.length - 100) + ' more private field(s).')); }
      local.rejected.slice(0, 200).forEach(function (r) {
        items.push(el('li', 'Record #' + (r.index + 1) + (r.id ? ' (' + r.id + ')' : '') + ' was not used: ' + r.reasons.join('; ') + '.'));
      });
      if (local.rejected.length > 200) { items.push(el('li', '…and ' + (local.rejected.length - 200) + ' more record(s) not used.')); }
      if (items.length) {
        det.appendChild(el('summary', 'Why records or fields were not used (' + items.length + ')'));
        var ul = el('ul', undefined, 'bank-list'); items.forEach(function (li) { ul.appendChild(li); });
        det.appendChild(ul); det.hidden = false; det.open = !ok || local.rejected.length > 0;
      } else { det.hidden = true; }
    }

    function renderPreviewButton() {
      var btn = $('import-open-preview'); if (!btn) { return; }
      var note = '', sum = state.summary, ch = state.selection, can = false;
      var manifestBank = !!state.local && state.provenance && state.provenance.origin === 'manifest';
      if (!state.local) { note = 'Select a verified paper above, import a public-safe JSON file, or load the published catalogue to enable the local preview.'; }
      else if (!state.handoff) { note = 'Your browser blocked temporary storage, so the exam preview cannot receive these questions. Check this tab’s session-storage settings.'; }
      else if (freshBlockNote()) { note = freshBlockNote(); }
      else if (!sum || sum.state === 'awaiting_config') { note = 'Not available for full-length mock exams, which are awaiting configuration.'; }
      else if (sum.state === 'incomplete') { note = 'Choose the required filters first.'; }
      else if (sum.state === 'no_matches') { note = 'No questions match the current filters.'; }
      else if (sum.state === 'bad_count') { note = 'Enter a whole number of questions from 1 to ' + sum.pool + ' before opening the preview.'; }
      else if (sum.state === 'ok' && ch) {
        can = true;
        note = 'The preview will open exactly ' + ch.info.count + ' of ' + sum.pool + ' matching question' + (sum.pool === 1 ? '' : 's') +
          ' (' + SELECTION_METHODS[ch.method].toLowerCase() + '), total marks ' + ch.info.totalMarks + '; ' + breakdownText(ch.info.breakdown) +
          '. Local preview only: no authoritative scoring, remote saving or online attempt.';
      }
      btn.disabled = !can;
      btn.textContent = can ? 'Open local exam preview with the ' + ch.info.count + ' selected question' + (ch.info.count === 1 ? '' : 's') : 'Open local exam preview';
      fill('import-preview-note', note);
      var clear = $('import-clear');
      if (clear) {
        clear.hidden = !state.local;
        clear.textContent = manifestBank ? 'Clear selected paper' : 'Remove loaded question bank';
      }
      var paperPreview = $('pp-open-preview');
      if (paperPreview) {
        paperPreview.hidden = !manifestBank;
        paperPreview.disabled = !can;
        paperPreview.textContent = can ? 'Open local preview with ' + ch.info.count + ' selected question' + (ch.info.count === 1 ? '' : 's') : 'Open local preview with selected questions';
      }
    }

    function openPreview() {
      var ch = state.selection, sum = state.summary;
      if (!state.local || !state.handoff || !sum || sum.state !== 'ok' || !ch || !ch.records.length) { return; }
      if (freshBlockNote()) { renderPreviewButton(); return; }
      var ids = ch.records.map(function (r) { return r.id; });
      var label = MODES[state.mode].label + (MODES[state.mode].filters.length ? ' | ' + describeFilters(state.mode, state.sel).join('; ') : '');
      if (!previewStore.saveSelection({ ids: ids, method: ch.method, matching: ch.matching, label: label })) {
        state.handoff = false; renderPreviewButton(); return;
      }
      root.location.href = 'exam.html';
    }

    function acceptLocal(local, restored, provenance) {
      state.provenance = provenance || { origin: 'local' };
      state.local = local; state.bank = local; state.bankSeq++; state.draw = null;
      state.sel = {}; state.requested = null; state.touched = false; state.lastMatch = null;
      state.freshSeq++; state.fresh = { status: isPublishedBank() ? 'checking' : 'na', current: null, reason: '' };
      renderImportReport(local); renderBankNote(); render(); renderFresh();
      if (isPublishedBank()) { runCheck(); }   /* published banks are checked against op=metadata; local imports never touch the network */
      setStatus('import-status', local.message + (restored ? ' (Restored from this tab\u2019s temporary preview storage.)' : '') +
        (state.handoff ? '' : ' Temporary browser storage is blocked, so the exam preview cannot receive these questions.'));
    }

    function importFile(file) {
      if (!file) { return; }
      if (file.size > LOCAL_LIMITS.fileBytes) {
        setStatus('import-status', 'Import not accepted: the file is larger than ' + (LOCAL_LIMITS.fileBytes / 1048576) + ' MB. Nothing was loaded.');
        return;
      }
      setStatus('import-status', 'Reading the file in this browser…');
      var reader = new FileReader();
      reader.onerror = function () { setStatus('import-status', 'Import not accepted: the file could not be read. Nothing was loaded.'); };
      reader.onload = function () {
        var raw;
        try { raw = JSON.parse(String(reader.result).replace(/^\uFEFF/, '')); }
        catch (e) { setStatus('import-status', 'Import not accepted: ' + BANK_MESSAGES.invalid_json + ' Nothing was loaded.'); return; }
        var local = prepareLocalBank(raw);
        if (local.status !== 'ready') {
          renderImportReport(local);
          setStatus('import-status', 'Import not accepted. ' + local.message + (state.local ? ' The bank you imported earlier is unchanged.' : ''));
          return;
        }
        var prov = { origin: 'local' };
        state.handoff = previewStore.saveBank(local, prov);
        acceptLocal(local, false, prov);
      };
      reader.readAsText(file);
    }

    /* Published catalogue (read-only, public). The response is untrusted data: it goes through prepareLocalBank()
     * like a file. Nothing starts automatically and an existing bank is kept if the load fails. */
    var CATALOGUE_MESSAGES = {
      busy: 'A catalogue request is already in progress.',
      timeout: 'The catalogue service did not respond in time. Nothing was loaded. You can try again or import a file.',
      connection: 'The catalogue service could not be reached. Nothing was loaded. You can try again or import a file.',
      bad_response: 'The catalogue service returned something this page does not recognise. Nothing was loaded.',
      server_error: 'The catalogue service reported a problem. Nothing was loaded.'
    };
    var SERVER_CODES = {
      not_configured: 'the catalogue service is not configured yet',
      source_unavailable: 'the catalogue source could not be opened',
      sheet_missing: 'the public catalogue sheet is missing',
      forbidden_columns: 'the published sheet contains answer-key, explanation or scoring-type columns, so it was refused',
      bad_columns: 'the published sheet does not match the public schema',
      empty_catalogue: 'the published catalogue is empty',
      too_large: 'the published catalogue is too large',
      malformed_data: 'some published records are invalid, so none were published'
    };

    /* ----- Published-catalogue freshness (best-effort client-side check, not a security boundary) ----- */
    function isPublishedBank() { return !!state.local && state.provenance && state.provenance.origin === 'published'; }
    function isUnconfirmedBank() { return !!state.local && state.provenance && state.provenance.origin === 'unverified'; }
    function shortVer(v) { return typeof v === 'string' ? v.slice(0, 12) + '\u2026' : ''; }

    function freshReasonText(code, serverCode) {
      switch (code) {
        case 'not_configured': return 'No catalogue endpoint is configured on this site, so freshness cannot be verified.';
        case 'noversion': return 'The version of this catalogue was not recorded when it was loaded, so freshness cannot be verified. Reload the catalogue.';
        case 'busy': return 'Another catalogue request is still in progress. Try again in a moment.';
        case 'timeout': case 'connection': return 'The catalogue service could not be reached (network failure or timeout).';
        case 'bad_response': return 'The catalogue service returned a response this page does not recognise (malformed or missing version).';
        case 'server_error': return 'The catalogue service reported that the catalogue is not available' + (SERVER_CODES[serverCode] ? ': ' + SERVER_CODES[serverCode] : '') + '.';
        default: return 'Freshness could not be verified.';
      }
    }

    /* Resolves (never rejects) to { status: 'current' | 'stale' | 'unverified', current, reason }. */
    function verifyFreshness() {
      var prov = state.provenance, api = root.GatePublicApi;
      if (!prov.catalogue_version) { return Promise.resolve({ status: 'unverified', current: null, reason: freshReasonText('noversion') }); }
      if (!api || typeof api.isConfigured !== 'function' || !api.isConfigured() || typeof api.loadCatalogueMetadata !== 'function') {
        return Promise.resolve({ status: 'unverified', current: null, reason: freshReasonText('not_configured') });
      }
      return api.loadCatalogueMetadata().then(function (meta) {
        /* Both versions must be valid 64-character hex strings; only then are they compared. */
        var ok = /^[a-f0-9]{64}$/.test(prov.catalogue_version) && meta && /^[a-f0-9]{64}$/.test(meta.catalogue_version);
        if (!ok) { return { status: 'unverified', current: null, reason: freshReasonText('bad_response') }; }
        return { status: meta.catalogue_version === prov.catalogue_version ? 'current' : 'stale', current: meta.catalogue_version, reason: '' };
      }, function (err) {
        return { status: 'unverified', current: null, reason: freshReasonText(err && err.code, err && err.serverCode) };
      });
    }

    /* Runs a check and applies it unless the bank or a newer check has superseded it. Questions are never touched. */
    function runCheck() {
      if (!isPublishedBank()) { return Promise.resolve(); }
      var seq = ++state.freshSeq, bseq = state.bankSeq;
      state.fresh = { status: 'checking', current: null, reason: '' };
      renderFresh(); renderPreviewButton();
      return verifyFreshness().then(function (res) {
        if (seq !== state.freshSeq || bseq !== state.bankSeq) { return; }
        state.fresh = res; renderFresh(); renderPreviewButton();
      });
    }

    function renderFresh() {
      var box = $('catalogue-fresh'); if (!box) { return; }
      var pub = isPublishedBank();
      box.hidden = !pub;
      if (!pub) { return; }
      var f = state.fresh, prov = state.provenance;
      var loadedEl = $('cf-loaded');
      loadedEl.textContent = prov.catalogue_version ? shortVer(prov.catalogue_version) : 'Not recorded';
      loadedEl.title = prov.catalogue_version || '';
      var curEl = $('cf-current');
      curEl.textContent = f.current ? shortVer(f.current) : (f.status === 'checking' ? 'Checking\u2026' : 'Not retrieved');
      curEl.title = f.current || '';
      var text = f.status === 'checking' ? 'Checking the published catalogue version\u2026'
        : f.status === 'current' ? 'Up to date: the loaded questions match the currently published catalogue version.'
        : f.status === 'stale' ? 'Stale: the published catalogue has changed since these questions were loaded. Preview is blocked until you reload the latest catalogue.'
        : 'Could not verify freshness. ' + f.reason + ' Your questions are unchanged, but the preview stays blocked until a check succeeds.';
      setStatus('catalogue-fresh-status', text);
      $('catalogue-reload').hidden = f.status !== 'stale';
      $('catalogue-check').disabled = f.status === 'checking' || state.catalogueBusy === true;
      $('catalogue-reload').disabled = state.catalogueBusy === true;
    }

    function setCatalogueBusy(on) {
      state.catalogueBusy = on;
      $('catalogue-load').disabled = on;
      renderFresh();
    }

    /* Why the preview is blocked, or '' when it is not. Local imports are never blocked here. */
    function freshBlockNote() {
      if (isUnconfirmedBank()) { return 'Preview is blocked: where this question bank came from could not be confirmed. Load the published catalogue or import a file again.'; }
      if (!isPublishedBank()) { return ''; }
      var f = state.fresh;
      if (f.status === 'current') { return ''; }
      if (f.status === 'checking') { return 'Preview is blocked while the published catalogue version is being checked.'; }
      if (f.status === 'stale') { return 'Preview is blocked: the published catalogue has changed since these questions were loaded. Use \u201cReload latest catalogue\u201d, then choose your questions again.'; }
      return 'Preview is blocked because freshness of the published catalogue could not be verified. ' + f.reason + ' Your questions are unchanged. Use \u201cCheck for updates\u201d to try again.';
    }

    function loadPublished() {
      var api = root.GatePublicApi;
      if (!api || typeof api.isConfigured !== 'function' || !api.isConfigured()) {
        setStatus('catalogue-status', 'The published question catalogue is not connected yet: no catalogue endpoint has been configured for this site. You can still import a question-bank file below.');
        return;
      }
      setCatalogueBusy(true);
      setStatus('catalogue-status', 'Loading the published question catalogue…');
      api.loadPublicCatalogue().then(function (raw) {
        /* Only the bank fields go to prepareLocalBank(); the version metadata travels separately and is never a question field. */
        var local = prepareLocalBank({ schema_version: raw.schema_version, questions: raw.questions });   /* never bypassed */
        if (local.status !== 'ready') {
          renderImportReport(local);
          setStatus('catalogue-status', 'Catalogue not accepted. ' + local.message + (state.local ? ' The bank you loaded earlier is unchanged.' : ''));
          return;
        }
        local.message = local.message.replace('Local question bank loaded', 'Published question catalogue loaded');
        var meta = raw.meta || null;
        var prov = cleanProvenance({ origin: 'published', catalogue_version: meta ? meta.catalogue_version : null,
                                     count: meta ? meta.count : null, published_at: meta ? meta.published_at : null });
        state.handoff = previewStore.saveBank(local, prov);
        acceptLocal(local, false, prov);
        setStatus('catalogue-status', local.message + (prov.catalogue_version ? ' Catalogue version ' + prov.catalogue_version.slice(0, 12) + '\u2026.' : ' The service did not provide a valid version, so the exam preview cannot check freshness.') +
          ' Your earlier question selection was cleared: choose the questions you want again. No exam has started.' +
          (state.handoff ? '' : ' Temporary browser storage is blocked, so the exam preview cannot receive these questions.'));
      }, function (err) {
        var code = err && err.code, text = CATALOGUE_MESSAGES[code] || CATALOGUE_MESSAGES.bad_response;
        if (code === 'server_error') {
          var why = SERVER_CODES[err.serverCode];
          text = 'The catalogue service did not provide a catalogue' + (why ? ': ' + why : '') + '. Nothing was loaded.';
        }
        setStatus('catalogue-status', text + (state.local ? ' The bank you loaded earlier is unchanged.' : ''));
      }).then(function () { setCatalogueBusy(false); });
    }

    function removeLocal() {
      previewStore.clear();
      state.local = null; state.bank = null; state.handoff = false; state.bankSeq++; state.draw = null; state.sel = {}; state.requested = null; state.lastMatch = null;
      $('import-result').hidden = true; $('import-file').value = '';
      setStatus('import-status', 'The loaded question bank was cleared from this page and temporary storage.');
      setStatus('catalogue-status', '');
      state.freshSeq++; state.fresh = { status: 'na', current: null, reason: '' }; state.provenance = { origin: 'local' }; renderFresh();
      renderBankNote(); render(); loadDefault();
    }

    /* Task 49: manifest first. No manifest (404) -> the legacy data/questions.json bank, as before. A manifest that exists but cannot be used is an
     * error shown to the person; the legacy file is never loaded in its place. Choosing a paper loads only that paper's file(s). */
    function bankOf(status, message, warnings) {
      return { origin: 'manifest', status: status, message: message, records: [], rejected: [], warnings: warnings || [], total: 0, sources: [], placeholder: false, shards: [], failures: [] };
    }
    function loadDefault() {
      var fetchFn = typeof root.fetch === 'function' ? root.fetch.bind(root) : null;
      return loadCatalogue(fetchFn).then(function (res) {
        if (state.local) { return; }   /* a file chosen meanwhile wins */
        state.paperSeq++;
        if (res.mode === 'legacy') { state.manifest = null; state.choices = []; state.bank = res.bank; }
        else if (res.status === 'ready') { state.manifest = res.manifest; state.choices = res.choices; state.bank = bankOf('choose', 'Choose a paper and year under \u201cOfficial papers\u201d to load its questions. Nothing has been loaded yet.'); }
        else { state.manifest = null; state.choices = []; state.bank = bankOf('manifest_' + res.status, res.message, (res.problems || []).slice(0, 10).map(function (p) { return 'Manifest: ' + p + '.'; })); }
        renderPapers(); renderBankNote(); render();
      });
    }

    function renderPapers() {
      var card = $('paper-card'); if (!card) { return; }
      card.hidden = !state.manifest;
      var ps = $('pp-paper'), ys = $('pp-year'), vs = $('pp-variant');
      if (!state.manifest) { return; }
      function opts(sel, items, placeholder) {
        sel.textContent = '';
        var o = el('option', placeholder); o.value = ''; sel.appendChild(o);
        items.forEach(function (it) { var op = el('option', it.label); op.value = it.value; sel.appendChild(op); });
      }
      opts(ps, state.choices.map(function (p) { return { value: p.code, label: p.code + ' \u2013 ' + p.name }; }), 'Choose a paper');
      opts(ys, [], 'Choose a paper first'); ys.disabled = true;
      opts(vs, [], 'Choose a set'); $('pp-variant-field').hidden = true;
      $('pp-load').disabled = true;
    }
    function paperChoice() { var c = state.choices.filter(function (p) { return p.code === $('pp-paper').value; })[0]; return c || null; }
    function yearChoice() { var p = paperChoice(); return p ? (p.years.filter(function (y) { return String(y.year) === $('pp-year').value; })[0] || null) : null; }
    function syncPaperControls() {
      var p = paperChoice(), y = yearChoice(), vs = $('pp-variant'), vf = $('pp-variant-field');
      var ok = !!p && !!y && (!y.variants.length || !!vs.value);
      var externalBank = !!state.local && (!state.provenance || state.provenance.origin !== 'manifest');
      $('pp-load').disabled = !ok || externalBank;
      if ($('pp-load')) { $('pp-load').textContent = state.local && state.provenance.origin === 'manifest' ? 'Replace with selected paper' : 'Load selected paper'; }
    }
    function onPaperChange() {
      var p = paperChoice(), ys = $('pp-year');
      ys.textContent = ''; var o = el('option', p ? 'Choose a year' : 'Choose a paper first'); o.value = ''; ys.appendChild(o);
      if (p) { p.years.forEach(function (y) { var op = el('option', String(y.year)); op.value = String(y.year); ys.appendChild(op); }); }
      ys.disabled = !p; onYearChange();
    }
    function onYearChange() {
      var y = yearChoice(), vs = $('pp-variant'), vf = $('pp-variant-field');
      vs.textContent = ''; var o = el('option', 'Choose a set'); o.value = ''; vs.appendChild(o);
      if (y && y.variants.length) {
        y.variants.forEach(function (v) { var op = el('option', 'Set ' + v); op.value = v; vs.appendChild(op); });
        if (y.variants.length === 1) { vs.value = y.variants[0]; }
        vf.hidden = false;
        fill('pp-variant-hint', y.setRequired ? 'This year has more than one official set. Choose one; sets are never merged.' : 'This year has one official set.');
      } else { vf.hidden = true; }
      syncPaperControls();
    }
    function loadSelectedPaper() {
      if (state.local && (!state.provenance || state.provenance.origin !== 'manifest')) {
        setStatus('pp-status', 'A local file or catalogue bank is loaded. Clear it below before loading a static paper.'); return;
      }
      var p = paperChoice(), y = yearChoice(); if (!p || !y || !state.manifest) { return; }
      var sel = { paper: p.code, year: y.year }; if (y.variants.length) { sel.variant = $('pp-variant').value; }
      var seq = ++state.paperSeq, fetchFn = typeof root.fetch === 'function' ? root.fetch.bind(root) : null;
      $('pp-load').disabled = true;
      previewStore.clear(); state.local = null; state.handoff = false; state.provenance = { origin: 'local' };
      state.bank = bankOf('loading', 'Loading the selected paper. No questions are available until every selected shard passes validation.');
      state.sel = {}; state.requested = null; state.touched = false; state.draw = null; state.lastMatch = null; state.bankSeq++;
      setStatus('pp-status', 'Loading ' + p.code + ' ' + y.year + (sel.variant ? ' set ' + sel.variant : '') + '\u2026'); renderBankNote(); renderPreviewButton(); render();
      return loadPaper(fetchFn, state.manifest, sel).then(function (bank) {
        if (seq !== state.paperSeq) { return; }
        if (bank.status === 'ready') {
          /* Re-run the common local-bank validation before passing safe question text/options to the preview. */
          var local = prepareLocalBank({ schema_version: 1, placeholder: bank.placeholder === true, questions: bank.questions || [] });
          if (local.status === 'ready') {
            local.message = bank.message + ' Text/options passed the local-preview allowlist. This browser preview does not score or save remotely.';
            var prov = cleanProvenance({ origin: 'manifest', release: state.manifest.release });
            state.handoff = previewStore.saveBank(local, prov);
            acceptLocal(local, false, prov);
            if (!state.handoff) { setStatus('pp-status', 'Paper data was validated, but this tab could not hold the temporary preview data. Check session-storage settings; nothing was started.'); }
            else { setStatus('pp-status', bank.message + ' The verified questions now feed the filters and local exam preview below.'); }
          } else {
            state.bank = bankOf('paper_invalid', 'The paper passed shard checks but failed the additional local-preview validation. Nothing was loaded.');
            state.local = null; state.handoff = false; previewStore.clear();
            setStatus('pp-status', 'Not loaded. ' + local.message);
          }
        } else {
          state.bank = bank; state.local = null; state.handoff = false; previewStore.clear();
          setStatus('pp-status', 'Not loaded. ' + bank.message);
        }
        state.sel = {}; state.bankSeq++; state.draw = null;
        syncPaperControls(); renderBankNote(); renderPreviewButton(); render();
      }).catch(function () {
        if (seq !== state.paperSeq) { return; }
        state.bank = bankOf('paper_failed', 'The selected paper could not be loaded. Nothing was loaded.'); state.local = null; state.handoff = false; previewStore.clear();
        setStatus('pp-status', 'Not loaded. The selected paper request failed. Nothing was loaded.');
        syncPaperControls(); renderBankNote(); renderPreviewButton(); render();
      });
    }

    /* Wiring */
    Array.prototype.forEach.call(document.querySelectorAll('input[name="practice-mode"]'), function (radio) {
      radio.addEventListener('change', function () {
        if (!radio.checked) { return; }
        state.mode = radio.value; state.requested = null; state.touched = false; state.lastMatch = null;
        setStatus('summary-status', '');
        urlSetMode(); render();
      });
    });
    FIELDS.forEach(function (f) {
      selects[f].addEventListener('change', function () {
        state.sel[f] = selects[f].value;
        if (!state.touched) { state.requested = null; }
        render();
      });
    });
    countInput.addEventListener('input', function () {
      var raw = countInput.value.trim();
      state.touched = true;
      state.requested = raw === '' ? NaN : Number(raw);
      render();
    });
    $('pf-reset').addEventListener('click', function () {
      state.sel = {}; state.requested = null; state.touched = false; state.lastMatch = null;
      setStatus('summary-status', '');
      render();
    });
    $('practice-form').addEventListener('submit', function (e) { e.preventDefault(); });
    $('start-test').addEventListener('click', function () {
      var list = state.blockers || [];
      setStatus('summary-status', list.length
        ? 'A test cannot start yet. Missing: ' + list.join(' ')
        : 'Ready.');
    });

    /* Initial mode from ?mode= (unknown or missing values fall back to custom tests) */
    var param = null;
    try { param = new URLSearchParams(root.location.search).get('mode'); } catch (e) { param = null; }
    if (param && MODE_ORDER.indexOf(param) >= 0) { state.mode = param; }

    if ($('catalogue-load')) { $('catalogue-load').addEventListener('click', loadPublished); }
    if ($('pp-load')) {
      $('pp-paper').addEventListener('change', onPaperChange); $('pp-year').addEventListener('change', onYearChange);
      $('pp-variant').addEventListener('change', syncPaperControls); $('pp-load').addEventListener('click', loadSelectedPaper);
    }
    if ($('pp-open-preview')) { $('pp-open-preview').addEventListener('click', openPreview); }
    if ($('import-file')) {
      $('import-file').addEventListener('change', function () { importFile($('import-file').files && $('import-file').files[0]); });
      $('import-clear').addEventListener('click', removeLocal);
      $('import-open-preview').addEventListener('click', function () {
        if (!isPublishedBank()) { openPreview(); return; }   /* local imports and static manifest shards: no freshness endpoint */
        /* Final guard: re-check the published version immediately before any handoff. */
        runCheck().then(function () {
          if (state.fresh.status === 'current') { openPreview(); return; }
          setStatus('catalogue-fresh-status', (freshBlockNote() || 'Freshness could not be confirmed.') + ' The preview was not opened and no selection was handed off.');
        });
      });
    }
    if ($('catalogue-check')) {
      $('catalogue-check').addEventListener('click', function () { runCheck(); });
      $('catalogue-reload').addEventListener('click', loadPublished);
    }
    Array.prototype.forEach.call(document.querySelectorAll('input[name="pf-method"]'), function (r) {
      r.addEventListener('change', function () { if (r.checked) { state.method = r.value; state.draw = null; render(); } });
    });
    if ($('pf-redraw')) { $('pf-redraw').addEventListener('click', function () { state.draw = null; render(); fill('match-status', 'A new random sample was drawn.'); state.lastMatch = null; }); }

    render();
    renderBankNote();
    var restored = $('import-file') ? previewStore.loadBank() : null;
    if (restored && restored.status === 'ready') {
      state.handoff = true; acceptLocal(restored, true, previewStore.loadProvenance()); root.__practiceReady = true;
    } else {
      loadDefault().then(function () { root.__practiceReady = true; });
    }
  }

  if ($('practice-form')) { initPractice(); }

  /* ---------- Exam window (LOCAL PREVIEW) ----------
   * Questions come only from a bank the person selected on the practice page (handed over through this tab's
   * sessionStorage, see previewStore). Nothing is invented: with no bank, an empty state is shown. Responses stay
   * in this page's memory. Nothing is sent, saved remotely, server-timed or scored, and no answer keys exist
   * here. The attempt logic is the existing state machine (createExam and friends). The question text and option
   * text live in a separate lookup (qmap) so that the state machine still holds only ids, types and selections. */
  var STATUS_TEXT = { answered: 'answered', unanswered: 'not answered', review: 'marked for review', none: 'not visited' };
  var TYPE_HELP = { MCQ: 'Select one option.', MSQ: 'Select one or more options.', NAT: 'Enter a number.' };
  var STATE_TEXT = {
    in_progress: 'Attempt state: in progress (local preview).',
    submitted: 'Attempt state: submitted (local preview). Your responses are now read-only. Nothing was sent or scored.',
    timed_out: 'Attempt state: time is up (local preview). Responses saved so far are kept and are read-only.'
  };
  var NO_BANK_TEXT = 'No question bank has been imported. This preview only shows questions from a JSON file you select on the Practice page, and it never makes up questions.';

  /* Reads the temporary hand-off and re-validates both parts. Returns { status, message, questions, label, method,
   * matching }. status: 'missing' (no bank: empty state), 'invalid' (bank or selection unusable: error state) or
   * 'ready'. It never substitutes the whole bank for a missing or bad selection. */
  function loadPreviewQuestions() {
    function fail(status, message) { return { status: status, message: message, questions: [], label: '', method: '', matching: 0 }; }
    var local = previewStore.loadBank();
    if (!local) { return fail('missing', NO_BANK_TEXT); }
    if (local.status !== 'ready') {
      return fail('invalid', 'The temporarily stored question bank could not be used (' + local.message + ') Import the file again on the Practice page.');
    }
    var prov = previewStore.loadProvenance();
    var sel = previewStore.loadSelection();
    if (!sel) { return fail('invalid', 'No question selection was passed to the preview (it is missing or unreadable).'); }
    var res = resolvePreviewSelection(local.questions, sel);
    if (!res.ok) { return fail('invalid', res.error); }
    return { status: 'ready', questions: res.questions, label: sel.label || 'selected questions', method: sel.method, matching: sel.matching,
             placeholder: local.placeholder, provenance: prov,
             message: (prov.origin === 'published' ? 'Local preview: ' + res.questions.length + ' question' + (res.questions.length === 1 ? '' : 's') + ' from the published question catalogue.'
                                                    : 'Local preview: ' + res.questions.length + ' question' + (res.questions.length === 1 ? '' : 's') + ' from the file you selected.') };
  }

  function initExam() {
    var loaded = loadPreviewQuestions();
    var questions = loaded.questions, qmap = Object.create(null);
    questions.forEach(function (q) { qmap[q.id] = q; });
    function makeItems() {
      return questions.map(function (q) {
        return { id: q.id, type: q.type, options: q.options ? q.options.map(function (o) { return o.id; }) : undefined };
      });
    }
    var ex;
    try { ex = createExam(makeItems()); }
    catch (e) { questions = []; qmap = Object.create(null); loaded = { status: 'invalid', message: 'The selected questions could not be used to build the preview.', questions: [] }; ex = createExam([]); }
    var bankStatus = questions.length ? 'ready' : 'missing';
    var state = { blockers: [], armed: false, restartArmed: false, timerId: null };
    var totalMarks = questions.reduce(function (t, q) { return t + q.marks; }, 0);
    var plan = localTimerPlan(totalMarks);

    function el(tag, text, cls) {
      var e = document.createElement(tag);
      if (text !== undefined) { e.textContent = text; }
      if (cls) { e.className = cls; }
      return e;
    }
    function fill(id, text) { var e = $(id); if (e) { e.textContent = text; } }
    function curItem() { return ex.byId[ex.ids[ex.current]]; }
    function isOpen() { return examIsOpen(ex); }

    /* ----- policy gate display: year selection changes the reference status only, never a gate ----- */
    function renderProfileStatus(year) {
      var gates = policyStatus(year), mp = $('mark-profile-rules'), mb = $('mark-profile-blockers');
      fill('mark-profile-title', 'Marking profile: ' + (gates.year === null ? 'selected year' : 'GATE ' + gates.year) + ' (' + gates.profileStatus.replace(/_/g, ' ') + ')');
      fill('mark-policy-status', 'Policy status: ' + gates.specStatus.replace(/_/g, ' ') + '; profile ' + gates.profileStatus.replace(/_/g, ' ') + '; scoring ' + (gates.canScore ? 'enabled' : 'BLOCKED') + '; online attempts ' + (gates.canStartOnlineExam ? 'enabled' : 'BLOCKED') + '; answer review ' + (gates.canReviewAnswers ? 'enabled' : 'BLOCKED') + '.');
      if (mp && mb) {
        mp.textContent = ''; mb.textContent = '';
        describeProfile(year).forEach(function (t) { mp.appendChild(el('li', t)); });
        gates.blockers.forEach(function (t) { mb.appendChild(el('li', t)); });
      }
    }
    function renderGate() {
      var list = examBlockers(bankStatus), ul = $('exam-blockers');
      ul.textContent = '';
      list.forEach(function (t) { ul.appendChild(el('li', t)); });
      $('exam-start').setAttribute('aria-disabled', examAttemptsEnabled(bankStatus) ? 'false' : 'true');
      state.blockers = list;
      renderProfileStatus(2026);
      var yearInput = $('mark-policy-year'), yearCheck = $('mark-policy-check');
      if (yearInput && yearCheck) {
        yearCheck.addEventListener('click', function () {
          var value = Number(yearInput.value);
          if (!wholeNumber(value) || value < 1900 || value > 2100) {
            yearInput.setAttribute('aria-invalid', 'true');
            fill('mark-policy-status', 'Enter a whole-number year from 1900 to 2100. This lookup does not change any policy gate.');
            return;
          }
          yearInput.removeAttribute('aria-invalid');
          renderProfileStatus(value);
        });
      }
    }

    /* ----- countdown display (display only) ----- */
    function showRemaining(seconds) {
      var shown = formatClock(seconds);
      fill('exam-timer', shown);
      fill('exam-timer-state', typeof seconds === 'number' && isFinite(seconds)
        ? (seconds <= 0 ? 'Time is up.' : 'Time remaining') : 'Not running (local preview)');
    }

    /* ----- local countdown ----- */
    function stopTimer() { if (state.timerId !== null) { root.clearInterval(state.timerId); state.timerId = null; } }
    function disarm() { state.armed = false; state.restartArmed = false; }

    /* Shows the clock from the existing state machine. examStatus() applies the deadline, so reading it can close
     * the attempt as timed out. Once the attempt is closed the display stays at zero and the interval is stopped. */
    function syncTimer() {
      if (!ex.clock) {
        stopTimer();
        fill('exam-timer', formatClock(null));
        fill('exam-timer-state', ex.status === 'in_progress' ? 'Timer not started (local preview)'
          : ex.status === 'submitted' ? 'Submitted (local preview)' : 'Time is up (local preview)');
        return;
      }
      var st = examStatus(ex);
      if (st === 'in_progress') {
        fill('exam-timer', formatClock(examRemaining(ex)));
        fill('exam-timer-state', 'Time remaining (local timer, not server-enforced)');
      } else {
        stopTimer();
        fill('exam-timer', formatClock(0));
        fill('exam-timer-state', st === 'submitted' ? 'Submitted (local preview)' : 'Time is up (local preview)');
      }
    }

    function startBlockReason() {
      if (!questions.length) {
        return loaded.status === 'invalid' ? 'No valid question selection exists, so the timer cannot start.' : 'No question bank has been imported, so the timer cannot start.';
      }
      if (!plan.allowed) { return plan.message; }
      if (ex.clock) {
        return ex.status === 'in_progress' ? 'The local timer is running. It cannot be paused. Use restart to begin a fresh preview.'
                                           : 'This timed preview has ended. Use restart to begin a fresh preview.';
      }
      if (ex.status !== 'in_progress') { return 'This preview was already submitted or closed. Use restart to begin a fresh preview.'; }
      return '';
    }
    function renderTimerPanel() {
      var info = selectionSummary(questions);
      fill('tp-count', questions.length ? String(info.count) : '\u2014');
      fill('tp-marks', questions.length ? String(info.totalMarks) : '\u2014');
      fill('tp-duration', questions.length ? (plan.allowed ? plan.text + ' (fixed formula, calculated from the selected questions only)' : plan.text) : '\u2014');
      var reason = startBlockReason();
      fill('exam-timer-block', reason);
      $('exam-start-timer').disabled = reason !== '';
    }

    function tick() {
      var before = ex.status;
      syncTimer();
      if (before === 'in_progress' && ex.status !== 'in_progress') {   /* deadline reached: closed by examStatus() */
        disarm();
        fill('exam-status', 'Time is up (local preview). Responses are kept in this page only and are now read-only.');
        refresh();
      }
    }

    function startTimer() {
      if (startBlockReason() !== '') { renderTimerPanel(); return; }
      var now = Date.now();   /* the one fixed start timestamp; the deadline is startedAtMs + duration and is never recomputed */
      try {
        var snap = examSnapshot(ex);
        snap.clock = { durationSeconds: plan.seconds, startedAtMs: now };
        ex = examRestore(makeItems(), snap, now);   /* keeps responses and review flags already entered */
      } catch (e) {
        fill('exam-timer-status', 'The timer could not be started safely. Nothing was changed.');
        return;
      }
      disarm();
      stopTimer();
      state.timerId = root.setInterval(tick, 1000);
      fill('exam-timer-status', 'Local timer started for ' + formatDuration(plan.seconds) + '. It runs in this browser only, is not enforced by a server and cannot be paused.');
      fill('exam-status', '');
      refresh();
    }

    /* ----- attempt state banner and read-only switches ----- */
    function renderState() {
      syncTimer();   /* may close the attempt if the deadline has passed */
      var st = ex.status;
      fill('exam-state', st === 'in_progress'
        ? (ex.clock ? 'Attempt state: in progress (local preview, local timer running; not enforced by a server).'
                    : 'Attempt state: in progress (local preview, timer not started).')
        : STATE_TEXT[st]);
      var closed = st !== 'in_progress';
      var sub = $('exam-submit');
      sub.disabled = closed;
      sub.textContent = closed ? 'Submitted (local preview)' : state.armed ? 'Confirm: submit and lock answers (local preview)' : 'Submit exam (local preview)';
      if (st === 'timed_out') { sub.textContent = 'Time is up (local preview)'; }
      $('exam-simulate-timeup').disabled = closed;
      $('exam-restart').textContent = state.restartArmed ? 'Confirm restart: clear all responses' : 'Preview: restart (clears all responses)';
      renderTimerPanel();
    }

    /* ----- palette and counts ----- */
    function renderPalette() {
      var grid = $('exam-palette'); grid.textContent = '';
      ex.ids.forEach(function (id, idx) {
        var ps = examPaletteState(ex, idx);
        var cls = { answered: 'a', unanswered: 'u', review: 'r', none: 'n' }[ps.status];
        var b = el('button', String(idx + 1), 'pq ' + cls + (ps.marked && ps.answered ? ' am' : ''));
        b.type = 'button';
        b.setAttribute('data-index', String(idx));
        b.setAttribute('aria-label', 'Question ' + (idx + 1) + ': ' + STATUS_TEXT[ps.status] +
          (ps.marked && ps.answered ? ', also has an answer' : ''));
        if (ps.current) { b.setAttribute('aria-current', 'true'); }
        grid.appendChild(b);
      });
      var s = examSummary(ex);
      fill('cnt-answered', String(s.answered));
      fill('cnt-notanswered', String(s.notAnswered));
      fill('cnt-marked', String(s.marked));
      fill('cnt-notvisited', String(s.notVisited));
    }

    /* ----- question panel ----- */
    function renderQuestion() {
      var item = curItem(), n = ex.current + 1, open = isOpen();
      fill('exam-qtitle', 'Question ' + n + ' of ' + ex.ids.length);
      fill('exam-qtype', 'Type: ' + item.type + '. ' + TYPE_HELP[item.type] + (open ? '' : ' Read-only.'));
      var q = qmap[item.id];
      fill('exam-qmarks', 'Marks: ' + q.marks);
      fill('exam-qmeta', q.branch + ' | ' + q.year + ' | ' + q.subject + ' | ' + q.topic + ' | Source: ' + q.source.name);
      fill('exam-qtext', q.text);
      var area = $('exam-answer'); area.textContent = '';
      var saved = ex.responses[item.id];
      if (item.type === 'NAT') {
        var wrap = el('p', undefined, 'field');
        var lab = el('label', 'Your answer (a number)'); lab.setAttribute('for', 'exam-nat');
        var inp = el('input'); inp.type = 'text'; inp.id = 'exam-nat'; inp.setAttribute('inputmode', 'decimal');
        inp.setAttribute('autocomplete', 'off'); inp.setAttribute('maxlength', String(NAT_MAX_LEN));
        inp.value = typeof saved === 'string' ? saved : '';
        inp.disabled = !open;
        inp.addEventListener('input', function () {
          if (examSetAnswer(ex, item.id, inp.value)) { renderPalette(); fill('exam-status', ''); }
          else if (!isOpen()) { refresh(); }
        });
        wrap.appendChild(lab); wrap.appendChild(inp); area.appendChild(wrap);
      } else {
        var fs = el('fieldset', undefined, 'exam-options');
        fs.appendChild(el('legend', 'Answer options for question ' + n));
        var optText = Object.create(null);
        q.options.forEach(function (o) { optText[o.id] = o.text; });
        item.options.forEach(function (oid) {
          var row = el('p', undefined, 'exam-opt');
          var input = el('input'); input.type = item.type === 'MCQ' ? 'radio' : 'checkbox';
          input.name = 'exam-answer'; input.value = oid; input.id = 'exam-opt-' + oid;
          input.checked = item.type === 'MCQ' ? saved === oid : (Array.isArray(saved) && saved.indexOf(oid) >= 0);
          input.disabled = !open;
          var l = el('label', oid + '. ' + optText[oid]); l.setAttribute('for', input.id);
          input.addEventListener('change', function () {
            var ok;
            if (item.type === 'MCQ') { ok = examSetAnswer(ex, item.id, oid); }
            else {
              var picked = Array.prototype.map.call(fs.querySelectorAll('input:checked'), function (c) { return c.value; });
              ok = examSetAnswer(ex, item.id, picked);
            }
            if (ok) { renderPalette(); fill('exam-status', ''); } else { refresh(); }
          });
          row.appendChild(input); row.appendChild(l); fs.appendChild(row);
        });
        area.appendChild(fs);
      }
      var mk = $('exam-mark');
      mk.setAttribute('aria-pressed', ex.marked[item.id] ? 'true' : 'false');
      mk.disabled = !open;
      $('exam-clear').disabled = !open;
      fill('exam-mark-state', (ex.marked[item.id] ? 'This question is marked for review.' : '') +
        (ex.marked[item.id] && examHasAnswer(ex, item.id) ? ' It also has an answer.' : ''));
      $('exam-prev').disabled = ex.current <= 0;
      $('exam-next').disabled = ex.current >= ex.ids.length - 1;
      renderPalette();
      renderState();
    }

    function refresh() {
      if (!$('exam-summary').hidden) { renderSummary(); }
      renderQuestion();
    }

    function go(index) {
      state.restartArmed = false;
      if (!examGoTo(ex, index)) { return; }
      renderQuestion();
      $('exam-qtitle').focus();
      fill('exam-status', '');
    }

    /* ----- summary ----- */
    function renderSummary() {
      var s = examSummary(ex);
      fill('sum-total', String(s.total)); fill('sum-answered', String(s.answered));
      fill('sum-notanswered', String(s.notAnswered)); fill('sum-notvisited', String(s.notVisited));
      fill('sum-marked', String(s.marked)); fill('sum-both', String(s.answeredAndMarked));
      var body = $('exam-summary-rows'); body.textContent = '';
      ex.ids.forEach(function (id, idx) {
        var ps = examPaletteState(ex, idx), tr = el('tr');
        tr.appendChild(el('td', String(idx + 1)));
        tr.appendChild(el('td', ex.byId[id].type));
        tr.appendChild(el('td', ps.answered ? 'Answered' : ps.visited ? 'Not answered' : 'Not visited'));
        tr.appendChild(el('td', examResponseText(ex, id) || '\u2014'));
        tr.appendChild(el('td', ps.marked ? 'Yes' : 'No'));
        body.appendChild(tr);
      });
      renderState();
    }
    function showSummary(show) {
      $('exam-summary').hidden = !show;
      $('exam-window').hidden = show;
      state.armed = false; state.restartArmed = false;
      if (show) { renderSummary(); $('exam-summary-title').focus(); } else { renderQuestion(); $('exam-qtitle').focus(); }
    }

    /* ----- wiring ----- */
    $('exam-prev').addEventListener('click', function () { go(ex.current - 1); });
    $('exam-next').addEventListener('click', function () { go(ex.current + 1); });
    $('exam-palette').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-index]') : null;
      if (b) { go(Number(b.getAttribute('data-index'))); }
    });
    $('exam-clear').addEventListener('click', function () {
      if (!isOpen()) { refresh(); return; }
      state.restartArmed = false;
      var item = curItem(), n = ex.current + 1;
      var had = examClear(ex, item.id);
      renderQuestion();
      fill('exam-status', had ? 'Response cleared for question ' + n + '.' : 'Question ' + n + ' had no response to clear.');
      $('exam-clear').focus();
    });
    $('exam-mark').addEventListener('click', function () {
      if (!isOpen()) { refresh(); return; }
      state.restartArmed = false;
      var item = curItem(), n = ex.current + 1;
      var on = examToggleMark(ex, item.id);
      fill('exam-status', on ? 'Question ' + n + ' marked for review.' : 'Question ' + n + ' is no longer marked for review.');
      renderQuestion();
    });
    $('exam-open-summary').addEventListener('click', function () { showSummary(true); });
    $('exam-back').addEventListener('click', function () { showSummary(false); });
    $('exam-submit').addEventListener('click', function () {
      if (!isOpen()) { refresh(); return; }
      if (!state.armed) {
        state.armed = true; state.restartArmed = false; renderState();
        fill('exam-submit-status', 'Submitting locks every answer in this page only. Nothing is saved, sent or scored. Press the button again to confirm.');
        return;
      }
      state.armed = false;
      examSubmit(ex);
      fill('exam-submit-status', 'Local preview submitted in this page only. Answers are locked. Nothing was saved, sent or scored.');
      renderSummary();
    });
    $('exam-simulate-timeup').addEventListener('click', function () {
      if (!examTimeOut(ex)) { return; }
      state.armed = false;
      fill('exam-submit-status', '');
      fill('exam-status', 'Local preview: time is up. Responses are kept in this page only; nothing new is accepted.');
      refresh();
    });
    $('exam-restart').addEventListener('click', function () {
      if (!state.restartArmed) {
        state.restartArmed = true; state.armed = false;
        fill('exam-status', 'Restart warning: this clears every response, review flag and visited flag held in this page, and begins a brand-new local preview. It does not resume the current attempt, and the timer must be started again with a new deadline. Press the button again to confirm.');
        renderState();
        return;
      }
      stopTimer();
      ex = createExam(makeItems()); disarm();
      $('exam-summary').hidden = true; $('exam-window').hidden = false;
      fill('exam-submit-status', ''); fill('exam-timer-status', '');
      fill('exam-status', 'Local preview restarted as a new attempt. All previous in-memory responses were cleared. The timer is not running; press \u201cStart timed local preview\u201d to begin a new countdown.');
      renderQuestion();
    });
    $('exam-start-timer').addEventListener('click', startTimer);
    $('exam-start').addEventListener('click', function () {
      fill('exam-gate-status', state.blockers.length
        ? 'An exam attempt cannot start yet. Missing: ' + state.blockers.join(' ')
        : 'Ready.');
    });

    function showState(which) {   /* 'live' | 'empty' (no bank) | 'error' (bad or missing selection) */
      $('exam-empty').hidden = which !== 'empty'; $('exam-error').hidden = which !== 'error'; $('exam-live').hidden = which !== 'live';
      if (which === 'error') { fill('exam-error-text', loaded.message); }
    }
    function describeBank() {
      var info = selectionSummary(questions);
      fill('exam-bar-name', 'Local preview: ' + info.count + ' question' + (info.count === 1 ? '' : 's'));
      fill('exam-bar-label', loaded.label ? '(' + loaded.label + ')' : '');
      var types = Object.keys(info.breakdown).map(function (t) { return t + ': ' + info.breakdown[t].count + ' (' + info.breakdown[t].marks + ' marks)'; }).join('; ');
      fill('exam-selection-info', 'Selected: ' + info.count + ' of ' + loaded.matching + ' matching question' + (loaded.matching === 1 ? '' : 's') +
        '. Method: ' + SELECTION_METHODS[loaded.method] + (loaded.method === 'all' ? '' : '. A local-preview convenience, not an approved GATE mock-composition policy') + '. Types: ' + types + '.');
      fill('exam-total-marks', 'Total marks of the selected questions: ' + info.totalMarks + '. Calculated duration (fixed formula, selected questions only): ' + (plan.allowed ? plan.text + '. This is used only by the optional local timer below and is not an approved exam duration.' : plan.message) +
        ' The timer starts only when you press \u201cStart timed local preview\u201d. It runs in this browser, is not enforced by a server and can be altered by the user.');
      $('exam-placeholder-flag').hidden = !loaded.placeholder;
    }

    /* ----- catalogue freshness (display only; never changes questions, selection ids or the timer) ----- */
    function shortVersion(v) { return v.slice(0, 12) + '\u2026'; }
    function showFreshness(kind, headline, used, current, published) {
      var box = $('freshness'); if (!box) { return; }
      box.hidden = false;
      box.className = 'formula' + (kind === 'stale' ? ' freshness-stale' : '');
      box.setAttribute('role', kind === 'stale' ? 'alert' : 'status');
      fill('fr-headline', headline);
      fill('fr-used', used); fill('fr-current', current); fill('fr-published', published);
    }
    function checkFreshness() {
      var prov = loaded.provenance;
      if (!$('freshness') || !questions.length || !prov) { return Promise.resolve(); }
      if (prov.origin === 'local') {
        showFreshness('info', 'Local file import: catalogue freshness is not checked for files you import yourself.', 'Not applicable (local file).', 'Not checked.', 'Not applicable.');
        return Promise.resolve();
      }
      if (prov.origin === 'manifest') {
        showFreshness('ok', 'Static manifest shard verified when loaded: digest, question count, schema and public-safe fields passed. This is a local preview, not a live catalogue or online attempt.', 'Manifest release ' + prov.release + '.', 'Not applicable (static files).', 'Not supplied.');
        return Promise.resolve();
      }
      if (prov.origin !== 'published') {
        showFreshness('info', 'The source of this question bank could not be confirmed, so freshness is not checked. Return to the Practice page and load the bank again.', 'Unknown.', 'Not checked.', 'Not checked.');
        return Promise.resolve();
      }
      var used = prov.catalogue_version ? shortVersion(prov.catalogue_version) : 'Not recorded.';
      var api = root.GatePublicApi;
      if (!prov.catalogue_version) {
        showFreshness('unverified', 'Could not verify freshness: the version of this catalogue was not recorded when it was loaded.', used, 'Not checked.', 'Not checked.');
        return Promise.resolve();
      }
      if (!api || typeof api.isConfigured !== 'function' || !api.isConfigured()) {
        showFreshness('unverified', 'Could not verify freshness: no catalogue endpoint is configured on this site.', used, 'Not checked.', 'Not checked.');
        return Promise.resolve();
      }
      showFreshness('unverified', 'Checking whether this preview matches the currently published catalogue\u2026', used, 'Checking\u2026', 'Checking\u2026');
      return api.loadCatalogueMetadata().then(function (meta) {
        var at = meta.published_at ? String(meta.published_at) + ' (supplied by the site owner)' : 'Not configured by the site owner.';
        if (meta.catalogue_version === prov.catalogue_version) {
          showFreshness('ok', 'This preview matches the currently published catalogue version.', used, shortVersion(meta.catalogue_version), at);
        } else {
          showFreshness('stale', 'Stale preview: the published catalogue has changed since these questions were loaded. The questions below are unchanged. Return to the Practice page, reload the published question catalogue and open a fresh preview.',
            used, shortVersion(meta.catalogue_version), at);
        }
      }, function () {
        showFreshness('unverified', 'Could not verify freshness: the catalogue service could not be checked right now. Your current questions are unchanged and still usable.', used, 'Not retrieved.', 'Not retrieved.');
      });
    }

    showRemaining(null);
    fill('bank-note', loaded.message);
    renderGate();
    if (!questions.length) {
      showState(loaded.status === 'invalid' ? 'error' : 'empty');
    } else {
      showState('live');
      describeBank();
      renderQuestion();
    }
    renderTimerPanel();
    root.__examReady = true;
    checkFreshness().then(function () { root.__freshnessReady = true; });
    /* Display-only handle for tests. It cannot start an attempt; it only changes the countdown text. */
    root.__exam = { showRemaining: showRemaining };
  }

  if ($('exam-root')) { initExam(); }
})(typeof window !== 'undefined' ? window : globalThis);
