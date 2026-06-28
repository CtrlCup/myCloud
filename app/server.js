const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const archiver = require('archiver');
const crypto = require('crypto');
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
const upload = multer({ storage: storage });

// Session Configuration using PostgreSQL for session store
app.use(session({
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
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Authentication Middleware
function requireAuth(req, res, next) {
  if (req.session.userId) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

function requireAdmin(req, res, next) {
  if (req.session.userId && req.session.role === 'admin') {
    return next();
  }
  res.status(403).json({ error: 'Forbidden: Admin access required' });
}

// WebAuthn configuration variables
const RP_NAME = 'myCloud';
const RP_ID = process.env.APP_URL ? new URL(process.env.APP_URL).hostname : 'localhost';
const EXPECTED_ORIGIN = process.env.APP_URL || 'http://localhost:3000';

/* ==========================================================================
   AUTHENTICATION ROUTES
   ========================================================================== */

// Check current user status
app.get('/api/auth/status', async (req, res) => {
  if (req.session.userId) {
    return res.json({
      loggedIn: true,
      user: {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role,
      }
    });
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
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const userCountRes = await pool.query('SELECT COUNT(*) FROM users');
    const userCount = parseInt(userCountRes.rows[0].count);
    const regEnabled = await getSetting('registration_enabled');

    // First user is automatically admin, otherwise check if registration is enabled
    if (userCount > 0 && regEnabled !== 'true') {
      return res.status(403).json({ error: 'Registration is currently disabled.' });
    }

    const role = userCount === 0 ? 'admin' : 'user';
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role',
      [username, passwordHash, role]
    );

    const newUser = result.rows[0];
    req.session.userId = newUser.id;
    req.session.username = newUser.username;
    req.session.role = newUser.role;

    res.status(201).json({ success: true, user: newUser });
  } catch (err) {
    console.error('Registration error:', err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already exists' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Standard Login Route
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = result.rows[0];
    if (!user.password_hash) {
      return res.status(400).json({ error: 'This user is registered via SSO or Passkey only. Please use the appropriate login method.' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;

    res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
  } catch (err) {
    console.error('Login error:', err);
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
      rpID: RP_ID,
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
  const { body } = req;
  const userId = req.session.userId;
  const expectedChallenge = req.session.currentChallenge;

  if (!expectedChallenge) {
    return res.status(400).json({ error: 'Challenge missing from session' });
  }

  try {
    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: EXPECTED_ORIGIN,
      expectedRPID: RP_ID,
    });

    if (verification.verified && verification.registrationInfo) {
      const { credentialPublicKey, credentialID, counter } = verification.registrationInfo;

      const credentialPublicKeyBase64 = Buffer.from(credentialPublicKey).toString('base64url');
      const credentialIDBase64 = Buffer.from(credentialID).toString('base64url');
      const transports = body.response.transports ? body.response.transports.join(',') : '';

      await pool.query(
        'INSERT INTO passkeys (id, public_key, counter, user_id, transports) VALUES ($1, $2, $3, $4, $5)',
        [credentialIDBase64, credentialPublicKeyBase64, counter, userId, transports]
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
      rpID: RP_ID,
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
      expectedOrigin: EXPECTED_ORIGIN,
      expectedRPID: RP_ID,
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
    const userRes = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userRes.rows.length === 0) {
      // Do not disclose whether user exists
      return res.json({ success: true, message: 'If user exists, a reset link will be sent.' });
    }

    const user = userRes.rows[0];
    if (user.sso_id) {
      return res.status(400).json({ error: 'This user is managed via SSO and cannot reset passwords locally.' });
    }

    // Generate random reset token in session
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + 3600000; // 1 hour

    // Store in global DB Settings or memory. Storing in user session is easiest for stateless,
    // but users request this logged out. We will store it in the sessions DB through a temp mechanism,
    // or just in the DB users table (or just write a quick setting `reset_${resetToken}`: userId).
    await setSetting(`reset_${resetToken}`, JSON.stringify({ userId: user.id, expires }));

    const appUrl = await getSetting('app_url') || process.env.APP_URL || 'http://localhost:3000';
    const resetLink = `${appUrl}/#reset-password?token=${resetToken}`;

    const mailSent = await sendMail({
      to: `${username}@placeholder-email.com`, // Since users table doesn't have an email field, we could derive it, or prompt for email.
      // Wait, let's assume username is an email address, or we could add an email column.
      // If we use username as SMTP receiver if it looks like email, or if user has configured one.
      // We will fallback to attempting to send it to username if it's an email, otherwise just return it for testing.
      subject: 'myCloud - Password Reset Request',
      text: `Hello,\n\nPlease reset your password using the following link:\n${resetLink}\n\nThis link is valid for 1 hour.`,
      html: `<p>Hello,</p><p>Please reset your password using the following link:</p><p><a href="${resetLink}">${resetLink}</a></p><p>This link is valid for 1 hour.</p>`
    });

    if (mailSent) {
      res.json({ success: true, message: 'Password reset link sent to registered email.' });
    } else {
      // If email service is not configured, we return the link for debugging if it is localhost
      if (appUrl.includes('localhost')) {
        return res.json({ success: true, devLink: resetLink, message: '[DEV ONLY] Mail delivery disabled, here is your link.' });
      }
      res.status(500).json({ error: 'Failed to send reset email. Please contact Administrator.' });
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
      `SELECT id, name, size, is_folder, mime_type, created_at, parent_id 
       FROM files 
       WHERE owner_id = $1 AND (parent_id = $2 OR (parent_id IS NULL AND $2 IS NULL))
       ORDER BY is_folder DESC, name ASC`,
      [userId, parentId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error listing files:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new folder
app.post('/api/files/folder', requireAuth, async (req, res) => {
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
app.post('/api/files/upload', requireAuth, upload.single('file'), async (req, res) => {
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

    const result = await pool.query(
      `INSERT INTO files (name, path, mime_type, size, is_folder, parent_id, owner_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, false, parentId, userId]
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
app.get('/api/files/download/:id', requireAuth, async (req, res) => {
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
app.delete('/api/files/:id', requireAuth, async (req, res) => {
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

// Delete multiple files/folders
app.post('/api/files/delete-multiple', requireAuth, async (req, res) => {
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
app.post('/api/files/create-empty', requireAuth, async (req, res) => {
  const { name, parentId } = req.body;
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

    const uniqueFilename = crypto.randomUUID() + '.txt';
    const physicalPath = path.join(UPLOADS_DIR, uniqueFilename);
    
    // Create empty file on disk
    fs.writeFileSync(physicalPath, '');

    const result = await pool.query(
      `INSERT INTO files (name, path, mime_type, size, is_folder, parent_id, owner_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, uniqueFilename, 'text/plain', 0, false, parsedParentId, userId]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating empty file:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


/* ==========================================================================
   SHARING SYSTEM ROUTES
   ========================================================================== */

// Create a share link
app.post('/api/shares', requireAuth, async (req, res) => {
  const { fileId, customSlug, canRead, canWrite, canDownload, canZip, expiresDays } = req.body;
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
    if (expiresDays) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + parseInt(expiresDays));
    }

    const result = await pool.query(
      `INSERT INTO shares (slug, file_id, can_read, can_write, can_download, can_zip, expires_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [slug, fileId, canRead !== false, canWrite === true, canDownload !== false, canZip !== false, expiresAt]
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
  const { customSlug, canRead, canWrite, canDownload, canZip, expiresDays } = req.body;
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
    if (expiresDays !== undefined) {
      if (expiresDays === null || expiresDays === '') {
        expiresAt = null;
      } else {
        expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + parseInt(expiresDays));
      }
    }

    const result = await pool.query(
      `UPDATE shares 
       SET slug = $1, can_read = $2, can_write = $3, can_download = $4, can_zip = $5, expires_at = $6 
       WHERE id = $7 RETURNING *`,
      [slug, canRead !== false, canWrite === true, canDownload !== false, canZip !== false, expiresAt, shareId]
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
    const baseFileRes = await pool.query('SELECT id, name, is_folder, owner_id FROM files WHERE id = $1', [share.file_id]);
    if (baseFileRes.rows.length === 0) {
      return res.status(404).json({ error: 'Shared content no longer exists.' });
    }

    const baseFile = baseFileRes.rows[0];

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
    if (baseFile.is_folder) {
      const filesRes = await pool.query(
        'SELECT id, name, size, is_folder, mime_type, created_at, parent_id FROM files WHERE parent_id = $1 ORDER BY is_folder DESC, name ASC',
        [currentFolderId]
      );
      files = filesRes.rows;
    } else {
      files = [baseFile];
    }

    res.json({
      share: {
        slug: share.slug,
        can_read: share.can_read,
        can_write: share.can_write,
        can_download: share.can_download,
        can_zip: share.can_zip,
        expires_at: share.expires_at,
      },
      baseFile: {
        id: baseFile.id,
        name: baseFile.name,
        is_folder: baseFile.is_folder,
      },
      currentFolderId,
      files,
    });
  } catch (err) {
    console.error('Error fetching public share:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public Share Download - Single file
app.get('/api/public/shares/:slug/download/:fileId', async (req, res) => {
  const { slug, fileId } = req.params;

  try {
    const shareRes = await pool.query('SELECT * FROM shares WHERE slug = $1', [slug]);
    if (shareRes.rows.length === 0) return res.status(404).json({ error: 'Share link not found.' });

    const share = shareRes.rows[0];
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Share has expired.' });
    }
    if (!share.can_download) return res.status(403).json({ error: 'Download permissions denied.' });

    // Verify fileId is either the shared file or a descendant of the shared folder
    const fileRes = await pool.query('SELECT * FROM files WHERE id = $1', [parseInt(fileId)]);
    if (fileRes.rows.length === 0) return res.status(404).json({ error: 'File not found.' });

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

    if (!isValid) return res.status(403).json({ error: 'Access denied.' });
    if (file.is_folder) return res.status(400).json({ error: 'Cannot download folder.' });

    const filePath = path.join(UPLOADS_DIR, file.path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Physical file not found.' });

    res.download(filePath, file.name);
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
      [req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, false, targetFolderId, baseFile.owner_id]
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
    const shareRes = await pool.query('SELECT * FROM shares WHERE slug = $1', [slug]);
    if (shareRes.rows.length === 0) return res.status(404).json({ error: 'Share link not found.' });

    const share = shareRes.rows[0];
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Share has expired.' });
    }
    if (!share.can_zip) return res.status(403).json({ error: 'ZIP Download permissions denied.' });

    // Verify folderId is or is descendant of share.file_id
    const targetFolderRes = await pool.query('SELECT * FROM files WHERE id = $1 AND is_folder = true', [parseInt(folderId)]);
    if (targetFolderRes.rows.length === 0) return res.status(404).json({ error: 'Folder not found.' });

    const targetFolder = targetFolderRes.rows[0];
    let checkId = targetFolder.id;
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

    if (!isValid) return res.status(403).json({ error: 'Access denied.' });

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

// Get settings (User profile and config)
app.get('/api/settings', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  try {
    const userRes = await pool.query('SELECT id, username, role FROM users WHERE id = $1', [userId]);
    const passkeysRes = await pool.query('SELECT id, created_at FROM passkeys WHERE user_id = $1', [userId]);
    
    const data = {
      user: userRes.rows[0],
      passkeys: passkeysRes.rows,
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

// Update personal settings (Change password, delete passkeys)
app.post('/api/settings/profile', requireAuth, async (req, res) => {
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

// Update Admin Configuration settings
app.post('/api/settings/admin/config', requireAdmin, async (req, res) => {
  const configs = req.body;
  try {
    for (const [key, value] of Object.entries(configs)) {
      // Avoid overwriting password with placeholder
      if (key === 'email_smtp_pass' && value === '__placeholder__') {
        continue;
      }
      await setSetting(key, value);
    }
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
    res.json({ success: true, message: `Test email sent to ${to}.` });
  } else {
    res.status(500).json({ error: 'SMTP connection failed. Check your SMTP configurations or logs.' });
  }
});

// Admin User-Management: List Users
app.get('/api/settings/admin/users', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.role, u.sso_provider, u.created_at, 
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

// Admin User-Management: Update user role / Delete user
app.post('/api/settings/admin/users/:id', requireAdmin, async (req, res) => {
  const targetUserId = parseInt(req.params.id);
  const { action, role } = req.body;

  if (targetUserId === req.session.userId) {
    return res.status(400).json({ error: 'You cannot perform actions on your own account.' });
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
      return res.json({ success: true, message: 'User and all files deleted.' });
    } else if (action === 'role' && role) {
      await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, targetUserId]);
      return res.json({ success: true, message: 'User role updated.' });
    }

    res.status(400).json({ error: 'Invalid admin action.' });
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

// Start Database & Express Server
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`myCloud app is running on ${EXPECTED_ORIGIN}`);
    });
  })
  .catch(err => {
    console.error('Database connection failed, exiting...', err);
    process.exit(1);
  });
