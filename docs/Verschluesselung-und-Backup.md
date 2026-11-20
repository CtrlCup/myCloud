# Konzept: Verschlüsselte Speicherung, Backup & Wiederherstellung

Stand: 2026-10-03 · Status: **P1 und P2 umgesetzt (inkl. Migration), P3 bis P7 offen** · Umsetzung in Phasen, siehe
Abschnitt 8 und die GitHub-Issues mit dem Label `encryption`.

Ziel: Dateien und sensible Datenbankinhalte von myCloud liegen **verschlüsselt auf der Platte**.
Trotzdem lässt sich jederzeit ein **vollständiges Backup** der Cloud erstellen und auf einer
**frischen Instanz** wiederherstellen, inklusive Schlüssel, Nutzern, Freigaben und Einstellungen.

---

## 1. Bedrohungsmodell: wogegen schützt das?

| Szenario | Geschützt? |
|---|---|
| Festplatte, Server oder Volume wird gestohlen oder entsorgt | ✅ ja |
| Backup-Datei landet in falschen Händen (Cloud-Speicher, USB-Stick) | ✅ ja (Backup-Passphrase) |
| Hoster oder Admin mit Zugriff auf `/var/lib/docker/volumes` liest Dateien | ✅ ja, solange er den Master-Key nicht hat |
| Datenbank-Dump (`pg_dump`) wird geleakt | ✅ für verschlüsselte Spalten |
| Angreifer übernimmt die **laufende** App oder Root auf dem Host | ❌ nein: Die App muss entschlüsseln können, der Schlüssel liegt im Speicher |
| Kompromittiertes Nutzerkonto | ❌ nein: Das ist Aufgabe von Auth, 2FA usw. |

Bewusst **nicht** Teil dieses Konzepts: Ende-zu-Ende-Verschlüsselung, bei der der Server die Daten
nie im Klartext sieht. Das würde Vorschaubilder, OCR, Volltextsuche, EuroOffice und
Kollaboration unmöglich machen. Server-seitige Verschlüsselung („at rest“) ist der Standard
vergleichbarer Selbst-Hosting-Lösungen (Nextcloud Server-Side-Encryption, Seafile ohne
verschlüsselte Bibliotheken).

## 2. Überblick: zwei Ebenen

1. **Datenbank → Volume-Verschlüsselung + gezielte Spalten-Verschlüsselung**
   - Das Postgres-Volume liegt auf einem verschlüsselten Dateisystem (LUKS/dm-crypt,
     verschlüsseltes ZFS-Dataset o. Ä.). Das ist transparent für Postgres, und Suche und Indizes
     funktionieren weiter. Das ist Betriebsdoku, kein App-Code (Abschnitt 9).
   - Besonders sensible Spalten verschlüsselt **die App** zusätzlich selbst (Abschnitt 4). So sind
     sie auch in einem geleakten `pg_dump` geschützt.
2. **Dateien → App-seitige Verschlüsselung** jeder Datei unter `uploads/` (Abschnitt 3).

Beide Ebenen hängen an **einem Master-Key** der Instanz (Abschnitt 5). Das Backup enthält diesen
Master-Key, **selbst verschlüsselt mit einer Backup-Passphrase** (Abschnitt 6). Genau das
macht die Wiederherstellung auf einer frischen Instanz möglich.

## 3. Dateiverschlüsselung

### 3.1 Schlüsselhierarchie
```
Master-Key (KEK, 256 Bit, pro Instanz)
  └── verschlüsselt ("wrapped") ──► Data-Encryption-Key (DEK, 256 Bit, pro Datei-Blob, zufällig)
                                      └── verschlüsselt ──► Dateiinhalt
```
- Pro physischer Datei ein eigener zufälliger DEK. Ein kompromittierter DEK betrifft nur eine
  Datei. Schlüsselrotation muss nur die DEKs neu wrappen, nicht alle Dateien neu verschlüsseln.
- Der gewrappte DEK steht im **Header der Datei** (nicht in der DB). Damit ist ein Blob zusammen
  mit dem Master-Key eigenständig entschlüsselbar, das ist robust für Backup und Restore.

### 3.2 Dateiformat (Version 1)
Segmentiertes AES-256-GCM, damit **Range-Requests** (Video-Streaming, Seek im Player, PDF.js)
ohne vollständiges Entschlüsseln funktionieren:

