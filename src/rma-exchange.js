'use strict';
const { z } = require('zod');
const { createHash, randomUUID } = require('node:crypto');
const { withTransaction } = require('./db');
const { appendAudit } = require('./audit');
const inventory = require('./inventory');
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const common = { version: z.number().int().positive(), requestKey: z.string().uuid(), reason: z.string().trim().min(5).max(1000) };
const issueSchema = z.object({ ...common, warehouseId: z.string().uuid(), confirmedReceivedAll: z.literal(true), items: z.array(z.object({
  orderItemId: z.string().uuid(), replacementVariantId: z.string().uuid(), quantity: z.number().int().min(1).max(99)
}).strict()).min(1).max(30).refine(items => new Set(items.map(item => item.orderItemId)).size === items.length) }).strict();
const voidSchema = z.object({ ...common, issueId: z.string().uuid() }).strict();
function authorize(actor) {
  if (!actor?.permissions?.includes('orders.write') || !actor.permissions.includes('inventory.approve')) throw fail('Cần quyền xử lý đơn và duyệt kho để xuất/hoàn lại hàng đổi mới.', 403);
}
async function readIssue(client, caseId, issueId = null) {
  const row = (await client.query(`SELECT id,case_id AS "caseId",warehouse_id AS "warehouseId",warehouse_name AS "warehouseName",status,reason,created_by AS "createdBy",created_at AS "createdAt",voided_by AS "voidedBy",voided_at AS "voidedAt",void_reason AS "voidReason"
    FROM rma_exchange_issues WHERE case_id=$1 AND ($2::uuid IS NULL AND status='posted' OR id=$2) ORDER BY created_at DESC LIMIT 1`, [caseId, issueId])).rows[0];
  if (!row) return null;
  row.items = (await client.query(`SELECT order_item_id AS "orderItemId",replacement_variant_id AS "replacementVariantId",inventory_movement_id AS "inventoryMovementId",sku,variant_name AS "variantName",quantity,unit_price_vnd AS "unitPriceVnd" FROM rma_exchange_issue_items WHERE issue_id=$1 ORDER BY order_item_id`, [row.id])).rows;
  return row;
}
async function sourceItems(client, orderId) {
  return (await client.query(`SELECT i.id AS "orderItemId",i.variant_id AS "variantId",v.product_id AS "productId",i.product_name AS "productName",i.variant_name AS "variantName",i.sku,i.quantity,i.unit_price_vnd AS "unitPriceVnd" FROM order_items i LEFT JOIN product_variants v ON v.id=i.variant_id WHERE i.order_id=$1 ORDER BY i.id`, [orderId])).rows;
}
function eligibility(row, issue) {
  if (row.kind !== 'return' || row.return_type !== 'exchange') return 'Hồ sơ không phải đổi mới 1:1.';
  if (row.status !== 'received' || row.inbound_status !== 'delivered_to_warehouse') return 'Xác nhận đã nhận đủ hàng về kho trước khi xuất hàng đổi.';
  if (String(row.inspection_notes || '').trim().length < 5) return 'Ghi kết quả thẩm định kỹ thuật trước khi xuất hàng đổi.';
  if (issue) return 'Đã có chứng từ xuất kho đang hiệu lực. Không xuất lặp.';
  return null;
}
async function exchangeOptions(pool, caseId) {
  const row = (await pool.query('SELECT * FROM order_after_sales WHERE id=$1', [caseId])).rows[0];
  if (!row) throw fail('Không tìm thấy hồ sơ RMA.', 404);
  const issue = await readIssue(pool, caseId), items = await sourceItems(pool, row.order_id);
  const warehouses = (await pool.query('SELECT id,code,name FROM warehouses WHERE active=true ORDER BY code')).rows;
  for (const item of items) {
    item.candidates = item.productId ? (await pool.query(`SELECT v.id AS "variantId",v.sku,v.name,v.price_vnd AS "priceVnd" FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.product_id=$1 AND v.active=true AND p.active=true AND p.deleted_at IS NULL AND (v.id=$2 OR v.price_vnd=$3) ORDER BY v.sku`, [item.productId, item.variantId, item.unitPriceVnd])).rows : [];
    for (const candidate of item.candidates) candidate.stock = (await pool.query('SELECT s.warehouse_id AS "warehouseId",s.quantity FROM warehouse_stock s JOIN warehouses w ON w.id=s.warehouse_id WHERE s.variant_id=$1 AND w.active=true ORDER BY s.warehouse_id', [candidate.variantId])).rows;
  }
  const reason = eligibility(row, issue) || (!items.length || items.some(item => !item.variantId || !item.productId || !item.candidates.length) ? 'Sản phẩm gốc hoặc phiên bản thay thế không còn đầy đủ.' : null);
  return { caseId, version: row.version, eligible: !reason, reason, scope: 'full_order_same_product_no_price_difference', warehouses, items, issue };
}
async function request(client, caseId, data, actor, operation, work) {
  const key = 'rma-exchange:' + data.requestKey;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
  const canonical = { caseId, ...data, ...(data.items ? { items: [...data.items].sort((a, b) => a.orderItemId.localeCompare(b.orderItemId)) } : {}) };
  const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  const previous = (await client.query('SELECT operation_type,request_hash,result,actor_username FROM inventory_requests WHERE request_key=$1', [key])).rows[0];
  if (previous) {
    if (previous.operation_type !== operation || previous.request_hash !== hash || previous.actor_username !== actor.username) throw fail('Mã yêu cầu đã được dùng cho nội dung hoặc nhân sự khác.');
    return { ...previous.result, existing: true };
  }
  const result = await work();
  await client.query('INSERT INTO inventory_requests(request_key,operation_type,request_hash,result,actor_username) VALUES($1,$2,$3,$4,$5)', [key, operation, hash, JSON.stringify(result), actor.username]);
  return result;
}
async function lockCase(client, caseId, version = null) {
  // Match order deletion/restoration: lock the original order before its case.
  // This also serializes a new issue against deletion's open-document check.
  const reference = (await client.query('SELECT order_id FROM order_after_sales WHERE id=$1', [caseId])).rows[0];
  if (!reference) throw fail('Không tìm thấy hồ sơ RMA.', 404);
  const order = (await client.query('SELECT id,order_number,customer_id,email,phone FROM orders WHERE id=$1 FOR UPDATE', [reference.order_id])).rows[0];
  if (!order) throw fail('Không tìm thấy đơn gốc của hồ sơ RMA.', 404);
  const row = (await client.query('SELECT * FROM order_after_sales WHERE id=$1 FOR UPDATE', [caseId])).rows[0];
  if (!row) throw fail('Không tìm thấy hồ sơ RMA.', 404);
  if (row.order_id !== order.id || (version !== null && row.version !== version)) throw fail('Hồ sơ RMA đã thay đổi. Tải lại trước khi xuất hoặc hoàn lại kho.');
  return { ...row, order_number: order.order_number, customer_id: order.customer_id, email: order.email, phone: order.phone };
}
async function adjust(client, issueId, warehouseId, items, direction, actor, reason) {
  const quantities = new Map();
  for (const item of items) quantities.set(item.replacementVariantId, (quantities.get(item.replacementVariantId) || 0) + item.quantity);
  const movements = new Map();
  for (const [variantId, quantity] of [...quantities].sort(([a], [b]) => a.localeCompare(b))) {
    await client.query('SELECT id FROM product_variants WHERE id=$1 FOR UPDATE', [variantId]);
    const before = Number((await client.query('SELECT quantity FROM warehouse_stock WHERE warehouse_id=$1 AND variant_id=$2', [warehouseId, variantId])).rows[0]?.quantity || 0);
    if (direction < 0 && before < quantity) throw fail('Kho đã chọn không đủ hàng đổi mới. Chưa có chứng từ hoặc trừ kho nào được lưu.');
    const requestKey = `rma-${direction < 0 ? 'issue' : 'void'}:${issueId}:${variantId}`;
    await inventory.adjustWarehouseStock(client, { warehouseId, variantId, delta: direction * quantity, expectedQuantity: before, reason, requestKey, actor });
    const movement = (await client.query('SELECT id FROM inventory_movements WHERE event_key=$1', ['adjustment:' + requestKey])).rows[0];
    movements.set(variantId, movement.id);
  }
  return movements;
}
async function issueExchange(pool, { caseId, data, actor }) {
  authorize(actor); data = issueSchema.parse(data);
  return withTransaction(pool, client => request(client, caseId, data, actor, 'rma_exchange_issue', async () => {
    const row = await lockCase(client, caseId, data.version), existing = await readIssue(client, caseId);
    const reason = eligibility(row, existing); if (reason) throw fail(reason);
    const original = await sourceItems(client, row.order_id);
    if (original.length !== data.items.length || original.some(item => !item.variantId || !item.productId || !data.items.some(selected => selected.orderItemId === item.orderItemId && selected.quantity === item.quantity))) throw fail('Chỉ hỗ trợ đổi toàn bộ đơn, đúng từng dòng và số lượng hàng đã nhận; không đổi một phần.');
    const warehouse = (await client.query('SELECT id,name FROM warehouses WHERE id=$1 AND active=true', [data.warehouseId])).rows[0];
    if (!warehouse) throw fail('Kho xuất không còn hoạt động.');
    const selected = [];
    for (const item of [...data.items].sort((a, b) => a.replacementVariantId.localeCompare(b.replacementVariantId))) {
      const source = original.find(value => value.orderItemId === item.orderItemId);
      const variant = (await client.query('SELECT v.id,v.sku,v.name,v.product_id,v.price_vnd,v.active,p.active AS product_active,p.deleted_at FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1 FOR UPDATE OF v', [item.replacementVariantId])).rows[0];
      if (!variant || !variant.active || !variant.product_active || variant.deleted_at || variant.product_id !== source.productId || (variant.id !== source.variantId && variant.price_vnd !== source.unitPriceVnd)) throw fail('Chỉ đổi phiên bản cùng sản phẩm, cùng đơn giá đã mua; không hỗ trợ bù hoặc hoàn chênh lệch.');
      selected.push({ ...item, sku: variant.sku, variantName: variant.name, unitPriceVnd: source.unitPriceVnd });
    }
    const issueId = randomUUID();
    await client.query('INSERT INTO rma_exchange_issues(id,case_id,warehouse_id,warehouse_name,reason,created_by) VALUES($1,$2,$3,$4,$5,$6)', [issueId, caseId, warehouse.id, warehouse.name, data.reason, actor.username]);
    const moves = await adjust(client, issueId, warehouse.id, selected, -1, actor, 'Xuất hàng đổi RMA ' + (row.rma_number || caseId) + ': ' + data.reason);
    for (const item of selected) await client.query('INSERT INTO rma_exchange_issue_items(issue_id,order_item_id,replacement_variant_id,inventory_movement_id,sku,variant_name,quantity,unit_price_vnd) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [issueId, item.orderItemId, item.replacementVariantId, moves.get(item.replacementVariantId), item.sku, item.variantName, item.quantity, item.unitPriceVnd]);
    const version = (await client.query("UPDATE order_after_sales SET version=version+1,outbound_status='preparing',outbound_carrier=NULL,outbound_tracking_number=NULL,updated_at=now() WHERE id=$1 RETURNING version", [caseId])).rows[0].version;
    const issue = await readIssue(client, caseId, issueId);
    await appendAudit(client, { actor, action: 'rma.exchange.issue', entityType: 'order_after_sales', entityId: caseId, metadata: { issue, requestKey: data.requestKey, confirmedReceivedAll: true, scope: 'full_order_same_product_no_price_difference' } });
    return { issue, version, existing: false };
  }));
}
async function voidExchange(pool, { caseId, data, actor }) {
  authorize(actor); data = voidSchema.parse(data);
  return withTransaction(pool, client => request(client, caseId, data, actor, 'rma_exchange_void', async () => {
    const row = await lockCase(client, caseId, data.version), issue = await readIssue(client, caseId, data.issueId);
    if (!issue || issue.status !== 'posted' || row.status !== 'received' || !['none', 'preparing'].includes(row.outbound_status)) throw fail('Chỉ hoàn lại chứng từ đang hiệu lực trước khi bàn giao hàng đổi cho vận chuyển.');
    await adjust(client, issue.id, issue.warehouseId, issue.items, 1, actor, 'Hoàn lại xuất đổi RMA ' + (row.rma_number || caseId) + ': ' + data.reason);
    await client.query("UPDATE rma_exchange_issues SET status='voided',voided_by=$2,voided_at=now(),void_reason=$3 WHERE id=$1", [issue.id, actor.username, data.reason]);
    const version = (await client.query("UPDATE order_after_sales SET version=version+1,outbound_status='none',outbound_carrier=NULL,outbound_tracking_number=NULL,updated_at=now() WHERE id=$1 RETURNING version", [caseId])).rows[0].version;
    await appendAudit(client, { actor, action: 'rma.exchange.void', entityType: 'order_after_sales', entityId: caseId, metadata: { issueId: issue.id, reason: data.reason, requestKey: data.requestKey } });
    return { issue: await readIssue(client, caseId, issue.id), version, existing: false };
  }));
}
module.exports = { issueSchema, voidSchema, exchangeOptions, issueExchange, voidExchange, readIssue, lockCase };
