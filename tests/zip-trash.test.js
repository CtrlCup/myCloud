// node --test tests/zip-trash.test.js  (Test-Stack auf http://localhost:3099) — Issue #44
const test = require('node:test');
const assert = require('node:assert');

const BASE = process.env.BASE_URL || 'http://localhost:3099';
const user = 'ziptrash' + Date.now();
const password = 'Test-Passwort-12345!';
let cookie = '', rootId, packId, slug;

const api = (method, path, body) => fetch(BASE + path, {
  method,
  headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
async function upload(name, parentId) {
  const fd = new FormData();
  fd.append('file', new Blob(['inhalt ' + name], { type: 'text/plain' }), name);
  fd.append('parentId', String(parentId));
  const res = await fetch(BASE + '/api/files/upload', { method: 'POST', headers: { cookie }, body: fd });
  assert.ok([200, 201].includes(res.status), 'upload ' + res.status);
  const j = await res.json();
  return (j.file || j).id;
}
async function mkdir(name, parentId) {
  const res = await api('POST', '/api/files/folder', { name, parentId });
  assert.ok([200, 201].includes(res.status), 'mkdir ' + res.status);
  return (await res.json()).id;
}
// Liest die Dateinamen aus dem Central Directory (kein Zip64, kleine Archive).
function zipNames(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  assert.ok(eocd >= 0, 'kein ZIP');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count; n++) {
    assert.strictEqual(buf.readUInt32LE(off), 0x02014b50);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), cmtLen = buf.readUInt16LE(off + 32);
    names.push(buf.toString('utf8', off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return names.sort();
}
async function names(res) {
  assert.strictEqual(res.status, 200);
  return zipNames(Buffer.from(await res.arrayBuffer()));
}

test('setup', async () => {
  const res = await fetch(BASE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, email: user + '@example.test', password }),
  });
  assert.ok([200, 201].includes(res.status), 'register ' + res.status);
  cookie = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  rootId = await mkdir('root', null);
  packId = await mkdir('pack', rootId);
  const liveId = await mkdir('live', packId);
  const goneSubId = await mkdir('gonesub', packId);
  await upload('keep.txt', packId);
  await upload('ok.txt', liveId);
  const goneId = await upload('gone.txt', packId);
  await upload('inner.txt', goneSubId);
  assert.strictEqual((await api('DELETE', '/api/files/' + goneId)).status, 200);
  assert.strictEqual((await api('DELETE', '/api/files/' + goneSubId)).status, 200);
  const sh = await api('POST', '/api/shares', { fileId: rootId, canRead: true, canDownload: true, canZip: true });
  assert.ok([200, 201].includes(sh.status), 'share ' + sh.status);
  const j = await sh.json();
  slug = (j.share || j).slug;
});


test('Owner download-zip/:id enthält nichts aus dem Papierkorb', async () => {
  const n = await names(await api('GET', `/api/files/download-zip/${packId}`));
  assert.deepStrictEqual(n.filter(x => !x.endsWith('/')), ['keep.txt', 'live/ok.txt']);
});

test('Owner download-zip-multiple enthält nichts aus dem Papierkorb', async () => {
  const n = await names(await api('GET', `/api/files/download-zip-multiple?ids=${packId}`));
  assert.deepStrictEqual(n.filter(x => !x.endsWith('/')), ['pack/keep.txt', 'pack/live/ok.txt']);
  assert.ok(!n.some(x => /gone|inner/.test(x)), n.join());
});

test('Share download-zip enthält nichts aus dem Papierkorb', async () => {
  const n = await names(await fetch(`${BASE}/api/public/shares/${slug}/download-zip/${packId}`));
  assert.deepStrictEqual(n.filter(x => !x.endsWith('/')), ['keep.txt', 'live/ok.txt']);
  const all = await names(await fetch(`${BASE}/api/public/shares/${slug}/download-zip/${rootId}`));
  assert.ok(!all.some(x => /gone|inner/.test(x)), all.join());
});

test('Share download-zip-multiple enthält nichts aus dem Papierkorb', async () => {
  const n = await names(await fetch(`${BASE}/api/public/shares/${slug}/download-zip-multiple?ids=${packId}`));
  assert.deepStrictEqual(n.filter(x => !x.endsWith('/')), ['pack/keep.txt', 'pack/live/ok.txt']);
  assert.ok(!n.some(x => /gone|inner/.test(x)), n.join());
});
