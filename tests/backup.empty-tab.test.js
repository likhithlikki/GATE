'use strict';
/**
 * Task 46 + Task 47 + Task 48 focused checks for private-backup/Backup.gs (empty-tab support), run against an in-memory MOCK of Apps Script, Drive and Sheets.
 * Mocked checks do NOT prove real Apps Script, Google Drive or Google Sheets behaviour. Run: node backup.empty-tab.test.js
 * Part 1 runs the checks against the real source. Part 2 (mutation controls) deliberately breaks the source one way at a time and requires
 * that at least one check then fails, proving the checks can actually detect a broken empty-tab rule.
 */
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const SRC_DIR = path.join(__dirname, '..', 'private-backup');
const readSrc = () => ['Validation.gs', 'Schemas.gs', 'Backup.gs'].map(f => fs.readFileSync(path.join(SRC_DIR, f), 'utf8')).join('\n');

/* ---------------- Apps Script / Drive / Sheets mock ---------------- */
const OWNER = 'owner@example.com';
const iter = arr => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
const blank = c => !c || ((c.v === '' || c.v === null || c.v === undefined) && !c.f);

function makeWorld(mutate) {
  const W = { writes: 0, nodes: {}, books: {}, seq: 0, props: {}, user: OWNER, logs: [] };
  const newId = p => p + '_' + String(++W.seq).padStart(10, '0');

  function Sheet(book, name, data) {
    this.name = name; this.data = data;                         /* data: array of rows of {v,f}; no mutators are exposed (read-only mock) */
  }
  Sheet.prototype.getName = function () { return this.name; };
  Sheet.prototype.getLastRow = function () { let m = 0; this.data.forEach((r, i) => { if (r.some(c => !blank(c))) m = i + 1; }); return m; };
  Sheet.prototype.getLastColumn = function () { let m = 0; this.data.forEach(r => r.forEach((c, j) => { if (!blank(c)) m = Math.max(m, j + 1); })); return m; };
  Sheet.prototype.getRange = function (r, c, n, k) {
    if (W.ranges) { W.ranges.push({ r: r, c: c, n: n, k: k }); }
    const self = this, cell = (i, j) => (self.data[r - 1 + i] || [])[c - 1 + j] || { v: '', f: '' };
    const grid = fn => Array.from({ length: n }, (_, i) => Array.from({ length: k }, (_, j) => fn(cell(i, j))));
    return { getValues: () => grid(x => (x.v === undefined || x.v === null ? '' : x.v)), getFormulas: () => grid(x => x.f || '') };
  };
  const bookObj = id => ({ getSheets: () => W.books[id].map(s => s), getSheetByName: n => W.books[id].find(s => s.name === n) || null });
  const cloneCell = c => (c && typeof c === 'object' ? { v: c.v instanceof Date ? new Date(c.v.getTime()) : c.v, f: c.f } : c);   /* keeps Date cells as Dates, as a real copy does */
  const cloneBook = sheets => sheets.map(s => new Sheet(null, s.name, s.data.map(row => row.map(cloneCell))));

  function fileApi(node) {
    return {
      getId: () => node.id, getName: () => node.name, isTrashed: () => !!node.trashed, getMimeType: () => node.mime,
      getSharingAccess: () => node.access, getEditors: () => node.editors.map(e => ({ getEmail: () => e })), getViewers: () => node.viewers.map(e => ({ getEmail: () => e })),
      getBlob: () => ({ getDataAsString: () => node.content }),
      makeCopy: (name, folder) => {
        W.writes++;
        const n = addNode({ kind: 'file', name, mime: 'application/vnd.google-apps.spreadsheet', parent: folder.getId(), ssId: null });
        n.ssId = n.id; W.books[n.id] = cloneBook(W.books[node.ssId]);
        return fileApi(n);
      }
    };
  }
  function folderApi(node) {
    const kids = kind => Object.values(W.nodes).filter(n => n.parent === node.id && n.kind === kind);
    return Object.assign(fileApi(node), {
      getOwner: () => (node.owner ? { getEmail: () => node.owner } : null),
      getParents: () => iter(node.parent ? [folderApi(W.nodes[node.parent])] : []),
      getFoldersByName: nm => iter(kids('folder').filter(n => n.name === nm).map(folderApi)),
      getFilesByName: nm => iter(kids('file').filter(n => n.name === nm).map(fileApi)),
      getFiles: () => iter(kids('file').map(fileApi)),
      createFolder: nm => { W.writes++; return folderApi(addNode({ kind: 'folder', name: nm, parent: node.id })); },
      createFile: (nm, content) => { W.writes++; return fileApi(addNode({ kind: 'file', name: nm, mime: 'text/plain', parent: node.id, content })); }
    });
  }
  function addNode(o) {
    const n = Object.assign({ id: newId(o.kind === 'folder' ? 'FOLDER' : 'FILE'), access: 'PRIVATE', editors: [], viewers: [], owner: OWNER, trashed: false, content: '' }, o);
    W.nodes[n.id] = n; return n;
  }
  W.addNode = addNode;

  const ctx = {
    console, Logger: { log: m => W.logs.push(String(m)) }, MimeType: { GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet', PLAIN_TEXT: 'text/plain' },
    Session: { getEffectiveUser: () => ({ getEmail: () => W.user }), getActiveUser: () => ({ getEmail: () => W.user }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in W.props ? W.props[k] : null) }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: () => crypto.randomUUID(),
      computeDigest: (a, text) => Array.from(new Int8Array(crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest()))
    },
    SpreadsheetApp: { openById: id => { if (!W.books[id]) { throw new Error('not found'); } return bookObj(id); } },
    DriveApp: {
      Access: { PRIVATE: 'PRIVATE' },
      getRootFolder: () => folderApi(W.nodes[W.rootId]),
      getFolderById: id => { if (!W.nodes[id] || W.nodes[id].kind !== 'folder') { throw new Error('not found'); } return folderApi(W.nodes[id]); },
      getFileById: id => { if (!W.nodes[id] || W.nodes[id].kind !== 'file') { throw new Error('not found'); } return fileApi(W.nodes[id]); }
    }
  };
  vm.createContext(ctx);
  let src = readSrc();
  if (mutate) { const out = mutate(src); if (out === src) { throw new Error('mutation did not change the source'); } src = out; }
  vm.runInContext(src, ctx, { filename: 'Backup.gs' });
  W.ctx = ctx; W.SCHEMAS = ctx.BACKUP_DB_SCHEMAS;

  /* root + private backup folder + three sources with all schema tabs (header + one data row) */
  W.rootId = addNode({ kind: 'folder', name: 'root', parent: null, owner: OWNER }).id;
  W.folderId = addNode({ kind: 'folder', name: 'backups', parent: W.rootId }).id;
  W.ids = {};
  Object.keys(W.SCHEMAS).forEach(db => {
    const sheets = Object.keys(W.SCHEMAS[db]).map(tab => {
      const cols = W.SCHEMAS[db][tab];
      return new Sheet(null, tab, [cols.map(c => ({ v: c })), cols.map((c, i) => (i === 0 ? { v: 'x' } : i === 1 ? { v: 0 } : i === 2 ? { v: true } : { v: '', f: i === 3 ? '=A2' : '' }))]);
    });
    const n = addNode({ kind: 'file', name: db + '_src', mime: ctx.MimeType.GOOGLE_SHEETS, parent: W.rootId });
    n.ssId = n.id; W.books[n.id] = sheets; W.ids[db] = n.id;
  });
  W.props = { AUTH_DB_ID: W.ids.AUTH_DB, EXAM_DB_ID: W.ids.EXAM_DB, KEYS_DB_ID: W.ids.KEYS_DB, PRIVATE_BACKUP_FOLDER_ID: W.folderId, BACKUP_OWNER_EMAIL: OWNER };
  W.addEmptyTab = (db, name) => { W.books[W.ids[db]].push(new Sheet(null, name || 'scratch', [])); };
  W.backup = () => ctx.admin_backup_private_databases();
  W.runFolderId = () => Object.values(W.nodes).find(n => n.kind === 'folder' && /^gps-backup-/.test(n.name)).id;
  W.manifestNode = () => Object.values(W.nodes).find(n => n.parent === W.runFolderId() && /^manifest/.test(n.name));
  W.getManifest = () => JSON.parse(W.manifestNode().content);
  W.setManifest = fn => { const n = W.manifestNode(), m = JSON.parse(n.content); fn(m); n.content = JSON.stringify(m, null, 2); };  /* test-only edit of the mock copy */
  W.copyBook = db => { const f = Object.values(W.nodes).find(n => n.parent === W.runFolderId() && n.name.indexOf(db + '_backup_') === 0); return W.books[f.ssId]; };
  W.verify = (arg) => (arg === undefined && arguments.length === 0 ? ctx.admin_verify_private_backup() : ctx.admin_verify_private_backup(arg));
  W.snapshot = () => JSON.stringify([W.nodes, W.books, W.props]);
  return W;
}


