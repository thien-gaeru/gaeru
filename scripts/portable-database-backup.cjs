'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Transform, Writable } = require('node:stream');
const { createGzip, createGunzip } = require('node:zlib');

function dumpFooter() {
  let tail = Buffer.alloc(0);
  return new Transform({
    transform(chunk, encoding, callback) {
      tail = Buffer.concat([tail, chunk.subarray(-8192)]).subarray(-8192);
      callback(null, chunk);
    },
    flush(callback) {
      const valid = /^-- PostgreSQL database dump complete\s*$/m.test(tail.toString('utf8').split(/\r?\n/).slice(-24).join('\n'));
      callback(valid ? null : new Error('Missing pg_dump completion footer.'));
    }
  });
}

function start(program, args, env) {
  // Support explicitly supplied PowerShell dump adapters as well as libpq executables.
  if (process.platform === 'win32' && path.extname(program).toLowerCase() === '.ps1') {
    args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', program, ...args];
    program = 'powershell.exe';
  }
  const child = spawn(program, args, { shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'ignore'] });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Backup tool exited unsuccessfully.')));
  });
  return { child, done };
}

async function run(mode, gpg, file, dump, fingerprint) {
  const common = ['--batch', '--no-tty', '--no-auto-key-locate'];
  const gpgEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^PG|^DATABASE_URL$/i.test(k)));
  if (mode === 'verify') {
    const decoder = start(gpg, [...common, '--decrypt', '--', file], gpgEnv);
    decoder.child.stdin.end();
    try {
      await Promise.all([decoder.done, pipeline(decoder.child.stdout, createGunzip(), dumpFooter(),
        new Writable({ write(chunk, encoding, callback) { callback(); } }))]);
    } finally { decoder.child.kill(); }
    return;
  }
  if (mode !== 'backup' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(fingerprint || '')) throw new Error('Invalid backup parameters.');
  const source = start(dump, ['--no-password', '--format=plain', '--lock-wait-timeout=30s'], process.env);
  const encoder = start(gpg, [...common, '--trust-model', 'always', '--compress-algo', 'none', '--recipient', fingerprint, '--encrypt'], gpgEnv);
  source.child.stdin.end();
  try {
    await Promise.all([source.done, encoder.done,
      pipeline(source.child.stdout, dumpFooter(), createGzip(), encoder.child.stdin),
      pipeline(encoder.child.stdout, fs.createWriteStream(file, { flags: 'wx', mode: process.platform === 'win32' ? 0o666 : 0o600 }))]);
  } finally {
    source.child.kill();
    encoder.child.kill();
  }
}

if (require.main === module) run(...process.argv.slice(2)).catch(() => {
  // Child diagnostics and database content can include private data.
  console.error('Portable database backup operation failed.');
  process.exitCode = 1;
});
