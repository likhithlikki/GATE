'use strict';
/* Focused Task 58 contract tests. No real endpoint, account, key, token or Google service is contacted. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rootDir = path.resolve(__dirname, '..');
const authSource = fs.readFileSync(path.join(rootDir, 'auth.js'), 'utf8');
const html = name => fs.readFileSync(path.join(rootDir, name), 'utf8');

function storage() {
  const map = new Map();
  return {
    getItem: k => map.has(k) ? map.get(k) : null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    has: k => map.has(k),
    raw: map
  };
}
function boot(page, initial) {
  const sessionStorage = storage();
  const localStorage = storage();
  Object.entries(initial || {}).forEach(([k, v]) => sessionStorage.setItem(k, v));
  const location = { pathname: '/gate-prep/' + page, href: '', replaced: '', replace(v) { this.replaced = v; } };
  const body = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] || null; } };
  const document = {
    readyState: 'complete', body, visibilityState: 'visible',
    getElementById() { return null; },
    createElement() { throw new Error('unexpected DOM creation in this test'); },
    addEventListener() {}
  };
  const window = { document, location, sessionStorage, localStorage, setTimeout, clearTimeout, addEventListener() {},
    crypto: { getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = i + 1; return a; } } };
  const context = vm.createContext({ window, Promise, Uint8Array, TextEncoder, Date, JSON, Object, Array, Error, RegExp, Math, isFinite, String, Number });
  vm.runInContext(authSource, context, { filename: 'auth.js' });
  return { window, location, sessionStorage, localStorage, body };
}

(async function run() {
  let passed = 0;
  function check(name, fn) { fn(); passed++; process.stdout.write('PASS ' + name + '\n'); }
  check('protected page without an endpoint redirects to login and stores only a safe in-tab return page', () => {
    const env = boot('profile.html');
    assert.strictEqual(env.location.replaced, 'login.html');
    assert.strictEqual(env.sessionStorage.getItem('gps.auth.returnTo.v1'), 'profile.html');
    assert.ok(!env.location.replaced.includes('token'));
  });
  check('return routing stores a local allowlisted filename, never a user-supplied URL', () => {
    const env = boot('profile.html');
    assert.strictEqual(env.sessionStorage.getItem('gps.auth.returnTo.v1'), 'profile.html');
    assert.match(authSource, /var SAFE_RETURN_PAGES = \{ 'dashboard\.html': 1, 'history\.html': 1, 'bookmarks\.html': 1, 'profile\.html': 1 \}/);
    assert.match(authSource, /function safeReturnTarget\(value\)/);
    assert.strictEqual(env.sessionStorage.getItem('gps.session.v1'), null);
  });
  check('malformed session values are discarded, never accepted as logged in', () => {
    const env = boot('dashboard.html', { 'gps.session.v1': '{bad-json' });
    assert.strictEqual(env.window.GateAuth.readSession(), null);
    assert.strictEqual(env.sessionStorage.getItem('gps.session.v1'), null);
    assert.strictEqual(env.location.replaced, 'login.html');
  });
  check('session clear removes both normal and remember-me tokens', () => {
    const env = boot('history.html');
    env.sessionStorage.setItem('gps.session.v1', JSON.stringify({ token: 'a'.repeat(32) + '.' + 'b'.repeat(64) }));
    env.localStorage.setItem('gps.session.v1', JSON.stringify({ token: 'c'.repeat(32) + '.' + 'd'.repeat(64) }));
    env.window.GateAuth.clearSession();
    assert.strictEqual(env.sessionStorage.getItem('gps.session.v1'), null);
    assert.strictEqual(env.localStorage.getItem('gps.session.v1'), null);
  });
  check('unconfigured requests fail without calling fetch or exposing values in a URL', async () => {
    const env = boot('login.html');
    let sent = false;
    env.window.fetch = () => { sent = true; return Promise.resolve({ text: () => Promise.resolve('{}') }); };
    await assert.rejects(env.window.GateAuth.call('auth_status', { email: 'private@example.com' }), e => e && e.kind === 'not_configured');
    assert.strictEqual(sent, false);
    assert.strictEqual(env.location.href, '');
  });
  check('protected account pages use fail-closed state and auth gate markup', () => {
    for (const page of ['dashboard.html', 'history.html', 'bookmarks.html', 'profile.html']) {
      const source = html(page);
      assert.match(source, /data-auth-protected="true" data-auth-state="checking"/);
      assert.match(source, /id="auth-gate-screen"/);
      assert.match(source, /src="auth\.js"/);
    }
    const css = html('style.css');
    assert.match(css, /body\[data-auth-protected="true"\]:not\(\[data-auth-state="ready"\]\) main \{ display: none; \}/);
  });
  check('login, register and reset keep auth calls in the POST body adapter', () => {
    assert.match(authSource, /method: 'POST'/);
    assert.match(authSource, /credentials: 'omit'/);
    assert.match(authSource, /referrerPolicy: 'no-referrer'/);
    assert.match(authSource, /function refreshSession\(\)/);
    assert.match(authSource, /session_get/);
    assert.match(authSource, /function logout\(\)/);
    assert.doesNotMatch(authSource, /location\.(?:href|replace)\s*\([^)]*(?:sessionToken|password|otp|emailProof|resetProof)/i);
  });
  process.stdout.write(`\n${passed}/7 Task 58 auth lifecycle checks passed.\n`);
})().catch(e => { console.error(e); process.exitCode = 1; });
