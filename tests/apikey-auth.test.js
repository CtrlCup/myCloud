// node --test tests/apikey-auth.test.js  (Test-Stack auf http://localhost:3099, REGISTRATION_ENABLED=true)
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');

const { BASE } = require('./_env');
const user = 'apikey' + Date.now();
const password = 'Test-Passwort-12345!';
let cookie = '';
let key, keyId;

const bearer = k => ({ authorization: 'Bearer ' + k });
const { COMPOSE_CMD } = require('./_env');
const psql = sql => execSync(
  `${COMPOSE_CMD} exec -T db psql -U mycloud -d mycloud -c "${sql}"`,
  { cwd: require('node:path').join(__dirname, '..'), stdio: 'pipe' });

test('setup: register and create API key via session', async () => {
  const res = await fetch(BASE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, email: user + '@example.test', password }),
  });
  assert.ok([200, 201].includes(res.status), 'register ' + res.status);
  cookie = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  const k = await fetch(BASE + '/api/settings/api-keys', {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 't' }),
  });
  assert.strictEqual(k.status, 201);
  const j = await k.json();
  key = j.key; keyId = j.id;
  assert.ok(key.startsWith('mcld_'));
});

test('valid key: 200 and no Set-Cookie', async () => {
  const res = await fetch(BASE + '/api/settings', { headers: bearer(key) });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.getSetCookie().length, 0);
  assert.strictEqual(res.headers.get('set-cookie'), null);
});

test('logout with key does not crash and sets no cookie', async () => {
  const res = await fetch(BASE + '/api/auth/logout', { method: 'POST', headers: bearer(key) });
  assert.strictEqual(res.status, 200);
  const again = await fetch(BASE + '/api/settings', { headers: bearer(key) });
  assert.strictEqual(again.status, 200);
});

test('browser session login still works', async () => {
  const res = await fetch(BASE + '/api/settings', { headers: { cookie } });
  assert.strictEqual(res.status, 200);
});

test('malformed mcld_ key: 401', async () => {
  const res = await fetch(BASE + '/api/settings', { headers: bearer('mcld_deadbeef') });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.headers.getSetCookie().length, 0);
});

test('kill switch: 401 immediately, works again when re-enabled', async () => {
  psql("insert into settings(key,value) values('api_key_auth_enabled','false') on conflict (key) do update set value='false'");
  try {
    const res = await fetch(BASE + '/api/settings', { headers: bearer(key) });
    assert.strictEqual(res.status, 401);
  } finally {
    psql("delete from settings where key='api_key_auth_enabled'");
  }
  const ok = await fetch(BASE + '/api/settings', { headers: bearer(key) });
  assert.strictEqual(ok.status, 200);
});

test('key bearer cannot manage account security (403), session still can', async () => {
  const k2 = await (await fetch(BASE + '/api/settings/api-keys', {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'sec' }),
  })).json();
  const h = { ...bearer(k2.key), 'Content-Type': 'application/json' };
  for (const [method, path] of [
    ['POST', '/api/settings/api-keys'], ['GET', '/api/settings/api-keys'],
    ['POST', '/api/settings/2fa/totp/disable'], ['POST', '/api/settings/password'],
  ]) {
    const res = await fetch(BASE + path, { method, headers: h, body: method === 'POST' ? '{}' : undefined });
    assert.strictEqual(res.status, 403, method + ' ' + path);
  }
  const ok = await fetch(BASE + '/api/settings/api-keys', { headers: { cookie } });
  assert.strictEqual(ok.status, 200);
  await fetch(`${BASE}/api/settings/api-keys/${k2.id}`, { method: 'DELETE', headers: { cookie } });
});

test('revoked key: 401', async () => {
  const del = await fetch(`${BASE}/api/settings/api-keys/${keyId}`, { method: 'DELETE', headers: { cookie } });
  assert.strictEqual(del.status, 200);
  const res = await fetch(BASE + '/api/settings', { headers: bearer(key) });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.headers.getSetCookie().length, 0);
});
