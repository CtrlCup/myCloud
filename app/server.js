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
const compression = require('compression');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { isoBase64URL } = require('@simplewebauthn/server/helpers');

const { pool, initDb, getSetting, setSetting, getAllSettings } = require('./db');
const { sendMail, renderEmailTemplate, getEmailBranding, applyConditionalBlock } = require('./email');
const { version: APP_VERSION } = require('./package.json');
const { getVersionStatus, logVersionStatus, checkForUpdate, GITHUB_REPO } = require('./version');

require('dotenv').config();

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

// Setup directories
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Physical filenames (on disk) are built from this extension rather than the raw
// path.extname() of a user-supplied name: several code paths (thumbnailing, OCR, EXIF read)
// shell out via exec() with the physical filename interpolated into a double-quoted string,
// so an extension containing a `"` or other shell metacharacter would be command injection.
// Restricting to a short alphanumeric extension closes that off at the source.
function safeFileExtension(originalName) {
  const ext = path.extname(originalName || '');
  return /^\.[A-Za-z0-9]{1,15}$/.test(ext) ? ext : '';
}

// Admin-controlled settings (SEO title/description) get reflected into HTML served to every
// visitor, including unauthenticated ones — escape before injecting so a compromised admin
// account (or a stray "<" in the description) can't inject markup/script into the page shell.
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Multer storage engine
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = crypto.randomUUID();
    cb(null, uniqueSuffix + safeFileExtension(file.originalname));
  }
});
// Without a limit, multer will happily write an unbounded request body to disk before the
// app-level storage-quota check (further down) ever runs — a single oversized upload could
// fill the disk regardless of any quota. This is a generous ceiling (not the per-user quota),
// just a backstop against a genuinely unbounded request. Admin-configurable at runtime (see
// max_upload_size_mb setting) so an instance can tighten it well below the 5GB fallback
// default without a redeploy; DEFAULT_MAX_UPLOAD_SIZE_BYTES only applies until the admin
// (or MAX_UPLOAD_SIZE_BYTES env var, kept for backwards compatibility) sets one explicitly.
const DEFAULT_MAX_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024 * 1024; // 5GB
const MIN_UPLOAD_SIZE_MB = 1;
const MAX_UPLOAD_SIZE_MB_CEILING = 512000; // 500GB — sanity cap on the admin setting itself
let maxUploadSizeBytes = parseInt(process.env.MAX_UPLOAD_SIZE_BYTES) || DEFAULT_MAX_UPLOAD_SIZE_BYTES;

// Loads the admin-configured limit from the DB (falling back to the env var / default above)
// into the in-memory cache multer reads from. Called once at startup and again whenever the
// setting is saved, so a running process picks up a new limit without a restart.
async function refreshMaxUploadSizeBytes() {
  const raw = await getSetting('max_upload_size_mb');
  const mb = parseInt(raw);
  if (Number.isFinite(mb) && mb >= MIN_UPLOAD_SIZE_MB && mb <= MAX_UPLOAD_SIZE_MB_CEILING) {
    maxUploadSizeBytes = mb * 1024 * 1024;
  }
}

// multer() is constructed fresh per request instead of once at module load, so a limit change
// takes effect immediately instead of requiring the process (and its one frozen multer
// instance) to restart.
function uploadSingle(fieldName) {
  return (req, res, next) => multer({ storage, limits: { fileSize: maxUploadSizeBytes } }).single(fieldName)(req, res, next);
}
function uploadArray(fieldName, maxCount) {
  return (req, res, next) => multer({ storage, limits: { fileSize: maxUploadSizeBytes } }).array(fieldName, maxCount)(req, res, next);
}

// Browsers send multipart filenames as raw UTF-8 bytes, but multer's underlying parser (busboy)
// decodes multipart header fields as latin1 per the multipart spec. Re-decoding the mangled
// string as latin1 -> utf8 undoes that mojibake (e.g. "PrÃ¤sentation" -> "Präsentation").
function fixUploadFilenameEncoding(req, res, next) {
  const fix = (name) => Buffer.from(name, 'latin1').toString('utf8');
  if (req.file) req.file.originalname = fix(req.file.originalname);
  if (Array.isArray(req.files)) {
    req.files.forEach(f => { f.originalname = fix(f.originalname); });
  }
  next();
}

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

// OCR support (tesseract-ocr + poppler-utils, installed in the Dockerfile alongside the
// existing ffmpeg/exiftool system tools) so images and scanned PDFs without a text layer are
// still findable via deep search, not just by filename.
const OCR_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif'];

function ocrImage(imagePath) {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    const outputBase = imagePath + '.ocrtmp';
    exec(`tesseract "${imagePath}" "${outputBase}" -l deu+eng`, { timeout: 30000 }, () => {
      try {
        const text = fs.readFileSync(outputBase + '.txt', 'utf8');
        fs.unlinkSync(outputBase + '.txt');
        resolve(text.trim());
      } catch {
        resolve('');
      }
    });
  });
}

// Scanned PDFs have no embedded text layer to extract — render the first 10 pages to images
// (poppler's pdftoppm) and OCR each one instead. Page cap keeps a pathological huge scan from
// blocking the upload response for minutes.
async function ocrPdf(pdfPath) {
  const { exec } = require('child_process');
  const tmpPrefix = pdfPath + '.ocrpage';
  await new Promise((resolve) => {
    exec(`pdftoppm -png -r 150 -l 10 "${pdfPath}" "${tmpPrefix}"`, { timeout: 60000 }, () => resolve());
  });

  const dir = path.dirname(pdfPath);
  const base = path.basename(tmpPrefix);
  let pageFiles = [];
  try {
    pageFiles = fs.readdirSync(dir).filter(f => f.startsWith(base)).sort();
  } catch {
    return '';
  }

  let combined = '';
  for (const pf of pageFiles) {
    const pagePath = path.join(dir, pf);
    combined += (await ocrImage(pagePath)) + '\n';
    try { fs.unlinkSync(pagePath); } catch { /* best-effort cleanup */ }
  }
  return combined.trim();
}

// Reads with the async fs API rather than *Sync — this runs on every upload/save (see call
// sites) and a synchronous read of a large file (a big log/text file, or a many-MB PDF) would
// block Node's single event loop thread, stalling every other in-flight request on the server
// until the read finishes, not just this one.
async function extractTextContent(filePath, mimeType, fileName) {
  try {
    const ext = path.extname(fileName).toLowerCase();

    // 1. PDF files
    if (ext === '.pdf' || mimeType === 'application/pdf') {
      let dataBuffer;
      try { dataBuffer = await fs.promises.readFile(filePath); } catch { return null; }
      const uint8Array = new Uint8Array(dataBuffer);
      const parser = new pdfParse.PDFParse(uint8Array);
      const parsed = await parser.getText();
      const text = parsed.text || '';
      if (text.trim().length > 20) return text;
      // Likely a scanned PDF with no text layer — fall back to OCR.
      const ocrText = await ocrPdf(filePath);
      return ocrText || text;
    }

    // 2. Plain text / code files — only the first 500KB is ever kept (to cap db bloat), so
    // only that much is actually read off disk instead of loading an arbitrarily large file
    // (e.g. a multi-hundred-MB log) into memory just to truncate it afterwards.
    const textExts = ['.txt', '.md', '.json', '.js', '.css', '.html', '.py', '.sh', '.xml', '.yaml', '.yml', '.csv', '.ini', '.conf'];
    if (textExts.includes(ext) || (mimeType && mimeType.startsWith('text/'))) {
      const MAX_INDEXED_BYTES = 500000;
      let handle;
      try {
        handle = await fs.promises.open(filePath, 'r');
        const buffer = Buffer.alloc(MAX_INDEXED_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, MAX_INDEXED_BYTES, 0);
        return buffer.toString('utf8', 0, bytesRead);
      } catch {
        return null;
      } finally {
        await handle?.close();
      }
    }

    // 3. Images — OCR any visible text (screenshots, scanned documents, photos of signs, etc.)
    if (OCR_IMAGE_EXTS.includes(ext)) {
      if (!fs.existsSync(filePath)) return null;
      const ocrText = await ocrImage(filePath);
      return ocrText || null;
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

// Both the fallback below and the values shipped in docker-compose.yml/.env.example are public
// (visible to anyone who's looked at this open-source repo), so a deployment that never
// overrode SESSION_SECRET is signing session cookies with a secret an attacker can just look
// up — letting them forge a valid session for any userId without ever touching a password.
const KNOWN_WEAK_SESSION_SECRETS = [
  'fallback_secret_key_change_me',
  'change_this_to_a_long_random_string',
  'a_long_random_and_secure_session_secret_key_12345',
];
if (!process.env.SESSION_SECRET || KNOWN_WEAK_SESSION_SECRETS.includes(process.env.SESSION_SECRET)) {
  console.warn('\n⚠️  WARNUNG: SESSION_SECRET ist nicht gesetzt oder verwendet einen aus dem öffentlichen Repository bekannten Standardwert.');
  console.warn('   Damit lassen sich Session-Cookies fälschen (voller Account-Zugriff ohne Passwort).');
  console.warn('   Bitte in .env einen eigenen, zufälligen SESSION_SECRET setzen, z. B. via: openssl rand -hex 32\n');
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
    // Hardcoding this to false meant the session cookie never got the Secure flag even when
    // the app is deployed behind HTTPS (directly or via a reverse proxy), letting it leak over
    // a plain-HTTP downgrade. Derive it from the configured public URL instead.
    secure: (process.env.APP_URL || '').startsWith('https'),
    sameSite: 'lax',
  }
});
app.use(sessionMiddleware);

// Regenerates the session ID before granting an authenticated identity, so a session ID an
// attacker planted before login (session fixation — e.g. via a shared/kiosk browser or a cookie
// set from a subdomain) doesn't silently become authenticated once the victim logs in. Wraps
// express-session's callback-based regenerate() in a promise for use in async route handlers.
function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(err => (err ? reject(err) : resolve()));
  });
}

// Helper to recursively check if a fileId is a descendant of ancestorId using a CTE.
// This replaces O(N) sequential database queries in loops with a single efficient index-backed query.
async function isDescendantOf(fileId, ancestorId) {
  if (fileId === ancestorId) return true;
  if (!fileId || !ancestorId) return false;
  try {
    const res = await pool.query(
      `WITH RECURSIVE file_path AS (
        SELECT id, parent_id FROM files WHERE id = $1
        UNION ALL
        SELECT f.id, f.parent_id FROM files f JOIN file_path fp ON f.id = fp.parent_id
      )
      SELECT EXISTS(SELECT 1 FROM file_path WHERE id = $2) AS is_descendant`,
      [fileId, ancestorId]
    );
    return res.rows[0].is_descendant;
  } catch (err) {
    console.error('Error checking isDescendantOf:', err);
    return false;
  }
}


// gzip everything compressible (JSON API responses, app.js/styles.css) — compression's default
// filter already skips binary formats (zip/images/video/pdf) via their Content-Type, and skips
// anything that already has a Content-Encoding, so this doesn't double-compress file downloads.
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// index: false — index.html needs SEO tags injected per-request (see renderAppShell below),
// so it must never be served as-is by the static middleware's automatic directory index.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Self-hosted PDF.js viewer app (not just the bare library) — its prebuilt UI already has a
// page-layout menu with single/two-page/two-page-with-cover-page modes, which is exactly the
// "two-page view with control over which side page 1 lands on" the in-house PDF viewer wants,
// so embedding it directly is far less work (and more correct) than reimplementing spread-view
// pagination by hand. Served from node_modules rather than vendored into public/ so it stays in
// sync with the pdfjs-dist version in package.json. The viewer shell itself needs no auth (it's
// just static JS/HTML); the PDF it loads goes through our existing authenticated download route.
app.use('/pdfjs', express.static(path.join(__dirname, 'node_modules/pdfjs-dist')));

// pdf-lib: used client-side only to flatten the custom pen/highlighter/eraser drawing layer
// (see openPdfViewer in app.js) into the saved PDF as an image overlay per annotated page —
// pdf.js's own AnnotationEditor has no eraser primitive and no way to force a straight line,
// so those tools are hand-rolled on a canvas rather than going through pdf.js's ink/highlight
// editors, and need a separate library to bake the result back into PDF bytes on save.
app.use('/pdf-lib', express.static(path.join(__dirname, 'node_modules/pdf-lib/dist')));

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

// Sessions last up to 30 days and only carry the role/active-status a user had at login time.
// Without re-checking the DB, an admin who deactivates or demotes someone doesn't actually
// revoke their access until that stale session expires on its own. Refreshes req.session.role
// to the current value (self-healing a stale session) and reports whether the account is still
// active. Called by all three auth middlewares below.
async function refreshSessionIdentity(req) {
  const result = await pool.query('SELECT is_active, role FROM users WHERE id = $1', [req.session.userId]);
  if (result.rows.length === 0 || result.rows[0].is_active === false) return false;
  req.session.role = result.rows[0].role;
  return true;
}

