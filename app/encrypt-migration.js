'use strict';
/*
 * Migration bestehender Klartext-Dateien in verschlüsselte Blobs (Konzept 3.5, Phase P2c).
 *
 * Läuft nur bei aktivem Master-Key (der Aufrufer startet den Job nur dann). Fortsetzbar und idempotent: ausgewählt
 * werden ausschließlich Zeilen mit `enc_version IS NULL` (auch Papierkorb); nach einem Abbruch beginnt der nächste Lauf
 * einfach wieder dort. Pro Datei:
 *   1. Alt-Blob fehlt -> `missing`.
 *   2. Defensiv: trägt der Blob am Pfad bereits die MCENC1-Magic UND lässt er sich komplett mit dem aktiven Key
 *      entschlüsseln UND stimmt die Größe mit files.size, wurde er schon verschlüsselt (Abbruch zwischen Schreiben und
 *      DB-Update einer früheren Strategie): nur die Spalte nachziehen (`adopted`). Magic allein reicht nie. Trägt er die
 *      Magic, besteht aber die Prüfung nicht, wird er NICHT angefasst (`failed`), damit nie doppelt verschlüsselt wird.
 *   3. Klartext -> NEUER Blob (neue UUID, gleiche Endung, selber Benutzerordner) über writeEncrypted, zunächst unter einem
 *      Staging-Namen `<name>.enc-tmp-<hex>` (den sweepOrphans nach 1 h entfernt, falls der Prozess stirbt).
 *   4. Verifikation vor dem Umhängen: neuer Blob komplett mit createDecryptStream lesen, SHA-256 und Größe gegen das
 *      Ergebnis von writeEncrypted (= Hash des gelesenen Alt-Blobs) und files.size vergleichen. Abweichung: Staging-Blob
 *      löschen, `failed`, Alt-Blob unangetastet.
 *   5. Staging-Blob auf den endgültigen Namen umbenennen und in EINER Transaktion (swapFileBlob, FOR UPDATE, expectPath)
 *      path/enc_version/content_hash setzen. Wurde die Zeile zwischenzeitlich geändert (anderer Pfad, gelöscht):
 *      neuen Blob verwerfen (`skipped`).
 *   6. Erst NACH dem Commit den alten Blob löschen (Fehler werden nur geloggt).
 * Außerdem (nur nach vollständigem Lauf): Klartext-Thumbnails werden gelöscht (werden bei Bedarf verschlüsselt neu
 * erzeugt) und Klartext-Avatare nach `<uuid>.<ext>.enc` verschlüsselt (users.avatar_path wird umgehängt).
 * Drosselung: begrenzte Parallelität (MYCLOUD_MIGRATION_CONCURRENCY, Standard 1) und Pause nach jeder Datei
 * (MYCLOUD_MIGRATION_PAUSE_MS, Standard 50).
 */
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const BATCH = 100;
const AVATAR_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envInt = (v, def, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

function hashStream(stream) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let size = 0;
    stream.on('data', (c) => { h.update(c); size += c.length; });
    stream.on('error', reject);
    stream.on('end', () => resolve({ sha256: h.digest('hex'), size }));
  });
}

const unlinkQuiet = (p) => fsp.unlink(p).catch(() => {});

