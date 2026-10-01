'use strict';
/*
 * crypto-store: einziger Ort, der Datei-Blobs verschlüsselt liest/schreibt (Konzept:
 * docs/Verschluesselung-und-Backup.md, Abschnitte 3 und 5). Nur Node-`crypto`, keine Abhängigkeiten.
 *
 * Ohne konfigurierten Master-Key (isEnabled() === false) schreibt writeEncrypted Klartext (Passthrough).
 * Ob eine vorhandene Datei verschlüsselt ist, entscheidet der AUFRUFER (später files.enc_version) über
 * die Option `encrypted`:
 *   true      -> strikt: Header ungültig/Magic falsch -> Fehler, niemals Klartext.
 *   false     -> Klartext lesen, auch wenn die Bytes wie ein Header aussehen.
 *   undefined -> Heuristik isEncrypted() (exakte 8-Byte-Magic). NUR für Migration/Recovery erlaubt.
 *
 * Master-Key-Datei (MYCLOUD_MASTER_KEY_FILE), eines von:
 *   - eine Zeile mit 32 Bytes als Hex (64 Zeichen) oder Base64  -> keyId 1
 *   - JSON { "current": 2, "keys": { "1": "<hex|base64>", "2": "<hex|base64>" } }  (für Rotation)
 * Der Master-Key wird nie direkt als Cipher-Key benutzt: per HKDF-SHA256 (leeres Salt) entstehen je Key
 * kek_wrap ("mycloud-file-wrap-v1"), kcv_key ("mycloud-kcv-v1") und col_key ("mycloud-column-v1").
 *
 * Dateiformat v1 (96-Byte-Header, danach Segmente aus Ciphertext + 16 B GCM-Tag):
 *    0  magic "MCENC1\0\0"   8 B
 *    8  version uint16 = 1
 *   10  keyId uint32           (änderbar durch rewrapHeader)
 *   14  segSize uint32
 *   18  plainSize uint64       (beim Schreiben erst am Ende bekannt, NICHT authentisiert im Header)
 *   26  noncePfx 8 B zufällig
 *   34  wrappedDek 60 B = Wrap-IV 12 B || verschlüsselter DEK 32 B || Tag 16 B (AES-256-GCM mit kek_wrap,
 *       AAD = magic..segSize inkl. keyId + noncePfx)
 *   94  reserviert 2 B (0)
 * Segment i: Nonce = noncePfx || uint32(i);
 *   AAD = SHA256(magic||version||segSize||noncePfx||reserved) || uint32(i) || isLast-Byte
 *         [|| plainSize uint64 nur beim letzten Segment]
 * Segment-AAD bindet nur UNVERÄNDERLICHE Header-Felder (nicht keyId/wrappedDek), damit rewrapHeader nur
 * die 96 Header-Bytes ändert. Der DEK ist durch den GCM-Wrap authentisiert.
 * plainSize steht in der AAD des letzten Segments und wird beim Öffnen gegen die Dateigröße geprüft.
 * Eine leere Datei hat genau ein leeres letztes Segment (Abschneiden bleibt erkennbar).
 *
 * HARTES VERBOT: Nach rewrapHeader (oder generell) niemals neuen Inhalt mit demselben DEK und noncePfx
 * schreiben (Nonce-Wiederverwendung bricht GCM). Neuer Inhalt = neue Datei mit neuem DEK/noncePfx
 * (Copy-on-Write).
 *
 * plainSizeOf() liest nur den Header ohne DEK-Unwrap; die Größe ist dort nicht authentisiert.
 */
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const MAGIC = Buffer.from('MCENC1\0\0', 'latin1');
const HEADER_SIZE = 96;
const TAG_SIZE = 16;
const DEFAULT_SEG_SIZE = 65536;
const MIN_SEG_SIZE = 4096;
const MAX_SEG_SIZE = 1 << 24;
const OFF = { version: 8, keyId: 10, segSize: 14, plainSize: 18, noncePfx: 26, wrapped: 34, wrappedLen: 60, reserved: 94 };

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

