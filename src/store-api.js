const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const multer = require("multer");
const { Router } = require("express");
const { rateLimit } = require("express-rate-limit");
const { z } = require("zod");
const { requireAdmin, requireCsrf } = require("./security");
const { withTransaction } = require("./db");
const { buildVnpayPaymentUrl, verifyVnpayQuery } = require("./vnpay");

const orderSchema = z.object({
  customer: z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(254),
    phone: z.string().trim().min(8).max(30),
    address: z.string().trim().min(5).max(250),
    city: z.string().trim().min(2).max(120),
    note: z.string().trim().max(1000).default("")
  }),
  paymentMethod: z.enum(["cod", "vnpay"]),
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

async function loadProducts(pool, { includeDrafts = false, search = "" } = {}) {
  const visibility = includeDrafts ? "" : "WHERE p.active = true";
  const query = `
    SELECT p.id, p.slug, p.name, p.category, p.descriptor, p.description,
      p.image_url AS "imageUrl", p.image_alt AS "imageAlt", p.active,
      p.sort_order AS "sortOrder",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', v.id, 'sku', v.sku, 'name', v.name, 'options', v.options,
          'priceVnd', v.price_vnd, 'stockQuantity', v.stock_quantity, 'active', v.active
        ) ORDER BY v.name)
        FROM product_variants v
        WHERE v.product_id = p.id ${includeDrafts ? "" : "AND v.active = true"}
      ), '[]'::jsonb) AS variants
    FROM products p
    ${visibility}
    ORDER BY p.sort_order, p.name`;
  const result = await pool.query(query);
  const needle = search.trim().toLocaleLowerCase("vi");
  if (!needle) return result.rows;
  return result.rows.filter((product) =>
    `${product.name} ${product.description} ${product.category} ${product.descriptor}`
      .toLocaleLowerCase("vi").includes(needle)
  );
}

async function getSettings(pool, keys) {
  const result = await pool.query(
    "SELECT setting_key, setting_value FROM store_settings WHERE setting_key = ANY($1::text[])",
    [keys]
  );
  return Object.fromEntries(result.rows.map((row) => [row.setting_key, row.setting_value]));
}

