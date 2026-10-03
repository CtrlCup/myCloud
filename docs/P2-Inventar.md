# P2-Inventar: Stellen, die Datei-Blobs lesen oder schreiben

Stand: Phase P2c (Migration, damit P2 abgeschlossen). Zeilennummern in den P2a-Tabellen beziehen sich auf `app/server.js` nach P2a und dienen nur der
Orientierung. Grundlage: `docs/Verschluesselung-und-Backup.md` 3.4/3.5. `enc` meint `files.enc_version > 0`
(Spalte, nie Heuristik), "Thumb" meint den Suffix `.enc`.

Ergebnis: **alle Lese-/Auslieferungsstellen sind in P2a umgestellt, alle Schreibpfade in P2b**. Die Migration
bestehender Dateien (P2c) ist ebenfalls erledigt.

## Auslieferung (Bytes an den Client)

| Stelle | Art | P2a | Begründung |
|---|---|---|---|
| `GET /api/files/download/:id` (~2374) | Download/Inline | `sendFileDecrypted` | Rechte-, Permission-Prüfung und Schutz-Header bleiben, nur das Senden ändert sich |
| `GET /api/public/shares/:slug/download/:fileId` (~5077) | öffentliche Freigabe | `sendFileDecrypted` | Passwort, Limits und atomarer Download-Zähler laufen unverändert davor |
| `GET /api/eurooffice/download/:id` (~4216) | EuroOffice-Download | `sendFileDecrypted` | Token-Prüfung unverändert; Doc-Server bekommt Klartext |
| `GET /api/files/thumbnail/:id` (~3728), `GET /api/public/shares/:slug/thumbnail/:fileId` (~5037) | Thumbnail-Auslieferung | `sendThumbnail` (Thumb `.enc` per Namens-Suffix) | Entscheidung deterministisch über den Namen; Fallback auf das Original über `sendFileDecrypted` mit `file.enc_version` |
| `GET /api/users/:id/avatar` | Avatar | P2b: `.enc`-Suffix im `avatar_path` -> `sendFileDecrypted`, sonst Klartext wie bisher | Entscheidung am Suffix (wie Thumbnails), keine neue Spalte |
| `sendBrandingFile` | Branding | unverändert (Klartext `res.sendFile`) | Branding-Assets bleiben bewusst Klartext (öffentlich ausgeliefert, kein vertraulicher Inhalt) |
| `res.sendFile` für `index.html`/`share.html` | statische App-Dateien | unverändert | keine Nutzerdaten |

## ZIP

| Stelle | Art | P2a | Begründung |
|---|---|---|---|
| `addFolderToZip` (~2438) + `addFileToZip` (~2428) | Ordner-ZIP (Owner und Freigabe) | Klartext: `archive.file`, `enc`: `archive.append(lazy Decrypt-Stream)` | Lazy, damit nicht alle Blobs gleichzeitig offen sind. SELECTs liefern jetzt `enc_version` |
| `download-zip-multiple` (~3023) und öffentlicher `download-zip-multiple` (~5460) | Einzeldateien im ZIP | `addFileToZip` | wie oben |
| `archive.on('error')` (4 Stellen) | Fehlerpfad | `zipErrorHandler`: vor erstem Byte 500, danach `res.destroy(err)` | Vorher `throw` im Event-Handler (Prozess-Absturz) bzw. sauberes `res.end()` mit unvollständigem ZIP |

## Interne Klartext-Leser

| Stelle | Art | P2a | Begründung |
|---|---|---|---|
| `GET /api/files/content/:id` (~3342) und `GET /api/public/shares/:slug/content/:fileId` (~4829) | Texteditor laden | `readDecrypted` über `readTextBlob`, bei `enc` mit `maxBytes` 32 MiB | Klartext bleibt unbegrenzt wie bisher (E16); Speicherlast nur bei verschlüsselten Blobs begrenzt |
| `computeFileHash` (~84) | Hash-Berechnung | `createDecryptStream` mit `encrypted`-Parameter | Hash immer über den Klartext; Aufrufer übergeben `isEncRow(row)` bzw. `false` für frische Klartext-Blobs |
| `resolveExistingFileHash` (Duplikat-Erkennung) | Hash-Backfill | `enc_version` im SELECT von `findNameConflict` und der Move-Abfrage | Zeile entscheidet |
| `extractTextContent` (~419) | Textindex PDF/Text/OCR | `readDecrypted` (PDF), Präfix-Stream 500 KB (Text), `withPlaintextTempFile` (OCR) | Pflicht-Parameter `{ encrypted }` |
| `indexExistingFiles` (~521) | Backfill-Job | `enc_version` im SELECT, `{ encrypted: isEncRow(row) }` | |
| `ocrImage` (~371), `ocrPdf` (~390) | tesseract, pdftoppm | über `withPlaintextTempFile` (Ext aus Dateiname) | `ocrPdf` legt Seitenbilder neben die Eingabe: im privaten Temp-Verzeichnis, wird mit gelöscht |
| `getExifSummary` (~3582) | exiftool | `withPlaintextTempFile`, Aufrufer übergeben `isEncRow(file)` | |
| `generateThumbnail` (~3613) | ffmpeg, exiftool, rsvg-convert | Eingabe über `withPlaintextTempFile`; nur für thumbnailbare Endungen entschlüsseln; Cache-Prüfung zuerst (`<name>.enc` hat Vorrang) | Schreiben des Thumbnails bleibt P2b |
| Semaphor | Last | `MYCLOUD_DECRYPT_CONCURRENCY` (Standard 4) für alle `withPlaintextTempFile`-Nutzer mit `enc` | Klartext-Blobs belegen keinen Slot |

