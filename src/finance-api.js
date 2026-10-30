const { Router } = require("express");
const { z } = require("zod");
const { createHash, randomUUID } = require("node:crypto");
const { withTransaction } = require("./db");
const { requireCsrf } = require("./security");
const { requirePermission } = require("./staff-access");
const { appendAudit } = require("./audit");

const amount = z.number().int().positive().max(1_000_000_000_000);
const requestKey = z.string().min(8).max(120).regex(/^[A-Za-z0-9_.:-]+$/);
const common = { amountVnd: amount, method: z.enum(["cash", "bank_transfer"]), reference: z.string().trim().max(160).default(""), note: z.string().trim().max(1000).default(""), requestKey };
const supplierPaymentSchema = z.object({ supplierId: z.string().uuid(), ...common });
const expenseSchema = z.object({ category: z.enum(["operations", "marketing", "payroll", "other"]), payee: z.string().trim().min(2).max(160), ...common });
const receiptSchema = z.object({ orderId: z.string().uuid(), ...common, amountVnd: amount.max(2_000_000_000) });
const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function numeric(row) {
  if (!row) return row;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (value !== null && /Vnd$|Count$|Quantity$/.test(key)) {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw fail(503, "Giá trị báo cáo vượt giới hạn xử lý an toàn.");
      return [key, number];
    }
    return [key, value];
  }));
}
function pageQuery(query) {
  const page = Number(query.page || 1);
  const search = String(query.q || "").trim();
  if (!Number.isInteger(page) || page < 1 || page > 100000 || search.length > 120) throw fail(400, "Bộ lọc hoặc trang không hợp lệ.");
  return { page, search };
}
async function paged(pool, query, select, count, values = []) {
  const { page: requested } = pageQuery(query);
  const total = Number((await pool.query(count, values)).rows[0]?.total || 0);
  const pageSize = 25, pageCount = Math.ceil(total / pageSize), page = Math.min(requested, Math.max(1, pageCount));
  const result = await pool.query(`${select} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, pageSize, (page - 1) * pageSize]);
  return { rows: result.rows.map(numeric), pagination: { page, pageSize, total, pageCount } };
}
async function receiptTotal(client, orderId) {
  return Number((await client.query("SELECT COALESCE(SUM(amount_vnd),0) AS total FROM sales_receipts WHERE order_id=$1", [orderId])).rows[0]?.total || 0);
}
async function recordFullOrderPayment(client, { order, actor }) {
  const received = await receiptTotal(client, order.id);
  const remaining = Number(order.total_vnd) - received;
  if (remaining <= 0) return;
  const internalKey = `system-full:${randomUUID()}`;
  await client.query(`INSERT INTO sales_receipts (order_id,amount_vnd,method,reference,note,request_key,request_hash,created_by)
    VALUES ($1,$2,$3,'','Ghi nhận đủ tiền khi xử lý đơn',$4,$4,$5)`, [order.id, remaining, order.payment_method === "cod" ? "cash" : "bank_transfer", internalKey, actor?.username || "system"]);
}
async function supplierBalance(client, supplierId) {
  const result = await client.query(`SELECT
    (SELECT COALESCE(SUM(i.line_total_vnd),0) FROM goods_receipt_items i JOIN goods_receipts r ON r.id=i.goods_receipt_id JOIN purchase_orders p ON p.id=r.purchase_order_id WHERE p.supplier_id=$1) AS received,
    (SELECT COALESCE(SUM(amount_vnd),0) FROM supplier_payments WHERE supplier_id=$1 AND status='posted') AS paid`, [supplierId]);
  return { received: Number(result.rows[0].received), paid: Number(result.rows[0].paid) };
}
async function idempotent(client, table, data) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${table}:${data.requestKey}`]);
  const result = await client.query(`SELECT id,request_hash FROM ${table} WHERE request_key=$1`, [data.requestKey]);
  if (result.rows[0] && result.rows[0].request_hash !== digest(data)) throw fail(409, "Mã yêu cầu đã được dùng cho nội dung khác.");
  return result.rows[0];
}
function range(query, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map((part) => [part.type, part.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const from = String(query.from || new Date(Date.parse(today) - 29 * 86400000).toISOString().slice(0, 10));
  const to = String(query.to || today);
  const valid = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!valid(from) || !valid(to) || from > to || Date.parse(to) - Date.parse(from) > 366 * 86400000) throw fail(400, "Chọn khoảng báo cáo hợp lệ, tối đa 367 ngày.");
  return [from, to];
}
function createFinanceApi(pool) {
  const router = Router();
  const route = (handler) => async (req, res, next) => { try { await handler(req, res); } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); next(error); } };
  router.get("/finance/summary", requirePermission("finance.read"), route(async (_req, res) => {
    const result = await pool.query(`SELECT
      (SELECT COALESCE(SUM(CASE WHEN o.status='cancelled' OR o.return_completed_at IS NOT NULL THEN 0 WHEN o.payment_status='paid' THEN o.total_vnd ELSE COALESCE(r.received,0) END),0) FROM orders o LEFT JOIN (SELECT order_id,SUM(amount_vnd) received FROM sales_receipts GROUP BY order_id) r ON r.order_id=o.id) AS "salesPaidVnd",
      (SELECT COALESCE(SUM(GREATEST(COALESCE(o.total_vnd,0)-COALESCE(r.received,0),0)),0) FROM orders o LEFT JOIN (SELECT order_id,SUM(amount_vnd) received FROM sales_receipts GROUP BY order_id) r ON r.order_id=o.id WHERE o.payment_status<>'paid' AND o.status<>'cancelled' AND o.return_completed_at IS NULL) AS "salesOutstandingVnd",
      (SELECT COALESCE(SUM(line_total_vnd),0) FROM goods_receipt_items) AS "purchasesReceivedVnd",
      (SELECT COALESCE(SUM(amount_vnd),0) FROM supplier_payments WHERE status='posted') AS "supplierPaidVnd",
      (SELECT COALESCE(SUM(amount_vnd),0) FROM expense_requests WHERE status='posted') AS "expensesVnd"`);
    const summary = numeric(result.rows[0]);
    summary.supplierOutstandingVnd = summary.purchasesReceivedVnd - summary.supplierPaidVnd;
    res.json({ summary });
  }));
  router.get("/finance/receivables", requirePermission("finance.read"), route(async (req, res) => {
    const { search } = pageQuery(req.query);
    const where = `o.payment_status<>'paid' AND o.status<>'cancelled' AND o.return_completed_at IS NULL AND ($1::text='' OR o.order_number ILIKE '%'||$1||'%' OR o.customer_name ILIKE '%'||$1||'%' OR o.phone ILIKE '%'||$1||'%')`;
    const result = await paged(pool, req.query, `SELECT o.id,o.order_number AS "orderNumber",o.customer_name AS "customerName",o.email,o.phone,o.total_vnd AS "totalVnd",COALESCE(r.received,0) AS "receivedVnd",GREATEST(COALESCE(o.total_vnd,0)-COALESCE(r.received,0),0) AS "outstandingVnd",o.status,o.payment_method AS "paymentMethod",o.created_at AS "createdAt" FROM orders o LEFT JOIN (SELECT order_id,SUM(amount_vnd) received FROM sales_receipts GROUP BY order_id) r ON r.order_id=o.id WHERE ${where} ORDER BY o.created_at DESC`, `SELECT COUNT(*)::int total FROM orders o WHERE ${where}`, [search]);
    res.json({ receivables: result.rows, pagination: result.pagination });
  }));
  router.get("/finance/payables", requirePermission("finance.read"), route(async (_req, res) => {
    const result = await pool.query(`SELECT s.id AS "supplierId",s.name AS "supplierName",COALESCE(r.received,0) AS "receivedVnd",COALESCE(p.paid,0) AS "paidVnd",COALESCE(r.received,0)-COALESCE(p.paid,0) AS "outstandingVnd" FROM suppliers s LEFT JOIN (SELECT p.supplier_id,SUM(i.line_total_vnd) received FROM goods_receipt_items i JOIN goods_receipts g ON g.id=i.goods_receipt_id JOIN purchase_orders p ON p.id=g.purchase_order_id GROUP BY p.supplier_id) r ON r.supplier_id=s.id LEFT JOIN (SELECT supplier_id,SUM(amount_vnd) paid FROM supplier_payments WHERE status='posted' GROUP BY supplier_id) p ON p.supplier_id=s.id ORDER BY s.name LIMIT 1000`);
    res.json({ payables: result.rows.map(numeric) });
  }));
  router.get("/finance/customer-payments", requirePermission("finance.read"), route(async (req, res) => {
    const result = await paged(pool, req.query, `SELECT r.id,r.order_id AS "orderId",o.order_number AS "orderNumber",r.amount_vnd AS "amountVnd",r.method,r.reference,r.note,r.created_by AS "createdBy",r.created_at AS "createdAt" FROM sales_receipts r JOIN orders o ON o.id=r.order_id ORDER BY r.created_at DESC`, "SELECT COUNT(*)::int total FROM sales_receipts");
    res.json({ payments: result.rows, pagination: result.pagination });
  }));
  router.post("/finance/customer-payments", requirePermission("payments.write"), requireCsrf, route(async (req, res) => {
    const parsed = receiptSchema.safeParse(req.body);
    if (!parsed.success) throw fail(400, "Thông tin phiếu thu chưa hợp lệ.");
    const data = parsed.data;
    const result = await withTransaction(pool, async (client) => {
      const previous = await idempotent(client, "sales_receipts", data);
      if (previous) return { id: previous.id, replayed: true };
      const order = (await client.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [data.orderId])).rows[0];
      if (!order) throw fail(404, "Không tìm thấy đơn hàng.");
      if (["vnpay", "9pay", "momo", "zalopay"].includes(order.payment_method)) throw fail(409, "Thanh toán trực tuyến được đối soát qua cổng thanh toán.");
      if (order.status === "cancelled" || order.payment_status === "paid" || order.total_vnd === null) throw fail(409, "Đơn đã kết thúc, đã thu đủ tiền hoặc chưa chốt tổng.");
      if (order.payment_method === "cod" && !["shipped", "completed"].includes(order.status)) throw fail(409, "Chỉ ghi nhận tiền COD sau khi giao hàng.");
      const received = await receiptTotal(client, order.id);
      if (data.amountVnd > order.total_vnd - received) throw fail(409, "Số tiền thu vượt số tiền còn phải thu.");
      const inserted = await client.query(`INSERT INTO sales_receipts (order_id,amount_vnd,method,reference,note,request_key,request_hash,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [order.id, data.amountVnd, data.method, data.reference, data.note, data.requestKey, digest(data), req.admin.username]);
      if (received + data.amountVnd === order.total_vnd) await client.query("UPDATE orders SET payment_status='paid',status=CASE WHEN payment_method='cod' AND status='shipped' THEN 'completed' ELSE status END,updated_at=now() WHERE id=$1", [order.id]);
      await appendAudit(client, { actor: req.admin, action: "finance.receipt.post", entityType: "sales_receipt", entityId: inserted.rows[0].id, metadata: { orderId: order.id, amountVnd: data.amountVnd, method: data.method } });
      return { id: inserted.rows[0].id, replayed: false };
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));
  for (const definition of [{ path: "supplier-payments", table: "supplier_payments", schema: supplierPaymentSchema, listKey: "payments" }, { path: "expenses", table: "expense_requests", schema: expenseSchema, listKey: "expenses" }]) {
    const { table } = definition;
    router.get(`/finance/${definition.path}`, requirePermission("finance.read"), route(async (req, res) => {
      const fields = table === "supplier_payments" ? 't.supplier_id AS "supplierId",s.name AS "supplierName",' : "t.category,t.payee,";
      const join = table === "supplier_payments" ? "LEFT JOIN suppliers s ON s.id=t.supplier_id" : "";
      const result = await paged(pool, req.query, `SELECT t.id,${fields}t.amount_vnd AS "amountVnd",t.method,t.reference,t.note,t.status,t.created_by AS "createdBy",t.approved_by AS "approvedBy",t.created_at AS "createdAt",t.posted_at AS "postedAt" FROM ${table} t ${join} ORDER BY t.created_at DESC`, `SELECT COUNT(*)::int total FROM ${table}`);
      res.json({ [definition.listKey]: result.rows, pagination: result.pagination });
    }));
    router.post(`/finance/${definition.path}`, requirePermission("finance.write"), requireCsrf, route(async (req, res) => {
      const parsed = definition.schema.safeParse(req.body);
      if (!parsed.success) throw fail(400, "Thông tin đề nghị chi chưa hợp lệ.");
      const data = parsed.data;
      const result = await withTransaction(pool, async (client) => {
        const previous = await idempotent(client, table, data);
        if (previous) return { id: previous.id, replayed: true };
        let inserted;
        if (table === "supplier_payments") {
          const supplier = (await client.query("SELECT id,active FROM suppliers WHERE id=$1 FOR UPDATE", [data.supplierId])).rows[0];
          if (!supplier?.active) throw fail(409, "Nhà cung cấp không khả dụng.");
          const balance = await supplierBalance(client, supplier.id);
          if (data.amountVnd > balance.received - balance.paid) throw fail(409, "Khoản chi vượt công nợ hàng đã nhận.");
          inserted = await client.query(`INSERT INTO supplier_payments (supplier_id,amount_vnd,method,reference,note,request_key,request_hash,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [data.supplierId, data.amountVnd, data.method, data.reference, data.note, data.requestKey, digest(data), req.admin.username]);
        } else {
          inserted = await client.query(`INSERT INTO expense_requests (category,payee,amount_vnd,method,reference,note,request_key,request_hash,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [data.category, data.payee, data.amountVnd, data.method, data.reference, data.note, data.requestKey, digest(data), req.admin.username]);
        }
        await appendAudit(client, { actor: req.admin, action: "finance.request.create", entityType: table, entityId: inserted.rows[0].id, metadata: { amountVnd: data.amountVnd, reference: data.reference } });
        return { id: inserted.rows[0].id, replayed: false };
      });
      res.status(result.replayed ? 200 : 201).json(result);
    }));
    router.post(`/finance/${definition.path}/:id/:action`, requirePermission("finance.approve"), requireCsrf, route(async (req, res) => {
      if (!z.string().uuid().safeParse(req.params.id).success || !["approve", "cancel"].includes(req.params.action)) throw fail(400, "Thao tác không hợp lệ.");
      const result = await withTransaction(pool, async (client) => {
        const document = (await client.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
        if (!document) throw fail(404, "Không tìm thấy đề nghị chi.");
        const target = req.params.action === "approve" ? "posted" : "cancelled";
        if (document.status === target) return { id: document.id, status: target, replayed: true };
        if (document.status !== "submitted") throw fail(409, "Đề nghị này đã được xử lý.");
        if (target === "posted" && document.created_by === req.admin.username && !["owner", "admin"].includes(req.admin.role)) throw fail(409, "Người lập không được tự duyệt đề nghị của mình.");
        if (target === "posted" && table === "supplier_payments") {
          await client.query("SELECT id FROM suppliers WHERE id=$1 FOR UPDATE", [document.supplier_id]);
          const balance = await supplierBalance(client, document.supplier_id);
          if (Number(document.amount_vnd) > balance.received - balance.paid) throw fail(409, "Công nợ đã thay đổi; khoản chi vượt số tiền còn phải trả.");
        }
        await client.query(`UPDATE ${table} SET status=$2,approved_by=$3,posted_at=CASE WHEN $2='posted' THEN now() ELSE NULL END WHERE id=$1`, [document.id, target, req.admin.username]);
        await appendAudit(client, { actor: req.admin, action: `finance.request.${req.params.action}`, entityType: table, entityId: document.id, metadata: { amountVnd: Number(document.amount_vnd), status: target } });
        return { id: document.id, status: target, replayed: false };
      });
      res.json(result);
    }));
  }
  router.get("/reports/overview", requirePermission("reports.read"), route(async (req, res) => {
    const dates = range(req.query);
    const where = "(o.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $1::date AND $2::date";
    const [summary, daily, top, inventory, purchases, payments, expenses] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS "orderCount",COALESCE(SUM(o.total_vnd) FILTER (WHERE o.status<>'cancelled' AND o.return_completed_at IS NULL),0) AS "orderValueVnd",COALESCE(SUM(CASE WHEN o.return_completed_at IS NOT NULL OR o.status='cancelled' THEN 0 WHEN o.payment_status='paid' THEN o.total_vnd ELSE COALESCE(r.received,0) END),0) AS "collectedVnd",COALESCE(SUM(GREATEST(COALESCE(o.total_vnd,0)-COALESCE(r.received,0),0)) FILTER (WHERE o.payment_status<>'paid' AND o.status<>'cancelled' AND o.return_completed_at IS NULL),0) AS "outstandingVnd",COUNT(*) FILTER (WHERE o.status='completed' AND o.return_completed_at IS NULL)::int AS "completedCount",COUNT(*) FILTER (WHERE o.status='cancelled')::int AS "cancelledCount",COUNT(*) FILTER (WHERE o.return_completed_at IS NOT NULL)::int AS "returnedCount",COALESCE(SUM(o.total_vnd) FILTER (WHERE o.return_completed_at IS NOT NULL),0) AS "returnedValueVnd" FROM orders o LEFT JOIN (SELECT order_id,SUM(amount_vnd) received FROM sales_receipts GROUP BY order_id) r ON r.order_id=o.id WHERE ${where}`, dates),
      pool.query(`SELECT (o.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS date,COUNT(*)::int AS "orderCount",COALESCE(SUM(o.total_vnd) FILTER (WHERE o.status<>'cancelled' AND o.return_completed_at IS NULL),0) AS "orderValueVnd",COALESCE(SUM(CASE WHEN o.return_completed_at IS NOT NULL OR o.status='cancelled' THEN 0 WHEN o.payment_status='paid' THEN o.total_vnd ELSE COALESCE(r.received,0) END),0) AS "collectedVnd" FROM orders o LEFT JOIN (SELECT order_id,SUM(amount_vnd) received FROM sales_receipts GROUP BY order_id) r ON r.order_id=o.id WHERE ${where} GROUP BY 1 ORDER BY 1`, dates),
      pool.query(`SELECT i.product_name AS "productName",SUM(i.quantity)::int AS quantity,SUM(i.line_total_vnd) AS "salesVnd" FROM order_items i JOIN orders o ON o.id=i.order_id WHERE ${where} AND o.status<>'cancelled' AND o.return_completed_at IS NULL GROUP BY i.product_name ORDER BY SUM(i.line_total_vnd) DESC LIMIT 10`, dates),
      pool.query(`SELECT (SELECT COUNT(*)::int FROM warehouses WHERE active) AS "warehouseCount",COUNT(*)::int AS "variantCount",COALESCE(SUM(stock_quantity),0)::bigint AS "availableQuantity",COUNT(*) FILTER (WHERE active AND stock_quantity<=5)::int AS "lowStockCount" FROM product_variants`),
      pool.query(`SELECT COALESCE(SUM(i.line_total_vnd),0) AS total FROM goods_receipt_items i JOIN goods_receipts r ON r.id=i.goods_receipt_id WHERE (r.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $1::date AND $2::date`, dates),
      pool.query(`SELECT COALESCE(SUM(amount_vnd),0) AS total FROM supplier_payments WHERE status='posted' AND (posted_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $1::date AND $2::date`, dates),
      pool.query(`SELECT COALESCE(SUM(amount_vnd),0) AS total FROM expense_requests WHERE status='posted' AND (posted_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $1::date AND $2::date`, dates)
    ]);
    const salesChannels=await require('./channel-reports').channelReport(pool,dates[0],dates[1]);
    res.json({salesChannels, from: dates[0], to: dates[1], definition: "Đơn theo ngày tạo tại Việt Nam; tiền thu là số đã ghi nhận đến hiện tại của các đơn trong kỳ. Không phải báo cáo lợi nhuận hoặc báo cáo kế toán pháp định.", summary: numeric({ ...summary.rows[0], purchaseReceivedVnd: purchases.rows[0].total, supplierPaidVnd: payments.rows[0].total, expensesVnd: expenses.rows[0].total }), daily: daily.rows.map(numeric), topProducts: top.rows.map((row) => ({ ...numeric(row), quantity: Number(row.quantity) })), inventory: numeric(inventory.rows[0]) });
  }));
  return router;
}
module.exports = { createFinanceApi, receiptTotal, recordFullOrderPayment, range, supplierPaymentSchema, expenseSchema, receiptSchema };
