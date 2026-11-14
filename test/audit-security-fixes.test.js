const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { PGlite } = require('@electric-sql/pglite');
const sharp = require('sharp');
const jsQR = require('jsqr');

const { createApp } = require('../src/app');
const { migrateDatabase, MIGRATION_FILES } = require('../src/migrate');
const { ramCache, invalidateTags } = require('../cache');
const { EventEmitter } = require('node:events');
const { configureSseSocket, sseHandler } = require('../src/realtime-sse');
const { loadWebPagesIndexAsync, clearWebKnowledgeCache } = require('../src/chat-web-knowledge');
const { FailoverSyncManager } = require('../src/failover-sync');

async function createPglitePool() {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const previous = queue;
    let release;
    queue = new Promise((resolve) => { release = resolve; });
    await previous;
    return release;
  }
  async function execQuery(sql, values) {
    const result = !values && sql.includes(';')
      ? (await db.exec(sql)).at(-1)
      : await db.query(sql, values);
    return {
      ...result,
      rows: result?.rows || [],
      rowCount: result?.affectedRows ?? result?.rows?.length ?? 0,
    };
  }
  return {
    async query(sql, values) {
      const release = await lock();
      try {
        return await execQuery(sql, values);
      } finally {
        release();
      }
    },
    async connect() {
      const release = await lock();
      return { query: execQuery, release };
    },
    end: () => db.close(),
  };
}

