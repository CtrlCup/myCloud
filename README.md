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
- **Versionserkennung**: Die Admin-Konsole zeigt die aktuell laufende Version (Git-Commit) an und warnt beim Start (Log + Banner), falls sich `.env` oder `docker-compose.yml` seit dem letzten Start geändert haben oder nicht mehr zur laufenden Software-Version passen.
- **Dockerized**: Läuft vollständig containerisiert mit PostgreSQL als Datenbank.

## Voraussetzungen
- Docker und Docker Compose
- Node.js (für lokale Entwicklung außerhalb von Docker)
- Für die Versionserkennung: das Repository per `git clone` ausgecheckt haben (nicht als ZIP heruntergeladen) — `docker-compose.yml` mountet das lokale `.git`-Verzeichnis read-only in den Container.

## Installation & Start
1. Kopiere die Datei `.env.example` nach `.env` und passe die Werte an.
2. Starte die Container mit:
   ```bash
   docker compose up --build
   ```
3. Öffne `http://localhost:3030` (oder den konfigurierten Port) im Browser.

## Umgebungsvariablen (Configuration Variables)

Die folgenden Variablen können in der `.env`-Datei definiert werden:

### Standardkonfigurationen (Empfohlen)
- `PORT`: Der Port, auf dem die App gehostet wird (Standard: `3030`).
- `APP_URL`: Die öffentliche URL der myCloud-Instanz (Standard: `http://localhost:3030`).
- `SESSION_SECRET`: Ein zufälliger, sicherer String zur Absicherung von Sessions.
- `DB_USER` / `DB_PASSWORD` / `DB_NAME`: PostgreSQL Zugangsdaten.

### Mailserver / SMTP (Optional)
- `EMAIL_SMTP_HOST`: Hostname des SMTP-Servers (z. B. `smtp.gmail.com`).
- `EMAIL_SMTP_PORT`: SMTP-Port (z. B. `587` oder `465`).
- `EMAIL_SMTP_USER`: SMTP-Benutzername.
- `EMAIL_SMTP_PASS`: SMTP-Passwort.
- `EMAIL_FROM`: Absender-Adresse (Standard: `noreply@mycloud.local`).

### SSO / OIDC (Optional)
- `SSO_ENABLED`: SSO Login aktivieren (`true` / `false`).
- `SSO_CLIENT_ID`: Client ID deines OIDC-Providers (z. B. Authentik).
- `SSO_CLIENT_SECRET`: Client Secret deines OIDC-Providers.
- `SSO_ISSUER_URL`: Issuer-URL des Providers.
- `SSO_REDIRECT_URI`: Weiterleitungs-URI (Standard: `http://localhost:3030/auth/sso/callback`).

### Sicherheit & System (Optional)
- `REGISTRATION_ENABLED`: Registrierung neuer Benutzer über die Anmeldeseite erlauben (`true` / `false`, Standard: `true`).

> [!NOTE]
> **Synchronisierung:** Wird eine optionale Variable nicht gesetzt, lässt sich die entsprechende Funktion bequem über die Weboberfläche in den **Admin-Einstellungen** konfigurieren.
> Nimmst du Änderungen in den Admin-Einstellungen der Weboberfläche vor, werden diese Werte **automatisch** zurück in die `.env`-Datei geschrieben.

