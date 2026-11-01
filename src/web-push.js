'use strict';

const dns = require('node:dns');
const express = require('express');
const webpush = require('web-push');
const { rateLimit } = require('express-rate-limit');
const { requirePermission } = require('./staff-access');
const { requireCsrf } = require('./security');
const { randomUUID } = require('node:crypto');

function getVapidConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY ? String(process.env.VAPID_PUBLIC_KEY).trim() : '';
  const privateKey = process.env.VAPID_PRIVATE_KEY ? String(process.env.VAPID_PRIVATE_KEY).trim() : '';
  const subject = process.env.VAPID_SUBJECT ? String(process.env.VAPID_SUBJECT).trim() : 'mailto:hotro@gaeru.com';

  if (!publicKey || !privateKey || publicKey.includes('DEMO') || privateKey.includes('DEMO')) {
    return null;
  }

  // Validate the key pair using webpush.setVapidDetails to ensure bad keys don't report enabled
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
  } catch {
    return null;
  }

  return { publicKey, privateKey, subject };
}

function isPrivateOrLoopbackHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return true;
  let host = hostname.toLowerCase().trim().replace(/\.+$/, '');

  // Localhost & private domain suffixes
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host === 'metadata.google.internal' ||
    host === 'instance-data'
  ) {
    return true;
  }

  // Non-FQDN without dots or colons
  if (!host.includes('.') && !host.includes(':')) {
    return true;
  }

  // Check IPv6 (strip square brackets if present)
  let cleanIpv6 = host;
  if (cleanIpv6.startsWith('[') && cleanIpv6.endsWith(']')) {
    cleanIpv6 = cleanIpv6.slice(1, -1);
  }

  if (cleanIpv6.includes(':')) {
    const lower = cleanIpv6.toLowerCase();
    if (lower === '::1' || lower === '::' || lower === '0:0:0:0:0:0:0:1') return true;
    // IPv6 link-local fe80::/10, unique local fc00::/7, multicast ff00::/8, documentation 2001:db8::/32
    if (
      lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb') ||
      lower.startsWith('fc') || lower.startsWith('fd') ||
      lower.startsWith('ff') ||
      lower.startsWith('2001:db8:') || lower.startsWith('2001:0db8:')
    ) {
      return true;
    }
    // IPv4-mapped IPv6 e.g. ::ffff:127.0.0.1 or 0:0:0:0:0:ffff:127.0.0.1 or ::ffff:7f00:1
    const ffffIdx = lower.lastIndexOf('ffff:');
    if (ffffIdx !== -1) {
      const rest = lower.slice(ffffIdx + 5);
      if (rest.includes('.')) {
        return isPrivateOrLoopbackHost(rest);
      }
      const hexParts = rest.split(':');
      if (hexParts.length === 2) {
        const p1 = parseInt(hexParts[0], 16);
        const p2 = parseInt(hexParts[1], 16);
        if (!isNaN(p1) && !isNaN(p2)) {
          const octet1 = (p1 >> 8) & 0xff;
          const octet2 = p1 & 0xff;
          const octet3 = (p2 >> 8) & 0xff;
          const octet4 = p2 & 0xff;
          return isPrivateOrLoopbackHost(`${octet1}.${octet2}.${octet3}.${octet4}`);
        }
      }
    }
    // Global unicast IPv6 addresses (2000::/3 e.g. 2xxx: or 3xxx:) are public internet routable
    if (lower.startsWith('2') || lower.startsWith('3')) {
      return false;
    }
    return true;
  }

  // Check IPv4
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1, 5).map(Number);
    if (octets.some(o => o < 0 || o > 255)) return true;
    const [o1, o2, o3, o4] = octets;

    // 0.0.0.0/8
    if (o1 === 0) return true;
    // 127.0.0.0/8 (Loopback)
    if (o1 === 127) return true;
    // 10.0.0.0/8 (Private)
    if (o1 === 10) return true;
    // 172.16.0.0/12 (Private 172.16.0.0 - 172.31.255.255)
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
    // 192.168.0.0/16 (Private)
    if (o1 === 192 && o2 === 168) return true;
    // 169.254.0.0/16 (Link-local / Cloud metadata)
    if (o1 === 169 && o2 === 254) return true;
    // 100.64.0.0/10 (Carrier-grade NAT)
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return true;
    // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (TEST-NET)
    if (o1 === 192 && o2 === 0 && o3 === 2) return true;
    if (o1 === 198 && o2 === 51 && o3 === 100) return true;
    if (o1 === 203 && o2 === 0 && o3 === 113) return true;
    // 224.0.0.0/4 Multicast / Reserved
    if (o1 >= 224) return true;
    return false;
  }

  return false;
}

