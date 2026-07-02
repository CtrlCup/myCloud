const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const archiver = require('archiver');
const crypto = require('crypto');
const swaggerUi = require('swagger-ui-express');
const yaml = require('js-yaml');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const { pool, initDb, getSetting, setSetting, getAllSettings } = require('./db');
const { sendMail } = require('./email');

require('dotenv').config();

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

// Setup directories
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer storage engine
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = crypto.randomUUID();
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
// Without a limit, multer will happily write an unbounded request body to disk before the
// app-level storage-quota check (further down) ever runs — a single oversized upload could
// fill the disk regardless of any quota. This is a generous ceiling (not the per-user quota),
// just a backstop against a genuinely unbounded request.
const MAX_UPLOAD_SIZE_BYTES = parseInt(process.env.MAX_UPLOAD_SIZE_BYTES) || 100 * 1024 * 1024 * 1024; // 100GB
const upload = multer({ storage: storage, limits: { fileSize: MAX_UPLOAD_SIZE_BYTES } });

// The browser/client freely chooses the Content-Type it reports for an uploaded file (multer's
// req.file.mimetype) — trusting it let an uploader store e.g. a .txt file with mimetype
// "text/html", which was then served with that same Content-Type on inline view/download,
// letting the browser render it as HTML/script (stored XSS). Deriving the type from the file
// extension instead means we always decide what gets served how, never the uploader. Anything
// not explicitly listed (notably svg/html/xhtml, which a browser can execute) falls back to
// application/octet-stream, which browsers download rather than render.
const SAFE_MIME_TYPES = {
  txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', log: 'text/plain',
  json: 'application/json', xml: 'application/xml', yaml: 'text/plain', yml: 'text/plain',
  js: 'text/plain', mjs: 'text/plain', ts: 'text/plain', css: 'text/plain', py: 'text/plain',
  java: 'text/plain', c: 'text/plain', cpp: 'text/plain', h: 'text/plain', go: 'text/plain',
  rs: 'text/plain', sh: 'text/plain', sql: 'text/plain', php: 'text/plain', rb: 'text/plain',
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  rar: 'application/x-rar-compressed', '7z': 'application/x-7z-compressed',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
};
function getSafeMimeType(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return SAFE_MIME_TYPES[ext] || 'application/octet-stream';
}

const pdfParse = require('pdf-parse');

async function extractTextContent(filePath, mimeType, fileName) {
  try {
    const ext = path.extname(fileName).toLowerCase();
    
    // 1. PDF files
    if (ext === '.pdf' || mimeType === 'application/pdf') {
      if (!fs.existsSync(filePath)) return null;
      const dataBuffer = fs.readFileSync(filePath);
      const uint8Array = new Uint8Array(dataBuffer);
      const parser = new pdfParse.PDFParse(uint8Array);
      const parsed = await parser.getText();
      return parsed.text || '';
    }
    
    // 2. Plain text / code files
    const textExts = ['.txt', '.md', '.json', '.js', '.css', '.html', '.py', '.sh', '.xml', '.yaml', '.yml', '.csv', '.ini', '.conf'];
    if (textExts.includes(ext) || (mimeType && mimeType.startsWith('text/'))) {
      if (!fs.existsSync(filePath)) return null;
      const text = fs.readFileSync(filePath, 'utf8');
      // Cap size to 500KB to prevent db bloat
      return text.substring(0, 500000);
    }
  } catch (err) {
    console.error('Error extracting text content from file:', fileName, err);
  }
  return null;
}

async function indexExistingFiles() {
  try {
    const res = await pool.query(
      "SELECT id, name, path, mime_type FROM files WHERE is_folder = false AND content IS NULL"
    );
    for (const row of res.rows) {
      const filePath = path.join(UPLOADS_DIR, row.path);
      if (fs.existsSync(filePath)) {
        console.log(`Indexing existing file: ${row.name}`);
        const content = await extractTextContent(filePath, row.mime_type, row.name);
        if (content !== null) {
          await pool.query("UPDATE files SET content = $1 WHERE id = $2", [content, row.id]);
        }
      }
    }
  } catch (err) {
    console.error('Error indexing existing files:', err);
  }
}

// Session Configuration using PostgreSQL for session store
// Kept as a named reference (not just inline app.use(...)) so the WebSocket upgrade handler
// further down can run it manually against the raw upgrade request — express-session normally
// only wires into Express's own request pipeline, not into raw `http` 'upgrade' events.
const sessionMiddleware = session({
  store: new (require('connect-pg-simple')(session))({
    pool: pool,
    tableName: 'session',
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET || 'fallback_secret_key_change_me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    secure: false, // Set to true if running over HTTPS
    sameSite: 'lax',
  }
});
app.use(sessionMiddleware);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// API-Key Authentication (Bearer token, for external/app clients)
// Populates req.session.userId/.username/.role from a personal API key, exactly like a browser
// login would — every existing route below reads those three session fields, so this lets the
// entire API work for token-authenticated clients without touching any individual route handler.
app.use(async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (req.session.userId || !authHeader || !authHeader.startsWith('Bearer ')) return next();

  const token = authHeader.slice(7).trim();
  if (!token.startsWith('mcld_')) return next();

  try {
    const keyHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await pool.query(
      `SELECT ak.id AS key_id, u.id AS user_id, u.username, u.role
       FROM api_keys ak JOIN users u ON ak.user_id = u.id
       WHERE ak.key_hash = $1`,
      [keyHash]
    );
    if (result.rows.length > 0) {
      const row = result.rows[0];
      req.session.userId = row.user_id;
      req.session.username = row.username;
      req.session.role = row.role;
      pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [row.key_id]).catch(() => {});
    }
  } catch (err) {
    console.error('API key auth error:', err);
  }
  next();
});

// API documentation (Swagger UI over the openapi.yaml spec, so an app developer can browse
// and try out every endpoint at /api/docs). Public — it only describes the API, no secrets.
let openApiSpec = null;
try {
  openApiSpec = yaml.load(fs.readFileSync(path.join(__dirname, 'openapi.yaml'), 'utf8'));
} catch (err) {
  console.error('Failed to load openapi.yaml:', err.message);
}
if (openApiSpec) {
  app.get('/api/docs/openapi.json', (req, res) => res.json(openApiSpec));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, {
    customSiteTitle: 'myCloud API Docs',
  }));
}

