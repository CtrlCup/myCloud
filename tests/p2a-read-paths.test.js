// node --test tests/p2a-read-paths.test.js
// Teil 1 (Stack, TEST_BASE): Range/HEAD/Download/ZIP/Freigabe über die HTTP-API. Läuft gegen den normalen und
// gegen den verschlüsselten Test-Stack (run-all-enc.sh); Uploads sind bis P2b noch Klartext.
// Teil 2 (ohne Stack): sendFileDecrypted direkt mit per crypto-store verschlüsselten Dateien über einen
// lokalen http-Server (Range über Segmentgrenzen, 416, HEAD, ETag, korrupte Datei, files.size-Mismatch).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { BASE } = require('./_env');
const cryptoStore = require('../app/crypto-store');
const { sendFileDecrypted, makeSemaphore, parseRange } = require('../app/file-delivery');

/* ====================== Teil 1: Stack ====================== */

const user = 'p2a' + Date.now();
const password = 'Test-Passwort-12345!';
let cookie = '';
const api = (p, opts = {}) => fetch(BASE + p, { ...opts, headers: { cookie, ...(opts.headers || {}) } });
const json = (method, p, body) => api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const DATA = crypto.randomBytes(300000); // mehrere 64-KiB-Segmente
let fileId, folderId, slug;

async function upload(name, buf, parentId) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/octet-stream' }), name);
  if (parentId) fd.append('parentId', String(parentId));
  const res = await api('/api/files/upload', { method: 'POST', body: fd });
  assert.ok([200, 201].includes(res.status), 'upload ' + res.status);
  const j = await res.json();
  return (j.file || j).id;
}

// Liest alle Einträge (Name -> Inhalt) aus einem ZIP über das Central Directory.
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  assert.ok(eocd >= 0, 'kein ZIP');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), cmtLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    out[name] = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

test('setup: Registrierung, Upload, Ordner, Freigabe', async () => {
  const res = await fetch(BASE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, email: user + '@example.test', password }),
  });
  assert.ok([200, 201].includes(res.status), 'register ' + res.status);
  cookie = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  fileId = await upload('video.mp4', DATA, null);
  const f = await json('POST', '/api/files/folder', { name: 'zipdir', parentId: null });
  folderId = (await f.json()).id;
  await upload('a.txt', Buffer.from('Inhalt A äöü'), folderId);
  await upload('b.bin', DATA.subarray(0, 100000), folderId);
  const sh = await json('POST', '/api/shares', { fileId, canRead: true, canDownload: true });
  assert.ok([200, 201].includes(sh.status), 'share ' + sh.status);
  slug = (await sh.json()).slug;
  assert.ok(slug);
});

