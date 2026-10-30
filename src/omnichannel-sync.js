'use strict';

const express = require('express');
const crypto = require('crypto');
const { withTransaction } = require('./db');

async function processOmnichannelEvent(pool, { channel, eventType, externalSku, quantityDelta = 0, payload = {} }) {
  const normChannel = String(channel || 'other').toLowerCase();
  const allowedChannels = ['shopee', 'tiktok_shop', 'lazada', 'other'];
  if (!allowedChannels.includes(normChannel)) {
    throw Object.assign(new Error(`Kênh bán hàng không hợp lệ: ${channel}`), { status: 400 });
  }

  const sku = String(externalSku || '').trim();
  const delta = Number.parseInt(quantityDelta, 10) || 0;

  if (!sku) {
    throw Object.assign(new Error('externalSku là bắt buộc.'), { status: 400 });
  }

  // Idempotency: kiểm tra chống duplicate event nếu payload có eventId
  const rawEventId = payload?.eventId || payload?.event_id || payload?.id;
  const eventId = rawEventId ? String(rawEventId).trim() : null;

  return await withTransaction(pool, async (client) => {
    if (eventId) {
      const existing = await client.query(
        `SELECT id, channel, event_type AS "eventType", external_sku AS "externalSku", quantity_delta AS "quantityDelta", created_at AS "createdAt"
         FROM omnichannel_events
         WHERE (channel = $1 AND event_id = $2) OR payload->>'eventId' = $2 OR payload->>'event_id' = $2
         LIMIT 1`,
        [normChannel, eventId]
      );
      if (existing.rows.length) {
        return {
          ok: true,
          event: existing.rows[0],
          duplicate: true
        };
      }
    }

    let updatedVariant = null;
    if (delta !== 0) {
      const updated = await client.query(
        `UPDATE product_variants
         SET stock_quantity = GREATEST(0, stock_quantity + $1), updated_at = now()
         WHERE sku = $2
         RETURNING id, sku, name, stock_quantity AS "stockQuantity"`,
        [delta, sku]
      );
      updatedVariant = updated.rows[0] || null;
    }

    try {
      const eventRes = await client.query(
        `INSERT INTO omnichannel_events (channel, event_type, external_sku, quantity_delta, payload, event_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'processed')
         RETURNING id, channel, event_type AS "eventType", external_sku AS "externalSku", quantity_delta AS "quantityDelta", created_at AS "createdAt"`,
        [normChannel, eventType || 'inventory_sync', sku, delta, JSON.stringify(payload), eventId]
      );

      return {
        ok: true,
        event: eventRes.rows[0],
        variant: updatedVariant
      };
    } catch (err) {
      // 23505: unique_violation trên (channel, event_id) do race condition tại database
      if (err.code === '23505') {
        const existing = await client.query(
          `SELECT id, channel, event_type AS "eventType", external_sku AS "externalSku", quantity_delta AS "quantityDelta", created_at AS "createdAt"
           FROM omnichannel_events
           WHERE channel = $1 AND event_id = $2
           LIMIT 1`,
          [normChannel, eventId]
        );
        return {
          ok: true,
          event: existing.rows[0] || null,
          duplicate: true
        };
      }
      throw err;
    }
  });
}

// ─── P0 FIX: Webhook xác thực HMAC-SHA256 + chống phát lại ─────────────────
// Yêu cầu header:
//   X-Webhook-Timestamp : Unix epoch seconds (phải trong ±5 phút)
//   X-Webhook-Signature : hex(HMAC-SHA256(secret, "<timestamp>.<rawBody>"))
// Cấu hình: OMNICHANNEL_WEBHOOK_SECRET trong .env (tối thiểu 32 ký tự)
// Nếu secret chưa cấu hình trên production → endpoint trả 503 để tránh lỗ hổng tồn kho.
function webhookAuthMiddleware(config) {
  return function(req, res, next) {
    const isExplicitlyDisabled = config?.OMNICHANNEL_WEBHOOK_ENABLED === false || process.env.OMNICHANNEL_WEBHOOK_ENABLED === 'false';
    if (isExplicitlyDisabled) {
      return res.status(503).json({ error: 'Tính năng Webhook đồng bộ tồn kho đa kênh hiện đang tạm khóa.' });
    }

    const secret = config?.OMNICHANNEL_WEBHOOK_SECRET || process.env.OMNICHANNEL_WEBHOOK_SECRET;

    // BẮT BUỘC phải có khóa bí mật an toàn (>= 32 ký tự) trong MỌI môi trường
    if (!secret || secret.length < 32) {
      return res.status(503).json({ error: 'Webhook inventory sync chưa được cấu hình khóa bí mật bảo mật an toàn (tối thiểu 32 ký tự).' });
    }

    const tsHeader = req.headers['x-webhook-timestamp'];
    const sigHeader = req.headers['x-webhook-signature'];

    if (!tsHeader || !sigHeader) {
      return res.status(401).json({ error: 'Yêu cầu thiếu tiêu đề xác thực webhook (X-Webhook-Timestamp, X-Webhook-Signature).' });
    }

    const ts = Number(tsHeader);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
      return res.status(401).json({ error: 'Timestamp webhook không hợp lệ hoặc đã hết hạn.' });
    }

    const rawBody = req.rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${ts}.${rawBody}`)
      .digest('hex');

    let match = false;
    try {
      match = crypto.timingSafeEqual(
        Buffer.from(sigHeader, 'hex'),
        Buffer.from(expected, 'hex')
      );
    } catch {}

    if (!match) {
      return res.status(401).json({ error: 'Chữ ký webhook không hợp lệ.' });
    }

    next();
  };
}

function createOmnichannelRouter(pool, config) {
  const router = express.Router();

  router.post(
    '/webhooks/omnichannel/:channel',
    webhookAuthMiddleware(config),
    async (req, res, next) => {
      try {
        const channel = req.params.channel;
        const { eventType, sku, quantityDelta, payload } = req.body || {};

        const result = await processOmnichannelEvent(pool, {
          channel,
          eventType,
          externalSku: sku,
          quantityDelta,
          payload
        });

        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

function createOmnichannelAdmin(pool) {
  const router = express.Router();

  router.get('/omnichannel/events', async (req, res, next) => {
    try {
      const result = await pool.query(`
        SELECT id, channel, event_type AS "eventType", external_sku AS "externalSku",
               quantity_delta AS "quantityDelta", status, processed_at AS "processedAt", created_at AS "createdAt"
        FROM omnichannel_events
        ORDER BY created_at DESC
        LIMIT 50
      `);
      res.json({ events: result.rows });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  processOmnichannelEvent,
  createOmnichannelRouter,
  createOmnichannelAdmin,
  _webhookAuthMiddleware: webhookAuthMiddleware
};
