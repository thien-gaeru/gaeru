const { isOnlineGateway, ONLINE_GATEWAYS } = require('./domain/payments/payment-policy');
const { CatalogService } = require('./domain/catalog/catalog-service');
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function allocateOptimalCarrier(city, enabledCarriers = ['ghn', 'ghtk', 'viettel', 'spx', 'jt']) {
  const normCity = String(city || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const isMajorUrban = /ha noi|ho chi minh|sai gon|da nang/.test(normCity);
  if (isMajorUrban) {
    if (enabledCarriers.includes('spx')) return { id: 'spx', name: 'Shopee Express (SPX)' };
    if (enabledCarriers.includes('ghn')) return { id: 'ghn', name: 'Giao Hàng Nhanh (GHN)' };
  } else {
    if (enabledCarriers.includes('viettel')) return { id: 'viettel', name: 'Viettel Post' };
    if (enabledCarriers.includes('ghtk')) return { id: 'ghtk', name: 'Giao Hàng Tiết Kiệm (GHTK)' };
  }
  const fallback = enabledCarriers.find(c => ['ghn','ghtk','viettel','spx','jt'].includes(c)) || 'ghn';
  const nameMap = { ghn: 'Giao Hàng Nhanh (GHN)', ghtk: 'Giao Hàng Tiết Kiệm (GHTK)', viettel: 'Viettel Post', spx: 'Shopee Express (SPX)', jt: 'J&T Express' };
  return { id: fallback, name: nameMap[fallback] || 'Giao Hàng Nhanh (GHN)' };
}

const multer = require("multer");
const { Router } = require("express");
const { rateLimit } = require("express-rate-limit");
const { z } = require("zod");
const { requireAdmin, requireCsrf } = require("./security");
const { requirePermission } = require("./staff-access");
const { withTransaction } = require("./db");
const { buildVnpayPaymentUrl, verifyVnpayQuery } = require("./vnpay");
const { decoratePublicProductImages } = require("./lib/public-image-urls");
const { checkCustomerPhoneStatus, checkCustomerRegEmailStatus } = require("./customer-lifecycle");

const orderSchema = z.object({
  customer: z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(254).transform(value=>value.toLowerCase()),
    phone: z.string().trim().regex(/^[+0-9().\s-]{8,30}$/),
    address: z.string().trim().min(5).max(250),
    city: z.string().trim().min(2).max(120),
    note: z.string().trim().max(1000).default("")
  }),
  shippingCarrierId:z.enum(['ghn','ghtk','viettel','jt','spx']).optional(),
  expectedShippingFeeVnd:z.number().int().min(0).max(1000000000).optional(),
  expectedSubtotalVnd:z.number().int().min(0).max(2000000000).optional(),
  voucherCode: z.string().trim().toUpperCase().max(40).optional(),
  idempotencyKey: z.string().trim().min(4).max(120).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
  retryOrderNumber: z.string().trim().min(5).max(80).optional(),
  paymentMethod: z.enum(["cod", "bank_transfer", "vnpay", "9pay", "momo", "zalopay"]),
  items: z.array(z.object({
    variantId: z.string().uuid(),
    quantity: z.number().int().min(1).max(99)
  })).min(1).max(30)
});

const transitions = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["completed"],
  completed: [],
  cancelled: []
};

async function loadProducts(pool, { includeDrafts = false, deleted = false, search = "" } = {}) {
  const visibility = includeDrafts ? (deleted ? "WHERE p.deleted_at IS NOT NULL" : "WHERE p.deleted_at IS NULL") : "WHERE p.active = true AND p.deleted_at IS NULL";
  const query = `
    SELECT p.id, p.slug, p.name, p.category, p.descriptor, p.description, p.card_title AS "cardTitle", p.card_summary AS "cardSummary",
      p.image_url AS "imageUrl", p.image_alt AS "imageAlt", p.active, p.edit_version AS version, p.deleted_at AS "deletedAt",
      p.sort_order AS "sortOrder",
      COALESCE(m.description_media,'[]'::jsonb) AS "descriptionMedia",COALESCE(m.gallery,'[]'::jsonb) AS gallery,COALESCE(m.option_groups,'[]'::jsonb) AS "optionGroups",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', v.id, 'sku', v.sku, 'name', v.name, 'options', v.options,
          'priceVnd', v.price_vnd, 'stockQuantity', v.stock_quantity, 'active', v.active, 'imageUrl', v.image_url
        ) ORDER BY v.name)
        FROM product_variants v
        WHERE v.product_id = p.id ${includeDrafts ? "" : "AND v.active = true"}
      ), '[]'::jsonb) AS variants
    FROM products p LEFT JOIN product_presentations m ON m.product_id=p.id
    ${visibility}
    ORDER BY p.sort_order, p.name`;
  const result = await pool.query(query);
  const { normalizeBrandText } = require("./primary-domain");
  for (const p of result.rows) {
    p.name = normalizeBrandText(p.name);
    p.descriptor = normalizeBrandText(p.descriptor);
    p.description = normalizeBrandText(p.description);
    p.cardTitle = normalizeBrandText(p.cardTitle);
    p.cardSummary = normalizeBrandText(p.cardSummary);
    p.imageAlt = normalizeBrandText(p.imageAlt);
  }
  if(!includeDrafts){const priced=await require("./product-promotions").quoteCatalogPrices(pool,result.rows.flatMap(p=>p.variants));const byId=new Map(priced.map(v=>[v.id,v]));for(const p of result.rows)p.variants=p.variants.map(v=>byId.get(v.id));}
  const needle = search.trim().toLocaleLowerCase("vi");
  if (!needle) return result.rows;
  return result.rows.filter((product) =>
    `${product.name} ${product.slug} ${product.description} ${product.category} ${product.descriptor} ${product.variants.map((variant) => `${variant.name} ${variant.sku}`).join(" ")}`
      .toLocaleLowerCase("vi").includes(needle)
  );
}

async function lockVariantWithProduct(client, variantId) {
  const parentResult = await client.query(
    `SELECT p.id, p.active FROM products p
     JOIN product_variants v ON v.product_id = p.id
     WHERE v.id=$1 AND p.deleted_at IS NULL FOR UPDATE OF p`,
    [variantId]
  );
  const product = parentResult.rows[0];
  if (!product) return null;
  const variantResult = await client.query(
    'SELECT id, active, stock_quantity AS "stockQuantity" FROM product_variants WHERE id=$1 AND product_id=$2 FOR UPDATE',
    [variantId, product.id]
  );
  const variant = variantResult.rows[0];
  return variant ? { product, variant } : null;
}

async function requireAnotherActiveVariant(client, product, variant) {
  if (!product.active || !variant.active) return;
  const result = await client.query(
    "SELECT COUNT(*)::int AS count FROM product_variants WHERE product_id=$1 AND active=true AND id<>$2",
    [product.id, variant.id]
  );
  if (!result.rows[0]?.count) {
    const error = new Error("Sản phẩm đang hiển thị cần ít nhất một phiên bản đang bán. Hãy tạm ẩn sản phẩm trước khi ẩn hoặc xóa phiên bản cuối cùng.");
    error.status = 409;
    throw error;
  }
}

async function getSettings(pool, keys) {
  const result = await pool.query(
    "SELECT setting_key, setting_value FROM store_settings WHERE setting_key = ANY($1::text[])",
    [keys]
  );
  return Object.fromEntries(result.rows.map((row) => [row.setting_key, row.setting_value]));
}