function makeClient(baseUrl) {
  let cookie = '';
  let csrf = '';
  return {
    async request(url, { method = 'GET', body, headers = {} } = {}) {
      const mergedHeaders = {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(method !== 'GET' && method !== 'HEAD' && csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...(body && typeof body === 'object' && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      };
      const res = await fetch(`${baseUrl}${url}`, {
        method,
        headers: mergedHeaders,
        body: body && typeof body === 'object' && !(body instanceof FormData) ? JSON.stringify(body) : body,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const ct = res.headers.get('content-type') || '';
      let data = null;
      if (res.status !== 204) {
        if (ct.includes('application/json')) data = await res.json();
        else if (ct.includes('image/png')) data = Buffer.from(await res.arrayBuffer());
        else data = await res.text();
      }
      if (data && typeof data === 'object' && !Buffer.isBuffer(data) && data.csrfToken) {
        csrf = data.csrfToken;
      }
      return { status: res.status, headers: res.headers, data };
    },
    async ok(url, opts) {
      const res = await this.request(url, opts);
      assert.equal(res.status, opts?.expected || 200, `${opts?.method || 'GET'} ${url}: ${JSON.stringify(res.data)}`);
      return res.data;
    },
  };
}

function requestWithCustomHost(port, requestPath, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method: 'GET',
      headers: { Host: hostHeader },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('audit fixes: /health, /api/failover-status auth, /gaeru_ceo/pwa-qr.png host hardening, and CTE cache flush', async (t) => {
  const pool = await createPglitePool();
  await migrateDatabase(pool);

  const app = createApp({
    config: {
      NODE_ENV: 'test',
      PORT: 0,
      PUBLIC_BASE_URL: 'https://gaeru.com',
      SESSION_SECRET: randomBytes(48).toString('hex'),
      ADMIN_USERNAME: 'audit-owner',
      ADMIN_PASSWORD_HASH: bcrypt.hashSync('Audit-Owner-Pass-2026!', 4),
      STORE_ORDERS_ENABLED: true,
    },
    pool,
    sessionStore: new session.MemoryStore(),
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await pool.end();
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // 1. Minimal /health endpoint
  const healthRes = await fetch(`${baseUrl}/health`);
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await healthRes.json(), { status: 'ok' });

  // 2. /api/failover-status requires admin session + dashboard.read
  const guest = makeClient(baseUrl);
  assert.equal((await guest.request('/api/failover-status')).status, 401);

  const custHash = bcrypt.hashSync('CustPass2026!', 4);
  await pool.query(
    'INSERT INTO customers(full_name, email, phone, password_hash) VALUES($1, $2, $3, $4)',
    ['Customer Only', 'cust-only@example.test', '0901111111', custHash]
  );
  const cust = makeClient(baseUrl);
  await cust.ok('/api/csrf');
  await cust.ok('/api/customer-auth/login', {
    method: 'POST',
    body: { identifier: 'cust-only@example.test', password: 'CustPass2026!' },
  });
  assert.equal((await cust.request('/api/failover-status')).status, 401);

  const owner = makeClient(baseUrl);
  await owner.ok('/api/csrf');
  await owner.ok('/api/auth/login', {
    method: 'POST',
    body: { username: 'audit-owner', password: 'Audit-Owner-Pass-2026!' },
  });
  const failoverStatus = await owner.ok('/api/failover-status');
  assert.equal(typeof failoverStatus, 'object');
  assert.ok('mode' in failoverStatus || 'role' in failoverStatus || 'running' in failoverStatus || 'stateFilePath' in failoverStatus || 'peer' in failoverStatus);

  // 3. /gaeru_ceo/pwa-qr.png ignores untrusted Host and ?url= phishing target
  const qrRes = await requestWithCustomHost(
    port,
    '/gaeru_ceo/pwa-qr.png?url=' + encodeURIComponent('https://evil.attacker.invalid/phish'),
    'evil.attacker.invalid'
  );
  assert.equal(qrRes.status, 200);
  assert.equal(qrRes.headers['content-type'], 'image/png');
  assert.match(String(qrRes.headers['cache-control'] || ''), /private/);
  assert.match(String(qrRes.headers.vary || ''), /host/i);
  const { data: rgba, info } = await sharp(qrRes.body).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const decodedQr = jsQR(new Uint8ClampedArray(rgba), info.width, info.height);
  assert.ok(decodedQr, 'QR PNG must decode cleanly');
  assert.equal(decodedQr.data, 'https://gaeru.com/gaeru_ceo');

  // 4. CTE SQL mutations (WITH ... UPDATE products) trigger catalog cache invalidation
  ramCache.set('data:catalog', { data: { sentinel: true }, tags: ['products'], expiresAt: Date.now() + 60000 });
  assert.equal(ramCache.has('data:catalog'), true);
  await pool.query('WITH cte AS (SELECT 1) UPDATE products SET active = true WHERE false');
  assert.equal(ramCache.has('data:catalog'), false);
});

test('audit fixes: checkout cart check-prices, marketing quote soft-delete filter & promo+bundle+voucher waterfall cap', { timeout: 60000 }, async (t) => {
  const pool = await createPglitePool();
  await migrateDatabase(pool);

  const app = createApp({
    config: {
      NODE_ENV: 'test',
      PORT: 0,
      SESSION_SECRET: randomBytes(48).toString('hex'),
      ADMIN_USERNAME: 'pricing-owner',
      ADMIN_PASSWORD_HASH: bcrypt.hashSync('Pricing-Owner-2026!', 4),
      STORE_ORDERS_ENABLED: true,
    },
    pool,
    sessionStore: new session.MemoryStore(),
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await pool.end();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const owner = makeClient(baseUrl);
  await owner.ok('/api/csrf');
  await owner.ok('/api/auth/login', {
    method: 'POST',
    body: { username: 'pricing-owner', password: 'Pricing-Owner-2026!' },
  });

  const p1Body = { slug: 'audit-p1', name: 'Audit Mic 1', category: 'audio', descriptor: 'D', description: '', imageUrl: '/assets/products/k9.webp', imageAlt: 'P1', active: false, sortOrder: 1 };
  const p1 = await owner.ok('/api/gaeru_ceo/products', { method: 'POST', expected: 201, body: p1Body });
  const v1 = await owner.ok(`/api/gaeru_ceo/products/${p1.id}/variants`, {
    method: 'POST',
    expected: 201,
    body: { sku: 'AUD-1', name: 'V1', options: {}, priceVnd: 100000, stockQuantity: 50, active: true },
  });
  await owner.ok(`/api/gaeru_ceo/products/${p1.id}`, { method: 'PUT', body: { ...p1Body, active: true } });

  const p2Body = { slug: 'audit-p2', name: 'Audit Mic 2', category: 'audio', descriptor: 'D', description: '', imageUrl: '/assets/products/k9.webp', imageAlt: 'P2', active: false, sortOrder: 2 };
  const p2 = await owner.ok('/api/gaeru_ceo/products', { method: 'POST', expected: 201, body: p2Body });
  const v2 = await owner.ok(`/api/gaeru_ceo/products/${p2.id}/variants`, {
    method: 'POST',
    expected: 201,
    body: { sku: 'AUD-2', name: 'V2', options: {}, priceVnd: 100000, stockQuantity: 50, active: true },
  });
  await owner.ok(`/api/gaeru_ceo/products/${p2.id}`, { method: 'PUT', body: { ...p2Body, active: true } });

  const pDelBody = { slug: 'audit-del', name: 'Deleted Mic', category: 'audio', descriptor: 'D', description: '', imageUrl: '/assets/products/k9.webp', imageAlt: 'PD', active: false, sortOrder: 3 };
  const pDeleted = await owner.ok('/api/gaeru_ceo/products', { method: 'POST', expected: 201, body: pDelBody });
  const vDeleted = await owner.ok(`/api/gaeru_ceo/products/${pDeleted.id}/variants`, {
    method: 'POST',
    expected: 201,
    body: { sku: 'AUD-DEL', name: 'VD', options: {}, priceVnd: 100000, stockQuantity: 50, active: true },
  });
  await owner.ok(`/api/gaeru_ceo/products/${pDeleted.id}`, { method: 'PUT', body: { ...pDelBody, active: true } });
  await pool.query('UPDATE products SET deleted_at = now() WHERE id = $1', [pDeleted.id]);

  // 20% promotion on v1 -> 80,000 VND
  await owner.ok('/api/gaeru_ceo/marketing/promotions', {
    method: 'POST',
    expected: 201,
    body: {
      data: {
        title: 'Audit Promo 20%',
        type: 'flash',
        kind: 'percent',
        amount: 20,
        startsAt: new Date(Date.now() - 60000).toISOString(),
        endsAt: new Date(Date.now() + 86400000).toISOString(),
        active: true,
        variantIds: [v1.id],
      },
    },
  });

  // Fixed bundle 40,000 VND off when buying v1 + v2 (180,000 -> 140,000)
  await owner.ok('/api/gaeru_ceo/marketing/bundles', {
    method: 'POST',
    expected: 201,
    body: {
      data: {
        title: 'Audit Combo',
        description: 'Giam 40k',
        discountType: 'fixed',
        discountValue: 40000,
        startsAt: new Date(Date.now() - 60000).toISOString(),
        endsAt: new Date(Date.now() + 86400000).toISOString(),
        active: true,
        items: [
          { variantId: v1.id, isPrimary: true, minQuantity: 1 },
          { variantId: v2.id, isPrimary: false, minQuantity: 1 },
        ],
      },
    },
  });

  // Fixed voucher 180,000 VND (exceeds remaining 140,000 after bundle -> must cap at 140,000)
  await owner.ok('/api/gaeru_ceo/marketing/vouchers', {
    method: 'POST',
    expected: 201,
    body: {
      data: {
        code: 'CAPTEST',
        title: 'Big voucher',
        kind: 'fixed',
        amount: 180000,
        maxDiscountVnd: null,
        minSpendVnd: 100000,
        startsAt: new Date(Date.now() - 60000).toISOString(),
        endsAt: new Date(Date.now() + 86400000).toISOString(),
        totalLimit: 10,
        perCustomerLimit: 2,
        publicClaim: true,
        active: true,
      },
    },
  });

  const cust = makeClient(baseUrl);
  const custPass = 'BuyerCart2026!';
  await pool.query(
    'INSERT INTO customers(full_name, email, phone, password_hash) VALUES($1, $2, $3, $4)',
    ['Cart Buyer', 'cart-buyer@example.test', '0902222222', bcrypt.hashSync(custPass, 4)]
  );
  await cust.ok('/api/csrf');
  await cust.ok('/api/customer-auth/login', {
    method: 'POST',
    body: { identifier: 'cart-buyer@example.test', password: custPass },
  });
  await cust.ok('/api/customer/marketing/claim', { method: 'POST', body: { code: 'CAPTEST' } });

  // Soft-deleted product is ignored by PUT /cart and rejected by /marketing/quote
  const putCartRes = await cust.ok('/api/customer/cart', {
    method: 'PUT',
    body: {
      items: [
        { variantId: v1.id, quantity: 1 },
        { variantId: v2.id, quantity: 1 },
        { variantId: vDeleted.id, quantity: 1 },
      ],
    },
  });
  assert.equal(putCartRes.items.length, 2);

  const missingCsrf = await cust.request('/api/customer/cart/check-prices', {
    method: 'POST',
    headers: { 'X-CSRF-Token': '' },
    body: { items: [{ variantId: v1.id, expectedPriceVnd: 100000 }] },
  });
  assert.equal(missingCsrf.status, 403);

  const badBody = await cust.request('/api/customer/cart/check-prices', {
    method: 'POST',
    body: { items: [{ variantId: 'not-a-uuid' }] },
  });
  assert.equal(badBody.status, 400);

  const postCheck = await cust.ok('/api/customer/cart/check-prices', {
    method: 'POST',
    body: { items: [{ variantId: v1.id, expectedPriceVnd: 100000 }] },
  });
  assert.equal(postCheck.hasPriceChanges, true);
  assert.equal(postCheck.priceChanges[0].currentPriceVnd, 80000);
  assert.equal(postCheck.bundleDiscountVnd, 40000);
  assert.equal(postCheck.currentSubtotalVnd, 140000);

  const getCheck = await cust.ok('/api/customer/cart/check-prices');
  assert.equal(getCheck.bundleDiscountVnd, 40000);
  assert.equal(getCheck.currentSubtotalVnd, 140000);

  const deletedQuote = await cust.request('/api/customer/marketing/quote', {
    method: 'POST',
    body: { code: 'CAPTEST', items: [{ variantId: vDeleted.id, quantity: 1 }] },
  });
  assert.equal(deletedQuote.status, 409);

  const bundleVoucherQuote = await cust.ok('/api/customer/marketing/quote', {
    method: 'POST',
    body: {
      code: 'CAPTEST',
      items: [
        { variantId: v1.id, quantity: 1 },
        { variantId: v2.id, quantity: 1 },
      ],
    },
  });
  assert.equal(bundleVoucherQuote.subtotalVnd, 180000);
  assert.equal(bundleVoucherQuote.bundleDiscountVnd, 40000);
  assert.equal(bundleVoucherQuote.discountVnd, 140000);
});

test('audit fixes: SSE socket keepalive/timeout, async web knowledge loader, and non-repo failover state path', async (t) => {
  const calls = [];
  const socket = {
    remoteAddress: '127.0.0.1',
    setTimeout: (ms) => calls.push(['socket.setTimeout', ms]),
    setNoDelay: (v) => calls.push(['setNoDelay', v]),
    setKeepAlive: (en, ms) => calls.push(['setKeepAlive', en, ms]),
  };
  const req = Object.assign(new EventEmitter(), {
    ip: '127.0.0.1',
    headers: {},
    socket,
    setTimeout: (ms) => calls.push(['req.setTimeout', ms]),
  });
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    setTimeout: (ms) => calls.push(['res.setTimeout', ms]),
    writeHead: () => {},
    write: () => {},
    end: () => { res.writableEnded = true; },
  });
  sseHandler(req, res);
  res.emit('close');
  req.emit('close');
  assert.deepEqual(calls, [
    ['req.setTimeout', 0],
    ['res.setTimeout', 0],
    ['socket.setTimeout', 0],
    ['setNoDelay', true],
    ['setKeepAlive', true, 10000],
  ]);

  clearWebKnowledgeCache();
  const pages = await loadWebPagesIndexAsync();
  assert.ok(Array.isArray(pages) && pages.length > 0);
  assert.ok(pages.length <= 100);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaeru-failover-state-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const prevStatePath = process.env.FAILOVER_STATE_PATH;
  delete process.env.FAILOVER_STATE_PATH;
  try {
    const defaultMgr = new FailoverSyncManager({}, { query: async () => ({ rows: [] }) });
    assert.ok(!defaultMgr.stateFilePath.startsWith(path.resolve(__dirname, '..')), 'failover state must not default into repo root');
    const customPath = path.join(tmpDir, 'state.json');
    const customMgr = new FailoverSyncManager({ FAILOVER_STATE_PATH: customPath }, { query: async () => ({ rows: [] }) });
    assert.equal(customMgr.stateFilePath, customPath);
  } finally {
    if (prevStatePath !== undefined) process.env.FAILOVER_STATE_PATH = prevStatePath;
  }
});

test('audit fixes: full DB schema migration creates FK indexes idempotently and ops/CI hardening invariants hold', async (t) => {
  assert.equal(MIGRATION_FILES.at(-1), 'audit-fk-indexes-20261114.sql');
  const pool = await createPglitePool();
  t.after(() => pool.end());

  const firstRun = await migrateDatabase(pool);
  assert.equal(firstRun.appliedCount, MIGRATION_FILES.length);
  const secondRun = await migrateDatabase(pool);
  assert.equal(secondRun.appliedCount, 0);

  const idxRows = (await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx_%'")).rows.map((r) => r.indexname);
  const idxSet = new Set(idxRows);
  for (const requiredIdx of [
    'idx_order_items_order_id',
    'idx_order_items_variant_id',
    'idx_warehouse_stock_variant_id',
    'idx_shopping_chat_upload_sessions_completed_file_id',
    'idx_warranty_email_outbox_order_id',
  ]) {
    assert.ok(idxSet.has(requiredIdx), `Missing expected FK index: ${requiredIdx}`);
  }

  const root = path.resolve(__dirname, '..');
  const watchdogSrc = fs.readFileSync(path.join(root, 'scripts', 'watchdog-supervisor.js'), 'utf8');
  assert.doesNotMatch(watchdogSrc, /\bexecSync\b/);
  assert.match(watchdogSrc, /\bexecFileSync\b/);
  assert.match(watchdogSrc, /shell:\s*false/);
  assert.doesNotMatch(watchdogSrc, /Start-Sleep -Milliseconds/);

  const pullPs1 = fs.readFileSync(path.join(root, 'scripts', 'pull-mi6-backups.ps1'), 'utf8');
  assert.match(pullPs1, /StrictHostKeyChecking/);
  assert.doesNotMatch(pullPs1, /C:\\Users\\imdot\\gaeru/);

  const restorePs1 = fs.readFileSync(path.join(root, 'scripts', 'failover-restore-to-pc.ps1'), 'utf8');
  assert.match(restorePs1, /Assert-SafeTarArchive/);
  assert.match(restorePs1, /-v ON_ERROR_STOP=1 -tA/);
  assert.doesNotMatch(restorePs1, /C:\\Users\\imdot\\gaeru/);

  const gdriveSh = fs.readFileSync(path.join(root, 'scripts', 'mi6-backup', 'gaeru-gdrive-sync.sh'), 'utf8');
  assert.match(gdriveSh, /prune_remote_subdir "pg"/);
  assert.match(gdriveSh, /prune_remote_subdir "mail"/);
  assert.match(gdriveSh, /prune_remote_subdir "media"/);

  const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'neon_workflow.yml'), 'utf8');
  assert.doesNotMatch(wf, /tj-actions\//);
  assert.match(wf, /permissions:\s*\{\}/);
  assert.match(wf, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  const usesLines = [...wf.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]);
  assert.ok(usesLines.length >= 2);
  for (const ref of usesLines) {
    assert.match(ref, /@[0-9a-f]{40}$/, `Action must be commit-SHA pinned: ${ref}`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies && pkg.dependencies.ws, 'ws must be declared in package.json dependencies');
});

test('batch 1 critical fixes: gaeru-full-restore.sh stdout isolation & standalone test script DB safety', async (t) => {
  const root = path.resolve(__dirname, '..');

  // 1. gaeru-full-restore.sh static + Git Bash / POSIX execution checks
  const restoreShPath = path.join(root, 'scripts', 'mi6-backup', 'gaeru-full-restore.sh');
  const restoreSh = fs.readFileSync(restoreShPath, 'utf8');
  assert.equal(restoreSh.includes('\r\n'), false, 'gaeru-full-restore.sh must preserve LF line endings');
  assert.match(restoreSh, /sha256sum -c "\$\{base\}\.sha256" >&2/);
  assert.match(restoreSh, /set \+o pipefail/);
  assert.match(restoreSh, /gpg --batch --yes --no-tty --decrypt --output "\$tmp_out" "\$input" >&2/);

  const bashCandidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']
    : ['/bin/bash', '/usr/bin/bash', 'bash'];
  const bashBin = bashCandidates.find((candidate) => candidate === 'bash' || fs.existsSync(candidate));
  assert.ok(bashBin, 'bash executable required to verify gaeru-full-restore.sh');

  const posixRestoreShPath = restoreShPath.replace(/\\/g, '/');
  execFileSync(bashBin, ['-n', posixRestoreShPath], { encoding: 'utf8' });

  const bashScript = [
    'set -euo pipefail',
    'TMPDIR_TEST=$(mktemp -d)',
    'cleanup() { rm -rf "$TMPDIR_TEST"; }',
    'trap cleanup EXIT',
    `FUNCS=$(sed '/^case /,$d' '${posixRestoreShPath}')`,
    'eval "$FUNCS"',
    'printf \'backup-payload\' > "$TMPDIR_TEST/sample.dump"',
    '(cd "$TMPDIR_TEST" && sha256sum sample.dump > sample.dump.sha256)',
    'OUT1=$(prepare_restore_input "$TMPDIR_TEST/sample.dump" "$TMPDIR_TEST/out1.tmp")',
    '[ "$OUT1" = "$TMPDIR_TEST/sample.dump" ]',
    'printf \'plain-payload\' > "$TMPDIR_TEST/plain.dump"',
    'OUT2=$(prepare_restore_input "$TMPDIR_TEST/plain.dump" "$TMPDIR_TEST/out2.tmp")',
    '[ "$OUT2" = "$TMPDIR_TEST/plain.dump" ]',
    'printf \'tampered\' > "$TMPDIR_TEST/bad.dump"',
    'printf \'0000000000000000000000000000000000000000000000000000000000000000  bad.dump\\n\' > "$TMPDIR_TEST/bad.dump.sha256"',
    'if (prepare_restore_input "$TMPDIR_TEST/bad.dump" "$TMPDIR_TEST/out3.tmp") >/dev/null 2>&1; then exit 1; fi',
    'printf \'cipher\' > "$TMPDIR_TEST/test.dump.gpg"',
    'if (prepare_restore_input "$TMPDIR_TEST/test.dump.gpg" "$TMPDIR_TEST/out4.tmp") >/dev/null 2>&1; then exit 1; fi',
    'mkdir -p "$TMPDIR_TEST/bin"',
    'cat > "$TMPDIR_TEST/bin/gpg" <<\'EOGPG\'',
    '#!/bin/bash',
    'out=""',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    --output) out="$2"; shift 2 ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    'echo "gpg noisy stdout chatter"',
    'printf \'decrypted-db-bytes\' > "$out"',
    'EOGPG',
    'chmod +x "$TMPDIR_TEST/bin/gpg"',
    'PATH="$TMPDIR_TEST/bin:$PATH"',
    '(cd "$TMPDIR_TEST" && sha256sum test.dump.gpg > test.dump.gpg.sha256)',
    'OUT5=$(prepare_restore_input "$TMPDIR_TEST/test.dump.gpg" "$TMPDIR_TEST/out5.tmp")',
    '[ "$OUT5" = "$TMPDIR_TEST/out5.tmp" ]',
    '[ "$(cat "$OUT5")" = "decrypted-db-bytes" ]',
    'printf "BASH_OK:%s:%s" "$OUT1" "$OUT5"',
  ].join('\n');
  const bashResult = execFileSync(bashBin, ['-s'], { input: bashScript, encoding: 'utf8' });
  assert.match(bashResult, /BASH_OK:.*\/sample\.dump:.*\/out5\.tmp$/);
  assert.doesNotMatch(bashResult, /: OK/);

  // 2. test-mi6-standalone.js source invariants
  const standaloneSrc = fs.readFileSync(path.join(root, 'scripts', 'test-mi6-standalone.js'), 'utf8');
  assert.doesNotMatch(standaloneSrc, /stock_quantity\s*=\s*501/);
  assert.match(standaloneSrc, /SET LOCAL gaeru\.allow_owner_order_purge = 'on'/);
  assert.match(standaloneSrc, /FROM order_stock_allocations[\s\S]*released_at IS NULL/);
  assert.match(standaloneSrc, /SUM\(ws\.quantity\)/);
  assert.doesNotMatch(standaloneSrc, /DELETE FROM inventory_movements/);
  assert.doesNotMatch(standaloneSrc, /DELETE FROM audit_events/);
  assert.doesNotMatch(standaloneSrc, /audit_logs/);

  // 3. verify-order-complete-ui.js isolation & cleanup trigger test
  const verifyUiSrc = fs.readFileSync(path.join(root, 'scripts', 'verify-order-complete-ui.js'), 'utf8');
  assert.match(verifyUiSrc, /GAERU_UI_TEST_LIVE_DB === '1'/);
  assert.match(verifyUiSrc, /createIsolatedPglitePool/);
  assert.match(verifyUiSrc, /SET LOCAL gaeru\.allow_owner_order_purge = 'on'/);
  assert.match(verifyUiSrc, /finally[\s\S]*cleanupTestOrder\(pool,\s*TEST_ORDER_ID\)/);
  assert.doesNotMatch(verifyUiSrc, /audit_logs/);

  const { cleanupTestOrder } = require('../scripts/verify-order-complete-ui');
  const pool = await createPglitePool();
  t.after(() => pool.end());
  await migrateDatabase(pool);

  const prodId = '99999999-8888-7777-6666-111111111111';
  const varId = '99999999-8888-7777-6666-222222222222';
  const orderId = '99999999-8888-7777-6666-555555555555';
  const custId = '99999999-8888-7777-6666-666666666666';

  await pool.query(
    `INSERT INTO products (id, slug, name, category, descriptor, description, image_url, image_alt, active, sort_order)
     VALUES ($1, 'cleanup-test-prod', 'Cleanup Test', 'audio', 'D', 'D', '/assets/products/k9.webp', 'Alt', true, 1)`,
    [prodId]
  );
  await pool.query(
    `INSERT INTO product_variants (id, product_id, sku, name, options, price_vnd, stock_quantity, active)
     VALUES ($1, $2, 'CLN-TEST-1', 'Std', '{}'::jsonb, 500000, 10, true)`,
    [varId, prodId]
  );
  await pool.query(
    `INSERT INTO customers (id, full_name, email, phone, password_hash)
     VALUES ($1, 'Cleanup Cust', 'cleanup-test@example.test', '0909998888', 'hash')`,
    [custId]
  );
  await pool.query(
    `INSERT INTO orders (id, order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd)
     VALUES ($1, 'GAERU-TEST-CLEANUP', $2, 'Cleanup Cust', 'cleanup-test@example.test', '0909998888', '123 Test', 'HCM', 'cod', 'paid', 'completed', 500000, 0, 500000)`,
    [orderId, custId]
  );
  const itemRow = (await pool.query(
    `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
     VALUES ($1, $2, 'Cleanup Test', 'Std', 'CLN-TEST-1', 1, 500000, 500000) RETURNING id`,
    [orderId, varId]
  )).rows[0];
  await pool.query(
    `INSERT INTO sales_receipts (order_id, amount_vnd, method, reference, note, request_key, request_hash, created_by)
     VALUES ($1, 500000, 'cash', 'REF-CLN', 'Test', 'req-cln-1', 'hash-cln-1', 'test-owner')`,
    [orderId]
  );
  await pool.query(
    `INSERT INTO warranty_activations (customer_id, order_item_id, status, request_key)
     VALUES ($1, $2, 'active', '11111111-1111-4111-8111-111111111111')`,
    [custId, itemRow.id]
  );

  // Trigger protect_sales_receipt must block unprivileged DELETE outside allow_owner_order_purge
  await assert.rejects(
    pool.query('DELETE FROM sales_receipts WHERE order_id = $1', [orderId]),
    /Sales receipts are append-only/
  );

  await cleanupTestOrder(pool, orderId);

  assert.equal((await pool.query('SELECT count(*)::int AS c FROM orders WHERE id = $1', [orderId])).rows[0].c, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS c FROM order_items WHERE order_id = $1', [orderId])).rows[0].c, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS c FROM sales_receipts WHERE order_id = $1', [orderId])).rows[0].c, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS c FROM warranty_activations WHERE order_item_id = $1', [itemRow.id])).rows[0].c, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS c FROM order_admin_email_outbox WHERE order_id = $1', [orderId])).rows[0].c, 0);
});

test('batch 2 high-severity fixes: [H-01] through [H-09]', async (t) => {
  const root = path.join(__dirname, '..');

  // [H-01] Cross-email Google linking blocked, inactive blocked, matching email succeeds
  await t.test('[H-01] customer-oauth blocks cross-email linking and inactive account', async () => {
    const { createCustomerOAuthRouter } = require('../src/customer-oauth');
    const { signTestGoogleIdToken, createTestGoogleOAuthClient } = require('./helpers/google-id-token');
    const pool = await createPglitePool();
    t.after(() => pool.end());
    await migrateDatabase(pool);

    const cust = (await pool.query(
      `INSERT INTO customers (full_name, email, phone, password_hash, email_verified_at, active)
       VALUES ('Victim User', 'victim@example.test', '0901112223', 'hash', NULL, true)
       RETURNING id, email`
    )).rows[0];

    const googleClientId = 'h01-client-id.apps.googleusercontent.com';
    const oauthClient = createTestGoogleOAuthClient();
    const router = createCustomerOAuthRouter(pool, { config: { GOOGLE_CLIENT_ID: googleClientId, GOOGLE_LOGIN_ENABLED: true }, oauthClient });

    const callLink = async (payload) => {
      const token = signTestGoogleIdToken({
        iss: 'accounts.google.com',
        aud: googleClientId,
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...payload
      });
      const req = {
        session: { customer: { id: cust.id, email: cust.email } },
        body: { credential: token }
      };
      let statusCode = 200;
      let body = null;
      let nextErr = null;
      const res = {
        status(code) { statusCode = code; return this; },
        json(data) { body = data; return this; }
      };
      await router.handleLinkGoogle(req, res, (err) => { nextErr = err; });
      if (nextErr) throw nextErr;
      return { statusCode, body };
    };

    const crossEmail = await callLink({ sub: 'sub-attacker-1', email: 'attacker@gmail.com', email_verified: true });
    assert.equal(crossEmail.statusCode, 403);
    assert.match(crossEmail.body.error, /trùng với email|cùng địa chỉ email/);

    const afterCross = (await pool.query('SELECT email_verified_at FROM customers WHERE id = $1', [cust.id])).rows[0];
    assert.equal(afterCross.email_verified_at, null);
    assert.equal((await pool.query('SELECT count(*)::int AS c FROM auth_identities WHERE customer_id = $1', [cust.id])).rows[0].c, 0);

    await pool.query('UPDATE customers SET active = false WHERE id = $1', [cust.id]);
    const inactiveRes = await callLink({ sub: 'sub-victim-1', email: 'victim@example.test', email_verified: true });
    assert.equal(inactiveRes.statusCode, 403);
    assert.match(inactiveRes.body.error, /bị khóa/);

    await pool.query('UPDATE customers SET active = true WHERE id = $1', [cust.id]);
    const okRes = await callLink({ sub: 'sub-victim-1', email: 'victim@example.test', email_verified: true });
    assert.equal(okRes.statusCode, 200);
    assert.equal(okRes.body.success, true);
    const verified = (await pool.query('SELECT email_verified_at, google_id FROM customers WHERE id = $1', [cust.id])).rows[0];
    assert.ok(verified.email_verified_at);
    assert.equal(verified.google_id, 'sub-victim-1');
  });

  // [H-02] node-app.conf removes sourcing app.env as root and validates APP/env lines safely
  await t.test('[H-02] node-app.conf safely parses app.env without dot-sourcing', () => {
    const confPath = path.join(root, 'scripts', 'node-app.conf');
    const confSrc = fs.readFileSync(confPath, 'utf8');
    assert.equal(confSrc.includes('\r\n'), false, 'node-app.conf must use LF line endings');
    assert.doesNotMatch(confSrc, /^\s*\.\s+.*app\.env/m);
    assert.match(confSrc, /case "\$APP" in/);
    assert.match(confSrc, /tr -d '\\r'/);
    assert.match(confSrc, /ENV_\[A-Za-z_\]\[A-Za-z0-9_\]\*=\*\)/);

    const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find((p) => fs.existsSync(p));
    if (gitBash) {
      const scriptMatch = confSrc.match(/\nscript\n([\s\S]*?)\nend script/);
      assert.ok(scriptMatch, 'node-app.conf should contain script block');
      const tmpSh = path.join(os.tmpdir(), `gaeru-node-app-${Date.now()}.sh`);
      fs.writeFileSync(tmpSh, scriptMatch[1] + '\n', { encoding: 'utf8' });
      try {
        execFileSync(gitBash, ['-n', tmpSh], { encoding: 'utf8' });
      } finally {
        fs.rmSync(tmpSh, { force: true });
      }
    }
  });

  // [H-03] & [H-04] COD delivery earns loyalty points; COD return intake releases vouchers & fails pending payment_attempts
  await t.test('[H-03][H-04] COD delivery earns loyalty and COD return intake releases voucher & fails payment attempts', async () => {
    const { applyCarrierDeliveryTransition } = require('../src/shipping-management');
    const { createCodReturnIntake } = require('../src/cod-return-intake');
    const express = require('express');

    const pool = await createPglitePool();
    t.after(() => pool.end());
    await migrateDatabase(pool);

    const whId = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN'")).rows[0].id;
    const custId = (await pool.query(
      `INSERT INTO customers (full_name, email, phone, password_hash)
       VALUES ('COD Loyalty Cust', 'cod-loyalty@example.test', '0902223334', 'hash') RETURNING id`
    )).rows[0].id;
    const prodId = (await pool.query(
      `INSERT INTO products (name, slug, category, active) VALUES ('H03 Mic', 'h03-mic', 'audio', true) RETURNING id`
    )).rows[0].id;
    const varId = (await pool.query(
      `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
       VALUES ($1, 'H03-SKU', 'Black', 500000, 10, true) RETURNING id`, [prodId]
    )).rows[0].id;
    await pool.query('INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 10)', [whId, varId]);

    // [H-03] Delivered COD order awards loyalty points
    const codDeliveredOrderId = (await pool.query(
      `INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd)
       VALUES ('GA-H03-1', $1, 'COD Loyalty Cust', 'cod-loyalty@example.test', '0902223334', '123 Le Loi', 'HCM', 'cod', 'pending', 'shipped', 500000, 0, 500000) RETURNING id`,
      [custId]
    )).rows[0].id;
    const client = await pool.connect();
    try {
      const nextStatus = await applyCarrierDeliveryTransition(client, {
        order_id: codDeliveredOrderId,
        orderNumber: 'GA-H03-1',
        orderStatus: 'shipped',
        orderPaymentMethod: 'cod',
        orderPaymentStatus: 'pending',
        orderTotalVnd: 500000,
        orderCustomerId: custId
      }, 'delivered', { username: 'worker' });
      assert.equal(nextStatus, 'completed');
    } finally {
      client.release();
    }
    const loyalty = (await pool.query('SELECT points_balance FROM customer_loyalty WHERE customer_id = $1', [custId])).rows[0];
    assert.ok(loyalty && loyalty.points_balance > 0, 'COD delivered order must earn loyalty points');

    // [H-04] Return intake releases voucher_redemptions & marks pending payment_attempts as failed
    const voucherId = (await pool.query(
      `INSERT INTO marketing_vouchers (code, title, kind, amount, min_spend_vnd, starts_at, ends_at, total_limit, per_customer_limit, active)
       VALUES ('RETH04', 'Return Voucher', 'fixed', 20000, 0, now() - interval '1 day', now() + interval '7 days', 100, 5, true) RETURNING id`
    )).rows[0].id;
    const codRetOrderId = (await pool.query(
      `INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, discount_vnd, voucher_code, shipping_fee_vnd, total_vnd)
       VALUES ('GA-H04-1', $1, 'COD Return Cust', 'cod-loyalty@example.test', '0902223334', '123 Le Loi', 'HCM', 'cod', 'pending', 'shipped', 500000, 20000, 'RETH04', 0, 480000) RETURNING id`,
      [custId]
    )).rows[0].id;
    await pool.query(
      `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
       VALUES ($1, $2, 'H03 Mic', 'Black', 'H03-SKU', 1, 500000, 500000)`,
      [codRetOrderId, varId]
    );
    await pool.query('INSERT INTO order_stock_allocations (order_id, variant_id, warehouse_id, quantity) VALUES ($1, $2, $3, 1)', [codRetOrderId, varId, whId]);
    await pool.query('UPDATE product_variants SET stock_quantity = 9 WHERE id = $1', [varId]);
    await pool.query('UPDATE warehouse_stock SET quantity = 9 WHERE warehouse_id = $1 AND variant_id = $2', [whId, varId]);
    await pool.query(
      `INSERT INTO voucher_redemptions (voucher_id, order_id, customer_id, discount_vnd, released)
       VALUES ($1, $2, $3, 20000, false)`,
      [voucherId, codRetOrderId, custId]
    );
    await pool.query(
      `INSERT INTO payment_attempts (order_id, provider, transaction_ref, amount_vnd, status, expires_at)
       VALUES ($1, 'vnpay', 'h04-attempt-1', 480000, 'pending', now() + interval '1 hour')`,
      [codRetOrderId]
    );
    await pool.query(
      `INSERT INTO carrier_shipments (order_id, carrier_id, tracking_number, status, cod_amount_vnd)
       VALUES ($1, 'viettel', 'VT-H04-RET', 'returned', 480000)`,
      [codRetOrderId]
    );

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = { csrfToken: 'csrf-h04' };
      req.admin = { username: 'wh_staff', permissions: ['orders.read', 'orders.write', 'inventory.read', 'inventory.write'] };
      next();
    });
    app.use('/api/gaeru_ceo', createCodReturnIntake(pool));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    t.after(() => new Promise((r) => server.close(r)));
    const resp = await fetch(`http://127.0.0.1:${server.address().port}/api/gaeru_ceo/cod-returns/intake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'csrf-h04' },
      body: JSON.stringify({ trackingNumber: 'VT-H04-RET', packageCondition: 'intact', warehouseId: whId })
    });
    assert.equal(resp.status, 200);
    const ordAfter = (await pool.query('SELECT status FROM orders WHERE id = $1', [codRetOrderId])).rows[0];
    assert.equal(ordAfter.status, 'cancelled');
    const vr = (await pool.query('SELECT released FROM voucher_redemptions WHERE order_id = $1', [codRetOrderId])).rows[0];
    const pa = (await pool.query('SELECT status FROM payment_attempts WHERE order_id = $1', [codRetOrderId])).rows[0];
    assert.equal(vr.released, true);
    assert.equal(pa.status, 'failed');
  });

  // [H-05] Barcode API: MAX_STOCK, balance verification, requestKey idempotency, and pending dispatch rules
  await t.test('[H-05] barcode-api enforces MAX_STOCK, balance check, requestKey idempotency, and pending dispatch guards', async () => {
    const { receiveByBarcode, countByBarcode, resolveBarcode, verifyPackItem, dispatchByBarcode } = require('../src/barcode-api');
    const pool = await createPglitePool();
    t.after(() => pool.end());
    await migrateDatabase(pool);

    const whId = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN'")).rows[0].id;
    const prodId = (await pool.query("INSERT INTO products (name, slug, category, active) VALUES ('H05 Prod', 'h05-prod', 'audio', true) RETURNING id")).rows[0].id;
    const varId = (await pool.query("INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, 'H05-SKU', 'Std', 100000, 10, true) RETURNING id", [prodId])).rows[0].id;
    await pool.query('INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 10)', [whId, varId]);

    await assert.rejects(() => receiveByBarcode(pool, { code: 'H05-SKU', warehouseId: whId, quantity: 1_000_000_001 }), /vượt giới hạn an toàn/);
    await assert.rejects(() => countByBarcode(pool, { code: 'H05-SKU', warehouseId: whId, actualQuantity: 1_000_000_001 }), /vượt giới hạn an toàn/);

    const r1 = await receiveByBarcode(pool, { code: 'H05-SKU', warehouseId: whId, quantity: 5, requestKey: 'h05-rk-1', actor: { username: 'wh' } });
    const r2 = await receiveByBarcode(pool, { code: 'H05-SKU', warehouseId: whId, quantity: 5, requestKey: 'h05-rk-1', actor: { username: 'wh' } });
    assert.equal(r1.aggregateQuantity, 15);
    assert.equal(r2.aggregateQuantity, 15);
    await assert.rejects(() => receiveByBarcode(pool, { code: 'H05-SKU', warehouseId: whId, quantity: 6, requestKey: 'h05-rk-1' }), /Khóa yêu cầu kho/);

    // Desync aggregate stock_quantity vs warehouse_stock -> blocked with 409
    await pool.query('UPDATE product_variants SET stock_quantity = 999 WHERE id = $1', [varId]);
    await assert.rejects(() => receiveByBarcode(pool, { code: 'H05-SKU', warehouseId: whId, quantity: 1 }), /đối soát/);
    await assert.rejects(() => countByBarcode(pool, { code: 'H05-SKU', warehouseId: whId, actualQuantity: 12 }), /đối soát/);
    await pool.query('UPDATE product_variants SET stock_quantity = 15 WHERE id = $1', [varId]);

    // Pending order without shipping_fee_vnd/total_vnd rejected at dispatch
    const pendingOrdId = (await pool.query(
      `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd)
       VALUES ('GA-H05-PEND', 'Pending Cust', 'p@example.test', '0903334445', '123', 'HCM', 'cod', 'pending', 'pending', 200000, NULL, NULL) RETURNING id`
    )).rows[0].id;
    await pool.query(
      `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
       VALUES ($1, $2, 'H05 Prod', 'Std', 'H05-SKU', 2, 100000, 200000)`,
      [pendingOrdId, varId]
    );
    await resolveBarcode(pool, 'GA-H05-PEND', { ensureVerification: true, logScan: false });
    await verifyPackItem(pool, { orderId: pendingOrdId, scannedCode: 'H05-SKU' });
    await verifyPackItem(pool, { orderId: pendingOrdId, scannedCode: 'H05-SKU' });

    await assert.rejects(() => dispatchByBarcode(pool, { orderId: pendingOrdId }), /chưa chốt phí giao hàng/);

    await pool.query('UPDATE orders SET shipping_fee_vnd = 0, total_vnd = 200000 WHERE id = $1', [pendingOrdId]);
    const dispRes = await dispatchByBarcode(pool, { orderId: pendingOrdId, actor: { username: 'wh' } });
    assert.equal(dispRes.ok, true);
    const alloc = (await pool.query('SELECT quantity FROM order_stock_allocations WHERE order_id = $1', [pendingOrdId])).rows[0];
    assert.equal(alloc.quantity, 2);
    assert.equal((await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [varId])).rows[0].stock_quantity, 13);
  });

  // [H-06] Internal AI grounding tools enforce per-tool RBAC read permissions
  await t.test('[H-06] internal-ai grounding tools enforce RBAC permissions per tool', async () => {
    const express = require('express');
    const { createInternalAiRouter } = require('../src/internal-ai');
    const pool = await createPglitePool();
    t.after(() => pool.end());
    await migrateDatabase(pool);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.admin = { id: 'staff-h06', username: 'viewer_only', role: 'viewer', isOwner: false, permissions: ['dashboard.read'] };
      next();
    });
    app.use('/api/ai', createInternalAiRouter(pool, {}));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    t.after(() => new Promise((r) => server.close(r)));
    const base = `http://127.0.0.1:${server.address().port}/api/ai`;

    const th = await (await fetch(`${base}/threads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    const checks = [
      { q: 'Tra cứu đơn hàng đang chờ xử lý', tool: 'query_orders' },
      { q: 'Kiểm tra tồn kho sản phẩm sắp hết hàng', tool: 'check_inventory' },
      { q: 'Tra cứu vận đơn giao hàng bưu cục', tool: 'query_shipping' },
      { q: 'Xem danh sách voucher khuyến mãi hiện tại', tool: 'get_marketing_overview' },
      { q: 'Báo cáo tình hình CSKH và bảo hành', tool: 'get_customer_care' }
    ];
    for (const c of checks) {
      const resp = await fetch(`${base}/threads/${th.thread.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: c.q })
      });
      assert.equal(resp.status, 200);
      const data = await resp.json();
      const entry = data.toolResults.find((t) => t.tool === c.tool);
      assert.ok(entry?.data?.error, `Expected RBAC error for tool ${c.tool}`);
      assert.match(data.answer, /không có quyền/);
    }
  });

  // [H-07] Chat compression routes detached from uploadGate & single-flight/threadId isolated
  await t.test('[H-07] shopping-chat compression routes bypass uploadGate, filter threadId, and guard concurrency', async () => {
    const extrasSrc = fs.readFileSync(path.join(root, 'src', 'shopping-chat-extras.js'), 'utf8');
    assert.match(extrasSrc, /publicApi\.post\('\/threads\/:id\/files\/compress',chatCsrf,limit,authorize\(false\),compressRoute\)/);
    assert.match(extrasSrc, /admin\.post\('\/shopping-chat\/:id\/files\/compress',requirePermission\('customers\.write'\),chatCsrf,limit,authorize\(true\),compressRoute\)/);

    const tmpMedia = fs.mkdtempSync(path.join(os.tmpdir(), 'gaeru-h07-'));
    const oldMediaRoot = process.env.MEDIA_ROOT;
    process.env.MEDIA_ROOT = tmpMedia;
    t.after(() => {
      if (oldMediaRoot === undefined) delete process.env.MEDIA_ROOT;
      else process.env.MEDIA_ROOT = oldMediaRoot;
      fs.rmSync(tmpMedia, { recursive: true, force: true });
    });

    const pool = await createPglitePool();
    t.after(() => pool.end());
    await migrateDatabase(pool);
    const { storeUpload } = require('../src/lib/stored-media');
    const { triggerManualChatCompression, processOneChatCompression } = require('../src/shopping-chat-compression');

    const tA = (await pool.query("INSERT INTO shopping_chat_threads(owner_key,product_name,request_key) VALUES('h07-a','A','33333333-3333-4333-8333-333333333331') RETURNING id")).rows[0].id;
    const tB = (await pool.query("INSERT INTO shopping_chat_threads(owner_key,product_name,request_key) VALUES('h07-b','B','33333333-3333-4333-8333-333333333332') RETURNING id")).rows[0].id;
    const buf = Buffer.from('GAERU chat compression fixture text '.repeat(40));
    const storedA = await storeUpload('chat', buf, 'text/plain');
    const storedB = await storeUpload('chat', buf, 'text/plain');
    const mA = (await pool.query("INSERT INTO shopping_chat_messages(thread_id,sender,body,request_key) VALUES($1,'customer','A','44444444-4444-4444-8444-444444444441') RETURNING id", [tA])).rows[0].id;
    const mB = (await pool.query("INSERT INTO shopping_chat_messages(thread_id,sender,body,request_key) VALUES($1,'customer','B','44444444-4444-4444-8444-444444444442') RETURNING id", [tB])).rows[0].id;
    const fA = (await pool.query("INSERT INTO shopping_chat_files(thread_id,message_id,name,mime,content,byte_size,compression_status) VALUES($1,$2,'a.txt','text/plain',$3,$4,'pending') RETURNING id", [tA, mA, storedA.content, buf.length])).rows[0].id;
    const fB = (await pool.query("INSERT INTO shopping_chat_files(thread_id,message_id,name,mime,content,byte_size,compression_status) VALUES($1,$2,'b.txt','text/plain',$3,$4,'pending') RETURNING id", [tB, mB, storedB.content, buf.length])).rows[0].id;

    // Thread filter: compressing tA leaves tB untouched
    const man = await triggerManualChatCompression(pool, { threadId: tA, limit: 2 });
    assert.equal(man.processed, true);
    assert.equal((await pool.query('SELECT compression_status FROM shopping_chat_files WHERE id = $1', [fA])).rows[0].compression_status, 'compressed');
    assert.equal((await pool.query('SELECT compression_status FROM shopping_chat_files WHERE id = $1', [fB])).rows[0].compression_status, 'pending');

    // Single-flight guard: slow compression causes concurrent manual trigger to return { processed: false, busy: true }
    let releaseRead;
    let entered = false;
    const slowMedia = {
      async readMedia() {
        entered = true;
        await new Promise((r) => { releaseRead = r; });
        return buf;
      }
    };
    const p1 = triggerManualChatCompression(pool, { threadId: tB, limit: 1 });
    // Even if fast, direct test with processOneChatCompression vs concurrent trigger: reset fB to pending and verify concurrent lock via triggerManualChatCompression + delayed timer isn't flaky
    await p1;
    assert.equal(entered, false);
    assert.equal((await pool.query('SELECT compression_status FROM shopping_chat_files WHERE id = $1', [fB])).rows[0].compression_status, 'compressed');
    await pool.query("UPDATE shopping_chat_files SET compression_status = 'pending', compression_attempts = 0 WHERE id = $1", [fB]);
    // Mock slow read inside processOneChatCompression or stored-media
    const storedMedia = require('../src/lib/stored-media');
    const origRead = storedMedia.readMedia;
    let markStarted;
    const startedPromise = new Promise((r) => { markStarted = r; });
    storedMedia.readMedia = async () => { markStarted(); return await slowMedia.readMedia(); };
    try {
      const firstRun = triggerManualChatCompression(pool, { threadId: tB, limit: 1 });
      await startedPromise;
      const busyRun = await triggerManualChatCompression(pool, { threadId: tB, limit: 1 });
      assert.deepEqual(busyRun, { processed: false, busy: true });
      releaseRead();
      await firstRun;
    } finally {
      storedMedia.readMedia = origRead;
    }
    void processOneChatCompression;
  });

  // [H-08] operationalHealth awaits rootPath() before fs.access()
  await t.test('[H-08] operationalHealth awaits filesystem-media.rootPath()', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gaeru-h08-'));
    const oldMediaRoot = process.env.MEDIA_ROOT;
    process.env.MEDIA_ROOT = tmpRoot;
    t.after(() => {
      if (oldMediaRoot === undefined) delete process.env.MEDIA_ROOT;
      else process.env.MEDIA_ROOT = oldMediaRoot;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    const pool = await createPglitePool();
    t.after(() => pool.end());
    await migrateDatabase(pool);
    const { operationalHealth } = require('../src/operational-health');
    const health = await operationalHealth(pool, {});
    assert.equal(health.storage.configured, true);
    assert.equal(health.storage.status, 'accessible');
  });

  // [H-09] protect-and-hide-web-folders.ps1 uses non-destructive ACL inspection and parses cleanly
  await t.test('[H-09] protect-and-hide-web-folders.ps1 checks ACL non-destructively', () => {
    const ps1Path = path.join(root, 'scripts', 'protect-and-hide-web-folders.ps1');
    const ps1Src = fs.readFileSync(ps1Path, 'utf8');
    assert.doesNotMatch(ps1Src, /\[System\.IO\.Directory\]::Delete/);
    assert.match(ps1Src, /Get-Acl -LiteralPath \$dir/);

    const astOut = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${ps1Path.replace(/'/g, "''")}',[ref]$tokens,[ref]$errors);if($errors.Count -gt 0){throw ($errors[0].Message)};Write-Output 'AST_OK'`
      ],
      { encoding: 'utf8' }
    );
    assert.match(astOut, /AST_OK/);
  });
});

test('batch 3 medium-severity fixes: [M-01] through [M-09]', async (t) => {
  const repoRoot = path.resolve(__dirname, '..');

  // Helper to boot an isolated app+PGlite instance when HTTP endpoints are exercised
  async function bootTestApp(extraConfig = {}, oauthClient = null) {
    const pool = await createPglitePool();
    t.after(() => pool.end());
    await migrateDatabase(pool);
    const app = createApp({
      config: {
        NODE_ENV: 'test',
        PORT: 0,
        PUBLIC_BASE_URL: 'https://gaeru.com',
        SESSION_SECRET: randomBytes(48).toString('hex'),
        ADMIN_USERNAME: 'batch3-owner',
        ADMIN_PASSWORD_HASH: bcrypt.hashSync('Batch3-Owner-Pass-2026!', 4),
        STORE_ORDERS_ENABLED: true,
        ...extraConfig,
      },
      pool,
      sessionStore: new session.MemoryStore(),
      oauthClient,
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    t.after(async () => {
      await new Promise((r) => server.close(r));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return { pool, baseUrl };
  }

  // [M-01] Customer lock/unlock state & session/challenge invalidation
  await t.test('[M-01] customer unlock clears lock fields & lock/junk invalidates challenges + account_security version', async () => {
    const { pool, baseUrl } = await bootTestApp();
    const owner = makeClient(baseUrl);
    await owner.ok('/api/csrf');
    await owner.ok('/api/auth/login', {
      method: 'POST',
      body: { username: 'batch3-owner', password: 'Batch3-Owner-Pass-2026!' },
    });

    const custId = (await pool.query(
      `INSERT INTO customers(full_name, email, phone, password_hash, active, lock_reason, locked_at, phone_invalid_at, reg_email_failed_at)
       VALUES('Locked User', 'm01-locked@example.test', '0901000001', $1, false, 'phone_invalid_expired', now(), now() - interval '10 days', now())
       RETURNING id`,
      [bcrypt.hashSync('Pass123!', 4)]
    )).rows[0].id;
    const secKey = `customer:${custId}`;
    await pool.query('INSERT INTO account_security(account_key, version) VALUES($1, 1)', [secKey]);
    await pool.query(
      "INSERT INTO security_challenges(account_key, purpose, fingerprint, expires_at) VALUES($1, 'reset', 'm01-fp-1', now() + interval '1 hour')",
      [secKey]
    );

    // Unlock via admin PATCH clears lock fields and bumps security version + expires open challenge
    await owner.ok(`/api/gaeru_ceo/customers/${custId}`, {
      method: 'PATCH',
      body: { active: true },
    });
    const afterUnlock = (await pool.query(
      'SELECT active, lock_reason, locked_at, phone_invalid_at, reg_email_failed_at FROM customers WHERE id = $1',
      [custId]
    )).rows[0];
    assert.equal(afterUnlock.active, true);
    assert.equal(afterUnlock.lock_reason, null);
    assert.equal(afterUnlock.locked_at, null);
    assert.equal(afterUnlock.phone_invalid_at, null);
    assert.equal(afterUnlock.reg_email_failed_at, null);
    assert.equal((await pool.query('SELECT version FROM account_security WHERE account_key = $1', [secKey])).rows[0].version, 2);
    assert.ok((await pool.query("SELECT used_at FROM security_challenges WHERE fingerprint = 'm01-fp-1'")).rows[0].used_at);

    // Re-lock via admin PATCH sets admin_locked, locked_at, and bumps security version again
    await pool.query(
      "INSERT INTO security_challenges(account_key, purpose, fingerprint, expires_at) VALUES($1, 'reset', 'm01-fp-2', now() + interval '1 hour')",
      [secKey]
    );
    await owner.ok(`/api/gaeru_ceo/customers/${custId}`, {
      method: 'PATCH',
      body: { active: false },
    });
    const afterLock = (await pool.query('SELECT active, lock_reason, locked_at FROM customers WHERE id = $1', [custId])).rows[0];
    assert.equal(afterLock.active, false);
    assert.equal(afterLock.lock_reason, 'admin_locked');
    assert.ok(afterLock.locked_at);
    assert.equal((await pool.query('SELECT version FROM account_security WHERE account_key = $1', [secKey])).rows[0].version, 3);
    assert.ok((await pool.query("SELECT used_at FROM security_challenges WHERE fingerprint = 'm01-fp-2'")).rows[0].used_at);

    // lockExpiredJunkAccounts locks expired junk accounts and invalidates challenges + account_security
    const junkId = (await pool.query(
      `INSERT INTO customers(full_name, email, phone, password_hash, active, email_verified_at, reg_email_failed_at, created_at)
       VALUES('Junk User', 'm01-junk@example.test', '0901000002', $1, true, NULL, now() - interval '15 hours', now() - interval '10 days')
       RETURNING id`,
      [bcrypt.hashSync('Pass123!', 4)]
    )).rows[0].id;
    await pool.query('INSERT INTO account_security(account_key, version) VALUES($1, 1)', [`customer:${junkId}`]);
    await pool.query(
      "INSERT INTO security_challenges(account_key, purpose, fingerprint, expires_at) VALUES($1, 'verify', 'm01-fp-junk', now() + interval '1 hour')",
      [`customer:${junkId}`]
    );
    const { lockExpiredJunkAccounts } = require('../src/account-retention');
    await lockExpiredJunkAccounts(pool);
    assert.equal((await pool.query('SELECT active FROM customers WHERE id = $1', [junkId])).rows[0].active, false);
    assert.equal((await pool.query('SELECT version FROM account_security WHERE account_key = $1', [`customer:${junkId}`])).rows[0].version, 2);
    assert.ok((await pool.query("SELECT used_at FROM security_challenges WHERE fingerprint = 'm01-fp-junk'")).rows[0].used_at);
  });

  // [M-02] Mail permissions, HMAC internal secret, owner step-up, & WebPush SSRF/role filtering
  await t.test('[M-02] mail RBAC, owner step-up, HMAC secret derivation, and WebPush endpoint/role guard', async () => {
    const { pool, baseUrl } = await bootTestApp();
    const deptId = (await pool.query("INSERT INTO departments(code, name) VALUES('M02D', 'Batch3 Dept') RETURNING id")).rows[0].id;
    const staffPass = bcrypt.hashSync('StaffPass-2026!', 4);
    await pool.query(
      `INSERT INTO staff_accounts(username, full_name, password_hash, role, department_id, active)
       VALUES('m02_viewer', 'Viewer Staff', $1, 'viewer', $2, true),
             ('m02_admin', 'Admin Staff', $1, 'admin', $2, true)`,
      [staffPass, deptId]
    );

    const viewer = makeClient(baseUrl);
    await viewer.ok('/api/csrf');
    await viewer.ok('/api/auth/login', { method: 'POST', body: { username: 'm02_viewer', password: 'StaffPass-2026!' } });
    assert.equal((await viewer.request('/api/gaeru_ceo/notifications/mail-accounts')).status, 403);
    const viewerNotices = await viewer.ok('/api/gaeru_ceo/notifications');
    assert.equal(viewerNotices.items.some((i) => i.key === 'inbound_mail_notifications'), false);

    const adminStaff = makeClient(baseUrl);
    await adminStaff.ok('/api/csrf');
    await adminStaff.ok('/api/auth/login', { method: 'POST', body: { username: 'm02_admin', password: 'StaffPass-2026!' } });
    // adminStaff has settings.write, yet mail-accounts mutation is restricted to owner
    const staffMutRes = await adminStaff.request('/api/gaeru_ceo/notifications/mail-accounts', {
      method: 'POST',
      body: { action: 'add', username: 'test', password: 'MailboxPass123!' },
    });
    assert.equal(staffMutRes.status, 403);

    const owner = makeClient(baseUrl);
    await owner.ok('/api/csrf');
    await owner.ok('/api/auth/login', { method: 'POST', body: { username: 'batch3-owner', password: 'Batch3-Owner-Pass-2026!' } });
    // Owner without adminPassword fails step-up re-auth
    const noStepUp = await owner.request('/api/gaeru_ceo/notifications/mail-accounts', {
      method: 'POST',
      body: { action: 'add', username: 'test', password: 'MailboxPass123!' },
    });
    assert.ok([401, 403].includes(noStepUp.status));
    // Owner with wrong adminPassword fails step-up re-auth
    const badStepUp = await owner.request('/api/gaeru_ceo/notifications/mail-accounts', {
      method: 'POST',
      body: { action: 'add', username: 'test', password: 'MailboxPass123!', adminPassword: 'WrongPassword!' },
    });
    assert.ok([401, 403].includes(badStepUp.status));

    const notifSrc = fs.readFileSync(path.join(repoRoot, 'src', 'admin-notifications.js'), 'utf8');
    assert.match(notifSrc, /'X-Gaeru-Internal-Mail':secret/);
    assert.match(notifSrc, /createHmac\(['"]sha256['"],fallbackBase\)\.update\(['"]gaeru-internal-mail-v1['"]\)\.digest\(['"]hex['"]\)/);

    const pushScript = fs.readFileSync(path.join(repoRoot, 'scripts', 'send-mail-webpush.js'), 'utf8');
    assert.match(pushScript, /assertSafePushEndpoint/);
    assert.match(pushScript, /sa\.active\s*=\s*true\s+AND\s+sa\.role\s+IN\s*\(\s*'owner'\s*,\s*'admin'\s*\)/i);

    const uiNotifSrc = fs.readFileSync(path.join(repoRoot, 'admin', 'notifications.js'), 'utf8');
    assert.match(uiNotifSrc, /settings\.read/);
    assert.match(uiNotifSrc, /adminPassword/);
  });

  // [M-03] /api/payments/order-status permission check & /owner/revoke-staff-sessions account_security invalidation
  await t.test('[M-03] order-status rejects revoked staff sessions & revoke-staff-sessions invalidates account_security', async () => {
    const { pool, baseUrl } = await bootTestApp();
    const deptId = (await pool.query("INSERT INTO departments(code, name) VALUES('M03D', 'Sales Dept') RETURNING id")).rows[0].id;
    const staffId = (await pool.query(
      `INSERT INTO staff_accounts(username, full_name, password_hash, role, department_id, active)
       VALUES('m03_sales', 'Sales Staff', $1, 'sales', $2, true)
       RETURNING id`,
      [bcrypt.hashSync('SalesPass-2026!', 4), deptId]
    )).rows[0].id;
    const staffKey = `staff:${staffId}`;
    await pool.query('INSERT INTO account_security(account_key, version) VALUES($1, 1)', [staffKey]);
    await pool.query(
      "INSERT INTO security_challenges(account_key, purpose, fingerprint, expires_at) VALUES($1, 'otp', 'm03-fp-1', now() + interval '1 hour')",
      [staffKey]
    );
    await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd)
       VALUES('GAE-M03-001', 'Khach M03', 'm03@example.test', '0903000001', '123 Duong M03', 'HCM', 'bank_transfer', 'pending', 'pending', 100000, 0, 100000)`
    );

    const sales = makeClient(baseUrl);
    await sales.ok('/api/csrf');
    await sales.ok('/api/auth/login', { method: 'POST', body: { username: 'm03_sales', password: 'SalesPass-2026!' } });
    // Before revocation, staff with orders.read can query order-status
    const beforeRevoke = await sales.request('/api/payments/order-status?order=GAE-M03-001');
    assert.equal(beforeRevoke.status, 200);

    // Owner revokes all staff sessions
    const owner = makeClient(baseUrl);
    await owner.ok('/api/csrf');
    await owner.ok('/api/auth/login', { method: 'POST', body: { username: 'batch3-owner', password: 'Batch3-Owner-Pass-2026!' } });
    await owner.ok('/api/gaeru_ceo/owner/revoke-staff-sessions', {
      method: 'POST',
      body: { confirmation: 'REVOKE_STAFF_SESSIONS' },
    });

    assert.ok((await pool.query('SELECT version FROM account_security WHERE account_key = $1', [staffKey])).rows[0].version > 1);
    assert.ok((await pool.query("SELECT used_at FROM security_challenges WHERE fingerprint = 'm03-fp-1'")).rows[0].used_at);

    // Revoked staff session can no longer bypass /api/payments/order-status via stale req.session.admin.id
    const afterRevoke = await sales.request('/api/payments/order-status?order=GAE-M03-001');
    assert.ok([401, 403].includes(afterRevoke.status));
    // Owner still has access
    assert.equal((await owner.request('/api/payments/order-status?order=GAE-M03-001')).status, 200);

    const ownerSrc = fs.readFileSync(path.join(repoRoot, 'src', 'owner-api.js'), 'utf8');
    assert.match(ownerSrc, /resolveEncryptionKeys\(config\)\.dedicated/);
  });

  // [M-04] Google OAuth DB disable flag & checkCustomerPhoneStatus enforcement
  await t.test('[M-04] Google OAuth honors DB disabled flag and blocks phone-expired customers', async () => {
    const expiredEmail = 'm04-expired@example.test';
    const fakeOAuthClient = {
      async verifyIdToken() {
        return {
          getPayload() {
            return {
              sub: 'google-sub-m04-expired',
              email: expiredEmail,
              email_verified: true,
              name: 'M04 Expired',
              iss: 'https://accounts.google.com',
              aud: 'm04-client-id.apps.googleusercontent.com',
              exp: Math.floor(Date.now() / 1000) + 3600,
            };
          },
        };
      },
    };
    const { pool, baseUrl } = await bootTestApp({
      GOOGLE_CLIENT_ID: 'm04-client-id.apps.googleusercontent.com',
    }, fakeOAuthClient);

    await pool.query(
      `INSERT INTO customers(full_name, email, phone, password_hash, google_id, active, email_verified_at, phone_invalid_at)
       VALUES('M04 Expired', $1, '12345', $2, 'google-sub-m04-expired', true, now(), now() - interval '15 days')`,
      [expiredEmail, bcrypt.hashSync('CustM04Pass!', 4)]
    );

    const client = makeClient(baseUrl);
    await client.ok('/api/csrf');

    // 1. Enabled in env, active account except expired invalid phone -> 403 and auto-locked
    const phoneBlocked = await client.request('/api/customer-auth/oauth/google', {
      method: 'POST',
      body: { credential: 'header.payload.signature-token' },
    });
    assert.equal(phoneBlocked.status, 403);
    const lockedRow = (await pool.query('SELECT active, lock_reason FROM customers WHERE email = $1', [expiredEmail])).rows[0];
    assert.equal(lockedRow.active, false);
    assert.equal(lockedRow.lock_reason, 'invalid_phone_timeout');

    // 2. DB OAuth disabled flag overrides GOOGLE_CLIENT_ID env var
    await pool.query(
      `INSERT INTO store_settings(setting_key, setting_value) VALUES('private_admin:oauth', $1::jsonb)
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
      [JSON.stringify({ enabled: false, googleClientId: 'm04-client-id.apps.googleusercontent.com' })]
    );
    const cfg = await client.ok('/api/customer-auth/oauth/config');
    assert.equal(cfg.google.enabled, false);
    const disabledPost = await client.request('/api/customer-auth/oauth/google', {
      method: 'POST',
      body: { credential: 'header.payload.signature-token' },
    });
    assert.ok([403, 404, 503].includes(disabledPost.status));
  });

  // [M-05] Internal AI no fuzzy fallback, newest-10 history ordering, & spinner XSS fix
  await t.test('[M-05] Internal AI skips fuzzy fallback on mismatch, fetches newest 10 ASC, & renders safe spinner', async () => {
    const { pool, baseUrl } = await bootTestApp();
    const owner = makeClient(baseUrl);
    await owner.ok('/api/csrf');
    await owner.ok('/api/auth/login', { method: 'POST', body: { username: 'batch3-owner', password: 'Batch3-Owner-Pass-2026!' } });

    const starts = new Date(Date.now() - 86400000).toISOString();
    const ends = new Date(Date.now() + 86400000 * 7).toISOString();
    await pool.query(
      `INSERT INTO marketing_vouchers(code, title, kind, amount, min_spend_vnd, starts_at, ends_at, total_limit, active)
       VALUES('M05ALPHA', 'Voucher Alpha', 'fixed', 10000, 0, $1, $2, 10, true),
             ('M05BETA', 'Voucher Beta', 'fixed', 20000, 0, $1, $2, 10, true)`,
      [starts, ends]
    );
    await pool.query(
      `INSERT INTO marketing_campaigns(title, body, starts_at, ends_at, active)
       VALUES('Chien dich Mua Xuan', 'Noi dung xuan', $1, $2, true),
             ('Chien dich Mua He', 'Noi dung he', $1, $2, true)`,
      [starts, ends]
    );

    const thread = await owner.ok('/api/gaeru_ceo/internal-ai/threads', {
      method: 'POST',
      body: { title: 'Batch3 M05 Test' },
      expected: 201,
    });
    const threadId = thread.thread?.id || thread.id;

    // Asking to cancel a non-matching voucher when 2 exist must NOT propose deleting/cancelling M05BETA
    const noMatchVoucher = await owner.ok(`/api/gaeru_ceo/internal-ai/threads/${threadId}/chat`, {
      method: 'POST',
      body: { question: 'hủy mã voucher M05KHONGTONTAI' },
    });
    assert.equal(noMatchVoucher.actionCard || null, null);
    assert.doesNotMatch(JSON.stringify(noMatchVoucher), /M05BETA/);

    // Asking to cancel a non-matching campaign when 2 exist must NOT propose cancelling Mua He
    const noMatchCampaign = await owner.ok(`/api/gaeru_ceo/internal-ai/threads/${threadId}/chat`, {
      method: 'POST',
      body: { question: 'hủy chiến dịch khuyến mại Mua Dong' },
    });
    assert.equal(noMatchCampaign.actionCard || null, null);
    assert.doesNotMatch(JSON.stringify(noMatchCampaign), /Mua He/);

    // Verify newest-10 chronological subquery logic directly on internal_ai_messages
    const histThreadId = (await pool.query(
      "INSERT INTO internal_ai_threads(user_id, user_role, user_name, title) VALUES('owner', 'owner', 'Owner', 'HistOrder') RETURNING id"
    )).rows[0].id;
    const baseMs = Date.now() - 60000;
    for (let i = 1; i <= 15; i += 1) {
      await pool.query(
        'INSERT INTO internal_ai_messages(thread_id, role, content, created_at) VALUES($1, $2, $3, $4)',
        [histThreadId, i % 2 ? 'user' : 'assistant', `msg-${String(i).padStart(2, '0')}`, new Date(baseMs + i * 1000)]
      );
    }
    const recent10 = (await pool.query(`
      SELECT role, content FROM (
        SELECT id, role, content, created_at
        FROM internal_ai_messages
        WHERE thread_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 10
      ) recent
      ORDER BY created_at ASC, id ASC
    `, [histThreadId])).rows.map((r) => r.content);
    assert.deepEqual(recent10, ['msg-06', 'msg-07', 'msg-08', 'msg-09', 'msg-10', 'msg-11', 'msg-12', 'msg-13', 'msg-14', 'msg-15']);

    const aiClientSrc = fs.readFileSync(path.join(repoRoot, 'admin', 'internal-ai.js'), 'utf8');
    assert.match(aiClientSrc, /assistantBubble\.innerHTML\s*=\s*['"]<span class="copilot-loading"/);
  });

  // [M-06] Aggregated reserveStock across duplicate order_items, redeemed voucher delete 409, & exchange doesn't block return
  await t.test('[M-06] aggregates duplicate variant quantities, protects redeemed vouchers, and allows return after resolved exchange', async () => {
    const { pool, baseUrl } = await bootTestApp();
    const owner = makeClient(baseUrl);
    await owner.ok('/api/csrf');
    await owner.ok('/api/auth/login', { method: 'POST', body: { username: 'batch3-owner', password: 'Batch3-Owner-Pass-2026!' } });

    const prodId = (await pool.query(
      "INSERT INTO products(slug, name, category, active) VALUES('m06-mic', 'M06 Mic', 'audio', true) RETURNING id"
    )).rows[0].id;
    const varId = (await pool.query(
      "INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active) VALUES($1, 'M06-SKU-1', 'Standard', 100000, 4, true) RETURNING id",
      [prodId]
    )).rows[0].id;
    await pool.query(
      `INSERT INTO warehouse_stock(warehouse_id, variant_id, quantity)
       SELECT id, $1, 4 FROM warehouses WHERE code = 'MAIN'
       ON CONFLICT (warehouse_id, variant_id) DO UPDATE SET quantity = 4`,
      [varId]
    );
    const orderId = (await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd)
       VALUES('GAE-M06-DUP', 'Khach M06', 'm06@example.test', '0906000001', '12 Duong M06', 'HN', 'cod', 'pending', 'pending', 500000, 0, 500000)
       RETURNING id`
    )).rows[0].id;
    // Two order_items for the SAME variant summing to 5 (> stock 4)
    await pool.query(
      `INSERT INTO order_items(order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
       VALUES($1, $2, 'M06 Mic', 'Standard', 'M06-SKU-1', 100000, 2, 200000),
             ($1, $2, 'M06 Mic', 'Standard', 'M06-SKU-1', 100000, 3, 300000)`,
      [orderId, varId]
    );
    const overStockRes = await owner.request(`/api/gaeru_ceo/orders/${orderId}`, {
      method: 'PATCH',
      body: { status: 'confirmed' },
    });
    assert.equal(overStockRes.status, 409);

    // Raise stock to 5 -> confirmation succeeds and leaves stock_quantity = 0
    await pool.query('UPDATE product_variants SET stock_quantity = 5 WHERE id = $1', [varId]);
    await pool.query(
      "UPDATE warehouse_stock SET quantity = 5 WHERE variant_id = $1 AND warehouse_id = (SELECT id FROM warehouses WHERE code = 'MAIN')",
      [varId]
    );
    await owner.ok(`/api/gaeru_ceo/orders/${orderId}`, {
      method: 'PATCH',
      body: { status: 'confirmed' },
    });
    assert.equal((await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [varId])).rows[0].stock_quantity, 0);

    // Redeemed voucher cannot be deleted (409)
    const starts = new Date(Date.now() - 86400000).toISOString();
    const ends = new Date(Date.now() + 86400000 * 7).toISOString();
    const vId = (await pool.query(
      `INSERT INTO marketing_vouchers(code, title, kind, amount, min_spend_vnd, starts_at, ends_at, total_limit, active)
       VALUES('M06REDEEM', 'Voucher Redeemed', 'fixed', 10000, 0, $1, $2, 10, true) RETURNING id`,
      [starts, ends]
    )).rows[0].id;
    await pool.query(
      'INSERT INTO voucher_redemptions(order_id, voucher_id, discount_vnd, released) VALUES($1, $2, 10000, false)',
      [orderId, vId]
    );
    const delVoucherRes = await owner.request(`/api/gaeru_ceo/marketing/vouchers/${vId}`, { method: 'DELETE' });
    assert.equal(delVoucherRes.status, 409);
    assert.equal((await pool.query('SELECT count(*)::int AS c FROM voucher_redemptions WHERE voucher_id = $1', [vId])).rows[0].c, 1);

    // Resolved exchange does NOT block a subsequent return eligibility or admin return creation
    const retOrderId = (await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd)
       VALUES('GAE-M06-EXCH', 'Khach M06B', 'm06b@example.test', '0906000002', '12 Duong M06B', 'HN', 'cod', 'paid', 'completed', 200000, 0, 200000)
       RETURNING id`
    )).rows[0].id;
    await pool.query(
      `INSERT INTO order_after_sales(order_id, kind, return_type, status, reason)
       VALUES($1, 'return', 'exchange', 'resolved', 'Doi moi lan 1')`,
      [retOrderId]
    );
    const adminAfterSales = await owner.request(`/api/gaeru_ceo/orders/${retOrderId}/after-sales`, {
      method: 'POST',
      body: { kind: 'return', reason: 'Hoan tien sau khi da doi moi' },
    });
    assert.equal(adminAfterSales.status, 201);
  });

  // [M-07] Care SSE sender semantics & catalog video range streaming + deleted product exclusion
  await t.test('[M-07] care upload emits customer/staff sender accurately and catalog-videos streams ranges + excludes deleted products', async () => {
    const tmpMedia = fs.mkdtempSync(path.join(os.tmpdir(), 'gaeru-m07-media-'));
    const oldMediaRoot = process.env.MEDIA_ROOT;
    process.env.MEDIA_ROOT = tmpMedia;
    t.after(() => {
      if (oldMediaRoot === undefined) delete process.env.MEDIA_ROOT;
      else process.env.MEDIA_ROOT = oldMediaRoot;
      fs.rmSync(tmpMedia, { recursive: true, force: true });
    });

    const { pool, baseUrl } = await bootTestApp();
    const realtimeSse = require('../src/realtime-sse');
    const origPublish = realtimeSse.publishCareEvent;
    const emitted = [];
    realtimeSse.publishCareEvent = (careId, eventName, payload) => {
      emitted.push({ careId, eventName, payload });
    };
    t.after(() => { realtimeSse.publishCareEvent = origPublish; });

    const custId = (await pool.query(
      "INSERT INTO customers(full_name, email, phone, password_hash, active, email_verified_at) VALUES('Care Cust', 'm07-care@example.test', '0907000001', $1, true, now()) RETURNING id",
      [bcrypt.hashSync('CarePass-2026!', 4)]
    )).rows[0].id;
    const orderId = (await pool.query(
      "INSERT INTO orders(order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd) VALUES('GAE-M07-01', $1, 'Care Cust', 'm07-care@example.test', '0907000001', 'Dia chi M07', 'HCM', 'cod', 'pending', 'pending', 100000, 0, 100000) RETURNING id",
      [custId]
    )).rows[0].id;
    const careId = (await pool.query(
      "INSERT INTO care_requests(customer_id, order_id, request_key, subject, description, status, response) VALUES($1, $2, '77777777-7777-4777-8777-777777777771', 'Can ho tro M07', 'Mo ta chi tiet yeu cau ho tro', 'waiting_customer', 'Da tiep nhan ho tro') RETURNING id",
      [custId, orderId]
    )).rows[0].id;

    const cust = makeClient(baseUrl);
    await cust.ok('/api/csrf');
    await cust.ok('/api/customer-auth/login', { method: 'POST', body: { identifier: 'm07-care@example.test', password: 'CarePass-2026!' } });
    const owner = makeClient(baseUrl);
    await owner.ok('/api/csrf');
    await owner.ok('/api/auth/login', { method: 'POST', body: { username: 'batch3-owner', password: 'Batch3-Owner-Pass-2026!' } });

    const custForm = new FormData();
    custForm.append('file', new Blob([Buffer.from('Hello from customer')], { type: 'text/plain' }), 'cust-note.txt');
    await cust.ok(`/api/customer/care/${careId}/files`, { method: 'POST', body: custForm, expected: 201 });

    const staffForm = new FormData();
    staffForm.append('file', new Blob([Buffer.from('Hello from staff')], { type: 'text/plain' }), 'staff-note.txt');
    await owner.ok(`/api/gaeru_ceo/care-requests/${careId}/files`, { method: 'POST', body: staffForm, expected: 201 });

    assert.equal(emitted.length, 2);
    assert.equal(emitted[0].payload.sender, 'customer');
    assert.equal(emitted[1].payload.sender, 'staff');

    // Catalog video streaming & deleted_at guard
    const { storeMedia } = require('../src/lib/stored-media');
    const mp4Bytes = Buffer.concat([Buffer.from('\x00\x00\x00\x18ftypisom'), Buffer.from('0123456789abcdef'.repeat(4))]);
    const storedLive = await storeMedia('videos', mp4Bytes, 'video/mp4');
    const liveVidId = (await pool.query(
      "INSERT INTO catalog_videos(content, mime_type) VALUES($1, 'video/mp4') RETURNING id",
      [storedLive]
    )).rows[0].id;
    const liveProdId = (await pool.query(
      "INSERT INTO products(slug, name, category, active, deleted_at) VALUES('m07-live-vid', 'Live Vid', 'video', true, NULL) RETURNING id"
    )).rows[0].id;
    await pool.query(
      'INSERT INTO product_presentations(product_id, description_media) VALUES($1, $2::jsonb)',
      [liveProdId, JSON.stringify([{ type: 'video', url: `/api/catalog-videos/${liveVidId}` }])]
    );

    const delVidId = (await pool.query(
      "INSERT INTO catalog_videos(content, mime_type) VALUES($1, 'video/mp4') RETURNING id",
      [storedLive]
    )).rows[0].id;
    const delProdId = (await pool.query(
      "INSERT INTO products(slug, name, category, active, deleted_at) VALUES('m07-del-vid', 'Del Vid', 'video', true, now()) RETURNING id"
    )).rows[0].id;
    await pool.query(
      'INSERT INTO product_presentations(product_id, description_media) VALUES($1, $2::jsonb)',
      [delProdId, JSON.stringify([{ type: 'video', url: `/api/catalog-videos/${delVidId}` }])]
    );

    const deletedVideoRes = await fetch(`${baseUrl}/api/catalog-videos/${delVidId}`);
    assert.equal(deletedVideoRes.status, 404);

    const rangeRes = await fetch(`${baseUrl}/api/catalog-videos/${liveVidId}`, {
      headers: { Range: 'bytes=0-15' },
    });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get('content-range'), `bytes 0-15/${mp4Bytes.length}`);
    assert.match(rangeRes.headers.get('cache-control') || '', /^private,\s*max-age=300\b/);
    assert.deepEqual(Buffer.from(await rangeRes.arrayBuffer()), mp4Bytes.subarray(0, 16));

    const badRangeRes = await fetch(`${baseUrl}/api/catalog-videos/${liveVidId}`, {
      headers: { Range: `bytes=${mp4Bytes.length + 10}-${mp4Bytes.length + 20}` },
    });
    assert.equal(badRangeRes.status, 416);

    const adminVideoRes = await owner.request(`/api/gaeru_ceo/catalog-videos/${liveVidId}`);
    assert.equal(adminVideoRes.status, 200);
    assert.match(adminVideoRes.headers.get('cache-control') || '', /^no-store\b/);
  });

  // [M-08] server-admin redaction, VietQR CSP, warranty sessionStorage, & lightbox shared state
  await t.test('[M-08] redacts server-admin.html, sets img-src vietqr CSP, uses sessionStorage, and stores _lightboxState', async () => {
    const serverAdminHtml = fs.readFileSync(path.join(repoRoot, 'admin', 'server-admin.html'), 'utf8');
    for (const secretPattern of [/192\.168\.31\.7/, /u0_a184/, /8022/, /LG G7 ThinQ/i, /judyln/i, /Snapdragon 845/i, /4\.9\.337/, /5432/, /6379/, /18\.6/, /8\.10\.3/]) {
      assert.doesNotMatch(serverAdminHtml, secretPattern);
    }
    for (const hook of [/<title>Bảng Điều Khiển Máy Chủ GAERU/, /id="spec-device"/, /id="spec-os"/, /id="spec-ip"/, /id="node-pid"/, /id="pg-summary-text"/]) {
      assert.match(serverAdminHtml, hook);
    }

    const { baseUrl } = await bootTestApp();
    const homeRes = await fetch(`${baseUrl}/`);
    const csp = homeRes.headers.get('content-security-policy') || '';
    assert.match(csp, /img-src[^;]*https:\/\/img\.vietqr\.io/);

    const warrantySrc = fs.readFileSync(path.join(repoRoot, 'warranty.js'), 'utf8');
    assert.doesNotMatch(warrantySrc, /localStorage\.setItem\(['"]gaeru-warranty-tokens['"]/);
    assert.match(warrantySrc, /sessionStorage\.setItem\(['"]gaeru-warranty-tokens['"]/);

    const chatClientSrc = fs.readFileSync(path.join(repoRoot, 'shopping-chat-client.js'), 'utf8');
    assert.match(chatClientSrc, /dlg\._lightboxState/);
  });

  // [M-09] PowerShell/JS operational script hardening
  await t.test('[M-09] scripts parse cleanly and enforce streaming/ACL/watchdog/process scoping', () => {
    const pullPs1 = path.join(repoRoot, 'scripts', 'pull-mi6-backups.ps1');
    const restorePs1 = path.join(repoRoot, 'scripts', 'failover-restore-to-pc.ps1');
    const cutoverPs1 = path.join(repoRoot, 'scripts', 'finalize-pc-cutover.ps1');
    const watchdogJs = path.join(repoRoot, 'scripts', 'watchdog-supervisor.js');

    const pullSrc = fs.readFileSync(pullPs1, 'utf8');
    assert.doesNotMatch(pullSrc, /\$sr\.ReadToEnd\(\)/);
    assert.match(pullSrc, /\$sr\.ReadLine\(\)/);
    assert.match(pullSrc, /envelope_verified/);

    const restoreSrc = fs.readFileSync(restorePs1, 'utf8');
    assert.match(restoreSrc, /function Protect-TempPath/);
    assert.match(restoreSrc, /icacls\.exe/);
    assert.match(restoreSrc, /\/inheritance:r/);
    assert.doesNotMatch(restoreSrc, /-f\s+\$tmpSql\s+2>\$null/);

    const watchdogSrc = fs.readFileSync(watchdogJs, 'utf8');
    assert.match(watchdogSrc, /typeof process\.stderr\.on\s*===\s*['"]function['"]/);

    const cutoverSrc = fs.readFileSync(cutoverPs1, 'utf8');
    assert.match(cutoverSrc, /\$_\.CommandLine\s+-like\s+"\*gaeru\*"/);

    for (const psFile of [pullPs1, restorePs1, cutoverPs1]) {
      const astOut = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${psFile.replace(/'/g, "''")}',[ref]$tokens,[ref]$errors);if($errors.Count -gt 0){throw ($errors[0].Message)};Write-Output 'AST_OK'`
        ],
        { encoding: 'utf8' }
      );
      assert.match(astOut, /AST_OK/);
    }
  });
});