// Authentication Middleware
function requireAuth(req, res, next) {
  if (req.session.userId) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

// Resolve the permission map for a role name (empty object if the role is gone)
async function getRolePermissions(roleName) {
  if (!roleName) return {};
  try {
    const r = await pool.query('SELECT permissions FROM roles WHERE name = $1', [roleName]);
    if (r.rows.length === 0) return {};
    return r.rows[0].permissions || {};
  } catch (err) {
    console.error('getRolePermissions error:', err);
    return {};
  }
}

// Admin = legacy 'admin' role name OR any role carrying the `admin` permission
async function requireAdmin(req, res, next) {
  try {
    if (!req.session.userId) {
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }
    if (req.session.role === 'admin') return next();
    const perms = await getRolePermissions(req.session.role);
    if (perms.admin === true) return next();
    return res.status(403).json({ error: 'Forbidden: Admin access required' });
  } catch (err) {
    console.error('requireAdmin error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Gate an action behind a single permission key (admins always pass)
function requirePermission(key) {
  return async (req, res, next) => {
    try {
      if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
      if (req.session.role === 'admin') return next();
      const perms = await getRolePermissions(req.session.role);
      if (perms.admin === true || perms[key] === true) return next();
      return res.status(403).json({ error: 'Für diese Aktion fehlt deiner Rolle die Berechtigung.' });
    } catch (err) {
      console.error('requirePermission error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// WebAuthn configuration variables
const RP_NAME = 'myCloud';
const EXPECTED_ORIGIN = process.env.APP_URL || 'http://localhost:3030';
const getRpId = (req) => {
  const host = req.get('host') || 'localhost';
  return host.split(':')[0];
};
const getExpectedOrigin = (req) => {
  if (req.headers.origin) {
    return req.headers.origin;
  }
  const host = req.get('host') || 'localhost';
  const proto = req.protocol || 'http';
  return `${proto}://${host}`;
};

/* ==========================================================================
   AUTHENTICATION ROUTES
   ========================================================================== */

// Check current user status
app.get('/api/auth/status', async (req, res) => {
  if (req.session.userId) {
    try {
      const userRes = await pool.query('SELECT id, username, role, email, first_name, last_name, display_real_name FROM users WHERE id = $1', [req.session.userId]);
      if (userRes.rows.length > 0) {
        return res.json({
          loggedIn: true,
          user: userRes.rows[0]
        });
      }
    } catch (e) {
      console.error('Error fetching user auth status:', e);
    }
  }
  
  // Also check if any users exist to determine if registration should be open
  const userCountRes = await pool.query('SELECT COUNT(*) FROM users');
  const userCount = parseInt(userCountRes.rows[0].count);
  const ssoEnabled = (await getSetting('sso_enabled')) === 'true';

  res.json({
    loggedIn: false,
    firstRun: userCount === 0,
    ssoEnabled,
  });
});

// Standard Register Route
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const userCountRes = await pool.query('SELECT COUNT(*) FROM users');
    const userCount = parseInt(userCountRes.rows[0].count);
    const regEnabled = await getSetting('registration_enabled');

    // First user is automatically admin, otherwise check if registration is enabled
    if (userCount > 0 && regEnabled !== 'true') {
      return res.status(403).json({ error: 'Registration is currently disabled.' });
    }

    // First user is admin; everyone else gets the configured default role
    let role = 'admin';
    if (userCount !== 0) {
      const defRes = await pool.query('SELECT name FROM roles WHERE is_default = true LIMIT 1');
      role = (defRes.rows[0] && defRes.rows[0].name) || 'user';
    }
    const passwordHash = await bcrypt.hash(password, 10);

    // Generate standard username based on email prefix
    let baseUsername = email.split('@')[0].substring(0, 30);
    baseUsername = baseUsername.replace(/[^a-zA-Z0-9-_]/g, '');
    if (!baseUsername) baseUsername = 'user';

    let username = baseUsername;
    let attempts = 0;
    while (attempts < 10) {
      const check = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
      if (check.rows.length === 0) break;
      username = `${baseUsername}_${Math.floor(1000 + Math.random() * 9000)}`;
      attempts++;
    }

    // Check if SMTP is configured and verified by testing it
    const smtpHost = await getSetting('email_smtp_host');
    const smtpTested = await getSetting('email_smtp_tested');
    const emailConfigured = (smtpHost && smtpTested === 'true') ? true : false;

    let isVerified = true;
    let verificationToken = null;

    if (emailConfigured && role !== 'admin') { // Admins are auto-verified
      isVerified = false;
      verificationToken = crypto.randomBytes(32).toString('hex');
    }

    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, role, is_verified, verification_token, has_custom_username) 
       VALUES ($1, $2, $3, $4, $5, $6, false) 
       RETURNING id, username, email, role, is_verified`,
      [username, email, passwordHash, role, isVerified, verificationToken]
    );

    const newUser = result.rows[0];

    if (!isVerified) {
      // Send verification email
      const appUrl = await getSetting('app_url') || process.env.APP_URL || 'http://localhost:3030';
      const verifyLink = `${appUrl}/api/auth/verify-email?token=${verificationToken}`;

      await sendMail({
        to: email,
        subject: 'myCloud - Registrierung bestätigen',
        text: `Hallo,\n\nBitte bestätige deine Registrierung über den folgenden Link:\n${verifyLink}\n\nErst danach kannst du dich anmelden.`,
        html: `<p>Hallo,</p><p>Bitte bestätige deine Registrierung über den folgenden Link:</p><p><a href="${verifyLink}">${verifyLink}</a></p><p>Erst danach kannst du dich anmelden.</p>`
      });

      return res.status(201).json({ success: true, requiresVerification: true, message: 'Registrierung erfolgreich. Bitte bestätige deine E-Mail-Adresse.' });
    }

    // Log in automatically if no verification is required
    req.session.userId = newUser.id;
    req.session.username = newUser.username;
    req.session.role = newUser.role;

    res.status(201).json({ success: true, user: newUser });
  } catch (err) {
    console.error('Registration error:', err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Diese E-Mail-Adresse oder dieser Name wird bereits verwendet.' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET Route to verify email
app.get('/api/auth/verify-email', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send('Token ist erforderlich.');

  try {
    const userRes = await pool.query('SELECT * FROM users WHERE verification_token = $1', [token]);
    if (userRes.rows.length === 0) {
      return res.status(400).send('Ungültiger oder abgelaufener Verifizierungslink.');
    }

    const user = userRes.rows[0];
    await pool.query(
      'UPDATE users SET is_verified = true, verification_token = null WHERE id = $1',
      [user.id]
    );

    const appUrl = await getSetting('app_url') || process.env.APP_URL || 'http://localhost:3030';
    res.redirect(`${appUrl}/#login?verified=true`);
  } catch (err) {
    console.error('Error verifying email:', err);
    res.status(500).send('Internal server error');
  }
});

// Standard Login Route
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username/Email and password are required' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1 OR email = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Ungültiger Benutzername oder E-Mail oder Passwort.' });
    }

    const user = result.rows[0];
    if (user.is_active === false) {
      return res.status(403).json({ error: 'Ihr Account wurde gesperrt. Bitte wenden Sie sich an einen Administrator.' });
    }

    if (!user.password_hash) {
      return res.status(400).json({ error: 'Dieser Account nutzt SSO oder Passkeys. Bitte melde dich über diese an.' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Ungültiger Benutzername oder E-Mail oder Passwort.' });
    }

    // Check email verification
    if (!user.is_verified) {
      return res.status(403).json({ error: 'Bitte bestätige zuerst deine E-Mail-Adresse über den Link, den wir dir gesendet haben.' });
    }

    // Check 2FA
    if (user.two_factor_email || user.two_factor_totp) {
      req.session.tempUserId = user.id;
      req.session.tempUsername = user.username;
      req.session.tempUserRole = user.role;

      if (user.two_factor_totp) {
        return res.json({ success: true, requires2FA: true, type: 'totp' });
      }

      if (user.two_factor_email) {
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        req.session.twoFactorCode = code;
        req.session.twoFactorCodeExpires = Date.now() + 5 * 60 * 1000; // 5 min

        await sendMail({
          to: user.email,
          subject: 'myCloud - 2FA Login Code',
          text: `Hallo,\n\ndein 2FA-Code für den Login lautet: ${code}\n\nDieser Code ist 5 Minuten gültig.`,
          html: `<p>Hallo,</p><p>dein 2FA-Code für den Login lautet: <strong>${code}</strong></p><p>Dieser Code ist 5 Minuten gültig.</p>`
        });

        return res.json({ success: true, requires2FA: true, type: 'email' });
      }
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;

    res.json({
      success: true,
      user: { id: user.id, username: user.username, role: user.role, hasCustomUsername: user.has_custom_username }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 2FA Verification Route
app.post('/api/auth/login/verify-2fa', async (req, res) => {
  const { code } = req.body;
  const tempUserId = req.session.tempUserId;

  if (!tempUserId || !code) {
    return res.status(400).json({ error: '2FA-Sitzung abgelaufen oder kein Code eingegeben.' });
  }

  try {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [tempUserId]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    }

    const user = userRes.rows[0];

    if (user.two_factor_totp) {
      const speakeasy = require('speakeasy');
      const verified = speakeasy.totp.verify({
        secret: user.totp_secret,
        encoding: 'base32',
        token: code,
        window: 1
      });

      if (!verified) {
        return res.status(400).json({ error: 'Ungültiger Authenticator-Code.' });
      }
    } else if (user.two_factor_email) {
      if (!req.session.twoFactorCode || req.session.twoFactorCode !== code || req.session.twoFactorCodeExpires < Date.now()) {
        return res.status(400).json({ error: 'Ungültiger oder abgelaufener E-Mail-Code.' });
      }
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;

    delete req.session.tempUserId;
    delete req.session.tempUsername;
    delete req.session.tempUserRole;
    delete req.session.twoFactorCode;
    delete req.session.twoFactorCodeExpires;

    res.json({
      success: true,
      user: { id: user.id, username: user.username, role: user.role, hasCustomUsername: user.has_custom_username }
    });
  } catch (err) {
    console.error('2FA Verification error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Set custom username on first login
app.post('/api/auth/set-username', requireAuth, async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });

  const cleanUsername = username.trim().replace(/[^a-zA-Z0-9-_]/g, '');
  if (cleanUsername.length < 3 || cleanUsername.length > 30) {
    return res.status(400).json({ error: 'Der Name muss 3 bis 30 Zeichen lang sein und darf nur Buchstaben, Zahlen, Bindestriche und Unterstriche enthalten.' });
  }

  try {
    const exists = await pool.query('SELECT id FROM users WHERE username = $1 AND id != $2', [cleanUsername, req.session.userId]);
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: 'Dieser Name ist bereits vergeben.' });
    }

    await pool.query(
      'UPDATE users SET username = $1, has_custom_username = true WHERE id = $2',
      [cleanUsername, req.session.userId]
    );

    req.session.username = cleanUsername;
    res.json({ success: true, username: cleanUsername });
  } catch (err) {
    console.error('Error setting custom username:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout Route
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ error: 'Could not log out' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

/* ==========================================================================
   WEB_AUTHN / PASSKEY ROUTES
   ========================================================================== */

// 1. Registration Options
app.post('/api/auth/passkey/register-options', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const userRes = await pool.query('SELECT id, username FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];

    const userPasskeysRes = await pool.query('SELECT id, transports FROM passkeys WHERE user_id = $1', [userId]);
    const excludeCredentials = userPasskeysRes.rows.map(row => ({
      id: Buffer.from(row.id, 'base64url'),
      type: 'public-key',
      transports: row.transports ? row.transports.split(',') : [],
    }));

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: getRpId(req),
      userID: String(user.id),
      userName: user.username,
      userDisplayName: user.username,
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'preferred',
      },
    });

    req.session.currentChallenge = options.challenge;
    res.json(options);
  } catch (err) {
    console.error('Error generating passkey registration options:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. Verify Registration
app.post('/api/auth/passkey/register-verify', requireAuth, async (req, res) => {
  const { credential, name } = req.body;
  const userId = req.session.userId;
  const expectedChallenge = req.session.currentChallenge;

  if (!expectedChallenge) {
    return res.status(400).json({ error: 'Challenge missing from session' });
  }

  try {
    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: getExpectedOrigin(req),
      expectedRPID: getRpId(req),
    });

    if (verification.verified && verification.registrationInfo) {
      const { credentialPublicKey, credentialID, counter } = verification.registrationInfo;

      const credentialPublicKeyBase64 = Buffer.from(credentialPublicKey).toString('base64url');
      const credentialIDBase64 = Buffer.from(credentialID).toString('base64url');
      const transports = credential.response.transports ? credential.response.transports.join(',') : '';

      await pool.query(
        'INSERT INTO passkeys (id, public_key, counter, user_id, transports, name) VALUES ($1, $2, $3, $4, $5, $6)',
        [credentialIDBase64, credentialPublicKeyBase64, counter, userId, transports, name || 'Passkey']
      );

      delete req.session.currentChallenge;
      return res.json({ success: true });
    }

    res.status(400).json({ error: 'Registration verification failed' });
  } catch (err) {
    console.error('Error verifying passkey registration:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. Login Options
app.post('/api/auth/passkey/login-options', async (req, res) => {
  try {
    const options = await generateAuthenticationOptions({
      rpID: getRpId(req),
      userVerification: 'preferred',
    });

    req.session.currentChallenge = options.challenge;
    res.json(options);
  } catch (err) {
    console.error('Error generating passkey login options:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 4. Verify Login
app.post('/api/auth/passkey/login-verify', async (req, res) => {
  const { body } = req;
  const expectedChallenge = req.session.currentChallenge;

  if (!expectedChallenge) {
    return res.status(400).json({ error: 'Challenge missing from session' });
  }

  try {
    const credentialID = body.id;
    const passkeyRes = await pool.query('SELECT * FROM passkeys WHERE id = $1', [credentialID]);
    
    if (passkeyRes.rows.length === 0) {
      return res.status(404).json({ error: 'No passkey found with this ID' });
    }

    const passkey = passkeyRes.rows[0];
    const userRes = await pool.query('SELECT id, username, role FROM users WHERE id = $1', [passkey.user_id]);
    const user = userRes.rows[0];

    const verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: getExpectedOrigin(req),
      expectedRPID: getRpId(req),
      authenticator: {
        credentialID: Buffer.from(passkey.id, 'base64url'),
        credentialPublicKey: Buffer.from(passkey.public_key, 'base64url'),
        counter: parseInt(passkey.counter),
      },
    });

    if (verification.verified) {
      // Update counter
      await pool.query('UPDATE passkeys SET counter = $1 WHERE id = $2', [
        verification.authenticationInfo.newCounter,
        passkey.id,
      ]);

      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role;
      delete req.session.currentChallenge;

      return res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
    }

    res.status(400).json({ error: 'Authentication verification failed' });
  } catch (err) {
    console.error('Error verifying passkey login:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* ==========================================================================
   SSO / OIDC (AUTHENTIK) ROUTES
   ========================================================================== */

// Redirect to SSO Provider
app.get('/auth/sso', async (req, res) => {
  const ssoEnabled = await getSetting('sso_enabled');
  if (ssoEnabled !== 'true') {
    return res.status(400).send('SSO is currently disabled.');
  }

  const clientId = await getSetting('sso_client_id');
  const issuerUrl = await getSetting('sso_issuer_url');
  const redirectUri = await getSetting('sso_redirect_uri');

  if (!clientId || !issuerUrl || !redirectUri) {
    return res.status(500).send('SSO configuration is incomplete.');
  }

  const state = crypto.randomBytes(16).toString('hex');
  req.session.ssoState = state;

  // Build Auth URL (Assuming standard OIDC endpoint /protocol/openid-connect/auth)
  const authUrl = `${issuerUrl.replace(/\/$/, '')}/protocol/openid-connect/auth?` +
    `client_id=${encodeURIComponent(clientId)}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `response_type=code&` +
    `scope=openid%20profile%20email&` +
    `state=${state}`;

  res.redirect(authUrl);
});

// SSO Callback
app.get('/auth/sso/callback', async (req, res) => {
  const { code, state } = req.query;
  const sessionState = req.session.ssoState;
  
  if (!code || !state || state !== sessionState) {
    return res.status(400).send('Invalid state or state mismatch.');
  }
  
  delete req.session.ssoState;

  try {
    const clientId = await getSetting('sso_client_id');
    const clientSecret = await getSetting('sso_client_secret');
    const issuerUrl = await getSetting('sso_issuer_url');
    const redirectUri = await getSetting('sso_redirect_uri');

    // Token Endpoint
    const tokenUrl = `${issuerUrl.replace(/\/$/, '')}/protocol/openid-connect/token`;
    
    const params = new URLSearchParams();
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);
    params.append('code', code);
    params.append('redirect_uri', redirectUri);
    params.append('grant_type', 'authorization_code');

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });

    if (!tokenResponse.ok) {
      throw new Error(`Token exchange failed: ${tokenResponse.statusText}`);
    }

    const tokenData = await tokenResponse.json();
    
    // UserInfo Endpoint
    const userInfoUrl = `${issuerUrl.replace(/\/$/, '')}/protocol/openid-connect/userinfo`;
    const userResponse = await fetch(userInfoUrl, {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });

    if (!userResponse.ok) {
      throw new Error(`Failed to fetch user info: ${userResponse.statusText}`);
    }

    const userInfo = await userResponse.json();
    const ssoId = userInfo.sub;
    const username = userInfo.preferred_username || userInfo.username || userInfo.email.split('@')[0];

    // Find or create SSO user
    let userRes = await pool.query('SELECT * FROM users WHERE sso_id = $1 AND sso_provider = $2', [ssoId, 'authentik']);
    
    if (userRes.rows.length === 0) {
      // Check if username already exists
      let checkUsernameRes = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
      let finalUsername = username;
      if (checkUsernameRes.rows.length > 0) {
        finalUsername = `${username}_${crypto.randomBytes(3).toString('hex')}`;
      }

      // Check if this is the first user
      const userCountRes = await pool.query('SELECT COUNT(*) FROM users');
      const role = parseInt(userCountRes.rows[0].count) === 0 ? 'admin' : 'user';

      userRes = await pool.query(
        'INSERT INTO users (username, role, sso_id, sso_provider) VALUES ($1, $2, $3, $4) RETURNING *',
        [finalUsername, role, ssoId, 'authentik']
      );
    }

    const user = userRes.rows[0];
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;

    res.redirect('/');
  } catch (err) {
    console.error('SSO Callback error:', err);
    res.status(500).send('SSO Authentication Failed.');
  }
});

/* ==========================================================================
   PASSWORD RESET VIA EMAIL
   ========================================================================== */

// Route to request password reset
app.post('/api/auth/reset-password-request', async (req, res) => {
  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  try {
    const userRes = await pool.query('SELECT * FROM users WHERE username = $1 OR email = $1', [username]);
    if (userRes.rows.length === 0) {
      // Do not disclose whether user exists
      return res.json({ success: true, message: 'Falls der Benutzer existiert, wurde ein Reset-Link gesendet.' });
    }

    const user = userRes.rows[0];
    if (user.sso_id) {
      return res.status(400).json({ error: 'Dieser Benutzer wird über SSO verwaltet und kann sein Passwort nicht lokal ändern.' });
    }

    // Determine recipient email
    let recipient = user.email || '';
    if (!recipient && user.username.includes('@')) {
      recipient = user.username;
    }

    if (!recipient) {
      return res.status(400).json({ error: 'Für diesen Account ist keine E-Mail-Adresse hinterlegt. Passwort-Reset per E-Mail ist nicht möglich.' });
    }

    // Generate random reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + 3600000; // 1 hour

    await setSetting(`reset_${resetToken}`, JSON.stringify({ userId: user.id, expires }));

    const appUrl = await getSetting('app_url') || process.env.APP_URL || 'http://localhost:3030';
    const resetLink = `${appUrl}/#reset-password?token=${resetToken}`;

    const mailSent = await sendMail({
      to: recipient,
      subject: 'myCloud - Passwort zurücksetzen',
      text: `Hallo,\n\nBitte setze dein Passwort über den folgenden Link zurück:\n${resetLink}\n\nDieser Link ist für 1 Stunde gültig.`,
      html: `<p>Hallo,</p><p>Bitte setze dein Passwort über den folgenden Link zurück:</p><p><a href="${resetLink}">${resetLink}</a></p><p>Dieser Link ist für 1 Stunde gültig.</p>`
    });

    if (mailSent) {
      res.json({ success: true, message: 'Passwort-Reset-Link an die hinterlegte E-Mail-Adresse gesendet.' });
    } else {
      if (appUrl.includes('localhost')) {
        return res.json({ success: true, devLink: resetLink, message: '[DEV ONLY] E-Mail-Versand fehlgeschlagen, hier ist dein Link.' });
      }
      res.status(500).json({ error: 'Fehler beim Senden der Reset-E-Mail. Bitte wende dich an den Administrator.' });
    }
  } catch (err) {
    console.error('Password reset request error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Route to execute password reset
app.post('/api/auth/reset-password-execute', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({ error: 'Token and new password are required' });
  }

  try {
    const key = `reset_${token}`;
    const rawVal = await getSetting(key);
    if (!rawVal) {
      return res.status(400).json({ error: 'Invalid or expired token.' });
    }

    const { userId, expires } = JSON.parse(rawVal);
    if (Date.now() > expires) {
      await pool.query('DELETE FROM settings WHERE key = $1', [key]);
      return res.status(400).json({ error: 'Token has expired.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
    
    // Clean up token
    await pool.query('DELETE FROM settings WHERE key = $1', [key]);

    res.json({ success: true, message: 'Password reset successful. Please log in.' });
  } catch (err) {
    console.error('Password reset execute error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* ==========================================================================
   FILE & EXPLORER ROUTES
   ========================================================================== */

// Helper to check recursively if a file/folder belongs to an owner
async function verifyFileOwner(fileId, userId) {
  if (!fileId) return true;
  const res = await pool.query('SELECT owner_id FROM files WHERE id = $1', [fileId]);
  if (res.rows.length === 0) return false;
  return res.rows[0].owner_id === userId;
}

// Search files (normal and deep/OCR modes)
app.get('/api/files/search', requireAuth, async (req, res) => {
  const query = req.query.q || '';
  const deep = req.query.deep === 'true';
  const userId = req.session.userId;

  if (!query.trim()) {
    return res.json([]);
  }

  try {
    let sql = `
      WITH RECURSIVE folder_sizes AS (
        SELECT id, size, parent_id
        FROM files
        WHERE is_folder = false AND owner_id = $1
        
        UNION ALL
        
        SELECT f.id, fs.size, f.parent_id
        FROM files f
        JOIN folder_sizes fs ON f.id = fs.parent_id
        WHERE f.owner_id = $1
      )
      SELECT f.id, f.name, COALESCE(f.size, sz.total_size, 0) as size, f.is_folder, f.mime_type, f.created_at, f.parent_id 
      FROM files f
      LEFT JOIN (
        SELECT id, SUM(size) as total_size
        FROM folder_sizes
        GROUP BY id
      ) sz ON f.id = sz.id
      WHERE f.owner_id = $1 AND (f.name ILIKE $2`;

    const params = [userId, `%${query}%`];

    if (deep) {
      sql += ` OR f.content ILIKE $2 OR word_similarity($3, f.name) > 0.3 OR word_similarity($3, COALESCE(f.content, '')) > 0.2`;
      params.push(query);
    }

    sql += `)
      ORDER BY
        CASE
          WHEN f.name ILIKE $2 THEN 0
          WHEN f.content ILIKE $2 THEN 1
          ELSE 2
        END,
        f.is_folder DESC, f.name ASC`;

    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error searching files:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get directory listing
app.get('/api/files/list', requireAuth, async (req, res) => {
  const parentId = req.query.parentId === 'null' || !req.query.parentId ? null : parseInt(req.query.parentId);
  const userId = req.session.userId;

  try {
    // Verify parent is owned by user
    if (parentId !== null) {
      const isOwner = await verifyFileOwner(parentId, userId);
      if (!isOwner) return res.status(403).json({ error: 'Access denied' });
    }

    const result = await pool.query(
      `WITH RECURSIVE folder_sizes AS (
         SELECT id, size, parent_id
         FROM files
         WHERE is_folder = false AND owner_id = $1
         
         UNION ALL
         
         SELECT f.id, fs.size, f.parent_id
         FROM files f
         JOIN folder_sizes fs ON f.id = fs.parent_id
         WHERE f.owner_id = $1
       )
       SELECT f.id, f.name, COALESCE(f.size, sz.total_size, 0) as size, f.is_folder, f.mime_type, f.created_at, f.parent_id 
       FROM files f
       LEFT JOIN (
         SELECT id, SUM(size) as total_size
         FROM folder_sizes
         GROUP BY id
       ) sz ON f.id = sz.id
       WHERE f.owner_id = $1 AND (f.parent_id = $2 OR (f.parent_id IS NULL AND $2 IS NULL))
       ORDER BY f.is_folder DESC, f.name ASC`,
      [userId, parentId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error listing files:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new folder
app.post('/api/files/folder', requireAuth, requirePermission('create_folder'), async (req, res) => {
  const { name, parentId } = req.body;
  const userId = req.session.userId;
  const parsedParentId = parentId ? parseInt(parentId) : null;

  if (!name) {
    return res.status(400).json({ error: 'Folder name is required' });
  }

  try {
    if (parsedParentId !== null) {
      const isOwner = await verifyFileOwner(parsedParentId, userId);
      if (!isOwner) return res.status(403).json({ error: 'Access denied' });
    }

    const result = await pool.query(
      'INSERT INTO files (name, path, is_folder, parent_id, owner_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, 'folder', true, parsedParentId, userId]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating folder:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Upload file
app.post('/api/files/upload', requireAuth, requirePermission('upload'), upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const parentId = req.body.parentId && req.body.parentId !== 'null' ? parseInt(req.body.parentId) : null;
  const userId = req.session.userId;

  try {
    // Check per-user storage quota
    const userRes = await pool.query('SELECT storage_quota, role FROM users WHERE id = $1', [userId]);
    const quotaBytes = userRes.rows[0].storage_quota ? parseInt(userRes.rows[0].storage_quota) : null;

    if (quotaBytes !== null) {
      const usedRes = await pool.query('SELECT SUM(size) as total FROM files WHERE owner_id = $1 AND is_folder = false', [userId]);
      const usedBytes = parseInt(usedRes.rows[0].total || 0);
      if (usedBytes + req.file.size > quotaBytes) {
        fs.unlinkSync(req.file.path);
        return res.status(413).json({ error: 'Speicherplatzlimit überschritten! Bitte lösche Dateien oder wende dich an einen Admin.' });
      }
    }

    // Check group (role) storage quota — combined usage of all members of the role
    const roleName = userRes.rows[0].role;
    const roleQuotaRes = await pool.query('SELECT storage_quota FROM roles WHERE name = $1', [roleName]);
    const roleQuotaBytes = (roleQuotaRes.rows[0] && roleQuotaRes.rows[0].storage_quota) ? parseInt(roleQuotaRes.rows[0].storage_quota) : null;
    if (roleQuotaBytes !== null) {
      const groupUsedRes = await pool.query(
        `SELECT COALESCE(SUM(f.size), 0) as total
         FROM files f JOIN users u ON f.owner_id = u.id
         WHERE u.role = $1 AND f.is_folder = false`,
        [roleName]
      );
      const groupUsed = parseInt(groupUsedRes.rows[0].total || 0);
      if (groupUsed + req.file.size > roleQuotaBytes) {
        fs.unlinkSync(req.file.path);
        return res.status(413).json({ error: 'Das gemeinsame Speicherkontingent deiner Gruppe ist erschöpft. Bitte wende dich an einen Admin.' });
      }
    }

    if (parentId !== null) {
      const isOwner = await verifyFileOwner(parentId, userId);
      if (!isOwner) {
        fs.unlinkSync(req.file.path); // Delete file if unauthorized
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const safeMimeType = getSafeMimeType(req.file.originalname);
    const textContent = await extractTextContent(req.file.path, safeMimeType, req.file.originalname);

    const result = await pool.query(
      `INSERT INTO files (name, path, mime_type, size, is_folder, parent_id, owner_id, content)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.file.originalname, req.file.filename, safeMimeType, req.file.size, false, parentId, userId, textContent]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error uploading file:', err);
    // Cleanup file
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Download single file
app.get('/api/files/download/:id', requireAuth, requirePermission('download'), async (req, res) => {
  const fileId = parseInt(req.params.id);
  const userId = req.session.userId;

  try {
    const fileRes = await pool.query('SELECT * FROM files WHERE id = $1', [fileId]);
    if (fileRes.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const file = fileRes.rows[0];
    if (file.owner_id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (file.is_folder) {
      return res.status(400).json({ error: 'Cannot download folder directly. Use ZIP download.' });
    }

    const filePath = path.join(UPLOADS_DIR, file.path);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Physical file not found on disk' });
    }

    if (req.query.inline === 'true') {
      let mimeType = file.mime_type;
      if (!mimeType) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (ext === 'pdf') {
          mimeType = 'application/pdf';
        } else {
          mimeType = 'application/octet-stream';
        }
      }

      return res.sendFile(filePath, {
        headers: {
          'Content-Type': mimeType,
          'Content-Disposition': 'inline; filename="' + encodeURIComponent(file.name) + '"'
        }
      });
    }

    res.download(filePath, file.name);
  } catch (err) {
    console.error('Error downloading file:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper for ZIP folder packing
async function addFolderToZip(zip, folderId, currentPath, userId) {
  const filesRes = await pool.query(
    'SELECT * FROM files WHERE owner_id = $1 AND parent_id = $2',
    [userId, folderId]
  );

  for (const file of filesRes.rows) {
    const archivePath = path.join(currentPath, file.name);
    if (file.is_folder) {
      await addFolderToZip(zip, file.id, archivePath, userId);
    } else {
      const physicalPath = path.join(UPLOADS_DIR, file.path);
      if (fs.existsSync(physicalPath)) {
        zip.file(physicalPath, { name: archivePath });
      }
    }
  }
}

// Download folder as ZIP
app.get('/api/files/download-zip/:id', requireAuth, async (req, res) => {
  const folderId = parseInt(req.params.id);
  const userId = req.session.userId;

  try {
    const folderRes = await pool.query('SELECT * FROM files WHERE id = $1 AND is_folder = true', [folderId]);
    if (folderRes.rows.length === 0) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    const folder = folderRes.rows[0];
    if (folder.owner_id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(folder.name)}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => { throw err; });
    archive.pipe(res);

    await addFolderToZip(archive, folder.id, '', userId);
    await archive.finalize();
  } catch (err) {
    console.error('Error zipping folder:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create ZIP archive' });
    }
  }
});

// Helper: Recursively delete folder files
async function deleteFolderRecursive(folderId, userId) {
  const filesRes = await pool.query('SELECT * FROM files WHERE owner_id = $1 AND parent_id = $2', [userId, folderId]);
  for (const file of filesRes.rows) {
    if (file.is_folder) {
      await deleteFolderRecursive(file.id, userId);
    } else {
      const filePath = path.join(UPLOADS_DIR, file.path);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  }
  // Delete folder entry
  await pool.query('DELETE FROM files WHERE id = $1', [folderId]);
}

// Delete file/folder
app.delete('/api/files/:id', requireAuth, requirePermission('delete'), async (req, res) => {
  const fileId = parseInt(req.params.id);
  const userId = req.session.userId;

  try {
    const fileRes = await pool.query('SELECT * FROM files WHERE id = $1', [fileId]);
    if (fileRes.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const file = fileRes.rows[0];
    if (file.owner_id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (file.is_folder) {
      await deleteFolderRecursive(file.id, userId);
    } else {
      const filePath = path.join(UPLOADS_DIR, file.path);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      await pool.query('DELETE FROM files WHERE id = $1', [file.id]);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting file:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Move multiple files/folders to a target folder
app.post('/api/files/move-multiple', requireAuth, requirePermission('rename'), async (req, res) => {
  const { fileIds, targetFolderId } = req.body;
  const userId = req.session.userId;

  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    return res.status(400).json({ error: 'fileIds must be a non-empty array' });
  }

  try {
    // Verify target folder ownership if not root
    if (targetFolderId !== null) {
      const isOwner = await verifyFileOwner(targetFolderId, userId);
      if (!isOwner) return res.status(403).json({ error: 'Access denied to target folder' });

      // Reject moving a folder into itself or one of its own subfolders — that creates a
      // parent_id cycle, which sends the recursive folder-size CTE (list/search) and the
      // recursive folder delete into an infinite loop.
      const movingIds = fileIds.map(Number);
      let checkId = targetFolderId;
      while (checkId !== null) {
        if (movingIds.includes(checkId)) {
          return res.status(400).json({ error: 'Cannot move a folder into itself or one of its own subfolders.' });
        }
        const checkRes = await pool.query('SELECT parent_id FROM files WHERE id = $1', [checkId]);
        if (checkRes.rows.length === 0) break;
        checkId = checkRes.rows[0].parent_id;
      }
    }

    // Update parent_id for all these files belonging to the user
    await pool.query(
      'UPDATE files SET parent_id = $1 WHERE id = ANY($2) AND owner_id = $3',
      [targetFolderId, fileIds, userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Error moving multiple files:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Recursive copy helper for files and folders
async function copyFileOrFolderRecursive(fileId, targetFolderId, userId) {
  const fileRes = await pool.query('SELECT * FROM files WHERE id = $1 AND owner_id = $2', [fileId, userId]);
  if (fileRes.rows.length === 0) return;
  const file = fileRes.rows[0];

  if (file.is_folder) {
    const folderName = `${file.name} (Kopie)`;
    const newFolderRes = await pool.query(
      `INSERT INTO files (name, is_folder, parent_id, owner_id) 
       VALUES ($1, true, $2, $3) RETURNING *`,
      [folderName, targetFolderId, userId]
    );
    const newFolder = newFolderRes.rows[0];

    const childrenRes = await pool.query('SELECT id FROM files WHERE parent_id = $1 AND owner_id = $2', [file.id, userId]);
    for (const child of childrenRes.rows) {
      await copyFileOrFolderRecursive(child.id, newFolder.id, userId);
    }
  } else {
    const oldPath = path.join(UPLOADS_DIR, file.path);
    if (!fs.existsSync(oldPath)) return;

    const newFilename = crypto.randomUUID() + path.extname(file.name);
    const newPath = path.join(UPLOADS_DIR, newFilename);
    fs.copyFileSync(oldPath, newPath);

    const newName = file.name.includes('.') 
      ? file.name.replace(/(\.[^.]+)$/, ' (Kopie)$1') 
      : `${file.name} (Kopie)`;

    await pool.query(
      `INSERT INTO files (name, path, mime_type, size, is_folder, parent_id, owner_id, content) 
       VALUES ($1, $2, $3, $4, false, $5, $6, $7)`,
      [newName, newFilename, file.mime_type, file.size, targetFolderId, userId, file.content]
    );
  }
}

// Copy multiple files/folders
app.post('/api/files/copy-multiple', requireAuth, async (req, res) => {
  const { fileIds, targetFolderId } = req.body;
  const userId = req.session.userId;

  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    return res.status(400).json({ error: 'fileIds must be a non-empty array' });
  }

  try {
    // Verify target folder ownership if not root
    if (targetFolderId !== null) {
      const isOwner = await verifyFileOwner(targetFolderId, userId);
      if (!isOwner) return res.status(403).json({ error: 'Access denied to target folder' });
    }

    for (const id of fileIds) {
      await copyFileOrFolderRecursive(parseInt(id), targetFolderId, userId);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error copying multiple files:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete multiple files/folders
app.post('/api/files/delete-multiple', requireAuth, requirePermission('delete'), async (req, res) => {
  const { ids } = req.body;
  const userId = req.session.userId;
  
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'No IDs provided' });
  }

  try {
    for (const id of ids) {
      const fileId = parseInt(id);
      const fileRes = await pool.query('SELECT * FROM files WHERE id = $1', [fileId]);
      if (fileRes.rows.length === 0) continue;

      const file = fileRes.rows[0];
      if (file.owner_id !== userId) continue;

      if (file.is_folder) {
        await deleteFolderRecursive(file.id, userId);
      } else {
        const filePath = path.join(UPLOADS_DIR, file.path);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
        await pool.query('DELETE FROM files WHERE id = $1', [file.id]);
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting multiple files:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Download multiple files/folders as a single ZIP
app.get('/api/files/download-zip-multiple', requireAuth, async (req, res) => {
  const idsParam = req.query.ids;
  const userId = req.session.userId;

  if (!idsParam) {
    return res.status(400).json({ error: 'No IDs provided' });
  }

  const ids = idsParam.split(',').map(id => parseInt(id));

  try {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="mycloud_selection.zip"');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => { throw err; });
    archive.pipe(res);

    for (const id of ids) {
      const fileRes = await pool.query('SELECT * FROM files WHERE id = $1', [id]);
      if (fileRes.rows.length === 0) continue;

      const file = fileRes.rows[0];
      if (file.owner_id !== userId) continue;

      if (file.is_folder) {
        await addFolderToZip(archive, file.id, file.name, userId);
      } else {
        const physicalPath = path.join(UPLOADS_DIR, file.path);
        if (fs.existsSync(physicalPath)) {
          archive.file(physicalPath, { name: file.name });
        }
      }
    }
    await archive.finalize();
  } catch (err) {
    console.error('Error zipping multiple files:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create ZIP archive' });
    }
  }
});

// Create new empty file
app.post('/api/files/create-empty', requireAuth, requirePermission('upload'), async (req, res) => {
  const { name, parentId, type } = req.body;
  const userId = req.session.userId;
  const parsedParentId = parentId ? parseInt(parentId) : null;

  if (!name) {
    return res.status(400).json({ error: 'File name is required' });
  }

  try {
    if (parsedParentId !== null) {
      const isOwner = await verifyFileOwner(parsedParentId, userId);
      if (!isOwner) return res.status(403).json({ error: 'Access denied' });
    }

    let ext = '.txt';
    let mimeType = 'text/plain';
    let templateFile = null;

    switch (type) {
      case 'docx':
        ext = '.docx';
        mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        templateFile = path.join(__dirname, 'templates', 'new.docx');
        break;
      case 'xlsx':
        ext = '.xlsx';
        mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        templateFile = path.join(__dirname, 'templates', 'new.xlsx');
        break;
      case 'pptx':
        ext = '.pptx';
        mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        templateFile = path.join(__dirname, 'templates', 'new.pptx');
        break;
      case 'txt':
      default:
        ext = '.txt';
        mimeType = 'text/plain';
        break;
    }

    let finalName = name.trim();
    if (type === 'txt' || type === 'codex' || type === 'other') {
      const parts = finalName.split('.');
      if (parts.length > 1) {
        const detectedExt = '.' + parts.pop().toLowerCase();
        ext = detectedExt;
        if (ext === '.js' || ext === '.mjs' || ext === '.cjs') mimeType = 'application/javascript';
        else if (ext === '.json') mimeType = 'application/json';
        else if (ext === '.html') mimeType = 'text/html';
        else if (ext === '.css') mimeType = 'text/css';
        else mimeType = 'text/plain';
      } else {
        if (type === 'codex') {
          ext = '.js';
          mimeType = 'application/javascript';
        } else if (type === 'other') {
          ext = '.bin';
          mimeType = 'application/octet-stream';
        } else {
          ext = '.txt';
          mimeType = 'text/plain';
        }
      }
    }

    if (!finalName.toLowerCase().endsWith(ext)) {
      finalName += ext;
    }

    const uniqueFilename = crypto.randomUUID() + ext;
    const physicalPath = path.join(UPLOADS_DIR, uniqueFilename);
    
    let fileSize = 0;
    if (templateFile && fs.existsSync(templateFile)) {
      fs.copyFileSync(templateFile, physicalPath);
      fileSize = fs.statSync(physicalPath).size;
    } else {
      fs.writeFileSync(physicalPath, '');
    }

    const result = await pool.query(
      `INSERT INTO files (name, path, mime_type, size, is_folder, parent_id, owner_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [finalName, uniqueFilename, mimeType, fileSize, false, parsedParentId, userId]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating empty file:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a self-destructing one-time note file and automatic share link
app.post('/api/files/create-note', requireAuth, async (req, res) => {
  const { name, content, maxViews, expiresHours, parentId } = req.body;
  const userId = req.session.userId;
  const parsedParentId = parentId ? parseInt(parentId) : null;

  if (!name || content === undefined) {
    return res.status(400).json({ error: 'Benutzername und Inhalt sind erforderlich.' });
  }

  try {
    if (parsedParentId !== null) {
      const isOwner = await verifyFileOwner(parsedParentId, userId);
      if (!isOwner) return res.status(403).json({ error: 'Access denied' });
    }

    const cleanName = name.trim().endsWith('.txt') ? name.trim() : name.trim() + '.txt';
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + (parseInt(expiresHours) || 24));

    // Generate unique physical filename
    const uniqueFilename = crypto.randomUUID() + '.txt';
    const physicalPath = path.join(UPLOADS_DIR, uniqueFilename);
    
    // Write note text to physical file
    fs.writeFileSync(physicalPath, content, 'utf8');
    const size = Buffer.byteLength(content, 'utf8');

    // Insert file record
    const fileRes = await pool.query(
      `INSERT INTO files (name, path, mime_type, size, is_folder, parent_id, owner_id, is_one_time_note, content)
       VALUES ($1, $2, $3, $4, false, $5, $6, true, $7) RETURNING id`,
      [cleanName, uniqueFilename, 'text/plain', size, parsedParentId, userId, content]
    );
    const fileId = fileRes.rows[0].id;

    // Generate unique slug
    const slug = crypto.randomBytes(8).toString('hex');

    // Create share record
    await pool.query(
      `INSERT INTO shares (slug, file_id, can_read, can_write, can_download, can_zip, expires_at, max_downloads, download_count)
       VALUES ($1, $2, true, false, true, false, $3, $4, 0)`,
      [slug, fileId, expiresAt, parseInt(maxViews) || 1]
    );

    const shareLink = `${EXPECTED_ORIGIN}/s/${slug}`;
    res.json({ success: true, shareLink });
  } catch (err) {
    console.error('Error creating one-time note:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Get text file content
app.get('/api/files/content/:id', requireAuth, async (req, res) => {
  const fileId = parseInt(req.params.id);
  const userId = req.session.userId;

  try {
    const isOwner = await verifyFileOwner(fileId, userId);
    if (!isOwner) return res.status(403).json({ error: 'Access denied' });

    const fileRes = await pool.query('SELECT * FROM files WHERE id = $1', [fileId]);
    const file = fileRes.rows[0];
    if (file.is_folder) return res.status(400).json({ error: 'Folders do not have text content' });

    const filePath = path.join(UPLOADS_DIR, file.path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Physical file not found' });

    const content = fs.readFileSync(filePath, 'utf8');
    res.type('text/plain').send(content);
  } catch (err) {
    console.error('Error reading file content:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Save text file content
app.put('/api/files/content/:id', requireAuth, requirePermission('edit_files'), async (req, res) => {
  const fileId = parseInt(req.params.id);
  const userId = req.session.userId;
  const { content } = req.body;

  if (content === undefined) return res.status(400).json({ error: 'Content is required' });

  try {
    const isOwner = await verifyFileOwner(fileId, userId);
    if (!isOwner) return res.status(403).json({ error: 'Access denied' });

    const fileRes = await pool.query('SELECT * FROM files WHERE id = $1', [fileId]);
    const file = fileRes.rows[0];
    if (file.is_folder) return res.status(400).json({ error: 'Folders do not have text content' });

    const filePath = path.join(UPLOADS_DIR, file.path);
    fs.writeFileSync(filePath, content);
    const stats = fs.statSync(filePath);

    await pool.query('UPDATE files SET size = $1, content = $2 WHERE id = $3', [stats.size, content, fileId]);

    res.json({ success: true, size: stats.size });
  } catch (err) {
    console.error('Error saving file content:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const THUMBNAILS_DIR = path.join(UPLOADS_DIR, 'thumbnails');
if (!fs.existsSync(THUMBNAILS_DIR)) {
  fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
}

// Helper to generate a thumbnail using ffmpeg or dcraw/exiftool
function generateThumbnail(physicalFilename, extension) {
  return new Promise((resolve) => {
    const inputPath = path.join(UPLOADS_DIR, physicalFilename);
    const outputPath = path.join(THUMBNAILS_DIR, physicalFilename + '.jpg');

    if (fs.existsSync(outputPath)) {
      return resolve(outputPath);
    }

    const lowerExt = extension.toLowerCase();
    
    // Check if it's a video
    const videoExts = ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'm4v'];
    // Check if it's a RAW image
    const rawExts = ['cr2', 'nef', 'dng', 'arw', 'orf', 'rw2', 'pef', 'raf'];

    if (videoExts.includes(lowerExt)) {
      // Generate video thumbnail using ffmpeg
      const { exec } = require('child_process');
      const cmd = `ffmpeg -y -i "${inputPath}" -ss 00:00:01 -vframes 1 -f image2 -vcodec mjpeg "${outputPath}"`;
      exec(cmd, (err) => {
        if (err) {
          console.error(`ffmpeg failed for ${physicalFilename}:`, err);
          return resolve(null);
        }
        resolve(outputPath);
      });
    } else if (rawExts.includes(lowerExt)) {
      // Extract RAW embedded preview using exiftool (supports all raw formats)
      const { exec } = require('child_process');
      const cmd = `exiftool -b -PreviewImage "${inputPath}" > "${outputPath}" || exiftool -b -ThumbnailImage "${inputPath}" > "${outputPath}" || exiftool -b -JpgFromRaw "${inputPath}" > "${outputPath}"`;
      exec(cmd, (err) => {
        if (!err && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          return resolve(outputPath);
        }
        console.error(`exiftool failed for ${physicalFilename}:`, err);
        resolve(null);
      });
    } else {
      resolve(null);
    }
  });
}

// Get file thumbnail
app.get('/api/files/thumbnail/:id', requireAuth, async (req, res) => {
  const fileId = parseInt(req.params.id);
  const userId = req.session.userId;

  try {
    const fileRes = await pool.query('SELECT * FROM files WHERE id = $1', [fileId]);
    if (fileRes.rows.length === 0) return res.status(404).json({ error: 'File not found' });

    const file = fileRes.rows[0];
    if (file.owner_id !== userId) return res.status(403).json({ error: 'Access denied' });
    if (file.is_folder) return res.status(400).json({ error: 'Cannot generate folder thumbnail' });

    const ext = file.name.split('.').pop().toLowerCase();
    const filePath = path.join(UPLOADS_DIR, file.path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Physical file not found' });

    // Standard web images are served directly. SVG is deliberately excluded — it's an XML
    // format that can embed <script>, and res.sendFile would serve it as image/svg+xml,
    // letting the browser execute an attacker-uploaded SVG inline as a "thumbnail".
    const webImageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'];
    if (webImageExts.includes(ext)) {
      return res.sendFile(filePath);
    }

    // Try to generate/serve thumbnail for video or RAW
    const thumbPath = await generateThumbnail(file.path, ext);
    if (thumbPath && fs.existsSync(thumbPath)) {
      return res.sendFile(thumbPath);
    }

    res.status(404).json({ error: 'Thumbnail not available' });
  } catch (err) {
    console.error('Thumbnail endpoint error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


/* ==========================================================================
   SHARING SYSTEM ROUTES
   ========================================================================== */

// Create a share link
app.post('/api/shares', requireAuth, requirePermission('share'), async (req, res) => {
  const { fileId, customSlug, canRead, canWrite, canDownload, canZip, expiresDays, password, maxDownloads, onlyUpload, canCollab } = req.body;
  const userId = req.session.userId;

  try {
    // Verify ownership of the file/folder
    const isOwner = await verifyFileOwner(fileId, userId);
    if (!isOwner) return res.status(403).json({ error: 'Access denied' });

    let slug = customSlug ? customSlug.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-') : '';
    if (!slug) {
      slug = crypto.randomBytes(8).toString('hex');
    }

    // Check slug uniqueness
    const slugCheck = await pool.query('SELECT id FROM shares WHERE slug = $1', [slug]);
    if (slugCheck.rows.length > 0) {
      return res.status(409).json({ error: 'This custom link slug is already taken.' });
    }

    let expiresAt = null;
    if (req.body.expiresAt) {
      expiresAt = new Date(req.body.expiresAt);
    } else if (expiresDays) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + parseInt(expiresDays));
    }

    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    const maxDownloadsVal = maxDownloads ? parseInt(maxDownloads) : null;
    const onlyUploadVal = onlyUpload === true;

    const result = await pool.query(
      `INSERT INTO shares (slug, file_id, can_read, can_write, can_download, can_zip, expires_at, password_hash, max_downloads, only_upload, can_collab)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [slug, fileId, canRead !== false, canWrite === true, canDownload !== false, canZip !== false, expiresAt, passwordHash, maxDownloadsVal, onlyUploadVal, canCollab === true]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating share:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update an existing share link
app.put('/api/shares/:id', requireAuth, async (req, res) => {
  const shareId = parseInt(req.params.id);
  const { customSlug, canRead, canWrite, canDownload, canZip, expiresDays, password, maxDownloads, onlyUpload, removePassword, canCollab } = req.body;
  const userId = req.session.userId;

  try {
    // Get share and file
    const shareRes = await pool.query('SELECT s.*, f.owner_id FROM shares s JOIN files f ON s.file_id = f.id WHERE s.id = $1', [shareId]);
    if (shareRes.rows.length === 0) {
      return res.status(404).json({ error: 'Share link not found' });
    }

    const share = shareRes.rows[0];
    if (share.owner_id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    let slug = share.slug;
    if (customSlug) {
      const cleanSlug = customSlug.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
      if (cleanSlug !== share.slug) {
        const slugCheck = await pool.query('SELECT id FROM shares WHERE slug = $1', [cleanSlug]);
        if (slugCheck.rows.length > 0) {
          return res.status(409).json({ error: 'This custom link slug is already taken.' });
        }
        slug = cleanSlug;
      }
    }

    let expiresAt = share.expires_at;
    if (req.body.expiresAt !== undefined) {
      expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
    } else if (expiresDays !== undefined) {
      if (expiresDays === null || expiresDays === '') {
        expiresAt = null;
      } else {
        expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + parseInt(expiresDays));
      }
    }

    let passwordHash = share.password_hash;
    if (removePassword) {
      passwordHash = null;
    } else if (password) {
      passwordHash = await bcrypt.hash(password, 10);
    }

    const maxDownloadsVal = (maxDownloads !== undefined) 
      ? (maxDownloads ? parseInt(maxDownloads) : null) 
      : share.max_downloads;

    const onlyUploadVal = (onlyUpload !== undefined)
      ? (onlyUpload === true)
      : share.only_upload;

    const canCollabVal = (canCollab !== undefined)
      ? (canCollab === true)
      : share.can_collab;

    const result = await pool.query(
      `UPDATE shares
       SET slug = $1, can_read = $2, can_write = $3, can_download = $4, can_zip = $5, expires_at = $6,
           password_hash = $7, max_downloads = $8, only_upload = $9, can_collab = $10
       WHERE id = $11 RETURNING *`,
      [slug, canRead !== false, canWrite === true, canDownload !== false, canZip !== false, expiresAt,
       passwordHash, maxDownloadsVal, onlyUploadVal, canCollabVal, shareId]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating share:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete a share
app.delete('/api/shares/:id', requireAuth, async (req, res) => {
  const shareId = parseInt(req.params.id);
  const userId = req.session.userId;

  try {
    const shareRes = await pool.query('SELECT s.*, f.owner_id FROM shares s JOIN files f ON s.file_id = f.id WHERE s.id = $1', [shareId]);
    if (shareRes.rows.length === 0) {
      return res.status(404).json({ error: 'Share not found' });
    }

    const share = shareRes.rows[0];
    if (share.owner_id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await pool.query('DELETE FROM shares WHERE id = $1', [shareId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting share:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bulk-delete multiple shares owned by the current user
app.post('/api/shares/bulk-delete', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];

  if (ids.length === 0) return res.status(400).json({ error: 'No share IDs provided' });

  try {
    // Only delete shares whose underlying file belongs to the current user
    const result = await pool.query(
      `DELETE FROM shares s
       USING files f
       WHERE s.file_id = f.id AND f.owner_id = $1 AND s.id = ANY($2::int[])`,
      [userId, ids]
    );
    res.json({ success: true, deleted: result.rowCount });
  } catch (err) {
    console.error('Error bulk-deleting shares:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bulk-update permissions/expiry/password for multiple shares at once.
// Only the fields present in `updates` are applied; the slug is intentionally not editable here.
app.post('/api/shares/bulk-update', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  const updates = req.body.updates || {};

  if (ids.length === 0) return res.status(400).json({ error: 'No share IDs provided' });

  try {
    // Restrict to shares the user actually owns
    const ownRes = await pool.query(
      `SELECT s.id FROM shares s JOIN files f ON s.file_id = f.id
       WHERE f.owner_id = $1 AND s.id = ANY($2::int[])`,
      [userId, ids]
    );
    const ownedIds = ownRes.rows.map(r => r.id);
    if (ownedIds.length === 0) return res.status(403).json({ error: 'Access denied' });

    const setClauses = [];
    const params = [];
    let p = 1;

    const addSet = (column, value) => {
      setClauses.push(`${column} = $${p++}`);
      params.push(value);
    };

    if (updates.canRead !== undefined) addSet('can_read', updates.canRead !== false);
    if (updates.canWrite !== undefined) addSet('can_write', updates.canWrite === true);
    if (updates.canDownload !== undefined) addSet('can_download', updates.canDownload !== false);
    if (updates.canZip !== undefined) addSet('can_zip', updates.canZip !== false);
    if (updates.onlyUpload !== undefined) addSet('only_upload', updates.onlyUpload === true);
    if (updates.canCollab !== undefined) addSet('can_collab', updates.canCollab === true);

    if (updates.expiresAt !== undefined) {
      addSet('expires_at', updates.expiresAt ? new Date(updates.expiresAt) : null);
    }

    if (updates.maxDownloads !== undefined) {
      addSet('max_downloads', updates.maxDownloads ? parseInt(updates.maxDownloads) : null);
    }

    if (updates.removePassword) {
      addSet('password_hash', null);
    } else if (updates.password) {
      addSet('password_hash', await bcrypt.hash(updates.password, 10));
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(ownedIds);
    await pool.query(
      `UPDATE shares SET ${setClauses.join(', ')} WHERE id = ANY($${p}::int[])`,
      params
    );

    res.json({ success: true, updated: ownedIds.length });
  } catch (err) {
    console.error('Error bulk-updating shares:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List all shares for current user
app.get('/api/shares', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  try {
    const result = await pool.query(
      `SELECT s.*, f.name as file_name, f.is_folder 
       FROM shares s 
       JOIN files f ON s.file_id = f.id 
       WHERE f.owner_id = $1`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching shares:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// EuroOffice Temporary Token Store
const officeTokens = new Map();

// Tokens are only ever pruned lazily when reused past expiry, never on the (common) success
// path — without this sweep the map grows without bound as more documents get opened.
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of officeTokens.entries()) {
    if (data.expires < now) officeTokens.delete(token);
  }
}, 10 * 60 * 1000);

// Helper to get Document Type for EuroOffice
function getOfficeDocType(ext) {
  if (['docx', 'doc', 'txt', 'odt', 'rtf', 'html'].includes(ext)) return 'word';
  if (['xlsx', 'xls', 'ods', 'csv'].includes(ext)) return 'cell';
  if (['pptx', 'ppt', 'odp'].includes(ext)) return 'slide';
  return 'word';
}

// Picks a random colour from the same palette used for code-editor collab cursors (COLLAB_COLORS,
// defined further down with the WebSocket collab setup), so each EuroOffice co-author gets a
// distinct highlight/cursor colour.
function pickRandomCollabColor() {
  return COLLAB_COLORS[Math.floor(Math.random() * COLLAB_COLORS.length)].replace('#', '');
}

// Get EuroOffice Config for editing
app.get('/api/eurooffice/config/:id', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const fileId = parseInt(req.params.id);

  try {
    // Get file info (must be owned by the requesting user)
    const fileRes = await pool.query(
      'SELECT * FROM files WHERE id = $1 AND owner_id = $2',
      [fileId, userId]
    );

    if (fileRes.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const file = fileRes.rows[0];
    if (file.is_folder) {
      return res.status(400).json({ error: 'Cannot open folder in editor' });
    }

    const ext = file.name.split('.').pop().toLowerCase();
    const supportedExts = ['docx', 'xlsx', 'pptx', 'txt', 'odt', 'ods', 'odp'];
    if (!supportedExts.includes(ext)) {
      return res.status(400).json({ error: 'Unsupported file format for editing' });
    }

    // Get current user details
    const userRes = await pool.query('SELECT username FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];

    // Generate temp download token
    const crypto = require('crypto');
    const token = crypto.randomBytes(16).toString('hex');
    officeTokens.set(token, {
      fileId: file.id,
      userId,
      expires: Date.now() + 10 * 60 * 1000 // 10 minutes
    });

    const docType = getOfficeDocType(ext);
    const internalAppUrl = 'http://app:3000'; // App name in Docker Compose network
    const publicOfficeUrl = process.env.EURO_OFFICE_PUBLIC_URL || 'http://localhost:8080';

    const config = {
      document: {
        fileType: ext,
        key: `file_${file.id}`,
        title: file.name,
        url: `${internalAppUrl}/api/eurooffice/download/${file.id}?token=${token}`
      },
      documentType: docType,
      editorConfig: {
        callbackUrl: `${internalAppUrl}/api/eurooffice/callback/${file.id}?userId=${userId}`,
        user: {
          id: `${userId}`,
          name: user.username,
          color: pickRandomCollabColor()
        },
        mode: 'edit',
        lang: 'de'
      }
    };

    res.json({
      publicUrl: publicOfficeUrl,
      config
    });
  } catch (err) {
    console.error('Error generating office config:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Download endpoint for EuroOffice Document Server
app.get('/api/eurooffice/download/:id', async (req, res) => {
  const fileId = parseInt(req.params.id);
  const token = req.query.token;

  if (!token || !officeTokens.has(token)) {
    return res.status(403).json({ error: 'Forbidden: Invalid or expired token' });
  }

  const tokenData = officeTokens.get(token);
  if (tokenData.fileId !== fileId || tokenData.expires < Date.now()) {
    officeTokens.delete(token);
    return res.status(403).json({ error: 'Forbidden: Expired token' });
  }

  try {
    const fileRes = await pool.query('SELECT * FROM files WHERE id = $1', [fileId]);
    if (fileRes.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const file = fileRes.rows[0];
    const filePath = path.join(UPLOADS_DIR, file.path);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Physical file not found' });
    }

    res.sendFile(filePath);
  } catch (err) {
    console.error('Office download error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Callback endpoint for EuroOffice Document Server (handles saving)
app.post('/api/eurooffice/callback/:id', async (req, res) => {
  const fileId = parseInt(req.params.id);
  const { status, url } = req.body;

  // This endpoint has no user auth — it's called by the internal EuroOffice document server,
  // not a browser, so a session/token check isn't available here. Without this guard, anyone
  // on the internet could POST an arbitrary `url` and overwrite any file's content with
  // whatever that URL serves (SSRF + arbitrary file write). Restricting `url` to the document
  // server's own internal origin closes that off — we only ever fetch content the document
  // server itself is serving, never an attacker-supplied host.
  const internalOfficeOrigin = process.env.EURO_OFFICE_URL || 'http://eurooffice:80';

  if (status === 2 && url && url.startsWith(internalOfficeOrigin)) {
    try {
      const fileRes = await pool.query('SELECT * FROM files WHERE id = $1', [fileId]);
      if (fileRes.rows.length === 0) {
        return res.json({ error: 0 });
      }

      const file = fileRes.rows[0];
      const filePath = path.join(UPLOADS_DIR, file.path);

      const http = require('http');
      const https = require('https');
      const downloadClient = url.startsWith('https') ? https : http;

      downloadClient.get(url, (downloadRes) => {
        if (downloadRes.statusCode === 200) {
          const fileStream = fs.createWriteStream(filePath);
          downloadRes.pipe(fileStream);

          fileStream.on('finish', async () => {
            fileStream.close();
            
            const stats = fs.statSync(filePath);
            const textContent = await extractTextContent(filePath, file.mime_type, file.name);
            await pool.query(
              'UPDATE files SET size = $1, content = $2, updated_at = NOW() WHERE id = $3',
              [stats.size, textContent, fileId]
            );

            console.log(`Office document ${fileId} successfully saved. New size: ${stats.size} bytes.`);
          });
        } else {
          console.error(`Failed to download edited file from EuroOffice: status ${downloadRes.statusCode}`);
        }
      }).on('error', (err) => {
        console.error('Error downloading file from EuroOffice callback:', err);
      });

    } catch (err) {
      console.error('Callback save error:', err);
    }
  }

  res.json({ error: 0 });
});

// Get Branding Config
app.get('/api/public/branding', async (req, res) => {
  try {
    const name = await getSetting('cloud_name') || 'myCloud';
    const tabName = await getSetting('cloud_tab_name') || 'myCloud';
    const hasIcon = await getSetting('cloud_icon_path') ? true : false;
    const customColorBg = await getSetting('custom_color_bg') || '#0b0f19';
    const customColorAccent = await getSetting('custom_color_accent') || '#00d2ff';
    const hasDashboardBg = await getSetting('dashboard_bg_image') ? true : false;
    const hasLoginBg = await getSetting('login_bg_image') ? true : false;
    const hasDashboardBgLight = await getSetting('dashboard_bg_image_light') ? true : false;
    const hasLoginBgLight = await getSetting('login_bg_image_light') ? true : false;
    const appUrl = process.env.APP_URL || '';

    const smtpHost = await getSetting('email_smtp_host');
    const smtpTested = await getSetting('email_smtp_tested');
    const emailConfigured = (smtpHost && smtpTested === 'true') ? true : false;

    res.json({ name, tabName, hasIcon, customColorBg, customColorAccent, hasDashboardBg, hasLoginBg, hasDashboardBgLight, hasLoginBgLight, appUrl, emailConfigured });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Cloud Icon
app.get('/api/public/branding/icon', async (req, res) => {
  try {
    const iconPath = await getSetting('cloud_icon_path');
    if (iconPath) {
      const filePath = path.join(UPLOADS_DIR, iconPath);
      if (fs.existsSync(filePath)) {
        return res.sendFile(filePath);
      }
    }
    res.status(404).send('Icon not found');
  } catch (err) {
    res.status(500).send('Internal server error');
  }
});

// Get Dashboard Background
app.get('/api/public/branding/dashboard-bg', async (req, res) => {
  try {
    const key = req.query.variant === 'light' ? 'dashboard_bg_image_light' : 'dashboard_bg_image';
    const bgPath = await getSetting(key);
    if (bgPath) {
      const filePath = path.join(UPLOADS_DIR, bgPath);
      if (fs.existsSync(filePath)) {
        return res.sendFile(filePath);
      }
    }
    res.status(404).send('Background not found');
  } catch (err) {
    res.status(500).send('Internal server error');
  }
});

// Get Login Background
app.get('/api/public/branding/login-bg', async (req, res) => {
  try {
    const key = req.query.variant === 'light' ? 'login_bg_image_light' : 'login_bg_image';
    const bgPath = await getSetting(key);
    if (bgPath) {
      const filePath = path.join(UPLOADS_DIR, bgPath);
      if (fs.existsSync(filePath)) {
        return res.sendFile(filePath);
      }
    }
    res.status(404).send('Background not found');
  } catch (err) {
    res.status(500).send('Internal server error');
  }
});

// Upload Cloud Icon (Admin only)
app.post('/api/settings/admin/icon', requireAdmin, upload.single('icon'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No icon file provided.' });
  }

  try {
    const oldIcon = await getSetting('cloud_icon_path');
    await setSetting('cloud_icon_path', req.file.filename);

    if (oldIcon) {
      const oldFilePath = path.join(UPLOADS_DIR, oldIcon);
      if (fs.existsSync(oldFilePath)) {
        fs.unlinkSync(oldFilePath);
      }
    }

    res.json({ success: true, iconUrl: `/api/public/branding/icon?t=${Date.now()}` });
  } catch (err) {
    console.error('Error saving admin icon:', err);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Upload Dashboard Background (Admin only) — variant: dark (default) | light
app.post('/api/settings/admin/dashboard-bg', requireAdmin, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image provided.' });
  }
  try {
    const key = req.query.variant === 'light' ? 'dashboard_bg_image_light' : 'dashboard_bg_image';
    const oldBg = await getSetting(key);
    await setSetting(key, req.file.filename);

    if (oldBg) {
      const oldFilePath = path.join(UPLOADS_DIR, oldBg);
      if (fs.existsSync(oldFilePath)) {
        fs.unlinkSync(oldFilePath);
      }
    }
    res.json({ success: true, bgUrl: `/api/public/branding/dashboard-bg?variant=${req.query.variant === 'light' ? 'light' : 'dark'}&t=${Date.now()}` });
  } catch (err) {
    console.error('Error saving dashboard bg:', err);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/settings/admin/dashboard-bg', requireAdmin, async (req, res) => {
  try {
    const key = req.query.variant === 'light' ? 'dashboard_bg_image_light' : 'dashboard_bg_image';
    const oldBg = await getSetting(key);
    await setSetting(key, '');
    if (oldBg) {
      const oldFilePath = path.join(UPLOADS_DIR, oldBg);
      if (fs.existsSync(oldFilePath)) {
        fs.unlinkSync(oldFilePath);
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Upload Login Background (Admin only) — variant: dark (default) | light
app.post('/api/settings/admin/login-bg', requireAdmin, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image provided.' });
  }
  try {
    const key = req.query.variant === 'light' ? 'login_bg_image_light' : 'login_bg_image';
    const oldBg = await getSetting(key);
    await setSetting(key, req.file.filename);

    if (oldBg) {
      const oldFilePath = path.join(UPLOADS_DIR, oldBg);
      if (fs.existsSync(oldFilePath)) {
        fs.unlinkSync(oldFilePath);
      }
    }
    res.json({ success: true, bgUrl: `/api/public/branding/login-bg?variant=${req.query.variant === 'light' ? 'light' : 'dark'}&t=${Date.now()}` });
  } catch (err) {
    console.error('Error saving login bg:', err);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/settings/admin/login-bg', requireAdmin, async (req, res) => {
  try {
    const key = req.query.variant === 'light' ? 'login_bg_image_light' : 'login_bg_image';
    const oldBg = await getSetting(key);
    await setSetting(key, '');
    if (oldBg) {
      const oldFilePath = path.join(UPLOADS_DIR, oldBg);
      if (fs.existsSync(oldFilePath)) {
        fs.unlinkSync(oldFilePath);
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public Share API - Fetch share metadata & files
app.get('/api/public/shares/:slug', async (req, res) => {
  const { slug } = req.params;
  const parentId = req.query.parentId && req.query.parentId !== 'null' ? parseInt(req.query.parentId) : null;

  try {
    const shareRes = await pool.query('SELECT * FROM shares WHERE slug = $1', [slug]);
    if (shareRes.rows.length === 0) {
      return res.status(404).json({ error: 'Share link not found.' });
    }

    const share = shareRes.rows[0];
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This share link has expired.' });
    }

    // Check download limit
    if (share.max_downloads !== null && share.download_count >= share.max_downloads) {
      return res.status(410).json({ error: 'This share has reached its download limit.' });
    }

    // Get the base file/folder shared
    const baseFileRes = await pool.query('SELECT id, name, is_folder, owner_id, size FROM files WHERE id = $1', [share.file_id]);
    if (baseFileRes.rows.length === 0) {
      return res.status(404).json({ error: 'Shared content no longer exists.' });
    }

    const baseFile = baseFileRes.rows[0];

    // Check password protection
    const isUnlocked = req.session.unlockedShares && req.session.unlockedShares[slug];
    if (share.password_hash && !isUnlocked) {
      return res.json({
        share: {
          slug: share.slug,
          passwordRequired: true,
        },
        baseFile: {
          id: baseFile.id,
          name: baseFile.is_folder ? 'Geschützter Ordner' : 'Geschützte Datei',
          is_folder: baseFile.is_folder,
        }
      });
    }

    // Determine current folder we are viewing
    let currentFolderId = baseFile.id;
    if (parentId !== null) {
      // Validate that parentId is a child of the base shared folder
      let checkParentId = parentId;
      let isValidChild = false;
      
      while (checkParentId !== null) {
        if (checkParentId === baseFile.id) {
          isValidChild = true;
          break;
        }
        const checkRes = await pool.query('SELECT parent_id FROM files WHERE id = $1', [checkParentId]);
        if (checkRes.rows.length === 0) break;
        checkParentId = checkRes.rows[0].parent_id;
      }

      if (!isValidChild) {
        return res.status(403).json({ error: 'Access denied.' });
      }
      currentFolderId = parentId;
    }

    // List files inside the current folder
    let files = [];
    if (share.only_upload && baseFile.is_folder) {
      // "Only Upload" Mode: Return empty list, user can't see files
      files = [];
    } else if (baseFile.is_folder) {
      const filesRes = await pool.query(
        `WITH RECURSIVE folder_sizes AS (
           SELECT id, size, parent_id
           FROM files
           WHERE is_folder = false
           
           UNION ALL
           
           SELECT f.id, fs.size, f.parent_id
           FROM files f
           JOIN folder_sizes fs ON f.id = fs.parent_id
         )
         SELECT f.id, f.name, COALESCE(f.size, sz.total_size, 0) as size, f.is_folder, f.mime_type, f.created_at, f.parent_id 
         FROM files f
         LEFT JOIN (
           SELECT id, SUM(size) as total_size
           FROM folder_sizes
           GROUP BY id
         ) sz ON f.id = sz.id
         WHERE f.parent_id = $1 
         ORDER BY f.is_folder DESC, f.name ASC`,
        [currentFolderId]
      );
      files = filesRes.rows;
    } else {
      files = share.only_upload ? [] : [baseFile];
    }

    res.json({
      share: {
        slug: share.slug,
        can_read: share.can_read,
        can_write: share.can_write,
        can_download: share.can_download,
        can_zip: share.can_zip,
        expires_at: share.expires_at,
        only_upload: share.only_upload,
        can_collab: share.can_collab,
      },
      baseFile: {
        id: baseFile.id,
        name: baseFile.name,
        is_folder: baseFile.is_folder,
        size: baseFile.size,
      },
      currentFolderId,
      files,
    });
  } catch (err) {
    console.error('Error fetching public share:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unlock password protected share
app.post('/api/public/shares/:slug/unlock', async (req, res) => {
  const { slug } = req.params;
  const { password } = req.body;

  try {
    const shareRes = await pool.query('SELECT * FROM shares WHERE slug = $1', [slug]);
    if (shareRes.rows.length === 0) {
      return res.status(404).json({ error: 'Share link not found.' });
    }

    const share = shareRes.rows[0];
    if (!share.password_hash) {
      return res.json({ success: true, message: 'Share is not password protected.' });
    }

    const isValid = await bcrypt.compare(password || '', share.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Falsches Passwort.' });
    }

    req.session.unlockedShares = req.session.unlockedShares || {};
    req.session.unlockedShares[slug] = true;

    res.json({ success: true });
  } catch (err) {
    console.error('Error unlocking share:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Helper to increment download count and check if a file/share should self-destruct
async function incrementDownloadCountAndCheckSelfDestruct(shareId) {
  try {
    // Atomic increment bounded by max_downloads (a plain read-then-write let concurrent
    // requests all pass the limit check before any of them recorded their download).
    const shareRes = await pool.query(
      `UPDATE shares SET download_count = download_count + 1
       WHERE id = $1 AND (max_downloads IS NULL OR download_count < max_downloads)
       RETURNING *`,
      [shareId]
    );
    if (shareRes.rows.length === 0) return;
    const share = shareRes.rows[0];

    const fileRes = await pool.query('SELECT * FROM files WHERE id = $1', [share.file_id]);
    if (fileRes.rows.length === 0) return;
    const file = fileRes.rows[0];

    // Self-destruct is specifically for one-time notes (always a single file, never a folder).
    // It must NOT also fire just because a share's overall download limit was reached — for a
    // folder share that would delete the entire shared folder tree (files.parent_id cascades)
    // the moment the cap is hit, not just stop further downloads. The counter check at the top
    // of every share route already stops further downloads once the limit is reached; no
    // deletion is needed for that case.
    if (file.is_one_time_note && !file.is_folder) {
      const filePath = path.join(UPLOADS_DIR, file.path);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      // Cascades automatically to delete corresponding share record
      await pool.query('DELETE FROM files WHERE id = $1', [file.id]);
      console.log(`Self-destructed one-time note ${file.name} (ID: ${file.id})`);
    }
  } catch (err) {
    console.error('Self-destruct check error:', err);
  }
}

// Helper for public share validation
async function verifyPublicShareAccess(slug, fileId, req) {
  const shareRes = await pool.query('SELECT * FROM shares WHERE slug = $1', [slug]);
  if (shareRes.rows.length === 0) return { error: 'Share link not found.', status: 404 };

  const share = shareRes.rows[0];
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return { error: 'Share has expired.', status: 410 };
  }

  // Check password protection
  const isUnlocked = req.session.unlockedShares && req.session.unlockedShares[slug];
  if (share.password_hash && !isUnlocked) {
    return { error: 'Password required.', status: 401 };
  }

  if (!share.can_read) {
    return { error: 'Read access denied.', status: 403 };
  }

  // "Only upload" shares are a blind dropbox — visitors may drop files in but must not be able
  // to see/read anything back (including files other visitors dropped in the same folder).
  if (share.only_upload) {
    return { error: 'This share only accepts uploads.', status: 403 };
  }

  // Verify fileId is either the shared file/folder or a descendant
  const fileRes = await pool.query('SELECT * FROM files WHERE id = $1', [parseInt(fileId)]);
  if (fileRes.rows.length === 0) return { error: 'File not found.', status: 404 };

  const file = fileRes.rows[0];
  let checkId = file.id;
  let isValid = false;

  while (checkId !== null) {
    if (checkId === share.file_id) {
      isValid = true;
      break;
    }
    const checkRes = await pool.query('SELECT parent_id FROM files WHERE id = $1', [checkId]);
    if (checkRes.rows.length === 0) break;
    checkId = checkRes.rows[0].parent_id;
  }

  if (!isValid) return { error: 'Access denied.', status: 403 };

  return { file, share };
}

// Get public share text file content
app.get('/api/public/shares/:slug/content/:fileId', async (req, res) => {
  const { slug, fileId } = req.params;

  try {
    const access = await verifyPublicShareAccess(slug, fileId, req);
    if (access.error) return res.status(access.status).json({ error: access.error });

    const { file, share } = access;
    if (file.is_folder) return res.status(400).json({ error: 'Folders do not have text content' });

    const filePath = path.join(UPLOADS_DIR, file.path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Physical file not found' });

    const content = fs.readFileSync(filePath, 'utf8');
    res.type('text/plain').send(content);

    // Increment and check self-destruction after content is fully sent
    res.on('finish', async () => {
      await incrementDownloadCountAndCheckSelfDestruct(share.id);
    });
  } catch (err) {
    console.error('Public content fetch error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Save public share text file content
app.put('/api/public/shares/:slug/content/:fileId', async (req, res) => {
  const { slug, fileId } = req.params;
  const { content } = req.body;

  if (content === undefined) return res.status(400).json({ error: 'Content is required' });

  try {
    const access = await verifyPublicShareAccess(slug, fileId, req);
    if (access.error) return res.status(access.status).json({ error: access.error });

    const { file, share } = access;
    if (!share.can_write) return res.status(403).json({ error: 'Write permission denied.' });
    if (file.is_folder) return res.status(400).json({ error: 'Folders do not have text content' });

    const filePath = path.join(UPLOADS_DIR, file.path);
    fs.writeFileSync(filePath, content);
    const stats = fs.statSync(filePath);

    await pool.query('UPDATE files SET size = $1 WHERE id = $2', [stats.size, file.id]);

    res.json({ success: true, size: stats.size });
  } catch (err) {
    console.error('Public content save error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Get EuroOffice config for collaborative editing via a public share link
app.get('/api/public/shares/:slug/eurooffice/config/:fileId', async (req, res) => {
  const { slug, fileId } = req.params;

  try {
    const access = await verifyPublicShareAccess(slug, fileId, req);
    if (access.error) return res.status(access.status).json({ error: access.error });

    const { file, share } = access;
    if (!share.can_collab) return res.status(403).json({ error: 'Collaborative editing is not enabled for this share.' });
    if (file.is_folder) return res.status(400).json({ error: 'Cannot open folder in editor' });

    const ext = file.name.split('.').pop().toLowerCase();
    const supportedExts = ['docx', 'xlsx', 'pptx', 'txt', 'odt', 'ods', 'odp'];
    if (!supportedExts.includes(ext)) {
      return res.status(400).json({ error: 'Unsupported file format for editing' });
    }

    const guestId = `guest_${crypto.randomBytes(4).toString('hex')}`;
    const guestName = COLLAB_ANIMALS[Math.floor(Math.random() * COLLAB_ANIMALS.length)];

    const token = crypto.randomBytes(16).toString('hex');
    officeTokens.set(token, {
      fileId: file.id,
      userId: null,
      expires: Date.now() + 10 * 60 * 1000
    });

    const docType = getOfficeDocType(ext);
    const internalAppUrl = 'http://app:3000';
    const publicOfficeUrl = process.env.EURO_OFFICE_PUBLIC_URL || 'http://localhost:8080';

    const config = {
      document: {
        fileType: ext,
        key: `file_${file.id}`,
        title: file.name,
        url: `${internalAppUrl}/api/eurooffice/download/${file.id}?token=${token}`
      },
      documentType: docType,
      editorConfig: {
        callbackUrl: `${internalAppUrl}/api/eurooffice/callback/${file.id}`,
        user: {
          id: guestId,
          name: guestName,
          color: pickRandomCollabColor()
        },
        // Reaching this point already required share.can_collab === true (checked above), so
        // anyone with the link can edit — collaborative editing shouldn't need a second,
        // separate "Bearbeiten & Speichern" permission on top of it.
        mode: 'edit',
        lang: 'de'
      }
    };

    res.json({ publicUrl: publicOfficeUrl, config });
  } catch (err) {
    console.error('Error generating public office config:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get public share file thumbnail
app.get('/api/public/shares/:slug/thumbnail/:fileId', async (req, res) => {
  const { slug, fileId } = req.params;

  try {
    const access = await verifyPublicShareAccess(slug, fileId, req);
    if (access.error) return res.status(access.status).json({ error: access.error });

    const { file } = access;
    if (file.is_folder) return res.status(400).json({ error: 'Cannot generate folder thumbnail' });

    const ext = file.name.split('.').pop().toLowerCase();
    const filePath = path.join(UPLOADS_DIR, file.path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Physical file not found' });

    // Standard web images are served directly. SVG is deliberately excluded — it's an XML
    // format that can embed <script>, and res.sendFile would serve it as image/svg+xml,
    // letting the browser execute an attacker-uploaded SVG inline as a "thumbnail".
    const webImageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'];
    if (webImageExts.includes(ext)) {
      return res.sendFile(filePath);
    }

    // Try to generate/serve thumbnail for video or RAW
    const thumbPath = await generateThumbnail(file.path, ext);
    if (thumbPath && fs.existsSync(thumbPath)) {
      return res.sendFile(thumbPath);
    }

    res.status(404).json({ error: 'Thumbnail not available' });
  } catch (err) {
    console.error('Public thumbnail endpoint error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});


// Public Share Download - Single file
app.get('/api/public/shares/:slug/download/:fileId', async (req, res) => {
  const { slug, fileId } = req.params;

  try {
    const access = await verifyPublicShareAccess(slug, fileId, req);
    if (access.error) return res.status(access.status).json({ error: access.error });

    const { file, share } = access;
    if (!share.can_download) return res.status(403).json({ error: 'Download permissions denied.' });

    // Check download limit
    if (share.max_downloads !== null && share.download_count >= share.max_downloads) {
      return res.status(410).json({ error: 'This share has reached its download limit.' });
    }

    if (file.is_folder) return res.status(400).json({ error: 'Cannot download folder.' });

    const filePath = path.join(UPLOADS_DIR, file.path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Physical file not found.' });

    if (req.query.inline === 'true') {
      let mimeType = file.mime_type;
      if (!mimeType) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (ext === 'pdf') {
          mimeType = 'application/pdf';
        } else {
          mimeType = 'application/octet-stream';
        }
      }

      return res.sendFile(filePath, {
        headers: {
          'Content-Type': mimeType,
          'Content-Disposition': 'inline; filename="' + encodeURIComponent(file.name) + '"'
        }
      }, async (err) => {
        if (!err) {
          await incrementDownloadCountAndCheckSelfDestruct(share.id);
        }
      });
    }

    // Increment download count and check self-destruct after download completes
    res.download(filePath, file.name, async (err) => {
      if (!err) {
        await incrementDownloadCountAndCheckSelfDestruct(share.id);
      }
    });
  } catch (err) {
    console.error('Public download error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Public Share Upload - Allow uploads to shared folder if write permission exists
app.post('/api/public/shares/:slug/upload', upload.single('file'), async (req, res) => {
  const { slug } = req.params;
  const parentId = req.body.parentId ? parseInt(req.body.parentId) : null;

  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  try {
    const shareRes = await pool.query('SELECT * FROM shares WHERE slug = $1', [slug]);
    if (shareRes.rows.length === 0) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Share link not found.' });
    }

    const share = shareRes.rows[0];
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      fs.unlinkSync(req.file.path);
      return res.status(410).json({ error: 'Share has expired.' });
    }
    if (!share.can_write) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'Upload permissions denied.' });
    }

    // Check password protection
    const isUnlocked = req.session.unlockedShares && req.session.unlockedShares[slug];
    if (share.password_hash && !isUnlocked) {
      fs.unlinkSync(req.file.path);
      return res.status(401).json({ error: 'Password required.' });
    }

    // Verify parentId is descendant of shared folder
    const baseFileRes = await pool.query('SELECT id, owner_id FROM files WHERE id = $1', [share.file_id]);
    const baseFile = baseFileRes.rows[0];

    let targetFolderId = parentId !== null ? parentId : baseFile.id;
    let checkId = targetFolderId;
    let isValid = false;

    while (checkId !== null) {
      if (checkId === baseFile.id) {
        isValid = true;
        break;
      }
      const checkRes = await pool.query('SELECT parent_id FROM files WHERE id = $1', [checkId]);
      if (checkRes.rows.length === 0) break;
      checkId = checkRes.rows[0].parent_id;
    }

    if (!isValid) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'Access denied.' });
    }

    const result = await pool.query(
      `INSERT INTO files (name, path, mime_type, size, is_folder, parent_id, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.file.originalname, req.file.filename, getSafeMimeType(req.file.originalname), req.file.size, false, targetFolderId, baseFile.owner_id]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Public upload error:', err);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Public Share ZIP Download
app.get('/api/public/shares/:slug/download-zip/:folderId', async (req, res) => {
  const { slug, folderId } = req.params;

  try {
    const access = await verifyPublicShareAccess(slug, folderId, req);
    if (access.error) return res.status(access.status).json({ error: access.error });

    const { file: targetFolder, share } = access;
    if (!targetFolder.is_folder) return res.status(404).json({ error: 'Folder not found.' });
    if (!share.can_zip) return res.status(403).json({ error: 'ZIP Download permissions denied.' });

    // Check download limit
    if (share.max_downloads !== null && share.download_count >= share.max_downloads) {
      return res.status(410).json({ error: 'This share has reached its download limit.' });
    }

    // Increment download count atomically, bounded by max_downloads (a plain
    // read-then-write let concurrent requests all pass the limit check above at once).
    await pool.query(
      `UPDATE shares SET download_count = download_count + 1
       WHERE id = $1 AND (max_downloads IS NULL OR download_count < max_downloads)`,
      [share.id]
    );

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(targetFolder.name)}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => { throw err; });
    archive.pipe(res);

    const baseFileRes = await pool.query('SELECT owner_id FROM files WHERE id = $1', [share.file_id]);
    const ownerId = baseFileRes.rows[0].owner_id;

    await addFolderToZip(archive, targetFolder.id, '', ownerId);
    await archive.finalize();
  } catch (err) {
    console.error('Public ZIP download error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create ZIP.' });
    }
  }
});

/* ==========================================================================
   SETTINGS & ADMIN PANEL ROUTES
   ========================================================================== */

// Upload Avatar
app.post('/api/settings/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided.' });
  }

  const userId = req.session.userId;

  // Verify it is an image
  const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif'];
  if (!allowedMimeTypes.includes(req.file.mimetype)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Only JPEG, PNG, or GIF images are allowed.' });
  }

  // Max size 2MB
  if (req.file.size > 2 * 1024 * 1024) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Image size must be less than 2 MB.' });
  }

  try {
    // Get old avatar path
    const oldAvatarRes = await pool.query('SELECT avatar_path FROM users WHERE id = $1', [userId]);
    const oldAvatarPath = oldAvatarRes.rows[0]?.avatar_path;

    // Save new avatar path in DB
    await pool.query('UPDATE users SET avatar_path = $1 WHERE id = $2', [req.file.filename, userId]);

    // Delete old avatar file from disk if it exists
    if (oldAvatarPath) {
      const oldFilePath = path.join(UPLOADS_DIR, oldAvatarPath);
      if (fs.existsSync(oldFilePath)) {
        fs.unlinkSync(oldFilePath);
      }
    }

    res.json({ success: true, avatarUrl: `/api/users/${userId}/avatar?t=${Date.now()}` });
  } catch (err) {
    console.error('Error saving avatar:', err);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get User Avatar
app.get('/api/users/:id/avatar', async (req, res) => {
  const userId = parseInt(req.params.id);

  try {
    const userRes = await pool.query('SELECT username, avatar_path FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) {
      return res.status(404).send('User not found');
    }

    const user = userRes.rows[0];
    if (user.avatar_path) {
      const filePath = path.join(UPLOADS_DIR, user.avatar_path);
      if (fs.existsSync(filePath)) {
        return res.sendFile(filePath);
      }
    }

    // Fallback: Generate Initial SVG Avatar using Accent colors from CSS
    const initials = user.username.charAt(0).toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
      <rect width="100" height="100" fill="#161f30" rx="50"/>
      <text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" font-family="'Outfit', sans-serif" font-size="45" font-weight="700" fill="#00d2ff">${initials}</text>
    </svg>`;
    
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch (err) {
    console.error('Error fetching avatar:', err);
    res.status(500).send('Internal server error');
  }
});

// Get settings (User profile and config)
app.get('/api/settings', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  try {
    const userRes = await pool.query('SELECT id, username, role, email, first_name, last_name, display_real_name, two_factor_email, two_factor_totp FROM users WHERE id = $1', [userId]);
    const passkeysRes = await pool.query('SELECT id, name, created_at FROM passkeys WHERE user_id = $1', [userId]);
    
    const smtpHost = await getSetting('email_smtp_host');
    const smtpTested = await getSetting('email_smtp_tested');
    const emailConfigured = (smtpHost && smtpTested === 'true') ? true : false;

    const data = {
      user: userRes.rows[0],
      passkeys: passkeysRes.rows,
      emailConfigured: emailConfigured
    };

    if (req.session.role === 'admin') {
      data.adminConfig = await getAllSettings();
      // Remove sensitive SMTP password value to prevent exposing it (just indicate if set)
      if (data.adminConfig.email_smtp_pass) {
        data.adminConfig.email_smtp_pass_configured = true;
        delete data.adminConfig.email_smtp_pass;
      }
    }

    res.json(data);
  } catch (err) {
    console.error('Error fetching settings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* ─── API Keys (personal access tokens for external/app clients) ─── */

// List the current user's API keys (never returns the actual key, only metadata)
app.get('/api/settings/api-keys', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, key_prefix, created_at, last_used_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC',
      [req.session.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error listing API keys:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a new API key. The full key is only ever returned here — only its hash is stored.
app.post('/api/settings/api-keys', requireAuth, async (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 100) || 'API-Key';
  try {
    const token = `mcld_${crypto.randomBytes(24).toString('hex')}`;
    const keyPrefix = token.slice(0, 12);
    const keyHash = crypto.createHash('sha256').update(token).digest('hex');

    const result = await pool.query(
      `INSERT INTO api_keys (user_id, name, key_prefix, key_hash)
       VALUES ($1, $2, $3, $4) RETURNING id, name, key_prefix, created_at`,
      [req.session.userId, name, keyPrefix, keyHash]
    );

    res.status(201).json({ ...result.rows[0], key: token });
  } catch (err) {
    console.error('Error creating API key:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Revoke (delete) one of the current user's API keys
app.delete('/api/settings/api-keys/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM api_keys WHERE id = $1 AND user_id = $2 RETURNING id',
      [parseInt(req.params.id), req.session.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'API key not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Error revoking API key:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user storage consumption & quota & disk info
app.get('/api/users/storage', requireAuth, async (req, res) => {
  const userId = req.session.userId;

  try {
    // 1. Used space
    const usedRes = await pool.query('SELECT SUM(size) as total FROM files WHERE owner_id = $1 AND is_folder = false', [userId]);
    const usedBytes = parseInt(usedRes.rows[0].total || 0);

    // 2. User quota
    const userRes = await pool.query('SELECT storage_quota FROM users WHERE id = $1', [userId]);
    const quotaBytes = userRes.rows[0].storage_quota ? parseInt(userRes.rows[0].storage_quota) : null;

    // 3. Free disk space
    let freeDiskBytes = 0;
    try {
      const stats = fs.statfsSync('/');
      freeDiskBytes = stats.bsize * stats.bavail;
    } catch (diskErr) {
      console.error('Error reading disk stats:', diskErr);
    }

    res.json({
      usedBytes,
      quotaBytes,
      freeDiskBytes
    });
  } catch (err) {
    console.error('Error fetching user storage:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update Profile details
app.post('/api/settings/profile', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const { first_name, last_name, username, email, display_real_name } = req.body;

  if (!username || !email) {
    return res.status(400).json({ error: 'Benutzername und E-Mail sind erforderlich.' });
  }

  try {
    // Check conflicts
    const conflictRes = await pool.query(
      'SELECT id FROM users WHERE (username = $1 OR email = $2) AND id != $3',
      [username, email, userId]
    );

    if (conflictRes.rows.length > 0) {
      return res.status(400).json({ error: 'Benutzername oder E-Mail wird bereits von einem anderen Benutzer verwendet.' });
    }

    const result = await pool.query(
      `UPDATE users 
       SET first_name = $1, last_name = $2, username = $3, email = $4, display_real_name = $5
       WHERE id = $6 RETURNING id, username, role, email, first_name, last_name, display_real_name`,
      [first_name || null, last_name || null, username, email, !!display_real_name, userId]
    );

    // Update session cache
    req.session.username = username;

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('Error updating profile settings:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Post settings email
app.post('/api/settings/email', requireAuth, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  try {
    await pool.query('UPDATE users SET email = $1 WHERE id = $2', [email, req.session.userId]);
    res.json({ success: true, message: 'E-Mail-Adresse erfolgreich gespeichert.' });
  } catch (err) {
    console.error('Error updating email:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Toggle Email 2FA
app.post('/api/settings/2fa/email', requireAuth, async (req, res) => {
  const { enabled } = req.body;
  try {
    // Check if email is set
    const userRes = await pool.query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
    if (!userRes.rows[0].email && enabled) {
      return res.status(400).json({ error: 'Bitte hinterlege zuerst eine E-Mail-Adresse.' });
    }

    const smtpHost = await getSetting('email_smtp_host');
    const smtpTested = await getSetting('email_smtp_tested');
    const emailConfigured = (smtpHost && smtpTested === 'true') ? true : false;
    if (!emailConfigured && enabled) {
      return res.status(400).json({ error: 'E-Mail-2FA kann erst aktiviert werden, wenn der SMTP-Server eingerichtet und getestet ist.' });
    }

    await pool.query('UPDATE users SET two_factor_email = $1 WHERE id = $2', [enabled, req.session.userId]);
    res.json({ success: true, twoFactorEmail: enabled });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Setup TOTP 2FA (returns secret + qr-code url)
app.post('/api/settings/2fa/totp/setup', requireAuth, async (req, res) => {
  const speakeasy = require('speakeasy');
  try {
    const userRes = await pool.query('SELECT username FROM users WHERE id = $1', [req.session.userId]);
    const username = userRes.rows[0].username;

    const secret = speakeasy.generateSecret({
      name: `myCloud (${username})`,
      length: 20
    });

    req.session.tempTotpSecret = secret.base32;

    res.json({
      success: true,
      secret: secret.base32,
      otpauthUrl: secret.otpauth_url
    });
  } catch (err) {
    console.error('TOTP setup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Confirm TOTP 2FA setup
app.post('/api/settings/2fa/totp/confirm', requireAuth, async (req, res) => {
  const { code } = req.body;
  const tempSecret = req.session.tempTotpSecret;

  if (!tempSecret || !code) {
    return res.status(400).json({ error: 'Setup-Sitzung nicht gefunden oder Code fehlt.' });
  }

  const speakeasy = require('speakeasy');
  const verified = speakeasy.totp.verify({
    secret: tempSecret,
    encoding: 'base32',
    token: code,
    window: 1
  });

  if (!verified) {
    return res.status(400).json({ error: 'Ungültiger Code. Bitte versuche es erneut.' });
  }

  try {
    await pool.query(
      'UPDATE users SET two_factor_totp = true, totp_secret = $1 WHERE id = $2',
      [tempSecret, req.session.userId]
    );
    delete req.session.tempTotpSecret;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Disable TOTP 2FA
app.post('/api/settings/2fa/totp/disable', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE users SET two_factor_totp = false, totp_secret = null WHERE id = $1',
      [req.session.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Change password
app.post('/api/settings/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const userId = req.session.userId;

  try {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];

    if (user.sso_id) {
      return res.status(400).json({ error: 'Users managed by SSO cannot change their password locally.' });
    }

    const isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, userId]);

    res.json({ success: true, message: 'Password changed successfully.' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete user passkey
app.delete('/api/settings/passkeys/:id', requireAuth, async (req, res) => {
  const passkeyId = req.params.id;
  const userId = req.session.userId;

  try {
    const result = await pool.query('DELETE FROM passkeys WHERE id = $1 AND user_id = $2', [passkeyId, userId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Passkey not found or not owned by you.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting passkey:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper to update the .env file with new configurations
function updateEnvFile(configs) {
  // Locate the .env file in the application working directory (mounted from host)
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    console.log('.env file does not exist, skipping environment write.');
    return;
  }

  try {
    let content = fs.readFileSync(envPath, 'utf8');
    const lines = content.split('\n');

    // Mapping of DB config keys to .env variable names
    const mapping = {
      registration_enabled: 'REGISTRATION_ENABLED',
      sso_enabled: 'SSO_ENABLED',
      sso_issuer_url: 'SSO_ISSUER_URL',
      sso_client_id: 'SSO_CLIENT_ID',
      sso_client_secret: 'SSO_CLIENT_SECRET',
      email_smtp_host: 'EMAIL_SMTP_HOST',
      email_smtp_port: 'EMAIL_SMTP_PORT',
      email_smtp_user: 'EMAIL_SMTP_USER',
      email_smtp_pass: 'EMAIL_SMTP_PASS',
      email_from: 'EMAIL_FROM'
    };

    for (const [key, value] of Object.entries(configs)) {
      const envKey = mapping[key];
      if (!envKey) continue;

      let found = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith(`${envKey}=`)) {
          lines[i] = `${envKey}=${value}`;
          found = true;
          break;
        }
      }
      if (!found) {
        lines.push(`${envKey}=${value}`);
      }
    }

    fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
  } catch (err) {
    console.error('Error updating .env file:', err);
  }
}

// Update Admin Configuration settings
app.post('/api/settings/admin/config', requireAdmin, async (req, res) => {
  const configs = req.body;
  try {
    const keysChanged = Object.keys(configs);
    const smtpKeys = ['email_smtp_host', 'email_smtp_port', 'email_smtp_user', 'email_smtp_pass', 'email_from'];
    if (keysChanged.some(k => smtpKeys.includes(k))) {
      await setSetting('email_smtp_tested', 'false');
    }

    const activeConfigs = {};
    for (const [key, value] of Object.entries(configs)) {
      // Avoid overwriting password with placeholder
      if (key === 'email_smtp_pass' && value === '__placeholder__') {
        continue;
      }
      await setSetting(key, value);
      activeConfigs[key] = value;
    }

    // Write updates back to .env
    updateEnvFile(activeConfigs);

    res.json({ success: true, message: 'System configurations updated.' });
  } catch (err) {
    console.error('Error updating admin config:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin test SMTP connection
app.post('/api/settings/admin/test-smtp', requireAdmin, async (req, res) => {
  const { to } = req.body;
  if (!to) {
    return res.status(400).json({ error: 'Test email address is required.' });
  }

  const sent = await sendMail({
    to,
    subject: 'myCloud - SMTP Connection Test',
    text: 'If you receive this email, your myCloud SMTP mail configurations are working correctly!',
    html: '<h3>myCloud - SMTP Test</h3><p>If you receive this email, your myCloud SMTP mail configurations are working correctly!</p>'
  });

  if (sent) {
    await setSetting('email_smtp_tested', 'true');
    res.json({ success: true, message: `Test email sent to ${to}.` });
  } else {
    res.status(500).json({ error: 'SMTP connection failed. Check your SMTP configurations or logs.' });
  }
});

// Admin User-Management: List Users
app.get('/api/settings/admin/users', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.role, u.sso_provider, u.created_at, u.first_name, u.last_name, u.email, u.is_active, u.storage_quota,
       (SELECT COUNT(*) FROM files WHERE owner_id = u.id) as file_count,
       (SELECT COALESCE(SUM(size), 0) FROM files WHERE owner_id = u.id AND is_folder = false) as storage_used
       FROM users u ORDER BY u.username ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Admin list users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// The permission keys the UI exposes (single source of truth)
const ROLE_PERMISSION_KEYS = ['admin', 'upload', 'create_folder', 'delete', 'rename', 'share', 'download', 'edit_files'];

// Admin Role-Management: list roles with member counts & combined storage usage
app.get('/api/settings/admin/roles', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.name, r.is_default, r.is_system, r.permissions, r.storage_quota,
              (SELECT COUNT(*) FROM users u WHERE u.role = r.name) as member_count,
              (SELECT COALESCE(SUM(f.size), 0) FROM files f JOIN users u ON f.owner_id = u.id
                 WHERE u.role = r.name AND f.is_folder = false) as storage_used
       FROM roles r ORDER BY r.is_system DESC, r.name ASC`
    );
    res.json({ roles: result.rows, permissionKeys: ROLE_PERMISSION_KEYS });
  } catch (err) {
    console.error('Admin list roles error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin Role-Management: create a new role
app.post('/api/settings/admin/roles', requireAdmin, async (req, res) => {
  const { name, permissions, storageQuota } = req.body;
  const cleanName = (name || '').trim().toLowerCase();
  if (!cleanName || !/^[a-z0-9_-]{2,30}$/.test(cleanName)) {
    return res.status(400).json({ error: 'Ungültiger Rollenname (2–30 Zeichen: a–z, 0–9, _ und -).' });
  }
  try {
    const exists = await pool.query('SELECT id FROM roles WHERE name = $1', [cleanName]);
    if (exists.rows.length > 0) return res.status(400).json({ error: 'Diese Rolle existiert bereits.' });

    const perms = {};
    for (const k of ROLE_PERMISSION_KEYS) perms[k] = !!(permissions && permissions[k]);
    const quota = storageQuota ? parseInt(storageQuota) : null;

    const result = await pool.query(
      `INSERT INTO roles (name, is_default, is_system, permissions, storage_quota)
       VALUES ($1, false, false, $2, $3) RETURNING *`,
      [cleanName, JSON.stringify(perms), quota]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Admin create role error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin Role-Management: update a role's permissions / quota
app.put('/api/settings/admin/roles/:id', requireAdmin, async (req, res) => {
  const roleId = parseInt(req.params.id);
  const { permissions, storageQuota } = req.body;
  try {
    const roleRes = await pool.query('SELECT * FROM roles WHERE id = $1', [roleId]);
    if (roleRes.rows.length === 0) return res.status(404).json({ error: 'Rolle nicht gefunden.' });
    const role = roleRes.rows[0];

    const perms = {};
    for (const k of ROLE_PERMISSION_KEYS) perms[k] = !!(permissions && permissions[k]);
    // The built-in admin role must always keep full access
    if (role.name === 'admin') for (const k of ROLE_PERMISSION_KEYS) perms[k] = true;

    const quota = (storageQuota !== undefined && storageQuota !== null && storageQuota !== '')
      ? parseInt(storageQuota) : null;

    await pool.query('UPDATE roles SET permissions = $1, storage_quota = $2 WHERE id = $3',
      [JSON.stringify(perms), quota, roleId]);
    res.json({ success: true, message: 'Rolle aktualisiert.' });
  } catch (err) {
    console.error('Admin update role error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin Role-Management: set a role as the default for new sign-ups
app.post('/api/settings/admin/roles/:id/default', requireAdmin, async (req, res) => {
  const roleId = parseInt(req.params.id);
  try {
    const roleRes = await pool.query('SELECT name FROM roles WHERE id = $1', [roleId]);
    if (roleRes.rows.length === 0) return res.status(404).json({ error: 'Rolle nicht gefunden.' });
    await pool.query('UPDATE roles SET is_default = false');
    await pool.query('UPDATE roles SET is_default = true WHERE id = $1', [roleId]);
    res.json({ success: true, message: `Standardrolle auf "${roleRes.rows[0].name}" gesetzt.` });
  } catch (err) {
    console.error('Admin set default role error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin Role-Management: delete a role (members fall back to the default role)
app.delete('/api/settings/admin/roles/:id', requireAdmin, async (req, res) => {
  const roleId = parseInt(req.params.id);
  try {
    const roleRes = await pool.query('SELECT * FROM roles WHERE id = $1', [roleId]);
    if (roleRes.rows.length === 0) return res.status(404).json({ error: 'Rolle nicht gefunden.' });
    const role = roleRes.rows[0];
    if (role.is_system) return res.status(400).json({ error: 'System-Rollen können nicht gelöscht werden.' });

    // Reassign members to the current default role
    const defRes = await pool.query('SELECT name FROM roles WHERE is_default = true LIMIT 1');
    const fallback = (defRes.rows[0] && defRes.rows[0].name) || 'user';
    await pool.query('UPDATE users SET role = $1 WHERE role = $2', [fallback, role.name]);
    await pool.query('DELETE FROM roles WHERE id = $1', [roleId]);
    res.json({ success: true, message: `Rolle gelöscht. Mitglieder wurden auf "${fallback}" verschoben.` });
  } catch (err) {
    console.error('Admin delete role error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin User-Management: Create a new user
app.post('/api/settings/admin/users', requireAdmin, async (req, res) => {
  const { username, email, password, role } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Benutzername, E-Mail und Passwort sind erforderlich.' });
  }
  
  try {
    const conflictRes = await pool.query('SELECT id FROM users WHERE username = $1 OR email = $2', [username, email]);
    if (conflictRes.rows.length > 0) {
      return res.status(400).json({ error: 'Benutzername oder E-Mail existiert bereits.' });
    }
    
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);
    // Accept any existing role; fall back to the default role
    let targetRole = (role || '').trim();
    const roleCheck = await pool.query('SELECT name FROM roles WHERE name = $1', [targetRole]);
    if (roleCheck.rows.length === 0) {
      const defRes = await pool.query('SELECT name FROM roles WHERE is_default = true LIMIT 1');
      targetRole = (defRes.rows[0] && defRes.rows[0].name) || 'user';
    }

    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, role, is_verified, is_active)
       VALUES ($1, $2, $3, $4, true, true) RETURNING id, username, role, email`,
      [username, email, password_hash, targetRole]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Admin create user error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin User-Management: Update user / Block user / Delete user / Reset password
app.post('/api/settings/admin/users/:id', requireAdmin, async (req, res) => {
  const targetUserId = parseInt(req.params.id);
  const { action, role } = req.body;

  if (targetUserId === req.session.userId) {
    return res.status(400).json({ error: 'Du kannst keine Aktionen auf deinem eigenen Konto ausführen.' });
  }

  try {
    if (action === 'delete') {
      // Find files of user and remove physical files
      const filesRes = await pool.query('SELECT path FROM files WHERE owner_id = $1 AND is_folder = false', [targetUserId]);
      for (const file of filesRes.rows) {
        const filePath = path.join(UPLOADS_DIR, file.path);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
      
      await pool.query('DELETE FROM users WHERE id = $1', [targetUserId]);
      return res.json({ success: true, message: 'Benutzer und alle seine Dateien wurden gelöscht.' });
    } else if (action === 'quota') {
      const quotaBytes = req.body.quotaBytes !== undefined ? (req.body.quotaBytes ? parseInt(req.body.quotaBytes) : null) : null;
      await pool.query('UPDATE users SET storage_quota = $1 WHERE id = $2', [quotaBytes, targetUserId]);
      return res.json({ success: true, message: 'Speicherplatzlimit aktualisiert.' });
    } else if (action === 'role' && role) {
      const roleCheck = await pool.query('SELECT name FROM roles WHERE name = $1', [role]);
      if (roleCheck.rows.length === 0) return res.status(400).json({ error: 'Diese Rolle existiert nicht.' });
      await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, targetUserId]);
      return res.json({ success: true, message: 'Benutzerrolle aktualisiert.' });
    } else if (action === 'toggle-status') {
      const userRes = await pool.query('SELECT is_active FROM users WHERE id = $1', [targetUserId]);
      if (userRes.rows.length === 0) return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
      const currentActive = userRes.rows[0].is_active;
      const newActive = !currentActive;
      await pool.query('UPDATE users SET is_active = $1 WHERE id = $2', [newActive, targetUserId]);
      return res.json({ success: true, message: newActive ? 'Benutzer entsperrt.' : 'Benutzer gesperrt.' });
    } else if (action === 'reset-password') {
      const smtpHost = await getSetting('email_smtp_host');
      const smtpTested = await getSetting('email_smtp_tested');
      const emailConfigured = (smtpHost && smtpTested === 'true') ? true : false;
      if (!emailConfigured) {
        return res.status(400).json({ error: 'E-Mail-Server ist nicht eingerichtet oder getestet.' });
      }

      const userRes = await pool.query('SELECT username, email FROM users WHERE id = $1', [targetUserId]);
      if (userRes.rows.length === 0) return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
      const user = userRes.rows[0];
      if (!user.email) return res.status(400).json({ error: 'Dieser Benutzer hat keine E-Mail-Adresse hinterlegt.' });

      const tempPassword = crypto.randomBytes(6).toString('hex'); // 12 characters
      const saltRounds = 10;
      const hash = await bcrypt.hash(tempPassword, saltRounds);
      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, targetUserId]);

      await sendMail({
        to: user.email,
        subject: 'myCloud - Passwort zurückgesetzt',
        text: `Hallo ${user.username},\n\ndein Passwort wurde von einem Administrator zurückgesetzt.\nDein neues temporäres Passwort lautet: ${tempPassword}\n\nBitte melde dich an und ändere dein Passwort in den Einstellungen.`
      });

      return res.json({ success: true, message: 'Passwort erfolgreich zurückgesetzt und E-Mail versendet.' });
    }

    res.status(400).json({ error: 'Ungültige Admin-Aktion.' });
  } catch (err) {
    console.error('Admin user-action error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public share routing
app.get('/s/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

// SPA Route Fallback (serve main index.html for unknown routes)
app.get('*', (req, res) => {
  // If requesting file API routes or specific static files, don't fall back to HTML
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.includes('.')) {
    return res.status(404).send('Not Found');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Multer errors (e.g. exceeding MAX_UPLOAD_SIZE_BYTES) otherwise fall through to Express's
// default HTML error page instead of a clean JSON response.
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File is too large.' });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// Background cleanup task for expired shares and self-destruct notes
setInterval(async () => {
  try {
    const expiredSharesRes = await pool.query(
      'SELECT id, file_id, slug FROM shares WHERE expires_at IS NOT NULL AND expires_at < NOW()'
    );
    
    for (const share of expiredSharesRes.rows) {
      const fileRes = await pool.query('SELECT * FROM files WHERE id = $1', [share.file_id]);
      if (fileRes.rows.length > 0) {
        const file = fileRes.rows[0];
        if (file.is_one_time_note) {
          if (!file.is_folder) {
            const filePath = path.join(UPLOADS_DIR, file.path);
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
          }
          await pool.query('DELETE FROM files WHERE id = $1', [file.id]);
          console.log(`Background clean: Expired self-destruct note file ${file.name} deleted.`);
          continue;
        }
      }
      await pool.query('DELETE FROM shares WHERE id = $1', [share.id]);
    }
  } catch (err) {
    console.error('Expired cleanup interval error:', err);
  }
}, 5 * 60 * 1000); // Run every 5 minutes

// Start Database & Express Server
const WebSocket = require('ws');

// Rooms map: fileId -> Set of client sockets
const collabRooms = new Map();

// Collaboration identity palette: distinct colors + German animal names for anonymous visitors
const COLLAB_COLORS = ['#00d2ff', '#ff5555', '#50fa7b', '#ffb86c', '#ff79c6', '#bd93f9', '#f1fa8c', '#8be9fd', '#ff6e6e', '#69ff94', '#d3a4ff', '#ffd166'];
const COLLAB_ANIMALS = ['Fuchs', 'Luchs', 'Dachs', 'Biber', 'Otter', 'Igel', 'Eule', 'Falke', 'Reh', 'Hirsch', 'Wolf', 'Bär', 'Marder', 'Wiesel', 'Specht', 'Kranich', 'Reiher', 'Storch', 'Pinguin', 'Robbe', 'Delfin', 'Wal', 'Hase', 'Eichhörnchen', 'Murmeltier', 'Steinbock', 'Gämse', 'Waschbär', 'Panda', 'Koala', 'Tiger', 'Löwe', 'Leopard', 'Gepard', 'Elefant', 'Giraffe', 'Zebra', 'Nashorn', 'Flamingo', 'Tukan', 'Papagei', 'Kolibri', 'Schwan', 'Luchskatze', 'Ozelot', 'Erdmännchen'];

function initWebSocket(server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    } catch (err) {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/api/collab') {
      socket.destroy();
      return;
    }

    // Raw `upgrade` events bypass Express entirely, so express-session never runs for them —
    // run it manually to get request.session (cookie-based auth) before deciding access.
    // {} stands in for the response object; express-session only needs it for the parts of a
    // real HTTP response we never trigger here (we only read the session, never modify it).
    sessionMiddleware(request, {}, async () => {
      try {
        const fileId = parseInt(url.searchParams.get('fileId'));
        const slug = url.searchParams.get('slug');

        if (!fileId) {
          socket.destroy();
          return;
        }

        // Previously this endpoint trusted the client-supplied userId/username with no
        // access check at all — anyone could join any file's collab room by guessing its id,
        // eavesdrop on edits, and inject their own (which a legitimately write-permitted
        // collaborator would then unwittingly persist). Determine real read/write access
        // the same way the REST endpoints do, via session ownership or a public share.
        let access = { canRead: false, canWrite: false };

        if (request.session.userId) {
          const isOwner = await verifyFileOwner(fileId, request.session.userId);
          if (isOwner) access = { canRead: true, canWrite: true };
        }

        if (!access.canRead && slug) {
          const shareAccess = await verifyPublicShareAccess(slug, fileId, request);
          if (!shareAccess.error && shareAccess.share.can_read) {
            access = { canRead: true, canWrite: !!shareAccess.share.can_write };
          }
        }

        if (!access.canRead) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.canWrite = access.canWrite;
          wss.emit('connection', ws, request);
        });
      } catch (err) {
        console.error('WebSocket upgrade error:', err);
        socket.destroy();
      }
    });
  });

  wss.on('connection', (ws, request) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      const fileId = parseInt(url.searchParams.get('fileId'));
      const isGuest = url.searchParams.get('guest') === '1';
      let username = url.searchParams.get('username') || '';
      const userId = url.searchParams.get('userId') || `guest_${Math.random().toString(36).substring(2, 11)}`;

      if (!fileId) {
        ws.close(1008, 'Missing fileId');
        return;
      }

      if (!collabRooms.has(fileId)) {
        collabRooms.set(fileId, new Set());
      }
      const room = collabRooms.get(fileId);

      // Determine names & colors already taken in this room to avoid duplicates
      const usedNames = new Set();
      const usedColors = new Set();
      for (const client of room) {
        if (client.username) usedNames.add(client.username);
        if (client.color) usedColors.add(client.color);
      }

      // Assign a unique color (prefer an unused one from the palette, hash fallback)
      let color = COLLAB_COLORS.find(c => !usedColors.has(c));
      if (!color) {
        let hash = 0;
        for (let i = 0; i < userId.length; i++) {
          hash = userId.charCodeAt(i) + ((hash << 5) - hash);
        }
        color = COLLAB_COLORS[Math.abs(hash) % COLLAB_COLORS.length];
      }

      // Anonymous visitors get a unique random animal name; authenticated users keep theirs (de-duplicated)
      if (isGuest || !username) {
        const available = COLLAB_ANIMALS.filter(a => !usedNames.has(a));
        if (available.length > 0) {
          username = available[Math.floor(Math.random() * available.length)];
        } else {
          const base = COLLAB_ANIMALS[Math.floor(Math.random() * COLLAB_ANIMALS.length)];
          let n = 2;
          while (usedNames.has(`${base} ${n}`)) n++;
          username = `${base} ${n}`;
        }
      } else if (usedNames.has(username)) {
        let n = 2;
        while (usedNames.has(`${username} (${n})`)) n++;
        username = `${username} (${n})`;
      }

      ws.fileId = fileId;
      ws.username = username;
      ws.userId = userId;
      ws.color = color;

      room.add(ws);

      const getRoomUsersList = () => {
        const list = [];
        for (const client of room) {
          list.push({
            userId: client.userId,
            username: client.username,
            color: client.color
          });
        }
        return list;
      };

      const broadcast = (data, excludeSelf = true) => {
        const msg = JSON.stringify(data);
        for (const client of room) {
          if (client.readyState === WebSocket.OPEN) {
            if (excludeSelf && client === ws) continue;
            client.send(msg);
          }
        }
      };

      // Welcome message (includes the identity the server assigned to this client)
      ws.send(JSON.stringify({
        type: 'init',
        userId: ws.userId,
        username: ws.username,
        color: ws.color,
        users: getRoomUsersList()
      }));

      // Broadcast join
      broadcast({
        type: 'user_joined',
        userId: ws.userId,
        username: ws.username,
        color: ws.color,
        users: getRoomUsersList()
      }, true);

      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);
          if (data.type === 'edit') {
            // Read-only participants (share without can_write) can watch but must not be able
            // to inject changes that a write-permitted collaborator's client would then apply
            // and unwittingly persist via the (properly-authenticated) save endpoint.
            if (!ws.canWrite) return;
            broadcast({
              type: 'edit',
              userId: ws.userId,
              changes: data.changes
            }, true);
          } else if (data.type === 'cursor') {
            broadcast({
              type: 'cursor',
              userId: ws.userId,
              username: ws.username,
              position: data.position,
              selection: data.selection
            }, true);
          }
        } catch (err) {
          console.error('Collab socket message handling error:', err);
        }
      });

      ws.on('close', () => {
        room.delete(ws);
        if (room.size === 0) {
          collabRooms.delete(fileId);
        } else {
          broadcast({
            type: 'user_left',
            userId: ws.userId,
            username: ws.username,
            users: getRoomUsersList()
          }, true);
        }
      });
    } catch (err) {
      console.error('WebSocket connection setup error:', err);
      ws.close(1011, 'Internal connection setup error');
    }
  });
}

initDb()
  .then(() => {
    const server = app.listen(PORT, () => {
      console.log(`myCloud app is running on ${EXPECTED_ORIGIN}`);
    });
    initWebSocket(server);
    indexExistingFiles();
  })
  .catch(err => {
    console.error('Database connection failed, exiting...', err);
    process.exit(1);
  });
