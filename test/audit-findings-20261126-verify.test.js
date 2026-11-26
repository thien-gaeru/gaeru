'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { createLocalPool } = require('../src/local-server');
const { migrateDatabase } = require('../src/migrate');

const REPO_ROOT = path.resolve(__dirname, '..');

test('Finding #1: pull-mi6-backups.ps1 retains local copies on full or partial failure and prunes only verified groups', { skip: process.platform !== 'win32' }, () => {
  const pullScript = path.join(REPO_ROOT, 'scripts', 'pull-mi6-backups.ps1');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gaeru-pull-test-'));
  const backupRoot = path.join(tmpRoot, 'backup');
  const fakeBin = path.join(tmpRoot, 'bin');
  const remoteRoot = path.join(tmpRoot, 'remote');
  const remotePg = path.join(remoteRoot, 'pg');
  const remoteMedia = path.join(remoteRoot, 'media');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(remotePg, { recursive: true });
  fs.mkdirSync(remoteMedia, { recursive: true });
  fs.mkdirSync(path.join(backupRoot, 'pg'), { recursive: true });
  fs.mkdirSync(path.join(backupRoot, 'media'), { recursive: true });

  const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const writeBackup = (dir, name, body, ageDays = 0) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, body);
    const s = f + '.sha256';
    fs.writeFileSync(s, `${sha256(f)}  ${name}\n`);
    if (ageDays > 0) {
      const t = new Date(Date.now() - ageDays * 86400000);
      fs.utimesSync(f, t, t);
      fs.utimesSync(s, t, t);
    }
    return f;
  };

  // Seed 31-day-old local backups (must NEVER be lost if remote group fails)
  const oldPgDump = writeBackup(path.join(backupRoot, 'pg'), 'gaeru_store-20260101T000000Z.dump.gpg', 'old-dump', 31);
  const oldPgSql = writeBackup(path.join(backupRoot, 'pg'), 'gaeru_store-20260101T000000Z.sql.gz.gpg', 'old-sql', 31);
  const oldGlobals = writeBackup(path.join(backupRoot, 'pg'), 'gaeru_store-globals-20260101T000000Z.sql.gz.gpg', 'old-glob', 31);
  const oldMedia = writeBackup(path.join(backupRoot, 'media'), 'gaeru-media-config-20260101T000000Z.tar.gz.gpg', 'old-media', 31);

  // Seed remote fresh backups for a consistent new run
  writeBackup(remotePg, 'gaeru_store-20261126T000000Z.dump.gpg', 'new-dump-bytes');
  writeBackup(remotePg, 'gaeru_store-20261126T000000Z.sql.gz.gpg', 'new-sql-bytes');
  writeBackup(remotePg, 'gaeru_store-globals-20261126T000000Z.sql.gz.gpg', 'new-glob-bytes');
  writeBackup(remoteMedia, 'gaeru-media-config-20261126T000000Z.tar.gz.gpg', 'new-media-bytes');

  // Fake ssh/scp/gpg shims controlled by FAKE_PULL_MODE (offline | pg-only | media-only | all-ok)
  const sshShimJs = path.join(fakeBin, 'ssh-shim.js');
  fs.writeFileSync(sshShimJs, `
    const fs = require('fs'), path = require('path');
    const mode = process.env.FAKE_PULL_MODE || 'offline';
    const cmd = process.argv.slice(2).join(' ');
    if (mode === 'offline') process.exit(255);
    const isMedia = cmd.includes('gaeru-media-backups');
    if (mode === 'pg-only' && isMedia) process.exit(255);
    if (mode === 'media-only' && !isMedia) process.exit(255);
    const dir = isMedia ? process.env.FAKE_REMOTE_MEDIA : process.env.FAKE_REMOTE_PG;
    const prefix = isMedia ? '/userdata/storage/gaeru-media-backups/' : '/userdata/storage/gaeru-pg-backups/';
    const files = fs.readdirSync(dir).filter(f => !f.endsWith('.sha256'));
    let match = [];
    if (cmd.includes('gaeru_store-globals-20*.sql.gz.gpg')) match = files.filter(f => f.startsWith('gaeru_store-globals-') && f.endsWith('.sql.gz.gpg'));
    else if (cmd.includes('gaeru_store-20*.dump.gpg')) match = files.filter(f => f.startsWith('gaeru_store-20') && f.endsWith('.dump.gpg'));
    else if (cmd.includes('gaeru_store-20*.sql.gz.gpg')) match = files.filter(f => f.startsWith('gaeru_store-20') && f.endsWith('.sql.gz.gpg'));
    else if (cmd.includes('gaeru-media-config-20*.tar.gz.gpg')) match = files.filter(f => f.startsWith('gaeru-media-config-20') && f.endsWith('.tar.gz.gpg'));
    for (const f of match) console.log(prefix + f);
  `);
  const scpShimJs = path.join(fakeBin, 'scp-shim.js');
  fs.writeFileSync(scpShimJs, `
    const fs = require('fs'), path = require('path');
    const args = process.argv.slice(2);
    const srcArg = args[args.length - 2], dst = args[args.length - 1];
    const remotePath = srcArg.split(':').slice(1).join(':');
    const base = path.basename(remotePath);
    const dir = remotePath.includes('gaeru-media-backups') ? process.env.FAKE_REMOTE_MEDIA : process.env.FAKE_REMOTE_PG;
    fs.copyFileSync(path.join(dir, base), dst);
  `);
  const gpgShimJs = path.join(fakeBin, 'gpg-shim.js');
  fs.writeFileSync(gpgShimJs, `
    const args = process.argv.slice(2).join(' ');
    if (args.includes('--list-packets')) { console.log(':pubkey enc packet: version 3, algo 1'); process.exit(0); }
    process.exit(2); // passphrase required -> envelope_verified
  `);
  fs.writeFileSync(path.join(fakeBin, 'ssh.cmd'), `@"${process.execPath}" "${sshShimJs}" %*\r\n`);
  fs.writeFileSync(path.join(fakeBin, 'scp.cmd'), `@"${process.execPath}" "${scpShimJs}" %*\r\n`);
  const gpgCmd = path.join(fakeBin, 'gpg.cmd');
  fs.writeFileSync(gpgCmd, `@"${process.execPath}" "${gpgShimJs}" %*\r\n`);

  const runPull = (mode) => spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', pullScript, '-BackupRoot', backupRoot, '-KeepDays', '30', '-GpgExe', gpgCmd],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin};${process.env.PATH}`, FAKE_PULL_MODE: mode, FAKE_REMOTE_PG: remotePg, FAKE_REMOTE_MEDIA: remoteMedia }
    }
  );
  const readStatus = () => JSON.parse(fs.readFileSync(path.join(backupRoot, 'backup-status.json'), 'utf8'));

  try {
    // 1. Offline: must fail and retain ALL 31-day-old local archives + companions
    const rOffline = runPull('offline');
    assert.notEqual(rOffline.status, 0);
    assert.equal(readStatus().status, 'failed');
    for (const f of [oldPgDump, oldPgSql, oldGlobals, oldMedia]) {
      assert.equal(fs.existsSync(f), true, `Offline must retain ${path.basename(f)}`);
      assert.equal(fs.existsSync(f + '.sha256'), true);
    }

    // 2. Partial (PG succeeds, Media fails): must still fail overall, keep 31-day Media, prune old PG while keeping new PG
    const rPgOnly = runPull('pg-only');
    assert.notEqual(rPgOnly.status, 0);
    assert.equal(readStatus().status, 'failed');
    assert.equal(fs.existsSync(oldMedia), true, 'Failed Media group must keep its 31-day-old archive');
    assert.equal(fs.existsSync(oldMedia + '.sha256'), true);
    assert.equal(fs.existsSync(path.join(backupRoot, 'pg', 'gaeru_store-20261126T000000Z.dump.gpg')), true);
    assert.equal(fs.existsSync(oldPgDump), false, 'Verified PG replacement allows pruning 31-day-old PG archive');

    // Re-seed an old PG archive and test reverse partial (Media succeeds, PG fails)
    const oldPg2 = writeBackup(path.join(backupRoot, 'pg'), 'gaeru_store-20260201T000000Z.dump.gpg', 'old-dump-2', 31);
    const rMediaOnly = runPull('media-only');
    assert.notEqual(rMediaOnly.status, 0);
    assert.equal(readStatus().status, 'failed');
    assert.equal(fs.existsSync(oldPg2), true, 'Failed PG group must keep its 31-day-old archive');
    assert.equal(fs.existsSync(path.join(backupRoot, 'media', 'gaeru-media-config-20261126T000000Z.tar.gz.gpg')), true);
    assert.equal(fs.existsSync(oldMedia), false, 'Verified Media replacement allows pruning 31-day-old Media archive');

    // 3. Full success: both groups succeed, newest sets + companions kept, status envelope_verified
    const rOk = runPull('all-ok');
    assert.equal(rOk.status, 0, rOk.stderr || rOk.stdout);
    const st = readStatus();
    assert.equal(st.status, 'envelope_verified');
    assert.equal(st.newestPg, 'gaeru_store-20261126T000000Z.dump.gpg');
    assert.equal(st.newestMedia, 'gaeru-media-config-20261126T000000Z.tar.gz.gpg');
    assert.equal(fs.existsSync(oldPg2), false);
    assert.equal(fs.existsSync(path.join(backupRoot, 'pg', 'gaeru_store-20261126T000000Z.dump.gpg.sha256')), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Finding #2: shared refund ledger enforces combined cap across partial MoMo and manual RMA refunds', async (t) => {
  const pool = await createLocalPool();
  await migrateDatabase(pool);
  t.after(() => pool.end());

  const { getOrderRefundLedger } = require('../src/momo-refunds');
  const order = (await pool.query(
    `INSERT INTO orders(order_number,customer_name,email,phone,address,city,status,payment_method,payment_status,subtotal_vnd,total_vnd)
     VALUES('GR-CAP-2026','Cap Buyer','cap@example.test','0901234567','Addr','HCM','completed','momo','paid',200000,200000) RETURNING *`
  )).rows[0];
  await pool.query(
    `INSERT INTO momo_refunds(order_id,order_number,refund_order_id,request_id,original_trans_id,amount_vnd,status,environment,created_by)
     VALUES($1,$2,'ref-1','req-1',1001,80000,'succeeded','sandbox','owner'),
           ($1,$2,'ref-2','req-2',1001,50000,'pending','sandbox','owner')`,
    [order.id, order.order_number]
  );

  const mid = await getOrderRefundLedger(pool, order);
  assert.equal(mid.succeededMomoVnd, 80000);
  assert.equal(mid.unsettledMomoVnd, 50000);
  assert.equal(mid.reservedMomoVnd, 130000);
  assert.equal(mid.grossRefundableVnd, 120000);

  // After pending fails and manual RMA resolves the remaining 120,000, combined remaining becomes 0
  await pool.query("UPDATE momo_refunds SET status='failed' WHERE refund_order_id='ref-2'");
  await pool.query(
    `INSERT INTO order_after_sales(order_id,kind,return_type,status,reason,refund_amount_vnd)
     VALUES($1,'return','refund','resolved','Hoàn phần còn lại',120000)`,
    [order.id]
  );
  const done = await getOrderRefundLedger(pool, order);
  assert.equal(done.unsettledMomoVnd, 0);
  assert.equal(done.manualSettledVnd, 120000);
  assert.equal(done.grossRefundableVnd, 0);
});

