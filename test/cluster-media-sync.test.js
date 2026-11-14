'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createMediaSynchronizer, createSshTransport, putLocal, localInventory, validateKey } = require('../scripts/cluster-media-sync');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gaeru-media-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = new Map(), requests = [], logs = []; let now = 100000;
  const f = { root, files, requests, logs, beforePut: null, beforeGet: null, failPut: false };
  const remote = async request => {
    requests.push(request);
    if (request.action === 'inventory') return { ok: true, files: Object.fromEntries([...files].map(([key, bytes]) => [key, { size: bytes.length, sha256: sha(bytes) }])), errors: [] };
    if (request.action === 'get') {
      if (f.beforeGet) await f.beforeGet(request);
      const bytes = files.get(request.key);
      if (sha(bytes) !== request.sha256) throw new Error('file changed');
      return { ok: true, data: bytes.toString('base64') };
    }
    if (request.action === 'put') {
      if (f.beforePut) await f.beforePut(request);
      if (f.failPut) throw new Error('offline');
      if (files.has(request.key)) return { ok: true, status: sha(files.get(request.key)) === request.sha256 ? 'already_present' : 'conflict' };
      assert.equal(request.expectedMissing, true);
      const bytes = Buffer.from(request.data, 'base64'); assert.equal(sha(bytes), request.sha256);
      files.set(request.key, bytes); return { ok: true, status: 'copied' };
    }
    throw new Error('Unexpected request');
  };
  f.remote = remote;
  f.sync = createMediaSynchronizer({ localRoot: root, remote, now: () => now, log: line => logs.push(line) });
  f.advance = () => { now += 60000; };
  f.local = async (key, value) => { const file = path.join(root, key); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); };
  return f;
}

test('missing nested files copy in both directions, while different hashes remain untouched', async t => {
  const f = await fixture(t);
  await f.local('nested/local.bin', 'local file'); f.files.set('remote.bin', Buffer.from('remote file'));
  await f.local('conflict.bin', 'PC version'); f.files.set('conflict.bin', Buffer.from('Mi6 version'));
  const result = await f.sync.scan();
  assert.equal(result.toRemote, 1); assert.equal(result.toLocal, 1); assert.equal(result.conflicts, 1);
  assert.equal(f.files.get('nested/local.bin').toString(), 'local file');
  assert.equal(await fs.readFile(path.join(f.root, 'remote.bin'), 'utf8'), 'remote file');
  assert.equal(await fs.readFile(path.join(f.root, 'conflict.bin'), 'utf8'), 'PC version');
  assert.equal(f.files.get('conflict.bin').toString(), 'Mi6 version');
});

test('failed copies survive a synchronizer restart and retry from durable inventory', async t => {
  const f = await fixture(t); await f.local('pending.bin', 'retry me'); f.failPut = true;
  assert.equal((await f.sync.scan()).failed, 1);
  const calls = f.requests.length; await f.sync.scan(); assert.equal(f.requests.length, calls, 'no hot-loop retry');
  assert.equal(await fs.readFile(path.join(f.root, 'pending.bin'), 'utf8'), 'retry me');
  f.sync.close(); f.failPut = false;
  f.sync = createMediaSynchronizer({ localRoot: f.root, remote: f.remote });
  assert.equal((await f.sync.scan()).toRemote, 1);
  assert.equal(f.files.get('pending.bin').toString(), 'retry me');
});

test('a remote file appearing after inventory is preserved as a conflict', async t => {
  const f = await fixture(t); await f.local('race.bin', 'PC content');
  f.beforePut = async request => f.files.set(request.key, Buffer.from('concurrent Mi6 content'));
  assert.equal((await f.sync.scan()).conflicts, 1);
  assert.equal(f.files.get('race.bin').toString(), 'concurrent Mi6 content');
  assert.equal(await fs.readFile(path.join(f.root, 'race.bin'), 'utf8'), 'PC content');
});

