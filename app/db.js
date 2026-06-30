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

    // Update shares table columns if not exists
    await client.query('ALTER TABLE shares ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)');
    await client.query('ALTER TABLE shares ADD COLUMN IF NOT EXISTS max_downloads INTEGER');
    await client.query('ALTER TABLE shares ADD COLUMN IF NOT EXISTS download_count INTEGER DEFAULT 0');
    await client.query('ALTER TABLE shares ADD COLUMN IF NOT EXISTS only_upload BOOLEAN DEFAULT FALSE');
    await client.query('ALTER TABLE files ADD COLUMN IF NOT EXISTS is_one_time_note BOOLEAN DEFAULT FALSE');
    await client.query('ALTER TABLE files ADD COLUMN IF NOT EXISTS content TEXT');

    // Settings Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(50) PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

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
