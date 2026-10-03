// node --test tests/p2c-migration.test.js
// Phase P2c (Migration bestehender Dateien, E14). Teil 1: Unit-Tests mit Fake-Storage (ohne Stack). Teil 2: HTTP-/Container-Tests
// gegen den Test-Stack (TEST_BASE): im normalen Stack nur Zugriffsschutz und E16 (kein Key -> nichts passiert), im
// verschlüsselten Stack (TEST_ENCRYPTED=1) die komplette Migration inklusive Abbruch/Wiederaufnahme.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { execFileSync, execSync } = require('node:child_process');
const { BASE, COMPOSE_ARGS, COMPOSE_CMD, ROOT } = require('./_env');
const cryptoStore = require('../app/crypto-store');
const { createMigration } = require('../app/encrypt-migration');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/* ---------------- Teil 1: Unit-Tests mit Fake-Storage ---------------- */

const { createOutbox } = require('../app/blob-outbox');
const readAll = (p) => new Promise((res, rej) => { const c = []; const st = cryptoStore.createDecryptStream(p, { encrypted: true }); st.on('data', (d) => c.push(d)); st.on('end', () => res(Buffer.concat(c))); st.on('error', rej); });

function fakeEnv({ store = cryptoStore, swapHook, newBlobHook } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2c-'));
  const rows = new Map();
  const users = new Map();
  const outboxRows = new Set();
  const state = { failDelete: false };
  const silent = { log() {}, error() {} };
  const run = async (sql, p) => {
    if (sql.startsWith('SELECT id, owner_id')) return { rows: [...rows.values()].filter((r) => r.enc_version == null && r.id > p[0]).sort((a, b) => a.id - b.id).slice(0, p[1]) };
    if (sql.startsWith('SELECT path, enc_version')) return { rows: rows.has(p[0]) ? [rows.get(p[0])] : [] };
    if (sql.startsWith('SELECT 1 FROM files WHERE path = $1 AND id')) return { rows: [...rows.values()].filter((r) => r.path === p[0] && r.id !== p[1]).slice(0, 1) };
    if (sql.startsWith('SELECT 1 FROM files WHERE path = $1')) {
      const hit = [...rows.values()].some((r) => r.path === p[0]) || [...users.values()].some((u) => u.avatar_path === p[0]);
      return { rows: hit ? [{}] : [] };
    }
    if (sql.startsWith('UPDATE files SET enc_version = 1')) {
      const r = rows.get(p[1]);
      if (!r || r.path !== p[2] || r.enc_version != null) return { rowCount: 0 };
      Object.assign(r, { enc_version: 1, content_hash: p[0] });
      return { rowCount: 1 };
    }
    if (sql.startsWith('SELECT id, avatar_path')) return { rows: [...users.values()].filter((u) => u.avatar_path && !u.avatar_path.endsWith('.enc')).map((u) => ({ ...u })) };
    if (sql.startsWith('UPDATE users SET avatar_path')) {
      const u = users.get(p[1]);
      if (!u || u.avatar_path !== p[2]) return { rowCount: 0 };
      u.avatar_path = p[0];
      return { rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO pending_blob_deletes')) { outboxRows.add(p[0]); return { rowCount: 1 }; }
    if (sql.startsWith('DELETE FROM pending_blob_deletes')) { outboxRows.delete(p[0]); return { rowCount: 1 }; }
    if (sql.startsWith('SELECT path FROM pending_blob_deletes')) return { rows: [...outboxRows].map((x) => ({ path: x })) };
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return {};
    throw new Error('unerwartetes SQL: ' + sql);
  };
  const pool = { query: run, connect: async () => ({ query: run, release() {} }) };
  const blobOutbox = createOutbox({ pool, uploadsDir: dir, deleteBlob: (abs) => fs.rmSync(abs, { force: true }), minAgeMs: 0, log: silent });
  const swapFileBlob = async (id, cols, opts) => {
    if (swapHook) swapHook(rows.get(id));
    const r = rows.get(id);
    if (!r) throw new Error('weg');
    if (opts.expectPath !== undefined && r.path !== opts.expectPath) throw new Error('geändert');
    const oldPath = path.join(dir, r.path);
    if (cols.path !== r.path) await blobOutbox.enqueue(pool, r.path);
    Object.assign(r, cols);
    return { ok: true, row: r, oldPath };
  };
  const newBlobPath = (owner, name) => {
    const f = crypto.randomUUID() + path.extname(name);
    fs.mkdirSync(path.join(dir, String(owner)), { recursive: true });
    const out = { relativePath: `${owner}/${f}`, absPath: path.join(dir, String(owner), f) };
    if (newBlobHook) newBlobHook(out);
    return out;
  };
  const tryDeleteBlob = (p) => { if (state.failDelete) return; fs.rmSync(p, { force: true }); outboxRows.delete(path.relative(dir, p)); };
  const mig = createMigration({
    pool, cryptoStore: store, uploadsDir: dir, thumbnailsDir: path.join(dir, 'thumbnails'),
    swapFileBlob, tryDeleteBlob, newBlobPath, log: silent, pauseMs: 0, blobOutbox, detectAvatarExt: async () => 'png',
  });
  const addPlain = (id, data, size = data.length) => {
    fs.mkdirSync(path.join(dir, '1'), { recursive: true });
    const rel = `1/${crypto.randomUUID()}.bin`;
    fs.writeFileSync(path.join(dir, rel), data);
    const row = { id, owner_id: 1, name: 'f.bin', path: rel, size, enc_version: null, content_hash: null };
    rows.set(id, row);
    return row;
  };
  const files = () => fs.readdirSync(path.join(dir, '1'));
  return { dir, rows, users, outboxRows, state, mig, blobOutbox, addPlain, files, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test.before(() => cryptoStore.useKeys(crypto.randomBytes(32)));
test.after(() => cryptoStore.useKeys(null));

test('Unit: Datei wird migriert, Alt-Blob gelöscht, Hash/Größe stimmen, Outbox leer', async () => {
  const env = fakeEnv();
  try {
    const data = crypto.randomBytes(200000);
    const row = env.addPlain(1, data);
    const old = row.path;
    assert.strictEqual(await env.mig.migrateFile({ ...row }), 'migrated');
    const cur = env.rows.get(1);
    assert.strictEqual(cur.enc_version, 1);
    assert.strictEqual(cur.content_hash, sha(data));
    assert.notStrictEqual(cur.path, old);
    assert.ok(!fs.existsSync(path.join(env.dir, old)), 'Alt-Blob gelöscht');
    assert.strictEqual(env.files().length, 1);
    assert.ok((await readAll(path.join(env.dir, cur.path))).equals(data));
    assert.strictEqual(env.outboxRows.size, 0);
  } finally { env.cleanup(); }
});

test('Unit: manipulierter neuer Blob -> failed, Alt-Blob bleibt, kein Rest', async () => {
  const tampering = { ...cryptoStore, createDecryptStream: (p, o) => (p.includes('.enc-tmp-') ? Readable.from([Buffer.from('manipuliert')]) : cryptoStore.createDecryptStream(p, o)) };
  const env = fakeEnv({ store: tampering });
  try {
    const data = crypto.randomBytes(5000);
    const row = env.addPlain(1, data);
    assert.strictEqual(await env.mig.migrateFile({ ...row }), 'failed');
    assert.strictEqual(env.rows.get(1).enc_version, null);
    assert.strictEqual(env.rows.get(1).path, row.path);
    assert.ok(fs.readFileSync(path.join(env.dir, row.path)).equals(data), 'Alt-Blob unangetastet');
    assert.deepStrictEqual(env.files(), [path.basename(row.path)]);
  } finally { env.cleanup(); }
});

test('Fehlerinjektion: writeEncrypted wirft -> failed, Zeile und Alt-Blob unverändert, kein Rest', async () => {
  const failing = { ...cryptoStore, writeEncrypted: async (p, input) => { input.destroy(); throw new Error('Platte voll'); } };
  const env = fakeEnv({ store: failing });
  try {
    const data = crypto.randomBytes(5000);
    const row = env.addPlain(1, data);
    assert.strictEqual(await env.mig.migrateFile({ ...row }), 'failed');
    assert.deepStrictEqual([env.rows.get(1).enc_version, env.rows.get(1).path], [null, row.path]);
    assert.deepStrictEqual(env.files(), [path.basename(row.path)]);
    assert.strictEqual(env.outboxRows.size, 0);
  } finally { env.cleanup(); }
});

test('Fehlerinjektion: rename wirft -> failed, Staging-Blob und Outbox-Eintrag weg', async () => {
  // Am Zielnamen liegt ein nicht leeres Verzeichnis: rename(Datei, Verzeichnis) schlägt fehl
  const env = fakeEnv({ newBlobHook: (b) => { fs.mkdirSync(b.absPath); fs.writeFileSync(path.join(b.absPath, 'x'), '1'); } });
  try {
    const data = crypto.randomBytes(5000);
    const row = env.addPlain(1, data);
    assert.strictEqual(await env.mig.migrateFile({ ...row }), 'failed');
    assert.deepStrictEqual([env.rows.get(1).enc_version, env.rows.get(1).path], [null, row.path]);
    assert.ok(fs.readFileSync(path.join(env.dir, row.path)).equals(data));
    assert.ok(!env.files().some((f) => f.includes('tmp-')), 'Staging weg: ' + env.files());
    assert.strictEqual(env.outboxRows.size, 0);
  } finally { env.cleanup(); }
});

test('Fehlerinjektion: DB-Swap wirft -> Zeile unverändert, neuer Blob weg, Alt-Blob bleibt', async () => {
  const env = fakeEnv({ swapHook: () => { throw new Error('DB weg'); } });
  try {
    const data = crypto.randomBytes(5000);
    const row = env.addPlain(1, data);
    await assert.rejects(env.mig.migrateFile({ ...row }), /DB weg/);
    assert.deepStrictEqual([env.rows.get(1).enc_version, env.rows.get(1).path], [null, row.path]);
    assert.deepStrictEqual(env.files(), [path.basename(row.path)]);
    assert.strictEqual(env.outboxRows.size, 0);
  } finally { env.cleanup(); }
});

test('Fehlerinjektion: Abbruch nach Commit vor dem Löschen -> Outbox hält den Alt-Blob, Worker löscht ihn', async () => {
  const env = fakeEnv();
  try {
    const data = crypto.randomBytes(5000);
    const row = env.addPlain(1, data);
    const oldRel = row.path;
    env.state.failDelete = true; // simuliert: Prozess endet nach dem Commit, bevor tryDeleteBlob läuft
    assert.strictEqual(await env.mig.migrateFile({ ...row }), 'migrated');
    assert.strictEqual(env.rows.get(1).enc_version, 1);
    assert.ok(fs.existsSync(path.join(env.dir, oldRel)), 'Klartext-Alt-Blob liegt noch da');
    assert.deepStrictEqual([...env.outboxRows], [oldRel]);
    env.state.failDelete = false;
    const r = await env.blobOutbox.sweep(0);
    assert.strictEqual(r.deleted, 1);
    assert.ok(!fs.existsSync(path.join(env.dir, oldRel)), 'Alt-Blob nach dem Worker weg');
    assert.strictEqual(env.outboxRows.size, 0);
    assert.ok((await readAll(path.join(env.dir, env.rows.get(1).path))).equals(data));
  } finally { env.cleanup(); }
});

test('Unit: files.size weicht von der Klartextgröße ab -> failed, nichts verändert', async () => {
  const env = fakeEnv();
  try {
    const row = env.addPlain(1, crypto.randomBytes(5000), 4999);
    assert.strictEqual(await env.mig.migrateFile({ ...row }), 'failed');
    assert.deepStrictEqual(env.files(), [path.basename(row.path)]);
    assert.strictEqual(env.rows.get(1).enc_version, null);
  } finally { env.cleanup(); }
});

test('Unit: Race (Zeile zwischenzeitlich per Copy-on-Write ersetzt) -> neuer Blob verworfen, Zeile konsistent', async () => {
  let replacedPath;
  const env = fakeEnv({ swapHook: (r) => { replacedPath = '1/replaced.bin'; fs.writeFileSync(path.join(env.dir, replacedPath), 'neuer Inhalt'); r.path = replacedPath; r.enc_version = 1; } });
  try {
    const row = env.addPlain(1, crypto.randomBytes(3000));
    const origName = path.basename(row.path);
    assert.strictEqual(await env.mig.migrateFile({ ...row }), 'skipped');
    assert.strictEqual(env.rows.get(1).path, replacedPath);
    assert.ok(!env.files().some((f) => f !== 'replaced.bin' && f !== origName), 'neuer Blob muss weg sein: ' + env.files());
    assert.ok(fs.existsSync(path.join(env.dir, replacedPath)));
    assert.strictEqual(env.outboxRows.size, 0);
  } finally { env.cleanup(); }
});

test('Unit: bereits verschlüsselter Blob mit enc_version NULL -> nur Spalte nachziehen (nicht doppelt verschlüsseln)', async () => {
  const env = fakeEnv();
  try {
    const data = crypto.randomBytes(70000);
    const row = env.addPlain(1, Buffer.alloc(0));
    await cryptoStore.writeEncrypted(path.join(env.dir, row.path), Readable.from([data]));
    row.size = data.length;
    const before = fs.readFileSync(path.join(env.dir, row.path));
    assert.strictEqual(await env.mig.migrateFile({ ...row }), 'adopted');
    assert.strictEqual(env.rows.get(1).enc_version, 1);
    assert.strictEqual(env.rows.get(1).content_hash, sha(data));
    assert.ok(fs.readFileSync(path.join(env.dir, row.path)).equals(before), 'Blob unverändert');
    assert.strictEqual(env.files().length, 1);
  } finally { env.cleanup(); }
});

test('Unit: Klartextdatei, die mit MCENC1 beginnt, wird normal migriert und bleibt byteidentisch lesbar', async () => {
  const env = fakeEnv();
  try {
    const data = Buffer.concat([Buffer.from('MCENC1\0\0', 'latin1'), crypto.randomBytes(500)]);
    const row = env.addPlain(1, data);
    assert.strictEqual(await env.mig.migrateFile({ ...row }), 'migrated');
    const cur = env.rows.get(1);
    assert.strictEqual(cur.enc_version, 1);
    assert.ok((await readAll(path.join(env.dir, cur.path))).equals(data));
    assert.strictEqual(env.files().length, 1);
  } finally { env.cleanup(); }
});

test('Unit: fehlender Blob -> missing; kompletter Lauf zählt, zweiter Lauf idempotent', async () => {
  const env = fakeEnv();
  try {
    env.addPlain(1, crypto.randomBytes(100));
    env.rows.set(2, { id: 2, owner_id: 1, name: 'weg.bin', path: '1/gibt-es-nicht.bin', size: 5, enc_version: null });
    env.addPlain(3, crypto.randomBytes(100));
    assert.ok(env.mig.start());
    assert.strictEqual(env.mig.start(), false, 'zweiter Start während des Laufs');
    await env.mig.done;
    const s = env.mig.getState();
    assert.deepStrictEqual([s.running, s.migrated, s.missing, s.failed], [false, 2, 1, 0]);
    const snapshot = env.files().join();
    env.mig.start(); await env.mig.done;
    assert.strictEqual(env.mig.getState().migrated, 0);
    assert.strictEqual(env.files().join(), snapshot);
  } finally { env.cleanup(); }
});

test('Unit: Avatar-Migration verschlüsselt, hängt um, Klartext weg, Outbox leer', async () => {
  const env = fakeEnv();
  try {
    fs.writeFileSync(path.join(env.dir, 'alt.png'), PNG);
    env.users.set(7, { id: 7, avatar_path: 'alt.png' });
    env.mig.start(); await env.mig.done;
    const ap = env.users.get(7).avatar_path;
    assert.match(ap, /^[0-9a-f-]{36}\.png\.enc$/);
    assert.ok(!fs.existsSync(path.join(env.dir, 'alt.png')));
    assert.ok((await readAll(path.join(env.dir, ap))).equals(PNG));
    assert.strictEqual(env.mig.getState().avatarsMigrated, 1);
    assert.strictEqual(env.outboxRows.size, 0);
  } finally { env.cleanup(); }
});

test('Unit: Avatar, Abbruch zwischen UPDATE und unlink -> Outbox löscht den Klartext später', async () => {
  const env = fakeEnv();
  try {
    fs.writeFileSync(path.join(env.dir, 'alt.png'), PNG);
    env.users.set(7, { id: 7, avatar_path: 'alt.png' });
    env.state.failDelete = true;
    env.mig.start(); await env.mig.done;
    assert.ok(fs.existsSync(path.join(env.dir, 'alt.png')), 'Klartext noch da');
    assert.deepStrictEqual([...env.outboxRows], ['alt.png']);
    env.state.failDelete = false;
    await env.blobOutbox.sweep(0);
    assert.ok(!fs.existsSync(path.join(env.dir, 'alt.png')));
    assert.ok(fs.existsSync(path.join(env.dir, env.users.get(7).avatar_path)), 'neuer Avatar bleibt');
  } finally { env.cleanup(); }
});

test('Outbox-Worker: referenzierter Pfad bleibt, unreferenzierter wird gelöscht, ENOENT ok, Pfad außerhalb ignoriert, Blockade pausiert', async () => {
  const env = fakeEnv();
  try {
    const keep = env.addPlain(1, Buffer.from('lebt'));
    fs.mkdirSync(path.join(env.dir, '1'), { recursive: true });
    fs.writeFileSync(path.join(env.dir, '1', 'waise.bin'), 'x');
    fs.writeFileSync(path.join(env.dir, 'avatar.png'), PNG);
    env.users.set(9, { id: 9, avatar_path: 'avatar.png' });
    for (const p of [keep.path, '1/waise.bin', '1/schon-weg.bin', 'avatar.png', '../ausserhalb.bin']) env.outboxRows.add(p);
    const outside = path.join(env.dir, '..', 'ausserhalb.bin');
    fs.writeFileSync(outside, 'darf bleiben');
    let blocked = true;
    const ob = createOutbox({ pool: { query: async () => { throw new Error('nicht erwartet'); } }, uploadsDir: env.dir, deleteBlob: () => {}, isBlocked: () => blocked, log: { log() {}, error() {} } });
    assert.strictEqual(await ob.sweep(0), null, 'blockiert: nichts passiert');
    const r = await env.blobOutbox.sweep(0);
    assert.deepStrictEqual([r.deleted, r.referenced, r.dropped, r.failed], [2, 2, 1, 0]);
    assert.ok(fs.existsSync(path.join(env.dir, keep.path)));
    assert.ok(fs.existsSync(path.join(env.dir, 'avatar.png')));
    assert.ok(!fs.existsSync(path.join(env.dir, '1', 'waise.bin')));
    assert.ok(fs.existsSync(outside));
    assert.strictEqual(env.outboxRows.size, 0);
    fs.rmSync(outside);
    blocked = false;
  } finally { env.cleanup(); }
});

/* ---------------- Teil 2: Stack-Tests ---------------- */

const ENC = process.env.TEST_ENCRYPTED === '1';
const UP = '/usr/src/app/uploads';
const sh = (cmd, input) => execFileSync('docker', [...COMPOSE_ARGS, 'exec', '-T', 'app', 'sh', '-c', cmd], { cwd: ROOT, input, maxBuffer: 64 << 20 }).toString();
const psql = (sql) => execSync(`${COMPOSE_CMD} exec -T db psql -U mycloud -d mycloud -At`, { input: sql, cwd: ROOT }).toString().trim();
const password = 'Test-Passwort-12345!';
async function register(name) {
  const res = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, email: name + '@example.test', password }),
  });
  assert.ok([200, 201].includes(res.status), 'register ' + res.status);
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const me = await (await fetch(BASE + '/api/settings', { headers: { cookie } })).json();
  return { cookie, id: (me.user || me).id };
}

