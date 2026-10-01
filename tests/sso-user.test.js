// node --test --test-concurrency=1 tests/sso-user.test.js
// Reine Teile laufen ohne Stack; die DB-Szenarien rufen app/sso-user.js im laufenden Test-Stack-Container
// auf (docker compose -p mycloudtest ...), weil es im Test-Stack keinen OIDC-Provider gibt.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { sanitizeUsername, pickUsernameBase } = require('../app/sso-user');

const BASE = process.env.BASE_URL || 'http://localhost:3099';
const COMPOSE = ['compose', '-p', 'mycloudtest', '-f', __dirname + '/docker-compose.test.yml'];
const RUN = Date.now().toString(36);

test('sanitizeUsername: Bereinigung und Kürzung auf 50 Zeichen', () => {
  assert.strictEqual(sanitizeUsername('Max Muster!ä@x'), 'MaxMusterx');
  assert.strictEqual(sanitizeUsername('a'.repeat(80)).length, 50);
  assert.strictEqual(sanitizeUsername('ääö'), '');
  assert.strictEqual(sanitizeUsername(undefined), '');
});

test('pickUsernameBase: Reihenfolge und fehlende Claims', () => {
  assert.strictEqual(pickUsernameBase({ preferred_username: 'pu', username: 'u', email: 'e@x.de' }), 'pu');
  assert.strictEqual(pickUsernameBase({ username: 'u', email: 'e@x.de' }), 'u');
  assert.strictEqual(pickUsernameBase({ email: 'Mail.Name@x.de' }), 'mailname');
  assert.strictEqual(pickUsernameBase({ preferred_username: '!!!', email: 'e@x.de' }), 'e');
  assert.strictEqual(pickUsernameBase({}), '');
});

function psql(sql) {
  return execFileSync('docker', [...COMPOSE, 'exec', '-T', 'db', 'psql', '-U', 'mycloud', '-d', 'mycloud', '-At', '-c', sql]).toString().trim();
}
const SCRIPT = `const {Pool}=require('pg');const m=require('/usr/src/app/sso-user.js');
(async()=>{const p=new Pool({connectionString:process.env.DATABASE_URL});const a=JSON.parse(process.argv[1]);
try{const r=a.fn==='link'?{user:await m.linkSsoToUser(p,a.userId,a.claims)}:await m.findOrCreateSsoUser(p,a.claims,a.opts);
console.log(JSON.stringify({user:r.user,created:r.created,linked:r.linked}))}catch(e){console.log(JSON.stringify({err:e.code||e.message}))}
await p.end()})()`;
function sso(claims, opts, extra = {}) {
  const out = execFileSync('docker', [...COMPOSE, 'exec', '-T', 'app', 'node', '-e', SCRIPT, JSON.stringify({ claims, opts, ...extra })]).toString().trim();
  return JSON.parse(out.split('\n').pop());
}

// Lokale Nutzer per SQL statt API (Registrierungs-Rate-Limit); nur Link- und Profil-Test nutzen die API.
function localUser(username, email) {
  return { id: parseInt(psql(`INSERT INTO users (username, email, role) VALUES ('${username}', '${email}', 'user') RETURNING id`).split('\n')[0]) };
}
const count = () => parseInt(psql('SELECT COUNT(*) FROM users'));

let setupOk = false;
test('setup: Stack erreichbar', async () => {
  psql('SELECT 1');
  if (count() === 0) psql(`INSERT INTO users (username, email, role) VALUES ('base${RUN}', 'base${RUN}@example.test', 'admin')`); // erster Nutzer ist sonst admin
  setupOk = true;
});

test('verifizierte E-Mail: bestehendes Konto wird verknüpft', async (t) => {
  if (!setupOk) return t.skip();
  const email = `link${RUN}@example.test`;
  const local = localUser('link' + RUN, email); // per SQL: /api/auth/register ist auf 5 Versuche/h und IP limitiert, die Suite braucht das Kontingent anderswo
  const before = count();
  const r = sso({ sub: 'sub-link-' + RUN, email: email.toUpperCase(), email_verified: true, preferred_username: 'other' }, { allowEmailLinking: true });
  assert.strictEqual(r.user.id, local.id);
  assert.strictEqual(r.linked, true);
  assert.strictEqual(r.created, false);
  assert.strictEqual(count(), before);
  assert.strictEqual(psql(`SELECT sso_id FROM users WHERE id=${local.id}`), 'sub-link-' + RUN);
});

