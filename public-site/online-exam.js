/* GATE Prep Studio: authenticated ONLINE examination UI (online-exam.js)
 *
 * Two controllers, chosen by which elements the page has:
 *   practice.html (#online-card)  load papers from the private catalogue, choose paper/mode/filters, start an attempt.
 *   exam.html     (#online-exam)  open an attempt (?attempt=<id>), answer, save, resume, submit, fetch the result.
 *
 * It is separate from the local preview in app.js (different elements, different timer, no shared state). It uses only GateExamApi.
 *
 * What this page does NOT decide: which questions are in a test, their marks, the marking profile, the duration, the deadline, whether a late
 * answer is valid, or the score. The browser sends the paper, mode and filters; the server answers with the pinned test. Locally chosen question
 * ids are never sent as a test definition. Question text is shown with textContent only.
 *
 * Saving: a choice is held locally as "not saved" until the server confirms it (save_answers). The page never says "saved" before then. The save
 * request carries the sequence number the page last saw; a server conflict resynchronises from the server. A replayed save is harmless.
 * Timer: remaining time comes from the server (remaining_ms, refreshed on every server reply) and is counted down on a monotonic clock. At zero
 * the page asks the server what happened; the server closes the attempt and the page then goes read-only.
 * Nothing here is written to browser storage. Nothing here is logged.
 */
