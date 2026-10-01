// node --test tests/crypto-store.test.js  (Unit-Test, kein Stack nötig)
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const cs = require('../app/crypto-store');

const SEG = cs.DEFAULT_SEG_SIZE;
const KEY = crypto.randomBytes(32);
const KEY2 = crypto.randomBytes(32);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mycloud-cs-test-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;
const tp = () => path.join(tmpRoot, `f${n++}`);
const collect = async s => { const c = []; for await (const x of s) c.push(x); return Buffer.concat(c); };
const withKey = (k, fn) => async () => { cs.useKeys(k); try { await fn(); } finally { cs.useKeys(null); } };

async function enc(data, opts) {
  const p = tp();
  await cs.writeEncrypted(p, data, opts);
  return p;
}
async function mustFail(p) {
  await assert.rejects(async () => { cs.useKeys(KEY); await cs.readDecrypted(p); });
}

test('E1 Roundtrip (0 B, 1 B, 1 Segment, Segment+1, 50 MB)', withKey(KEY, async () => {
  for (const size of [0, 1, SEG, SEG + 1, 2 * SEG, 50 * 1024 * 1024]) {
    const data = crypto.randomBytes(size);
    const p = await enc(data);
    const r = await cs.writeEncrypted(tp(), data);
    assert.strictEqual(r.plainSize, size);
    assert.strictEqual(r.sha256, crypto.createHash('sha256').update(data).digest('hex'));
    assert.strictEqual(cs.plainSizeOf(p), size);
    assert.ok(cs.isEncrypted(p));
    assert.ok((await cs.readDecrypted(p)).equals(data), `size ${size}`);
    assert.ok((await collect(cs.createDecryptStream(p))).equals(data));
  }
}));

test('E1 Stream-Eingabe in kleinen Chunks', withKey(KEY, async () => {
  const data = crypto.randomBytes(3 * SEG + 123);
  const p = await enc(require('stream').Readable.from(Array.from({ length: 50 }, (_, i) => data.subarray(i * 4000, (i + 1) * 4000)).concat([data.subarray(200000)])));
  assert.ok((await cs.readDecrypted(p)).equals(data));
}));

test('E2 kein Klartext, Magic-Header', withKey(KEY, async () => {
  const marker = 'GEHEIMER-KLARTEXT-MARKER-12345';
  const p = await enc(Buffer.from(marker.repeat(100)));
  const raw = fs.readFileSync(p);
  assert.strictEqual(raw.indexOf(marker), -1);
  assert.strictEqual(raw.subarray(0, 8).toString('latin1'), 'MCENC1\0\0');
  assert.strictEqual(raw.length, 96 + marker.length * 100 + 16);
}));

test('E3 Range: zufällige und Grenzfälle', withKey(KEY, async () => {
  const size = 5 * SEG + 777;
  const data = crypto.randomBytes(size);
  const p = await enc(data);
  const cases = [[0, size - 1], [0, 0], [size - 1, size - 1], [SEG - 1, SEG], [SEG, SEG], [SEG, 2 * SEG - 1], [SEG - 1, 2 * SEG], [5 * SEG, size - 1], [5 * SEG - 1, size - 1], [100, 100], [0, undefined], [size - 5, undefined]];
  for (let i = 0; i < 150; i++) {
    const a = crypto.randomInt(0, size), b = crypto.randomInt(0, size);
    cases.push([Math.min(a, b), Math.max(a, b)]);
  }
  for (const [s, e] of cases) {
    const got = await collect(cs.createDecryptStream(p, { start: s, end: e }));
    assert.ok(got.equals(data.subarray(s, (e === undefined ? size - 1 : e) + 1)), `range ${s}-${e}`);
  }
  assert.strictEqual((await collect(cs.createDecryptStream(p, { start: size + 10 }))).length, 0);
}));

test('E3 Range entschlüsselt nur betroffene Segmente (Beschädigung anderswo stört nicht)', withKey(KEY, async () => {
  const data = crypto.randomBytes(3 * SEG);
  const p = await enc(data);
  const fd = fs.openSync(p, 'r+');
  fs.writeSync(fd, Buffer.from([0xff]), 0, 1, 96 + 2 * (SEG + 16) + 5); // Segment 2
  fs.closeSync(fd);
  assert.ok((await collect(cs.createDecryptStream(p, { start: 10, end: 20 }))).equals(data.subarray(10, 21)));
  await assert.rejects(collect(cs.createDecryptStream(p, { start: 2 * SEG })));
}));