function createStoreApi(pool, { ordersEnabled = false, getOrdersEnabled = null, vnpayConfig = null, getVnpayConfig = null, paymentChannels = null, getPaymentChannels = null, paymentFetcher = fetch, publicBaseUrl = "https://gaeru.com", inventory = null, finance = null, audit = async () => {}, shippingChoices = false, checkoutAccounts = false, config = null, misaFetcher = fetch } = {}) {
  const router = Router();
  const orderLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Quá nhiều yêu cầu đặt hàng. Vui lòng thử lại sau." }
  });
  const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) => {
      if (["image/png", "image/jpeg", "image/webp"].includes(file.mimetype)) return callback(null, true);
      callback(new Error("Chỉ chấp nhận ảnh PNG, JPEG hoặc WebP."));
    }
  });
  const parseImageUpload = (req, res, next) => {
    imageUpload.single("image")(req, res, (error) => {
      if (error) return res.status(400).json({ error: error.message });
      next();
    });
  };

  router.use(async(req,res,next)=>{try{req.ordersEnabled=getOrdersEnabled?await getOrdersEnabled():ordersEnabled;req.vnpayConfig=getVnpayConfig?await getVnpayConfig():vnpayConfig;req.paymentChannels=getPaymentChannels?await getPaymentChannels():paymentChannels;req.vnpayCallbackConfig=req.paymentChannels?.callbackConfigs?.vnpay||req.vnpayConfig;next();}catch(error){next(error);}});
  router.get("/products", async (req, res) => {
    const products = await loadProducts(pool, { search: String(req.query.q || "") });
    res.json(decoratePublicProductImages({ products }));
  });

  router.get("/products/:slug", async (req, res) => {
    const products = await loadProducts(pool);
    const product = products.find((item) => item.slug === req.params.slug);
    if (!product) return res.status(404).json({ error: "Không tìm thấy sản phẩm." });
    res.json(decoratePublicProductImages({ product }));
  });

  router.get("/settings/public", async (req, res) => {
    const settings = await getSettings(pool, ["shipping_note", "shipping_rates"]);
    let publicCarriers = [];
    if (shippingChoices) {
      try {
        const verified = await require("./shipping-choice").availableCarriers(pool);
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
      } catch (e) {}
    }
    res.json({
      ...(shippingChoices ? { shippingCarriers: publicCarriers } : {}),
      shippingNote: settings.shipping_note || "",
      shippingRates: settings.shipping_rates || {},
      paymentMethods: req.paymentChannels?.methods || ["cod", ...(req.vnpayConfig ? ["vnpay"] : [])],
      ...(req.paymentChannels?.bankTransfer ? { bankTransfer: req.paymentChannels.bankTransfer } : {}),
      ...(req.paymentChannels?.cod ? { cod: req.paymentChannels.cod } : {}),
      ordersEnabled:req.ordersEnabled
    });
  });

  router.get("/payments/vnpay/return", (req, res) => {
    if (!req.vnpayCallbackConfig) return res.sendStatus(404);
    const { valid, parameters } = verifyVnpayQuery(req.query, req.vnpayCallbackConfig.hashSecret);
    if (!valid || parameters.vnp_TmnCode !== req.vnpayCallbackConfig.tmnCode) {
      return res.redirect("/payment-result.html?result=invalid");
    }
    const successful = parameters.vnp_ResponseCode === "00" && parameters.vnp_TransactionStatus === "00";
    const query = new URLSearchParams({
      result: successful ? "processing" : "failed",
      order: parameters.vnp_TxnRef || ""
    });
    res.redirect(`/payment-result.html?${query}`);
  });

  router.get("/payments/vnpay/ipn", async (req, res, next) => {
    if (!req.vnpayCallbackConfig) return res.status(404).json({ RspCode: "99", Message: "Provider unavailable" });
    try {
      const { valid, parameters } = verifyVnpayQuery(req.query, req.vnpayCallbackConfig.hashSecret);
      if (!valid || parameters.vnp_TmnCode !== req.vnpayCallbackConfig.tmnCode) {
        return res.json({ RspCode: "97", Message: "Invalid signature" });
      }
      // VNPAY 2.1 IPN callbacks omit the checkout-only vnp_Command parameter.
      if (parameters.vnp_Command !== undefined && parameters.vnp_Command !== "pay") {
        return res.json({ RspCode: "99", Message: "Unsupported command" });
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
        if (!attempt) return { code: "01", message: "Order not found" };
        const amount = Number(parameters.vnp_Amount);
        if (!Number.isSafeInteger(amount) || amount !== attempt.amountVnd * 100 || attempt.totalVnd !== attempt.amountVnd) {
          return { code: "04", message: "Invalid amount" };
        }
        if (attempt.attemptStatus === "paid" || attempt.paymentStatus === "paid") {
          return { code: "02", message: "Order already confirmed" };
        }

        const successful = parameters.vnp_ResponseCode === "00" && parameters.vnp_TransactionStatus === "00";
        await client.query(
          `UPDATE payment_attempts SET status=$2, provider_transaction_id=$3, response_code=$4, updated_at=now()
           WHERE id=$1`,
          [attempt.id, successful ? "paid" : "failed", parameters.vnp_TransactionNo || null, parameters.vnp_ResponseCode || null]
        );
        if (successful) {
          const ledger = finance || require("./finance-api");
          await ledger.recordFullOrderPayment(client, {
            order: { id: attempt.orderId, order_number: parameters.vnp_TxnRef, payment_method: "vnpay", total_vnd: attempt.totalVnd },
            actor: { username: "vnpay", source: "payment_gateway" }
          });
          await client.query("UPDATE orders SET payment_status='paid', status=CASE WHEN status IN ('pending','confirmed') THEN 'processing' ELSE status END, updated_at=now() WHERE id=$1", [attempt.orderId]);
        }
        await audit(client, { actor: { username: "vnpay", source: "payment_gateway" }, action: "payment.vnpay.callback", entityType: "order", entityId: attempt.orderId, metadata: { successful, amountVnd: attempt.amountVnd, responseCode: parameters.vnp_ResponseCode || null } });
        if(req.paymentChannels?.versions)await require('./payment-channels').recordGatewayEvidence(client,'vnpay',req.paymentChannels.versions.vnpay,{enabled:req.paymentChannels.methods.includes('vnpay')});
        return { code: "00", message: "Confirm Success" };
      });
      res.json({ RspCode: result.code, Message: result.message });
    } catch (error) {
      next(error);
    }
  });

  router.get("/payments/order-status", async (req, res, next) => {
    try {
      const orderNumber = require("./payment-channels").extractOrderNumber(req.query.order);
      if (!orderNumber) return res.status(400).json({ error: "Thiếu mã đơn hàng." });
      const row = (await pool.query(
        `SELECT o.order_number AS "orderNumber", o.status, o.payment_method AS "paymentMethod",
          o.payment_status AS "paymentStatus", o.total_vnd AS "totalVnd", o.updated_at AS "updatedAt",
          (SELECT p.status FROM payment_attempts p WHERE p.order_id = o.id ORDER BY p.created_at DESC LIMIT 1) AS "paymentAttemptStatus"
         FROM orders o WHERE o.order_number = $1`,
        [orderNumber]
      )).rows[0];
      if (!row) return res.status(404).json({ error: "Không tìm thấy đơn hàng." });
      res.json({ order: row });
    } catch (error) {
      next(error);
    }
  });

  router.post("/orders/:orderNumber/retry-payment", (req, res, next) => {
    if (!req.ordersEnabled) {
      return res.status(503).json({ error: "GAERU đang tạm dừng tiếp nhận đơn hàng trực tuyến." });
    }
    next();
  }, orderLimit, requireCsrf, async (req, res, next) => {
    try {
      const orderNumber = require("./payment-channels").extractOrderNumber(req.params.orderNumber);
      if (!orderNumber) return res.status(400).json({ error: "Mã đơn hàng không hợp lệ." });
      const retried = await require("./payment-channels").retryGatewayOrderPayment(pool, {
        orderNumber,
        config: config || {},
        settings: null,
        baseUrl: publicBaseUrl,
        fetcher: paymentFetcher,
        inventory,
        finance,
        audit,
        actor: { username: "customer", source: "payment_retry" }
      });
      if (!retried) return res.status(404).json({ error: "Không tìm thấy đơn hàng." });
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
  });

  router.get("/payments/:provider/return", async (req,res,next)=>{
    const provider=String(req.params.provider||'');if(!['9pay','momo','zalopay'].includes(provider))return next();
    if(provider==='9pay')return res.sendStatus(404);
    const channelConfig=req.paymentChannels?.callbackConfigs?.[provider]||req.paymentChannels?.configs?.[provider];
    if(!channelConfig)return res.sendStatus(404);
    const verified=require('./payment-channels').verifyGatewayPayload(provider,req.query,channelConfig);
    const order=require('./payment-channels').extractOrderNumber(verified.orderNumber||req.query.orderId||req.query.apptransid||req.query.app_trans_id||req.query.order||'');
    // Browser-controlled navigation is display only. IPN/query is authoritative.
    const query=new URLSearchParams({result:verified.valid?(verified.successful?'processing':'failed'):'pending',provider,order});
    res.redirect('/payment-result.html?'+query);
  });

  const handleGatewayIpn=async(req,res,next)=>{
    const provider=String(req.params.provider||'');if(!['9pay','momo','zalopay','bank_transfer'].includes(provider))return next();
    if(provider==='9pay')return res.status(503).json({code:'99',message:'Provider adapter unavailable'});
    try{
      const channelConfig=req.paymentChannels?.callbackConfigs?.[provider]||req.paymentChannels?.configs?.[provider];
      if(!channelConfig)return res.status(404).json({code:'99',message:'Provider unavailable'});
      // Official wallet notifications are server POST JSON, never query aliases.
      if(req.method!=='POST')return res.status(405).end();
      const verified=require('./payment-channels').verifyGatewayPayload(provider,req.body||{},channelConfig);
      if(!verified.valid)return res.status(400).json({code:'97',return_code:-1,resultCode:97,message:'Invalid callback'});
      const outcome=await withTransaction(pool,async client=>{
        const row=(await client.query('SELECT provider_request_id FROM payment_attempts WHERE transaction_ref=$1 AND provider=$2',[verified.orderNumber,provider])).rows[0];
        if(!row)return {code:'01',matched:false,message:'Order not found'};
        const reqId=provider==='momo'?verified.requestId:verified.providerOrderId;
        if(row.provider_request_id&&row.provider_request_id!==reqId)return {code:'97',matched:false,message:'Provider request mismatch'};
        if(!row.provider_request_id&&reqId){
          await client.query('UPDATE payment_attempts SET provider_request_id=COALESCE(provider_request_id,$3) WHERE transaction_ref=$1 AND provider=$2',[verified.orderNumber,provider,reqId]);
        }
        const outcome=await require('./payment-channels').reconcilePrepaidOrder(client,{provider,orderNumber:verified.orderNumber,amountVnd:verified.amountVnd,successful:verified.successful,providerTransactionId:verified.providerTransactionId,responseCode:verified.responseCode,finance,audit});
        if(outcome.matched&&req.paymentChannels?.versions)await require('./payment-channels').recordGatewayEvidence(client,provider,req.paymentChannels.versions[provider],{enabled:req.paymentChannels.methods.includes(provider)});
        return outcome;
      });
      if(provider==='zalopay')return res.json({return_code:outcome.code==='00'||outcome.code==='02'?1:0,return_message:outcome.message,orderStatus:outcome.orderStatus,paymentStatus:outcome.paymentStatus});
      if(provider==='momo')return outcome.matched?res.status(204).end():res.status(409).json({resultCode:Number(outcome.code)||99,message:outcome.message});
      return res.json({code:outcome.code,message:outcome.message});
    }catch(error){next(error);}
  };
  router.get('/payments/:provider/ipn',handleGatewayIpn);
  router.post('/payments/:provider/ipn',handleGatewayIpn);
  router.post('/payments/bank_transfer/webhook',(req,res,next)=>{req.params.provider='bank_transfer';return handleGatewayIpn(req,res,next);});

  router.post("/orders", (req, res, next) => {
    if (!req.ordersEnabled) {
      return res.status(503).json({ error: "GAERU đang tạm dừng tiếp nhận đơn hàng trực tuyến." });
    }
    next();
  }, orderLimit, requireCsrf, async (req, res, next) => {
    try {
      const parsed = orderSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Thông tin đặt hàng chưa hợp lệ.", details: parsed.error.issues });
      }
      if (parsed.data.paymentMethod === "vnpay" && !req.vnpayConfig) { return res.status(503).json({ error: "VNPAY chưa được cấu hình trên máy chủ." }); }
      if (req.paymentChannels && !req.paymentChannels.methods.includes(parsed.data.paymentMethod)) { return res.status(503).json({ error: "Phương thức thanh toán đã chọn hiện chưa khả dụng." }); }
      if (!req.paymentChannels && ["bank_transfer", "9pay", "momo", "zalopay"].includes(parsed.data.paymentMethod)) { return res.status(503).json({ error: "Kênh thanh toán chưa được cấu hình trên máy chủ." });
      // payment method checked above
      }
      if(parsed.data.paymentMethod==='9pay')return res.status(503).json({error:'9Pay chưa sẵn sàng nhận thanh toán.'});
      const uniqueItems = new Map();
      for (const item of parsed.data.items) {
        uniqueItems.set(item.variantId, (uniqueItems.get(item.variantId) || 0) + item.quantity);
      }
      if ([...uniqueItems.values()].some((quantity) => quantity > 99)) {
        return res.status(400).json({ error: "Mỗi phiên bản chỉ được đặt tối đa 99 sản phẩm." });
      }

      const headerIdempotencyKey = String(req.get?.("X-Idempotency-Key") || "").trim();
      const clientReference = parsed.data.idempotencyKey || (headerIdempotencyKey && /^[A-Za-z0-9_.:-]{4,120}$/.test(headerIdempotencyKey) ? headerIdempotencyKey : null);
      const retryOrderNumber = parsed.data.retryOrderNumber || null;
      if (clientReference || retryOrderNumber) {
        const resumed = await require("./payment-channels").retryGatewayOrderPayment(pool, {
          orderNumber: retryOrderNumber,
          clientReference,
          config: config || {},
          settings: req.paymentChannels?.configs?.[parsed.data.paymentMethod] || null,
          baseUrl: publicBaseUrl,
          fetcher: paymentFetcher,
          inventory,
          finance,
          audit,
          actor: { username: "customer", source: "payment_retry" }
        });
        if (resumed) {
          const { status = 200, ...payload } = resumed;
          return res.status(status).json(payload);
        }
        if (retryOrderNumber && !clientReference) {
          return res.status(404).json({ error: "Không tìm thấy đơn hàng cần thử lại thanh toán." });
        }
      }

      const order = await withTransaction(pool, async (client) => {
        if(parsed.data.paymentMethod === "vnpay" && getVnpayConfig){
          await client.query("SELECT pg_advisory_xact_lock(hashtext('gaeru:vnpay-config'))");
          req.vnpayConfig=await getVnpayConfig(client);
          if(!req.vnpayConfig)throw Object.assign(Error("VNPAY vừa ngừng khả dụng. Vui lòng chọn phương thức khác."),{status:409});
        }
        if(['momo','zalopay'].includes(parsed.data.paymentMethod)){
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['gaeru:payment-config:'+parsed.data.paymentMethod]);
          if(getPaymentChannels)req.paymentChannels=await getPaymentChannels(client);
          if(!req.paymentChannels?.methods.includes(parsed.data.paymentMethod))throw Object.assign(Error('Kênh thanh toán vừa ngừng khả dụng.'),{status:409});
        }
        let prepared = [];
        for (const [variantId, quantity] of [...uniqueItems.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          const result = await client.query(
            `SELECT v.id, v.sku, v.name AS "variantName", v.price_vnd AS "priceVnd",
              v.stock_quantity AS "stockQuantity", p.name AS "productName", p.slug AS "productSlug"
             FROM product_variants v JOIN products p ON p.id = v.product_id
             WHERE v.id = $1 AND v.active = true AND p.active = true
             FOR UPDATE OF v`,
            [variantId]
          );
          const variant = result.rows[0];
          if (!variant) {
            const error = new Error("Một phiên bản trong giỏ hàng không còn được bán.");
            error.status = 409;
            throw error;
          }
          if (variant.stockQuantity < quantity) {
            const error = new Error(`${variant.productName} (${variant.variantName}) hiện chỉ còn ${variant.stockQuantity} sản phẩm.`);
            error.status = 409;
            throw error;
          }
          prepared.push({ ...variant, quantity });
        }

        const cartQuote = await require("./product-promotions").quoteCartPrices(client, prepared);
        prepared = cartQuote.items;
        const subtotal = cartQuote.subtotalVnd;
        if (!Number.isSafeInteger(subtotal) || subtotal > 2_000_000_000) {
          const error = new Error("Tổng giá trị đơn hàng vượt giới hạn cho phép.");
          error.status = 400;
          throw error;
        }
        if(parsed.data.expectedSubtotalVnd!==undefined&&parsed.data.expectedSubtotalVnd!==subtotal)throw Object.assign(Error("Giá hoặc chương trình đã thay đổi. Tải lại trang để xác nhận giá mới trước khi đặt hàng."),{status:409});
        const shippingResult = await client.query(
          "SELECT setting_value FROM store_settings WHERE setting_key = 'shipping_rates' FOR SHARE"
        );
        const shippingRates = shippingResult.rows[0]?.setting_value || {};
        if (require("../checkout-flow").shippingFee(shippingRates,parsed.data.customer.city) === undefined) {
          const error = new Error("Tỉnh/thành phố giao hàng hiện chưa được hỗ trợ hoặc chưa có phí vận chuyển.");
          error.status = 409;
          throw error;
        }
        const shippingFee = require("../checkout-flow").shippingFee(shippingRates,parsed.data.customer.city);
        let shippingSelection = null;
        if (shippingChoices) {
          try {
            shippingSelection = await require('./shipping-choice').validateSelection(client, parsed.data.shippingCarrierId);
          } catch (err) {
            const connCheck = await client.query('SELECT count(*)::int AS cnt FROM shipping_carrier_connections').catch(() => ({ rows: [] }));
            if (connCheck.rows[0]?.cnt > 0) {
              throw err;
            }
            const allowed = {
              ghn: 'Giao Hàng Nhanh (GHN)',
              ghtk: 'Giao Hàng Tiết Kiệm (GHTK)',
              viettel: 'Viettel Post',
              spx: 'Shopee Express (SPX)'
            };
            if (parsed.data.shippingCarrierId && allowed[parsed.data.shippingCarrierId]) {
              shippingSelection = {
                id: parsed.data.shippingCarrierId,
                name: allowed[parsed.data.shippingCarrierId],
                version: 1
              };
            } else if (parsed.data.shippingCarrierId) {
              throw err;
            }
          }
        }
        if(parsed.data.expectedShippingFeeVnd!==undefined&&parsed.data.expectedShippingFeeVnd!==shippingFee)throw Object.assign(Error('Phí vận chuyển đã thay đổi. Tải lại trang trước khi đặt hàng.'),{status:409});
        const promotion=parsed.data.voucherCode?await require("./marketing").eligible(client,parsed.data.voucherCode,req.session?.customer?.id,subtotal,true,{productSlugs:prepared.map(p=>p.productSlug).filter(Boolean)}):null;
        const total = subtotal + shippingFee - (promotion?.discountVnd||0);
        if (!Number.isSafeInteger(total) || total > 2_000_000_000) {
          const error = new Error("Tổng giá trị đơn hàng vượt giới hạn cho phép.");
          error.status = 400;
          throw error;
        }
        if (parsed.data.paymentMethod !== "cod" && total < 1) {
          const error = new Error("Cổng thanh toán trực tuyến không hỗ trợ đơn hàng có tổng tiền bằng 0.");
          error.status = 400;
          throw error;
        }
        if (parsed.data.paymentMethod === "cod" && req.paymentChannels?.cod?.maxAmountVnd && total > req.paymentChannels.cod.maxAmountVnd) {
          throw Object.assign(new Error(`Đơn hàng vượt hạn mức thu hộ COD (${new Intl.NumberFormat("vi-VN").format(req.paymentChannels.cod.maxAmountVnd)} ₫). Vui lòng chọn phương thức thanh toán trước.`), { status: 400 });
        }
        const orderNumber = `GR-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${require("node:crypto").randomBytes(5).toString("hex").toUpperCase()}`;
        const inserted = await client.query(
          `INSERT INTO orders (order_number, customer_name, email, phone, address, city, note,
            payment_method, subtotal_vnd, shipping_fee_vnd, total_vnd)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id, order_number AS "orderNumber", subtotal_vnd AS "subtotalVnd",
             shipping_fee_vnd AS "shippingFeeVnd", total_vnd AS "totalVnd",
             status, payment_method AS "paymentMethod", created_at AS "createdAt"`,
          [orderNumber, parsed.data.customer.name, parsed.data.customer.email, parsed.data.customer.phone,
            parsed.data.customer.address, parsed.data.customer.city, parsed.data.customer.note,
            parsed.data.paymentMethod, subtotal, shippingFee, total]
        );
        const createdOrder = inserted.rows[0];
        if (clientReference) {
          await client.query('UPDATE orders SET client_reference = $2 WHERE id = $1', [createdOrder.id, clientReference]);
        }
        if(shippingSelection){
          await client.query('INSERT INTO order_shipping_selection(order_id,carrier_id,carrier_name,fee_vnd,config_version) VALUES($1,$2,$3,$4,$5)',[createdOrder.id,shippingSelection.id,shippingSelection.name,shippingFee,shippingSelection.version]);
          createdOrder.shippingCarrierName=shippingSelection.name;
        } else {
          try {
            const optimal = allocateOptimalCarrier(parsed.data.customer.city);
            await client.query('INSERT INTO order_shipping_selection(order_id,carrier_id,carrier_name,fee_vnd,config_version) VALUES($1,$2,$3,$4,1) ON CONFLICT (order_id) DO NOTHING',[createdOrder.id,optimal.id,optimal.name,shippingFee]);
            createdOrder.shippingCarrierName=optimal.name;
          } catch(e){}
        }
        if(promotion){await require("./marketing").redeem(client,promotion,req.session.customer.id,createdOrder.id);createdOrder.discountVnd=promotion.discountVnd;createdOrder.voucherCode=promotion.voucher.code;}
        if (req.session?.customer?.id) {
          await client.query('UPDATE orders SET customer_id=$2 WHERE id=$1 AND EXISTS (SELECT 1 FROM customers WHERE id=$2 AND active=true)', [createdOrder.id, req.session.customer.id]);
        }
        if(checkoutAccounts)await require("./checkout-account").enroll(client,createdOrder,parsed.data.customer,req.session?.customer?.id);
        for (const item of prepared) {
          await client.query(
            `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku,
              unit_price_vnd, quantity, line_total_vnd, original_price_vnd, promotion_snapshot)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [createdOrder.id, item.id, item.productName, item.variantName, item.sku,
              item.priceVnd, item.quantity, item.lineTotalVnd !== undefined ? item.lineTotalVnd : item.priceVnd * item.quantity,item.originalPriceVnd,item.promotion]
          );
          if (inventory) await inventory.reserveStock(client, { variantId: item.id, quantity: item.quantity, orderId: createdOrder.id, actor: { username: "customer", source: "customer" } });
          else await client.query(
            "UPDATE product_variants SET stock_quantity = stock_quantity - $2, updated_at = now() WHERE id = $1",
            [item.id, item.quantity]
          );
        }
        let paymentUrl = null;
        let bankTransfer = null;
        let gatewayCall = null;
        if (["9pay", "momo", "zalopay"].includes(parsed.data.paymentMethod)) {
          const channelConfig = req.paymentChannels?.configs?.[parsed.data.paymentMethod];
          if (!channelConfig) throw Object.assign(new Error("Kênh thanh toán vừa ngừng khả dụng. Vui lòng chọn phương thức khác."), { status: 409 });
          const gatewayNow = Date.now();
          const { validateGatewayInitiationRequest } = require("./payment-provider-clients");
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
        } else if (parsed.data.paymentMethod === "bank_transfer") {
          const channelConfig = req.paymentChannels?.configs?.bank_transfer;
          if (!channelConfig) throw Object.assign(new Error("Chuyển khoản ngân hàng vừa ngừng khả dụng. Vui lòng chọn phương thức khác."), { status: 409 });
          await client.query(
            `INSERT INTO payment_attempts (order_id, provider, transaction_ref, amount_vnd, expires_at)
             VALUES ($1, 'bank_transfer', $2, $3, now() + interval '24 hours')`,
            [createdOrder.id, createdOrder.orderNumber, createdOrder.totalVnd]
          );
          bankTransfer = require("./payment-channels").formatBankTransferInstructions(channelConfig, {
            orderNumber: createdOrder.orderNumber,
            amountVnd: createdOrder.totalVnd
          });
        }
        if (parsed.data.paymentMethod === "vnpay") {
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
        await audit(client, { actor: { username: "customer", source: "customer" }, action: "order.create", entityType: "order", entityId: createdOrder.id, metadata: { orderNumber: createdOrder.orderNumber, totalVnd: createdOrder.totalVnd, paymentMethod: parsed.data.paymentMethod } });
        return {
          order: { ...createdOrder, items: prepared.map(({ productName, variantName, sku, priceVnd, quantity }) => ({ productName, variantName, sku, priceVnd, quantity })) },
          paymentUrl,
          ...(bankTransfer ? { bankTransfer } : {}),
          gatewayCall
        };
      });

      if (order.gatewayCall) {
        const { provider, channelConfig, version, providerRequestId, gatewayNow } = order.gatewayCall;
        let gateway = null;
        try {
          gateway = await require('./payment-provider-clients').createGatewayPayment(provider, channelConfig, {
            amountVnd: order.order.totalVnd,
            txnRef: order.order.orderNumber,
            requestId: providerRequestId,
            now: gatewayNow,
            baseUrl: publicBaseUrl,
            fetcher: paymentFetcher
          });
        } catch (gwError) {
          // Safe gateway failure handling: NEVER permanently delete the order or financial vouchers.
          const recovery = await withTransaction(pool, async (client) => {
            const lockedOrder = (await client.query(
              `SELECT id, order_number AS "orderNumber", status AS "orderStatus",
                 payment_status AS "paymentStatus", voucher_code AS "voucherCode",
                 EXISTS (SELECT 1 FROM sales_receipts sr WHERE sr.order_id = orders.id) AS "hasReceipt"
               FROM orders
               WHERE id = $1
               FOR UPDATE`,
              [order.order.id]
            )).rows[0];
            const lockedAttempt = (await client.query(
              `SELECT id AS "attemptId", status AS "attemptStatus", provider_request_id AS "providerRequestId"
               FROM payment_attempts
               WHERE order_id = $1 AND provider = $2
               FOR UPDATE`,
              [order.order.id, provider]
            )).rows[0];
            const locked = lockedOrder ? { ...lockedOrder, ...(lockedAttempt || {}) } : null;

            if (locked && (locked.paymentStatus === 'paid' || locked.attemptStatus === 'paid' || locked.hasReceipt)) {
              await audit(client, {
                actor: { username: provider, source: 'payment_gateway' },
                action: 'payment.initiation.settled_during_timeout',
                entityType: 'order',
                entityId: order.order.id,
                before: { attemptStatus: locked.attemptStatus, orderStatus: locked.orderStatus, paymentStatus: locked.paymentStatus },
                after: { attemptStatus: 'paid', orderStatus: locked.orderStatus, paymentStatus: 'paid' },
                metadata: {
                  provider,
                  orderNumber: order.order.orderNumber,
                  providerRequestId: locked.providerRequestId || providerRequestId,
                  errorCode: gwError.code || 'PAYMENT_TIMEOUT'
                }
              });
              return { settledByIpn: true, orderStatus: locked.orderStatus };
            }

            if (gwError.ambiguous === false) {
              // Definite non-ambiguous rejection from provider (verified no order created & unpaid under lock)
              if (locked?.attemptId) {
                await client.query(
                  `UPDATE payment_attempts
                   SET status = 'failed', response_code = $2, last_error_code = $3, updated_at = now()
                   WHERE id = $1`,
                  [locked.attemptId, gwError.gatewayResultCode !== undefined ? String(gwError.gatewayResultCode) : null, gwError.code || 'PAYMENT_PROVIDER_REJECTED']
                );
              }
              if (locked && locked.orderStatus !== 'cancelled' && locked.orderStatus !== 'completed') {
                if (locked.voucherCode) {
                  await client.query('UPDATE voucher_redemptions SET released = true WHERE order_id = $1 AND released = false', [order.order.id]);
                }
                if (inventory) {
                  await inventory.releaseOrderStock(client, { orderId: order.order.id, actor: { username: 'system', source: 'gateway_rejection' } });
                } else {
                  await client.query(
                    `UPDATE product_variants v SET stock_quantity = v.stock_quantity + i.quantity, updated_at = now()
                     FROM order_items i WHERE i.order_id = $1 AND i.variant_id = v.id`,
                    [order.order.id]
                  );
                }
                await client.query("UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1", [order.order.id]);
                await client.query("UPDATE order_email_outbox SET status = 'skipped', finished_at = now(), result = 'Đơn hủy do cổng thanh toán từ chối' WHERE order_id = $1 AND status = 'pending'", [order.order.id]);
              }
              await audit(client, {
                actor: { username: 'system', source: 'gateway_rejection' },
                action: 'payment.initiation.rejected',
                entityType: 'order',
                entityId: order.order.id,
                before: { attemptStatus: locked?.attemptStatus || 'pending', orderStatus: locked?.orderStatus || 'pending', paymentStatus: locked?.paymentStatus || 'pending' },
                after: { attemptStatus: 'failed', orderStatus: 'cancelled', paymentStatus: locked?.paymentStatus || 'pending' },
                metadata: {
                  provider,
                  orderNumber: order.order.orderNumber,
                  providerRequestId: locked?.providerRequestId || providerRequestId,
                  errorCode: gwError.code || 'PAYMENT_PROVIDER_REJECTED',
                  gatewayResultCode: gwError.gatewayResultCode ?? null
                }
              });
              return { settledByIpn: false, reconciliationStatus: 'cancelled_unpaid' };
            }

            // Ambiguous outcome (timeout, network error, HTTP 5xx, invalid/mismatched response, duplicate code):
            // Keep order & attempt & reserved stock intact until gateway query verifies no money was taken!
            if (locked?.attemptId) {
              await client.query(
                `UPDATE payment_attempts
                 SET status = 'payment_initiation_unknown', last_error_code = $2, updated_at = now()
                 WHERE id = $1`,
                [locked.attemptId, gwError.code || 'PAYMENT_INITIATION_UNKNOWN']
              );
            }
            await audit(client, {
              actor: { username: 'system', source: 'payment_gateway' },
              action: 'payment.initiation.unknown',
              entityType: 'order',
              entityId: order.order.id,
              before: { attemptStatus: locked?.attemptStatus || 'pending', orderStatus: locked?.orderStatus || 'pending', paymentStatus: locked?.paymentStatus || 'pending' },
              after: { attemptStatus: 'payment_initiation_unknown', orderStatus: locked?.orderStatus || 'pending', paymentStatus: locked?.paymentStatus || 'pending' },
              metadata: {
                provider,
                orderNumber: order.order.orderNumber,
                providerRequestId: locked?.providerRequestId || providerRequestId,
                errorCode: gwError.code || 'PAYMENT_INITIATION_UNKNOWN'
              }
            });
            await client.query('SAVEPOINT sp_enqueue_reconcile');
            try {
              const { enqueueJob } = require('./job-queue');
              await enqueueJob(client, {
                name: 'payment.reconcile',
                idempotencyKey: `payment-reconcile:${order.order.id}:${locked?.providerRequestId || providerRequestId}`,
                payload: { orderId: order.order.id, orderNumber: order.order.orderNumber, provider },
                runAt: new Date(Date.now() + 15000)
              });
              await client.query('RELEASE SAVEPOINT sp_enqueue_reconcile');
            } catch {
              await client.query('ROLLBACK TO SAVEPOINT sp_enqueue_reconcile').catch(() => {});
            }
            return { settledByIpn: false, reconciliationStatus: 'payment_initiation_unknown' };
          });

          if (recovery.settledByIpn) {
            order.order.status = recovery.orderStatus;
            order.order.paymentStatus = 'paid';
            return res.status(201).json({
              order: order.order,
              paymentUrl: null,
              paymentSettled: true,
              reconciliationStatus: 'paid',
              message: 'Giao dịch đã được xác nhận thanh toán thành công từ cổng thanh toán.'
            });
          }

          return res.status(gwError.status || 502).json({
            error: gwError.message,
            code: gwError.code || 'PAYMENT_GATEWAY_ERROR',
            ambiguous: gwError.ambiguous !== false,
            orderId: order.order.id,
            orderNumber: order.order.orderNumber,
            providerRequestId,
            reconciliationStatus: recovery.reconciliationStatus
          });
        }

        order.paymentUrl = gateway.paymentUrl;
        try {
          const postSave = await withTransaction(pool, async (client) => {
            const lockedOrder = (await client.query(
              `SELECT status AS "orderStatus", payment_status AS "paymentStatus"
               FROM orders WHERE id = $1 FOR UPDATE`,
              [order.order.id]
            )).rows[0];
            const lockedAttempt = (await client.query(
              `SELECT id AS "attemptId", status AS "attemptStatus"
               FROM payment_attempts WHERE order_id = $1 AND provider = $2 FOR UPDATE`,
              [order.order.id, provider]
            )).rows[0];
            const locked = lockedOrder ? { ...lockedOrder, ...(lockedAttempt || {}) } : null;
            await client.query(
              `UPDATE payment_attempts
               SET provider_request_id = COALESCE(provider_request_id, $3),
                   provider_transaction_id = COALESCE(provider_transaction_id, $4),
                   payment_url = $5,
                   status = CASE
                     WHEN status IN ('payment_initiation_unknown', 'awaiting_reconciliation') THEN 'pending'
                     ELSE status
                   END,
                   last_error_code = NULL,
                   updated_at = now()
               WHERE order_id = $1 AND provider = $2`,
              [order.order.id, provider, gateway.requestId, gateway.providerTransactionId, gateway.paymentUrl]
            );
            if (version) {
              await require('./payment-channels').recordGatewayEvidence(client, provider, version, { method: 'provider_order_create', scope: 'api_credentials', enabled: true });
            }
            return locked;
          });
          if (postSave?.paymentStatus === 'paid' || postSave?.attemptStatus === 'paid') {
            order.order.status = postSave.orderStatus;
            order.order.paymentStatus = 'paid';
          }
        } catch (persistError) {
          let settled = false;
          let currentOrderStatus = order.order.status;
          try {
            await withTransaction(pool, async (client) => {
              const lockedOrder = (await client.query(
                `SELECT status AS "orderStatus", payment_status AS "paymentStatus",
                   EXISTS (SELECT 1 FROM sales_receipts sr WHERE sr.order_id = orders.id) AS "hasReceipt"
                 FROM orders WHERE id = $1 FOR UPDATE`,
                [order.order.id]
              )).rows[0];
              const lockedAttempt = (await client.query(
                `SELECT id AS "attemptId", status AS "attemptStatus"
                 FROM payment_attempts WHERE order_id = $1 AND provider = $2 FOR UPDATE`,
                [order.order.id, provider]
              )).rows[0];
              const locked = lockedOrder ? { ...lockedOrder, ...(lockedAttempt || {}) } : null;
              if (locked && (locked.paymentStatus === 'paid' || locked.attemptStatus === 'paid' || locked.hasReceipt)) {
                settled = true;
                currentOrderStatus = locked.orderStatus;
                return;
              }
              if (locked?.attemptId) {
                await client.query(
                  `UPDATE payment_attempts
                   SET status = 'awaiting_reconciliation',
                       last_error_code = 'PAYMENT_RESPONSE_PERSIST_FAILED',
                       updated_at = now()
                   WHERE id = $1`,
                  [locked.attemptId]
                );
              }
              await audit(client, {
                actor: { username: 'system', source: 'payment_gateway' },
                action: 'payment.initiation.awaiting_reconciliation',
                entityType: 'order',
                entityId: order.order.id,
                before: { attemptStatus: locked?.attemptStatus || 'pending', orderStatus: locked?.orderStatus || 'pending', paymentStatus: locked?.paymentStatus || 'pending' },
                after: { attemptStatus: 'awaiting_reconciliation', orderStatus: locked?.orderStatus || 'pending', paymentStatus: locked?.paymentStatus || 'pending' },
                metadata: {
                  provider,
                  orderNumber: order.order.orderNumber,
                  providerRequestId: gateway.requestId || providerRequestId,
                  errorCode: 'PAYMENT_RESPONSE_PERSIST_FAILED',
                  reason: persistError?.message || 'DB persist failed'
                }
              });
            });
          } catch {
            // Order & payment_attempts with provider_request_id remain safely committed from Transaction 1
          }
          if (settled) {
            order.order.status = currentOrderStatus;
            order.order.paymentStatus = 'paid';
            return res.status(201).json({
              order: order.order,
              paymentUrl: gateway.paymentUrl,
              paymentSettled: true,
              reconciliationStatus: 'paid',
              message: 'Giao dịch đã được xác nhận thanh toán thành công.'
            });
          }
          return res.status(502).json({
            error: 'Đã khởi tạo giao dịch tại cổng thanh toán nhưng chưa lưu được phản hồi cục bộ. Đơn hàng được giữ nguyên để đối soát tự động.',
            code: 'PAYMENT_RESPONSE_PERSIST_FAILED',
            ambiguous: true,
            orderId: order.order.id,
            orderNumber: order.order.orderNumber,
            providerRequestId: gateway.requestId || providerRequestId,
            paymentUrl: gateway.paymentUrl,
            reconciliationStatus: 'awaiting_reconciliation'
          });
        }
      }

      res.status(201).json({
        order: order.order,
        paymentUrl: order.paymentUrl,
        ...(order.bankTransfer ? { bankTransfer: order.bankTransfer } : {}),
        message: parsed.data.paymentMethod === "cod"
          ? "Đã tiếp nhận đơn hàng COD. GAERU sẽ xác nhận đơn và thu tiền khi giao hàng."

          : parsed.data.paymentMethod === "bank_transfer"
            ? "Đã tiếp nhận đơn chuyển khoản. Sau khi giao dịch được xác nhận khớp số tiền và mã đơn, đơn hàng sẽ tự động chuyển sang trạng thái Chờ gửi hàng."
            : `Đã tạo phiên thanh toán ${parsed.data.paymentMethod.toUpperCase()}. Sau khi thanh toán thành công, đơn hàng sẽ tự động duyệt sang trạng thái Chờ gửi hàng.`



      });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.use("/gaeru_ceo", requireAdmin);

  router.post("/gaeru_ceo/uploads", requireCsrf, parseImageUpload, async (req, res, next) => {
    let uploadedPath;
    try {
      if (!req.file) return res.status(400).json({ error: "Chọn một tệp ảnh để tải lên." });
      const signatures = [
        { type: "image/png", ext: "png", valid: req.file.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
        { type: "image/jpeg", ext: "jpg", valid: req.file.buffer[0] === 0xff && req.file.buffer[1] === 0xd8 && req.file.buffer[2] === 0xff },
        { type: "image/webp", ext: "webp", valid: req.file.buffer.toString("ascii", 0, 4) === "RIFF" && req.file.buffer.toString("ascii", 8, 12) === "WEBP" }
      ];
      const image = signatures.find((entry) => entry.type === req.file.mimetype && entry.valid);
      if (!image) return res.status(400).json({ error: "Nội dung tệp không khớp định dạng ảnh được phép." });
      const uploaded=await require('./lib/stored-media').storeUpload('products',req.file.buffer,req.file.mimetype);
      const saved=await withTransaction(pool,async client=>{const row=(await client.query('INSERT INTO catalog_images(content,mime_type) VALUES($1,$2) RETURNING id',[uploaded.content,uploaded.mimeType])).rows[0];await audit(client,{actor:req.admin,action:'catalog.image.upload',entityType:'product_image',entityId:row.id,metadata:{size:uploaded.byteSize,type:uploaded.mimeType}});return row;});
      res.status(201).json({imageUrl:'/api/catalog-images/'+saved.id});
    } catch (error) {
      next(error);
    }
  });

  router.get("/gaeru_ceo/customers", async (req, res, next) => {
    try {
      await require("./account-retention").lockExpiredJunkAccounts(pool).catch(() => {});
      const query = String(req.query.q || "").trim().slice(0, 100);
      const requestedPage = Number.parseInt(req.query.page || "1", 10);
      if (!Number.isInteger(requestedPage) || requestedPage < 1) {
        return res.status(400).json({ error: "Trang khách hàng không hợp lệ." });
      }
      const verification=String(req.query.verification||'all');
      if(!['all','verified','unverified'].includes(verification))return res.status(400).json({error:'Bộ lọc xác minh chưa hợp lệ.'});
      const status = String(req.query.status || 'all').trim().toLowerCase();
      const validStatuses = ['all', 'active', 'warning', 'locked', 'spam', 'trash'];
      if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Bộ lọc trạng thái tài khoản chưa hợp lệ.' });
      const pageSize = 25;
      const values = [query];
      const where = `($1::text = '' OR c.full_name ILIKE '%' || $1 || '%' OR c.email ILIKE '%' || $1 || '%' OR c.phone ILIKE '%' || $1 || '%')`;
      const counts=(await pool.query(`SELECT COUNT(*) FILTER(WHERE c.email_verified_at IS NOT NULL)::int AS verified,COUNT(*) FILTER(WHERE c.email_verified_at IS NULL)::int AS unverified FROM customers c WHERE ${where}`,values)).rows[0]||{verified:0,unverified:0};
      const statusCounts = (await pool.query(`
        SELECT
          COUNT(*)::int AS all,
          COUNT(*) FILTER(WHERE c.active = true AND c.deleted_at IS NULL AND (c.phone_invalid_at IS NULL OR c.phone_invalid_at > now() - interval '12 hours') AND (c.reg_email_failed_at IS NULL OR c.reg_email_failed_at > now() - interval '12 hours'))::int AS active,
          COUNT(*) FILTER(WHERE c.active = true AND c.deleted_at IS NULL AND ((c.phone_invalid_at IS NOT NULL AND c.phone_invalid_at > now() - interval '12 hours') OR (c.reg_email_failed_at IS NOT NULL AND c.reg_email_failed_at > now() - interval '12 hours')))::int AS warning,
          COUNT(*) FILTER(WHERE c.active = false AND c.deleted_at IS NULL)::int AS locked,
          COUNT(*) FILTER(WHERE (c.lock_reason = 'spam_email' OR c.lock_reason = 'invalid_phone_timeout' OR c.lock_reason = 'reg_email_failed_timeout') AND c.deleted_at IS NULL)::int AS spam,
          COUNT(*) FILTER(WHERE c.deleted_at IS NOT NULL)::int AS trash
        FROM customers c WHERE ${where}`, values)).rows[0] || { all: 0, active: 0, warning: 0, locked: 0, spam: 0, trash: 0 };
      let statusWhere = '';
      if (status === 'trash') {
        statusWhere = ' AND c.deleted_at IS NOT NULL';
      } else if (status === 'active') {
        statusWhere = " AND c.active = true AND c.deleted_at IS NULL AND (c.phone_invalid_at IS NULL OR c.phone_invalid_at > now() - interval '12 hours') AND (c.reg_email_failed_at IS NULL OR c.reg_email_failed_at > now() - interval '12 hours')";
      } else if (status === 'warning') {
        statusWhere = " AND c.active = true AND c.deleted_at IS NULL AND ((c.phone_invalid_at IS NOT NULL AND c.phone_invalid_at > now() - interval '12 hours') OR (c.reg_email_failed_at IS NOT NULL AND c.reg_email_failed_at > now() - interval '12 hours'))";
      } else if (status === 'locked') {
        statusWhere = ' AND c.active = false AND c.deleted_at IS NULL';
      } else if (status === 'spam') {
        statusWhere = " AND (c.lock_reason = 'spam_email' OR c.lock_reason = 'invalid_phone_timeout' OR c.lock_reason = 'reg_email_failed_timeout') AND c.deleted_at IS NULL";
      }
      const verifiedWhere=verification==='verified'?' AND c.email_verified_at IS NOT NULL':verification==='unverified'?' AND c.email_verified_at IS NULL':'';
      const filterTotalRes = await pool.query(`SELECT COUNT(*)::int AS total FROM customers c WHERE ${where}${statusWhere}${verifiedWhere}`, values);
      const total = filterTotalRes.rows[0]?.total || 0;
      const pageCount = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(requestedPage, pageCount);
      const result = await pool.query(
        `SELECT c.id, c.full_name AS "fullName", c.email, c.phone, c.active,c.deleted_at AS "deletedAt",c.deletion_recoverable AS "deletionRecoverable",(c.deleted_at>now()-interval '1 year') AS "canRestore",
                c.email_verified_at IS NOT NULL AS "emailVerified", c.created_at AS "createdAt",
                c.phone_invalid_at AS "phoneInvalidAt", c.lock_reason AS "lockReason", c.locked_at AS "lockedAt", c.reg_email_failed_at AS "regEmailFailedAt", c.google_id AS "googleId",
                COUNT(o.id)::int AS "orderCount", MAX(o.created_at) AS "lastOrderAt"
         FROM customers c
         LEFT JOIN orders o ON o.customer_id=c.id OR (o.customer_id IS NULL AND lower(o.email)=lower(c.email))
         WHERE ${where}${statusWhere}${verifiedWhere}
         GROUP BY c.id ORDER BY c.created_at DESC LIMIT $2 OFFSET $3`,
        [query, pageSize, (page - 1) * pageSize]
      );
      const customers = result.rows.map(row => {
        const phoneCheck = checkCustomerPhoneStatus({
          phone: row.phone,
          phone_invalid_at: row.phoneInvalidAt,
          created_at: row.createdAt
        });
        const regEmailCheck = checkCustomerRegEmailStatus({
          reg_email_failed_at: row.regEmailFailedAt,
          google_id: row.googleId,
          email_verified: row.emailVerified
        });
        return {
          ...row,
          phoneWarning: phoneCheck.isWarning,
          phoneWarningHours: phoneCheck.remainingHours,
          phoneWarningExpiresAt: phoneCheck.warningExpiresAt,
          regEmailWarning: regEmailCheck.isWarning,
          regEmailWarningHours: regEmailCheck.remainingHours,
          regEmailWarningExpiresAt: regEmailCheck.warningExpiresAt
        };
      });
      res.json({
        customers,
        verification,
        verificationCounts:{all:Number(counts.verified)+Number(counts.unverified),verified:Number(counts.verified),unverified:Number(counts.unverified)},
        status,
        statusCounts,
        filterCounts: statusCounts,
        pagination: { page, pageSize, total, pageCount }
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/gaeru_ceo/customers/:id", requireUuidParam("id"), async (req, res, next) => {
    try {
      const customerResult = await pool.query(
        `SELECT id, full_name AS "fullName", email, phone, active,
                email_verified_at IS NOT NULL AS "emailVerified", created_at AS "createdAt"
         FROM customers WHERE id = $1`, [req.params.id]
      );
      const customer = customerResult.rows[0];
      if (!customer) return res.status(404).json({ error: "Không tìm thấy khách hàng." });
      const orders = await pool.query(
        `SELECT id, order_number AS "orderNumber", status, payment_method AS "paymentMethod",
                payment_status AS "paymentStatus", total_vnd AS "totalVnd", created_at AS "createdAt"
         FROM orders WHERE customer_id=$2 OR (customer_id IS NULL AND lower(email) = lower($1)) ORDER BY created_at DESC LIMIT 50`, [customer.email,customer.id]
      );
      res.json({ customer, orders: orders.rows });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/gaeru_ceo/customers/:id", requireUuidParam("id"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = z.object({ active: z.boolean() }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Trạng thái khách hàng chưa hợp lệ." });
      const customer = await withTransaction(pool, async (client) => {
      const result = await client.query(
        `UPDATE customers SET active = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, full_name AS "fullName", email, phone, active,
                   email_verified_at IS NOT NULL AS "emailVerified"`,
        [req.params.id, parsed.data.active]
      );
      if (!result.rowCount) return null;
      await audit(client, { actor: req.admin, action: "customer.access.update", entityType: "customer", entityId: req.params.id, metadata: { active: parsed.data.active } });
      return result.rows[0];
      });
      if (!customer) return res.status(404).json({ error: "Không tìm thấy khách hàng." });
      res.json({ customer });
    } catch (error) {
      next(error);
    }
  });

  const { getTrafficSummary } = require("./traffic-tracker");

  router.get("/gaeru_ceo/summary", async (req, res) => {
    const [products, orders, settings, traffic] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE active)::int AS active,
        (SELECT COUNT(*)::int FROM product_variants v JOIN products p ON p.id = v.product_id
         WHERE v.active = true AND p.active = true AND v.stock_quantity <= 5) AS "lowStock"
        FROM products WHERE deleted_at IS NULL`),
      pool.query(`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status NOT IN ('completed', 'cancelled'))::int AS "needsAction",
        COUNT(*) FILTER (WHERE payment_status = 'pending' AND status <> 'cancelled' AND return_completed_at IS NULL)::int AS "paymentPending"
        FROM orders`),
      getSettings(pool, ["shipping_rates"]),
      getTrafficSummary(pool)
    ]);
    const shippingRatesConfigured = Object.keys(settings.shipping_rates || {}).length > 0;
    res.json({ products: products.rows[0], orders: orders.rows[0], ordersEnabled:req.ordersEnabled, shippingRatesConfigured, traffic });
  });

  router.get("/gaeru_ceo/traffic-summary", async (req, res) => {
    res.json(await getTrafficSummary(pool));
  });

  router.get("/gaeru_ceo/products", async (req, res) => {
    res.json({ products: await loadProducts(pool, { includeDrafts: true, deleted:req.query.scope==="trash", search: String(req.query.q || "") }) });
  });

  router.post("/gaeru_ceo/products", requireCsrf, async (req, res, next) => {
    try {
      const parsed = productSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Thông tin sản phẩm chưa hợp lệ.", details: parsed.error.issues });
      const product = await withTransaction(pool, async (client) => {
        return await CatalogService.createProduct(client, { data: parsed.data, actor: req.admin });
      });
      res.status(201).json({ id: product.id });
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ error: "Slug sản phẩm đã được sử dụng." });
      next(error);
    }
  });

  router.delete('/gaeru_ceo/products/:id', requireUuidParam('id'), requirePermission('catalog.write'), requireCsrf, async (req,res,next)=>{
    const parsed=z.object({version:z.number().int().positive(),confirmation:z.literal('DELETE_PRODUCT')}).strict().safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:'Xác nhận sản phẩm cần xóa và tải lại dữ liệu mới nhất.'});
    try{
      await withTransaction(pool,async client=>{
        await CatalogService.softDeleteProduct(client, {
          productId: req.params.id,
          expectedVersion: parsed.data.version,
          actor: req.admin
        });
      });
      res.status(204).end();
    }catch(error){if(error.status)return res.status(error.status).json({error:error.message});next(error);}
  });

  require('./product-trash').attachProductTrash(router,pool);

  const handleProductVisibility = async (req, res, next) => {
    try {
      const parsed = z.object({ active: z.boolean().optional(), version: z.number().int().positive().optional() }).strict().safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ error: "Trạng thái hiển thị sản phẩm không hợp lệ." });
      }
      const product = await withTransaction(pool, async (client) => {
        return await CatalogService.setProductVisibility(client, {
          productId: req.params.id,
          active: parsed.data.active,
          expectedVersion: parsed.data.version,
          actor: req.admin,
          auditFn: audit
        });
      });

      if (!product) return res.status(404).json({ error: "Không tìm thấy sản phẩm." });
      res.json({
        message: product.active ? "Đã hiển thị sản phẩm trên cửa hàng." : "Đã ẩn sản phẩm khỏi cửa hàng.",
        id: product.id,
        active: product.active
      });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  };

  router.post("/gaeru_ceo/products/:id/visibility", requireUuidParam("id"), requirePermission("catalog.write"), requireCsrf, handleProductVisibility);
  router.patch("/gaeru_ceo/products/:id/visibility", requireUuidParam("id"), requirePermission("catalog.write"), requireCsrf, handleProductVisibility);

  router.put("/gaeru_ceo/products/:id", requireUuidParam("id"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = productSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Thông tin sản phẩm chưa hợp lệ.", details: parsed.error.issues });
      const expectedVersion = Number.isInteger(req.body?.version) && req.body.version > 0 ? req.body.version : undefined;
      const product = await withTransaction(pool, async (client) => {
        return await CatalogService.updateProduct(client, {
          productId: req.params.id,
          data: parsed.data,
          expectedVersion,
          actor: req.admin,
          auditFn: audit
        });
      });
      if (!product) return res.status(404).json({ error: "Không tìm thấy sản phẩm." });
      res.json({ id: product.id });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      if (error.code === "23505") return res.status(409).json({ error: "Slug sản phẩm đã được sử dụng." });
      next(error);
    }
  });

  router.post("/gaeru_ceo/products/:id/variants", requireUuidParam("id"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = variantSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Thông tin phiên bản chưa hợp lệ.", details: parsed.error.issues });
      const v = parsed.data;
      if (req.admin && v.stockQuantity > 0 && !req.admin.permissions.includes("inventory.approve")) return res.status(403).json({ error: "Cần quyền duyệt kho để khai báo tồn đầu kỳ." });
      const variant = await withTransaction(pool, async (client) => {
      const result = await client.query(
        `INSERT INTO product_variants (product_id, sku, name, options, price_vnd, stock_quantity, active)
         SELECT id, $2, $3, $4, $5, $6, $7 FROM products WHERE id=$1 AND deleted_at IS NULL
         RETURNING id`,
        [req.params.id, v.sku, v.name, v.options, v.priceVnd, v.stockQuantity, v.active]
      );
      if (!result.rowCount) return null;
      if (inventory) await inventory.initializeVariantStock(client, { variantId: result.rows[0].id, quantity: v.stockQuantity, actor: req.admin });
      await audit(client, { actor: req.admin, action: "catalog.variant.create", entityType: "variant", entityId: result.rows[0].id, after: v });
      return result.rows[0];
      });
      if (!variant) return res.status(404).json({ error: "Không tìm thấy sản phẩm." });
      res.status(201).json({ id: variant.id });
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ error: "SKU đã được sử dụng." });
      next(error);
    }
  });

  router.put("/gaeru_ceo/variants/:id", requireUuidParam("id"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = variantSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Thông tin phiên bản chưa hợp lệ.", details: parsed.error.issues });
      const v = parsed.data;
      const variant = await withTransaction(pool, async (client) => {
        const current = await lockVariantWithProduct(client, req.params.id);
        if (!current) return null;
        if (req.admin && v.stockQuantity !== current.variant.stockQuantity && !req.admin.permissions.includes("inventory.approve")) {
          const error = new Error("Cần quyền duyệt kho để thay đổi số lượng tồn."); error.status = 403; throw error;
        }
        if (!v.active) await requireAnotherActiveVariant(client, current.product, current.variant);
        if (inventory) await inventory.setVariantStock(client, { variantId: req.params.id, quantity: v.stockQuantity, actor: req.admin, reason: "Điều chỉnh từ trang phiên bản sản phẩm" });
        const result = await client.query(
          `UPDATE product_variants SET sku=$2, name=$3, options=$4, price_vnd=$5,
            stock_quantity=$6, active=$7, updated_at=now() WHERE id=$1 RETURNING id`,
          [req.params.id, v.sku, v.name, v.options, v.priceVnd, v.stockQuantity, v.active]
        );
        await audit(client, { actor: req.admin, action: "catalog.variant.update", entityType: "variant", entityId: req.params.id, after: v });
        return result.rows[0];
      });
      if (!variant) return res.status(404).json({ error: "Không tìm thấy phiên bản." });
      res.json({ id: variant.id });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      if (error.code === "23505") return res.status(409).json({ error: "SKU đã được sử dụng." });
      next(error);
    }
  });

  router.delete("/gaeru_ceo/variants/:id", requireUuidParam("id"), requireCsrf, async (req, res, next) => {
    try {
      const result = await withTransaction(pool, async (client) => {
        const current = await lockVariantWithProduct(client, req.params.id);
        if (!current) return { missing: true };
        const references = await client.query(
          "SELECT EXISTS (SELECT 1 FROM order_items WHERE variant_id=$1) AS referenced",
          [req.params.id]
        );
        if (references.rows[0].referenced) return { inUse: true };
        if (inventory) {
          const history = await client.query("SELECT EXISTS (SELECT 1 FROM inventory_movements WHERE variant_id=$1) AS referenced", [req.params.id]);
          if (history.rows[0].referenced) return { inUse: true };
        }
        await requireAnotherActiveVariant(client, current.product, current.variant);
        await client.query("DELETE FROM product_variants WHERE id=$1", [req.params.id]);
        await audit(client, { actor: req.admin, action: "catalog.variant.delete", entityType: "variant", entityId: req.params.id });
        return { deleted: true };
      });
      if (result.missing) return res.status(404).json({ error: "Không tìm thấy phiên bản." });
      if (result.inUse) return res.status(409).json({ error: "Phiên bản đã có trong lịch sử đơn hàng hoặc kho. Hãy sửa và tạm ẩn thay vì xóa." });
      res.status(204).end();
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      if (error.code === "23503") return res.status(409).json({ error: "Phiên bản đã có trong chứng từ. Hãy tạm ẩn thay vì xóa." });
      next(error);
    }
  });

  router.get("/gaeru_ceo/orders", async (req, res) => {
    const status = String(req.query.status || "");
    if (status && !Object.hasOwn(transitions, status) && !['ready_to_ship','cancelled_or_returned','payment_pending'].includes(status)) {
      return res.status(400).json({ error: "Bộ lọc trạng thái đơn hàng không hợp lệ." });
    }
    const paymentStatus = String(req.query.paymentStatus || "");
    const paymentMethod = String(req.query.paymentMethod || "");
    if ((paymentStatus && !["pending", "paid"].includes(paymentStatus)) ||
        (paymentMethod && !["cod", "bank_transfer", "9pay", "vnpay", "momo", "zalopay"].includes(paymentMethod))) {
      return res.status(400).json({ error: "Bộ lọc thanh toán đơn hàng không hợp lệ." });
    }
    const search = String(req.query.q || "").trim();
    const requestedPage = Number(req.query.page || 1);
    if (search.length > 120 || !Number.isInteger(requestedPage) || requestedPage < 1 || requestedPage > 100000) {
      return res.status(400).json({ error: "Bộ lọc hoặc trang đơn hàng không hợp lệ." });
    }
    const pageSize = Number(req.query.pageSize || 25);
    const sort = String(req.query.sort || 'newest');
    const sortSql = {newest:'o.created_at DESC, o.id DESC',oldest:'o.created_at ASC, o.id ASC',highest:'o.total_vnd DESC NULLS LAST, o.id DESC',lowest:'o.total_vnd ASC NULLS LAST, o.id ASC'};
    if (![20,25,50,100].includes(pageSize) || !Object.hasOwn(sortSql, sort)) return res.status(400).json({error:'Bộ lọc sắp xếp hoặc số đơn mỗi trang không hợp lệ.'});
    const exportXlsx = req.query.format === 'xlsx';
    const exportAll = exportXlsx && req.query.scope === 'all';
    const filterValues = [status, search, paymentStatus, paymentMethod];
    const excludeReviews = checkoutAccounts && status !== 'payment_pending' && !search;
    const where = `${excludeReviews ? "NOT EXISTS (SELECT 1 FROM order_reviews r WHERE r.order_id=o.id AND r.resolved_at IS NULL) AND " : ""}($1::text = '' OR o.status = $1
      OR ($1='ready_to_ship' AND o.status IN ('confirmed','processing') AND o.return_completed_at IS NULL)
      OR ($1='payment_pending' AND o.payment_status = 'pending' AND o.status <> 'cancelled' AND o.return_completed_at IS NULL)
      OR ($1='cancelled_or_returned' AND (o.status='cancelled' OR EXISTS(SELECT 1 FROM order_after_sales a WHERE a.order_id=o.id AND a.kind='return'))))
      AND ($2::text = '' OR o.order_number ILIKE '%' || $2 || '%'
        OR o.customer_name ILIKE '%' || $2 || '%'
        OR o.email ILIKE '%' || $2 || '%' OR o.phone ILIKE '%' || $2 || '%')
      AND ($3::text = '' OR (o.payment_status = $3 AND ($3 <> 'pending' OR (o.status <> 'cancelled' AND o.return_completed_at IS NULL) OR $1 IN ('cancelled','cancelled_or_returned'))))
      AND ($4::text = '' OR o.payment_method = $4)
      AND ($1 NOT IN ('completed','shipped') OR o.return_completed_at IS NULL)`;
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM orders o WHERE ${where}`,
      filterValues
    );
    const total = countResult.rows[0]?.total || 0;
    if (exportAll && total > 5000) return res.status(400).json({error:"Có hơn 5.000 đơn. Thu hẹp bộ lọc hoặc xuất từng trang."});
    const pageCount = Math.ceil(total / pageSize);
    const page = Math.min(requestedPage, Math.max(1, pageCount));
    const result = await pool.query(
      `SELECT o.id, o.order_number AS "orderNumber", o.customer_name AS "customerName",
        o.email, o.phone, o.address, o.city, o.note, o.payment_method AS "paymentMethod",
        o.payment_status AS "paymentStatus", o.status, o.discount_vnd AS "discountVnd",o.voucher_code AS "voucherCode",o.subtotal_vnd AS "subtotalVnd",
        o.shipping_fee_vnd AS "shippingFeeVnd", o.total_vnd AS "totalVnd", o.created_at AS "createdAt",o.management_version AS version,o.return_completed_at AS "returnedAt",
        (SELECT s.carrier_name FROM order_shipping_selection s WHERE s.order_id=o.id LIMIT 1) AS "shippingCarrierName",
        (SELECT s.carrier_id FROM order_shipping_selection s WHERE s.order_id=o.id LIMIT 1) AS "shippingCarrierId",
        CASE WHEN o.return_completed_at IS NOT NULL THEN 'returned' WHEN EXISTS(SELECT 1 FROM order_after_sales a WHERE a.order_id=o.id AND a.kind='return' AND a.status NOT IN ('resolved','rejected')) THEN 'open' ELSE NULL END AS "returnStatus",
        p.provider AS "paymentProvider", p.status AS "paymentAttemptStatus", p.expires_at AS "paymentAttemptExpiresAt",
        ${checkoutAccounts ? '(SELECT r.reason FROM order_reviews r WHERE r.order_id=o.id AND r.resolved_at IS NULL ORDER BY r.created_at DESC LIMIT 1) AS "reviewReason",' : 'NULL AS "reviewReason",'}
        COALESCE(jsonb_agg(jsonb_build_object('productName', i.product_name, 'variantName', i.variant_name,
          'sku', i.sku, 'unitPriceVnd', i.unit_price_vnd, 'quantity', i.quantity, 'lineTotalVnd', i.line_total_vnd))
          FILTER (WHERE i.id IS NOT NULL), '[]'::jsonb) AS items
       FROM orders o
       LEFT JOIN order_items i ON i.order_id = o.id
       LEFT JOIN LATERAL (
         SELECT provider, status, expires_at FROM payment_attempts WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1
       ) p ON true
       WHERE ${where}
       GROUP BY o.id, p.provider, p.status, p.expires_at ORDER BY ${sortSql[sort]} LIMIT $5 OFFSET $6`,
      [...filterValues, exportAll ? 5000 : pageSize, exportAll ? 0 : (page - 1) * pageSize]
    );
    if(shippingChoices&&result.rows.length){const selected=(await pool.query('SELECT order_id,carrier_name FROM order_shipping_selection WHERE order_id=ANY($1::uuid[])',[result.rows.map(o=>o.id)])).rows;for(const order of result.rows)order.shippingCarrierName=selected.find(r=>r.order_id===order.id)?.carrier_name||null;}
    if (finance && result.rows.length) {
      const receipts = await pool.query('SELECT order_id, SUM(amount_vnd) AS received FROM sales_receipts WHERE order_id=ANY($1::uuid[]) GROUP BY order_id', [result.rows.map((order) => order.id)]);
      const receivedByOrder = new Map(receipts.rows.map((row) => [row.order_id, Number(row.received)]));
      for (const order of result.rows) {
        order.receivedVnd = order.paymentStatus === "paid" ? order.totalVnd : (receivedByOrder.get(order.id) || 0);
        order.outstandingVnd = order.totalVnd === null ? null : Math.max(0, order.totalVnd - order.receivedVnd);
      }
    }
    if (config && result.rows.length) {
      try {
        const einvoices = await pool.query('SELECT order_id, invoice_number AS "invoiceNumber", invoice_series AS "invoiceSeries", template_code AS "templateCode", view_url AS "viewUrl", issued_at AS "issuedAt" FROM misa_einvoices WHERE order_id=ANY($1::uuid[])', [result.rows.map((order) => order.id)]);
        const invoiceMap = new Map(einvoices.rows.map((r) => [r.order_id, r]));
        for (const order of result.rows) {
          order.einvoice = invoiceMap.get(order.id) || null;
        }
      } catch {}
    }
    if (exportXlsx) {
      const buffer = await require('./order-export').orderWorkbook(result.rows);
      return res.set({'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="gaeru-orders.xlsx"','Cache-Control':'no-store'}).send(Buffer.from(buffer));
    }
    let overview;
    if (req.query.overview === '1') {
      const counts = await pool.query(`SELECT CASE WHEN o.return_completed_at IS NOT NULL THEN 'returned' ELSE o.status END AS status, COUNT(*)::int AS total FROM orders o WHERE ${checkoutAccounts ? 'NOT EXISTS (SELECT 1 FROM order_reviews r WHERE r.order_id=o.id AND r.resolved_at IS NULL)' : 'true'} GROUP BY CASE WHEN o.return_completed_at IS NOT NULL THEN 'returned' ELSE o.status END`);
      overview = Object.fromEntries(counts.rows.map(row => [row.status, row.total]));
      const cancelledAndReturns=await pool.query(`SELECT count(*)::int AS total FROM orders o WHERE ${checkoutAccounts ? 'NOT EXISTS (SELECT 1 FROM order_reviews r WHERE r.order_id=o.id AND r.resolved_at IS NULL) AND ' : ''}(o.status='cancelled' OR EXISTS(SELECT 1 FROM order_after_sales a WHERE a.order_id=o.id AND a.kind='return'))`);
      overview.cancelled_or_returned=cancelledAndReturns.rows[0]?.total||0;
    }
    res.json({
      ...(overview ? {overview} : {}),
      orders: result.rows,
      pagination: { page, pageSize, total, pageCount }
    });
  });

  async function applyOrderUpdate(client,id,update,actor){
        const currentResult = await client.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id]);
        const current = currentResult.rows[0];
        if (!current) return null;
        if(current.return_completed_at)throw Object.assign(Error('Đơn đã hoàn trả xong; không thể xử lý lại.'),{status:409});
        if (actor) {
          const fulfillmentChange = (update.status !== undefined && update.status !== current.status) || (update.shippingFeeVnd !== undefined && update.shippingFeeVnd !== current.shipping_fee_vnd);
          const paymentChange = update.paymentStatus !== undefined && update.paymentStatus !== current.payment_status;
          if ((fulfillmentChange && !actor.permissions.includes("orders.write")) || (paymentChange && !actor.permissions.includes("payments.write"))) {
            const error = new Error("Tài khoản không có quyền cập nhật nghiệp vụ này."); error.status = 403; throw error;
          }
        }
        if(checkoutAccounts && update.status && ['confirmed','processing','shipped','completed'].includes(update.status) && (await client.query('SELECT order_id FROM order_reviews WHERE order_id=$1 AND resolved_at IS NULL',[current.id])).rows.length)throw Object.assign(Error('Cần gọi xác nhận và xử lý đơn trong mục Đơn hàng rác / chờ xác minh trước.'),{status:409});
        const receivedAmount = finance ? await finance.receiptTotal(client, current.id) : 0;
        if (receivedAmount > 0 && ((update.status === "cancelled" && current.status !== "cancelled") || (update.shippingFeeVnd !== undefined && update.shippingFeeVnd !== current.shipping_fee_vnd))) {
          const error = new Error("Đơn đã ghi nhận thu tiền; cần đối soát/hoàn tiền trước khi hủy hoặc đổi tổng tiền."); error.status = 409; throw error;
        }
        const prepaidAutoProcess = current.payment_method !== "cod" && (current.payment_status === "paid" || update.paymentStatus === "paid");
        if (update.status && update.status !== current.status && !transitions[current.status].includes(update.status) && !(prepaidAutoProcess && current.status === "pending" && update.status === "processing")) {
          const error = new Error(`Không thể chuyển đơn từ ${current.status} sang ${update.status}.`);
          error.status = 409;
          throw error;
        }
        const paymentStatusChanged = update.paymentStatus !== undefined && update.paymentStatus !== current.payment_status;
        if (current.payment_status === "paid" && paymentStatusChanged) {
          const error = new Error("Không thể chuyển đơn đã thanh toán về chưa thanh toán. Cần đối soát hoặc xử lý hoàn tiền riêng.");
          error.status = 409;
          throw error;
        }
        if (paymentStatusChanged && isOnlineGateway(current.payment_method)) {
          const error = new Error("Trạng thái thanh toán trực tuyến được cập nhật từ cổng thanh toán, không thể sửa thủ công.");
          error.status = 409;
          throw error;
        }
        if (update.status === "cancelled" && current.status !== "cancelled" && current.payment_status === "paid") {
          const error = new Error("Đơn đã thanh toán cần được xử lý hoàn tiền trước khi hủy.");
          error.status = 409;
          throw error;
        }
        const autoApproveToProcessing = paymentStatusChanged && update.paymentStatus === "paid" && current.payment_method !== "cod" && ["pending", "confirmed"].includes(current.status) && (!update.status || ["pending", "confirmed", "processing"].includes(update.status));
        const targetStatus = autoApproveToProcessing ? "processing" : (update.status ?? current.status);
        const targetPaymentStatus = update.paymentStatus ?? current.payment_status;
        const shippingFee = update.shippingFeeVnd ?? current.shipping_fee_vnd;
        const shippingFeeChanged = update.shippingFeeVnd !== undefined && update.shippingFeeVnd !== current.shipping_fee_vnd;
        if (shippingFeeChanged && current.payment_status === "paid") {
          const error = new Error("Không thể thay đổi phí giao hàng sau khi đơn đã thanh toán.");
          error.status = 409;
          throw error;
        }
        if (shippingFeeChanged && isOnlineGateway(current.payment_method)) {
          const paymentAttempt = await client.query(
            "SELECT EXISTS (SELECT 1 FROM payment_attempts WHERE order_id = $1) AS active",
            [current.id]
          );
          if (paymentAttempt.rows[0]?.active) {
            const error = new Error("Không thể thay đổi phí sau khi đã tạo phiên thanh toán VNPAY.");
            error.status = 409;
            throw error;
          }
        }
        if (update.status === "cancelled" && current.status !== "cancelled" && isOnlineGateway(current.payment_method)) {
          const activeAttempt = await client.query(
            `SELECT
               EXISTS (
                 SELECT 1 FROM payment_attempts
                 WHERE order_id = $1 AND status IN ('payment_initiation_unknown', 'awaiting_reconciliation')
               ) AS unresolved,
               EXISTS (
                 SELECT 1 FROM payment_attempts
                 WHERE order_id = $1 AND status = 'pending' AND expires_at > now()
               ) AS active`,
            [current.id]
          );
          if (activeAttempt.rows[0]?.unresolved) {
            const error = new Error("Đơn đang chờ đối soát trạng thái giao dịch với cổng thanh toán; cần xác minh chưa thu tiền trước khi hủy đơn.");
            error.status = 409;
            throw error;
          }
          if (activeAttempt.rows[0]?.active) {
            const error = new Error("Chờ hết hạn phiên thanh toán VNPAY trước khi hủy đơn.");
            error.status = 409;
            throw error;
          }
        }
        if (update.shippingFeeVnd !== undefined && update.shippingFeeVnd !== current.shipping_fee_vnd && current.status !== "pending") {
          const error = new Error("Phí giao hàng chỉ được thay đổi khi đơn còn chờ xác nhận.");
          error.status = 409;
          throw error;
        }
        if (update.status === "confirmed" && update.shippingFeeVnd === undefined && current.shipping_fee_vnd === null) {
          const error = new Error("Nhập phí giao hàng để chốt tổng tiền trước khi xác nhận đơn.");
          error.status = 409;
          throw error;
        }
        if (targetStatus === "completed" && targetPaymentStatus !== "paid") {
          const error = new Error("Chỉ hoàn tất đơn sau khi xác nhận đã thu đủ tiền.");
          error.status = 409;
          throw error;
        }
        if (paymentStatusChanged && update.paymentStatus === "paid" && targetStatus === "cancelled") {
          const error = new Error("Không thể ghi nhận thanh toán cho đơn đã hủy.");
          error.status = 409;
          throw error;
        }
        if (update.paymentStatus === "paid" && shippingFee === null) {
          const error = new Error("Chốt phí giao hàng trước khi ghi nhận thanh toán.");
          error.status = 409;
          throw error;
        }
        if (update.paymentStatus === "paid" && current.payment_method === "cod" && targetStatus !== "completed") {
          const error = new Error("Đơn COD chỉ được ghi nhận đã thanh toán sau khi giao hàng.");
          error.status = 409;
          throw error;
        }
        if (update.status === "cancelled" && current.status !== "cancelled") {
          if(current.voucher_code)await client.query('UPDATE voucher_redemptions SET released=true WHERE order_id=$1 AND released=false',[current.id]);
          if (inventory) await inventory.releaseOrderStock(client, { orderId: current.id, actor: actor });
          else await client.query(
            `UPDATE product_variants v SET stock_quantity = v.stock_quantity + i.quantity, updated_at=now()
             FROM order_items i WHERE i.order_id=$1 AND i.variant_id=v.id`,
            [current.id]
          );
        }
        const total = shippingFee === null ? null : current.subtotal_vnd + shippingFee - (current.discount_vnd||0);
        if (total !== null && total > 2_000_000_000) {
          const error = new Error("Tổng đơn hàng vượt giới hạn cho phép.");
          error.status = 400;
          throw error;
        }
        if (finance && update.paymentStatus === "paid" && current.payment_status !== "paid") await finance.recordFullOrderPayment(client, { order: { ...current, total_vnd: total }, actor: actor });
        const updated = await client.query(
          `UPDATE orders SET status=COALESCE($2, status), payment_status=COALESCE($3, payment_status),
            shipping_fee_vnd=$4, total_vnd=$5, updated_at=now()
           WHERE id=$1 RETURNING id, status, payment_status AS "paymentStatus",
             shipping_fee_vnd AS "shippingFeeVnd", total_vnd AS "totalVnd"`,
          [current.id, (autoApproveToProcessing ? "processing" : update.status) || null, update.paymentStatus || null, shippingFee, total]
        );
        await audit(client, { actor: actor, action: "order.update", entityType: "order", entityId: current.id, before: { status: current.status, paymentStatus: current.payment_status, shippingFeeVnd: current.shipping_fee_vnd }, after: updated.rows[0] });
        return updated.rows[0];
  }

  router.post('/gaeru_ceo/orders/bulk',requirePermission('orders.write'),requireCsrf,rateLimit({windowMs:60000,limit:20,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res,next)=>{
    try{
      const parsed=z.object({action:z.enum(['confirm','prepare','ship','complete','cancel']),confirmReceived:z.boolean().default(false),orders:z.array(z.object({id:z.string().uuid(),expectedStatus:z.enum(['pending','confirmed','processing','shipped','completed','cancelled']),expectedPaymentStatus:z.enum(['pending','paid']),expectedTotalVnd:z.number().int().min(0).max(2000000000).nullable()}).strict()).min(1).max(100).refine(rows=>new Set(rows.map(o=>o.id)).size===rows.length)}).strict().safeParse(req.body);
      if(!parsed.success)return res.status(400).json({error:'Chọn từ 1 đến 100 đơn khác nhau và bước xử lý hợp lệ.'});
      const data=parsed.data,target={confirm:'confirmed',prepare:'processing',ship:'shipped',complete:'completed',cancel:'cancelled'}[data.action];
      const result=await withTransaction(pool,async client=>{
        const changed=[];
        for(const expected of [...data.orders].sort((a,b)=>a.id.localeCompare(b.id))){
          const current=(await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[expected.id])).rows[0];
          if(!current)throw Object.assign(Error('Có đơn không còn tồn tại. Tải lại danh sách.'),{status:409});
          if(current.status!==expected.expectedStatus||current.payment_status!==expected.expectedPaymentStatus||current.total_vnd!==expected.expectedTotalVnd)throw Object.assign(Error('Đơn '+current.order_number+' đã thay đổi. Tải lại trước khi xử lý hàng loạt.'),{status:409});
          if(!transitions[current.status].includes(target))throw Object.assign(Error('Đơn '+current.order_number+' không ở bước phù hợp. Các đơn cần cùng đủ điều kiện cho thao tác đã chọn.'),{status:409});
          const update={status:target};
          if(target==='completed'&&current.payment_status!=='paid'){
            if(!data.confirmReceived)throw Object.assign(Error('Xác nhận đã thu đủ tiền trước khi hoàn tất các đơn chưa thanh toán.'),{status:409});
            update.paymentStatus='paid';
          }
          changed.push(await applyOrderUpdate(client,expected.id,update,req.admin));
        }
        return changed;
      });
      if (target === 'completed') {
        try {
          const { autoIssueForOrder } = require('./misa-einvoice');
          for (const order of result) {
            if (order.status === 'completed' && order.paymentStatus === 'paid') {
              await autoIssueForOrder(pool, config, order.id, { fetcher: misaFetcher });
            }
          }
        } catch (misaErr) {
          console.error('MISA auto-issue error in bulk:', misaErr.message);
        }
      }
      res.json({orders:result,targetStatus:target,message:'Đã cập nhật '+result.length+' đơn hàng.'});
    }catch(error){next(error);}
  });
  router.post('/gaeru_ceo/orders/:id/restore',requirePermission('orders.write'),requireUuidParam('id'),requireCsrf,rateLimit({windowMs:60000,limit:20,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res,next)=>{
    try{const {restoreOrder,restorationSchema}=require('./order-restoration');const data=restorationSchema.parse(req.body);
      const order=await withTransaction(pool,client=>restoreOrder(client,{id:req.params.id,data,actor:req.admin,inventory:inventory||require('./inventory'),audit}));
      res.json({order,message:order.alreadyRestored?'Yêu cầu đã được xử lý trước đó.':'Đã khôi phục đơn về Chờ xác nhận và giữ lại tồn kho. Chưa ghi nhận thanh toán hoặc gửi hàng.'});
    }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Nhập lý do, phiên bản và xác nhận đã đối chiếu chưa nhận tiền trước khi khôi phục.'});if(error.code==='23505')return res.status(409).json({error:'Mã yêu cầu khôi phục đã được dùng. Tải lại để kiểm tra trạng thái.'});if(error.status)return res.status(error.status).json({error:error.message});next(error);}
  });

  router.post('/gaeru_ceo/orders/:id/reconcile-payment', requirePermission('orders.write'), requireUuidParam('id'), requireCsrf, rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }), async (req, res, next) => {
    try {
      const outcome = await require('./payment-channels').reconcileGatewayOrder(pool, {
        orderId: req.params.id,
        config: config || {},
        fetcher: paymentFetcher,
        inventory: inventory || require('./inventory'),
        finance,
        audit,
        actor: req.admin
      });
      res.json(outcome);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

    const handleOrderPermanentDelete = async (req, res, next) => {
    try {
      const { deleteOrderPermanently } = require('./order-deletion');
      const deleted = await withTransaction(pool, client =>
        deleteOrderPermanently(client, req.params.id, {
          actor: req.admin,
          inventory: inventory || require('./inventory')
        })
      );
      if (!deleted) return res.status(404).json({ error: 'Không tìm thấy đơn hàng.' });
      res.json({
        id: req.params.id,
        orderNumber: deleted.order_number,
        message: 'Đã xóa vĩnh viễn đơn hàng ' + (deleted.order_number || req.params.id) + ' khỏi hệ thống và loại khỏi dữ liệu doanh số.'
      });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  };
  router.post('/gaeru_ceo/orders/:id/permanent-delete', requirePermission('orders.write'), requireUuidParam('id'), requireCsrf, rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }), handleOrderPermanentDelete);
  router.delete('/gaeru_ceo/orders/:id', requirePermission('orders.write'), requireUuidParam('id'), requireCsrf, rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }), handleOrderPermanentDelete);

  router.patch("/gaeru_ceo/orders/:id", requireUuidParam("id"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = orderUpdateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Cập nhật đơn hàng chưa hợp lệ.", details: parsed.error.issues });
      const update = parsed.data;
      const result = await withTransaction(pool, async (client) => {
        return applyOrderUpdate(client,req.params.id,update,req.admin);
      });
      if (!result) return res.status(404).json({ error: "Không tìm thấy đơn hàng." });
      if (result.status === 'completed' && result.paymentStatus === 'paid') {
        try {
          const { autoIssueForOrder } = require('./misa-einvoice');
          await autoIssueForOrder(pool, config, req.params.id, { fetcher: misaFetcher });
        } catch (misaErr) {
          console.error('MISA auto-issue error for order ' + req.params.id + ':', misaErr.message);
        }
      }
      res.json({ order: result });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.get("/gaeru_ceo/settings", async (req, res) => {
    res.json({
      ...await getSettings(pool, ["shipping_note", "shipping_rates"]),
      paymentMethods: req.paymentChannels?.methods || ["cod", ...(req.vnpayConfig ? ["vnpay"] : [])]
    });
  });

  router.put("/gaeru_ceo/settings", requireCsrf, async (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Cài đặt chưa hợp lệ.", details: parsed.error.issues });
    const settings = {
      shipping_note: parsed.data.shippingNote,
      shipping_rates: parsed.data.shippingRates
    };
    await withTransaction(pool, async (client) => {
      for (const [key, value] of Object.entries(settings)) {
        await client.query(
          `INSERT INTO store_settings (setting_key, setting_value, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value, updated_at=now()`,
          [key, JSON.stringify(value)]
        );
      }
      await audit(client, { actor: req.admin, action: "settings.update", entityType: "store_settings", after: settings });
    });
    res.json({ settings: {
      shippingNote: settings.shipping_note,
      shippingRates: settings.shipping_rates
    } });
  });

  return router;
}

const productSchema = z.object({
  slug: z.string().trim().min(2).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(2).max(160),
  category: z.enum(["audio", "video", "accessory"]),
  descriptor: z.string().trim().max(160).default(""),
  description: z.string().trim().max(3000).default(""),
  imageUrl: z.string().trim().regex(/^(?:\/assets\/products\/[a-zA-Z0-9._-]+|\/api\/catalog-images\/[0-9a-f-]{36})$/),
  imageAlt: z.string().trim().max(250).default(""),
  active: z.boolean().default(false),
  sortOrder: z.number().int().min(-1000).max(10000).default(0)
});

const variantSchema = z.object({
  sku: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/),
  name: z.string().trim().min(1).max(160),
  options: z.record(z.string(), z.string()).default({}),
  priceVnd: z.number().int().min(0).max(20_000_000),
  stockQuantity: z.number().int().min(0).max(1_000_000),
  active: z.boolean().default(false)
});

const orderUpdateSchema = z.object({
  status: z.enum(["pending", "confirmed", "processing", "shipped", "completed", "cancelled"]).optional(),
  paymentStatus: z.enum(["pending", "paid"]).optional(),
  shippingFeeVnd: z.number().int().min(0).max(1_000_000_000).optional()
}).refine((value) => Object.keys(value).length > 0);

const settingsSchema = z.object({
  shippingNote: z.string().trim().max(1000),
  shippingRates: z.record(
    z.string().trim().min(2).max(120).regex(/^[\p{L}\p{N} .’'-]+$/u),
    z.number().int().min(0).max(1_000_000_000)
  ).default({}).superRefine((rates, context) => {
    if (Object.keys(rates).length > 100) {
      context.addIssue({ code: "custom", message: "Chỉ cấu hình tối đa 100 tỉnh/thành phố." });
    }
    const provinceNames = new Set();
    for (const province of Object.keys(rates)) {
      const normalized = province.normalize("NFC").toLocaleLowerCase("vi");
      if (provinceNames.has(normalized)) {
        context.addIssue({ code: "custom", path: [province], message: "Tỉnh/thành phố không được trùng tên." });
      }
      provinceNames.add(normalized);
    }
  })
});

function requireUuidParam(name) {
  return (req, res, next) => {
    if (!z.string().uuid().safeParse(req.params[name]).success) {
      return res.status(400).json({ error: "Mã định danh không hợp lệ." });
    }
    next();
  };
}

module.exports = { createStoreApi, loadProducts, transitions, orderSchema, productSchema, variantSchema, settingsSchema };
