// node --test tests/shares-permissions.test.js  (Test-Stack auf http://localhost:3099, REGISTRATION_ENABLED=true)
// Deckt #41 (Einmal-Notiz), #42 (Nur Herunterladen), #46 (PUT behaelt Berechtigungen) ab. Ein registrierter Nutzer.
const test = require('node:test');
const assert = require('node:assert');

const BASE = process.env.BASE_URL || 'http://localhost:3099';
const user = 'shareperm' + Date.now();
const password = 'Test-Passwort-12345!';
let cookie = '';

const api = (method, path, body) => fetch(BASE + path, {
  method,
  headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const cookiesOf = (res) => (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');

async function upload(name) {
  const fd = new FormData();
  fd.append('file', new Blob(['hello ' + name], { type: 'text/plain' }), name);
  const res = await fetch(BASE + '/api/files/upload', { method: 'POST', headers: { cookie }, body: fd });
  assert.ok([200, 201].includes(res.status), 'upload ' + res.status);
  const j = await res.json();
  return (j.file || j).id;
}

test('setup', async () => {
  const res = await fetch(BASE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, email: user + '@example.test', password }),
  });
  assert.ok([200, 201].includes(res.status), 'register ' + res.status);
  cookie = cookiesOf(res);
});

test('#41 Einmal-Notiz: nach bestaetigtem Oeffnen ist der Inhalt lesbar, andere Sitzung gesperrt', async () => {
  const fd = new FormData();
  fd.append('name', 'geheim');
  fd.append('content', 'Geheimer Text 41');
  fd.append('maxViews', '1');
  const res = await fetch(BASE + '/api/files/create-note', { method: 'POST', headers: { cookie }, body: fd });
  assert.strictEqual(res.status, 200);
  const slug = (await res.json()).shareLink.split('/s/')[1];
  assert.ok(slug);

  const open = await fetch(`${BASE}/api/public/shares/${slug}?confirmed=true`);
  assert.strictEqual(open.status, 200);
  const sessCookie = cookiesOf(open);
  const info = await open.json();
  const noteId = info.baseFile.id;

  const content = await fetch(`${BASE}/api/public/shares/${slug}/content/${noteId}`, { headers: { cookie: sessCookie } });
  assert.strictEqual(content.status, 200);
  assert.strictEqual(await content.text(), 'Geheimer Text 41');

  const other = await fetch(`${BASE}/api/public/shares/${slug}`);
  assert.strictEqual(other.status, 410);
  const otherContent = await fetch(`${BASE}/api/public/shares/${slug}/content/${noteId}`);
  assert.strictEqual(otherContent.status, 410);
});

test('#42 Nur Herunterladen: Download 200, Vorschau/Metadaten/Inhalt/Thumbnail 403', async () => {
  const fileId = await upload('dl.txt');
  const sh = await api('POST', '/api/shares', { fileId, canRead: false, canDownload: true });
  assert.ok([200, 201].includes(sh.status), 'share ' + sh.status);
  const j = await sh.json();
  const share = j.share || j;
  assert.strictEqual(share.can_read, false);
  const pub = (p) => fetch(`${BASE}/api/public/shares/${share.slug}/${p}/${fileId}`);

  const dl = await pub('download');
  assert.strictEqual(dl.status, 200);
  assert.strictEqual(await dl.text(), 'hello dl.txt');
  for (const p of ['content', 'meta', 'thumbnail']) {
    const r = await pub(p);
    assert.strictEqual(r.status, 403, p);
    await r.arrayBuffer();
  }

  // can_download=false verweigert den Download weiterhin
  const upd = await api('PUT', '/api/shares/' + share.id, { canDownload: false });
  assert.strictEqual(upd.status, 200);
  const denied = await pub('download');
  assert.strictEqual(denied.status, 403);
  await denied.arrayBuffer();
});

test('#46 PUT mit nur message laesst Berechtigungen unveraendert', async () => {
  const fileId = await upload('perm.txt');
  const sh = await api('POST', '/api/shares', { fileId, canRead: false, canWrite: true, canDownload: false, canZip: false });
  assert.ok([200, 201].includes(sh.status), 'share ' + sh.status);
  const sj = await sh.json();
  const share = sj.share || sj;
  const before = { r: share.can_read, w: share.can_write, d: share.can_download, z: share.can_zip };
  assert.deepStrictEqual(before, { r: false, w: true, d: false, z: false });

  const upd = await api('PUT', '/api/shares/' + share.id, { message: 'Hallo' });
  assert.strictEqual(upd.status, 200);
  const after = await upd.json();
  assert.strictEqual(after.message, 'Hallo');
  assert.deepStrictEqual({ r: after.can_read, w: after.can_write, d: after.can_download, z: after.can_zip }, before);

  // einzelne Berechtigung setzen, andere bleiben
  const upd2 = await (await api('PUT', '/api/shares/' + share.id, { canZip: true })).json();
  assert.deepStrictEqual({ r: upd2.can_read, w: upd2.can_write, d: upd2.can_download, z: upd2.can_zip },
    { r: false, w: true, d: false, z: true });
});
