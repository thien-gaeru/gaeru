
async function resolveOrderAccessToken({ orderId, orderNumber, customerId }, config, pool) {
  const secret = config?.ORDER_ACCESS_TOKEN_SECRET || config?.SESSION_SECRET || process.env.ORDER_ACCESS_TOKEN_SECRET || process.env.SESSION_SECRET;
  const { generateOrderAccessToken } = require('../domain/payments/order-idempotency-policy');
  try {
    const token = generateOrderAccessToken({ orderId, orderNumber, customerId }, secret);
    return { orderAccessToken: token };
  } catch (tokenErr) {
    if (tokenErr.code === 'MISSING_ORDER_TOKEN_SECRET') {
      console.error('[CRITICAL_SECURITY_CONFIG] Thieu SESSION_SECRET / ORDER_ACCESS_TOKEN_SECRET (>= 32 ky tu) khi cap orderAccessToken cho don ' + orderNumber + '. Khach vang lai se khong the truy cap lai don hang!');
      try {
        const { alertSystem } = require('../system-alerts');
        await alertSystem(pool, {
          severity: 'critical',
          source: 'order_access_token_security',
          message: '[CAU HINH THIEU BAO MAT] Don hang ' + orderNumber + ' duoc xu ly nhung he thong thieu SESSION_SECRET / ORDER_ACCESS_TOKEN_SECRET du manh (>= 32 ky tu). Khach vang lai khong duoc cap orderAccessToken!',
          metadata: { orderNumber, orderId, customerId },
          config
        });
      } catch {}
      return {
        orderAccessToken: null,
        orderAccessTokenWarning: 'Cau hinh bao mat he thong chua hoan tat; khong the tao token truy cap don cho khach vang lai.'
      };
    }
    throw tokenErr;
  }
}

'use strict';

const crypto = require('node:crypto');
const { createHash } = crypto;
const { rateLimit } = require('express-rate-limit');
const { requireCsrf } = require('../security');
const { withTransaction } = require('../db');
const { buildVnpayPaymentUrl, verifyVnpayQuery } = require('../vnpay');
const { decoratePublicProductImages } = require('../lib/public-image-urls');
const { PricingEngine } = require('../domain/pricing/pricing-engine');
const { PaymentService } = require('../domain/payments/payment-service');
const { buildScopedClientReference } = require('../domain/payments/order-idempotency-policy');
const { orderSchema } = require('./store-schemas');
const { allocateOptimalCarrier, loadProducts, getSettings } = require('./carrier-and-catalog-loader');

