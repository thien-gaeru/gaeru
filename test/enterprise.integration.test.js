const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const { createApp } = require("../src/app");
const { migrateDatabase } = require("../src/migrate");

// Runs real PostgreSQL statements in one embedded connection. Multi-connection
// locking and production integrations still require a separate staging run.
async function database() {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const previous = queue;
    let release;
    queue = new Promise((resolve) => { release = resolve; });
    await previous;
    return release;
  }
  async function query(sql, values) {
    const result = !values && sql.includes(";") ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...result, rows: result?.rows || [], rowCount: result?.affectedRows ?? result?.rows?.length ?? 0 };
  }
  return {
    async query(sql, values) { const release = await lock(); try { return await query(sql, values); } finally { release(); } },
    async connect() { const release = await lock(); return { query, release }; },
    end: () => db.close()
  };
}

test("enterprise workflows integrate authentication, approvals, warehouse stock, collections and immutable audit", { timeout: 60000 }, async (context) => {
  const pool = await database();
  await migrateDatabase(pool);
  const app = createApp({ config: {
    NODE_ENV: "test", SESSION_SECRET: randomBytes(48).toString("hex"),
    ADMIN_USERNAME: "enterprise-owner", ADMIN_PASSWORD_HASH: bcrypt.hashSync("Owner-test-password-2026", 4), STORE_ORDERS_ENABLED: true
  }, pool, sessionStore: new session.MemoryStore() });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  context.after(async () => { await new Promise((resolve) => server.close(resolve)); await pool.end(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  function client() {
    let cookie = "", csrf = "";
    const api = {
      async request(url, method = "GET", body) {
        const response = await fetch(base + url, { method, headers: { Cookie: cookie, ...(method !== "GET" ? { "X-CSRF-Token": csrf } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const updatedCookie = response.headers.get("set-cookie");
        if (updatedCookie) cookie = updatedCookie.split(";")[0];
        const data = response.status === 204 ? null : await response.json();
        if (data?.csrfToken) csrf = data.csrfToken;
        return { status: response.status, data };
      },
      async ok(url, method = "GET", body, expected = 200) {
        const response = await api.request(url, method, body);
        assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(response.data)}`);
        return response.data;
      },
      async login(username, password) { await api.ok("/api/csrf"); return api.ok("/api/auth/login", "POST", { username, password }); }
    };
    return api;
  }
  const owner = client(), warehouse = client(), accountant = client(), manager = client(), sales = client();
  await owner.login("enterprise-owner", "Owner-test-password-2026");
  let variantId, productId, secondWarehouse, mainWarehouse, supplierId, purchaseId, staffWarehouse, departmentId;
  const password = "Employee-test-password-2026";
  const productPayload = { slug: "enterprise-test", name: "Enterprise test product", category: "audio", descriptor: "Test fixture", description: "", imageUrl: "/assets/products/k9.png", imageAlt: "Test", active: false, sortOrder: 0 };

  await context.test("owner sets up employees, departments, warehouse, supplier and opening stock", async () => {
    departmentId = (await owner.ok("/api/admin/departments", "POST", { code: "OPS", name: "Operations", active: true }, 201)).department?.id;
    if (!departmentId) departmentId = (await owner.ok("/api/admin/departments")).departments[0].id;
    for (const role of ["warehouse", "accountant", "manager", "sales"]) {
      const created = await owner.ok("/api/admin/staff", "POST", { username: `test-${role}`, fullName: `Test ${role}`, password, role, departmentId }, 201);
      if (role === "warehouse") staffWarehouse = created.staff || created;
    }
    await warehouse.login("test-warehouse", password);
    await accountant.login("test-accountant", password);
    await manager.login("test-manager", password);
    await sales.login("test-sales", password);
    assert.equal((await warehouse.request("/api/admin/staff")).status, 403);
    mainWarehouse = (await owner.ok("/api/admin/warehouses")).warehouses.find((row) => row.code === "MAIN").id;
    const createdWarehouse = await owner.ok("/api/admin/warehouses", "POST", { code: "HCM", name: "Test second warehouse", address: "Test address", active: true }, 201);
    secondWarehouse = createdWarehouse.warehouse?.id || createdWarehouse.id;
    const supplier = await owner.ok("/api/admin/suppliers", "POST", { code: "TEST-SUPPLIER", name: "Test supplier", email: "supplier@example.invalid", phone: "0900000000", address: "Test", active: true }, 201);
    supplierId = supplier.supplier?.id || supplier.id;
    productId = (await owner.ok("/api/admin/products", "POST", productPayload, 201)).id;
    variantId = (await owner.ok(`/api/admin/products/${productId}/variants`, "POST", { sku: "ENTERPRISE-TEST", name: "Test variant", options: {}, priceVnd: 150000, stockQuantity: 20, active: true }, 201)).id;
    await owner.ok(`/api/admin/products/${productId}`, "PUT", { ...productPayload, active: true });
    await owner.ok("/api/admin/settings", "PUT", { shippingNote: "Test shipping", shippingRates: { "Hồ Chí Minh": 30000 } });
    assert.equal((await pool.query("SELECT SUM(quantity)::int total FROM warehouse_stock WHERE variant_id=$1", [variantId])).rows[0].total, 20);
  });
  await context.test("approved purchase supports partial receipts and exact retry without duplicate stock", async () => {
    const created = await warehouse.ok("/api/admin/purchase-orders", "POST", { supplierId, warehouseId: secondWarehouse, reference: "TEST-PO", note: "Fixture", items: [{ variantId, quantity: 5, unitCostVnd: 100000 }] }, 201);
    purchaseId = created.purchaseOrder?.id || created.id;
    await warehouse.ok(`/api/admin/purchase-orders/${purchaseId}/submit`, "POST", {});
    assert.equal((await warehouse.request(`/api/admin/purchase-orders/${purchaseId}/approve`, "POST", {})).status, 403);
    await manager.ok(`/api/admin/purchase-orders/${purchaseId}/approve`, "POST", {});
    const purchase = (await owner.ok(`/api/admin/purchase-orders/${purchaseId}`)).purchaseOrder;
    const itemId = purchase.items[0].id;
    const receipt = { requestKey: randomUUID(), reference: "TEST-RECEIPT", note: "Partial", items: [{ itemId, quantity: 3 }] };
    const first = await warehouse.ok(`/api/admin/purchase-orders/${purchaseId}/receipts`, "POST", receipt, 201);
    const repeated = await warehouse.request(`/api/admin/purchase-orders/${purchaseId}/receipts`, "POST", receipt);
    assert.ok([200, 201].includes(repeated.status));
    assert.ok(first.id || first.receipt?.id || first.receiptId);
    assert.equal((await pool.query("SELECT stock_quantity FROM product_variants WHERE id=$1", [variantId])).rows[0].stock_quantity, 23);
    assert.equal((await warehouse.request(`/api/admin/purchase-orders/${purchaseId}/receipts`, "POST", { ...receipt, requestKey: randomUUID(), items: [{ itemId, quantity: 3 }] })).status, 409);
    await warehouse.ok(`/api/admin/purchase-orders/${purchaseId}/receipts`, "POST", { ...receipt, requestKey: randomUUID(), items: [{ itemId, quantity: 2 }] }, 201);
    assert.equal((await owner.ok(`/api/admin/purchase-orders/${purchaseId}`)).purchaseOrder.status, "received");
    assert.equal((await pool.query("SELECT stock_quantity FROM product_variants WHERE id=$1", [variantId])).rows[0].stock_quantity, 25);
  });
  await context.test("warehouse transfers preserve aggregate; approved adjustments reject stale counts and retries", async () => {
    const transfer = { fromWarehouseId: mainWarehouse, toWarehouseId: secondWarehouse, variantId, quantity: 4, reason: "Test stock relocation", requestKey: randomUUID() };
    await warehouse.ok("/api/admin/inventory/transfers", "POST", transfer, 201);
    const adjustment = { warehouseId: mainWarehouse, variantId, delta: -2, expectedQuantity: 16, reason: "Test inventory count", requestKey: randomUUID() };
    assert.equal((await warehouse.request("/api/admin/inventory/adjustments", "POST", adjustment)).status, 403);
    await owner.ok("/api/admin/inventory/adjustments", "POST", adjustment, 201);
    const repeated = await owner.request("/api/admin/inventory/adjustments", "POST", adjustment);
    assert.ok([200, 201].includes(repeated.status));
    assert.equal((await owner.request("/api/admin/inventory/adjustments", "POST", { ...adjustment, requestKey: randomUUID() })).status, 409);
    assert.equal((await pool.query("SELECT stock_quantity FROM product_variants WHERE id=$1", [variantId])).rows[0].stock_quantity, 23);
  });
  await context.test("checkout reserves assigned warehouses and cancellation restores exactly once", async () => {
    const guest = client();
    await guest.ok("/api/csrf");
    const placed = await guest.ok("/api/orders", "POST", { customer: { name: "Test customer", email: "customer@example.invalid", phone: "0900000000", address: "Test address", city: "Hồ Chí Minh", note: "Fixture" }, paymentMethod: "cod", items: [{ variantId, quantity: 20 }] }, 201);
    const orderId = placed.order.id;
    assert.equal((await pool.query("SELECT SUM(quantity)::int total FROM order_stock_allocations WHERE order_id=$1", [orderId])).rows[0].total, 20);
    assert.equal((await pool.query("SELECT stock_quantity FROM product_variants WHERE id=$1", [variantId])).rows[0].stock_quantity, 3);
    await owner.ok(`/api/admin/orders/${orderId}`, "PATCH", { status: "cancelled" });
    await owner.ok(`/api/admin/orders/${orderId}`, "PATCH", { status: "cancelled" });
    assert.equal((await pool.query("SELECT stock_quantity FROM product_variants WHERE id=$1", [variantId])).rows[0].stock_quantity, 23);
    assert.equal((await owner.request(`/api/admin/variants/${variantId}`, "DELETE")).status, 409);
  });
  await context.test("partial collections protect the order balance and reject overcollection and unauthorized writes", async () => {
    const orderId = randomUUID();
    await pool.query(`INSERT INTO orders (id,order_number,customer_name,email,phone,address,city,payment_method,status,subtotal_vnd,shipping_fee_vnd,total_vnd) VALUES ($1,'QA-AR','Test customer','qa@example.invalid','0900000000','Test address','Hồ Chí Minh','bank_transfer','pending',100000,0,100000)`, [orderId]);
    const receipt = { orderId, amountVnd: 40000, method: "bank_transfer", reference: "BANK-TEST", note: "Recorded offline", requestKey: `order-full:${orderId}` };
    assert.equal((await sales.request("/api/admin/finance/customer-payments", "POST", receipt)).status, 403);
    const first = await accountant.ok("/api/admin/finance/customer-payments", "POST", receipt, 201);
    assert.equal((await accountant.ok("/api/admin/finance/customer-payments", "POST", receipt)).id, first.id);
    assert.equal((await accountant.request("/api/admin/finance/customer-payments", "POST", { ...receipt, amountVnd: 80000, requestKey: randomUUID() })).status, 409);
    assert.equal((await owner.request(`/api/admin/orders/${orderId}`, "PATCH", { status: "cancelled" })).status, 409);
    assert.equal((await owner.request(`/api/admin/orders/${orderId}`, "PATCH", { shippingFeeVnd: 10000 })).status, 409);
    const rows = (await accountant.ok("/api/admin/finance/receivables?q=QA-AR")).receivables;
    assert.equal(rows[0].outstandingVnd, 60000);
    await owner.ok(`/api/admin/orders/${orderId}`, "PATCH", { paymentStatus: "paid" });
    assert.equal((await pool.query("SELECT payment_status FROM orders WHERE id=$1", [orderId])).rows[0].payment_status, "paid");
  });
  await context.test("supplier settlements and expenses require approval and cannot overpay or mutate posted records", async () => {
    const payment = await accountant.ok("/api/admin/finance/supplier-payments", "POST", { supplierId, amountVnd: 200000, method: "bank_transfer", reference: "BANK-AP", note: "Paid offline", requestKey: randomUUID() }, 201);
    assert.equal((await accountant.request(`/api/admin/finance/supplier-payments/${payment.id}/approve`, "POST", {})).status, 403);
    await manager.ok(`/api/admin/finance/supplier-payments/${payment.id}/approve`, "POST", {});
    await manager.ok(`/api/admin/finance/supplier-payments/${payment.id}/approve`, "POST", {});
    assert.equal((await accountant.ok("/api/admin/finance/payables")).payables[0].outstandingVnd, 300000);
    assert.equal((await accountant.request("/api/admin/finance/supplier-payments", "POST", { supplierId, amountVnd: 400000, method: "cash", requestKey: randomUUID() })).status, 409);
    await assert.rejects(pool.query("UPDATE supplier_payments SET amount_vnd=1 WHERE id=$1", [payment.id]), /immutable/);
    const expense = await accountant.ok("/api/admin/finance/expenses", "POST", { category: "operations", payee: "Test courier", amountVnd: 10000, method: "cash", reference: "QA-EXP", note: "Fixture", requestKey: randomUUID() }, 201);
    await owner.ok(`/api/admin/finance/expenses/${expense.id}/approve`, "POST", {});
    const report = await owner.ok("/api/admin/reports/overview");
    assert.equal(report.summary.purchaseReceivedVnd, 500000);
    assert.equal(report.summary.supplierPaidVnd, 200000);
    assert.equal(report.summary.expensesVnd, 10000);
  });
  await context.test("customer address book isolates owners and keeps one default", async () => {
    const first=client(), second=client();
    for(const [api,email] of [[first,'first@example.test'],[second,'second@example.test']]) {
      await api.ok('/api/csrf');
      await api.ok('/api/customer-auth/register','POST',{fullName:'Customer Test',email,phone:'0900000000',password:'Customer-test-password-2026'});
      await api.ok('/api/csrf');
    }
    const payload={label:'Home',fullName:'Customer Test',phone:'0900000000',address:'123 Test Street',city:'Hồ Chí Minh'};
    const a=(await first.ok('/api/customer/addresses','POST',payload,201)).address;
    assert.equal(a.isDefault,true);
    const b=(await first.ok('/api/customer/addresses','POST',{...payload,label:'Office',isDefault:true},201)).address;
    assert.equal((await first.ok('/api/customer/addresses')).addresses.filter(a=>a.isDefault).length,1);
    assert.equal((await second.ok('/api/customer/addresses')).addresses.length,0);
    assert.equal((await second.request('/api/customer/addresses/'+a.id,'DELETE')).status,404);
    assert.equal((await second.request('/api/customer/addresses/'+a.id+'/default','POST')).status,404);
    await first.ok('/api/customer/addresses/'+b.id,'DELETE',undefined,204);
    assert.equal((await first.ok('/api/customer/addresses')).addresses[0].isDefault,true);
    const customerId=(await pool.query('SELECT id FROM customers WHERE email=$1',['first@example.test'])).rows[0].id;
    await first.ok('/api/orders','POST',{customer:{name:'Customer Test',email:'first@example.test',phone:'0900000000',address:'123 Test Street',city:'Hồ Chí Minh'},paymentMethod:'cod',items:[{variantId,quantity:1}]},201);
    assert.equal((await first.ok('/api/customer/orders')).orders.length,1);
    assert.equal((await second.ok('/api/customer/orders')).orders.length,0);
    await pool.query('UPDATE customers SET active=false WHERE id=$1',[customerId]);
    assert.equal((await first.request('/api/customer/addresses')).status,401);
  });
  await context.test("role changes revoke live sessions; migrations and immutable audit preserve operational data", async () => {
    const staff = (await owner.ok("/api/admin/staff?q=test-warehouse")).staff[0];
    await owner.ok(`/api/admin/staff/${staff.id}`, "PATCH", { version: staff.version, role: "viewer" });
    assert.equal((await warehouse.request("/api/admin/inventory")).status, 401);
    await warehouse.login("test-warehouse", password);
    assert.equal((await warehouse.request("/api/admin/warehouses", "POST", { code: "DENIED", name: "Denied" })).status, 403);
    const events = await owner.ok("/api/admin/audit-logs");
    assert.ok(events.events.length > 0);
    assert.ok(!JSON.stringify(events).includes(password));
    for (const sql of ["UPDATE audit_events SET action='tamper'", "DELETE FROM audit_events", "TRUNCATE audit_events"]) await assert.rejects(pool.query(sql), /append-only/);
    await migrateDatabase(pool);
    assert.equal((await pool.query("SELECT COUNT(*)::int total FROM schema_migrations")).rows[0].total, 5);
    const balances = await pool.query("SELECT v.stock_quantity,COALESCE(SUM(s.quantity),0)::int total FROM product_variants v LEFT JOIN warehouse_stock s ON s.variant_id=v.id GROUP BY v.id");
    assert.ok(balances.rows.every((row) => row.stock_quantity === row.total));
  });
});