/* ---------- Master-Key laden ---------- */

function parseKey(str, what) {
  const s = String(str).trim();
  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) buf = Buffer.from(s, 'hex');
  else if (/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(s)) buf = Buffer.from(s, 'base64');
  if (!buf || buf.length !== 32) throw fail('KEY_FORMAT', `${what}: erwartet werden 32 Bytes als Hex (64 Zeichen) oder Base64.`);
  return buf;
}

/** Parst den Inhalt einer Key-Datei -> { current: number, keys: Map<number, Buffer> }. */
function parseKeyFile(content) {
  const text = String(content).trim();
  if (text.startsWith('{')) {
    let json;
    try { json = JSON.parse(text); } catch { throw fail('KEY_FORMAT', 'Master-Key-Datei: ungültiges JSON.'); }
    if (!json || typeof json.keys !== 'object' || !json.keys) throw fail('KEY_FORMAT', 'Master-Key-Datei: Feld "keys" fehlt.');
    const keys = new Map();
    for (const [id, val] of Object.entries(json.keys)) {
      if (!/^[1-9]\d{0,8}$/.test(id)) throw fail('KEY_FORMAT', `Master-Key-Datei: ungültige keyId "${id}".`);
      keys.set(Number(id), parseKey(val, `Key ${id}`));
    }
    const current = Number(json.current);
    if (!keys.has(current)) throw fail('KEY_FORMAT', 'Master-Key-Datei: "current" verweist auf keinen vorhandenen Key.');
    return { current, keys };
  }
  return { current: 1, keys: new Map([[1, parseKey(text, 'Master-Key')]]) };
}

let keyState; // undefined = noch nicht geladen, null = deaktiviert

/** Lädt die Keys aus `file` (Standard: MYCLOUD_MASTER_KEY_FILE). Ohne Pfad: null (Verschlüsselung aus). */
function loadMasterKeys(file = process.env.MYCLOUD_MASTER_KEY_FILE) {
  if (!file) { keyState = null; return null; }
  let content;
  try { content = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw fail('KEY_UNREADABLE', `Master-Key-Datei "${file}" nicht lesbar: ${e.code || e.message}`); }
  keyState = parseKeyFile(content);
  return keyState;
}

/** Setzt die Keys direkt (Tests, scripts); null = Verschlüsselung aus. */
function useKeys(cfg) {
  if (cfg && Buffer.isBuffer(cfg)) cfg = { current: 1, keys: new Map([[1, cfg]]) };
  keyState = cfg || null;
}

function getKeys() {
  if (keyState === undefined) loadMasterKeys();
  return keyState;
}

function isEnabled() {
  return !!getKeys();
}

/* ---------- Schlüsselableitung (Domain-Separation) ---------- */

const hk = (master, info) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
const derivedCache = new WeakMap();
function derived(master) {
  let d = derivedCache.get(master);
  if (!d) {
    d = { wrap: hk(master, 'mycloud-file-wrap-v1'), kcv: hk(master, 'mycloud-kcv-v1'), col: hk(master, 'mycloud-column-v1') };
    derivedCache.set(master, d);
  }
  return d;
}

/** Key-Check-Wert (hex) = HMAC-SHA256(kcv_key, "mycloud-kcv"). */
function getKeyCheckValue(masterKey) {
  return crypto.createHmac('sha256', derived(masterKey).kcv).update('mycloud-kcv').digest('hex');
}

function deriveColumnKey(masterKey, info = 'mycloud-column-v1') {
  return info === 'mycloud-column-v1' ? Buffer.from(derived(masterKey).col) : hk(masterKey, info);
}

/* ---------- Header ---------- */

// Nur unveränderliche Felder (nicht keyId, wrappedDek, plainSize): rewrapHeader ändert die Segmente nicht.
function segHash(header) {
  return crypto.createHash('sha256')
    .update(header.subarray(0, OFF.keyId))
    .update(header.subarray(OFF.segSize, OFF.plainSize))
    .update(header.subarray(OFF.noncePfx, OFF.wrapped))
    .update(header.subarray(OFF.reserved, HEADER_SIZE))
    .digest();
}

