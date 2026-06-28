const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function initDb() {
  console.log('Initializing database schema...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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

    // Settings Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(50) PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Seed default settings if not exists
    const settingsSeeds = [
      { key: 'registration_enabled', value: 'true' },
      { key: 'sso_enabled', value: 'false' },
      { key: 'sso_client_id', value: '' },
      { key: 'sso_client_secret', value: '' },
      { key: 'sso_issuer_url', value: '' },
      { key: 'email_smtp_host', value: '' },
      { key: 'email_smtp_port', value: '587' },
      { key: 'email_smtp_user', value: '' },
      { key: 'email_smtp_pass', value: '' },
      { key: 'email_from', value: 'noreply@mycloud.local' },
      { key: 'cloud_name', value: 'myCloud' },
      { key: 'cloud_tab_name', value: 'myCloud' },
      { key: 'cloud_icon_path', value: '' }
    ];

    for (const seed of settingsSeeds) {
      await client.query(`
        INSERT INTO settings (key, value)
        VALUES ($1, $2)
        ON CONFLICT (key) DO NOTHING
      `, [seed.key, seed.value]);
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