const KNOWN_PUSH_PROVIDERS = Object.freeze([
  'googleapis.com',
  'google.com',
  'push.services.mozilla.com',
  'mozilla.com',
  'notify.windows.com',
  'microsoft.com',
  'push.apple.com',
  'apple.com',
  'android.com'
]);

function isKnownPushProvider(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  const host = hostname.toLowerCase().trim().replace(/\.+$/, '');
  return KNOWN_PUSH_PROVIDERS.some(p => host === p || host.endsWith('.' + p));
}

async function verifyPushEndpointDns(endpointUrl, options = {}) {
  const dnsLookup = options.dnsLookup || dns?.promises?.lookup;
  if (!endpointUrl || typeof endpointUrl !== 'string') {
    throw Object.assign(new Error('Endpoint Push không được để trống.'), { status: 400 });
  }
  let parsed;
  try {
    parsed = new URL(endpointUrl.trim());
  } catch {
    throw Object.assign(new Error('Endpoint Push không phải URL hợp lệ.'), { status: 400 });
  }

  const host = parsed.hostname;
  if (isPrivateOrLoopbackHost(host)) {
    throw Object.assign(new Error('Endpoint không được trỏ đến địa chỉ nội bộ, loopback hoặc mạng riêng.'), { status: 400 });
  }

  const isDirectIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':');
  if (isDirectIp) {
    throw Object.assign(new Error('Endpoint Push không được sử dụng trực tiếp địa chỉ IP.'), { status: 400 });
  }

  if (!isKnownPushProvider(host)) {
    throw Object.assign(new Error('Endpoint Push không thuộc danh sách nhà cung cấp Push gateway đáng tin cậy.'), { status: 400 });
  }

  if (typeof dnsLookup !== 'function') {
    throw Object.assign(new Error('Hệ thống không tìm thấy trình phân giải DNS khả dụng.'), { status: 500 });
  }

  // Phân giải DNS kiểm soát địa chỉ IP đích để ngăn chặn SSRF và DNS rebinding (fail-closed)
  let addresses;
  try {
    addresses = await dnsLookup(host, { all: true });
  } catch (err) {
    if (err.status === 400) throw err;
    const errCode = err.code || err.errno || 'DNS_LOOKUP_FAILED';
    throw Object.assign(
      new Error(`Không thể phân giải tên miền Push gateway (DNS lookup failed: ${errCode}).`),
      { status: 400, code: errCode }
    );
  }

  if (!addresses || !Array.isArray(addresses) || addresses.length === 0) {
    throw Object.assign(
      new Error('Không thể phân giải tên miền Push gateway (DNS trả về kết quả rỗng).'),
      { status: 400 }
    );
  }

  for (const addr of addresses) {
    const ip = typeof addr === 'string' ? addr : addr?.address;
    if (!ip || isPrivateOrLoopbackHost(ip)) {
      throw Object.assign(
        new Error(`Endpoint phân giải về địa chỉ mạng riêng không được phép (${ip || 'unknown'}).`),
        { status: 400 }
      );
    }
  }

  return addresses;
}

