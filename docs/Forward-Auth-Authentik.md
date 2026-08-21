# Forward-Auth: automatischer Login über Authentik hinter Caddy

Diese Funktion loggt Nutzer automatisch in myCloud ein, wenn ihr Request bereits durch Authentiks
**Forward-Auth-Gate** eines vorgeschalteten Reverse-Proxys (z. B. Caddy) gelaufen ist — ohne das
myCloud-Login-Formular zu zeigen. Sie ist ein **anderer Mechanismus als die reguläre SSO/OIDC-
Anmeldung** (`Einstellungen → Admin → Registrierung & SSO → SSO / Authentik Integration`), die per
Redirect-Flow funktioniert und weiterhin unabhängig davon nutzbar bleibt.

## Sicherheitsmodell — warum nicht einfach den Headern vertrauen

Authentiks Forward-Auth hängt an jeden durchgelassenen Request mehrere Header an, u. a.:

- `X-Authentik-Username`, `X-Authentik-Email`, `X-Authentik-Name` — **Klartext**, von Authentik
  gesetzt, aber für die App selbst nicht überprüfbar.
- `X-Authentik-Jwt` — ein von Authentik **signiertes** JWT mit denselben (und weiteren) Claims.
- `X-Authentik-Meta-Jwks` — die URL zum JWKS-Endpoint des Outposts, über den sich die Signatur
  verifizieren lässt.

Nur die ersten drei Header direkt zu vertrauen, war die Schwachstelle hinter **CVE-2026-25748**:
Jeder Client, der die App-Instanz direkt erreichen kann (Proxy umgangen, Fehlkonfiguration,
kompromittierter Zwischenschritt), kann beliebige Header selbst setzen — inklusive
`X-Authentik-Username: admin`.

**myCloud verifiziert deshalb ausschließlich das JWT aus `X-Authentik-Jwt`:**

1. Signatur gegen den öffentlichen Schlüssel aus dem JWKS-Endpoint prüfen.
2. Ablaufzeit (`exp`), Aussteller (`iss`) und Audience/Client-ID (`aud`) gegen die in den
   Admin-Einstellungen konfigurierten Werte prüfen.
3. Nur bei gültiger Signatur werden Username/Email aus den **verifizierten JWT-Claims**
   ausgelesen (nicht aus den Klartext-Headern) und ein lokaler Nutzer gefunden/angelegt.
4. Fehlt der Header, ist er ungültig, abgelaufen oder passt Aussteller/Audience nicht — es gibt
   **keinen Fallback** auf die Klartext-Header. Es wird ganz normal das reguläre Login gezeigt.

Zusätzlich prüft myCloud, dass die JWKS-URL aus `X-Authentik-Meta-Jwks` auf **denselben Host** wie
der konfigurierte Aussteller zeigt und HTTPS verwendet — sonst könnte ein Angreifer, der die App
direkt erreicht, die JWKS-URL auf einen eigenen Schlüssel-Server umbiegen und sich damit ein
"gültiges" JWT selbst signieren. Public Keys werden pro JWKS-URL gecacht (nicht bei jedem Request
neu abgerufen).

## Voraussetzung: die App darf NICHT direkt erreichbar sein

Diese ganze Prüfung nützt nichts, wenn Angreifer die myCloud-Instanz **unter Umgehung von
Caddy/Authentik** direkt ansprechen können — dann könnten sie zwar keine gültige Signatur fälschen,
aber die Forward-Auth-Header schlicht weglassen und stattdessen versuchen, sich ganz regulär
einzuloggen oder andere Schwachstellen auszunutzen, während der Admin denkt, der Zugriff liefe
ausschließlich über Authentik.

In `docker-compose.yml` ist standardmäßig der `ports`-Block aktiv, der den App-Port direkt auf den
Host mappt:

```yaml
    ports:
      - "${PORT:-3000}:3000"
    # expose:
    #   - "3000"
```

