// node --test tests/email-case.test.js  (Test-Stack auf http://localhost:3099) — Issue #45
// Die Migrationsprüfung braucht docker compose (Projekt mycloudtest) für psql und den App-Neustart.
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');

const BASE = process.env.BASE_URL || 'http://localhost:3099';
const stamp = Date.now();
const user = 'emailcase' + stamp;
const mixed = `Mixed.${stamp}@Example.TEST`;
const password = 'Test-Passwort-12345!';
const COMPOSE = 'docker compose -p mycloudtest -f tests/docker-compose.test.yml';
const psql = (sql) => execSync(`${COMPOSE} exec -T db psql -U mycloud -d mycloud -At`, { input: sql, cwd: __dirname + '/..' }).toString().trim();

const post = (path, body) => fetch(BASE + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('Registrierung mit gemischter Schreibweise speichert klein', async () => {
  const res = await post('/api/auth/register', { username: user, email: mixed, password });
  assert.ok([200, 201].includes(res.status), 'register ' + res.status);
  assert.strictEqual(psql(`SELECT email FROM users WHERE LOWER(email)='${mixed.toLowerCase()}'`), mixed.toLowerCase());
});

test('Login per E-Mail in drei Schreibweisen', async () => {
  for (const id of [mixed, mixed.toLowerCase(), mixed.toUpperCase(), '  ' + mixed + ' ']) {
    const res = await post('/api/auth/login', { username: id, password });
    assert.strictEqual(res.status, 200, 'login ' + id);
  }
});

test('Passwort-Reset-Anfrage mit anderer Schreibweise ohne 500', async () => {
  const res = await post('/api/auth/reset-password-request', { username: mixed.toUpperCase() });
  assert.strictEqual(res.status, 200);
});

test('Zweite Registrierung mit anderer Schreibweise wird abgelehnt', async () => {
  const res = await post('/api/auth/register', { username: user + 'b', email: mixed.toUpperCase(), password });
  assert.ok([400, 409].includes(res.status), 'status ' + res.status);
  assert.strictEqual(psql(`SELECT count(*) FROM users WHERE LOWER(email)='${mixed.toLowerCase()}'`), '1');
});

test('Migration: eindeutige Adressen normalisieren, Kollisionen unangetastet, idempotent', async () => {
  const p = 'mig' + stamp;
  psql(`DROP INDEX IF EXISTS users_email_lower_unique_idx;
    INSERT INTO users (username, email, password_hash) VALUES
      ('${p}one', ' Mig.One.${stamp}@Example.test ', 'x'),
      ('${p}a', 'Col.${stamp}@x.test', 'x'),
      ('${p}b', 'COL.${stamp}@x.test', 'x');`);
  const restart = () => {
    execSync(`${COMPOSE} restart app`, { cwd: __dirname + '/..', stdio: 'ignore' });
    for (let i = 0; i < 40; i++) {
      try { execSync('curl -sf -o /dev/null ' + BASE + '/api/auth/status'); return; } catch { execSync('sleep 1'); }
    }
    throw new Error('App startet nicht');
  };
  const state = () => psql(`SELECT username || '=' || email FROM users WHERE username LIKE '${p}%' ORDER BY username`);
  restart();
  const expected = [`${p}a=Col.${stamp}@x.test`, `${p}b=COL.${stamp}@x.test`, `${p}one=mig.one.${stamp}@example.test`].join('\n');
  assert.strictEqual(state(), expected);
  restart();
  assert.strictEqual(state(), expected);
  // Aufräumen, damit spätere Boots den Unique-Index wieder anlegen können
  psql(`DELETE FROM users WHERE username LIKE '${p}%'`);
});
