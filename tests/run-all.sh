#!/usr/bin/env bash
# Führt jede Testdatei einzeln aus und startet vorher den App-Container neu: Das Registrierungs-Limit
# (5 pro Stunde und App-Prozess, im Speicher) würde sonst nach wenigen Suiten 429 liefern.
# Voraussetzung: Test-Stack läuft (docker compose -p mycloudtest -f tests/docker-compose.test.yml up --build -d)
set -u
cd "$(dirname "$0")/.."
COMPOSE="docker compose -p mycloudtest -f tests/docker-compose.test.yml"
fail=0
for f in tests/*.test.js; do
  $COMPOSE restart app >/dev/null 2>&1
  for _ in $(seq 1 30); do curl -sf -o /dev/null http://localhost:3099/api/auth/status && break; sleep 1; done
  echo "== $f"
  out=$(node --test "$f" 2>&1); status=$?
  echo "$out" | grep -E "^ℹ (tests|pass|fail|skipped)|^✖" || true
  [ "$status" -eq 0 ] || fail=1
done
exit $fail