**Vor dem Aktivieren von Forward-Auth:** `ports` auskommentieren und stattdessen den `expose`-Block
aktivieren, damit die App nur noch innerhalb des Docker-Netzwerks (`mycloud_network`) erreichbar
ist und Caddy als einziger Weg von außen bleibt (siehe [`Caddyfile.example`](../Caddyfile.example)
für das Netzwerk-Setup zwischen Caddy und `app:3000`).

## Caddy-Konfiguration (Beispiel)

Beispielhafter Ausschnitt für eine Domain hinter Authentiks Forward-Auth (Proxy-Provider/Outpost).
Exakte Pfade/Direktiven können je nach Authentik- und Caddy-Version abweichen — maßgeblich ist
Authentiks eigene Dokumentation zur Caddy-Forward-Auth-Integration:

```
mycloud.company.local {
	forward_auth outpost.company.local:9000 {
		uri /outpost.goauthentik.io/auth/caddy
		copy_headers X-Authentik-Username X-Authentik-Groups X-Authentik-Email X-Authentik-Name X-Authentik-Uid X-Authentik-Jwt X-Authentik-Meta-Jwks X-Authentik-Meta-Outpost X-Authentik-Meta-Provider X-Authentik-Meta-App X-Authentik-Meta-Version

		# Nicht angemeldete Besucher zum Authentik-Login schicken statt einen nackten 401 zu zeigen
		handle_response {
			@error status 401
			redir @error https://outpost.company.local/outpost.goauthentik.io/start?rd={uri} 302
		}
	}

	reverse_proxy app:3000
}
```

## Admin-Einstellungen

**Einstellungen → Admin → Registrierung & SSO → Forward-Auth (Authentik hinter Reverse-Proxy):**

| Feld | Bedeutung |
|---|---|
| Automatischer Login per Forward-Auth-Header | Instanzweiter Schalter, Standard: aus |
| Erwarteter Aussteller (iss) | Muss exakt dem `iss`-Claim in Authentiks JWT entsprechen und eine HTTPS-URL sein — legt außerdem den erlaubten JWKS-Host fest |
| Erwartete Audience / Client-ID (aud) | Muss dem `aud`-Claim entsprechen (Client-ID des Proxy-Providers/Outposts, nicht zwingend identisch mit der Client-ID der regulären SSO-Anmeldung) |

Der Schalter lässt sich erst aktivieren, wenn beide Felder gesetzt sind — ohne sie könnte die
Prüfung nicht wissen, gegen welchen Aussteller/welche Audience sie überhaupt validieren soll.

## Verhalten bei bestehenden Sitzungen

Ist bereits eine myCloud-Session aktiv (Cookie-Login oder vorheriger Forward-Auth-Login), wird das
JWT bei jedem weiteren Request **nicht erneut geprüft** — genau wie beim bestehenden
API-Key-Mechanismus greift die Verifizierung nur, solange noch keine Session existiert. Ein Wechsel
des Authentik-Nutzers am Proxy führt also nicht automatisch zu einem Nutzerwechsel in einer bereits
laufenden myCloud-Session; dafür müsste zuerst regulär abgemeldet werden.

## Hinweis: gleicher Nutzer wie bei regulärer SSO-Anmeldung

Forward-Auth und die reguläre SSO/OIDC-Anmeldung verknüpfen einen Authentik-Nutzer über denselben
`sub`-Claim mit demselben lokalen myCloud-Konto (`sso_provider = 'authentik'`). Das funktioniert
nur zuverlässig, wenn Authentiks **Subject Mode** für den Proxy-Provider (Forward-Auth-Outpost) und
den regulären OIDC-Provider identisch konfiguriert ist (z. B. beide auf "Based on the User's UUID"
oder beide auf "Based on the User's ID") — unterscheiden sich die Subject Modes, erzeugt Forward-
Auth ein zweites, separates myCloud-Konto für denselben Menschen.

## Öffentliche Freigabe-Links (`/s/...`)

Bleiben vollständig unangetastet — diese laufen bewusst ohne Authentik/Login und werden von dieser
Middleware nicht berührt (sie greift ohnehin nur, solange noch kein `req.session.userId` gesetzt
ist, und Freigabe-Links prüfen ihre eigene Berechtigung unabhängig von Benutzer-Sessions).
