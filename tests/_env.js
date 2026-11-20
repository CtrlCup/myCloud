'use strict';
// Gemeinsame Parameter der Stack-Tests (Standard: normaler Test-Stack, siehe run-all.sh). Der verschlüsselte
// Stack (run-all-enc.sh) setzt TEST_BASE, TEST_COMPOSE_PROJECT und TEST_COMPOSE_FILES.
//   TEST_BASE             Basis-URL der App (Standard http://localhost:3099; BASE_URL wird weiter akzeptiert)
//   TEST_COMPOSE_PROJECT  Compose-Projektname (Standard mycloudtest)
//   TEST_COMPOSE_FILES    Compose-Dateien, durch Leerzeichen getrennt, relativ zum Repo-Root
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const BASE = process.env.TEST_BASE || process.env.BASE_URL || 'http://localhost:3099';
const COMPOSE_PROJECT = process.env.TEST_COMPOSE_PROJECT || 'mycloudtest';
const COMPOSE_FILES = (process.env.TEST_COMPOSE_FILES || 'tests/docker-compose.test.yml').split(/\s+/).filter(Boolean).map(f => path.resolve(ROOT, f));
// Argumente für `docker` (execFileSync) bzw. ein fertiger Kommandostring für execSync
const COMPOSE_ARGS = ['compose', '-p', COMPOSE_PROJECT, ...COMPOSE_FILES.flatMap(f => ['-f', f])];
const COMPOSE_CMD = 'docker ' + COMPOSE_ARGS.map(a => JSON.stringify(a)).join(' ');
module.exports = { ROOT, BASE, COMPOSE_PROJECT, COMPOSE_FILES, COMPOSE_ARGS, COMPOSE_CMD };