test('a local file appearing after inventory is never overwritten', async t => {
  const f = await fixture(t); f.files.set('race.bin', Buffer.from('Mi6 content'));
  f.beforeGet = () => f.local('race.bin', 'concurrent PC content');
  assert.equal((await f.sync.scan()).conflicts, 1);
  assert.equal(await fs.readFile(path.join(f.root, 'race.bin'), 'utf8'), 'concurrent PC content');
  assert.deepEqual((await fs.readdir(f.root)).filter(name => name.startsWith('.gaeru-sync-')), []);
});

test('a bad hash never publishes a partial destination file', async t => {
  const f = await fixture(t);
  await assert.rejects(putLocal(f.root, 'bad.bin', Buffer.from('bad bytes'), { size: 9, sha256: sha('good data') }));
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('path traversal from remote inventory never creates or overwrites outside the media root', async t => {
  const f = await fixture(t); f.files.set('../outside.bin', Buffer.from('unsafe'));
  assert.equal((await f.sync.scan()).failed, 1);
  assert.deepEqual(await fs.readdir(f.root), []);
  assert.equal(f.requests.some(request => request.action === 'get'), false);
});

test('removing a local file never sends a deletion to the other machine', async t => {
  const f = await fixture(t); await f.local('survivor.bin', 'keep'); f.files.set('survivor.bin', Buffer.from('keep'));
  await f.sync.scan(); await fs.unlink(path.join(f.root, 'survivor.bin')); f.advance(); await f.sync.scan();
  assert.equal(f.files.get('survivor.bin').toString(), 'keep');
  assert.equal(await fs.readFile(path.join(f.root, 'survivor.bin'), 'utf8'), 'keep');
  assert.ok(f.requests.every(request => ['inventory', 'get', 'put'].includes(request.action)));
});

test('node identity files are excluded from inventory at every directory depth', async t => {
  const f = await fixture(t);
  await f.local('.gaeru-storage-check', 'PC identity');
  await f.local('nested/.gaeru-storage-check', 'nested identity');
  await f.local('nested/ordinary.bin', 'share this');
  const inventory = await localInventory(f.root);
  assert.deepEqual(Object.keys(inventory.files), ['nested/ordinary.bin']);
  assert.deepEqual(inventory.errors, []);
  assert.equal((await f.sync.scan()).toRemote, 1);
  assert.equal(f.files.has('.gaeru-storage-check'), false);
  assert.equal(f.files.has('nested/.gaeru-storage-check'), false);
});

test('identity path components are rejected for both downloads and local writes', async t => {
  const f = await fixture(t);
  for (const key of ['.gaeru-storage-check', 'nested/.gaeru-storage-check', '.gaeru-storage-check/child.bin', '.GAERU-STORAGE-CHECK']) {
    assert.throws(() => validateKey(key));
    await assert.rejects(putLocal(f.root, key, Buffer.from('identity'), { size: 8, sha256: sha('identity') }));
    f.files.set(key, Buffer.from('remote identity'));
  }
  assert.equal((await f.sync.scan()).failed, 4);
  assert.equal(f.requests.some(request => request.action === 'get'), false);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('SSH sends paths only through stdin and requires host verification without an agent', async () => {
  let call, input;
  const fakeSpawn = (exe, args, options) => {
    call = { exe, args, options }; const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    child.stdin.on('data', chunk => { input = (input || '') + chunk.toString(); });
    child.stdin.on('finish', () => { child.stdout.write('{"ok":true,"files":{}}'); child.emit('close', 0); });
    return child;
  };
  const remote = createSshTransport('root@192.168.31.59', fakeSpawn);
  const key = "customer's image $(echo bad).png";
  await remote({ action: 'get', key });
  assert.equal(call.exe, 'ssh'); assert.equal(call.options.shell, undefined);
  for (const option of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'IdentityAgent=none']) assert.ok(call.args.includes(option));
  assert.equal(call.args.some(argument => argument.includes(key)), false);
  assert.equal(JSON.parse(input).key, key);
});
