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
  let marketplaceCustomerClient;
  let variantId, productId, secondWarehouse, mainWarehouse, supplierId, purchaseId, staffWarehouse, departmentId;
  const password = "Employee-test-password-2026";
  const productPayload = { slug: "enterprise-test", name: "Enterprise test product", category: "audio", descriptor: "Test fixture", description: "", imageUrl: "/assets/products/k9.png", imageAlt: "Test", active: false, sortOrder: 0 };

  await context.test("owner sets up employees, departments, warehouse, supplier and opening stock", async () => {
    departmentId = (await owner.ok("/api/gaeru_ceo/departments", "POST", { code: "OPS", name: "Operations", active: true }, 201)).department?.id;
    if (!departmentId) departmentId = (await owner.ok("/api/gaeru_ceo/departments")).departments[0].id;
    for (const role of ["warehouse", "accountant", "manager", "sales"]) {
      const created = await owner.ok("/api/gaeru_ceo/staff", "POST", { username: `test-${role}`, fullName: `Test ${role}`, password, role, departmentId }, 201);
      if (role === "warehouse") staffWarehouse = created.staff || created;
    }
    await warehouse.login("test-warehouse", password);
    await accountant.login("test-accountant", password);
    await manager.login("test-manager", password);
    await sales.login("test-sales", password);
    assert.equal((await warehouse.request("/api/gaeru_ceo/staff")).status, 403);
    mainWarehouse = (await owner.ok("/api/gaeru_ceo/warehouses")).warehouses.find((row) => row.code === "MAIN").id;
    const createdWarehouse = await owner.ok("/api/gaeru_ceo/warehouses", "POST", { code: "HCM", name: "Test second warehouse", address: "Test address", active: true }, 201);
    secondWarehouse = createdWarehouse.warehouse?.id || createdWarehouse.id;
    const supplier = await owner.ok("/api/gaeru_ceo/suppliers", "POST", { code: "TEST-SUPPLIER", name: "Test supplier", email: "supplier@example.invalid", phone: "0900000000", address: "Test", active: true }, 201);
    supplierId = supplier.supplier?.id || supplier.id;
    productId = (await owner.ok("/api/gaeru_ceo/products", "POST", productPayload, 201)).id;
    variantId = (await owner.ok(`/api/gaeru_ceo/products/${productId}/variants`, "POST", { sku: "ENTERPRISE-TEST", name: "Test variant", options: {}, priceVnd: 150000, stockQuantity: 20, active: true }, 201)).id;
    await owner.ok(`/api/gaeru_ceo/products/${productId}`, "PUT", { ...productPayload, active: true });
    await owner.ok("/api/gaeru_ceo/settings", "PUT", { shippingNote: "Test shipping", shippingRates: { "Hồ Chí Minh": 30000 } });
    assert.equal((await pool.query("SELECT SUM(quantity)::int total FROM warehouse_stock WHERE variant_id=$1", [variantId])).rows[0].total, 20);
  });
  await context.test("approved purchase supports partial receipts and exact retry without duplicate stock", async () => {
    const created = await warehouse.ok("/api/gaeru_ceo/purchase-orders", "POST", { supplierId, warehouseId: secondWarehouse, reference: "TEST-PO", note: "Fixture", items: [{ variantId, quantity: 5, unitCostVnd: 100000 }] }, 201);
    purchaseId = created.purchaseOrder?.id || created.id;
    await warehouse.ok(`/api/gaeru_ceo/purchase-orders/${purchaseId}/submit`, "POST", {});
    assert.equal((await warehouse.request(`/api/gaeru_ceo/purchase-orders/${purchaseId}/approve`, "POST", {})).status, 403);
    await manager.ok(`/api/gaeru_ceo/purchase-orders/${purchaseId}/approve`, "POST", {});
    const purchase = (await owner.ok(`/api/gaeru_ceo/purchase-orders/${purchaseId}`)).purchaseOrder;
    const itemId = purchase.items[0].id;
    const receipt = { requestKey: randomUUID(), reference: "TEST-RECEIPT", note: "Partial", items: [{ itemId, quantity: 3 }] };
    const first = await warehouse.ok(`/api/gaeru_ceo/purchase-orders/${purchaseId}/receipts`, "POST", receipt, 201);
    const repeated = await warehouse.request(`/api/gaeru_ceo/purchase-orders/${purchaseId}/receipts`, "POST", receipt);
    assert.ok([200, 201].includes(repeated.status));
    assert.ok(first.id || first.receipt?.id || first.receiptId);
    assert.equal((await pool.query("SELECT stock_quantity FROM product_variants WHERE id=$1", [variantId])).rows[0].stock_quantity, 23);
    assert.equal((await warehouse.request(`/api/gaeru_ceo/purchase-orders/${purchaseId}/receipts`, "POST", { ...receipt, requestKey: randomUUID(), items: [{ itemId, quantity: 3 }] })).status, 409);
    await warehouse.ok(`/api/gaeru_ceo/purchase-orders/${purchaseId}/receipts`, "POST", { ...receipt, requestKey: randomUUID(), items: [{ itemId, quantity: 2 }] }, 201);
    assert.equal((await owner.ok(`/api/gaeru_ceo/purchase-orders/${purchaseId}`)).purchaseOrder.status, "received");
    assert.equal((await pool.query("SELECT stock_quantity FROM product_variants WHERE id=$1", [variantId])).rows[0].stock_quantity, 25);
  });
  await context.test("warehouse transfers preserve aggregate; approved adjustments reject stale counts and retries", async () => {
    const transfer = { fromWarehouseId: mainWarehouse, toWarehouseId: secondWarehouse, variantId, quantity: 4, reason: "Test stock relocation", requestKey: randomUUID() };
    await warehouse.ok("/api/gaeru_ceo/inventory/transfers", "POST", transfer, 201);
    const adjustment = { warehouseId: mainWarehouse, variantId, delta: -2, expectedQuantity: 16, reason: "Test inventory count", requestKey: randomUUID() };
    assert.equal((await warehouse.request("/api/gaeru_ceo/inventory/adjustments", "POST", adjustment)).status, 403);
    await owner.ok("/api/gaeru_ceo/inventory/adjustments", "POST", adjustment, 201);
    const repeated = await owner.request("/api/gaeru_ceo/inventory/adjustments", "POST", adjustment);
    assert.ok([200, 201].includes(repeated.status));
    assert.equal((await owner.request("/api/gaeru_ceo/inventory/adjustments", "POST", { ...adjustment, requestKey: randomUUID() })).status, 409);
    assert.equal((await pool.query("SELECT stock_quantity FROM product_variants WHERE id=$1", [variantId])).rows[0].stock_quantity, 23);
  });
  await context.test("checkout reserves assigned warehouses and cancellation restores exactly once", async () => {
    const guest = client();
    await guest.ok("/api/csrf");
    const placed = await guest.ok("/api/orders", "POST", { customer: { name: "Test customer", email: "customer@example.invalid", phone: "0900000000", address: "Test address", city: "Hồ Chí Minh", note: "Fixture" }, paymentMethod: "cod", items: [{ variantId, quantity: 20 }] }, 201);
    const orderId = placed.order.id;
    assert.equal((await pool.query("SELECT SUM(quantity)::int total FROM order_stock_allocations WHERE order_id=$1", [orderId])).rows[0].total, 20);
    assert.equal((await pool.query("SELECT stock_quantity FROM product_variants WHERE id=$1", [variantId])).rows[0].stock_quantity, 3);
    await owner.ok(`/api/gaeru_ceo/orders/${orderId}`, "PATCH", { status: "cancelled" });
    await owner.ok(`/api/gaeru_ceo/orders/${orderId}`, "PATCH", { status: "cancelled" });
    assert.equal((await pool.query("SELECT stock_quantity FROM product_variants WHERE id=$1", [variantId])).rows[0].stock_quantity, 23);
    assert.equal((await owner.request(`/api/gaeru_ceo/variants/${variantId}`, "DELETE")).status, 409);
  });
  await context.test("partial collections protect the order balance and reject overcollection and unauthorized writes", async () => {
    const orderId = randomUUID();
    await pool.query(`INSERT INTO orders (id,order_number,customer_name,email,phone,address,city,payment_method,status,subtotal_vnd,shipping_fee_vnd,total_vnd) VALUES ($1,'QA-AR','Test customer','qa@example.invalid','0900000000','Test address','Hồ Chí Minh','bank_transfer','pending',100000,0,100000)`, [orderId]);
    const receipt = { orderId, amountVnd: 40000, method: "bank_transfer", reference: "BANK-TEST", note: "Recorded offline", requestKey: `order-full:${orderId}` };
    assert.equal((await sales.request("/api/gaeru_ceo/finance/customer-payments", "POST", receipt)).status, 403);
    const first = await accountant.ok("/api/gaeru_ceo/finance/customer-payments", "POST", receipt, 201);
    assert.equal((await accountant.ok("/api/gaeru_ceo/finance/customer-payments", "POST", receipt)).id, first.id);
    assert.equal((await accountant.request("/api/gaeru_ceo/finance/customer-payments", "POST", { ...receipt, amountVnd: 80000, requestKey: randomUUID() })).status, 409);
    assert.equal((await owner.request(`/api/gaeru_ceo/orders/${orderId}`, "PATCH", { status: "cancelled" })).status, 409);
    assert.equal((await owner.request(`/api/gaeru_ceo/orders/${orderId}`, "PATCH", { shippingFeeVnd: 10000 })).status, 409);
    const rows = (await accountant.ok("/api/gaeru_ceo/finance/receivables?q=QA-AR")).receivables;
    assert.equal(rows[0].outstandingVnd, 60000);
    await owner.ok(`/api/gaeru_ceo/orders/${orderId}`, "PATCH", { paymentStatus: "paid" });
    assert.equal((await pool.query("SELECT payment_status FROM orders WHERE id=$1", [orderId])).rows[0].payment_status, "paid");
  });
  await context.test("supplier settlements and expenses require approval and cannot overpay or mutate posted records", async () => {
    const payment = await accountant.ok("/api/gaeru_ceo/finance/supplier-payments", "POST", { supplierId, amountVnd: 200000, method: "bank_transfer", reference: "BANK-AP", note: "Paid offline", requestKey: randomUUID() }, 201);
    assert.equal((await accountant.request(`/api/gaeru_ceo/finance/supplier-payments/${payment.id}/approve`, "POST", {})).status, 403);
    await manager.ok(`/api/gaeru_ceo/finance/supplier-payments/${payment.id}/approve`, "POST", {});
    await manager.ok(`/api/gaeru_ceo/finance/supplier-payments/${payment.id}/approve`, "POST", {});
    assert.equal((await accountant.ok("/api/gaeru_ceo/finance/payables")).payables[0].outstandingVnd, 300000);
    assert.equal((await accountant.request("/api/gaeru_ceo/finance/supplier-payments", "POST", { supplierId, amountVnd: 400000, method: "cash", requestKey: randomUUID() })).status, 409);
    await assert.rejects(pool.query("UPDATE supplier_payments SET amount_vnd=1 WHERE id=$1", [payment.id]), /immutable/);
    const expense = await accountant.ok("/api/gaeru_ceo/finance/expenses", "POST", { category: "operations", payee: "Test courier", amountVnd: 10000, method: "cash", reference: "QA-EXP", note: "Fixture", requestKey: randomUUID() }, 201);
    await owner.ok(`/api/gaeru_ceo/finance/expenses/${expense.id}/approve`, "POST", {});
    const report = await owner.ok("/api/gaeru_ceo/reports/overview");
    assert.equal(report.summary.purchaseReceivedVnd, 500000);
    assert.equal(report.summary.supplierPaidVnd, 200000);
    assert.equal(report.summary.expensesVnd, 10000);
  });
  await context.test("customer login accepts email and Vietnamese phone formats without ambiguous account selection", async () => {
    const api=client(), password='Customer-phone-password-2026';
    const hash=await bcrypt.hash(password,4);
    await pool.query('INSERT INTO customers(full_name,email,phone,password_hash) VALUES($1,$2,$3,$4)', ['Phone Customer','phone-login@example.test','+84987654321',hash]);
    await api.ok('/api/csrf');
    for(const identifier of [' PHONE-LOGIN@example.test ','0987 654 321','+84 987 654 321']) {
      const login=await api.ok('/api/customer-auth/login','POST',{identifier,password});
      assert.equal(login.customer.email,'phone-login@example.test');
      assert.equal((await api.ok('/api/customer-auth/me')).customer.id,login.customer.id);
    }
    assert.equal((await api.request('/api/customer-auth/login','POST',{identifier:'0987654321',password:'wrong'})).status,401);
    assert.equal((await api.request('/api/customer-auth/login','POST',{identifier:'not-an-account',password})).status,400);
    await pool.query('INSERT INTO customers(full_name,email,phone,password_hash) VALUES($1,$2,$3,$4)', ['Other Customer','shared-phone@example.test','0987654321',hash]);
    assert.equal((await api.request('/api/customer-auth/login','POST',{identifier:'0987654321',password})).status,401);
    await api.ok('/api/customer-auth/login','POST',{email:'phone-login@example.test',password});
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
    assert.equal((await second.request('/api/customer/addresses/'+a.id,'PUT',{...payload,label:'Stolen'})).status,404);
    const updated=(await first.ok('/api/customer/addresses/'+a.id,'PUT',{...payload,address:'456 Updated Street',isDefault:true})).address;
    assert.equal(updated.address,'456 Updated Street');
    assert.equal((await first.ok('/api/customer/addresses')).addresses.filter(a=>a.isDefault).length,1);
    const profile=await first.ok('/api/customer/profile','PATCH',{fullName:'Updated Customer',phone:'0900000000'});
    assert.equal(profile.customer.fullName,'Updated Customer');
    assert.equal((await first.ok('/api/customer-auth/me')).customer.phone,'0900000000');
    assert.equal((await first.request('/api/customer/profile','PATCH',{fullName:'Updated Customer',phone:'0911111111',email:'other@example.test'})).status,409);
    await first.ok('/api/customer/addresses/'+b.id,'DELETE',undefined,204);
    assert.equal((await first.ok('/api/customer/addresses')).addresses[0].isDefault,true);
    const customerId=(await pool.query('SELECT id FROM customers WHERE email=$1',['first@example.test'])).rows[0].id;
    await first.ok('/api/orders','POST',{customer:{name:'Customer Test',email:'first@example.test',phone:'0900000000',address:'123 Test Street',city:'Hồ Chí Minh'},paymentMethod:'cod',items:[{variantId,quantity:1}]},201);
    assert.equal((await first.ok('/api/customer/orders')).orders.length,1);
    const ownOrder=(await first.ok('/api/customer/orders')).orders[0];
    assert.equal((await first.ok('/api/customer/orders/'+ownOrder.id)).order.items.length,1);
    assert.equal((await second.request('/api/customer/orders/'+ownOrder.id)).status,404);
    const itemId=(await first.ok('/api/customer/orders/'+ownOrder.id)).order.items[0].id;
    const warrantyBody={orderItemId:itemId,requestKey:randomUUID(),serial:'QA-ABC-001'};
    assert.equal((await second.request('/api/customer/warranties','POST',warrantyBody)).status,404);
    const activation=(await first.ok('/api/customer/warranties')).activations.find(w=>w.orderItemId===itemId);assert.ok(activation);assert.equal(activation.automatic,true);assert.equal(activation.status,'pending');
    const searched=await owner.ok('/api/gaeru_ceo/warranties?q='+encodeURIComponent(activation.id));assert.equal(searched.activations.length,1);
    assert.equal((await first.request('/api/customer/warranties','POST',warrantyBody)).status,409);
    assert.equal((await second.ok('/api/customer/warranties')).activations.length,0);
    const purchaseDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const approval={status:'active',purchaseDate,reason:'Đã đối chiếu đơn hàng và serial.',version:1};
    assert.equal((await sales.request('/api/gaeru_ceo/warranties/'+activation.id,'PATCH',approval)).status,403);
    assert.equal((await owner.request('/api/gaeru_ceo/warranties/'+activation.id,'PATCH',approval)).status,409);
    await pool.query("UPDATE orders SET status='completed',payment_status='paid' WHERE id=$1",[ownOrder.id]);
    const approved=(await first.ok('/api/customer/warranties')).activations.find(w=>w.id===activation.id);assert.equal(approved.status,'active');assert.equal(approved.purchaseDate,purchaseDate);
    await pool.query("UPDATE orders SET status='completed',payment_status='paid' WHERE id=$1",[ownOrder.id]);
    assert.equal((await first.ok('/api/customer/warranties')).activations.filter(w=>w.orderItemId===itemId).length,1);
    assert.equal((await owner.request('/api/gaeru_ceo/warranties/'+activation.id,'PATCH',approval)).status,409);
    await owner.ok('/api/gaeru_ceo/warranties/'+activation.id,'PATCH',{status:'revoked',reason:'Thu hồi theo kết quả đối chiếu.',version:approved.version});
    assert.equal((await first.request('/api/customer/warranties','POST',{...warrantyBody,requestKey:randomUUID()})).status,409);
    assert.equal((await second.ok('/api/customer/orders')).orders.length,0);
    const careBody={orderId:ownOrder.id,requestKey:randomUUID(),subject:'Micro cần kiểm tra',description:'Micro không kết nối với điện thoại khi sử dụng.'};
    assert.equal((await second.request('/api/customer/care','POST',careBody)).status,404);
    const care=(await first.ok('/api/customer/care','POST',careBody,201)).request;
    assert.equal((await first.ok('/api/customer/care','POST',careBody)).request.id,care.id);
    assert.equal((await first.request('/api/customer/care','POST',{...careBody,subject:'Thay nội dung'})).status,409);
    assert.equal((await second.ok('/api/customer/care')).requests.length,0);
    assert.equal((await first.ok('/api/customer/care')).requests[0].id,care.id);
    const adminCare=(await owner.ok('/api/gaeru_ceo/care-requests')).requests.find(r=>r.id===care.id);
    assert.ok(adminCare);
    assert.equal((await second.request('/api/gaeru_ceo/care-requests/'+care.id,'PATCH',{status:'resolved',response:'Unauthorized response',version:1})).status,401);
    assert.equal((await accountant.request('/api/gaeru_ceo/care-requests/'+care.id,'PATCH',{status:'resolved',response:'Unauthorized response',version:1})).status,403);
    await owner.ok('/api/gaeru_ceo/care-requests/'+care.id,'PATCH',{status:'reviewing',response:'GAERU đang kiểm tra thông tin đơn hàng.',version:1});
    assert.equal((await owner.request('/api/gaeru_ceo/care-requests/'+care.id,'PATCH',{status:'resolved',response:'Stale response',version:1})).status,409);
    assert.equal((await first.ok('/api/customer/care')).requests[0].status,'reviewing');
    assert.equal((await second.request('/api/customer/care/'+care.id+'/messages')).status,404);
    assert.equal((await second.request('/api/customer/care/'+care.id+'/messages','POST',{body:'Unauthorized',version:2})).status,404);
    assert.equal((await first.ok('/api/customer/care/'+care.id+'/messages')).messages[0].sender,'staff');
    await first.ok('/api/customer/care/'+care.id+'/messages','POST',{body:'Tôi đã thử kết nối lại, vẫn chưa được.',version:2},201);
    assert.equal((await first.request('/api/customer/care/'+care.id+'/messages','POST',{body:'Duplicate stale reply',version:2})).status,409);
    assert.equal((await first.request('/api/customer/care/'+care.id+'/messages?before=9999999999999999999')).status,400);
    const thread=(await owner.ok('/api/gaeru_ceo/care-requests/'+care.id+'/messages')).messages;
    assert.equal(thread.length,2);assert.equal(thread[1].sender,'customer');
    const fresh=await first.ok('/api/customer/care/'+care.id+'/messages?after='+thread[0].id);
    assert.equal(fresh.messages.length,1);assert.equal(fresh.messages[0].id,thread[1].id);assert.equal(fresh.thread.version,3);assert.equal(fresh.thread.canReply,true);
    assert.equal((await first.ok('/api/customer/care/'+care.id+'/messages?after='+thread[1].id)).messages.length,0);
    assert.equal((await second.request('/api/customer/care/'+care.id+'/messages?after='+thread[0].id)).status,404);
    assert.equal((await first.request('/api/customer/care/'+care.id+'/messages?after='+thread[0].id+'&before='+thread[1].id)).status,400);
    assert.equal((await first.request('/api/customer/care/'+care.id+'/messages?after=9999999999999999999')).status,400);
    assert.match(thread[1].body,/kết nối/);
    await pool.query("INSERT INTO care_messages(care_id,sender,body) SELECT $1,'staff','Paging message '||i FROM generate_series(1,55) i",[care.id]);
    const batch=await owner.ok('/api/gaeru_ceo/care-requests/'+care.id+'/messages?after='+thread[1].id);
    assert.equal(batch.messages.length,50);assert.equal(batch.hasMore,true);assert.ok(BigInt(batch.messages[0].id)<BigInt(batch.messages[49].id));
    const rest=await owner.ok('/api/gaeru_ceo/care-requests/'+care.id+'/messages?after='+batch.messages.at(-1).id);assert.equal(rest.messages.length,5);assert.equal(rest.hasMore,false);
    assert.equal((await first.request('/api/customer/care/'+care.id+'/messages?before=garbage')).status,400);
    await owner.ok('/api/gaeru_ceo/care-requests/'+care.id,'PATCH',{status:'closed',response:'Đã kết thúc yêu cầu theo phản hồi của khách.',version:3});
    assert.equal((await first.request('/api/customer/care/'+care.id+'/messages','POST',{body:'Cannot reply closed',version:4})).status,409);
    assert.equal((await owner.request('/api/gaeru_ceo/care-requests/'+care.id,'PATCH',{status:'reviewing',response:'Cannot reopen',version:3})).status,409);
    await pool.query('UPDATE customers SET active=false WHERE id=$1',[customerId]);
    assert.equal((await first.request('/api/customer/addresses')).status,401);
  });
  await context.test('AI news routes enforce permissions and report missing server key',async()=>{
    assert.equal((await owner.ok('/api/gaeru_ceo/news/ai/status')).configured,false);
    assert.equal((await accountant.request('/api/gaeru_ceo/news/ai/status')).status,403);
    assert.equal((await client().request('/api/gaeru_ceo/news/ai/status')).status,401);
    const result=await owner.request('/api/gaeru_ceo/news/ai/draft','POST',{topic:'Micro GAERU',facts:'Dữ kiện kiểm chứng về sản phẩm micro GAERU.',tone:'professional',length:'short'});
    assert.equal(result.status,503);assert.match(result.data.error,/OPENAI_API_KEY/);
  });

  await context.test("role changes revoke live sessions; migrations and immutable audit preserve operational data", async () => {
    const staff = (await owner.ok("/api/gaeru_ceo/staff?q=test-warehouse")).staff[0];
    await owner.ok(`/api/gaeru_ceo/staff/${staff.id}`, "PATCH", { version: staff.version, role: "viewer" });
    assert.equal((await warehouse.request("/api/gaeru_ceo/inventory")).status, 401);
    await warehouse.login("test-warehouse", password);
    assert.equal((await warehouse.request("/api/gaeru_ceo/warehouses", "POST", { code: "DENIED", name: "Denied" })).status, 403);
    const events = await owner.ok("/api/gaeru_ceo/audit-logs");
    assert.ok(events.events.length > 0);
    assert.ok(!JSON.stringify(events).includes(password));
    for (const sql of ["UPDATE audit_events SET action='tamper'", "DELETE FROM audit_events", "TRUNCATE audit_events"]) await assert.rejects(pool.query(sql), /append-only/);
    await migrateDatabase(pool);
    assert.equal((await pool.query("SELECT COUNT(*)::int total FROM schema_migrations")).rows[0].total, 30);
    const balances = await pool.query("SELECT v.stock_quantity,COALESCE(SUM(s.quantity),0)::int total FROM product_variants v LEFT JOIN warehouse_stock s ON s.variant_id=v.id GROUP BY v.id");
    assert.ok(balances.rows.every((row) => row.stock_quantity === row.total));
  });
  await context.test('business finance protects payroll, approves tax facts, keeps invoices unissued and reports incomplete marketplace costs',async()=>{
    const period='2026-10';
    const payroll={period,requestKey:randomUUID(),employeeCode:'PAY-01',fullName:'Payroll Fixture',mode:'mixed',baseSalaryVnd:26000000,plannedDays:26,workedDays:26,hourlyRateVnd:100000,workedMinutes:60,allowanceVnd:0,bonusVnd:0,commissionVnd:0,insuranceVnd:1000000,pitWithheldVnd:1000000,advanceVnd:0,deductionVnd:0,employerContributionVnd:0};
    const salary=(await accountant.ok('/api/gaeru_ceo/business/payroll','POST',payroll,201)).id;
    assert.equal((await accountant.ok('/api/gaeru_ceo/business/payroll','POST',payroll)).id,salary);
    assert.equal((await accountant.request('/api/gaeru_ceo/business/payroll','POST',{...payroll,bonusVnd:1})).status,409);
    assert.equal((await manager.request('/api/gaeru_ceo/business/payroll?period='+period)).status,403);
    assert.equal((await sales.request('/api/gaeru_ceo/business/payroll?period='+period)).status,403);
    assert.equal((await accountant.request('/api/gaeru_ceo/business/payroll/'+salary+'/approve','POST',{version:1})).status,403);
    await owner.ok('/api/gaeru_ceo/business/payroll/'+salary+'/approve','POST',{version:1});
    assert.equal((await owner.request('/api/gaeru_ceo/business/payroll/'+salary+'/paid','POST',{version:2})).status,409);
    await owner.ok('/api/gaeru_ceo/business/payroll/'+salary+'/paid','POST',{version:2,paymentReference:'PAYMENT-FIXTURE-01'});
    const paid=(await accountant.ok('/api/gaeru_ceo/business/payroll?period='+period)).documents[0];assert.equal(paid.calculation.netVnd,24100000);assert.equal(paid.status,'paid');
    assert.equal((await owner.request('/api/gaeru_ceo/business/payroll/'+salary+'/void','POST',{version:3,reason:'Cannot cancel paid'})).status,409);
    await assert.rejects(pool.query("UPDATE business_documents SET payload='{}'::jsonb WHERE id=$1",[salary]),/immutable/);
    for(const direction of ['input','output']){const id=(await accountant.ok('/api/gaeru_ceo/business/tax','POST',{period,requestKey:randomUUID(),documentDate:'2026-10-01',direction,reference:'VAT-'+direction,counterparty:'Tax Fixture',netVnd:100000,vatVnd:10000,deductibleVatVnd:direction==='input'?5000:0},201)).id;await owner.ok('/api/gaeru_ceo/business/tax/'+id+'/approve','POST',{version:1});}
    assert.equal((await accountant.ok('/api/gaeru_ceo/business/tax-summary?period='+period)).differenceVnd,5000);
    const completed=(await pool.query("SELECT id FROM orders WHERE status='completed' AND payment_status='paid' LIMIT 1")).rows[0].id;
    const invoice=(await accountant.ok('/api/gaeru_ceo/business/invoice','POST',{period,requestKey:randomUUID(),orderId:completed,buyerName:'Buyer Fixture',buyerTaxCode:'TEST-TAX',buyerAddress:'123 Fixture Address',buyerEmail:'buyer@example.test'},201)).id;
    await owner.ok('/api/gaeru_ceo/business/invoice/'+invoice+'/approve','POST',{version:1});
    assert.equal((await owner.request('/api/gaeru_ceo/business/invoice/'+invoice+'/issue','POST',{})).status,503);
    assert.equal((await accountant.ok('/api/gaeru_ceo/business/invoice?period='+period)).documents[0].calculation.issued,false);
    const orderCount=(await pool.query('SELECT count(*) AS total FROM orders')).rows[0].total;
    for(const channel of ['shopee','tiktok','lazada']){const id=(await accountant.ok('/api/gaeru_ceo/business/marketplace','POST',{period,requestKey:randomUUID(),channel,shopId:'SHOP-1',externalOrderId:'ORDER-1',orderDate:'2026-10-01',status:'completed',reconciled:true,netRevenueVnd:1000000,refundVnd:0,platformFeesVnd:100000,cogsVnd:channel==='tiktok'?null:400000,adsVnd:0,fulfillmentVnd:0,otherCostsVnd:0},201)).id;await manager.ok('/api/gaeru_ceo/business/marketplace/'+id+'/approve','POST',{version:1});}
    const summary=await accountant.ok('/api/gaeru_ceo/business/marketplace-summary?period='+period);assert.equal(summary.channels.find(c=>c.channel==='shopee').profitVnd,500000);assert.equal(summary.channels.find(c=>c.channel==='tiktok').profitVnd,null);
    assert.equal((await pool.query('SELECT count(*) AS total FROM orders')).rows[0].total,orderCount);
    assert.equal((await accountant.ok('/api/gaeru_ceo/business/integrations')).automaticSyncEnabled,false);
  });
  await context.test('marketplace product links snapshot receipt costs and preserve unknown or historical costs',async()=>{
    assert.equal((await sales.request('/api/gaeru_ceo/business/catalog?q=ENTERPRISE')).status,403);
    assert.equal((await accountant.ok('/api/gaeru_ceo/business/catalog?q=ENTERPRISE')).products[0].id,variantId);
    const data={period:'2099-01',requestKey:randomUUID(),channel:'shopee',shopId:'STOCK',externalOrderId:'LINKED',orderDate:'2099-01-01',status:'completed',reconciled:true,netRevenueVnd:1000000,refundVnd:0,platformFeesVnd:100000,cogsVnd:null,adsVnd:0,fulfillmentVnd:0,otherCostsVnd:0,costMode:'warehouse',items:[{variantId,quantity:2}]};
    const stockBefore=(await pool.query('SELECT stock_quantity FROM product_variants WHERE id=$1',[variantId])).rows[0].stock_quantity;
    const id=(await accountant.ok('/api/gaeru_ceo/business/marketplace','POST',data,201)).id;
    const records=()=>accountant.ok('/api/gaeru_ceo/business/marketplace?period=2099-01');
    let record=(await records()).documents.find(r=>r.id===id);
    assert.equal(record.payload.cogsVnd,200000);assert.equal(record.calculation.profitVnd,700000);
    assert.equal(record.payload.costSnapshot.lines[0].unitCostVnd,100000);
    assert.ok(record.payload.costSnapshot.lines[0].receiptItemId);
    assert.equal((await accountant.request('/api/gaeru_ceo/business/marketplace','POST',{...data,requestKey:randomUUID(),cogsVnd:1})).status,400);
    assert.equal((await accountant.request('/api/gaeru_ceo/business/marketplace','POST',{...data,requestKey:randomUUID(),items:[...data.items,...data.items]})).status,400);
    assert.equal((await accountant.request('/api/gaeru_ceo/business/marketplace','POST',{...data,requestKey:randomUUID(),items:[{variantId:randomUUID(),quantity:1}]})).status,400);
    const missing=(await accountant.ok('/api/gaeru_ceo/business/marketplace','POST',{...data,requestKey:randomUUID(),externalOrderId:'HISTORICAL',orderDate:'2000-01-01'},201)).id;
    record=(await records()).documents.find(r=>r.id===missing);assert.equal(record.payload.cogsVnd,null);assert.equal(record.calculation.profitVnd,null);
    const returned=(await accountant.ok('/api/gaeru_ceo/business/marketplace','POST',{...data,requestKey:randomUUID(),externalOrderId:'RETURNED',status:'returned',netRevenueVnd:0,items:[{variantId,quantity:0}]},201)).id;
    assert.equal((await records()).documents.find(r=>r.id===returned).payload.cogsVnd,0);
    assert.equal((await pool.query('SELECT stock_quantity FROM product_variants WHERE id=$1',[variantId])).rows[0].stock_quantity,stockBefore);
    await manager.ok('/api/gaeru_ceo/business/marketplace/'+id+'/approve','POST',{version:1});
    const purchaseId=(await owner.ok('/api/gaeru_ceo/purchase-orders','POST',{supplierId,warehouseId:secondWarehouse,reference:'NEW-COST',note:'Fixture',items:[{variantId,quantity:1,unitCostVnd:200000}]},201)).purchaseOrder.id;
    await owner.ok(`/api/gaeru_ceo/purchase-orders/${purchaseId}/submit`,'POST',{});
    await owner.ok(`/api/gaeru_ceo/purchase-orders/${purchaseId}/approve`,'POST',{});
    const itemId=(await owner.ok(`/api/gaeru_ceo/purchase-orders/${purchaseId}`)).purchaseOrder.items[0].id;
    await owner.ok(`/api/gaeru_ceo/purchase-orders/${purchaseId}/receipts`,'POST',{requestKey:randomUUID(),reference:'NEW-COST',note:'Fixture',items:[{itemId,quantity:1}]},201);
    assert.equal((await accountant.ok('/api/gaeru_ceo/business/marketplace','POST',data)).id,id);
    assert.equal((await records()).documents.find(r=>r.id===id).payload.cogsVnd,200000);
    const newId=(await accountant.ok('/api/gaeru_ceo/business/marketplace','POST',{...data,requestKey:randomUUID(),externalOrderId:'LATEST'},201)).id;
    assert.equal((await records()).documents.find(r=>r.id===newId).payload.cogsVnd,400000);
    assert.equal((await accountant.ok('/api/gaeru_ceo/business/marketplace-summary?period=2099-01')).channels.find(c=>c.channel==='shopee').profitVnd,700000);
  });
  await context.test('marketplace and guest warranty requests remain private, idempotent and pending until staff review',async()=>{
    const guest=client(),otherGuest=client(),account=client();marketplaceCustomerClient=account;
    await guest.ok('/api/csrf');await otherGuest.ok('/api/csrf');await account.ok('/api/csrf');
    await account.ok('/api/customer-auth/login','POST',{email:'second@example.test',password:'Customer-test-password-2026'});
    await account.ok('/api/csrf');
    const contact={fullName:'Warranty Customer',phone:'0900000000',address:'123 Warranty Street',city:'Hồ Chí Minh'};
    const data={channel:'shopee',externalOrderNumber:'SHOPEE-TEST-001',productName:'GAERU K9 · Type-C',purchaseDate:'2026-01-01',serial:'EXTERNAL-SERIAL-01',contact,requestKey:randomUUID()};
    assert.equal((await guest.request('/api/warranty-requests','POST',{...data,purchaseDate:'2026-02-30'})).status,400);assert.equal((await guest.request('/api/warranty-requests','POST',{...data,purchaseDate:'2099-01-01'})).status,400);
    const ordersBefore=(await pool.query('SELECT count(*)::int total FROM orders')).rows[0].total;
    const saved=(await guest.ok('/api/warranty-requests','POST',data,201)).activation;
    assert.equal(saved.status,'pending');
    assert.equal((await guest.ok('/api/warranty-requests','POST',data)).activation.id,saved.id);
    assert.equal((await guest.request('/api/warranty-requests','POST',{...data,contact:{...contact,fullName:'Changed Customer'}})).status,409);
    assert.equal((await otherGuest.request('/api/warranty-requests','POST',data)).status,409);
    assert.equal((await guest.request('/api/warranty-requests','POST',{...data,requestKey:randomUUID(),contact:{...contact,address:''}})).status,400);
    assert.equal((await guest.request('/api/warranty-requests','POST',{...data,requestKey:randomUUID(),customerId:randomUUID()})).status,400);
    assert.equal((await client().request('/api/warranty-requests','POST',data)).status,403);
    assert.equal((await guest.request('/api/warranty-requests','POST',{...data,requestKey:randomUUID()})).status,409);
    const duplicate=await otherGuest.request('/api/warranty-requests','POST',{...data,externalOrderNumber:' shopee-test-001 ',serial:'',requestKey:randomUUID()});assert.equal(duplicate.status,409);
    const known=(await pool.query('SELECT order_number FROM orders LIMIT 1')).rows[0];assert.equal((await guest.request('/api/warranty-requests','POST',{...data,channel:'website',externalOrderNumber:known.order_number,serial:'',requestKey:randomUUID()})).status,409);
    const guestWebsite=(await guest.ok('/api/warranty-requests','POST',{...data,channel:'website',externalOrderNumber:'GUEST-WEB-ORDER',serial:'',requestKey:randomUUID()},201)).activation;
    assert.equal(guestWebsite.status,'pending');
    assert.equal((await guest.request('/api/customer/warranties')).status,401);
    for(const channel of ['tiktok','lazada']){
      const activation=(await account.ok('/api/warranty-requests','POST',{...data,channel,externalOrderNumber:channel+'-ORDER',serial:'',requestKey:randomUUID()},201)).activation;
      assert.ok((await account.ok('/api/customer/warranties')).activations.some(w=>w.id===activation.id&&w.channel===channel));
    }
    assert.ok(!(await account.ok('/api/customer/warranties')).activations.some(w=>w.id===saved.id));
    const row=(await owner.ok('/api/gaeru_ceo/warranties')).activations.find(w=>w.id===saved.id);
    assert.equal(row.contactName,contact.fullName);assert.equal(row.contactAddress,contact.address);assert.equal(row.orderNumber,data.externalOrderNumber);
    assert.equal(row.claimedPurchaseDate,'2026-01-01');assert.equal(row.purchaseDate,null);
    assert.equal(row.channel,'shopee');assert.equal(row.productName,data.productName);
    assert.equal((await sales.request('/api/gaeru_ceo/warranties/'+saved.id,'PATCH',{status:'active',purchaseDate:'2026-01-01',reason:'Proof checked',version:1})).status,403);
    await owner.ok('/api/gaeru_ceo/warranties/'+saved.id,'PATCH',{status:'active',purchaseDate:'2026-01-01',reason:'Đã đối chiếu chứng từ mua trên sàn.',version:1});
    const approved=(await owner.ok('/api/gaeru_ceo/warranties')).activations.find(w=>w.id===saved.id);
    assert.equal(approved.expiresOn,'2027-01-01');
    assert.equal((await otherGuest.request('/api/warranty-requests','POST',{...data,serial:'',requestKey:randomUUID()})).status,409);
    assert.equal((await pool.query('SELECT count(*)::int total FROM orders')).rows[0].total,ordersBefore);
  });
  await context.test('support accepts marketplace order numbers without exposing another customer requests',async()=>{
    const account=marketplaceCustomerClient;
    const base={requestKey:randomUUID(),subject:'Cần kiểm tra micro',description:'Micro không nhận tín hiệu khi kết nối điện thoại.'};
    const created=[];
    for(const channel of ['shopee','tiktok','lazada']){
      const body={...base,requestKey:randomUUID(),channel,externalOrderNumber:channel+'-SUPPORT-01'};
      const result=(await account.ok('/api/customer/care','POST',body,201)).request;created.push(result.id);
      assert.equal((await account.ok('/api/customer/care','POST',body)).request.id,result.id);
      assert.equal((await account.request('/api/customer/care','POST',{...body,externalOrderNumber:'CHANGED'})).status,409);
    }
    const rows=(await account.ok('/api/customer/care')).requests;assert.equal(rows.length,3);
    assert.ok(rows.every(r=>r.orderId===null&&r.orderNumber.endsWith('-SUPPORT-01')));
    assert.equal((await account.request('/api/customer/care','POST',{...base,channel:'shopee'})).status,400);
    assert.equal((await account.request('/api/customer/care','POST',{...base,channel:'shopee',externalOrderNumber:'MIXED',orderId:randomUUID()})).status,400);
    assert.equal((await client().request('/api/customer/care','POST',{...base,channel:'shopee',externalOrderNumber:'GUEST'})).status,401);
    assert.ok((await owner.ok('/api/gaeru_ceo/care-requests')).requests.some(r=>r.id===created[0]&&r.channel==='shopee'));
    await owner.ok('/api/gaeru_ceo/care-requests/'+created[0],'PATCH',{status:'reviewing',response:'Đang đối chiếu mã đơn và thông tin mua hàng trên sàn.',version:1});
    assert.equal((await account.ok('/api/customer/care')).requests.find(r=>r.id===created[0]).status,'reviewing');
  });
  await context.test('only the bootstrap owner can inspect highest-level controls or revoke employee sessions',async()=>{
    const adminClient=client();
    await owner.ok('/api/gaeru_ceo/staff','POST',{username:'test-admin',fullName:'Test Admin',password,role:'admin'},201);
    await adminClient.login('test-admin',password);
    assert.equal((await adminClient.request('/api/gaeru_ceo/owner')).status,403);
    assert.equal((await adminClient.request('/api/gaeru_ceo/owner/revoke-staff-sessions','POST',{confirmation:'REVOKE_STAFF_SESSIONS'})).status,403);
    const overview=await owner.ok('/api/gaeru_ceo/owner');
    assert.equal(overview.owner.username,'enterprise-owner');
    assert.equal(JSON.stringify(overview).includes(password),false);
    assert.equal((await owner.request('/api/gaeru_ceo/owner/revoke-staff-sessions','POST',{})).status,400);
    const result=await owner.ok('/api/gaeru_ceo/owner/revoke-staff-sessions','POST',{confirmation:'REVOKE_STAFF_SESSIONS'});
    assert.ok(result.count>0);
    assert.equal((await adminClient.request('/api/gaeru_ceo/summary')).status,401);
    assert.equal((await owner.ok('/api/gaeru_ceo/owner')).owner.role,'owner');
    assert.ok((await owner.ok('/api/gaeru_ceo/audit-logs')).events.some(e=>e.action==='owner.revoke_staff_sessions'));
  });
  await context.test('warranty pagination keeps every product of each order together',async()=>{await pool.query("INSERT INTO warranty_activations(channel,external_order_number,external_product_name,request_key) SELECT 'shopee','GROUP-PAGE-'||g::text,'Pagination Product '||n::text,gen_random_uuid() FROM generate_series(1,26) g CROSS JOIN generate_series(1,2) n");const first=await owner.ok('/api/gaeru_ceo/warranties?q=GROUP-PAGE-&page=1'),second=await owner.ok('/api/gaeru_ceo/warranties?q=GROUP-PAGE-&page=2');assert.equal(first.activations.length,50);assert.equal(new Set(first.activations.map(w=>w.orderKey)).size,25);assert.equal(first.pagination.hasNext,true);assert.equal(second.activations.length,2);assert.equal(second.pagination.hasNext,false);const before=new Set(first.activations.map(w=>w.orderKey));assert.ok(second.activations.every(w=>!before.has(w.orderKey)));});

});
