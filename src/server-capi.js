'use strict';
const crypto = require('node:crypto');
const { Router } = require('express');

function hashSha256(val) {
  if (!val) return null;
  const clean = String(val).trim().toLowerCase();
  return crypto.createHash('sha256').update(clean).digest('hex');
}

function normalizePhoneE164(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('0')) digits = '84' + digits.slice(1);
  return digits;
}

async function logCapiEvent(pool, { eventId, eventName, platform, status, payloadSummary, responseBody = null }) {
  try {
    await pool.query(
      `INSERT INTO server_capi_logs (event_id, event_name, platform, status, payload_summary, response_body)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [eventId, eventName, platform, status, JSON.stringify(payloadSummary || {}), responseBody]
    );
  } catch (err) {
    console.error('Lỗi lưu log server-side CAPI:', err.message);
  }
}

async function dispatchServerCapi(pool, config = {}, {
  eventName = 'Purchase',
  eventId = null,
  orderNumber = null,
  amountVnd = 0,
  email = null,
  phone = null,
  ip = null,
  userAgent = null,
  contents = [],
  fetcher = fetch
}) {
  const evId = eventId || `ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const hashedEmail = hashSha256(email);
  const normalizedPhone = normalizePhoneE164(phone);
  const hashedPhone = hashSha256(normalizedPhone);

  const metaPixelId = config.META_PIXEL_ID || process.env.META_PIXEL_ID;
  const metaToken = config.META_CAPI_TOKEN || process.env.META_CAPI_TOKEN;

  const tikTokPixelId = config.TIKTOK_PIXEL_ID || process.env.TIKTOK_PIXEL_ID;
  const tikTokToken = config.TIKTOK_EVENTS_TOKEN || process.env.TIKTOK_EVENTS_TOKEN;

  const results = { eventId: evId, meta: null, tiktok: null };

  // 1. Meta Conversions API
  const metaPayload = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: evId,
        user_data: {
          em: hashedEmail ? [hashedEmail] : undefined,
          ph: hashedPhone ? [hashedPhone] : undefined,
          client_ip_address: ip || '127.0.0.1',
          client_user_agent: userAgent || 'Mozilla/5.0'
        },
        custom_data: {
          currency: 'VND',
          value: Number(amountVnd) || 0,
          order_id: orderNumber,
          content_type: 'product',
          contents: contents.map(c => ({
            id: c.sku || c.slug || 'GAERU-SKU',
            quantity: c.quantity || 1,
            item_price: c.priceVnd || 0
          }))
        }
      }
    ]
  };

  if (metaPixelId && metaToken) {
    try {
      const resp = await fetcher(`https://graph.facebook.com/v19.0/${metaPixelId}/events?access_token=${metaToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(metaPayload),
        signal: AbortSignal.timeout(8000)
      });
      const data = await resp.text();
      results.meta = { status: resp.ok ? 'sent' : 'failed', response: data };
      await logCapiEvent(pool, {
        eventId: evId,
        eventName,
        platform: 'meta',
        status: resp.ok ? 'sent' : 'failed',
        payloadSummary: { value: amountVnd, orderNumber },
        responseBody: data
      });
    } catch (e) {
      results.meta = { status: 'failed', error: e.message };
      await logCapiEvent(pool, {
        eventId: evId,
        eventName,
        platform: 'meta',
        status: 'failed',
        payloadSummary: { value: amountVnd, orderNumber, error: e.message }
      });
    }
  } else {
    results.meta = { status: 'simulated', notice: 'CAPI Meta chạy chế độ mô phỏng (chưa cấu hình token)' };
    await logCapiEvent(pool, {
      eventId: evId,
      eventName,
      platform: 'meta',
      status: 'simulated',
      payloadSummary: { value: amountVnd, orderNumber, mode: 'simulation' }
    });
  }

  // 2. TikTok Events API
  const tikTokEventName = eventName === 'Purchase' ? 'CompletePayment' : eventName;
  const tikTokPayload = {
    event_source: 'web',
    event_source_id: tikTokPixelId || 'DEFAULT_TIKTOK_PIXEL',
    data: [
      {
        event: tikTokEventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: evId,
        user: {
          phone: hashedPhone,
          email: hashedEmail,
          ip: ip || '127.0.0.1',
          user_agent: userAgent || 'Mozilla/5.0'
        },
        properties: {
          currency: 'VND',
          value: Number(amountVnd) || 0,
          order_id: orderNumber
        }
      }
    ]
  };

  if (tikTokPixelId && tikTokToken) {
    try {
      const resp = await fetcher('https://business-api.tiktok.com/open_api/v1.3/event/track/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Access-Token': tikTokToken
        },
        body: JSON.stringify(tikTokPayload),
        signal: AbortSignal.timeout(8000)
      });
      const data = await resp.text();
      results.tiktok = { status: resp.ok ? 'sent' : 'failed', response: data };
      await logCapiEvent(pool, {
        eventId: evId,
        eventName: tikTokEventName,
        platform: 'tiktok',
        status: resp.ok ? 'sent' : 'failed',
        payloadSummary: { value: amountVnd, orderNumber },
        responseBody: data
      });
    } catch (e) {
      results.tiktok = { status: 'failed', error: e.message };
      await logCapiEvent(pool, {
        eventId: evId,
        eventName: tikTokEventName,
        platform: 'tiktok',
        status: 'failed',
        payloadSummary: { value: amountVnd, orderNumber, error: e.message }
      });
    }
  } else {
    results.tiktok = { status: 'simulated', notice: 'CAPI TikTok chạy chế độ mô phỏng (chưa cấu hình token)' };
    await logCapiEvent(pool, {
      eventId: evId,
      eventName: tikTokEventName,
      platform: 'tiktok',
      status: 'simulated',
      payloadSummary: { value: amountVnd, orderNumber, mode: 'simulation' }
    });
  }

  return results;
}

function createCapiAdminRouter(pool, config) {
  const router = Router();

  router.get('/capi/logs', async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM server_capi_logs ORDER BY created_at DESC LIMIT 50`
      );
      res.json({ logs: rows });
    } catch (err) {
      next(err);
    }
  });

  router.post('/capi/test-event', async (req, res, next) => {
    try {
      const { eventName = 'Purchase', amountVnd = 450000, orderNumber = 'TEST-ORDER' } = req.body || {};
      const results = await dispatchServerCapi(pool, config, {
        eventName,
        orderNumber,
        amountVnd,
        email: 'test@gaeru.com',
        phone: '0987654321',
        ip: req.ip,
        userAgent: req.get('user-agent')
      });
      res.json({ success: true, results });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  hashSha256,
  normalizePhoneE164,
  logCapiEvent,
  dispatchServerCapi,
  createCapiAdminRouter
};
