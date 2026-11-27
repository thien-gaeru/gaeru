'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '..');
const { migrateDatabase } = require('../src/migrate');

async function createPglitePool() {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const prev = queue;
    let release;
    queue = new Promise((r) => { release = r; });
    await prev;
    return release;
  }
  async function rawQuery(sql, values) {
    const res = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...res, rows: res?.rows || [], rowCount: res?.affectedRows ?? res?.rows?.length ?? 0 };
  }
  const pool = {
    async query(sql, values) {
      const release = await lock();
      try { return await rawQuery(sql, values); } finally { release(); }
    },
    async connect() {
      const release = await lock();
      let released = false;
      return {
        query: (sql, values) => rawQuery(sql, values),
        release: () => { if (!released) { released = true; release(); } }
      };
    },
    end: () => db.close()
  };
  await migrateDatabase(pool);
  return { db, pool };
}

async function seedCatalog(pool) {
  const productId = randomUUID();
  const variantId = randomUUID();
  const whMain = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN' LIMIT 1")).rows[0]?.id || randomUUID();
  await pool.query(
    "INSERT INTO warehouses (id, code, name, active) VALUES ($1, 'MAIN', 'Kho chính', true) ON CONFLICT DO NOTHING",
    [whMain]
  );
  await pool.query(
    `INSERT INTO products (id, slug, name, category, active)
     VALUES ($1, $2, 'GAERU K9 Pro', 'audio', true)`,
    [productId, 'gaeru-k9-' + productId.slice(0, 8)]
  );
  await pool.query(
    `INSERT INTO product_variants (id, product_id, sku, name, price_vnd, cost_price_vnd, stock_quantity, active)
     VALUES ($1, $2, $3, 'Bản chuẩn', 1000000, 600000, 100, true)`,
    [variantId, productId, 'SKU-' + variantId.slice(0, 8).toUpperCase()]
  );
  await pool.query(
    `INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity)
     VALUES ($1, $2, 100)
     ON CONFLICT (warehouse_id, variant_id) DO UPDATE SET quantity = 100`,
    [whMain, variantId]
  );
  return { productId, variantId, whMain };
}

async function seedCustomer(pool, { email, phone = '0901234567', deletedAt = null } = {}) {
  const id = randomUUID();
  const cleanEmail = email || `user-${id.slice(0, 8)}@example.com`;
  await pool.query(
    `INSERT INTO customers (id, full_name, email, phone, password_hash, active, deleted_at, email_verified_at)
     VALUES ($1, 'Nguyễn Văn A', $2, $3, 'hash', $4, $5, now())`,
    [id, cleanEmail, phone, deletedAt ? false : true, deletedAt]
  );
  return { id, email: cleanEmail, phone };
}

