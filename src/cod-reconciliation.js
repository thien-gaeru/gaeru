'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { transitionPaymentStatus } = require('./domain/payments/payment-policy');

async function processCodReconciliation(pool, { carrier = 'spx', fileName = 'bang-ke.csv', items = [] }) {
  if (!Array.isArray(items) || !items.length) {
    throw Object.assign(new Error('Danh sách đơn hàng đối soát không được để trống.'), { status: 400 });
  }

  const batchCode = `REC-${carrier.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
  let totalCollected = 0;
  let totalFee = 0;
  let hasDiscrepancy = false;

  const batchRes = await pool.query(
    `INSERT INTO cod_reconciliations (batch_code, carrier, total_orders, file_name, status)
     VALUES ($1, $2, $3, $4, 'reconciled')
     RETURNING id, batch_code AS "batchCode"`,
    [batchCode, carrier, items.length, fileName]
  );
  const batchId = batchRes.rows[0].id;

  for (const item of items) {
    const trackingCode = String(item.trackingCode || '').trim();
    const orderCode = String(item.orderCode || '').trim();
    const collected = Math.max(0, Number(item.carrierCollectedVnd) || 0);
    const fee = Math.max(0, Number(item.feeVnd) || 0);

    totalCollected += collected;
    totalFee += fee;

    // Search matching order in GAERU database
    let orderRow = null;
    if (orderCode) {
      orderRow = (await pool.query(
        `SELECT id, order_number, total_vnd, payment_status, status FROM orders WHERE order_number = $1`,
        [orderCode]
      )).rows[0];
    }
    if (!orderRow && trackingCode) {
      orderRow = (await pool.query(
        `SELECT id, order_number, total_vnd, payment_status, status FROM orders WHERE note LIKE $1 LIMIT 1`,
        [`%${trackingCode}%`]
      )).rows[0];
    }

    let status = 'matched';
    let discrepancy = 0;
    let systemCod = 0;
    let matchedOrderId = null;

    if (!orderRow) {
      status = 'not_found';
      hasDiscrepancy = true;
    } else {
      matchedOrderId = orderRow.id;
      systemCod = Number(orderRow.total_vnd) || 0;
      discrepancy = collected - systemCod;
      if (discrepancy !== 0) {
        status = 'mismatch';
        hasDiscrepancy = true;
      } else {
        // Automatically mark order as paid if COD was pending!
        if (orderRow.payment_status === 'pending') {
          await transitionPaymentStatus(pool, { orderId: orderRow.id, targetStatus: 'paid' });
        }
      }
    }

    await pool.query(
      `INSERT INTO cod_reconciliation_items
       (batch_id, tracking_code, order_code, order_id, system_cod_vnd, carrier_collected_vnd, fee_vnd, discrepancy_vnd, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [batchId, trackingCode, orderRow?.order_number || orderCode, matchedOrderId, systemCod, collected, fee, discrepancy, status]
    );
  }

  const netTransferred = totalCollected - totalFee;
  const finalStatus = hasDiscrepancy ? 'discrepancy' : 'reconciled';

  await pool.query(
    `UPDATE cod_reconciliations
     SET total_collected_vnd = $1, total_fee_vnd = $2, net_transferred_vnd = $3, status = $4
     WHERE id = $5`,
    [totalCollected, totalFee, netTransferred, finalStatus, batchId]
  );

  return {
    ok: true,
    batchCode,
    totalOrders: items.length,
    totalCollectedVnd: totalCollected,
    totalFeeVnd: totalFee,
    netTransferredVnd: netTransferred,
    status: finalStatus
  };
}

function createCodReconciliationAdmin(pool) {
  const router = express.Router();

  router.post('/cod/reconcile', express.json(), async (req, res, next) => {
    try {
      const { carrier, fileName, items } = req.body || {};
      const result = await processCodReconciliation(pool, { carrier, fileName, items });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/cod/batches', async (req, res, next) => {
    try {
      const result = await pool.query(`
        SELECT id, batch_code AS "batchCode", carrier, total_orders AS "totalOrders",
               total_collected_vnd AS "totalCollectedVnd", total_fee_vnd AS "totalFeeVnd",
               net_transferred_vnd AS "netTransferredVnd", file_name AS "fileName",
               status, created_at AS "createdAt"
        FROM cod_reconciliations
        ORDER BY created_at DESC
        LIMIT 50
      `);
      res.json({ batches: result.rows });
    } catch (err) {
      next(err);
    }
  });

  router.get('/cod/batches/:id', async (req, res, next) => {
    try {
      const batchRes = await pool.query(
        `SELECT id, batch_code AS "batchCode", carrier, total_orders AS "totalOrders",
                total_collected_vnd AS "totalCollectedVnd", total_fee_vnd AS "totalFeeVnd",
                net_transferred_vnd AS "netTransferredVnd", file_name AS "fileName", status, created_at AS "createdAt"
         FROM cod_reconciliations WHERE id = $1`,
        [req.params.id]
      );
      if (!batchRes.rows.length) return res.status(404).json({ error: 'Không tìm thấy bảng kê.' });

      const itemsRes = await pool.query(
        `SELECT id, tracking_code AS "trackingCode", order_code AS "orderCode", system_cod_vnd AS "systemCodVnd",
                carrier_collected_vnd AS "carrierCollectedVnd", fee_vnd AS "feeVnd", discrepancy_vnd AS "discrepancyVnd", status
         FROM cod_reconciliation_items WHERE batch_id = $1 ORDER BY id ASC`,
        [req.params.id]
      );

      res.json({ batch: batchRes.rows[0], items: itemsRes.rows });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  processCodReconciliation,
  createCodReconciliationAdmin
};
