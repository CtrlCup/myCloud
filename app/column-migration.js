'use strict';
/*
 * Migration bestehender Klartext-Spaltenwerte in das Format `enc:v1:...` (Konzept Abschnitt 4, Phase P3).
 *
 * Läuft nur bei aktivem Master-Key (der Aufrufer startet den Job nur dann). Idempotent und fortsetzbar: ausgewählt
 * werden ausschließlich nicht-leere Werte OHNE `enc:v1:`-Prefix; ein Abbruch verliert nichts, der nächste Lauf macht
 * dort weiter und verschlüsselt nie doppelt. Pro Wert:
 *   1. verschlüsseln, 2. Roundtrip-Verifikation (decrypt(encrypt(x)) === x), 3. optimistisches
 *   UPDATE ... WHERE <id> = $ AND <spalte> = <alter Wert> (zwischenzeitlich geänderte Zeilen werden übersprungen).
 * Batches nach id-/key-Cursor, Drosselung wie die Dateimigration (MYCLOUD_MIGRATION_PAUSE_MS, Standard 50).
 * Bei file_versions wird `size` (Klartext-Länge in Zeichen) im selben UPDATE gesetzt, falls noch NULL.
 */
const { encryptColumn, decryptColumn, PREFIX } = require('./column-crypto');
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
  { name: 'file_versions.content', table: 'file_versions', col: 'content', idCol: 'id', start: 0, scope: 'TRUE', ctx: () => 'file_versions.content', batch: 20, extraSet: ', size = COALESCE(size, LENGTH(content))' },
  { name: 'shares.message', table: 'shares', col: 'message', idCol: 'id', start: 0, scope: 'TRUE', ctx: () => 'shares.message', batch: 100 },
];

const NOT_EMPTY = (c) => `${c.col} IS NOT NULL AND ${c.col} <> ''`;

/** Zähler je Spalte: { total, encrypted, plain } (nur nicht-leere Werte). */
async function countColumns(pool) {
  const out = {};
  for (const c of COLUMNS) {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE left(${c.col}, ${PREFIX.length}) = $1)::int AS encrypted
       FROM ${c.table} WHERE ${c.scope} AND ${NOT_EMPTY(c)}`, [PREFIX]);
    const { total, encrypted } = r.rows[0];
    out[c.name] = { total, encrypted, plain: total - encrypted };
  }
  return out;
}

function createColumnMigration({ pool, log = console, pauseMs = envInt(process.env.MYCLOUD_MIGRATION_PAUSE_MS, 50, 0, 10000) }) {
  let running = false;
  let stopRequested = false;
  let stats = { migrated: 0, skipped: 0, failed: 0 };
  let lastRun = null;

  async function migrateRow(c, row) {
    const context = c.ctx(row);
    const enc = encryptColumn(row.val, context);
    if (enc === row.val) return 'skipped'; // kein Key aktiv
    if (decryptColumn(enc, context) !== row.val) throw new Error('Roundtrip-Verifikation fehlgeschlagen');
    const r = await pool.query(
      `UPDATE ${c.table} SET ${c.col} = $1${c.extraSet || ''} WHERE ${c.idCol} = $2 AND ${c.col} = $3`,
      [enc, row.id, row.val]);
    return r.rowCount ? 'migrated' : 'skipped'; // 0 Zeilen: zwischenzeitlich geändert
  }

  async function runColumn(c) {
    let cursor = c.start;
    while (!stopRequested) {
      const { rows } = await pool.query(
        `SELECT ${c.idCol} AS id, ${c.col} AS val FROM ${c.table}
         WHERE ${c.scope} AND ${NOT_EMPTY(c)} AND left(${c.col}, ${PREFIX.length}) <> $3 AND ${c.idCol} > $1
         ORDER BY ${c.idCol} LIMIT $2`, [cursor, c.batch, PREFIX]);
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
      lastRun = { startedAt, finishedAt: new Date().toISOString(), stopped: stopRequested };
      running = false;
      if (stats.migrated || stats.failed) log.log(`Spaltenverschlüsselung beendet: ${stats.migrated} migriert, ${stats.skipped} übersprungen, ${stats.failed} fehlgeschlagen.`);
    }
  }

  return {
    start() {
      if (running) return false;
      running = true;
      stopRequested = false;
      stats = { migrated: 0, skipped: 0, failed: 0 };
      this.done = run();
      return true;
    },
    stop() { if (running) stopRequested = true; return running; },
    getState() { return { running, lastRun, ...stats }; },
    done: Promise.resolve(),
  };
}

module.exports = { createColumnMigration, countColumns, COLUMNS };