```
Header (fest, 96 Byte):
  magic      "MCENC1\0\0"  (8 B)
  version    uint16 = 1
  keyId      uint32        — welcher Master-Key (für Rotation, per Rewrap änderbar)
  segSize    uint32        — Klartext-Segmentgröße, Standard 65536 (erlaubt 4096 .. 16 MiB)
  plainSize  uint64        — Klartextgröße in Byte (beim Streamen erst am Ende bekannt)
  noncePfx   8 B zufällig  — Nonce-Präfix dieser Datei
  wrappedDek 60 B          — Wrap-IV 12 B || DEK 32 B (verschlüsselt) || GCM-Tag 16 B
  reserviert 2 B           — 0
Segmente i = 0..n-1:
  ciphertext (segSize bzw. Rest) + 16 B GCM-Tag
  Nonce = noncePfx || uint32(i)
  AAD   = SHA256(magic||version||segSize||noncePfx||reserviert) || uint32(i) || isLast-Byte
          [|| plainSize uint64, nur beim letzten Segment]
```
- **Segment-AAD nur über unveränderliche Felder.** `keyId` und `wrappedDek` stehen bewusst nicht
  darin: Der DEK ist durch den GCM-Wrap authentisiert (AAD des Wraps: magic, version, keyId,
  segSize, noncePfx). So ändert eine Schlüsselrotation (`rewrapHeader`) nur die 96 Header-Bytes,
  die Segmente bleiben byte-identisch.
- `plainSize` ist in der AAD des letzten Segments gebunden und wird beim Öffnen exakt gegen die
  Dateigröße geprüft (`96 + plainSize + nseg*16`). Eine **leere Datei** hat genau ein leeres
  letztes Segment, damit Abschneiden erkennbar bleibt. Weil `plainSize` nicht im Wrap-AAD steht, wird bei `plainSize = 0` dieses Segment beim
  Lesen immer verifiziert (sonst ließe sich jede Datei auf 112 Byte kürzen und `plainSize=0` setzen).
  `plainSizeOf()` liest nur den Header und prüft das nicht.
- **Rewrap-Invariante (hartes Verbot):** Nach einem Rewrap, und generell, darf nie neuer Inhalt mit
  demselben DEK und `noncePfx` geschrieben werden (Nonce-Wiederverwendung bricht GCM). Neuer
  Inhalt bedeutet neue Datei mit neuem DEK (Copy-on-Write, Abschnitt 3.4).
- **Domain-Separation:** Der Master-Key ist nie direkt Cipher-Key. Per HKDF-SHA256 (leeres Salt)
  entstehen je Master-Key `kek_wrap` (info `mycloud-file-wrap-v1`), `kcv_key` (`mycloud-kcv-v1`)
  und `col_key` (`mycloud-column-v1`, Abschnitt 4).
- **Ob eine Datei verschlüsselt ist, entscheidet der Aufrufer** (später `files.enc_version`) über den
  Parameter `encrypted`, nicht die Magic-Heuristik. `encrypted: true` ist strikt (ungültiger Header
  ist ein Fehler, nie Klartext), `false` liest Klartext auch bei Header-ähnlichen Bytes. Die
  Heuristik (`isEncrypted`, exakte 8-Byte-Magic) ist nur für Migration und Recovery gedacht.
- Klartextposition p liegt in Segment `floor(p / segSize)`. Ein Range-Request entschlüsselt
  nur die betroffenen Segmente.
- Ein manipuliertes Segment führt zu einem Fehler beim Entschlüsseln (GCM-Tag), der Stream bricht
  sauber ab.
- Nur Node-`crypto`, keine neue Abhängigkeit.
- **Grenzen:** Ein Angreifer mit DB- **und** Plattenzugriff ist nicht abgedeckt (er kann
  `files.enc_version` und Dateien gemeinsam zurückdrehen oder ersetzen). `plainSize` im Header ist
  für `plainSizeOf()` nicht authentisiert. Nach der Migration können Klartextreste auf der Platte
  bleiben (freigegebene Blöcke, Snapshots, Thumbnails, alte Backups), sie werden durch die
  Verschlüsselung nicht geschützt.

### 3.3 Neues Modul `app/crypto-store.js`
Einziger Ort, der Blobs liest oder schreibt. Alle Stellen in `server.js`, die heute direkt über
`fs` gehen, stellen darauf um.
```
encryptFileInPlace(path, { assumePlain }) / writeEncrypted(path, readableOrBuffer) → { plainSize, sha256 }
createDecryptStream(path, { start, end, encrypted }) → Readable (Range-fähig)
readDecrypted(path, { encrypted, maxBytes }) → Buffer (nur für kleine Dateien, z. B. Texteditor)
withPlaintextTempFile(path, async tmp => …, { encrypted, ext }) → für ffmpeg/exiftool/tesseract/pdftoppm/rsvg
plainSizeOf(path, { encrypted }), rewrapHeader(path, { toKeyId }), sweepOrphans(dirs)
sendFileDecrypted(req, res, path, headers)  → Ersatz für res.sendFile/res.download inkl. Range, ETag
isEncrypted(path)                            → exakte Magic-Bytes (nur Migration/Recovery-Heuristik)
```

### 3.4 Betroffene Stellen im Code (Bestand 2026-10-01)
- **20× Auslieferung** (`res.sendFile`, `res.download`, `createReadStream`): Downloads, Inline-Ansicht,
  Freigaben, ZIP (`archiver` bekommt Streams statt Pfade), EuroOffice-Download, Thumbnails.
