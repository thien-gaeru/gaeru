'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const hasGpg = process.platform === 'win32' && spawnSync('gpg.exe', ['--version'], { windowsHide: true }).status === 0;
const windowsOnly = { skip: !hasGpg };
let keyDir, recipient;
test.before(() => {
  if (!hasGpg) return;
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaeru-key-'));
  const options = { env: { ...process.env, GNUPGHOME: keyDir }, encoding: 'utf8', windowsHide: true };
  const key = spawnSync('gpg.exe', ['--batch', '--generate-key'], { ...options, input:
    'Key-Type: RSA\nKey-Length: 2048\nKey-Usage: encrypt\nName-Real: Backup Fixture\nName-Email: fixture@example.invalid\n%no-protection\n%commit\n' });
  assert.equal(key.status, 0, key.stderr);
  const listing = spawnSync('gpg.exe', ['--batch', '--with-colons', '--list-keys'], options);
  recipient = /^fpr:::::::::([0-9A-F]+):/m.exec(listing.stdout)?.[1];
  assert.ok(recipient);
});
test.after(() => {
  if (!keyDir) return;
  spawnSync('gpgconf.exe', ['--kill', 'all'], { env: { ...process.env, GNUPGHOME: keyDir }, windowsHide: true });
  fs.rmSync(keyDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
});
const ps = 'powershell.exe';
const scripts = path.join(__dirname, '../scripts');
const fakeDump = `
if ($args.Count -ne 3 -or $args -notcontains '--no-password' -or $args -match '--file') { exit 2 }
if ($env:PGHOST -ne 'db.invalid' -or $env:PGPORT -ne '6543' -or $env:PGDATABASE -ne 'test backup' -or
    $env:PGUSER -ne 'backup user' -or $env:PGPASSWORD -ne 'fixture:p@ss' -or $env:PGSSLMODE -ne 'require') {
    throw 'Connection configuration mismatch.'
}
$dumpText = "-- PostgreSQL database dump\nSELECT 1;\n"
if ($env:GAERU_BACKUP_TEST_MODE -ne 'incomplete') { $dumpText += "-- PostgreSQL database dump complete\n\\unrestrict fixture\n" }
[Console]::Write($dumpText)
if ($env:GAERU_BACKUP_TEST_MODE -eq 'failed') {
    Write-Error 'fixture:p@ss must never appear in diagnostics'
    exit 1
} else { exit 0 }
`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gaeru-backup-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backupDir = path.join(root, 'backups'), envFile = path.join(root, 'test.env'), dump = path.join(root, 'pg_dump.ps1');
  fs.mkdirSync(backupDir);
  fs.writeFileSync(envFile, '# fixture only\n export DATABASE_URL = "postgresql://backup%20user:fixture%3Ap%40ss@db.invalid:6543/test%20backup?sslmode=require" # comment\n');
  fs.writeFileSync(dump, fakeDump);
  const old = path.join(backupDir, 'gaeru_store-old.sql.gz.gpg');
  fs.writeFileSync(old, 'previous known-good backup');
  const oldTime = new Date(Date.now() - 72 * 60 * 60 * 1000); fs.utimesSync(old, oldTime, oldTime);
  const run = (script, mode = 'success') => spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(scripts, script), '-BackupDir', backupDir, '-EnvFile', envFile, '-PgDumpPath', dump], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, GNUPGHOME: keyDir, GAERU_BACKUP_GPG_RECIPIENT: mode === 'missing-key' ? 'A'.repeat(40) : recipient, GAERU_BACKUP_TEST_MODE: mode, PGHOST: 'wrong.invalid', PGUSER: 'wrong-user', PGPASSWORD: 'wrong-fixture', PGSSLMODE: 'disable' }
  });
  return { root, backupDir, envFile, dump, old, run };
}

test('15-minute backup reads the configured connection, publishes complete dump, then expires old backups', windowsOnly, t => {
  const f = fixture(t); const result = f.run('backup-db-15m.ps1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(f.old), false);
  const files = fs.readdirSync(f.backupDir);
  assert.equal(files.length, 2);
  const filename = files.find(name => /^gaeru_store-.*\.sql\.gz\.gpg$/.test(name));
  assert.ok(filename);
  const encrypted = path.join(f.backupDir, filename);
  assert.equal(fs.readFileSync(encrypted).includes(Buffer.from('PostgreSQL database dump complete')), false);
  const verify = () => spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(scripts, 'failover-restore-to-pc.ps1'), '-Mode', 'VerifyPortable', '-PortableFile', encrypted], {
    env: { ...process.env, GNUPGHOME: keyDir }, encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(verify().status, 0);
  fs.appendFileSync(encrypted, 'damaged fixture');
  assert.equal(verify().status, 1);
});

for (const mode of ['failed', 'incomplete', 'missing-key']) {
  test(`a ${mode} dump never publishes or prunes a previous backup`, windowsOnly, t => {
    const f = fixture(t); const result = f.run('backup-db-15m.ps1', mode);
    assert.equal(result.status, 1);
    assert.deepEqual(fs.readdirSync(f.backupDir), [path.basename(f.old)]);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture:p@ss|wrong-fixture/);
    assert.equal(fs.readFileSync(f.old, 'utf8'), 'previous known-good backup');
  });
}

test('missing configuration fails closed without a default password or retention cleanup', windowsOnly, t => {
  const f = fixture(t); fs.writeFileSync(f.envFile, '# DATABASE_URL is deliberately absent\n');
  const result = f.run('backup-db-15m.ps1');
  assert.equal(result.status, 1);
  assert.deepEqual(fs.readdirSync(f.backupDir), [path.basename(f.old)]);
});

test('daily backup retains existing backups', windowsOnly, t => {
  const f = fixture(t); const result = f.run('backup-db.ps1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(f.old), true);
  assert.equal(fs.readdirSync(f.backupDir).filter(name => name.endsWith('.sql.gz.gpg')).length, 2);
});

test('the shared runner restores inherited database environment after failure', windowsOnly, t => {
  const f = fixture(t);
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const command = `. ${quote(path.join(scripts, 'database-backup.ps1'))};
    $env:PGHOST = 'original.invalid'; $env:PGPASSWORD = 'original-fixture';
    try { Invoke-GaeruDatabaseBackup -BackupDir ${quote(f.backupDir)} -EnvFile ${quote(f.envFile)} -PgDumpPath ${quote(f.dump)} | Out-Null } catch {}
    if ($env:PGHOST -ne 'original.invalid' -or $env:PGPASSWORD -ne 'original-fixture') { exit 1 }; exit 0`;
  const result = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...process.env, GNUPGHOME: keyDir, GAERU_BACKUP_GPG_RECIPIENT: recipient, GAERU_BACKUP_TEST_MODE: 'failed' }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