// Authentication Middleware
async function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    if (!(await refreshSessionIdentity(req))) return res.status(401).json({ error: 'Unauthorized' });
    next();
  } catch (err) {
    console.error('requireAuth error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
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
    if (!(await refreshSessionIdentity(req))) {
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
      if (!(await refreshSessionIdentity(req))) return res.status(401).json({ error: 'Unauthorized' });
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
  // Deliberately NOT trusting req.headers.origin here: it's attacker-controlled on any raw
  // request that isn't a real browser fetch (e.g. a replayed WebAuthn response sent via curl),
  // so accepting it as the "expected" origin makes the check tautological — it would always
  // match whatever the caller claims, defeating the point of validating the origin at all.
  // Derive it the same way getRpId() derives the RP ID, from the request's own host.
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
      const userRes = await pool.query('SELECT id, username, role, email, first_name, last_name, display_real_name, theme_preference FROM users WHERE id = $1', [req.session.userId]);
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
  try {
    const userCountRes = await pool.query('SELECT COUNT(*) FROM users');
    const userCount = parseInt(userCountRes.rows[0].count);
    const ssoEnabled = (await getSetting('sso_enabled')) === 'true';
    const ssoAutoRedirect = (await getSetting('sso_auto_redirect')) === 'true';
    const ssoOnly = (await getSetting('sso_only')) === 'true';
    const ssoButtonText = await getSetting('sso_button_text');

    res.json({
      loggedIn: false,
      firstRun: userCount === 0,
      ssoEnabled,
      ssoAutoRedirect,
      ssoOnly,
      ssoButtonText: ssoButtonText || 'Über Authentik (SSO) anmelden',
    });
  } catch (err) {
    console.error('Error fetching auth status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// No limit here meant anyone could script unlimited account creation — each one sends a
// verification email (see below) to whatever address is supplied, so this was also an
// unauthenticated mail-bombing vector against arbitrary third-party inboxes, not just DB
// spam. Same in-memory-counter pattern as loginAttempts/resetRequestAttempts, keyed by IP
// (the target email varies per attempt, unlike a password-reset request against one account).
const registerAttempts = new Map(); // ip -> { count, resetAt }
const REGISTER_MAX_ATTEMPTS = 5;
const REGISTER_ATTEMPT_WINDOW_MS = 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of registerAttempts.entries()) {
    if (entry.resetAt < now) registerAttempts.delete(id);
  }
}, 15 * 60 * 1000);

// Standard Register Route
app.post('/api/auth/register', async (req, res) => {
  if ((await getSetting('sso_only')) === 'true') {
    return res.status(403).json({ error: 'Die Anmeldung ist nur über SSO möglich.' });
  }

  const registerIp = req.ip;
  const registerNow = Date.now();
  const registerEntry = registerAttempts.get(registerIp);
  if (registerEntry && registerEntry.resetAt >= registerNow && registerEntry.count >= REGISTER_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Zu viele Registrierungsversuche. Bitte versuche es später erneut.' });
  }
  if (!registerEntry || registerEntry.resetAt < registerNow) {
    registerAttempts.set(registerIp, { count: 1, resetAt: registerNow + REGISTER_ATTEMPT_WINDOW_MS });
  } else {
    registerEntry.count++;
  }

  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    // Check if email already exists to prevent duplicate email registrations
    const existingEmailRes = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
    if (existingEmailRes.rows.length > 0) {
      return res.status(409).json({ error: 'Diese E-Mail-Adresse oder dieser Name wird bereits verwendet.' });
    }

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
      [username, normalizedEmail, passwordHash, role, isVerified, verificationToken]
    );

    const newUser = result.rows[0];

    if (!isVerified) {
      // Send verification email
      const branding = await getEmailBranding();
      const verifyLink = `${branding.appUrl}/api/auth/verify-email?token=${verificationToken}`;

      await sendMail({
        to: email,
        subject: `${branding.cloudName} - Registrierung bestätigen`,
        text: `Hallo,\n\nBitte bestätige deine Registrierung über den folgenden Link:\n${verifyLink}\n\nErst danach kannst du dich anmelden.`,
        html: renderEmailTemplate('verify-account', {
          CLOUD_NAME: branding.cloudName,
          LOGO_MARK: { raw: branding.logoMark },
          APP_URL: branding.appUrl,
          USER_NAME: normalizedEmail.split('@')[0],
          USER_EMAIL: normalizedEmail,
          VERIFY_URL: { raw: verifyLink },
        }),
        templated: true,
      });

      return res.status(201).json({ success: true, requiresVerification: true, message: 'Registrierung erfolgreich. Bitte bestätige deine E-Mail-Adresse.' });
    }

    // Log in automatically if no verification is required
    await regenerateSession(req);
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

// The password login had no brute-force protection at all: unlike the 2FA step below, an
// attacker could try unlimited password guesses against a known username/email. Simple
// in-memory counter per identifier (username/email as typed), mirroring the twoFactorAttempts
// pattern already used further down — no new infrastructure, just closes the obvious gap.
const loginAttempts = new Map(); // identifier -> { count, resetAt }
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of loginAttempts.entries()) {
    if (entry.resetAt < now) loginAttempts.delete(id);
  }
}, 10 * 60 * 1000);
function recordFailedLoginAttempt(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_ATTEMPT_WINDOW_MS });
  } else {
    entry.count++;
  }
}

// Standard Login Route
app.post('/api/auth/login', async (req, res) => {
  if ((await getSetting('sso_only')) === 'true') {
    return res.status(403).json({ error: 'Die Anmeldung ist nur über SSO möglich.' });
  }

  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username/Email and password are required' });
  }

  const loginKey = username.trim().toLowerCase();
  const now = Date.now();
  const attemptEntry = loginAttempts.get(loginKey);
  if (attemptEntry && attemptEntry.resetAt >= now && attemptEntry.count >= LOGIN_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte versuche es in ein paar Minuten erneut.' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1 OR email = $1', [username]);
    if (result.rows.length === 0) {
      recordFailedLoginAttempt(loginKey);
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
      recordFailedLoginAttempt(loginKey);
      await pool.query('UPDATE users SET last_failed_login_at = NOW() WHERE id = $1', [user.id]);
      return res.status(401).json({ error: 'Ungültiger Benutzername oder E-Mail oder Passwort.' });
    }

    loginAttempts.delete(loginKey);

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

    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    await pool.query('UPDATE users SET last_login_at = NOW(), last_failed_login_at = NULL WHERE id = $1', [user.id]);

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
// Both the email code and TOTP are 6 digits (1M possibilities) checked with no attempt limit —
// an attacker who already has a valid password (having passed the first factor) could brute
// force the second factor directly. Cap attempts per pending login within the code's window.
const twoFactorAttempts = new Map(); // tempUserId -> { count, resetAt }
const TWO_FACTOR_MAX_ATTEMPTS = 5;
const TWO_FACTOR_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of twoFactorAttempts.entries()) {
    if (entry.resetAt < now) twoFactorAttempts.delete(id);
  }
}, 10 * 60 * 1000);

app.post('/api/auth/login/verify-2fa', async (req, res) => {
  const { code } = req.body;
  const tempUserId = req.session.tempUserId;

  if (!tempUserId || !code) {
    return res.status(400).json({ error: '2FA-Sitzung abgelaufen oder kein Code eingegeben.' });
  }

  const now = Date.now();
  const attemptEntry = twoFactorAttempts.get(tempUserId);
  if (!attemptEntry || attemptEntry.resetAt < now) {
    twoFactorAttempts.set(tempUserId, { count: 1, resetAt: now + TWO_FACTOR_ATTEMPT_WINDOW_MS });
  } else if (attemptEntry.count >= TWO_FACTOR_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte versuche es in ein paar Minuten erneut.' });
  } else {
    attemptEntry.count++;
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

    twoFactorAttempts.delete(tempUserId);

    // regenerateSession() replaces the session store entry wholesale, which also takes care of
    // clearing tempUserId/twoFactorCode/etc. — no need to delete them individually afterwards.
    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    await pool.query('UPDATE users SET last_login_at = NOW(), last_failed_login_at = NULL WHERE id = $1', [user.id]);

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
      // generateRegistrationOptions() passes userID straight through into the response JSON's
      // `user.id` field without encoding it, and the client-side library then base64url-decodes
      // that field as-is — so it must already be a base64url string, not a raw id/Buffer.
      userID: isoBase64URL.fromString(String(user.id)),
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
  if ((await getSetting('sso_only')) === 'true') {
    return res.status(403).json({ error: 'Die Anmeldung ist nur über SSO möglich.' });
  }
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
    const userRes = await pool.query('SELECT id, username, role, is_active FROM users WHERE id = $1', [passkey.user_id]);
    const user = userRes.rows[0];

    if (!user) {
      return res.status(404).json({ error: 'No user found with this passkey ID' });
    }

    if (user.is_active === false) {
      return res.status(403).json({ error: 'Ihr Account wurde gesperrt. Bitte wenden Sie sich an einen Administrator.' });
    }

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

      await regenerateSession(req);
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role;
      await pool.query('UPDATE users SET last_login_at = NOW(), last_failed_login_at = NULL WHERE id = $1', [user.id]);

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
  try {
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
  } catch (err) {
    console.error('SSO redirect error:', err);
    res.status(500).send('Internal server error');
  }
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
    if (user.is_active === false) {
      return res.status(403).send('Ihr Account wurde gesperrt. Bitte wenden Sie sich an einen Administrator.');
    }
    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    await pool.query('UPDATE users SET last_login_at = NOW(), last_failed_login_at = NULL WHERE id = $1', [user.id]);

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
// No limit here meant anyone could trigger unlimited reset e-mails to any account (mail-bombing
// a victim, or burning through SMTP send quota/reputation) — same in-memory-counter pattern as
// loginAttempts, keyed by the submitted identifier. Deliberately generous (higher than login's)
// since a real forgetful user might legitimately retry a few times.
const resetRequestAttempts = new Map(); // identifier -> { count, resetAt }
const RESET_REQUEST_MAX_ATTEMPTS = 5;
const RESET_REQUEST_WINDOW_MS = 15 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of resetRequestAttempts.entries()) {
    if (entry.resetAt < now) resetRequestAttempts.delete(id);
  }
}, 10 * 60 * 1000);

