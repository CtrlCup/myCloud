'use strict';
/*
 * crypto-store: einziger Ort, der Datei-Blobs verschlüsselt liest/schreibt (Konzept:
 * docs/Verschluesselung-und-Backup.md, Abschnitte 3 und 5). Nur Node-`crypto`, keine Abhängigkeiten.
 *
 * Ohne konfigurierten Master-Key (isEnabled() === false) laufen alle Funktionen im Klartext-Passthrough.
 * Bereits verschlüsselte Dateien sind ohne passenden Key nicht lesbar (klarer Fehler, nie falsche Daten).
 *
 * Master-Key-Datei (MYCLOUD_MASTER_KEY_FILE), eines von:
 *   - eine Zeile mit 32 Bytes als Hex (64 Zeichen) oder Base64  -> keyId 1
 *   - JSON { "current": 2, "keys": { "1": "<hex|base64>", "2": "<hex|base64>" } }  (für Rotation)
 *
 * Dateiformat v1 (96-Byte-Header, danach Segmente aus Ciphertext + 16 B GCM-Tag):
 *    0  magic "MCENC1\0\0"   8 B
 *    8  version uint16 = 1
 *   10  keyId uint32
 *   14  segSize uint32 (Klartext je Segment, Standard 65536)
 *   18  plainSize uint64
 *   26  noncePfx 8 B zufällig
 *   34  wrappedDek 60 B = Nonce 12 B || verschlüsselter DEK 32 B || Tag 16 B (AES-256-GCM mit dem Master-Key)
 *   94  reserviert 2 B (0)
 * Segment i: Nonce = noncePfx || uint32(i); AAD = Header-Hash || uint32(i) || isLast-Byte.
 *
 * Abweichungen/Präzisierungen zum Konzept (Abschnitt 3.2):
 *   - wrappedDek ist 60 statt 40 Byte (32 B DEK + 12 B Nonce + 16 B Tag passen nicht in 40 B).
 *   - Der Header-Hash (SHA-256) wird mit auf 0 gesetztem plainSize gebildet, weil beim Streamen die
 *     Größe erst am Ende feststeht. plainSize wird stattdessen zusätzlich in die AAD des letzten
 *     Segments aufgenommen und beim Öffnen gegen die Dateigröße geprüft (Abschneiden/Anhängen fällt auf).
 *   - Auch eine leere Datei hat genau ein (leeres) letztes Segment, damit Abschneiden erkennbar bleibt.
 *   - Beginnt eine Datei mit "MCENC", ist aber kein gültiger Header, wird sie als beschädigt
 *     abgelehnt und nicht als Klartext behandelt (Bit-Flips in den Magic-Bytes 5..7 fallen auf).
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
const MAX_SEG_SIZE = 1 << 24;
const OFF = { version: 8, keyId: 10, segSize: 14, plainSize: 18, noncePfx: 26, wrapped: 34, wrappedLen: 60 };

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

/* ---------- Schlüsselableitung ---------- */

function getKeyCheckValue(masterKey) {
  return crypto.createHmac('sha256', masterKey).update('mycloud-kcv').digest('hex');
}

function deriveColumnKey(masterKey, info = 'mycloud-column-v1') {
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), info, 32));
}

/* ---------- Header ---------- */

function headerHash(header) {
  const h = Buffer.from(header);
  h.fill(0, OFF.plainSize, OFF.plainSize + 8);
  return crypto.createHash('sha256').update(h).digest();
}

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

function buildHeader(keyId, kek, dek, segSize) {
  const h = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(h, 0);
  h.writeUInt16BE(1, OFF.version);
  h.writeUInt32BE(keyId, OFF.keyId);
  h.writeUInt32BE(segSize, OFF.segSize);
  crypto.randomBytes(8).copy(h, OFF.noncePfx);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', kek, iv);
  c.setAAD(wrapAad(h));
  const ct = Buffer.concat([c.update(dek), c.final()]);
  Buffer.concat([iv, ct, c.getAuthTag()]).copy(h, OFF.wrapped);
  return h;
}

