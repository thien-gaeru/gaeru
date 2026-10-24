const { createHash, randomBytes } = require("node:crypto");
const { Router } = require("express");
const { z } = require("zod");
const { withTransaction } = require("./db");
const { requireCsrf } = require("./security");
const { requirePermission } = require("./staff-access");
const { appendAudit } = require("./audit");
const inventory = require("./inventory");

const MAX_MONEY = 9_000_000_000_000;
const uuid = z.string().uuid();
const requestKey = z.string().trim().min(16).max(120).regex(/^[A-Za-z0-9._:-]+$/);
const code = z.string().trim().min(2).max(30).regex(/^[A-Z0-9_-]+$/);
const warehouseSchema = z.object({ code, name: z.string().trim().min(2).max(120), address: z.string().trim().max(500).default(""), active: z.boolean().default(true) });
const supplierSchema = z.object({ code, name: z.string().trim().min(2).max(160), email: z.union([z.literal(""), z.string().email()]).default(""),
  phone: z.string().trim().max(30).default(""), address: z.string().trim().max(500).default(""), active: z.boolean().default(true) });
const purchaseSchema = z.object({ supplierId: uuid, warehouseId: uuid, reference: z.string().trim().max(120).default(""), note: z.string().trim().max(2000).default(""),
  items: z.array(z.object({ variantId: uuid, quantity: z.number().int().min(1).max(1_000_000), unitCostVnd: z.number().int().min(0).max(MAX_MONEY) })).min(1).max(100) });
const receiptSchema = z.object({ requestKey, reference: z.string().trim().max(120).default(""), note: z.string().trim().max(2000).default(""),
  items: z.array(z.object({ itemId: uuid, quantity: z.number().int().min(1).max(1_000_000) })).min(1).max(100) });
const adjustmentSchema = z.object({ warehouseId: uuid, variantId: uuid, delta: z.number().int().min(-inventory.MAX_STOCK).max(inventory.MAX_STOCK).refine((value) => value !== 0),
  expectedQuantity: z.number().int().min(0).max(inventory.MAX_STOCK), reason: z.string().trim().min(5).max(1000), requestKey });
const transferSchema = z.object({ fromWarehouseId: uuid, toWarehouseId: uuid, variantId: uuid, quantity: z.number().int().min(1).max(inventory.MAX_STOCK),
  reason: z.string().trim().min(5).max(1000), requestKey });
const purchaseStatuses = ["draft", "submitted", "approved", "partially_received", "received", "cancelled"];
const movementTypes = ["opening", "adjustment", "transfer_in", "transfer_out", "sale_reservation", "sale_release", "legacy_sale_release", "purchase_receipt"];

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw inventory.operationError("Dữ liệu nghiệp vụ chưa hợp lệ. Vui lòng kiểm tra lại các trường.", 400);
  return result.data;
}

