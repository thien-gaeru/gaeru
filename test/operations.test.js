const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const inventory = require("../src/inventory");
const { createOperationsApi, withIdempotency } = require("../src/operations-api");
const { ROLE_PERMISSIONS } = require("../src/staff-access");

const variantId = "4b4cfca4-96cd-47b1-a851-ed6f9944359f";
const mainId = "8fdd01fd-c15d-42d0-b95d-beb8cc3a5ef7";
const otherId = "a1ee81a1-6f7d-4a9f-a651-d99e774df69f";
const orderId = "2aee81a1-6f7d-4a9f-a651-d99e774df69f";
const itemId = "1aee81a1-6f7d-4a9f-a651-d99e774df69f";
const actor = { id: null, username: "owner", role: "owner", permissions: ROLE_PERMISSIONS.owner, source: "bootstrap" };

function memoryClient({ quantity = 5, balances = [[mainId, 2], [otherId, 3]], legacyItems = [] } = {}) {
  const state = { quantity, balances: new Map(balances), allocations: [], movements: [], audit: [], requests: new Map(), statements: [], legacyItems };
  const client = {
    async query(sql, values = []) {
      state.statements.push({ sql, values });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.startsWith("SELECT v.id,v.sku")) return { rows: [{ id: values[0], sku: "K9-USB", variantName: "USB-C", productName: "GAERU K9", stockQuantity: state.quantity }] };
      if (sql.startsWith("SELECT id FROM warehouses WHERE code")) return { rows: [{ id: mainId }] };
      if (sql.startsWith("SELECT id,active FROM warehouses")) return { rows: [{ id: values[0], active: true }] };
      if (sql.startsWith("SELECT s.warehouse_id")) return { rows: [...state.balances].sort(([a], [b]) => a.localeCompare(b)).map(([warehouseId, quantity]) => ({ warehouseId, quantity, active: true })) };
      if (sql.startsWith("INSERT INTO warehouse_stock")) {
        if (sql.includes("WHERE NOT EXISTS") && state.balances.size) return { rowCount: 0, rows: [] };
        const exists = state.balances.has(values[0]);
        if (!exists) state.balances.set(values[0], 0);
        return { rowCount: exists ? 0 : 1, rows: exists ? [] : [{ variant_id: values[1] }] };
      }
      if (sql.startsWith("SELECT quantity FROM warehouse_stock")) return { rows: [{ quantity: state.balances.get(values[0]) }] };
      if (sql.startsWith("UPDATE warehouse_stock")) { state.balances.set(values[0], values[2]); return { rows: [] }; }
      if (sql.startsWith("UPDATE product_variants SET stock_quantity")) { state.quantity = values[1]; return { rows: [] }; }
      if (sql.startsWith("INSERT INTO inventory_movements")) {
        assert.equal(state.movements.some((row) => row.eventKey === values[0]), false, "movement event must be unique");
        state.movements.push({ eventKey: values[0], warehouseId: values[1], type: values[6], delta: values[7], before: values[8], after: values[9], reason: values[12] });
        return { rows: [] };
      }
      if (sql.startsWith("SELECT id FROM inventory_movements")) return { rows: state.movements.filter((row) => row.eventKey === values[0]).map(() => ({ id: "existing" })) };
      if (sql.startsWith("SELECT quantity,released_at FROM order_stock_allocations")) return { rows: state.allocations.filter((row) => row.orderId === values[0]).map((row) => ({ quantity: row.quantity, released_at: row.releasedAt })) };
      if (sql.startsWith("INSERT INTO order_stock_allocations")) {
        state.allocations.push({ orderId: values[0], warehouseId: values[2], quantity: values[3], releasedAt: null });
        return { rows: [] };
      }
      if (sql.startsWith("SELECT DISTINCT variant_id")) return { rows: state.allocations.some((row) => row.orderId === values[0] && !row.releasedAt) ? [{ id: variantId }] : [] };
      if (sql.startsWith("SELECT EXISTS (SELECT 1 FROM order_stock_allocations")) return { rows: [{ allocated: state.allocations.some((row) => row.orderId === values[0]) }] };
      if (sql.startsWith("SELECT warehouse_id AS")) return { rows: state.allocations.filter((row) => row.orderId === values[0] && !row.releasedAt).sort((a, b) => a.warehouseId.localeCompare(b.warehouseId)).map((row) => ({ warehouseId: row.warehouseId, quantity: row.quantity })) };
      if (sql.startsWith("UPDATE order_stock_allocations")) {
        state.allocations.find((row) => row.orderId === values[0] && row.warehouseId === values[2]).releasedAt = "now";
        return { rows: [] };
      }
      if (sql.startsWith('SELECT variant_id AS "variantId",SUM(quantity)')) return { rows: state.legacyItems };
      if (sql.startsWith("SELECT COUNT(*)::int AS count FROM order_items")) return { rows: [{ count: 0 }] };
      if (sql.startsWith("INSERT INTO audit_events")) { state.audit.push(values); return { rows: [{ id: `audit-${state.audit.length}` }] }; }
      if (sql.startsWith("INSERT INTO inventory_requests")) {
        const exists = state.requests.has(values[0]);
        if (!exists) state.requests.set(values[0], { operation_type: values[1], request_hash: values[2], result: null });
        return { rowCount: exists ? 0 : 1, rows: exists ? [] : [{ request_key: values[0] }] };
      }
      if (sql.startsWith("SELECT operation_type,request_hash,result")) return { rows: [state.requests.get(values[0])] };
      if (sql.startsWith("UPDATE inventory_requests")) { state.requests.get(values[0]).result = JSON.parse(values[1]); return { rows: [] }; }
      throw new Error(`Unexpected test query: ${sql}`);
    },
    release() {}
  };
  return { client, state };
}

