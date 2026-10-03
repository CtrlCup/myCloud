'use strict';
// Schreibt nicht-geheime Admin-Einstellungen zurück in die .env (Datei liegt im App-Verzeichnis, vom Host gemountet).
// Secrets (SMTP-Passwort, SSO-Client-Secret) werden bewusst NICHT geschrieben (Konzept F3): Sie stehen nur in der
// Datenbank (bei aktivem Master-Key verschlüsselt, siehe column-crypto.js). Ein vorhandener Wert in der .env bleibt
// als Rückwärtskompatibilitäts-Fallback unangetastet (Entfernen: Phase P7).
const fs = require('fs');
const path = require('path');

// DB-Schlüssel -> .env-Variable; ausschließlich NICHT geheime Werte.
const ENV_MAPPING = {
  registration_enabled: 'REGISTRATION_ENABLED',
  sso_enabled: 'SSO_ENABLED',
  sso_issuer_url: 'SSO_ISSUER_URL',
  sso_client_id: 'SSO_CLIENT_ID',
  email_smtp_host: 'EMAIL_SMTP_HOST',
  email_smtp_port: 'EMAIL_SMTP_PORT',
  email_smtp_user: 'EMAIL_SMTP_USER',
  email_from: 'EMAIL_FROM',
};

function updateEnvFile(configs, envPath = path.join(__dirname, '.env')) {
  if (!fs.existsSync(envPath)) {
    console.log('.env file does not exist, skipping environment write.');
    return;
  }

  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');

    for (const [key, value] of Object.entries(configs)) {
      const envKey = ENV_MAPPING[key];
      if (!envKey) continue;

      // A settings value containing a newline would otherwise let it break out of its own
      // "KEY=value" line and inject arbitrary extra environment variables into the .env file.
      const safeValue = String(value).replace(/[\r\n]+/g, ' ');

      let found = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith(`${envKey}=`)) {
          lines[i] = `${envKey}=${safeValue}`;
          found = true;
          break;
        }
      }
      if (!found) lines.push(`${envKey}=${safeValue}`);
    }

    fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
  } catch (err) {
    console.error('Error updating .env file:', err);
  }
}

module.exports = { updateEnvFile, ENV_MAPPING };
