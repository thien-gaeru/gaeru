'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function validateKey(key) {
  if (typeof key !== 'string' || !key || key.includes('\\') || /[\x00-\x1f:*?"<>|]/.test(key) || key.startsWith('/')) throw new Error('invalid_media_key');
  const parts = key.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.gaeru-storage-check' || /[. ]$/.test(part) || /^\.gaeru-sync-/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('invalid_media_key');
  return parts;
}

function createSshTransport(host, spawnProcess = spawn) {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:[\]-]*$/.test(host)) throw new Error('invalid_ssh_host');
  return request => new Promise((resolve, reject) => {
    const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentityAgent=none', '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', host, 'python3', '/usr/local/bin/gaeru-media-sync.py'];
    const child = spawnProcess('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let settled = false, size = 0; const chunks = [];
    const finish = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); if (err) reject(err); else resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('media_transport_timeout')); }, 120000);
    child.on('error', () => finish(new Error('media_transport_unavailable')));
    child.stdin.on('error', () => finish(new Error('media_transport_input_failed')));
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_FILE_BYTES * 1.4 + 1024 * 1024) { child.kill(); finish(new Error('media_response_too_large')); }
      else chunks.push(chunk);
    });
    child.on('close', code => {
      if (code !== 0) return finish(new Error('media_transport_failed'));
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!response.ok) throw new Error('media_remote_request_failed');
        finish(null, response);
      } catch (_) { finish(new Error('media_remote_request_failed')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

async function resolveLocal(root, key, createParents = false) {
  const parts = validateKey(key); const resolvedRoot = await fs.realpath(root);
  let parent = resolvedRoot;
  for (const component of parts.slice(0, -1)) {
    parent = path.join(parent, component);
    if (createParents) await fs.mkdir(parent).catch(err => { if (err.code !== 'EEXIST') throw err; });
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_media_parent');
  }
  const canonicalParent = await fs.realpath(parent);
  const relative = path.relative(resolvedRoot, canonicalParent);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('unsafe_media_parent');
  return path.join(canonicalParent, parts.at(-1));
}

async function readLocal(root, key, expected) {
  const target = await resolveLocal(root, key);
  const before = await fs.lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) throw new Error('unsupported_media_file');
  const bytes = await fs.readFile(target); const after = await fs.lstat(target);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || after.isSymbolicLink()) throw new Error('media_changed_during_read');
  const sha256 = hash(bytes);
  if (expected && (expected.sha256 !== sha256 || expected.size !== bytes.length)) throw new Error('media_changed_since_inventory');
  return { bytes, sha256, size: bytes.length };
}

async function localInventory(root) {
  const files = Object.create(null), errors = [];
  async function visit(directory, prefix) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.gaeru-sync-') || entry.name.toLowerCase() === '.gaeru-storage-check') continue;
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      try {
        validateKey(key);
        if (entry.isSymbolicLink()) throw new Error('unsafe_media_link');
        if (entry.isDirectory()) {
          const child = await resolveLocal(root, key); const stat = await fs.lstat(child);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_media_link');
          await visit(child, key);
        }
        else if (entry.isFile()) { const item = await readLocal(root, key); files[key] = { size: item.size, sha256: item.sha256 }; }
      } catch (_) { errors.push(key); }
    }
  }
  await visit(await fs.realpath(root), '');
  return { files, errors };
}

async function putLocal(root, key, bytes, expected) {
  if (bytes.length > MAX_FILE_BYTES || bytes.length !== expected.size || hash(bytes) !== expected.sha256) throw new Error('media_hash_mismatch');
  const target = await resolveLocal(root, key, true);
  const temporary = path.join(path.dirname(target), `.gaeru-sync-${crypto.randomUUID()}.partial`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    if (await resolveLocal(root, key) !== target) throw new Error('media_parent_changed');
    try { await fs.link(temporary, target); }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try { const existing = await readLocal(root, key); return existing.sha256 === expected.sha256 ? 'already_present' : 'conflict'; }
      catch (_) { return 'conflict'; }
    }
    await readLocal(root, key, expected);
    return 'copied';
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

function createMediaSynchronizer({ localRoot, remoteHost, remote = createSshTransport(remoteHost), log = () => {}, now = Date.now, intervalMs = 60000 }) {
  let running = false, closed = false, nextScanAt = 0;
  const reportedConflicts = new Map();
  function conflict(key, signature) {
    if (reportedConflicts.get(key) !== signature) log(`[MEDIA CONFLICT] ${key}: giữ nguyên cả hai bản, cần kiểm tra.`, 'WARN');
    reportedConflicts.set(key, signature);
  }
  async function scan() {
    if (closed || running || now() < nextScanAt) return;
    running = true; nextScanAt = now() + intervalMs;
    const result = { toRemote: 0, toLocal: 0, conflicts: 0, failed: 0 };
    try {
      const [local, other] = await Promise.all([localInventory(localRoot), remote({ action: 'inventory' })]);
      if (!other.ok || !other.files || typeof other.files !== 'object') throw new Error('invalid_media_inventory');
      result.failed += local.errors.length + (Array.isArray(other.errors) ? other.errors.length : 0);
      for (const key of [...new Set([...Object.keys(local.files), ...Object.keys(other.files)])].sort()) {
        if (closed) break;
        try {
          validateKey(key);
          const left = local.files[key], right = Object.hasOwn(other.files, key) ? other.files[key] : undefined;
          for (const item of [left, right].filter(Boolean)) {
            if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('invalid_media_metadata');
          }
          if (left && right) {
            if (left.sha256 !== right.sha256 || left.size !== right.size) { result.conflicts++; conflict(key, `${left.sha256}:${right.sha256}`); }
            else reportedConflicts.delete(key);
          } else if (left) {
            const file = await readLocal(localRoot, key, left);
            const response = await remote({ action: 'put', key, expectedMissing: true, ...left, data: file.bytes.toString('base64') });
            if (response.status === 'conflict') { result.conflicts++; conflict(key, left.sha256); }
            else if (response.ok && ['copied', 'already_present'].includes(response.status)) result.toRemote++;
            else throw new Error('media_put_unconfirmed');
          } else if (right) {
            const response = await remote({ action: 'get', key, sha256: right.sha256, size: right.size });
            if (!response.ok || typeof response.data !== 'string') throw new Error('invalid_media_download');
            const status = await putLocal(localRoot, key, Buffer.from(response.data, 'base64'), right);
            if (status === 'conflict') { result.conflicts++; conflict(key, right.sha256); }
            else result.toLocal++;
          }
        } catch (_) { result.failed++; log(`[MEDIA RETRY] ${key}: chưa sao chép được; giữ file nguồn và thử ở lần quét sau.`, 'WARN'); }
      }
      if (result.failed || result.conflicts || result.toRemote || result.toLocal) log(`[MEDIA AUDIT] ${JSON.stringify(result)}`);
    } catch (_) { result.failed++; log('[MEDIA RETRY] Chưa hoàn tất kiểm kê; giữ dữ liệu và thử lại ở lần quét sau.', 'WARN'); }
    finally { running = false; }
    return result;
  }
  return { scan, close() { closed = true; } };
}

module.exports = { createMediaSynchronizer, createSshTransport, validateKey, localInventory, putLocal, MAX_FILE_BYTES };
