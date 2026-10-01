// node --test tests/crypto-boot.test.js
// Start-Prüfung des Master-Keys (Key-Check-Wert) in einem eigenen, kurzlebigen Compose-Projekt
// (mycloudcryptoboot, kein Host-Port). Der Test-Stack mycloudtest bleibt unberührt. Braucht Docker.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycloud-boot-'));
const keyA = crypto.randomBytes(32).toString('hex');
const keyB = crypto.randomBytes(32).toString('hex');
const base = ['compose', '-p', 'mycloudcryptoboot', '-f', path.join(root, 'tests/docker-compose.test.yml'), '-f', path.join(root, 'tests/docker-compose.crypto.override.yml')];
const hasDocker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

function dc(args, keyFile) {
  const env = { ...process.env, BOOT_KEY_DIR: dir, BOOT_KEY_FILE: keyFile || '' };
  return spawnSync('docker', [...base, ...args], { env, encoding: 'utf8', cwd: root });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Startet app neu und wartet, bis sie läuft oder beendet ist. Liefert { exit, logs }.
async function boot(keyFile) {
  const up = dc(['up', '-d', '--force-recreate', '--no-deps', 'app'], keyFile);
  assert.strictEqual(up.status, 0, up.stderr);
  for (let i = 0; i < 60; i++) {
    const logs = dc(['logs', 'app', '--no-color']).stdout;
    const id = dc(['ps', '-a', '-q', 'app']).stdout.trim();
    const st = spawnSync('docker', ['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', id], { encoding: 'utf8' }).stdout.trim().split(' ');
    if (logs.includes('myCloud app is running') || st[0] === 'exited') return { exit: st[0] === 'exited' ? Number(st[1]) : null, logs };
    await sleep(1000);
  }
  assert.fail('App weder gestartet noch beendet');
}

test('Start-Check des Master-Keys', { skip: !hasDocker && 'Docker nicht verfügbar', timeout: 300000 }, async t => {
  t.after(() => { dc(['down', '-v', '--remove-orphans']); fs.rmSync(dir, { recursive: true, force: true }); });
  const build = dc(['build', 'app']);
  assert.strictEqual(build.status, 0, build.stderr);
  assert.strictEqual(dc(['up', '-d', 'db']).status, 0);

  await t.test('ohne Key und ohne Check-Wert: normaler Start', async () => {
    const r = await boot('');
    assert.strictEqual(r.exit, null, r.logs);
    assert.ok(!r.logs.includes('Verschlüsselung'));
  });

  await t.test('erster Start mit Key A speichert Check-Wert und läuft', async () => {
    fs.writeFileSync(path.join(dir, 'key'), keyA + '\n');
    const r = await boot('/keys/key');
    assert.strictEqual(r.exit, null, r.logs);
    const q = dc(['exec', '-T', 'db', 'psql', '-U', 'mycloud', '-tA', '-c', "SELECT value FROM settings WHERE key='crypto_kcv'"]);
    const kcv = crypto.createHmac('sha256', Buffer.from(keyA, 'hex')).update('mycloud-kcv').digest('hex');
    assert.strictEqual(q.stdout.trim(), kcv);
    assert.ok(!r.logs.includes(keyA));
  });

  await t.test('erneuter Start mit gleichem Key läuft', async () => {
    const r = await boot('/keys/key');
    assert.strictEqual(r.exit, null, r.logs);
  });

  await t.test('anderer Key: Exit 1 mit Fehlermeldung', async () => {
    fs.writeFileSync(path.join(dir, 'key'), keyB + '\n');
    const r = await boot('/keys/key');
    assert.strictEqual(r.exit, 1, r.logs);
    assert.match(r.logs, /passt nicht zu dieser Instanz/);
    assert.ok(!r.logs.includes(keyA) && !r.logs.includes(keyB));
  });

  await t.test('Key entfernt, Instanz war verschlüsselt: Exit 1 mit Hinweis', async () => {
    const r = await boot('');
    assert.strictEqual(r.exit, 1, r.logs);
    assert.match(r.logs, /MYCLOUD_MASTER_KEY_FILE ist nicht gesetzt/);
  });
});
