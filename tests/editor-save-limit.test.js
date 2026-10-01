// node --test tests/editor-save-limit.test.js  (Test-Stack auf http://localhost:3099) — Issue #43
const test = require('node:test');
const assert = require('node:assert');

const BASE = process.env.BASE_URL || 'http://localhost:3099';
const user = 'editlimit' + Date.now();
const password = 'Test-Passwort-12345!';
let cookie = '', fileId, slug;

const api = (method, path, body) => fetch(BASE + path, {
  method,
  headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const big = (bytes) => 'abcdefghi\n'.repeat(Math.ceil(bytes / 10)).slice(0, bytes);

test('setup', async () => {
  const res = await fetch(BASE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, email: user + '@example.test', password }),
  });
  assert.ok([200, 201].includes(res.status), 'register ' + res.status);
  cookie = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  const fd = new FormData();
  fd.append('file', new Blob(['start'], { type: 'text/plain' }), 'big.txt');
  const up = await fetch(BASE + '/api/files/upload', { method: 'POST', headers: { cookie }, body: fd });
  assert.ok([200, 201].includes(up.status), 'upload ' + up.status);
  const j = await up.json();
  fileId = (j.file || j).id;
  const sh = await api('POST', '/api/shares', { fileId, canRead: true, canWrite: true });
  assert.ok([200, 201].includes(sh.status), 'share ' + sh.status);
  const s = await sh.json();
  slug = (s.share || s).slug;
});

for (const [label, bytes] of [['200 KB', 200 * 1024], ['5 MB', 5 * 1024 * 1024]]) {
  test(`Owner speichert ${label} und liest sie korrekt zurück`, async () => {
    const content = big(bytes);
    const put = await api('PUT', `/api/files/content/${fileId}`, { content });
    assert.strictEqual(put.status, 200);
    const get = await api('GET', `/api/files/content/${fileId}`);
    assert.strictEqual(get.status, 200);
    assert.strictEqual(await get.text(), content);
  });
}

test('Share-Schreiber speichert 5 MB', async () => {
  const content = big(5 * 1024 * 1024) + 'share';
  const put = await fetch(`${BASE}/api/public/shares/${slug}/content/${fileId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
  });
  assert.strictEqual(put.status, 200);
  const get = await api('GET', `/api/files/content/${fileId}`);
  assert.strictEqual(await get.text(), content);
});

test('Über dem Limit (20 MB) kommt 413 mit deutscher Meldung', async () => {
  const body = JSON.stringify({ content: big(21 * 1024 * 1024) });
  for (const [path, headers] of [
    [`/api/files/content/${fileId}`, { cookie }],
    [`/api/public/shares/${slug}/content/${fileId}`, {}],
  ]) {
    const res = await fetch(BASE + path, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body });
    assert.strictEqual(res.status, 413, path);
    assert.match((await res.json()).error, /zu groß/);
  }
});

test('Globales JSON-Limit bleibt klein (200 KB an anderer Route -> 413)', async () => {
  const res = await api('POST', '/api/files/folder', { name: big(200 * 1024), parentId: null });
  assert.strictEqual(res.status, 413);
});