app.post('/api/auth/reset-password-request', async (req, res) => {
  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  const resetKey = username.trim().toLowerCase();
  const rateNow = Date.now();
  const resetAttemptEntry = resetRequestAttempts.get(resetKey);
  if (resetAttemptEntry && resetAttemptEntry.resetAt >= rateNow && resetAttemptEntry.count >= RESET_REQUEST_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Zu viele Anfragen. Bitte versuche es in ein paar Minuten erneut.' });
  }
  if (!resetAttemptEntry || resetAttemptEntry.resetAt < rateNow) {
    resetRequestAttempts.set(resetKey, { count: 1, resetAt: rateNow + RESET_REQUEST_WINDOW_MS });
  } else {
    resetAttemptEntry.count++;
  }

  try {
    const userRes = await pool.query('SELECT * FROM users WHERE username = $1 OR email = $1', [username]);
    if (userRes.rows.length === 0) {
      // Do not disclose whether user exists
      return res.json({ success: true, message: 'Falls der Benutzer existiert, wurde ein Reset-Link gesendet.' });
    }

    const user = userRes.rows[0];

    // Determine recipient email
    let recipient = user.email || '';
    if (!recipient && user.username.includes('@')) {
      recipient = user.username;
    }

    // Neither "this account is SSO-managed" nor "this account has no email on file" may be
    // distinguishable from "no such account" — otherwise an attacker can enumerate valid
    // usernames by watching which specific error comes back for a given input.
    if (user.sso_id || !recipient) {
      return res.json({ success: true, message: 'Falls der Benutzer existiert, wurde ein Reset-Link gesendet.' });
    }

    // Generate random reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + 3600000; // 1 hour

    await setSetting(`reset_${resetToken}`, JSON.stringify({ userId: user.id, expires }));

    const branding = await getEmailBranding();
    const resetLink = `${branding.appUrl}/#reset-password?token=${resetToken}`;

    const mailSent = await sendMail({
      to: recipient,
      subject: `${branding.cloudName} - Passwort zurücksetzen`,
      text: `Hallo,\n\nBitte setze dein Passwort über den folgenden Link zurück:\n${resetLink}\n\nDieser Link ist für 1 Stunde gültig.`,
      html: renderEmailTemplate('password-reset', {
        CLOUD_NAME: branding.cloudName,
        LOGO_MARK: { raw: branding.logoMark },
        APP_URL: branding.appUrl,
        USER_NAME: getUserDisplayName(user),
        USER_EMAIL: recipient,
        RESET_URL: { raw: resetLink },
      }),
      templated: true,
    });

    if (mailSent) {
      res.json({ success: true, message: 'Passwort-Reset-Link an die hinterlegte E-Mail-Adresse gesendet.' });
    } else {
      if (branding.appUrl.includes('localhost')) {
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

// Mirrors the frontend's updateDisplayNameUI() logic so emails greet a user the same way the
// app's own UI does — the real name when the user opted into showing it, otherwise the username.
function getUserDisplayName(user) {
  if (user.display_real_name && (user.first_name || user.last_name)) {
    return `${user.first_name || ''} ${user.last_name || ''}`.trim();
  }
  return user.username;
}

// Helper to check recursively if a file/folder belongs to an owner
async function verifyFileOwner(fileId, userId) {
  // Only treat an explicit "no parent/file specified" (null/undefined, i.e. root) as
  // automatically authorized. A plain falsy check (`!fileId`) would also match `0`, `NaN`
  // and `''` — e.g. an id that failed `parseInt()` — and silently grant access instead of
  // failing the lookup below.
  if (fileId === null || fileId === undefined) return true;
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
        WHERE is_folder = false AND owner_id = $1 AND deleted_at IS NULL

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
      WHERE f.owner_id = $1 AND f.is_one_time_note = false AND f.deleted_at IS NULL AND (f.name ILIKE $2`;

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

// Most recently created files/folders across all of the user's folders (not scoped to the
// current directory) — powers the "Zuletzt hinzugefügt" sidebar entry in the Nova theme.
app.get('/api/files/recent', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  try {
    const result = await pool.query(
      `SELECT id, name, size, is_folder, mime_type, created_at, parent_id
       FROM files
       WHERE owner_id = $1 AND is_one_time_note = false AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 40`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching recent files:', err);
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
         WHERE is_folder = false AND owner_id = $1 AND deleted_at IS NULL

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
       WHERE f.owner_id = $1 AND f.is_one_time_note = false AND f.deleted_at IS NULL AND (f.parent_id = $2 OR (f.parent_id IS NULL AND $2 IS NULL))
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
app.post('/api/files/upload', requireAuth, requirePermission('upload'), uploadSingle('file'), fixUploadFilenameEncoding, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const parentId = req.body.parentId && req.body.parentId !== 'null' ? parseInt(req.body.parentId) : null;
  const userId = req.session.userId;

  try {
    if (parentId !== null) {
      const isOwner = await verifyFileOwner(parentId, userId);
      if (!isOwner) {
        fs.unlinkSync(req.file.path); // Delete file if unauthorized
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const safeMimeType = getSafeMimeType(req.file.originalname);

    const quotaResult = await withStorageQuotaLock(userId, req.file.size, (client) => client.query(
      `INSERT INTO files (name, path, mime_type, size, is_folder, parent_id, owner_id, content)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL) RETURNING *`,
      [req.file.originalname, req.file.filename, safeMimeType, req.file.size, false, parentId, userId]
    ));
    if (!quotaResult.ok) {
      fs.unlinkSync(req.file.path);
      return res.status(413).json({ error: quotaResult.error });
    }

    const insertedFile = quotaResult.data.rows[0];
    res.status(201).json(insertedFile);

    // Text extraction (incl. OCR for scanned PDFs/images) runs after the response — for large
    // batch uploads it can take up to ~30s per file, and uploads are processed one at a time on
    // the client, so doing this beforehand serialized the whole batch behind it. A stale/failed
    // extraction here just leaves content NULL, same as any pre-existing file — indexExistingFiles()
    // picks those up as a backfill on the next server start.
    extractTextContent(req.file.path, safeMimeType, req.file.originalname)
      .then((textContent) => {
        if (textContent === null) return;
        return pool.query('UPDATE files SET content = $1 WHERE id = $2', [textContent, insertedFile.id]);
      })
      .catch((err) => console.error('Error indexing uploaded file:', req.file.originalname, err));
    return;
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

// Helper for ZIP folder packing — fetches the whole subtree in one recursive-CTE query instead
// of one round-trip per folder level, then walks the resulting (small, in-memory) tree to add
// each file at its correct archive path.
async function addFolderToZip(zip, folderId, currentPath, userId) {
  const subtreeRes = await pool.query(
    `WITH RECURSIVE subtree AS (
       SELECT id, name, parent_id, is_folder, path FROM files WHERE id = $1 AND owner_id = $2
       UNION ALL
       SELECT f.id, f.name, f.parent_id, f.is_folder, f.path FROM files f
       JOIN subtree s ON f.parent_id = s.id
       WHERE f.owner_id = $2
     )
     SELECT id, name, parent_id, is_folder, path FROM subtree WHERE id != $1`,
    [folderId, userId]
  );

  const childrenByParent = new Map();
  for (const file of subtreeRes.rows) {
    if (!childrenByParent.has(file.parent_id)) childrenByParent.set(file.parent_id, []);
    childrenByParent.get(file.parent_id).push(file);
  }

  const addChildren = (parentId, currentArchivePath) => {
    for (const file of childrenByParent.get(parentId) || []) {
      const archivePath = path.join(currentArchivePath, file.name);
      if (file.is_folder) {
        addChildren(file.id, archivePath);
      } else {
        const physicalPath = path.join(UPLOADS_DIR, file.path);
        if (fs.existsSync(physicalPath)) {
          zip.file(physicalPath, { name: archivePath });
        }
      }
    }
  };
  addChildren(folderId, currentPath);
}

// Download folder as ZIP
app.get('/api/files/download-zip/:id', requireAuth, requirePermission('download'), async (req, res) => {
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

// Helper: Recursively delete folder files. Fetches the whole subtree in one recursive-CTE
// query instead of one round-trip per folder level, then unlinks physical files and removes
// all the rows in a single batch DELETE.
async function deleteFolderRecursive(folderId, userId) {
  const subtreeRes = await pool.query(
    `WITH RECURSIVE subtree AS (
       SELECT id, path, is_folder FROM files WHERE id = $1 AND owner_id = $2
       UNION ALL
       SELECT f.id, f.path, f.is_folder FROM files f
       JOIN subtree s ON f.parent_id = s.id
       WHERE f.owner_id = $2
     )
     SELECT id, path, is_folder FROM subtree`,
    [folderId, userId]
  );

  for (const file of subtreeRes.rows) {
    if (file.is_folder) continue;
    const filePath = path.join(UPLOADS_DIR, file.path);
    // fs.existsSync() + fs.unlinkSync() is a TOCTOU race: if the file disappears between
    // the check and the unlink (e.g. an overlapping delete-multiple call on the same
    // subtree), unlinkSync throws ENOENT here and aborts the recursion partway through,
    // leaving some rows deleted and others not. Best-effort delete instead.
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  await pool.query('DELETE FROM files WHERE id = ANY($1)', [subtreeRes.rows.map(f => f.id)]);
}

// Permanently removes a single trash item (file or folder) — physical file(s) plus DB
// row(s). Used by the "delete forever" trash action, "empty trash", and the retention
// purge interval below; never called for a plain (non-trashed) delete, which soft-deletes
// via moveToTrashRecursive instead.
async function hardDeleteTrashItem(file, userId) {
  if (file.is_folder) {
    await deleteFolderRecursive(file.id, userId);
  } else {
    const filePath = path.join(UPLOADS_DIR, file.path);
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await pool.query('DELETE FROM files WHERE id = $1', [file.id]);
  }
}

// Soft-delete: stamps the file/folder and its entire subtree with the same deleted_at, so it
// disappears from normal listings/search but can still be restored. One recursive-CTE UPDATE
// instead of a per-node round-trip walk — same end result, one query instead of N.
async function moveToTrashRecursive(fileId, userId, deletedAt) {
  await pool.query(
    `WITH RECURSIVE subtree AS (
       SELECT id FROM files WHERE id = $1 AND owner_id = $2
       UNION ALL
       SELECT f.id FROM files f JOIN subtree s ON f.parent_id = s.id WHERE f.owner_id = $2
     )
     UPDATE files SET deleted_at = $3 WHERE id IN (SELECT id FROM subtree)`,
    [fileId, userId, deletedAt]
  );
}

// Restore: clears deleted_at on the item and its whole subtree.
async function restoreFromTrashRecursive(fileId, userId) {
  await pool.query(
    `WITH RECURSIVE subtree AS (
       SELECT id FROM files WHERE id = $1 AND owner_id = $2
       UNION ALL
       SELECT f.id FROM files f JOIN subtree s ON f.parent_id = s.id WHERE f.owner_id = $2
     )
     UPDATE files SET deleted_at = NULL WHERE id IN (SELECT id FROM subtree)`,
    [fileId, userId]
  );
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

    await moveToTrashRecursive(file.id, userId, new Date());

    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting file:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Rename a file or folder — only the human-facing name changes, the on-disk physical
// filename (a random UUID, unrelated to the display name) stays put, so no file-system move
// is needed here.
app.put('/api/files/:id/rename', requireAuth, requirePermission('rename'), async (req, res) => {
  const fileId = parseInt(req.params.id);
  const userId = req.session.userId;
  const newName = (req.body.name || '').trim();

  if (!newName) return res.status(400).json({ error: 'Name darf nicht leer sein.' });
  if (newName.length > 255) return res.status(400).json({ error: 'Name ist zu lang.' });
  if (newName.includes('/') || newName.includes('\\')) return res.status(400).json({ error: 'Name darf keine Schrägstriche enthalten.' });

  try {
    const isOwner = await verifyFileOwner(fileId, userId);
    if (!isOwner) return res.status(403).json({ error: 'Access denied' });

    const newMimeType = getSafeMimeType(newName);
    const result = await pool.query(
      'UPDATE files SET name = $1, mime_type = CASE WHEN is_folder = false THEN $2 ELSE mime_type END WHERE id = $3 RETURNING id, name',
      [newName, newMimeType, fileId]
    );
    res.json({ success: true, name: result.rows[0].name });
  } catch (err) {
    console.error('Error renaming file:', err);
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

    const newFilename = crypto.randomUUID() + safeFileExtension(file.name);
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

// Sums the on-disk size of a set of root ids plus everything nested under them (for folders),
// scoped to the given owner. Used to enforce the same storage quota on copy as on upload —
// without this, copying was a way to duplicate storage past a user's/group's quota for free.
async function calculateCopySize(fileIds, userId) {
  const result = await pool.query(
    `WITH RECURSIVE subtree AS (
       SELECT id, size, is_folder FROM files WHERE id = ANY($1) AND owner_id = $2
       UNION ALL
       SELECT f.id, f.size, f.is_folder FROM files f
       JOIN subtree s ON f.parent_id = s.id
       WHERE f.owner_id = $2
     )
     SELECT COALESCE(SUM(size), 0) as total FROM subtree WHERE is_folder = false`,
    [fileIds, userId]
  );
  return parseInt(result.rows[0].total || 0);
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

    // Enforce the same per-user and per-group storage quota as uploads (see /api/files/upload) —
    // copying creates new physical files/rows too, so it must count against quota just the same.
    const parsedIds = fileIds.map(id => parseInt(id));
    const copySize = await calculateCopySize(parsedIds, userId);
    if (copySize > 0) {
      const userRes = await pool.query('SELECT storage_quota, role FROM users WHERE id = $1', [userId]);
      const quotaBytes = userRes.rows[0].storage_quota ? parseInt(userRes.rows[0].storage_quota) : null;
      if (quotaBytes !== null) {
        const usedRes = await pool.query('SELECT SUM(size) as total FROM files WHERE owner_id = $1 AND is_folder = false', [userId]);
        const usedBytes = parseInt(usedRes.rows[0].total || 0);
        if (usedBytes + copySize > quotaBytes) {
          return res.status(413).json({ error: 'Speicherplatzlimit überschritten! Bitte lösche Dateien oder wende dich an einen Admin.' });
        }
      }

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
        if (groupUsed + copySize > roleQuotaBytes) {
          return res.status(413).json({ error: 'Das gemeinsame Speicherkontingent deiner Gruppe ist erschöpft. Bitte wende dich an einen Admin.' });
        }
      }
    }

    for (const id of parsedIds) {
      await copyFileOrFolderRecursive(id, targetFolderId, userId);
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
    const deletedAt = new Date();
    const fileIds = ids.map(id => parseInt(id)).filter(id => !isNaN(id));
    const ownedRes = await pool.query(
      'SELECT id FROM files WHERE id = ANY($1) AND owner_id = $2',
      [fileIds, userId]
    );
    for (const row of ownedRes.rows) {
      await moveToTrashRecursive(row.id, userId, deletedAt);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting multiple files:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List trash "roots" only — a deleted item whose parent is either not deleted or no
// longer around, i.e. the top of whatever subtree the user actually deleted. Deleted
// descendants are restored/purged along with their root, not listed separately.
app.get('/api/files/trash', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  try {
    const result = await pool.query(
      `SELECT f.id, f.name, f.is_folder, f.size, f.deleted_at
       FROM files f
       WHERE f.owner_id = $1 AND f.deleted_at IS NOT NULL
         AND (f.parent_id IS NULL OR f.parent_id NOT IN (
           SELECT id FROM files WHERE owner_id = $1 AND deleted_at IS NOT NULL
         ))
       ORDER BY f.deleted_at DESC`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error listing trash:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Restore a trashed file/folder (and its subtree) back to where it was.
app.post('/api/files/trash/:id/restore', requireAuth, requirePermission('delete'), async (req, res) => {
  const fileId = parseInt(req.params.id);
  const userId = req.session.userId;
  try {
    const fileRes = await pool.query('SELECT owner_id, deleted_at FROM files WHERE id = $1', [fileId]);
    if (fileRes.rows.length === 0) return res.status(404).json({ error: 'File not found' });
    if (fileRes.rows[0].owner_id !== userId) return res.status(403).json({ error: 'Access denied' });
    if (fileRes.rows[0].deleted_at === null) return res.status(400).json({ error: 'File is not in trash' });

    await restoreFromTrashRecursive(fileId, userId);
    res.json({ success: true });
  } catch (err) {
    console.error('Error restoring file:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Permanently delete a single trashed item (and its subtree) — cannot be undone.
app.delete('/api/files/trash/:id', requireAuth, requirePermission('delete'), async (req, res) => {
  const fileId = parseInt(req.params.id);
  const userId = req.session.userId;
  try {
    const fileRes = await pool.query('SELECT * FROM files WHERE id = $1', [fileId]);
    if (fileRes.rows.length === 0) return res.status(404).json({ error: 'File not found' });
    const file = fileRes.rows[0];
    if (file.owner_id !== userId) return res.status(403).json({ error: 'Access denied' });
    if (file.deleted_at === null) return res.status(400).json({ error: 'File is not in trash' });

    await hardDeleteTrashItem(file, userId);
    res.json({ success: true });
  } catch (err) {
    console.error('Error permanently deleting file:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Permanently delete everything currently in the user's trash.
app.post('/api/files/trash/empty', requireAuth, requirePermission('delete'), async (req, res) => {
  const userId = req.session.userId;
  try {
    const rootsRes = await pool.query(
      `SELECT f.id, f.is_folder, f.path, f.owner_id
       FROM files f
       WHERE f.owner_id = $1 AND f.deleted_at IS NOT NULL
         AND (f.parent_id IS NULL OR f.parent_id NOT IN (
           SELECT id FROM files WHERE owner_id = $1 AND deleted_at IS NOT NULL
         ))`,
      [userId]
    );
    for (const file of rootsRes.rows) {
      await hardDeleteTrashItem(file, userId);
    }
    res.json({ success: true, count: rootsRes.rows.length });
  } catch (err) {
    console.error('Error emptying trash:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Download multiple files/folders as a single ZIP
app.get('/api/files/download-zip-multiple', requireAuth, requirePermission('download'), async (req, res) => {
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

    // The physical on-disk extension must go through the same allowlist as uploads/copies
    // (see safeFileExtension above) — `ext` above can come straight from the user-supplied
    // `name` (the `.txt`/`codex`/`other` branch splits on the raw string), and several code
    // paths (thumbnailing, OCR, EXIF read) later shell out with the physical filename
    // interpolated into an exec() string.
    const uniqueFilename = crypto.randomUUID() + safeFileExtension(finalName);
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

// Create a self-destructing one-time note file (optionally with attachments) and automatic
// share link. With attachments, the note text + attachment files are wrapped in a container
// folder that itself carries is_one_time_note = true, reusing the existing folder-share
// browsing/zip-download machinery; without attachments it's a single flagged text file exactly
// as before.
app.post('/api/files/create-note', requireAuth, uploadArray('attachments', 10), fixUploadFilenameEncoding, async (req, res) => {
  const { name, content, maxViews, expiresHours, parentId } = req.body;
  const userId = req.session.userId;
  const parsedParentId = parentId && parentId !== 'null' ? parseInt(parentId) : null;
  const attachments = req.files || [];

  const cleanupAttachments = () => {
    attachments.forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
  };

  if (!name || content === undefined) {
    cleanupAttachments();
    return res.status(400).json({ error: 'Name und Inhalt sind erforderlich.' });
  }

  try {
    if (parsedParentId !== null) {
      const isOwner = await verifyFileOwner(parsedParentId, userId);
      if (!isOwner) {
        cleanupAttachments();
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const cleanName = name.trim().endsWith('.txt') ? name.trim() : name.trim() + '.txt';
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + (parseInt(expiresHours) || 24));

    let containerFileId;

    if (attachments.length > 0) {
      const folderRes = await pool.query(
        `INSERT INTO files (name, path, is_folder, parent_id, owner_id, is_one_time_note)
         VALUES ($1, 'folder', true, $2, $3, true) RETURNING id`,
        [cleanName.replace(/\.txt$/i, ''), parsedParentId, userId]
      );
      const folderId = folderRes.rows[0].id;

      const uniqueFilename = crypto.randomUUID() + '.txt';
      fs.writeFileSync(path.join(UPLOADS_DIR, uniqueFilename), content, 'utf8');
      const size = Buffer.byteLength(content, 'utf8');
      // Children are also flagged is_one_time_note so the flat "exclude one-time notes from
      // listing/search" filter catches them too, without needing a recursive ancestor check.
      await pool.query(
        `INSERT INTO files (name, path, mime_type, size, is_folder, parent_id, owner_id, is_one_time_note, content)
         VALUES ($1, $2, 'text/plain', $3, false, $4, $5, true, $6)`,
        [cleanName, uniqueFilename, size, folderId, userId, content]
      );

      for (const att of attachments) {
        const safeMimeType = getSafeMimeType(att.originalname);
        await pool.query(
          `INSERT INTO files (name, path, mime_type, size, is_folder, parent_id, owner_id, is_one_time_note)
           VALUES ($1, $2, $3, $4, false, $5, $6, true)`,
          [att.originalname, att.filename, safeMimeType, att.size, folderId, userId]
        );
      }

      containerFileId = folderId;
    } else {
      const uniqueFilename = crypto.randomUUID() + '.txt';
      fs.writeFileSync(path.join(UPLOADS_DIR, uniqueFilename), content, 'utf8');
      const size = Buffer.byteLength(content, 'utf8');
      const fileRes = await pool.query(
        `INSERT INTO files (name, path, mime_type, size, is_folder, parent_id, owner_id, is_one_time_note, content)
         VALUES ($1, $2, $3, $4, false, $5, $6, true, $7) RETURNING id`,
        [cleanName, uniqueFilename, 'text/plain', size, parsedParentId, userId, content]
      );
      containerFileId = fileRes.rows[0].id;
    }

    // Generate unique slug
    const slug = crypto.randomBytes(8).toString('hex');

    // Create share record — bundles with attachments also get can_zip so the whole thing can
    // be grabbed in a single request.
    await pool.query(
      `INSERT INTO shares (slug, file_id, can_read, can_write, can_download, can_zip, expires_at, max_downloads, download_count)
       VALUES ($1, $2, true, false, true, $3, $4, $5, 0)`,
      [slug, containerFileId, attachments.length > 0, expiresAt, parseInt(maxViews) || 1]
    );

    // Derived from the request's own Host header (like getExpectedOrigin() does for WebAuthn)
    // instead of the fixed EXPECTED_ORIGIN, so the link works under whichever of the app's
    // configured domains the visitor actually used — relevant behind a multi-domain reverse proxy.
    const shareLink = `${getExpectedOrigin(req)}/s/${slug}`;
    res.json({ success: true, shareLink });
  } catch (err) {
    console.error('Error creating one-time note:', err);
    cleanupAttachments();
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List the current user's one-time notes for the dashboard's dedicated management category.
// Only top-level containers (the standalone note file, or the wrapper folder when it has
// attachments) — never the note-text/attachment children of a wrapper folder, which are also
// flagged is_one_time_note so they're excluded from normal listing/search.
app.get('/api/files/notes', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  try {
    const result = await pool.query(
      `SELECT f.id, f.name, f.is_folder, f.created_at,
              s.id AS share_id, s.slug, s.expires_at, s.max_downloads, s.download_count
       FROM files f
       LEFT JOIN files parent ON parent.id = f.parent_id
       LEFT JOIN shares s ON s.file_id = f.id
       WHERE f.owner_id = $1 AND f.is_one_time_note = true AND f.deleted_at IS NULL
         AND (parent.id IS NULL OR parent.is_one_time_note IS NOT TRUE)
         AND s.id IS NOT NULL
         AND (s.expires_at IS NULL OR s.expires_at > NOW())
         AND (s.max_downloads IS NULL OR s.download_count < s.max_downloads)
       ORDER BY f.created_at DESC`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error listing one-time notes:', err);
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
// Lean autosave version history: called right before a file's content is overwritten, with
// the content as it was *before* this save. Throttled to one checkpoint per file per
// FILE_VERSION_MIN_INTERVAL_MS so continuous typing (autosave fires every 1.5s) doesn't
// create a version on every keystroke pause — only meaningful, spaced-out checkpoints are
// kept. Also caps total versions per file so history stays lean rather than growing forever.
const FILE_VERSION_MIN_INTERVAL_MS = 3 * 60 * 1000;
const FILE_VERSION_MAX_PER_FILE = 30;
async function maybeSaveFileVersion(fileId, oldContent) {
  if (!oldContent) return; // nothing meaningful to check-point yet (new/empty file)
  try {
    const lastRes = await pool.query(
      'SELECT created_at FROM file_versions WHERE file_id = $1 ORDER BY created_at DESC LIMIT 1',
      [fileId]
    );
    const last = lastRes.rows[0];
    if (last && Date.now() - new Date(last.created_at).getTime() < FILE_VERSION_MIN_INTERVAL_MS) return;

    await pool.query('INSERT INTO file_versions (file_id, content) VALUES ($1, $2)', [fileId, oldContent]);
    await pool.query(
      `DELETE FROM file_versions WHERE file_id = $1 AND id NOT IN (
         SELECT id FROM file_versions WHERE file_id = $1 ORDER BY created_at DESC LIMIT $2
       )`,
      [fileId, FILE_VERSION_MAX_PER_FILE]
    );
  } catch (err) {
    console.error('Error saving file version:', err);
  }
}

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

    await maybeSaveFileVersion(fileId, file.content);

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

// Overwrite a file's binary content in place (e.g. a PDF re-saved with annotations/filled-in
// form fields from the in-browser viewer). Unlike /content/:id above this is multipart/binary,
// not JSON text, and keeps the same file id/row — only the on-disk path changes (multer already
// wrote the upload under a fresh UUID name, so we just point the row at it and drop the old
// physical file, same idea as the trash/copy routes swapping `path` without touching `id`).
app.put('/api/files/:id/binary-content', requireAuth, requirePermission('edit_files'), uploadSingle('file'), async (req, res) => {
  const fileId = parseInt(req.params.id);
  const userId = req.session.userId;

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const isOwner = await verifyFileOwner(fileId, userId);
    if (!isOwner) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'Access denied' });
    }

    const fileRes = await pool.query('SELECT * FROM files WHERE id = $1', [fileId]);
    const file = fileRes.rows[0];
    if (!file || file.is_folder) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'File not found or is a folder' });
    }

    const oldPhysicalPath = path.join(UPLOADS_DIR, file.path);
    const textContent = await extractTextContent(req.file.path, file.mime_type, file.name);

    // Only the net size increase counts against quota — usedBytes inside the lock still
    // includes this file's OLD size (its row hasn't been updated yet), so checking the full
    // new size on top of that would double-count the very file being replaced.
    const netAdditionalBytes = req.file.size - (file.size || 0);
    const doUpdate = (client) => client.query(
      'UPDATE files SET path = $1, size = $2, content = $3 WHERE id = $4',
      [req.file.filename, req.file.size, textContent, fileId]
    );
    if (netAdditionalBytes > 0) {
      const quotaResult = await withStorageQuotaLock(userId, netAdditionalBytes, doUpdate);
      if (!quotaResult.ok) {
        fs.unlinkSync(req.file.path);
        return res.status(413).json({ error: quotaResult.error });
      }
    } else {
      await doUpdate(pool);
    }

    if (fs.existsSync(oldPhysicalPath)) fs.unlinkSync(oldPhysicalPath);

    res.json({ success: true, size: req.file.size });
  } catch (err) {
    console.error('Error saving binary file content:', err);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List version history for a file (newest first)
app.get('/api/files/:id/versions', requireAuth, async (req, res) => {
  const fileId = parseInt(req.params.id);
  const userId = req.session.userId;
  try {
    const isOwner = await verifyFileOwner(fileId, userId);
    if (!isOwner) return res.status(403).json({ error: 'Access denied' });

    const result = await pool.query(
      'SELECT id, created_at, LENGTH(content) as size FROM file_versions WHERE file_id = $1 ORDER BY created_at DESC',
      [fileId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error listing file versions:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get a specific version's full content (for preview or restore)
app.get('/api/files/:id/versions/:versionId', requireAuth, async (req, res) => {
  const fileId = parseInt(req.params.id);
  const versionId = parseInt(req.params.versionId);
  const userId = req.session.userId;
  try {
    const isOwner = await verifyFileOwner(fileId, userId);
    if (!isOwner) return res.status(403).json({ error: 'Access denied' });

    const result = await pool.query(
      'SELECT id, content, created_at FROM file_versions WHERE id = $1 AND file_id = $2',
      [versionId, fileId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Version not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching file version:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Restore a file to a previous version's content — checkpoints the current state first (so
// restoring is itself undoable via the same history) then overwrites.
app.post('/api/files/:id/versions/:versionId/restore', requireAuth, requirePermission('edit_files'), async (req, res) => {
  const fileId = parseInt(req.params.id);
  const versionId = parseInt(req.params.versionId);
  const userId = req.session.userId;
  try {
    const isOwner = await verifyFileOwner(fileId, userId);
    if (!isOwner) return res.status(403).json({ error: 'Access denied' });

    const versionRes = await pool.query(
      'SELECT content FROM file_versions WHERE id = $1 AND file_id = $2',
      [versionId, fileId]
    );
    if (versionRes.rows.length === 0) return res.status(404).json({ error: 'Version not found' });
    const restoredContent = versionRes.rows[0].content;

    const fileRes = await pool.query('SELECT * FROM files WHERE id = $1', [fileId]);
    const file = fileRes.rows[0];

    // Checkpoint the current (about-to-be-overwritten) state unconditionally, ignoring the
    // usual throttle — a restore is a deliberate action the user should be able to undo too.
    // The FILE_VERSION_MAX_PER_FILE cap still applies though (only the throttle is skipped),
    // otherwise repeated restores would grow file_versions for this file forever.
    await pool.query('INSERT INTO file_versions (file_id, content) VALUES ($1, $2)', [fileId, file.content]);
    await pool.query(
      `DELETE FROM file_versions WHERE file_id = $1 AND id NOT IN (
         SELECT id FROM file_versions WHERE file_id = $1 ORDER BY created_at DESC LIMIT $2
       )`,
      [fileId, FILE_VERSION_MAX_PER_FILE]
    );

    const filePath = path.join(UPLOADS_DIR, file.path);
    fs.writeFileSync(filePath, restoredContent);
    const stats = fs.statSync(filePath);
    await pool.query('UPDATE files SET size = $1, content = $2 WHERE id = $3', [stats.size, restoredContent, fileId]);

    res.json({ success: true, content: restoredContent });
  } catch (err) {
    console.error('Error restoring file version:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const THUMBNAILS_DIR = path.join(UPLOADS_DIR, 'thumbnails');
if (!fs.existsSync(THUMBNAILS_DIR)) {
  fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
}

// Shared with generateThumbnail() below and both thumbnail routes — SVG is deliberately
// excluded (see the routes): it's an XML format that can embed <script>, and serving it as-is
// would let the browser execute attacker-uploaded SVG inline as a "thumbnail".
const WEB_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'];

// Reads camera make/model + lens out of an image's EXIF data via exiftool (already used above
// for RAW thumbnail extraction). Returns null if the file has no such tags at all (e.g.
// screenshots, AI-generated images, anything stripped of EXIF) so the caller can hide the whole
// section rather than showing empty fields.
function getExifSummary(physicalFilename) {
  return new Promise((resolve) => {
    const inputPath = path.join(UPLOADS_DIR, physicalFilename);
    const { exec } = require('child_process');
    const cmd = `exiftool -j -Make -Model -LensModel -LensID "${inputPath}"`;
    exec(cmd, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const data = JSON.parse(stdout)[0];
        const camera = [data.Make, data.Model].filter(Boolean).join(' ').trim();
        const lens = data.LensModel || data.LensID || null;
        if (!camera && !lens) return resolve(null);
        resolve({ camera: camera || null, lens });
      } catch {
        resolve(null);
      }
    });
  });
}

// Helper to generate a thumbnail using ffmpeg or dcraw/exiftool
function generateThumbnail(physicalFilename, extension) {
  return new Promise((resolve) => {
    const inputPath = path.join(UPLOADS_DIR, physicalFilename);
    const lowerExt = extension.toLowerCase();
    // SVG thumbnails are rasterized to PNG (keeps transparency) — the vector source is never
    // served as a thumbnail itself, only this pre-rendered raster derivative, so no SVG markup
    // (and no <script>/external reference it might contain) ever reaches the client here.
    const outputPath = path.join(THUMBNAILS_DIR, physicalFilename + (lowerExt === 'svg' ? '.png' : '.jpg'));

    if (fs.existsSync(outputPath)) {
      return resolve(outputPath);
    }

    // Check if it's a video
    const videoExts = ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'm4v'];
    // Check if it's a RAW image
    const rawExts = ['cr2', 'nef', 'dng', 'arw', 'orf', 'rw2', 'pef', 'raf'];

    if (lowerExt === 'svg') {
      // rsvg-convert never fetches remote http(s) references, unlike e.g. ImageMagick's SVG
      // delegate — that's precisely why it's the standard safe choice for untrusted SVG input.
      const { exec } = require('child_process');
      const cmd = `rsvg-convert -a -w 512 -h 512 -o "${outputPath}" "${inputPath}"`;
      exec(cmd, (err) => {
        if (!err && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          return resolve(outputPath);
        }
        console.error(`rsvg-convert failed for ${physicalFilename}:`, err);
        resolve(null);
      });
    } else if (videoExts.includes(lowerExt)) {
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
    } else if (WEB_IMAGE_EXTS.includes(lowerExt)) {
      // Standard camera/web images used to be served as their own "thumbnail" (the full
      // original file, routinely several MB) — every grid render re-downloaded and re-decoded
      // that for every tile. Downscale to a small cached JPEG instead, same as the other
      // branches here; callers fall back to the original file if this fails.
      const { exec } = require('child_process');
      const cmd = `ffmpeg -y -i "${inputPath}" -vf "scale='min(480,iw)':-1" -q:v 4 "${outputPath}"`;
      exec(cmd, (err) => {
        if (!err && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          return resolve(outputPath);
        }
        console.error(`ffmpeg image thumbnail failed for ${physicalFilename}:`, err);
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

    // Cached, downscaled thumbnail — covers web images, video and RAW (see generateThumbnail).
    // Content is immutable once generated (physical filenames are per-upload UUIDs, never
    // reused/overwritten), so it's safe to cache aggressively client-side.
    const thumbPath = await generateThumbnail(file.path, ext);
    if (thumbPath && fs.existsSync(thumbPath)) {
      return res.sendFile(thumbPath, { headers: { 'Cache-Control': 'private, max-age=604800, immutable' } });
    }

    // Fallback for standard web images if downscaling failed for some reason (e.g. an
    // unusual/corrupt file ffmpeg can't decode) — SVG is deliberately excluded here, it's an
    // XML format that can embed <script>, and res.sendFile would serve it as image/svg+xml,
    // letting the browser execute an attacker-uploaded SVG inline as a "thumbnail".
    if (WEB_IMAGE_EXTS.includes(ext)) {
      return res.sendFile(filePath);
    }

    res.status(404).json({ error: 'Thumbnail not available' });
  } catch (err) {
    console.error('Thumbnail endpoint error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Single-file metadata, used by the image/video viewer's info panel. Registered after every
// other literal-segment /api/files/... GET route above so this catch-all :id pattern can't
// shadow them.
const EXIF_CAPABLE_EXTS = ['jpg', 'jpeg', 'tif', 'tiff', 'heic', 'heif', 'cr2', 'nef', 'dng', 'arw', 'orf', 'rw2', 'pef', 'raf'];

app.get('/api/files/:id', requireAuth, async (req, res) => {
  const fileId = parseInt(req.params.id);
  const userId = req.session.userId;
  try {
    const fileRes = await pool.query('SELECT * FROM files WHERE id = $1 AND owner_id = $2', [fileId, userId]);
    if (fileRes.rows.length === 0) return res.status(404).json({ error: 'File not found' });
    const file = fileRes.rows[0];
    const ext = file.name.split('.').pop().toLowerCase();
    if (!file.is_folder && EXIF_CAPABLE_EXTS.includes(ext)) {
      file.exif = await getExifSummary(file.path);
    }
    res.json(file);
  } catch (err) {
    console.error('Error fetching file metadata:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


/* ==========================================================================
   SHARING SYSTEM ROUTES
   ========================================================================== */

// Create a share link
// Builds a short, German permission summary for the share-notification email — mirrors the
// flag combinations the share modal itself can produce (see updateSharePermissionsUI() in
// app.js), just phrased as prose instead of individual checkboxes.
function buildSharePermissionLabel({ canRead, canWrite, canDownload, onlyUpload }) {
  if (onlyUpload) return 'Nur Hochladen';
  if (!canRead) return 'Nur Herunterladen';
  if (canWrite) return 'Ansehen & Bearbeiten';
  if (canDownload) return 'Ansehen & Herunterladen';
  return 'Nur Ansehen';
}

app.post('/api/shares', requireAuth, requirePermission('share'), async (req, res) => {
  const { fileId, customSlug, canRead, canWrite, canDownload, canZip, expiresDays, password, maxDownloads, onlyUpload, canCollab, message, notifyEmail } = req.body;
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
    const messageVal = message ? String(message).trim().slice(0, 2000) || null : null;

    const result = await pool.query(
      `INSERT INTO shares (slug, file_id, can_read, can_write, can_download, can_zip, expires_at, password_hash, max_downloads, only_upload, can_collab, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [slug, fileId, canRead !== false, canWrite === true, canDownload !== false, canZip !== false, expiresAt, passwordHash, maxDownloadsVal, onlyUploadVal, canCollab === true, messageVal]
    );
    const share = result.rows[0];

    let notified = false;
    const recipientEmail = notifyEmail ? String(notifyEmail).trim() : '';
    if (recipientEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      try {
        const fileRes = await pool.query('SELECT name, is_folder FROM files WHERE id = $1', [fileId]);
        const file = fileRes.rows[0];
        const sharerRes = await pool.query('SELECT username, first_name, last_name, display_real_name FROM users WHERE id = $1', [userId]);
        const branding = await getEmailBranding();
        const shareUrl = `${branding.appUrl}/s/${share.slug}`;

        let html = renderEmailTemplate('share-notification', {
          CLOUD_NAME: branding.cloudName,
          LOGO_MARK: { raw: branding.logoMark },
          APP_URL: branding.appUrl,
          SHARER_NAME: getUserDisplayName(sharerRes.rows[0]),
          USER_NAME: recipientEmail.split('@')[0],
          ITEM_NAME: file.name,
          ITEM_TYPE: file.is_folder ? 'Ordner' : 'Datei',
          ITEM_ICON: { raw: file.is_folder ? '&#128193;' : '&#128196;' },
          ITEM_PERMISSION: buildSharePermissionLabel({ canRead: share.can_read, canWrite: share.can_write, canDownload: share.can_download, onlyUpload: share.only_upload }),
          SHARE_URL: { raw: shareUrl },
          EXPIRES_AT: share.expires_at ? new Date(share.expires_at).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '',
        });
        html = applyConditionalBlock(html, 'EXPIRY', !!share.expires_at);
        html = applyConditionalBlock(html, 'PWDPROTECTED', !!share.password_hash);

        notified = await sendMail({
          to: recipientEmail,
          subject: `${getUserDisplayName(sharerRes.rows[0])} hat etwas mit dir geteilt`,
          text: `${getUserDisplayName(sharerRes.rows[0])} hat dir über ${branding.cloudName} "${file.name}" freigegeben:\n${shareUrl}`,
          html,
          templated: true,
        });
      } catch (mailErr) {
        console.error('Error sending share notification email:', mailErr);
      }
    }

    res.status(201).json({ ...share, notified });
  } catch (err) {
    console.error('Error creating share:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update an existing share link
app.put('/api/shares/:id', requireAuth, async (req, res) => {
  const shareId = parseInt(req.params.id);
  const { customSlug, canRead, canWrite, canDownload, canZip, expiresDays, password, maxDownloads, onlyUpload, removePassword, canCollab, message } = req.body;
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

    const messageVal = (message !== undefined)
      ? (message ? String(message).trim().slice(0, 2000) || null : null)
      : share.message;

    const result = await pool.query(
      `UPDATE shares
       SET slug = $1, can_read = $2, can_write = $3, can_download = $4, can_zip = $5, expires_at = $6,
           password_hash = $7, max_downloads = $8, only_upload = $9, can_collab = $10, message = $11
       WHERE id = $12 RETURNING *`,
      [slug, canRead !== false, canWrite === true, canDownload !== false, canZip !== false, expiresAt,
       passwordHash, maxDownloadsVal, onlyUploadVal, canCollabVal, messageVal, shareId]
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
// The callback route (below) now requires this same token, not just the download route — so
// its lifetime has to cover a whole editing session, not just the initial fetch. It's refreshed
// (see the download and callback handlers) on every use, so an actively-edited document never
// times out; only a genuinely abandoned session ages out and gets swept below.
const OFFICE_TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

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
      expires: Date.now() + OFFICE_TOKEN_TTL_MS
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
        callbackUrl: `${internalAppUrl}/api/eurooffice/callback/${file.id}?userId=${userId}&token=${token}`,
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
  // Sliding renewal — the document server re-fetches the doc periodically during a live editing
  // session, so as long as that's happening the token keeps getting pushed back out; only a
  // session with no activity for the full TTL actually expires.
  tokenData.expires = Date.now() + OFFICE_TOKEN_TTL_MS;

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

  // This endpoint has no session auth — it's called by the internal EuroOffice document server,
  // not a browser. Two independent guards stand in for that:
  //   1. `token` must match the officeTokens entry minted for THIS fileId when the editor was
  //      opened (config route above) — closes the IDOR (an attacker POSTing an arbitrary fileId
  //      with no way to know a live token for it).
  //   2. `url` must resolve to exactly the document server's own host/port/protocol, with no
  //      embedded userinfo. A plain `startsWith(internalOfficeOrigin)` check looks equivalent
  //      but isn't: "http://eurooffice:80@attacker.example/x" also starts with
  //      "http://eurooffice:80" as a string, yet Node's URL/http client treats everything
  //      before the "@" as userinfo and actually connects to attacker.example — full SSRF
  //      bypass. Parsing with `new URL()` and comparing fields exactly closes that off.
  const internalOfficeOrigin = process.env.EURO_OFFICE_URL || 'http://eurooffice:80';
  const tokenData = req.query.token && officeTokens.get(req.query.token);
  const tokenValid = !!tokenData && tokenData.fileId === fileId && tokenData.expires > Date.now();

  let isInternalUrl = false;
  if (url) {
    try {
      const parsedUrl = new URL(url);
      const parsedOrigin = new URL(internalOfficeOrigin);
      const defaultPort = (u) => u.port || (u.protocol === 'https:' ? '443' : '80');
      isInternalUrl = !parsedUrl.username && !parsedUrl.password
        && parsedUrl.protocol === parsedOrigin.protocol
        && parsedUrl.hostname === parsedOrigin.hostname
        && defaultPort(parsedUrl) === defaultPort(parsedOrigin);
    } catch {
      isInternalUrl = false;
    }
  }

  if (status === 2 && isInternalUrl && tokenValid) {
    tokenData.expires = Date.now() + OFFICE_TOKEN_TTL_MS; // sliding renewal, see download handler
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
    const registrationEnabled = (await getSetting('registration_enabled')) === 'true';
    // Registration is always allowed for the very first account (bootstrapping the initial
    // admin) regardless of the setting — the frontend needs to know that to decide whether to
    // show the "Registrieren" option on a fresh install where the setting is still off.
    const hasUsersRes = await pool.query('SELECT EXISTS(SELECT 1 FROM users)');
    const hasUsers = hasUsersRes.rows[0].exists;

    const footerEnabled = (await getSetting('footer_enabled')) === 'true';
    let footerLinks = [];
    try { footerLinks = JSON.parse((await getSetting('footer_links')) || '[]'); } catch { footerLinks = []; }

    const defaultTheme = (await getSetting('default_theme')) || 'nova';

    res.json({ name, tabName, hasIcon, customColorBg, customColorAccent, hasDashboardBg, hasLoginBg, hasDashboardBgLight, hasLoginBgLight, appUrl, emailConfigured, registrationEnabled, hasUsers, footerEnabled, footerLinks, appVersion: APP_VERSION, defaultTheme });
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

// Get SEO/Open-Graph preview image — falls back to the cloud icon if no dedicated one was
// uploaded, so link previews still show something once branding is set up.
app.get('/api/public/branding/seo-image', async (req, res) => {
  try {
    const imgPath = (await getSetting('seo_image_path')) || (await getSetting('cloud_icon_path'));
    if (imgPath) {
      const filePath = path.join(UPLOADS_DIR, imgPath);
      if (fs.existsSync(filePath)) {
        return res.sendFile(filePath);
      }
    }
    res.status(404).send('Image not found');
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
app.post('/api/settings/admin/icon', requireAdmin, uploadSingle('icon'), async (req, res) => {
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

// Upload SEO/Open-Graph preview image (Admin only)
app.post('/api/settings/admin/seo-image', requireAdmin, uploadSingle('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided.' });
  }

  try {
    const oldImg = await getSetting('seo_image_path');
    await setSetting('seo_image_path', req.file.filename);

    if (oldImg) {
      const oldFilePath = path.join(UPLOADS_DIR, oldImg);
      if (fs.existsSync(oldFilePath)) {
        fs.unlinkSync(oldFilePath);
      }
    }

    res.json({ success: true, imageUrl: `/api/public/branding/seo-image?t=${Date.now()}` });
  } catch (err) {
    console.error('Error saving SEO image:', err);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove SEO/Open-Graph preview image (Admin only)
app.delete('/api/settings/admin/seo-image', requireAdmin, async (req, res) => {
  try {
    const oldImg = await getSetting('seo_image_path');
    if (oldImg) {
      const oldFilePath = path.join(UPLOADS_DIR, oldImg);
      if (fs.existsSync(oldFilePath)) {
        fs.unlinkSync(oldFilePath);
      }
    }
    await setSetting('seo_image_path', '');
    res.json({ success: true });
  } catch (err) {
    console.error('Error removing SEO image:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Upload Dashboard Background (Admin only) — variant: dark (default) | light
app.post('/api/settings/admin/dashboard-bg', requireAdmin, uploadSingle('image'), async (req, res) => {
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
app.post('/api/settings/admin/login-bg', requireAdmin, uploadSingle('image'), async (req, res) => {
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

    // Get the base file/folder shared
    const baseFileRes = await pool.query('SELECT id, name, is_folder, owner_id, size, is_one_time_note FROM files WHERE id = $1', [share.file_id]);
    if (baseFileRes.rows.length === 0) {
      return res.status(404).json({ error: 'Shared content no longer exists.' });
    }

    const baseFile = baseFileRes.rows[0];

    // Handle one-time note session activation & lock
    if (baseFile.is_one_time_note) {
      if (share.accessed_at) {
        // Already accessed. Check if it's the same session.
        const isSameSession = req.session.accessedOneTimeShares && req.session.accessedOneTimeShares[slug];
        if (!isSameSession) {
          return res.status(410).json({ error: 'This one-time link has already been opened and burned.' });
        }
      } else if (req.query.confirmed === 'true') {
        // First access and confirmed. Record it, increment download_count, and bind to session.
        await pool.query(
          'UPDATE shares SET accessed_at = NOW(), last_heartbeat = NOW(), download_count = download_count + 1 WHERE id = $1',
          [share.id]
        );
        req.session.accessedOneTimeShares = req.session.accessedOneTimeShares || {};
        req.session.accessedOneTimeShares[slug] = true;
        share.download_count += 1;
      }
    }

    // Check download limit
    if (share.max_downloads !== null && share.download_count >= share.max_downloads) {
      const isSameSession = baseFile.is_one_time_note && req.session.accessedOneTimeShares && req.session.accessedOneTimeShares[slug];
      if (!isSameSession) {
        return res.status(410).json({ error: 'This share has reached its download limit.' });
      }
    }

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
      const isValidChild = await isDescendantOf(parentId, baseFile.id);

      if (!isValidChild) {
        return res.status(403).json({ error: 'Access denied.' });
      }
      currentFolderId = parentId;
    }

    // List files inside the current folder
    let files = [];
    if ((share.only_upload || !share.can_read) && baseFile.is_folder) {
      // "Only Upload" mode, or a share with read access explicitly disabled: return an empty
      // list — folder browsing must not be possible just because can_read wasn't re-checked
      // here (single-file shares still return the base file below regardless of can_read, since
      // those are meant to keep working as plain direct-download links).
      files = [];
    } else if (baseFile.is_folder) {
      // Scoped to the share owner (like the equivalent authenticated listing/search queries) —
      // without owner_id here, this recursively aggregated over every file of every user on the
      // whole server on every single (unauthenticated, unrate-limited) request to this route.
      const filesRes = await pool.query(
        `WITH RECURSIVE folder_sizes AS (
           SELECT id, size, parent_id
           FROM files
           WHERE is_folder = false AND owner_id = $2 AND deleted_at IS NULL

           UNION ALL

           SELECT f.id, fs.size, f.parent_id
           FROM files f
           JOIN folder_sizes fs ON f.id = fs.parent_id
           WHERE f.owner_id = $2
         )
         SELECT f.id, f.name, COALESCE(f.size, sz.total_size, 0) as size, f.is_folder, f.mime_type, f.created_at, f.parent_id
         FROM files f
         LEFT JOIN (
           SELECT id, SUM(size) as total_size
           FROM folder_sizes
           GROUP BY id
         ) sz ON f.id = sz.id
         WHERE f.parent_id = $1 AND f.deleted_at IS NULL
         ORDER BY f.is_folder DESC, f.name ASC`,
        [currentFolderId, baseFile.owner_id]
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
        message: share.message,
      },
      baseFile: {
        id: baseFile.id,
        name: baseFile.name,
        is_folder: baseFile.is_folder,
        size: baseFile.size,
        is_one_time_note: baseFile.is_one_time_note,
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
// Share passwords are typically short/simple (no strength requirement in the UI) and this route
// had no attempt limit at all, unlike the account-login/2FA equivalents — an unbounded, scriptable
// brute force against a known slug. Same in-memory-counter pattern as loginAttempts, keyed by slug.
const shareUnlockAttempts = new Map(); // slug -> { count, resetAt }
const SHARE_UNLOCK_MAX_ATTEMPTS = 10;
const SHARE_UNLOCK_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of shareUnlockAttempts.entries()) {
    if (entry.resetAt < now) shareUnlockAttempts.delete(id);
  }
}, 10 * 60 * 1000);

app.post('/api/public/shares/:slug/unlock', async (req, res) => {
  const { slug } = req.params;
  const { password } = req.body;

  const now = Date.now();
  const attemptEntry = shareUnlockAttempts.get(slug);
  if (attemptEntry && attemptEntry.resetAt >= now && attemptEntry.count >= SHARE_UNLOCK_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte versuche es in ein paar Minuten erneut.' });
  }

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
      if (!attemptEntry || attemptEntry.resetAt < now) {
        shareUnlockAttempts.set(slug, { count: 1, resetAt: now + SHARE_UNLOCK_ATTEMPT_WINDOW_MS });
      } else {
        attemptEntry.count++;
      }
      return res.status(401).json({ error: 'Falsches Passwort.' });
    }

    shareUnlockAttempts.delete(slug);
    req.session.unlockedShares = req.session.unlockedShares || {};
    req.session.unlockedShares[slug] = true;

    res.json({ success: true });
  } catch (err) {
    console.error('Error unlocking share:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Helper for public share validation
async function verifyPublicShareAccess(slug, fileId, req) {
  const shareRes = await pool.query('SELECT * FROM shares WHERE slug = $1', [slug]);
  if (shareRes.rows.length === 0) return { error: 'Share link not found.', status: 404 };

  const share = shareRes.rows[0];
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return { error: 'Share has expired.', status: 410 };
  }

  // Check download limit — this must be enforced here too (not just in the top-level listing
  // and single-file-download routes), otherwise content/meta/thumbnail/eurooffice-config all
  // keep working forever once the cap is reached.
  if (share.max_downloads !== null && share.download_count >= share.max_downloads) {
    const fileRes = await pool.query('SELECT is_one_time_note FROM files WHERE id = $1', [share.file_id]);
    const baseFile = fileRes.rows[0];
    const isSameSession = baseFile && baseFile.is_one_time_note && req.session.accessedOneTimeShares && req.session.accessedOneTimeShares[slug];
    if (!isSameSession) {
      return { error: 'This share has reached its download limit.', status: 410 };
    }
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
  const isValid = await isDescendantOf(file.id, share.file_id);

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

    // Atomic increment bounded by max_downloads, done before reading/sending content so two
    // concurrent views of a one-time note can't both succeed before either's increment runs
    // (mirrors the fix applied to the file/ZIP download routes for the same race).
    const incRes = await pool.query(
      `UPDATE shares SET download_count = download_count + 1
       WHERE id = $1 AND (max_downloads IS NULL OR download_count < max_downloads)
       RETURNING *`,
      [share.id]
    );
    if (incRes.rows.length === 0) {
      return res.status(410).json({ error: 'This share has reached its download limit.' });
    }

    const content = fs.readFileSync(filePath, 'utf8');

    res.type('text/plain').send(content);
  } catch (err) {
    console.error('Public content fetch error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Single-file metadata for a publicly shared file, used by the image/video viewer's info panel.
app.get('/api/public/shares/:slug/meta/:fileId', async (req, res) => {
  const { slug, fileId } = req.params;
  try {
    const access = await verifyPublicShareAccess(slug, fileId, req);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const file = access.file;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!file.is_folder && EXIF_CAPABLE_EXTS.includes(ext)) {
      file.exif = await getExifSummary(file.path);
    }
    res.json(file);
  } catch (err) {
    console.error('Public metadata fetch error:', err);
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

// Overwrite a publicly-shared file's binary content in place — the writable-share counterpart
// to PUT /api/files/:id/binary-content above (e.g. a guest filling in/annotating a shared PDF).
app.put('/api/public/shares/:slug/binary-content/:fileId', uploadSingle('file'), async (req, res) => {
  const { slug, fileId } = req.params;

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const access = await verifyPublicShareAccess(slug, fileId, req);
    if (access.error) {
      fs.unlinkSync(req.file.path);
      return res.status(access.status).json({ error: access.error });
    }

    const { file, share } = access;
    if (!share.can_write) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'Write permission denied.' });
    }
    if (file.is_folder) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Folders do not have binary content' });
    }

    const oldPhysicalPath = path.join(UPLOADS_DIR, file.path);
    const textContent = await extractTextContent(req.file.path, file.mime_type, file.name);

    // Charged against the file OWNER's quota (there's no uploader account on a public share) —
    // only the net size increase counts, since usedBytes inside the lock still includes this
    // file's OLD size until the UPDATE below runs.
    const netAdditionalBytes = req.file.size - (file.size || 0);
    const doUpdate = (client) => client.query(
      'UPDATE files SET path = $1, size = $2, content = $3 WHERE id = $4',
      [req.file.filename, req.file.size, textContent, file.id]
    );
    if (netAdditionalBytes > 0) {
      const quotaResult = await withStorageQuotaLock(file.owner_id, netAdditionalBytes, doUpdate);
      if (!quotaResult.ok) {
        fs.unlinkSync(req.file.path);
        return res.status(413).json({ error: quotaResult.error });
      }
    } else {
      await doUpdate(pool);
    }

    if (fs.existsSync(oldPhysicalPath)) fs.unlinkSync(oldPhysicalPath);

    res.json({ success: true, size: req.file.size });
  } catch (err) {
    console.error('Public binary content save error:', err);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
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
      expires: Date.now() + OFFICE_TOKEN_TTL_MS
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
        callbackUrl: `${internalAppUrl}/api/eurooffice/callback/${file.id}?token=${token}`,
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

    // Cached, downscaled thumbnail — covers web images, video and RAW (see generateThumbnail).
    // Content is immutable once generated (physical filenames are per-upload UUIDs, never
    // reused/overwritten), so it's safe to cache aggressively client-side.
    const thumbPath = await generateThumbnail(file.path, ext);
    if (thumbPath && fs.existsSync(thumbPath)) {
      return res.sendFile(thumbPath, { headers: { 'Cache-Control': 'private, max-age=604800, immutable' } });
    }

    // Fallback for standard web images if downscaling failed for some reason (e.g. an
    // unusual/corrupt file ffmpeg can't decode) — SVG is deliberately excluded here, it's an
    // XML format that can embed <script>, and res.sendFile would serve it as image/svg+xml,
    // letting the browser execute an attacker-uploaded SVG inline as a "thumbnail".
    if (WEB_IMAGE_EXTS.includes(ext)) {
      return res.sendFile(filePath);
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
    if (file.is_folder) return res.status(400).json({ error: 'Cannot download folder.' });

    const filePath = path.join(UPLOADS_DIR, file.path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Physical file not found.' });

    // Atomic increment bounded by max_downloads, done before streaming starts so two
    // concurrent downloads can't both slip past the limit (a plain read-then-write, as this
    // route used to do via a post-stream callback, lets that race through — mirrors the fix
    // already applied to the ZIP download route).
    if (!file.is_one_time_note) {
      const incRes = await pool.query(
        `UPDATE shares SET download_count = download_count + 1
         WHERE id = $1 AND (max_downloads IS NULL OR download_count < max_downloads)
         RETURNING *`,
        [share.id]
      );
      if (incRes.rows.length === 0) {
        return res.status(410).json({ error: 'This share has reached its download limit.' });
      }
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
    console.error('Public download error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Public Share Upload - Allow uploads to shared folder if write permission exists
app.post('/api/public/shares/:slug/upload', uploadSingle('file'), fixUploadFilenameEncoding, async (req, res) => {
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
    if (share.max_downloads !== null && share.download_count >= share.max_downloads) {
      fs.unlinkSync(req.file.path);
      return res.status(410).json({ error: 'This share has reached its download limit.' });
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

    const quotaResult = await withStorageQuotaLock(baseFile.owner_id, req.file.size, (client) => client.query(
      `INSERT INTO files (name, path, mime_type, size, is_folder, parent_id, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.file.originalname, req.file.filename, getSafeMimeType(req.file.originalname), req.file.size, false, targetFolderId, baseFile.owner_id]
    ));
    if (!quotaResult.ok) {
      fs.unlinkSync(req.file.path);
      return res.status(413).json({ error: quotaResult.error });
    }

    res.status(201).json(quotaResult.data.rows[0]);
  } catch (err) {
    console.error('Public upload error:', err);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Shared checks for the write-capable public-share routes below (create/delete/paste): the
// share must be live, writable, and (if password-protected) already unlocked in this session.
async function verifyPublicWriteAccess(slug, req) {
  const shareRes = await pool.query('SELECT * FROM shares WHERE slug = $1', [slug]);
  if (shareRes.rows.length === 0) return { error: 'Share link not found.', status: 404 };
  const share = shareRes.rows[0];
  if (share.expires_at && new Date(share.expires_at) < new Date()) return { error: 'Share has expired.', status: 410 };
  if (share.max_downloads !== null && share.download_count >= share.max_downloads) {
    return { error: 'This share has reached its download limit.', status: 410 };
  }
  if (!share.can_write) return { error: 'Write permissions denied.', status: 403 };
  const isUnlocked = req.session.unlockedShares && req.session.unlockedShares[slug];
  if (share.password_hash && !isUnlocked) return { error: 'Password required.', status: 401 };
  const baseFileRes = await pool.query('SELECT id, owner_id FROM files WHERE id = $1', [share.file_id]);
  if (baseFileRes.rows.length === 0) return { error: 'Shared content no longer exists.', status: 404 };
  return { share, baseFile: baseFileRes.rows[0] };
}

// Walks fileId's parent_id chain up to see whether it is baseFileId or one of its descendants
// — guards every write route below against a guest supplying an id outside the shared subtree.
async function isWithinSharedFolder(fileId, baseFileId) {
  return isDescendantOf(fileId, baseFileId);
}

// Create a folder inside a writable public share
app.post('/api/public/shares/:slug/folder', async (req, res) => {
  const { slug } = req.params;
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });

  try {
    const access = await verifyPublicWriteAccess(slug, req);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const { baseFile } = access;

    const targetFolderId = req.body.parentId ? parseInt(req.body.parentId) : baseFile.id;
    if (!(await isWithinSharedFolder(targetFolderId, baseFile.id))) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const result = await pool.query(
      `INSERT INTO files (name, path, is_folder, parent_id, owner_id) VALUES ($1, 'folder', true, $2, $3) RETURNING *`,
      [name, targetFolderId, baseFile.owner_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Public create-folder error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Create an empty text file inside a writable public share
app.post('/api/public/shares/:slug/file', async (req, res) => {
  const { slug } = req.params;
  const rawName = (req.body.name || '').trim();
  if (!rawName) return res.status(400).json({ error: 'Name is required.' });

  try {
    const access = await verifyPublicWriteAccess(slug, req);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const { baseFile } = access;

    const targetFolderId = req.body.parentId ? parseInt(req.body.parentId) : baseFile.id;
    if (!(await isWithinSharedFolder(targetFolderId, baseFile.id))) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const cleanName = rawName.includes('.') ? rawName : rawName + '.txt';
    const uniqueFilename = crypto.randomUUID() + '.txt';
    fs.writeFileSync(path.join(UPLOADS_DIR, uniqueFilename), '');

    const result = await pool.query(
      `INSERT INTO files (name, path, mime_type, size, is_folder, parent_id, owner_id, content)
       VALUES ($1, $2, 'text/plain', 0, false, $3, $4, '') RETURNING *`,
      [cleanName, uniqueFilename, targetFolderId, baseFile.owner_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Public create-file error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Delete a file/folder inside a writable public share
app.delete('/api/public/shares/:slug/files/:fileId', async (req, res) => {
  const { slug, fileId } = req.params;
  const fid = parseInt(fileId);

  try {
    const access = await verifyPublicWriteAccess(slug, req);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const { baseFile } = access;

    if (fid === baseFile.id) return res.status(403).json({ error: 'Cannot delete the shared root.' });
    if (!(await isWithinSharedFolder(fid, baseFile.id))) return res.status(403).json({ error: 'Access denied.' });

    const fileRes = await pool.query('SELECT * FROM files WHERE id = $1 AND owner_id = $2', [fid, baseFile.owner_id]);
    if (fileRes.rows.length === 0) return res.status(404).json({ error: 'Not found.' });

    // Soft-delete into the owner's trash, same as an owner-initiated delete — a
    // collaborator deleting the wrong file via a writable share link is recoverable too.
    await moveToTrashRecursive(fid, baseFile.owner_id, new Date());
    res.json({ success: true });
  } catch (err) {
    console.error('Public delete error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Copy or move (cut+paste) a file/folder within a writable public share
app.post('/api/public/shares/:slug/paste', async (req, res) => {
  const { slug } = req.params;
  const fid = parseInt(req.body.fileId);
  const action = req.body.action === 'cut' ? 'cut' : 'copy';

  try {
    const access = await verifyPublicWriteAccess(slug, req);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const { baseFile } = access;

    const targetFolderId = req.body.targetParentId ? parseInt(req.body.targetParentId) : baseFile.id;
    if (!(await isWithinSharedFolder(fid, baseFile.id)) || !(await isWithinSharedFolder(targetFolderId, baseFile.id))) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    if (action === 'cut') {
      await pool.query('UPDATE files SET parent_id = $1 WHERE id = $2 AND owner_id = $3', [targetFolderId, fid, baseFile.owner_id]);
    } else {
      await copyFileOrFolderRecursive(fid, targetFolderId, baseFile.owner_id);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Public paste error:', err);
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

    if (!targetFolder.is_one_time_note) {
      const incRes = await pool.query(
        `UPDATE shares SET download_count = download_count + 1
         WHERE id = $1 AND (max_downloads IS NULL OR download_count < max_downloads)
         RETURNING *`,
        [share.id]
      );
      if (incRes.rows.length === 0) {
        return res.status(410).json({ error: 'This share has reached its download limit.' });
      }
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(targetFolder.name)}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    // archiver emits 'error' asynchronously (e.g. the client aborting the download mid-stream,
    // or a file disappearing while being zipped) — by then this handler runs outside the
    // surrounding try/catch's call stack, so `throw`ing here would be an uncaught exception
    // that crashes the whole process for every user. Log and just end the response instead.
    archive.on('error', (err) => {
      console.error('ZIP archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create ZIP.' });
      } else {
        res.end();
      }
    });
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
app.post('/api/settings/avatar', requireAuth, uploadSingle('avatar'), async (req, res) => {
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
// No legitimate caller ever requests anyone's avatar but their own (nav bar / settings preview
// both use currentUser.id) — requireAuth just closes off unauthenticated enumeration/harvesting
// of every user's profile photo via the sequential numeric id, without affecting real usage.
app.get('/api/users/:id/avatar', requireAuth, async (req, res) => {
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
    const userRes = await pool.query('SELECT id, username, role, email, first_name, last_name, display_real_name, two_factor_email, two_factor_totp, theme_preference FROM users WHERE id = $1', [userId]);
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
      // Same for the SSO client secret — never send the plaintext value back, even to admins
      if (data.adminConfig.sso_client_secret) {
        data.adminConfig.sso_client_secret_configured = true;
        delete data.adminConfig.sso_client_secret;
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
    const rawQuota = userRes.rows[0].storage_quota;
    const quotaBytes = (rawQuota !== null && rawQuota !== undefined) ? parseInt(rawQuota) : null;

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

  // Unlike /api/auth/set-username, this route accepted any username unvalidated — only
  // uniqueness was checked. Applying the same character whitelist/length limit here closes that
  // gap consistently (frontend already escapes usernames wherever it renders one today, but an
  // unvalidated value is one un-escaped render call away from becoming a stored-XSS vector).
  const cleanUsername = username.trim().replace(/[^a-zA-Z0-9-_]/g, '');
  if (cleanUsername.length < 3 || cleanUsername.length > 30) {
    return res.status(400).json({ error: 'Der Name muss 3 bis 30 Zeichen lang sein und darf nur Buchstaben, Zahlen, Bindestriche und Unterstriche enthalten.' });
  }

  try {
    // Check conflicts
    const conflictRes = await pool.query(
      'SELECT id FROM users WHERE (username = $1 OR email = $2) AND id != $3',
      [cleanUsername, email, userId]
    );

    if (conflictRes.rows.length > 0) {
      return res.status(400).json({ error: 'Benutzername oder E-Mail wird bereits von einem anderen Benutzer verwendet.' });
    }

    const result = await pool.query(
      `UPDATE users
       SET first_name = $1, last_name = $2, username = $3, email = $4, display_real_name = $5
       WHERE id = $6 RETURNING id, username, role, email, first_name, last_name, display_real_name`,
      [first_name || null, last_name || null, cleanUsername, email, !!display_real_name, userId]
    );

    // Update session cache
    req.session.username = cleanUsername;

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('Error updating profile settings:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Set the current user's personal theme override (null = follow the cloud-wide default)
const AVAILABLE_THEMES = ['liquidglass', 'nova'];
app.post('/api/settings/theme', requireAuth, async (req, res) => {
  const { theme } = req.body;
  if (theme !== null && !AVAILABLE_THEMES.includes(theme)) {
    return res.status(400).json({ error: 'Unbekanntes Theme.' });
  }
  try {
    await pool.query('UPDATE users SET theme_preference = $1 WHERE id = $2', [theme, req.session.userId]);
    res.json({ success: true, theme });
  } catch (err) {
    console.error('Error updating theme preference:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Post settings email
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

      // A settings value containing a newline would otherwise let it break out of its own
      // "KEY=value" line and inject arbitrary extra environment variables into the .env file.
      // Strip line breaks — none of the mapped settings (URLs, hosts, ports, credentials) are
      // legitimately multi-line.
      const safeValue = String(value).replace(/[\r\n]+/g, ' ');

      let found = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith(`${envKey}=`)) {
          lines[i] = `${envKey}=${safeValue}`;
          found = true;
          break;
        }
      }
      if (!found) {
        lines.push(`${envKey}=${safeValue}`);
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
    if ('trash_retention_days' in configs) {
      const n = parseInt(configs.trash_retention_days);
      if (!Number.isFinite(n) || n < 1 || n > 365) {
        return res.status(400).json({ error: 'Papierkorb-Aufbewahrungsdauer muss zwischen 1 und 365 Tagen liegen.' });
      }
      configs.trash_retention_days = String(n);
    }

    if ('max_upload_size_mb' in configs) {
      const n = parseInt(configs.max_upload_size_mb);
      if (!Number.isFinite(n) || n < MIN_UPLOAD_SIZE_MB || n > MAX_UPLOAD_SIZE_MB_CEILING) {
        return res.status(400).json({ error: `Maximale Upload-Größe muss zwischen ${MIN_UPLOAD_SIZE_MB} und ${MAX_UPLOAD_SIZE_MB_CEILING} MB liegen.` });
      }
      configs.max_upload_size_mb = String(n);
    }

    if ('sso_button_text' in configs && configs.sso_button_text.length > 60) {
      return res.status(400).json({ error: 'Button-Text darf maximal 60 Zeichen lang sein.' });
    }

    if ('default_theme' in configs && !AVAILABLE_THEMES.includes(configs.default_theme)) {
      return res.status(400).json({ error: 'Unbekanntes Standard-Theme.' });
    }

    if ('seo_title' in configs && configs.seo_title.length > 70) {
      return res.status(400).json({ error: 'SEO-Titel darf maximal 70 Zeichen lang sein.' });
    }
    if ('seo_description' in configs && configs.seo_description.length > 200) {
      return res.status(400).json({ error: 'SEO-Beschreibung darf maximal 200 Zeichen lang sein.' });
    }

    // Guard against ever reaching a state where neither password/passkey login nor SSO
    // works — that would lock every admin out of the web UI with no way back in short of
    // editing the database directly.
    if ('sso_only' in configs && configs.sso_only === 'true') {
      const ssoEnabled = 'sso_enabled' in configs
        ? configs.sso_enabled === 'true'
        : (await getSetting('sso_enabled')) === 'true';
      if (!ssoEnabled) {
        return res.status(400).json({ error: 'SSO muss aktiviert sein, bevor die Passwort-/Passkey-Anmeldung deaktiviert werden kann.' });
      }
    }
    if ('sso_enabled' in configs && configs.sso_enabled === 'false') {
      const ssoOnly = 'sso_only' in configs
        ? configs.sso_only === 'true'
        : (await getSetting('sso_only')) === 'true';
      if (ssoOnly) {
        return res.status(400).json({ error: 'SSO kann nicht deaktiviert werden, solange "Nur SSO-Anmeldung" aktiv ist. Bitte diese Option zuerst deaktivieren.' });
      }
    }

    const keysChanged = Object.keys(configs);
    const smtpKeys = ['email_smtp_host', 'email_smtp_port', 'email_smtp_user', 'email_smtp_pass', 'email_from', 'email_from_name'];
    if (keysChanged.some(k => smtpKeys.includes(k))) {
      await setSetting('email_smtp_tested', 'false');
    }

    const activeConfigs = {};
    for (const [key, value] of Object.entries(configs)) {
      // Avoid overwriting password/secret with the placeholder the client echoes back
      // when it never received the real value (see GET /api/settings redaction above).
      if ((key === 'email_smtp_pass' || key === 'sso_client_secret') && value === '__placeholder__') {
        continue;
      }
      await setSetting(key, value);
      activeConfigs[key] = value;
    }

    // Write updates back to .env
    updateEnvFile(activeConfigs);

    if ('max_upload_size_mb' in activeConfigs) {
      await refreshMaxUploadSizeBytes();
    }

    res.json({ success: true, message: 'System configurations updated.' });
  } catch (err) {
    console.error('Error updating admin config:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: software/.env/docker-compose.yml versions, each compared against what the
// running code expects (see version.js), plus a GitHub check for a newer software
// release (read-only — this never pulls code or updates anything by itself).
app.get('/api/settings/admin/version-status', requireAdmin, async (req, res) => {
  try {
    const update = await checkForUpdate(req.query.force === 'true');
    res.json({ ...getVersionStatus(), update: { ...update, repo: GITHUB_REPO } });
  } catch (err) {
    console.error('Error fetching version status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin test SMTP connection
app.post('/api/settings/admin/test-smtp', requireAdmin, async (req, res) => {
  const { to } = req.body;
  if (!to) {
    return res.status(400).json({ error: 'Test email address is required.' });
  }

  const branding = await getEmailBranding();
  const smtpHost = await getSetting('email_smtp_host') || process.env.EMAIL_SMTP_HOST || '';
  const sentAt = new Date().toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });

  const sent = await sendMail({
    to,
    subject: `${branding.cloudName} - SMTP Connection Test`,
    text: `Hallo ${req.session.username},\n\ndiese Test-E-Mail bestätigt, dass dein ${branding.cloudName}-Server E-Mails erfolgreich über deine hinterlegten SMTP-Einstellungen versenden kann.`,
    html: renderEmailTemplate('test', {
      CLOUD_NAME: branding.cloudName,
      LOGO_MARK: { raw: branding.logoMark },
      APP_URL: branding.appUrl,
      USER_NAME: req.session.username,
      SMTP_HOST: smtpHost,
      SENT_AT: sentAt,
    }),
    templated: true,
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
       u.last_login_at, u.last_failed_login_at,
       (SELECT COUNT(*) FROM files WHERE owner_id = u.id) as file_count,
       (SELECT COALESCE(SUM(size), 0) FROM files WHERE owner_id = u.id AND is_folder = false) as storage_used
       FROM users u
       ORDER BY (u.last_failed_login_at IS NOT NULL) DESC, u.username ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Admin list users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// The permission keys the UI exposes (single source of truth)
const ROLE_PERMISSION_KEYS = ['admin', 'upload', 'create_folder', 'delete', 'rename', 'share', 'download', 'edit_files'];

// Parse a storage-quota value from client input: empty/null/undefined means "unlimited" (null),
// anything else must be a non-negative integer. Returns { ok: false } on invalid input so
// callers can reject the request instead of writing NaN or a negative quota to the DB.
function parseQuotaBytes(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  const n = parseInt(raw);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

// Shared by /api/files/upload and the public writable-share upload route — the latter used to
// skip this check entirely, letting anyone with a writable share link fill up the share owner's
// storage (and the whole disk, up to MAX_UPLOAD_SIZE_BYTES per file) regardless of their
// configured quota.
//
// Runs the quota check and the caller's write (`writeFn`) inside a single DB transaction,
// serialized behind advisory locks keyed on the owner id (and, if a role quota applies, the
// role name). Without this, two concurrent requests could both run the SELECT SUM(size) check
// against the same "before" total, both see themselves as within quota, and both commit their
// insert/update — letting quota be exceeded by any multiple simply by firing uploads in
// parallel (e.g. several browser tabs, or a trivial curl loop), which on a disk-full event can
// take down Postgres (failed WAL writes) for every user, not just the one over quota. The
// advisory lock closes that window: the second transaction blocks until the first commits (or
// rolls back), so it always sees the first upload's write when it re-reads "used bytes".
//
// `writeFn(client)` must perform the caller's actual DB write (insert/update of the files row)
// using the given `client`, not `pool`, so it lands in the same transaction as the check.
async function withStorageQuotaLock(ownerId, additionalBytes, writeFn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // pg_advisory_xact_lock auto-releases at COMMIT/ROLLBACK — no separate unlock needed.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`quota_user_${ownerId}`]);

    const userRes = await client.query('SELECT storage_quota, role FROM users WHERE id = $1', [ownerId]);
    if (userRes.rows.length === 0) {
      const data = await writeFn(client);
      await client.query('COMMIT');
      return { ok: true, data };
    }

    const quotaBytes = parseQuotaBytes(userRes.rows[0].storage_quota).value;
    if (quotaBytes !== null) {
      const usedRes = await client.query('SELECT SUM(size) as total FROM files WHERE owner_id = $1 AND is_folder = false', [ownerId]);
      const usedBytes = parseInt(usedRes.rows[0].total || 0);
      if (usedBytes + additionalBytes > quotaBytes) {
        await client.query('ROLLBACK');
        return { ok: false, error: 'Speicherplatzlimit überschritten! Bitte lösche Dateien oder wende dich an einen Admin.' };
      }
    }

    const roleName = userRes.rows[0].role;
    // Locking the role too serializes concurrent uploads from *different* users who share a
    // role-level quota — otherwise they'd each pass the per-user lock (different keys) and
    // still race each other on the shared group total below.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`quota_role_${roleName}`]);
    const roleQuotaRes = await client.query('SELECT storage_quota FROM roles WHERE name = $1', [roleName]);
    const roleQuotaBytes = parseQuotaBytes(roleQuotaRes.rows[0] && roleQuotaRes.rows[0].storage_quota).value;
    if (roleQuotaBytes !== null) {
      const groupUsedRes = await client.query(
        `SELECT COALESCE(SUM(f.size), 0) as total
         FROM files f JOIN users u ON f.owner_id = u.id
         WHERE u.role = $1 AND f.is_folder = false`,
        [roleName]
      );
      const groupUsed = parseInt(groupUsedRes.rows[0].total || 0);
      if (groupUsed + additionalBytes > roleQuotaBytes) {
        await client.query('ROLLBACK');
        return { ok: false, error: 'Das gemeinsame Speicherkontingent deiner Gruppe ist erschöpft. Bitte wende dich an einen Admin.' };
      }
    }

    const data = await writeFn(client);
    await client.query('COMMIT');
    return { ok: true, data };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Admin Role-Management: list roles with member counts & combined storage usage
app.get('/api/settings/admin/roles', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.name, r.is_default, r.is_system, r.permissions, r.storage_quota, r.weight,
              (SELECT COUNT(*) FROM users u WHERE u.role = r.name) as member_count,
              (SELECT COALESCE(SUM(f.size), 0) FROM files f JOIN users u ON f.owner_id = u.id
                 WHERE u.role = r.name AND f.is_folder = false) as storage_used
       FROM roles r ORDER BY r.weight DESC, r.is_system DESC, r.name ASC`
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
    const parsedQuota = parseQuotaBytes(storageQuota);
    if (!parsedQuota.ok) return res.status(400).json({ error: 'Ungültiges Speicherplatzlimit.' });

    const result = await pool.query(
      `INSERT INTO roles (name, is_default, is_system, permissions, storage_quota)
       VALUES ($1, false, false, $2, $3) RETURNING *`,
      [cleanName, JSON.stringify(perms), parsedQuota.value]
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
  const { permissions, storageQuota, weight } = req.body;
  try {
    const roleRes = await pool.query('SELECT * FROM roles WHERE id = $1', [roleId]);
    if (roleRes.rows.length === 0) return res.status(404).json({ error: 'Rolle nicht gefunden.' });
    const role = roleRes.rows[0];

    const perms = {};
    for (const k of ROLE_PERMISSION_KEYS) perms[k] = !!(permissions && permissions[k]);
    // The built-in admin role must always keep full access
    if (role.name === 'admin') for (const k of ROLE_PERMISSION_KEYS) perms[k] = true;

    const parsedQuota = parseQuotaBytes(storageQuota);
    if (!parsedQuota.ok) return res.status(400).json({ error: 'Ungültiges Speicherplatzlimit.' });
    const weightVal = Number.isFinite(parseInt(weight)) ? parseInt(weight) : 0;

    await pool.query('UPDATE roles SET permissions = $1, storage_quota = $2, weight = $3 WHERE id = $4',
      [JSON.stringify(perms), parsedQuota.value, weightVal, roleId]);
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
    // Deleting the current default role would leave its members pointing at a role name that
    // no longer exists (the fallback lookup below would just find this same role again, since
    // it is still is_default at this point) and leave no default role for new sign-ups.
    if (role.is_default) return res.status(400).json({ error: 'Die Standardrolle kann nicht gelöscht werden. Bitte setze zuerst eine andere Rolle als Standard.' });

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
      // (previously used `req.body.quotaBytes ? ... : null`, which silently treated an explicit
      // 0-byte quota the same as "unlimited" since 0 is falsy in JS)
      const parsedQuota = parseQuotaBytes(req.body.quotaBytes);
      if (!parsedQuota.ok) return res.status(400).json({ error: 'Ungültiges Speicherplatzlimit.' });
      await pool.query('UPDATE users SET storage_quota = $1 WHERE id = $2', [parsedQuota.value, targetUserId]);
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

      // Send the new password before persisting it: if delivery fails, the user's old
      // password must keep working rather than being silently replaced by one nobody received.
      const sent = await sendMail({
        to: user.email,
        subject: 'myCloud - Passwort zurückgesetzt',
        text: `Hallo ${user.username},\n\ndein Passwort wurde von einem Administrator zurückgesetzt.\nDein neues temporäres Passwort lautet: ${tempPassword}\n\nBitte melde dich an und ändere dein Passwort in den Einstellungen.`
      });

      if (!sent) {
        return res.status(500).json({ error: 'E-Mail konnte nicht gesendet werden. Das Passwort wurde nicht zurückgesetzt.' });
      }

      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, targetUserId]);

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

app.get('/robots.txt', async (req, res) => {
  const indexable = (await getSetting('site_indexable')) === 'true';
  res.type('text/plain');
  // Share links (/s/:slug) are always noindex via their own <meta> tag regardless of this
  // setting — this only ever controls the login/app shell itself.
  res.send(indexable ? 'User-agent: *\nAllow: /\n' : 'User-agent: *\nDisallow: /\n');
});

// Injects admin-configured SEO title/description/Open-Graph tags and the indexable/noindex
// robots directive into the app shell HTML at request time — index.html itself only carries
// a placeholder comment (see SEO_META marker) since these values live in the settings table
// and can change without a deploy.
async function renderAppShell(req, res) {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const [seoTitle, seoDescription, cloudName, indexable] = await Promise.all([
      getSetting('seo_title'),
      getSetting('seo_description'),
      getSetting('cloud_name'),
      getSetting('site_indexable'),
    ]);

    const title = escapeHtml(seoTitle || cloudName || 'myCloud');
    const description = seoDescription ? escapeHtml(seoDescription) : '';
    const robotsContent = indexable === 'true' ? 'index, follow' : 'noindex, nofollow';
    const pageUrl = escapeHtml(getExpectedOrigin(req));
    const imageUrl = `${pageUrl}/api/public/branding/seo-image`;

    const metaTags = [
      `<meta name="robots" content="${robotsContent}">`,
      description && `<meta name="description" content="${description}">`,
      `<meta property="og:title" content="${title}">`,
      description && `<meta property="og:description" content="${description}">`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:url" content="${pageUrl}">`,
      `<meta property="og:image" content="${imageUrl}">`,
      `<meta name="twitter:card" content="summary_large_image">`,
    ].filter(Boolean).join('\n  ');

    const rendered = html
      .replace(/<title>.*?<\/title>/, `<title>${title}</title>`)
      .replace('<!-- SEO_META: server-injected robots/description/Open-Graph tags, see renderAppShell() in server.js -->', metaTags);

    res.set('X-Robots-Tag', robotsContent);
    res.send(rendered);
  } catch (err) {
    console.error('Error rendering app shell:', err);
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
}

// SPA Route Fallback (serve main index.html for unknown routes)
app.get('*', (req, res) => {
  // If requesting file API routes or specific static files, don't fall back to HTML
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.includes('.')) {
    return res.status(404).send('Not Found');
  }
  renderAppShell(req, res);
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
          if (file.is_folder) {
            await deleteFolderRecursive(file.id, file.owner_id);
          } else {
            const filePath = path.join(UPLOADS_DIR, file.path);
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
            await pool.query('DELETE FROM files WHERE id = $1', [file.id]);
          }
          console.log(`Background clean: Expired self-destruct note ${file.name} deleted.`);
          continue;
        }
      }
      await pool.query('DELETE FROM shares WHERE id = $1', [share.id]);
    }
  } catch (err) {
    console.error('Expired cleanup interval error:', err);
  }
}, 5 * 60 * 1000); // Run every 5 minutes

// Background cleanup task: permanently purge trash items past the configured retention
// period (admin-configurable, see trash_retention_days setting). Only trash "roots" are
// queried — hardDeleteTrashItem takes care of each one's whole subtree.
setInterval(async () => {
  try {
    const retentionDays = parseInt(await getSetting('trash_retention_days')) || 30;
    const rootsRes = await pool.query(
      `SELECT f.id, f.is_folder, f.path, f.owner_id
       FROM files f
       WHERE f.deleted_at IS NOT NULL
         AND f.deleted_at < NOW() - ($1 || ' days')::interval
         AND (f.parent_id IS NULL OR f.parent_id NOT IN (
           SELECT id FROM files WHERE deleted_at IS NOT NULL
         ))`,
      [retentionDays]
    );
    for (const file of rootsRes.rows) {
      await hardDeleteTrashItem(file, file.owner_id);
    }
    if (rootsRes.rows.length > 0) {
      console.log(`Papierkorb: ${rootsRes.rows.length} Element(e) nach Ablauf der Aufbewahrungsfrist (${retentionDays} Tage) endgültig gelöscht.`);
    }
  } catch (err) {
    console.error('Trash purge interval error:', err);
  }
}, 60 * 60 * 1000); // Run hourly

// Heartbeat endpoint for one-time links
app.post('/api/public/shares/:slug/heartbeat', async (req, res) => {
  const { slug } = req.params;
  try {
    const shareRes = await pool.query('SELECT * FROM shares WHERE slug = $1', [slug]);
    if (shareRes.rows.length === 0) {
      return res.status(404).json({ error: 'Share not found.' });
    }
    const share = shareRes.rows[0];

    const baseFileRes = await pool.query('SELECT is_one_time_note FROM files WHERE id = $1', [share.file_id]);
    if (baseFileRes.rows.length === 0) {
      return res.status(404).json({ error: 'Shared content no longer exists.' });
    }
    const baseFile = baseFileRes.rows[0];
    if (!baseFile.is_one_time_note) {
      return res.json({ success: true });
    }

    const isSameSession = req.session.accessedOneTimeShares && req.session.accessedOneTimeShares[slug];
    if (!isSameSession) {
      return res.status(410).json({ error: 'Access denied.' });
    }

    await pool.query(
      'UPDATE shares SET last_heartbeat = NOW() WHERE id = $1',
      [share.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Heartbeat error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Burn endpoint for one-time links (called on window unload)
app.post('/api/public/shares/:slug/burn', async (req, res) => {
  const { slug } = req.params;
  try {
    const shareRes = await pool.query('SELECT * FROM shares WHERE slug = $1', [slug]);
    if (shareRes.rows.length > 0) {
      const share = shareRes.rows[0];
      const isSameSession = req.session.accessedOneTimeShares && req.session.accessedOneTimeShares[slug];
      if (isSameSession) {
        const fileRes = await pool.query('SELECT * FROM files WHERE id = $1', [share.file_id]);
        if (fileRes.rows.length > 0) {
          const file = fileRes.rows[0];
          if (file.is_folder) {
            await deleteFolderRecursive(file.id, file.owner_id);
          } else {
            const filePath = path.join(UPLOADS_DIR, file.path);
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
            await pool.query('DELETE FROM files WHERE id = $1', [file.id]);
          }
          console.log(`Self-destructed one-time note share ${slug} immediately via burn call.`);
        }
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Burn error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Background cleanup task for active one-time shares with expired heartbeats (client closed tab/browser)
setInterval(async () => {
  try {
    // Select all one-time shares that have been accessed and whose last_heartbeat is older than 15 seconds
    const expiredOneTimeRes = await pool.query(
      `SELECT s.id, s.file_id, s.slug FROM shares s
       JOIN files f ON f.id = s.file_id
       WHERE f.is_one_time_note = true
         AND s.accessed_at IS NOT NULL
         AND s.last_heartbeat < NOW() - INTERVAL '15 seconds'`
    );

    for (const share of expiredOneTimeRes.rows) {
      const fileRes = await pool.query('SELECT * FROM files WHERE id = $1', [share.file_id]);
      if (fileRes.rows.length > 0) {
        const file = fileRes.rows[0];
        if (file.is_folder) {
          await deleteFolderRecursive(file.id, file.owner_id);
        } else {
          const filePath = path.join(UPLOADS_DIR, file.path);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
          await pool.query('DELETE FROM files WHERE id = $1', [file.id]);
        }
        console.log(`Self-destructed expired one-time note share ${share.slug} (ID: ${file.id}) due to lost heartbeat.`);
      } else {
        await pool.query('DELETE FROM shares WHERE id = $1', [share.id]);
      }
    }
  } catch (err) {
    console.error('One-time heartbeat cleanup interval error:', err);
  }
}, 10000); // Run every 10 seconds

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
      // For a logged-in caller, the session's own username is authoritative — never trust the
      // query param, which anyone can set to arbitrary text (this is what gets broadcast to
      // every other collaborator and rendered into a <style> block client-side; a raw client
      // value here was a stored-XSS vector against every co-editor). Only an anonymous guest
      // (no session) gets to pick a display name at all, and even then it's whitelisted to a
      // safe charset — same policy as the persistent username field in /api/auth/set-username.
      let username = request.session.userId
        ? (request.session.username || '')
        : (url.searchParams.get('username') || '').trim().replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 30);
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
  .then(async () => {
    await refreshMaxUploadSizeBytes();
    logVersionStatus();
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