function validatePushSubscriptionData(payload = {}) {
  const { endpoint, p256dh, auth, keys } = payload;
  const ep = String(endpoint || '').trim();
  const key = String(p256dh || (keys && keys.p256dh) || '').trim();
  const a = String(auth || (keys && keys.auth) || '').trim();

  if (!ep || !key || !a) {
    throw Object.assign(new Error('endpoint, p256dh và auth là bắt buộc để đăng ký thông báo đẩy.'), { status: 400 });
  }

  let url;
  try {
    url = new URL(ep);
  } catch {
    throw Object.assign(new Error('Endpoint Push Subscription không phải URL hợp lệ.'), { status: 400 });
  }

  if (url.protocol !== 'https:') {
    throw Object.assign(new Error('Endpoint phải sử dụng giao thức HTTPS.'), { status: 400 });
  }

  // Chặn cổng không chuẩn để chống SSRF probing
  if (url.port && url.port !== '443' && url.port !== '') {
    throw Object.assign(new Error('Endpoint Push Subscription chỉ được sử dụng cổng chuẩn HTTPS (443).'), { status: 400 });
  }

  // Chặn SSRF: thông tin tài khoản hoặc trỏ mạng riêng / loopback / metadata
  if (url.username || url.password) {
    throw Object.assign(new Error('Endpoint không được chứa thông tin xác thực đăng nhập (username/password).'), { status: 400 });
  }

  if (isPrivateOrLoopbackHost(url.hostname)) {
    throw Object.assign(new Error('Endpoint không được trỏ đến địa chỉ nội bộ, loopback hoặc mạng riêng.'), { status: 400 });
  }

  // Chặn dữ liệu subscription giả
  if (key === 'auto-p256dh-key' || a === 'auto-auth-key' || (ep.includes('auto-') && ep.includes('Math.random'))) {
    throw Object.assign(new Error('Thông tin khóa subscription được tạo giả, không được chấp nhận.'), { status: 400 });
  }

  if (!isKnownPushProvider(url.hostname)) {
    throw Object.assign(new Error('Endpoint Push không thuộc danh sách nhà cung cấp Push gateway đáng tin cậy.'), { status: 400 });
  }

  // Khóa p256dh và auth phải chứa định dạng ký tự Base64 / Base64URL chuẩn (không cho phép dấu chấm hoặc ký tự đặc biệt)
  const base64Pattern = /^[A-Za-z0-9+/_-]+=*$/;
  if (!base64Pattern.test(key)) {
    throw Object.assign(new Error('Khóa p256dh không phải Base64/Base64URL hợp lệ.'), { status: 400 });
  }
  if (!base64Pattern.test(a)) {
    throw Object.assign(new Error('Khóa auth secret không phải Base64/Base64URL hợp lệ.'), { status: 400 });
  }

  // Khóa p256dh phải là khóa công khai uncompressed P-256 (65 bytes, bắt đầu bằng 0x04)
  let keyBuf;
  try {
    const normalizedKey = key.replace(/-/g, '+').replace(/_/g, '/');
    keyBuf = Buffer.from(normalizedKey, 'base64');
  } catch {
    throw Object.assign(new Error('Khóa p256dh không thể giải mã Base64.'), { status: 400 });
  }
  if (keyBuf.length !== 65 || keyBuf[0] !== 0x04) {
    throw Object.assign(new Error('Độ dài khóa p256dh không hợp lệ hoặc không phải khóa công khai P-256 uncompressed chuẩn (65 bytes bắt đầu bằng 0x04).'), { status: 400 });
  }

  // Auth secret chuẩn RFC 8291 đúng 16 bytes
  let authBuf;
  try {
    const normalizedAuth = a.replace(/-/g, '+').replace(/_/g, '/');
    authBuf = Buffer.from(normalizedAuth, 'base64');
  } catch {
    throw Object.assign(new Error('Khóa auth secret không thể giải mã Base64.'), { status: 400 });
  }
  if (authBuf.length !== 16) {
    throw Object.assign(new Error('Khóa auth secret phải có độ dài đúng 16 bytes.'), { status: 400 });
  }

  return { endpoint: ep, p256dh: key, auth: a };
}

async function executeDbTx(pool, fn) {
  if (typeof pool.connect === 'function') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await fn(client);
      await client.query('COMMIT');
      return res;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  } else if (typeof pool.transaction === 'function') {
    return pool.transaction(async (tx) => {
      return fn(tx);
    });
  } else {
    try {
      await pool.query('BEGIN');
      const res = await fn(pool);
      await pool.query('COMMIT');
      return res;
    } catch (err) {
      try { await pool.query('ROLLBACK'); } catch {}
      throw err;
    }
  }
}

