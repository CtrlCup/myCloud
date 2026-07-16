const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function initDb() {
  console.log('Initializing database schema...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Enable trigram extension for fuzzy search
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');

    // Users Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255),
        role VARCHAR(20) DEFAULT 'user',
        sso_id VARCHAR(100),
        sso_provider VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add avatar_path column if not exists
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_path VARCHAR(255)');
    // Add email column if not exists
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255)');

    // Login and password-reset both look users up by email as if it were unique, but nothing
    // enforced that at the DB level — two accounts could end up sharing an email, and login-by-
    // email would then always resolve to whichever row Postgres happens to return first.
    // Skip (rather than fail startup) if a deployment already has duplicate/empty-string data;
    // the CREATE INDEX is retried on every boot, so it takes effect as soon as that's resolved.
    const dupEmailsRes = await client.query(
      `SELECT email FROM users WHERE email IS NOT NULL AND email != '' GROUP BY email HAVING COUNT(*) > 1`
    );
    if (dupEmailsRes.rows.length === 0) {
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (email) WHERE email IS NOT NULL AND email != ''`
      );
    } else {
      console.warn(`Skipping unique email index: ${dupEmailsRes.rows.length} duplicate email(s) already exist in the users table.`);
    }
    // Add verification and 2FA columns
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT TRUE');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token VARCHAR(255)');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_email BOOLEAN DEFAULT FALSE');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_totp BOOLEAN DEFAULT FALSE');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(255)');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS has_custom_username BOOLEAN DEFAULT FALSE');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100)');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100)');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS display_real_name BOOLEAN DEFAULT FALSE');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_quota BIGINT DEFAULT NULL');
    // Login activity tracking for the admin user list: last_failed_login_at is cleared to NULL
    // on every successful login, so "last_failed_login_at is set" alone means "has not
    // successfully logged in since that failure" without needing to compare two timestamps.
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP DEFAULT NULL');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_failed_login_at TIMESTAMP DEFAULT NULL');

    // Roles Table — named roles with a permission map and an optional group-wide storage quota
    await client.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) UNIQUE NOT NULL,
        is_default BOOLEAN DEFAULT FALSE,
        is_system BOOLEAN DEFAULT FALSE,
        permissions JSONB DEFAULT '{}',
        storage_quota BIGINT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Display/priority weight — heavier roles sort first in the admin panel. Also intended as
    // the future tie-breaker once a user can hold more than one role at a time (not yet
    // implemented; today every user has exactly one role, so weight is purely cosmetic).
    await client.query('ALTER TABLE roles ADD COLUMN IF NOT EXISTS weight INTEGER DEFAULT 0');

    // Seed the two built-in roles (admin = everything, user = default for new sign-ups)
    const ALL_PERMS = {
      admin: true, upload: true, create_folder: true, delete: true,
      rename: true, share: true, download: true, edit_files: true,
    };
    const USER_PERMS = {
      admin: false, upload: true, create_folder: true, delete: true,
      rename: true, share: true, download: true, edit_files: true,
    };
    await client.query(
      `INSERT INTO roles (name, is_default, is_system, permissions)
       VALUES ('admin', false, true, $1)
       ON CONFLICT (name) DO UPDATE SET is_system = true, permissions = $1`,
      [JSON.stringify(ALL_PERMS)]
    );
    await client.query(
      `INSERT INTO roles (name, is_default, is_system, permissions)
       VALUES ('user', true, true, $1)
       ON CONFLICT (name) DO UPDATE SET is_system = true`,
      [JSON.stringify(USER_PERMS)]
    );
    // Guarantee exactly one default role exists
    const defCount = await client.query('SELECT COUNT(*) FROM roles WHERE is_default = true');
    if (parseInt(defCount.rows[0].count) === 0) {
      await client.query(`UPDATE roles SET is_default = true WHERE name = 'user'`);
    }

    // Passkeys Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS passkeys (
        id VARCHAR(255) PRIMARY KEY,
        public_key TEXT NOT NULL,
        counter BIGINT NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        transports VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query('ALTER TABLE passkeys ADD COLUMN IF NOT EXISTS name VARCHAR(255)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_passkeys_user_id ON passkeys(user_id)');


    // Files Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS files (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        path TEXT NOT NULL,
        mime_type VARCHAR(100),
        size BIGINT,
        is_folder BOOLEAN DEFAULT FALSE,
        parent_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
        owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_files_owner_id ON files(owner_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_files_parent_id ON files(parent_id)');

    // API Keys Table (personal access tokens for third-party/app clients)
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        key_prefix VARCHAR(16) NOT NULL,
        key_hash VARCHAR(64) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_used_at TIMESTAMP
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id)');

    // Shares Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS shares (
        id SERIAL PRIMARY KEY,
        slug VARCHAR(100) UNIQUE NOT NULL,
        file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
        can_read BOOLEAN DEFAULT TRUE,
        can_write BOOLEAN DEFAULT FALSE,
        can_download BOOLEAN DEFAULT TRUE,
        can_zip BOOLEAN DEFAULT TRUE,
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_shares_file_id ON shares(file_id)');

    // Update shares table columns if not exists
    await client.query('ALTER TABLE shares ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)');
    await client.query('ALTER TABLE shares ADD COLUMN IF NOT EXISTS max_downloads INTEGER');
    await client.query('ALTER TABLE shares ADD COLUMN IF NOT EXISTS download_count INTEGER DEFAULT 0');
    await client.query('ALTER TABLE shares ADD COLUMN IF NOT EXISTS only_upload BOOLEAN DEFAULT FALSE');
    await client.query('ALTER TABLE shares ADD COLUMN IF NOT EXISTS can_collab BOOLEAN DEFAULT FALSE');
    await client.query('ALTER TABLE shares ADD COLUMN IF NOT EXISTS message TEXT');
    await client.query('ALTER TABLE shares ADD COLUMN IF NOT EXISTS accessed_at TIMESTAMP');
    await client.query('ALTER TABLE shares ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMP');
    await client.query('ALTER TABLE files ADD COLUMN IF NOT EXISTS is_one_time_note BOOLEAN DEFAULT FALSE');
    await client.query('ALTER TABLE files ADD COLUMN IF NOT EXISTS content TEXT');
    // Trash: a non-null deleted_at soft-deletes a file/folder (and, via moveToTrashRecursive
    // in server.js, its whole subtree with the same timestamp) instead of removing it
    // immediately. A background interval hard-deletes anything past the configured
    // trash_retention_days setting.
    await client.query('ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP');
    await client.query('CREATE INDEX IF NOT EXISTS idx_files_deleted_at ON files(deleted_at) WHERE deleted_at IS NOT NULL');

    // Lean autosave version history for the code editor — a rolling checkpoint per file,
    // throttled server-side (see maybeSaveFileVersion in server.js) so continuous typing
    // doesn't create a version on every 1.5s autosave tick.
    await client.query(`
      CREATE TABLE IF NOT EXISTS file_versions (
        id SERIAL PRIMARY KEY,
        file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
        content TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_file_versions_file_id ON file_versions(file_id)');

    // Settings Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    // Alter settings key type if already exists, to support password reset tokens (70 chars)
    await client.query('ALTER TABLE settings ALTER COLUMN key TYPE VARCHAR(100)');


    // Seed/sync settings from environment variables if set, otherwise seed defaults
    const getEnvOrSeed = (key, envVal, seedVal) => {
      return envVal !== undefined && envVal !== '' ? envVal : seedVal;
    };

    const registrationSeed = process.env.REGISTRATION_ENABLED !== undefined ? process.env.REGISTRATION_ENABLED : 'true';

    const settingsSeeds = [
      { key: 'registration_enabled', value: registrationSeed },
      { key: 'sso_enabled', value: getEnvOrSeed('sso_enabled', process.env.SSO_ENABLED, 'false') },
      { key: 'sso_client_id', value: getEnvOrSeed('sso_client_id', process.env.SSO_CLIENT_ID, '') },
      { key: 'sso_client_secret', value: getEnvOrSeed('sso_client_secret', process.env.SSO_CLIENT_SECRET, '') },
      { key: 'sso_issuer_url', value: getEnvOrSeed('sso_issuer_url', process.env.SSO_ISSUER_URL, '') },
      { key: 'email_smtp_host', value: getEnvOrSeed('email_smtp_host', process.env.EMAIL_SMTP_HOST, '') },
      { key: 'email_smtp_port', value: getEnvOrSeed('email_smtp_port', process.env.EMAIL_SMTP_PORT, '587') },
      { key: 'email_smtp_user', value: getEnvOrSeed('email_smtp_user', process.env.EMAIL_SMTP_USER, '') },
      { key: 'email_smtp_pass', value: getEnvOrSeed('email_smtp_pass', process.env.EMAIL_SMTP_PASS, '') },
      { key: 'email_from', value: getEnvOrSeed('email_from', process.env.EMAIL_FROM, 'noreply@mycloud.local') },
      { key: 'cloud_name', value: 'myCloud' },
      { key: 'cloud_tab_name', value: 'myCloud' },
      { key: 'cloud_icon_path', value: '' },
      { key: 'custom_color_bg', value: '#0b0f19' },
      { key: 'custom_color_accent', value: '#00d2ff' },
      { key: 'dashboard_bg_image', value: '' },
      { key: 'login_bg_image', value: '' }
    ];

    // If SMTP host is configured via env, set email_smtp_tested to true automatically
    if (process.env.EMAIL_SMTP_HOST) {
      settingsSeeds.push({ key: 'email_smtp_tested', value: 'true' });
    }

    for (const seed of settingsSeeds) {
      const envKeys = [
        'registration_enabled', 'sso_enabled', 'sso_client_id', 'sso_client_secret', 'sso_issuer_url',
        'email_smtp_host', 'email_smtp_port', 'email_smtp_user', 'email_smtp_pass', 'email_from'
      ];
      
      const isEnvKey = envKeys.includes(seed.key);
      const isEnvValueProvided = isEnvKey && (
        (seed.key === 'registration_enabled' && process.env.REGISTRATION_ENABLED !== undefined) ||
        (seed.key === 'sso_enabled' && process.env.SSO_ENABLED !== undefined) ||
        (seed.key === 'sso_client_id' && process.env.SSO_CLIENT_ID) ||
        (seed.key === 'sso_client_secret' && process.env.SSO_CLIENT_SECRET) ||
        (seed.key === 'sso_issuer_url' && process.env.SSO_ISSUER_URL) ||
        (seed.key === 'email_smtp_host' && process.env.EMAIL_SMTP_HOST) ||
        (seed.key === 'email_smtp_port' && process.env.EMAIL_SMTP_PORT) ||
        (seed.key === 'email_smtp_user' && process.env.EMAIL_SMTP_USER) ||
        (seed.key === 'email_smtp_pass' && process.env.EMAIL_SMTP_PASS) ||
        (seed.key === 'email_from' && process.env.EMAIL_FROM)
      );

      if (isEnvValueProvided) {
        await client.query(`
          INSERT INTO settings (key, value)
          VALUES ($1, $2)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `, [seed.key, seed.value]);
      } else {
        await client.query(`
          INSERT INTO settings (key, value)
          VALUES ($1, $2)
          ON CONFLICT (key) DO NOTHING
        `, [seed.key, seed.value]);
      }
    }

    await client.query('COMMIT');
    console.log('Database schema initialized successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to initialize database schema:', err);
    throw err;
  } finally {
    client.release();
  }
}

// Helper to get configuration setting from DB
async function getSetting(key) {
  try {
    const res = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (res.rows.length > 0) {
      return res.rows[0].value;
    }
    return null;
  } catch (err) {
    console.error(`Error getting setting ${key}:`, err);
    return null;
  }
}

// Helper to set configuration setting in DB
async function setSetting(key, value) {
  try {
    await pool.query(`
      INSERT INTO settings (key, value)
      VALUES ($1, $2)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [key, String(value)]);
    return true;
  } catch (err) {
    console.error(`Error setting ${key}:`, err);
    return false;
  }
}

// Get all settings as an object
async function getAllSettings() {
  try {
    const res = await pool.query('SELECT key, value FROM settings');
    const settings = {};
    res.rows.forEach(row => {
      settings[row.key] = row.value;
    });
    return settings;
  } catch (err) {
    console.error('Error getting all settings:', err);
    return {};
  }
}

module.exports = {
  pool,
  initDb,
  getSetting,
  setSetting,
  getAllSettings,
};