async function seedOrder(pool, {
  customerId = null,
  status = 'confirmed',
  paymentMethod = 'momo',
  paymentStatus = 'paid',
  subtotalVnd = 1000000,
  shippingFeeVnd = 0,
  discountVnd = 0,
  totalVnd = 1000000,
  voucherCode = '',
  email = 'buyer@example.com',
  phone = '0901234567',
  customerName = 'Nguyễn Văn A',
  address = '123 Lê Lợi, Q1',
  city = 'TP.HCM',
  confirmedAt = null,
  anonymizedAt = null
} = {}) {
  const id = randomUUID();
  const orderNumber = 'GR-' + id.slice(0, 8).toUpperCase();
  await pool.query(
    `INSERT INTO orders (
       id, order_number, customer_id, customer_name, email, phone, address, city,
       payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd,
       discount_vnd, voucher_code, total_vnd, confirmed_at, anonymized_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      id, orderNumber, customerId, customerName, email, phone, address, city,
      paymentMethod, paymentStatus, status, subtotalVnd, shippingFeeVnd,
      discountVnd, voucherCode, totalVnd, confirmedAt, anonymizedAt
    ]
  );
  return { id, orderNumber };
}

test('#01 & #09: paid unshipped orders block customer deletion/purge, and 50 blocked accounts never starve #51', async () => {
  const { pool } = await createPglitePool();
  try {
    const { permanentDeleteCustomer } = require('../src/customer-lifecycle');
    const { purgeDeletedAccounts } = require('../src/account-retention');

    // #01a: Manual permanentDeleteCustomer MUST block when customer has a PAID order in confirmed/processing without shipment
    const prepaidCust = await seedCustomer(pool, { email: 'prepaid@example.com', phone: '0912345678' });
    const prepaidOrder = await seedOrder(pool, {
      customerId: prepaidCust.id,
      status: 'processing',
      paymentMethod: 'momo',
      paymentStatus: 'paid',
      address: '45 Nguyễn Huệ, Quận 1',
      phone: '0912345678'
    });

    await assert.rejects(
      () => permanentDeleteCustomer(pool, prepaidCust.id, { username: 'owner', role: 'owner', source: 'admin' }),
      (err) => err && err.status === 409
    );

    const stillCust = (await pool.query('SELECT id FROM customers WHERE id = $1', [prepaidCust.id])).rows[0];
    const stillOrder = (await pool.query('SELECT phone, address, anonymized_at FROM orders WHERE id = $1', [prepaidOrder.id])).rows[0];
    assert.ok(stillCust, 'customer must remain intact');
    assert.equal(stillOrder.phone, '0912345678');
    assert.equal(stillOrder.address, '45 Nguyễn Huệ, Quận 1');
    assert.equal(stillOrder.anonymized_at, null);

    // #01b & #09: Seed 50 expired deleted accounts blocked by paid processing orders + 1 eligible expired account #51
    const blockedIds = [];
    for (let i = 0; i < 50; i++) {
      const deletedAt = new Date(Date.now() - (400 + (50 - i)) * 86400 * 1000).toISOString();
      const c = await seedCustomer(pool, { email: `blocked-${i}@example.com`, deletedAt });
      await seedOrder(pool, {
        customerId: c.id,
        status: 'confirmed',
        paymentMethod: 'bank_transfer',
        paymentStatus: 'paid',
        address: `Địa chỉ đơn trả trước #${i}`
      });
      blockedIds.push(c.id);
    }
    // Account #51 is newer than the 50 blocked ones, still > 1 year old, and has NO blocking orders
    const eligible51 = await seedCustomer(pool, {
      email: 'eligible-51@example.com',
      deletedAt: new Date(Date.now() - 370 * 86400 * 1000).toISOString()
    });
    const completedOldOrder = await seedOrder(pool, {
      customerId: eligible51.id,
      status: 'completed',
      paymentMethod: 'cod',
      paymentStatus: 'paid'
    });

    const purgedCount = await purgeDeletedAccounts(pool);
    assert.equal(purgedCount, 1, 'account #51 must be purged despite 50 older blocked accounts');

    const gone51 = (await pool.query('SELECT id FROM customers WHERE id = $1', [eligible51.id])).rows;
    assert.equal(gone51.length, 0);
    const anonOrd = (await pool.query('SELECT anonymized_at, email, phone FROM orders WHERE id = $1', [completedOldOrder.id])).rows[0];
    assert.ok(anonOrd.anonymized_at, 'purged customer historical completed order must carry anonymized_at');

    const remainingBlocked = (await pool.query('SELECT COUNT(*)::int AS cnt FROM customers WHERE id = ANY($1::uuid[])', [blockedIds])).rows[0].cnt;
    assert.equal(remainingBlocked, 50, 'all 50 blocked accounts with paid unshipped orders must be preserved');

    // Concurrency guard verification: hasBlockingCustomerActivity locks customer orders FOR UPDATE before checking
    const lifecycleSrc = fs.readFileSync(path.join(ROOT, 'src/customer-lifecycle.js'), 'utf8');
    const lockIdx = lifecycleSrc.indexOf('SELECT id FROM orders WHERE customer_id = $1 ORDER BY id FOR UPDATE');
    const checkIdx = lifecycleSrc.indexOf('buildBlockingOrderExistsSql(\'c.id\', \'o\')');
    assert.ok(lockIdx > 0 && lockIdx < checkIdx, 'orders must be locked FOR UPDATE before evaluating blocking activity');
  } finally {
    await pool.end();
  }
});

test('#02: anonymized orders are rejected by public tracking & return-request while valid guest orders still pass', async () => {
  const { pool } = await createPglitePool();
  try {
    const { anonymizeCustomerOrders } = require('../src/order-deletion');
    const { getOrderTrackingDetails, verifyOrderChallenge } = require('../src/tracking-api');

    const cust = await seedCustomer(pool, { email: 'anon-target@example.com', phone: '0988777666' });
    const ord = await seedOrder(pool, {
      customerId: cust.id,
      status: 'completed',
      paymentStatus: 'paid',
      email: cust.email,
      phone: cust.phone
    });

    await anonymizeCustomerOrders(pool, cust.id);

    const lookupByPhone = await getOrderTrackingDetails(pool, { orderNumber: ord.orderNumber, challenge: '0000000000' });
    const lookupByEmail = await getOrderTrackingDetails(pool, { orderNumber: ord.orderNumber, challenge: 'anonymized@privacy.gaeru.com' });
    assert.equal(lookupByPhone.found, false);
    assert.equal(lookupByEmail.found, false);

    // Valid active guest order MUST still pass lookup & challenge
    const guestOrd = await seedOrder(pool, {
      customerId: null,
      status: 'confirmed',
      paymentMethod: 'cod',
      paymentStatus: 'pending',
      email: 'guest-real@example.com',
      phone: '0933222111',
      customerName: 'Trần Thị Khách',
      address: '88 Hai Bà Trưng, Q1'
    });
    const guestLookup = await getOrderTrackingDetails(pool, { orderNumber: guestOrd.orderNumber, challenge: '0933222111' });
    assert.equal(guestLookup.found, true);

    // Legacy non-anonymized guest order with only a single unusual field (e.g., phone 0000000000 but real email/name/address) must NOT be falsely blocked
    assert.equal(
      verifyOrderChallenge({
        customer_id: null,
        anonymized_at: null,
        customer_name: 'Khách thật',
        email: 'real-legacy@example.com',
        phone: '0000000000',
        address: '10 Trần Hưng Đạo'
      }, 'real-legacy@example.com'),
      true
    );
  } finally {
    await pool.end();
  }
});

