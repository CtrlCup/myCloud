const fs = require('fs');
const path = require('path');
const { version: SOFTWARE_VERSION } = require('./package.json');

const ENV_PATH = path.join(__dirname, '.env');
const COMPOSE_PATH = path.join(__dirname, 'docker-compose.yml');

// Bump these whenever a change to .env.example / docker-compose.yml requires the user
// to manually update their own copy (new required variable, new volume, etc.) — the
// version markers in those files (ENV_VERSION=.. / # COMPOSE_VERSION=..) then fall
// behind and get flagged as outdated below.
const EXPECTED_ENV_VERSION = '1.0.0';
const EXPECTED_COMPOSE_VERSION = '1.0.0';

// Reads a "KEY=1.2.3" marker line from a file — plain for .env, as a YAML comment
// ("# KEY=1.2.3") for docker-compose.yml. Returns null if the file or marker is missing.
function readVersionMarker(filePath, key) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(new RegExp(`^#?\\s*${key}=([\\d.]+)`, 'm'));
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Numeric major.minor.patch comparison — returns -1/0/1. Missing/non-numeric parts
// count as 0, so "1" and "1.0.0" compare equal.
function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function getVersionStatus() {
  const envVersion = readVersionMarker(ENV_PATH, 'ENV_VERSION');
  const composeVersion = readVersionMarker(COMPOSE_PATH, 'COMPOSE_VERSION');

  return {
    software: { version: SOFTWARE_VERSION },
    env: {
      version: envVersion,
      expected: EXPECTED_ENV_VERSION,
      outdated: envVersion === null || compareVersions(envVersion, EXPECTED_ENV_VERSION) < 0,
    },
    compose: {
      version: composeVersion,
      expected: EXPECTED_COMPOSE_VERSION,
      outdated: composeVersion === null || compareVersions(composeVersion, EXPECTED_COMPOSE_VERSION) < 0,
    },
  };
}

// Called once at boot to print the three versions and flag anything outdated.
function logVersionStatus() {
  const s = getVersionStatus();
  console.log(
    `Version: Software ${s.software.version} | .env ${s.env.version || 'nicht gesetzt'} | docker-compose.yml ${s.compose.version || 'nicht gesetzt'}`
  );
  if (s.env.outdated) {
    console.log(`⚠️  .env ist veraltet (Version ${s.env.version || 'nicht gesetzt'}, erwartet ${s.env.expected}) — bitte mit .env.example abgleichen.`);
  }
  if (s.compose.outdated) {
    console.log(`⚠️  docker-compose.yml ist veraltet (Version ${s.compose.version || 'nicht gesetzt'}, erwartet ${s.compose.expected}) — bitte die aktuelle docker-compose.yml aus dem Repository übernehmen.`);
  }
}

const GITHUB_REPO = 'CtrlCup/myCloud';
const GITHUB_BRANCH = 'main';
const UPDATE_CHECK_CACHE_MS = 60 * 60 * 1000; // 1h — avoid hitting GitHub on every admin panel load

let updateCheckCache = null;

// Checks GitHub for a newer package.json version than the one currently running. Never
// throws — a failed/offline check just means no "update available" note is shown, it
// doesn't affect anything else. This only ever reads a public file; it never pulls code
// or triggers any kind of update itself.
async function checkForUpdate() {
  if (updateCheckCache && Date.now() - updateCheckCache.checkedAt < UPDATE_CHECK_CACHE_MS) {
    return updateCheckCache;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(
      `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/app/package.json`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`GitHub responded with ${res.status}`);
    const pkg = await res.json();
    updateCheckCache = {
      latestVersion: pkg.version || null,
      updateAvailable: !!pkg.version && compareVersions(pkg.version, SOFTWARE_VERSION) > 0,
      checkedAt: Date.now(),
    };
  } catch {
    updateCheckCache = { latestVersion: null, updateAvailable: false, checkedAt: Date.now() };
  }
  return updateCheckCache;
}

module.exports = { getVersionStatus, logVersionStatus, checkForUpdate, GITHUB_REPO };