test('E4 Integrität: Bit-Flip in Header (alle Bytes ab 5), Segment, Tag', withKey(KEY, async () => {
  const data = crypto.randomBytes(2 * SEG + 100);
  const p = await enc(data);
  const orig = fs.readFileSync(p);
  const total = orig.length;
  const positions = [];
  for (let i = 5; i < 96; i++) positions.push(i);
  positions.push(96, 96 + 1000, 96 + SEG - 1, 96 + SEG, 96 + SEG + 7, total - 1, total - 16, total - 17, 96 + 2 * (SEG + 16) + 3);
  for (const pos of positions) {
    const b = Buffer.from(orig);
    b[pos] ^= 0x01;
    const q = tp();
    fs.writeFileSync(q, b);
    await mustFail(q);
  }
  // Magic-Präfix beschädigt (Bytes 5..7) wird abgelehnt, nicht als Klartext durchgereicht
  const m = Buffer.from(orig); m[6] ^= 1;
  const q = tp(); fs.writeFileSync(q, m);
  await mustFail(q);
}));

test('E4 Integrität: Segmente vertauscht, abgeschnitten, angehängt', withKey(KEY, async () => {
  const data = crypto.randomBytes(3 * SEG);
  const p = await enc(data);
  const orig = fs.readFileSync(p);
  const segLen = SEG + 16;
  const seg = i => orig.subarray(96 + i * segLen, 96 + (i + 1) * segLen);
  const swapped = Buffer.concat([orig.subarray(0, 96), seg(1), seg(0), seg(2)]);
  const variants = {
    swapped,
    truncatedTag: orig.subarray(0, orig.length - 1),
    truncatedSegment: orig.subarray(0, orig.length - segLen),
    truncatedHeader: orig.subarray(0, 50),
    appended: Buffer.concat([orig, Buffer.from([0])]),
    appendedSegment: Buffer.concat([orig, seg(0)]),
    headerOnly: orig.subarray(0, 96),
  };
  for (const [name, b] of Object.entries(variants)) {
    const q = tp(); fs.writeFileSync(q, b);
    await assert.rejects(async () => { cs.useKeys(KEY); await cs.readDecrypted(q); }, undefined, name);
  }
}));

test('E4 Segment einer anderen Datei einschieben schlägt fehl', withKey(KEY, async () => {
  const a = await enc(crypto.randomBytes(2 * SEG));
  const b = await enc(crypto.randomBytes(2 * SEG));
  const A = fs.readFileSync(a), B = fs.readFileSync(b);
  const mixed = Buffer.concat([A.subarray(0, 96), B.subarray(96, 96 + SEG + 16), A.subarray(96 + SEG + 16)]);
  const q = tp(); fs.writeFileSync(q, mixed);
  await mustFail(q);
}));

test('E5 falscher Master-Key, fehlender Key, unbekannte keyId', async () => {
  cs.useKeys(KEY);
  const p = await enc(Buffer.from('hallo'));
  cs.useKeys(KEY2);
  await assert.rejects(cs.readDecrypted(p), { code: 'KEY_MISMATCH' });
  assert.throws(() => cs.createDecryptStream(p), { code: 'KEY_MISMATCH' });
  cs.useKeys(null);
  await assert.rejects(cs.readDecrypted(p), { code: 'ENCRYPTED_NO_KEY' });
  assert.throws(() => cs.plainSizeOf(p), { code: 'ENCRYPTED_NO_KEY' });
  cs.useKeys({ current: 2, keys: new Map([[2, KEY]]) });
  await assert.rejects(cs.readDecrypted(p), { code: 'KEY_UNKNOWN' });
  // Rotation: alte Datei (keyId 1) bleibt mit beiden Keys lesbar, neue nutzt current
  cs.useKeys({ current: 2, keys: new Map([[1, KEY], [2, KEY2]]) });
  assert.strictEqual((await cs.readDecrypted(p)).toString(), 'hallo');
  const p2 = await enc(Buffer.from('neu'));
  assert.strictEqual(fs.readFileSync(p2).readUInt32BE(10), 2);
  cs.useKeys(null);
});

test('E6 zwei Verschlüsselungen derselben Datei unterscheiden sich', withKey(KEY, async () => {
  const data = crypto.randomBytes(1000);
  const a = fs.readFileSync(await enc(data)), b = fs.readFileSync(await enc(data));
  assert.strictEqual(a.length, b.length);
  assert.ok(!a.equals(b));
  assert.ok(!a.subarray(96).equals(b.subarray(96)));
  assert.ok(!a.subarray(34, 94).equals(b.subarray(34, 94)));
}));

