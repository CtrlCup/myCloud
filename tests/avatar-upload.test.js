// node --test tests/avatar-upload.test.js  (Test-Stack auf http://localhost:3099, REGISTRATION_ENABLED=true)
const test = require('node:test');
const assert = require('node:assert');

const { BASE } = require('./_env');
const user = 'avatar' + Date.now();
const password = 'Test-Passwort-12345!';
let cookie = '';
let userId;

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function upload(buf, name, type) {
  const fd = new FormData();
  fd.append('avatar', new Blob([buf], { type }), name);
  const res = await fetch(BASE + '/api/settings/avatar', { method: 'POST', headers: { cookie }, body: fd });
  return res;
}
const getAvatar = () => fetch(`${BASE}/api/users/${userId}/avatar`, { headers: { cookie } });

test('setup: register', async () => {
  const res = await fetch(BASE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, email: user + '@example.test', password }),
  });
  assert.ok([200, 201].includes(res.status), 'register ' + res.status);
  cookie = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  const me = await fetch(BASE + '/api/settings', { headers: { cookie } });
  const j = await me.json();
  userId = (j.user || j).id;
  assert.ok(userId);
});

test('valid PNG is accepted and served as image/png', async () => {
  const res = await upload(PNG, 'a.png', 'image/png');
  assert.strictEqual(res.status, 200);
  const av = await getAvatar();
  assert.strictEqual(av.status, 200);
  assert.strictEqual(av.headers.get('content-type'), 'image/png');
  assert.strictEqual(av.headers.get('x-content-type-options'), 'nosniff');
});

test('HTML content with image/png mimetype and .html name is rejected (400)', async () => {
  const res = await upload(Buffer.from('<html><script>alert(1)</script></html>'), 'x.html', 'image/png');
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.ok(body.error);
});

test('PNG content with .html name is accepted and served as image/png', async () => {
  const res = await upload(PNG, 'evil.html', 'text/html');
  assert.strictEqual(res.status, 200, 'upload ' + res.status);
  const av = await getAvatar();
  assert.strictEqual(av.status, 200);
  assert.strictEqual(av.headers.get('content-type'), 'image/png');
  assert.strictEqual(av.headers.get('x-content-type-options'), 'nosniff');
});