- **4× In-Place-Schreiben** (`writeFileSync(filePath, …)` in Editor-Speichern, Versions-Restore,
  öffentliches Speichern, EuroOffice-Callback). Diese auf **Copy-on-Write** umstellen: neuen
  Blob mit neuer UUID schreiben, `files.path` umhängen, alten Blob löschen. Das macht Blobs
  unveränderlich, wovon auch das Backup profitiert (Abschnitt 6.3).
- **11× `exec()`** externer Tools, die Klartext brauchen: über `withPlaintextTempFile()` in ein
  privates tmpfs-Verzeichnis (`/run/mycloud-tmp`, Modus 0700) entschlüsseln und danach sofort
  löschen. Im Compose ein `tmpfs`-Mount, damit Klartext nie auf die Platte kommt.
- **Upload-Pfade** (multer, Chunked-Assembly, Notiz-Anhänge, Avatar/Branding): nach dem Empfang
  verschlüsseln. Besser: eigener multer-StorageEngine, der direkt verschlüsselt schreibt, dann
  liegt nie Klartext auf der Platte. Chunks im `tmp-chunked`-Verzeichnis ebenfalls
  verschlüsselt oder auf tmpfs.
  *Entscheidung (P2b):* Avatare (persönliche Fotos) werden bei aktivem Key verschlüsselt als `<uuid>.<ext>.enc`
  abgelegt (Auslieferung entscheidet am Suffix `.enc`, wie bei Thumbnails; ältere Klartext-Avatare bleiben lesbar).
  Branding-Assets (Logo, Hintergründe, SEO-Bild) bleiben bewusst Klartext: sie werden öffentlich ausgeliefert
  (Login-Seite, Link-Vorschau) und enthalten keinen vertraulichen Inhalt.
  Chunked-Upload: jeder Chunk liegt als eigener kleiner verschlüsselter Blob in `tmp-chunked`, der Zusammenbau
  streamt sie entschlüsselt in ein einziges `writeEncrypted` (Details: `docs/P2-Inventar.md`).
- **Thumbnails** (`uploads/thumbnails/`) sind abgeleiteter Klartext und werden genauso
  verschlüsselt gespeichert.
- `files.size` bleibt die **Klartextgröße** (Quota, Anzeige). `content_hash` wird über den
  **Klartext** gebildet (Duplikat-Erkennung funktioniert weiter).

### 3.5 Migration bestehender Instanzen
- Neue Spalte `files.enc_version SMALLINT NULL` (NULL = Klartext) über `initDb()`.
- Hintergrund-Job nach dem Muster von `migrateUploadsToPerUserFolders()`: fortsetzbar und
  idempotent. Pro Datei: verschlüsselte Kopie schreiben, Tag prüfen, per `rename()` atomar
  ersetzen, dann `enc_version = 1` setzen. Klartext- und verschlüsselte Blobs funktionieren
  während der Migration parallel (`isEncrypted()` per Magic-Bytes).
- Fortschritt im Admin-Bereich anzeigen (wie der vorhandene Faststart-Backfill).
- *Umsetzung (P2c, `app/encrypt-migration.js`):* Statt `rename()` über den Alt-Blob wird nie in-place geschrieben: neuer Blob
  (neue UUID, `writeEncrypted`), Verifikation (Entschlüsseln, SHA-256, Größe gegen `files.size`), dann ein Transaktions-Swap
  (`FOR UPDATE`, `expectPath`) von `path`/`enc_version`/`content_hash`, Löschen des Alt-Blobs erst nach dem Commit. Klartext-
  Thumbnails werden gelöscht, Klartext-Avatare nach `<uuid>.<ext>.enc` migriert. Eine Zeile mit `enc_version NULL`, deren Blob
  bereits vollständig mit dem aktiven Key lesbar ist (und zur Größe passt), bekommt nur die Spalte nachgezogen; besteht ein
  Blob mit Magic diese Prüfung nicht, ist er Klartext (`enc_version NULL` heißt immer Klartext) und wird normal migriert.
  Löschen alter Blobs läuft über die Outbox `pending_blob_deletes` (`app/blob-outbox.js`): `swapFileBlob` trägt den alten Pfad in
  derselben Transaktion wie den Pfad-Swap ein, nach dem Commit löscht `tryDeleteBlob` und entfernt den Eintrag; ein Worker
  (beim Start und alle 10 Minuten, immer aktiv) räumt Reste nach Abstürzen ab und löscht nur Pfade, die weder `files.path`
  noch `users.avatar_path` noch ein Branding-Setting referenziert. Alle Sofort-Löschstellen (`tryDeleteBlob`, Papierkorb, Ersetzen, Einmal-Notizen, Benutzer löschen) gehen über denselben Referenz-Re-Check. Die Outbox enthält ausschließlich alte, bereits entkoppelte Pfade (UUID-eindeutig, nie wieder vergeben); der NEUE Blob der Migration steht nie darin. Bricht der Prozess zwischen Umbenennen und Swap ab, bleibt höchstens ein verwaister verschlüsselter Blob (Speicherverschwendung, kein Klartext-Leck). Einträge mit Verzeichnis-Pfad werden verworfen, nach 20 Fehlversuchen mit Warnung ebenfalls. Reste ohne Outbox-Eintrag (z. B. Absturz mitten in `writeEncrypted`):
  `<name>.tmp-`/`.enc-tmp-`-Dateien entfernt `sweepOrphans` nach 1 h. P4 kann am Worker über `isBlocked` ("backup_in_progress")
  einhängen. Zeilen mit fehlender oder abweichender `size` zählen als `failed` und brauchen eine manuelle Prüfung. Steuerung:
  `MYCLOUD_MIGRATION_CONCURRENCY`, `MYCLOUD_MIGRATION_PAUSE_MS`, Einstellung `encryption_auto_migrate` (nur als DB-Setting).
