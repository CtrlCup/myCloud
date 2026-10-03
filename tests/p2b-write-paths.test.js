// node --test tests/p2b-write-paths.test.js
// Phase P2b (Schreibpfade) gegen den Test-Stack (TEST_BASE). Läuft im normalen Stack (E16: ohne Key wie bisher,
// Klartext, enc_version NULL) und im verschlüsselten Stack (run-all-enc.sh setzt TEST_ENCRYPTED=1): E7 bis E13,
// Copy-on-Write, Thumbnails, Avatar, Auto-Wandern von Klartext-Altbestand.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync, execSync } = require('node:child_process');
const { BASE, COMPOSE_ARGS, COMPOSE_CMD, ROOT } = require('./_env');

const UP = '/usr/src/app/uploads';
const TMP = '/run/mycloud-tmp';
const ENC = process.env.TEST_ENCRYPTED === '1';
const MARKER = 'MYCLOUD-P2B-PLAINTEXT-MARKER';

// Container- und DB-Zugriff (nur der Test-Stack: -p/-f kommen aus _env.js)
const sh = (cmd, input) => execFileSync('docker', [...COMPOSE_ARGS, 'exec', '-T', 'app', 'sh', '-c', cmd], { cwd: ROOT, input }).toString();
const shOk = (cmd) => { try { execFileSync('docker', [...COMPOSE_ARGS, 'exec', '-T', 'app', 'sh', '-c', cmd], { cwd: ROOT, stdio: 'pipe' }); return true; } catch { return false; } };
const psql = (sql) => execSync(`${COMPOSE_CMD} exec -T db psql -U mycloud -d mycloud -At`, { input: sql, cwd: ROOT }).toString().trim();
const blobHead = (rel) => sh(`head -c 6 "${UP}/${rel}"`);
const blobExists = (rel) => shOk(`test -e "${UP}/${rel}"`);
// true, wenn irgendeine Datei unter den Verzeichnissen die Zeichenfolge enthält
const containsOnDisk = (needle, dirs) => shOk(`grep -rlF -- "${needle}" ${dirs.join(' ')} | grep -q .`);

// Hintergrundjobs (OCR/Textindex nach dem Upload) belegen das Temp-Verzeichnis kurzzeitig: bis zu 20 s auf "leer" warten.
async function assertTmpEmpty(msg = 'Temp-Verzeichnis nicht leer') {
  let n;
  for (let i = 0; i < 40; i++) {
    n = sh(`ls -A ${TMP} | wc -l`).trim();
    if (n === '0') return;
    await new Promise(r => setTimeout(r, 500));
  }
  assert.strictEqual(n, '0', msg);
}

const user = 'p2b' + Date.now();
const password = 'Test-Passwort-12345!';
let cookie = '', userId;
const api = (p, opts = {}) => fetch(BASE + p, { ...opts, headers: { cookie, ...(opts.headers || {}) } });
const json = (method, p, body) => api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const getRow = async (id) => (await (await api(`/api/files/${id}`)).json());

async function upload(name, buf, extra = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/octet-stream' }), name);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) fd.append(k, String(v));
  const res = await api('/api/files/upload', { method: 'POST', body: fd });
  assert.ok([200, 201].includes(res.status), 'upload ' + res.status);
  return res.json();
}
const download = async (id, headers) => api(`/api/files/download/${id}?inline=true`, { headers });
const bytes = async (res) => Buffer.from(await res.arrayBuffer());

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

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const marked = (bytesLen) => Buffer.from((MARKER + '\n').repeat(Math.ceil(bytesLen / (MARKER.length + 1))).slice(0, bytesLen));

test('setup: Registrierung, Modus', async () => {
  const res = await fetch(BASE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, email: user + '@example.test', password }),
  });
  assert.ok([200, 201].includes(res.status), 'register ' + res.status);
  cookie = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  const me = await api('/api/settings');
  const j = await me.json();
  userId = (j.user || j).id;
  assert.ok(userId);
  // Konsistenz: TEST_ENCRYPTED muss zum Stack passen
  assert.strictEqual(shOk('test -n "$MYCLOUD_MASTER_KEY_FILE"'), ENC, 'TEST_ENCRYPTED passt nicht zum Stack');
  console.log(ENC ? '# Modus: verschlüsselter Stack' : '# Modus: Klartext-Stack (E16)');
});

/* ---------------- E7 / E16: Upload ---------------- */

