# Handoff-Notizen

Jede Übergabe zwischen Rechnern hängt hier einen neuen Abschnitt an (nicht
überschreiben). Neueste Einträge stehen unten.

## Handover 2026-09-21 12:04 von laptop@Glurak

Mobile-UI-Fix: Ordner/Datei anlegen und Upload auf dem Handy. Bitte am Server weiterarbeiten.

## Handover 2026-09-21 12:12 von laptop@Glurak

STAND: Ursache gefunden und behoben (Commit 2e9372e, PR #24 offen, nicht gemergt, Version 0.4.29). Der versteckte Toast .notification (z-index 10040, nur opacity:0 + translateY) lag auf Phones unsichtbar ueber Tab-Bar und FAB und schluckte Taps. Fix: pointer-events:none im versteckten Zustand (app/public/styles.css). Lokal per Headless-Chrome nur bis zum Eingabedialog von 'Neuer Ordner' verifiziert. OFFEN fuer dich: (1) Upload- und 'Neue Datei'-Pfad der Mobile-UI (app/public/mobile-ui.js, FAB -> Bottom-Sheet) per Code-Review auf weitere Blocker pruefen: verstecktes file input, click()-Handler, capture-Attribut, weitere Overlays mit hohem z-index ohne pointer-events:none. (2) Andere versteckte Elemente mit opacity:0/visibility-Tricks suchen, die Taps abfangen koennten. (3) Gefundene Probleme in kleinem Commit auf diesem Branch fixen, PR #24 aktualisieren, Version ggf. +0.0.1. Nicht mergen. Hinweis: Kein Docker auf dem Server, nur node --check und Review. Echter Test (docker compose up --build, Handy) macht Alex nach vibe pull auf dem Laptop.

## 2026-10-01 – Rechnerwechsel (Laptop -> Server), manuell ausgelöst
Alle Agenten pausiert. Sicherheits-Welle 1+2 (#51-#55) und #47 sind gemergt, gepusht und geschlossen (Version 0.4.29).
Dieser Branch (fix/49-50-sso-users) enthält den **unfertigen, nicht verifizierten Zwischenstand** der SSO-Arbeit (#49/#50: app/sso-user.js, Settings-Button "Mit SSO verknüpfen", tests/sso-user.test.js). Der Agent wurde mitten in der Arbeit gestoppt: zuerst `node --check`, Tests, Diff prüfen, dann fertigstellen.
Danach offen: #40-Rest (generateUniqueName, Zyklenprüfung copy-multiple), #41, #42, #43, #44 (vermutlich durch #54 erledigt, nur verifizieren), #45, #46, #48. Workflow: je Issue Branch -> Review/Verifikation im Test-Stack -> ff-Merge -> `gh issue close <n> -c "Verifiziert im Test-Stack."`.
Test-Stack: `docker compose -p mycloudtest -f tests/docker-compose.test.yml up --build -d`; vor Testläufen `restart app` + 8 s warten; `node --test --test-concurrency=1 tests/*.test.js`.

**Update (2026-10-01, spaeter):** Alle dort genannten Issues (#40-#55) sind inzwischen erledigt, gemergt und geschlossen, `main` steht auf 0.4.30. Der SSO-Branch fix/49-50-sso-users ist fertig (PR #56 gemergt). Dieser Mobile-UI-Branch wurde mit `main` zusammengefuehrt (Konflikt nur in dieser Datei, Version auf 0.4.31 gehoben).
