const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const multer = require("multer");
const { Router } = require("express");
const { rateLimit } = require("express-rate-limit");
const { z } = require("zod");
const { requireAdmin, requireCsrf } = require("./security");
const { requirePermission } = require("./staff-access");
const { withTransaction } = require("./db");
const { buildVnpayPaymentUrl, verifyVnpayQuery } = require("./vnpay");
const { decoratePublicProductImages } = require("./lib/public-image-urls");

const orderSchema = z.object({
  customer: z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(254).transform(value=>value.toLowerCase()),
    phone: z.string().trim().regex(/^[+0-9().\s-]{8,30}$/),
    address: z.string().trim().min(5).max(250),
    city: z.string().trim().min(2).max(120),
    note: z.string().trim().max(1000).default("")
  }),
  shippingCarrierId:z.enum(['ghn','ghtk','viettel','jt']).optional(),
  expectedShippingFeeVnd:z.number().int().min(0).max(1000000000).optional(),
  expectedSubtotalVnd:z.number().int().min(0).max(2000000000).optional(),
  voucherCode: z.string().trim().toUpperCase().max(40).optional(),
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
  if(!includeDrafts){const priced=await require("./product-promotions").applyPromotions(pool,result.rows.flatMap(p=>p.variants));const byId=new Map(priced.map(v=>[v.id,v]));for(const p of result.rows)p.variants=p.variants.map(v=>byId.get(v.id));}
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