(function (root) {
  'use strict';
  var doc = root.document;
  if (!doc) { return; }
  var api = root.GateExamApi;
  function $(id) { return doc.getElementById(id); }
  function fill(id, text) { var n = $(id); if (n) { n.textContent = text; } }
  function show(id, on) { var n = $(id); if (n) { n.hidden = !on; } }
  function el(tag, text, cls) { var n = doc.createElement(tag); if (text !== undefined && text !== null) { n.textContent = text; } if (cls) { n.className = cls; } return n; }
  function clear(n) { while (n && n.firstChild) { n.removeChild(n.firstChild); } }
  function fmtClock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (x < 10 ? '0' : '') + x;
  }
  function fmtDuration(sec) { var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return h + ' h ' + m + ' min ' + s + ' s (' + sec + ' seconds)'; }
  function fmtTime(iso) { var d = new Date(iso); return isNaN(d.getTime()) ? String(iso) : d.toLocaleString(); }
  var ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

  function connectionNote() {
    if (!api) { return 'The online examination code did not load.'; }
    if (!api.isConfigured()) { return 'The online examination service is not connected: no private backend address has been configured for this site. Nothing can be started or saved online.'; }
    if (!api.isSignedIn()) { return 'You are not signed in. Log in to use online examinations.'; }
    return '';
  }

  /* =============================================================================================================
   * Practice page: load papers, choose, start
   * =========================================================================================================== */
  function initPractice() {
    if (!$('online-card')) { return; }
    var papers = [], busy = false, pending = null;   /* pending: {sig, key}: the request key for one set of parameters, reused on retry */
    var note = connectionNote();
    fill('ox-status', note || 'Connected and signed in. Press the button to load the papers available to you. Nothing starts until you choose to start.');
    if (note) { return; }
    $('ox-load').disabled = false;

    function cur() { return papers[parseInt($('ox-paper').value, 10)] || null; }
    function mode() { return $('ox-mode-practice').checked ? 'practice' : 'paper'; }
    function selVal(id) { var v = $(id).value; return v === '' ? '' : v; }

    function fillSelect(id, entries, keep) {
      var s = $(id), old = keep ? s.value : ''; clear(s);
      var any = el('option', 'Any', ''); any.value = ''; s.appendChild(any);
      entries.forEach(function (e) { var o = el('option', e.label); o.value = e.value; s.appendChild(o); });
      s.value = entries.some(function (e) { return e.value === old; }) ? old : '';
    }
    function matching(p, f) {
      var n = 0, m = 0;
      p.facets.forEach(function (x) { if ((!f.subject || x.subject === f.subject) && (!f.topic || x.topic === f.topic) && (!f.type || x.type === f.type)) { n += x.count; m += x.marks; } });
      return { count: n, marks: m };
    }
    function distinct(p, key, f) {
      var out = {}, order = [];
      p.facets.forEach(function (x) {
        if ((f.subject && key !== 'subject' && x.subject !== f.subject) || (f.topic && key === 'type' && x.topic !== f.topic)) { return; }
        if (!(x[key] in out)) { out[x[key]] = 0; order.push(x[key]); }
        out[x[key]] += x.count;
      });
      return order.sort().map(function (v) { return { value: v, label: v + ' (' + out[v] + ')' }; });
    }
    function refresh() {
      var p = cur(), m = mode();
      show('ox-filters', m === 'practice');
      $('ox-start').disabled = true; show('ox-block', false);
      if (!p) { fill('ox-avail', ''); return; }
      var f = { subject: '', topic: '', type: '' };
      if (m === 'practice') {
        f.subject = selVal('ox-subject');
        fillSelect('ox-subject', distinct(p, 'subject', {}), true); f.subject = selVal('ox-subject');
        fillSelect('ox-topic', distinct(p, 'topic', { subject: f.subject }), true); f.topic = selVal('ox-topic');
        fillSelect('ox-type', distinct(p, 'type', { subject: f.subject, topic: f.topic }), true); f.type = selVal('ox-type');
      }
      var mm = matching(p, f), modeInfo = m === 'paper' ? p.paper_mode : p.practice_mode;
      fill('ox-avail', 'According to the private catalogue: ' + mm.count + ' question' + (mm.count === 1 ? '' : 's') + ' (' + mm.marks + ' marks) match' + (mm.count === 1 ? 'es' : '') +
        '. The paper has ' + p.question_count + ' questions and ' + p.total_marks + ' marks. This is a count, not the test: the server makes the final selection and fixes marks, profile and duration when you start.' +
        (m === 'paper' && p.duration_seconds ? ' Duration for the whole paper, calculated by the server: ' + fmtDuration(p.duration_seconds) + '.' : ''));
      var gates = root.GatePrep && root.GatePrep.marking && typeof root.GatePrep.marking.policyStatus === 'function'
        ? root.GatePrep.marking.policyStatus(parseInt(p.year, 10)) : null;
      if (!gates || !gates.canStartOnlineExam) {
        fill('ox-block', 'Online attempts are blocked by the owner-controlled policy gates. The scoring specification is not approved, marking confirmation and secure server scoring are not ready, and attempt enforcement is not enabled. No start request was sent. Use local practice/preview instead.');
        show('ox-block', true); return;
      }
      if (!modeInfo.available) {
        fill('ox-block', api.describe({ kind: 'server', code: 'feature_disabled', reason: modeInfo.reason }, 'Starting')); show('ox-block', true); return;
      }
      if (!mm.count) { fill('ox-block', 'No question matches these filters. Set a filter back to \u201cAny\u201d.'); show('ox-block', true); return; }
      $('ox-start').disabled = false;
    }

    function load() {
      if (busy) { return; } busy = true; $('ox-load').disabled = true;
      fill('ox-status', 'Loading papers\u2026');
      api.listPapers().then(function (d) {
        papers = Array.isArray(d.papers) ? d.papers : [];
        show('ox-setup', papers.length > 0);
        if (!papers.length) { fill('ox-status', 'The private catalogue has no registered papers yet, so there is nothing to start. Nothing was invented in its place.'); return; }
        var sel = $('ox-paper'); clear(sel);
        papers.forEach(function (p, i) {
          var o = el('option', p.paper_code + ' \u2014 ' + p.year + ', session ' + p.session + (p.title ? ' (' + p.title + ')' : '') + ' \u2014 ' + p.question_count + ' questions, ' + p.total_marks + ' marks' + (p.available ? '' : ' \u2014 not available'));
          o.value = String(i); sel.appendChild(o);
        });
        fill('ox-status', papers.length + ' paper' + (papers.length === 1 ? '' : 's') + ' loaded. No test has been started.');
        refresh();
      }).catch(function (e) { show('ox-setup', false); fill('ox-status', api.describe(e, 'Loading the papers')); })
        .then(function () { busy = false; $('ox-load').disabled = false; });
    }

    function start() {
      var p = cur(); if (!p || busy) { return; }
      var m = mode(), req = { mode: m, paper_id: p.paper_id }, f = {};
      if (m === 'practice') {
        ['subject', 'topic', 'type'].forEach(function (k) { var v = selVal('ox-' + k); if (v) { f[k] = v; } });
        if (Object.keys(f).length) { req.filters = f; }
      }
      var sig = JSON.stringify(req);
      if (!pending || pending.sig !== sig) { try { pending = { sig: sig, key: api.requestKey() }; } catch (e) { fill('ox-start-status', api.describe(e, 'Starting')); return; } }
      req.request_key = pending.key;
      busy = true; $('ox-start').disabled = true; fill('ox-start-status', 'Asking the server to start the test\u2026');
      api.startAttempt(req).then(function (d) {
        if (d.started === false && d.active_attempt_id && !d.view) {
          fill('ox-start-status', 'You already have an active online attempt in this mode. Finish or resume it before starting another.');
          show('ox-started', true); var a0 = $('ox-r-open'); a0.href = 'exam.html?attempt=' + encodeURIComponent(d.active_attempt_id); a0.textContent = 'Resume your active attempt';
          fill('ox-started-title', 'An attempt is already active');
          ['ox-r-count', 'ox-r-marks', 'ox-r-profile', 'ox-r-duration', 'ox-r-deadline'].forEach(function (id) { fill(id, '\u2014'); });
          return;
        }
        var v = d.view && d.view.attempt;
        if (!v || !ID_RE.test(v.attempt_id)) { throw Object.assign(new Error('bad_response'), { kind: 'bad_response' }); }
        pending = null;
        fill('ox-started-title', d.started ? 'Online attempt created' : 'Earlier start request found: attempt resumed');
        fill('ox-r-count', String(v.question_count)); fill('ox-r-marks', String(v.total_marks)); fill('ox-r-profile', v.profile && v.profile.length ? v.profile.join(', ') : '\u2014');
        fill('ox-r-duration', fmtDuration(v.duration_seconds)); fill('ox-r-deadline', fmtTime(v.deadline_at));
        var a = $('ox-r-open'); a.href = 'exam.html?attempt=' + encodeURIComponent(v.attempt_id); a.textContent = 'Open the exam window';
        show('ox-started', true); fill('ox-start-status', 'The server created the attempt.');
        var t = $('ox-started-title'); if (t && t.focus) { t.focus(); }
      }).catch(function (e) {
        if (!api.isRetryable(e) && !(e && e.code === 'busy')) { pending = null; }
        fill('ox-start-status', api.describe(e, 'Starting the test') + (api.isRetryable(e) ? ' Pressing Start again repeats the same request safely: it cannot create a second attempt.' : ''));
      }).then(function () { busy = false; refresh(); });
    }

    $('ox-load').addEventListener('click', load);
    $('ox-start').addEventListener('click', start);
    ['ox-paper', 'ox-subject', 'ox-topic', 'ox-type'].forEach(function (id) { $(id).addEventListener('change', refresh); });
    ['ox-mode-paper', 'ox-mode-practice'].forEach(function (id) { $(id).addEventListener('change', refresh); });
  }

  /* =============================================================================================================
   * Exam page: the online attempt
   * =========================================================================================================== */
  function initExam() {
    if (!$('online-exam')) { return; }
    var note = connectionNote();
    var q = /^\?attempt=([A-Za-z0-9._-]{1,64})$/.exec(root.location.search || '');
    if (note) { fill('ox-state', note); return; }

    if (!q) {
      fill('ox-state', 'Signed in. No online attempt is open on this page.'); show('ox-idle', true);
      $('ox-find').addEventListener('click', function () {
        var list = $('ox-find-list'); clear(list); fill('ox-state', 'Looking for your attempts\u2026');
        api.listAttempts().then(function (d) {
          var open = (d.attempts || []).filter(function (a) { return a.status === 'in_progress'; });
          fill('ox-state', open.length ? 'Attempts of yours that are still in progress:' : 'You have no online attempt in progress.');
          open.forEach(function (a) {
            var li = el('li'), link = el('a', a.paper_id + ' (' + a.mode + '), started ' + fmtTime(a.started_at));
            link.href = 'exam.html?attempt=' + encodeURIComponent(a.attempt_id); li.appendChild(link); list.appendChild(li);
          });
        }).catch(function (e) { fill('ox-state', api.describe(e, 'The lookup')); });
      });
      return;
    }

    var S = { id: q[1], attempt: null, qs: [], local: {}, conf: {}, seq: 0, idx: 0, visited: {}, dirty: {}, saving: false, saveTimer: null, retryTimer: null, retryN: 0, resyncN: 0,
      closed: false, deadlineAt: 0, tick: null, bookmarks: null, saveNote: '', failed: false, submitting: false, expiredAsked: false };

    function now() { return root.performance && root.performance.now ? root.performance.now() : Date.now(); }
    function qid() { return S.qs[S.idx].question_id; }
    function emptyFor(type) { return type === 'MSQ' ? [] : ''; }
    function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
    function localOf(id, type) { return S.local[id] || { response: emptyFor(type), review: false }; }
    function isAnswered(v) { return Array.isArray(v) ? v.length > 0 : (typeof v === 'string' && v.trim() !== ''); }
    function unsavedCount() { return Object.keys(S.dirty).length; }

    /* ----- server state ----- */
    function adopt(d, keepDirty) {
      S.attempt = d.attempt; S.qs = d.questions; S.seq = d.attempt.last_seq;
      var dirty = keepDirty ? S.dirty : {}, localOld = S.local;
      S.local = {}; S.conf = {}; S.dirty = {};
      S.qs.forEach(function (x) {
        var r = d.responses[x.question_id];
        var c = r ? { response: r.response, review: r.review_flag === true } : { response: emptyFor(x.type), review: false };
        S.conf[x.question_id] = c; S.local[x.question_id] = { response: c.response, review: c.review };
        if (dirty[x.question_id] && localOld[x.question_id]) { S.local[x.question_id] = localOld[x.question_id]; S.dirty[x.question_id] = true; }
      });
      S.deadlineAt = now() + (d.attempt.remaining_ms || 0);
      S.closed = d.attempt.status !== 'in_progress';
    }
    function syncClock(remainingMs) { if (typeof remainingMs === 'number' && isFinite(remainingMs)) { S.deadlineAt = now() + remainingMs; } }

    function load(keepDirty) {
      fill('ox-state', 'Loading your attempt from the server\u2026');
      return api.getAttempt(S.id).then(function (d) {
        adopt(d, keepDirty); render(); return true;
      }, function (e) {
        fill('ox-state', api.describe(e, 'Loading the attempt') + (e && e.code === 'not_found' ? '' : ' Nothing is shown from memory.'));
        show('ox-live', false); return false;
      });
    }

    /* ----- saving ----- */
    function setSaveNote() {
      var n = unsavedCount(), t;
      if (S.closed) { t = 'This attempt is closed. No further changes are accepted.'; }
      else if (S.saving) { t = 'Saving to the server\u2026 ' + n + ' change' + (n === 1 ? '' : 's') + ' not yet confirmed.'; }
      else if (S.failed) { t = 'NOT SAVED: ' + S.saveNote + ' ' + n + ' change' + (n === 1 ? ' is' : 's are') + ' held on this page only and are not confirmed by the server.'; }
      else if (n) { t = n + ' change' + (n === 1 ? '' : 's') + ' not yet saved. Saving shortly\u2026'; }
      else { t = 'All your choices are saved (confirmed by the server).'; }
      fill('ox-save-state', t);
      show('ox-retry', S.failed && !S.closed && n > 0);
      show('ox-reload', !S.closed && (S.failed || S.resyncN > 2));
    }
    function scheduleSave(delay) { if (S.closed) { return; } if (S.saveTimer) { root.clearTimeout(S.saveTimer); } S.saveTimer = root.setTimeout(doSave, delay === undefined ? 700 : delay); }

    function doSave() {
      S.saveTimer = null;
      if (S.closed || S.saving) { return; }
      var ids = Object.keys(S.dirty).slice(0, 20);
      if (!ids.length) { setSaveNote(); return; }
      var byId = {}; S.qs.forEach(function (x) { byId[x.question_id] = x; });
      var sent = {}, updates = ids.map(function (id) {
        var l = S.local[id]; sent[id] = { response: l.response, review: l.review };
        return { question_id: id, response: l.response, review_flag: l.review };
      });
      S.saving = true; S.failed = false; setSaveNote();
      api.saveAnswers(S.id, S.seq, updates).then(function (d) {
        S.saving = false; S.retryN = 0; S.resyncN = 0; S.failed = false;
        if (typeof d.seq === 'number') { S.seq = d.seq; }
        syncClock(d.remaining_ms);
        ids.forEach(function (id) {   /* confirmed only if the user has not changed it again meanwhile */
          if (same(S.local[id], sent[id])) { S.conf[id] = { response: sent[id].response, review: sent[id].review }; delete S.dirty[id]; }
        });
        renderAll(); if (unsavedCount()) { scheduleSave(150); }
      }).catch(function (e) {
        S.saving = false;
        if (e && e.kind === 'server' && (e.code === 'attempt_expired' || e.code === 'attempt_closed')) { var lost = unsavedCount(); S.dirty = {}; return load(false).then(function () { fill('ox-save-state', (lost ? lost + ' change' + (lost === 1 ? ' was' : 's were') + ' not saved before the attempt closed. ' : '') + api.describe(e, 'Saving')); }); }
        if (e && e.kind === 'server' && e.code === 'conflict') {
          S.resyncN++;
          if (S.resyncN <= 2) {   /* your latest choices win: resynchronise the sequence number, keep what you changed, save again */
            return api.getAttempt(S.id).then(function (d) {
              var keep = S.dirty; S.dirty = {};
              S.seq = d.attempt.last_seq; syncClock(d.attempt.remaining_ms);
              if (d.attempt.status !== 'in_progress') { adopt(d, false); render(); return; }
              S.qs.forEach(function (x) { var r = d.responses[x.question_id]; S.conf[x.question_id] = r ? { response: r.response, review: r.review_flag === true } : { response: emptyFor(x.type), review: false }; if (!keep[x.question_id]) { S.local[x.question_id] = { response: S.conf[x.question_id].response, review: S.conf[x.question_id].review }; } });
              S.dirty = keep; fill('ox-save-state', 'Your answers were changed elsewhere (another tab?). This page re-synchronised and is saving your latest choices.'); renderAll(); scheduleSave(100);
            }, function (e2) { S.failed = true; S.saveNote = api.describe(e2, 'Re-synchronising'); setSaveNote(); });
          }
          S.failed = true; S.saveNote = api.describe(e, 'Saving'); setSaveNote(); return;
        }
        S.failed = true; S.saveNote = api.describe(e, 'Saving');
        setSaveNote();
        if (api.isRetryable(e) && S.retryN < 6) { S.retryN++; S.retryTimer = root.setTimeout(function () { S.retryTimer = null; doSave(); }, Math.min(15000, 2000 * S.retryN)); }
      });
    }

    function change(id, resp, review) {
      if (S.closed || S.expiredAsked) { return; }
      var x = S.qs.filter(function (z) { return z.question_id === id; })[0], cur = localOf(id, x.type);
      S.local[id] = { response: resp === undefined ? cur.response : resp, review: review === undefined ? cur.review : review };
      var c = S.conf[id] || { response: emptyFor(x.type), review: false };
      if (same(S.local[id], c)) { delete S.dirty[id]; } else { S.dirty[id] = true; }
      S.failed = false; S.retryN = 0;
      renderAll(); scheduleSave(x.type === 'NAT' ? 900 : 350);
    }

    /* ----- rendering ----- */
    function statusOf(i) {
      var x = S.qs[i], l = localOf(x.question_id, x.type), ans = isAnswered(l.response);
      if (!S.visited[i] && !ans && !l.review) { return 'none'; }
      if (l.review) { return 'review'; }
      return ans ? 'answered' : 'unanswered';
    }
    function renderPalette() {
      var g = $('ox-palette'); clear(g);
      var cnt = { answered: 0, unanswered: 0, review: 0, none: 0 };
      S.qs.forEach(function (x, i) {
        var st = statusOf(i), l = localOf(x.question_id, x.type), ans = isAnswered(l.response);
        cnt[st]++;
        var b = el('button', String(i + 1), 'pq ' + { answered: 'a', unanswered: 'u', review: 'r', none: 'n' }[st] + (l.review && ans ? ' am' : ''));
        b.type = 'button'; b.setAttribute('data-index', String(i));
        b.setAttribute('aria-label', 'Question ' + (i + 1) + ': ' + { answered: 'answered', unanswered: 'not answered', review: 'marked for review', none: 'not visited' }[st] + (S.dirty[x.question_id] ? ', not yet saved' : ''));
        if (i === S.idx) { b.setAttribute('aria-current', 'true'); }
        g.appendChild(b);
      });
      fill('ox-cnt-answered', String(cnt.answered)); fill('ox-cnt-notanswered', String(cnt.unanswered)); fill('ox-cnt-marked', String(cnt.review)); fill('ox-cnt-notvisited', String(cnt.none));
    }

    function renderQuestion() {
      var x = S.qs[S.idx], l = localOf(x.question_id, x.type), ro = S.closed || S.expiredAsked;
      S.visited[S.idx] = true;
      fill('ox-qtitle', 'Question ' + (S.idx + 1) + ' of ' + S.qs.length);
      fill('ox-qtype', { MCQ: 'Multiple choice (one correct option)', MSQ: 'Multiple select (one or more options)', NAT: 'Numerical answer (type a number)' }[x.type] || x.type);
      fill('ox-qmarks', 'Marks: ' + x.marks);
      fill('ox-qmeta', [x.subject, x.topic, x.year].filter(Boolean).join(' \u00b7 '));
      fill('ox-qtext', x.text);
      var box = $('ox-answer'); clear(box);
      if (x.type === 'NAT') {
        var p = el('p', undefined, 'field'), lab = el('label', 'Your answer'), inp = doc.createElement('input');
        lab.setAttribute('for', 'ox-nat'); inp.type = 'text'; inp.id = 'ox-nat'; inp.maxLength = 64; inp.setAttribute('inputmode', 'decimal'); inp.autocomplete = 'off'; inp.value = l.response; inp.disabled = ro;
        inp.addEventListener('input', function () { change(x.question_id, inp.value, undefined); });
        p.appendChild(lab); p.appendChild(inp); box.appendChild(p);
      } else {
        var fs = el('fieldset', undefined, 'exam-options'), lg = el('legend', x.type === 'MSQ' ? 'Select all that apply' : 'Select one option'); fs.appendChild(lg);
        x.options.forEach(function (o, k) {
          var row = el('p', undefined, 'exam-opt'), inp = doc.createElement('input'), lab = el('label', o.id + '. ' + o.text);
          inp.type = x.type === 'MSQ' ? 'checkbox' : 'radio'; inp.name = 'ox-answer'; inp.value = o.id; inp.id = 'ox-opt-' + k; inp.disabled = ro;
          inp.checked = x.type === 'MSQ' ? l.response.indexOf(o.id) >= 0 : l.response === o.id;
          lab.setAttribute('for', inp.id);
          inp.addEventListener('change', function () {
            if (x.type === 'MSQ') {
              var cur = localOf(x.question_id, 'MSQ').response.slice(), at = cur.indexOf(o.id);
              if (inp.checked && at < 0) { cur.push(o.id); } else if (!inp.checked && at >= 0) { cur.splice(at, 1); }
              change(x.question_id, cur.sort(), undefined);
            } else { change(x.question_id, o.id, undefined); }
          });
          row.appendChild(inp); row.appendChild(lab); fs.appendChild(row);
        });
        box.appendChild(fs);
      }
      var m = $('ox-mark'); m.setAttribute('aria-pressed', l.review ? 'true' : 'false'); m.textContent = l.review ? 'Unmark review' : 'Mark for review'; m.disabled = ro;
      $('ox-clear').disabled = ro || !isAnswered(l.response);
      $('ox-prev').disabled = S.idx === 0; $('ox-next').disabled = S.idx === S.qs.length - 1;
      var st = S.dirty[x.question_id] ? 'Your choice for this question is NOT saved yet.' : (S.conf[x.question_id] && (isAnswered(S.conf[x.question_id].response) || S.conf[x.question_id].review) ? 'Saved (confirmed by the server).' : '');
      fill('ox-q-state', st);
      renderBookmark();
    }

    function renderBookmark() {
      var b = $('ox-bookmark'); if (!b) { return; }
      if (S.bookmarks === null) { b.hidden = true; return; }
      var on = !!S.bookmarks[qid()]; b.hidden = false; b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.textContent = on ? 'Remove bookmark' : 'Bookmark question';
    }

    function renderSummary() {
      var rows = $('ox-summary-rows'); clear(rows);
      var a = 0, m = 0;
      S.qs.forEach(function (x, i) {
        var l = localOf(x.question_id, x.type), ans = isAnswered(l.response), st = statusOf(i);
        if (ans) { a++; } if (l.review) { m++; }
        var tr = el('tr');
        tr.appendChild(el('td', String(i + 1))); tr.appendChild(el('td', x.type));
        tr.appendChild(el('td', { answered: 'Answered', unanswered: 'Not answered', review: ans ? 'Answered, marked for review' : 'Marked for review', none: 'Not visited' }[st]));
        tr.appendChild(el('td', S.dirty[x.question_id] ? 'Not saved yet' : 'Saved'));
        tr.appendChild(el('td', l.review ? 'Yes' : 'No'));
        rows.appendChild(tr);
      });
      fill('ox-sum-total', String(S.qs.length)); fill('ox-sum-answered', String(a)); fill('ox-sum-notanswered', String(S.qs.length - a)); fill('ox-sum-marked', String(m)); fill('ox-sum-unsaved', String(unsavedCount()));
    }

    function renderTimer() {
      if (S.closed) { fill('ox-timer-state', 'Attempt closed'); fill('ox-timer', '--:--:--'); return; }
      var rem = S.deadlineAt - now();
      fill('ox-timer', fmtClock(rem));
      fill('ox-timer-state', rem > 0 ? 'Server deadline in' : 'Deadline reached: asking the server');
      if (rem <= 0 && !S.expiredAsked) {   /* the server, not this page, decides what happens at the deadline */
        S.expiredAsked = true; if (S.saveTimer) { root.clearTimeout(S.saveTimer); }
        renderAll();
        var lost = unsavedCount();
        api.getAttempt(S.id).then(function (d) { S.dirty = {}; adopt(d, false); S.expiredAsked = false; render(); if (lost) { fill('ox-save-state', lost + ' change' + (lost === 1 ? ' was' : 's were') + ' not saved before the deadline and cannot be accepted now.'); } },
          function (e) { S.expiredAsked = false; S.deadlineAt = now() + 5000; fill('ox-save-state', api.describe(e, 'Checking the deadline') + ' Trying again in a few seconds.'); });
      }
    }

    function renderTerminal() {
      show('ox-summary', false); show('ox-window', true); show('ox-result', true);
      var a = S.attempt, why = a.close_reason === 'expired' ? 'The deadline passed and the server closed the attempt with the answers already saved.' : 'You submitted this attempt.';
      fill('ox-closed-text', why + (a.closed_at ? ' Closed at ' + fmtTime(a.closed_at) + '.' : '') + ' Your answers can no longer be changed.');
      $('ox-score').textContent = a.status === 'scored' ? 'Show my result' : 'Get my result';
    }

    function renderAll() { renderPalette(); renderQuestion(); renderSummary(); setSaveNote(); renderTimer(); }
    function render() {
      var a = S.attempt;
      show('ox-live', true); show('ox-idle', false);
      fill('ox-state', 'Online attempt loaded from the server (' + (S.closed ? 'closed' : 'in progress') + ').');
      fill('ox-bar-name', a.paper_id); fill('ox-bar-label', '(' + a.mode + ')');
      fill('ox-info', a.question_count + ' questions \u00b7 ' + a.total_marks + ' marks \u00b7 profile ' + (a.profile.join(', ') || '\u2014') + ' \u00b7 duration ' + fmtDuration(a.duration_seconds) + ' \u00b7 started ' + fmtTime(a.started_at) + ' \u00b7 deadline ' + fmtTime(a.deadline_at));
      if (S.idx >= S.qs.length) { S.idx = 0; }
      renderAll();
      if (S.closed) { renderTerminal(); } else { show('ox-result', false); }
      ['ox-submit'].forEach(function (id) { $(id).disabled = S.closed; });
      if (!S.tick) { S.tick = root.setInterval(renderTimer, 1000); }
    }

    /* ----- navigation and actions ----- */
    function go(i) { if (i < 0 || i >= S.qs.length) { return; } S.idx = i; show('ox-summary', false); show('ox-window', true); renderAll(); var t = $('ox-qtitle'); if (t && t.focus) { t.focus(); } }
    $('ox-prev').addEventListener('click', function () { go(S.idx - 1); });
    $('ox-next').addEventListener('click', function () { go(S.idx + 1); });
    $('ox-palette').addEventListener('click', function (e) { var b = e.target && e.target.closest ? e.target.closest('button[data-index]') : null; if (b) { go(parseInt(b.getAttribute('data-index'), 10)); } });
    $('ox-clear').addEventListener('click', function () { var x = S.qs[S.idx]; change(x.question_id, emptyFor(x.type), undefined); });
    $('ox-mark').addEventListener('click', function () { var x = S.qs[S.idx]; change(x.question_id, undefined, !localOf(x.question_id, x.type).review); });
    $('ox-open-summary').addEventListener('click', function () { show('ox-window', false); show('ox-summary', true); renderSummary(); var t = $('ox-summary-title'); if (t && t.focus) { t.focus(); } });
    $('ox-back').addEventListener('click', function () { show('ox-summary', false); show('ox-window', true); });
    $('ox-retry').addEventListener('click', function () { S.retryN = 0; S.failed = false; doSave(); });
    $('ox-reload').addEventListener('click', function () { S.dirty = {}; S.resyncN = 0; S.failed = false; load(false); });

    $('ox-bookmark').addEventListener('click', function () {
      var id = qid(), on = !!S.bookmarks[id], b = $('ox-bookmark'); b.disabled = true;
      (on ? api.removeBookmark(id) : api.addBookmark(id)).then(function (d) { S.bookmarks[id] = d.bookmarked === true; fill('ox-q-state', d.bookmarked ? 'Bookmark saved (confirmed by the server).' : 'Bookmark removed (confirmed by the server).'); },
        function (e) { fill('ox-q-state', api.describe(e, 'The bookmark change')); }).then(function () { b.disabled = false; renderBookmark(); });
    });

    $('ox-submit').addEventListener('click', function () {
      if (S.closed || S.submitting) { return; }
      S.submitting = true; $('ox-submit').disabled = true;
      var st = $('ox-submit-status');
      function finish() {
        st.textContent = 'Submitting to the server\u2026';
        api.submitAttempt(S.id).then(function () { return load(false); }).then(function () { st.textContent = 'Submitted. The server closed the attempt.'; },
          function (e) { st.textContent = api.describe(e, 'Submitting') + ' The attempt was not confirmed closed; press Submit again to repeat the same request safely.'; })
          .then(function () { S.submitting = false; $('ox-submit').disabled = S.closed; });
      }
      if (!unsavedCount()) { finish(); return; }
      st.textContent = 'Saving your last changes first\u2026';
      (function waitSaved(tries) {   /* submit only after the server confirmed every choice */
        if (S.closed) { S.submitting = false; return; }
        if (!unsavedCount()) { finish(); return; }
        if (tries > 20 || S.failed) { st.textContent = 'Not submitted: ' + unsavedCount() + ' change(s) are not saved on the server yet. ' + (S.saveNote || '') + ' Fix the connection and try again.'; S.submitting = false; $('ox-submit').disabled = false; return; }
        if (!S.saving && !S.saveTimer) { doSave(); }
        root.setTimeout(function () { waitSaved(tries + 1); }, 700);
      })(0);
    });

    $('ox-score').addEventListener('click', function () {
      var b = $('ox-score'); b.disabled = true; fill('ox-result-status', 'Asking the server for your result\u2026');
      function showResult(r, extra) {
        fill('ox-res-score', r.total_text + ' (' + (r.total.num / r.total.den).toFixed(4).replace(/\.?0+$/, '') + ' approx.)'); fill('ox-res-max', String(r.max_marks));
        fill('ox-res-cw', r.counts.correct + ' / ' + r.counts.wrong); fill('ox-res-un', String(r.counts.unanswered)); fill('ox-res-mta', String(r.counts.marks_to_all)); fill('ox-res-profile', (r.profile || []).join(', ') || '\u2014');
        show('ox-result-dl', true); fill('ox-result-status', extra);
      }
      api.getResult(S.id).then(function (d) {
        if (d.available) { showResult(d.result, 'Result committed and verified by the server.'); return; }
        fill('ox-result-status', 'No result has been committed yet. Asking the server to score the attempt\u2026');
        return api.scoreAttempt(S.id).then(function (s) {
          showResult(s.result, 'Scored by the server (' + s.commit_status.replace(/_/g, ' ') + (s.audit && s.audit !== 'written' && s.audit !== 'already_present' ? '; the audit record reported: ' + s.audit.replace(/_/g, ' ') : '') + ').');
        });
      }).catch(function (e) { show('ox-result-dl', false); fill('ox-result-status', api.describe(e, 'Getting the result')); }).then(function () { b.disabled = false; });
    });
    $('ox-review').addEventListener('click', function () {
      fill('ox-result-status', 'Asking the server for the answer review\u2026');
      api.getResultReview(S.id).then(function () { fill('ox-result-status', 'The server released a review of your own responses and outcomes. Answer keys and explanations are not part of it.'); },
        function (e) { fill('ox-result-status', api.describe(e, 'The answer review')); });
    });

    root.addEventListener('pagehide', function () { if (S.tick) { root.clearInterval(S.tick); } });
    load(false).then(function (ok) {
      if (!ok) { return; }
      api.listBookmarks().then(function (d) { S.bookmarks = {}; (d.bookmarks || []).forEach(function (b) { S.bookmarks[b.question_id] = true; }); renderBookmark(); }, function () { S.bookmarks = null; renderBookmark(); });
    });
  }

  function init() { initPractice(); initExam(); }
  if (doc.readyState === 'loading') { doc.addEventListener('DOMContentLoaded', init); } else { init(); }
})(typeof window !== 'undefined' ? window : this);
