'use strict';
/*
 * Outbox für das Löschen alter Blobs (Copy-on-Write, Migration, endgültiges Löschen).
 *
 * Ablauf: Eine Operation, die einen Blob ersetzt oder dessen Zeile löscht, trägt den alten Pfad (files.path-relativ)
 * in DERSELBEN Transaktion in `pending_blob_deletes` ein (enqueue). Nach dem Commit löscht der Aufrufer die Datei
 * (+ Thumbnails) und entfernt den Eintrag (server.js tryDeleteBlob). Stirbt der Prozess dazwischen, räumt der Worker
 * (beim Start und danach alle 10 Minuten) die Reste ab. Einträge jünger als `minAgeMs` fasst er nicht an, dort läuft das
 * Löschen des Aufrufers noch.
 *
 * Re-Check unmittelbar vor dem Löschen: der Pfad wird NIE gelöscht, solange er noch referenziert ist. Alle Spalten in
 * db.js, die Blob-Pfade enthalten (Stand P2c, geprüft): files.path (Blobs im Benutzerordner), users.avatar_path
 * (Dateiname im Upload-Root), settings.value für cloud_icon_path/seo_image_path/Hintergrund-Bilder (Dateiname im
 * Upload-Root). file_versions (nur Text in `content`), shares, api_keys, passkeys, roles, sessions enthalten keine Pfade.
 * Referenziert wird per Gleichheit mit dem Pfad; ist er referenziert, wird nur der Eintrag entfernt.
 *
 * P4-Hook: `isBlocked()` (z. B. "backup_in_progress") lässt den Worker pausieren, ohne Einträge zu verlieren.
 * Eine laufende Sicherung darf so nie einen Blob verlieren, den sie noch lesen will.
 */
const path = require('path');

function createOutbox({ pool, uploadsDir, deleteBlob, isBlocked = () => false, minAgeMs = 60000, log = console }) {
  const root = path.resolve(uploadsDir);
  let timer = null;
  let running = false;

  /** Innerhalb einer Transaktion (`client` oder pool) aufrufen. */
  async function enqueue(client, relPath) {
    await client.query('INSERT INTO pending_blob_deletes (path) VALUES ($1) ON CONFLICT DO NOTHING', [relPath]);
  }

  async function dequeue(relPath) {
    await pool.query('DELETE FROM pending_blob_deletes WHERE path = $1', [relPath]);
  }

  async function processOne(relPath) {
    const abs = path.resolve(root, relPath);
    if (!abs.startsWith(root + path.sep)) { // Eintrag zeigt aus dem Upload-Verzeichnis heraus: nie löschen
      await pool.query('DELETE FROM pending_blob_deletes WHERE path = $1', [relPath]);
      return 'dropped';
    }
    const ref = await pool.query(
      `SELECT 1 FROM files WHERE path = $1
       UNION ALL SELECT 1 FROM users WHERE avatar_path = $1
       UNION ALL SELECT 1 FROM settings WHERE value = $1
       LIMIT 1`, [relPath]);
    if (ref.rows.length) {
      await pool.query('DELETE FROM pending_blob_deletes WHERE path = $1', [relPath]);
      return 'referenced';
    }
    deleteBlob(abs); // ENOENT zählt als erledigt (deleteBlob ignoriert es), andere Fehler werfen
    await pool.query('DELETE FROM pending_blob_deletes WHERE path = $1', [relPath]);
    return 'deleted';
  }

  /** Arbeitet alle fälligen Einträge ab. Liefert { deleted, referenced, failed } oder null, wenn blockiert/schon aktiv. */
  async function sweep(ageMs = minAgeMs) {
    if (running || isBlocked()) return null;
    running = true;
    const out = { deleted: 0, referenced: 0, dropped: 0, failed: 0 };
    try {
      const { rows } = await pool.query(
        `SELECT path FROM pending_blob_deletes WHERE created_at < NOW() - ($1::int * INTERVAL '1 millisecond') ORDER BY created_at LIMIT 1000`,
        [ageMs]);
      for (const r of rows) {
        if (isBlocked()) break;
        try { out[await processOne(r.path)]++; } catch (e) { out.failed++; log.error(`Blob-Outbox: ${r.path} nicht gelöscht: ${e.message}`); }
      }
    } catch (e) {
      log.error('Blob-Outbox-Sweep fehlgeschlagen:', e.message);
    } finally { running = false; }
    if (out.deleted) log.log(`Blob-Outbox: ${out.deleted} alte Blobs gelöscht.`);
    return out;
  }

  function start(intervalMs = 10 * 60 * 1000) {
    if (timer) return;
    sweep(0); // beim Start läuft kein Löschen eines Aufrufers mehr
    timer = setInterval(() => sweep(), intervalMs);
    timer.unref?.();
  }

  return { enqueue, dequeue, sweep, processOne, start, stop() { if (timer) clearInterval(timer); timer = null; } };
}

module.exports = { createOutbox };