test('#04 & #05: MoMo loyalty clawback caps future refunds (including pre-migration backfill), finance retains clawback on cancelled orders, and multi-part full refunds restore redeemed Xu', async () => {
  const { pool } = await createPglitePool();
  try {
    const { earnPoints, redeemPoints, previewEarnClawback } = require('../src/loyalty-api');
    const { getOrderRefundLedger, initiateMomoRefund } = require('../src/momo-refunds');
    const { writeRecord } = require('../src/admin-configuration');
    const express = require('express');
    const { createFinanceApi } = require('../src/finance-api');
    const { randomBytes } = require('node:crypto');

    const config = {
      NODE_ENV: 'test',
      AUTH_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      SESSION_SECRET: 'momo-codex-test-secret'
    };
    const owner = { username: 'owner', role: 'owner', permissions: ['finance.read', 'payments.write', 'orders.write'], source: 'admin' };
    await writeRecord(pool, config, 'payment_momo', {
      partnerCode: 'MOMOTEST',
      accessKey: 'ACCKEY',
      secretKey: 'SECKEY1234567890',
      environment: 'sandbox',
      requestType: 'captureWallet',
      enabled: true
    }, 0, owner);

    const momoOkFetcher = async (_url, init) => {
      const b = JSON.parse(init.body);
      return new Response(JSON.stringify({
        partnerCode: b.partnerCode,
        orderId: b.orderId,
        requestId: b.requestId,
        amount: b.amount,
        transId: 987654321,
        resultCode: 0,
        message: 'Success',
        responseTime: Date.now()
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    // === #04a: Post-migration MoMo refund persists loyalty_clawback_vnd and caps refund #2 ===
    const c1 = await seedCustomer(pool, { email: 'momo-clawback@example.com' });
    const o1 = await seedOrder(pool, { customerId: c1.id, paymentMethod: 'momo', paymentStatus: 'paid', status: 'processing', totalVnd: 1000000, subtotalVnd: 1000000 });
    await pool.query(
      `INSERT INTO payment_attempts (order_id, provider, transaction_ref, amount_vnd, status, provider_transaction_id, expires_at)
       VALUES ($1, 'momo', $2, 1000000, 'paid', '1234567890', now() + interval '1 day')`,
      [o1.id, o1.orderNumber]
    );
    await earnPoints(pool, { customerId: c1.id, orderId: o1.id, orderTotalVnd: 1000000, pointsRatio: 0.01 }); // +10,000 Xu
    // Customer spends all 10,000 Xu on another order -> balance = 0
    const spendOrder = await seedOrder(pool, { customerId: c1.id, totalVnd: 200000, subtotalVnd: 200000 });
    await redeemPoints(pool, { customerId: c1.id, orderId: spendOrder.id, pointsToRedeem: 10000, orderTotalVnd: 200000 });

    const r1 = await initiateMomoRefund(pool, config, {
      orderNumber: o1.orderNumber,
      amountVnd: 400000,
      requestKey: randomUUID(),
      actor: { username: 'owner', role: 'owner', source: 'admin' },
      fetcher: momoOkFetcher
    });
    assert.equal(r1.refund.status, 'succeeded');
    assert.equal(r1.refund.loyaltyClawbackVnd, 10000, 'refund #1 must persist 10,000 VND loyalty_clawback_vnd');

    // Refund #2 for 600,000 MUST be rejected (only 590,000 remains after 400,000 + 10,000 clawback)
    await assert.rejects(
      () => initiateMomoRefund(pool, config, {
        orderNumber: o1.orderNumber,
        amountVnd: 600000,
        requestKey: randomUUID(),
        actor: { username: 'owner', role: 'owner', source: 'admin' },
        fetcher: momoOkFetcher
      }),
      (err) => err && err.status === 409 && /590\.000/.test(err.message)
    );

    // Refund #2 for 590,000 succeeds and settles full 1,000,000 (990,000 cash + 10,000 clawback)
    const r2 = await initiateMomoRefund(pool, config, {
      orderNumber: o1.orderNumber,
      amountVnd: 590000,
      requestKey: randomUUID(),
      actor: { username: 'owner', role: 'owner', source: 'admin' },
      fetcher: momoOkFetcher
    });
    assert.equal(r2.refund.status, 'succeeded');
    const ledgerAfter = await getOrderRefundLedger(pool, { id: o1.id, payment_status: 'paid', total_vnd: 1000000 });
    assert.equal(ledgerAfter.grossRefundableVnd, 0);

    // Finance summary endpoint MUST still preserve the 10,000 VND retained Xu clawback when order is cancelled
    await pool.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [o1.id]);
    const finApp = express();
    finApp.use((req, _res, next) => { req.admin = owner; next(); });
    finApp.use(createFinanceApi(pool));
    const finServer = finApp.listen(0);
    try {
      const port = finServer.address().port;
      const finRes = await fetch(`http://127.0.0.1:${port}/finance/summary`);
      assert.equal(finRes.status, 200);
      const finBody = await finRes.json();
      assert.equal(finBody.summary.salesPaidVnd, 210000, 'live /finance/summary must equal spendOrder (200,000) + retained Xu clawback on cancelled MoMo order (10,000)');
    } finally {
      await new Promise((resolve) => finServer.close(resolve));
    }

    // === #04b: Pre-migration legacy order (Codex exact PGlite scenario: 1,000,000 total, 400,000 refunded, 10,000 Xu deducted in ledger reason, loyalty_clawback_vnd = 0) ===
    const cLegacy = await seedCustomer(pool, { email: 'legacy-momo@example.com' });
    const oLegacy = await seedOrder(pool, { customerId: cLegacy.id, paymentMethod: 'momo', paymentStatus: 'paid', status: 'processing', totalVnd: 1000000, subtotalVnd: 1000000 });
    const paLeg = (await pool.query(
      `INSERT INTO payment_attempts (order_id, provider, transaction_ref, amount_vnd, status, provider_transaction_id, expires_at)
       VALUES ($1, 'momo', $2, 1000000, 'paid', '2234567890', now() + interval '1 day') RETURNING id`,
      [oLegacy.id, oLegacy.orderNumber]
    )).rows[0];
    await pool.query(
      `INSERT INTO momo_refunds (order_id, payment_attempt_id, order_number, refund_order_id, request_id, original_trans_id, amount_vnd, loyalty_clawback_vnd, status, environment, created_by)
       VALUES ($1, $2, $3, 'RF-LEGACY-1', $4, '2234567890', 400000, 0, 'succeeded', 'sandbox', 'owner')`,
      [oLegacy.id, paLeg.id, oLegacy.orderNumber, randomUUID()]
    );
    await pool.query(
      `INSERT INTO customer_loyalty_ledger (customer_id, order_id, type, points, balance_after, reason, event_key)
       VALUES ($1, $2, 'earn', 10000, 10000, 'Tích Xu', $3),
              ($1, $2, 'refund', 0, 0, 'Thu hồi Xu đã tích từ đơn #' || $2 || ': Hoàn MoMo (trừ số dư: 0 Xu, khấu trừ tiền hoàn: 10000 ₫)', $4)`,
      [cLegacy.id, oLegacy.id, `earn:${oLegacy.id}`, `refund-earn:${oLegacy.id}`]
    );

    // Even BEFORE re-running migration backfill, runtime ledger sees 590,000 remaining (NOT 600,000)!
    const legacyLedger = await getOrderRefundLedger(pool, { id: oLegacy.id, payment_status: 'paid', total_vnd: 1000000 }, { receivedVnd: 1000000 });
    assert.equal(legacyLedger.momoClawbackVnd, 10000);
    assert.equal(legacyLedger.grossRefundableVnd, 590000);

    // AND re-running the idempotent SQL backfill populates momo_refunds.loyalty_clawback_vnd = 10,000 durably!
    const migSql = fs.readFileSync(path.join(ROOT, 'db/audit-remediation-20261127-v2.sql'), 'utf8');
    await pool.query(migSql);
    const backfilledRow = (await pool.query("SELECT loyalty_clawback_vnd FROM momo_refunds WHERE refund_order_id = 'RF-LEGACY-1'")).rows[0];
    assert.equal(Number(backfilledRow.loyalty_clawback_vnd), 10000);

    // === #05: Multi-installment full MoMo refund vs single 100% refund on order with BOTH redeemed Xu AND earned Xu ===
    async function runFullRefundScenario(installments) {
      const cust = await seedCustomer(pool, { email: `multi-${installments.join('-')}-${randomUUID().slice(0, 6)}@example.com` });
      // Seed starting balance = 10,000 Xu
      await earnPoints(pool, { customerId: cust.id, orderId: null, orderTotalVnd: 1000000, pointsRatio: 0.01 });
      const ord = await seedOrder(pool, { customerId: cust.id, paymentMethod: 'momo', paymentStatus: 'paid', status: 'processing', subtotalVnd: 1000000, discountVnd: 10000, totalVnd: 990000 });
      await pool.query(
        `INSERT INTO payment_attempts (order_id, provider, transaction_ref, amount_vnd, status, provider_transaction_id, expires_at)
         VALUES ($1, 'momo', $2, 990000, 'paid', '3344556677', now() + interval '1 day')`,
        [ord.id, ord.orderNumber]
      );
      await redeemPoints(pool, { customerId: cust.id, orderId: ord.id, pointsToRedeem: 10000, orderTotalVnd: 1000000 }); // balance -> 0
      await earnPoints(pool, { customerId: cust.id, orderId: ord.id, orderTotalVnd: 500000, pointsRatio: 0.01 }); // +5,000 -> balance = 5,000

      for (const amt of installments) {
        const res = await initiateMomoRefund(pool, config, {
          orderNumber: ord.orderNumber,
          amountVnd: amt,
          requestKey: randomUUID(),
          actor: { username: 'owner', role: 'owner', source: 'admin' },
          fetcher: momoOkFetcher
        });
        assert.equal(res.refund.status, 'succeeded');
      }
      const bal = (await pool.query('SELECT points_balance, clawback_debt_points FROM customer_loyalty WHERE customer_id = $1', [cust.id])).rows[0];
      const previewEnd = await previewEarnClawback(pool, { customerId: cust.id, orderId: ord.id });
      assert.equal(previewEnd.pendingRedeemRefund, 0, 'all redeemed Xu must be refunded on full settlement');
      return { balance: Number(bal.points_balance), debt: Number(bal.clawback_debt_points) };
    }

    const singleRes = await runFullRefundScenario([990000]);
    const multiRes = await runFullRefundScenario([490000, 500000]);
    assert.deepEqual(multiRes, singleRes, '2-installment full refund must leave exact same Xu balance as 1-shot full refund');
    assert.equal(multiRes.balance, 10000, 'customer gets back their 10,000 redeemed Xu while 5,000 earned Xu is revoked');
    assert.equal(multiRes.debt, 0);
  } finally {
    await pool.end();
  }
});

test('#10, #11, #12, #13: Inventory forecast PO idempotency, strict missing-variant rejection, 0 safetyStockDays, and per-warehouse detail velocity + manualSafetyStock', async () => {
  const { pool } = await createPglitePool();
  try {
    const {
      calculateInventoryForecast,
      getVariantForecastDetail,
      upsertReorderSettings,
      createPurchaseOrderFromForecast
    } = require('../src/inventory-forecast');

    const { variantId, whMain } = await seedCatalog(pool);
    const whSub = randomUUID();
    await pool.query("INSERT INTO warehouses (id, code, name, active) VALUES ($1, 'HN', 'Kho Hà Nội', true)", [whSub]);
    await pool.query(
      'INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 10)',
      [whSub, variantId]
    );

    const supId = randomUUID();
    await pool.query("INSERT INTO suppliers (id, code, name, active) VALUES ($1, 'SUP1', 'NCC Test', true)", [supId]);

    // Seed 30 units sold ONLY in whMain (velocity = 1.0/day), 0 sold in whSub
    const ord = await seedOrder(pool, { status: 'completed', paymentStatus: 'paid' });
    await pool.query(
      `INSERT INTO order_stock_allocations (order_id, warehouse_id, variant_id, quantity)
       VALUES ($1, $2, $3, 30)`,
      [ord.id, whMain, variantId]
    );

    // #12: safetyStockDays = 0 must NOT be coerced to 7
    await upsertReorderSettings(pool, {
      warehouseId: whMain,
      variantId,
      leadTimeDays: 7,
      safetyStockDays: 0,
      manualSafetyStock: null,
      manualReorderPoint: null,
      minOrderQuantity: 1,
      targetStockDays: 30
    });
    const listForecast = await calculateInventoryForecast(pool, { days: 30, useCache: false });
    const mainListRow = listForecast.items.find(i => i.warehouseId === whMain && i.variantId === variantId);
    const subListRow = listForecast.items.find(i => i.warehouseId === whSub && i.variantId === variantId);
    assert.equal(mainListRow.safetyStockDays, 0);
    assert.equal(mainListRow.safetyStock, 0);
    assert.equal(mainListRow.reorderPoint, 7, 'leadTime(7)*1 + safety(0) = 7, NOT 14');
    assert.equal(subListRow.reorderPoint, 0);

    // #13: Detail view must use per-warehouse velocity (whSub = 0, NOT global 1.0) AND respect manualSafetyStock
    await upsertReorderSettings(pool, {
      warehouseId: whMain,
      variantId,
      leadTimeDays: 7,
      safetyStockDays: 0,
      manualSafetyStock: 5,
      manualReorderPoint: null,
      minOrderQuantity: 1,
      targetStockDays: 30
    });
    const detail = await getVariantForecastDetail(pool, variantId);
    const mainDetail = detail.warehousesBreakdown.find(w => w.warehouseId === whMain);
    const subDetail = detail.warehousesBreakdown.find(w => w.warehouseId === whSub);
    assert.equal(mainDetail.safetyStockDays, 0);
    assert.equal(mainDetail.safetyStock, 5, 'manualSafetyStock must be applied in detail view');
    assert.equal(mainDetail.reorderPoint, 12, 'leadTime(7) + manualSafetyStock(5) = 12');
    assert.equal(subDetail.salesVelocity, 0, 'whSub velocity must NOT inherit global velocity');
    assert.equal(subDetail.reorderPoint, 0);
    assert.equal(subDetail.daysOfSupply, null);

    // #11: Mixed valid + missing variant MUST reject with 400 and create 0 POs
    const missingVariantId = randomUUID();
    await assert.rejects(
      () => createPurchaseOrderFromForecast(pool, {
        supplierId: supId,
        warehouseId: whMain,
        items: [
          { variantId, quantity: 5, unitCostVnd: 600000 },
          { variantId: missingVariantId, quantity: 3, unitCostVnd: 500000 }
        ],
        actor: { username: 'owner', role: 'owner', source: 'admin' }
      }),
      (err) => err && err.status === 400 && Array.isArray(err.missingVariantIds) && err.missingVariantIds.includes(missingVariantId)
    );
    const poCountAfterReject = (await pool.query('SELECT COUNT(*)::int AS cnt FROM purchase_orders')).rows[0].cnt;
    assert.equal(poCountAfterReject, 0, 'no PO number or row should be created when a variant is missing');

    // #10: Retrying with same requestKey returns the exact same PO without duplicates; changed payload gets 409
    const reqKey = randomUUID();
    const firstPo = await createPurchaseOrderFromForecast(pool, {
      supplierId: supId,
      warehouseId: whMain,
      requestKey: reqKey,
      items: [{ variantId, quantity: 5, unitCostVnd: 600000 }],
      actor: { username: 'owner', role: 'owner', source: 'admin' }
    });
    const secondPo = await createPurchaseOrderFromForecast(pool, {
      supplierId: supId,
      warehouseId: whMain,
      requestKey: reqKey,
      items: [{ variantId, quantity: 5, unitCostVnd: 600000 }],
      actor: { username: 'owner', role: 'owner', source: 'admin' }
    });
    assert.equal(secondPo.replayed, true);
    assert.equal(secondPo.purchaseOrder.number, firstPo.purchaseOrder.number);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS cnt FROM purchase_orders')).rows[0].cnt, 1);

    await assert.rejects(
      () => createPurchaseOrderFromForecast(pool, {
        supplierId: supId,
        warehouseId: whMain,
        requestKey: reqKey,
        items: [{ variantId, quantity: 9, unitCostVnd: 600000 }],
        actor: { username: 'owner', role: 'owner', source: 'admin' }
      }),
      (err) => err && err.status === 409
    );
  } finally {
    await pool.end();
  }
});

test('#14, #15, #18: Tracking preserves null unconfirmed shipping/total, avoids double-counting restored Xu, and uses immutable confirmed_at excluding failed payment callbacks', async () => {
  const { pool } = await createPglitePool();
  try {
    const { getOrderTrackingDetails } = require('../src/tracking-api');
    const cust = await seedCustomer(pool, { email: 'track-test@example.com', phone: '0977666555' });

    // #14: Null shippingFeeVnd & totalVnd preserved (NOT coerced to 0)
    const pendingFeeOrd = await seedOrder(pool, {
      customerId: cust.id,
      status: 'pending',
      paymentMethod: 'cod',
      paymentStatus: 'pending',
      subtotalVnd: 100000,
      shippingFeeVnd: null,
      discountVnd: 0,
      totalVnd: null,
      email: cust.email,
      phone: cust.phone
    });
    const rNull = await getOrderTrackingDetails(pool, { orderNumber: pendingFeeOrd.orderNumber, challenge: cust.phone });
    assert.equal(rNull.order.summary.shippingFeeVnd, null);
    assert.equal(rNull.order.summary.totalVnd, null);

    // Zero fee vs positive fee still distinct
    const freeOrd = await seedOrder(pool, {
      customerId: cust.id, status: 'confirmed', shippingFeeVnd: 0, subtotalVnd: 100000, totalVnd: 100000, email: cust.email, phone: cust.phone
    });
    const rZero = await getOrderTrackingDetails(pool, { orderNumber: freeOrd.orderNumber, challenge: cust.phone });
    assert.equal(rZero.order.summary.shippingFeeVnd, 0);
    assert.equal(rZero.order.summary.totalVnd, 100000);

    // Frontend tracking.js renders "Chờ xác nhận" for null shipping/total
    const trackingJs = fs.readFileSync(path.join(ROOT, 'tracking.js'), 'utf8');
    assert.match(trackingJs, /sum\.shippingFeeVnd == null \? 'Chờ xác nhận'/);
    assert.match(trackingJs, /sum\.totalVnd == null \? 'Chờ xác nhận'/);

    // #15: Restored order with redeem 10k -> refund 10k -> redeem 10k reports 10,000 Xu (NOT 20,000)
    const restoredOrd = await seedOrder(pool, {
      customerId: cust.id,
      status: 'confirmed',
      subtotalVnd: 100000,
      discountVnd: 30000,
      voucherCode: 'SALE20K',
      shippingFeeVnd: 0,
      totalVnd: 70000,
      email: cust.email,
      phone: cust.phone
    });
    await pool.query(
      `INSERT INTO customer_loyalty_ledger (customer_id, order_id, type, points, balance_after, reason, event_key)
       VALUES ($1, $2, 'redeem', -10000, 0, 'Lần 1', $3),
              ($1, $2, 'refund', 10000, 10000, 'Hoàn hủy', $4),
              ($1, $2, 'redeem', -10000, 0, 'Khôi phục', $5)`,
      [cust.id, restoredOrd.id, `redeem:${restoredOrd.id}`, `refund-redeem:${restoredOrd.id}`, `redeem:${restoredOrd.id}:restore:1`]
    );
    const rRestored = await getOrderTrackingDetails(pool, { orderNumber: restoredOrd.orderNumber, challenge: cust.phone });
    assert.equal(rRestored.order.summary.loyaltyPointsRedeemed, 10000);
    assert.equal(rRestored.order.summary.loyaltyDiscountVnd, 10000);

    // #18: Failed payment callback MUST NOT become confirmed_at, and later updated_at MUST NOT move confirmed timestamp
    const failedAt = '2026-11-20T08:00:00.000Z';
    const paidAt = '2026-11-20T09:00:00.000Z';
    const laterUpdate = '2026-11-25T15:00:00.000Z';
    const histOrd = await seedOrder(pool, {
      customerId: cust.id, status: 'shipped', paymentStatus: 'paid', confirmedAt: null, email: cust.email, phone: cust.phone
    });
    await pool.query('UPDATE orders SET updated_at = $2 WHERE id = $1', [histOrd.id, laterUpdate]);
    await pool.query(
      `INSERT INTO audit_events (actor_username, actor_name, actor_role, actor_source, action, entity_type, entity_id, metadata, created_at)
       VALUES ('momo','momo','system','payment_gateway','payment.momo.callback','order',$1,'{"successful":false}'::jsonb,$2),
              ('momo','momo','system','payment_gateway','payment.momo.callback','order',$1,'{"successful":true}'::jsonb,$3)`,
      [histOrd.id, failedAt, paidAt]
    );
    const rHist = await getOrderTrackingDetails(pool, { orderNumber: histOrd.orderNumber, challenge: cust.phone });
    const confirmedStep = rHist.order.timeline.find(t => t.step === 'confirmed');
    assert.equal(new Date(confirmedStep.timestamp).toISOString(), paidAt, 'confirmed timestamp must match successful payment, ignoring failed callback and updated_at');

    // Legacy confirmed order with no confirmed_at and no audit events returns null timestamp (not updated_at)
    const legacyNoHist = await seedOrder(pool, {
      customerId: cust.id, status: 'completed', paymentStatus: 'paid', confirmedAt: null, email: cust.email, phone: cust.phone
    });
    const rLegacy = await getOrderTrackingDetails(pool, { orderNumber: legacyNoHist.orderNumber, challenge: cust.phone });
    assert.equal(rLegacy.order.timeline.find(t => t.step === 'confirmed').timestamp, null);
  } finally {
    await pool.end();
  }
});

test('#16: GPU AI client keeps timeout active while reading slow JSON and binary response bodies', async () => {
  const { checkGpuHealth, embedTexts, segmentForegroundMask } = require('../src/lib/gpu-ai-client');

  const slowJsonTransport = async () => ({
    ok: true,
    status: 200,
    json: () => new Promise(resolve => setTimeout(() => resolve({ ok: true, data: [{ embedding: [1, 0] }] }), 180))
  });
  const slowBinTransport = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => '0.5' },
    arrayBuffer: () => new Promise(resolve => setTimeout(() => resolve(new Uint8Array(4).buffer), 180))
  });

  const t0 = Date.now();
  const health = await checkGpuHealth({ timeoutMs: 25, transport: slowJsonTransport });
  const embed = await embedTexts(['micro khong day'], { timeoutMs: 25, transport: slowJsonTransport });
  const mask = await segmentForegroundMask(Buffer.alloc(2 * 2 * 3, 128), { width: 2, height: 2, timeoutMs: 25, transport: slowBinTransport });
  const elapsed = Date.now() - t0;

  assert.equal(health, null, 'checkGpuHealth must time out on slow body');
  assert.equal(embed, null, 'embedTexts must time out on slow body');
  assert.equal(mask, null, 'segmentForegroundMask must time out on slow body');
  assert.ok(elapsed < 400, `timeouts should abort promptly instead of waiting for 3x180ms bodies (elapsed=${elapsed}ms)`);
});