function createMigration(deps) {
  const { pool, cryptoStore, uploadsDir, thumbnailsDir, swapFileBlob, tryDeleteBlob, newBlobPath, detectAvatarExt } = deps;
  const log = deps.log || console;
  const concurrency = deps.concurrency ?? envInt(process.env.MYCLOUD_MIGRATION_CONCURRENCY, 1, 1, 8);
  const pauseMs = deps.pauseMs ?? envInt(process.env.MYCLOUD_MIGRATION_PAUSE_MS, 50, 0, 10000);

  let running = false;
  let stopRequested = false;
  let current = null;
  let stats = { migrated: 0, adopted: 0, missing: 0, failed: 0, skipped: 0, thumbnailsRemoved: 0, avatarsMigrated: 0 };
  let lastRun = null;

  async function migrateFile(row) {
    const oldAbs = path.join(uploadsDir, row.path);
    let st;
    try { st = await fsp.stat(oldAbs); } catch (e) { if (e.code === 'ENOENT') return 'missing'; throw e; }
    if (!st.isFile()) return 'missing';
    const expectedSize = Number(row.size);

    if (cryptoStore.isEncrypted(oldAbs)) {
      let h = null;
      try { h = await hashStream(cryptoStore.createDecryptStream(oldAbs, { encrypted: true })); } catch { /* nicht mit dem aktiven Key lesbar */ }
      if (h && h.size === expectedSize) {
        const r = await pool.query(
          'UPDATE files SET enc_version = 1, content_hash = $1 WHERE id = $2 AND path = $3 AND enc_version IS NULL',
          [h.sha256, row.id, row.path]);
        return r.rowCount ? 'adopted' : 'skipped';
      }
      log.error(`Migration: Datei ${row.id} hat einen Verschlüsselungs-Header, ist aber nicht lesbar oder hat eine abweichende Größe; unverändert gelassen.`);
      return 'failed';
    }

    const { relativePath, absPath } = newBlobPath(row.owner_id, row.path);
    const staging = `${absPath}.enc-tmp-${crypto.randomBytes(6).toString('hex')}`;
    let res;
    try {
      res = await cryptoStore.writeEncrypted(staging, fs.createReadStream(oldAbs));
      if (res.plainSize !== expectedSize) throw new Error(`Größe ${res.plainSize} weicht von files.size ${expectedSize} ab`);
      const v = await hashStream(cryptoStore.createDecryptStream(staging, { encrypted: true }));
      if (v.sha256 !== res.sha256 || v.size !== res.plainSize) throw new Error('Verifikation des neuen Blobs fehlgeschlagen');
      await fsp.rename(staging, absPath);
    } catch (e) {
      await unlinkQuiet(staging);
      log.error(`Migration: Datei ${row.id} nicht migriert: ${e.message}`);
      return 'failed';
    }

    let swapped;
    try {
      swapped = await swapFileBlob(row.id, { path: relativePath, enc_version: 1, content_hash: res.sha256 }, { expectPath: row.path });
    } catch (e) {
      await unlinkQuiet(absPath);
      const cur = (await pool.query('SELECT path, enc_version FROM files WHERE id = $1', [row.id])).rows[0];
      if (!cur || cur.path !== row.path || cur.enc_version != null) return 'skipped'; // zwischenzeitlich bearbeitet/gelöscht
      throw e;
    }
    if (!swapped.ok) { await unlinkQuiet(absPath); return 'skipped'; }
    // Nur löschen, wenn kein anderer Eintrag denselben Blob referenziert
    const shared = await pool.query('SELECT 1 FROM files WHERE path = $1 AND id <> $2 LIMIT 1', [row.path, row.id]);
    if (!shared.rows.length) tryDeleteBlob(swapped.oldPath);
    return 'migrated';
  }

  async function removePlainThumbnails() {
    let names = [];
    try { names = await fsp.readdir(thumbnailsDir); } catch { return; }
    for (const n of names) {
      if (!/\.(jpg|png)$/.test(n)) continue; // `.enc`, laufende `.tmp-`-Dateien und Fremdes bleiben
      try { await fsp.unlink(path.join(thumbnailsDir, n)); stats.thumbnailsRemoved++; } catch { /* weiter */ }
    }
  }

  async function migrateAvatar(user) {
    const oldAbs = path.join(uploadsDir, path.basename(user.avatar_path));
    let ext = path.extname(user.avatar_path).slice(1).toLowerCase();
    if (!AVATAR_EXTS.includes(ext) || !fs.existsSync(oldAbs)) return;
    if (detectAvatarExt) { ext = await detectAvatarExt(oldAbs, false); if (!ext) return; }
    const name = `${crypto.randomUUID()}.${ext}.enc`;
    const newAbs = path.join(uploadsDir, name);
    try {
      const expected = (await fsp.stat(oldAbs)).size;
      const res = await cryptoStore.writeEncrypted(newAbs, fs.createReadStream(oldAbs));
      const v = await hashStream(cryptoStore.createDecryptStream(newAbs, { encrypted: true }));
      if (res.plainSize !== expected || v.sha256 !== res.sha256 || v.size !== expected) throw new Error('Verifikation fehlgeschlagen');
      const r = await pool.query('UPDATE users SET avatar_path = $1 WHERE id = $2 AND avatar_path = $3', [name, user.id, user.avatar_path]);
      if (!r.rowCount) { await unlinkQuiet(newAbs); return; }
      await unlinkQuiet(oldAbs);
      stats.avatarsMigrated++;
    } catch (e) {
      await unlinkQuiet(newAbs);
      log.error(`Migration: Avatar von Nutzer ${user.id} nicht migriert: ${e.message}`);
    }
  }

  async function runPool(rows) {
    let i = 0;
    const worker = async () => {
      while (!stopRequested && i < rows.length) {
        const row = rows[i++];
        current = row.name;
        try {
          const outcome = await migrateFile(row);
          stats[outcome]++;
          if (outcome === 'missing') log.error(`Migration: Blob von Datei ${row.id} fehlt auf der Platte.`);
        } catch (e) {
          stats.failed++;
          log.error(`Migration: Datei ${row.id} fehlgeschlagen: ${e.message}`);
        }
        if (pauseMs) await sleep(pauseMs);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  async function run() {
    const startedAt = new Date().toISOString();
    try {
      let cursor = 0;
      while (!stopRequested) {
        const { rows } = await pool.query(
          'SELECT id, owner_id, name, path, size FROM files WHERE enc_version IS NULL AND is_folder = false AND id > $1 ORDER BY id LIMIT $2',
          [cursor, BATCH]);
        if (!rows.length) break;
        cursor = rows[rows.length - 1].id;
        await runPool(rows);
      }
      if (!stopRequested) {
        await removePlainThumbnails();
        const users = await pool.query("SELECT id, avatar_path FROM users WHERE avatar_path IS NOT NULL AND avatar_path NOT LIKE '%.enc'");
        for (const u of users.rows) { if (stopRequested) break; await migrateAvatar(u); }
      }
    } catch (e) {
      log.error('Migration abgebrochen:', e.message);
    } finally {
      lastRun = { startedAt, finishedAt: new Date().toISOString(), stopped: stopRequested };
      running = false;
      current = null;
      const s = stats;
      if (s.migrated || s.adopted || s.failed || s.missing || s.thumbnailsRemoved || s.avatarsMigrated) {
        log.log(`Verschlüsselungs-Migration beendet: ${s.migrated} migriert, ${s.adopted} übernommen, ${s.skipped} übersprungen, ${s.missing} fehlend, ${s.failed} fehlgeschlagen, ${s.thumbnailsRemoved} Thumbnails entfernt, ${s.avatarsMigrated} Avatare migriert.`);
      }
    }
  }

  return {
    /** Startet den Lauf im Hintergrund; false, wenn bereits einer läuft. Liefert in `done` das Ende (für Tests). */
    start() {
      if (running) return false;
      running = true;
      stopRequested = false;
      stats = { migrated: 0, adopted: 0, missing: 0, failed: 0, skipped: 0, thumbnailsRemoved: 0, avatarsMigrated: 0 };
      this.done = run();
      return true;
    },
    stop() { if (running) stopRequested = true; return running; },
    getState() { return { running, current, lastRun, ...stats }; },
    migrateFile,
    done: Promise.resolve(),
  };
}

module.exports = { createMigration };