/** Liest/prüft den Header, entpackt den DEK. Wirft synchron. */
function readHeader(filePath) {
  const keys = getKeys();
  if (!keys) throw fail('ENCRYPTED_NO_KEY', `"${path.basename(filePath)}" ist verschlüsselt, aber es ist kein Master-Key konfiguriert (MYCLOUD_MASTER_KEY_FILE).`);
  const fd = fs.openSync(filePath, 'r');
  let header, size;
  try {
    size = fs.fstatSync(fd).size;
    header = Buffer.alloc(HEADER_SIZE);
    if (fs.readSync(fd, header, 0, HEADER_SIZE, 0) !== HEADER_SIZE) throw fail('ECORRUPT', 'Verschlüsselte Datei: Header unvollständig.');
  } finally { fs.closeSync(fd); }
  if (!header.subarray(0, 8).equals(MAGIC)) throw fail('ECORRUPT', 'Verschlüsselte Datei: ungültiger Header.');
  if (header.readUInt16BE(OFF.version) !== 1) throw fail('ECORRUPT', 'Verschlüsselte Datei: unbekannte Format-Version.');
  const keyId = header.readUInt32BE(OFF.keyId);
  const segSize = header.readUInt32BE(OFF.segSize);
  const plainBig = header.readBigUInt64BE(OFF.plainSize);
  if (segSize < 1 || segSize > MAX_SEG_SIZE || plainBig > BigInt(Number.MAX_SAFE_INTEGER)) throw fail('ECORRUPT', 'Verschlüsselte Datei: ungültige Header-Werte.');
  const plainSize = Number(plainBig);
  const nseg = Math.max(1, Math.ceil(plainSize / segSize));
  if (size !== HEADER_SIZE + plainSize + nseg * TAG_SIZE) throw fail('ECORRUPT', 'Verschlüsselte Datei: Größe passt nicht zum Header (abgeschnitten oder erweitert).');
  const kek = keys.keys.get(keyId);
  if (!kek) throw fail('KEY_UNKNOWN', `Datei wurde mit Master-Key ${keyId} verschlüsselt, dieser Key ist nicht konfiguriert.`);
  let dek;
  try {
    const w = header.subarray(OFF.wrapped, OFF.wrapped + OFF.wrappedLen);
    const d = crypto.createDecipheriv('aes-256-gcm', kek, w.subarray(0, 12));
    d.setAAD(wrapAad(header));
    d.setAuthTag(w.subarray(44, 60));
    dek = Buffer.concat([d.update(w.subarray(12, 44)), d.final()]);
  } catch {
    throw fail('KEY_MISMATCH', 'Entschlüsselung fehlgeschlagen: falscher Master-Key oder beschädigter Header.');
  }
  return { header, hash: headerHash(header), dek, keyId, segSize, plainSize, nseg };
}

/* ---------- Erkennen / Größe ---------- */