test('#07: Cluster rolling reload records partial/failed status when a replacement worker fails readiness', async () => {
  const writtenFiles = new Map();
  const workers = [];
  const timers = new Set();
  const cluster = {
    isPrimary: true,
    setupPrimary() {},
    fork(env) {
      const worker = new EventEmitter();
      worker.process = { pid: workers.length + 2000 };
      worker.env = env;
      worker.dead = false;
      worker.isConnected = () => !worker.dead;
      worker.isDead = () => worker.dead;
      worker.send = () => {};
      worker.disconnect = () => { worker.dead = true; worker.emit('exit', 0, null); };
      worker.kill = worker.disconnect;
      const idx = workers.push(worker) - 1;
      queueMicrotask(() => {
        // Replacement for slot 0 (idx === 2) crashes before WORKER_READY
        if (idx === 2) {
          worker.dead = true;
          worker.emit('exit', 1, null);
        } else {
          worker.emit('message', { type: 'WORKER_READY' });
        }
      });
      return worker;
    }
  };
  const fakeFs = {
    existsSync: () => false,
    mkdirSync() {},
    writeFileSync(p, c) { writtenFiles.set(path.basename(p), c); },
    renameSync(src, dst) {
      const val = writtenFiles.get(path.basename(src));
      writtenFiles.delete(path.basename(src));
      writtenFiles.set(path.basename(dst), val);
    }
  };
  const fakeRequire = id => id === 'node:cluster' ? cluster
    : id === 'node:fs' ? fakeFs
    : id === 'node:os' ? { cpus: () => [1, 2], setPriority() {}, constants: { priority: { PRIORITY_ABOVE_NORMAL: 0 } } }
    : id === 'node:path' ? path
    : id.includes('cluster-fanout') ? { defaultFanoutHub: { handleWorkerMessage() {} } }
    : require(id);

  const mod = { exports: {} };
  vm.runInNewContext('(function(){' + fs.readFileSync(require.resolve('../src/cluster-master'), 'utf8') + '\n})()', {
    require: fakeRequire,
    module: mod,
    __dirname: path.dirname(require.resolve('../src/cluster-master')),
    console: { log() {} },
    process: { env: { CLUSTER_WORKERS: '2', GAERU_RELEASE_SHA: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, argv: [], pid: 999, on() {} },
    setInterval() { return { unref() {} }; },
    setTimeout(fn, ms) { const t = { fn, ms, unref() {} }; timers.add(t); return t; },
    clearTimeout(t) { timers.delete(t); }
  });

  const reloadTask = mod.exports.executeRollingReload();
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 10; j++) await Promise.resolve();
    for (const t of [...timers]) { if (t.ms === 1000) { timers.delete(t); t.fn(); } }
  }
  const outcome = await reloadTask;
  assert.equal(outcome.status, 'partial');
  assert.deepEqual(Array.from(outcome.failedSlots), [0]);
  assert.deepEqual(Array.from(outcome.upgradedSlots), [1]);

  const statusJson = JSON.parse(writtenFiles.get('cluster-reload-status.json'));
  assert.equal(statusJson.status, 'partial');
  assert.deepEqual(statusJson.failedSlots, [0]);
});