## Schreibpfade und Sonderfälle (P2b erledigt)

Gemeinsame Bausteine in `app/server.js`: `storage` (multer-StorageEngine, bei aktivem Key `writeEncrypted(stream)` direkt,
`req.file.size` = Klartextgröße, `sha256`, `encrypted`), `writeNewBlob`, `newBlobPath`, `swapFileBlob` (eine Transaktion
mit `SELECT ... FOR UPDATE`, setzt `path/size/content_hash/enc_version/...`), `replaceBlobCow`, `deleteBlob`/`deleteThumbnailsFor`
(einzige Stellen, die Blobs und Thumbnails `<name>`/`<name>.enc` physisch löschen; Einhängepunkt für die Backup-Warteschlange in P4).
Ohne Master-Key bleibt jedes Verhalten wie vorher (Klartext, `enc_version` NULL, In-Place-Schreiben, E16).

| Stelle | Art | P2b |
|---|---|---|
| Multer-Upload (`/api/files/upload`), `relocateUploadToOwnerDir`, Ersetzen/Kollision, `finalizeUploadedFile` | Upload | erledigt: Stream läuft durch die Engine, `files.size` = Klartextgröße, `content_hash` = Klartext-SHA-256 (bei aktivem Key immer gesetzt), `enc_version` = 1; Textindex/Remux bekommen `encrypted` aus dem Schreibergebnis; Ersetzen löscht den alten Blob über `deleteBlob` |
| Öffentlicher Upload (`finalizePublicUploadedFile`), öffentliche Datei anlegen (`/api/public/shares/:slug/file`) | Upload/neue Datei | erledigt (wie oben; leere Datei als verschlüsselter Blob) |
| `assembleChunkedUpload`, `tmp-chunked` (Variante A, siehe unten) | Chunked-Upload | erledigt |
| `PUT /api/files/content/:id`, Versions-Restore, `PUT /api/public/shares/:slug/content/:fileId` | In-Place-Schreiben | erledigt: bei aktivem Key `replaceBlobCow` (neuer Blob mit neuem DEK, `files.path` umhängen, nach dem Commit alten Blob löschen; auch wenn die Zeile bisher Klartext war: Auto-Wandern). Key aus: unverändert in-place |
| `PUT /api/files/:id/binary-content`, `PUT /api/public/shares/:slug/binary-content/:fileId` | Binär-Speichern | erledigt: Upload ist schon ein neuer Blob (Engine), `enc_version`/`content_hash` werden mitgesetzt, alter Blob über `deleteBlob` |
| EuroOffice-Callback (`saveDownloadedFileCow` in `office-save.js`) | Speichern aus dem Doc-Server | erledigt: Download streamt direkt in einen NEUEN verschlüsselten Blob, `swapFileBlob` (path/size/content_hash/enc_version/content in einer Transaktion), alter Blob erst nach dem Commit gelöscht, bei Fehler/Abbruch bleibt alles beim Alten und der neue Blob wird gelöscht. Key aus: `saveDownloadedFile` wie bisher |
| `remuxMp4Faststart`, `runFaststartBackfill` | ffmpeg | erledigt: bei aktivem Key liest ffmpeg eine Temp-Klartextdatei (`withPlaintextTempFile`), schreibt die Ausgabe in ein tmpfs-Temp-Verzeichnis (`withPrivateTempDir`), daraus neuer verschlüsselter Blob + Copy-on-Write (mit `expectPath`-Prüfung gegen zwischenzeitliche Änderungen). Der Backfill wählt jetzt auch `enc_version > 0` (das `AND enc_version IS NULL` aus P2a ist entfernt) |
| `copyFileOrFolderRecursive` | `fs.copyFileSync` | unverändert (P2a-INSERT behält `enc_version`/`content_hash`); bytegleiche Kopie ist unkritisch, weil nie in einen Blob geschrieben wird |
| `create-empty` (Office-Vorlagen aus `templates/`), `create-note` (Text und Anhänge) | neue Dateien | erledigt: Vorlage lesen, als Blob schreiben (`writeNewBlob`); Anhänge laufen über die Engine |
| Thumbnail-Erzeugung | abgeleiteter Klartext | erledigt: bei aktivem Key schreiben ffmpeg/rsvg/exiftool in ein tmpfs-Temp-Verzeichnis, daraus `<name>.enc` (`writeEncrypted`), Temp wird gelöscht; Ersetzen/Löschen entfernt `<name>` und `<name>.enc` mit |
| Avatar-Upload / -Auslieferung | Schreiben/Lesen | erledigt: bei aktivem Key `<uuid>.<ext>.enc` (Magic-Bytes aus dem entschlüsselten Anfang, Endungs-Allowlist und `setFileServeHeaders` aus #52 gelten weiter); die Auslieferung entscheidet am Suffix `.enc`, ältere Klartext-Avatare bleiben lesbar. Keine neue Spalte |
| Branding-Assets (Logo, Hintergründe, SEO-Bild) | Schreiben | **bewusst Klartext** (`uploadSinglePlain`): sie werden öffentlich ausgeliefert (Login-Seite, Link-Vorschau, ohne Anmeldung), enthalten keinen vertraulichen Inhalt und liegen nicht in `files` |
| Migration (idempotent, fortsetzbar, Admin-Fortschritt) | Bestand | P2c erledigt: `app/encrypt-migration.js` (Dateien inkl. Papierkorb, Klartext-Thumbnails löschen, Avatare nach `.enc`), `GET /api/settings/admin/encryption-status`, `POST /api/settings/admin/encryption-migration`, Karte „Verschlüsselung“ in den Systemeinstellungen. `files.content`/`file_versions.content` bleiben Klartext (P3), `tmp-chunked`-Reste räumt der Start-Sweep ab |

**Entscheidung Chunked-Upload (Variante A):** Jeder Chunk wird als eigener kleiner verschlüsselter Blob (`writeEncrypted`, atomar
ersetzt, ein wiederholter Chunk überschreibt ihn) in `tmp-chunked/<uploadId>/<index>` abgelegt. Beim Zusammenbau werden die
Chunks nacheinander per `createDecryptStream` in EIN `writeEncrypted` gestreamt; Ergebnis ist ein verschlüsselter Blob samt
SHA-256 und Größe des Klartexts. Begründung gegenüber Klartext-Chunks im tmpfs: Chunks sind bis 8 MiB groß, mehrere
Uploads parallel und bis 4 h Sessions würden den RAM-basierten tmpfs unvorhersehbar füllen; so liegt nie Klartext auf der Platte. Kosten: einmal Verschlüsseln und Entschlüsseln mehr pro Chunk. Aufräumen:
`deleteChunkedUploadSession` (wie bisher, auch bei Abbruch), Session-Timeout (4 h) und beim Start `sweepOrphans({ chunked })`,
weil Sessions nur im Speicher leben und nach einem Neustart jedes Verzeichnis in `tmp-chunked` verwaist ist.

## Reine Lösch-/Verschiebe-Stellen (kein Lesen des Inhalts)

`deleteFolderRecursive`, `hardDeleteTrashItem`, Umbenennen/Verschieben mit Ersetzen, Einmal-Notiz-Bereinigung (Ablauf, Burn,
Heartbeat-Verlust), Benutzer löschen und alle COW-Ersetzungen löschen über `deleteBlob` (samt Thumbnails). `migrateUploadsToPerUserFolders`
nutzt `rename` (der Dateiname trägt kein Format-Merkmal). Nicht über `deleteBlob` laufen nur verworfene Uploads, die nie in
`files` standen, und Branding-/Avatar-Dateien.

## Nicht-Blob-Leser (zur Vollständigkeit)

`openapi.yaml`, `public/index.html`, E-Mail-Templates, `.env`: App-eigene Dateien, keine Nutzerdaten.

## Hintergrundjobs

| Job | Behandlung |
|---|---|
| `runFaststartBackfill` | P2b: wählt auch verschlüsselte Zeilen, Remux per Copy-on-Write |
| `indexExistingFiles` (Text-/OCR-Reindex) | liest über `extractTextContent` mit `enc_version`, unkritisch |
| Bereinigungsjobs (Shares, Papierkorb, Einmalnotizen) | nur `unlink`, unabhängig vom Format |

## Externe Tools

Auch die Ausgabe-Temp-Dateien (Thumbnails, Remux) liegen nur im tmpfs (`withPrivateTempDir`). Alle `exec`-Aufrufe haben Timeouts (`EXEC_TIMEOUT_SHORT` 60 s für Thumbnails/EXIF, `EXEC_TIMEOUT_LONG` 300 s für OCR/Remux) mit `SIGKILL`, damit hängende Prozesse den Entschlüsselungs-Semaphor nicht dauerhaft belegen.

## Reihenfolge

P2b ist erledigt: Schreibpfade sind Copy-on-Write, damit darf P2c (Migration) laufen. Klartext-Thumbnails aus der Zeit vor dem Key werden von der Migration (P2c) gelöscht.

## Nachbesserung P2b (Review)

- **Copy-on-Write-Regel:** Eine Kopie teilt DEK und noncePfx mit der Quelle. Blobs dürfen deshalb NIE in-place mit neuem Inhalt
  beschrieben werden; die einzige erlaubte In-Place-Operation ist `rewrapHeader`. Jeder neue Inhalt ist ein neuer Blob.
- **Löschen nach dem Commit:** Der alte Blob wird erst nach dem DB-Commit und in einem eigenen `try` (`tryDeleteBlob`) gelöscht;
  ein Fehler dort lässt höchstens einen verwaisten alten Blob zurück, nie einen verlorenen neuen. `swapFileBlob` (Zeilensperre,
  `expectPath`, Quota-Prüfung unter Lock bei Wachstum, 413 wie bei Uploads) wird auch von Upload-Ersetzen, `create-empty`-Ersetzen
  und beiden `binary-content`-Routen genutzt.
- **Key-AUS-Guard (`assertPlainWritable`):** Zeilen mit `enc_version > 0` werden ohne Master-Key nie in-place überschrieben
  (Routen: 409 "Die Datei ist verschlüsselt, der Master-Key fehlt.", EuroOffice-Callback `{error: 1}`, Remux: Fehler).
  Start: `checkMasterKeyAtStartup` bricht ab, wenn der Key fehlt, aber `enc_version > 0` existiert, und legt keinen
  Key-Check-Wert an, solange verschlüsselte Dateien existieren.
- **tmpfs-Prüfung beim Start:** Bei aktivem Key muss `MYCLOUD_TMP_DIR` (falls gesetzt) auf tmpfs/ramfs liegen
  (`statfsSync`), sonst Abbruch; Ausnahme `MYCLOUD_ALLOW_DISK_TMP=1` mit lauter Warnung. tmpfs-Seiten können in den Swap geraten:
  Swap abschalten oder verschlüsseln.
- Öffentliche Upload-/Speichern-Routen prüfen Freigabe und Schreibrecht VOR multer; der Avatar-Upload hat ein 2-MB-Limit im Upload.
- Altbestand (Klartext) wird bei aktivem Key für Tools zuerst in ein privates Temp-Verzeichnis kopiert; die Tools bekommen `TMPDIR`
  auf das tmpfs. `writeNewBlob` behält ohne Key die alten Dateirechte (umask).
- Fehlerpfade räumen auf: create-empty, create-note (Blobs und halbfertige Container), öffentliches Anlegen; `writeEncrypted`
  zerstört den Eingabestream bei Fehlern; paralleles `complete` eines Chunk-Uploads liefert 409.

## Nachbesserung P2c (Review)

- **Outbox `pending_blob_deletes`** (`app/blob-outbox.js`, Tabelle in `initDb()`): `swapFileBlob` (alle Copy-on-Write-Nutzer) und das
  endgültige Löschen (`hardDeleteTrashItem`, `deleteFolderRecursive`: `DELETE ... RETURNING path` samt Eintrag in einer Anweisung,
  mit dem aktuellen statt eines veralteten Pfads) tragen alte Blob-Pfade transaktional ein; `tryDeleteBlob` löscht nach dem Commit und
  entfernt den Eintrag. Der Worker läuft immer (Start, dann alle 10 min), prüft vor dem Löschen `files.path`, `users.avatar_path` und
  `settings.value` und hat den Hook `isBlocked` für das spätere "backup_in_progress" (P4).
- Der Adopt-Pfad der Migration behandelt Blobs mit Magic, die sich nicht vollständig entschlüsseln lassen, als Klartext.
- `copyFileOrFolderRecursive`: fehlt der Quell-Blob, wird die Zeile einmal neu gelesen, sonst kommt ein deutscher Fehler (500).
