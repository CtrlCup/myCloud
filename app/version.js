const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV_PATH = path.join(__dirname, '.env');
const COMPOSE_PATH = path.join(__dirname, 'docker-compose.yml');
const GIT_DIR = path.join(__dirname, '.git-host');

// Resolves the currently checked-out git commit without shelling out to `git` — the
// container only has the host's .git directory bind-mounted read-only (docker-compose.yml),
// not the git binary itself. Falls back to 'unknown' for non-git deployments.
function getGitVersion() {
  try {
    const head = fs.readFileSync(path.join(GIT_DIR, 'HEAD'), 'utf8').trim();
    let sha;
    if (head.startsWith('ref:')) {
      const ref = head.slice(4).trim();
      const refPath = path.join(GIT_DIR, ref);
      if (fs.existsSync(refPath)) {
        sha = fs.readFileSync(refPath, 'utf8').trim();
      } else {
        // Ref has no loose file on disk — look it up in packed-refs instead (git gc'd repos).
        const packed = fs.readFileSync(path.join(GIT_DIR, 'packed-refs'), 'utf8');
        const line = packed.split('\n').find(l => l.endsWith(' ' + ref));
        sha = line ? line.split(' ')[0] : null;
      }
    } else {
      sha = head; // detached HEAD: the HEAD file already holds the commit SHA directly
    }
    return sha ? sha.slice(0, 12) : 'unknown';
  } catch {
    return 'unknown';
  }
}

function computeFileHash(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

// Runs once at boot: compares the running software version and the mounted .env /
// docker-compose.yml against what was recorded at the previous boot, logs a clear
// notice if anything drifted since then, and persists a summary the admin panel reads.
async function checkVersionAndConfig({ getSetting, setSetting }) {
  const currentVersion = getGitVersion();
  const currentEnvHash = computeFileHash(ENV_PATH);
  const currentComposeHash = computeFileHash(COMPOSE_PATH);

  const [prevVersion, prevEnvHash, prevComposeHash] = await Promise.all([
    getSetting('_version_app'),
    getSetting('_version_env_hash'),
    getSetting('_version_compose_hash'),
  ]);

  const isFirstBoot = prevVersion === null;
  const versionChanged = !isFirstBoot && prevVersion !== currentVersion;
  const envChanged = !isFirstBoot && prevEnvHash !== null && currentEnvHash !== null && prevEnvHash !== currentEnvHash;
  const composeChanged = !isFirstBoot && prevComposeHash !== null && currentComposeHash !== null && prevComposeHash !== currentComposeHash;

  if (versionChanged || envChanged || composeChanged) {
    console.log('⚠️  Konfigurationsänderung seit dem letzten Start erkannt:');
    if (versionChanged) console.log(`   - Software-Version: ${prevVersion} -> ${currentVersion}`);
    if (envChanged) console.log('   - .env wurde seit dem letzten Start verändert');
    if (composeChanged) console.log('   - docker-compose.yml wurde seit dem letzten Start verändert');
  } else if (isFirstBoot) {
    console.log(`Versionserfassung gestartet (Version ${currentVersion}).`);
  } else {
    console.log(`Version ${currentVersion} — keine Änderungen an .env oder docker-compose.yml seit dem letzten Start.`);
  }

  await Promise.all([
    // Always overwritten (not just on change) so the admin-panel banner only ever
    // reflects the most recent boot, instead of an old change lingering forever.
    setSetting('_version_status', JSON.stringify({
      versionChanged, envChanged, composeChanged,
      previousVersion: prevVersion, currentVersion,
      checkedAt: new Date().toISOString(),
    })),
    setSetting('_version_app', currentVersion),
    currentEnvHash !== null ? setSetting('_version_env_hash', currentEnvHash) : Promise.resolve(),
    currentComposeHash !== null ? setSetting('_version_compose_hash', currentComposeHash) : Promise.resolve(),
  ]);
}

// Called right after the app rewrites .env itself (SMTP/SSO settings save), so that
// in-app config edits aren't mistaken for an external/version-mismatch .env change on
// the next boot.
function acknowledgeEnvSelfWrite(setSetting) {
  const hash = computeFileHash(ENV_PATH);
  if (hash !== null) setSetting('_version_env_hash', hash);
}

module.exports = { getGitVersion, computeFileHash, checkVersionAndConfig, acknowledgeEnvSelfWrite, ENV_PATH, COMPOSE_PATH };