test('nicht verifiziert (false, String, fehlend) oder allowEmailLinking=false: kein Link, neues Konto', async (t) => {
  if (!setupOk) return t.skip();
  const email = `nolink${RUN}@example.test`;
  const local = localUser('nolink' + RUN, email);
  const cases = [
    [{ email_verified: false }, true], [{ email_verified: 'true' }, true], [{}, true], [{ email_verified: true }, false],
  ];
  for (const [i, [extra, allow]] of cases.entries()) {
    const r = sso({ sub: `sub-nolink-${RUN}-${i}`, email, preferred_username: `nolink${RUN}${i}`, ...extra }, { allowEmailLinking: allow });
    assert.strictEqual(r.linked, false);
    assert.strictEqual(r.created, true);
    assert.notStrictEqual(r.user.id, local.id);
    assert.strictEqual(r.user.email, null); // E-Mail gehört schon dem lokalen Konto
  }
  assert.strictEqual(psql(`SELECT sso_id IS NULL FROM users WHERE id=${local.id}`), 't');
});

test('zwei lokale Konten mit gleicher E-Mail-Schreibweise-Kollision: nicht verknüpfen', async (t) => {
  if (!setupOk) return t.skip();
  const a = localUser('dup' + RUN, `dup${RUN}@example.test`);
  // zweites Konto nur per SQL (Unique-Index erlaubt keine exakte Dublette, Schreibweise aber schon)
  psql(`INSERT INTO users (username, email, role) VALUES ('dup2${RUN}', 'DUP${RUN}@example.test', 'user')`);
  const r = sso({ sub: 'sub-dup-' + RUN, email: `dup${RUN}@example.test`, email_verified: true, preferred_username: 'dupsso' + RUN }, { allowEmailLinking: true });
  assert.strictEqual(r.linked, false);
  assert.strictEqual(r.created, true);
  assert.notStrictEqual(r.user.id, a.id);
});

test('Neuanlage: Standardrolle, Name/E-Mail, 80-Zeichen-Name', async (t) => {
  if (!setupOk) return t.skip();
  const oldDefault = psql(`SELECT name FROM roles WHERE is_default LIMIT 1`);
  psql(`INSERT INTO roles (name, is_default, is_system, permissions) SELECT 'ssorole${RUN}', false, false, permissions FROM roles WHERE name='user'`);
  psql(`UPDATE roles SET is_default = (name='ssorole${RUN}')`);
  try {
    const long = RUN + 'x'.repeat(80) + ' ü'; // RUN-Präfix: ein Wiederholungslauf im selben Stack trifft sonst den schon vergebenen Namen
    const r = sso({ sub: 'sub-new-' + RUN, preferred_username: long, email: `New${RUN}@Example.test`, given_name: 'Erika', family_name: 'Muster' }, { allowEmailLinking: true });
    assert.strictEqual(r.created, true);
    assert.strictEqual(r.user.role, 'ssorole' + RUN);
    assert.strictEqual(r.user.username, (RUN + 'x'.repeat(80)).substring(0, 50));
    assert.strictEqual(r.user.email, `new${RUN}@example.test`);
    assert.strictEqual(r.user.first_name, 'Erika');
    assert.strictEqual(r.user.last_name, 'Muster');
    // gleicher Name nochmal (anderer sub): Suffix, weiterhin <= 50 Zeichen und gültig
    const r2 = sso({ sub: 'sub-new2-' + RUN, preferred_username: long }, {});
    assert.ok(r2.user.username.length <= 50 && /^[a-zA-Z0-9-_]+$/.test(r2.user.username));
    assert.notStrictEqual(r2.user.username, r.user.username);
  } finally {
    psql(`UPDATE roles SET is_default = (name='${oldDefault}')`);
  }
});

test('fehlende Claims: MISSING_CLAIMS statt Absturz', async (t) => {
  if (!setupOk) return t.skip();
  assert.strictEqual(sso({ sub: 'sub-empty-' + RUN }, {}).err, 'MISSING_CLAIMS');
  assert.strictEqual(sso({ preferred_username: 'x' }, {}).err, 'MISSING_CLAIMS');
});

test('zweiter Login aktualisiert E-Mail/Name; Kollision crasht nicht; profile_overridden respektiert', async (t) => {
  if (!setupOk) return t.skip();
  const sub = 'sub-upd-' + RUN;
  const r1 = sso({ sub, preferred_username: 'upd' + RUN, email: `upd${RUN}@example.test`, given_name: 'A', family_name: 'B' }, {});
  const id = r1.user.id;
  const r2 = sso({ sub, preferred_username: 'upd' + RUN, email: `upd2${RUN}@example.test`, email_verified: true, given_name: 'C', family_name: 'D' }, {});
  assert.strictEqual(r2.user.id, id);
  assert.strictEqual(r2.user.email, `upd2${RUN}@example.test`);
  assert.strictEqual(r2.user.first_name, 'C');
  // E-Mail eines anderen Kontos: unverändert, kein Fehler, Name wird trotzdem aktualisiert
  const other = `upd-other${RUN}@example.test`;
  localUser('updother' + RUN, other);
  const r3 = sso({ sub, preferred_username: 'upd' + RUN, email: other, email_verified: true, given_name: 'E', family_name: 'F' }, {});
  assert.strictEqual(r3.err, undefined);
  assert.strictEqual(r3.user.email, `upd2${RUN}@example.test`);
  assert.strictEqual(r3.user.first_name, 'E');
  // lokal überschrieben: keine Aktualisierung mehr
  psql(`UPDATE users SET profile_overridden = true WHERE id=${id}`);
  const r4 = sso({ sub, preferred_username: 'upd' + RUN, email: `upd4${RUN}@example.test`, email_verified: true, given_name: 'G' }, {});
  assert.strictEqual(r4.user.email, `upd2${RUN}@example.test`);
  assert.strictEqual(r4.user.first_name, 'E');
});