test("reservations allocate available stock across warehouses and release the same allocations once", async () => {
  const { client, state } = memoryClient();
  const input = { variantId, quantity: 4, orderId, actor };
  await inventory.reserveStock(client, input);
  assert.equal(state.quantity, 1);
  assert.deepEqual([...state.balances.values()], [0, 1]);
  assert.equal(state.movements.reduce((sum, row) => sum + row.delta, 0), -4);
  assert.equal(state.allocations.reduce((sum, row) => sum + row.quantity, 0), 4);
  const variantLock = state.statements.findIndex((row) => row.sql.includes("FOR UPDATE OF v"));
  const warehouseLock = state.statements.findIndex((row) => row.sql.includes("FOR UPDATE OF s"));
  assert.ok(variantLock >= 0 && warehouseLock > variantLock);
  await inventory.reserveStock(client, input);
  assert.equal(state.movements.length, 2);
  await inventory.releaseOrderStock(client, { orderId, actor });
  assert.equal(state.quantity, 5);
  assert.deepEqual([...state.balances.values()], [2, 3]);
  assert.equal(state.movements.reduce((sum, row) => sum + row.delta, 0), 0);
  await inventory.releaseOrderStock(client, { orderId, actor });
  assert.equal(state.movements.length, 4);
  assert.equal(state.audit.length, 2);
});

test("transfers preserve aggregate available stock and reject negative source balances", async () => {
  const { client, state } = memoryClient();
  const data = { fromWarehouseId: mainId, toWarehouseId: otherId, variantId, quantity: 2, reason: "Chuyển kho hàng bán", requestKey: "transfer-request-001", actor };
  await inventory.transferStock(client, data);
  assert.equal(state.quantity, 5);
  assert.deepEqual([...state.balances.values()], [0, 5]);
  assert.equal(state.movements.reduce((sum, row) => sum + row.delta, 0), 0);
  await assert.rejects(inventory.transferStock(client, { ...data, quantity: 1, requestKey: "transfer-request-002" }), /không đủ tồn/);
  assert.equal(state.movements.length, 2);
});

