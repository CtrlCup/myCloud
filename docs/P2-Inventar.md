# P2-Inventar: Stellen, die Datei-Blobs lesen oder schreiben

Stand: Phase P2a (Lesepfade). Zeilennummern beziehen sich auf `app/server.js` nach P2a und dienen nur der
Orientierung. Grundlage: `docs/Verschluesselung-und-Backup.md` 3.4/3.5. `enc` meint `files.enc_version > 0`
(Spalte, nie Heuristik), "Thumb" meint den Suffix `.enc`.

Ergebnis: **alle Lese-/Auslieferungsstellen sind in P2a umgestellt**. Offen sind Schreibpfade (P2b), Migration
(P2c) und Avatar/Branding (Entscheidung nötig).

## Auslieferung (Bytes an den Client)

| Stelle | Art | P2a | Begründung |
|---|---|---|---|
| `GET /api/files/download/:id` (~2374) | Download/Inline | `sendFileDecrypted` | Rechte-, Permission-Prüfung und Schutz-Header bleiben, nur das Senden ändert sich |
| `GET /api/public/shares/:slug/download/:fileId` (~5077) | öffentliche Freigabe | `sendFileDecrypted` | Passwort, Limits und atomarer Download-Zähler laufen unverändert davor |
| `GET /api/eurooffice/download/:id` (~4216) | EuroOffice-Download | `sendFileDecrypted` | Token-Prüfung unverändert; Doc-Server bekommt Klartext |
| `GET /api/files/thumbnail/:id` (~3728), `GET /api/public/shares/:slug/thumbnail/:fileId` (~5037) | Thumbnail-Auslieferung | `sendThumbnail` (Thumb `.enc` per Namens-Suffix) | Entscheidung deterministisch über den Namen; Fallback auf das Original über `sendFileDecrypted` mit `file.enc_version` |
| `sendBrandingFile` (~346), `GET /api/users/:id/avatar` (~5603) | Branding/Avatar | **unverändert (Klartext `res.sendFile`)** | Es gibt keine Spalte, die das Format festhält (Avatar: `users.avatar_path`, Branding: `settings`). Entscheidung für P2b offen, siehe unten |
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

## Schreibpfade und Sonderfälle (nicht in P2a angefasst)

| Stelle | Art | Phase | Begründung |
|---|---|---|---|
| Multer-Upload (`/api/files/upload` ~2120ff), `relocateUploadToOwnerDir` (~72), Ersetzen/Kollision | Upload | P2b | Neuer Blob verschlüsselt schreiben, `enc_version` setzen. Die dortigen `extractTextContent(…, {encrypted:false})`/`computeFileHash(…, false)` mit P2b-Kommentar sind dann auf das Schreibergebnis umzustellen |
| `assembleChunkedUpload` (~257), `tmp-chunked` (~2300) | Chunked-Upload | P2b | Chunks verschlüsselt oder auf tmpfs |
| `PUT /api/files/content/:id` (~3395), Versions-Restore (~3557), öffentliches Speichern (~4903), EuroOffice-Callback (~4302, `saveDownloadedFile`) | In-Place-Schreiben | P2b | Copy-on-Write: neuer Blob mit neuem DEK, `files.path` umhängen, alten löschen. **Harte Vorbedingung:** nie neuen Inhalt in einen vorhandenen verschlüsselten Blob schreiben |
| `remuxMp4Faststart` (~2065) und `runFaststartBackfill` (~6158) | ffmpeg schreibt in Datei und ersetzt per `rename` | P2b | Eingabe über Temp-Klartext, Ergebnis als neuer verschlüsselter Blob (Copy-on-Write), `enc_version` setzen; bis dahin nur auf Klartext-Zeilen sinnvoll |
| `copyFileOrFolderRecursive` (~2790) | `fs.copyFileSync` des Blobs | P2b | Bytegleiche Kopie ist ohne Nonce-Problem möglich (gleicher Inhalt, keine Änderung), **aber** die neue Zeile muss `enc_version` mitnehmen |
| `create-empty` (~3064), Notizen (~3248, 3272), `templates/` | neue Dateien | P2b | schreiben verschlüsselt |
| Thumbnail-Erzeugung (Schreiben in `uploads/thumbnails`) | abgeleiteter Klartext | P2b | Ausgabe als `<name>.enc` schreiben; Lese-/Auslieferungsseite steht |
| Avatar-/Branding-Upload (~4400-4560, ~5560) | Schreiben | P2b (Entscheidung) | Es braucht ein Format-Merkmal: neue Spalte (`users.avatar_enc`) bzw. Suffix `.enc` im Pfad (wie bei Thumbnails). Empfehlung: Suffix `.enc` im Dateinamen, keine neue Spalte. Branding wird auch ohne Login ausgeliefert (Login-Hintergrund), das ist mit verschlüsselter Ablage vereinbar, weil die App entschlüsselt |
| Migration (idempotent, fortsetzbar, Admin-Fortschritt) | Bestand | P2c | siehe Konzept 3.5 |

## Reine Lösch-/Verschiebe-Stellen (kein Lesen des Inhalts)

`deleteFolderRecursive`, `hardDeleteTrashItem`, Einmal-Notiz-Bereinigung, Benutzer löschen,
`migrateUploadsToPerUserFolders`: `unlink`/`rename`, unabhängig vom Format. Keine Änderung nötig.
(Ein `rename` ändert den Blob nicht; der Dateiname trägt kein Format-Merkmal.)

## Nicht-Blob-Leser (zur Vollständigkeit)

`openapi.yaml`, `public/index.html`, E-Mail-Templates, `.env`: App-eigene Dateien, keine Nutzerdaten.
