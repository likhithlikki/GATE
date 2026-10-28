/* GATE Prep Studio: student pages (student.js): dashboard, history, bookmarks, profile.
 * Shows ONLY data the server returns for the signed-in session (ownership is enforced server-side; no user id is sent or trusted).
 * Without a connection or a session the static, honest placeholder text stays. On a service error an unavailable message is shown:
 * never sample scores, dummy accounts or invented fields (the account has no branch or target-year field). Uses textContent only. */
(function (root) {
  'use strict';
  var doc = root.document, api = root.GateExamApi;
  if (!doc || !api) { return; }
  function $(id) { return doc.getElementById(id); }
  function el(t, x, c) { var n = doc.createElement(t); if (x !== undefined && x !== null) { n.textContent = x; } if (c) { n.className = c; } return n; }
  function clear(n) { while (n.firstChild) { n.removeChild(n.firstChild); } }
  function when(i) { if (!i) { return '\u2014'; } var d = new Date(i); return isNaN(d.getTime()) ? String(i) : d.toLocaleString(); }
  function dl(pairs) { var d = el('dl', undefined, 'feature-grid'); pairs.forEach(function (p) { var w = el('div'); w.appendChild(el('dt', p[0])); w.appendChild(el('dd', p[1])); d.appendChild(w); }); return d; }
  function holdPlaceholders(on) { Array.prototype.forEach.call(doc.querySelectorAll('[data-placeholder]'), function (n) { n.hidden = on; }); }
  function live(id, build, err) {   /* fills a live container, or an honest unavailable message */
    var box = $(id); if (!box) { return Promise.resolve(); }
    return build().then(function (node) { clear(box); box.appendChild(node); box.hidden = false; },
      function (e) { clear(box); box.appendChild(el('p', api.describe(e, err) + ' Nothing is shown in its place.', 'formula')); box.hidden = false; });
  }
  function note(t) { var n = $('acct-note'); if (n) { n.textContent = t; } }
  function modeText(a) { return a.mode === 'paper' ? 'Whole paper' : a.mode === 'practice' ? 'Filtered practice' : a.mode; }
  function statusText(a) { return a.status === 'in_progress' ? 'In progress' : a.status === 'scored' ? 'Closed, scored' : a.close_reason === 'expired' ? 'Closed (time expired)' : 'Closed (submitted)'; }
  function link(href, text) { var a = el('a', text); a.href = href; return a; }

  function attemptsTable(list, withResult, onResult) {
    var wrap = el('div', undefined, 'table-scroll'), t = el('table', undefined, 'exam-table'), h = el('tr');
    ['Started', 'Mode', 'Paper', 'Marks', 'Status', ''].forEach(function (x) { h.appendChild(el('th', x)); });
    var th = el('thead'); th.appendChild(h); t.appendChild(th);
    var tb = el('tbody');
    list.forEach(function (a) {
      var tr = el('tr'), act = el('td');
      [when(a.started_at), modeText(a), a.paper_id, String(a.total_marks), statusText(a)].forEach(function (x) { tr.appendChild(el('td', x)); });
      if (a.status === 'in_progress') { act.appendChild(link('exam.html?attempt=' + encodeURIComponent(a.attempt_id), 'Resume')); }
      else if (withResult) { var b = el('button', 'View result', 'btn btn-outline btn-sm'); b.type = 'button'; b.addEventListener('click', function () { onResult(a, b); }); act.appendChild(b); }
      else { act.appendChild(link('history.html', 'History')); }
      tr.appendChild(act); tb.appendChild(tr);
    });
    t.appendChild(tb); wrap.appendChild(t); return wrap;
  }

  function init() {
    var page = (root.location.pathname.split('/').pop() || '');
    if (!/^(dashboard|history|bookmarks|profile)\.html$/.test(page)) { return; }
    if (!api.isConfigured()) { note('The account service is not connected: no private backend address has been configured for this site. Everything below is an empty preview with no real data.'); return; }
    if (!api.isSignedIn()) { return; }
    holdPlaceholders(true); var cta = $('acct-cta'); if (cta) { cta.hidden = true; }
    note('Signed in. The sections below show only what the server holds for your account; anything it cannot supply is marked unavailable.');

    if (page === 'dashboard.html') {
      live('live-profile', function () { return api.getProfile().then(function (p) { var b = el('div'); b.appendChild(el('h2', 'Profile overview')); b.appendChild(dl([['Username', p.username], ['Full name', p.full_name], ['Member since', when(p.created_at)]])); b.appendChild(el('p', 'Branch and target exam year are not part of the account yet, so they are not shown.', 'fine')); return b; }); }, 'Loading your profile');
      var att = api.listAttempts();
      live('live-progress', function () { return att.then(function (d) { var c = d.counts, b = el('div'); b.appendChild(el('h2', 'Progress overview')); b.appendChild(dl([['Online tests started', String(c.total)], ['In progress', String(c.in_progress)], ['Closed', String(c.closed)], ['Scored', String(c.scored)]])); b.appendChild(el('p', 'Accuracy, study time and subject progress are not calculated yet.', 'fine')); return b; }); }, 'Loading your progress');
      live('live-recent', function () { return att.then(function (d) { var b = el('div'); b.appendChild(el('h2', 'Recent exam history')); if (!d.attempts.length) { b.appendChild(el('p', 'You have not started any online test.')); b.appendChild(link('practice.html#online-card', 'Go to the practice page')); } else { b.appendChild(attemptsTable(d.attempts.slice(0, 5), false)); b.appendChild(link('history.html', 'Full history')); } return b; }); }, 'Loading your history');
      live('live-bookmarks', function () { return api.listBookmarks().then(function (d) { var b = el('div'); b.appendChild(el('h2', 'Bookmarks')); b.appendChild(el('p', 'You have ' + d.count + ' bookmarked question' + (d.count === 1 ? '' : 's') + '. ')); b.appendChild(link('bookmarks.html', 'Open bookmarks')); return b; }); }, 'Loading your bookmarks');
    }

    if (page === 'history.html') {
      live('live-attempts', function () { return api.listAttempts().then(function (d) {
        var b = el('div'), out = el('div'), msg = el('p', '', 'status'); msg.setAttribute('role', 'status'); msg.setAttribute('aria-live', 'polite');
        b.appendChild(el('h2', 'Your online tests'));
        if (!d.attempts.length) { b.appendChild(el('p', 'You have not started any online test.')); return b; }
        b.appendChild(attemptsTable(d.attempts, true, function (a, btn) {
          btn.disabled = true; msg.textContent = 'Asking the server for the result\u2026';
          api.getResult(a.attempt_id).then(function (r) { if (r.available) { return r; } return api.scoreAttempt(a.attempt_id); }).then(function (r) {
            var x = r.result; msg.textContent = 'Score ' + x.total_text + ' of ' + x.max_marks + ' marks (' + x.counts.correct + ' correct, ' + x.counts.wrong + ' wrong, ' + x.counts.unanswered + ' unanswered). Verified by the server.';
          }).catch(function (e) { msg.textContent = api.describe(e, 'Getting the result'); }).then(function () { btn.disabled = false; });
        }));
        b.appendChild(msg); if (d.truncated) { b.appendChild(el('p', 'Only your most recent attempts are listed.', 'fine')); }
        if (d.unreadable) { b.appendChild(el('p', d.unreadable + ' record(s) could not be read and are not shown.', 'fine')); }
        return b; }); }, 'Loading your history');
    }

    if (page === 'bookmarks.html') {
      live('live-saved', function () { return api.listBookmarks().then(function (d) {
        var b = el('div'), msg = el('p', '', 'status'); msg.setAttribute('role', 'status'); msg.setAttribute('aria-live', 'polite');
        b.appendChild(el('h2', 'Saved questions'));
        if (!d.bookmarks.length) { b.appendChild(el('p', 'You have no bookmarks. Bookmark a question from the online exam window.')); return b; }
        d.bookmarks.forEach(function (q) {
          var card = el('div', undefined, 'form-card');
          if (q.available) { card.appendChild(el('p', q.type + ' \u00b7 ' + q.marks + ' mark(s) \u00b7 ' + [q.subject, q.topic, q.year].join(' \u00b7 '), 'fine')); card.appendChild(el('p', q.text, 'exam-qtext')); }
          else { card.appendChild(el('p', 'Question ' + q.question_id + ' is no longer available in the catalogue.')); }
          var rm = el('button', 'Remove bookmark', 'btn btn-outline btn-sm'); rm.type = 'button';
          rm.addEventListener('click', function () { rm.disabled = true; api.removeBookmark(q.question_id).then(function () { card.parentNode.removeChild(card); msg.textContent = 'Bookmark removed (confirmed by the server).'; }, function (e) { rm.disabled = false; msg.textContent = api.describe(e, 'Removing the bookmark'); }); });
          card.appendChild(rm); b.appendChild(card);
        });
        b.appendChild(msg); return b; }); }, 'Loading your bookmarks');
    }

    if (page === 'profile.html') {
      live('live-details', function () { return api.getProfile().then(function (p) { var b = el('div'); b.appendChild(el('h2', 'Account details')); b.appendChild(dl([['Username', p.username], ['Full name', p.full_name], ['Gmail address', p.email], ['Address verified', when(p.email_verified_at)], ['Member since', when(p.created_at)], ['Last login', when(p.last_login_at)]])); b.appendChild(el('p', 'Branch and target exam year are not part of the account yet, so they are not shown.', 'fine')); return b; }); }, 'Loading your account details');
    }
  }
  if (doc.readyState === 'loading') { doc.addEventListener('DOMContentLoaded', init); } else { init(); }
})(typeof window !== 'undefined' ? window : this);
