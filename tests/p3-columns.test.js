// node --test tests/p3-columns.test.js
// Phase P3 (Spaltenverschlüsselung, E15/E16) gegen den Test-Stack (TEST_BASE). Im verschlüsselten Stack (TEST_ENCRYPTED=1):
// Werte beginnen in der DB mit enc:v1:, Migration von Klartext-Altwerten inkl. Abbruch/Neustart. Im normalen Stack (E16):
// alles bleibt Klartext wie bisher.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { execFileSync, execSync } = require('node:child_process');
const { BASE, COMPOSE_ARGS, COMPOSE_CMD, ROOT } = require('./_env');

const ENC = process.env.TEST_ENCRYPTED === '1';
const APP_DIR = '/usr/src/app';
const sh = (cmd, input) => execFileSync('docker', [...COMPOSE_ARGS, 'exec', '-T', 'app', 'sh', '-c', cmd], { cwd: ROOT, input, maxBuffer: 64 << 20 }).toString();
const psql = (sql) => execSync(`${COMPOSE_CMD} exec -T db psql -U mycloud -d mycloud -At`, { input: sql, cwd: ROOT, maxBuffer: 64 << 20 }).toString().trim();
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const password = 'Test-Passwort-12345!';
const stamp = Date.now();

async function register(name) {
  const res = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, email: name + '@example.test', password }),
  });
  assert.ok([200, 201].includes(res.status), 'register ' + res.status);
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const me = await (await fetch(BASE + '/api/settings', { headers: { cookie } })).json();
  return { cookie, id: (me.user || me).id, username: name };
}
const call = (who, p, opts = {}) => fetch(BASE + p, { ...opts, headers: { cookie: who.cookie, ...(opts.headers || {}) } });
const send = (who, method, p, body) => call(who, p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const status = async (who) => (await call(who, '/api/settings/admin/encryption-status')).json();

// RFC 6238 (SHA-1, 30 s, 6 Stellen)
function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of s.replace(/=+$/, '')) bits += A.indexOf(ch).toString(2).padStart(5, '0');
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(secretB32, t = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
async function login2fa(username, secret) {
  const l = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.strictEqual(l.status, 200);
  const lj = await l.json();
  assert.strictEqual(lj.requires2FA, true);
  const cookie = (l.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  return fetch(BASE + '/api/auth/login/verify-2fa', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ code: totp(secret) }) });
}

// Liest eine Einstellung über die entschlüsselnden App-Funktionen im App-Container (nicht per SQL).
const appGetSetting = (key) => sh(`node -e "require('./db').getSetting('${key}').then(v => { process.stdout.write(JSON.stringify(v)); process.exit(0); })"`);
async function waitUp() {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(BASE + '/api/auth/status')).ok) return; } catch { /* startet noch */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.fail('App nach dem Neustart nicht erreichbar');
}
async function waitColumnsDone(who, maxMs = 180000) {
  const t0 = Date.now();
  for (;;) {
    let s = null;
    try { s = await status(who); } catch { /* Neustart */ }
    if (s && s.columns && !s.columnMigration.running && Object.values(s.columns).every((c) => c.plain === 0)) return s;
    assert.ok(Date.now() - t0 < maxMs, 'Spaltenmigration endet nicht: ' + JSON.stringify(s && s.columns));
    await new Promise((r) => setTimeout(r, 500));
  }
}

const isEnc = (v) => v.startsWith('enc:v1:');
const expectStored = (v, plain, what) => {
  if (ENC) { assert.ok(isEnc(v), `${what} beginnt mit enc:v1: (${v.slice(0, 20)})`); assert.ok(!v.includes(plain), `${what} enthält keinen Klartext`); }
  else assert.strictEqual(v, plain, `${what} (E16: Klartext wie bisher)`);
};

let admin, user, savedSettings;
const SECRET_KEYS = ['email_smtp_host', 'email_smtp_user', 'email_smtp_pass', 'email_smtp_tested', 'sso_client_id', 'sso_client_secret', 'sso_issuer_url'];

test('Setup: Admin und Nutzer', async () => {
  admin = await register('p3adm' + stamp);
  user = await register('p3usr' + stamp);
  psql(`UPDATE users SET role = 'admin' WHERE id = ${admin.id}; UPDATE users SET role = 'user' WHERE id = ${user.id};`);
  savedSettings = psql(`SELECT key || E'\\t' || value FROM settings WHERE key IN (${SECRET_KEYS.map(q).join(',')})`).split('\n').filter(Boolean).map((l) => l.split('\t'));
});