let textId, textRow;
test('E7: Upload -> Download byteidentisch; Blob verschlüsselt (Enc-Stack) bzw. Klartext (E16)', async () => {
  const data = marked(150000);
  const j = await upload('e7.txt', data);
  textId = j.id; textRow = j;
  assert.strictEqual(Number(j.size), data.length, 'files.size = Klartextgröße');
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  if (ENC) assert.strictEqual(j.content_hash, sha);
  else if (j.content_hash) assert.strictEqual(j.content_hash, sha); // ohne Key darf er fehlen, ist er gesetzt, muss er stimmen
  assert.ok((await bytes(await download(textId))).equals(data));
  if (ENC) {
    assert.strictEqual(j.enc_version, 1);
    assert.strictEqual(blobHead(j.path), 'MCENC1');
    assert.ok(!containsOnDisk(MARKER, [UP + '/' + j.path]), 'Klartext auf der Platte');
  } else {
    assert.ok(j.enc_version === null || j.enc_version === undefined);
    assert.notStrictEqual(blobHead(j.path), 'MCENC1');
    assert.ok(containsOnDisk(MARKER, [UP + '/' + j.path]), 'ohne Key muss der Blob Klartext sein');
  }
  // Textindex läuft über die richtigen Pfade (Suche im Inhalt)
  await new Promise(r => setTimeout(r, 1500));
  const s = await api(`/api/files/search?q=${MARKER}&deep=true`);
  if (s.status === 200) {
    const sj = await s.json();
    const list = Array.isArray(sj) ? sj : (sj.files || sj.results || []);
    assert.ok(list.some(f => f.id === textId), 'Tiefensuche findet die Datei');
  }
});

test('Upload: Duplikat -> 409, Ersetzen und beide behalten', async () => {
  const a = Buffer.from('erste Fassung ' + MARKER);
  const first = await upload('dup.txt', a);
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('zweite Fassung')]), 'dup.txt');
  let res = await api('/api/files/upload', { method: 'POST', body: fd });
  assert.strictEqual(res.status, 409);
  await res.json();
  const b = Buffer.from('zweite Fassung länger ' + MARKER);
  const rep = await upload('dup.txt', b, { onConflict: 'replace' });
  assert.strictEqual(rep.id, first.id);
  assert.strictEqual(Number(rep.size), b.length);
  assert.notStrictEqual(rep.path, first.path, 'Ersetzen schreibt einen neuen Blob');
  assert.ok(!blobExists(first.path), 'alter Blob gelöscht');
  assert.ok((await bytes(await download(first.id))).equals(b));
  if (ENC) { assert.strictEqual(rep.enc_version, 1); assert.strictEqual(blobHead(rep.path), 'MCENC1'); }
  const both = await upload('dup.txt', a, { onConflict: 'keep_both' });
  assert.notStrictEqual(both.id, first.id);
  assert.ok((await bytes(await download(both.id))).equals(a));
});

test('create-empty: Office-Vorlage und leere Textdatei', async () => {
  const tpl = fs.readFileSync(path.join(ROOT, 'app/templates/new.docx'));
  let res = await json('POST', '/api/files/create-empty', { name: 'vorlage', type: 'docx', parentId: null });
  assert.strictEqual(res.status, 201);
  const d = await res.json();
  assert.strictEqual(Number(d.size), tpl.length);
  assert.ok((await bytes(await download(d.id))).equals(tpl));
  res = await json('POST', '/api/files/create-empty', { name: 'leer.txt', type: 'txt', parentId: null });
  const t = await res.json();
  assert.strictEqual(Number(t.size), 0);
  assert.strictEqual((await bytes(await download(t.id))).length, 0);
  if (ENC) {
    assert.strictEqual(d.enc_version, 1); assert.strictEqual(t.enc_version, 1);
    assert.strictEqual(blobHead(d.path), 'MCENC1');
  }
});

test('create-note: Text und Anhang', async () => {
  const fd = new FormData();
  fd.append('name', 'geheim');
  fd.append('content', 'Notiz ' + MARKER);
  fd.append('maxViews', '3');
  fd.append('expiresHours', '1');
  fd.append('attachments', new Blob([Buffer.from('Anhang ' + MARKER)]), 'anhang.txt');
  const res = await api('/api/files/create-note', { method: 'POST', body: fd });
  assert.strictEqual(res.status, 200, 'create-note ' + res.status);
  const rows = psql(`SELECT name, path, enc_version, size FROM files WHERE owner_id = ${userId} AND is_one_time_note = true AND is_folder = false ORDER BY id`).split('\n');
  assert.strictEqual(rows.length, 2);
  for (const r of rows) {
    const [, p, ev] = r.split('|');
    if (ENC) { assert.strictEqual(ev, '1'); assert.strictEqual(blobHead(p), 'MCENC1'); assert.ok(!containsOnDisk(MARKER, [UP + '/' + p])); }
    else assert.strictEqual(ev, '');
  }
});