const stamp = Date.now();
let admin, plainUser, apiKey;
const call = (who, p, opts = {}) => fetch(BASE + p, { ...opts, headers: { cookie: who.cookie, ...(opts.headers || {}) } });
const postJson = (who, p, body) => call(who, p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const status = async () => (await call(admin, '/api/settings/admin/encryption-status')).json();
async function waitIdle(maxMs = 120000) {
  const t0 = Date.now();
  for (;;) {
    let s;
    try { s = await status(); } catch { s = null; } // Container-Neustart
    if (s && !s.running) return s;
    assert.ok(Date.now() - t0 < maxMs, 'Migration endet nicht');
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Legt Klartext-Dateien (zufälliger Inhalt) im Upload-Volume und passende files-Zeilen mit enc_version NULL an.
function seedPlain(ownerId, specs) {
  const items = specs.map((s) => ({ ...s, uuid: crypto.randomUUID() }));
  sh(`mkdir -p ${UP}/${ownerId}`);
  const script = items.map((i) => `head -c ${i.size} /dev/urandom > ${UP}/${ownerId}/${i.uuid}.bin`).join('\n');
  sh('sh', script);
  const sums = Object.fromEntries(sh(`cd ${UP}/${ownerId} && sha256sum *.bin`).trim().split('\n').map((l) => { const [h, f] = l.split(/\s+/); return [f, h]; }));
  const values = items.map((i) => `('${i.name}', '${ownerId}/${i.uuid}.bin', 'application/octet-stream', ${i.size}, false, ${ownerId}, ${i.trash ? 'NOW()' : 'NULL'})`).join(',');
  const ids = psql(`INSERT INTO files (name, path, mime_type, size, is_folder, owner_id, deleted_at) VALUES ${values} RETURNING id;`).split('\n').map(Number);
  return items.map((i, n) => ({ ...i, id: ids[n], oldPath: `${ownerId}/${i.uuid}.bin`, hash: sums[`${i.uuid}.bin`] }));
}
const dlHash = async (who, id) => sha(Buffer.from(await (await call(who, `/api/files/download/${id}?inline=true`)).arrayBuffer()));
const rowOf = (id) => { const [p, e, h] = psql(`SELECT path, COALESCE(enc_version::text,''), COALESCE(content_hash,'') FROM files WHERE id = ${id}`).split('|'); return { path: p, enc: e, hash: h }; };
// Dateinamen im Benutzerordner, die eine Zeile oder ein Outbox-Eintrag (Löschen steht noch aus) referenziert
const referencedNames = () => new Set(psql(`SELECT path FROM files WHERE owner_id = ${admin.id} UNION SELECT path FROM pending_blob_deletes`).split('\n').map((p) => p.split('/')[1]));
async function waitUp() {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(BASE + '/api/auth/status')).ok) return; } catch { /* startet noch */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.fail('App nach dem Neustart nicht erreichbar');
}
const head = (rel) => sh(`head -c 6 "${UP}/${rel}"`);
const exists = (rel) => { try { sh(`test -e "${UP}/${rel}"`); return true; } catch { return false; } };

test('Stack-Setup: Admin, normaler Nutzer, API-Key', async () => {
  admin = await register('p2cadm' + stamp);
  plainUser = await register('p2cusr' + stamp);
  psql(`UPDATE users SET role = 'admin' WHERE id = ${admin.id}; UPDATE users SET role = 'user' WHERE id = ${plainUser.id};`);
  const k = await postJson(admin, '/api/settings/api-keys', { name: 'p2c' });
  assert.strictEqual(k.status, 201);
  apiKey = (await k.json()).key;
});

test('Zugriff: Nicht-Admin 403, API-Key 403 (Status und Migration)', async () => {
  for (const [method, body] of [['GET'], ['POST', { action: 'start' }]]) {
    const p = method === 'GET' ? '/api/settings/admin/encryption-status' : '/api/settings/admin/encryption-migration';
    const mk = (headers) => fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
    assert.strictEqual((await mk({ cookie: plainUser.cookie })).status, 403, 'Nutzer ' + p);
    assert.strictEqual((await mk({ authorization: 'Bearer ' + apiKey })).status, 403, 'Key ' + p);
    assert.strictEqual((await mk({})).status, 403, 'anonym ' + p);
  }
});


test('Outbox-Worker beim Start: unreferenzierter Eintrag wird gelöscht, referenzierter nur aus der Queue genommen', async () => {
  const [live] = seedPlain(admin.id, [{ name: 'lebt.bin', size: 100 }]);
  const orphan = `${admin.id}/waise-${stamp}.bin`;
  sh(`echo alt > ${UP}/${orphan}`);
  psql(`INSERT INTO pending_blob_deletes (path, created_at) VALUES ('${orphan}', NOW() - INTERVAL '1 hour'), ('${live.oldPath}', NOW() - INTERVAL '1 hour') ON CONFLICT DO NOTHING;`);
  execFileSync('docker', [...COMPOSE_ARGS, 'restart', 'app'], { cwd: ROOT, stdio: 'ignore' });
  await waitUp();
  let gone = false;
  for (let i = 0; i < 30 && !gone; i++) { gone = !exists(orphan); if (!gone) await new Promise((r) => setTimeout(r, 500)); }
  assert.ok(gone, 'Waise gelöscht');
  assert.strictEqual(psql(`SELECT COUNT(*) FROM pending_blob_deletes WHERE path IN ('${orphan}')`), '0');
  // die referenzierte Datei lebt weiter (im Enc-Stack ggf. inzwischen migriert: dann ist der Pfad ein anderer, Inhalt gleich)
  assert.strictEqual(await dlHash(admin, live.id), live.hash);
});

test('Kopieren: fehlender Quell-Blob -> deutscher Fehler statt stillem Überspringen', async () => {
  const id = psql(`INSERT INTO files (name, path, mime_type, size, is_folder, owner_id) VALUES ('kopie-weg.bin', '${admin.id}/nicht-da-kopie-${stamp}.bin', 'application/octet-stream', 10, false, ${admin.id}) RETURNING id;`).split('\n')[0];
  const r = await postJson(admin, '/api/files/copy-multiple', { fileIds: [Number(id)], targetFolderId: null });
  assert.strictEqual(r.status, 500);
  assert.match((await r.json()).error, /konnte nicht kopiert werden/);
  assert.strictEqual(psql(`SELECT COUNT(*) FROM files WHERE name LIKE 'kopie-weg%' AND owner_id = ${admin.id}`), '1');
  psql(`DELETE FROM files WHERE id = ${id}`);
});

test('Endgültiges Löschen (Papierkorb): Blob am AKTUELLEN Pfad wird gelöscht, Outbox leer', async () => {
  const [it] = seedPlain(admin.id, [{ name: 'weg-forever.bin', size: 500, trash: true }]);
  const r = await call(admin, `/api/files/trash/${it.id}`, { method: 'DELETE' });
  assert.ok(r.ok, 'trash delete ' + r.status);
  assert.strictEqual(psql(`SELECT COUNT(*) FROM files WHERE id = ${it.id}`), '0');
  assert.ok(!exists(it.oldPath));
  await new Promise((r2) => setTimeout(r2, 500));
  assert.strictEqual(psql(`SELECT COUNT(*) FROM pending_blob_deletes WHERE path = '${it.oldPath}'`), '0');
});

if (!ENC) {
  test('E16: ohne Key meldet der Status enabled=false, Start -> 409 (deutsch), nichts migriert', async () => {
    const s = await status();
    assert.strictEqual(s.enabled, false);
    assert.strictEqual(s.running, false);
    const r = await postJson(admin, '/api/settings/admin/encryption-migration', { action: 'start' });
    assert.strictEqual(r.status, 409);
    assert.match((await r.json()).error, /Verschlüsselung|Master-Key/);
    assert.strictEqual(psql('SELECT COUNT(*) FROM files WHERE enc_version IS NOT NULL'), '0');
  });
} else {
  test('Enc-Stack: Status meldet enabled=true mit keyId', async () => {
    const s = await status();
    assert.strictEqual(s.enabled, true);
    assert.ok(Number.isInteger(s.keyId));
    for (const k of ['total', 'encrypted', 'plain', 'missing', 'failed', 'running', 'lastRun', 'thumbnailsRemoved', 'avatarsMigrated']) assert.ok(k in s, k);
  });

  test('Ungültige Aktion -> 400', async () => {
    assert.strictEqual((await postJson(admin, '/api/settings/admin/encryption-migration', { action: 'x' })).status, 400);
  });

  test('E14: Klartext-Bestand (inkl. Papierkorb, leere Datei, Thumbnail, Avatar) wird migriert, Zweitlauf ändert nichts', async () => {
    await waitIdle();
    const items = seedPlain(admin.id, [
      { name: 'a.bin', size: 300000 }, { name: 'b.bin', size: 70000 }, { name: 'leer.bin', size: 0 },
      { name: 'trash.bin', size: 12345, trash: true },
    ]);
    // Klartext-Thumbnails: eines zu einer Datei, eines verwaist; dazu ein Klartext-Avatar
    const orphanThumb = `orphan-${stamp}.jpg`;
    sh(`echo thumb > ${UP}/thumbnails/${items[0].uuid}.bin.jpg; echo thumb > ${UP}/thumbnails/${orphanThumb}`);
    sh(`echo '${PNG.toString('base64')}' | base64 -d > ${UP}/legacy-avatar-${admin.id}.png`);
    psql(`UPDATE users SET avatar_path = 'legacy-avatar-${admin.id}.png' WHERE id = ${admin.id}`);

    const before = await status();
    assert.ok(before.plain >= 4);
    const st = await postJson(admin, '/api/settings/admin/encryption-migration', { action: 'start' });
    assert.strictEqual(st.status, 200);
    const after = await waitIdle();

    for (const it of items) {
      const r = rowOf(it.id);
      assert.strictEqual(r.enc, '1', it.name);
      assert.notStrictEqual(r.path, it.oldPath);
      assert.strictEqual(head(r.path), 'MCENC1', it.name);
      assert.strictEqual(r.hash, it.hash, 'content_hash ' + it.name);
      assert.ok(!exists(it.oldPath), 'Alt-Blob gelöscht ' + it.name);
      if (!it.trash) assert.strictEqual(await dlHash(admin, it.id), it.hash, 'Download ' + it.name);
    }
    // Papierkorb-Datei: Blob lesbar (Wiederherstellen-Pfad), Inhalt per Container entschlüsselt prüfen
    const tr = rowOf(items[3].id);
    assert.ok(exists(tr.path));
    assert.ok(!exists(`thumbnails/${orphanThumb}`), 'verwaistes Klartext-Thumbnail entfernt');
    assert.ok(!exists(`thumbnails/${items[0].uuid}.bin.jpg`), 'Klartext-Thumbnail entfernt');
    assert.ok(after.thumbnailsRemoved >= 1 && after.avatarsMigrated >= 1);
    const ap = psql(`SELECT avatar_path FROM users WHERE id = ${admin.id}`);
    assert.match(ap, /^[0-9a-f-]{36}\.png\.enc$/);
    assert.ok(!exists(`legacy-avatar-${admin.id}.png`));
    assert.strictEqual(head(ap), 'MCENC1');
    const av = await call(admin, `/api/users/${admin.id}/avatar`);
    assert.strictEqual(av.status, 200);
    assert.ok(Buffer.from(await av.arrayBuffer()).equals(PNG));
    // Zähler stimmen mit der DB überein
    const c = psql("SELECT COUNT(*), COUNT(*) FILTER (WHERE enc_version > 0), COUNT(*) FILTER (WHERE enc_version IS NULL) FROM files WHERE is_folder = false").split('|').map(Number);
    assert.deepStrictEqual([after.total, after.encrypted, after.plain], c);

    // Zweiter Lauf: nichts ändert sich
    const paths = items.map((i) => rowOf(i.id).path);
    await postJson(admin, '/api/settings/admin/encryption-migration', { action: 'start' });
    const second = await waitIdle();
    assert.strictEqual(second.migrated, 0);
    assert.strictEqual(second.avatarsMigrated, 0);
    assert.deepStrictEqual(items.map((i) => rowOf(i.id).path), paths);
    assert.strictEqual(psql(`SELECT avatar_path FROM users WHERE id = ${admin.id}`), ap);
  });

  test('Race: Datei wird während der Migration per binary-content überschrieben -> konsistent', async () => {
    await waitIdle();
    const items = seedPlain(admin.id, Array.from({ length: 60 }, (_, i) => ({ name: `race${i}.bin`, size: 20000 })));
    const victim = items[items.length - 1];
    await postJson(admin, '/api/settings/admin/encryption-migration', { action: 'start' });
    const newBytes = crypto.randomBytes(5000);
    const fd = new FormData();
    fd.append('file', new Blob([newBytes]), 'race.bin');
    const put = await call(admin, `/api/files/${victim.id}/binary-content`, { method: 'PUT', body: fd });
    assert.ok(put.ok, 'binary-content ' + put.status);
    await waitIdle();
    assert.strictEqual(await dlHash(admin, victim.id), sha(newBytes), 'Datei zeigt den neuen Inhalt');
    const r = rowOf(victim.id);
    assert.strictEqual(r.enc, '1');
    assert.strictEqual(head(r.path), 'MCENC1');
    assert.ok(!exists(victim.oldPath));
    // Keine verwaisten Blobs: jede Datei im Benutzerordner gehört zu einer Zeile (ausgenommen .tmp-/.enc-tmp-)
    const onDisk = sh(`ls ${UP}/${admin.id}`).trim().split('\n').filter((f) => f && !f.includes('tmp-'));
    const inDb = referencedNames();
    assert.deepStrictEqual(onDisk.filter((f) => !inDb.has(f)), []);
    for (const it of items.slice(0, -1)) assert.strictEqual(await dlHash(admin, it.id), it.hash);
  });

  test('Abbruch/Wiederaufnahme: Neustart des App-Containers mitten im Lauf, danach alles verschlüsselt, nichts doppelt', async () => {
    await waitIdle();
    const items = seedPlain(admin.id, Array.from({ length: 300 }, (_, i) => ({ name: `resume${i}.bin`, size: 30000 + i })));
    await postJson(admin, '/api/settings/admin/encryption-migration', { action: 'start' });
    // abwarten, bis ein Teil migriert ist, dann hart neu starten
    const ids = items.map((i) => i.id).join(',');
    let done = 0;
    for (let i = 0; i < 150 && done < 20; i++) {
      await new Promise((r) => setTimeout(r, 200));
      done = Number(psql(`SELECT COUNT(*) FROM files WHERE id IN (${ids}) AND enc_version = 1`));
    }
    const mid = Number(psql(`SELECT COUNT(*) FROM files WHERE id IN (${ids}) AND enc_version = 1`));
    assert.ok(mid > 0 && mid < items.length, `Neustart muss mitten im Lauf passieren (migriert: ${mid} von ${items.length})`);
    execFileSync('docker', [...COMPOSE_ARGS, 'restart', 'app'], { cwd: ROOT, stdio: 'ignore' });
    await waitUp();
    // Der Job startet beim App-Start von selbst (encryption_auto_migrate); notfalls anstoßen
    await postJson(admin, '/api/settings/admin/encryption-migration', { action: 'start' }).catch(() => {});
    const s = await waitIdle();
    console.log(`# vor dem Neustart migriert: ${mid} von ${items.length}`);
    assert.strictEqual(Number(psql(`SELECT COUNT(*) FROM files WHERE id IN (${ids}) AND enc_version IS NULL`)), 0);
    assert.strictEqual(s.failed, 0);
    for (const it of items) {
      const r = rowOf(it.id);
      assert.strictEqual(r.hash, it.hash, 'content_hash ' + it.name);
      assert.strictEqual(sh(`stat -c %s "${UP}/${r.path}"`).trim(), String(96 + it.size + 16 * Math.max(1, Math.ceil(it.size / 65536))), 'Blobgröße (einfach verschlüsselt) ' + it.name);
    }
    // stichprobenartig Downloads (Entschlüsselung genau einmal -> Klartext-Hash)
    for (const it of [items[0], items[150], items[299]]) assert.strictEqual(await dlHash(admin, it.id), it.hash);
    const onDisk = sh(`ls ${UP}/${admin.id}`).trim().split('\n').filter((f) => f && !f.includes('tmp-'));
    const inDb = referencedNames();
    assert.deepStrictEqual(onDisk.filter((f) => !inDb.has(f)), [], 'verwaiste Blobs');
  });

  test('Fehlender Blob wird als missing gezählt, Lauf geht weiter; Stopp-Aktion antwortet', async () => {
    await waitIdle();
    const id = psql(`INSERT INTO files (name, path, mime_type, size, is_folder, owner_id) VALUES ('weg.bin', '${admin.id}/nicht-da-${stamp}.bin', 'application/octet-stream', 10, false, ${admin.id}) RETURNING id;`).split('\n')[0];
    await postJson(admin, '/api/settings/admin/encryption-migration', { action: 'start' });
    const s = await waitIdle();
    assert.ok(s.missing >= 1);
    assert.strictEqual(rowOf(id).enc, '');
    const stop = await postJson(admin, '/api/settings/admin/encryption-migration', { action: 'stop' });
    assert.strictEqual(stop.status, 200);
    psql(`DELETE FROM files WHERE id = ${id}`);
  });
}