function validateId(req) { return parse(uuid, req.params.id); }
function username(actor) { return actor?.username || "system"; }
function documentNumber(prefix) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(5).toString("hex").toUpperCase()}`; }
function hashRequest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function handler(action) {
  return async (req, res, next) => {
    try { await action(req, res); } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      if (error.code === "23505") return res.status(409).json({ error: "Mã hoặc chứng từ đã được sử dụng." });
      next(error);
    }
  };
}
function listFilter(req) {
  const page = Number(req.query.page || 1);
  const q = String(req.query.q || "").trim();
  if (!Number.isInteger(page) || page < 1 || page > 100000 || q.length > 120) throw inventory.operationError("Bộ lọc hoặc trang dữ liệu chưa hợp lệ.", 400);
  return { page, pageSize: 25, q };
}
function optionalId(value) { return value ? parse(uuid, value) : ""; }
function pagination(total, requestedPage, pageSize = 25) {
  const pageCount = Math.ceil(total / pageSize);
  return { page: Math.min(requestedPage, Math.max(1, pageCount)), pageSize, total, pageCount };
}
async function listWarehouses(client) {
  return (await client.query('SELECT id,code,name,address,active,created_at AS "createdAt" FROM warehouses ORDER BY code')).rows;
}
async function activeReference(client, table, id, label) {
  const result = await client.query(`SELECT id,name FROM ${table} WHERE id=$1 AND active=true FOR SHARE`, [id]);
  if (!result.rows[0]) throw inventory.operationError(`${label} không tồn tại hoặc đã ngừng hoạt động.`);
  return result.rows[0];
}

async function withIdempotency(client, { key, operation, body, actor }, action) {
  const requestHash = hashRequest(body);
  const claim = await client.query(
    `INSERT INTO inventory_requests (request_key,operation_type,request_hash,actor_username)
     VALUES ($1,$2,$3,$4) ON CONFLICT (request_key) DO NOTHING RETURNING request_key`, [key, operation, requestHash, username(actor)]
  );
  if (!claim.rowCount) {
    const existing = (await client.query("SELECT operation_type,request_hash,result FROM inventory_requests WHERE request_key=$1 FOR UPDATE", [key])).rows[0];
    if (!existing || existing.operation_type !== operation || existing.request_hash !== requestHash) {
      throw inventory.operationError("Mã yêu cầu đã được sử dụng cho dữ liệu khác. Hãy tạo yêu cầu mới.");
    }
    if (!existing.result) throw inventory.operationError("Yêu cầu đang được xử lý. Vui lòng thử lại với cùng mã yêu cầu.");
    return existing.result;
  }
  const result = await action(requestHash);
  await client.query("UPDATE inventory_requests SET result=$2 WHERE request_key=$1", [key, JSON.stringify(result)]);
  return result;
}

const purchaseSelect = `SELECT o.id,o.number,o.supplier_id AS "supplierId",o.supplier_name AS "supplierName",
  o.warehouse_id AS "warehouseId",w.name AS "warehouseName",o.reference,o.note,o.status,o.total_vnd::float8 AS "totalVnd",
  o.created_by AS "createdBy",o.created_by_username AS "createdByUsername",o.submitted_by_username AS "submittedByUsername",
  o.approved_by_username AS "approvedByUsername",o.created_at AS "createdAt",o.updated_at AS "updatedAt",o.approved_at AS "approvedAt"
  FROM purchase_orders o JOIN warehouses w ON w.id=o.warehouse_id`;

async function purchaseDetail(client, id) {
  const result = await client.query(`${purchaseSelect} WHERE o.id=$1`, [id]);
  if (!result.rows[0]) throw inventory.operationError("Không tìm thấy đơn mua hàng.", 404);
  const items = await client.query(
    `SELECT id,variant_id AS "variantId",sku,product_name AS "productName",variant_name AS "variantName",quantity,
      received_quantity AS "receivedQuantity",unit_cost_vnd::float8 AS "unitCostVnd",line_total_vnd::float8 AS "lineTotalVnd"
     FROM purchase_order_items WHERE purchase_order_id=$1 ORDER BY sku,id`, [id]
  );
  return { ...result.rows[0], items: items.rows };
}

function createOperationsApi(pool) {
  const router = Router();

  router.get("/warehouses", requirePermission("inventory.read"), handler(async (_req, res) => {
    res.json({ warehouses: await listWarehouses(pool) });
  }));
  router.post("/warehouses", requirePermission("inventory.approve"), requireCsrf, handler(async (req, res) => {
    const data = parse(warehouseSchema, req.body);
    const warehouse = await withTransaction(pool, async (client) => {
      const result = await client.query("INSERT INTO warehouses (code,name,address,active) VALUES ($1,$2,$3,$4) RETURNING id,code,name,address,active", [data.code, data.name, data.address, data.active]);
      await appendAudit(client, { actor: req.admin, action: "warehouse.create", entityType: "warehouse", entityId: result.rows[0].id, after: data });
      return result.rows[0];
    });
    res.status(201).json({ warehouse });
  }));
  router.patch("/warehouses/:id", requirePermission("inventory.approve"), requireCsrf, handler(async (req, res) => {
    const id = validateId(req);
    const data = parse(warehouseSchema.partial(), req.body);
    if (!Object.keys(data).length) throw inventory.operationError("Chưa có thay đổi kho.", 400);
    const warehouse = await withTransaction(pool, async (client) => {
      const current = (await client.query("SELECT * FROM warehouses WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!current) throw inventory.operationError("Không tìm thấy kho.", 404);
      if (data.code && data.code !== current.code) throw inventory.operationError("Mã kho đã tạo không thể thay đổi.", 400);
      if (data.active === false && current.active) {
        if (current.code === "MAIN") throw inventory.operationError("Kho chính phải luôn hoạt động để nhận số dư khởi tạo.");
        const busy = await client.query(
          `SELECT EXISTS (SELECT 1 FROM warehouse_stock WHERE warehouse_id=$1 AND quantity>0)
            OR EXISTS (SELECT 1 FROM order_stock_allocations a JOIN orders o ON o.id=a.order_id
                       WHERE a.warehouse_id=$1 AND a.released_at IS NULL AND o.status NOT IN ('completed','cancelled'))
            OR EXISTS (SELECT 1 FROM purchase_orders WHERE warehouse_id=$1 AND status IN ('draft','submitted','approved','partially_received')) AS busy`, [id]
        );
        if (busy.rows[0].busy) throw inventory.operationError("Kho còn tồn khả dụng, đơn mua hoặc đơn hàng đang phân bổ. Hãy xử lý trước khi ngừng hoạt động.");
      }
      const merged = { ...current, ...data };
      const result = await client.query("UPDATE warehouses SET name=$2,address=$3,active=$4,updated_at=now() WHERE id=$1 RETURNING id,code,name,address,active", [id, merged.name, merged.address, merged.active]);
      await appendAudit(client, { actor: req.admin, action: "warehouse.update", entityType: "warehouse", entityId: id, before: current, after: result.rows[0] });
      return result.rows[0];
    });
    res.json({ warehouse });
  }));

  router.get("/inventory", requirePermission("inventory.read"), handler(async (req, res) => {
    const { page, pageSize, q } = listFilter(req);
    const warehouseId = optionalId(req.query.warehouseId);
    const values = [warehouseId, q];
    const from = `FROM warehouse_stock s JOIN warehouses w ON w.id=s.warehouse_id
      JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id
      WHERE ($1::text='' OR s.warehouse_id=NULLIF($1,'')::uuid)
        AND ($2::text='' OR v.sku ILIKE '%'||$2||'%' OR v.name ILIKE '%'||$2||'%' OR p.name ILIKE '%'||$2||'%')`;
    const count = (await pool.query(`SELECT COUNT(*)::int AS total ${from}`, values)).rows[0].total;
    const paging = pagination(count, page, pageSize);
    const result = await pool.query(
      `SELECT s.warehouse_id AS "warehouseId",w.name AS "warehouseName",s.variant_id AS "variantId",v.sku,
        p.name AS "productName",v.name AS "variantName",COALESCE(NULLIF(v.image_url,''),p.image_url) AS "imageUrl",s.quantity ${from}
       ORDER BY w.code,v.sku LIMIT $3 OFFSET $4`, [...values, pageSize, (paging.page - 1) * pageSize]
    );
    res.json({ stock: result.rows, pagination: paging, warehouses: await listWarehouses(pool) });
  }));
  router.get("/inventory/movements", requirePermission("inventory.read"), handler(async (req, res) => {
    const { page, pageSize, q } = listFilter(req);
    const warehouseId = optionalId(req.query.warehouseId);
    const variantId = optionalId(req.query.variantId);
    const type = String(req.query.type || "");
    if (type && !movementTypes.includes(type)) throw inventory.operationError("Loại biến động kho chưa hợp lệ.", 400);
    const values = [warehouseId, variantId, type, q];
    const from = `FROM inventory_movements m JOIN warehouses w ON w.id=m.warehouse_id
      WHERE ($1::text='' OR m.warehouse_id=NULLIF($1,'')::uuid) AND ($2::text='' OR m.variant_id=NULLIF($2,'')::uuid)
        AND ($3::text='' OR m.movement_type=$3) AND ($4::text='' OR m.sku ILIKE '%'||$4||'%' OR m.product_name ILIKE '%'||$4||'%')`;
    const count = (await pool.query(`SELECT COUNT(*)::int AS total ${from}`, values)).rows[0].total;
    const paging = pagination(count, page, pageSize);
    const result = await pool.query(
      `SELECT m.id,m.warehouse_id AS "warehouseId",w.name AS "warehouseName",m.variant_id AS "variantId",m.sku,
        m.product_name AS "productName",m.variant_name AS "variantName",m.movement_type AS type,m.delta,
        m.quantity_before AS "quantityBefore",m.quantity_after AS "quantityAfter",m.reference_type AS "referenceType",
        m.reference_id AS "referenceId",m.reason,m.actor_username AS "actorUsername",m.created_at AS "createdAt"
       ${from} ORDER BY m.created_at DESC,m.id DESC LIMIT $5 OFFSET $6`, [...values, pageSize, (paging.page - 1) * pageSize]
    );
    res.json({ movements: result.rows, pagination: paging });
  }));
  router.post("/inventory/adjustments", requirePermission("inventory.approve"), requireCsrf, handler(async (req, res) => {
    const data = parse(adjustmentSchema, req.body);
    const result = await withTransaction(pool, (client) => withIdempotency(client,
      { key: data.requestKey, operation: "adjustment", body: data, actor: req.admin },
      () => inventory.adjustWarehouseStock(client, { ...data, actor: req.admin })));
    res.status(201).json({ adjustment: result });
  }));
  router.post("/inventory/transfers", requirePermission("inventory.write"), requireCsrf, handler(async (req, res) => {
    const data = parse(transferSchema, req.body);
    const result = await withTransaction(pool, (client) => withIdempotency(client,
      { key: data.requestKey, operation: "transfer", body: data, actor: req.admin },
      () => inventory.transferStock(client, { ...data, actor: req.admin })));
    res.status(201).json({ transfer: result });
  }));

  router.get("/suppliers", requirePermission("suppliers.read"), handler(async (req, res) => {
    const { page, pageSize, q } = listFilter(req);
    const where = "WHERE ($1::text='' OR code ILIKE '%'||$1||'%' OR name ILIKE '%'||$1||'%' OR phone ILIKE '%'||$1||'%')";
    const count = (await pool.query(`SELECT COUNT(*)::int AS total FROM suppliers ${where}`, [q])).rows[0].total;
    const paging = pagination(count, page, pageSize);
    const result = await pool.query(`SELECT id,code,name,email,phone,address,active,created_at AS "createdAt" FROM suppliers ${where} ORDER BY name,id LIMIT $2 OFFSET $3`, [q, pageSize, (paging.page - 1) * pageSize]);
    res.json({ suppliers: result.rows, pagination: paging });
  }));
  router.post("/suppliers", requirePermission("suppliers.write"), requireCsrf, handler(async (req, res) => {
    const data = parse(supplierSchema, req.body);
    const supplier = await withTransaction(pool, async (client) => {
      const result = await client.query("INSERT INTO suppliers (code,name,email,phone,address,active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,code,name,email,phone,address,active", [data.code, data.name, data.email, data.phone, data.address, data.active]);
      await appendAudit(client, { actor: req.admin, action: "supplier.create", entityType: "supplier", entityId: result.rows[0].id, after: data });
      return result.rows[0];
    });
    res.status(201).json({ supplier });
  }));
  router.patch("/suppliers/:id", requirePermission("suppliers.write"), requireCsrf, handler(async (req, res) => {
    const id = validateId(req);
    const data = parse(supplierSchema.partial(), req.body);
    if (!Object.keys(data).length) throw inventory.operationError("Chưa có thay đổi nhà cung cấp.", 400);
    const supplier = await withTransaction(pool, async (client) => {
      const current = (await client.query("SELECT * FROM suppliers WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!current) throw inventory.operationError("Không tìm thấy nhà cung cấp.", 404);
      if (data.active === false && current.active) {
        const busy = await client.query("SELECT EXISTS (SELECT 1 FROM purchase_orders WHERE supplier_id=$1 AND status IN ('draft','submitted','approved','partially_received')) AS busy", [id]);
        if (busy.rows[0].busy) throw inventory.operationError("Nhà cung cấp còn đơn mua đang mở. Hãy hoàn tất hoặc hủy đơn trước khi ngừng hợp tác.");
      }
      const merged = { ...current, ...data };
      const result = await client.query("UPDATE suppliers SET code=$2,name=$3,email=$4,phone=$5,address=$6,active=$7,updated_at=now() WHERE id=$1 RETURNING id,code,name,email,phone,address,active", [id, merged.code, merged.name, merged.email, merged.phone, merged.address, merged.active]);
      await appendAudit(client, { actor: req.admin, action: "supplier.update", entityType: "supplier", entityId: id, before: current, after: result.rows[0] });
      return result.rows[0];
    });
    res.json({ supplier });
  }));

  router.get("/purchase-orders", requirePermission("purchases.read"), handler(async (req, res) => {
    const { page, pageSize, q } = listFilter(req);
    const status = String(req.query.status || "");
    if (status && !purchaseStatuses.includes(status)) throw inventory.operationError("Trạng thái đơn mua chưa hợp lệ.", 400);
    const values = [status, q];
    const where = "WHERE ($1::text='' OR o.status=$1) AND ($2::text='' OR o.number ILIKE '%'||$2||'%' OR o.supplier_name ILIKE '%'||$2||'%' OR o.reference ILIKE '%'||$2||'%')";
    const count = (await pool.query(`SELECT COUNT(*)::int AS total FROM purchase_orders o ${where}`, values)).rows[0].total;
    const paging = pagination(count, page, pageSize);
    const result = await pool.query(`${purchaseSelect} ${where} ORDER BY o.created_at DESC,o.id DESC LIMIT $3 OFFSET $4`, [...values, pageSize, (paging.page - 1) * pageSize]);
    res.json({ purchaseOrders: result.rows, pagination: paging });
  }));
  router.get("/purchase-orders/:id", requirePermission("purchases.read"), handler(async (req, res) => {
    res.json({ purchaseOrder: await purchaseDetail(pool, validateId(req)) });
  }));
  router.post("/purchase-orders", requirePermission("purchases.write"), requireCsrf, handler(async (req, res) => {
    const data = parse(purchaseSchema, req.body);
    if (new Set(data.items.map((item) => item.variantId)).size !== data.items.length) throw inventory.operationError("Mỗi phiên bản chỉ được xuất hiện một lần trong đơn mua.", 400);
    const total = data.items.reduce((sum, item) => sum + item.quantity * item.unitCostVnd, 0);
    if (!Number.isSafeInteger(total) || total > MAX_MONEY) throw inventory.operationError("Giá trị đơn mua vượt giới hạn cho phép.", 400);
    const purchaseOrder = await withTransaction(pool, async (client) => {
      const supplier = await activeReference(client, "suppliers", data.supplierId, "Nhà cung cấp");
      await activeReference(client, "warehouses", data.warehouseId, "Kho nhận hàng");
      const variants = await client.query(
        `SELECT v.id,v.sku,v.name AS "variantName",p.name AS "productName" FROM product_variants v
         JOIN products p ON p.id=v.product_id WHERE v.id=ANY($1::uuid[]) ORDER BY v.id FOR SHARE OF v`, [data.items.map((item) => item.variantId).sort()]
      );
      if (variants.rows.length !== data.items.length) throw inventory.operationError("Một phiên bản trong đơn mua không còn tồn tại.");
      const inserted = await client.query(
        `INSERT INTO purchase_orders (number,supplier_id,warehouse_id,supplier_name,reference,note,total_vnd,created_by,created_by_username)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [documentNumber("PO"), data.supplierId, data.warehouseId, supplier.name, data.reference, data.note, total, req.admin?.id || null, username(req.admin)]
      );
      const id = inserted.rows[0].id;
      for (const item of data.items) {
        const variant = variants.rows.find((row) => row.id === item.variantId);
        await client.query(
          `INSERT INTO purchase_order_items (purchase_order_id,variant_id,sku,product_name,variant_name,quantity,unit_cost_vnd,line_total_vnd)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, item.variantId, variant.sku, variant.productName, variant.variantName, item.quantity, item.unitCostVnd, item.quantity * item.unitCostVnd]
        );
      }
      await appendAudit(client, { actor: req.admin, action: "purchase.create", entityType: "purchase_order", entityId: id, after: { ...data, totalVnd: total } });
      return purchaseDetail(client, id);
    });
    res.status(201).json({ purchaseOrder });
  }));

  for (const action of ["submit", "approve", "cancel"]) {
    router.post(`/purchase-orders/:id/${action}`, requirePermission(action === "approve" ? "purchases.approve" : "purchases.write"), requireCsrf, handler(async (req, res) => {
      const id = validateId(req);
      const purchaseOrder = await withTransaction(pool, async (client) => {
        const current = (await client.query("SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE", [id])).rows[0];
        if (!current) throw inventory.operationError("Không tìm thấy đơn mua hàng.", 404);
        const target = { submit: "submitted", approve: "approved", cancel: "cancelled" }[action];
        if (current.status === target) return purchaseDetail(client, id);
        const allowed = action === "submit" ? current.status === "draft" : action === "approve" ? current.status === "submitted" : ["draft", "submitted", "approved"].includes(current.status);
        if (!allowed) throw inventory.operationError("Trạng thái đơn mua không cho phép thao tác này.");
        if (action === "approve" && !["owner", "admin"].includes(req.admin?.role)) {
          const sameMaker = (req.admin?.id && current.created_by === req.admin.id) || current.created_by_username === username(req.admin) ||
            (req.admin?.id && current.submitted_by === req.admin.id) || current.submitted_by_username === username(req.admin);
          if (sameMaker) throw inventory.operationError("Người lập hoặc gửi duyệt không được tự duyệt đơn mua. Cần người có quyền duyệt khác.", 403);
        }
        if (action !== "cancel") {
          await activeReference(client, "suppliers", current.supplier_id, "Nhà cung cấp");
          await activeReference(client, "warehouses", current.warehouse_id, "Kho nhận hàng");
        }
        if (action === "cancel") {
          const received = await client.query("SELECT EXISTS (SELECT 1 FROM goods_receipts WHERE purchase_order_id=$1) AS received", [id]);
          if (received.rows[0].received) throw inventory.operationError("Đơn mua đã nhận hàng không thể hủy. Cần nghiệp vụ trả hàng riêng.");
        }
        if (action === "submit") await client.query("UPDATE purchase_orders SET status='submitted',submitted_by=$2,submitted_by_username=$3,updated_at=now() WHERE id=$1", [id, req.admin?.id || null, username(req.admin)]);
        else if (action === "approve") await client.query("UPDATE purchase_orders SET status='approved',approved_by=$2,approved_by_username=$3,approved_at=now(),updated_at=now() WHERE id=$1", [id, req.admin?.id || null, username(req.admin)]);
        else await client.query("UPDATE purchase_orders SET status='cancelled',updated_at=now() WHERE id=$1", [id]);
        await appendAudit(client, { actor: req.admin, action: `purchase.${action}`, entityType: "purchase_order", entityId: id, before: { status: current.status }, after: { status: target } });
        return purchaseDetail(client, id);
      });
      res.json({ purchaseOrder });
    }));
  }

  router.post("/purchase-orders/:id/receipts", requirePermission("inventory.write"), requireCsrf, handler(async (req, res) => {
    const id = validateId(req);
    const data = parse(receiptSchema, req.body);
    if (new Set(data.items.map((item) => item.itemId)).size !== data.items.length) throw inventory.operationError("Mỗi dòng đơn mua chỉ được nhận một lần trong phiếu.", 400);
    const normalized = { purchaseOrderId: id, ...data, items: [...data.items].sort((left, right) => left.itemId.localeCompare(right.itemId)) };
    const receipt = await withTransaction(pool, (client) => withIdempotency(client,
      { key: data.requestKey, operation: "goods_receipt", body: normalized, actor: req.admin }, async (requestHash) => {
        const purchase = (await client.query("SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE", [id])).rows[0];
        if (!purchase) throw inventory.operationError("Không tìm thấy đơn mua hàng.", 404);
        if (!["approved", "partially_received"].includes(purchase.status)) throw inventory.operationError("Chỉ nhận hàng cho đơn mua đã được duyệt và còn số lượng chờ nhận.");
        await activeReference(client, "suppliers", purchase.supplier_id, "Nhà cung cấp");
        await activeReference(client, "warehouses", purchase.warehouse_id, "Kho nhận hàng");
        const lines = await client.query(
          `SELECT id,variant_id AS "variantId",quantity,received_quantity AS "receivedQuantity",unit_cost_vnd::float8 AS "unitCostVnd"
           FROM purchase_order_items WHERE purchase_order_id=$1 ORDER BY variant_id FOR UPDATE`, [id]
        );
        const selected = data.items.map((item) => {
          const line = lines.rows.find((row) => row.id === item.itemId);
          if (!line || item.quantity > line.quantity - line.receivedQuantity) throw inventory.operationError("Số lượng nhận vượt số lượng còn lại hoặc dòng không thuộc đơn mua này.");
          return { ...line, receivedNow: item.quantity };
        }).sort((left, right) => left.variantId.localeCompare(right.variantId));
        const inserted = await client.query(
          `INSERT INTO goods_receipts (number,purchase_order_id,warehouse_id,request_key,request_hash,reference,note,created_by,created_by_username)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,number,created_at AS "createdAt"`,
          [documentNumber("GRN"), id, purchase.warehouse_id, data.requestKey, requestHash, data.reference, data.note, req.admin?.id || null, username(req.admin)]
        );
        const posted = inserted.rows[0];
        let receivedTotalVnd = 0;
        for (const item of selected) {
          const value = item.receivedNow * item.unitCostVnd;
          receivedTotalVnd += value;
          const insertedLine = await client.query(
            `INSERT INTO goods_receipt_items (goods_receipt_id,purchase_order_item_id,variant_id,quantity,unit_cost_vnd,line_total_vnd)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [posted.id, item.id, item.variantId, item.receivedNow, item.unitCostVnd, value]
          );
          await inventory.receiveStock(client, { warehouseId: purchase.warehouse_id, variantId: item.variantId, quantity: item.receivedNow,
            receiptId: posted.id, receiptItemId: insertedLine.rows[0].id, actor: req.admin });
          await client.query("UPDATE purchase_order_items SET received_quantity=received_quantity+$2 WHERE id=$1", [item.id, item.receivedNow]);
        }
        const completed = lines.rows.every((line) => line.receivedQuantity + (selected.find((item) => item.id === line.id)?.receivedNow || 0) === line.quantity);
        const status = completed ? "received" : "partially_received";
        await client.query("UPDATE purchase_orders SET status=$2,updated_at=now() WHERE id=$1", [id, status]);
        await appendAudit(client, { actor: req.admin, action: "purchase.receive", entityType: "goods_receipt", entityId: posted.id,
          metadata: { purchaseOrderId: id, warehouseId: purchase.warehouse_id, requestKey: data.requestKey, totalVnd: receivedTotalVnd, items: data.items } });
        return { ...posted, purchaseOrderId: id, warehouseId: purchase.warehouse_id, purchaseOrderStatus: status, totalVnd: receivedTotalVnd };
      }));
    res.status(201).json({ receipt });
  }));
  router.get("/goods-receipts", requirePermission("purchases.read"), handler(async (req, res) => {
    const { page, pageSize, q } = listFilter(req);
    const where = "WHERE ($1::text='' OR r.number ILIKE '%'||$1||'%' OR o.number ILIKE '%'||$1||'%' OR o.supplier_name ILIKE '%'||$1||'%')";
    const from = `FROM goods_receipts r JOIN purchase_orders o ON o.id=r.purchase_order_id JOIN warehouses w ON w.id=r.warehouse_id ${where}`;
    const count = (await pool.query(`SELECT COUNT(*)::int AS total ${from}`, [q])).rows[0].total;
    const paging = pagination(count, page, pageSize);
    const result = await pool.query(
      `SELECT r.id,r.number,r.purchase_order_id AS "purchaseOrderId",o.number AS "purchaseOrderNumber",o.supplier_name AS "supplierName",
        r.warehouse_id AS "warehouseId",w.name AS "warehouseName",r.reference,r.note,r.created_by_username AS "createdByUsername",r.created_at AS "createdAt",
        (SELECT COALESCE(SUM(i.line_total_vnd),0)::float8 FROM goods_receipt_items i WHERE i.goods_receipt_id=r.id) AS "totalVnd"
       ${from} ORDER BY r.created_at DESC,r.id DESC LIMIT $2 OFFSET $3`, [q, pageSize, (paging.page - 1) * pageSize]
    );
    res.json({ receipts: result.rows, pagination: paging });
  }));

  return router;
}

module.exports = { createOperationsApi, withIdempotency, purchaseSchema, receiptSchema, adjustmentSchema, transferSchema, MAX_MONEY };