function readMagic(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const b = Buffer.alloc(8);
    const n = fs.readSync(fd, b, 0, 8, 0);
    return b.subarray(0, n);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** true, wenn die Datei mit den Magic-Bytes MCENC1\0\0 beginnt (Klartext/kurz/leer -> false). */
function isEncrypted(filePath) {
  return readMagic(filePath).equals(MAGIC);
}

// Ein "MCENC"-Präfix ohne gültige Magic gilt als beschädigt, nicht als Klartext.
function looksEncrypted(filePath) {
  const m = readMagic(filePath);
  return m.length >= 5 && m.subarray(0, 5).equals(MAGIC.subarray(0, 5));
}

/** Klartextgröße: aus dem Header bei verschlüsselten Dateien, sonst Dateigröße. */
function plainSizeOf(filePath) {
  if (looksEncrypted(filePath)) return readHeader(filePath).plainSize;
  return fs.statSync(filePath).size;
}

/* ---------- Schreiben ---------- */

async function* toChunks(input) {
  if (Buffer.isBuffer(input) || typeof input === 'string') yield Buffer.from(input);
  else for await (const c of input) yield Buffer.isBuffer(c) ? c : Buffer.from(c);
}

/**
 * Schreibt `input` (Buffer oder Readable) atomar nach `filePath` (Temp-Datei im selben Verzeichnis, dann
 * rename). Verschlüsselt, wenn ein Master-Key konfiguriert ist, sonst Klartext.
 * Liefert { plainSize, sha256 } (SHA-256 über den Klartext, hex).
 */
async function writeEncrypted(filePath, input, { segSize = DEFAULT_SEG_SIZE } = {}) {
  const keys = getKeys();
  const tmp = `${filePath}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  const sha = crypto.createHash('sha256');
  let plainSize = 0;
  let fh;
  try {
    fh = await fsp.open(tmp, 'wx', 0o600);
    if (!keys) {
      for await (const c of toChunks(input)) { sha.update(c); plainSize += c.length; await fh.write(c); }
    } else {
      const kek = keys.keys.get(keys.current);
      const dek = crypto.randomBytes(32);
      const header = buildHeader(keys.current, kek, dek, segSize);
      const hash = headerHash(header);
      const pfx = header.subarray(OFF.noncePfx, OFF.noncePfx + 8);
      await fh.write(header, 0, HEADER_SIZE, 0);
      let pos = HEADER_SIZE, idx = 0;
      let pending = Buffer.alloc(0);
      const emit = async (data, isLast) => {
        const c = crypto.createCipheriv('aes-256-gcm', dek, segNonce(pfx, idx));
        // plainSize ist für das letzte Segment erst hier bekannt (alle Daten sind dann gezählt)
        c.setAAD(segAad(hash, idx, isLast, plainSize));
        const out = Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
        await fh.write(out, 0, out.length, pos);
        pos += out.length;
        idx++;
      };
      for await (const c of toChunks(input)) {
        sha.update(c);
        plainSize += c.length;
        pending = pending.length ? Buffer.concat([pending, c]) : c;
        // Ein Segment wird erst geschrieben, wenn mehr als segSize Bytes vorliegen: so ist das letzte bekannt.
        while (pending.length > segSize) {
          await emit(pending.subarray(0, segSize), false);
          pending = pending.subarray(segSize);
        }
      }
      await emit(pending, true);
      const ps = Buffer.alloc(8);
      ps.writeBigUInt64BE(BigInt(plainSize));
      await fh.write(ps, 0, 8, OFF.plainSize);
    }
    await fh.sync();
    await fh.close();
    fh = null;
    await fsp.rename(tmp, filePath);
    return { plainSize, sha256: sha.digest('hex') };
  } catch (e) {
    if (fh) await fh.close().catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

/**
 * Verschlüsselt eine vorhandene Klartextdatei atomar an Ort und Stelle. Bereits verschlüsselte Dateien und
 * der Betrieb ohne Key bleiben unverändert (sha256 ist dann null).
 */
async function encryptFileInPlace(filePath) {
  if (!isEnabled() || looksEncrypted(filePath)) {
    return { plainSize: plainSizeOf(filePath), sha256: null, changed: false };
  }
  const r = await writeEncrypted(filePath, fs.createReadStream(filePath));
  return { ...r, changed: true };
}

/* ---------- Lesen ---------- */

/**
 * Readable über den Klartext (start/end inklusive, wie fs.createReadStream). Entschlüsselt nur die
 * betroffenen Segmente; GCM-Fehler werden zum Stream-Fehler. Klartextdateien werden unverändert gelesen.
 * Header-/Key-Fehler werfen synchron.
 */
function createDecryptStream(filePath, { start = 0, end } = {}) {
  if (!looksEncrypted(filePath)) {
    return fs.createReadStream(filePath, end === undefined ? { start } : { start, end });
  }
  const info = readHeader(filePath);
  const { hash, dek, segSize, plainSize, nseg } = info;
  const pfx = info.header.subarray(OFF.noncePfx, OFF.noncePfx + 8);
  if (end === undefined || end > plainSize - 1) end = plainSize - 1;
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end)) throw new RangeError('Ungültiger Bereich');
  if (start > end) return Readable.from([]);
  const first = Math.floor(start / segSize);
  const last = Math.floor(end / segSize);
  async function* gen() {
    const fh = await fsp.open(filePath, 'r');
    try {
      for (let i = first; i <= last; i++) {
        const isLast = i === nseg - 1;
        const len = (isLast ? plainSize - i * segSize : segSize) + TAG_SIZE;
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, HEADER_SIZE + i * (segSize + TAG_SIZE));
        if (bytesRead !== len) throw fail('ECORRUPT', 'Verschlüsselte Datei: Segment unvollständig.');
        let plain;
        try {
          const d = crypto.createDecipheriv('aes-256-gcm', dek, segNonce(pfx, i));
          d.setAAD(segAad(hash, i, isLast, plainSize));
          d.setAuthTag(buf.subarray(len - TAG_SIZE));
          plain = Buffer.concat([d.update(buf.subarray(0, len - TAG_SIZE)), d.final()]);
        } catch {
          throw fail('ECORRUPT', `Integritätsprüfung fehlgeschlagen (Segment ${i}): Datei beschädigt oder manipuliert.`);
        }
        const from = i === first ? start - i * segSize : 0;
        const to = i === last ? end - i * segSize + 1 : plain.length;
        yield plain.subarray(from, to);
      }
    } finally { await fh.close(); }
  }
  return Readable.from(gen(), { objectMode: false });
}

async function readDecrypted(filePath) {
  if (!looksEncrypted(filePath)) return fsp.readFile(filePath);
  const chunks = [];
  for await (const c of createDecryptStream(filePath)) chunks.push(c);
  return Buffer.concat(chunks);
}

/**
 * Entschlüsselt `filePath` in eine private Temp-Datei (Verzeichnis 0700, Datei 0600 unter
 * MYCLOUD_TMP_DIR bzw. os.tmpdir()), ruft fn(tmpPath) auf und löscht alles in finally.
 * Unverschlüsselte Dateien werden ohne Kopie direkt übergeben (fn darf sie dann nicht verändern).
 */
async function withPlaintextTempFile(filePath, fn) {
  if (!looksEncrypted(filePath)) return fn(filePath);
  const base = process.env.MYCLOUD_TMP_DIR || os.tmpdir();
  const dir = await fsp.mkdtemp(path.join(base, 'mycloud-'));
  try {
    await fsp.chmod(dir, 0o700);
    const tmp = path.join(dir, 'plain');
    const fh = await fsp.open(tmp, 'wx', 0o600);
    try {
      for await (const c of createDecryptStream(filePath)) await fh.write(c);
    } finally { await fh.close(); }
    return await fn(tmp);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ---------- Start-Prüfung ---------- */

/**
 * Key-Check-Wert gegen die DB prüfen (Einstellung "crypto_kcv"). `db` hat query(sql, params).
 * Wirft bei falschem/fehlendem Key mit deutscher Meldung. Ohne Key und ohne gespeicherten Wert: no-op.
 */
async function checkMasterKeyAtStartup(db) {
  const keys = getKeys();
  const r = await db.query("SELECT value FROM settings WHERE key = 'crypto_kcv'");
  const stored = r.rows[0] ? r.rows[0].value : null;
  if (!keys) {
    if (stored) throw fail('KCV_NO_KEY', 'Diese Instanz wurde mit einem Master-Key verschlüsselt, aber MYCLOUD_MASTER_KEY_FILE ist nicht gesetzt. Start abgebrochen, damit verschlüsselte Dateien nicht als beschädigt behandelt werden. Key-Datei wieder einbinden.');
    return;
  }
  if (!stored) {
    await db.query("INSERT INTO settings (key, value) VALUES ('crypto_kcv', $1) ON CONFLICT (key) DO NOTHING", [getKeyCheckValue(keys.keys.get(keys.current))]);
    console.log('Verschlüsselung: Master-Key geladen, Key-Check-Wert gespeichert.');
    return;
  }
  const s = Buffer.from(stored, 'hex');
  for (const k of keys.keys.values()) {
    const c = Buffer.from(getKeyCheckValue(k), 'hex');
    if (c.length === s.length && crypto.timingSafeEqual(c, s)) return;
  }
  throw fail('KCV_MISMATCH', 'Der Master-Key in MYCLOUD_MASTER_KEY_FILE passt nicht zu dieser Instanz (Key-Check-Wert weicht ab). Start abgebrochen. Richtige Key-Datei einbinden oder mit dem Recovery-Code wiederherstellen.');
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
  writeEncrypted, encryptFileInPlace, createDecryptStream, readDecrypted, withPlaintextTempFile,
  checkMasterKeyAtStartup, formatRecoveryCode, parseRecoveryCode,
};
