// node --test tests/p3-units.test.js  (Unit-Tests ohne Stack, Fake-DB)
// Phase P3: Spaltenmigration (parallele Änderung, size, Prefix-Klartext, unlesbare Werte), getAllSettings und Seeding.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const cs = require('../app/crypto-store');
const { encryptColumn, decryptColumn } = require('../app/column-crypto');
const { createColumnMigration, countColumns } = require('../app/column-migration');
const db = require('../app/db');

const K1 = crypto.randomBytes(32), K2 = crypto.randomBytes(32);
test.afterEach(() => cs.useKeys(null));
const silent = () => { const l = { errors: [], log() {}, error(...a) { l.errors.push(a.join(' ')); } }; return l; };

// Fake-Pool: je Tabelle ein Array von Zeilen; versteht die SELECT-/UPDATE-Formen der Migration.
function fakePool(tables, { beforeUpdate } = {}) {
  const idCol = { settings: 'key' };
  return {
    async query(sql, p) {
      let m = /^\s*SELECT (\w+) AS id, (\w+) AS val FROM (\w+)/.exec(sql);
      if (m) {
        const [, id, col, table] = m;
        const rows = tables[table].filter((r) => r[col] != null && r[col] !== '' && r[id] > p[0]).sort((a, b) => (a[id] > b[id] ? 1 : -1)).slice(0, p[1]);
        return { rows: rows.map((r) => ({ id: r[id], val: r[col] })) };
      }
      m = /^\s*UPDATE (\w+) SET (\w+) = \$1(, size = COALESCE\(size, \$4\))? WHERE (\w+) = \$2 AND \w+ = \$3/.exec(sql);
      if (m) {
        const [, table, col, withSize, id] = m;
        if (beforeUpdate) beforeUpdate(table, p);
        const r = tables[table].find((x) => x[id] === p[1]);
        if (!r || r[col] !== p[2]) return { rowCount: 0 };
        r[col] = p[0];
        if (withSize && r.size == null) r.size = p[3];
        return { rowCount: 1 };
      }
      throw new Error('unerwartetes SQL: ' + sql);
    },
  };
}
const empty = () => ({ users: [], settings: [], file_versions: [], shares: [] });
async function runMig(pool, log = silent()) {
  const mig = createColumnMigration({ pool, log, pauseMs: 0 });
  assert.ok(mig.start());
  await mig.done;
  return { mig, log };
}

test('Migration: Klartext, Klartext mit enc:v1:-Prefix und Escape werden verschlüsselt, size gesetzt, gültige Werte übersprungen', async () => {
  cs.useKeys(K1);
  const t = empty();
  t.users.push({ id: 1, totp_secret: 'JBSWY3DP' });
  t.settings.push({ key: 'email_smtp_pass', value: 'pw' }, { key: 'sso_client_secret', value: '' });
  const already = encryptColumn('schon', 'file_versions.content');
  cs.useKeys(null);
  const escaped = encryptColumn('enc:v1:escaped äö', 'file_versions.content');
  cs.useKeys(K1);
  t.file_versions.push(
    { id: 1, content: 'alt ä🌍', size: null }, { id: 2, content: 'enc:v1:foo', size: null }, { id: 3, content: 'enc:v1:1:', size: 9 },
    { id: 4, content: already, size: 5 }, { id: 5, content: escaped, size: null }, { id: 6, content: null, size: null });
  t.shares.push({ id: 1, message: 'hi' });
  const { mig } = await runMig(fakePool(t));
  assert.strictEqual(mig.getState().failed, 0);
  assert.ok(t.users[0].totp_secret.startsWith('enc:v1:1:'));
  assert.ok(t.settings[0].value.startsWith('enc:v1:1:'));
  assert.strictEqual(t.settings[1].value, '');
  assert.strictEqual(t.file_versions[3].content, already, 'gültiger Wert unangetastet (kein Doppel-Encrypt)');
  const plain = ['alt ä🌍', 'enc:v1:foo', 'enc:v1:1:', null, 'enc:v1:escaped äö'];
  for (const [i, exp] of [[0, plain[0]], [1, plain[1]], [2, plain[2]], [4, plain[4]]]) {
    assert.strictEqual(decryptColumn(t.file_versions[i].content, 'file_versions.content'), exp);
  }
  assert.strictEqual(t.file_versions[0].size, 5, 'size aus Klartext (Zeichen) bei NULL gesetzt');
  assert.strictEqual(t.file_versions[1].size, 10);
  assert.strictEqual(t.file_versions[2].size, 9, 'vorhandene size bleibt');
  assert.strictEqual(t.file_versions[4].size, 17, 'size des dekodierten Klartexts, nicht des Escapes');
  assert.strictEqual(t.file_versions[5].content, null);
  // zweiter Lauf: nichts ändert sich
  const snap = JSON.stringify(t);
  await runMig(fakePool(t));
  assert.strictEqual(JSON.stringify(t), snap);
});

