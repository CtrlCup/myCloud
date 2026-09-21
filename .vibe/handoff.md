# Handoff-Notizen

Jede Übergabe zwischen Rechnern hängt hier einen neuen Abschnitt an (nicht
überschreiben). Neueste Einträge stehen unten.
## Handover 2026-09-21 12:04 von laptop@Glurak

Mobile-UI-Fix: Ordner/Datei anlegen und Upload auf dem Handy. Bitte am Server weiterarbeiten.

## Handover 2026-09-21 12:12 von laptop@Glurak

STAND: Ursache gefunden und behoben (Commit 2e9372e, PR #24 offen, nicht gemergt, Version 0.4.29). Der versteckte Toast .notification (z-index 10040, nur opacity:0 + translateY) lag auf Phones unsichtbar ueber Tab-Bar und FAB und schluckte Taps. Fix: pointer-events:none im versteckten Zustand (app/public/styles.css). Lokal per Headless-Chrome nur bis zum Eingabedialog von 'Neuer Ordner' verifiziert. OFFEN fuer dich: (1) Upload- und 'Neue Datei'-Pfad der Mobile-UI (app/public/mobile-ui.js, FAB -> Bottom-Sheet) per Code-Review auf weitere Blocker pruefen: verstecktes file input, click()-Handler, capture-Attribut, weitere Overlays mit hohem z-index ohne pointer-events:none. (2) Andere versteckte Elemente mit opacity:0/visibility-Tricks suchen, die Taps abfangen koennten. (3) Gefundene Probleme in kleinem Commit auf diesem Branch fixen, PR #24 aktualisieren, Version ggf. +0.0.1. Nicht mergen. Hinweis: Kein Docker auf dem Server, nur node --check und Review. Echter Test (docker compose up --build, Handy) macht Alex nach vibe pull auf dem Laptop.

