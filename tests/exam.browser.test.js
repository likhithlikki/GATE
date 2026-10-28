// Real-browser tests (Playwright + Chromium) for exam.html. Run: node exam.browser.test.js
// Needs Playwright; set PLAYWRIGHT_PATH to its folder if it is installed globally. Serves the site folder locally.
const http = require('http'); const fs = require('fs'); const path = require('path'); const assert = require('assert');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const SITE = path.join(__dirname, '..'); const FX = path.join(__dirname, 'fixtures');
const fx = n => fs.readFileSync(path.join(FX, n), 'utf8');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.join(SITE, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(SITE) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(fs.readFileSync(p));
});
const queue = []; const t = (name, fn) => queue.push([name, fn]);
let browser, base;

async function open(bank, opts = {}) {   // bank: null (real 404), or a fixture file name
  const ctx = await browser.newContext(opts.ctx || {}); const page = await ctx.newPage();
  const requests = []; const errors = [];
  page.on('request', r => requests.push(r.url())); page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  if (bank) await page.route('**/data/questions.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: fx(bank) }));
  await page.goto(base + '/exam.html'); await page.waitForFunction(() => window.__examReady === true);
  return { page, ctx, requests, errors };
}
const txt = (p, sel) => p.locator(sel).innerText();
const attr = (p, sel, a) => p.locator(sel).getAttribute(a);

t('loads with the existing site design; no bank -> clear message, no console errors', async () => {
  const { page, ctx, errors } = await open(null);
  assert.match(await txt(page, '#bank-note'), /No question bank has been imported/); assert.strictEqual(await page.title(), 'Exam window preview | GATE Prep Studio');
  assert.ok(await page.locator('link[href="style.css"]').count()); assert.ok(await page.locator('.site-header .brand').count()); assert.ok(await page.locator('.site-footer').count());
  assert.deepStrictEqual(errors.filter(e => !/404/.test(e)), []); await ctx.close();
});
t('preview is clearly labelled; countdown shows no fake time; no duration is invented', async () => {
  const { page, ctx } = await open(null);
  assert.match(await txt(page, 'main'), /layout placeholders, not GATE questions/); assert.match(await txt(page, 'main'), /Nothing here is saved, sent, timed or scored/);
  assert.strictEqual(await txt(page, '#exam-timer'), '--:--:--'); assert.strictEqual(await txt(page, '#exam-timer-state'), 'Not running (preview)');
  assert.strictEqual(await attr(page, '#exam-timer', 'role'), 'timer'); assert.strictEqual(await attr(page, '#exam-timer', 'aria-live'), 'off');
  assert.match(await txt(page, '#gate'), /round\(total marks × 10800 ÷ 65\) seconds/); assert.match(await txt(page, '#gate'), /You do not set the time/);
  assert.match(await txt(page, '#exam-root'), /Total marks: not set in the preview/); await ctx.close();
});
t('countdown display updates, pads, and says when time is up (display only)', async () => {
  const { page, ctx } = await open(null);
  await page.evaluate(() => window.__exam.showRemaining(10800)); assert.strictEqual(await txt(page, '#exam-timer'), '03:00:00'); assert.strictEqual(await txt(page, '#exam-timer-state'), 'Time remaining');
  await page.evaluate(() => window.__exam.showRemaining(1495)); assert.strictEqual(await txt(page, '#exam-timer'), '00:24:55');
  await page.evaluate(() => window.__exam.showRemaining(0)); assert.strictEqual(await txt(page, '#exam-timer'), '00:00:00'); assert.strictEqual(await txt(page, '#exam-timer-state'), 'Time is up.');
  assert.ok(await page.locator('#exam-window').isVisible(), 'nothing is auto-submitted or hidden at zero'); assert.strictEqual(await page.locator('#exam-summary').isVisible(), false);
  await page.evaluate(() => window.__exam.showRemaining(null)); assert.strictEqual(await txt(page, '#exam-timer'), '--:--:--'); await ctx.close();
});
t('exam attempts stay disabled for every bank state, including a valid bank', async () => {
  for (const bank of [null, 'valid.json', 'empty.json', 'bad-schema.json', 'not-json.txt']) {
    const { page, ctx } = await open(bank);
    assert.strictEqual(await attr(page, '#exam-start', 'aria-disabled'), 'true', String(bank));
    const items = await page.locator('#exam-blockers li').allInnerTexts();
    assert.ok(items.some(i => /Marking rules/.test(i)) && items.some(i => /exam engine is not built/.test(i)) && items.some(i => /no backend enforces it yet/.test(i)), String(bank));
    await page.click('#exam-start', { force: true }); assert.match(await txt(page, '#exam-gate-status'), /cannot start yet/);
    assert.ok(!/^Ready/.test(await txt(page, '#exam-gate-status'))); assert.ok(await page.url().endsWith('/exam.html'));
    if (bank === 'valid.json') { assert.match(await txt(page, '#bank-note'), /12 usable questions/); assert.ok(!items.some(i => /No usable question bank/.test(i))); }
    else assert.ok(items.some(i => /No usable question bank/.test(i)), String(bank));
    await ctx.close();
  }
});
t('layout placeholders only: bank question text, options and keys never appear on the page', async () => {
  const { page, ctx } = await open('with-answer-keys.json'); const body = await page.locator('body').innerText();
  assert.ok(!body.includes('SYNTHETIC TEST QUESTION')); assert.ok(!body.includes('SYNTHETIC SECRET EXPLANATION')); assert.ok(!body.includes('synthetic a'));
  assert.ok(!/answer[_ ]key|explanation/i.test(await page.locator('#exam-root').innerText()));
  const html = await page.content(); assert.ok(!html.includes('SYNTHETIC SECRET')); await ctx.close();
});
t('question panel: 12 slots, first shown, types cycle MCQ/MCQ/MSQ/NAT with matching controls', async () => {
  const { page, ctx } = await open(null);
  assert.strictEqual(await page.locator('#exam-palette button').count(), 12); assert.strictEqual(await txt(page, '#exam-qtitle'), 'Question 1 of 12');
  assert.match(await txt(page, '#exam-qtype'), /MCQ.*Select one option/); assert.strictEqual(await page.locator('#exam-answer input[type=radio]').count(), 4);
  await page.click('#exam-next'); await page.click('#exam-next'); assert.match(await txt(page, '#exam-qtype'), /MSQ.*one or more/); assert.strictEqual(await page.locator('#exam-answer input[type=checkbox]').count(), 4);
  await page.click('#exam-next'); assert.match(await txt(page, '#exam-qtype'), /NAT.*number/); assert.strictEqual(await page.locator('#exam-nat').count(), 1);
  assert.ok(await page.locator('label[for=exam-nat]').count()); await ctx.close();
});
t('navigation: previous/next bounds, palette jump, focus moves to the question heading, no wrap', async () => {
  const { page, ctx } = await open(null);
  assert.strictEqual(await page.locator('#exam-prev').isDisabled(), true); await page.click('#exam-next'); assert.strictEqual(await txt(page, '#exam-qtitle'), 'Question 2 of 12');
  assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'exam-qtitle');
  await page.click('#exam-palette button:nth-child(12)'); assert.strictEqual(await txt(page, '#exam-qtitle'), 'Question 12 of 12'); assert.strictEqual(await page.locator('#exam-next').isDisabled(), true);
  await page.click('#exam-palette button:nth-child(1)'); assert.strictEqual(await page.locator('#exam-prev').isDisabled(), true);
  assert.strictEqual(await attr(page, '#exam-palette button:nth-child(1)', 'aria-current'), 'true'); assert.strictEqual(await page.locator('#exam-palette [aria-current]').count(), 1); await ctx.close();
});
t('palette states: not visited -> not answered -> answered -> marked, with text alternatives and live counts', async () => {
  const { page, ctx } = await open(null); const b = n => `#exam-palette button:nth-child(${n})`;
  assert.match(await attr(page, b(1), 'aria-label'), /Question 1: not answered/); assert.match(await attr(page, b(2), 'aria-label'), /Question 2: not visited/);
  assert.deepStrictEqual([await txt(page, '#cnt-answered'), await txt(page, '#cnt-notanswered'), await txt(page, '#cnt-marked'), await txt(page, '#cnt-notvisited')], ['0', '1', '0', '11']);
  await page.check('#exam-opt-B'); assert.match(await attr(page, b(1), 'aria-label'), /Question 1: answered/); assert.ok((await attr(page, b(1), 'class')).includes(' a'));
  await page.click('#exam-mark'); assert.match(await attr(page, b(1), 'aria-label'), /marked for review, also has an answer/); assert.ok((await attr(page, b(1), 'class')).includes('am'));
  assert.deepStrictEqual([await txt(page, '#cnt-answered'), await txt(page, '#cnt-notanswered'), await txt(page, '#cnt-marked'), await txt(page, '#cnt-notvisited')], ['1', '0', '1', '11']); await ctx.close();
});
t('answer selection: MCQ is single choice, MSQ multiple, NAT text; each survives navigating away and back', async () => {
  const { page, ctx } = await open(null);
  await page.check('#exam-opt-A'); await page.check('#exam-opt-C'); assert.strictEqual(await page.locator('#exam-answer input:checked').count(), 1); assert.strictEqual(await page.isChecked('#exam-opt-C'), true);
  await page.click('#exam-next'); await page.click('#exam-next'); await page.check('#exam-opt-A'); await page.check('#exam-opt-D'); assert.strictEqual(await page.locator('#exam-answer input:checked').count(), 2);
  await page.uncheck('#exam-opt-A'); assert.strictEqual(await page.locator('#exam-answer input:checked').count(), 1);
  await page.click('#exam-next'); await page.fill('#exam-nat', ' 3.5 '); await page.click('#exam-prev'); await page.click('#exam-next');
  assert.strictEqual(await page.inputValue('#exam-nat'), '3.5'); await page.click('#exam-palette button:nth-child(1)'); assert.strictEqual(await page.isChecked('#exam-opt-C'), true);
  await page.click('#exam-palette button:nth-child(3)'); assert.strictEqual(await page.isChecked('#exam-opt-D'), true); assert.strictEqual(await page.isChecked('#exam-opt-A'), false); await ctx.close();
});
t('typing a NAT answer keeps keyboard focus in the field (palette re-render must not steal it)', async () => {
  const { page, ctx } = await open(null); await page.click('#exam-palette button:nth-child(4)'); await page.click('#exam-nat'); await page.keyboard.type('42');
  assert.strictEqual(await page.inputValue('#exam-nat'), '42'); assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'exam-nat');
  await page.fill('#exam-nat', ''); assert.match(await attr(page, '#exam-palette button:nth-child(4)', 'aria-label'), /not answered/); await ctx.close();
});
t('clear response: removes the answer, keeps the review mark, announces, and is harmless when empty', async () => {
  const { page, ctx } = await open(null);
  await page.click('#exam-clear'); assert.match(await txt(page, '#exam-status'), /had no response to clear/);
  await page.check('#exam-opt-B'); await page.click('#exam-mark'); await page.click('#exam-clear');
  assert.strictEqual(await page.locator('#exam-answer input:checked').count(), 0); assert.match(await txt(page, '#exam-status'), /Response cleared for question 1/);
  assert.strictEqual(await attr(page, '#exam-mark', 'aria-pressed'), 'true'); assert.match(await attr(page, '#exam-palette button:nth-child(1)', 'aria-label'), /marked for review$/);
  await page.click('#exam-palette button:nth-child(4)'); await page.fill('#exam-nat', '7'); await page.click('#exam-clear'); assert.strictEqual(await page.inputValue('#exam-nat'), ''); await ctx.close();
});
t('mark for review: toggles with aria-pressed, status text and palette shape; persists per question', async () => {
  const { page, ctx } = await open(null);
  assert.strictEqual(await attr(page, '#exam-mark', 'aria-pressed'), 'false'); await page.click('#exam-mark'); assert.strictEqual(await attr(page, '#exam-mark', 'aria-pressed'), 'true');
  assert.match(await txt(page, '#exam-mark-state'), /marked for review/); assert.match(await txt(page, '#exam-status'), /Question 1 marked for review/);
  await page.click('#exam-next'); assert.strictEqual(await attr(page, '#exam-mark', 'aria-pressed'), 'false'); await page.click('#exam-prev'); assert.strictEqual(await attr(page, '#exam-mark', 'aria-pressed'), 'true');
  await page.click('#exam-mark'); assert.match(await txt(page, '#exam-status'), /no longer marked/); assert.strictEqual(await txt(page, '#cnt-marked'), '0'); await ctx.close();
});
t('summary: counts match the palette, per-question table, back returns to the same question, submit locks the preview attempt', async () => {
  const { page, ctx } = await open(null);
  await page.check('#exam-opt-A'); await page.click('#exam-mark'); await page.click('#exam-next'); await page.click('#exam-next'); await page.click('#exam-palette button:nth-child(4)'); await page.fill('#exam-nat', '9');
  await page.click('#exam-open-summary'); assert.strictEqual(await page.locator('#exam-summary').isVisible(), true); assert.strictEqual(await page.locator('#exam-window').isVisible(), false);
  assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'exam-summary-title');
  const v = async id => txt(page, '#' + id);
  assert.deepStrictEqual([await v('sum-total'), await v('sum-answered'), await v('sum-notanswered'), await v('sum-notvisited'), await v('sum-marked'), await v('sum-both')], ['12', '2', '2', '8', '1', '1']);
  assert.strictEqual(await page.locator('#exam-summary-rows tr').count(), 12); assert.deepStrictEqual(await page.locator('#exam-summary-rows tr:nth-child(1) td').allInnerTexts(), ['1', 'MCQ', 'Answered', 'A', 'Yes']);
  assert.deepStrictEqual(await page.locator('#exam-summary-rows tr:nth-child(2) td').allInnerTexts(), ['2', 'MCQ', 'Not answered', '\u2014', 'No']); assert.deepStrictEqual(await page.locator('#exam-summary-rows tr:nth-child(5) td').allInnerTexts(), ['5', 'MCQ', 'Not visited', '\u2014', 'No']);
  assert.ok(await page.locator('#exam-summary caption').count()); assert.ok(await page.locator('#exam-summary th[scope=col]').count() === 5);
  await page.click('#exam-submit'); assert.match(await txt(page, '#exam-submit-status'), /Press the button again to confirm/); assert.strictEqual(await txt(page, '#exam-state'), 'Attempt state: in progress (preview).');
  await page.click('#exam-back'); await page.click('#exam-open-summary');   /* leaving the summary disarms the confirmation */
  await page.click('#exam-submit'); await page.click('#exam-submit'); assert.match(await txt(page, '#exam-state'), /submitted \(preview\)\..*read-only\. Nothing was sent or scored/); assert.strictEqual(await page.locator('#exam-submit').isDisabled(), true);
  assert.deepStrictEqual([await v('sum-total'), await v('sum-answered'), await v('sum-marked'), await v('sum-both')], ['12', '2', '1', '1']);
  await page.click('#exam-back'); assert.strictEqual(await page.locator('#exam-nat').isDisabled(), true); assert.strictEqual(await page.locator('#exam-clear').isDisabled(), true); assert.strictEqual(await page.locator('#exam-mark').isDisabled(), true);
  await page.click('#exam-restart'); assert.strictEqual(await txt(page, '#cnt-answered'), '0'); assert.strictEqual(await txt(page, '#exam-state'), 'Attempt state: in progress (preview).');
  await page.click('#exam-simulate-timeup'); assert.match(await txt(page, '#exam-state'), /time is up/); assert.strictEqual(await page.locator('#exam-clear').isDisabled(), true);
  await page.click('#exam-restart'); await page.click('#exam-next'); await page.click('#exam-next'); await page.click('#exam-next'); await page.click('#exam-prev'); await page.click('#exam-prev'); await page.click('#exam-prev');
  await page.click('#exam-palette button:nth-child(4)'); await page.fill('#exam-nat', '9'); await page.click('#exam-open-summary');
  await page.click('#exam-back'); assert.strictEqual(await page.locator('#exam-window').isVisible(), true); assert.strictEqual(await txt(page, '#exam-qtitle'), 'Question 4 of 12'); assert.strictEqual(await page.inputValue('#exam-nat'), '9'); await ctx.close();
});
t('nothing is stored or sent: no web storage, no cookies, only the allowed requests, no unload prompt', async () => {
  const { page, ctx, requests } = await open(null);
  await page.check('#exam-opt-A'); await page.click('#exam-mark'); await page.click('#exam-open-summary'); await page.click('#exam-submit'); await page.click('#exam-submit');
  assert.deepStrictEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, '']);
  assert.deepStrictEqual(await page.evaluate(async () => (await indexedDB.databases()).length), 0); assert.deepStrictEqual(await ctx.cookies(), []);
  const own = requests.filter(u => u.startsWith(base)).map(u => new URL(u).pathname).filter(p => p !== '/favicon.ico');
  assert.deepStrictEqual([...new Set(own)].sort(), ['/app.js', '/data/questions.json', '/exam.html', '/style.css']); assert.ok(!requests.some(u => !u.startsWith(base) && !u.startsWith('data:')));
  let dialog = false; page.on('dialog', () => { dialog = true; }); await page.reload(); assert.strictEqual(dialog, false);
  await page.waitForFunction(() => window.__examReady === true); assert.strictEqual(await txt(page, '#exam-qtitle'), 'Question 1 of 12'); assert.strictEqual(await txt(page, '#cnt-answered'), '0'); await ctx.close();
});
t('keyboard: palette buttons, options and actions are reachable and operable without a mouse', async () => {
  const { page, ctx } = await open(null);
  await page.focus('#exam-palette button:nth-child(2)'); await page.keyboard.press('Enter'); assert.strictEqual(await txt(page, '#exam-qtitle'), 'Question 2 of 12');
  await page.focus('#exam-opt-A'); await page.keyboard.press('Space'); assert.strictEqual(await page.isChecked('#exam-opt-A'), true);
  await page.focus('#exam-mark'); await page.keyboard.press('Enter'); assert.strictEqual(await attr(page, '#exam-mark', 'aria-pressed'), 'true');
  await page.focus('#exam-next'); await page.keyboard.press('Enter'); assert.strictEqual(await txt(page, '#exam-qtitle'), 'Question 3 of 12');
  assert.ok((await page.locator('#exam-palette button').evaluateAll(bs => bs.every(b => b.tabIndex >= 0)))); await ctx.close();
});
t('accessibility wiring: unique ids, labelled controls, live regions, heading order', async () => {
  const { page, ctx } = await open(null);
  const r = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map(e => e.id); const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
    const unlabeled = [...document.querySelectorAll('#exam-root input')].filter(i => !document.querySelector(`label[for="${i.id}"]`)).map(i => i.id);
    const noName = [...document.querySelectorAll('#exam-root button')].filter(b => !(b.getAttribute('aria-label') || b.textContent.trim())).length;
    const levels = [...document.querySelectorAll('main h1, main h2, main h3')].map(h => +h.tagName[1]); let skip = false; levels.forEach((l, i) => { if (i && l - levels[i - 1] > 1) skip = true; });
    return { dup, unlabeled, noName, skip, h1: document.querySelectorAll('h1').length, lang: document.documentElement.lang,
      live: ['exam-status', 'exam-gate-status', 'bank-note'].map(id => document.getElementById(id).getAttribute('role') + '/' + document.getElementById(id).getAttribute('aria-live')) };
  });
  assert.deepStrictEqual(r.dup, []); assert.deepStrictEqual(r.unlabeled, []); assert.strictEqual(r.noName, 0); assert.strictEqual(r.skip, false); assert.strictEqual(r.h1, 1); assert.strictEqual(r.lang, 'en');
  assert.deepStrictEqual(r.live, ['status/polite', 'status/polite', 'status/null']); await ctx.close();
});
t('responsive: no horizontal scroll at 360px and 1280px; palette tap targets >= 44px', async () => {
  for (const w of [360, 1280]) {
    const { page, ctx } = await open(null, { ctx: { viewport: { width: w, height: 800 } } });
    assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'width ' + w);
    const sizes = await page.locator('#exam-palette button').evaluateAll(bs => bs.map(b => Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height))); assert.ok(sizes.every(s => s >= 43.5), w + ': ' + Math.min(...sizes));
    await page.click('#exam-open-summary'); assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'summary ' + w); await ctx.close();
  }
});
t('dark mode renders (no errors) and palette text stays readable', async () => {
  const { page, ctx } = await open(null, { ctx: { colorScheme: 'dark' } }); const c = await page.evaluate(() => getComputedStyle(document.querySelector('#exam-palette button.u')).color);
  assert.strictEqual(c, 'rgb(15, 21, 35)'); await ctx.close();
});
t('untrusted bank data cannot inject markup into the exam page', async () => {
  const evil = JSON.parse(fx('valid.json')); evil.questions[0].branch = '<img src=x onerror=alert(1)>'; evil.questions[0].source.name = '<script>alert(1)</script>';
  const ctx = await browser.newContext(); const page = await ctx.newPage(); let dialog = false; page.on('dialog', () => { dialog = true; });
  await page.route('**/data/questions.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(evil) }));
  await page.goto(base + '/exam.html'); await page.waitForFunction(() => window.__examReady === true);
  assert.strictEqual(await page.locator('main img').count(), 0); assert.strictEqual(dialog, false); await ctx.close();
});
t('other pages unaffected: practice page links to the preview; link works', async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage(); await page.goto(base + '/practice.html'); await page.waitForFunction(() => window.__practiceReady === true);
  await page.click('a[href="exam.html"]'); await page.waitForFunction(() => window.__examReady === true); assert.match(page.url(), /exam\.html$/); await ctx.close();
});