test('Kopieren: Kopie liefert gleichen Inhalt', async () => {
  const res = await json('POST', '/api/files/copy-multiple', { fileIds: [textId], targetFolderId: null });
  assert.ok([200, 201].includes(res.status));
  const id = psql(`SELECT id FROM files WHERE owner_id = ${userId} AND name = 'e7 (Kopie).txt'`);
  const c = await download(Number(id));
  assert.strictEqual(c.status, 200);
  assert.ok((await bytes(c)).equals(marked(150000)));
});

/* ---------------- E8: Range ---------------- */

test('E8: Range-Request auf Binärdatei -> 206 mit richtigen Bytes', async () => {
  const data = crypto.randomBytes(400000);
  const j = await upload('clip.bin', data);
  const res = await download(j.id, { Range: 'bytes=1000-1999' });
  assert.strictEqual(res.status, 206);
  assert.strictEqual(res.headers.get('content-range'), `bytes 1000-1999/${data.length}`);
  assert.ok((await bytes(res)).equals(data.subarray(1000, 2000)));
  const r2 = await download(j.id, { Range: 'bytes=65000-131100' });
  assert.strictEqual(r2.status, 206);
  assert.ok((await bytes(r2)).equals(data.subarray(65000, 131101)));
});

/* ---------------- E9: Chunked ---------------- */

test('E9: Chunked-Upload mehrerer MB identisch, kein Klartext in tmp-chunked/uploads/Temp', async () => {
  if (ENC) {
    // Positivkontrolle: die Suche findet Klartext, wenn welcher da ist
    sh(`mkdir -p ${UP}/p2b-ctrl && printf '%s' '${MARKER}-CTRL' > ${UP}/p2b-ctrl/x`);
    assert.ok(containsOnDisk(MARKER + '-CTRL', [UP]));
    sh(`rm -rf ${UP}/p2b-ctrl`);
  }
  const data = marked(18 * 1024 * 1024 + 123);
  const init = await json('POST', '/api/files/upload/chunked/init', { name: 'chunked.txt', size: data.length, parentId: null });
  assert.strictEqual(init.status, 200);
  const { uploadId, chunkSize, totalChunks } = await init.json();
  assert.ok(totalChunks >= 3);
  for (let i = 0; i < totalChunks; i++) {
    const part = data.subarray(i * chunkSize, Math.min(data.length, (i + 1) * chunkSize));
    const r = await api(`/api/uploads/chunked/${uploadId}/${i}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: part });
    assert.strictEqual(r.status, 200, 'chunk ' + i);
    if (i === 1) { // Wiederholung eines Chunks bleibt möglich
      const again = await api(`/api/uploads/chunked/${uploadId}/${i}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: part });
      assert.strictEqual(again.status, 200);
    }
  }
  if (ENC) assert.ok(!containsOnDisk(MARKER, [UP, TMP]), 'Klartext während des Chunk-Uploads auf der Platte');
  const done = await json('POST', `/api/uploads/chunked/${uploadId}/complete`, {});
  assert.strictEqual(done.status, 201);
  const row = await done.json();
  assert.strictEqual(Number(row.size), data.length);
  const got = await bytes(await download(row.id));
  assert.ok(got.equals(data));
  assert.ok(!blobExists('tmp-chunked/' + uploadId), 'tmp-chunked aufgeräumt');
  if (ENC) {
    assert.strictEqual(row.enc_version, 1);
    assert.strictEqual(row.content_hash, crypto.createHash('sha256').update(data).digest('hex'));
    assert.strictEqual(blobHead(row.path), 'MCENC1');
    assert.ok(!containsOnDisk(MARKER, [UP, TMP]), 'Klartext nach dem Chunk-Upload auf der Platte');
  }
});

test('Chunked-Upload abbrechen räumt tmp-chunked auf', async () => {
  const init = await json('POST', '/api/files/upload/chunked/init', { name: 'abort.bin', size: 9 * 1024 * 1024, parentId: null });
  const { uploadId, chunkSize } = await init.json();
  await api(`/api/uploads/chunked/${uploadId}/0`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: crypto.randomBytes(chunkSize) });
  assert.ok(blobExists('tmp-chunked/' + uploadId));
  const del = await api(`/api/uploads/chunked/${uploadId}`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  await new Promise(r => setTimeout(r, 500));
  assert.ok(!blobExists('tmp-chunked/' + uploadId));
});

/* ---------------- E10: Editor, Versions-Restore, COW ---------------- */