test('Passthrough ohne Key', async () => {
  cs.useKeys(null);
  assert.strictEqual(cs.isEnabled(), false);
  const data = crypto.randomBytes(200000);
  const p = tp();
  const r = await cs.writeEncrypted(p, data);
  assert.ok(fs.readFileSync(p).equals(data));
  assert.strictEqual(r.sha256, crypto.createHash('sha256').update(data).digest('hex'));
  assert.ok(!cs.isEncrypted(p));
  assert.ok((await collect(cs.createDecryptStream(p, { start: 5, end: 99 }))).equals(data.subarray(5, 100)));
  assert.ok((await cs.readDecrypted(p)).equals(data));
  assert.strictEqual(cs.plainSizeOf(p), data.length);
  const r2 = await cs.encryptFileInPlace(p);
  assert.strictEqual(r2.changed, false);
  assert.ok(fs.readFileSync(p).equals(data));
  await cs.withPlaintextTempFile(p, async t => assert.strictEqual(t, p));
  assert.ok(fs.existsSync(p));
});

test('Mischbetrieb: Klartextdatei mit aktivem Key lesbar, isEncrypted bei kurzen/leeren Dateien', withKey(KEY, async () => {
  const p = tp(); fs.writeFileSync(p, 'MCENC');
  const e = tp(); fs.writeFileSync(e, '');
  assert.strictEqual(cs.isEncrypted(e), false);
  assert.strictEqual(cs.isEncrypted(p), false);
  const plain = tp(); fs.writeFileSync(plain, 'klartext');
  assert.strictEqual((await cs.readDecrypted(plain)).toString(), 'klartext');
  assert.strictEqual((await cs.readDecrypted(e)).length, 0);
}));

test('encryptFileInPlace: atomar, idempotent, Klartext-Hash', withKey(KEY, async () => {
  const data = crypto.randomBytes(70000);
  const p = tp(); fs.writeFileSync(p, data);
  const r = await cs.encryptFileInPlace(p);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.sha256, crypto.createHash('sha256').update(data).digest('hex'));
  assert.ok(cs.isEncrypted(p));
  const before = fs.readFileSync(p);
  const r2 = await cs.encryptFileInPlace(p);
  assert.strictEqual(r2.changed, false);
  assert.ok(fs.readFileSync(p).equals(before));
  assert.ok((await cs.readDecrypted(p)).equals(data));
  assert.deepStrictEqual(fs.readdirSync(tmpRoot).filter(f => f.includes('.tmp-')), []);
}));

test('atomares Schreiben: bei Fehler bleibt kein Rest, Ziel unverändert', withKey(KEY, async () => {
  const p = tp(); fs.writeFileSync(p, 'alt');
  const bad = require('stream').Readable.from((async function* () { yield Buffer.alloc(100000, 1); throw new Error('Quelle kaputt'); })());
  await assert.rejects(cs.writeEncrypted(p, bad), /Quelle kaputt/);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'alt');
  assert.deepStrictEqual(fs.readdirSync(tmpRoot).filter(f => f.includes('.tmp-')), []);
}));

test('withPlaintextTempFile: Klartext, Modi, Aufräumen (auch bei Exception)', withKey(KEY, async () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'tmpdir-'));
  process.env.MYCLOUD_TMP_DIR = dir;
  try {
    const data = crypto.randomBytes(150000);
    const p = await enc(data);
    let seen;
    await cs.withPlaintextTempFile(p, async t => {
      seen = t;
      assert.ok(fs.readFileSync(t).equals(data));
      assert.strictEqual(fs.statSync(t).mode & 0o777, 0o600);
      assert.strictEqual(fs.statSync(path.dirname(t)).mode & 0o777, 0o700);
      assert.ok(path.dirname(t).startsWith(dir));
    });
    assert.ok(!fs.existsSync(seen));
    assert.deepStrictEqual(fs.readdirSync(dir), []);
    await assert.rejects(cs.withPlaintextTempFile(p, async () => { throw new Error('boom'); }), /boom/);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
    // beschädigte Datei: Fehler beim Entschlüsseln, trotzdem aufgeräumt
    const raw = fs.readFileSync(p); raw[200] ^= 1;
    const q = tp(); fs.writeFileSync(q, raw);
    await assert.rejects(cs.withPlaintextTempFile(q, async () => {}));
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  } finally { delete process.env.MYCLOUD_TMP_DIR; }
}));

test('Key-Datei-Parser: hex, base64, JSON, Fehler', () => {
  const k = crypto.randomBytes(32);
  assert.ok(cs.parseKeyFile(k.toString('hex') + '\n').keys.get(1).equals(k));
  assert.ok(cs.parseKeyFile(k.toString('base64')).keys.get(1).equals(k));
  const j = cs.parseKeyFile(JSON.stringify({ current: 2, keys: { 1: k.toString('hex'), 2: KEY.toString('base64') } }));
  assert.strictEqual(j.current, 2);
  assert.ok(j.keys.get(1).equals(k) && j.keys.get(2).equals(KEY));
  for (const bad of ['', 'abc', 'zz'.repeat(32), k.toString('hex').slice(2), '{}', '{"current":3,"keys":{"1":"' + k.toString('hex') + '"}}', '{"current":1,"keys":{"0":"' + k.toString('hex') + '"}}', '{kaputt'])
    assert.throws(() => cs.parseKeyFile(bad), { code: 'KEY_FORMAT' }, JSON.stringify(bad));
});