test('Finding #3: dedicated key reads legacy-derived config & TOTP secrets, re-encrypts TOTP on use, and raises 503 on undecryptable config', async (t) => {
  const pool = await createLocalPool();
  await migrateDatabase(pool);
  t.after(() => pool.end());

  const { seal, open, base32 } = require('../src/totp');
  const { resolveEncryptionKeys, sealWithPrimaryKey } = require('../src/audit-fixes/encryption-key');
  const adminConfig = require('../src/admin-configuration');
  const { createAccountSecurity } = require('../src/account-security');

  const sessionSecret = crypto.randomBytes(32).toString('hex');
  const dedicatedKey = crypto.randomBytes(32).toString('hex');
  const compatKeys = resolveEncryptionKeys({ NODE_ENV: 'test', SESSION_SECRET: sessionSecret, AUTH_ENCRYPTION_KEY: '' });
  const dedicatedCfg = { NODE_ENV: 'test', SESSION_SECRET: sessionSecret, AUTH_ENCRYPTION_KEY: dedicatedKey, ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: require('bcryptjs').hashSync('Owner-pass-2026!', 4) };
  const dedicatedKeys = resolveEncryptionKeys(dedicatedCfg);

  // 1. Store one config sealed with legacyDerived and one with raw SESSION_SECRET
  await pool.query(
    `INSERT INTO store_settings(setting_key, setting_value) VALUES
      ('private_admin:payment_momo', $1::jsonb),
      ('private_admin:vnpay', $2::jsonb)`,
    [
      JSON.stringify({ version: 1, cipher: sealWithPrimaryKey(JSON.stringify({ partnerCode: 'COMPAT_MOMO', secretKey: 's1' }), compatKeys) }),
      JSON.stringify({ version: 1, cipher: seal(JSON.stringify({ tmnCode: 'RAW_VNPAY', hashSecret: 's2' }), sessionSecret) })
    ]
  );

  const momoRec = await adminConfig.readRecord(pool, dedicatedCfg, 'payment_momo');
  assert.equal(momoRec.data.partnerCode, 'COMPAT_MOMO');
  const vnpRec = await adminConfig.readRecord(pool, dedicatedCfg, 'vnpay');
  assert.equal(vnpRec.data.tmnCode, 'RAW_VNPAY');

  // 2. Undecryptable record must raise 503 rather than silently returning version 0 empty object
  await pool.query(
    "INSERT INTO store_settings(setting_key, setting_value) VALUES ('private_admin:misa', $1::jsonb)",
    [JSON.stringify({ version: 2, cipher: seal(JSON.stringify({ appId: 'broken' }), crypto.randomBytes(32).toString('hex')) })]
  );
  await assert.rejects(() => adminConfig.readRecord(pool, dedicatedCfg, 'misa'), (err) => err.status === 503);

  // 3. TOTP secret encrypted with legacyDerived still verifies after dedicated key activation AND re-encrypts to primary key
  const totpSecret = base32(crypto.randomBytes(20));
  const legacyCipher = sealWithPrimaryKey(totpSecret, compatKeys);
  await pool.query(
    `INSERT INTO account_security(account_key, method, encrypted_secret, last_counter, recovery_hashes, version)
     VALUES ('owner', 'app', $1, -1, '[]'::jsonb, 1)`,
    [legacyCipher]
  );
  // Generate valid current TOTP code
  const counter = Math.floor(Date.now() / 30000);
  const b32Alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of totpSecret) bits += b32Alpha.indexOf(ch).toString(2).padStart(5, '0');
  const rawSecret = Buffer.from(bits.match(/.{8}/g).map(x => parseInt(x, 2)));
  const ctrBuf = Buffer.alloc(8);
  ctrBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', rawSecret).update(ctrBuf).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const code = String(((hmac[off] & 0x7f) << 24 | hmac[off + 1] << 16 | hmac[off + 2] << 8 | hmac[off + 3]) % 1000000).padStart(6, '0');

  const sec = createAccountSecurity(pool, dedicatedCfg, null);
  const res = await sec.authorize(
    { session: { admin: { source: 'bootstrap', username: 'owner', credentialVersion: require('../src/staff-access').bootstrapCredentialVersion(dedicatedCfg) } }, body: { password: 'Owner-pass-2026!', factorCode: code } },
    async () => ({ ok: true })
  );
  assert.deepEqual(res, { ok: true });
  const updatedCipher = (await pool.query("SELECT encrypted_secret FROM account_security WHERE account_key='owner'")).rows[0].encrypted_secret;
  assert.notEqual(updatedCipher, legacyCipher);
  assert.equal(open(updatedCipher, dedicatedKeys.primary), totpSecret, 'TOTP secret must be re-encrypted with dedicated primary key');
});