let edId;
test('E10: Texteditor speichern + Versionsverlauf-Restore (Copy-on-Write im Enc-Stack)', async () => {
  const j = await upload('edit.txt', Buffer.from('Fassung eins ' + MARKER));
  edId = j.id;
  const p0 = j.path;
  let res = await json('PUT', `/api/files/content/${edId}`, { content: 'Fassung zwei äöü ' + MARKER });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).size, Buffer.byteLength('Fassung zwei äöü ' + MARKER));
  const r1 = await getRow(edId);
  assert.strictEqual(await (await api(`/api/files/content/${edId}`)).text(), 'Fassung zwei äöü ' + MARKER);
  if (ENC) {
    assert.notStrictEqual(r1.path, p0, 'files.path neu');
    assert.ok(!blobExists(p0), 'alter Blob gelöscht');
    assert.strictEqual(r1.enc_version, 1);
    assert.strictEqual(blobHead(r1.path), 'MCENC1');
    assert.strictEqual(r1.content_hash, crypto.createHash('sha256').update('Fassung zwei äöü ' + MARKER).digest('hex'));
  } else {
    assert.strictEqual(r1.path, p0, 'ohne Key wie bisher an Ort und Stelle');
  }
  // Zweiter Save + Restore der ersten Version (Version wird beim Speichern des Vorgängers angelegt)
  await json('PUT', `/api/files/content/${edId}`, { content: 'Fassung drei ' + MARKER });
  const versions = await (await api(`/api/files/${edId}/versions`)).json();
  assert.ok(versions.length >= 1);
  const oldest = versions[versions.length - 1];
  const r2 = await getRow(edId);
  res = await json('POST', `/api/files/${edId}/versions/${oldest.id}/restore`, {});
  assert.strictEqual(res.status, 200);
  const restored = (await res.json()).content;
  const r3 = await getRow(edId);
  assert.strictEqual(await (await api(`/api/files/content/${edId}`)).text(), restored);
  assert.strictEqual(Number(r3.size), Buffer.byteLength(restored));
  if (ENC) {
    assert.notStrictEqual(r3.path, r2.path);
    assert.ok(!blobExists(r2.path), 'alter Blob nach Restore gelöscht');
    assert.strictEqual(blobHead(r3.path), 'MCENC1');
    assert.ok(!containsOnDisk(MARKER, [UP + '/' + r3.path]));
  }
});

