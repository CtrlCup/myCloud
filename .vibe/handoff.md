# Handoff-Notizen

Jede Übergabe zwischen Rechnern hängt hier einen neuen Abschnitt an (nicht
überschreiben). Neueste Einträge stehen unten.

## 2026-10-01 – Rechnerwechsel (Laptop -> Server), manuell ausgelöst
Alle Agenten pausiert. Sicherheits-Welle 1+2 (#51-#55) und #47 sind gemergt, gepusht und geschlossen (Version 0.4.29).
Dieser Branch (fix/49-50-sso-users) enthält den **unfertigen, nicht verifizierten Zwischenstand** der SSO-Arbeit (#49/#50: app/sso-user.js, Settings-Button "Mit SSO verknüpfen", tests/sso-user.test.js). Der Agent wurde mitten in der Arbeit gestoppt: zuerst `node --check`, Tests, Diff prüfen, dann fertigstellen.
Danach offen: #40-Rest (generateUniqueName, Zyklenprüfung copy-multiple), #41, #42, #43, #44 (vermutlich durch #54 erledigt, nur verifizieren), #45, #46, #48. Workflow: je Issue Branch -> Review/Verifikation im Test-Stack -> ff-Merge -> `gh issue close <n> -c "Verifiziert im Test-Stack."`.
Test-Stack: `docker compose -p mycloudtest -f tests/docker-compose.test.yml up --build -d`; vor Testläufen `restart app` + 8 s warten; `node --test --test-concurrency=1 tests/*.test.js`.