test('loadMasterKeys: Datei, ohne Pfad, unlesbar', () => {
  const f = tp(); fs.writeFileSync(f, KEY.toString('hex'));
  assert.ok(cs.loadMasterKeys(f).keys.get(1).equals(KEY));
  assert.strictEqual(cs.isEnabled(), true);
  assert.strictEqual(cs.loadMasterKeys(''), null);
  assert.strictEqual(cs.isEnabled(), false);
  assert.throws(() => cs.loadMasterKeys(path.join(tmpRoot, 'gibtsnicht')), { code: 'KEY_UNREADABLE' });
  cs.useKeys(null);
});

test('Key-Check-Wert, Spaltenschlüssel, Recovery-Code', () => {
  assert.strictEqual(cs.getKeyCheckValue(KEY), crypto.createHmac('sha256', KEY).update('mycloud-kcv').digest('hex'));
  assert.notStrictEqual(cs.getKeyCheckValue(KEY), cs.getKeyCheckValue(KEY2));
  const c = cs.deriveColumnKey(KEY, 'mycloud-column-v1');
  assert.strictEqual(c.length, 32);
  assert.ok(c.equals(cs.deriveColumnKey(KEY, 'mycloud-column-v1')));
  assert.ok(!c.equals(cs.deriveColumnKey(KEY, 'anders')));
  const code = cs.formatRecoveryCode(KEY);
  assert.match(code, /^([A-Z2-7]{4}-)+[A-Z2-7]{1,4}$/);
  assert.ok(cs.parseRecoveryCode(code).equals(KEY));
  assert.ok(cs.parseRecoveryCode(code.toLowerCase().replace(/-/g, ' ')).equals(KEY));
  const bad = (code[0] === 'A' ? 'B' : 'A') + code.slice(1);
  assert.throws(() => cs.parseRecoveryCode(bad), { code: 'KEY_FORMAT' });
});

test('Start-Check: erster Start, gleicher Key, falscher Key, Key fehlt', async () => {
  const rows = new Map();
  const db = { query: async (sql, p) => {
    if (/^SELECT/.test(sql)) return { rows: rows.has('k') ? [{ value: rows.get('k') }] : [] };
    if (!rows.has('k')) rows.set('k', p[0]);
    return { rows: [] };
  } };
  cs.useKeys(null);
  await cs.checkMasterKeyAtStartup(db);            // ohne Key, ohne kcv: no-op
  assert.strictEqual(rows.size, 0);
  cs.useKeys(KEY);
  const log = console.log; console.log = () => {};
  try { await cs.checkMasterKeyAtStartup(db); } finally { console.log = log; }
  assert.strictEqual(rows.get('k'), cs.getKeyCheckValue(KEY));
  await cs.checkMasterKeyAtStartup(db);            // gleicher Key
  cs.useKeys(KEY2);
  await assert.rejects(cs.checkMasterKeyAtStartup(db), { code: 'KCV_MISMATCH' });
  cs.useKeys(null);
  await assert.rejects(cs.checkMasterKeyAtStartup(db), { code: 'KCV_NO_KEY' });
});

test('keys.js: init, Modus 0400, Überschreiben verweigert, check, show-recovery', () => {
  const script = path.join(__dirname, '..', 'app', 'scripts', 'keys.js');
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'keys-'));
  const f = path.join(dir, 'master_key');
  const out = execFileSync('node', [script, 'init', '--out', f], { encoding: 'utf8' });
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o400);
  const key = cs.parseKeyFile(fs.readFileSync(f, 'utf8')).keys.get(1);
  const code = out.match(/Recovery-Code[^:]*: (\S+)/)[1];
  assert.ok(cs.parseRecoveryCode(code).equals(key));
  assert.ok(!out.includes(key.toString('hex')));
  const again = spawnSync('node', [script, 'init', '--out', f], { encoding: 'utf8' });
  assert.notStrictEqual(again.status, 0);
  assert.ok(cs.parseKeyFile(fs.readFileSync(f, 'utf8')).keys.get(1).equals(key));
  assert.ok(!again.stdout.includes(code));
  assert.match(execFileSync('node', [script, 'check', f], { encoding: 'utf8' }), /OK/);
  assert.ok(execFileSync('node', [script, 'show-recovery', f], { encoding: 'utf8' }).includes(code));
  const bad = path.join(dir, 'bad'); fs.writeFileSync(bad, 'xyz');
  const r = spawnSync('node', [script, 'check', bad], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.ok(!r.stdout.includes('xyz') && !r.stderr.includes('xyz'));
  assert.notStrictEqual(spawnSync('node', [script, 'check', path.join(dir, 'nix')]).status, 0);
});