- Verschlüsselung ist **Opt-in**: Ohne konfigurierten Master-Key verhält sich die App wie heute.

## 4. Spaltenverschlüsselung in der Datenbank

App-seitig verschlüsselt: AES-256-GCM, Format `enc:v1:<keyId>:<base64(nonce|ct|tag)>`, Schlüssel
per HKDF aus dem Master-Key abgeleitet (Kontext `"mycloud-column-v1"`).

| Spalte | Warum | Folgen |
|---|---|---|
| `users.totp_secret` | TOTP-Seed = zweiter Faktor | keine |
| `settings.email_smtp_pass`, `settings.sso_client_secret` | Zugangsdaten Dritter | Das Zurückschreiben in `.env` entfällt (Entscheidung F3) |
| `file_versions.content` | Vollständige alte Dateiinhalte | keine (wird nur einzeln gelesen) |
| `shares.message` | Freitext an Empfänger | keine |

**Nicht** app-seitig verschlüsselt, Schutz über die Volume-Verschlüsselung (Abschnitt 9):
- `files.content` (Volltext-Index): Die Tiefensuche per `ILIKE`/Trigram bleibt wie heute
  (Entscheidung F1).
- `files.name`, Ordnerstruktur, Größen, Zeitstempel: für Sortierung, Namenssuche
  (Trigram-Index) und Konfliktprüfung.

Passwort-Hashes (bcrypt) und API-Key-Hashes bleiben, wie sie sind: Sie sind bereits Einweg-Hashes.

## 5. Master-Key-Verwaltung

- Quelle, in dieser Reihenfolge:
  1. `MYCLOUD_MASTER_KEY_FILE`: Pfad zu einer Datei mit 32 zufälligen Bytes (hex/base64),
     empfohlen als **Docker-Secret** (`secrets:` in Compose), nicht als Umgebungsvariable.
  2. Nicht gesetzt: Verschlüsselung aus, App verhält sich wie heute.
- Erzeugung: `docker compose run --rm app node scripts/keys.js init` schreibt die Key-Datei
  (Modus 0400) und gibt einmalig einen **Recovery-Code** aus, der den Master-Key enthält
  (z. B. Base32 in 4er-Gruppen). Der Admin muss ihn offline aufbewahren (Passwortmanager).
- **Ohne Master-Key sind die Daten verloren.** Das muss in UI und Doku unmissverständlich
  stehen. Der Admin-Bereich zeigt einen Hinweis, solange der Recovery-Code nicht als „gesichert“
  bestätigt ist.
- Beim Start prüft die App **Key-Check-Werte** pro `keyId` (in `settings` als `crypto_kcv:<keyId>`,
  Wert `HMAC(kcv_key, "mycloud-kcv")`). Passt der Wert des `current`-Keys nicht, bricht der Start mit
  klarer Fehlermeldung ab, statt Dateien unlesbar zu „verschlüsseln“. Eine neue `keyId` wird erst
  angelegt, wenn ein anderer konfigurierter Key zu seinem Eintrag passt. Ist ein alter Key entfernt,
  aber sein Eintrag noch da, gibt es nur eine Warnung (Dateien mit dieser `keyId` prüfen P2/P5).
- **Rotation:** Neuer Key bekommt eine neue `keyId`. Ein Hintergrund-Job wrappt alle DEKs in den
  Headern neu (nur je ~100 Byte pro Datei) und verschlüsselt die Spalten neu. Alte Keys bleiben
  lesbar, bis der Job fertig ist.
  - **Risiko Torn-Write:** Der Header-Rewrap überschreibt 96 Byte in place und ist nicht
    crash-atomar. Deshalb sichert `rewrapHeader` vorher den alten Header in `<datei>.rewrap-bak`
    (0600, fsync), verifiziert nach dem Schreiben per Rücklesen, stellt bei Fehlern den alten Header
    zurück und löscht das Backup erst danach. Nach einem Absturz stellt `recoverRewrap(path)` den alten
    Header wieder her, falls der aktuelle nicht entpackbar ist, sonst löscht es nur das Backup.
  - Vor einem Massen-Rewrap ein Backup (Abschnitt 6) erstellen. Der Rewrap läuft im Wartungsfenster
    oder mit Retry bei gleichzeitigen Lesern: Leser können kurz `KEY_MISMATCH` sehen. Der Lesepfad
    wiederholt den Header-Unwrap deshalb einmal nach 50 ms.

