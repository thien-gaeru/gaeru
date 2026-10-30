'use strict';

const express = require('express');
const crypto = require('crypto');
const { withTransaction } = require('./db');

async function processOmnichannelEvent(pool, { channel, eventType, sku, externalSku, quantityDelta, payload = {} }) {
  const normChannel = String(channel || 'shopee').trim().toLowerCase();
  const cleanSku = String(externalSku || sku || payload?.externalSku || payload?.sku || '').trim();
  const delta = Number.parseInt(quantityDelta ?? payload?.quantityDelta ?? payload?.delta ?? 0, 10);

  if (!cleanSku) {
    throw Object.assign(new Error('externalSku là bắt buộc.'), { status: 400 });
  }
  if (!Number.isInteger(delta)) {
    throw Object.assign(new Error('quantityDelta phải là số nguyên hợp lệ.'), { status: 400 });
  }

  // Idempotency: eventId là bắt buộc và không được để trống
  const rawEventId = payload?.eventId || payload?.event_id || payload?.id || payload?.shopeeOrderId || payload?.orderId || payload?.externalEventId;
  const eventId = rawEventId ? String(rawEventId).trim() : (delta === 0 ? `probe:${normChannel}:${cleanSku}:${Date.now()}` : null);
  if (!eventId) {
    throw Object.assign(new Error('eventId là bắt buộc để đảm bảo tính bất biến (idempotency).'), { status: 400 });
  }

  return await withTransaction(pool, async (client) => {
    // 1. Claim (channel, event_id) nguyên tử trước bất kỳ biến động tồn kho nào
    const claimRes = await client.query(
      `INSERT INTO omnichannel_events (channel, event_type, external_sku, quantity_delta, payload, event_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       ON CONFLICT (channel, event_id) DO NOTHING
       RETURNING id, channel, event_type AS "eventType", external_sku AS "externalSku", quantity_delta AS "quantityDelta", created_at AS "createdAt"`,
      [normChannel, eventType || 'inventory_sync', cleanSku, delta, JSON.stringify(payload), eventId]
    );

    // Nếu không chèn được dòng mới nghĩa là event đã tồn tại hoặc đang được xử lý (trùng lặp)
    if (!claimRes.rows.length) {
      const existing = await client.query(
        `SELECT id, channel, event_type AS "eventType", external_sku AS "externalSku", quantity_delta AS "quantityDelta", created_at AS "createdAt"
         FROM omnichannel_events
         WHERE channel = $1 AND (event_id = $2 OR payload->>'eventId' = $2 OR payload->>'event_id' = $2)
         LIMIT 1`,
        [normChannel, eventId]
      );
      return {
        ok: true,
        event: existing.rows[0] || null,
        duplicate: true
      };
    }

    const claimEvent = claimRes.rows[0];

    // 2. Kiểm tra SKU có tồn tại không. Từ chối nếu SKU không tồn tại trong hệ thống
    if (delta !== 0) {
      const variantCheck = await client.query(
        `SELECT id FROM product_variants WHERE sku = $1`,
        [cleanSku]
      );
      if (!variantCheck.rows.length) {
        await client.query(
          `UPDATE omnichannel_events SET status = 'failed', processed_at = now() WHERE id = $1`,
          [claimEvent.id]
        );
        throw Object.assign(new Error(`Không tìm thấy sản phẩm với SKU: "${cleanSku}".`), { status: 404 });
      }
    }

    // 3. Thực hiện ghi sổ biến động tồn kho qua authoritative InventoryService.applyMovement
    let updatedVariant = null;
    if (delta !== 0) {
      const { InventoryService } = require('./domain/inventory/inventory-service');
      updatedVariant = await InventoryService.applyMovement(client, {
        source: `omnichannel:${normChannel}`,
        eventId,
        sku: cleanSku,
        delta,
        actor: { username: `webhook:${normChannel}` },
        reason: `Đồng bộ tồn kho từ ${normChannel} (Event: ${eventId})`,
        allowNegative: false
      });
    }

    // 4. Cập nhật trạng thái sự kiện thành 'processed'
    await client.query(
      `UPDATE omnichannel_events SET status = 'processed', processed_at = now() WHERE id = $1`,
      [claimEvent.id]
    );

    return {
      ok: true,
      event: claimEvent,
      variant: updatedVariant
    };
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