test.after(() => {
  // gemeinsame Test-DB: Einstellungen für nachfolgende Suiten zurücksetzen
  psql(`UPDATE settings SET value = '' WHERE key IN (${SECRET_KEYS.map(q).join(',')});` +
    savedSettings.map(([k, v]) => `UPDATE settings SET value = ${q(v)} WHERE key = ${q(k)};`).join(''));
});

/* ---------- E15: TOTP ---------- */

test('E15 TOTP: Setup+Bestätigung -> totp_secret in der DB verschlüsselt, 2FA-Login funktioniert, Deaktivieren löscht', async () => {
  const setup = await (await send(user, 'POST', '/api/settings/2fa/totp/setup', {})).json();
  assert.ok(setup.secret);
  const conf = await send(user, 'POST', '/api/settings/2fa/totp/confirm', { code: totp(setup.secret) });
  assert.strictEqual(conf.status, 200);
  const stored = psql(`SELECT totp_secret FROM users WHERE id = ${user.id}`);
  expectStored(stored, setup.secret, 'users.totp_secret');

  const ok = await login2fa(user.username, setup.secret);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await ok.json()).success, true);

  // falscher Code wird abgelehnt (Verifikation läuft wirklich gegen das entschlüsselte Secret)
  const l = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user.username, password }) });
  const cookie = (l.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const wrong = String((Number(totp(setup.secret)) + 1) % 1e6).padStart(6, '0');
  const bad = await fetch(BASE + '/api/auth/login/verify-2fa', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ code: wrong }) });
  assert.strictEqual(bad.status, 400);

  // beschädigter Wert -> klarer Fehler statt Login (nicht im Klartext-Fallback)
  psql(`UPDATE users SET totp_secret = 'enc:v1:1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE id = ${user.id}`);
  const broken = await login2fa(user.username, setup.secret);
  assert.strictEqual(broken.status, 500);
  assert.match((await broken.json()).error, /Datenbankwert/);
  psql(`UPDATE users SET totp_secret = ${q(stored)} WHERE id = ${user.id}`);
  assert.strictEqual((await login2fa(user.username, setup.secret)).status, 200);

  const dis = await send(user, 'POST', '/api/settings/2fa/totp/disable', {});
  assert.strictEqual(dis.status, 200);
  assert.strictEqual(psql(`SELECT COALESCE(totp_secret, 'NULL') FROM users WHERE id = ${user.id}`), 'NULL');
});

/* ---------- Admin-Secrets, F3 ---------- */

test('Admin-Config: SMTP-/SSO-Secrets verschlüsselt in der DB, nicht in .env, UI maskiert, App liest Klartext', async () => {
  const smtp = 'smtp-secret-' + stamp, sso = 'sso-secret-' + stamp;
  // Platzhalter-.env im Container (der Test-Stack mountet keine); nur anlegen/entfernen, wenn sie nicht existiert
  const hadEnv = (() => { try { sh(`test -e ${APP_DIR}/.env`); return true; } catch { return false; } })();
  if (!hadEnv) sh(`printf 'EMAIL_SMTP_HOST=alt\\nOTHER=1\\n' > ${APP_DIR}/.env`);
  try {
    const r = await send(admin, 'POST', '/api/settings/admin/config', {
      email_smtp_host: 'smtp.p3.example', email_smtp_user: 'p3user', email_smtp_pass: smtp,
      sso_client_id: 'p3-client', sso_client_secret: sso, sso_issuer_url: 'https://idp.p3.example/',
    });
    assert.strictEqual(r.status, 200);
    expectStored(psql(`SELECT value FROM settings WHERE key = 'email_smtp_pass'`), smtp, 'settings.email_smtp_pass');
    expectStored(psql(`SELECT value FROM settings WHERE key = 'sso_client_secret'`), sso, 'settings.sso_client_secret');
    assert.strictEqual(psql(`SELECT value FROM settings WHERE key = 'email_smtp_host'`), 'smtp.p3.example', 'Nicht-Secrets bleiben Klartext');
    assert.strictEqual(psql(`SELECT value FROM settings WHERE key = 'sso_client_id'`), 'p3-client');

    // App liest über die entschlüsselnden Funktionen den richtigen Wert
    assert.strictEqual(JSON.parse(appGetSetting('email_smtp_pass')), smtp);
    assert.strictEqual(JSON.parse(appGetSetting('sso_client_secret')), sso);

    // Admin-UI: Secrets nie im Klartext, nur "konfiguriert"
    const s = await (await call(admin, '/api/settings')).json();
    assert.strictEqual(s.adminConfig.email_smtp_pass_configured, true);
    assert.strictEqual(s.adminConfig.sso_client_secret_configured, true);
    assert.ok(!('email_smtp_pass' in s.adminConfig) && !('sso_client_secret' in s.adminConfig));
    assert.ok(!JSON.stringify(s).includes(smtp) && !JSON.stringify(s).includes(sso));

    // Platzhalter überschreibt nichts
    await send(admin, 'POST', '/api/settings/admin/config', { email_smtp_pass: '__placeholder__', sso_client_secret: '__placeholder__' });
    assert.strictEqual(JSON.parse(appGetSetting('email_smtp_pass')), smtp);

    // F3: .env enthält die Secrets NICHT, Nicht-Secrets werden weiter zurückgeschrieben
    const env = sh(`cat ${APP_DIR}/.env`);
    assert.ok(!env.includes(smtp) && !env.includes(sso), '.env ohne Secrets');
    assert.ok(!/SMTP_PASS|CLIENT_SECRET/.test(env));
    assert.match(env, /^EMAIL_SMTP_HOST=smtp\.p3\.example$/m);
    assert.match(env, /^SSO_CLIENT_ID=p3-client$/m);
  } finally {
    if (!hadEnv) sh(`rm -f ${APP_DIR}/.env`);
  }
});