test('batch 4 low-severity & hygiene fixes: [L-01] through [L-06]', async (t) => {
  const repoRoot = path.resolve(__dirname, '..');

  async function bootBatch4App({ customerMailer } = {}) {
    const pool = await createPglitePool();
    await migrateDatabase(pool);
    const app = createApp({
      config: {
        NODE_ENV: 'test',
        PORT: 0,
        PUBLIC_BASE_URL: 'https://gaeru.com',
        SESSION_SECRET: randomBytes(48).toString('hex'),
        ADMIN_USERNAME: 'batch4-owner',
        ADMIN_PASSWORD_HASH: bcrypt.hashSync('Batch4-Owner-Pass-2026!', 4),
        STORE_ORDERS_ENABLED: true,
        smtp: { from: 'noreply@gaeru.com' },
      },
      pool,
      sessionStore: new session.MemoryStore(),
      customerMailer,
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    t.after(async () => {
      await new Promise((r) => server.close(r));
      await pool.end();
    });
    const port = server.address().port;
    return { pool, port, baseUrl: `http://127.0.0.1:${port}` };
  }

  // [L-01] AI self-learning chat harvesting recency order, dedupe by harvestedKey, and confidence cap
  await t.test('[L-01] harvests newest chats first, deduplicates harvested pairs, and caps batch confidence', async () => {
    const pool = await createPglitePool();
    await migrateDatabase(pool);
    t.after(() => pool.end());

    const { scanAndHarvestPastChats } = require('../src/ai-self-learning');

    const oldThreadId = (await pool.query(
      "INSERT INTO shopping_chat_threads(owner_key, product_name, request_key) VALUES('guest:old-1', 'K9', '11111111-1111-4111-8111-111111111001') RETURNING id"
    )).rows[0].id;
    for (let idx = 0; idx < 12; idx++) {
      const sender = idx % 2 === 0 ? 'customer' : 'admin';
      const body = sender === 'customer'
        ? `Cau hoi cu so ${idx} ve san pham K9 co chong on khong?`
        : `Tra loi cu so ${idx} ve cong nghe loc tap am chu dong K9 rat tot a.`;
      await pool.query(
        `INSERT INTO shopping_chat_messages(thread_id, sender, body, request_key, created_at)
         VALUES($1, $2, $3, gen_random_uuid(), now() - interval '2 days' + ($4 || ' minutes')::interval)`,
        [oldThreadId, sender, body, String(idx)]
      );
    }

    const newThreadId = (await pool.query(
      "INSERT INTO shopping_chat_threads(owner_key, product_name, request_key) VALUES('guest:new-1', 'K9', '11111111-1111-4111-8111-111111111002') RETURNING id"
    )).rows[0].id;
    const qText = 'Micro K9 co dung duoc cho iPhone 16 Pro Max cong USB-C khong shop?';
    const aText = 'Micro GAERU K9 ho tro cam truc tiep iPhone 16 Pro Max qua cong USB-C chuan OTG a.';
    const qId = (await pool.query(
      "INSERT INTO shopping_chat_messages(thread_id, sender, body, request_key, created_at) VALUES($1, 'customer', $2, gen_random_uuid(), now() - interval '2 seconds') RETURNING id",
      [newThreadId, qText]
    )).rows[0].id;
    const aId = (await pool.query(
      "INSERT INTO shopping_chat_messages(thread_id, sender, body, request_key, created_at) VALUES($1, 'admin', $2, gen_random_uuid(), now() - interval '1 second') RETURNING id",
      [newThreadId, aText]
    )).rows[0].id;

    const firstPass = await scanAndHarvestPastChats(pool, { limit: 10 });
    assert.ok(firstPass.learned >= 1, 'must harvest the newest thread pair');

    const rowsAfterFirst = (await pool.query('SELECT * FROM ai_learned_knowledge ORDER BY created_at DESC')).rows;
    const targetKey = `${newThreadId}:${qId}:${aId}`;
    const targetRow = rowsAfterFirst.find((r) => Array.isArray(r.metadata?.harvestedKeys) && r.metadata.harvestedKeys.includes(targetKey));
    assert.ok(targetRow, 'metadata.harvestedKeys must contain exact threadId:questionId:answerId key');
    assert.equal(targetRow.status, 'pending_review');
    assert.ok(Number(targetRow.confidence_score) <= 0.85);
    const firstOccurrence = Number(targetRow.occurrence_count);
    const firstConfidence = Number(targetRow.confidence_score);

    // Re-running harvest on the exact same chat window must deduplicate cleanly
    const secondPass = await scanAndHarvestPastChats(pool, { limit: 10 });
    assert.equal(secondPass.learned, 0);
    const rowAfterSecond = (await pool.query('SELECT occurrence_count, confidence_score FROM ai_learned_knowledge WHERE id = $1', [targetRow.id])).rows[0];
    assert.equal(Number(rowAfterSecond.occurrence_count), firstOccurrence);
    assert.equal(Number(rowAfterSecond.confidence_score), firstConfidence);

    // A separate new message pair asking the same question reinforces count while capping confidence <= 0.85
    const repeatThreadId = (await pool.query(
      "INSERT INTO shopping_chat_threads(owner_key, product_name, request_key) VALUES('guest:new-2', 'K9', '11111111-1111-4111-8111-111111111003') RETURNING id"
    )).rows[0].id;
    await pool.query(
      "INSERT INTO shopping_chat_messages(thread_id, sender, body, request_key, created_at) VALUES($1, 'customer', $2, gen_random_uuid(), now())",
      [repeatThreadId, qText]
    );
    await pool.query(
      "INSERT INTO shopping_chat_messages(thread_id, sender, body, request_key, created_at) VALUES($1, 'admin', $2, gen_random_uuid(), now() + interval '1 second')",
      [repeatThreadId, aText]
    );
    const thirdPass = await scanAndHarvestPastChats(pool, { limit: 10 });
    assert.ok(thirdPass.learned >= 1);
    const rowAfterThird = (await pool.query('SELECT occurrence_count, confidence_score, status FROM ai_learned_knowledge WHERE id = $1', [targetRow.id])).rows[0];
    assert.equal(rowAfterThird.status, 'pending_review');
    assert.equal(Number(rowAfterThird.occurrence_count), firstOccurrence + 1);
    assert.ok(Number(rowAfterThird.confidence_score) <= 0.85);
  });

  // [L-02] CARE+ attachment scope in file-library, streaming, retention liveReferences, & inventory 9-dir guard
  await t.test('[L-02] integrates care/ storage scope, retention references, file-library stream, and 9-dir empty inventory', async () => {
    const tmpMedia = fs.mkdtempSync(path.join(os.tmpdir(), 'gaeru-l02-media-'));
    const oldMediaRoot = process.env.MEDIA_ROOT;
    process.env.MEDIA_ROOT = tmpMedia;
    t.after(() => {
      if (oldMediaRoot === undefined) delete process.env.MEDIA_ROOT;
      else process.env.MEDIA_ROOT = oldMediaRoot;
      fs.rmSync(tmpMedia, { recursive: true, force: true });
    });

    const filesystemMedia = require('../src/lib/filesystem-media');
    const emptyInv = await filesystemMedia.inventory();
    assert.equal(emptyInv.directories.length, 9);
    assert.equal(emptyInv.directories.some((d) => d.name === 'care'), false);

    const { pool, baseUrl } = await bootBatch4App();
    const { storeMedia } = require('../src/lib/stored-media');
    const payload = Buffer.from('Care evidence payload L02');
    const pointer = await storeMedia('care', payload, 'text/plain');
    const careKey = JSON.parse(pointer.subarray('GAERU_FS_V1:'.length).toString('utf8')).key;
    assert.match(careKey, /^care\//);

    const custId = (await pool.query(
      "INSERT INTO customers(full_name, email, phone, password_hash, active, email_verified_at) VALUES('L02 Care Cust', 'l02-care@example.test', '0902000001', $1, true, now()) RETURNING id",
      [bcrypt.hashSync('CareL02Pass-2026!', 4)]
    )).rows[0].id;
    const orderId = (await pool.query(
      "INSERT INTO orders(order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd) VALUES('GAE-L02-01', $1, 'L02 Care Cust', 'l02-care@example.test', '0902000001', '1 Duong L02', 'HCM', 'cod', 'pending', 'pending', 100000, 0, 100000) RETURNING id",
      [custId]
    )).rows[0].id;
    const careId = (await pool.query(
      "INSERT INTO care_requests(customer_id, order_id, request_key, subject, description, status) VALUES($1, $2, '22222222-2222-4222-8222-222222222001', 'Ho tro L02', 'Mo ta tep dinh kem CARE+', 'submitted') RETURNING id",
      [custId, orderId]
    )).rows[0].id;
    const msgId = (await pool.query(
      "INSERT INTO care_messages(care_id, sender, body) VALUES($1, 'customer', 'Gui tep dinh kem L02') RETURNING id",
      [careId]
    )).rows[0].id;
    await pool.query(
      "INSERT INTO care_message_files(care_id, message_id, name, mime, content, byte_size) VALUES($1, $2, 'care-evidence.txt', 'text/plain', $3, $4)",
      [careId, msgId, pointer, payload.length]
    );

    const populatedInv = await filesystemMedia.inventory();
    assert.ok(populatedInv.directories.some((d) => d.name === 'care' && d.files === 1));

    const fileLibraryStorage = require('../src/lib/file-library-storage');
    const careFiles = await fileLibraryStorage.list();
    assert.ok(careFiles.some((f) => f.scope === 'care' && f.key === careKey));

    const { liveReferences } = require('../src/shopping-chat-file-retention');
    assert.equal(await liveReferences(pool, careKey), true);

    const owner = makeClient(baseUrl);
    await owner.ok('/api/csrf');
    await owner.ok('/api/auth/login', {
      method: 'POST',
      body: { username: 'batch4-owner', password: 'Batch4-Owner-Pass-2026!' },
    });

    const libData = await owner.ok('/api/gaeru_ceo/file-library?scope=care');
    assert.equal(libData.scopes.care, 'Tệp CARE+');
    const listed = (libData.files || []).find((item) => item.key === careKey);
    assert.ok(listed, 'file-library listing must include care/ attachment');
    assert.ok(Array.isArray(listed.references) && listed.references.length >= 1);
    assert.ok(JSON.stringify(listed.references).includes('Tệp CARE+'));

    const streamRes = await owner.ok(`/api/gaeru_ceo/file-library/file?key=${encodeURIComponent(careKey)}`);
    assert.equal(streamRes, 'Care evidence payload L02');
  });

  // [L-03] Account retention purge skips in-flight shipments, releases stock/unpaid orders, & cleans auxiliary tables
  await t.test('[L-03] purgeDeletedAccounts protects shipped accounts and cleans unpaid orders + auxiliary tables', async () => {
    const { pool, baseUrl } = await bootBatch4App();
    const { purgeDeletedAccounts } = require('../src/account-retention');

    const owner = makeClient(baseUrl);
    await owner.ok('/api/csrf');
    await owner.ok('/api/auth/login', {
      method: 'POST',
      body: { username: 'batch4-owner', password: 'Batch4-Owner-Pass-2026!' },
    });

    const prodId = (await pool.query(
      "INSERT INTO products(slug, name, category, active) VALUES('l03-mic', 'L03 Mic', 'audio', true) RETURNING id"
    )).rows[0].id;
    const varId = (await pool.query(
      "INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active) VALUES($1, 'L03-SKU-1', 'Standard', 200000, 5, true) RETURNING id",
      [prodId]
    )).rows[0].id;
    await pool.query(
      `INSERT INTO warehouse_stock(warehouse_id, variant_id, quantity)
       SELECT id, $1, 5 FROM warehouses WHERE code = 'MAIN'
       ON CONFLICT (warehouse_id, variant_id) DO UPDATE SET quantity = 5`,
      [varId]
    );

    // Customer A: expired soft-delete BUT has an in-flight shipped order -> MUST be skipped
    const custA = (await pool.query(
      "INSERT INTO customers(full_name, email, phone, password_hash, active, deleted_at, deletion_recoverable) VALUES('Cust A', 'l03-a@example.test', '0903000001', $1, false, now() - interval '400 days', false) RETURNING id",
      [bcrypt.hashSync('CustA-Pass-2026!', 4)]
    )).rows[0].id;
    await pool.query(
      `INSERT INTO orders(order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd)
       VALUES('GAE-L03-SHIPPED', $1, 'Cust A', 'l03-a@example.test', '0903000001', '1 Duong A', 'HN', 'cod', 'pending', 'shipped', 200000, 0, 200000)`,
      [custA]
    );

    // Customer B: expired soft-delete with unpaid confirmed order (stock reserved), voucher, payment attempt, paid historical order, & aux tables
    const custB = (await pool.query(
      "INSERT INTO customers(full_name, email, phone, password_hash, active, deleted_at, deletion_recoverable) VALUES('Cust B', 'l03-b@example.test', '0903000002', $1, false, now() - interval '400 days', false) RETURNING id",
      [bcrypt.hashSync('CustB-Pass-2026!', 4)]
    )).rows[0].id;
    const voucherId = (await pool.query(
      `INSERT INTO marketing_vouchers(code, title, kind, amount, min_spend_vnd, starts_at, ends_at, total_limit, active)
       VALUES('L03PURGE', 'L03 Voucher', 'fixed', 20000, 0, now() - interval '1 day', now() + interval '30 days', 10, true) RETURNING id`
    )).rows[0].id;
    const unpaidOrderId = (await pool.query(
      `INSERT INTO orders(order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, discount_vnd, voucher_code, total_vnd)
       VALUES('GAE-L03-UNPAID', $1, 'Cust B', 'l03-b@example.test', '0903000002', '2 Duong B', 'HN', 'bank_transfer', 'pending', 'pending', 400000, 0, 20000, 'L03PURGE', 380000) RETURNING id`,
      [custB]
    )).rows[0].id;
    await pool.query(
      `INSERT INTO order_items(order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
       VALUES($1, $2, 'L03 Mic', 'Standard', 'L03-SKU-1', 200000, 2, 400000)`,
      [unpaidOrderId, varId]
    );
    // Transition unpaidOrderId -> confirmed via admin PATCH so stock reserves 5 -> 3 accurately
    await owner.ok(`/api/gaeru_ceo/orders/${unpaidOrderId}`, { method: 'PATCH', body: { status: 'confirmed' } });
    assert.equal((await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [varId])).rows[0].stock_quantity, 3);

    await pool.query(
      `INSERT INTO payment_attempts(order_id, provider, transaction_ref, amount_vnd, status, expires_at)
       VALUES($1, 'bank_transfer', 'TX-L03-1', 380000, 'pending', now() + interval '1 hour')`,
      [unpaidOrderId]
    );
    await pool.query(
      `INSERT INTO voucher_redemptions(order_id, voucher_id, customer_id, discount_vnd, released)
       VALUES($1, $2, $3, 20000, false)`,
      [unpaidOrderId, voucherId, custB]
    );

    const paidOrderId = (await pool.query(
      `INSERT INTO orders(order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd)
       VALUES('GAE-L03-PAID', $1, 'Cust B', 'l03-b@example.test', '0903000002', '2 Duong B', 'HN', 'cod', 'paid', 'completed', 200000, 0, 200000) RETURNING id`,
      [custB]
    )).rows[0].id;
    await pool.query(
      "INSERT INTO customer_addresses(customer_id, label, full_name, phone, address, city) VALUES($1, 'Nha', 'Cust B', '0903000002', '2 Duong B', 'HN')",
      [custB]
    );
    await pool.query(
      `INSERT INTO account_deletion_requests(customer_id, token_hash, email, password_fingerprint, reason, requested_by, expires_at)
       VALUES($1, 'hash-l03-req', 'l03-b@example.test', 'fp-l03', 'Yeu cau xoa tai khoan', 'customer', now() + interval '1 day')`,
      [custB]
    );

    const purgedCount = await purgeDeletedAccounts(pool);
    assert.equal(purgedCount, 1);

    assert.equal((await pool.query('SELECT id FROM customers WHERE id = $1', [custA])).rows.length, 1);
    assert.equal((await pool.query('SELECT id FROM customers WHERE id = $1', [custB])).rows.length, 0);
    assert.equal((await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [varId])).rows[0].stock_quantity, 5);

    const unpaidAfter = (await pool.query('SELECT status FROM orders WHERE id = $1', [unpaidOrderId])).rows[0];
    assert.equal(unpaidAfter.status, 'cancelled');
    assert.equal((await pool.query('SELECT status FROM payment_attempts WHERE order_id = $1', [unpaidOrderId])).rows[0].status, 'failed');
    assert.equal((await pool.query('SELECT released FROM voucher_redemptions WHERE order_id = $1', [unpaidOrderId])).rows[0].released, true);

    const paidAfter = (await pool.query('SELECT customer_id, status, payment_status FROM orders WHERE id = $1', [paidOrderId])).rows[0];
    assert.equal(paidAfter.customer_id, null);
    assert.equal(paidAfter.status, 'completed');
    assert.equal(paidAfter.payment_status, 'paid');
    assert.equal((await pool.query('SELECT id FROM customer_addresses WHERE customer_id = $1', [custB])).rows.length, 0);
  });

  // [L-04] Protocol-relative open redirect guard & query-string anchor stripping
  await t.test('[L-04] blocks protocol-relative // redirects, normalizes /// paths, and strips search from #anchor rewrites', async () => {
    const { port } = await bootBatch4App();
    const { cleanRoutes, enrich } = require('../src/clean-routes');
    const { clean } = require('../clean-urls');

    const cr = cleanRoutes('https://gaeru.com');
    const probe = (url) => {
      let loc = null;
      cr({ method: 'GET', path: url, originalUrl: url }, { redirect: (_s, target) => { loc = target; }, get: () => '', send: () => {}, locals: {} }, () => {});
      return loc;
    };
    assert.equal(probe('//attacker.example'), null);
    assert.equal(probe('///index.html'), '/');
    assert.equal(probe('//guide-k9.html'), '/huong-dan/gaeru-k9');

    const attackerHttp = await requestWithCustomHost(port, '//attacker.example', 'gaeru.com');
    assert.equal(attackerHttp.headers.location, undefined);

    const slashIndexHttp = await requestWithCustomHost(port, '///index.html', 'gaeru.com');
    assert.equal(slashIndexHttp.status, 301);
    assert.equal(slashIndexHttp.headers.location, '/');

    const slashGuideHttp = await requestWithCustomHost(port, '//guide-k9.html', 'gaeru.com');
    assert.equal(slashGuideHttp.status, 301);
    assert.equal(slashGuideHttp.headers.location, '/huong-dan/gaeru-k9');

    const enriched = enrich(
      '<!doctype html><html><head><title>X</title></head><body><main><a href="#top">Top</a></main></body></html>',
      '/san-pham?utm_source=evil',
      'https://gaeru.com'
    );
    assert.match(enriched, /href="\/san-pham#top"/);
    assert.doesNotMatch(enriched, /utm_source=evil/);

    assert.equal(clean('https://gaeru.com///guide-k9.html', 'https://gaeru.com'), '/huong-dan/gaeru-k9');
    assert.equal(clean('//attacker.example/path', 'https://gaeru.com'), '//attacker.example/path');
    assert.equal(clean('https://gaeru.com///cart.html', 'https://gaeru.com'), '/gio-hang');
    assert.equal(clean('/cart.html', 'https://gaeru.com'), '/gio-hang');
  });

  // [L-05] CSRF guards on return-request/inbound/admin-logistics & accurate order-email payment labels
  await t.test('[L-05] enforces CSRF on return/inbound/logistics routes and renders accurate payment labels in receipt email', async () => {
    const sent = [];
    const fakeMailer = {
      async sendMail(msg) {
        sent.push(msg);
        return { accepted: [msg.to] };
      },
    };
    const { pool, baseUrl } = await bootBatch4App({ customerMailer: fakeMailer });

    const custId = (await pool.query(
      "INSERT INTO customers(full_name, email, phone, password_hash, active, email_verified_at) VALUES('L05 Cust', 'l05@example.test', '0905000001', $1, true, now()) RETURNING id",
      [bcrypt.hashSync('L05CustPass-2026!', 4)]
    )).rows[0].id;
    const orderId = (await pool.query(
      `INSERT INTO orders(order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd, delivered_at)
       VALUES('GAE-L05-RET', $1, 'L05 Cust', 'l05@example.test', '0905000001', '5 Duong L05', 'HCM', 'bank_transfer', 'pending', 'completed', 500000, 0, 500000, now()) RETURNING id`,
      [custId]
    )).rows[0].id;

    const cust = makeClient(baseUrl);
    await cust.ok('/api/csrf');
    await cust.ok('/api/customer-auth/login', {
      method: 'POST',
      body: { identifier: 'l05@example.test', password: 'L05CustPass-2026!' },
    });

    const returnBody = {
      orderNumber: 'GAE-L05-RET',
      challenge: '0905000001',
      returnType: 'exchange',
      reasonCategory: 'faulty',
      reason: 'Micro khong thu duoc am thanh khi cam vao dien thoai',
    };
    const noCsrfReturn = await cust.request('/api/tracking/return-request', {
      method: 'POST',
      headers: { 'X-CSRF-Token': '' },
      body: returnBody,
    });
    assert.equal(noCsrfReturn.status, 403);

    const okReturn = await cust.ok('/api/tracking/return-request', {
      method: 'POST',
      expected: 201,
      body: returnBody,
    });
    const rmaRow = (await pool.query('SELECT id, rma_number, version FROM order_after_sales WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1', [orderId])).rows[0];
    const rmaNumber = okReturn.rmaNumber || rmaRow.rma_number;
    assert.ok(rmaNumber);

    await pool.query("UPDATE order_after_sales SET status = 'approved' WHERE id = $1", [rmaRow.id]);

    const whitespaceTokenInbound = await cust.request(`/api/rma/${encodeURIComponent(rmaNumber)}/inbound`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': '' },
      body: { token: '   ', carrier: 'viettel', trackingNumber: 'VT123456' },
    });
    assert.equal(whitespaceTokenInbound.status, 403);

    const owner = makeClient(baseUrl);
    await owner.ok('/api/csrf');
    await owner.ok('/api/auth/login', {
      method: 'POST',
      body: { username: 'batch4-owner', password: 'Batch4-Owner-Pass-2026!' },
    });

    const logisticsPayload = {
      version: Number(rmaRow.version),
      inboundStatus: 'delivered_to_warehouse',
      inspectionNotes: 'Kiem tra tinh trang may L05',
    };
    const noCsrfLogistics = await owner.request(`/api/gaeru_ceo/orders/after-sales/${rmaRow.id}/logistics`, {
      method: 'PATCH',
      headers: { 'X-CSRF-Token': '' },
      body: logisticsPayload,
    });
    assert.equal(noCsrfLogistics.status, 403);

    const okLogistics = await owner.ok(`/api/gaeru_ceo/orders/after-sales/${rmaRow.id}/logistics`, {
      method: 'PATCH',
      body: logisticsPayload,
    });
    assert.equal(Boolean(okLogistics), true);

    await pool.query(
      "INSERT INTO order_email_outbox(order_id, customer_id, kind, status) VALUES($1, $2, 'receipt', 'pending')",
      [orderId, custId]
    );
    const { processOrderEmail } = require('../src/order-email');
    const processed = await processOrderEmail(pool, { PUBLIC_BASE_URL: 'https://gaeru.com', smtp: { from: 'noreply@gaeru.com' } }, fakeMailer);
    assert.equal(Boolean(processed), true);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Chuyển khoản ngân hàng \(VietQR\)/);
    assert.doesNotMatch(sent[0].text, /VNPAY/);
  });

  // [L-06] GitHub workflows disabled/hardened and .gitignore excludes sensitive artifacts
  await t.test('[L-06] hardens GitHub workflows and expands .gitignore exclusions', () => {
    const jekyllSrc = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'jekyll-gh-pages.yml'), 'utf8');
    assert.match(jekyllSrc, /permissions:\s*\{\}/);
    assert.match(jekyllSrc, /if:\s*false/);
    assert.doesNotMatch(jekyllSrc, /actions\/checkout/);
    assert.doesNotMatch(jekyllSrc, /deploy-pages/);

    const notifySrc = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'notify-mobile-sync.yml'), 'utf8');
    assert.match(notifySrc, /permissions:\s*\{\}/);
    assert.match(notifySrc, /DISPATCH_TOKEN:/);
    assert.match(notifySrc, /jq\s+-n/);
    assert.match(notifySrc, /--config\s+-/);
    const runMatch = notifySrc.match(/run:\s*\|[\s\S]*$/);
    assert.ok(runMatch, 'notify-mobile-sync.yml must have a run block');
    assert.doesNotMatch(runMatch[0], /\$\{\{\s*(?:github\.event|secrets\.)/);

    const gitignoreSrc = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
    for (const pattern of ['deploy-mi6/*.tar.gz', 'deploy-mi6/*_pass', 'deploy-mi6/mi6-sync-key*', 'backups/', 'scratch/', '.tmp-test/']) {
      assert.ok(gitignoreSrc.includes(pattern), `.gitignore missing pattern: ${pattern}`);
    }
  });
});
