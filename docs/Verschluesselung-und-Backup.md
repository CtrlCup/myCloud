# Konzept: Verschlüsselte Speicherung, Backup & Wiederherstellung

Stand: 2026-10-01 · Status: **Entwurf, noch nicht umgesetzt** · Umsetzung in Phasen, siehe
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
  keyId      uint32        — welcher Master-Key (für Rotation)
  segSize    uint32        — Klartext-Segmentgröße, Standard 65536
  plainSize  uint64        — Klartextgröße in Byte
  noncePfx   8 B zufällig  — Nonce-Präfix dieser Datei
  wrappedDek 40 B          — DEK, mit KEK per AES-256-GCM-Keywrap (12 B Nonce + 16 B Tag inkl.)
  reserviert/padding
Segmente i = 0..n-1:
  ciphertext (segSize bzw. Rest) + 16 B GCM-Tag
  Nonce = noncePfx || uint32(i)
  AAD   = Header-Hash || uint32(i) || isLast-Flag   — verhindert Vertauschen/Abschneiden
```
- Klartextposition p liegt in Segment `floor(p / segSize)`. Ein Range-Request entschlüsselt
  nur die betroffenen Segmente.
- Ein manipuliertes Segment führt zu einem Fehler beim Entschlüsseln (GCM-Tag), der Stream bricht
  sauber ab.
- Nur Node-`crypto`, keine neue Abhängigkeit.

### 3.3 Neues Modul `app/crypto-store.js`
Einziger Ort, der Blobs liest oder schreibt. Alle Stellen in `server.js`, die heute direkt über
`fs` gehen, stellen darauf um.
```
encryptFileInPlace(path) / writeEncrypted(path, readableOrBuffer) → { plainSize, sha256 }
createDecryptStream(path, { start, end })   → Readable (Range-fähig)
readDecrypted(path) → Buffer                (nur für kleine Dateien, z. B. Texteditor)
withPlaintextTempFile(path, async tmp => …) → für ffmpeg/exiftool/tesseract/pdftoppm/rsvg
sendFileDecrypted(req, res, path, headers)  → Ersatz für res.sendFile/res.download inkl. Range, ETag
isEncrypted(path)                            → Magic-Bytes prüfen (für Migration/Mischbetrieb)
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
- Verschlüsselung ist **Opt-in**: Ohne konfigurierten Master-Key verhält sich die App wie heute.

## 4. Spaltenverschlüsselung in der Datenbank

App-seitig verschlüsselt: AES-256-GCM, Format `enc:v1:<keyId>:<base64(nonce|ct|tag)>`, Schlüssel
per HKDF aus dem Master-Key abgeleitet (Kontext `"mycloud-column-v1"`).

| Spalte | Warum | Folgen |
|---|---|---|
| `users.totp_secret` | TOTP-Seed = zweiter Faktor | keine |
| `settings.email_smtp_pass`, `settings.sso_client_secret` | Zugangsdaten Dritter | Beim Zurückschreiben in `.env` bleibt der Klartext dort, siehe offene Frage F3 |
| `file_versions.content` | Vollständige alte Dateiinhalte | keine (wird nur einzeln gelesen) |
| `shares.message` | Freitext an Empfänger | keine |
| `files.content` (Volltext-Index) | enthält Textauszüge **aller** Dokumente | ⚠️ **Tiefensuche per `ILIKE` geht dann nicht mehr**, siehe F1 |

**Nicht** verschlüsselt: `files.name`, Ordnerstruktur, Größen, Zeitstempel. Sie werden für Sortierung,
Namenssuche (Trigram-Index) und Konfliktprüfung gebraucht. Schutz über die Volume-Verschlüsselung.

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
- Beim Start prüft die App einen **Key-Check-Wert** (in `settings`, z. B. `HMAC(KEK, "mycloud-kcv")`).
  Falscher Schlüssel bedeutet: Start mit klarer Fehlermeldung abbrechen, statt Dateien
  unlesbar zu „verschlüsseln“.
- **Rotation:** Neuer Key bekommt eine neue `keyId`. Ein Hintergrund-Job wrappt alle DEKs in den
  Headern neu (nur je ~100 Byte pro Datei) und verschlüsselt die Spalten neu. Alte Keys bleiben
  lesbar, bis der Job fertig ist.

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
| **P2** | Alle Lese- und Schreibstellen auf `crypto-store` umstellen, Copy-on-Write, Temp-Klartext über tmpfs, Thumbnails, Migration bestehender Dateien, Admin-Anzeige | P1 |
| **P3** | Spaltenverschlüsselung (Abschnitt 4) inkl. Migration, Entscheidung F1 umsetzen | P1 |
| **P4** | Backup: Format, `scripts/backup.js create/verify`, Konsistenz-Flag, Admin-UI, Zeitplan und Aufbewahrung | P1 (P2 für Copy-on-Write-Konsistenz) |
| **P5** | Restore-CLI, Kompatibilitätsprüfungen, Doku im README | P4 |
| **P6** | Schlüsselrotation | P2, P3 |

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

## 11. Offene Entscheidungen

- **F1 Tiefensuche vs. Verschlüsselung von `files.content`:**
  (a) `files.content` unverschlüsselt lassen, Schutz nur über die Volume-Verschlüsselung;
  Tiefensuche bleibt wie heute. Das ist die Empfehlung für den Anfang.
  (b) Verschlüsseln, Tiefensuche entfällt oder nutzt einen Blind-Index (Aufwand hoch).
  (c) Verschlüsseln und Volltextsuche nur über Dateinamen.
- **F2 Dateinamen verschlüsseln?** Empfehlung: nein (Sortierung, Namenssuche, Konfliktprüfung).
  Schutz über die Volume-Verschlüsselung.
- **F3 `.env`-Rückschreiben von SMTP/SSO-Secrets:** Die App schreibt diese Werte heute im
  Klartext zurück in `.env`. Mit Spaltenverschlüsselung sollte das entfallen: Secrets nur noch
  verschlüsselt in der DB, `.env` nur noch für den Erststart.
- **F4 Automatische Backups nach extern** (S3, rclone/pCloud): eigene Phase nach P5?
