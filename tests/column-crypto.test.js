// node --test tests/column-crypto.test.js  (Unit-Test, kein Stack nötig)
// Phase P3: Spaltenverschlüsselung (app/column-crypto.js) und .env-Rückschreiben ohne Secrets (app/env-file.js).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cs = require('../app/crypto-store');
const { encryptColumn, decryptColumn, isEncryptedColumn } = require('../app/column-crypto');
const { updateEnvFile } = require('../app/env-file');

const K1 = crypto.randomBytes(32);
const K2 = crypto.randomBytes(32);
const CTX = 'settings.email_smtp_pass';
test.afterEach(() => cs.useKeys(null));

const codeOf = (fn) => { try { fn(); } catch (e) { return e; } assert.fail('kein Fehler'); };

test('Roundtrip: leer, Unicode, 1 MB, Format enc:v1:<keyId>:<base64>', () => {
  cs.useKeys(K1);
  for (const v of ['', 'a', 'Grüße 🌍 日本語 \u0000 "quote"', 'x'.repeat(1 << 20)]) {
    const e = encryptColumn(v, CTX);
    assert.match(e, /^enc:v1:1:[A-Za-z0-9+/]+=*$/);
    assert.ok(isEncryptedColumn(e));
    assert.strictEqual(decryptColumn(e, CTX), v);
  }
});

test('Zwei Verschlüsselungen desselben Werts unterscheiden sich (Zufallsnonce), Klartext steht nicht im Wert', () => {
  cs.useKeys(K1);
  const a = encryptColumn('geheim-geheim', CTX), b = encryptColumn('geheim-geheim', CTX);
  assert.notStrictEqual(a, b);
  assert.ok(!Buffer.from(a.split(':')[3], 'base64').includes('geheim'));
});

test('null/undefined werden durchgereicht, Klartext mit Key bleibt lesbar (Übergang)', () => {
  cs.useKeys(K1);
  assert.strictEqual(encryptColumn(null, CTX), null);
  assert.strictEqual(encryptColumn(undefined, CTX), undefined);
  assert.strictEqual(decryptColumn(null, CTX), null);
  assert.strictEqual(decryptColumn('altes-klartext-passwort', CTX), 'altes-klartext-passwort');
  assert.strictEqual(decryptColumn('', CTX), '');
});

test('Passthrough ohne Key (E16): Klartext rein, Klartext raus', () => {
  cs.useKeys(null);
  assert.strictEqual(encryptColumn('abc', CTX), 'abc');
  assert.strictEqual(decryptColumn('abc', CTX), 'abc');
});

test('enc:v1:-Wert ohne Key -> deutscher Fehler COLUMN_NO_KEY, kein Klartext', () => {
  cs.useKeys(K1);
  const e = encryptColumn('abc', CTX);
  cs.useKeys(null);
  const err = codeOf(() => decryptColumn(e, CTX));
  assert.strictEqual(err.code, 'COLUMN_NO_KEY');
  assert.match(err.message, /verschlüsselt.*kein Master-Key/);
});

test('Context-Bindung: Wert aus anderer Spalte wird abgelehnt', () => {
  cs.useKeys(K1);
  const e = encryptColumn('abc', 'shares.message');
  assert.strictEqual(codeOf(() => decryptColumn(e, 'users.totp_secret')).code, 'COLUMN_DECRYPT');
  assert.strictEqual(decryptColumn(e, 'shares.message'), 'abc');
});

test('Manipulation: Nonce, Ciphertext, Tag, Abschneiden -> COLUMN_DECRYPT/COLUMN_FORMAT', () => {
  cs.useKeys(K1);
  const e = encryptColumn('abcdefgh', CTX);
  const raw = Buffer.from(e.split(':')[3], 'base64');
  const mk = (b) => `enc:v1:1:${b.toString('base64')}`;
  for (const pos of [0, 11, 12, raw.length - 1]) {
    const t = Buffer.from(raw); t[pos] ^= 1;
    assert.strictEqual(codeOf(() => decryptColumn(mk(t), CTX)).code, 'COLUMN_DECRYPT', 'Bit ' + pos);
  }
  assert.strictEqual(codeOf(() => decryptColumn(mk(raw.subarray(0, raw.length - 1)), CTX)).code, 'COLUMN_DECRYPT');
  assert.strictEqual(codeOf(() => decryptColumn(mk(raw.subarray(0, 20)), CTX)).code, 'COLUMN_FORMAT');
});

test('Formatfehler werden streng abgelehnt', () => {
  cs.useKeys(K1);
  const good = encryptColumn('abc', CTX);
  const b64 = good.split(':')[3];
  for (const bad of ['enc:v1:', 'enc:v1:1:', 'enc:v1:1:!!!!', 'enc:v1:0:' + b64, 'enc:v1:x:' + b64, 
    'enc:v1:1:' + b64 + ':extra', 'enc:v1:1:' + b64 + ' ', 'enc:v1:1:' + b64.replace(/=+$/, ''), 'enc:v1:01:' + b64, 'enc:v1:1:' + b64.slice(0, -2)]) {
    const err = codeOf(() => decryptColumn(bad, CTX));
    assert.ok(['COLUMN_FORMAT', 'COLUMN_KEY_UNKNOWN', 'COLUMN_DECRYPT'].includes(err.code), bad + ' -> ' + err.code);
  }
  assert.strictEqual(codeOf(() => decryptColumn('enc:v1:1:!!!!', CTX)).code, 'COLUMN_FORMAT');
});