// Bindet keyId, segSize, noncePfx (und magic/version) an den gewrappten DEK.
function wrapAad(header) {
  return Buffer.concat([header.subarray(0, OFF.plainSize), header.subarray(OFF.noncePfx, OFF.wrapped)]);
}

function segNonce(noncePfx, i) {
  const n = Buffer.alloc(12);
  noncePfx.copy(n, 0);
  n.writeUInt32BE(i, 8);
  return n;
}

function segAad(hash, i, isLast, plainSize) {
  const a = Buffer.alloc(32 + 4 + 1 + (isLast ? 8 : 0));
  hash.copy(a, 0);
  a.writeUInt32BE(i, 32);
  a[36] = isLast ? 1 : 0;
  if (isLast) a.writeBigUInt64BE(BigInt(plainSize), 37);
  return a;
}

const cipher = (key, iv) => crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_SIZE });
const decipher = (key, iv) => crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_SIZE });

// Schreibt den gewrappten DEK mit frischem Wrap-IV in header (nach Setzen von keyId/segSize/noncePfx).
function wrapInto(header, master, dek) {
  const iv = crypto.randomBytes(12);
  const c = cipher(derived(master).wrap, iv);
  c.setAAD(wrapAad(header));
  const ct = Buffer.concat([c.update(dek), c.final()]);
  Buffer.concat([iv, ct, c.getAuthTag()]).copy(header, OFF.wrapped);
}

function buildHeader(keyId, master, dek, segSize) {
  const h = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(h, 0);
  h.writeUInt16BE(1, OFF.version);
  h.writeUInt32BE(keyId, OFF.keyId);
  h.writeUInt32BE(segSize, OFF.segSize);
  crypto.randomBytes(8).copy(h, OFF.noncePfx);
  wrapInto(h, master, dek);
  return h;
}

function unwrapDek(header) {
  const keys = getKeys();
  if (!keys) throw fail('ENCRYPTED_NO_KEY', 'Datei ist verschlüsselt, aber es ist kein Master-Key konfiguriert (MYCLOUD_MASTER_KEY_FILE).');
  const keyId = header.readUInt32BE(OFF.keyId);
  const master = keys.keys.get(keyId);
  if (!master) throw fail('KEY_UNKNOWN', `Datei wurde mit Master-Key ${keyId} verschlüsselt, dieser Key ist nicht konfiguriert.`);
  try {
    const w = header.subarray(OFF.wrapped, OFF.wrapped + OFF.wrappedLen);
    const d = decipher(derived(master).wrap, w.subarray(0, 12));
    d.setAAD(wrapAad(header));
    d.setAuthTag(w.subarray(44, 60));
    return Buffer.concat([d.update(w.subarray(12, 44)), d.final()]);
  } catch {
    throw fail('KEY_MISMATCH', 'Entschlüsselung fehlgeschlagen: falscher Master-Key oder beschädigter Header.');
  }
}

/**
 * Öffnet die Datei, prüft den Header strikt (Magic, Version, Größen, Dateilänge) und entpackt optional den DEK.
 * Der Aufrufer schließt `fd` (bei Fehlern schon geschehen).
 */