test('Öffentliches Speichern (Freigabe mit Schreibrecht): Copy-on-Write', async () => {
  const j = await upload('pub.txt', Buffer.from('alt ' + MARKER));
  const sh1 = await json('POST', '/api/shares', { fileId: j.id, canRead: true, canWrite: true, canDownload: true });
  const slug = ((await sh1.json()).share || {}).slug || (await (async () => psql(`SELECT slug FROM shares WHERE file_id = ${j.id}`))());
  const res = await fetch(`${BASE}/api/public/shares/${slug}/content/${j.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'neu ' + MARKER }) });
  assert.strictEqual(res.status, 200);
  const r = await getRow(j.id);
  assert.strictEqual(Number(r.size), Buffer.byteLength('neu ' + MARKER));
  const dl = await fetch(`${BASE}/api/public/shares/${slug}/download/${j.id}`);
  assert.strictEqual(await dl.text(), 'neu ' + MARKER);
  if (ENC) { assert.notStrictEqual(r.path, j.path); assert.ok(!blobExists(j.path)); assert.strictEqual(blobHead(r.path), 'MCENC1'); }
});

test('binary-content (Owner): neuer Blob, alter gelöscht, Inhalt korrekt', async () => {
  const j = await upload('bin.dat', crypto.randomBytes(5000));
  const nu = crypto.randomBytes(70000);
  const fd = new FormData();
  fd.append('file', new Blob([nu]), 'bin.dat');
  const res = await api(`/api/files/${j.id}/binary-content`, { method: 'PUT', body: fd });
  assert.strictEqual(res.status, 200);
  const r = await getRow(j.id);
  assert.strictEqual(Number(r.size), nu.length);
  assert.ok((await bytes(await download(j.id))).equals(nu));
  assert.ok(!blobExists(j.path), 'alter Blob gelöscht');
  if (ENC) { assert.strictEqual(r.enc_version, 1); assert.strictEqual(blobHead(r.path), 'MCENC1'); assert.strictEqual(r.content_hash, crypto.createHash('sha256').update(nu).digest('hex')); }
});

/* ---------------- E11: Thumbnails ---------------- */

test('E11: Thumbnail erzeugt/ausgeliefert; im Enc-Stack verschlüsselt, Temp leer', async () => {
  const j = await upload('thumb.png', PNG);
  const res = await api(`/api/files/thumbnail/${j.id}`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /^image\//);
  const b = await bytes(res);
  assert.ok(b.length > 0);
  const base = path.basename(j.path);
  const list = sh(`ls ${UP}/thumbnails | grep -F '${base}' || true`).trim().split('\n').filter(Boolean);
  if (ENC) {
    assert.deepStrictEqual(list, [base + '.jpg.enc']);
    assert.strictEqual(sh(`head -c 6 "${UP}/thumbnails/${base}.jpg.enc"`), 'MCENC1');
    await assertTmpEmpty();
    assert.strictEqual(b[0], 0xff); assert.strictEqual(b[1], 0xd8); // ausgeliefert wird JPEG-Klartext
    // zweiter Abruf aus dem Cache
    assert.strictEqual((await api(`/api/files/thumbnail/${j.id}`)).status, 200);
  } else {
    assert.ok(list.length === 0 || list[0] === base + '.jpg', 'ohne Key: Klartext-Thumbnail ' + list);
  }
  // Datei ersetzen/löschen -> Thumbnails mit gelöscht
  const fd = new FormData();
  fd.append('file', new Blob([PNG]), 'thumb.png');
  fd.append('onConflict', 'replace');
  const rep = await api('/api/files/upload', { method: 'POST', body: fd });
  assert.strictEqual(rep.status, 200);
  assert.strictEqual(sh(`ls ${UP}/thumbnails | grep -cF '${base}' || true`).trim(), '0', 'Thumbnails des ersetzten Blobs gelöscht');
});

/* ---------------- E12 / E13 ---------------- */

test('E12/E13: Ordner-ZIP und Freigabe-Download liefern Klartext', async () => {
  const f = await (await json('POST', '/api/files/folder', { name: 'zipdir', parentId: null })).json();
  const A = Buffer.from('Inhalt A äöü ' + MARKER), B = crypto.randomBytes(100000);
  const a = await upload('a.txt', A, { parentId: f.id });
  await upload('b.bin', B, { parentId: f.id });
  const zip = await api(`/api/files/download-zip/${f.id}`);
  assert.strictEqual(zip.status, 200);
  const entries = unzip(await bytes(zip));
  const names = Object.keys(entries);
  assert.ok(entries[names.find(n => n.endsWith('a.txt'))].equals(A));
  assert.ok(entries[names.find(n => n.endsWith('b.bin'))].equals(B));
  const s = await json('POST', '/api/shares', { fileId: a.id, canRead: true, canDownload: true });
  assert.ok([200, 201].includes(s.status));
  const slug = (await s.json()).slug;
  const dl = await fetch(`${BASE}/api/public/shares/${slug}/download/${a.id}`);
  assert.strictEqual(dl.status, 200);
  assert.ok((await bytes(dl)).equals(A));
});

test('Öffentlicher Upload über Freigabe (Ordner mit Schreibrecht)', async () => {
  const f = await (await json('POST', '/api/files/folder', { name: 'pubup', parentId: null })).json();
  const s = await json('POST', '/api/shares', { fileId: f.id, canRead: true, canWrite: true, canDownload: true });
  const slug = (await s.json()).slug;
  const data = marked(70000);
  const fd = new FormData();
  fd.append('file', new Blob([data]), 'gast.txt');
  const res = await fetch(`${BASE}/api/public/shares/${slug}/upload`, { method: 'POST', body: fd });
  assert.strictEqual(res.status, 201);
  const row = await res.json();
  assert.strictEqual(Number(row.size), data.length);
  assert.ok((await bytes(await download(row.id))).equals(data));
  if (ENC) { assert.strictEqual(row.enc_version, 1); assert.strictEqual(blobHead(row.path), 'MCENC1'); }
  // Datei in der Freigabe anlegen (leere Textdatei)
  const nf = await fetch(`${BASE}/api/public/shares/${slug}/file`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'neu' }) });
  assert.strictEqual(nf.status, 201);
  const nrow = await nf.json();
  if (ENC) { assert.strictEqual(nrow.enc_version, 1); assert.strictEqual(blobHead(nrow.path), 'MCENC1'); }
  assert.strictEqual((await bytes(await download(nrow.id))).length, 0);
});

/* ---------------- Faststart-Remux (COW) ---------------- */

test('Faststart-Remux: neuer Blob (Enc-Stack), Datei bleibt abspielbar', async (t) => {
  let mp4;
  try { mp4 = execFileSync('docker', [...COMPOSE_ARGS, 'exec', '-T', 'app', 'sh', '-c', 'ffmpeg -loglevel error -y -f lavfi -i testsrc=duration=1:size=64x64:rate=10 -c:v mpeg4 /tmp/p2b.mp4 && cat /tmp/p2b.mp4 && rm -f /tmp/p2b.mp4'], { cwd: ROOT, maxBuffer: 20 * 1024 * 1024 }); } catch { /* ffmpeg ohne mpeg4 */ }
  if (!mp4 || mp4.length < 100) return t.skip('ffmpeg-Encoder mpeg4 im Container nicht verfügbar');
  const j = await upload('cam.mp4', mp4);
  let row;
  for (let i = 0; i < 40; i++) {
    row = psql(`SELECT path, faststart_processed_at IS NOT NULL, enc_version, size FROM files WHERE id = ${j.id}`).split('|');
    if (row[1] === 't') break;
    await new Promise(r => setTimeout(r, 500));
  }
  assert.strictEqual(row[1], 't', 'Remux nicht abgeschlossen');
  const dl = await bytes(await download(j.id));
  assert.strictEqual(dl.length, Number(row[3]), 'files.size = Klartextgröße');
  assert.strictEqual(dl.subarray(4, 8).toString(), 'ftyp');
  if (ENC) {
    assert.notStrictEqual(row[0], j.path, 'Remux hängt neuen Blob um');
    assert.ok(!blobExists(j.path));
    assert.strictEqual(row[2], '1');
    assert.strictEqual(blobHead(row[0]), 'MCENC1');
    await assertTmpEmpty();
  } else {
    assert.strictEqual(row[0], j.path, 'ohne Key bleibt der Blob-Pfad in-place wie vorher');
  }
});

/* ---------------- Papierkorb endgültig löscht Blob + Thumbnail ---------------- */

test('Endgültig löschen entfernt Blob und Thumbnail', async () => {
  const j = await upload('weg.png', PNG);
  await api(`/api/files/thumbnail/${j.id}`);
  const base = path.basename(j.path);
  const before = sh(`ls ${UP}/thumbnails | grep -cF '${base}' || true`).trim();
  assert.ok(Number(before) >= 0);
  assert.ok(blobExists(j.path));
  await json('POST', '/api/files/delete-multiple', { ids: [j.id] });
  assert.ok(blobExists(j.path), 'Papierkorb: Blob bleibt');
  const del = await api(`/api/files/trash/${j.id}`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  assert.ok(!blobExists(j.path), 'Blob endgültig gelöscht');
  assert.strictEqual(sh(`ls ${UP}/thumbnails | grep -cF '${base}' || true`).trim(), '0');
});

/* ---------------- Avatar ---------------- */

test('Avatar: im Enc-Stack verschlüsselt (.enc), image/png ausgeliefert; Klartext-Altbestand lesbar', async () => {
  const fd = new FormData();
  fd.append('avatar', new Blob([PNG], { type: 'image/png' }), 'a.png');
  const up = await api('/api/settings/avatar', { method: 'POST', body: fd });
  assert.strictEqual(up.status, 200);
  const ap = psql(`SELECT avatar_path FROM users WHERE id = ${userId}`);
  const av = await api(`/api/users/${userId}/avatar`);
  assert.strictEqual(av.status, 200);
  assert.strictEqual(av.headers.get('content-type'), 'image/png');
  assert.strictEqual(av.headers.get('x-content-type-options'), 'nosniff');
  assert.ok((await bytes(av)).equals(PNG));
  if (ENC) {
    assert.ok(ap.endsWith('.png.enc'), 'avatar_path ' + ap);
    assert.strictEqual(sh(`head -c 6 "${UP}/${ap}"`), 'MCENC1');
    // Klartext-Altbestand: PNG direkt ablegen und avatar_path darauf setzen
    sh(`echo '${PNG.toString('base64')}' | base64 -d > ${UP}/legacy-avatar-${userId}.png`);
    psql(`UPDATE users SET avatar_path = 'legacy-avatar-${userId}.png' WHERE id = ${userId}`);
    const old = await api(`/api/users/${userId}/avatar`);
    assert.strictEqual(old.status, 200);
    assert.strictEqual(old.headers.get('content-type'), 'image/png');
    assert.ok((await bytes(old)).equals(PNG));
  } else {
    assert.ok(!ap.endsWith('.enc'));
  }
  // HTML bleibt abgelehnt (Magic-Bytes-Prüfung gilt auch für verschlüsselte Uploads)
  const bad = new FormData();
  bad.append('avatar', new Blob([Buffer.from('<html><script>1</script></html>')], { type: 'image/png' }), 'x.html');
  assert.strictEqual((await api('/api/settings/avatar', { method: 'POST', body: bad })).status, 400);
});

/* ---------------- Auto-Wandern ---------------- */

test('Enc-Stack: Klartext-Altdatei (enc_version NULL) wandert beim Bearbeiten in einen verschlüsselten Blob', { skip: !ENC }, async () => {
  const rel = `${userId}/legacy-${Date.now()}.txt`;
  sh(`printf '%s' 'alt im Klartext ${MARKER}' > ${UP}/${rel}`);
  const id = psql(`INSERT INTO files (name, path, mime_type, size, is_folder, owner_id) VALUES ('legacy.txt', '${rel}', 'text/plain', ${Buffer.byteLength('alt im Klartext ' + MARKER)}, false, ${userId}) RETURNING id`).split('\n')[0];
  assert.ok((await (await api(`/api/files/content/${id}`)).text()).includes('alt im Klartext'));
  const res = await json('PUT', `/api/files/content/${id}`, { content: 'bearbeitet ' + MARKER });
  assert.strictEqual(res.status, 200);
  const r = psql(`SELECT path, enc_version FROM files WHERE id = ${id}`).split('|');
  assert.notStrictEqual(r[0], rel);
  assert.strictEqual(r[1], '1');
  assert.ok(!blobExists(rel), 'Klartext-Altblob gelöscht');
  assert.strictEqual(blobHead(r[0]), 'MCENC1');
  assert.strictEqual(await (await api(`/api/files/content/${id}`)).text(), 'bearbeitet ' + MARKER);
});

/* ---------------- Fehlerpfade ---------------- */

test('Quota: Upload über dem Limit -> 413, kein Blob und keine Zeile', async () => {
  psql(`UPDATE users SET storage_quota = 1000 WHERE id = ${userId}`);
  try {
    const before = sh(`ls ${UP}/${userId} | wc -l; ls ${UP} | wc -l`).trim();
    const rows = psql(`SELECT count(*) FROM files WHERE owner_id = ${userId}`);
    const fd = new FormData();
    fd.append('file', new Blob([crypto.randomBytes(5000)]), 'zugross.bin');
    const res = await api('/api/files/upload', { method: 'POST', body: fd });
    assert.strictEqual(res.status, 413);
    await res.json();
    assert.strictEqual(sh(`ls ${UP}/${userId} | wc -l; ls ${UP} | wc -l`).trim(), before, 'Blob liegt noch herum');
    assert.strictEqual(psql(`SELECT count(*) FROM files WHERE owner_id = ${userId}`), rows);
  } finally {
    psql(`UPDATE users SET storage_quota = NULL WHERE id = ${userId}`);
  }
});

test('Chunked-Upload mit fehlendem Chunk -> Fehler, nichts bleibt liegen', async () => {
  const before = sh(`ls ${UP} | wc -l`).trim();
  const init = await json('POST', '/api/files/upload/chunked/init', { name: 'luecke.bin', size: 9 * 1024 * 1024, parentId: null });
  const { uploadId, chunkSize } = await init.json();
  await api(`/api/uploads/chunked/${uploadId}/0`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: crypto.randomBytes(chunkSize) });
  const done = await json('POST', `/api/uploads/chunked/${uploadId}/complete`, {});
  assert.ok(done.status >= 400, 'complete ' + done.status);
  await done.json();
  assert.ok(!blobExists('tmp-chunked/' + uploadId));
  assert.strictEqual(sh(`ls ${UP} | wc -l`).trim(), before);
  if (ENC) await assertTmpEmpty();
});

test('Chunked-Upload: paralleles Doppel-complete -> eines gewinnt, das andere 409/404', async () => {
  const data = crypto.randomBytes(300000);
  const init = await json('POST', '/api/files/upload/chunked/init', { name: 'doppelt.bin', size: data.length, parentId: null });
  const { uploadId } = await init.json();
  const put = await api(`/api/uploads/chunked/${uploadId}/0`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: data });
  assert.strictEqual(put.status, 200);
  const [a, b] = await Promise.all([json('POST', `/api/uploads/chunked/${uploadId}/complete`, {}), json('POST', `/api/uploads/chunked/${uploadId}/complete`, {})]);
  const codes = [a.status, b.status].sort();
  assert.strictEqual(codes[0], 201, 'Status ' + codes);
  assert.ok([404, 409].includes(codes[1]), 'Status ' + codes);
  await a.arrayBuffer(); await b.arrayBuffer();
});

test('Zwei parallele binary-content-Saves: genau ein Blob bleibt, Inhalt gehört zu einem der beiden', async () => {
  const j = await upload('race.bin', crypto.randomBytes(3000));
  const A = crypto.randomBytes(40000), B = crypto.randomBytes(50000);
  const before = Number(sh(`ls ${UP}/${userId} | wc -l`).trim());
  const put = (buf) => { const fd = new FormData(); fd.append('file', new Blob([buf]), 'race.bin'); return api(`/api/files/${j.id}/binary-content`, { method: 'PUT', body: fd }); };
  const [ra, rb] = await Promise.all([put(A), put(B)]);
  const codes = [ra.status, rb.status];
  await ra.arrayBuffer(); await rb.arrayBuffer();
  assert.ok(codes.includes(200), 'Status ' + codes);
  assert.ok(codes.every(c => [200, 500].includes(c)), 'Status ' + codes);
  const got = await bytes(await download(j.id));
  assert.ok(got.equals(A) || got.equals(B));
  assert.strictEqual(Number(sh(`ls ${UP}/${userId} | wc -l`).trim()), before, 'verwaister Blob');
});

test('Öffentlicher Upload ohne Schreibrecht wird vor dem Verschlüsseln abgewiesen (403), nichts bleibt liegen', async () => {
  const f = await (await json('POST', '/api/files/folder', { name: 'readonly', parentId: null })).json();
  const s = await json('POST', '/api/shares', { fileId: f.id, canRead: true, canWrite: false, canDownload: true });
  const slug = (await s.json()).slug;
  const before = sh(`ls ${UP} | wc -l`).trim();
  const fd = new FormData();
  fd.append('file', new Blob([crypto.randomBytes(100000)]), 'x.bin');
  const res = await fetch(`${BASE}/api/public/shares/${slug}/upload`, { method: 'POST', body: fd });
  assert.strictEqual(res.status, 403);
  await res.json();
  assert.strictEqual(sh(`ls ${UP} | wc -l`).trim(), before);
});

test('Avatar über 2 MB -> 400 mit deutscher Meldung', async () => {
  const fd = new FormData();
  fd.append('avatar', new Blob([PNG, Buffer.alloc(3 * 1024 * 1024)], { type: 'image/png' }), 'gross.png');
  const res = await api('/api/settings/avatar', { method: 'POST', body: fd });
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /2 MB/);
});

/* ---------------- 409-Guards: Key AUS, Zeile verschlüsselt (nur normaler Stack) ---------------- */

test('Key aus + enc_version=1: Schreibrouten antworten 409, Blob bleibt unverändert', { skip: ENC }, async () => {
  const j = await upload('guard.txt', Buffer.from('unveraendert ' + MARKER));
  psql(`UPDATE files SET enc_version = 1 WHERE id = ${j.id}`);
  const share = await json('POST', '/api/shares', { fileId: j.id, canRead: true, canWrite: true, canDownload: true });
  const slug = (await share.json()).slug;
  const ver = psql(`INSERT INTO file_versions (file_id, content) VALUES (${j.id}, 'alt') RETURNING id`).split('\n')[0];
  try {
    let res = await json('PUT', `/api/files/content/${j.id}`, { content: 'neu' });
    assert.strictEqual(res.status, 409); assert.match((await res.json()).error, /Master-Key/);
    res = await json('POST', `/api/files/${j.id}/versions/${ver}/restore`, {});
    assert.strictEqual(res.status, 409); await res.json();
    res = await fetch(`${BASE}/api/public/shares/${slug}/content/${j.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'neu' }) });
    assert.strictEqual(res.status, 409); await res.json();
    for (const url of [`/api/files/${j.id}/binary-content`, null]) {
      const fd = new FormData(); fd.append('file', new Blob([Buffer.from('neu')]), 'guard.txt');
      res = url ? await api(url, { method: 'PUT', body: fd }) : await fetch(`${BASE}/api/public/shares/${slug}/binary-content/${j.id}`, { method: 'PUT', body: fd });
      assert.strictEqual(res.status, 409, String(url)); await res.json();
    }
    const r = await getRow(j.id);
    assert.strictEqual(r.path, j.path);
    assert.ok(containsOnDisk('unveraendert ' + MARKER, [UP + '/' + j.path]), 'Blob wurde verändert');
  } finally {
    psql(`UPDATE files SET enc_version = NULL WHERE id = ${j.id}`);
  }
});

/* ---------------- Aufräumen ---------------- */

test('keine Temp-Reste: tmp-chunked und MYCLOUD_TMP_DIR sauber', async () => {
  assert.strictEqual(sh(`ls -A ${UP}/tmp-chunked 2>/dev/null | wc -l`).trim(), '0');
  if (ENC) await assertTmpEmpty();
});