## 6. Backup

### 6.1 Inhalt eines Backups
Eine Datei `mycloud-backup-<Instanzname>-<YYYYMMDD-HHMMSS>.mcbak`:
```
Äußere Hülle: verschlüsselt mit Backup-Passphrase (Abschnitt 6.2)
  manifest.json   — Format-Version, App-Version, Schema-Stand, Erstellzeit, Instanzname,
                    Anzahl Nutzer/Dateien, Liste aller Blobs mit Größe + SHA-256 (des Ciphertexts)
  keys.json       — Master-Key(s) inkl. keyId, Key-Check-Wert
  db.dump         — pg_dump im Custom-Format (-Fc), vollständige Datenbank inkl. settings
  blobs/…         — alle Dateien aus uploads/ (bereits verschlüsselt, werden 1:1 kopiert)
  env.json        — optional: nicht-geheime Konfiguration (APP_URL, EURO_OFFICE_*, PORT)
```
- Nicht enthalten: `SESSION_SECRET` und `DB_PASSWORD` (gehören zur Zielinstanz),
  Session-Tabelle (alle Nutzer müssen sich nach einem Restore neu einloggen), `tmp-chunked`.
- Blobs sind schon mit dem Master-Key verschlüsselt. Der Master-Key selbst steckt verschlüsselt im
  Backup. Das Backup ist damit **eigenständig wiederherstellbar**, nur Backup-Datei und
  Passphrase werden gebraucht.

### 6.2 Verschlüsselung der Backup-Datei
- Schlüssel aus Backup-Passphrase per **scrypt** (N=2^17, r=8, p=1; in Node-`crypto`
  enthalten) oder Argon2id (braucht eine Abhängigkeit). Salt im Klartext-Header.
- Inhalt als `tar`-Stream (Paket `tar-stream`, oder ZIP ohne Kompression über das vorhandene
  `archiver`), segmentiert mit AES-256-GCM verschlüsselt, gleiches Segmentformat wie in 3.2.
  Damit sind auch viele GB streambar, ohne alles im RAM zu halten.
- Die Passphrase wird **nie** gespeichert. Für automatische Backups:
  `MYCLOUD_BACKUP_PASSPHRASE_FILE` (Docker-Secret).

### 6.3 Konsistenz
- Durch Copy-on-Write (3.4) sind Blobs unveränderlich. Ablauf:
  1. Flag `backup_in_progress` setzen. Solange es gesetzt ist, **verzögern** Papierkorb-Leerung,
     Hard-Delete und Löschen alter Blobs nach Copy-on-Write ihr physisches `unlink()` (Queue).
  2. `pg_dump` erzeugt einen transaktionskonsistenten Snapshot.
  3. Alle im Dump referenzierten Blobs kopieren. Seit dem Dump neu hinzugekommene Blobs fehlen
     im Backup, sind aber auch nicht im Dump referenziert. Das ist konsistent.
  4. Flag löschen, verzögerte Löschungen ausführen.
- Keine Downtime und kein Wartungsmodus nötig.
- Voraussetzung im Container: `postgresql15-client` (für `pg_dump`/`pg_restore`) im
  `app/Dockerfile` ergänzen, Version passend zum `postgres:15`-Image.

### 6.4 Auslösen & Ablage
- **Admin-UI** (Systemeinstellungen → „Backup“): „Backup jetzt erstellen“ mit Passphrase-Eingabe,
  Fortschrittsanzeige, Liste vorhandener Backups mit Größe/Datum, Download und Löschen.
- **Zeitplan:** Einstellung „täglich/wöchentlich um HH:MM“, Aufbewahrung „letzte N Backups“.
- **Ablage:** eigenes Volume `backups_data` → `/usr/src/app/backups` (nicht im Upload-Volume!).
  Optional später: Upload per rclone/S3 (eigene Phase).
- **CLI** (für Cron/Automatisierung außerhalb der App):
  `docker compose exec app node scripts/backup.js create --passphrase-file /run/secrets/backup_pass`
  und `… verify <datei>` (entschlüsselt, prüft alle SHA-256 aus dem Manifest, ohne etwas
  wiederherzustellen).

## 7. Wiederherstellung auf einer frischen Instanz

Bewusst **nur per CLI**, nicht über die Weboberfläche. Eine frische Instanz ist über den
„erster Nutzer wird Admin“-Mechanismus öffentlich erreichbar. Ein Web-Restore-Formular dort wäre
ein Einfallstor.

```
# 1. Frische Instanz nach README aufsetzen (eigenes .env mit neuem SESSION_SECRET/DB_PASSWORD),
#    aber noch keinen Nutzer registrieren.
docker compose up -d db
# 2. Restore
docker compose run --rm -v /pfad/zum/backup:/restore:ro app \
  node scripts/backup.js restore /restore/mycloud-backup-….mcbak --passphrase-file /run/secrets/backup_pass
# 3. App starten
docker compose up -d
```
Ablauf in `restore`:
1. Passphrase prüfen, Manifest lesen und **Kompatibilität** prüfen: Backup-App-Version ≤ aktuelle
   App-Version (neuere Backups auf älterem Code ablehnen), Format-Version bekannt.
