// node --test tests/folder-copy.test.js  (Test-Stack auf http://localhost:3099) — Issue #40
const test = require('node:test');
const assert = require('node:assert');

const BASE = process.env.BASE_URL || 'http://localhost:3099';
const user = 'foldercopy' + Date.now();
const password = 'Test-Passwort-12345!';
let cookie = '', srcId, subId;

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
async function list(parentId) {
  const res = await api('GET', '/api/files/list?parentId=' + (parentId || 'null'));
  assert.strictEqual(res.status, 200);
  const j = await res.json();
  return Array.isArray(j) ? j : (j.files || []);
}
const copy = (ids, target) => api('POST', '/api/files/copy-multiple', { fileIds: ids, targetFolderId: target });

test('setup', async () => {
  const res = await fetch(BASE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, email: user + '@example.test', password }),
  });
  assert.ok([200, 201].includes(res.status), 'register ' + res.status);
  cookie = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  srcId = await mkdir('Quelle', null);
  subId = await mkdir('Unter', srcId);
  await upload('a.txt', srcId);
  await upload('b.txt', subId);
  const goneId = await upload('weg.txt', srcId);
  assert.strictEqual((await api('DELETE', '/api/files/' + goneId)).status, 200);
});

test('Ordner kopieren: Struktur und Inhalt stimmen, Papierkorb fehlt; zweimal kopieren -> zwei Namen', async () => {
  assert.strictEqual((await copy([srcId], null)).status, 200);
  assert.strictEqual((await copy([srcId], null)).status, 200);
  const root = (await list(null)).filter(f => f.is_folder && f.name.startsWith('Quelle'));
  const names = root.map(f => f.name).sort();
  assert.deepStrictEqual(names, ['Quelle', 'Quelle (Kopie)', 'Quelle (Kopie) (1)']);
  for (const c of root.filter(f => f.name !== 'Quelle')) {
    const kids = await list(c.id);
    assert.deepStrictEqual(kids.map(k => k.name).sort(), ['Unter', 'a.txt']);
    const sub = kids.find(k => k.name === 'Unter');
    assert.deepStrictEqual((await list(sub.id)).map(k => k.name), ['b.txt']);
  }
});

test('Ordner in sich selbst oder Unterordner kopieren -> 400', async () => {
  for (const target of [srcId, subId]) {
    const res = await copy([srcId], target);
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /sich selbst/);
  }
  const kids = await list(srcId);
  assert.ok(!kids.some(k => k.name.includes('Kopie')));
});
