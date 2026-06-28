# myCloud

Eine moderne, schlichte und sichere Cloud-Lösung, die über Docker Compose orchestriert wird.

## Features
- **Modernes 2-Farben-UI**: Vollständig minimalistisch gestaltet, alle Farben sind in einer einzigen `styles.css` hinterlegt.
- **Sichere Authentifizierung**:
  - Benutzername / Passwort
  - Passkeys (WebAuthn)
  - SSO-Integration (wie Authentik)
- **Ordner- und Dateifreigabe**: Granulare Berechtigungen für geteilte Links (Lesen, Schreiben/Upload, Download, ZIP-Download) und anpassbare URLs.
- **Admin-Konsole**: Registrierung aktivieren/deaktivieren, SMTP-Konfiguration für E-Mail-Dienste, SSO-Konfiguration und Benutzerverwaltung.
- **Dockerized**: Läuft vollständig containerisiert mit PostgreSQL als Datenbank.

## Voraussetzungen
- Docker und Docker Compose
- Node.js (für lokale Entwicklung außerhalb von Docker)

## Installation & Start
1. Kopiere die Datei `.env.example` nach `.env` und passe die Werte an.
2. Starte die Container mit:
   ```bash
   docker compose up --build
   ```
3. Öffne `http://localhost:3000` im Browser.
