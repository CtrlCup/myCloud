'use strict';
/*
 * Migration bestehender Klartext-Spaltenwerte in das Format `enc:v1:...` (Konzept Abschnitt 4, Phase P3).
 *
 * Läuft nur bei aktivem Master-Key (der Aufrufer startet den Job nur dann). Idempotent und fortsetzbar: ein Abbruch
 * verliert nichts, der nächste Lauf macht dort weiter und verschlüsselt nie doppelt. Alle nicht-leeren Werte werden
 * geprüft:
 *   - kein `enc:v1:`-Prefix: Klartext;
 *   - Prefix und per decryptColumn lesbar: fertig (übersprungen), außer dem Klartext-Escape `enc:v1:p:` (wird dekodiert
 *     und normal verschlüsselt);
 *   - Prefix, aber COLUMN_FORMAT (z. B. Klartext "enc:v1:foo"): ist Klartext und wird verschlüsselt;
 *   - COLUMN_DECRYPT (gültiges Format, Tag passt nicht: manipuliert/falscher Key/Kontext), COLUMN_KEY_UNKNOWN: bewusst
 *     NICHT angefasst, als `unreadable` gezählt und nur mit Spalte/Code/Zeilen-ID geloggt, nie mit dem Wert.
 * Pro zu verschlüsselndem Wert: 1. verschlüsseln, 2. Roundtrip-Verifikation (decrypt(encrypt(x)) === x),
 * 3. optimistisches UPDATE ... WHERE <id> = $ AND <spalte> = <alter Wert> (zwischenzeitlich geänderte Zeilen werden
 * übersprungen).
 * Batches nach id-/key-Cursor, Drosselung wie die Dateimigration (MYCLOUD_MIGRATION_PAUSE_MS, Standard 50).
 * Bei file_versions wird `size` (Klartext-Länge in Zeichen) im selben UPDATE gesetzt, falls noch NULL.
 * Hinweis P6 (Rotation): gültige enc:v1:-Werte werden hier übersprungen, ein Re-Encrypt auf einen neuen Key braucht einen eigenen Lauf.
 */
