// node --test tests/office-save.test.js  (kein Stack noetig)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
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