/* ---- Task 48 helpers: an independent reference of the documented fingerprint algorithm, and a deterministic cell generator ---- */
function t48CellAt(r, c) {
  const k = (r * 31 + c * 17) % 7;
  if (k === 0) { return { v: '', f: '' }; }
  if (k === 1) { return { v: 'a,b\n\u00e9' + r + ':' + c, f: '' }; }
  if (k === 2) { return { v: r * 1.5 - c + 0.1, f: '' }; }
  if (k === 3) { return { v: (r + c) % 2 === 0, f: '' }; }
  if (k === 4) { return { v: new Date(86400000 * c + r), f: '' }; }
  if (k === 5) { return { v: r, f: '=A' + r + '+' + c }; }
  return { v: null, f: '' };
}
function t48Tok(x) {
  if (x.f) { return 'f' + x.f.length + ':' + x.f; }
  const v = x.v;
  if (v === '' || v === null || v === undefined) { return 'b'; }
  if (typeof v === 'string') { return 's' + v.length + ':' + v; }
  if (typeof v === 'number') { return 'n' + String(v); }
  if (typeof v === 'boolean') { return v ? 'T' : 'F'; }
  return 'd' + String(v.getTime());
}
function t48Ref(name, rows, cols, cellAt) {                       /* reads every cell directly: no ranges, no chunk-size limit */
  const H = t => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
  let st = H('GPSFP1\nchunk:5000\ntab:' + name.length + ':' + name + '\nrows:' + rows + '\ncols:' + cols);
  if (rows === 0) { return st; }
  const per = Math.max(1, Math.floor(5000 / cols)); let idx = 0;
  for (let r = 1; r <= rows; r += per, idx++) {
    let text = '';
    for (let i = r; i < Math.min(r + per, rows + 1); i++) { const t = []; for (let c = 1; c <= cols; c++) { t.push(t48Tok(cellAt(i, c))); } text += t.join(',') + '\n'; }
    st = H(st + '\n' + idx + '\n' + H(text));
  }
  return st;
}
function t48Sheet(cellAt, log) {
  return { getRange: (r, c, n, k) => {
    if (log) { log.push({ r, c, n, k }); }
    const g = fn => Array.from({ length: n }, (_, i) => Array.from({ length: k }, (_, j) => fn(cellAt(r + i, c + j))));
    return { getValues: () => g(x => x.v), getFormulas: () => g(x => x.f) };
  } };
}
/* digests produced by the ORIGINAL (pre-Task-48) bkTabFingerprint_ from gate-prep-studio (36).zip for t48CellAt tabs; they must never change */
const T48_GOLDEN = {
  "g1:3x4": "06a93a10750038064a68df91dfb74d911a388093a8b5a8f18c32ed36c829bbfe",
  "g2:2x5001": "ff11914d30894802597e39ac1bcb80a74f3a564cd15e4866e75038c18d0bb6a2",
  "g3:1x18278": "b4472251e816e98e0f1ece9209dee0e2eaa644288ce9f6df8435db8243104d7d",
  "g4:7x5000": "f74ac6c80b1ac77ae9f9b52aa8e62b552ff92f838e369aa8acf13888225c16cf",
  "g5:3x1": "007f0575226051f860cc174e2d3f88e116e732a64154becc3dae25acf75494ab",
  "g6:2x20000": "dbc4d7ec9392cdcfc95db741e7902f46c40a27d9b152459a8e074f1d594f8e8c",
  "g7:1x10001": "16da6e4ef9204160a87d0be033ffcd689b1d9a4e238db5d55304daceb10e4ea0",
  "g8:12001x1": "90a0ea8c77c8ab2741dd07b3eb324908eedd7380dae3391ebbff12943f457f0b"
};