const { encryptColumn, decryptColumn, PREFIX, ESCAPE_PREFIX } = require('./column-crypto');
const { SECRET_SETTING_KEYS } = require('./db');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envInt = (v, def, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

const settingKeys = SECRET_SETTING_KEYS.map((k) => `'${k}'`).join(', ');

// ctx: Kontext-Funktion (Zeile -> AAD), idCol: Cursor-Spalte, batch: Zeilen pro Durchlauf (versions: klein wegen Größe)
const COLUMNS = [
  { name: 'users.totp_secret', table: 'users', col: 'totp_secret', idCol: 'id', start: 0, scope: 'TRUE', ctx: () => 'users.totp_secret', batch: 100 },
  { name: 'settings', table: 'settings', col: 'value', idCol: 'key', start: '', scope: `key IN (${settingKeys})`, ctx: (r) => `settings.${r.id}`, batch: 20 },
  { name: 'file_versions.content', table: 'file_versions', col: 'content', idCol: 'id', start: 0, scope: 'TRUE', ctx: () => 'file_versions.content', batch: 20, sizeCol: true },
  { name: 'shares.message', table: 'shares', col: 'message', idCol: 'id', start: 0, scope: 'TRUE', ctx: () => 'shares.message', batch: 100 },
];

const NOT_EMPTY = (c) => `${c.col} IS NOT NULL AND ${c.col} <> ''`;

const VALID_RE = '^enc:v1:[1-9][0-9]{0,8}:[A-Za-z0-9+/]+=*$';
let countCache = null; // { at, gen, data }
let countGen = 0;
function invalidateCounts() { countGen++; countCache = null; }

/**
 * Zähler je Spalte: { total, encrypted, plain } (nur nicht-leere Werte; encrypted = Wert hat das gültige Chiffrat-Format,
 * plain = alles andere inkl. Klartext-Escape und Klartext mit enc:v1:-Prefix). `unreadable` je Spalte steuert der Aufrufer
 * aus dem Migrationsstatus bei. Das Ergebnis wird 15 s gecacht (Admin-Status pollt alle 3 s), außer `cache: false`.
 */
async function countColumns(pool, { cache = true, ttlMs = 15000 } = {}) {
  if (cache && countCache && Date.now() - countCache.at < ttlMs) return countCache.data;
  const gen = countGen;
  const out = {};
  for (const c of COLUMNS) {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE ${c.col} ~ $1)::int AS encrypted
       FROM ${c.table} WHERE ${c.scope} AND ${NOT_EMPTY(c)}`, [VALID_RE]);
    const { total, encrypted } = r.rows[0];
    out[c.name] = { total, encrypted, plain: total - encrypted };
  }
  if (cache && gen === countGen) countCache = { at: Date.now(), gen, data: out };
  return out;
}

function createColumnMigration({ pool, log = console, pauseMs = envInt(process.env.MYCLOUD_MIGRATION_PAUSE_MS, 50, 0, 10000) }) {
  let running = false;
  let stopRequested = false;
  let stats = { migrated: 0, skipped: 0, failed: 0, unreadable: 0 };
  let unreadable = {}; // Spalte -> Anzahl im letzten/laufenden Lauf
  let lastRun = null;

  async function migrateRow(c, row) {
    const context = c.ctx(row);
    let plain = row.val;
    if (plain.startsWith(PREFIX)) {
      let dec;
      try { dec = decryptColumn(plain, context); }
      catch (e) {
        if (e.code !== 'COLUMN_FORMAT') {
          unreadable[c.name] = (unreadable[c.name] || 0) + 1;
          log.error(`Spaltenmigration ${c.name} (${row.id}): Wert nicht lesbar (${e.code}), unverändert gelassen.`);
          return 'unreadable';
        }
        dec = null; // kein gültiges Chiffrat: war Klartext
      }
      if (dec !== null) {
        if (!plain.startsWith(ESCAPE_PREFIX)) return 'skipped'; // bereits verschlüsselt
        plain = dec; // Klartext-Escape: dekodieren und normal verschlüsseln
      }
    }
    const enc = encryptColumn(plain, context);
    if (enc === plain || enc.startsWith(ESCAPE_PREFIX)) return 'skipped'; // kein Key aktiv
    if (decryptColumn(enc, context) !== plain) throw new Error('Roundtrip-Verifikation fehlgeschlagen');
    const params = [enc, row.id, row.val];
    if (c.sizeCol) params.push(Array.from(plain).length);
    const r = await pool.query(
      `UPDATE ${c.table} SET ${c.col} = $1${c.sizeCol ? ', size = COALESCE(size, $4)' : ''} WHERE ${c.idCol} = $2 AND ${c.col} = $3`, params);
    return r.rowCount ? 'migrated' : 'skipped'; // 0 Zeilen: zwischenzeitlich geändert
  }

  async function runColumn(c) {
    let cursor = c.start;
    while (!stopRequested) {
      const { rows } = await pool.query(
        `SELECT ${c.idCol} AS id, ${c.col} AS val FROM ${c.table}
         WHERE ${c.scope} AND ${NOT_EMPTY(c)} AND ${c.idCol} > $1
         ORDER BY ${c.idCol} LIMIT $2`, [cursor, c.batch]);
      if (!rows.length) break;
      cursor = rows[rows.length - 1].id;
      for (const row of rows) {
        if (stopRequested) break;
        try { stats[await migrateRow(c, row)]++; }
        catch (e) { stats.failed++; log.error(`Spaltenmigration ${c.name} (${row.id}) fehlgeschlagen: ${e.message}`); }
        if (pauseMs) await sleep(pauseMs);
      }
    }
  }

  async function run() {
    const startedAt = new Date().toISOString();
    try {
      for (const c of COLUMNS) { if (!stopRequested) await runColumn(c); }
    } catch (e) {
      log.error('Spaltenmigration abgebrochen:', e.message);
    } finally {
      invalidateCounts();
      lastRun = { startedAt, finishedAt: new Date().toISOString(), stopped: stopRequested };
      running = false;
      if (stats.migrated || stats.failed || stats.unreadable) log.log(`Spaltenverschlüsselung beendet: ${stats.migrated} migriert, ${stats.skipped} übersprungen, ${stats.failed} fehlgeschlagen, ${stats.unreadable} unlesbar.`);
    }
  }

  return {
    start() {
      if (running) return false;
      running = true;
      stopRequested = false;
      stats = { migrated: 0, skipped: 0, failed: 0, unreadable: 0 };
      unreadable = {};
      invalidateCounts();
      this.done = run();
      return true;
    },
    stop() { if (running) stopRequested = true; return running; },
    getState() { return { running, lastRun, ...stats, unreadableByColumn: { ...unreadable } }; },
    done: Promise.resolve(),
  };
}

module.exports = { createColumnMigration, countColumns, invalidateCounts, COLUMNS };