function openHeader(filePath, { unwrap = true, flags = 'r' } = {}) {
  const fd = fs.openSync(filePath, flags);
  try {
    const size = fs.fstatSync(fd).size;
    const header = Buffer.alloc(HEADER_SIZE);
    if (fs.readSync(fd, header, 0, HEADER_SIZE, 0) !== HEADER_SIZE) throw fail('ECORRUPT', 'Verschlüsselte Datei: Header unvollständig.');
    if (!header.subarray(0, 8).equals(MAGIC)) throw fail('ECORRUPT', 'Verschlüsselte Datei: ungültiger Header (keine MCENC1-Magic).');
    if (header.readUInt16BE(OFF.version) !== 1) throw fail('ECORRUPT', 'Verschlüsselte Datei: unbekannte Format-Version.');
    const keyId = header.readUInt32BE(OFF.keyId);
    const segSize = header.readUInt32BE(OFF.segSize);
    const plainBig = header.readBigUInt64BE(OFF.plainSize);
    if (segSize < MIN_SEG_SIZE || segSize > MAX_SEG_SIZE || plainBig > BigInt(Number.MAX_SAFE_INTEGER)) throw fail('ECORRUPT', 'Verschlüsselte Datei: ungültige Header-Werte.');
    const plainSize = Number(plainBig);
    const nseg = Math.max(1, Math.ceil(plainSize / segSize));
    if (nseg > 2 ** 32) throw fail('ECORRUPT', 'Verschlüsselte Datei: zu viele Segmente.');
    if (size !== HEADER_SIZE + plainSize + nseg * TAG_SIZE) throw fail('ECORRUPT', 'Verschlüsselte Datei: Größe passt nicht zum Header (abgeschnitten oder erweitert).');
    const info = { fd, header, keyId, segSize, plainSize, nseg };
    if (unwrap) { info.dek = unwrapDek(header); info.hash = segHash(header); }
    return info;
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

/* ---------- Erkennen / Größe ---------- */

/** true, wenn die Datei mit den Magic-Bytes MCENC1\0\0 beginnt (Klartext/kurz/leer -> false). */
function isEncrypted(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const b = Buffer.alloc(8);
    return fs.readSync(fd, b, 0, 8, 0) === 8 && b.equals(MAGIC);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// encrypted undefined -> Heuristik (nur Migration/Recovery); sonst Entscheidung des Aufrufers.
const decide = (filePath, encrypted) => (encrypted === undefined ? isEncrypted(filePath) : !!encrypted);

/**
 * Klartextgröße: aus dem Header (ohne DEK-Unwrap, nicht authentisiert) bzw. Dateigröße bei Klartext.
 */
function plainSizeOf(filePath, { encrypted } = {}) {
  if (!decide(filePath, encrypted)) return fs.statSync(filePath).size;
  const { fd, plainSize } = openHeader(filePath, { unwrap: false });
  fs.closeSync(fd);
  return plainSize;
}

/* ---------- Schreiben ---------- */

async function writeAll(fh, buf, pos) {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off, pos + off);
    if (bytesWritten === 0) throw new Error('Schreiben fehlgeschlagen (0 Bytes geschrieben).');
    off += bytesWritten;
  }
}

async function fsyncDir(dir) {
  try { const d = await fsp.open(dir, 'r'); try { await d.sync(); } finally { await d.close(); } } catch { /* best effort */ }
}

async function* toChunks(input) {
  if (Buffer.isBuffer(input) || typeof input === 'string') yield Buffer.from(input);
  else for await (const c of input) yield Buffer.isBuffer(c) ? c : Buffer.from(c);
}

/**
 * Schreibt `input` (Buffer oder Readable) atomar nach `filePath` (Temp-Datei im selben Verzeichnis, fsync,
 * rename, fsync des Verzeichnisses). Verschlüsselt, wenn ein Master-Key konfiguriert ist, sonst Klartext.
 * Liefert { plainSize, sha256 } (SHA-256 über den Klartext, hex).
 */
async function writeEncrypted(filePath, input, { segSize = DEFAULT_SEG_SIZE } = {}) {
  if (!Number.isInteger(segSize) || segSize < MIN_SEG_SIZE || segSize > MAX_SEG_SIZE) throw new RangeError(`segSize muss eine ganze Zahl zwischen ${MIN_SEG_SIZE} und ${MAX_SEG_SIZE} sein.`);
  const keys = getKeys();
  const tmp = `${filePath}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  const sha = crypto.createHash('sha256');
  let plainSize = 0;
  let fh;
  try {
    fh = await fsp.open(tmp, 'wx', 0o600);
    let expected;
    if (!keys) {
      let pos = 0;
      for await (const c of toChunks(input)) { sha.update(c); await writeAll(fh, c, pos); pos += c.length; plainSize += c.length; }
      expected = plainSize;
    } else {
      const master = keys.keys.get(keys.current);
      const dek = crypto.randomBytes(32);
      const header = buildHeader(keys.current, master, dek, segSize);
      const hash = segHash(header);
      const pfx = header.subarray(OFF.noncePfx, OFF.noncePfx + 8);
      await writeAll(fh, header, 0);
      let pos = HEADER_SIZE, idx = 0;
      let pending = Buffer.alloc(0);
      const emit = async (data, isLast) => {
        if (idx > 0xffffffff) throw new Error('Zu viele Segmente.');
        const c = cipher(dek, segNonce(pfx, idx));
        c.setAAD(segAad(hash, idx, isLast, plainSize)); // plainSize ist beim letzten Segment vollständig
        const out = Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
        await writeAll(fh, out, pos);
        pos += out.length;
        idx++;
      };
      for await (const c of toChunks(input)) {
        sha.update(c);
        plainSize += c.length;
        pending = pending.length ? Buffer.concat([pending, c]) : c;
        // Segment erst schreiben, wenn mehr als segSize Bytes vorliegen: so ist das letzte bekannt.
        while (pending.length > segSize) {
          await emit(pending.subarray(0, segSize), false);
          pending = pending.subarray(segSize);
        }
      }
      await emit(pending, true);
      const ps = Buffer.alloc(8);
      ps.writeBigUInt64BE(BigInt(plainSize));
      await writeAll(fh, ps, OFF.plainSize);
      expected = HEADER_SIZE + plainSize + idx * TAG_SIZE;
    }
    if ((await fh.stat()).size !== expected) throw new Error('Geschriebene Dateigröße stimmt nicht mit der erwarteten überein.');
    await fh.sync();
    await fh.close();
    fh = null;
    await fsp.rename(tmp, filePath);
    await fsyncDir(path.dirname(filePath));
    return { plainSize, sha256: sha.digest('hex') };
  } catch (e) {
    if (fh) await fh.close().catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

/**
 * Verschlüsselt eine Klartextdatei atomar an Ort und Stelle. Ohne Key: no-op. Ohne `assumePlain` werden
 * Dateien mit exakter Magic als bereits verschlüsselt übersprungen (Migration, idempotent); mit
 * `assumePlain: true` wird immer verschlüsselt (Aufrufer weiß, dass die Datei Klartext ist).
 */
async function encryptFileInPlace(filePath, { assumePlain = false } = {}) {
  if (!isEnabled() || (!assumePlain && isEncrypted(filePath))) {
    return { plainSize: plainSizeOf(filePath), sha256: null, changed: false };
  }
  const r = await writeEncrypted(filePath, fs.createReadStream(filePath));
  return { ...r, changed: true };
}

/**
 * Ersetzt in einer verschlüsselten Datei NUR den Header: DEK wird mit dem alten Key entpackt und mit dem Key
 * `toKeyId` neu gewrappt (neuer Wrap-IV; DEK, noncePfx und alle Segmentbytes bleiben). Beide Keys müssen
 * konfiguriert sein. Ein pwrite über alle 96 Byte, fsync, danach Wiederlesen und Prüfen.
 */
function rewrapHeader(filePath, { toKeyId }) {
  const keys = getKeys();
  const master = keys && keys.keys.get(toKeyId);
  if (!master) throw fail('KEY_UNKNOWN', `Ziel-Key ${toKeyId} ist nicht konfiguriert.`);
  const info = openHeader(filePath, { flags: 'r+' });
  try {
    const fromKeyId = info.keyId;
    if (fromKeyId === toKeyId) return { fromKeyId, toKeyId, changed: false };
    const h = Buffer.from(info.header);
    h.writeUInt32BE(toKeyId, OFF.keyId);
    wrapInto(h, master, info.dek);
    if (fs.writeSync(info.fd, h, 0, HEADER_SIZE, 0) !== HEADER_SIZE) throw new Error('Header-Schreiben unvollständig.');
    fs.fsyncSync(info.fd);
    const back = Buffer.alloc(HEADER_SIZE);
    fs.readSync(info.fd, back, 0, HEADER_SIZE, 0);
    if (!back.equals(h) || !unwrapDek(back).equals(info.dek)) throw new Error('Rewrap-Verifikation fehlgeschlagen.');
    return { fromKeyId, toKeyId, changed: true };
  } finally { fs.closeSync(info.fd); }
}

/* ---------- Lesen ---------- */

/**
 * Readable über den Klartext (start/end inklusive, wie fs.createReadStream). Entschlüsselt nur die
 * betroffenen Segmente mit einem einzigen fd; GCM-Fehler werden zum Stream-Fehler. Header-/Key-Fehler
 * werfen synchron.
 */
function createDecryptStream(filePath, { start = 0, end, encrypted } = {}) {
  if (!decide(filePath, encrypted)) {
    return fs.createReadStream(filePath, end === undefined ? { start } : { start, end });
  }
  const info = openHeader(filePath);
  const { fd, hash, dek, segSize, plainSize, nseg } = info;
  if (end === undefined || end > plainSize - 1) end = plainSize - 1;
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end)) { fs.closeSync(fd); throw new RangeError('Ungültiger Bereich'); }
  if (start > end) { fs.closeSync(fd); return Readable.from([]); }
  const pfx = info.header.subarray(OFF.noncePfx, OFF.noncePfx + 8);
  const first = Math.floor(start / segSize);
  const last = Math.floor(end / segSize);
  let i = first, inflight = false, closed = false;
  const closeFd = () => { if (!closed && !inflight) { closed = true; fs.closeSync(fd); } };
  return new Readable({
    highWaterMark: segSize,
    read() {
      if (i > last) { this.push(null); return; }
      const idx = i++;
      const isLast = idx === nseg - 1;
      const len = (isLast ? plainSize - idx * segSize : segSize) + TAG_SIZE;
      const buf = Buffer.alloc(len);
      inflight = true;
      fs.read(fd, buf, 0, len, HEADER_SIZE + idx * (segSize + TAG_SIZE), (err, n) => {
        inflight = false;
        if (this.destroyed) { closeFd(); return; }
        if (err) return this.destroy(err);
        if (n !== len) return this.destroy(fail('ECORRUPT', 'Verschlüsselte Datei: Segment unvollständig.'));
        let plain;
        try {
          const d = decipher(dek, segNonce(pfx, idx));
          d.setAAD(segAad(hash, idx, isLast, plainSize));
          d.setAuthTag(buf.subarray(len - TAG_SIZE));
          plain = Buffer.concat([d.update(buf.subarray(0, len - TAG_SIZE)), d.final()]);
        } catch {
          return this.destroy(fail('ECORRUPT', `Integritätsprüfung fehlgeschlagen (Segment ${idx}): Datei beschädigt oder manipuliert.`));
        }
        this.push(plain.subarray(idx === first ? start - idx * segSize : 0, idx === last ? end - idx * segSize + 1 : plain.length));
      });
    },
    destroy(err, cb) { closeFd(); cb(err); },
  });
}

/** Ganze Datei als Buffer; `maxBytes` begrenzt die Klartextgröße (Fehler ETOOBIG). */
async function readDecrypted(filePath, { encrypted, maxBytes } = {}) {
  const isEnc = decide(filePath, encrypted);
  if (maxBytes !== undefined && plainSizeOf(filePath, { encrypted: isEnc }) > maxBytes) throw fail('ETOOBIG', `Datei größer als ${maxBytes} Bytes.`);
  if (!isEnc) return fsp.readFile(filePath);
  const chunks = [];
  for await (const c of createDecryptStream(filePath, { encrypted: true })) chunks.push(c);
  return Buffer.concat(chunks);
}

let warnedDiskTmp = false;

/**
 * Entschlüsselt `filePath` in eine private Temp-Datei (Verzeichnis 0700, Datei 0600 unter MYCLOUD_TMP_DIR),
 * ruft fn(tmpPath) auf und löscht alles in finally. Ist die Verschlüsselung aktiv und MYCLOUD_TMP_DIR nicht
 * gesetzt, gibt es einen Fehler (Klartext soll nicht auf die Platte), außer MYCLOUD_ALLOW_DISK_TMP=1.
 * `ext`: optionale Endung ([a-z0-9]{1,5}), nie der Originalname. Klartextdateien werden ohne Kopie direkt
 * übergeben (fn darf sie dann nicht verändern).
 */
async function withPlaintextTempFile(filePath, fn, { encrypted, ext } = {}) {
  if (ext !== undefined && !/^[a-z0-9]{1,5}$/.test(ext)) throw new RangeError('Ungültige Dateiendung.');
  if (!decide(filePath, encrypted)) return fn(filePath);
  let base = process.env.MYCLOUD_TMP_DIR;
  if (!base) {
    if (isEnabled() && process.env.MYCLOUD_ALLOW_DISK_TMP !== '1') throw new Error('MYCLOUD_TMP_DIR ist nicht gesetzt: Klartext-Temp-Dateien sollen auf ein tmpfs (oder mit MYCLOUD_ALLOW_DISK_TMP=1 bewusst auf die Platte).');
    if (isEnabled() && !warnedDiskTmp) { warnedDiskTmp = true; console.warn('WARNUNG (Verschlüsselung): MYCLOUD_ALLOW_DISK_TMP=1, entschlüsselte Temp-Dateien landen auf der Platte.'); }
    base = os.tmpdir();
  }
  const dir = await fsp.mkdtemp(path.join(base, 'mycloud-'));
  try {
    await fsp.chmod(dir, 0o700);
    const tmp = path.join(dir, ext ? `plain.${ext}` : 'plain');
    const fh = await fsp.open(tmp, 'wx', 0o600);
    try {
      let pos = 0;
      for await (const c of createDecryptStream(filePath, { encrypted: true })) { await writeAll(fh, c, pos); pos += c.length; }
    } finally { await fh.close(); }
    return await fn(tmp);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Räumt Reste abgebrochener Vorgänge auf, die älter als `maxAgeMs` (Standard 1 h) sind: Temp-Verzeichnisse
 * `mycloud-XXXXXX` (nur direkt in den übergebenen Verzeichnissen) sowie Dateien `*.tmp-<hex>` /
 * `*.enc-tmp-<hex>` (rekursiv). Liefert die Anzahl gelöschter Einträge.
 */
async function sweepOrphans(dirs, { maxAgeMs = 3600000 } = {}) {
  const limit = Date.now() - maxAgeMs;
  let n = 0;
  const walk = async (dir, top) => {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory()) {
          if (top && /^mycloud-[A-Za-z0-9]{6}$/.test(e.name)) {
            if ((await fsp.stat(p)).mtimeMs < limit) { await fsp.rm(p, { recursive: true, force: true }); n++; }
          } else await walk(p, false);
        } else if (e.isFile() && /\.(enc-)?tmp-[0-9a-f]{6,}$/.test(e.name)) {
          if ((await fsp.stat(p)).mtimeMs < limit) { await fsp.unlink(p); n++; }
        }
      } catch { /* Eintrag verschwunden oder nicht löschbar: weiter */ }
    }
  };
  for (const d of dirs.filter(Boolean)) await walk(d, true);
  return n;
}

/* ---------- Start-Prüfung ---------- */

/**
 * Key-Check-Werte gegen die DB prüfen (Einstellungen "crypto_kcv:<keyId>"). `db` hat query(sql, params).
 * Wirft bei falschem/fehlendem Key mit deutscher Meldung. Ohne Key und ohne gespeicherte Werte: no-op.
 */
async function checkMasterKeyAtStartup(db, { warn = console.warn } = {}) {
  const keys = getKeys();
  const r = await db.query("SELECT key, value FROM settings WHERE key LIKE 'crypto\\_kcv:%'");
  const stored = new Map(r.rows.map(x => [Number(x.key.slice('crypto_kcv:'.length)), x.value]));
  if (!keys) {
    if (stored.size) throw fail('KCV_NO_KEY', 'Diese Instanz wurde mit einem Master-Key verschlüsselt, aber MYCLOUD_MASTER_KEY_FILE ist nicht gesetzt. Start abgebrochen, damit verschlüsselte Dateien nicht als beschädigt behandelt werden. Key-Datei wieder einbinden.');
    return;
  }
  const matches = (id) => {
    const s = Buffer.from(stored.get(id), 'hex');
    const c = Buffer.from(getKeyCheckValue(keys.keys.get(id)), 'hex');
    return c.length === s.length && crypto.timingSafeEqual(c, s);
  };
  const mismatchMsg = 'Der Master-Key in MYCLOUD_MASTER_KEY_FILE passt nicht zu dieser Instanz (Key-Check-Wert weicht ab). Start abgebrochen. Richtige Key-Datei einbinden oder mit dem Recovery-Code wiederherstellen.';
  const insertCurrent = () => db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [`crypto_kcv:${keys.current}`, getKeyCheckValue(keys.keys.get(keys.current))]);
  if (stored.size === 0) {
    await insertCurrent();
    console.log('Verschlüsselung: Master-Key geladen, Key-Check-Wert gespeichert.');
    return;
  }
  const configuredStored = [...keys.keys.keys()].filter(id => stored.has(id));
  if (stored.has(keys.current)) {
    if (!matches(keys.current)) throw fail('KCV_MISMATCH', mismatchMsg);
  } else {
    // neue keyId (Rotation): erst anlegen, wenn mindestens ein anderer konfigurierter Key zu seinem Eintrag passt
    if (!configuredStored.some(matches)) throw fail('KCV_MISMATCH', mismatchMsg);
    await insertCurrent();
  }
  for (const id of configuredStored) if (id !== keys.current && !matches(id)) warn(`WARNUNG (Verschlüsselung): Key ${id} passt nicht zu seinem gespeicherten Key-Check-Wert.`);
  for (const id of stored.keys()) if (!keys.keys.has(id)) warn(`WARNUNG (Verschlüsselung): Für keyId ${id} ist kein Key mehr konfiguriert; Dateien mit dieser keyId sind nicht lesbar.`);
}

/* ---------- Recovery-Code (Base32, 4er-Gruppen; Master-Key + 2 Byte Prüfsumme) ---------- */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function formatRecoveryCode(masterKey) {
  const data = Buffer.concat([masterKey, crypto.createHash('sha256').update(masterKey).digest().subarray(0, 2)]);
  let bits = 0, acc = 0, out = '';
  for (const b of data) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return out.match(/.{1,4}/g).join('-');
}

function parseRecoveryCode(code) {
  const s = String(code).toUpperCase().replace(/[\s-]/g, '');
  let bits = 0, acc = 0;
  const bytes = [];
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) throw fail('KEY_FORMAT', 'Recovery-Code enthält ungültige Zeichen.');
    acc = (acc << 5) | v; bits += 5;
    if (bits >= 8) { bytes.push((acc >>> (bits - 8)) & 255); bits -= 8; acc &= (1 << bits) - 1; }
  }
  const data = Buffer.from(bytes);
  if (data.length !== 34) throw fail('KEY_FORMAT', 'Recovery-Code hat die falsche Länge.');
  const key = data.subarray(0, 32);
  if (!crypto.createHash('sha256').update(key).digest().subarray(0, 2).equals(data.subarray(32))) throw fail('KEY_FORMAT', 'Recovery-Code: Prüfsumme stimmt nicht (Tippfehler?).');
  return Buffer.from(key);
}

module.exports = {
  HEADER_SIZE, DEFAULT_SEG_SIZE,
  parseKeyFile, loadMasterKeys, useKeys, isEnabled,
  getKeyCheckValue, deriveColumnKey,
  isEncrypted, plainSizeOf,
  writeEncrypted, encryptFileInPlace, rewrapHeader, createDecryptStream, readDecrypted, withPlaintextTempFile, sweepOrphans,
  checkMasterKeyAtStartup, formatRecoveryCode, parseRecoveryCode,
};
