# Handoff-Notizen

Jede Übergabe zwischen Rechnern hängt hier einen neuen Abschnitt an (nicht
überschreiben). Neueste Einträge stehen unten.

## 2026-10-01 – Rechnerwechsel (Laptop -> Server), manuell ausgelöst
Alle Agenten pausiert. Sicherheits-Welle 1+2 (#51-#55) und #47 sind gemergt, gepusht und geschlossen (Version 0.4.29).
Dieser Branch (fix/49-50-sso-users) enthält den **unfertigen, nicht verifizierten Zwischenstand** der SSO-Arbeit (#49/#50: app/sso-user.js, Settings-Button "Mit SSO verknüpfen", tests/sso-user.test.js). Der Agent wurde mitten in der Arbeit gestoppt: zuerst `node --check`, Tests, Diff prüfen, dann fertigstellen.
Danach offen: #40-Rest (generateUniqueName, Zyklenprüfung copy-multiple), #41, #42, #43, #44 (vermutlich durch #54 erledigt, nur verifizieren), #45, #46, #48. Workflow: je Issue Branch -> Review/Verifikation im Test-Stack -> ff-Merge -> `gh issue close <n> -c "Verifiziert im Test-Stack."`.
Test-Stack: `docker compose -p mycloudtest -f tests/docker-compose.test.yml up --build -d`; vor Testläufen `restart app` + 8 s warten; `node --test --test-concurrency=1 tests/*.test.js`.

## 2026-10-04 – Pause wegen Limit, Stand sichern (NICHT starten, bis Alex es freigibt)
Alex wartet auf sein Wochenlimit. Diese Notiz sichert den Stand; die Session soll NICHT von selbst loslegen.

**Rahmen:** Verschlüsselung/Backup-Konzept `docs/Verschluesselung-und-Backup.md`, Issues #33–#39 (Phasen P1–P7). Rollenmodell: der Orchestrator (Hauptsession) plant/prüft/verifiziert, Sonnet-`developer`-Agenten implementieren (je Phase ein Branch, sequenziell), danach unabhängige Reviews (`crypto`-Agent für Krypto/Klartext-Lecks, `reviewer` für Korrektheit/Datenverlust, `scope-guard`, `regression-guard`, vor Push `release-guard`). Erst nach grünem Test + Review mergen (ff), pushen, Issue schließen (`gh issue close <n> -c "Verifiziert ..."`, Auto-Schließen ist von Alex gewünscht; Ausnahme: #49/#50 bleiben bewusst offen, #57 ist eine offene Designfrage). Commit-Footer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` und `Claude-Session: ...`. Minor-Bump (0.5.0) NUR nach Rückfrage bei Alex am Ende (aktuell 0.4.30 auf main). Keine Klartext-Secrets einführen.

**Erledigt (in main, gepusht, Issues geschlossen):** #33 P1 (crypto-store, Master-Key, keys.js), #34 P2a/P2b/P2c (Lese-/Schreibpfade verschlüsselt, Copy-on-Write, Migration, Blob-Outbox `pending_blob_deletes`, Enc-Teststack). Davor: Sicherheits-Welle #51–#55 und Funktionsbugs #40–#48, #49/#50 (offen, Authentik manuell prüfen).

**Test-Workflow (WICHTIG):** `./tests/run-all.sh` (Port 3099, Projekt mycloudtest) UND danach `./tests/run-all-enc.sh` (Port 3098, Projekt mycloudenc). NIE zwei Läufe parallel auf demselben Stack (Kollision → "App im Enc-Stack nicht erreichbar"). Vorher `ps aux | grep run-all` prüfen. Läufe dauern ~10 Min. je, mit `run_in_background` starten. Die Stacks werden aus dem ARBEITSVERZEICHNIS gebaut: Änderungen während eines Laufs verfälschen das Ergebnis. Test-Stack: `docker compose -p mycloudtest -f tests/docker-compose.test.yml up --build -d`.

**Aktuell: P3 (#35, Spaltenverschlüsselung) auf Branch `feat/p3-columns`:** Commit f5356e3 (Basis-Implementierung, von einem Agenten als grün gemeldet) + WIP-Commit mit teilweise umgesetzter Review-Nachbesserung. **Unverifiziert:** Ein eigener Lauf des Orchestrators auf f5356e3 (während der Agent parallel Dateien änderte) war im normalen Stack grün, im Enc-Stack aber ROT in `tests/p3-columns.test.js`: "E15 TOTP: Setup+Bestätigung" und "Migration: Klartext-Altwerte aller fünf Spalten". Ursache ungeklärt (Code-Fehler oder Verfälschung durch parallele Änderungen): ERST sauber neu verifizieren (kein paralleles Arbeiten), dann weiter.

**Offene Nachbesserungen P3 (aus dem Krypto-Review; Stand der Umsetzung im WIP prüfen, `git diff f5356e3`):**
- MUSS 1: Klartext, der mit `enc:v1:` beginnt (Freigabe-Nachricht, Datei in Versionsverlauf), führt zu dauerhaften Lesefehlern (Versionsabruf/Restore, GET /api/shares ganze Liste, öffentliche Share-Meta). Fix: Escape `enc:v1:p:<base64(klartext)>` bei Key-AUS-Schreiben; `decryptColumn` dekodiert es ohne Key; Migration prüft Werte mit Präfix per decryptColumn: COLUMN_FORMAT/COLUMN_DECRYPT → Klartext → neu verschlüsseln, `enc:v1:p:` → decodieren+verschlüsseln, COLUMN_KEY_UNKNOWN/NO_KEY → loggen, unverändert, als `unreadable` zählen; countColumns weist `unreadable` aus; Admin-UI zeigt failed/unreadable; Lesepfade fangen Fehler PRO ZEILE (Liste scheitert nie wegen einer Zeile).
- MUSS 2 (Tests): fail-closed 2FA (manipuliertes totp_secret → 500, KEINE Session, kein Bypass), `enc:v1:`-Klartext-Fälle, Migration mit paralleler Änderung (Fake-DB), file_versions size NULL Altzeilen, getAllSettings mit unlesbarem Secret, E16-Integration im normalen Stack.
- SOLLTE: 2FA-Fehlermeldung generisch (Details nur ins Log); Seeding-Warnung wenn process.env-Secret von DB abweicht (ohne Werte) + README-Hinweis; Doku: Ohne/mit falschem Master-Key sind TOTP-Nutzer ausgesperrt, Recovery per DB (`UPDATE users SET two_factor_totp=false, totp_secret=NULL ...`); `decSetting`: gezieltes Logging, KEIN stiller env-Fallback wenn die DB ein unlesbares Chiffrat enthält; countColumns 15 s cachen; `req.session.tempTotpSecret` bei aktivem Key verschlüsselt ablegen; Doku Kontextbindung ohne Zeilenbezug (Modell: DB-Leser); Hinweis P6: Rotation braucht Re-Wrap-Lauf.
- Offene Entscheidungen bereits getroffen: Seeding der Secrets aus process.env nur bei leerer DB (konsistent mit F3, kein Rückschreiben in .env); `file_versions.size` als neue Spalte (nötig für Listenanzeige ohne Entschlüsseln).

**Danach (alle noch offen, Issues lesen: `gh issue view <n>`, Konzept lesen):**
- P4 #36: verschlüsseltes Voll-Backup (CLI + Admin-UI + Zeitplan, Format `.mcbak`, scrypt, Konsistenz-Flag `backup_in_progress` = Hook in blob-outbox `isBlocked()`, pg_dump im Container: `postgresql15-client` im app/Dockerfile ergänzen). Berücksichtige `file_versions.size` und `pending_blob_deletes` im Schema.
- P5 #37: Restore-CLI (nur CLI, Zielinstanz muss leer sein, Kompatibilitätsprüfung, SHA-256-Prüfung, Recovery-Code-CLI `show-recovery`/Parse existiert als Funktion in crypto-store).
- P6 #38: Schlüsselrotation (`rewrapHeader`+`recoverRewrap` existieren; Spalten: eigener Re-Wrap-Lauf; KCV pro keyId).
- P7 #39: keine Klartext-Passwörter mehr (Docker-Secrets `_FILE`, `readSecret`, Reset-Tokens nur als Hash, `.env.example` ohne Passwörter, Tests S1–S4).
- Am Ende: README/Konzept aktualisieren, Minor-Bump 0.5.0 NUR nach Rückfrage bei Alex.

**Server-Hinweis:** Der Benutzer `vibe` ist inzwischen in der Gruppe `docker`, aber der laufende tmux-Server (Session `remote`) hat noch die alten Gruppen: in per `vibe pull` gestarteten Sessions ist Docker erst nutzbar, wenn der tmux-Server neu gestartet wurde (dabei stirbt die `remote`-Session: nur mit Alex' Okay). Alternativ Tests per frischem `ssh vibe-server` ausführen.