/* ---------- Versionsverlauf ---------- */

let fileId;
const V1 = 'Version eins äöü 🌍';
async function content(id) { return (await call(admin, '/api/files/content/' + id)).text(); }

test('Versionsverlauf: content verschlüsselt, Liste (Größe)/Lesen/Restore funktionieren', async () => {
  const c = await send(admin, 'POST', '/api/files/create-empty', { name: `p3-${stamp}.txt`, type: 'txt', parentId: null });
  assert.ok([200, 201].includes(c.status), 'create ' + c.status);
  const created = await c.json();
  fileId = (created.file || created).id;
  assert.strictEqual((await send(admin, 'PUT', '/api/files/content/' + fileId, { content: V1 })).status, 200);
  assert.strictEqual((await send(admin, 'PUT', '/api/files/content/' + fileId, { content: 'Version zwei' })).status, 200);

  const list = await (await call(admin, `/api/files/${fileId}/versions`)).json();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(Number(list[0].size), Array.from(V1).length, 'Größe = Klartext-Zeichen, nicht Ciphertext');
  expectStored(psql(`SELECT content FROM file_versions WHERE id = ${list[0].id}`), V1, 'file_versions.content');
  assert.strictEqual(psql(`SELECT size FROM file_versions WHERE id = ${list[0].id}`), String(Array.from(V1).length));

  const v = await (await call(admin, `/api/files/${fileId}/versions/${list[0].id}`)).json();
  assert.strictEqual(v.content, V1);

  const rest = await send(admin, 'POST', `/api/files/${fileId}/versions/${list[0].id}/restore`, {});
  assert.strictEqual(rest.status, 200);
  assert.strictEqual((await rest.json()).content, V1);
  assert.strictEqual(await content(fileId), V1);
  const list2 = await (await call(admin, `/api/files/${fileId}/versions`)).json();
  assert.strictEqual(list2.length, 2, 'Restore checkpointet den Stand davor');
  const newest = await (await call(admin, `/api/files/${fileId}/versions/${list2[0].id}`)).json();
  assert.strictEqual(newest.content, 'Version zwei');
  assert.ok(psql(`SELECT COUNT(*) FROM file_versions WHERE file_id = ${fileId} AND content LIKE 'enc:v1:%'`) === (ENC ? '2' : '0'));
});

/* ---------- Freigaben ---------- */

test('Freigabe-Nachricht: in der DB verschlüsselt, API/Liste/öffentliche Meta liefern Klartext, Update-Pfade bleiben konsistent', async () => {
  const MSG = 'Hallo Welt äö ' + stamp;
  const cr = await send(admin, 'POST', '/api/shares', { fileId, message: MSG });
  assert.strictEqual(cr.status, 201);
  const share = await cr.json();
  assert.strictEqual(share.message, MSG);
  expectStored(psql(`SELECT message FROM shares WHERE id = ${share.id}`), MSG, 'shares.message');

  const list = await (await call(admin, '/api/shares')).json();
  assert.strictEqual(list.find((s) => s.id === share.id).message, MSG);
  const pub = await (await fetch(`${BASE}/api/public/shares/${share.slug}`)).json();
  assert.strictEqual(pub.share.message, MSG);

  // anderes Feld ändern: message bleibt, nicht doppelt verschlüsselt
  const up1 = await (await send(admin, 'PUT', '/api/shares/' + share.id, { canZip: false })).json();
  assert.strictEqual(up1.message, MSG);
  assert.strictEqual((await (await fetch(`${BASE}/api/public/shares/${share.slug}`)).json()).share.message, MSG);
  expectStored(psql(`SELECT message FROM shares WHERE id = ${share.id}`), MSG, 'shares.message nach Update');

  const up2 = await (await send(admin, 'PUT', '/api/shares/' + share.id, { message: 'Neu ü' })).json();
  assert.strictEqual(up2.message, 'Neu ü');
  const up3 = await (await send(admin, 'PUT', '/api/shares/' + share.id, { message: '' })).json();
  assert.strictEqual(up3.message, null);
  assert.strictEqual(psql(`SELECT COALESCE(message, 'NULL') FROM shares WHERE id = ${share.id}`), 'NULL');
});

