'use strict';

const express = require('express');
const { requirePermission } = require('./staff-access');
const { requireCsrf } = require('./security');

async function savePushSubscription(pool, { endpoint, p256dh, auth, customerId = null, userAgent = null }) {
  const ep = String(endpoint || '').trim();
  const key = String(p256dh || '').trim();
  const a = String(auth || '').trim();

  if (!ep || !key || !a) {
    throw Object.assign(new Error('endpoint, p256dh và auth là bắt buộc để đăng ký thông báo đẩy.'), { status: 400 });
  }

  const result = await pool.query(
    `INSERT INTO web_push_subscriptions (endpoint, p256dh, auth, customer_id, user_agent, active)
     VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (endpoint) DO UPDATE
     SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, customer_id = COALESCE(EXCLUDED.customer_id, web_push_subscriptions.customer_id),
         active = true, updated_at = now()
     RETURNING id, endpoint, active, created_at AS "createdAt"`,
    [ep, key, a, customerId, userAgent]
  );

  return result.rows[0];
}

async function broadcastPushNotification(pool, { title, body, url = '/', icon = '/assets/brand/gaeru-logo.webp' }) {
  const result = await pool.query(`SELECT id, endpoint, p256dh, auth FROM web_push_subscriptions WHERE active = true`);
  const payload = { title, body, url, icon, timestamp: Date.now() };

  let sent = 0;
  for (const sub of result.rows) {
    // In production, web-push library encrypts and posts to sub.endpoint
    sent++;
  }

  return { ok: true, recipientCount: result.rows.length, simulatedSent: sent, payload };
}

function createPushPublicRouter(pool) {
  const router = express.Router();

  router.post('/push/subscribe', express.json(), async (req, res, next) => {
    try {
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

  router.get('/push/public-key', (_req, res) => {
    res.json({
      publicKey: process.env.VAPID_PUBLIC_KEY || 'BF_GAERU_PUBLIC_VAPID_KEY_DEMO_2026'
    });
  });

  return router;
}

function createPushAdminRouter(pool) {
  const router = express.Router();
  const guardMarketingWrite = (req, res, next) => {
    if (req.admin) {
      return requirePermission('marketing.write')(req, res, () => {
        if (req.session) return requireCsrf(req, res, next);
        next();
      });
    }
    next();
  };

  router.post('/push/broadcast', guardMarketingWrite, express.json(), async (req, res, next) => {
    try {
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
  savePushSubscription,
  broadcastPushNotification,
  createPushPublicRouter,
  createPushAdminRouter
};
