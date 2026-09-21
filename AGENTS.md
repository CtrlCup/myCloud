# Agenten-Workflow: Server / Ubuntu-Laptop / Windows-Tower

Dieses Projekt wird auf mehreren Rechnern gleichzeitig bearbeitet, jeweils mit
eigenen Agenten-Sessions in eigenen Git-Worktrees. Das `vibe`-Tool (separates
Repo, auf allen Rechnern installiert) verwaltet Branches, Worktrees und die
Übergabe zwischen den Rechnern.

## Woran erkenne ich, auf welchem Rechner ich gerade laufe?

Lies `~/.vibe/config`. Das Feld `ROLE` ist eines von:

- `server` — Linux-Server, läuft dauerhaft, ist per SSH von den anderen
  Rechnern erreichbar. Sessions laufen hier in `tmux`, damit sie einen
  Verbindungsabbruch überstehen.
- `laptop` — Ubuntu-Laptop, mobil, nicht immer erreichbar.
- `pc` — Windows-Tower (via WSL2), stationär, für lokale End-to-End-Tests
  (z. B. wenn die App nur unter Windows getestet werden kann).

## Übergabe an einen anderen Rechner ("Handover")

Wenn der Nutzer sagt "mach eine Übergabe", "handover" o. ä., oder wenn der
Slash-Command `/handover` aufgerufen wird:

**Wichtig:** `vibe handover` wirkt auf **alle** gerade aktiven Agenten-Sessions
in diesem Projekt, nicht nur auf dich — parallel laufende Agenten anderer
Aufgaben im selben Projekt werden automatisch mit übergeben.

1. Eigene offene Änderungen selbst committen (aussagekräftige Message, du
   kennst den Kontext besser als ein generischer Commit-Text). Andere aktive
   Worktrees committet das Script selbst mit einer generischen Message.
2. Eine kurze, allgemeine Notiz für den Rechnerwechsel formulieren (gilt für
   alle mit übergebenen Branches, nicht nur deine eigene Aufgabe).
3. `vibe handover "<Notiz aus Schritt 2>"` ausführen (kein Branch-Argument
   mehr nötig). Das Script pusht automatisch jeden aktiven Branch im
   Projekt, legt/aktualisiert Pull Requests an, hängt die Notiz an
   `.vibe/handoff.md` jedes Branches an — und läuft gerade nicht auf dem
   Server, löst es automatisch die Übergabe an den Server per SSH aus (inkl.
   Erst-Klonen des Projekts dort, falls nötig) und öffnet dort alle
   übergebenen Sessions wieder. Du musst diese Schritte nicht selbst
   manuell nachbauen, das Script übernimmt sie deterministisch.
4. Die Ausgabe des Scripts an den Nutzer weitergeben (insbesondere ob die
   Übergabe automatisch an den Server ging oder manuell auf einem anderen
   Rechner mit `vibe pull <branch>` fortgesetzt werden muss).

## Wenn deine Aufgabe abgeschlossen ist

Führe `vibe done <dein-branch>` aus. Es versucht selbst, den PR automatisch
zu mergen (`gh pr merge --squash --delete-branch`):

- **Klappt der Merge**: Session/Worktree/lokaler Branch werden aufgeräumt,
  und die Docker-Dev-Umgebung des Projekts wird automatisch heruntergefahren,
  falls kein anderer Agent mehr aktiv ist (dieser Server ist eine
  Entwicklungsumgebung, keine Hosting-Plattform — nichts soll unnötig im
  Idle mitlaufen).
- **Klappt der Merge nicht** (Konflikte, kein PR vorhanden, offene Checks):
  `vibe done` startet dich (oder eine neue Session) genau in diesem
  Worktree mit dem Auftrag, main reinzubringen, Konflikte zu lösen, zu
  pushen und den Merge abzuschließen. Falls du dabei — z. B. weil
  Checks/CI fehlschlagen oder eine inhaltliche Entscheidung nötig ist — nicht
  automatisiert weiterkommst: mach eine reguläre Übergabe mit einer klaren
  Notiz statt endlos zu versuchen.

## Wenn eine `.vibe/handoff.md`-Datei im Worktree existiert

Beim Start einer neuen Session in einem übernommenen Branch: Lies zuerst die
Notiz(en) in `.vibe/handoff.md`, bevor du weiterarbeitest. Sie beschreiben den
Stand und was als Nächstes zu tun ist.

## Plattform-spezifisches Testen

Trage hier projekt-spezifisch ein, was nur auf welchem Rechner getestet werden
kann (Beispiel):

- Windows-spezifische UI/Installer-Tests → nur auf `pc` (Windows-Tower)
- Alles andere (Build, Unit-Tests, Linter) → überall möglich

Wenn eine Aufgabe eine Plattform braucht, die du gerade nicht hast, mach eine
Übergabe mit einer klaren Notiz, was genau getestet werden muss.
