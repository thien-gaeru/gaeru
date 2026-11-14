'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const windowsOnly = { skip: process.platform !== 'win32' };
const ps = 'powershell.exe';
const scripts = path.join(__dirname, '../scripts');
const fakeDump = `
$global:LASTEXITCODE = 93
$fileArg = @($args | Where-Object { $_ -like '--file=*' })
if ($fileArg.Count -ne 1 -or $fileArg[0] -notlike '*.partial') { throw 'Expected partial output.' }
if ($args.Count -ne 4 -or $args -notcontains '--no-password') { throw 'Unexpected dump arguments.' }
if ($env:PGHOST -ne 'db.invalid' -or $env:PGPORT -ne '6543' -or $env:PGDATABASE -ne 'test backup' -or
    $env:PGUSER -ne 'backup user' -or $env:PGPASSWORD -ne 'fixture:p@ss' -or $env:PGSSLMODE -ne 'require') {
    throw 'Connection configuration mismatch.'
}
$dumpText = "-- PostgreSQL database dump\nSELECT 1;\n"
if ($env:GAERU_BACKUP_TEST_MODE -ne 'incomplete') { $dumpText += "-- PostgreSQL database dump complete\n\\unrestrict fixture\n" }
[System.IO.File]::WriteAllText($fileArg[0].Substring(7), $dumpText)
if ($env:GAERU_BACKUP_TEST_MODE -eq 'failed') {
    Write-Error 'fixture:p@ss must never appear in diagnostics'
    $global:LASTEXITCODE = 1
} else { $global:LASTEXITCODE = 0 }
`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gaeru-backup-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backupDir = path.join(root, 'backups'), envFile = path.join(root, 'test.env'), dump = path.join(root, 'pg_dump.ps1');
  fs.mkdirSync(backupDir);
  fs.writeFileSync(envFile, '# fixture only\n export DATABASE_URL = "postgresql://backup%20user:fixture%3Ap%40ss@db.invalid:6543/test%20backup?sslmode=require" # comment\n');
  fs.writeFileSync(dump, fakeDump);
  const old = path.join(backupDir, 'old.sql');
  fs.writeFileSync(old, 'previous known-good backup');
  const oldTime = new Date(Date.now() - 72 * 60 * 60 * 1000); fs.utimesSync(old, oldTime, oldTime);
  const run = (script, mode = 'success') => spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(scripts, script), '-BackupDir', backupDir, '-EnvFile', envFile, '-PgDumpPath', dump], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, GAERU_BACKUP_TEST_MODE: mode, PGHOST: 'wrong.invalid', PGUSER: 'wrong-user', PGPASSWORD: 'wrong-fixture', PGSSLMODE: 'disable' }
  });
  return { root, backupDir, envFile, dump, old, run };
}

test('15-minute backup reads the configured connection, publishes complete dump, then expires old backups', windowsOnly, t => {
  const f = fixture(t); const result = f.run('backup-db-15m.ps1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(f.old), false);
  const files = fs.readdirSync(f.backupDir);
  assert.equal(files.length, 1); assert.match(files[0], /^gaeru_store_\d{8}_\d{6}\.sql$/);
  assert.match(fs.readFileSync(path.join(f.backupDir, files[0]), 'utf8'), /PostgreSQL database dump complete/);
});

for (const mode of ['failed', 'incomplete']) {
  test(`a ${mode} dump never publishes or prunes a previous backup`, windowsOnly, t => {
    const f = fixture(t); const result = f.run('backup-db-15m.ps1', mode);
    assert.equal(result.status, 1);
    assert.deepEqual(fs.readdirSync(f.backupDir), ['old.sql']);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture:p@ss|wrong-fixture/);
    assert.equal(fs.readFileSync(f.old, 'utf8'), 'previous known-good backup');
  });
}

test('missing configuration fails closed without a default password or retention cleanup', windowsOnly, t => {
  const f = fixture(t); fs.writeFileSync(f.envFile, '# DATABASE_URL is deliberately absent\n');
  const result = f.run('backup-db-15m.ps1');
  assert.equal(result.status, 1);
  assert.deepEqual(fs.readdirSync(f.backupDir), ['old.sql']);
});

test('daily backup retains existing backups', windowsOnly, t => {
  const f = fixture(t); const result = f.run('backup-db.ps1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(f.old), true);
  assert.equal(fs.readdirSync(f.backupDir).filter(name => name.endsWith('.sql')).length, 2);
});

test('the shared runner restores inherited database environment after failure', windowsOnly, t => {
  const f = fixture(t);
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const command = `. ${quote(path.join(scripts, 'database-backup.ps1'))};
    $env:PGHOST = 'original.invalid'; $env:PGPASSWORD = 'original-fixture';
    try { Invoke-GaeruDatabaseBackup -BackupDir ${quote(f.backupDir)} -EnvFile ${quote(f.envFile)} -PgDumpPath ${quote(f.dump)} | Out-Null } catch {}
    if ($env:PGHOST -ne 'original.invalid' -or $env:PGPASSWORD -ne 'original-fixture') { exit 1 }; exit 0`;
  const result = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...process.env, GAERU_BACKUP_TEST_MODE: 'failed' }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
