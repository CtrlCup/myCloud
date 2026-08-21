# myCloud per KI bedienen und personalisieren

Diese Anleitung beschreibt, wie ein KI-Assistent (z. B. Claude, ChatGPT mit Tools, ein eigenes
Skript/Agenten-Framework) über die REST-API vollständig anstelle eines Benutzers agieren kann —
inklusive aller Admin-Funktionen, falls dieser Benutzer Admin ist. Ziel ist es, die eigene
myCloud-Instanz per KI einzurichten, zu personalisieren (Branding, Rollen, SMTP, Benutzerverwaltung
…) oder im Alltag zu bedienen (Dateien verwalten, Freigaben erstellen …), ohne dass die KI eigene,
gesondert eingeschränkte Zugänge bräuchte.

> Kurzfassung: **Ein API-Key = exakt die Rechte des Benutzers, der ihn erstellt hat.** Es gibt kein
> separates Berechtigungsmodell für Keys. Erstellt ein Admin einen Key, kann jeder Client, der
> diesen Key kennt (also auch eine KI), alles tun, was der Admin im Browser auch könnte.

## Wie es funktioniert

myCloud hat **keine separate "App-API"** — die REST-API unter `/api/...` ist exakt dieselbe API,
die auch das Web-Frontend (`app.js`) nutzt. Es gibt zwei gleichwertige, parallel funktionierende
Auth-Methoden:

1. **Session-Cookie** — wie im Browser, gesetzt durch `POST /api/auth/login`.
2. **API-Key (Bearer-Token)** — gedacht genau für diesen Anwendungsfall: externe Clients wie
   Skripte, Apps oder eben KI-Agenten.

Für jeden Request mit einem gültigen `Authorization: Bearer mcld_...`-Header lädt eine Middleware
(`app/server.js`, kurz vor der Swagger-UI-Registrierung) den zugehörigen Benutzer aus der
Datenbank und befüllt `req.session.userId` / `.username` / `.role` — **identisch zu dem, was bei
einem Cookie-Login passieren würde.** Jede bestehende Route liest ausschließlich diese drei
Session-Felder, um zu entscheiden, wer der Aufrufer ist und was er darf. Dadurch funktioniert die
komplette API — inklusive aller `requireAdmin`-geschützten Admin-Routen — automatisch auch für
Token-authentifizierte Clients, ohne dass pro Route etwas Zusätzliches eingebaut werden musste.

Das bedeutet konkret:

- Ist der Ersteller des Keys ein normaler Benutzer, kann die KI über den Key alles tun, was dieser
  Benutzer im Web-UI auch tun kann (Dateien hoch-/herunterladen, verschieben, löschen, Freigaben
  erstellen, eigene Profileinstellungen ändern, eigene Passkeys/2FA verwalten, eigene weitere
  API-Keys erzeugen/widerrufen, …).
- Ist der Ersteller **Admin** (Rolle `admin` oder eine Rolle mit der Berechtigung `admin: true`),
  kann die KI zusätzlich alle `/api/settings/admin/...`-Endpunkte nutzen: Branding (Name, Farben,
  Icon, Hintergründe), SEO-Einstellungen, SMTP-Konfiguration inkl. Testversand, Benutzerverwaltung
  (anlegen, Rolle ändern, deaktivieren, Kontingent setzen), Rollen-/Berechtigungsverwaltung.
- Es gibt **keine Möglichkeit, einen Key auf einen Teilbereich einzuschränken** (kein Scoping nach
  Lese-/Schreibrecht, keine Endpunkt-Whitelist). Ein Key ist ein vollwertiger Zweitzugang zum
  jeweiligen Konto.

## API-Key erzeugen

1. Im Web-UI einloggen → **Einstellungen → API-Keys**.
2. **Neuer API-Key**, einen sprechenden Namen vergeben (z. B. `Claude Code Assistent`,
   `Automatisierung Backups`) — der Name dient nur der eigenen Übersicht.