test('Migration: parallele Änderung (UPDATE rowCount 0) -> übersprungen, geänderter Wert bleibt', async () => {
  cs.useKeys(K1);
  const t = empty();
  t.shares.push({ id: 1, message: 'alt' }, { id: 2, message: 'zwei' });
  const pool = fakePool(t, { beforeUpdate: (table, p) => { if (p[1] === 1) t.shares[0].message = 'parallel geändert'; } });
  const { mig } = await runMig(pool);
  assert.strictEqual(t.shares[0].message, 'parallel geändert');
  assert.ok(t.shares[1].message.startsWith('enc:v1:'));
  assert.strictEqual(mig.getState().migrated, 1);
  assert.strictEqual(mig.getState().skipped, 1);
});

test('Migration: unlesbare Werte (fremder Key, manipuliert, unbekannte keyId) bleiben unverändert, werden gezählt, Log ohne Wert', async () => {
  cs.useKeys(K2);
  const foreign = encryptColumn('geheimes-fremdes-secret', 'shares.message');
  cs.useKeys(K1);
  const good = encryptColumn('x', 'shares.message');
  const raw = Buffer.from(good.split(':')[3], 'base64'); raw[raw.length - 1] ^= 1;
  const tampered = 'enc:v1:1:' + raw.toString('base64');
  const unknownKey = 'enc:v1:99:' + good.split(':')[3];
  const t = empty();
  t.shares.push({ id: 1, message: foreign }, { id: 2, message: tampered }, { id: 3, message: unknownKey }, { id: 4, message: 'ok' });
  const { mig, log } = await runMig(fakePool(t));
  assert.deepStrictEqual([t.shares[0].message, t.shares[1].message, t.shares[2].message], [foreign, tampered, unknownKey]);
  assert.ok(t.shares[3].message.startsWith('enc:v1:1:'));
  assert.strictEqual(mig.getState().unreadable, 3);
  assert.strictEqual(mig.getState().unreadableByColumn['shares.message'], 3);
  const logged = log.errors.join('\n');
  assert.match(logged, /COLUMN_DECRYPT/);
  assert.match(logged, /COLUMN_KEY_UNKNOWN/);
  assert.ok(!logged.includes('geheimes') && !logged.includes(foreign) && !logged.includes(tampered));
});

test('Migration ohne Key: nichts wird verändert', async () => {
  cs.useKeys(null);
  const t = empty();
  t.shares.push({ id: 1, message: 'klar' });
  await runMig(fakePool(t));
  assert.strictEqual(t.shares[0].message, 'klar');
});

test('countColumns: Cache 15 s und cache:false', async () => {
  let n = 0;
  const pool = { async query() { n++; return { rows: [{ total: 2, encrypted: 1 }] }; } };
  const a = await countColumns(pool, { cache: false });
  assert.strictEqual(a['shares.message'].plain, 1);
  const calls = n;
  await countColumns(pool); await countColumns(pool);
  assert.strictEqual(n, calls + 4, 'erster gecachter Aufruf rechnet, zweiter nicht');
});