test('Download == Original, Accept-Ranges und Content-Length', async () => {
  const res = await api(`/api/files/download/${fileId}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('accept-ranges'), 'bytes');
  assert.strictEqual(res.headers.get('content-length'), String(DATA.length));
  assert.match(res.headers.get('content-disposition'), /^attachment;/);
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(DATA));
});

test('Inline-Download: Content-Disposition inline', async () => {
  const res = await api(`/api/files/download/${fileId}?inline=true`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /^inline; filename="video\.mp4"/);
  assert.match(res.headers.get('content-type'), /^video\/mp4/);
});

test('Range bytes=1000-1999 -> 206, Content-Range, richtige Bytes', async () => {
  const res = await api(`/api/files/download/${fileId}?inline=true`, { headers: { Range: 'bytes=1000-1999' } });
  assert.strictEqual(res.status, 206);
  assert.strictEqual(res.headers.get('content-range'), `bytes 1000-1999/${DATA.length}`);
  assert.strictEqual(res.headers.get('content-length'), '1000');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(DATA.subarray(1000, 2000)));
});

test('Range über Segmentgrenze, Suffix und offenes Ende', async () => {
  let res = await api(`/api/files/download/${fileId}?inline=true`, { headers: { Range: 'bytes=65000-66000' } });
  assert.strictEqual(res.status, 206);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(DATA.subarray(65000, 66001)));
  res = await api(`/api/files/download/${fileId}?inline=true`, { headers: { Range: 'bytes=-500' } });
  assert.strictEqual(res.status, 206);
  assert.strictEqual(res.headers.get('content-range'), `bytes ${DATA.length - 500}-${DATA.length - 1}/${DATA.length}`);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(DATA.subarray(DATA.length - 500)));
  res = await api(`/api/files/download/${fileId}?inline=true`, { headers: { Range: 'bytes=299000-' } });
  assert.strictEqual(res.status, 206);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(DATA.subarray(299000)));
});

test('ungültiger Bereich -> 416 mit Content-Range */Größe', async () => {
  const res = await api(`/api/files/download/${fileId}?inline=true`, { headers: { Range: 'bytes=900000-' } });
  assert.strictEqual(res.status, 416);
  assert.strictEqual(res.headers.get('content-range'), `bytes */${DATA.length}`);
  await res.arrayBuffer();
});

test('HEAD: Header ohne Body', async () => {
  const res = await api(`/api/files/download/${fileId}?inline=true`, { method: 'HEAD' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-length'), String(DATA.length));
  assert.strictEqual(res.headers.get('accept-ranges'), 'bytes');
  assert.strictEqual((await res.arrayBuffer()).byteLength, 0);
});

test('öffentliche Freigabe: Download und Range', async () => {
  let res = await fetch(`${BASE}/api/public/shares/${slug}/download/${fileId}?inline=true`);
  assert.strictEqual(res.status, 200);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(DATA));
  res = await fetch(`${BASE}/api/public/shares/${slug}/download/${fileId}?inline=true`, { headers: { Range: 'bytes=70000-70099' } });
  assert.strictEqual(res.status, 206);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(DATA.subarray(70000, 70100)));
});

test('ZIP-Download eines Ordners enthält den korrekten Klartext', async () => {
  const res = await api(`/api/files/download-zip/${folderId}`);
  assert.strictEqual(res.status, 200);
  const files = unzip(Buffer.from(await res.arrayBuffer()));
  assert.deepStrictEqual(Object.keys(files).sort(), ['a.txt', 'b.bin']);
  assert.strictEqual(files['a.txt'].toString('utf8'), 'Inhalt A äöü');
  assert.ok(files['b.bin'].equals(DATA.subarray(0, 100000)));
});

test('ZIP-Download mehrerer Dateien (download-zip-multiple)', async () => {
  const res = await api(`/api/files/download-zip-multiple?ids=${fileId}`);
  assert.strictEqual(res.status, 200);
  const files = unzip(Buffer.from(await res.arrayBuffer()));
  assert.ok(files['video.mp4'].equals(DATA));
});

/* ====================== Teil 2: sendFileDecrypted ohne Stack ====================== */

const KEY = crypto.randomBytes(32);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2a-'));
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const SEG = 65536, PLAIN = crypto.randomBytes(SEG * 3 + 1234); // 4 Segmente, letztes kurz
let encPath;

// Startet einen http-Server, der für jede Anfrage cfg() ausführt; liefert { status, headers, body, aborted }.
async function request(cfg, { method = 'GET', headers = {} } = {}) {
  const server = http.createServer((req, res) => {
    const { row, opts } = cfg();
    sendFileDecrypted(req, res, row, opts);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method, headers }, (res) => {
        const chunks = [];
        let aborted = false;
        res.on('data', (c) => chunks.push(c));
        res.on('aborted', () => { aborted = true; });
        res.on('error', () => { aborted = true; });
        res.on('close', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), aborted: aborted || !res.complete }));
      });
      req.on('error', () => resolve({ status: 0, headers: {}, body: Buffer.alloc(0), aborted: true }));
      req.end();
    });
  } finally { server.close(); }
}

test('unit: Setup verschlüsselte Datei', async () => {
  cryptoStore.useKeys(KEY);
  encPath = path.join(tmpDir, 'enc.bin');
  await cryptoStore.writeEncrypted(encPath, PLAIN, { segSize: SEG });
  assert.ok(cryptoStore.isEncrypted(encPath));
});

const encCfg = (extraRow = {}, extraOpts = {}) => () => ({
  row: { enc_version: 1, size: PLAIN.length, ...extraRow },
  opts: { filePath: encPath, filename: 'Bär.bin', inline: true, mimeType: 'application/octet-stream', ...extraOpts },
});

test('unit: volle Antwort 200 mit Header', async () => {
  const r = await request(encCfg());
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.equals(PLAIN));
  assert.strictEqual(r.headers['content-length'], String(PLAIN.length));
  assert.strictEqual(r.headers['accept-ranges'], 'bytes');
  assert.strictEqual(r.headers['content-disposition'], 'inline; filename="B%C3%A4r.bin"');
  assert.ok(r.headers.etag);
});

test('unit: Download-Disposition (attachment) mit UTF-8-Name', async () => {
  const r = await request(encCfg({}, { inline: false }));
  assert.match(r.headers['content-disposition'], /^attachment; filename="B\?r\.bin"; filename\*=UTF-8''B%C3%A4r\.bin$/);
});

test('unit: Range über Segmentgrenzen', async () => {
  for (const [s, e] of [[0, 0], [SEG - 10, SEG + 10], [SEG, 2 * SEG - 1], [SEG * 3 - 5, PLAIN.length - 1], [5, PLAIN.length - 1]]) {
    const r = await request(encCfg(), { headers: { Range: `bytes=${s}-${e}` } });
    assert.strictEqual(r.status, 206, `${s}-${e}`);
    assert.strictEqual(r.headers['content-range'], `bytes ${s}-${e}/${PLAIN.length}`);
    assert.ok(r.body.equals(PLAIN.subarray(s, e + 1)), `${s}-${e}`);
  }
});

test('unit: Suffix-Range, offenes Ende, Ende hinter der Datei', async () => {
  let r = await request(encCfg(), { headers: { Range: 'bytes=-500' } });
  assert.strictEqual(r.status, 206);
  assert.ok(r.body.equals(PLAIN.subarray(PLAIN.length - 500)));
  r = await request(encCfg(), { headers: { Range: `bytes=${SEG + 3}-` } });
  assert.ok(r.body.equals(PLAIN.subarray(SEG + 3)));
  r = await request(encCfg(), { headers: { Range: `bytes=${PLAIN.length - 10}-99999999` } });
  assert.strictEqual(r.headers['content-range'], `bytes ${PLAIN.length - 10}-${PLAIN.length - 1}/${PLAIN.length}`);
  r = await request(encCfg(), { headers: { Range: 'bytes=-99999999' } });
  assert.strictEqual(r.status, 206);
  assert.ok(r.body.equals(PLAIN));
});

test('unit: 416 bei nicht erfüllbarem Bereich, Ignorieren bei Unsinn/Mehrfachbereich', async () => {
  let r = await request(encCfg(), { headers: { Range: `bytes=${PLAIN.length}-` } });
  assert.strictEqual(r.status, 416);
  assert.strictEqual(r.headers['content-range'], `bytes */${PLAIN.length}`);
  r = await request(encCfg(), { headers: { Range: 'bytes=-0' } });
  assert.strictEqual(r.status, 416);
  for (const bad of ['bytes=abc', 'bytes=10-5', 'items=0-5', 'bytes=0-5,10-20']) {
    r = await request(encCfg(), { headers: { Range: bad } });
    assert.strictEqual(r.status, 200, bad);
    assert.ok(r.body.equals(PLAIN), bad);
  }
});

test('unit: parseRange', () => {
  assert.deepStrictEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepStrictEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepStrictEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.strictEqual(parseRange('bytes=100-', 100), 'unsatisfiable');
  assert.strictEqual(parseRange('bytes=0-0', 0), 'unsatisfiable');
});

test('unit: HEAD ohne Body, If-None-Match -> 304, If-Range mit fremdem ETag -> volle Antwort', async () => {
  let r = await request(encCfg(), { method: 'HEAD' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-length'], String(PLAIN.length));
  assert.strictEqual(r.body.length, 0);
  const etag = r.headers.etag;
  r = await request(encCfg(), { headers: { 'If-None-Match': etag } });
  assert.strictEqual(r.status, 304);
  assert.strictEqual(r.body.length, 0);
  r = await request(encCfg(), { headers: { Range: 'bytes=0-9', 'If-Range': '"anderer"' } });
  assert.strictEqual(r.status, 200);
  r = await request(encCfg(), { headers: { Range: 'bytes=0-9', 'If-Range': etag } });
  assert.strictEqual(r.status, 206);
});

test('unit: headersFn wird angewendet', async () => {
  const r = await request(encCfg({}, { headersFn: (res) => res.setHeader('Cache-Control', 'private, max-age=60') }));
  assert.strictEqual(r.headers['cache-control'], 'private, max-age=60');
});

test('unit: files.size passt nicht zur Header-plainSize -> 500 mit deutscher Meldung', async () => {
  const r = await request(encCfg({ size: PLAIN.length + 1 }));
  assert.strictEqual(r.status, 500);
  assert.match(JSON.parse(r.body.toString()).error, /Dateigröße passt nicht/);
});

test('unit: fehlende Datei -> 404, falscher Key -> 500', async () => {
  let r = await request(() => ({ row: { enc_version: 1, size: 1 }, opts: { filePath: path.join(tmpDir, 'nix') } }));
  assert.strictEqual(r.status, 404);
  const other = crypto.randomBytes(32);
  cryptoStore.useKeys(other);
  r = await request(encCfg());
  assert.strictEqual(r.status, 500);
  cryptoStore.useKeys(KEY);
});

test('unit: korrupte Datei mitten im Stream -> Verbindung abgebrochen, kein sauberes Ende', async () => {
  const p = path.join(tmpDir, 'corrupt.bin');
  fs.copyFileSync(encPath, p);
  const fd = fs.openSync(p, 'r+');
  const off = cryptoStore.HEADER_SIZE + 2 * (SEG + 16) + 7; // Segment 2 (von 0..3)
  const b = Buffer.alloc(1);
  fs.readSync(fd, b, 0, 1, off); b[0] ^= 0xff; fs.writeSync(fd, b, 0, 1, off);
  fs.closeSync(fd);
  const r = await request(() => ({ row: { enc_version: 1, size: PLAIN.length }, opts: { filePath: p, filename: 'c.bin', inline: true } }));
  assert.strictEqual(r.aborted, true, 'Antwort darf nicht vollständig abgeschlossen werden');
  assert.ok(r.body.length < PLAIN.length);
  assert.ok(!r.body.equals(PLAIN));
  // Range, die nur intakte Segmente trifft, funktioniert weiterhin
  const ok = await request(() => ({ row: { enc_version: 1, size: PLAIN.length }, opts: { filePath: p, filename: 'c.bin', inline: true } }), { headers: { Range: 'bytes=0-99' } });
  assert.strictEqual(ok.status, 206);
  assert.ok(ok.body.equals(PLAIN.subarray(0, 100)));
});

test('unit: korruptes erstes Segment -> 500 statt Teilinhalt', async () => {
  const p = path.join(tmpDir, 'corrupt0.bin');
  fs.copyFileSync(encPath, p);
  const fd = fs.openSync(p, 'r+');
  const off = cryptoStore.HEADER_SIZE + 3;
  const b = Buffer.alloc(1);
  fs.readSync(fd, b, 0, 1, off); b[0] ^= 0xff; fs.writeSync(fd, b, 0, 1, off);
  fs.closeSync(fd);
  const r = await request(() => ({ row: { enc_version: 1, size: PLAIN.length }, opts: { filePath: p } }));
  assert.strictEqual(r.status, 500);
});

test('unit: leere verschlüsselte Datei', async () => {
  const p = path.join(tmpDir, 'empty.bin');
  await cryptoStore.writeEncrypted(p, Buffer.alloc(0));
  const r = await request(() => ({ row: { enc_version: 1, size: 0 }, opts: { filePath: p } }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.length, 0);
});

test('unit: Klartext (enc_version NULL) läuft unverändert über res.sendFile (Range)', async () => {
  const express = require('../app/node_modules/express');
  const p = path.join(tmpDir, 'plain.bin');
  fs.writeFileSync(p, PLAIN);
  const app = express();
  app.get('/f', (req, res) => sendFileDecrypted(req, res, { enc_version: null, size: PLAIN.length }, { filePath: p, filename: 'plain.bin', inline: true, mimeType: 'application/octet-stream' }));
  app.get('/d', (req, res) => sendFileDecrypted(req, res, { enc_version: null, size: PLAIN.length }, { filePath: p, filename: 'plain.bin' }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    let res = await fetch(base + '/f', { headers: { Range: 'bytes=10-19' } });
    assert.strictEqual(res.status, 206);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(PLAIN.subarray(10, 20)));
    res = await fetch(base + '/d');
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="plain\.bin"/);
    await res.arrayBuffer();
  } finally { server.close(); }
});

test('unit: Semaphor begrenzt Parallelität', async () => {
  const sem = makeSemaphore(2);
  let active = 0, max = 0;
  await Promise.all(Array.from({ length: 6 }, () => sem.run(async () => {
    active++; max = Math.max(max, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
  })));
  assert.strictEqual(max, 2);
});