test("adjustments reject stale counts and negative balances before changing stock", async () => {
  const { client, state } = memoryClient();
  const data = { warehouseId: mainId, variantId, delta: -1, expectedQuantity: 1, reason: "Kiểm kê cuối ngày", requestKey: "adjustment-request-01", actor };
  await assert.rejects(inventory.adjustWarehouseStock(client, data), /Tồn kho đã thay đổi/);
  await assert.rejects(inventory.adjustWarehouseStock(client, { ...data, expectedQuantity: 2, delta: -3 }), /Số lượng tồn kho/);
  assert.equal(state.movements.length, 0);
  await inventory.adjustWarehouseStock(client, { ...data, expectedQuantity: 2 });
  assert.equal(state.quantity, 4);
  assert.equal(state.balances.get(mainId), 1);
  assert.equal(state.audit.length, 1);
});

test("opening balances do not double-count aggregate stock or create zero movements", async () => {
  for (const quantity of [0, 7]) {
    const { client, state } = memoryClient({ quantity, balances: [] });
    await inventory.initializeVariantStock(client, { variantId, quantity, actor });
    await inventory.initializeVariantStock(client, { variantId, quantity, actor });
    assert.equal(state.quantity, quantity);
    assert.equal(state.balances.get(mainId), quantity);
    assert.equal(state.movements.length, quantity ? 1 : 0);
  }
});

test("legacy order cancellation records an explicit MAIN conversion release only once", async () => {
  const { client, state } = memoryClient({ legacyItems: [{ variantId, quantity: 2 }] });
  await inventory.releaseOrderStock(client, { orderId, actor });
  assert.equal(state.quantity, 7);
  assert.equal(state.balances.get(mainId), 4);
  assert.equal(state.movements[0].type, "legacy_sale_release");
  assert.match(state.movements[0].reason, /Đơn trước khi phân kho/);
  await inventory.releaseOrderStock(client, { orderId, actor });
  assert.equal(state.movements.length, 1);
  assert.equal(state.quantity, 7);
});

test("product stock edits preserve the sum of warehouse balances", async () => {
  const { client, state } = memoryClient();
  await inventory.setVariantStock(client, { variantId, quantity: 1, actor });
  assert.equal(state.quantity, 1);
  assert.equal([...state.balances.values()].reduce((a, b) => a + b, 0), 1);
  await inventory.setVariantStock(client, { variantId, quantity: 8, actor });
  assert.equal(state.quantity, 8);
  assert.equal([...state.balances.values()].reduce((a, b) => a + b, 0), 8);
});

test("idempotency replays completed results and rejects request-key payload reuse", async () => {
  const { client } = memoryClient();
  const data = { key: "posting-request-key-1", operation: "transfer", body: { quantity: 3 }, actor };
  let posted = 0;
  const action = async () => ({ id: ++posted });
  assert.deepEqual(await withIdempotency(client, data, action), { id: 1 });
  assert.deepEqual(await withIdempotency(client, data, action), { id: 1 });
  await assert.rejects(withIdempotency(client, { ...data, body: { quantity: 4 } }, action), /dữ liệu khác/);
  assert.equal(posted, 1);
});

