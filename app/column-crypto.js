'use strict';
/*
 * Spaltenverschlüsselung (Konzept Abschnitt 4, Phase P3): users.totp_secret, settings (email_smtp_pass,
 * sso_client_secret), file_versions.content, shares.message.
 *
 * Format: `enc:v1:<keyId>:<base64(nonce 12 B | ciphertext | tag 16 B)>`, AES-256-GCM, Schlüssel =
 * cryptoStore.deriveColumnKey(masterKey(keyId), "mycloud-column-v1"). `context` (z. B. "shares.message") ist die AAD:
 * Ein Wert lässt sich nicht in eine andere Spalte kopieren. Bewusst NICHT an die Zeilen-ID gebunden, damit
 * Kopieren/Restore funktioniert.
 *
 * Verhalten:
 *   - ohne Master-Key schreibt encryptColumn Klartext (wie bisher), decryptColumn liest Klartext;
 *   - ein `enc:v1:`-Wert ohne Key: Fehler COLUMN_NO_KEY (kein Klartext-Fallback);
 *   - Klartext-Wert mit Key (Altbestand vor der Migration): wird unverändert zurückgegeben;
 *   - ungültiges Format, unbekannte keyId, falscher Key, manipulierter Wert oder falscher Kontext: Fehler mit `code`.
 * null/undefined werden unverändert durchgereicht.
 */
const crypto = require('crypto');
const cryptoStore = require('./crypto-store');

const PREFIX = 'enc:v1:';
const NONCE = 12;
const TAG = 16;
const VALUE_RE = /^enc:v1:([1-9]\d{0,8}):([A-Za-z0-9+/]+={0,2})$/;

class ColumnCryptoError extends Error {
  constructor(code, message) { super(message); this.name = 'ColumnCryptoError'; this.code = code; }
}

const keyCache = new WeakMap(); // masterKey (Buffer) -> abgeleiteter Spaltenschlüssel
function columnKey(master) {
  let k = keyCache.get(master);
  if (!k) { k = cryptoStore.deriveColumnKey(master, 'mycloud-column-v1'); keyCache.set(master, k); }
  return k;
}

function aad(context) {
  if (typeof context !== 'string' || !context) throw new ColumnCryptoError('COLUMN_CONTEXT', 'Spaltenverschlüsselung: Kontext fehlt.');
  return Buffer.from(`mycloud-column-v1|${context}`, 'utf8');
}

function isEncryptedColumn(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encryptColumn(plain, context) {
  if (plain === null || plain === undefined) return plain;
  const a = aad(context);
  const keyId = cryptoStore.getCurrentKeyId();
  if (keyId === null) return plain;
  const master = cryptoStore.getMasterKey(keyId);
  const nonce = crypto.randomBytes(NONCE);
  const c = crypto.createCipheriv('aes-256-gcm', columnKey(master), nonce, { authTagLength: TAG });
  c.setAAD(a);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `${PREFIX}${keyId}:${Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64')}`;
}

function decryptColumn(value, context) {
  if (typeof value !== 'string' || !isEncryptedColumn(value)) return value;
  const a = aad(context);
  const m = VALUE_RE.exec(value);
  if (!m) throw new ColumnCryptoError('COLUMN_FORMAT', 'Verschlüsselter Datenbankwert hat ein ungültiges Format.');
  const raw = Buffer.from(m[2], 'base64');
  if (raw.length < NONCE + TAG || raw.toString('base64') !== m[2]) throw new ColumnCryptoError('COLUMN_FORMAT', 'Verschlüsselter Datenbankwert hat ein ungültiges Format.');
  if (!cryptoStore.isEnabled()) throw new ColumnCryptoError('COLUMN_NO_KEY', 'Der Datenbankwert ist verschlüsselt, aber es ist kein Master-Key konfiguriert (MYCLOUD_MASTER_KEY_FILE).');
  const keyId = Number(m[1]);
  const master = cryptoStore.getMasterKey(keyId);
  if (!master) throw new ColumnCryptoError('COLUMN_KEY_UNKNOWN', `Der Datenbankwert wurde mit Master-Key ${keyId} verschlüsselt, dieser Key ist nicht konfiguriert.`);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', columnKey(master), raw.subarray(0, NONCE), { authTagLength: TAG });
    d.setAAD(a);
    d.setAuthTag(raw.subarray(raw.length - TAG));
    return Buffer.concat([d.update(raw.subarray(NONCE, raw.length - TAG)), d.final()]).toString('utf8');
  } catch {
    throw new ColumnCryptoError('COLUMN_DECRYPT', 'Entschlüsselung des Datenbankwerts fehlgeschlagen: falscher Master-Key, falscher Kontext oder manipulierter Wert.');
  }
}

module.exports = { encryptColumn, decryptColumn, isEncryptedColumn, ColumnCryptoError, PREFIX };