/* ---------------- check framework ---------------- */
function suite(mutate) {
  const fails = []; let total = 0, current = '';
  const ok = (cond, msg) => { total++; if (!cond) { fails.push(current + ': ' + msg); } };
  const eq = (a, b, msg) => ok(a === b, msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');
  const T = (name, fn) => { current = name; try { fn(); } catch (e) { total++; fails.push(name + ': threw ' + (e && e.message)); } };
  const expectedEmptyDigest = (name) => crypto.createHash('sha256').update('GPSFP1\nchunk:5000\ntab:' + name.length + ':' + name + '\nrows:0\ncols:0').digest('hex');
  const tabRec = (m, db, tab) => m.databases.find(d => d.type === db).tabs.find(t => t.tab === tab);
  const good = () => { const W = makeWorld(mutate); W.addEmptyTab('EXAM_DB', 'scratch'); const r = W.backup(); return { W, r }; };

  T('1-2 backup with a legitimate empty extra tab', () => {
    const { W, r } = good();
    eq(r.ok, true, 'backup ok'); eq(r.code, 'backup_complete', 'code'); eq(r.copies_verified, 3, '3 copies verified');
    const m = W.getManifest(); eq(m.manifest_version, 2, 'version 2'); eq(m.fingerprint_scheme, 'gps-tab-sha256-v1', 'scheme'); eq(m.status, 'complete', 'complete');
    eq(W.manifestNode().name, 'manifest.json', 'complete manifest file');
    const t = tabRec(m, 'EXAM_DB', 'scratch');
    ok(!!t, 'empty tab recorded'); eq(t && t.last_row, 0, 'last_row 0'); eq(t && t.last_column, 0, 'last_column 0');
    eq(t && t.sha256, expectedEmptyDigest('scratch'), 'independently computed empty-tab digest');
    Object.keys(W.SCHEMAS.EXAM_DB).forEach(tab => ok(tabRec(m, 'EXAM_DB', tab).last_row >= 1, 'schema tab ' + tab + ' non-empty'));
  });

  T('3 verification of the complete backup, zero writes, state unchanged', () => {
    const { W } = good(); const w0 = W.writes, snap = W.snapshot();
    const v = W.ctx.admin_verify_private_backup(W.runFolderId());
    eq(v.ok, true, 'verified ok'); eq(v.status, 'verified', 'status'); eq(v.code, 'backup_verified', 'code'); eq(v.copies_verified, 3, 'copies'); eq(v.tabs_checked, 23, '22 schema tabs + 1 empty');
    eq(W.writes, w0, 'zero writes'); eq(W.snapshot(), snap, 'Drive/Sheets state identical after verification');
    const w1 = W.ctx.admin_verify_private_backup(W.runFolderId()); eq(w1.ok, true, 'repeat verification ok (deterministic)');
  });

  T('2b deterministic empty fingerprint; name and size are part of it', () => {
    const W = makeWorld(mutate), f = W.ctx.bkTabFingerprint_, sh = { getRange() { throw new Error('must not read cells'); } };
    eq(f(sh, 'scratch', 0, 0), f(sh, 'scratch', 0, 0), 'repeat read identical'); eq(f(sh, 'scratch', 0, 0), expectedEmptyDigest('scratch'), 'matches spec');
    ok(f(sh, 'scratch', 0, 0) !== f(sh, 'other', 0, 0), 'name included');
    const full = { getRange: () => ({ getValues: () => [['a']], getFormulas: () => [['']] }) };
    ok(f(full, 'scratch', 1, 1) !== f(sh, 'scratch', 0, 0), 'gaining content changes the digest');
  });

  T('4 an empty tab gaining content fails against the old manifest', () => {
    let { W } = good();
    W.copyBook('EXAM_DB').find(s => s.name === 'scratch').data = [[{ v: 'new' }]];
    let v = W.ctx.admin_verify_private_backup(W.runFolderId()); eq(v.ok, false, 'not ok'); eq(v.code, 'copy_dimensions_mismatch', 'dimension mismatch caught');
    ({ W } = good());                                                       /* fingerprint layer alone: forge manifest dims to match the new content */
    W.copyBook('EXAM_DB').find(s => s.name === 'scratch').data = [[{ v: 'new' }]];
    W.setManifest(m => { const t = tabRec(m, 'EXAM_DB', 'scratch'); t.last_row = 1; t.last_column = 1; });
    v = W.ctx.admin_verify_private_backup(W.runFolderId()); eq(v.ok, false, 'not ok'); eq(v.code, 'copy_fingerprint_mismatch', 'fingerprint mismatch caught');
  });

  T('4b source tab gaining content between read and copy is handled by fingerprints', () => {
    const W = makeWorld(mutate), fp = W.ctx.bkFingerprints_;
    W.addEmptyTab('EXAM_DB', 'scratch'); const ss = W.ctx.SpreadsheetApp.openById(W.ids.EXAM_DB), d0 = W.ctx.bkDims_(ss), a = fp(ss, d0);
    W.books[W.ids.EXAM_DB].find(s => s.name === 'scratch').data = [[{ v: 1 }]];
    const d1 = W.ctx.bkDims_(ss), b = fp(ss, d1);
    ok(!W.ctx.bkSameFps_(a, b), 'old and new fingerprints differ'); ok(!W.ctx.bkSameDims_(d0, d1), 'dims differ');
  });

  T('5-6 manifest dimension rules (direct)', () => {
    const { W } = good(), base = () => { const m = W.getManifest(); return m; }, P = W.ctx.bkManifestProblem_;
    const withDims = (r, c, tab, ver) => { const m = base(); if (ver === 1) { m.manifest_version = 1; } tabRec(m, 'EXAM_DB', 'scratch'); const t = tabRec(m, 'EXAM_DB', tab || 'scratch'); if (r === undefined) { delete t.last_row; } else { t.last_row = r; } if (c === undefined) { delete t.last_column; } else { t.last_column = c; } return P(m, m.run_id, true); };
    eq(withDims(0, 0), '', 'empty non-schema tab (0,0) accepted'); eq(withDims(3, 4), '', 'non-empty accepted');
    [[-1, -1, 'negative both'], [-1, 2, 'negative row'], [2, -1, 'negative col'], [1.5, 2, 'fractional row'], [2, 0.5, 'fractional col'], [2 ** 53, 1, 'unsafe row'], [1, 2 ** 53, 'unsafe col'], [Infinity, 1, 'infinity'],
     [NaN, NaN, 'NaN'], ['0', '0', 'string zeros'], ['3', 4, 'string row'], [null, null, 'nulls'], [true, true, 'booleans'], [undefined, 0, 'missing row'], [0, undefined, 'missing col'], [-0, -0, 'negative zero'], [0, -0, 'neg zero col'],
     [0, 3, 'zero row nonzero col'], [3, 0, 'nonzero row zero col'], [0, 1, '0/1'], [1, 0, '1/0']].forEach(x => eq(withDims(x[0], x[1]), 'tab_counts', 'rejected: ' + x[2]));
    Object.keys(W.SCHEMAS.EXAM_DB).slice(0, 3).forEach(tab => eq(withDims(0, 0, tab), 'tab_counts', 'empty schema tab rejected: ' + tab));
    eq(withDims(0, 0, 'scratch', 1), 'tab_counts', 'version-1 manifest still refuses an empty tab (unchanged)');
    eq(withDims(2, 3, 'scratch', 1), '', 'version-1 manifest with normal tabs still sound');
  });

  T('5-6b rejection through the verify flow (stored manifest)', () => {
    [[-1, -1], [1.5, 2], [2 ** 53, 1], [0, 3], [3, 0]].forEach(([r, c]) => {
      const { W } = good(); W.setManifest(m => { const t = tabRec(m, 'EXAM_DB', 'scratch'); t.last_row = r; t.last_column = c; });
      const v = W.ctx.admin_verify_private_backup(W.runFolderId()); eq(v.ok, false, 'not ok ' + r + ',' + c); eq(v.code, 'manifest_invalid', 'rejected ' + r + ',' + c);
    });
    const { W } = good(); W.setManifest(m => { const t = tabRec(m, 'EXAM_DB', 'scratch'); t.last_row = '0'; t.last_column = '0'; });
    eq(W.ctx.admin_verify_private_backup(W.runFolderId()).code, 'manifest_invalid', 'string zeros rejected, not coerced');
  });

  T('5c invalid dimensions are never fingerprinted', () => {
    const W = makeWorld(mutate), f = W.ctx.bkTabFingerprint_, sh = { getRange: () => ({ getValues: () => [['a']], getFormulas: () => [['']] }) };
    [[-1, 1], [1, -1], [1.5, 1], [0, 3], [3, 0], [NaN, 1], [2 ** 53, 1], ['1', '1'], [undefined, undefined]].forEach(([r, c]) => {
      let code = ''; try { f(sh, 't', r, c); } catch (e) { code = e.bkCode || 'other'; } eq(code, 'copy_fingerprint_failed', 'refused ' + r + ',' + c);
    });
  });

  T('7a empty required schema tab: source fails closed, nothing written', () => {
    const W = makeWorld(mutate); W.books[W.ids.AUTH_DB].find(s => s.name === 'users').data = [];
    const r = W.backup(); eq(r.ok, false, 'not ok'); eq(r.code, 'source_not_ready', 'code'); eq(W.writes, 0, 'zero writes');
    const W2 = makeWorld(mutate); W2.books[W2.ids.KEYS_DB].find(s => s.name === 'answer_keys').data = [[{ v: 'key_id' }]];   /* header too short */
    eq(W2.backup().code, 'source_not_ready', 'short header refused'); eq(W2.writes, 0, 'zero writes (2)');
  });

  T('7b empty required schema tab in a copy fails verification', () => {
    const { W } = good(); W.copyBook('AUTH_DB').find(s => s.name === 'users').data = [];
    const v = W.ctx.admin_verify_private_backup(W.runFolderId()); eq(v.ok, false, 'not ok'); ok(v.code === 'copy_dimensions_mismatch' || v.code === 'copy_schema_mismatch', 'failed closed: ' + v.code);
  });

  T('8 missing or malformed fingerprints', () => {
    const cases = [['missing sha on empty tab', t => { delete t.sha256; }], ['short', t => { t.sha256 = 'abc'; }], ['uppercase', t => { t.sha256 = expectedEmptyDigest('scratch').toUpperCase(); }],
      ['number', t => { t.sha256 = 5; }], ['null', t => { t.sha256 = null; }], ['empty string', t => { t.sha256 = ''; }]];
    cases.forEach(([nm, fn]) => { const { W } = good(); W.setManifest(m => fn(tabRec(m, 'EXAM_DB', 'scratch'))); const v = W.ctx.admin_verify_private_backup(W.runFolderId()); eq(v.ok, false, nm + ' not ok'); eq(v.code, 'manifest_invalid', nm + ' rejected'); });
    let { W } = good(); W.setManifest(m => { tabRec(m, 'EXAM_DB', 'scratch').sha256 = 'a'.repeat(64); });
    let v = W.ctx.admin_verify_private_backup(W.runFolderId()); eq(v.code, 'copy_fingerprint_mismatch', 'well-formed wrong digest on empty tab');
    ({ W } = good()); W.setManifest(m => { tabRec(m, 'AUTH_DB', 'users').sha256 = '0'.repeat(64); });
    v = W.ctx.admin_verify_private_backup(W.runFolderId()); eq(v.code, 'copy_fingerprint_mismatch', 'wrong digest on schema tab');
    ({ W } = good()); W.setManifest(m => { m.fingerprint_scheme = 'other'; }); eq(W.ctx.admin_verify_private_backup(W.runFolderId()).code, 'manifest_invalid', 'bad scheme');
    ({ W } = good()); W.copyBook('AUTH_DB').find(s => s.name === 'users').data[1][0] = { v: 'changed' };
    eq(W.ctx.admin_verify_private_backup(W.runFolderId()).code, 'copy_fingerprint_mismatch', 'changed content still caught');
    ({ W } = good()); W.setManifest(m => { m.databases[1].tabs = m.databases[1].tabs.filter(t => t.tab !== 'scratch'); });
    eq(W.ctx.admin_verify_private_backup(W.runFolderId()).code, 'copy_tabs_mismatch', 'extra unrecorded tab refused');
    ({ W } = good()); W.copyBook('EXAM_DB').push({ name: 'sneaky', data: [], getName() { return 'sneaky'; }, getLastRow: () => 0, getLastColumn: () => 0 });
    eq(W.ctx.admin_verify_private_backup(W.runFolderId()).code, 'copy_tabs_mismatch', 'unrecorded extra empty tab refused');
  });

  T('9 version-1 backups are never content-verified', () => {
    const { W } = good();
    W.setManifest(m => { m.manifest_version = 1; delete m.fingerprint_scheme; m.databases.forEach(d => d.tabs.forEach(t => delete t.sha256)); m.databases[1].tabs = m.databases[1].tabs.filter(t => t.tab !== 'scratch'); });
    /* a v1 manifest never listed an empty tab; the copy still has one, so the structural check refuses it exactly as before */
    let v = W.ctx.admin_verify_private_backup(W.runFolderId()); eq(v.ok, false, 'v1 not ok'); eq(v.code, 'copy_tabs_mismatch', 'v1 with unrecorded extra tab refused');
    const W2 = makeWorld(mutate); const r = W2.backup(); eq(r.ok, true, 'plain backup ok');
    W2.setManifest(m => { m.manifest_version = 1; delete m.fingerprint_scheme; m.databases.forEach(d => d.tabs.forEach(t => delete t.sha256)); });
    v = W2.ctx.admin_verify_private_backup(W2.runFolderId()); eq(v.ok, false, 'v1 never ok'); eq(v.status, 'legacy', 'legacy'); eq(v.code, 'backup_integrity_not_recorded', 'code'); eq(v.copies_verified, 0, 'no content-verified copies');
    const W3 = makeWorld(mutate); W3.backup(); W3.setManifest(m => { m.manifest_version = 1; delete m.fingerprint_scheme; m.databases.forEach(d => d.tabs.forEach(t => { delete t.sha256; })); m.databases[0].tabs[0].last_row = 0; m.databases[0].tabs[0].last_column = 0; });
    eq(W3.ctx.admin_verify_private_backup(W3.runFolderId()).code, 'manifest_invalid', 'v1 manifest recording an empty tab is refused as before');
  });

  T('10 owner, folder privacy, read-only and argument rules intact', () => {
    let W = makeWorld(mutate); W.user = 'intruder@example.com'; let r = W.backup(); eq(r.code, 'owner_mismatch', 'backup owner check'); eq(W.writes, 0, 'no writes');
    W = makeWorld(mutate); W.nodes[W.folderId].viewers = ['x@example.com']; r = W.backup(); eq(r.code, 'backup_folder_shared', 'shared folder refused'); eq(W.writes, 0, 'no writes (shared)');
    W = makeWorld(mutate); W.nodes[W.folderId].access = 'ANYONE_WITH_LINK'; r = W.backup(); eq(r.code, 'backup_folder_not_private', 'public folder refused'); eq(W.writes, 0, 'no writes (public)');
    W = makeWorld(mutate); W.nodes[W.folderId].owner = 'other@example.com'; eq(W.backup().code, 'backup_folder_not_owned', 'folder not owned');
    const g = good().W; const rid = g.runFolderId();
    g.user = 'intruder@example.com'; let w0 = g.writes; eq(g.ctx.admin_verify_private_backup(rid).code, 'owner_mismatch', 'verify owner check'); g.user = OWNER;
    const copy = Object.values(g.nodes).find(n => n.name.indexOf('AUTH_DB_backup_') === 0); copy.viewers = ['z@example.com'];
    eq(g.ctx.admin_verify_private_backup(rid).code, 'copy_not_private', 'shared copy refused'); copy.viewers = [];
    g.nodes[rid].access = 'ANYONE_WITH_LINK'; eq(g.ctx.admin_verify_private_backup(rid).code, 'run_folder_not_private', 'public run folder refused'); g.nodes[rid].access = 'PRIVATE';
    eq(g.ctx.admin_verify_private_backup('bad id!').code, 'run_folder_id_invalid', 'invalid argument');
    g.props.BACKUP_VERIFY_RUN_FOLDER_ID = rid; eq(g.ctx.admin_verify_private_backup('bad id!').code, 'run_folder_id_invalid', 'property never replaces an invalid argument');
    eq(g.ctx.admin_verify_private_backup().code, 'backup_verified', 'no-argument run uses the property'); delete g.props.BACKUP_VERIFY_RUN_FOLDER_ID;
    eq(g.ctx.admin_verify_private_backup().code, 'verify_target_not_configured', 'no argument and no property'); eq(g.writes, w0, 'verification wrote nothing in any of these runs');
  });

  T('11 changed content in an ordinary tab, source drift and mid-backup mismatch still fail', () => {
    const { W } = good(); W.copyBook('EXAM_DB').find(s => s.name === 'questions').data[1][1] = { v: 99 };
    eq(W.ctx.admin_verify_private_backup(W.runFolderId()).code, 'copy_fingerprint_mismatch', 'changed cell');
    const W2 = makeWorld(mutate); W2.addEmptyTab('EXAM_DB'); W2.books[W2.ids.AUTH_DB].find(s => s.name === 'users').data[1][0] = { v: 'a' };
    eq(W2.backup().ok, true, 'ordinary backup unaffected');
  });

  /* ---- Task 47: strict manifest timestamps ---- */
  T('T47a bkIsIso_ accepts valid and rejects impossible timestamps', () => {
    const W = makeWorld(mutate), I = W.ctx.bkIsIso_;
    ['2026-10-28T06:03:14.000Z', '2024-02-29T00:00:00.000Z', '2000-02-29T23:59:59.999Z', '2400-02-29T12:00:00.001Z', '2023-02-28T23:59:59.999Z', '2026-04-30T10:20:30.123Z', '2026-12-31T23:59:59.999Z',
     '2026-01-01T00:00:00.000Z', '2026-07-31T00:00:00.000Z', '0004-02-29T00:00:00.000Z'].forEach(x => ok(I(x) === true, 'valid: ' + x));
    [['2023-02-29T00:00:00.000Z', 'Feb 29 non-leap'], ['1900-02-29T00:00:00.000Z', 'Feb 29 1900 (century, not leap)'], ['2100-02-29T00:00:00.000Z', 'Feb 29 2100'], ['2026-02-30T00:00:00.000Z', 'Feb 30'],
     ['2024-02-31T00:00:00.000Z', 'Feb 31 leap'], ['2026-04-31T00:00:00.000Z', 'Apr 31'], ['2026-06-31T00:00:00.000Z', 'Jun 31'], ['2026-09-31T00:00:00.000Z', 'Sep 31'], ['2026-11-31T00:00:00.000Z', 'Nov 31'],
     ['2026-00-10T00:00:00.000Z', 'month 0'], ['2026-13-10T00:00:00.000Z', 'month 13'], ['2026-01-00T00:00:00.000Z', 'day 0'], ['2026-01-32T00:00:00.000Z', 'day 32'],
     ['2026-01-01T24:00:00.000Z', 'hour 24'], ['2026-01-01T25:00:00.000Z', 'hour 25'], ['2026-01-01T00:60:00.000Z', 'minute 60'], ['2026-01-01T00:00:60.000Z', 'second 60'], ['2026-01-01T00:00:00.1000Z', 'ms 4 digits'],
     ['2026-01-01T00:00:00Z', 'missing ms'], ['2026-01-01T00:00:00.00Z', 'ms 2 digits'], ['2026-01-01T00:00:00.000', 'missing Z'], ['2026-01-01T00:00:00.000z', 'lowercase z'], ['2026-01-01T00:00:00.000+00:00', 'offset'],
     ['2026-01-01T00:00:00.000+0530', 'offset +0530'], ['2026-01-01T00:00:00.000-05:00', 'offset -05:00'], ['2026-01-01T00:00:00.000Z ', 'trailing space'], ['2026-01-01T00:00:00.000Z\n', 'trailing newline'],
     ['2026-01-01T00:00:00.000Zjunk', 'trailing text'], [' 2026-01-01T00:00:00.000Z', 'leading space'], ['2026-01-01 00:00:00.000Z', 'space instead of T'], ['2026-1-1T0:0:0.000Z', 'unpadded'],
     ['+002026-01-01T00:00:00.000Z', 'extended year'], ['2026-01-01', 'date only'], ['', 'empty'], ['not a date', 'garbage'], ['2026-01-01T00:00:00.000Z2026-01-01T00:00:00.000Z', 'doubled'],
     ['٢٠٢٦-01-01T00:00:00.000Z', 'non-ASCII digits'], [null, 'null'], [undefined, 'undefined'], [20260101, 'number'], [new Date(0), 'Date object'], [{}, 'object'], [['2026-01-01T00:00:00.000Z'], 'array']
    ].forEach(([x, nm]) => ok(I(x) === false, 'rejected: ' + nm));
    /* every accepted value must be exactly the instant written */
    ['2024-02-29T01:02:03.004Z', '2026-10-28T06:03:14.999Z'].forEach(x => ok(new Date(x).toISOString() === x && I(x), 'exact round trip ' + x));
  });

  T('T47b manifest validation: both timestamps, order, complete and incomplete', () => {
    const { W } = good(), P = W.ctx.bkManifestProblem_, m0 = W.getManifest(), rid = m0.run_id, clone = o => JSON.parse(JSON.stringify(o));
    eq(P(clone(m0), rid, true), '', 'valid complete manifest sound');
    const inc = clone(m0); inc.status = 'incomplete'; inc.failure_code = 'copy_failed';
    inc.databases.forEach((d, i) => { d.tabs = []; d.verification = i === 0 ? 'failed' : 'not_attempted'; d.code = i === 0 ? 'copy_failed' : ''; });
    eq(P(clone(inc), rid, false), '', 'valid incomplete manifest sound'); eq(P(clone(inc), rid, true), 'status', 'incomplete refused when complete wanted');
    [[true, 'complete'], [false, 'incomplete']].forEach(([wantComplete, kind]) => {
      const base = wantComplete ? m0 : inc;
      ['started_at', 'finished_at'].forEach(k => {
        ['2023-02-29T00:00:00.000Z', '2026-04-31T00:00:00.000Z', '2026-02-30T00:00:00.000Z', '2026-01-01T00:00:60.000Z', '2026-01-01T00:00:00.000+00:00', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z '].forEach(bad => {
          const m = clone(base); m[k] = bad; if (k === 'started_at') { m.finished_at = '2099-01-01T00:00:00.000Z'; } else { m.started_at = '2000-01-01T00:00:00.000Z'; }
          eq(P(m, rid, wantComplete), 'timestamps', kind + ' ' + k + ' rejected: ' + bad);
        });
      });
      const rev = clone(base); rev.started_at = '2026-10-28T06:03:14.001Z'; rev.finished_at = '2026-10-28T06:03:14.000Z'; eq(P(rev, rid, wantComplete), 'timestamps', kind + ' reversed timestamps rejected');
      const same = clone(base); same.finished_at = same.started_at; eq(P(same, rid, wantComplete), '', kind + ' equal timestamps allowed (unchanged)');
      const leap = clone(base); leap.started_at = '2024-02-29T23:59:59.999Z'; leap.finished_at = '2024-03-01T00:00:00.000Z'; eq(P(leap, rid, wantComplete), '', kind + ' leap day accepted');
    });
  });

  T('T47c stored manifests (complete and incomplete files) with impossible dates fail closed with zero writes', () => {
    ['finished_at', 'started_at'].forEach(k => {
      const { W } = good(); W.setManifest(m => { m[k] = '2023-02-29T00:00:00.000Z'; if (k === 'started_at') { m.finished_at = '2099-01-01T00:00:00.000Z'; } });
      const w0 = W.writes, snap = W.snapshot(), v = W.ctx.admin_verify_private_backup(W.runFolderId());
      eq(v.ok, false, 'complete/' + k + ' not ok'); eq(v.code, 'manifest_invalid', 'complete/' + k + ' rejected'); eq(v.copies_verified, 0, 'nothing verified'); eq(W.writes, w0, 'zero writes'); eq(W.snapshot(), snap, 'state unchanged');
    });
    const mk = () => {
      const { W } = good();
      W.setManifest(m => { m.status = 'incomplete'; m.failure_code = 'copy_failed'; m.databases.forEach((d, i) => { d.tabs = []; d.verification = i === 0 ? 'failed' : 'not_attempted'; d.code = i === 0 ? 'copy_failed' : ''; }); });
      W.manifestNode().name = 'manifest.INCOMPLETE.json'; return W;
    };
    let W = mk(); let v = W.ctx.admin_verify_private_backup(W.runFolderId()); eq(v.status, 'incomplete', 'valid incomplete manifest still reports incomplete'); eq(v.ok, false, 'incomplete never ok');
    W = mk(); W.setManifest(m => { m.finished_at = '2026-04-31T00:00:00.000Z'; m.started_at = '2000-01-01T00:00:00.000Z'; });
    const w1 = W.writes; v = W.ctx.admin_verify_private_backup(W.runFolderId()); eq(v.code, 'manifest_invalid', 'incomplete file with impossible finished_at rejected'); eq(W.writes, w1, 'zero writes');
    W = mk(); W.setManifest(m => { m.finished_at = '2000-01-01T00:00:00.000Z'; }); eq(W.ctx.admin_verify_private_backup(W.runFolderId()).code, 'manifest_invalid', 'incomplete file with reversed timestamps rejected');
    ({ W } = good()); W.setManifest(m => { m.finished_at = '2000-01-01T00:00:00.000Z'; }); eq(W.ctx.admin_verify_private_backup(W.runFolderId()).code, 'manifest_invalid', 'complete file with reversed timestamps rejected');
    ({ W } = good()); eq(W.ctx.admin_verify_private_backup(W.runFolderId()).code, 'backup_verified', 'an untouched backup (generated timestamps) still verifies');
  });

  /* ---- Task 48: bounded fingerprint reads for wide tabs ---- */
  T('T48a every range <= 5000 cells, full ordered coverage, digest equals independent reference and original-code goldens', () => {
    const W = makeWorld(mutate), f = W.ctx.bkTabFingerprint_;
    [[1, 1], [3, 4], [2, 4999], [2, 5000], [2, 5001], [3, 5002], [2, 9999], [2, 10000], [2, 10001], [1, 18278], [2, 18278], [2, 20000], [7, 5000], [12001, 1], [13, 2500], [13, 2501], [4, 1666], [4, 1667]].forEach(([rows, cols]) => {
      const log = [], d = f(t48Sheet(t48CellAt, log), 'wide', rows, cols), tag = rows + 'x' + cols;
      eq(d, t48Ref('wide', rows, cols, t48CellAt), 'digest equals independent reference ' + tag);
      ok(log.every(q => q.n * q.k <= 5000), 'every getRange <= 5000 cells ' + tag + ' (max ' + Math.max.apply(null, log.map(q => q.n * q.k)) + ')');
      eq(log.reduce((a, q) => a + q.n * q.k, 0), rows * cols, 'cells read == cells in tab ' + tag);
      const seen = new Set(); let dup = false, outside = false, prev = -1, ordered = true;
      log.forEach(q => { for (let i = 0; i < q.n; i++) { for (let j = 0; j < q.k; j++) { const key = (q.r + i) * 100000 + (q.c + j); if (seen.has(key)) { dup = true; } seen.add(key); if (q.r + i > rows || q.c + j > cols) { outside = true; } } } const pos = (q.r - 1) * cols + q.c; if (pos <= prev) { ordered = false; } prev = pos; });
      ok(!dup && !outside && seen.size === rows * cols, 'every cell read exactly once, none outside ' + tag); ok(ordered, 'ranges read in row-major order ' + tag);
      eq(f(t48Sheet(t48CellAt), 'wide', rows, cols), d, 'stable across repeated reads ' + tag);
    });
    Object.keys(T48_GOLDEN).forEach(k => { const m = /^(\w+):(\d+)x(\d+)$/.exec(k); eq(f(t48Sheet(t48CellAt), m[1], +m[2], +m[3]), T48_GOLDEN[k], 'byte-identical to original-code digest ' + k); });
    eq(f({ getRange() { throw new Error('read'); } }, 'e', 0, 0), t48Ref('e', 0, 0, t48CellAt), 'empty tab (0,0) unchanged and reads nothing');
  });

  T('T48b a changed cell, including near the final column or across a segment boundary, changes the digest', () => {
    const W = makeWorld(mutate), f = W.ctx.bkTabFingerprint_;
    [[2, 5001], [2, 10001], [2, 18278], [2, 20000]].forEach(([rows, cols]) => {
      const base = f(t48Sheet(t48CellAt), 'w', rows, cols), tag = rows + 'x' + cols;
      [[1, cols], [rows, cols], [1, cols - 1], [1, 5000], [1, 5001], [2, 5001], [1, 1]].forEach(([r, c]) => {
        const alt = (rr, cc) => (rr === r && cc === c ? { v: 'CHANGED', f: '' } : t48CellAt(rr, cc));
        ok(f(t48Sheet(alt), 'w', rows, cols) !== base, 'change at (' + r + ',' + c + ') detected ' + tag);
      });
      const fm = (rr, cc) => (rr === 1 && cc === cols ? { v: 0, f: '=1' } : t48CellAt(rr, cc));
      ok(f(t48Sheet(fm), 'w', rows, cols) !== base, 'formula in the last column detected ' + tag);
      const sw = (rr, cc) => (rr === 1 && cc === 5000 ? t48CellAt(1, 5001) : rr === 1 && cc === 5001 ? t48CellAt(1, 5000) : t48CellAt(rr, cc));
      if (t48Tok(t48CellAt(1, 5000)) !== t48Tok(t48CellAt(1, 5001))) { ok(f(t48Sheet(sw), 'w', rows, cols) !== base, 'swapping columns 5000/5001 detected ' + tag); }
    });
  });

  T('T48c 5001- and 18278-column tabs: new backup creates and verifies, ranges bounded, zero writes, scheme unchanged', () => {
    const W = makeWorld(mutate), wideRows = cols => [0, 1].map(r => Array.from({ length: cols }, (_, c) => t48CellAt(r + 1, c + 1))), SheetCtor = W.books[W.ids.EXAM_DB][0].constructor;
    W.books[W.ids.EXAM_DB].push(new SheetCtor(null, 'wide5001', wideRows(5001)));
    W.books[W.ids.KEYS_DB].push(new SheetCtor(null, 'wide18278', wideRows(18278)));
    W.addEmptyTab('AUTH_DB', 'scratch');
    W.ranges = []; const r = W.backup(); eq(r.ok, true, 'backup ok'); eq(r.code, 'backup_complete', 'complete');
    ok(W.ranges.length > 0 && W.ranges.every(q => q.n * q.k <= 5000), 'all backup-time ranges <= 5000 cells (max ' + Math.max.apply(null, W.ranges.map(q => q.n * q.k)) + ')');
    const m = W.getManifest(); eq(m.manifest_version, 2, 'manifest version stays 2'); eq(m.fingerprint_scheme, 'gps-tab-sha256-v1', 'scheme stays gps-tab-sha256-v1');
    const t = tabRec(m, 'EXAM_DB', 'wide5001'); eq(t && t.last_column, 5001, '5001 columns recorded'); eq(tabRec(m, 'KEYS_DB', 'wide18278').last_column, 18278, '18278 columns recorded');
    eq(t.sha256, t48Ref('wide5001', 2, 5001, t48CellAt), 'recorded digest equals independent reference (historic version-2 algorithm)');
    eq(tabRec(m, 'KEYS_DB', 'wide18278').sha256, t48Ref('wide18278', 2, 18278, t48CellAt), '18278-column digest equals independent reference');
    eq(tabRec(m, 'AUTH_DB', 'scratch').sha256, expectedEmptyDigest('scratch'), 'empty tab still recorded');
    m.databases.forEach(d => d.tabs.forEach(x => { const sh = W.copyBook(d.type).find(s => s.name === x.tab); eq(x.sha256, t48Ref(x.tab, x.last_row, x.last_column, (rr, cc) => (sh.data[rr - 1] || [])[cc - 1] || { v: '', f: '' }), 'reference digest of ' + d.type + '/' + x.tab); }));
    const w0 = W.writes, snap = W.snapshot(); W.ranges = [];
    const v = W.ctx.admin_verify_private_backup(W.runFolderId());
    eq(v.ok, true, 'verified'); eq(v.status, 'verified', 'status'); eq(v.copies_verified, 3, '3 copies content-verified');
    ok(W.ranges.length > 0 && W.ranges.every(q => q.n * q.k <= 5000), 'all verification-time ranges <= 5000 cells'); eq(W.writes, w0, 'zero writes'); eq(W.snapshot(), snap, 'state unchanged by verification');
    W.copyBook('EXAM_DB').find(s => s.name === 'wide5001').data[1][5000] = { v: 'tampered' };
    const v2 = W.ctx.admin_verify_private_backup(W.runFolderId()); eq(v2.ok, false, 'change in the last column fails'); eq(v2.code, 'copy_fingerprint_mismatch', 'caught by fingerprint (dimensions unchanged)');
    const W2 = makeWorld(mutate); W2.books[W2.ids.KEYS_DB].push(new SheetCtor(null, 'wide18278', wideRows(18278))); W2.backup();
    W2.copyBook('KEYS_DB').find(s => s.name === 'wide18278').data[0][18277] = { v: 'tampered' };
    eq(W2.ctx.admin_verify_private_backup(W2.runFolderId()).code, 'copy_fingerprint_mismatch', 'change in column 18278 fails');
  });

  T('T48d version/scheme combinations, version-1 and malformed fingerprints', () => {
    const cases = [
      ['version 3 not supported', m => { m.manifest_version = 3; }], ['version 2 with another scheme', m => { m.fingerprint_scheme = 'gps-tab-sha256-v2'; }],
      ['version 2 without a scheme', m => { delete m.fingerprint_scheme; }], ['version 2 with empty scheme', m => { m.fingerprint_scheme = ''; }],
      ['version 1 carrying a scheme', m => { m.manifest_version = 1; m.databases.forEach(d => d.tabs.forEach(t => { delete t.sha256; })); }],
      ['version 1 carrying digests', m => { m.manifest_version = 1; delete m.fingerprint_scheme; }],
      ['version as string', m => { m.manifest_version = '2'; }], ['version 0', m => { m.manifest_version = 0; }],
      ['missing digest', m => { delete m.databases[0].tabs[0].sha256; }], ['malformed digest', m => { m.databases[2].tabs[1].sha256 = 'zz'; }]];
    cases.forEach(([nm, fn]) => { const { W } = good(); W.setManifest(fn); const v = W.ctx.admin_verify_private_backup(W.runFolderId()); eq(v.ok, false, nm + ': not ok'); eq(v.code, 'manifest_invalid', nm + ': rejected'); eq(v.copies_verified, 0, nm + ': nothing verified'); });
    const { W } = good(); W.setManifest(m => { m.manifest_version = 1; delete m.fingerprint_scheme; m.databases.forEach(d => d.tabs.forEach(t => { delete t.sha256; })); m.databases[1].tabs = m.databases[1].tabs.filter(t => t.tab !== 'scratch'); });
    W.copyBook('EXAM_DB').splice(W.copyBook('EXAM_DB').findIndex(s => s.name === 'scratch'), 1);
    const v = W.ctx.admin_verify_private_backup(W.runFolderId()); eq(v.ok, false, 'version-1 never ok'); eq(v.status, 'legacy', 'version-1 legacy'); eq(v.code, 'backup_integrity_not_recorded', 'code'); eq(v.copies_verified, 0, 'no content-verified copies');
  });

  return { fails, total };
}