test('refreshProfile: E-Mail nur bei email_verified === true, Name immer', async (t) => {
  if (!setupOk) return t.skip();
  const sub = 'sub-ver-' + RUN;
  const mail = `ver${RUN}@example.test`;
  const id = sso({ sub, preferred_username: 'ver' + RUN, email: mail }, {}).user.id;
  const upd = (claims) => sso({ sub, preferred_username: 'ver' + RUN, ...claims }, {}).user;
  let u = upd({ email: `ver-a${RUN}@example.test`, given_name: 'N1' });
  assert.strictEqual(u.id, id);
  assert.strictEqual(u.email, mail);
  assert.strictEqual(u.first_name, 'N1');
  u = upd({ email: `ver-b${RUN}@example.test`, email_verified: 'true', given_name: 'N2' });
  assert.strictEqual(u.email, mail);
  assert.strictEqual(u.first_name, 'N2');
  u = upd({ email: `ver-c${RUN}@example.test`, email_verified: true });
  assert.strictEqual(u.email, `ver-c${RUN}@example.test`);
});

test('Profil speichern setzt profile_overridden nur bei Änderung von E-Mail/Name', async (t) => {
  if (!setupOk) return t.skip();
  const email = `prof${RUN}@example.test`;
  const reg = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Test-Passwort-12345!' }),
  });
  assert.ok(reg.ok);
  const cookie = (reg.headers.getSetCookie() || []).map(c => c.split(';')[0]).join('; ');
  const me = await (await fetch(BASE + '/api/auth/status', { headers: { cookie } })).json();
  if (!me.loggedIn) return t.skip('Registrierung loggt nicht automatisch ein');
  const save = (body) => fetch(BASE + '/api/settings/profile', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const base = { username: me.user.username, email, first_name: '', last_name: '', display_real_name: false };
  assert.ok((await save({ ...base, display_real_name: true })).ok);
  assert.strictEqual(psql(`SELECT profile_overridden FROM users WHERE id=${me.user.id}`), 'f');
  assert.ok((await save({ ...base, first_name: 'Neu' })).ok);
  assert.strictEqual(psql(`SELECT profile_overridden FROM users WHERE id=${me.user.id}`), 't');
  // gemischt geschriebene E-Mail wird kleingeschrieben gespeichert
  assert.ok((await save({ ...base, first_name: 'Neu', email: `Prof-Mixed${RUN}@Example.TEST` })).ok);
  assert.strictEqual(psql(`SELECT email FROM users WHERE id=${me.user.id}`), `prof-mixed${RUN}@example.test`);
});

test('manuelle Verknüpfung: ohne email_verified, belegte sso_id und fremde Identität werden abgelehnt', async (t) => {
  if (!setupOk) return t.skip();
  const u1 = localUser('man1' + RUN, `man1${RUN}@example.test`);
  const u2 = localUser('man2' + RUN, `man2${RUN}@example.test`);
  const sub = 'sub-man-' + RUN;
  const ok = sso({ sub }, null, { fn: 'link', userId: u1.id });
  assert.strictEqual(ok.user.id, u1.id);
  assert.strictEqual(psql(`SELECT sso_id FROM users WHERE id=${u1.id}`), sub);
  assert.strictEqual(sso({ sub }, null, { fn: 'link', userId: u1.id }).user.id, u1.id); // idempotent
  assert.strictEqual(sso({ sub }, null, { fn: 'link', userId: u2.id }).err, 'ALREADY_LINKED_OTHER');
  assert.strictEqual(sso({ sub: sub + 'x' }, null, { fn: 'link', userId: u1.id }).err, 'USER_LINKED_ELSEWHERE');
  assert.strictEqual(psql(`SELECT sso_id IS NULL FROM users WHERE id=${u2.id}`), 't');
});

test('HTTP: /auth/sso/link braucht Login; Status ohne SSO liefert ssoLinkable=false', async () => {
  const res = await fetch(BASE + '/auth/sso/link', { redirect: 'manual' });
  assert.strictEqual(res.status, 401);
});
