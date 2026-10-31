'use strict';

const express = require('express');
const webpush = require('web-push');
const { requirePermission } = require('./staff-access');
const { requireCsrf } = require('./security');

function getVapidConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY ? String(process.env.VAPID_PUBLIC_KEY).trim() : '';
  const privateKey = process.env.VAPID_PRIVATE_KEY ? String(process.env.VAPID_PRIVATE_KEY).trim() : '';
  const subject = process.env.VAPID_SUBJECT ? String(process.env.VAPID_SUBJECT).trim() : 'mailto:hotro@gaeru.com';

  if (!publicKey || !privateKey || publicKey.includes('DEMO') || privateKey.includes('DEMO')) {
    return null;
  }

  return { publicKey, privateKey, subject };
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

  // Chặn dữ liệu subscription giả
  if (key === 'auto-p256dh-key' || a === 'auto-auth-key' || (ep.includes('auto-') && ep.includes('Math.random'))) {
    throw Object.assign(new Error('Thông tin khóa subscription được tạo giả, không được chấp nhận.'), { status: 400 });
  }

  // Khóa p256dh phải là chuỗi hợp lệ
  try {
    const keyBuf = Buffer.from(key, 'base64');
    if (keyBuf.length < 6) {
      throw new Error('Độ dài khóa p256dh quá ngắn.');
    }
  } catch {
    throw Object.assign(new Error('Khóa p256dh không phải Base64 hợp lệ.'), { status: 400 });
  }

  // Auth secret chuẩn tối thiểu 4 bytes
  try {
    const authBuf = Buffer.from(a, 'base64');
    if (authBuf.length < 4) {
      throw new Error('Độ dài auth secret quá ngắn.');
    }
  } catch {
    throw Object.assign(new Error('Khóa auth secret không phải Base64 hợp lệ.'), { status: 400 });
  }

  return { endpoint: ep, p256dh: key, auth: a };
}

async function savePushSubscription(pool, { endpoint, p256dh, auth, customerId = null, userAgent = null }) {
  const valid = validatePushSubscriptionData({ endpoint, p256dh, auth });

  const result = await pool.query(
    `INSERT INTO web_push_subscriptions (endpoint, p256dh, auth, customer_id, user_agent, active)
     VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (endpoint) DO UPDATE
     SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, customer_id = COALESCE(EXCLUDED.customer_id, web_push_subscriptions.customer_id),
         user_agent = COALESCE(EXCLUDED.user_agent, web_push_subscriptions.user_agent),
         active = true, updated_at = now()
     RETURNING id, endpoint, active, created_at AS "createdAt"`,
    [valid.endpoint, valid.p256dh, valid.auth, customerId, userAgent]
  );

  return result.rows[0];
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
      enabled: true,
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

  for (const sub of subscriptions) {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth
      }
    };

    try {
      const response = await client.sendNotification(pushSubscription, payloadString, {
        TTL: 86400,
        urgency: 'high'
      });
      sent.push({
        id: sub.id,
        endpoint: sub.endpoint,
        statusCode: response?.statusCode || 201
      });
    } catch (err) {
      const statusCode = err.statusCode || (err.response && err.response.statusCode);
      if (statusCode === 404 || statusCode === 410) {
        expired.push({
          id: sub.id,
          endpoint: sub.endpoint,
          statusCode,
          error: 'Endpoint đã hết hạn hoặc người dùng đã hủy đăng ký.'
        });
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
      }
    }
  }

  return {
    ok: true,
    enabled: true,
    recipientCount: subscriptions.length,
    sentCount: sent.length,
    failedCount: failed.length,
    expiredCount: expired.length,
    unsentCount: 0,
    results: {
      sent,
      failed,
      expired
    },
    payload: { title, body, url, icon, tag }
  };
}

function createPushPublicRouter(pool) {
  const router = express.Router();

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

  router.post('/push/subscribe', express.json(), async (req, res, next) => {
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

  router.post('/push/broadcast', AdminAction('marketing.write'), express.json(), async (req, res, next) => {
    try {
      const vapid = getVapidConfig();
      if (!vapid) {
        return res.status(503).json({
          ok: false,
          enabled: false,
          error: 'Dịch vụ Web Push chưa cấu hình VAPID keys trên máy chủ.'
        });
      }

      const { title = 'GAERU Flash Sale', body = 'Ưu đãi micro thu âm chính hãng đã bắt đầu!', url = '/' } = req.body || {};
      const result = await broadcastPushNotification(pool, { title, body, url });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  getVapidConfig,
  validatePushSubscriptionData,
  savePushSubscription,
  broadcastPushNotification,
  createPushPublicRouter,
  createPushAdminRouter
};
