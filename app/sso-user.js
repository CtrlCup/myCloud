// Nutzer-Suche/-Anlage/-Verknüpfung für SSO (OIDC-Callback und Forward-Auth). Keine Express-Abhängigkeit:
// `pool` ist alles mit einer `query(text, params)`-Methode (pg.Pool).
const crypto = require('crypto');

const USERNAME_MAX = 50; // users.username ist VARCHAR(50)
const NAME_MAX = 100; // users.first_name / last_name sind VARCHAR(100)
const EMAIL_MAX = 255;
const SUFFIX_LEN = 7; // "_" + 6 Hex-Zeichen

class SsoUserError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Wie bei der normalen Registrierung: nur [a-zA-Z0-9-_], auf max. 50 Zeichen gekürzt.
function sanitizeUsername(raw, maxLen = USERNAME_MAX) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^a-zA-Z0-9-_]/g, '').substring(0, maxLen);
}

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (!e || e.length > EMAIL_MAX || !e.includes('@')) return null;
  return e;
}

function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const n = raw.trim().substring(0, NAME_MAX);
  return n || null;
}

// Benutzername aus preferred_username, sonst username, sonst E-Mail-Lokalteil; leer, wenn nichts Brauchbares.
function pickUsernameBase(claims) {
  const email = normalizeEmail(claims.email);
  const candidates = [claims.preferred_username, claims.username, email ? email.split('@')[0] : null];
  for (const c of candidates) {
    const clean = sanitizeUsername(c);
    if (clean) return clean;
  }
  return '';
}

async function uniqueUsername(pool, base) {
  let candidate = base;
  for (let i = 0; i < 10; i++) {
    const r = await pool.query('SELECT 1 FROM users WHERE username = $1', [candidate]);
    if (r.rows.length === 0) return candidate;
    candidate = `${base.substring(0, USERNAME_MAX - SUFFIX_LEN)}_${crypto.randomBytes(3).toString('hex')}`;
  }
  return candidate; // extrem unwahrscheinlich; der INSERT würde dann sichtbar scheitern
}

async function emailTakenByOther(pool, email, userId) {
  const r = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1 AND id != $2', [email, userId]);
  return r.rows.length > 0;
}

// Name/E-Mail aus den Claims übernehmen, außer der Nutzer hat sie lokal überschrieben (profile_overridden).
// Eine bereits von einem anderen Konto benutzte E-Mail bleibt unverändert (kein Fehler).
async function refreshProfile(pool, user, claims) {
  if (user.profile_overridden) return user;
  const email = normalizeEmail(claims.email);
  const first = cleanName(claims.given_name);
  const last = cleanName(claims.family_name);
  const sets = [];
  const params = [];
  if (email && email !== (user.email || '').toLowerCase() && !(await emailTakenByOther(pool, email, user.id))) {
    params.push(email);
    sets.push(`email = $${params.length}`);
  }
  if (first && first !== user.first_name) {
    params.push(first);
    sets.push(`first_name = $${params.length}`);
  }
  if (last && last !== user.last_name) {
    params.push(last);
    sets.push(`last_name = $${params.length}`);
  }
  if (sets.length === 0) return user;
  params.push(user.id);
  try {
    const r = await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    return r.rows[0] || user;
  } catch (err) {
    if (err.code === '23505') return user; // Unique-Race auf der E-Mail: unverändert lassen
    throw err;
  }
}

async function createUser(pool, claims, provider) {
  const base = pickUsernameBase(claims);
  if (!base) throw new SsoUserError('MISSING_CLAIMS', 'Der SSO-Anbieter hat weder Benutzername noch E-Mail geliefert.');
  const username = await uniqueUsername(pool, base);

  const countRes = await pool.query('SELECT COUNT(*) FROM users');
  let role = 'admin';
  if (parseInt(countRes.rows[0].count) !== 0) {
    const defRes = await pool.query('SELECT name FROM roles WHERE is_default = true LIMIT 1');
    role = (defRes.rows[0] && defRes.rows[0].name) || 'user';
  }

  let email = normalizeEmail(claims.email);
  if (email) {
    const dup = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [email]);
    if (dup.rows.length > 0) email = null; // E-Mail gehört schon einem anderen Konto
  }
  const insert = (mail) => pool.query(
    `INSERT INTO users (username, email, first_name, last_name, role, sso_id, sso_provider)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [username, mail, cleanName(claims.given_name), cleanName(claims.family_name), role, claims.sub, provider]
  );
  try {
    return (await insert(email)).rows[0];
  } catch (err) {
    if (err.code === '23505' && email) return (await insert(null)).rows[0]; // E-Mail-Race
    throw err;
  }
}

// Ergebnis: { user, created, linked }. Wirft SsoUserError('MISSING_CLAIMS').
async function findOrCreateSsoUser(pool, claims, { provider = 'authentik' } = {}) {
  if (!claims || !claims.sub) throw new SsoUserError('MISSING_CLAIMS', 'Die SSO-Antwort enthält keine Benutzerkennung.');

  const found = await pool.query('SELECT * FROM users WHERE sso_id = $1 AND sso_provider = $2', [claims.sub, provider]);
  if (found.rows.length > 0) {
    return { user: await refreshProfile(pool, found.rows[0], claims), created: false, linked: false };
  }

  return { user: await createUser(pool, claims, provider), created: true, linked: false };
}

module.exports = { findOrCreateSsoUser, sanitizeUsername, pickUsernameBase, SsoUserError, USERNAME_MAX };