/* ---------------- run ---------------- */
const base = suite(null);
console.log('Part 1: ' + (base.total - base.fails.length) + '/' + base.total + ' checks passed against the real source');
base.fails.forEach(f => console.log('  FAIL ' + f));

const MUTATIONS = [
  ['Task 48: wide rows read in one unbounded range', s => s.replace('var segW = Math.min(cols, BK_FP_CHUNK_CELLS)', 'var segW = cols')],
  ['Task 48: segment one cell too wide', s => s.replace('var segW = Math.min(cols, BK_FP_CHUNK_CELLS)', 'var segW = Math.min(cols, BK_FP_CHUNK_CELLS + 1)')],
  ['Task 48: last segment skipped', s => s.replace('for (var c = 1; c <= cols; c += segW)', 'for (var c = 1; c < cols; c += segW)')],
  ['Task 48: every segment re-reads column 1', s => s.replace('sh.getRange(r, c, n, w)', 'sh.getRange(r, 1, n, w)')],
  ['Task 48: tail segment read at full width', s => s.replace('var w = Math.min(segW, cols - c + 1)', 'var w = segW')],
  ['Task 48: chunk size constant changed (digests would change)', s => s.replace('var BK_FP_CHUNK_CELLS = 5000;', 'var BK_FP_CHUNK_CELLS = 4000;')],
  ['Task 48: wide-row tokens joined without separator', s => s.replace("text += toks[k].join(',') + '\\n';", "text += toks[k].join('') + '\\n';")],
  ['Task 47: bkIsIso_ back to Date.parse only', s => s.replace(/function bkIsIso_\(s\) \{[\s\S]*?\n\}\n/, "function bkIsIso_(s) { return typeof s === 'string' && /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/.test(s) && !isNaN(Date.parse(s)); }\n")],
  ['Task 47: leap-year rule ignores century exception (round trip off)', s => s.replace(' && t.toISOString() === s', '').replace("(y % 4 === 0 && y % 100 !== 0) || y % 400 === 0", 'y % 4 === 0')],
  ['Task 47: every February has 29 days (round trip off)', s => s.replace(' && t.toISOString() === s', '').replace('leap ? 29 : 28', '29')],
  ['Task 47: day limit ignores month length (round trip off)', s => s.replace(' && t.toISOString() === s', '').replace('d > dim[mo - 1]', 'd > 31')],
  ['Task 47: hour 24 allowed (round trip off)', s => s.replace(' && t.toISOString() === s', '').replace('h > 23', 'h > 24')],
  ['Task 47: second 60 allowed (round trip off)', s => s.replace(' && t.toISOString() === s', '').replace('sec > 59', 'sec > 60')],
  ['Task 47: minute 60 allowed (round trip off)', s => s.replace(' && t.toISOString() === s', '').replace('mi > 59', 'mi > 60')],
  ['Task 47: finished_at not strictly validated', s => s.replace('!bkIsIso_(m.finished_at) || ', '')],
  ['Task 47: started_at not strictly validated', s => s.replace('!bkIsIso_(m.started_at) || ', '')],
  ['Task 47: reversed-timestamp check removed', s => s.replace(' || Date.parse(m.finished_at) < Date.parse(m.started_at)', '')],
  ['mixed zero/nonzero dimension allowed', s => s.replace("if ((rows === 0) !== (cols === 0)) { return 'mixed_zero'; }", '')],
  ['empty schema tab allowed', s => s.replace("if (rows === 0 && mustHaveContent) { return 'empty'; }", '')],
  ['negative dimensions allowed', s => s.replace("rows < 0 || cols < 0 || Object.is(rows, -0) || Object.is(cols, -0)", 'false')],
  ['unsafe/fractional integers allowed', s => s.replace("!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols)", 'false')],
  ['string dimensions coerced', s => s.replace("typeof rows !== 'number' || typeof cols !== 'number' || ", '').replace("!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols)", 'isNaN(rows) || isNaN(cols)')],
  ['negative zero allowed', s => s.replace("|| Object.is(rows, -0) || Object.is(cols, -0)", '')],
  ['version-1 manifest may record an empty tab', s => s.replace(" || m.manifest_version !== 2))", '))')],
  ['schema tab treated as non-schema', s => s.replace("Object.prototype.hasOwnProperty.call(BACKUP_DB_SCHEMAS[db], x.tab) || m.manifest_version !== 2", 'm.manifest_version !== 2')],
  ['stored fingerprint comparison disabled', s => s.replace("if (fp[x.tab] !== x.sha256) { throw bkErr_('copy_fingerprint_mismatch'); }", '')],
  ['stored dimension comparison disabled', s => s.replace("if (dims[x.tab].last_row !== x.last_row || dims[x.tab].last_column !== x.last_column) { throw bkErr_('copy_dimensions_mismatch'); }", '')],
  ['dimension AND fingerprint comparison disabled', s => s.replace("if (fp[x.tab] !== x.sha256) { throw bkErr_('copy_fingerprint_mismatch'); }", '').replace("{ throw bkErr_('copy_dimensions_mismatch'); }", '{ }')],
  ['empty-tab digest ignores name and size', s => s.replace("'\\ntab:' + name.length + ':' + name + '\\nrows:' + rows + '\\ncols:' + cols", "''")],
  ['empty-tab digest ignores the name only', s => s.replace("'\\ntab:' + name.length + ':' + name + '\\nrows:'", "'\\nrows:'")],
  ['invalid dimensions fingerprinted', s => s.replace("if (bad) { throw bkErr_('copy_fingerprint_failed'); }", '')],
  ['version-1 reported as content-verified', s => s.replace("if (!legacy) { ctx.verified++; }", 'ctx.verified++;')],
  ['version-1 content check enabled/ok', s => s.replace("return bkVerifyResult_('legacy', 'backup_integrity_not_recorded', ctx);", "return bkVerifyResult_('verified', 'backup_verified', ctx);")],
  ['missing-fingerprint check removed', s => s.replace("if (m.manifest_version === 2 && (typeof x.sha256 !== 'string' || !BK_SHA_RE.test(x.sha256))) { return 'fingerprint'; }", '')],
  ['owner check removed from verification', s => s.replace(/(function bkVerifyRun_[\s\S]*?)bkRequireOwner_\(ownerEmail\);/, '$1')],
  ['copy privacy check removed from verification', s => s.replace("if (bkSharingProblem_(file, ownerEmail)) { throw bkErr_('copy_not_private'); }\n  } catch (e) {\n    if (e && e.bkCode) { throw e; }\n    throw bkErr_(bkAuthError_(e) ? 'drive_scope_not_authorized' : 'copy_unverifiable');", "} catch (e) {\n    if (e && e.bkCode) { throw e; }\n    throw bkErr_(bkAuthError_(e) ? 'drive_scope_not_authorized' : 'copy_unverifiable');")]
];
let undetected = 0;
console.log('Part 2: mutation controls (each broken variant must make at least one check fail)');
MUTATIONS.forEach(([name, fn]) => {
  let res;
  try { res = suite(fn); } catch (e) { console.log('  ERROR  ' + name + ': ' + e.message); undetected++; return; }
  if (res.fails.length) { console.log('  detected   ' + name + ' (' + res.fails.length + ' failing check(s))'); } else { console.log('  UNDETECTED ' + name); undetected++; }
});
const bad = base.fails.length + undetected;
console.log(bad ? '\nRESULT: FAILED' : '\nRESULT: all ' + base.total + ' checks passed; all ' + MUTATIONS.length + ' mutations detected (mocked only; not real Apps Script/Drive/Sheets).');
process.exit(bad ? 1 : 0);