2. **Zielinstanz muss leer sein** (keine Nutzer, keine Blobs), sonst Abbruch. Nur mit `--force`
   wird eine bestehende Instanz überschrieben, nach Rückfrage.
3. Master-Key(s) aus `keys.json` in die Key-Datei schreiben (`MYCLOUD_MASTER_KEY_FILE`). Existiert
   dort schon ein anderer Key: Abbruch.
4. `pg_restore --clean --if-exists` in die leere DB.
5. Blobs nach `uploads/` kopieren und jede SHA-256 gegen das Manifest prüfen.
6. Sessions leeren, `backup_in_progress` zurücksetzen.
7. Beim nächsten App-Start läuft `initDb()` und hebt ein älteres Schema automatisch an. Deshalb
   ist „älteres Backup auf neuerem Code“ unterstützt.
8. Zusammenfassung ausgeben: Anzahl Nutzer/Dateien/Freigaben, fehlende oder defekte Blobs.

Nach dem Restore funktionieren: Login aller Nutzer (Passwort, Passkeys, TOTP), alle Dateien,
Freigabe-Links (gleiche Slugs), Einstellungen und Branding. **Einschränkungen:** Passkeys sind an
die Domain (RP-ID) gebunden und funktionieren nur unter derselben Domain. SSO-Callback-URL im
IdP ggf. anpassen. Nutzer müssen sich neu einloggen.

## 8. Umsetzungsphasen

| Phase | Inhalt | Abhängig von |
|---|---|---|
| **P1** | `crypto-store.js` (Format v1, Stream-/Range-Entschlüsselung), Master-Key-Laden, Key-Check, `scripts/keys.js init` | – |
| **P2** | Alle Lese- und Schreibstellen auf `crypto-store` umstellen, Copy-on-Write, Temp-Klartext über tmpfs, Thumbnails, Migration bestehender Dateien, Admin-Anzeige (Vorgaben siehe unten) | P1 |
| **P3** | Spaltenverschlüsselung (Abschnitt 4) inkl. Migration; `.env`-Rückschreiben der Secrets entfernen (F3) | P1 |
| **P4** | Backup: Format, `scripts/backup.js create/verify`, Konsistenz-Flag, Admin-UI, Zeitplan und Aufbewahrung | P1 (P2 für Copy-on-Write-Konsistenz) |
| **P5** | Restore-CLI, Kompatibilitätsprüfungen, Doku im README | P4 |
| **P6** | Schlüsselrotation | P2, P3 |
| **P7** | Keine Klartext-Passwörter mehr: Docker-Secrets für Startgeheimnisse, Reset-Tokens nur gehasht (Abschnitt 12) | P1, P3 |

**Vorgaben für P2 (aus dem Krypto-Review):**
- `files.enc_version` ist die Wahrheit für jede Lese-, Schreib- und Auslieferungsentscheidung und wird
  als `encrypted` an `crypto-store` übergeben, keine Magic-Heuristik im Normalbetrieb.
- `files.size` gegen die Header-`plainSize` abgleichen, bei Abweichung Antwort 500.
- Bei Stream-Fehlern nach bereits gesendetem Header `res.destroy(err)`, nie einen Teilinhalt als
  erfolgreich abschließen.
- Migration idempotent: Eine bereits verschlüsselte Datei mit `enc_version = NULL` erkennen und nur
  die Spalte nachziehen. Vor dem `rename` das Ergebnis verifizieren (entschlüsseln, Hash vergleichen).
- Semaphor für paralleles Entschlüsseln (CPU- und Speicherlast begrenzen).
- Key-Check-Erstinitialisierung (`crypto_kcv:*` anlegen) nur, wenn keine Datei mit `enc_version > 0`
  existiert. Sonst Abbruch, damit ein fehlender oder leerer `settings`-Eintrag nicht mit einem neuen Key
  "überschrieben" wird, während schon verschlüsselte Dateien existieren.

Jede Phase ist für sich auslieferbar. Ohne Master-Key bleibt das Verhalten unverändert.

## 9. Betrieb: Volume-Verschlüsselung für Postgres (Doku, kein Code)
- Docker-Volumes auf ein LUKS-Device legen (`cryptsetup luksFormat` → Mount unter
  `/var/lib/docker/volumes` oder eigener `data-root` in `/etc/docker/daemon.json`) oder ein
  verschlüsseltes ZFS-Dataset nutzen.
- Entsperren beim Boot: Passphrase, Keyfile auf separatem Medium oder TPM2
  (`systemd-cryptenroll --tpm2-device=auto`). Das ist Abwägungssache und gehört ins README-Kapitel
  „Härtung“.