async function startApi(context, client, principal = actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.admin = principal; req.session = { csrfToken: "valid-token" }; next(); });
  app.use("/api/gaeru_ceo", createOperationsApi({ connect: async () => client, query: (...args) => client.query(...args) }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  return (path, body = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/gaeru_ceo${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": "valid-token" }, body: JSON.stringify(body)
  });
}

test("warehouse staff cannot approve stock adjustments or purchase orders", async (context) => {
  let accessed = false;
  const client = { async query() { accessed = true; throw new Error("Database should not be reached"); } };
  const principal = { ...actor, username: "warehouse1", role: "warehouse", permissions: ROLE_PERMISSIONS.warehouse };
  const request = await startApi(context, client, principal);
  assert.equal((await request("/inventory/adjustments")).status, 403);
  assert.equal((await request(`/purchase-orders/${orderId}/approve`)).status, 403);
  assert.equal(accessed, false);
});

test("purchase approval enforces maker-checker identity and records approval audit", async (context) => {
  for (const maker of ["manager1", "buyer1"]) {
    await context.test(maker, async (subcontext) => {
      const { client, state } = memoryClient();
      const baseQuery = client.query;
      let status = "submitted";
      client.query = async (sql, values = []) => {
        if (sql === "SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE") return { rows: [{ id: orderId, status, created_by: null, created_by_username: maker, submitted_by_username: maker, supplier_id: mainId, warehouse_id: mainId }] };
        if (sql.startsWith("SELECT id,name FROM")) return { rows: [{ id: mainId, name: "Active" }] };
        if (sql.startsWith("UPDATE purchase_orders SET status='approved'")) { status = "approved"; return { rows: [] }; }
        if (sql.startsWith("SELECT o.id,o.number")) return { rows: [{ id: orderId, status, totalVnd: 100000 }] };
        if (sql.startsWith("SELECT id,variant_id")) return { rows: [] };
        return baseQuery(sql, values);
      };
      const principal = { ...actor, username: "manager1", role: "manager", permissions: ROLE_PERMISSIONS.manager };
      const request = await startApi(subcontext, client, principal);
      const response = await request(`/purchase-orders/${orderId}/approve`);
      assert.equal(response.status, maker === "manager1" ? 403 : 200);
      assert.equal(status, maker === "manager1" ? "submitted" : "approved");
      assert.equal(state.audit.length, maker === "manager1" ? 0 : 1);
    });
  }
});

test("posted receipts update warehouse and aggregate once, allow partial receiving, and reject over-receiving", async (context) => {
  const { client, state } = memoryClient();
  const baseQuery = client.query;
  let purchaseStatus = "approved";
  let received = 0;
  let receipts = 0;
  client.query = async (sql, values = []) => {
    if (sql === "SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE") return { rows: [{ id: orderId, status: purchaseStatus, supplier_id: mainId, warehouse_id: mainId }] };
    if (sql.startsWith("SELECT id,name FROM")) return { rows: [{ id: mainId, name: "Active" }] };
    if (sql.startsWith('SELECT id,variant_id AS "variantId",quantity')) return { rows: [{ id: itemId, variantId, quantity: 5, receivedQuantity: received, unitCostVnd: 100000 }] };
    if (sql.startsWith("INSERT INTO goods_receipts")) { receipts++; return { rows: [{ id: orderId, number: `GRN-${receipts}`, createdAt: "2026-10-23" }] }; }
    if (sql.startsWith("INSERT INTO goods_receipt_items")) return { rows: [{ id: `receipt-item-${receipts}` }] };
    if (sql.startsWith("UPDATE purchase_order_items")) { received += values[1]; return { rows: [] }; }
    if (sql.startsWith("UPDATE purchase_orders SET status=$2")) { purchaseStatus = values[1]; return { rows: [] }; }
    return baseQuery(sql, values);
  };
  const request = await startApi(context, client);
  const body = { requestKey: "receipt-request-0001", items: [{ itemId, quantity: 2 }] };
  const first = await request(`/purchase-orders/${orderId}/receipts`, body);
  assert.equal(first.status, 201);
  assert.equal((await first.json()).receipt.purchaseOrderStatus, "partially_received");
  assert.equal(state.quantity, 7);
  assert.equal(received, 2);
  const replay = await request(`/purchase-orders/${orderId}/receipts`, body);
  assert.equal(replay.status, 201);
  assert.equal(receipts, 1);
  assert.equal(state.quantity, 7);
  const invalid = await request(`/purchase-orders/${orderId}/receipts`, { ...body, requestKey: "receipt-request-0002", items: [{ itemId, quantity: 4 }] });
  assert.equal(invalid.status, 409);
  assert.equal(received, 2);
  assert.equal(receipts, 1);
  const final = await request(`/purchase-orders/${orderId}/receipts`, { ...body, requestKey: "receipt-request-0003", items: [{ itemId, quantity: 3 }] });
  assert.equal(final.status, 201);
  assert.equal((await final.json()).receipt.purchaseOrderStatus, "received");
  assert.equal(received, 5);
  assert.equal(state.quantity, 10);
  assert.equal(state.balances.get(mainId), 7);
  assert.equal(state.movements.filter((row) => row.type === "purchase_receipt").length, 2);
});