t('practice page regression smoke (existing behaviour still works with the extended app.js)', async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/data/questions.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: fx('valid.json') }));
  await page.goto(base + '/practice.html?mode=custom'); await page.waitForFunction(() => window.__practiceReady === true);
  assert.strictEqual(await txt(page, '#sum-matching'), '12'); assert.strictEqual(await txt(page, '#sum-marks'), '18');
  await page.selectOption('#pf-branch', 'SYN-BRANCH-1'); assert.strictEqual(await txt(page, '#sum-marks'), '9'); assert.strictEqual(await txt(page, '#sum-duration'), '0 h 24 min 55 s (1495 s)');
  await page.click('#start-test', { force: true }); assert.match(await txt(page, '#summary-status'), /cannot start yet/); assert.strictEqual(await txt(page, '#sum-ready'), 'No');
  assert.deepStrictEqual(errors, []); await ctx.close();
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ args: ['--no-sandbox'] });
  let n = 0;
  for (const [name, fn] of queue) { try { await fn(); n++; console.log('ok -', name); } catch (e) { console.error('FAIL -', name, '\n', e.message.split('\n').slice(0, 6).join('\n')); process.exitCode = 1; } }
  console.log(`\n${n}/${queue.length} exam browser tests passed`);
  await browser.close(); server.close();
})();