test('Finding #4 & #9: gaeru-full-restore.sh resets search_path inside atomic restore & failover-restore-to-pc.ps1 has zero gitignored dependency', () => {
  const restoreSh = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'mi6-backup', 'gaeru-full-restore.sh'), 'utf8');
  assert.equal(restoreSh.includes('\r'), false, 'gaeru-full-restore.sh must remain LF');
  assert.match(restoreSh, /printf 'BEGIN;\\n'/);
  assert.match(restoreSh, /RESET search_path;/);
  assert.match(restoreSh, /SELECT count\(\*\) FROM public\.products;/);
  assert.match(restoreSh, /SELECT count\(\*\) FROM public\.orders;/);
  assert.match(restoreSh, /SELECT count\(\*\) FROM public\.media_upload_originals;/);
  assert.match(restoreSh, /psql -X -v ON_ERROR_STOP=1 -d gaeru_store/);
  assert.match(restoreSh, /trap finish_restore EXIT/);

  const failoverPs1 = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'failover-restore-to-pc.ps1'), 'utf8');
  assert.doesNotMatch(failoverPs1, /restart-server\.ps1/, 'PC failover must not depend on gitignored restart-server.ps1');
  assert.match(failoverPs1, /watchdog-supervisor\.js/);
  assert.match(failoverPs1, /\/readyz/);
  assert.ok(failoverPs1.indexOf('Missing failover prerequisite') < failoverPs1.indexOf('Stopping any active GAERU'));
  assert.ok(failoverPs1.indexOf('Assert-SafeTarArchive') < failoverPs1.indexOf('Stopping any active GAERU'));
});