3. Der vollständige Key (Format `mcld_<48 Hex-Zeichen>`) wird **einmalig im Klartext angezeigt**.
   Danach ist nur noch ein Präfix sichtbar; der Key kann nicht erneut angezeigt werden, nur
   widerrufen und neu erzeugt.
4. Diesen Key sicher an den KI-Agenten übergeben (siehe unten) — genauso vertraulich behandeln wie
   ein Passwort.

Äquivalent per API (z. B. wenn die KI sich selbst einen Folge-Key anlegen soll):

```bash
curl -X POST https://<deine-domain>/api/settings/api-keys \
  -H "Authorization: Bearer mcld_DEIN_BESTEHENDER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Claude Code Assistent"}'
```

Widerrufen (z. B. wenn der Zugriff der KI wieder entzogen werden soll):

```bash
curl -X DELETE https://<deine-domain>/api/settings/api-keys/<key-id> \
  -H "Authorization: Bearer mcld_DEIN_BESTEHENDER_KEY"
```

`GET /api/settings/api-keys` listet alle eigenen Keys (Name, Präfix, Erstellungsdatum,
`last_used_at`) — praktisch, um zu prüfen, ob ein an eine KI übergebener Key tatsächlich benutzt
wird oder um ungenutzte/verdächtige Keys zu identifizieren.

## Die KI an die API anbinden

Jeder Request der KI trägt einfach den Header `Authorization: Bearer mcld_...`. Beispiel — eigenes
Profil abfragen:

```bash
curl https://<deine-domain>/api/auth/status \
  -H "Authorization: Bearer mcld_DEIN_KEY"
```

Beispiel — als Admin einen neuen Benutzer anlegen:

```bash
curl -X POST https://<deine-domain>/api/settings/admin/users \
  -H "Authorization: Bearer mcld_DEIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"username": "neuer.nutzer", "password": "...", "role": "user"}'
```

Beispiel — Branding anpassen (Cloud-Name ändern):

```bash
curl -X POST https://<deine-domain>/api/settings/admin/config \
  -H "Authorization: Bearer mcld_DEIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"cloud_name": "Meine Cloud"}'
```

Damit eine KI **alle** Endpunkte kennt (nicht nur die hier beispielhaft genannten), gibt es zwei
maschinenlesbare Quellen, die sich beide direkt an einen KI-Agenten übergeben lassen:

- **`GET /api/docs/openapi.json`** — die vollständige OpenAPI-3.0-Spezifikation (auch als Datei im
  Repo unter [`app/openapi.yaml`](../app/openapi.yaml)). Ein Agent mit Werkzeug-Unterstützung
  (z. B. Claude mit einem HTTP-/OpenAPI-Tool, ein "GPT Action", ein selbstgebauter Agent) kann
  diese Spec einlesen und kennt danach jeden Endpunkt, jedes Schema und welche Endpunkte
  Admin-Rechte voraussetzen (Tag `Admin`).
- **`/api/docs`** — interaktive Swagger-UI über dieselbe Spezifikation, zum manuellen Ausprobieren
  im Browser (z. B. um vorab zu prüfen, was eine KI mit dem Key alles könnte).

Typischer Aufbau für einen KI-Agenten (z. B. Claude Code, ein Custom-GPT oder ein eigenes Skript):

1. Dem Agenten die Basis-URL der eigenen Instanz und den API-Key als Umgebungsvariable/Secret
   geben (nicht im Klartext in Prompts oder Chatverläufen).
2. Dem Agenten `app/openapi.yaml` bzw. `/api/docs/openapi.json` als Referenz geben, damit er
   Endpunkte, Parameter und Antwortformate kennt, statt zu raten.
3. Den Agenten anweisen, jeden Request mit `Authorization: Bearer <key>` zu senden.

Damit kann die KI eigenständig z. B. die komplette Ersteinrichtung übernehmen (Branding, SMTP,
Rollen/Benutzer anlegen), im laufenden Betrieb Dateien organisieren oder Freigaben verwalten — auf
Zuruf, ohne dass für jede einzelne Aktion ein Mensch im Web-UI klicken muss.

## API-Zugriff instanzweit deaktivieren