function createStoreApi(pool, { ordersEnabled = false, getOrdersEnabled = null, vnpayConfig = null, getVnpayConfig = null, paymentChannels = null, getPaymentChannels = null, publicBaseUrl = "https://gaeru.com", inventory = null, finance = null, audit = async () => {}, shippingChoices = false, checkoutAccounts = false } = {}) {
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

  router.use(async(req,res,next)=>{try{req.ordersEnabled=getOrdersEnabled?await getOrdersEnabled():ordersEnabled;req.vnpayConfig=getVnpayConfig?await getVnpayConfig():vnpayConfig;req.paymentChannels=getPaymentChannels?await getPaymentChannels():paymentChannels;next();}catch(error){next(error);}});
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
    res.json({
      ...(shippingChoices ? {shippingCarriers:(await require("./shipping-choice").availableCarriers(pool)).map(({id,name})=>({id,name}))} : {}),
      shippingNote: settings.shipping_note || "",
      shippingRates: settings.shipping_rates || {},
      paymentMethods: req.paymentChannels?.methods || ["cod", ...(req.vnpayConfig ? ["vnpay"] : [])],
      ...(req.paymentChannels?.bankTransfer ? { bankTransfer: req.paymentChannels.bankTransfer } : {}),
      ...(req.paymentChannels?.cod ? { cod: req.paymentChannels.cod } : {}),
      ordersEnabled:req.ordersEnabled
    });
  });

  router.get("/payments/vnpay/return", (req, res) => {
    if (!req.vnpayConfig) return res.sendStatus(404);
    const { valid, parameters } = verifyVnpayQuery(req.query, req.vnpayConfig.hashSecret);
    if (!valid || parameters.vnp_TmnCode !== req.vnpayConfig.tmnCode) {
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
    if (!req.vnpayConfig) return res.status(404).json({ RspCode: "99", Message: "Provider unavailable" });
    try {
      const { valid, parameters } = verifyVnpayQuery(req.query, req.vnpayConfig.hashSecret);
      if (!valid || parameters.vnp_TmnCode !== req.vnpayConfig.tmnCode) {
        return res.json({ RspCode: "97", Message: "Invalid signature" });
      }
      if (parameters.vnp_Command !== "pay") {
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
        `SELECT order_number AS "orderNumber", status, payment_method AS "paymentMethod",
          payment_status AS "paymentStatus", total_vnd AS "totalVnd", updated_at AS "updatedAt"
         FROM orders WHERE order_number = $1`,
        [orderNumber]
      )).rows[0];
      if (!row) return res.status(404).json({ error: "Không tìm thấy đơn hàng." });
      res.json({ order: row });
    } catch (error) {
      next(error);
    }
  });

  router.get("/payments/:provider/return", async (req, res, next) => {
    const provider = String(req.params.provider || "");
    if (!["9pay", "momo", "zalopay"].includes(provider)) return next();
    try {
      const channelConfig = req.paymentChannels?.configs?.[provider];
      if (!channelConfig) return res.sendStatus(404);
      const verified = require("./payment-channels").verifyGatewayPayload(provider, req.query, channelConfig);
      if (!verified.valid) return res.redirect(`/payment-result.html?result=invalid&provider=${encodeURIComponent(provider)}`);
      await require("./payment-channels").reconcilePrepaidOrder(pool, {
        provider,
        orderNumber: verified.orderNumber,
        amountVnd: verified.amountVnd,
        successful: verified.successful,
        providerTransactionId: verified.providerTransactionId,
        responseCode: verified.responseCode,
        finance,
        audit
      });
      const query = new URLSearchParams({
        result: verified.successful ? "processing" : "failed",
        provider,
        order: verified.orderNumber || ""
      });
      res.redirect(`/payment-result.html?${query}`);
    } catch (error) {
      next(error);
    }
  });

  const handleGatewayIpn = async (req, res, next) => {
    const provider = String(req.params.provider || "");
    if (!["9pay", "momo", "zalopay", "bank_transfer"].includes(provider)) return next();
    try {
      const channelConfig = req.paymentChannels?.configs?.[provider];
      if (!channelConfig) return res.status(404).json({ code: "99", message: "Provider unavailable" });
      const payload = { ...(req.query || {}), ...(req.body || {}) };
      if (req.headers["x-gaeru-signature"] && !payload.signature) payload.signature = String(req.headers["x-gaeru-signature"]);
      const verified = require("./payment-channels").verifyGatewayPayload(provider, payload, channelConfig);
      if (!verified.valid) {
        return res.status(400).json({ code: "97", return_code: -1, resultCode: 97, message: verified.reason || "Invalid signature" });
      }
      const outcome = await require("./payment-channels").reconcilePrepaidOrder(pool, {
        provider,
        orderNumber: verified.orderNumber,
        amountVnd: verified.amountVnd,
        successful: verified.successful,
        providerTransactionId: verified.providerTransactionId,
        responseCode: verified.responseCode,
        finance,
        audit
      });
      if (provider === "zalopay") {
        return res.json({ return_code: outcome.code === "00" || outcome.code === "02" ? 1 : 0, return_message: outcome.message, orderStatus: outcome.orderStatus, paymentStatus: outcome.paymentStatus });
      }
      if (provider === "momo") {
        return res.json({ resultCode: outcome.code === "00" || outcome.code === "02" ? 0 : Number(outcome.code), message: outcome.message, orderStatus: outcome.orderStatus, paymentStatus: outcome.paymentStatus });
      }
      res.json({ code: outcome.code, RspCode: outcome.code, Message: outcome.message, orderStatus: outcome.orderStatus, paymentStatus: outcome.paymentStatus });
    } catch (error) {
      next(error);
    }
  };
  router.get("/payments/:provider/ipn", handleGatewayIpn);
  router.post("/payments/:provider/ipn", handleGatewayIpn);
  router.post("/payments/bank_transfer/webhook", (req, res, next) => { req.params.provider = "bank_transfer"; return handleGatewayIpn(req, res, next); });

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
      const uniqueItems = new Map();
      for (const item of parsed.data.items) {
        uniqueItems.set(item.variantId, (uniqueItems.get(item.variantId) || 0) + item.quantity);
      }
      if ([...uniqueItems.values()].some((quantity) => quantity > 99)) {
        return res.status(400).json({ error: "Mỗi phiên bản chỉ được đặt tối đa 99 sản phẩm." });
      }

      const order = await withTransaction(pool, async (client) => {
        if(parsed.data.paymentMethod === "vnpay" && getVnpayConfig){
          await client.query("SELECT pg_advisory_xact_lock(hashtext('gaeru:vnpay-config'))");
          req.vnpayConfig=await getVnpayConfig(client);
          if(!req.vnpayConfig)throw Object.assign(Error("VNPAY vừa ngừng khả dụng. Vui lòng chọn phương thức khác."),{status:409});
        }
        let prepared = [];
        for (const [variantId, quantity] of [...uniqueItems.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          const result = await client.query(
            `SELECT v.id, v.sku, v.name AS "variantName", v.price_vnd AS "priceVnd",
              v.stock_quantity AS "stockQuantity", p.name AS "productName"
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

        prepared=await require("./product-promotions").applyPromotions(client,prepared);
        const subtotal = prepared.reduce((sum, item) => sum + item.priceVnd * item.quantity, 0);
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
        const shippingSelection=shippingChoices?await require('./shipping-choice').validateSelection(client,parsed.data.shippingCarrierId):null;
        if(parsed.data.expectedShippingFeeVnd!==undefined&&parsed.data.expectedShippingFeeVnd!==shippingFee)throw Object.assign(Error('Phí vận chuyển đã thay đổi. Tải lại trang trước khi đặt hàng.'),{status:409});
        const promotion=parsed.data.voucherCode?await require("./marketing").eligible(client,parsed.data.voucherCode,req.session?.customer?.id,subtotal,true):null;
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
        if(shippingSelection){await client.query('INSERT INTO order_shipping_selection(order_id,carrier_id,carrier_name,fee_vnd,config_version) VALUES($1,$2,$3,$4,$5)',[createdOrder.id,shippingSelection.id,shippingSelection.name,shippingFee,shippingSelection.version]);createdOrder.shippingCarrierName=shippingSelection.name;}
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
              item.priceVnd, item.quantity, item.priceVnd * item.quantity,item.originalPriceVnd,item.promotion]
          );
          if (inventory) await inventory.reserveStock(client, { variantId: item.id, quantity: item.quantity, orderId: createdOrder.id, actor: { username: "customer", source: "customer" } });
          else await client.query(
            "UPDATE product_variants SET stock_quantity = stock_quantity - $2, updated_at = now() WHERE id = $1",
            [item.id, item.quantity]
          );
        }
        let paymentUrl = null;
        let bankTransfer = null;
        if (["9pay", "momo", "zalopay"].includes(parsed.data.paymentMethod)) {
          const channelConfig = req.paymentChannels?.configs?.[parsed.data.paymentMethod];
          if (!channelConfig) throw Object.assign(new Error("Kênh thanh toán vừa ngừng khả dụng. Vui lòng chọn phương thức khác."), { status: 409 });
          await client.query(
            `INSERT INTO payment_attempts (order_id, provider, transaction_ref, amount_vnd, expires_at)
             VALUES ($1, $2, $3, $4, now() + interval '15 minutes')`,
            [createdOrder.id, parsed.data.paymentMethod, createdOrder.orderNumber, createdOrder.totalVnd]
          );
          const builders = {
            "9pay": require("./payment-channels").buildNinepayPaymentUrl,
            momo: require("./payment-channels").buildMomoPaymentUrl,
            zalopay: require("./payment-channels").buildZalopayPaymentUrl
          };
          paymentUrl = builders[parsed.data.paymentMethod](channelConfig, {
            amountVnd: createdOrder.totalVnd,
            txnRef: createdOrder.orderNumber,
            baseUrl: publicBaseUrl
          });
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
          ...(bankTransfer ? { bankTransfer } : {})
        };
      });

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
      const query = String(req.query.q || "").trim().slice(0, 100);
      const requestedPage = Number.parseInt(req.query.page || "1", 10);
      if (!Number.isInteger(requestedPage) || requestedPage < 1) {
        return res.status(400).json({ error: "Trang khách hàng không hợp lệ." });
      }
      const pageSize = 25;
      const values = [query];
      const where = `($1::text = '' OR c.full_name ILIKE '%' || $1 || '%' OR c.email ILIKE '%' || $1 || '%' OR c.phone ILIKE '%' || $1 || '%')`;
      const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM customers c WHERE ${where}`, values);
      const total = countResult.rows[0]?.total || 0;
      const pageCount = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(requestedPage, pageCount);
      const result = await pool.query(
        `SELECT c.id, c.full_name AS "fullName", c.email, c.phone, c.active,c.deleted_at AS "deletedAt",c.deletion_recoverable AS "deletionRecoverable",(c.deleted_at>now()-interval '1 year') AS "canRestore",
                c.email_verified_at IS NOT NULL AS "emailVerified", c.created_at AS "createdAt",
                COUNT(o.id)::int AS "orderCount", MAX(o.created_at) AS "lastOrderAt"
         FROM customers c
         LEFT JOIN orders o ON o.customer_id=c.id OR (o.customer_id IS NULL AND lower(o.email)=lower(c.email))
         WHERE ${where}
         GROUP BY c.id ORDER BY c.created_at DESC LIMIT $2 OFFSET $3`,
        [query, pageSize, (page - 1) * pageSize]
      );
      res.json({ customers: result.rows, pagination: { page, pageSize, total, pageCount } });
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

  router.get("/gaeru_ceo/summary", async (req, res) => {
    const [products, orders, settings] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE active)::int AS active,
        (SELECT COUNT(*)::int FROM product_variants v JOIN products p ON p.id = v.product_id
         WHERE v.active = true AND p.active = true AND v.stock_quantity <= 5) AS "lowStock"
        FROM products WHERE deleted_at IS NULL`),
      pool.query(`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status NOT IN ('completed', 'cancelled'))::int AS "needsAction",
        COUNT(*) FILTER (WHERE payment_status = 'pending' AND status <> 'cancelled')::int AS "paymentPending"
        FROM orders`),
      getSettings(pool, ["shipping_rates"])
    ]);
    const shippingRatesConfigured = Object.keys(settings.shipping_rates || {}).length > 0;
    res.json({ products: products.rows[0], orders: orders.rows[0], ordersEnabled:req.ordersEnabled, shippingRatesConfigured });
  });

  router.get("/gaeru_ceo/products", async (req, res) => {
    res.json({ products: await loadProducts(pool, { includeDrafts: true, deleted:req.query.scope==="trash", search: String(req.query.q || "") }) });
  });

  router.post("/gaeru_ceo/products", requireCsrf, async (req, res, next) => {
    try {
      const parsed = productSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Thông tin sản phẩm chưa hợp lệ.", details: parsed.error.issues });
      const p = parsed.data;
      const product = await withTransaction(pool, async (client) => {
      const result = await client.query(
        `INSERT INTO products (slug, name, category, descriptor, description, image_url, image_alt, active, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8)
         RETURNING id`,
        [p.slug, p.name, p.category, p.descriptor, p.description, p.imageUrl, p.imageAlt, p.sortOrder]
      );
      await audit(client, { actor: req.admin, action: "catalog.product.create", entityType: "product", entityId: result.rows[0].id, after: { ...p, active: false } });
      return result.rows[0];
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
      const removed=await withTransaction(pool,async client=>{
        const product=(await client.query('SELECT id,name,active,edit_version FROM products WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[req.params.id])).rows[0];
        if(!product)return false;
        if(product.edit_version!==parsed.data.version){const error=new Error('Sản phẩm vừa thay đổi. Tải lại trước khi xóa.');error.status=409;throw error;}
        await client.query('SELECT id FROM product_variants WHERE product_id=$1 ORDER BY id FOR UPDATE',[product.id]);
        await client.query("UPDATE products SET active=false,deleted_at=now(),deleted_variant_state=(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'active',active)),'[]'::jsonb) FROM product_variants WHERE product_id=$1),updated_at=now() WHERE id=$1",[product.id]);
        await client.query('UPDATE product_variants SET active=false,updated_at=now() WHERE product_id=$1',[product.id]);
        await audit(client,{actor:req.admin,action:'catalog.product.delete',entityType:'product',entityId:product.id,before:product,after:{deleted:true},metadata:{historyPreserved:true}});
        return true;
      });
      if(!removed)return res.status(404).json({error:'Không tìm thấy sản phẩm.'});
      res.status(204).end();
    }catch(error){if(error.status)return res.status(error.status).json({error:error.message});next(error);}
  });

  require('./product-trash').attachProductTrash(router,pool);

  router.put("/gaeru_ceo/products/:id", requireUuidParam("id"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = productSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Thông tin sản phẩm chưa hợp lệ.", details: parsed.error.issues });
      const p = parsed.data;
      const product = await withTransaction(pool, async (client) => {
        const current = await client.query("SELECT id FROM products WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", [req.params.id]);
        if (!current.rows[0]) return null;
        if (p.active) {
          const variants = await client.query("SELECT COUNT(*)::int AS count FROM product_variants WHERE product_id = $1 AND active = true", [req.params.id]);
          if (!variants.rows[0]?.count) {
            const error = new Error("Thêm ít nhất một phiên bản đang bán trước khi xuất bản sản phẩm.");
            error.status = 409;
            throw error;
          }
        }
        const result = await client.query(
          `UPDATE products SET slug=$2, name=$3, category=$4, descriptor=$5, description=$6,
            image_url=$7, image_alt=$8, active=$9, sort_order=$10, updated_at=now()
           WHERE id=$1 RETURNING id`,
          [req.params.id, p.slug, p.name, p.category, p.descriptor, p.description, p.imageUrl, p.imageAlt, p.active, p.sortOrder]
        );
        await audit(client, { actor: req.admin, action: "catalog.product.update", entityType: "product", entityId: req.params.id, after: p });
        return result.rows[0];
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
    if (status && !Object.hasOwn(transitions, status)) {
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
    const where = `${checkoutAccounts ? "NOT EXISTS (SELECT 1 FROM order_reviews r WHERE r.order_id=o.id AND r.resolved_at IS NULL) AND " : ""}($1::text = '' OR o.status = $1)
      AND ($2::text = '' OR o.order_number ILIKE '%' || $2 || '%'
        OR o.customer_name ILIKE '%' || $2 || '%'
        OR o.email ILIKE '%' || $2 || '%' OR o.phone ILIKE '%' || $2 || '%')
      AND ($3::text = '' OR o.payment_status = $3)
      AND ($4::text = '' OR o.payment_method = $4)`;
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
        o.shipping_fee_vnd AS "shippingFeeVnd", o.total_vnd AS "totalVnd", o.created_at AS "createdAt",
        p.provider AS "paymentProvider", p.status AS "paymentAttemptStatus", p.expires_at AS "paymentAttemptExpiresAt",
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
    if (exportXlsx) {
      const buffer = await require('./order-export').orderWorkbook(result.rows);
      return res.set({'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="gaeru-orders.xlsx"','Cache-Control':'no-store'}).send(Buffer.from(buffer));
    }
    let overview;
    if (req.query.overview === '1') {
      const counts = await pool.query(`SELECT o.status, COUNT(*)::int AS total FROM orders o WHERE ${checkoutAccounts ? 'NOT EXISTS (SELECT 1 FROM order_reviews r WHERE r.order_id=o.id AND r.resolved_at IS NULL)' : 'true'} GROUP BY o.status`);
      overview = Object.fromEntries(counts.rows.map(row => [row.status, row.total]));
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
        if (paymentStatusChanged && ["vnpay", "9pay", "momo", "zalopay"].includes(current.payment_method)) {
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
        if (shippingFeeChanged && ["vnpay", "9pay", "momo", "zalopay"].includes(current.payment_method)) {
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
        if (update.status === "cancelled" && current.status !== "cancelled" && ["vnpay", "9pay", "momo", "zalopay"].includes(current.payment_method)) {
          const activeAttempt = await client.query(
            `SELECT EXISTS (
               SELECT 1 FROM payment_attempts
               WHERE order_id = $1 AND status = 'pending' AND expires_at > now()
             ) AS active`,
            [current.id]
          );
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
      res.json({orders:result,targetStatus:target,message:'Đã cập nhật '+result.length+' đơn hàng.'});
    }catch(error){next(error);}
  });
  router.patch("/gaeru_ceo/orders/:id", requireUuidParam("id"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = orderUpdateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Cập nhật đơn hàng chưa hợp lệ.", details: parsed.error.issues });
      const update = parsed.data;
      const result = await withTransaction(pool, async (client) => {
        return applyOrderUpdate(client,req.params.id,update,req.admin);
      });
      if (!result) return res.status(404).json({ error: "Không tìm thấy đơn hàng." });
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
