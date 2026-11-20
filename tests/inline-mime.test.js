// node --test tests/inline-mime.test.js  (Test-Stack auf http://localhost:3099, REGISTRATION_ENABLED=true)
const test = require('node:test');
const assert = require('node:assert');

const { BASE } = require('./_env');
const user = 'mime' + Date.now();
const password = 'Test-Passwort-12345!';
let cookie = '';

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', cookie, ...(opts.headers || {}) },
  });
  const sc = res.headers.getSetCookie?.() || [];
  if (sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
  return res;
}

let fileId;

test('setup: register + create test.html', async () => {
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: user, email: user + '@example.test', password }),
  });
  assert.ok([200, 201].includes(reg.status), 'register ' + reg.status);
  const res = await api('/api/files/create-empty', {
    method: 'POST',
    body: JSON.stringify({ name: 'test.html', type: 'txt', parentId: null }),
  });
  assert.ok(res.ok, 'create-empty ' + res.status);
  const body = await res.json();
  fileId = (body.file || body).id;
  assert.ok(fileId);
  assert.strictEqual((body.file || body).mime_type, 'text/plain');
});

test('owner inline: text/plain, nosniff, sandbox CSP', async () => {
  const res = await api(`/api/files/download/${fileId}?inline=true`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
});

test('owner download: nosniff + CSP', async () => {
  const res = await api(`/api/files/download/${fileId}`);
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
});

test('public share inline: text/plain, nosniff, sandbox CSP', async () => {
  const sh = await api('/api/shares', {
    method: 'POST',
    body: JSON.stringify({ fileId, canRead: true, canDownload: true }),
  });
  assert.ok(sh.ok, 'share ' + sh.status);
  const slug = (await sh.json()).slug;
  assert.ok(slug);
  const res = await fetch(`${BASE}/api/public/shares/${slug}/download/${fileId}?inline=true`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
});

test('svg: image/svg+xml, nosniff, sandbox CSP', async () => {
  const res0 = await api('/api/files/create-empty', {
    method: 'POST',
    body: JSON.stringify({ name: 'test.svg', type: 'txt', parentId: null }),
  });
  assert.ok(res0.ok);
  const f = await res0.json();
  assert.strictEqual(f.mime_type, 'image/svg+xml');
  const res = await api(`/api/files/download/${f.id}?inline=true`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /^image\/svg\+xml/);
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
});

async function upload(name, content, type, field = 'file', path = '/api/files/upload') {
  const fd = new FormData();
  fd.append(field, new Blob([content], { type }), name);
  return fetch(BASE + path, { method: 'POST', headers: { cookie }, body: fd });
}

test('pdf: application/pdf, nosniff, no sandbox CSP', async () => {
  const up = await upload('t.pdf', '%PDF-1.4\n%%EOF\n', 'application/pdf');
  assert.ok(up.ok, 'upload ' + up.status);
  const f = await up.json();
  const res = await api(`/api/files/download/${(f.file || f).id}?inline=true`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/pdf/);
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(!/sandbox/.test(res.headers.get('content-security-policy') || ''));
});

test('copy of .html keeps text/plain', async () => {
  const res = await api('/api/files/copy-multiple', {
    method: 'POST',
    body: JSON.stringify({ ids: [fileId], fileIds: [fileId], targetFolderId: null }),
  });
  assert.ok(res.ok, 'copy ' + res.status);
  const list = await (await api('/api/files/list')).json();
  const items = Array.isArray(list) ? list : (list.files || list.items || []);
  const copy = items.find(x => /Kopie/.test(x.name) && x.name.endsWith('.html'));
  assert.ok(copy, 'copy not found');
  assert.strictEqual(copy.mime_type, 'text/plain');
});

test('branding upload with .html is rejected (admin only, else skipped)', async (t) => {
  const res = await upload('x.html', '<script>1</script>', 'text/html', 'icon', '/api/settings/admin/icon');
  if (res.status === 403) return t.skip('test user is not admin');
  assert.strictEqual(res.status, 400);
});
