// node --test tests/share-trash.test.js  (Test-Stack auf http://localhost:3099, REGISTRATION_ENABLED=true)
const test = require('node:test');
const assert = require('node:assert');

const BASE = process.env.BASE_URL || 'http://localhost:3099';
const user = 'sharetrash' + Date.now();
const password = 'Test-Passwort-12345!';
let cookie = '';
let folderId, subId, fileId, subFileId, slug;

const api = (method, path, body) => fetch(BASE + path, {
  method,
  headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const pub = (path) => fetch(BASE + '/api/public/shares/' + slug + path);

async function upload(name, parentId) {
  const fd = new FormData();
  fd.append('file', new Blob(['hello ' + name], { type: 'text/plain' }), name);
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
async function listIds() {
  const j = await (await pub('')).json();
  return (j.files || []).map(f => f.id);
}
const trash = (id) => api('DELETE', '/api/files/' + id);
const restore = (id) => api('POST', `/api/files/trash/${id}/restore`);

test('setup', async () => {
  const res = await fetch(BASE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, email: user + '@example.test', password }),
  });
  assert.ok([200, 201].includes(res.status), 'register ' + res.status);
  cookie = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  folderId = await mkdir('shared', null);
  subId = await mkdir('sub', folderId);
  fileId = await upload('a.txt', folderId);
  subFileId = await upload('b.txt', subId);
  const sh = await api('POST', '/api/shares', { fileId: folderId });
  assert.ok([200, 201].includes(sh.status), 'share ' + sh.status);
  const j = await sh.json();
  slug = (j.share || j).slug;
  assert.ok(slug);
});

test('file is reachable via share before trashing', async () => {
  for (const p of ['content', 'meta', 'download']) {
    const r = await pub(`/${p}/${fileId}`);
    assert.strictEqual(r.status, 200, p);
    await r.arrayBuffer();
  }
  assert.ok((await listIds()).includes(fileId));
});

test('trashed file: 404 on every share route, hidden from listing and ZIPs', async () => {
  assert.strictEqual((await trash(fileId)).status, 200);
  for (const p of ['content', 'meta', 'thumbnail', 'download', 'eurooffice/config']) {
    const r = await pub(`/${p}/${fileId}`);
    assert.strictEqual(r.status, 404, p);
    await r.arrayBuffer();
  }
  assert.ok(!(await listIds()).includes(fileId));
  const zip = await pub(`/download-zip/${folderId}`);
  assert.strictEqual(zip.status, 200);
  assert.ok(!(Buffer.from(await zip.arrayBuffer()).includes('a.txt')), 'ZIP must not contain trashed file');
  const multi = await pub(`/download-zip-multiple?ids=${fileId}`);
  assert.ok(!(Buffer.from(await multi.arrayBuffer()).includes('a.txt')), 'multi ZIP must not contain trashed file');
});

test('restore makes the file reachable again', async () => {
  assert.strictEqual((await restore(fileId)).status, 200);
  const r = await pub(`/content/${fileId}`);
  assert.strictEqual(r.status, 200);
  await r.arrayBuffer();
  assert.ok((await listIds()).includes(fileId));
});

test('file inside a trashed subfolder is not reachable by id; restore fixes it', async () => {
  assert.strictEqual((await pub(`/meta/${subFileId}`)).status, 200);
  assert.strictEqual((await trash(subId)).status, 200);
  for (const p of ['content', 'meta', 'download']) {
    const r = await pub(`/${p}/${subFileId}`);
    assert.strictEqual(r.status, 404, p);
    await r.arrayBuffer();
  }
  assert.strictEqual((await restore(subId)).status, 200);
  assert.strictEqual((await pub(`/meta/${subFileId}`)).status, 200);
});

test('trashed share root yields no content', async () => {
  // moveToTrashRecursive additionally revokes shares pointing into the trashed subtree
  // (by design), so the share stays dead after restore; here only "no content" matters.
  assert.strictEqual((await trash(folderId)).status, 200);
  assert.strictEqual((await pub('')).status, 404);
  assert.strictEqual((await pub(`/meta/${fileId}`)).status, 404);
});