function attachPublicAndCheckoutRoutes(router, pool, {
  getVnpayConfig,
  getPaymentChannels,
  paymentFetcher,
  publicBaseUrl,
  inventory,
  finance = require('../finance-api'),
  audit = require('../audit').appendAudit,
  shippingChoices,
  checkoutAccounts,
  config
}) {
  const orderLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Quá nhiều yêu cầu đặt hàng. Vui lòng thử lại sau.' }
  });

  router.get('/products', async (req, res) => {
    const products = await loadProducts(pool, { search: String(req.query.q || '') });
    res.json(decoratePublicProductImages({ products }));
  });

  router.get('/products/:slug', async (req, res) => {
    const products = await loadProducts(pool);
    const product = products.find((item) => item.slug === req.params.slug);
    if (!product) return res.status(404).json({ error: 'Không tìm thấy sản phẩm.' });
    res.json(decoratePublicProductImages({ product }));
  });

  router.get('/settings/public', async (req, res) => {
    const settings = await getSettings(pool, ['shipping_note', 'shipping_rates']);
    let publicCarriers = [];
    if (shippingChoices) {
      try {
        const verified = await require('../shipping-choice').availableCarriers(pool);
        if (verified && verified.length) {
          publicCarriers = verified.map(({ id, name }) => ({ id, name }));
        } else {
          const connCheck = await pool.query('SELECT count(*)::int AS cnt FROM shipping_carrier_connections').catch(() => ({ rows: [] }));
          if (connCheck.rows[0]?.cnt === 0) {
            publicCarriers = [
              { id: 'ghn', name: 'Giao Hàng Nhanh (GHN)' },
              { id: 'ghtk', name: 'Giao Hàng Tiết Kiệm (GHTK)' },
              { id: 'viettel', name: 'Viettel Post' },
              { id: 'spx', name: 'Shopee Express (SPX)' }
            ];
          }
        }
      } catch {}
    }
    res.json({
      ...(shippingChoices ? { shippingCarriers: publicCarriers } : {}),
      shippingNote: settings.shipping_note || '',
      shippingRates: settings.shipping_rates || {},
      paymentMethods: req.paymentChannels?.methods || ['cod', ...(req.vnpayConfig ? ['vnpay'] : [])],
      ...(req.paymentChannels?.bankTransfer ? { bankTransfer: req.paymentChannels.bankTransfer } : {}),
      ...(req.paymentChannels?.cod ? { cod: req.paymentChannels.cod } : {}),
      ordersEnabled: req.ordersEnabled
    });
  });

  router.get('/payments/vnpay/return', (req, res) => {
    if (!req.vnpayCallbackConfig) return res.sendStatus(404);
    const { valid, parameters } = verifyVnpayQuery(req.query, req.vnpayCallbackConfig.hashSecret);
    if (!valid || parameters.vnp_TmnCode !== req.vnpayCallbackConfig.tmnCode) {
      return res.redirect('/payment-result.html?result=invalid');
    }
    const successful = parameters.vnp_ResponseCode === '00' && parameters.vnp_TransactionStatus === '00';
    const query = new URLSearchParams({
      result: successful ? 'processing' : 'failed',
      order: parameters.vnp_TxnRef || ''
    });
    res.redirect(`/payment-result.html?${query}`);
  });

  router.get('/payments/vnpay/ipn', async (req, res, next) => {
    if (!req.vnpayCallbackConfig) return res.status(404).json({ RspCode: '99', Message: 'Provider unavailable' });
    try {
      const { valid, parameters } = verifyVnpayQuery(req.query, req.vnpayCallbackConfig.hashSecret);
      if (!valid || parameters.vnp_TmnCode !== req.vnpayCallbackConfig.tmnCode) {
        return res.json({ RspCode: '97', Message: 'Invalid signature' });
      }
      if (parameters.vnp_Command !== undefined && parameters.vnp_Command !== 'pay') {
        return res.json({ RspCode: '99', Message: 'Unsupported command' });
      }

      const result = await withTransaction(pool, async (client) => {
        const attemptResult = await client.query(
          `SELECT p.id, p.amount_vnd AS "amountVnd", p.status AS "attemptStatus",
                  o.id AS "orderId", o.total_vnd AS "totalVnd", o.payment_status AS "paymentStatus"
           FROM payment_attempts p JOIN orders o ON o.id = p.order_id
           WHERE p.transaction_ref = $1 AND p.provider = 'vnpay'
           FOR UPDATE OF p, o`,
          [parameters.vnp_TxnRef]
        );
        const attempt = attemptResult.rows[0];
        if (!attempt) return { code: '01', message: 'Order not found' };
        const amount = Number(parameters.vnp_Amount);
        if (!Number.isSafeInteger(amount) || amount !== attempt.amountVnd * 100 || attempt.totalVnd !== attempt.amountVnd) {
          return { code: '04', message: 'Invalid amount' };
        }
        if (attempt.attemptStatus === 'paid' || attempt.paymentStatus === 'paid') {
          return { code: '02', message: 'Order already confirmed' };
        }

        const successful = parameters.vnp_ResponseCode === '00' && parameters.vnp_TransactionStatus === '00';
        await client.query(
          `UPDATE payment_attempts SET status = $2, provider_transaction_id = $3, response_code = $4, updated_at = now()
           WHERE id = $1`,
          [attempt.id, successful ? 'paid' : 'failed', parameters.vnp_TransactionNo || null, parameters.vnp_ResponseCode || null]
        );
        if (successful) {
          const ledger = finance || require('../finance-api');
          await ledger.recordFullOrderPayment(client, {
            order: { id: attempt.orderId, order_number: parameters.vnp_TxnRef, payment_method: 'vnpay', total_vnd: attempt.totalVnd },
            actor: { username: 'vnpay', source: 'payment_gateway' }
          });
          await client.query(
            "UPDATE orders SET payment_status = 'paid', status = CASE WHEN status IN ('pending', 'confirmed') THEN 'processing' ELSE status END, updated_at = now() WHERE id = $1",
            [attempt.orderId]
          );
        }
        await audit(client, {
          actor: { username: 'vnpay', source: 'payment_gateway' },
          action: 'payment.vnpay.callback',
          entityType: 'order',
          entityId: attempt.orderId,
          metadata: { successful, amountVnd: attempt.amountVnd, responseCode: parameters.vnp_ResponseCode || null }
        });
        if (req.paymentChannels?.versions) {
          await require('../payment-channels').recordGatewayEvidence(client, 'vnpay', req.paymentChannels.versions.vnpay, {
            enabled: req.paymentChannels.methods.includes('vnpay')
          });
        }
        return { code: '00', message: 'Confirm Success' };
      });
      res.json({ RspCode: result.code, Message: result.message });
    } catch (error) {
      next(error);
    }
  });

  router.get('/payments/order-status', async (req, res, next) => {
    try {
      const orderNumber = req.query.order;
      if (!orderNumber) return res.status(400).json({ error: 'Thiếu mã đơn hàng.' });

      const { PaymentService } = require('../domain/payments/payment-service');
      const identityProof = PaymentService.extractIdentityProofFromRequest(req);
      const secret = config?.SESSION_SECRET || process.env.SESSION_SECRET;

      const result = await PaymentService.getOrderPaymentStatus(pool, orderNumber, identityProof, { secret });
      if (!result) return res.status(404).json({ error: 'Không tìm thấy đơn hàng.' });
      return res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/orders/:orderNumber/retry-payment',
    (req, res, next) => {
      if (!req.ordersEnabled) return res.status(503).json({ error: 'GAERU đang tạm dừng tiếp nhận đơn hàng trực tuyến.' });
      next();
    },
    orderLimit,
    requireCsrf,
    async (req, res, next) => {
      try {
        const orderNumber = require('../payment-channels').extractOrderNumber(req.params.orderNumber);
        if (!orderNumber) return res.status(400).json({ error: 'Mã đơn hàng không hợp lệ.' });

        const token = req.headers['x-order-token'] ||
                      (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null) ||
                      req.body?.orderAccessToken ||
                      req.body?.token ||
                      req.query?.token;

        const retried = await require('../payment-channels').retryGatewayOrderPayment(pool, {
          orderNumber,
          orderAccessToken: token,
          sessionCustomerId: req.session?.customer?.id,
          sessionCustomerEmail: req.session?.customer?.email,
          sessionCustomerPhone: req.session?.customer?.phone,
          sessionCreatedOrders: req.session?.createdOrders,
          config: config || {},
          settings: null,
          baseUrl: publicBaseUrl,
          fetcher: paymentFetcher,
          inventory,
          finance,
          audit,
          actor: { username: req.session?.customer?.email || 'customer', source: 'payment_retry' }
        });
        if (!retried) return res.status(404).json({ error: 'Không tìm thấy đơn hàng.' });
        if (retried.status === 202) {
          res.setHeader('Retry-After', String(retried.retryAfterSeconds || 3));
        }
        const { status = 200, ...payload } = retried;
        return res.status(status).json(payload);
      } catch (error) {
        if (error.status) {
          return res.status(error.status).json({
            error: error.message,
            ...(error.code ? { code: error.code } : {}),
            ...(error.ambiguous !== undefined ? { ambiguous: error.ambiguous } : {}),
            ...(error.orderId ? { orderId: error.orderId } : {}),
            ...(error.orderNumber ? { orderNumber: error.orderNumber } : {}),
            ...(error.providerRequestId ? { providerRequestId: error.providerRequestId } : {}),
            ...(error.reconciliationStatus ? { reconciliationStatus: error.reconciliationStatus } : {})
          });
        }
        next(error);
      }
    }
  );

  router.get('/payments/:provider/return', async (req, res, next) => {
    const provider = String(req.params.provider || '');
    if (!['9pay', 'momo', 'zalopay'].includes(provider)) return next();
    if (provider === '9pay') return res.sendStatus(404);
    const channelConfig = req.paymentChannels?.callbackConfigs?.[provider] || req.paymentChannels?.configs?.[provider];
    if (!channelConfig) return res.sendStatus(404);
    const verified = require('../payment-channels').verifyGatewayPayload(provider, req.query, channelConfig);
    const order = require('../payment-channels').extractOrderNumber(
      verified.orderNumber || req.query.orderId || req.query.apptransid || req.query.app_trans_id || req.query.order || ''
    );
    const query = new URLSearchParams({
      result: verified.valid ? (verified.successful ? 'processing' : 'failed') : 'pending',
      provider,
      order
    });
    res.redirect('/payment-result.html?' + query);
  });

  const handleGatewayIpn = async (req, res, next) => {
    const provider = String(req.params.provider || '');
    if (!['9pay', 'momo', 'zalopay', 'bank_transfer'].includes(provider)) return next();
    if (provider === '9pay') return res.status(503).json({ code: '99', message: 'Provider adapter unavailable' });
    try {
      const channelConfig = req.paymentChannels?.callbackConfigs?.[provider] || req.paymentChannels?.configs?.[provider];
      if (!channelConfig) return res.status(404).json({ code: '99', message: 'Provider unavailable' });
      if (req.method !== 'POST') return res.status(405).end();
      const verified = require('../payment-channels').verifyGatewayPayload(provider, req.body || {}, channelConfig);
      if (!verified.valid) return res.status(400).json({ code: '97', return_code: -1, resultCode: 97, message: 'Invalid callback' });
      const outcome = await withTransaction(pool, async (client) => {
        const row = (await client.query(
          'SELECT provider_request_id FROM payment_attempts WHERE transaction_ref = $1 AND provider = $2',
          [verified.orderNumber, provider]
        )).rows[0];
        if (!row) return { code: '01', matched: false, message: 'Order not found' };
        const reqId = provider === 'momo' ? verified.requestId : verified.providerOrderId;
        if (row.provider_request_id && row.provider_request_id !== reqId) {
          return { code: '97', matched: false, message: 'Provider request mismatch' };
        }
        if (!row.provider_request_id && reqId) {
          await client.query(
            'UPDATE payment_attempts SET provider_request_id = COALESCE(provider_request_id, $3) WHERE transaction_ref = $1 AND provider = $2',
            [verified.orderNumber, provider, reqId]
          );
        }
        const reconciled = await require('../payment-channels').reconcilePrepaidOrder(client, {
          provider,
          orderNumber: verified.orderNumber,
          amountVnd: verified.amountVnd,
          successful: verified.successful,
          providerTransactionId: verified.providerTransactionId,
          responseCode: verified.responseCode,
          finance,
          audit
        });
        if (reconciled.matched && req.paymentChannels?.versions) {
          await require('../payment-channels').recordGatewayEvidence(client, provider, req.paymentChannels.versions[provider], {
            enabled: req.paymentChannels.methods.includes(provider)
          });
        }
        return reconciled;
      });
      if (provider === 'zalopay') {
        return res.json({
          return_code: outcome.code === '00' || outcome.code === '02' ? 1 : 0,
          return_message: outcome.message,
          orderStatus: outcome.orderStatus,
          paymentStatus: outcome.paymentStatus
        });
      }
      if (provider === 'momo') {
        return outcome.matched ? res.status(204).end() : res.status(409).json({ resultCode: Number(outcome.code) || 99, message: outcome.message });
      }
      return res.json({ code: outcome.code, message: outcome.message });
    } catch (error) {
      next(error);
    }
  };

  router.get('/payments/:provider/ipn', handleGatewayIpn);
  router.post('/payments/:provider/ipn', handleGatewayIpn);
  router.post('/payments/bank_transfer/webhook', (req, res, next) => {
    req.params.provider = 'bank_transfer';
    return handleGatewayIpn(req, res, next);
  });

  router.post(
    '/orders',
    (req, res, next) => {
      if (!req.ordersEnabled) return res.status(503).json({ error: 'GAERU đang tạm dừng tiếp nhận đơn hàng trực tuyến.' });
      next();
    },
    orderLimit,
    requireCsrf,
    async (req, res, next) => {
      let parsed = null;
      let customerEmail = '';
      let customerPhone = '';
      let rawClientReference = null;
      let scopedClientReference = null;
      try {
        parsed = orderSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: 'Thông tin đặt hàng chưa hợp lệ.', details: parsed.error.issues });
        }
        if (parsed.data.paymentMethod === 'vnpay' && !req.vnpayConfig) {
          return res.status(503).json({ error: 'VNPAY chưa được cấu hình trên máy chủ.' });
        }
        if (req.paymentChannels && !req.paymentChannels.methods.includes(parsed.data.paymentMethod)) {
          return res.status(503).json({ error: 'Phương thức thanh toán đã chọn hiện chưa khả dụng.' });
        }
        if (!req.paymentChannels && ['bank_transfer', '9pay', 'momo', 'zalopay'].includes(parsed.data.paymentMethod)) {
          return res.status(503).json({ error: 'Kênh thanh toán chưa được cấu hình trên máy chủ.' });
        }
        if (parsed.data.paymentMethod === '9pay') {
          return res.status(503).json({ error: '9Pay chưa sẵn sàng nhận thanh toán.' });
        }

        const uniqueItems = new Map();
        for (const item of parsed.data.items) {
          uniqueItems.set(item.variantId, (uniqueItems.get(item.variantId) || 0) + item.quantity);
        }
        if ([...uniqueItems.values()].some((quantity) => quantity > 99)) {
          return res.status(400).json({ error: 'Mỗi phiên bản chỉ được đặt tối đa 99 sản phẩm.' });
        }

        customerEmail = parsed.data.customer.email.toLowerCase().trim();
        customerPhone = parsed.data.customer.phone.replace(/\D/g, '');
        const headerIdempotencyKey = String(req.get?.('X-Idempotency-Key') || '').trim();
        rawClientReference = parsed.data.idempotencyKey ||
          (headerIdempotencyKey && /^[A-Za-z0-9_.:-]{4,120}$/.test(headerIdempotencyKey) ? headerIdempotencyKey : null);
        scopedClientReference = buildScopedClientReference(rawClientReference, { email: customerEmail, phone: customerPhone });
        const retryOrderNumber = parsed.data.retryOrderNumber || null;

        if (scopedClientReference || retryOrderNumber) {
          try {
            const resumed = await require('../payment-channels').retryGatewayOrderPayment(pool, {
              orderNumber: retryOrderNumber,
              clientReference: scopedClientReference,
              expectedCustomer: {
                name: parsed.data.customer.name,
                email: customerEmail,
                phone: customerPhone,
                address: parsed.data.customer.address,
                city: parsed.data.customer.city
              },
              expectedPaymentMethod: parsed.data.paymentMethod,
              expectedItems: parsed.data.items,
              expectedShippingCarrierId: parsed.data.shippingCarrierId,
              expectedShippingFeeVnd: parsed.data.expectedShippingFeeVnd,
              expectedVoucherCode: parsed.data.voucherCode,
              expectedQuoteHash: parsed.data.expectedQuoteHash,
              expectedTotalVnd: parsed.data.expectedSubtotalVnd !== undefined && parsed.data.expectedShippingFeeVnd !== undefined
                ? parsed.data.expectedSubtotalVnd + parsed.data.expectedShippingFeeVnd
                : undefined,
              checkoutPayload: {
                customer: parsed.data.customer,
                items: parsed.data.items,
                paymentMethod: parsed.data.paymentMethod,
                shippingCarrierId: parsed.data.shippingCarrierId,
                expectedShippingFeeVnd: parsed.data.expectedShippingFeeVnd,
                expectedSubtotalVnd: parsed.data.expectedSubtotalVnd,
                expectedQuoteHash: parsed.data.expectedQuoteHash,
                voucherCode: parsed.data.voucherCode
              },
              config: config || {},
              settings: req.paymentChannels?.configs?.[parsed.data.paymentMethod] || null,
              baseUrl: publicBaseUrl,
              fetcher: paymentFetcher,
              inventory,
              finance,
              audit,
              actor: { username: 'customer', source: 'payment_retry' }
            });
            if (resumed) {
              if (req.session && resumed.order?.orderNumber) {
                req.session.createdOrders = req.session.createdOrders || [];
                if (!req.session.createdOrders.includes(resumed.order.orderNumber)) {
                  req.session.createdOrders.push(resumed.order.orderNumber);
                }
              }
              const tokenResult = await resolveOrderAccessToken(
                { orderId: resumed.order?.id, orderNumber: resumed.order?.orderNumber, customerId: req.session?.customer?.id },
                config,
                pool
              );
              if (resumed.status === 202) {
                res.setHeader('Retry-After', String(resumed.retryAfterSeconds || 3));
              }
              const { status = 200, ...payload } = resumed;
              return res.status(status).json({ ...payload, ...tokenResult });
            }
          } catch (retryErr) {
            if (retryErr.status === 403 || retryErr.status === 409) {
              return res.status(retryErr.status).json({ error: retryErr.message, code: retryErr.code });
            }
            throw retryErr;
          }
          if (retryOrderNumber && !scopedClientReference) {
            return res.status(404).json({ error: 'Không tìm thấy đơn hàng cần thử lại thanh toán.' });
          }
        }

        const order = await withTransaction(pool, async (client) => {
          if (parsed.data.paymentMethod === 'vnpay' && getVnpayConfig) {
            await client.query("SELECT pg_advisory_xact_lock(hashtext('gaeru:vnpay-config'))");
            req.vnpayConfig = await getVnpayConfig(client);
            if (!req.vnpayConfig) {
              throw Object.assign(Error('VNPAY vừa ngừng khả dụng. Vui lòng chọn phương thức khác.'), { status: 409 });
            }
          }
          if (['momo', 'zalopay'].includes(parsed.data.paymentMethod)) {
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['gaeru:payment-config:' + parsed.data.paymentMethod]);
            if (getPaymentChannels) req.paymentChannels = await getPaymentChannels(client);
            if (!req.paymentChannels?.methods.includes(parsed.data.paymentMethod)) {
              throw Object.assign(Error('Kênh thanh toán vừa ngừng khả dụng.'), { status: 409 });
            }
          }

          const sortedVariantIds = [...uniqueItems.keys()].sort();
          const result = await client.query(
            `SELECT v.id, v.sku, v.name AS "variantName", v.price_vnd AS "priceVnd",
                    v.stock_quantity AS "stockQuantity", p.name AS "productName", p.slug AS "productSlug"
             FROM product_variants v JOIN products p ON p.id = v.product_id
             WHERE v.id = ANY($1::uuid[]) AND v.active = true AND p.active = true
             ORDER BY v.id
             FOR UPDATE OF v`,
            [sortedVariantIds]
          );
          const variantMap = new Map(result.rows.map((v) => [v.id, v]));
          let prepared = [];
          for (const variantId of sortedVariantIds) {
            const variant = variantMap.get(variantId);
            const quantity = uniqueItems.get(variantId);
            if (!variant) {
              throw Object.assign(new Error('Một phiên bản trong giỏ hàng không còn được bán.'), { status: 409 });
            }
            if (variant.stockQuantity < quantity) {
              throw Object.assign(
                new Error(`${variant.productName} (${variant.variantName}) hiện chỉ còn ${variant.stockQuantity} sản phẩm.`),
                { status: 409 }
              );
            }
            prepared.push({ ...variant, quantity });
          }

          const orderQuote = await PricingEngine.quoteOrder(client, {
            items: prepared,
            voucherCode: parsed.data.voucherCode,
            customerId: req.session?.customer?.id,
            mode: 'commit',
            lockVoucher: true,
            city: parsed.data.customer.city,
            loadShippingFromDb: true,
            requireSupportedCity: true,
            shippingChoices,
            shippingCarrierId: parsed.data.shippingCarrierId,
            paymentMethod: parsed.data.paymentMethod,
            codMaxAmountVnd: req.paymentChannels?.cod?.maxAmountVnd,
            expectedSubtotalVnd: parsed.data.expectedSubtotalVnd,
            expectedShippingFeeVnd: parsed.data.expectedShippingFeeVnd,
            expectedQuoteHash: parsed.data.expectedQuoteHash
          });

          prepared = orderQuote.items;
          const subtotal = orderQuote.subtotalVnd;
          const shippingFee = orderQuote.shippingFeeVnd;
          const shippingSelection = orderQuote.shippingSelection;
          const promotion = orderQuote.voucher;
          const total = orderQuote.totalVnd;
          const orderNumber = `GR-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

          const inserted = await client.query(
            `INSERT INTO orders (order_number, customer_name, email, phone, address, city, note,
                                 payment_method, subtotal_vnd, shipping_fee_vnd, total_vnd)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING id, order_number AS "orderNumber", subtotal_vnd AS "subtotalVnd",
                       shipping_fee_vnd AS "shippingFeeVnd", total_vnd AS "totalVnd",
                       status, payment_method AS "paymentMethod", created_at AS "createdAt"`,
            [
              orderNumber, parsed.data.customer.name, parsed.data.customer.email, parsed.data.customer.phone,
              parsed.data.customer.address, parsed.data.customer.city, parsed.data.customer.note,
              parsed.data.paymentMethod, subtotal, shippingFee, total
            ]
          );

          const createdOrder = inserted.rows[0];
          const { computeCheckoutPayloadHash } = require('../domain/payments/order-idempotency-policy');
          const checkoutPayloadHash = computeCheckoutPayloadHash(parsed.data);

          try {
            await client.query(
              'UPDATE orders SET pricing_snapshot = $2::jsonb, quote_hash = $3, checkout_payload_hash = $4 WHERE id = $1',
              [createdOrder.id, JSON.stringify(orderQuote.snapshot), orderQuote.quoteHash, checkoutPayloadHash]
            );
          } catch {
            await client.query(
              'UPDATE orders SET pricing_snapshot = $2::jsonb, quote_hash = $3 WHERE id = $1',
              [createdOrder.id, JSON.stringify(orderQuote.snapshot), orderQuote.quoteHash]
            );
          }
          createdOrder.quoteHash = orderQuote.quoteHash;
          createdOrder.pricingVersion = orderQuote.pricingVersion;
          createdOrder.checkoutPayloadHash = checkoutPayloadHash;

          if (scopedClientReference) {
            await client.query('UPDATE orders SET client_reference = $2 WHERE id = $1', [createdOrder.id, scopedClientReference]);
          }

          if (shippingSelection) {
            await client.query(
              'INSERT INTO order_shipping_selection(order_id, carrier_id, carrier_name, fee_vnd, config_version) VALUES($1, $2, $3, $4, $5)',
              [createdOrder.id, shippingSelection.id, shippingSelection.name, shippingFee, shippingSelection.version]
            );
            createdOrder.shippingCarrierName = shippingSelection.name;
          } else {
            try {
              const optimal = allocateOptimalCarrier(parsed.data.customer.city);
              await client.query(
                'INSERT INTO order_shipping_selection(order_id, carrier_id, carrier_name, fee_vnd, config_version) VALUES($1, $2, $3, $4, 1) ON CONFLICT (order_id) DO NOTHING',
                [createdOrder.id, optimal.id, optimal.name, shippingFee]
              );
              createdOrder.shippingCarrierName = optimal.name;
            } catch {}
          }

          if (promotion) {
            await require('../marketing').redeem(client, promotion, req.session.customer.id, createdOrder.id);
            createdOrder.discountVnd = promotion.discountVnd;
            createdOrder.voucherCode = promotion.voucher.code;
          }

          if (req.session?.customer?.id) {
            await client.query(
              'UPDATE orders SET customer_id = $2 WHERE id = $1 AND EXISTS (SELECT 1 FROM customers WHERE id = $2 AND active = true)',
              [createdOrder.id, req.session.customer.id]
            );
          }

          if (checkoutAccounts) {
            await require('../checkout-account').enroll(client, createdOrder, parsed.data.customer, req.session?.customer?.id);
          }

          for (const item of prepared) {
            const resolvedLineTotal = item.lineTotalVnd !== undefined ? item.lineTotalVnd : item.priceVnd * item.quantity;
            const resolvedEffectiveUnit = item.effectiveUnitPriceVnd !== undefined ? item.effectiveUnitPriceVnd : item.priceVnd;
            const insertedItem = await client.query(
              `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku,
                                        unit_price_vnd, quantity, line_total_vnd, original_price_vnd,
                                        promotion_snapshot, effective_unit_price_vnd)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               RETURNING id`,
              [
                createdOrder.id, item.id, item.productName, item.variantName, item.sku,
                item.priceVnd, item.quantity, resolvedLineTotal, item.originalPriceVnd,
                item.promotion, resolvedEffectiveUnit
              ]
            );
            const orderItemId = insertedItem?.rows?.[0]?.id;
            if (orderItemId && Array.isArray(item.priceAllocations) && item.priceAllocations.length > 0) {
              for (const alloc of item.priceAllocations) {
                await client.query(
                  `INSERT INTO order_item_allocations (order_item_id, tier_kind, quantity, unit_price_vnd, line_total_vnd, discount_percent)
                   VALUES ($1, $2, $3, $4, $5, $6)`,
                  [orderItemId, alloc.tierKind, alloc.quantity, alloc.unitPriceVnd, alloc.lineTotalVnd, alloc.discountPercent || 0]
                );
              }
            }
            if (inventory) {
              if (typeof inventory.reserveStock === 'function') {
                await inventory.reserveStock(client, {
                  variantId: item.id,
                  quantity: item.quantity,
                  orderId: createdOrder.id,
                  actor: { username: 'customer', source: 'customer' }
                });
              } else if (typeof inventory.reserveOrderStock === 'function') {
                await inventory.reserveOrderStock(client, {
                  items: [{ variantId: item.id, quantity: item.quantity }],
                  orderId: createdOrder.id,
                  actor: { username: 'customer', source: 'customer' }
                });
              }
            } else {
              await client.query(
                'UPDATE product_variants SET stock_quantity = stock_quantity - $2, updated_at = now() WHERE id = $1',
                [item.id, item.quantity]
              );
            }
          }

          let paymentUrl = null;
          let bankTransfer = null;
          let gatewayCall = null;

          if (['9pay', 'momo', 'zalopay'].includes(parsed.data.paymentMethod)) {
            const channelConfig = req.paymentChannels?.configs?.[parsed.data.paymentMethod];
            if (!channelConfig) {
              throw Object.assign(new Error('Kênh thanh toán vừa ngừng khả dụng. Vui lòng chọn phương thức khác.'), { status: 409 });
            }
            const gatewayNow = Date.now();
            const { validateGatewayInitiationRequest } = require('../payment-provider-clients');
            const validatedGateway = validateGatewayInitiationRequest(parsed.data.paymentMethod, channelConfig, {
              amountVnd: createdOrder.totalVnd,
              txnRef: createdOrder.orderNumber,
              now: gatewayNow,
              baseUrl: publicBaseUrl
            });
            await client.query(
              `INSERT INTO payment_attempts (order_id, provider, transaction_ref, amount_vnd, provider_request_id, expires_at)
               VALUES ($1, $2, $3, $4, $5, now() + interval '15 minutes')`,
              [createdOrder.id, parsed.data.paymentMethod, createdOrder.orderNumber, createdOrder.totalVnd, validatedGateway.requestId]
            );
            gatewayCall = {
              provider: parsed.data.paymentMethod,
              channelConfig,
              version: req.paymentChannels?.versions?.[parsed.data.paymentMethod],
              providerRequestId: validatedGateway.requestId,
              gatewayNow
            };
          } else if (parsed.data.paymentMethod === 'bank_transfer') {
            const channelConfig = req.paymentChannels?.configs?.bank_transfer;
            if (!channelConfig) {
              throw Object.assign(new Error('Chuyển khoản ngân hàng vừa ngừng khả dụng. Vui lòng chọn phương thức khác.'), { status: 409 });
            }
            await client.query(
              `INSERT INTO payment_attempts (order_id, provider, transaction_ref, amount_vnd, expires_at)
               VALUES ($1, 'bank_transfer', $2, $3, now() + interval '24 hours')`,
              [createdOrder.id, createdOrder.orderNumber, createdOrder.totalVnd]
            );
            bankTransfer = require('../payment-channels').formatBankTransferInstructions(channelConfig, {
              orderNumber: createdOrder.orderNumber,
              amountVnd: createdOrder.totalVnd
            });
          } else if (parsed.data.paymentMethod === 'vnpay') {
            await client.query(
              `INSERT INTO payment_attempts (order_id, provider, transaction_ref, amount_vnd, expires_at)
               VALUES ($1, 'vnpay', $2, $3, now() + interval '15 minutes')`,
              [createdOrder.id, createdOrder.orderNumber, createdOrder.totalVnd]
            );
            paymentUrl = buildVnpayPaymentUrl(req.vnpayConfig, {
              amountVnd: createdOrder.totalVnd,
              txnRef: createdOrder.orderNumber,
              ipAddress: req.ip
            });
          }

          await audit(client, {
            actor: { username: 'customer', source: 'customer' },
            action: 'order.create',
            entityType: 'order',
            entityId: createdOrder.id,
            metadata: {
              orderNumber: createdOrder.orderNumber,
              totalVnd: createdOrder.totalVnd,
              paymentMethod: parsed.data.paymentMethod
            }
          });

          return {
            order: {
              ...createdOrder,
              items: prepared.map(({ productName, variantName, sku, priceVnd, quantity }) => ({
                productName,
                variantName,
                sku,
                priceVnd,
                quantity
              }))
            },
            paymentUrl,
            ...(bankTransfer ? { bankTransfer } : {}),
            gatewayCall
          };
        });

        const tokenResult = await resolveOrderAccessToken(
          { orderId: order.order.id, orderNumber: order.order.orderNumber, customerId: req.session?.customer?.id },
          config,
          pool
        );
        const orderAccessToken = tokenResult.orderAccessToken;
        if (req.session && order.order?.orderNumber) {
          req.session.createdOrders = req.session.createdOrders || [];
          if (!req.session.createdOrders.includes(order.order.orderNumber)) {
            req.session.createdOrders.push(order.order.orderNumber);
          }
        }

        if (order.gatewayCall) {
          const outcome = await PaymentService.initiateOrderGatewayPayment(pool, {
            order: order.order,
            gatewayCall: order.gatewayCall,
            publicBaseUrl,
            paymentFetcher,
            inventory,
            audit
          });
          if (!outcome.ok || outcome.body) {
            if (outcome.body && typeof outcome.body === 'object') {
              outcome.body.orderAccessToken = orderAccessToken;
              if (tokenResult.orderAccessTokenWarning) {
                outcome.body.orderAccessTokenWarning = tokenResult.orderAccessTokenWarning;
              }
            }
            return res.status(outcome.httpStatus).json(outcome.body);
          }
          order.order = outcome.order;
          order.paymentUrl = outcome.paymentUrl;
        }

        res.status(201).json({
          order: order.order,
          orderAccessToken,
          ...(tokenResult.orderAccessTokenWarning ? { orderAccessTokenWarning: tokenResult.orderAccessTokenWarning } : {}),
          paymentUrl: order.paymentUrl,
          ...(order.bankTransfer ? { bankTransfer: order.bankTransfer } : {}),
          message: parsed.data.paymentMethod === 'cod'
            ? 'Đã tiếp nhận đơn hàng COD. GAERU sẽ xác nhận đơn và thu tiền khi giao hàng.'
            : parsed.data.paymentMethod === 'bank_transfer'
              ? 'Đã tiếp nhận đơn chuyển khoản. Sau khi giao dịch được xác nhận khớp số tiền và mã đơn, đơn hàng sẽ tự động chuyển sang trạng thái Chờ gửi hàng.'
              : `Đã tạo phiên thanh toán ${parsed.data.paymentMethod.toUpperCase()}. Sau khi thanh toán thành công, đơn hàng sẽ tự động duyệt sang trạng thái Chờ gửi hàng.`
        });
      } catch (error) {
        if (scopedClientReference && (error.code === '23505' || String(error.message || '').includes('orders_client_reference_uidx'))) {
          try {
            const resumed = await require('../payment-channels').retryGatewayOrderPayment(pool, {
              clientReference: scopedClientReference,
              expectedCustomer: {
                name: parsed?.data?.customer?.name,
                email: customerEmail,
                phone: customerPhone,
                address: parsed?.data?.customer?.address,
                city: parsed?.data?.customer?.city
              },
              expectedPaymentMethod: parsed?.data?.paymentMethod,
              expectedItems: parsed?.data?.items,
              expectedShippingCarrierId: parsed?.data?.shippingCarrierId,
              expectedShippingFeeVnd: parsed?.data?.expectedShippingFeeVnd,
              expectedVoucherCode: parsed?.data?.voucherCode,
              expectedQuoteHash: parsed?.data?.expectedQuoteHash,
              expectedTotalVnd: parsed?.data?.expectedSubtotalVnd !== undefined && parsed?.data?.expectedShippingFeeVnd !== undefined
                ? parsed?.data?.expectedSubtotalVnd + parsed?.data?.expectedShippingFeeVnd
                : undefined,
              checkoutPayload: {
                customer: parsed?.data?.customer,
                items: parsed?.data?.items,
                paymentMethod: parsed?.data?.paymentMethod,
                shippingCarrierId: parsed?.data?.shippingCarrierId,
                expectedShippingFeeVnd: parsed?.data?.expectedShippingFeeVnd,
                expectedSubtotalVnd: parsed?.data?.expectedSubtotalVnd,
                expectedQuoteHash: parsed?.data?.expectedQuoteHash,
                voucherCode: parsed?.data?.voucherCode
              },
              config: config || {},
              settings: req.paymentChannels?.configs?.[parsed?.data?.paymentMethod] || null,
              baseUrl: publicBaseUrl,
              fetcher: paymentFetcher,
              inventory,
              finance,
              audit,
              actor: { username: 'customer', source: 'concurrent_idempotency_retry' }
            });
            if (resumed) {
              if (req.session && resumed.order?.orderNumber) {
                req.session.createdOrders = req.session.createdOrders || [];
                if (!req.session.createdOrders.includes(resumed.order.orderNumber)) {
                  req.session.createdOrders.push(resumed.order.orderNumber);
                }
              }
              const tokenResult = await resolveOrderAccessToken(
                { orderId: resumed.order?.id, orderNumber: resumed.order?.orderNumber, customerId: req.session?.customer?.id },
                config,
                pool
              );
              if (resumed.status === 202) {
                res.setHeader('Retry-After', String(resumed.retryAfterSeconds || 3));
              }
              const { status = 200, ...payload } = resumed;
              return res.status(status).json({ ...payload, ...tokenResult });
            }
          } catch (retryErr) {
            if (retryErr.status === 403 || retryErr.status === 409) {
              return res.status(retryErr.status).json({ error: retryErr.message, code: retryErr.code });
            }
          }
        }
        if (error.status) return res.status(error.status).json({ error: error.message });
        next(error);
      }
    }
  );
}

module.exports = { attachPublicAndCheckoutRoutes };
