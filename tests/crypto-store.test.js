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
  await assert.rejects(async () => { cs.useKeys(KEY); await cs.readDecrypted(p, { encrypted: true }); });
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

test('Stream früh zerstören gibt den fd frei und wirft nicht', withKey(KEY, async () => {
  const p = await enc(crypto.randomBytes(4 * SEG));
  const fdsBefore = fs.readdirSync('/proc/self/fd').length;
  for (let i = 0; i < 20; i++) {
    const st = cs.createDecryptStream(p, { encrypted: true });
    st.destroy();
    const st2 = cs.createDecryptStream(p, { encrypted: true });
    for await (const c of st2) { st2.destroy(); break; }
  }
  await new Promise(r => setTimeout(r, 50));
  assert.ok(fs.readdirSync('/proc/self/fd').length <= fdsBefore + 1);
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

test('E4 Integrität: Bit-Flip in Header (alle 96 Bytes), Segment, Tag', withKey(KEY, async () => {
  const data = crypto.randomBytes(2 * SEG + 100);
  const p = await enc(data);
  const orig = fs.readFileSync(p);
  const total = orig.length;
  const positions = [];
  for (let i = 0; i < 96; i++) positions.push(i);
  positions.push(96, 96 + 1000, 96 + SEG - 1, 96 + SEG, 96 + SEG + 7, total - 1, total - 16, total - 17, 96 + 2 * (SEG + 16) + 3);
  for (const pos of positions) {
    const b = Buffer.from(orig);
    b[pos] ^= 0x01;
    const q = tp();
    fs.writeFileSync(q, b);
    await mustFail(q);
  }
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
    await assert.rejects(async () => { cs.useKeys(KEY); await cs.readDecrypted(q, { encrypted: true }); }, undefined, name);
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
  await assert.rejects(cs.readDecrypted(p, { encrypted: true }), { code: 'KEY_MISMATCH' });
  assert.throws(() => cs.createDecryptStream(p, { encrypted: true }), { code: 'KEY_MISMATCH' });
  cs.useKeys(null);
  await assert.rejects(cs.readDecrypted(p, { encrypted: true }), { code: 'ENCRYPTED_NO_KEY' });
  assert.strictEqual(cs.plainSizeOf(p, { encrypted: true }), 5); // nur Header, kein Key nötig
  cs.useKeys({ current: 2, keys: new Map([[2, KEY]]) });
  await assert.rejects(cs.readDecrypted(p, { encrypted: true }), { code: 'KEY_UNKNOWN' });
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

test('encrypted-Parameter: Aufrufer entscheidet, Klartext mit MCENC1-Magic bleibt Klartext', withKey(KEY, async () => {
  const fake = Buffer.concat([Buffer.from('MCENC1\0\0'), crypto.randomBytes(300)]);
  const p = tp(); fs.writeFileSync(p, fake);
  assert.ok((await cs.readDecrypted(p, { encrypted: false })).equals(fake));
  assert.ok((await collect(cs.createDecryptStream(p, { encrypted: false, start: 3, end: 40 }))).equals(fake.subarray(3, 41)));
  assert.strictEqual(cs.plainSizeOf(p, { encrypted: false }), fake.length);
  await assert.rejects(cs.readDecrypted(p, { encrypted: true }));
  assert.throws(() => cs.plainSizeOf(p, { encrypted: true }));
  // Klartext ohne Magic, aber encrypted:true -> Fehler, nie Klartext
  const plain = tp(); fs.writeFileSync(plain, 'klartext');
  await assert.rejects(cs.readDecrypted(plain, { encrypted: true }), { code: 'ECORRUPT' });
  assert.throws(() => cs.createDecryptStream(plain, { encrypted: true }), { code: 'ECORRUPT' });
  await assert.rejects(cs.withPlaintextTempFile(plain, async () => {}, { encrypted: true }));
  // Heuristik (nur Migration): exakte Magic, kurze/leere Dateien sind Klartext
  assert.strictEqual(cs.isEncrypted(p), true);
  const e = tp(); fs.writeFileSync(e, ''); const m = tp(); fs.writeFileSync(m, 'MCENC');
  assert.strictEqual(cs.isEncrypted(e), false);
  assert.strictEqual(cs.isEncrypted(m), false);
  assert.strictEqual((await cs.readDecrypted(plain)).toString(), 'klartext');
  // assumePlain verschlüsselt immer, auch bei MCENC1-Anfang
  const r = await cs.encryptFileInPlace(p, { assumePlain: true });
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.plainSize, fake.length);
  assert.ok((await cs.readDecrypted(p, { encrypted: true })).equals(fake));
}));

test('maxBytes in readDecrypted', withKey(KEY, async () => {
  const p = await enc(Buffer.alloc(1000, 1));
  await assert.rejects(cs.readDecrypted(p, { encrypted: true, maxBytes: 999 }), { code: 'ETOOBIG' });
  assert.strictEqual((await cs.readDecrypted(p, { encrypted: true, maxBytes: 1000 })).length, 1000);
  const q = tp(); fs.writeFileSync(q, 'abc');
  await assert.rejects(cs.readDecrypted(q, { encrypted: false, maxBytes: 2 }), { code: 'ETOOBIG' });
}));

test('segSize-Validierung beim Schreiben', withKey(KEY, async () => {
  for (const bad of [0, 1, 4095, 1.5, (1 << 24) + 1, NaN, '65536'])
    await assert.rejects(cs.writeEncrypted(tp(), Buffer.from('x'), { segSize: bad }), RangeError, String(bad));
  const p = await enc(crypto.randomBytes(10000), { segSize: 4096 });
  assert.strictEqual((await cs.readDecrypted(p, { encrypted: true })).length, 10000);
}));

test('M1 Segment-AAD unabhängig von keyId/wrappedDek: rewrapHeader', async () => {
  const data = crypto.randomBytes(3 * SEG + 5);
  cs.useKeys({ current: 1, keys: new Map([[1, KEY]]) });
  const p = await enc(data);
  const before = fs.readFileSync(p);
  cs.useKeys({ current: 2, keys: new Map([[1, KEY], [2, KEY2]]) });
  const r = cs.rewrapHeader(p, { toKeyId: 2 });
  assert.deepStrictEqual([r.fromKeyId, r.toKeyId, r.changed], [1, 2, true]);
  const after = fs.readFileSync(p);
  assert.ok(after.subarray(96).equals(before.subarray(96)), 'Segmentbytes identisch');
  assert.ok(!after.subarray(34, 94).equals(before.subarray(34, 94)), 'neuer Wrap');
  assert.ok(after.subarray(26, 34).equals(before.subarray(26, 34)), 'noncePfx bleibt');
  assert.strictEqual(after.readUInt32BE(10), 2);
  assert.ok((await cs.readDecrypted(p, { encrypted: true })).equals(data));
  assert.strictEqual(cs.rewrapHeader(p, { toKeyId: 2 }).changed, false);
  cs.useKeys({ current: 2, keys: new Map([[2, KEY2]]) });
  assert.ok((await cs.readDecrypted(p, { encrypted: true })).equals(data));
  cs.useKeys({ current: 1, keys: new Map([[1, KEY]]) });
  await assert.rejects(cs.readDecrypted(p, { encrypted: true }), { code: 'KEY_UNKNOWN' });
  // Bit-Flips nach Rewrap weiterhin erkannt
  cs.useKeys({ current: 2, keys: new Map([[2, KEY2]]) });
  for (const pos of [0, 9, 10, 14, 26, 34, 70, 94, 96, 200, after.length - 1]) {
    const b = Buffer.from(after); b[pos] ^= 1;
    const q = tp(); fs.writeFileSync(q, b);
    await assert.rejects(cs.readDecrypted(q, { encrypted: true }), undefined, `pos ${pos}`);
  }
  assert.throws(() => cs.rewrapHeader(p, { toKeyId: 9 }), { code: 'KEY_UNKNOWN' });
  cs.useKeys(null);
});

test('Domain-Separation: KCV und Spaltenschlüssel unterscheiden sich vom Master-Key', () => {
  assert.notStrictEqual(cs.getKeyCheckValue(KEY), crypto.createHmac('sha256', KEY).update('mycloud-kcv').digest('hex'));
  assert.ok(!cs.deriveColumnKey(KEY).equals(KEY));
  assert.ok(!cs.deriveColumnKey(KEY).equals(cs.deriveColumnKey(KEY, 'mycloud-file-wrap-v1')));
});

test('S4 withPlaintextTempFile: ohne MYCLOUD_TMP_DIR Fehler bei aktivem Key, ext-Whitelist', withKey(KEY, async () => {
  const p = await enc(Buffer.from('x'));
  const saved = { t: process.env.MYCLOUD_TMP_DIR, a: process.env.MYCLOUD_ALLOW_DISK_TMP };
  delete process.env.MYCLOUD_TMP_DIR; delete process.env.MYCLOUD_ALLOW_DISK_TMP;
  try {
    await assert.rejects(cs.withPlaintextTempFile(p, async () => {}, { encrypted: true }), /MYCLOUD_TMP_DIR/);
    process.env.MYCLOUD_ALLOW_DISK_TMP = '1';
    const w = console.warn; console.warn = () => {};
    try { await cs.withPlaintextTempFile(p, async t => assert.strictEqual(fs.readFileSync(t, 'utf8'), 'x'), { encrypted: true }); } finally { console.warn = w; }
    process.env.MYCLOUD_TMP_DIR = fs.mkdtempSync(path.join(tmpRoot, 'tt-'));
    for (const bad of ['../x', 'A', 'toolong', '', 'a.b'])
      await assert.rejects(cs.withPlaintextTempFile(p, async () => {}, { encrypted: true, ext: bad }), RangeError, bad);
    await cs.withPlaintextTempFile(p, async t => assert.ok(t.endsWith('/plain.mp4')), { encrypted: true, ext: 'mp4' });
  } finally {
    for (const [k, v] of [['MYCLOUD_TMP_DIR', saved.t], ['MYCLOUD_ALLOW_DISK_TMP', saved.a]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}));

test('S4 sweepOrphans: enge Muster, kein Folgen von Symlinks, tmp nicht rekursiv', async () => {
  const d = fs.mkdtempSync(path.join(tmpRoot, 'sweep-'));
  const up = path.join(d, 'up'), tmp = path.join(d, 'tmp'), outside = path.join(d, 'outside');
  for (const x of [up, path.join(up, 'user1'), tmp, outside]) fs.mkdirSync(x);
  const old = new Date(Date.now() - 2 * 3600 * 1000);
  const mk = (f, o = true) => { fs.writeFileSync(f, 'x'); if (o) fs.utimesSync(f, old, old); };
  const U = '123e4567-e89b-12d3-a456-426614174000';
  mk(path.join(up, U));
  mk(path.join(up, 'user1', `${U}.tmp-abcdef123456`));
  mk(path.join(up, 'user1', `${U}.png.jpg.enc-tmp-abcdef123456`));
  mk(path.join(up, 'x.tmp-deadbeef'));                    // Nutzerdatei
  mk(path.join(up, `${U}.tmp-abcdef123456.txt`));         // Nutzerdatei
  mk(path.join(up, `${U}.tmp-abcdef654321`), false);      // jung
  mk(path.join(outside, `${U}.tmp-abcdef123456`));
  fs.symlinkSync(path.join(outside, `${U}.tmp-abcdef123456`), path.join(up, `${U}.tmp-111111111111`));
  fs.symlinkSync(outside, path.join(up, 'linkdir'));
  const mkTmp = (name, mode, o = true) => { const p = path.join(tmp, name); fs.mkdirSync(p, { mode }); fs.chmodSync(p, mode); if (o) fs.utimesSync(p, old, old); return p; };
  mkTmp('mycloud-AbC123', 0o700);
  mkTmp('mycloud-frisch', 0o700, false);
  mkTmp('mycloud-ZzZ999', 0o755);
  mkTmp('anderes', 0o700);
  fs.mkdirSync(path.join(tmp, 'sub')); mk(path.join(tmp, 'sub', `${U}.tmp-abcdef123456`));
  fs.symlinkSync(outside, path.join(tmp, 'mycloud-LnK123'));
  assert.strictEqual(await cs.sweepOrphans({ uploads: up, tmp, nichtda: 1 }), 3);
  assert.deepStrictEqual(fs.readdirSync(up).sort(), [U, 'linkdir', 'user1', 'x.tmp-deadbeef', `${U}.tmp-111111111111`, `${U}.tmp-abcdef123456.txt`, `${U}.tmp-abcdef654321`].sort());
  assert.deepStrictEqual(fs.readdirSync(path.join(up, 'user1')), []);
  assert.deepStrictEqual(fs.readdirSync(tmp).sort(), ['anderes', 'mycloud-LnK123', 'mycloud-ZzZ999', 'mycloud-frisch', 'sub']);
  assert.ok(fs.existsSync(path.join(outside, `${U}.tmp-abcdef123456`)));
  assert.ok(fs.existsSync(path.join(tmp, 'sub', `${U}.tmp-abcdef123456`)));
  assert.strictEqual(await cs.sweepOrphans({}), 0);
});

test('sweepOrphans chunked: UUID-Verzeichnisse (auch gefüllt) weg, Rest und Symlinks bleiben', async () => {
  const d = fs.mkdtempSync(path.join(tmpRoot, 'sweepc-'));
  const ch = path.join(d, 'tmp-chunked'), outside = path.join(d, 'outside');
  fs.mkdirSync(ch); fs.mkdirSync(outside);
  const U = '123e4567-e89b-12d3-a456-426614174000', V = '223e4567-e89b-12d3-a456-426614174000';
  fs.mkdirSync(path.join(ch, U)); fs.writeFileSync(path.join(ch, U, '0'), 'x');
  fs.mkdirSync(path.join(ch, V));
  fs.mkdirSync(path.join(ch, 'fremd')); fs.writeFileSync(path.join(ch, 'datei'), 'x');
  fs.symlinkSync(outside, path.join(ch, '323e4567-e89b-12d3-a456-426614174000'));
  await new Promise(r => setTimeout(r, 20)); // mtime hat Sub-Millisekunden, Date.now() nicht
  assert.strictEqual(await cs.sweepOrphans({ chunked: ch }, { maxAgeMs: 0 }), 2);
  assert.deepStrictEqual(fs.readdirSync(ch).sort(), ['323e4567-e89b-12d3-a456-426614174000', 'datei', 'fremd']);
  // junge Verzeichnisse bleiben bei Standardalter
  fs.mkdirSync(path.join(ch, U));
  assert.strictEqual(await cs.sweepOrphans({ chunked: ch }), 0);
});

test('Start-Check MYCLOUD_TMP_DIR: nur tmpfs/ramfs, Ausnahme per MYCLOUD_ALLOW_DISK_TMP', withKey(KEY, async () => {
  const saved = { t: process.env.MYCLOUD_TMP_DIR, a: process.env.MYCLOUD_ALLOW_DISK_TMP };
  try {
    delete process.env.MYCLOUD_TMP_DIR; delete process.env.MYCLOUD_ALLOW_DISK_TMP;
    cs.checkTmpDirAtStartup(); // ohne Verzeichnis: no-op
    process.env.MYCLOUD_TMP_DIR = path.join(tmpRoot, 'gibt-es-nicht');
    assert.throws(() => cs.checkTmpDirAtStartup(), { code: 'TMP_UNUSABLE' });
    if (fs.existsSync('/proc/self')) { // procfs ist weder tmpfs noch ramfs
      process.env.MYCLOUD_TMP_DIR = '/proc';
      assert.throws(() => cs.checkTmpDirAtStartup(), { code: 'TMP_NOT_TMPFS' });
      const warns = [];
      process.env.MYCLOUD_ALLOW_DISK_TMP = '1';
      cs.checkTmpDirAtStartup({ warn: m => warns.push(m) });
      assert.ok(warns.length === 1 && /MYCLOUD_ALLOW_DISK_TMP/.test(warns[0]));
    }
    cs.useKeys(null);
    process.env.MYCLOUD_TMP_DIR = '/proc'; delete process.env.MYCLOUD_ALLOW_DISK_TMP;
    cs.checkTmpDirAtStartup(); // ohne Key no-op
  } finally {
    for (const [k, v] of [['MYCLOUD_TMP_DIR', saved.t], ['MYCLOUD_ALLOW_DISK_TMP', saved.a]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}));

test('Leere Datei: legitim lesbar, Abschneiden/Tag-Flip erkannt', withKey(KEY, async () => {
  process.env.MYCLOUD_TMP_DIR = fs.mkdtempSync(path.join(tmpRoot, 'et-'));
  try {
  const emptyP = await enc(Buffer.alloc(0));
  const raw = fs.readFileSync(emptyP);
  assert.strictEqual(raw.length, 112);
  for (const range of [{}, { start: 0 }, { start: 0, end: 0 }, { start: 5, end: 9 }, { start: 3, end: 1 }]) {
    assert.strictEqual((await collect(cs.createDecryptStream(emptyP, { encrypted: true, ...range }))).length, 0);
  }
  assert.strictEqual((await cs.readDecrypted(emptyP, { encrypted: true })).length, 0);
  await cs.withPlaintextTempFile(emptyP, async t => assert.strictEqual(fs.readFileSync(t).length, 0), { encrypted: true });
  // (a) Datei mit Inhalt auf 112 Byte kürzen und plainSize=0 setzen
  const full = fs.readFileSync(await enc(crypto.randomBytes(5000)));
  const cut = Buffer.from(full.subarray(0, 112)); cut.writeBigUInt64BE(0n, 18);
  const q = tp(); fs.writeFileSync(q, cut);
  for (const range of [{}, { start: 0, end: 0 }, { start: 9, end: 3 }]) {
    assert.throws(() => cs.createDecryptStream(q, { encrypted: true, ...range }), { code: 'ECORRUPT' });
  }
  await assert.rejects(cs.readDecrypted(q, { encrypted: true }), { code: 'ECORRUPT' });
  await assert.rejects(cs.withPlaintextTempFile(q, async () => {}, { encrypted: true }), { code: 'ECORRUPT' });
  // (c) gekippter Tag
  const bad = Buffer.from(raw); bad[111] ^= 1;
  const q2 = tp(); fs.writeFileSync(q2, bad);
  await assert.rejects(cs.readDecrypted(q2, { encrypted: true }), { code: 'ECORRUPT' });
  // Leere Datei: Segment-Bytes einer anderen Datei
  const other = fs.readFileSync(await enc(Buffer.alloc(0)));
  const q3 = tp(); fs.writeFileSync(q3, Buffer.concat([raw.subarray(0, 96), other.subarray(96)]));
  await assert.rejects(cs.readDecrypted(q3, { encrypted: true }), { code: 'ECORRUPT' });
  } finally { delete process.env.MYCLOUD_TMP_DIR; }
}));

test('KCV-Erstinitialisierung: Race (anderer Wert nach INSERT) -> Abbruch', async () => {
  cs.useKeys(KEY);
  const db = { query: async sql => (/^SELECT key/.test(sql) ? { rows: [] } : /^SELECT value/.test(sql) ? { rows: [{ value: 'ff'.repeat(32) }] } : { rows: [] }) };
  const log = console.log; console.log = () => {};
  try { await assert.rejects(cs.checkMasterKeyAtStartup(db), { code: 'KCV_MISMATCH' }); } finally { console.log = log; cs.useKeys(null); }
});

test('rewrapHeader: Backup wird entfernt, recoverRewrap stellt nach Teil-Write wieder her', async () => {
  const data = crypto.randomBytes(3000);
  cs.useKeys({ current: 1, keys: new Map([[1, KEY], [2, KEY2]]) });
  const p = await enc(data);
  const orig = fs.readFileSync(p);
  assert.deepStrictEqual(cs.recoverRewrap(p), { recovered: false, reason: 'kein Backup' });
  cs.rewrapHeader(p, { toKeyId: 2 });
  assert.ok(!fs.existsSync(p + '.rewrap-bak'));
  // simulierter Teil-Write: Backup (alter Header) vorhanden, aktueller Header halb überschrieben
  const half = fs.readFileSync(p);
  fs.writeFileSync(p + '.rewrap-bak', orig.subarray(0, 96), { mode: 0o600 });
  const torn = Buffer.from(half); orig.copy(torn, 50, 50, 96); // vordere Hälfte neu (keyId 2), Rest alt
  fs.writeFileSync(p, torn);
  await assert.rejects(cs.readDecrypted(p, { encrypted: true }));
  assert.deepStrictEqual(cs.recoverRewrap(p), { recovered: true });
  assert.ok(!fs.existsSync(p + '.rewrap-bak'));
  assert.ok((await cs.readDecrypted(p, { encrypted: true })).equals(data));
  assert.strictEqual(fs.readFileSync(p).readUInt32BE(10), 1);
  // intakter Header + Backup: Backup wird nur gelöscht
  fs.writeFileSync(p + '.rewrap-bak', orig.subarray(0, 96));
  assert.deepStrictEqual(cs.recoverRewrap(p), { recovered: false, reason: 'Header intakt' });
  assert.ok(!fs.existsSync(p + '.rewrap-bak'));
  cs.useKeys(null);
});

test('Heuristik-Warnung bei encrypted undefined (einmalig)', withKey(KEY, async () => {
  const p = await enc(Buffer.from('a'));
  const w = console.warn; const msgs = []; console.warn = m => msgs.push(m);
  try { await cs.readDecrypted(p); await cs.readDecrypted(p); } finally { console.warn = w; }
  assert.ok(msgs.length <= 1);
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
  assert.match(cs.getKeyCheckValue(KEY), /^[0-9a-f]{64}$/);
  assert.strictEqual(cs.getKeyCheckValue(KEY), cs.getKeyCheckValue(KEY));
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

test('Start-Check (kcv pro keyId): Erststart, gleicher Key, falscher Key, Key fehlt, Rotation', async () => {
  const rows = new Map();
  let encFiles = false;
  const db = { query: async (sql, p) => {
    if (/FROM files/.test(sql)) return { rows: encFiles ? [{ '?column?': 1 }] : [] };
    if (/^SELECT/.test(sql)) return { rows: [...rows].filter(([key]) => !p || key === p[0]).map(([key, value]) => ({ key, value })) };
    if (!rows.has(p[0])) rows.set(p[0], p[1]);
    return { rows: [] };
  } };
  const warns = []; const opts = { warn: m => warns.push(m) };
  const cfg = (current, ...ids) => ({ current, keys: new Map(ids.map(i => [i, { 1: KEY, 2: KEY2, 3: KEY3 }[i]])) });
  const KEY3 = crypto.randomBytes(32);
  const log = console.log; console.log = () => {};
  try {
    cs.useKeys(null);
    await cs.checkMasterKeyAtStartup(db, opts);          // ohne Key, ohne kcv: no-op
    assert.strictEqual(rows.size, 0);
    // P2: verschlüsselte Dateien vorhanden -> ohne Key Abbruch, und keine KCV-Erstinitialisierung
    encFiles = true;
    await assert.rejects(cs.checkMasterKeyAtStartup(db, opts), { code: 'KEY_MISSING_ENC_FILES' });
    cs.useKeys(cfg(1, 1));
    await assert.rejects(cs.checkMasterKeyAtStartup(db, opts), { code: 'KCV_MISSING_ENC_FILES' });
    assert.strictEqual(rows.size, 0);
    encFiles = false;
    cs.useKeys(cfg(1, 1));
    await cs.checkMasterKeyAtStartup(db, opts);
    assert.strictEqual(rows.get('crypto_kcv:1'), cs.getKeyCheckValue(KEY));
    await cs.checkMasterKeyAtStartup(db, opts);          // gleicher Key
    cs.useKeys({ current: 1, keys: new Map([[1, KEY2]]) });
    await assert.rejects(cs.checkMasterKeyAtStartup(db, opts), { code: 'KCV_MISMATCH' });
    cs.useKeys(null);
    await assert.rejects(cs.checkMasterKeyAtStartup(db, opts), { code: 'KCV_NO_KEY' });
    // Rotation: neuer current (2) mit altem Key 1 -> Eintrag für 2 wird angelegt
    cs.useKeys(cfg(2, 1, 2));
    await cs.checkMasterKeyAtStartup(db, opts);
    assert.strictEqual(rows.get('crypto_kcv:2'), cs.getKeyCheckValue(KEY2));
    // Neue keyId 3 ohne einen passenden alten Key -> Abbruch, nichts angelegt
    cs.useKeys({ current: 3, keys: new Map([[3, KEY3]]) });
    await assert.rejects(cs.checkMasterKeyAtStartup(db, opts), { code: 'KCV_MISMATCH' });
    assert.ok(!rows.has('crypto_kcv:3'));
    // Alter Key 1 entfernt: nur Warnung
    cs.useKeys(cfg(2, 2));
    await cs.checkMasterKeyAtStartup(db, opts);
    assert.ok(warns.some(w => w.includes('keyId 1')));
    // nicht numerische keyId wird ignoriert (Warnung)
    rows.set('crypto_kcv:abc', 'zz');
    await cs.checkMasterKeyAtStartup(db, opts);
    assert.ok(warns.some(w => w.includes('crypto_kcv:abc')));
    rows.delete('crypto_kcv:abc');
    // current passt nicht -> Abbruch, auch wenn ein anderer Key passt
    cs.useKeys({ current: 2, keys: new Map([[1, KEY], [2, KEY3]]) });
    await assert.rejects(cs.checkMasterKeyAtStartup(db, opts), { code: 'KCV_MISMATCH' });
  } finally { console.log = log; cs.useKeys(null); }
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
  const noOut = spawnSync('node', [script, 'init'], { encoding: 'utf8', cwd: dir });
  assert.notStrictEqual(noOut.status, 0);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['master_key']);
  const bad = path.join(dir, 'bad'); fs.writeFileSync(bad, 'xyz');
  const r = spawnSync('node', [script, 'check', bad], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.ok(!r.stdout.includes('xyz') && !r.stderr.includes('xyz'));
  assert.notStrictEqual(spawnSync('node', [script, 'check', path.join(dir, 'nix')]).status, 0);
});