async function savePushSubscription(pool, { endpoint, p256dh, auth, customerId = null, userAgent = null }, options = {}) {
  const valid = validatePushSubscriptionData({ endpoint, p256dh, auth });
  await verifyPushEndpointDns(valid.endpoint, options);

  return executeDbTx(pool, async (tx) => {
      if (customerId) {
        const owner = await tx.query('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [customerId]);
        if (!owner.rows.length) {
          throw Object.assign(new Error('Không tìm thấy tài khoản khách hàng sở hữu subscription.'), { status: 401 });
        }
      }

      // 1. Kiểm tra endpoint đã tồn tại và xác thực quyền sở hữu của customer
      const existingRes = await tx.query(
        'SELECT id, customer_id, active, created_at FROM web_push_subscriptions WHERE endpoint = $1 FOR UPDATE',
        [valid.endpoint]
      );
      const existing = existingRes.rows[0];

      if (existing?.customer_id && (!customerId || String(existing.customer_id) !== String(customerId))) {
        throw Object.assign(
          new Error('Endpoint Push Subscription này đã thuộc quyền sở hữu của một tài khoản khách hàng khác.'),
          { status: 403 }
        );
      }

      // Xác định endpoint đã tồn tại và đang hoạt động cho tài khoản này hay chưa
      const isAlreadyActive = Boolean(
        existing &&
        existing.active === true &&
        (!customerId || String(existing.customer_id) === String(customerId))
      );

      // 2. Quota: Giới hạn tối đa 10 subscription hoạt động cho mỗi tài khoản để chống lạm dụng.
      // CHỈ thực hiện thu hồi (evict) thiết bị cũ khi đây là endpoint MỚI hoặc tái kích hoạt endpoint đã tắt.
      // Không evict thiết bị khác khi chỉ đăng ký lại / cập nhật khóa cho endpoint đang hoạt động.
      if (customerId && !isAlreadyActive) {
        const countRes = await tx.query(
          'SELECT count(*) AS cnt FROM web_push_subscriptions WHERE customer_id = $1 AND active = true AND endpoint != $2',
          [customerId, valid.endpoint]
        );
        const currentActive = parseInt(countRes.rows[0]?.cnt || '0', 10);
        if (currentActive >= 10) {
          const toEvict = currentActive - 10 + 1;
          await tx.query(
            `UPDATE web_push_subscriptions
             SET active = false, updated_at = now()
             WHERE id IN (
               SELECT id FROM web_push_subscriptions
               WHERE customer_id = $1 AND active = true AND endpoint != $2
               ORDER BY created_at ASC
               LIMIT $3
             )`,
            [customerId, valid.endpoint, toEvict]
          );
        }
      }

      // 3. UPSERT lưu / cập nhật thông tin subscription
      const result = await tx.query(
        `INSERT INTO web_push_subscriptions (endpoint, p256dh, auth, customer_id, user_agent, active)
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (endpoint) DO UPDATE
         SET p256dh = EXCLUDED.p256dh,
             auth = EXCLUDED.auth,
             customer_id = COALESCE(EXCLUDED.customer_id, web_push_subscriptions.customer_id),
             user_agent = COALESCE(EXCLUDED.user_agent, web_push_subscriptions.user_agent),
             active = true,
             updated_at = now()
         WHERE web_push_subscriptions.customer_id IS NULL
            OR (EXCLUDED.customer_id IS NOT NULL AND web_push_subscriptions.customer_id = EXCLUDED.customer_id)
         RETURNING id, endpoint, active, customer_id, created_at AS "createdAt"`,
        [valid.endpoint, valid.p256dh, valid.auth, customerId, userAgent]
      );

      if (!result.rows[0]) {
        throw Object.assign(
          new Error('Endpoint Push Subscription này đã thuộc quyền sở hữu của một tài khoản khách hàng khác.'),
          { status: 403 }
        );
      }
      return result.rows[0];
  });
}

const initializedPools = new WeakSet();

async function ensurePushAttemptsTable(pool) {
  if (!pool || typeof pool.query !== 'function') return;
  if (initializedPools.has(pool)) return;
  const ddl1 = `
    CREATE TABLE IF NOT EXISTS web_push_delivery_attempts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      subscription_id uuid,
      endpoint text NOT NULL,
      campaign_id text NOT NULL,
      attempt_number int NOT NULL DEFAULT 1,
      status text NOT NULL,
      indeterminate boolean NOT NULL DEFAULT false,
      retry_allowed boolean NOT NULL DEFAULT true,
      status_code int,
      error_message text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  const ddl2 = `CREATE INDEX IF NOT EXISTS idx_push_attempts_endpoint ON web_push_delivery_attempts (endpoint)`;
  const ddl3 = `CREATE INDEX IF NOT EXISTS idx_push_attempts_campaign ON web_push_delivery_attempts (campaign_id)`;
  const ddl4 = `
    CREATE TABLE IF NOT EXISTS web_push_delivery_claims (
      campaign_id text NOT NULL,
      endpoint text NOT NULL,
      subscription_id uuid,
      status text NOT NULL DEFAULT 'dispatching',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (campaign_id, endpoint)
    )
  `;

  if (typeof pool.exec === 'function') {
    await pool.exec(`${ddl1}; ${ddl2}; ${ddl3}; ${ddl4};`);
  } else {
    await pool.query(ddl1);
    await pool.query(ddl2);
    await pool.query(ddl3);
    await pool.query(ddl4);
  }
  await pool.query(
    `INSERT INTO web_push_delivery_claims (campaign_id, endpoint, subscription_id, status)
     SELECT DISTINCT ON (campaign_id, endpoint)
       campaign_id, endpoint, subscription_id, status
     FROM web_push_delivery_attempts
     WHERE status = 'sent' OR status = 'expired' OR indeterminate = true OR retry_allowed = false
     ORDER BY campaign_id, endpoint, created_at DESC
     ON CONFLICT (campaign_id, endpoint) DO NOTHING`
  );
  initializedPools.add(pool);
}

async function recordDeliveryAttempt(pool, { subscriptionId, attemptId, endpoint, campaignId, status, indeterminate, retryAllowed, statusCode, errorMessage }) {
  await executeDbTx(pool, async (tx) => {
    const updated = await tx.query(
      `UPDATE web_push_delivery_attempts
       SET status = $4, indeterminate = $5, retry_allowed = $6, status_code = $7,
           error_message = $8, updated_at = now()
       WHERE id = COALESCE($1, (
         SELECT id FROM web_push_delivery_attempts
         WHERE endpoint = $2 AND campaign_id = $3
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ))
       RETURNING id`,
      [attemptId || null, endpoint, campaignId, status, Boolean(indeterminate), Boolean(retryAllowed), statusCode || null, errorMessage || null]
    );
    if (!updated.rows.length) {
      await tx.query(
        `INSERT INTO web_push_delivery_attempts
         (subscription_id, endpoint, campaign_id, attempt_number, status, indeterminate, retry_allowed, status_code, error_message)
         VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8)`,
        [subscriptionId || null, endpoint, campaignId, status, Boolean(indeterminate), Boolean(retryAllowed), statusCode || null, errorMessage || null]
      );
    }
    await tx.query(
      'UPDATE web_push_delivery_claims SET status = $3, updated_at = now() WHERE campaign_id = $1 AND endpoint = $2',
      [campaignId, endpoint, status]
    );
  });
}

async function claimPushDeliveries(pool, subscriptions, campaignId) {
  return executeDbTx(pool, async (tx) => {
    const claimed = [];
    for (const subscription of subscriptions) {
      const claim = await tx.query(
        `INSERT INTO web_push_delivery_claims (campaign_id, endpoint, subscription_id, status)
         VALUES ($1, $2, $3, 'dispatching')
         ON CONFLICT (campaign_id, endpoint) DO NOTHING
         RETURNING endpoint`,
        [campaignId, subscription.endpoint, subscription.id || null]
      );
      if (!claim.rows.length) continue;
      const attempt = await tx.query(
        `INSERT INTO web_push_delivery_attempts
         (subscription_id, endpoint, campaign_id, attempt_number, status, indeterminate, retry_allowed)
         VALUES ($1, $2, $3, 1, 'dispatching', false, false)
         RETURNING id`,
        [subscription.id || null, subscription.endpoint, campaignId]
      );
      claimed.push({
        ...subscription,
        deliveryAttemptId: attempt.rows?.[0]?.id || null
      });
    }
    return claimed;
  });
}

async function retryPushDelivery(pool, { endpoint, campaignId }) {
  await ensurePushAttemptsTable(pool);
  const res = await pool.query(
    `SELECT * FROM web_push_delivery_attempts 
     WHERE endpoint = $1 ${campaignId ? 'AND campaign_id = $2' : ''} 
     ORDER BY created_at DESC LIMIT 1`,
    campaignId ? [endpoint, campaignId] : [endpoint]
  );
  const attempt = res.rows[0];
  if (!attempt) {
    throw Object.assign(new Error('Không tìm thấy dấu vết lượt gửi trước đó cho endpoint này.'), { status: 404 });
  }

  // Cấm retry mù: Không cho phép tự động gửi lại khi trạng thái là indeterminate / timed_out
  if (attempt.indeterminate || attempt.retry_allowed === false || attempt.status === 'timed_out') {
    throw Object.assign(
      new Error('Không được phép tự động gửi lại (retry) lượt gửi ở trạng thái giao vận bất định (indeterminate) để tránh gửi trùng lặp thông báo.'),
      { status: 400, code: 'BLIND_RETRY_FORBIDDEN', indeterminate: true }
    );
  }

  return { ok: true, retryAllowed: true, message: 'Dấu vết hợp lệ, cho phép gửi lại cho lỗi xác định.' };
}

async function broadcastPushNotification(pool, { title, body, url = '/', icon = '/assets/brand/gaeru-logo.webp', tag = 'gaeru-broadcast' }, options = {}) {
  const vapid = getVapidConfig();
  if (!vapid) {
    return {
      ok: false,
      enabled: false,
      error: 'VAPID keys chưa được cấu hình trên máy chủ. Tính năng Web Push đang tạm tắt.',
      recipientCount: 0,
      sentCount: 0,
      failedCount: 0,
      expiredCount: 0,
      unsentCount: 0,
      results: { sent: [], failed: [], expired: [] }
    };
  }

  const client = options.webpushClient || webpush;
  if (!options.webpushClient) {
    client.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  }

  const campaignId = String(
    options.campaignId ||
    options.idempotencyKey ||
    randomUUID()
  );

  await ensurePushAttemptsTable(pool);

  const result = await pool.query(
    `SELECT id, endpoint, p256dh, auth, customer_id 
     FROM web_push_subscriptions 
     WHERE active = true 
     ORDER BY created_at DESC`
  );

  const subscriptions = result.rows;
  if (!subscriptions.length) {
    return {
      ok: true,
      status: 'no_recipients',
      enabled: true,
      campaignId,
      recipientCount: 0,
      sentCount: 0,
      failedCount: 0,
      expiredCount: 0,
      unsentCount: 0,
      results: { sent: [], failed: [], expired: [] },
      payload: { title, body, url, icon, tag }
    };
  }

  const payloadString = JSON.stringify({
    title,
    body,
    url,
    icon,
    badge: '/assets/brand/gaeru-logo.webp',
    tag,
    timestamp: Date.now()
  });

  const sent = [];
  const failed = [];
  const expired = [];
  const timedOut = [];

  async function persistOutcome(outcome, attemptId) {
    try {
      await recordDeliveryAttempt(pool, { ...outcome, attemptId, campaignId });
      return true;
    } catch (error) {
      console.error('[WebPush] Không thể lưu kết quả gửi; giữ claim để tránh gửi trùng:', {
        campaignId,
        status: outcome.status,
        code: error.code || 'DELIVERY_AUDIT_FAILED'
      });
      return false;
    }
  }

  // Deduplicate subscriptions by endpoint before durably claiming this campaign.
  const uniqueSubs = [];
  const seenEndpoints = new Set();
  for (const sub of subscriptions) {
    if (!sub.endpoint || seenEndpoints.has(sub.endpoint)) continue;
    seenEndpoints.add(sub.endpoint);
    uniqueSubs.push(sub);
  }

  const claimedSubs = await claimPushDeliveries(pool, uniqueSubs, campaignId);
  if (!claimedSubs.length && uniqueSubs.length > 0) {
    return {
      ok: true,
      status: 'idempotent_skipped',
      enabled: true,
      campaignId,
      message: 'Chiến dịch này đã được gửi trước đó; các thuê bao hợp lệ hoặc bất định đã được giữ nguyên để chống gửi lặp.',
      recipientCount: uniqueSubs.length,
      sentCount: 0,
      failedCount: 0,
      expiredCount: 0,
      timedOutCount: 0,
      unsentCount: 0,
      results: { sent: [], failed: [], expired: [], timedOut: [] },
      payload: { title, body, url, icon, tag }
    };
  }

  async function sendWithTimeout(sub) {
    try {
      await verifyPushEndpointDns(sub.endpoint, options);
    } catch (dnsErr) {
      failed.push({
        id: sub.id,
        endpoint: sub.endpoint,
        statusCode: 400,
        error: dnsErr.message
      });
      await recordDeliveryAttempt(pool, {
        subscriptionId: sub.id,
        attemptId: sub.deliveryAttemptId,
        endpoint: sub.endpoint,
        campaignId,
        status: 'failed',
        indeterminate: false,
        retryAllowed: false,
        statusCode: 400,
        errorMessage: dnsErr.message
      });
      return;
    }

    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth
      }
    };

    let timer;
    let isTimedOut = false;
    const abortController = new AbortController();

    // Khởi tạo lời gọi gửi thực tế tới client / push gateway
    const sendPromise = Promise.resolve().then(() => client.sendNotification(pushSubscription, payloadString, {
      TTL: 86400,
      urgency: 'high',
      timeout: 5000,
      signal: abortController.signal
    }));

    // Lắng nghe phản hồi trễ (late completion) nếu gateway hoàn tất sau timeout (evidence: push_timeout_late_node24.log)
    if (sendPromise && typeof sendPromise.then === 'function') {
      sendPromise
        .then(async (lateRes) => {
          if (isTimedOut) {
            try {
              await pool.query(
                `UPDATE web_push_delivery_attempts
                 SET status = 'delivered_late', indeterminate = false, status_code = $1, updated_at = now()
                 WHERE id = $2`,
                [lateRes?.statusCode || 201, sub.deliveryAttemptId]
              );
            } catch (error) {
              console.error('[WebPush] Không thể cập nhật kết quả gateway đến muộn:', error.code || error.message);
            }
          }
        })
        .catch(async (lateErr) => {
          if (isTimedOut && lateErr?.name !== 'AbortError' && lateErr?.code !== 'ABORT_ERR') {
            try {
              await pool.query(
                `UPDATE web_push_delivery_attempts
                 SET status = 'failed_late', indeterminate = false, status_code = $1, error_message = $2, updated_at = now()
                 WHERE id = $3`,
                [lateErr?.statusCode || 500, lateErr.message, sub.deliveryAttemptId]
              );
            } catch (error) {
              console.error('[WebPush] Không thể cập nhật lỗi gateway đến muộn:', error.code || error.message);
            }
          }
        });
    }

    try {
      const response = await Promise.race([
        sendPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            isTimedOut = true;
            abortController.abort();
            const err = new Error('Quá thời gian gửi thông báo (timeout 5000ms).');
            err.code = 'ETIMEDOUT';
            reject(err);
          }, 5000);
          if (typeof timer.unref === 'function') timer.unref();
        })
      ]);
      const statusCode = response?.statusCode || 201;
      if (await persistOutcome({
        subscriptionId: sub.id,
        endpoint: sub.endpoint,
        status: 'sent',
        indeterminate: false,
        retryAllowed: false,
        statusCode
      }, sub.deliveryAttemptId)) {
        sent.push({ id: sub.id, endpoint: sub.endpoint, statusCode });
      } else {
        timedOut.push({
          id: sub.id, endpoint: sub.endpoint, status: 'indeterminate',
          indeterminate: true, retryAllowed: false,
          error: 'Push Gateway phản hồi thành công nhưng không lưu được kết quả; không tự gửi lại.'
        });
      }
    } catch (err) {
      if (err.code === 'ETIMEDOUT' || err.name === 'AbortError' || abortController.signal.aborted || isTimedOut) {
        timedOut.push({
          id: sub.id,
          endpoint: sub.endpoint,
          status: 'timed_out',
          indeterminate: true,
          retryAllowed: false,
          error: 'Quá thời gian chờ phản hồi từ Push Gateway (timeout 5000ms); trạng thái giao vận bất định (unconfirmed) để tránh trùng lặp.'
        });
        await persistOutcome({
          subscriptionId: sub.id,
          endpoint: sub.endpoint,
          status: 'timed_out',
          indeterminate: true,
          retryAllowed: false,
          statusCode: 408,
          errorMessage: 'Quá thời gian chờ phản hồi từ Push Gateway (timeout 5000ms); trạng thái giao vận bất định.'
        }, sub.deliveryAttemptId);
        return;
      }

      const statusCode = err.statusCode || (err.response && err.response.statusCode);
      if (statusCode === 404 || statusCode === 410) {
        expired.push({
          id: sub.id,
          endpoint: sub.endpoint,
          statusCode,
          error: 'Endpoint đã hết hạn hoặc người dùng đã hủy đăng ký.'
        });
        await persistOutcome({
          subscriptionId: sub.id,
          endpoint: sub.endpoint,
          status: 'expired',
          indeterminate: false,
          retryAllowed: false,
          statusCode,
          errorMessage: 'Endpoint đã hết hạn hoặc người dùng đã hủy đăng ký.'
        }, sub.deliveryAttemptId);
        try {
          await pool.query(
            `UPDATE web_push_subscriptions SET active = false, updated_at = now() WHERE id = $1`,
            [sub.id]
          );
        } catch (dbErr) {
          console.error('[WebPush] Lỗi cập nhật subscription hết hạn:', dbErr.message);
        }
      } else {
        failed.push({
          id: sub.id,
          endpoint: sub.endpoint,
          statusCode: statusCode || 500,
          error: err.message || 'Lỗi gửi push notification'
        });
        await persistOutcome({
          subscriptionId: sub.id,
          endpoint: sub.endpoint,
          status: 'failed',
          indeterminate: false,
          retryAllowed: true,
          statusCode: statusCode || 500,
          errorMessage: err.message || 'Lỗi gửi push notification'
        }, sub.deliveryAttemptId);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const BATCH_SIZE = 25;
  for (let i = 0; i < claimedSubs.length; i += BATCH_SIZE) {
    const chunk = claimedSubs.slice(i, i + BATCH_SIZE);
    await Promise.all(chunk.map(sub => sendWithTimeout(sub)));
  }

  const unsentCount = Math.max(0, claimedSubs.length - (sent.length + failed.length + expired.length + timedOut.length));
  const hasTimedOut = timedOut.length > 0;
  const isAllTimedOut = sent.length === 0 && claimedSubs.length > 0 && timedOut.length > 0 && failed.length === 0 && expired.length === 0;
  const isAllFailed = sent.length === 0 && claimedSubs.length > 0 && failed.length > 0 && expired.length === 0 && !hasTimedOut;
  const isPartial = sent.length > 0 && (failed.length > 0 || expired.length > 0 || timedOut.length > 0);
  const isIndeterminate = hasTimedOut && sent.length === 0;

  let status = 'success';
  if (sent.length === 0 && claimedSubs.length > 0) {
    if (isAllTimedOut || isIndeterminate) {
      status = 'timed_out';
    } else {
      status = 'failed';
    }
  } else if (isPartial) {
    status = 'partial';
  }

  return {
    ok: sent.length > 0,
    status,
    enabled: true,
    campaignId,
    indeterminate: hasTimedOut,
    message: hasTimedOut
      ? 'Có thuê bao ở trạng thái giao vận bất định (timed out / chưa xác nhận phản hồi từ Push Gateway). Không coi là gửi thất bại chắc chắn và cấm tự động gửi lại.'
      : (status === 'success' ? 'Gửi thông báo đẩy thành công.' : 'Hoàn tất gửi thông báo đẩy.'),
    recipientCount: claimedSubs.length,
    skippedCount: uniqueSubs.length - claimedSubs.length,
    sentCount: sent.length,
    failedCount: failed.length,
    expiredCount: expired.length,
    timedOutCount: timedOut.length,
    unsentCount,
    results: {
      sent,
      failed,
      expired,
      timedOut
    },
    payload: { title, body, url, icon, tag }
  };
}

function createPushPublicRouter(pool) {
  const router = express.Router();

  const pushSubscribeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Bạn đã gửi yêu cầu đăng ký thông báo đẩy quá nhiều lần. Vui lòng thử lại sau.' }
  });

  router.get('/push/public-key', (_req, res) => {
    const vapid = getVapidConfig();
    if (!vapid) {
      return res.json({
        enabled: false,
        publicKey: null,
        message: 'Tính năng Web Push chưa được cấu hình VAPID keys.'
      });
    }
    res.json({
      enabled: true,
      publicKey: vapid.publicKey
    });
  });

  router.post('/push/subscribe', pushSubscribeLimiter, express.json({ limit: '16kb' }), (req, res, next) => {
    const sessionToken = req.session?.csrfToken;
    const clientToken = req.headers['x-csrf-token'] || req.body?._csrf;
    if (!sessionToken || !clientToken || typeof clientToken !== 'string') {
      return res.status(403).json({ error: 'CSRF token không hợp lệ hoặc đã hết hạn.' });
    }
    const crypto = require('crypto');
    const bSession = Buffer.from(sessionToken);
    const bClient = Buffer.from(clientToken);
    if (bSession.length !== bClient.length || !crypto.timingSafeEqual(bSession, bClient)) {
      return res.status(403).json({ error: 'CSRF token không hợp lệ hoặc đã hết hạn.' });
    }
    next();
  }, async (req, res, next) => {
    try {
      const vapid = getVapidConfig();
      if (!vapid) {
        return res.status(503).json({
          ok: false,
          error: 'Tính năng Web Push hiện đang tắt do máy chủ chưa cấu hình VAPID keys.'
        });
      }

      const { endpoint, keys } = req.body || {};
      const customerId = req.session?.customer?.id || null;
      const sub = await savePushSubscription(pool, {
        endpoint,
        p256dh: keys?.p256dh,
        auth: keys?.auth,
        customerId,
        userAgent: req.headers['user-agent']
      });
      res.status(201).json({ ok: true, subscription: sub });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function createPushAdminRouter(pool) {
  const router = express.Router();
  const { AdminAction } = require('./admin-action');

  // Thống kê chính xác số lượng đăng ký Web Push phục vụ bảng điều khiển quản trị
  router.get('/push/stats', requirePermission('marketing.read'), async (req, res, next) => {
    try {
      const stats = await pool.query(`
        SELECT 
          count(*) AS total,
          count(*) FILTER (WHERE active = true) AS active,
          count(*) FILTER (WHERE active = false) AS inactive
        FROM web_push_subscriptions
      `);
      const row = stats.rows[0] || {};
      res.json({
        total: Number(row.total || 0),
        active: Number(row.active || 0),
        inactive: Number(row.inactive || 0)
      });
    } catch (err) {
      next(err);
    }
  });

  // Bảo vệ API gửi thông báo đẩy: kiểm tra quyền marketing.write, CSRF và xác thực nội dung
  router.post('/push/broadcast', AdminAction('marketing.write'), express.json({ limit: '64kb' }), async (req, res, next) => {
    try {
      const { title = 'GAERU Flash Sale', body = 'Ưu đãi micro thu âm chính hãng đã bắt đầu!', url = '/', idempotencyKey } = req.body || {};
      if (typeof title !== 'string' || title.trim().length === 0 || title.length > 200) {
        return res.status(400).json({ error: 'Tiêu đề thông báo không được để trống và tối đa 200 ký tự.' });
      }
      if (typeof body !== 'string' || body.trim().length === 0 || body.length > 500) {
        return res.status(400).json({ error: 'Nội dung thông báo không được để trống và tối đa 500 ký tự.' });
      }
      const requestKey = req.get('Idempotency-Key') || idempotencyKey;
      if (requestKey !== undefined && (typeof requestKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey))) {
        return res.status(400).json({ error: 'Idempotency-Key phải là UUID hợp lệ.' });
      }

      const vapid = getVapidConfig();
      if (!vapid) {
        return res.status(503).json({
          ok: false,
          enabled: false,
          error: 'Dịch vụ Web Push chưa cấu hình VAPID keys trên máy chủ.'
        });
      }

      const result = await broadcastPushNotification(pool, { title: title.trim(), body: body.trim(), url }, {
        campaignId: requestKey || randomUUID()
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  getVapidConfig,
  isKnownPushProvider,
  isPrivateOrLoopbackHost,
  verifyPushEndpointDns,
  validatePushSubscriptionData,
  savePushSubscription,
  broadcastPushNotification,
  retryPushDelivery,
  ensurePushAttemptsTable,
  createPushPublicRouter,
  createPushAdminRouter
};