## 10. Testfälle (Abnahmekriterien für die Umsetzung)

Diese Tests sollen als automatisierte Tests unter `tests/` entstehen (`node --test`, keine
Abhängigkeiten) und gegen den isolierten Test-Stack `tests/docker-compose.test.yml` laufen. Für
Backup/Restore werden zwei Stacks gebraucht (Quelle und Ziel, unterschiedliche Compose-Projektnamen
und Ports). Jede Phase gilt erst als fertig, wenn ihre Tests grün sind.

**Unit-Tests `crypto-store` (P1)**
- E1 Roundtrip: Beliebige Daten (0 B, 1 B, genau 1 Segment, Segment+1, 50 MB) verschlüsseln und
  entschlüsseln ergibt identische Bytes.
- E2 Auf der Platte steht kein Klartext: Eine bekannte Zeichenfolge im Klartext kommt in der
  verschlüsselten Datei nicht vor. Header beginnt mit `MCENC1`.
- E3 Range: Für zufällige `(start, end)`-Paare, auch über Segmentgrenzen und das letzte Segment,
  entspricht `createDecryptStream({start,end})` exakt dem Klartext-Ausschnitt.
- E4 Integrität: Ein gekipptes Bit in Header, Segment oder Tag, ein vertauschtes Segment und eine
  abgeschnittene Datei führen jeweils zu einem Fehler, niemals zu stillschweigend falschen Daten.
- E5 Falscher Master-Key: Entschlüsseln schlägt fehl. App-Start mit falschem Key bricht mit
  Key-Check-Fehler ab.
- E6 Zwei Verschlüsselungen derselben Datei ergeben unterschiedliche Ciphertexte (zufälliger DEK
  und Nonce).

**Integrationstests über die HTTP-API (P2/P3)**
- E7 Upload → Download liefert identische Bytes. Die Datei im Upload-Volume ist verschlüsselt
  (per `docker compose exec` die Magic-Bytes lesen).
- E8 Video-Range-Request (`Range: bytes=1000-1999`) liefert `206`, korrekte `Content-Range`-Header
  und die richtigen Bytes.
- E9 Chunked-Upload großer Datei: identische Bytes, kein Klartext in `tmp-chunked` oder `uploads`.
- E10 Texteditor speichern, danach Versionsverlauf-Restore: Inhalt korrekt, alter Blob gelöscht
  (Copy-on-Write), neuer Blob verschlüsselt.
- E11 Thumbnail wird erzeugt und ausgeliefert. Der Thumbnail-Cache auf der Platte ist verschlüsselt.
  Im tmpfs-Temp-Verzeichnis bleibt nach der Verarbeitung nichts liegen.
- E12 ZIP-Download eines Ordners enthält den korrekten Klartext.
- E13 Freigabe-Download (öffentlich) liefert den korrekten Klartext.
- E14 Migration: Instanz mit Klartext-Dateien starten, Master-Key setzen, Migration laufen lassen.
  Danach sind alle Dateien verschlüsselt und weiterhin abrufbar. Ein Abbruch mittendrin
  (Container-Neustart) ist fortsetzbar, ohne dass eine Datei doppelt verschlüsselt wird.
- E15 Spalten: `users.totp_secret` usw. beginnen in der DB mit `enc:v1:`. TOTP-Login funktioniert.
- E16 Ohne Master-Key verhält sich die App exakt wie vorher (bestehende Funktionen weiter grün).

**Backup & Restore (P4/P5)**
- B1 Roundtrip auf frische Instanz: Quelle mit mehreren Nutzern, Ordnerstruktur, Dateien
  (inkl. Video, Bild, Textdatei mit Versionen), Freigaben (mit Passwort), Papierkorb-Inhalt,
  Einstellungen/Branding. Backup erstellen, auf leerer Ziel-Instanz wiederherstellen. Danach gilt:
  gleiche Nutzer können sich mit ihren Passwörtern einloggen, `GET /api/files/list` ist rekursiv
  identisch (Namen, Größen, Struktur), jede Datei ist byteweise identisch (SHA-256), Freigabe-Links
  unter gleichem Slug funktionieren inkl. Passwort, Papierkorb und Einstellungen sind identisch.
- B2 Falsche Passphrase: `restore` bricht vor jeder Änderung ab, Ziel-Instanz bleibt leer.
- B3 Manipuliertes Backup (ein Byte in einem Blob oder im Manifest geändert): `verify` meldet den
  Fehler, `restore` bricht ab.
- B4 Nicht-leere Ziel-Instanz: `restore` ohne `--force` bricht ab und verändert nichts.
- B5 Versionsprüfung: Ein Backup mit höherer App-Version als der Code wird abgelehnt. Ein Backup
  einer älteren Version wird eingespielt und das Schema per `initDb()` angehoben.
- B6 Konsistenz unter Last: Während ein Backup läuft, werden parallel Dateien hochgeladen und
  gelöscht, der Papierkorb geleert. Das Backup ist trotzdem vollständig wiederherstellbar (kein im
  Dump referenzierter Blob fehlt).