test('Finding #5 & #12: Mi6 admin server enforces HTTPS on proxied access, restricts 2FA enroll to direct loopback, and ships all public icons/manifest', async (t) => {
  const serverSrc = fs.readFileSync(path.join(REPO_ROOT, 'infra', 'mi6', 'admin', 'server.js'), 'utf8');
  const syncSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'sync-to-mi6.ps1'), 'utf8');
  const publicDir = path.join(REPO_ROOT, 'infra', 'mi6', 'admin', 'public');

  const requiredAssets = [
    'index.html', 'logo.png', 'favicon.ico', 'favicon-16x16.png',
    'favicon-32x32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest'
  ];
  for (const asset of requiredAssets) {
    const filePath = path.join(publicDir, asset);
    assert.equal(fs.existsSync(filePath), true, `Missing tracked Mi6 admin asset: ${asset}`);
    assert.ok(fs.statSync(filePath).size > 0, `Empty Mi6 admin asset: ${asset}`);
    assert.ok(syncSrc.includes(asset), `sync-to-mi6.ps1 must sync ${asset}`);
  }
  assert.match(syncSrc, /\*\.png\|\*\.ico[\s\S]*cp -f "\$src"/, 'sync-to-mi6.ps1 must copy binary icons without tr -d \\r corruption');
  const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'));
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2);
  for (const icon of manifest.icons) {
    assert.equal(fs.existsSync(path.join(publicDir, icon.src.replace(/^\//, ''))), true, `Manifest icon missing: ${icon.src}`);
  }
  assert.doesNotMatch(serverSrc, /ufw allow[^\n]*8080/);
  assert.match(serverSrc, /server\.listen\(PORT, '127\.0\.0\.1'/);

  // Live HTTP checks against Mi6 admin server bound on 127.0.0.1 ephemeral port
  const mi6 = require('../infra/mi6/admin/server.js');
  const srv = mi6.server;
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  const base = `http://127.0.0.1:${srv.address().port}`;

  // Proxied cleartext HTTP must be rejected with 403
  const badHttp = await fetch(base + '/', { headers: { 'x-forwarded-proto': 'http' } });
  assert.equal(badHttp.status, 403);
  const badLogin = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'http' },
    body: JSON.stringify({ password: 'test' })
  });
  assert.equal(badLogin.status, 403);

  // Proxied HTTPS from loopback must serve HTML + HSTS and all icons/manifest with HTTP 200
  const okRoot = await fetch(base + '/', { headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(okRoot.status, 200);
  assert.match(okRoot.headers.get('strict-transport-security') || '', /max-age=/);
  for (const urlPath of ['/logo.png', '/favicon.ico', '/favicon-16x16.png', '/favicon-32x32.png', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest']) {
    const res = await fetch(base + urlPath, { headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(res.status, 200, `${urlPath} should return 200`);
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.length > 0, `${urlPath} should return non-empty body`);
  }

  // Proxied HTTPS cannot enroll 2FA (only direct loopback / SSH port forwarding allowed)
  const enrollBlocked = await fetch(base + '/api/2fa/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    body: JSON.stringify({ setupToken: 'x', code: '000000' })
  });
  assert.equal(enrollBlocked.status, 403);
});
