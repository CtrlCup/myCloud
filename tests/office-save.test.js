// node --test tests/office-save.test.js  (kein Stack noetig)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const crypto = require('crypto');
const { buildDocumentKey, saveDownloadedFile } = require('../app/office-save');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'office-save-')); }
const okGet = (body) => async () => ({ statusCode: 200, stream: Readable.from([Buffer.from(body)]) });

test('buildDocumentKey: stabil, versionsabhaengig, erlaubte Zeichen, <=128', () => {
  const a = buildDocumentKey(7, 'a'.repeat(64));
  assert.strictEqual(a, buildDocumentKey(7, 'a'.repeat(64)));
  assert.notStrictEqual(a, buildDocumentKey(7, 'b'.repeat(64)));
  assert.match(a, /^file_7_[a-zA-Z0-9]+$/);
  assert.ok(a.length <= 128);
  assert.match(buildDocumentKey(7, null), /^file_7_v0$/);
  assert.match(buildDocumentKey(7, '../x y!'), /^[a-zA-Z0-9_\-=.]+$/);
});

test('Erfolg: Datei ersetzt, Hash/Groesse korrekt, keine Temp-Datei', async () => {
  const dir = tmpDir();
  const target = path.join(dir, 'doc');
  fs.writeFileSync(target, 'old');
  const r = await saveDownloadedFile('http://x/y', target, okGet('new content'));
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'new content');
  assert.strictEqual(r.size, 11);
  assert.strictEqual(r.hash, require('crypto').createHash('sha256').update('new content').digest('hex'));
  assert.deepStrictEqual(fs.readdirSync(dir), ['doc']);
});

test('Abgebrochener Download: alte Datei bleibt, Temp-Datei geloescht', async () => {
  const dir = tmpDir();
  const target = path.join(dir, 'doc');
  fs.writeFileSync(target, 'old');
  const stream = new Readable({ read() {} });
  stream.push('partial');
  setImmediate(() => stream.destroy(new Error('connection reset')));
  await assert.rejects(saveDownloadedFile('http://x/y', target, async () => ({ statusCode: 200, stream })));
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'old');
  assert.deepStrictEqual(fs.readdirSync(dir), ['doc']);
});

test('HTTP-Status != 200 und Verbindungsfehler: alte Datei bleibt', async () => {
  const dir = tmpDir();
  const target = path.join(dir, 'doc');
  fs.writeFileSync(target, 'old');
  await assert.rejects(saveDownloadedFile('http://x/y', target, async () => ({ statusCode: 500, stream: Readable.from([]) })));
  await assert.rejects(saveDownloadedFile('http://x/y', target, async () => { throw new Error('ECONNREFUSED'); }));
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'old');
  assert.deepStrictEqual(fs.readdirSync(dir), ['doc']);
});

/* ---- Copy-on-Write-Variante (aktive Verschlüsselung) ---- */
const cryptoStore = require('../app/crypto-store');
const { saveDownloadedFileCow } = require('../app/office-save');

function cowFixture() {
  const dir = tmpDir();
  const oldPath = path.join(dir, 'old');
  const newPath = path.join(dir, 'new');
  fs.writeFileSync(oldPath, 'old');
  const row = { path: 'old' }; // simulierte DB-Zeile
  const opts = (extra = {}) => ({
    write: (p, s) => cryptoStore.writeEncrypted(p, s),
    commit: async () => { const o = row.path; row.path = 'new'; return { oldPath: path.join(dir, o) }; },
    discard: (p) => fs.rmSync(p, { force: true }),
    ...extra,
  });
  return { dir, oldPath, newPath, row, opts };
}

test('COW Erfolg: neuer verschlüsselter Blob, Zeile umgehängt, alter Blob gelöscht', async () => {
  cryptoStore.useKeys(crypto.randomBytes(32));
  try {
    const f = cowFixture();
    const r = await saveDownloadedFileCow('http://x/y', f.newPath, { ...f.opts(), get: okGet('neuer Inhalt') });
    assert.strictEqual(r.size, 12);
    assert.strictEqual(r.hash, crypto.createHash('sha256').update('neuer Inhalt').digest('hex'));
    assert.strictEqual(f.row.path, 'new');
    assert.ok(!fs.existsSync(f.oldPath));
    assert.strictEqual(fs.readFileSync(f.newPath).subarray(0, 6).toString(), 'MCENC1');
    assert.strictEqual((await cryptoStore.readDecrypted(f.newPath, { encrypted: true })).toString(), 'neuer Inhalt');
    assert.deepStrictEqual(fs.readdirSync(f.dir).sort(), ['new']);
  } finally { cryptoStore.useKeys(null); }
});

test('COW Abbruch/Status/Verbindungsfehler: alter Blob und Zeile bleiben, nichts Neues liegt herum', async () => {
  cryptoStore.useKeys(crypto.randomBytes(32));
  try {
    const f = cowFixture();
    const stream = new Readable({ read() {} });
    stream.push('partial');
    setImmediate(() => stream.destroy(new Error('connection reset')));
    await assert.rejects(saveDownloadedFileCow('http://x/y', f.newPath, { ...f.opts(), get: async () => ({ statusCode: 200, stream }) }));
    await assert.rejects(saveDownloadedFileCow('http://x/y', f.newPath, { ...f.opts(), get: async () => ({ statusCode: 500, stream: Readable.from([]) }) }));
    await assert.rejects(saveDownloadedFileCow('http://x/y', f.newPath, { ...f.opts(), get: async () => { throw new Error('ECONNREFUSED'); } }));
    assert.strictEqual(f.row.path, 'old');
    assert.strictEqual(fs.readFileSync(f.oldPath, 'utf8'), 'old');
    assert.deepStrictEqual(fs.readdirSync(f.dir), ['old']);
  } finally { cryptoStore.useKeys(null); }
});

test('COW Commit-Fehler (DB): neuer Blob wird gelöscht, alter bleibt', async () => {
  cryptoStore.useKeys(crypto.randomBytes(32));
  try {
    const f = cowFixture();
    await assert.rejects(saveDownloadedFileCow('http://x/y', f.newPath, { ...f.opts({ commit: async () => { throw new Error('db down'); } }), get: okGet('x') }), /db down/);
    assert.strictEqual(f.row.path, 'old');
    assert.deepStrictEqual(fs.readdirSync(f.dir), ['old']);
  } finally { cryptoStore.useKeys(null); }
});