test('Fehlender Kontext -> Fehler', () => {
  cs.useKeys(K1);
  assert.strictEqual(codeOf(() => encryptColumn('a', '')).code, 'COLUMN_CONTEXT');
  assert.strictEqual(codeOf(() => decryptColumn('enc:v1:1:AAAA', undefined)).code, 'COLUMN_CONTEXT');
});

test('Falscher Master-Key -> COLUMN_DECRYPT, nie ein (leerer) Wert', () => {
  cs.useKeys(K1);
  const e = encryptColumn('abc', CTX);
  cs.useKeys(K2);
  assert.strictEqual(codeOf(() => decryptColumn(e, CTX)).code, 'COLUMN_DECRYPT');
});

test('keyId-Auswahl: Schreiben mit current, Lesen mit der keyId aus dem Wert (Rotation)', () => {
  cs.useKeys({ current: 1, keys: new Map([[1, K1]]) });
  const old = encryptColumn('alt', CTX);
  cs.useKeys({ current: 2, keys: new Map([[1, K1], [2, K2]]) });
  const neu = encryptColumn('neu', CTX);
  assert.match(old, /^enc:v1:1:/);
  assert.match(neu, /^enc:v1:2:/);
  assert.strictEqual(decryptColumn(old, CTX), 'alt');
  assert.strictEqual(decryptColumn(neu, CTX), 'neu');
  // Key 1 entfernt: alter Wert nicht mehr lesbar (klarer Fehler)
  cs.useKeys({ current: 2, keys: new Map([[2, K2]]) });
  assert.strictEqual(codeOf(() => decryptColumn(old, CTX)).code, 'COLUMN_KEY_UNKNOWN');
  assert.strictEqual(decryptColumn(neu, CTX), 'neu');
});

test('F3: updateEnvFile schreibt keine Secrets, nicht-geheime Werte weiter, vorhandene Secret-Zeilen bleiben unberührt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3env-'));
  const f = path.join(dir, '.env');
  try {
    fs.writeFileSync(f, 'EMAIL_SMTP_HOST=alt\nEMAIL_SMTP_PASS=vorhanden\nOTHER=1');
    updateEnvFile({
      email_smtp_host: 'smtp.example', email_smtp_user: 'u', email_smtp_pass: 'GEHEIM-1', sso_client_secret: 'GEHEIM-2',
      sso_client_id: 'cid', sso_issuer_url: 'https://i/', registration_enabled: 'true', session_secret: 'GEHEIM-3',
    }, f);
    const c = fs.readFileSync(f, 'utf8');
    assert.ok(!c.includes('GEHEIM'), c);
    assert.ok(!c.includes('SSO_CLIENT_SECRET'));
    assert.match(c, /^EMAIL_SMTP_HOST=smtp\.example$/m);
    assert.match(c, /^EMAIL_SMTP_USER=u$/m);
    assert.match(c, /^SSO_CLIENT_ID=cid$/m);
    assert.match(c, /^EMAIL_SMTP_PASS=vorhanden$/m);
    assert.match(c, /^OTHER=1$/m);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Klartext-Escape: ohne Key wird Klartext mit enc:v1:-Prefix als enc:v1:p:<base64> gespeichert und gelesen (mit und ohne Key)', () => {
  cs.useKeys(null);
  for (const v of ['enc:v1:foo', 'enc:v1:', 'enc:v1:1:AAAA', 'enc:v1:p:xyz ä']) {
    const e = encryptColumn(v, CTX);
    assert.match(e, /^enc:v1:p:[A-Za-z0-9+/]+=*$/);
    assert.strictEqual(decryptColumn(e, CTX), v);
    cs.useKeys(K1);
    assert.strictEqual(decryptColumn(e, CTX), v, 'auch mit Key lesbar (bis zur Migration)');
    cs.useKeys(null);
  }
  assert.strictEqual(encryptColumn('normal', CTX), 'normal', 'sonstiger Klartext bleibt unverändert');
  assert.strictEqual(codeOf(() => decryptColumn('enc:v1:p:!!', CTX)).code, 'COLUMN_FORMAT');
  assert.strictEqual(codeOf(() => decryptColumn('enc:v1:p:' + Buffer.from('a').toString('base64').replace('=', ''), CTX)).code, 'COLUMN_FORMAT');
});

test('Mit Key wird Klartext mit enc:v1:-Prefix normal verschlüsselt', () => {
  cs.useKeys(K1);
  const e = encryptColumn('enc:v1:foo', CTX);
  assert.match(e, /^enc:v1:1:/);
  assert.strictEqual(decryptColumn(e, CTX), 'enc:v1:foo');
  assert.strictEqual(codeOf(() => decryptColumn('enc:v1:foo', CTX)).code, 'COLUMN_FORMAT');
});