test('getAllSettings crasht nicht bei nicht entschlüsselbarem Secret; getSetting wirft (fail closed, kein env-Fallback)', async () => {
  cs.useKeys(K1);
  const enc = encryptColumn('pw', 'settings.email_smtp_pass');
  cs.useKeys(null);
  const orig = db.pool.query;
  db.pool.query = async (sql) => (/FROM settings WHERE key/.test(sql)
    ? { rows: [{ value: enc }] }
    : { rows: [{ key: 'email_smtp_pass', value: enc }, { key: 'cloud_name', value: 'X' }] });
  const errs = [];
  const origErr = console.error; console.error = (...a) => errs.push(a.join(' '));
  try {
    const all = await db.getAllSettings();
    assert.strictEqual(all.cloud_name, 'X');
    assert.ok(all.email_smtp_pass, 'Secret bleibt als "gesetzt" erkennbar');
    await assert.rejects(db.getSetting('email_smtp_pass'), (e) => e.code === 'COLUMN_NO_KEY');
    assert.strictEqual(await db.getSetting('cloud_name'), 'X');
    assert.ok(errs.some((l) => /Secret email_smtp_pass nicht lesbar: COLUMN_NO_KEY/.test(l)));
    assert.ok(!errs.join('\n').includes(enc));
  } finally { db.pool.query = orig; console.error = origErr; }
});

test('Seeding aus process.env (E16 ohne Key): Klartext, nur bei leerem DB-Wert; Warnung bei abweichendem DB-Wert (ohne Werte)', async () => {
  const origConnect = db.pool.connect;
  const saved = { p: process.env.EMAIL_SMTP_PASS, s: process.env.SSO_CLIENT_SECRET };
  const warns = [];
  const origWarn = console.warn, origLog = console.log; console.warn = (...a) => warns.push(a.join(' ')); console.log = () => {};
  const run = async (existing) => {
    const calls = [];
    db.pool.connect = async () => ({
      async query(sql, p) {
        calls.push([sql, p]);
        if (/SELECT value FROM settings WHERE key/.test(sql)) return { rows: existing[p[0]] != null ? [{ value: existing[p[0]] }] : [] };
        return { rows: [], rowCount: 0 };
      }, release() {},
    });
    await db.initDb();
    return calls;
  };
  try {
    cs.useKeys(null);
    process.env.EMAIL_SMTP_PASS = 'env-pass-GEHEIM'; process.env.SSO_CLIENT_SECRET = 'env-sso-GEHEIM';
    let calls = await run({ email_smtp_pass: 'db-pass', sso_client_secret: '' });
    const up = calls.filter(([sql, p]) => /INSERT INTO settings/.test(sql) && ['email_smtp_pass', 'sso_client_secret'].includes(p[0]));
    assert.deepStrictEqual(up.map(([, p]) => p[1]), ['env-pass-GEHEIM', 'env-sso-GEHEIM'], 'Klartext wie bisher');
    assert.ok(up.every(([sql]) => /WHERE settings\.value IS NULL OR settings\.value = ''/.test(sql)), 'überschreibt keinen DB-Wert');
    assert.strictEqual(warns.filter((w) => /EMAIL_SMTP_PASS in \.env weicht von der Datenbank ab und wird ignoriert/.test(w)).length, 1);
    assert.ok(!warns.some((w) => /SSO_CLIENT_SECRET/.test(w)), 'leerer DB-Wert: keine Warnung');
    assert.ok(!warns.join('\n').includes('GEHEIM') && !warns.join('\n').includes('db-pass'));
    // mit Key: Seed verschlüsselt, Vergleich mit entschlüsseltem DB-Wert (gleich -> keine Warnung)
    cs.useKeys(K1);
    warns.length = 0;
    calls = await run({ email_smtp_pass: encryptColumn('env-pass-GEHEIM', 'settings.email_smtp_pass') });
    const up2 = calls.filter(([sql, p]) => /INSERT INTO settings/.test(sql) && p[0] === 'email_smtp_pass');
    assert.match(up2[0][1][1], /^enc:v1:1:/);
    assert.strictEqual(warns.length, 0);
  } finally {
    db.pool.connect = origConnect; console.warn = origWarn; console.log = origLog;
    for (const [k, v] of [['EMAIL_SMTP_PASS', saved.p], ['SSO_CLIENT_SECRET', saved.s]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
