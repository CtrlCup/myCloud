# Handoff-Notizen

Jede Übergabe zwischen Rechnern hängt hier einen neuen Abschnitt an (nicht
überschreiben). Neueste Einträge stehen unten. Ältere Einträge (bis 2026-10-04)
sind erledigt und nur noch in der Git-Historie dieser Datei zu finden.

## Stand 2026-11-22 (aufgeräumt)
Keine laufende Arbeit, `main` = 0.5.0. P1 bis P3 (#33 bis #35) sind gemergt und geschlossen.

**Offene Issues:** #36 bis #39 (P4 bis P7, sequenziell, je Phase erst nach Planfreigabe durch Alex), #49/#50 (gefixt, bleiben bis zum manuellen Authentik-Test offen, nicht automatisch schließen), #57 (Designfrage SSO-Verknüpfung, Entscheidung bei Alex), #23, #32, #59.

**Rahmen Verschlüsselung/Backup:** Konzept `docs/Verschluesselung-und-Backup.md`. Je Phase ein Branch, danach unabhängige Reviews (`crypto`, `reviewer`, `scope-guard`, `regression-guard`), vor Push `release-guard`. Erst nach grünem Test und Review mergen, pushen, Issue schließen. Keine Klartext-Secrets einführen.

**Test-Workflow:** `./tests/run-all.sh` (Port 3099, Projekt mycloudtest, Stack vorher selbst starten: `docker compose -p mycloudtest -f tests/docker-compose.test.yml up --build -d`), danach `./tests/run-all-enc.sh` (Port 3098, Projekt mycloudenc, fährt seinen Stack selbst). Nie zwei Läufe parallel, während eines Laufs keine Dateien ändern (Stacks werden aus dem Arbeitsverzeichnis gebaut). Läufe dauern etwa 10 Minuten.

**Umsetzungshinweise P4 bis P7:**
- P4 #36: verschlüsseltes Voll-Backup (CLI + Admin-UI + Zeitplan, Format `.mcbak`, scrypt, Konsistenz-Flag `backup_in_progress` = Hook in blob-outbox `isBlocked()`, pg_dump im Container: `postgresql15-client` im app/Dockerfile ergänzen). `file_versions.size` und `pending_blob_deletes` im Schema berücksichtigen.
- P5 #37: Restore-CLI (nur CLI, Zielinstanz muss leer sein, Kompatibilitätsprüfung, SHA-256-Prüfung, Recovery-Code-CLI `show-recovery`, Parse existiert als Funktion in crypto-store).
- P6 #38: Schlüsselrotation (`rewrapHeader` + `recoverRewrap` existieren; Spalten brauchen einen eigenen Re-Wrap-Lauf; KCV pro keyId).
- P7 #39: keine Klartext-Passwörter mehr (Docker-Secrets `_FILE`, `readSecret`, Reset-Tokens nur als Hash, `.env.example` ohne Passwörter, Tests S1 bis S4).

**Server-Hinweis:** Der Benutzer `vibe` ist in der Gruppe `docker`, aber ein alter tmux-Server hat eventuell noch die alten Gruppen: Docker ist in per `vibe pull` gestarteten Sessions dann erst nach Neustart des tmux-Servers nutzbar (nur mit Alex' Okay). Alternativ Tests per frischem `ssh vibe-server` ausführen.
