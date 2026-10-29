'use strict';

const express = require('express');

async function processOmnichannelEvent(pool, { channel, eventType, externalSku, quantityDelta = 0, payload = {} }) {
  const normChannel = String(channel || 'other').toLowerCase();
  const sku = String(externalSku || '').trim();
  const delta = Number.parseInt(quantityDelta, 10) || 0;

  if (!sku) {
    throw Object.assign(new Error('externalSku là bắt buộc.'), { status: 400 });
  }

  let updatedVariant = null;
  if (delta !== 0) {
    const updated = await pool.query(
      `UPDATE product_variants
       SET stock_quantity = GREATEST(0, stock_quantity + $1), updated_at = now()
       WHERE sku = $2
       RETURNING id, sku, name, stock_quantity AS "stockQuantity"`,
      [delta, sku]
    );
    updatedVariant = updated.rows[0] || null;
  }

  const eventRes = await pool.query(
    `INSERT INTO omnichannel_events (channel, event_type, external_sku, quantity_delta, payload, status)
     VALUES ($1, $2, $3, $4, $5, 'processed')
     RETURNING id, channel, event_type AS "eventType", external_sku AS "externalSku", quantity_delta AS "quantityDelta", created_at AS "createdAt"`,
    [normChannel, eventType || 'inventory_sync', sku, delta, JSON.stringify(payload)]
  );

  return {
    ok: true,
    event: eventRes.rows[0],
    variant: updatedVariant
  };
}

function createOmnichannelRouter(pool, config) {
  const router = express.Router();

  router.post('/webhooks/omnichannel/:channel', express.json(), async (req, res, next) => {
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
  });

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
  createOmnichannelAdmin
};
