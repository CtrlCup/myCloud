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
 * INVARIANTE: Einträge sind ausschließlich alte, bereits vom Swap/DELETE entkoppelte Pfade. Pfade sind UUID-eindeutig und
 * werden nie wieder vergeben; ein einmal unreferenzierter Pfad wird daher nie wieder referenziert. Neue Blobs (z. B. der der
 * Migration vor dem Swap) stehen NIE in der Outbox: ein Absturz hinterlässt dort höchstens einen Orphan aus Chiffrat
 * (Speicherverschwendung, kein Klartext-Leck), den bei `.enc-tmp-`-Staging-Resten `sweepOrphans` abräumt.
 *
 * Re-Check unmittelbar vor dem Löschen: der Pfad wird NIE gelöscht, solange er noch referenziert ist. Alle Spalten in
 * db.js, die Blob-Pfade enthalten (Stand P2c, geprüft): files.path (Blobs im Benutzerordner), users.avatar_path
 * (Dateiname im Upload-Root), settings.value für cloud_icon_path/seo_image_path/Hintergrund-Bilder (Dateiname im
 * Upload-Root). file_versions (nur Text in `content`), shares, api_keys, passkeys, roles, sessions enthalten keine Pfade.
 * Referenziert wird per Gleichheit mit dem Pfad; ist er referenziert, wird nur der Eintrag entfernt. Re-Check und unlink liegen
 * direkt hintereinander (kein Advisory-Lock): Wegen der UUID-Eindeutigkeit gibt es kein legitimes Neu-Referenzieren eines
 * Eintrags-Pfads, ein Lock würde nur Altlast mit geteiltem Pfad nicht besser schützen (die fängt der Re-Check ab).
 * Verzeichnisse als Pfad werden verworfen, Symlinks wird nur der Link selbst entfernt (nie das Ziel). Nach MAX_ATTEMPTS
 * Fehlversuchen wird ein Eintrag mit Warnung verworfen.
 *
 * P4-Hook: `isBlocked()` (z. B. "backup_in_progress") lässt den Worker pausieren, ohne Einträge zu verlieren.
 * Eine laufende Sicherung darf so nie einen Blob verlieren, den sie noch lesen will.
 */
const fs = require('fs');
const path = require('path');

const MAX_ATTEMPTS = 20;

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
    let st = null;
    try { st = fs.lstatSync(abs); } catch { /* fehlt: ENOENT ist erledigt */ }
    if (st && st.isDirectory()) {
      log.error(`Blob-Outbox: ${relPath} ist ein Verzeichnis, Eintrag verworfen.`);
      await dequeue(relPath);
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
        try { out[await processOne(r.path)]++; } catch (e) {
          out.failed++;
          log.error(`Blob-Outbox: ${r.path} nicht gelöscht: ${e.message}`);
          try {
            const a = await pool.query('UPDATE pending_blob_deletes SET attempts = attempts + 1 WHERE path = $1 RETURNING attempts', [r.path]);
            if (a.rows[0] && a.rows[0].attempts >= MAX_ATTEMPTS) {
              log.error(`WARNUNG Blob-Outbox: ${r.path} nach ${MAX_ATTEMPTS} Versuchen verworfen, bitte manuell prüfen.`);
              await dequeue(r.path);
            }
          } catch { /* beim nächsten Lauf erneut */ }
        }
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