Für den Fall, dass API-Keys (und damit der KI-Zugriff) vorübergehend oder dauerhaft komplett
unterbunden werden sollen — z. B. während einer Sicherheitsprüfung oder wenn kein Client diesen
Weg mehr nutzen soll — gibt es einen globalen Schalter, unabhängig von einzelnen Keys:

**Einstellungen → Admin → Registrierung & SSO → „API-Zugriff (Apps & KI-Agenten)“ →
„API-Key-Authentifizierung erlauben“.**

- Ist der Schalter **aus**, wird jeder Request mit einem `Authorization: Bearer mcld_...`-Header
  serverseitig wie unauthentifiziert behandelt — unabhängig davon, ob der jeweilige Key gültig
  wäre. Geschützte Endpunkte antworten dann mit `401`/`403`, exakt wie ohne jede Anmeldung.
  Session-Cookie-Logins (der normale Browser-Login) sind davon **nicht** betroffen.
- Die Umschaltung wirkt **sofort** beim nächsten Request, kein Neustart nötig — die Middleware
  prüft die Einstellung live bei jedem Request mit Bearer-Token.
- **Bestehende Keys werden dabei nicht gelöscht.** Nach erneutem Aktivieren funktionieren alle
  zuvor erzeugten Keys unverändert weiter, ohne dass sie neu erzeugt werden müssten.
- Äquivalent per API (setzt einen bestehenden Admin-Zugang mit Session-Cookie oder — solange der
  Schalter noch an ist — mit API-Key voraus):

  ```bash
  curl -X POST https://<deine-domain>/api/settings/admin/config \
    -H "Authorization: Bearer mcld_DEIN_ADMIN_KEY" \
    -H "Content-Type: application/json" \
    -d '{"api_key_auth_enabled": "false"}'
  ```

## Sicherheitshinweise

- **Ein Key ist ein Passwort-Äquivalent.** Wer ihn kennt, kann alles tun, was der erstellende
  Benutzer kann — bei einem Admin-Key also auch die gesamte Instanz umkonfigurieren, Benutzer
  anlegen/löschen und E-Mail-Versand (SMTP) missbrauchen.
- Für eine KI möglichst **keinen bestehenden Admin-Hauptzugang** verwenden, sondern einen
  **eigenen, klar benannten Key** erzeugen (siehe oben) — so lässt er sich gezielt widerrufen
  (`DELETE /api/settings/api-keys/:id`), ohne die eigene Sitzung oder andere Keys zu betreffen.
- `last_used_at` regelmäßig in **Einstellungen → API-Keys** prüfen; ein Key, der seit der
  KI-Anbindung nicht mehr benutzt wurde, kann bedenkenlos widerrufen werden.
- Die API sollte, wie das Web-UI auch, nur über **HTTPS** erreichbar sein (siehe
  [`Caddyfile.example`](../Caddyfile.example)) — der Bearer-Token wird sonst im Klartext übertragen.
- Es gibt aktuell **kein Rate-Limiting** auf API-Key-Requests. Ein fehlerhaft konfigurierter oder
  kompromittierter Agent könnte die Instanz daher mit Requests überlasten — bei Auffälligkeiten den
  betroffenen Key sofort widerrufen.
- Möchte man mehreren Zwecken (z. B. Backup-Skript und KI-Assistent) getrennte, einzeln widerrufbare
  Zugänge geben, für jeden Zweck einen **eigenen** Key erzeugen statt einen Key mehrfach zu
  verwenden.
- Bei akutem Verdacht (z. B. ein Key ist geleakt und die Quelle ist unklar) den globalen Schalter
  aus dem vorigen Abschnitt nutzen, um API-Key-Zugriff instanzweit sofort zu unterbinden, statt erst
  jeden einzelnen Key einzeln suchen und widerrufen zu müssen.

## Verwandte Dokumentation

- [`app/openapi.yaml`](../app/openapi.yaml) — vollständige API-Referenz (auch über `/api/docs`
  erreichbar).
- [`README.md`](../README.md) — Gesamtüberblick über Features, Architektur und Konfiguration.