/* ---------- Status ---------- */

test('Status: columns je Spalte mit total/encrypted/plain', async () => {
  const s = await status(admin);
  for (const k of ['users.totp_secret', 'settings', 'file_versions.content', 'shares.message']) {
    assert.ok(s.columns[k], k);
    assert.strictEqual(s.columns[k].total, s.columns[k].encrypted + s.columns[k].plain);
  }
  assert.ok('running' in s.columnMigration);
  if (!ENC) for (const c of Object.values(s.columns)) assert.strictEqual(c.encrypted, 0, 'E16: nichts verschlüsselt');
});

/* ---------- Migration (nur Enc-Stack) ---------- */

if (ENC) {
  const SEEDS = 45;
  const plainVersions = [];
  const snapshot = () => psql(`SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
    SELECT 't' || id || coalesce(totp_secret, '~') AS x FROM users
    UNION ALL SELECT 's' || key || value FROM settings
    UNION ALL SELECT 'v' || id || coalesce(content, '~') || coalesce(size::text, '~') FROM file_versions
    UNION ALL SELECT 'm' || id || coalesce(message, '~') FROM shares) q`);
  let migUser, migSecret, shareId;

  function seedPlain(tag) {
    const rows = [];
    for (let i = 0; i < SEEDS; i++) rows.push({ content: `${tag} Altwert ${i} äöü ` + 'x'.repeat(i * 100) });
    rows.push({ content: '' });
    const ids = psql(`INSERT INTO file_versions (file_id, content, size) VALUES ${rows.map((r) => `(${fileId}, ${q(r.content)}, NULL)`).join(',')} RETURNING id;`).split('\n').filter((l) => /^\d+$/.test(l)).map(Number);
    ids.forEach((id, n) => plainVersions.push({ id, content: rows[n].content }));
  }

  test('Migration: Klartext-Altwerte aller fünf Spalten werden verschlüsselt, Funktionen laufen, Zweitlauf ändert nichts', async () => {
    migUser = await register('p3mig' + stamp);
    migSecret = base32Encode(crypto.randomBytes(20));
    psql(`UPDATE users SET two_factor_totp = true, totp_secret = ${q(migSecret)} WHERE id = ${migUser.id};` +
      `UPDATE settings SET value = 'alt-smtp-${stamp}' WHERE key = 'email_smtp_pass'; UPDATE settings SET value = 'alt-sso-${stamp}' WHERE key = 'sso_client_secret';`);
    const sh0 = await (await send(admin, 'POST', '/api/shares', { fileId, message: 'x' })).json();
    shareId = sh0.id;
    psql(`UPDATE shares SET message = ${q('Klartext-Nachricht ' + stamp)} WHERE id = ${shareId}`);
    seedPlain('lauf1');
    psql(`INSERT INTO file_versions (file_id, content) VALUES (${fileId}, NULL)`); // NULL-Zeile bleibt unberührt

    const nulls = psql(`SELECT COUNT(*) FROM file_versions WHERE content IS NULL`), empties = psql(`SELECT COUNT(*) FROM file_versions WHERE content = ''`);
    const before = await status(admin);
    for (const k of Object.keys(before.columns)) assert.ok(before.columns[k].plain >= 1, 'offen: ' + k);
    // Klartext-Altwert ist mit Key bereits lesbar (Übergang)
    assert.strictEqual((await login2fa(migUser.username, migSecret)).status, 200);
    assert.strictEqual(JSON.parse(appGetSetting('email_smtp_pass')), `alt-smtp-${stamp}`);

    assert.strictEqual((await send(admin, 'POST', '/api/settings/admin/encryption-migration', { action: 'start' })).status, 200);
    const done = await waitColumnsDone(admin);
    assert.strictEqual(done.columnMigration.failed, 0);

    assert.ok(isEnc(psql(`SELECT totp_secret FROM users WHERE id = ${migUser.id}`)));
    assert.ok(isEnc(psql(`SELECT value FROM settings WHERE key = 'email_smtp_pass'`)));
    assert.ok(isEnc(psql(`SELECT value FROM settings WHERE key = 'sso_client_secret'`)));
    assert.ok(isEnc(psql(`SELECT message FROM shares WHERE id = ${shareId}`)));
    assert.strictEqual(psql(`SELECT COUNT(*) FROM file_versions WHERE content <> '' AND content NOT LIKE 'enc:v1:%'`), '0');
    assert.strictEqual(psql(`SELECT COUNT(*) FROM file_versions WHERE content IS NULL`), nulls);
    assert.strictEqual(psql(`SELECT COUNT(*) FROM file_versions WHERE content = ''`), empties);
    assert.strictEqual(psql(`SELECT COUNT(*) FROM file_versions WHERE size IS NULL AND content LIKE 'enc:v1:%'`), '0', 'size beim Verschlüsseln gesetzt');

    // Funktionen laufen mit den migrierten Werten
    assert.strictEqual((await login2fa(migUser.username, migSecret)).status, 200);
    assert.strictEqual(JSON.parse(appGetSetting('email_smtp_pass')), `alt-smtp-${stamp}`);
    assert.strictEqual(JSON.parse(appGetSetting('sso_client_secret')), `alt-sso-${stamp}`);
    const list = await (await call(admin, `/api/files/${fileId}/versions`)).json();
    for (const v of plainVersions) {
      const row = list.find((x) => x.id === v.id);
      assert.ok(row, 'in Liste ' + v.id);
      assert.strictEqual(Number(row.size), Array.from(v.content).length, 'Größe ' + v.id);
      assert.strictEqual((await (await call(admin, `/api/files/${fileId}/versions/${v.id}`)).json()).content, v.content);
    }
    assert.strictEqual((await (await fetch(`${BASE}/api/public/shares/${(await (await call(admin, '/api/shares')).json()).find((s) => s.id === shareId).slug}`)).json()).share.message, 'Klartext-Nachricht ' + stamp);

    // Zweitlauf: nichts ändert sich
    const snap = snapshot();
    assert.strictEqual((await send(admin, 'POST', '/api/settings/admin/encryption-migration', { action: 'start' })).status, 200);
    await waitColumnsDone(admin);
    await new Promise((r) => setTimeout(r, 1500));
    assert.strictEqual(snapshot(), snap, 'Zweitlauf ändert keine Zeile');
  });

  test('Migration: Abbruch durch Neustart mittendrin wird fortgesetzt, keine Doppelverschlüsselung', async () => {
    plainVersions.length = 0;
    seedPlain('lauf2');
    psql(`UPDATE shares SET message = ${q('Zweite Nachricht ' + stamp)} WHERE id = ${shareId}; UPDATE users SET totp_secret = ${q(migSecret)} WHERE id = ${migUser.id};`);
    assert.strictEqual((await send(admin, 'POST', '/api/settings/admin/encryption-migration', { action: 'start' })).status, 200);
    await new Promise((r) => setTimeout(r, 800));
    const mid = psql(`SELECT COUNT(*) FILTER (WHERE content LIKE 'enc:v1:%') || '/' || COUNT(*) FROM file_versions WHERE content <> '' AND id IN (${plainVersions.map((v) => v.id).join(',')})`);
    execFileSync('docker', [...COMPOSE_ARGS, 'restart', 'app'], { cwd: ROOT, stdio: 'ignore' });
    await waitUp();
    await waitColumnsDone(admin);

    assert.strictEqual(psql(`SELECT COUNT(*) FROM file_versions WHERE content <> '' AND content NOT LIKE 'enc:v1:%'`), '0', 'Zwischenstand beim Abbruch: ' + mid);
    // Doppelverschlüsselung würde als "enc:v1:..." im Klartext-Inhalt auftauchen
    for (const v of plainVersions.filter((x, n) => n % 7 === 0 || n === plainVersions.length - 1)) {
      assert.strictEqual((await (await call(admin, `/api/files/${fileId}/versions/${v.id}`)).json()).content, v.content);
    }
    assert.strictEqual((await login2fa(migUser.username, migSecret)).status, 200);
    const slug = (await (await call(admin, '/api/shares')).json()).find((s) => s.id === shareId).slug;
    assert.strictEqual((await (await fetch(`${BASE}/api/public/shares/${slug}`)).json()).share.message, 'Zweite Nachricht ' + stamp);
  });
}

function base32Encode(buf) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += A[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