function createStoreApi(pool, { ordersEnabled = false, vnpayConfig = null } = {}) {
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

  router.get("/products", async (req, res) => {
    const products = await loadProducts(pool, { search: String(req.query.q || "") });
    res.json({ products });
  });

  router.get("/products/:slug", async (req, res) => {
    const products = await loadProducts(pool);
    const product = products.find((item) => item.slug === req.params.slug);
    if (!product) return res.status(404).json({ error: "Không tìm thấy sản phẩm." });
    res.json({ product });
  });

  router.get("/settings/public", async (_req, res) => {
    const settings = await getSettings(pool, ["shipping_note", "shipping_rates"]);
    res.json({
      shippingNote: settings.shipping_note || "",
      shippingRates: settings.shipping_rates || {},
      paymentMethods: ["cod", ...(vnpayConfig ? ["vnpay"] : [])],
      ordersEnabled
    });
  });

  router.get("/payments/vnpay/return", (req, res) => {
    if (!vnpayConfig) return res.sendStatus(404);
    const { valid, parameters } = verifyVnpayQuery(req.query, vnpayConfig.hashSecret);
    if (!valid || parameters.vnp_TmnCode !== vnpayConfig.tmnCode) {
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
    if (!vnpayConfig) return res.status(404).json({ RspCode: "99", Message: "Provider unavailable" });
    try {
      const { valid, parameters } = verifyVnpayQuery(req.query, vnpayConfig.hashSecret);
      if (!valid || parameters.vnp_TmnCode !== vnpayConfig.tmnCode) {
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
        if (attempt.attemptStatus !== "pending" || attempt.paymentStatus === "paid") {
          return { code: "02", message: "Order already confirmed" };
        }

        const successful = parameters.vnp_ResponseCode === "00" && parameters.vnp_TransactionStatus === "00";
        await client.query(
          `UPDATE payment_attempts SET status=$2, provider_transaction_id=$3, response_code=$4, updated_at=now()
           WHERE id=$1`,
          [attempt.id, successful ? "paid" : "failed", parameters.vnp_TransactionNo || null, parameters.vnp_ResponseCode || null]
        );
        if (successful) {
          await client.query("UPDATE orders SET payment_status='paid', updated_at=now() WHERE id=$1", [attempt.orderId]);
        }
        return { code: "00", message: "Confirm Success" };
      });
      res.json({ RspCode: result.code, Message: result.message });
    } catch (error) {
      next(error);
    }
  });

  router.post("/orders", (_req, res, next) => {
    if (!ordersEnabled) {
      return res.status(503).json({ error: "GAERU đang tạm dừng tiếp nhận đơn hàng trực tuyến." });
    }
    next();
  }, orderLimit, requireCsrf, async (req, res, next) => {
    try {
      const parsed = orderSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Thông tin đặt hàng chưa hợp lệ.", details: parsed.error.issues });
      }
      if (parsed.data.paymentMethod === "vnpay" && !vnpayConfig) {
        return res.status(503).json({ error: "VNPAY chưa được cấu hình trên máy chủ." });
      }
      const uniqueItems = new Map();
      for (const item of parsed.data.items) {
        uniqueItems.set(item.variantId, (uniqueItems.get(item.variantId) || 0) + item.quantity);
      }
      if ([...uniqueItems.values()].some((quantity) => quantity > 99)) {
        return res.status(400).json({ error: "Mỗi phiên bản chỉ được đặt tối đa 99 sản phẩm." });
      }

      const order = await withTransaction(pool, async (client) => {
        const prepared = [];
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

        const subtotal = prepared.reduce((sum, item) => sum + item.priceVnd * item.quantity, 0);
        if (!Number.isSafeInteger(subtotal) || subtotal > 2_000_000_000) {
          const error = new Error("Tổng giá trị đơn hàng vượt giới hạn cho phép.");
          error.status = 400;
          throw error;
        }
        const shippingResult = await client.query(
          "SELECT setting_value FROM store_settings WHERE setting_key = 'shipping_rates' FOR SHARE"
        );
        const shippingRates = shippingResult.rows[0]?.setting_value || {};
        if (!Object.hasOwn(shippingRates, parsed.data.customer.city)) {
          const error = new Error("Tỉnh/thành phố giao hàng hiện chưa được hỗ trợ hoặc chưa có phí vận chuyển.");
          error.status = 409;
          throw error;
        }
        const shippingFee = shippingRates[parsed.data.customer.city];
        const total = subtotal + shippingFee;
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
        for (const item of prepared) {
          await client.query(
            `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku,
              unit_price_vnd, quantity, line_total_vnd)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [createdOrder.id, item.id, item.productName, item.variantName, item.sku,
              item.priceVnd, item.quantity, item.priceVnd * item.quantity]
          );
          await client.query(
            "UPDATE product_variants SET stock_quantity = stock_quantity - $2, updated_at = now() WHERE id = $1",
            [item.id, item.quantity]
          );
        }
        let paymentUrl = null;
        if (parsed.data.paymentMethod === "vnpay") {
          await client.query(
            `INSERT INTO payment_attempts (order_id, provider, transaction_ref, amount_vnd, expires_at)
             VALUES ($1, 'vnpay', $2, $3, now() + interval '15 minutes')`,
            [createdOrder.id, createdOrder.orderNumber, createdOrder.totalVnd]
          );
          paymentUrl = buildVnpayPaymentUrl(vnpayConfig, {
            amountVnd: createdOrder.totalVnd,
            txnRef: createdOrder.orderNumber,
            ipAddress: req.ip
          });
        }
        return {
          order: { ...createdOrder, items: prepared.map(({ productName, variantName, sku, priceVnd, quantity }) => ({ productName, variantName, sku, priceVnd, quantity })) },
          paymentUrl
        };
      });

      res.status(201).json({
        order: order.order,
        paymentUrl: order.paymentUrl,
        message: "Đã tiếp nhận đơn hàng. Phí vận chuyển đã được tính theo tỉnh/thành; GAERU sẽ xác nhận đơn và thanh toán."
      });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.use("/admin", requireAdmin);

  router.post("/admin/uploads", requireCsrf, parseImageUpload, async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Chọn một tệp ảnh để tải lên." });
      const signatures = [
        { type: "image/png", ext: "png", valid: req.file.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
        { type: "image/jpeg", ext: "jpg", valid: req.file.buffer[0] === 0xff && req.file.buffer[1] === 0xd8 && req.file.buffer[2] === 0xff },
        { type: "image/webp", ext: "webp", valid: req.file.buffer.toString("ascii", 0, 4) === "RIFF" && req.file.buffer.toString("ascii", 8, 12) === "WEBP" }
      ];
      const image = signatures.find((entry) => entry.type === req.file.mimetype && entry.valid);
      if (!image) return res.status(400).json({ error: "Nội dung tệp không khớp định dạng ảnh được phép." });
      const filename = `${randomUUID()}.${image.ext}`;
      const imageDirectory = path.join(__dirname, "..", "assets", "products");
      await fs.mkdir(imageDirectory, { recursive: true });
      await fs.writeFile(path.join(imageDirectory, filename), req.file.buffer, { flag: "wx" });
      res.status(201).json({ imageUrl: `/assets/products/${filename}` });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/summary", async (_req, res) => {
    const [products, orders, settings] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE active)::int AS active,
        (SELECT COUNT(*)::int FROM product_variants v JOIN products p ON p.id = v.product_id
         WHERE v.active = true AND p.active = true AND v.stock_quantity <= 5) AS "lowStock"
        FROM products`),
      pool.query(`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status NOT IN ('completed', 'cancelled'))::int AS "needsAction",
        COUNT(*) FILTER (WHERE payment_status = 'pending' AND status <> 'cancelled')::int AS "paymentPending"
        FROM orders`),
      getSettings(pool, ["shipping_rates"])
    ]);
    const shippingRatesConfigured = Object.keys(settings.shipping_rates || {}).length > 0;
    res.json({ products: products.rows[0], orders: orders.rows[0], ordersEnabled, shippingRatesConfigured });
  });

  router.get("/admin/products", async (req, res) => {
    res.json({ products: await loadProducts(pool, { includeDrafts: true, search: String(req.query.q || "") }) });
  });

  router.post("/admin/products", requireCsrf, async (req, res, next) => {
    try {
      const parsed = productSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Thông tin sản phẩm chưa hợp lệ.", details: parsed.error.issues });
      const p = parsed.data;
      const result = await pool.query(
        `INSERT INTO products (slug, name, category, descriptor, description, image_url, image_alt, active, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8)
         RETURNING id`,
        [p.slug, p.name, p.category, p.descriptor, p.description, p.imageUrl, p.imageAlt, p.sortOrder]
      );
      res.status(201).json({ id: result.rows[0].id });
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ error: "Slug sản phẩm đã được sử dụng." });
      next(error);
    }
  });

  router.put("/admin/products/:id", requireUuidParam("id"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = productSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Thông tin sản phẩm chưa hợp lệ.", details: parsed.error.issues });
      const p = parsed.data;
      if (p.active) {
        const variants = await pool.query("SELECT COUNT(*)::int AS count FROM product_variants WHERE product_id = $1 AND active = true", [req.params.id]);
        if (!variants.rows[0] || variants.rows[0].count === 0) return res.status(409).json({ error: "Thêm ít nhất một phiên bản đang bán trước khi xuất bản sản phẩm." });
      }
      const result = await pool.query(
        `UPDATE products SET slug=$2, name=$3, category=$4, descriptor=$5, description=$6,
          image_url=$7, image_alt=$8, active=$9, sort_order=$10, updated_at=now()
         WHERE id=$1 RETURNING id`,
        [req.params.id, p.slug, p.name, p.category, p.descriptor, p.description, p.imageUrl, p.imageAlt, p.active, p.sortOrder]
      );
      if (!result.rowCount) return res.status(404).json({ error: "Không tìm thấy sản phẩm." });
      res.json({ id: result.rows[0].id });
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ error: "Slug sản phẩm đã được sử dụng." });
      next(error);
    }
  });

  router.post("/admin/products/:id/variants", requireUuidParam("id"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = variantSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Thông tin phiên bản chưa hợp lệ.", details: parsed.error.issues });
      const v = parsed.data;
      const result = await pool.query(
        `INSERT INTO product_variants (product_id, sku, name, options, price_vnd, stock_quantity, active)
         SELECT id, $2, $3, $4, $5, $6, $7 FROM products WHERE id=$1
         RETURNING id`,
        [req.params.id, v.sku, v.name, v.options, v.priceVnd, v.stockQuantity, v.active]
      );
      if (!result.rowCount) return res.status(404).json({ error: "Không tìm thấy sản phẩm." });
      res.status(201).json({ id: result.rows[0].id });
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ error: "SKU đã được sử dụng." });
      next(error);
    }
  });

  router.put("/admin/variants/:id", requireUuidParam("id"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = variantSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Thông tin phiên bản chưa hợp lệ.", details: parsed.error.issues });
      const v = parsed.data;
      const result = await pool.query(
        `UPDATE product_variants SET sku=$2, name=$3, options=$4, price_vnd=$5,
          stock_quantity=$6, active=$7, updated_at=now() WHERE id=$1 RETURNING id`,
        [req.params.id, v.sku, v.name, v.options, v.priceVnd, v.stockQuantity, v.active]
      );
      if (!result.rowCount) return res.status(404).json({ error: "Không tìm thấy phiên bản." });
      res.json({ id: result.rows[0].id });
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ error: "SKU đã được sử dụng." });
      next(error);
    }
  });

  router.delete("/admin/variants/:id", requireUuidParam("id"), requireCsrf, async (req, res, next) => {
    try {
      const result = await withTransaction(pool, async (client) => {
        const variant = await client.query("SELECT id FROM product_variants WHERE id=$1 FOR UPDATE", [req.params.id]);
        if (!variant.rowCount) return { missing: true };
        const references = await client.query(
          "SELECT EXISTS (SELECT 1 FROM order_items WHERE variant_id=$1) AS referenced",
          [req.params.id]
        );
        if (references.rows[0].referenced) return { inUse: true };
        await client.query("DELETE FROM product_variants WHERE id=$1", [req.params.id]);
        return { deleted: true };
      });
      if (result.missing) return res.status(404).json({ error: "Không tìm thấy phiên bản." });
      if (result.inUse) return res.status(409).json({ error: "Phiên bản đã có trong lịch sử đơn hàng. Hãy sửa và tạm ẩn thay vì xóa." });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/orders", async (req, res) => {
    const status = String(req.query.status || "");
    if (status && !Object.hasOwn(transitions, status)) {
      return res.status(400).json({ error: "Bộ lọc trạng thái đơn hàng không hợp lệ." });
    }
    const search = String(req.query.q || "").trim();
    const requestedPage = Number(req.query.page || 1);
    if (search.length > 120 || !Number.isInteger(requestedPage) || requestedPage < 1 || requestedPage > 100000) {
      return res.status(400).json({ error: "Bộ lọc hoặc trang đơn hàng không hợp lệ." });
    }
    const pageSize = 25;
    const filterValues = [status, search];
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM orders o
       WHERE ($1::text = '' OR o.status = $1)
         AND ($2::text = '' OR o.order_number ILIKE '%' || $2 || '%'
           OR o.customer_name ILIKE '%' || $2 || '%'
           OR o.email ILIKE '%' || $2 || '%' OR o.phone ILIKE '%' || $2 || '%')`,
      filterValues
    );
    const total = countResult.rows[0]?.total || 0;
    const pageCount = Math.ceil(total / pageSize);
    const page = Math.min(requestedPage, Math.max(1, pageCount));
    const result = await pool.query(
      `SELECT o.id, o.order_number AS "orderNumber", o.customer_name AS "customerName",
        o.email, o.phone, o.address, o.city, o.note, o.payment_method AS "paymentMethod",
        o.payment_status AS "paymentStatus", o.status, o.subtotal_vnd AS "subtotalVnd",
        o.shipping_fee_vnd AS "shippingFeeVnd", o.total_vnd AS "totalVnd", o.created_at AS "createdAt",
        p.provider AS "paymentProvider", p.status AS "paymentAttemptStatus",
        COALESCE(jsonb_agg(jsonb_build_object('productName', i.product_name, 'variantName', i.variant_name,
          'sku', i.sku, 'unitPriceVnd', i.unit_price_vnd, 'quantity', i.quantity, 'lineTotalVnd', i.line_total_vnd))
          FILTER (WHERE i.id IS NOT NULL), '[]'::jsonb) AS items
       FROM orders o
       LEFT JOIN order_items i ON i.order_id = o.id
       LEFT JOIN LATERAL (
         SELECT provider, status FROM payment_attempts WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1
       ) p ON true
       WHERE ($1::text = '' OR o.status = $1)
         AND ($2::text = '' OR o.order_number ILIKE '%' || $2 || '%'
           OR o.customer_name ILIKE '%' || $2 || '%'
           OR o.email ILIKE '%' || $2 || '%' OR o.phone ILIKE '%' || $2 || '%')
       GROUP BY o.id, p.provider, p.status ORDER BY o.created_at DESC LIMIT $3 OFFSET $4`,
      [...filterValues, pageSize, (page - 1) * pageSize]
    );
    res.json({
      orders: result.rows,
      pagination: { page, pageSize, total, pageCount }
    });
  });

  router.patch("/admin/orders/:id", requireUuidParam("id"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = orderUpdateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Cập nhật đơn hàng chưa hợp lệ.", details: parsed.error.issues });
      const update = parsed.data;
      const result = await withTransaction(pool, async (client) => {
        const currentResult = await client.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [req.params.id]);
        const current = currentResult.rows[0];
        if (!current) return null;
        if (update.status && update.status !== current.status && !transitions[current.status].includes(update.status)) {
          const error = new Error(`Không thể chuyển đơn từ ${current.status} sang ${update.status}.`);
          error.status = 409;
          throw error;
        }
        if (update.status === "cancelled" && current.payment_status === "paid") {
          const error = new Error("Đơn đã thanh toán cần được xử lý hoàn tiền trước khi hủy.");
          error.status = 409;
          throw error;
        }
        const targetStatus = update.status ?? current.status;
        const targetPaymentStatus = update.paymentStatus ?? current.payment_status;
        const shippingFee = update.shippingFeeVnd ?? current.shipping_fee_vnd;
        const shippingFeeChanged = update.shippingFeeVnd !== undefined && update.shippingFeeVnd !== current.shipping_fee_vnd;
        if (shippingFeeChanged && current.payment_method === "vnpay") {
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
        if (update.status === "cancelled" && current.status !== "cancelled" && current.payment_method === "vnpay") {
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
        if (update.paymentStatus === "paid" && targetStatus === "cancelled") {
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
          await client.query(
            `UPDATE product_variants v SET stock_quantity = v.stock_quantity + i.quantity, updated_at=now()
             FROM order_items i WHERE i.order_id=$1 AND i.variant_id=v.id`,
            [current.id]
          );
        }
        const total = shippingFee === null ? null : current.subtotal_vnd + shippingFee;
        if (total !== null && total > 2_000_000_000) {
          const error = new Error("Tổng đơn hàng vượt giới hạn cho phép.");
          error.status = 400;
          throw error;
        }
        const updated = await client.query(
          `UPDATE orders SET status=COALESCE($2, status), payment_status=COALESCE($3, payment_status),
            shipping_fee_vnd=$4, total_vnd=$5, updated_at=now()
           WHERE id=$1 RETURNING id, status, payment_status AS "paymentStatus",
             shipping_fee_vnd AS "shippingFeeVnd", total_vnd AS "totalVnd"`,
          [current.id, update.status || null, update.paymentStatus || null, shippingFee, total]
        );
        return updated.rows[0];
      });
      if (!result) return res.status(404).json({ error: "Không tìm thấy đơn hàng." });
      res.json({ order: result });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.get("/admin/settings", async (_req, res) => {
    res.json({
      ...await getSettings(pool, ["shipping_note", "shipping_rates"]),
      paymentMethods: ["cod", ...(vnpayConfig ? ["vnpay"] : [])]
    });
  });

  router.put("/admin/settings", requireCsrf, async (req, res) => {
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
  imageUrl: z.string().trim().regex(/^\/assets\/products\/[a-zA-Z0-9._-]+$/),
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