- B7 Backup enthält keinen Klartext: Die `.mcbak`-Datei enthält weder einen bekannten
  Dateiinhalt noch einen bekannten Dateinamen im Klartext.
- B8 Aufbewahrung: Bei „letzte 3 Backups behalten“ bleiben nach 5 Läufen genau 3 Dateien übrig.
- B9 Backup-Download und -Löschen im Admin-Bereich nur für Admins (Nicht-Admin: 403).

## 11. Entscheidungen

Entschieden am 2026-10-01 von @CtrlCup:

- **F1 Tiefensuche vs. Verschlüsselung von `files.content`:** ✅ **Variante (a).** `files.content`
  bleibt unverschlüsselt, Schutz über die Volume-Verschlüsselung (Abschnitt 9). Die Tiefensuche
  bleibt unverändert.
- **F3 `.env`-Rückschreiben von SMTP/SSO-Secrets:** ✅ **Entfällt.** `updateEnvFile()` in
  `server.js` schreibt keine Secrets mehr. Übergeordnetes Ziel: **keine Klartext-Passwörter mehr
  in `.env`, im Repository oder in der Datenbank**, siehe Abschnitt 12.

Noch offen:

- **F2 Dateinamen verschlüsseln?** Empfehlung: nein (Sortierung, Namenssuche, Konfliktprüfung).
  Schutz über die Volume-Verschlüsselung.
- **F4 Automatische Backups nach extern** (S3, rclone/pCloud): eigene Phase nach P5?

## 12. Keine Klartext-Passwörter mehr (Phase P7)

Ziel (Entscheidung F3): Weder `.env` noch Repository noch Datenbank enthalten Passwörter oder
Tokens im Klartext.

**Was technisch nicht vermeidbar ist:** Ein paar **Startgeheimnisse** muss der Container beim
Start lesen können: Master-Key, Datenbank-Passwort und Session-Secret. Diese liegen nicht mehr in
`.env`, sondern als **Docker-Secrets**: je eine eigene Datei pro Geheimnis, Modus 0400, außerhalb
des Repos, nicht in Backups (außer dem verschlüsselten Master-Key, Abschnitt 6.1). Im Container
erscheinen sie unter `/run/secrets/…`, nicht als Umgebungsvariable (die sonst per
`docker inspect` und in `/proc/*/environ` sichtbar wäre).

| Geheimnis | Heute | Künftig |
|---|---|---|
| `SESSION_SECRET` | `.env` | Secret-Datei `session_secret` → `SESSION_SECRET_FILE` |
| `DB_PASSWORD` | `.env`, in `DATABASE_URL` eingebettet | Secret-Datei `db_password`; Postgres liest `POSTGRES_PASSWORD_FILE`, die App baut die Verbindung aus `DB_PASSWORD_FILE` |
| Master-Key | – | Secret-Datei `master_key` → `MYCLOUD_MASTER_KEY_FILE` (P1) |
| SMTP-Passwort, SSO-Client-Secret | `.env` + DB-Klartext + Rückschreiben | **nur** verschlüsselt in der DB (P3), gepflegt über die Admin-UI. `.env`-Variablen nur noch einmalig zum Erststart übernehmen und danach ignorieren (Warnung im Log, solange sie noch gesetzt sind) |
| Backup-Passphrase | – | Secret-Datei → `MYCLOUD_BACKUP_PASSPHRASE_FILE` (P4) |
| Passwort-Reset-Tokens | Klartext in `settings` | nur als SHA-256-Hash speichern (wie die API-Keys), eigene Tabelle mit Ablauf |

Umsetzung:
- Hilfsfunktion `readSecret(name)`: liest `NAME_FILE`, sonst (übergangsweise, mit Warnung) `NAME`.
- `docker-compose.example.yml`: `secrets:`-Block, `.env.example` ohne Passwort-Beispiele.
- `scripts/keys.js init` erzeugt alle Secret-Dateien mit zufälligen Werten.
- `updateEnvFile()` entfernen (bzw. nur noch für nicht-geheime Werte behalten).
- Migration bestehender Instanzen: Beim Start mit gesetzten Klartext-Variablen eine Warnung
  ausgeben und in der Admin-UI einen Hinweis „Klartext-Secrets in .env gefunden“ anzeigen. Das
  README bekommt eine Schritt-für-Schritt-Umzugsanleitung.

**Tests (S1–S4):**
- S1 Mit Secret-Dateien und ohne jede Passwort-Variable in `.env` startet der Stack und
  Login, Upload und Freigaben funktionieren.
- S2 Nach dem Speichern von SMTP-/SSO-Einstellungen in der Admin-UI enthält `.env` keinen dieser
  Werte, und in der DB beginnen sie mit `enc:v1:`.
- S3 Ein Passwort-Reset-Token steht nirgends im Klartext in der DB. Der Reset per Link funktioniert.
- S4 `docker inspect` des App-Containers zeigt keine Passwörter in den Umgebungsvariablen.