test('#03, #06, #08, #17, #19: Backup/restore/deploy scripts & .gitattributes hardening', () => {
  // #03: gdrive-sync checks content integrity via rclone check before pruning and preserves remote backups on empty source
  const gdriveSync = fs.readFileSync(path.join(ROOT, 'scripts/mi6-backup/gaeru-gdrive-sync.sh'), 'utf8');
  assert.ok(!gdriveSync.includes('\r'), 'gaeru-gdrive-sync.sh must stay pure LF');
  assert.match(gdriveSync, /run_rclone check "\$src_chroot" "\$\{REMOTE_ROOT\}\/\$\{subdir\}"/);
  assert.match(gdriveSync, /SYNC_STATUS="missing_backup"/);
  assert.match(gdriveSync, /prune_remote_subdir "media" --filter "- \$\{newest_base\}" --filter "- \$\{newest_base\}\.sha256"/);

  // #06 & #08: full-restore removes 48h/7d caps, matches same-timestamp complete PG set, and stages npm ci atomically
  const fullRestore = fs.readFileSync(path.join(ROOT, 'scripts/mi6-backup/gaeru-full-restore.sh'), 'utf8');
  assert.ok(!fullRestore.includes('\r'), 'gaeru-full-restore.sh must stay pure LF');
  assert.doesNotMatch(fullRestore, /--max-age\s+(48h|7d)/);
  assert.match(fullRestore, /select_latest_complete_pg_set/);
  assert.match(fullRestore, /gaeru-npm-stage/);
  assert.match(fullRestore, /cd \/storage\/apps\/gaeru && node -e/);

  // #06, #07, #17: sync-to-mi6 stages npm ci atomically, verifies cluster-reload-status.json, rebuilds GPU C/C++ via atomic mv -f, and parses JSON health strictly
  const syncPs1 = fs.readFileSync(path.join(ROOT, 'scripts/sync-to-mi6.ps1'), 'utf8');
  assert.match(syncPs1, /NPM_STAGE="\/storage\/apps\/\.gaeru-npm-stage\.\$\$"/);
  assert.match(syncPs1, /verify_workers_on_release/);
  assert.match(syncPs1, /d && \(d\.ok === true \|\| d\.status === "ok"\)/);
  assert.match(syncPs1, /mv -f \/storage\/gpu-ai-build\/gaeru-gpu-ai\.new \/usr\/local\/bin\/gaeru-gpu-ai/);
  assert.match(syncPs1, /mv -f \/storage\/gpu-ai-build\/libHybrisOpenCL\.so\.new \/usr\/local\/lib\/libHybrisOpenCL\.so/);

  // #19: .gitattributes enforces LF on *.sql and migration v2 is pure LF
  const gitattrs = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
  assert.match(gitattrs, /^\*\.sql text eol=lf/m);
  const migV2 = fs.readFileSync(path.join(ROOT, 'db/audit-remediation-20261127-v2.sql'), 'utf8');
  assert.ok(!migV2.includes('\r'), 'db/audit-remediation-20261127-v2.sql must stay pure LF');

  // Optional live awk check for #08 if bash/awk available (Git Bash / WSL / Linux)
  const bashProbe = spawnSync('bash', ['-c', 'command -v awk'], { encoding: 'utf8' });
  if (bashProbe.status === 0) {
    const sampleListing = [
      '2026-11-27 03:00:01|gaeru_store-20261127-030001.dump.gpg|1024',
      // Incomplete newest set (missing .sql.gz.gpg!) -> must fall back to 20261124 (3 days old!)
      '2026-11-27 03:00:02|gaeru_store-20261127-030001.dump.gpg.sha256|96',
      '2026-11-24 03:00:01|gaeru_store-20261124-030001.dump.gpg|2048',
      '2026-11-24 03:00:02|gaeru_store-20261124-030001.dump.gpg.sha256|96',
      '2026-11-24 03:00:03|gaeru_store-20261124-030001.sql.gz.gpg|4096',
      '2026-11-24 03:00:04|gaeru_store-20261124-030001.sql.gz.gpg.sha256|96'
    ].join('\n');
    const awkScript = `
      printf '%s\\n' "$1" | awk -F'|' '
        $3 + 0 > 0 { ts[$2] = $1; present[$2] = 1 }
        END {
          for (f in present) {
            if (f ~ /^gaeru_store-20.*\\.dump\\.gpg$/) {
              stamp = f; sub(/^gaeru_store-/, "", stamp); sub(/\\.dump\\.gpg$/, "", stamp)
              dump_f = "gaeru_store-" stamp ".dump.gpg"
              sql_f = "gaeru_store-" stamp ".sql.gz.gpg"
              if (present[dump_f] && present[dump_f ".sha256"] && present[sql_f] && present[sql_f ".sha256"]) {
                print ts[dump_f] "|" stamp "|" dump_f "|" sql_f
              }
            }
          }
        }' | sort -r | head -n 1
    `;
    const res = spawnSync('bash', ['-c', awkScript, '_', sampleListing], { encoding: 'utf8' });
    assert.equal(res.status, 0);
    assert.match(res.stdout.trim(), /20261124-030001\|gaeru_store-20261124-030001\.dump\.gpg\|gaeru_store-20261124-030001\.sql\.gz\.gpg$/);
  }
});
