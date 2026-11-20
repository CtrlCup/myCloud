#!/usr/bin/env bash
# Startet einen zweiten Compose-Stack (Projekt mycloudenc, Port 3098) mit aktivem Master-Key und
# MYCLOUD_TMP_DIR/tmpfs und lässt die GESAMTE Suite dagegen laufen (Parameter über tests/_env.js).
# Der Master-Key wird zur Laufzeit erzeugt (Temp-Verzeichnis, nach dem Lauf gelöscht) und nie ausgegeben.
# Übersprungen wird nur tests/crypto-boot.test.js: Es startet ohnehin eigene Stacks (mycloudcryptoboot) und
# ist unabhängig vom Ziel-Stack; der normale Lauf (run-all.sh) deckt es ab.
# Hinweis: Mit P2b schreiben alle Schreibpfade verschlüsselt; TEST_ENCRYPTED=1 aktiviert die Enc-Prüfungen der Suiten.
set -u
cd "$(dirname "$0")/.."
ENC_KEY_DIR=$(mktemp -d -t mycloud-enc-key.XXXXXX)
export ENC_KEY_DIR
export TEST_BASE=http://localhost:3098
export TEST_ENCRYPTED=1
export TEST_COMPOSE_PROJECT=mycloudenc
export TEST_COMPOSE_FILES="tests/docker-compose.test.yml tests/docker-compose.enc.override.yml"
COMPOSE="docker compose -p $TEST_COMPOSE_PROJECT -f tests/docker-compose.test.yml -f tests/docker-compose.enc.override.yml"
cleanup() { $COMPOSE down -v >/dev/null 2>&1; rm -rf "$ENC_KEY_DIR"; }
trap cleanup EXIT

node app/scripts/keys.js init --out "$ENC_KEY_DIR/master_key" >/dev/null || { echo "Key-Erzeugung fehlgeschlagen"; exit 1; }
$COMPOSE up --build -d || { echo "Stack-Start fehlgeschlagen"; exit 1; }

fail=0
for f in tests/*.test.js; do
  case "$f" in tests/crypto-boot.test.js) echo "== $f (übersprungen: eigener Stack)"; continue;; esac
  $COMPOSE restart app >/dev/null 2>&1
  up=0
  for _ in $(seq 1 60); do curl -sf -o /dev/null "$TEST_BASE/api/auth/status" && { up=1; break; }; sleep 1; done
  [ "$up" -eq 1 ] || { echo "App im Enc-Stack nicht erreichbar"; $COMPOSE logs app | tail -20; fail=1; break; }
  echo "== $f"
  out=$(node --test "$f" 2>&1); status=$?
  echo "$out" | grep -E "^ℹ (tests|pass|fail|skipped)|^✖" || true
  [ "$status" -eq 0 ] || fail=1
done
exit $fail
