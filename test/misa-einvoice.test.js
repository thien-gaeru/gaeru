const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { PGlite } = require("@electric-sql/pglite");
const { migrateDatabase } = require("../src/migrate");
const { createApp } = require("../src/app");
const {
  buildInvoicePayload,
  probeConnection,
  issueInvoice,
  autoIssueForOrder,
  issueInvoiceForDocument
} = require("../src/misa-einvoice");
const { writeRecord } = require("../src/admin-configuration");

async function setupTestDb(t) {
  const pg = await PGlite.create();
  const pool = {
    async query(sql, v) {
      return !v && sql.includes(";") ? (await pg.exec(sql)).at(-1) : pg.query(sql, v);
    },
    async connect() {
      return { query: pool.query, release() {} };
    }
  };
  t.after(() => pg.close());
  await migrateDatabase(pool);
  return pool;
}

test("MISA eShop e-invoice payload builder maps items, shipping, payment method and customer info correctly", () => {
  const order = {
    id: "a0000000-0000-0000-0000-000000000001",
    order_number: "GR-TEST-001",
    customer_name: "Nguyễn Văn A",
    buyer_tax_code: "0101243150",
    address: "Số 10 Tràng Tiền",
    city: "Hà Nội",
    email: "nguyenvana@example.com",
    phone: "0912345678",
    payment_method: "bank_transfer",
    subtotal_vnd: 200000,
    shipping_fee_vnd: 30000,
    total_vnd: 230000
  };

  const items = [
    {
      product_name: "GAERU Tai nghe K9 Pro",
      variant_name: "Màu đen",
      sku: "K9-PRO-BLK",
      unit_price_vnd: 100000,
      quantity: 2,
      line_total_vnd: 200000
    }
  ];

  const misaConfig = {
    appId: "APP-MISA-123",
    storeId: "STORE-GAERU-01",
    taxCode: "0109998888",
    templateCode: "1/001",
    series: "C26TGA"
  };

  const payload = buildInvoicePayload(order, items, misaConfig);

  assert.equal(payload.RefID, order.id);
  assert.equal(payload.RefNo, "GR-TEST-001");
  assert.equal(payload.InvoiceTemplate, "1/001");
  assert.equal(payload.InvoiceSeries, "C26TGA");
  assert.equal(payload.PaymentMethod, "CK");
  assert.equal(payload.BuyerLegalName, "Nguyễn Văn A");
  assert.equal(payload.BuyerTaxCode, "0101243150");
  assert.equal(payload.SellerTaxCode, "0109998888");
  assert.equal(payload.TotalAmount, 230000);
  assert.equal(payload.Items.length, 2); // 1 product + 1 shipping fee

  assert.equal(payload.Items[0].ItemName, "GAERU Tai nghe K9 Pro - Màu đen");
  assert.equal(payload.Items[0].ItemCode, "K9-PRO-BLK");
  assert.equal(payload.Items[0].Quantity, 2);
  assert.equal(payload.Items[0].UnitPrice, 100000);
  assert.equal(payload.Items[0].Amount, 200000);

  assert.equal(payload.Items[1].ItemName, "Cước phí vận chuyển");
  assert.equal(payload.Items[1].Quantity, 1);
  assert.equal(payload.Items[1].Amount, 30000);
});

test("MISA probeConnection validates credentials and calls verification endpoint", async () => {
  let probeCalled = false;
  const mockFetcher = async (url, options) => {
    probeCalled = true;
    assert.match(url, /\/api\/v1\/connection\/verify$/);
    assert.equal(options.headers["X-MISA-AppId"], "MISA-APP-OK");
    assert.equal(options.headers["X-MISA-Secret"], "SEC-123");
    return {
      ok: true,
      status: 200,
      json: async () => ({ Success: true, Data: { storeName: "GAERU Official" } })
    };
  };

  const result = await probeConnection(
    { appId: "MISA-APP-OK", storeId: "STORE-01", secret: "SEC-123" },
    { fetcher: mockFetcher }
  );
  assert.equal(result.verified, true);
  assert.equal(probeCalled, true);

  // Failure scenario
  const failingFetcher = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ ErrorMessage: "AppId hoặc Secret không hợp lệ" })
  });

  await assert.rejects(
    probeConnection({ appId: "BAD", storeId: "STORE-01", secret: "BAD" }, { fetcher: failingFetcher }),
    /AppId hoặc Secret không hợp lệ/
  );
});

test("autoIssueForOrder completes e-invoice issuance and is strictly idempotent", async (t) => {
  const pool = await setupTestDb(t);
  const sessionSecret = "misa-test-session-secret-key-12345";
  const config = {
    SESSION_SECRET: sessionSecret,
    accountSecurity: { authorize: (_r, fn) => fn(null, pool) }
  };

  // Configure MISA in store_settings
  await pool.query(
    "INSERT INTO store_settings(setting_key, setting_value) VALUES($1, $2)",
    [
      "private_admin:misa",
      JSON.stringify({
        version: 1,
        cipher: require("../src/totp").seal(
          JSON.stringify({
            appId: "APP-MISA-REAL",
            storeId: "STORE-001",
            secret: "SECRET-REAL",
            taxCode: "0109998888",
            templateCode: "1/001",
            series: "C26TGA",
            environment: "sandbox",
            autoIssue: true,
            enabled: true
          }),
          sessionSecret
        )
      })
    ]
  );

  // Insert a completed & paid order
  const order = (
    await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, shipping_fee_vnd, total_vnd, status, payment_status)
       VALUES('GR-MISA-999', 'Trần Thị B', 'b@example.com', '0987654321', '456 Lê Lợi', 'TP. Hồ Chí Minh', 'cod', 150000, 20000, 170000, 'completed', 'paid')
       RETURNING *`
    )
  ).rows[0];

  await pool.query(
    `INSERT INTO order_items(order_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
     VALUES($1, 'Cáp sạc Type-C', '1m', 'CABLE-C-1M', 150000, 1, 150000)`,
    [order.id]
  );

  let publishCallCount = 0;
  const mockFetcher = async (url, options) => {
    publishCallCount++;
    assert.match(url, /\/api\/v1\/invoices\/publish$/);
    const body = JSON.parse(options.body);
    assert.equal(body.RefNo, "GR-MISA-999");
    assert.equal(body.TotalAmount, 170000);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        Success: true,
        InvoiceNo: "0000123",
        InvoiceSeries: "C26TGA",
        TemplateCode: "1/001",
        TransactionID: "TX-MISA-UUID-1234",
        ViewUrl: "https://testmeinvoice.vn/view/TX-MISA-UUID-1234"
      })
    };
  };

  // 1st run: Should issue invoice
  const firstRun = await autoIssueForOrder(pool, config, order.id, { fetcher: mockFetcher });
  assert.equal(firstRun.success, true);
  assert.equal(firstRun.einvoice.invoice_number, "0000123");
  assert.equal(firstRun.einvoice.view_url, "https://testmeinvoice.vn/view/TX-MISA-UUID-1234");
  assert.equal(publishCallCount, 1);

  // Verify stored in DB
  const rows = (await pool.query("SELECT * FROM misa_einvoices WHERE order_id=$1", [order.id])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].invoice_number, "0000123");
  assert.equal(rows[0].transaction_id, "TX-MISA-UUID-1234");

  // 2nd run: Should skip due to idempotency constraint
  const secondRun = await autoIssueForOrder(pool, config, order.id, { fetcher: mockFetcher });
  assert.equal(secondRun.skipped, true);
  assert.equal(secondRun.reason, "already_issued");
  assert.equal(publishCallCount, 1, "MISA publish API must never be called twice for the same order");
});

test("Order status completion via admin API automatically triggers MISA e-invoice issuing", async (t) => {
  const pool = await setupTestDb(t);
  const sessionSecret = "misa-order-completion-session-secret";
  const password = "Owner-password-2026";
  const passwordHash = bcrypt.hashSync(password, 4);

  let misaIssued = false;
  let probeHit = false;
  const misaFetcher = async (url, options) => {
    if (url.includes("/connection/verify")) {
      probeHit = true;
      return { ok: true, json: async () => ({ Success: true }) };
    }
    misaIssued = true;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        Success: true,
        InvoiceNo: "0009876",
        InvoiceSeries: "C26TGA",
        TemplateCode: "1/001",
        TransactionID: "TX-ORDER-COMPLETE-001",
        ViewUrl: "https://testmeinvoice.vn/view/TX-ORDER-COMPLETE-001"
      })
    };
  };

  const config = {
    NODE_ENV: "test",
    SESSION_SECRET: sessionSecret,
    ADMIN_USERNAME: "owner",
    ADMIN_PASSWORD_HASH: passwordHash,
    PUBLIC_BASE_URL: "https://gaeru.com",
    STORE_ORDERS_ENABLED: true,
    misaFetcher
  };

  const app = createApp({
    config,
    pool,
    sessionStore: new session.MemoryStore(),
    customerMailer: { async sendMail() {} }
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  let cookie = "", csrf = "";

  async function api(path, method = "GET", body) {
    const res = await fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.headers.get("set-cookie")) {
      cookie = res.headers.get("set-cookie").split(";")[0];
    }
    const data = res.status === 204 ? null : await res.json();
    if (data?.csrfToken) csrf = data.csrfToken;
    return { status: res.status, data };
  }

  // Get CSRF and log in as owner
  await api("/api/csrf");
  const loginRes = await api("/api/auth/login", "POST", { username: "owner", password });
  assert.equal(loginRes.status, 200);

  // Save MISA configuration with autoIssue = true and enabled = true
  const saveConfigRes = await api("/api/gaeru_ceo/owner/configuration/misa", "PUT", {
    version: 0,
    data: {
      appId: "APP-MISA-AUTO",
      storeId: "STORE-AUTO-01",
      secret: "SECRET-MISA-123",
      taxCode: "0101234567",
      templateCode: "1/001",
      series: "C26TGA",
      environment: "sandbox",
      autoIssue: true,
      enabled: true
    },
    password
  });
  assert.equal(saveConfigRes.status, 200);

  // Create an order in 'shipped' and 'paid' state
  const order = (
    await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, shipping_fee_vnd, total_vnd, status, payment_status)
       VALUES('GR-AUTO-01', 'Lê Văn C', 'c@example.com', '0911223344', '789 Trần Hưng Đạo', 'Hà Nội', 'bank_transfer', 300000, 20000, 320000, 'shipped', 'paid')
       RETURNING *`
    )
  ).rows[0];

  await pool.query(
    `INSERT INTO order_items(order_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
     VALUES($1, 'Chuột không dây GAERU M1', 'Xám', 'M1-GRY', 300000, 1, 300000)`,
    [order.id]
  );

  // Transition order to 'completed'
  const patchRes = await api("/api/gaeru_ceo/orders/" + order.id, "PATCH", { status: "completed" });
  assert.equal(patchRes.status, 200);

  // Verify MISA invoice was automatically issued
  assert.equal(misaIssued, true);
  const einvoiceRows = (await pool.query("SELECT * FROM misa_einvoices WHERE order_id=$1", [order.id])).rows;
  assert.equal(einvoiceRows.length, 1);
  assert.equal(einvoiceRows[0].invoice_number, "0009876");
  assert.equal(einvoiceRows[0].view_url, "https://testmeinvoice.vn/view/TX-ORDER-COMPLETE-001");

  // Verify GET /api/gaeru_ceo/orders returns the invoice details
  const getOrdersRes = await api("/api/gaeru_ceo/orders?status=completed");
  assert.equal(getOrdersRes.status, 200);
  const found = getOrdersRes.data.orders.find((o) => o.id === order.id);
  assert.ok(found);
  assert.equal(found.einvoice?.invoiceNumber, "0009876");

  // Verify probe endpoint POST /api/gaeru_ceo/owner/configuration/misa/test
  const probeRes = await api("/api/gaeru_ceo/owner/configuration/misa/test", "POST", { version: 1, password });
  assert.equal(probeRes.status, 200);
  assert.equal(probeRes.data.compatible, true);
  assert.equal(probeHit, true);

  // Verify business integrations endpoint reflects active MISA connection
  const intRes = await api("/api/gaeru_ceo/business/integrations");
  assert.equal(intRes.status, 200);
  assert.equal(intRes.data.automaticSyncEnabled, true);
  const misaProvider = intRes.data.providers.find((p) => p.name === "MISA eShop");
  assert.ok(misaProvider);
  assert.equal(misaProvider.connected, true);
  assert.equal(misaProvider.status, "connected");

  // Create another order to test manual issuance via business document API
  const order2 = (
    await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, shipping_fee_vnd, total_vnd, status, payment_status)
       VALUES('GR-MANUAL-02', 'Phạm Thị D', 'd@example.com', '0933445566', '321 Phố Huế', 'Hà Nội', 'cod', 500000, 30000, 530000, 'completed', 'paid')
       RETURNING *`
    )
  ).rows[0];

  await pool.query(
    `INSERT INTO order_items(order_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
     VALUES($1, 'Bàn phím cơ GAERU TKL', 'White', 'KB-TKL-W', 500000, 1, 500000)`,
    [order2.id]
  );

  const docRes = await api("/api/gaeru_ceo/business/invoice", "POST", {
    period: "2026-10",
    requestKey: randomUUID(),
    orderId: order2.id,
    buyerName: "Công ty TNHH Dịch vụ D",
    buyerTaxCode: "0109997777",
    buyerAddress: "321 Phố Huế, Hà Nội",
    buyerEmail: "ketoan@example.com"
  });
  assert.equal(docRes.status, 201);
  const docId = docRes.data.id;

  // Approve invoice document
  const approveRes = await api("/api/gaeru_ceo/business/invoice/" + docId + "/approve", "POST", { version: 1 });
  assert.equal(approveRes.status, 200);

  // Issue invoice via POST /business/invoice/:id/issue
  const manualIssueRes = await api("/api/gaeru_ceo/business/invoice/" + docId + "/issue", "POST", {});
  assert.equal(manualIssueRes.status, 200);
  assert.equal(manualIssueRes.data.success, true);
  assert.ok(manualIssueRes.data.einvoice);
  assert.equal(manualIssueRes.data.einvoice.buyer_tax_code, "0109997777");

  // Check GET /business/invoice returns einvoice details
  const listDocsRes = await api("/api/gaeru_ceo/business/invoice?period=2026-10");
  assert.equal(listDocsRes.status, 200);
  const foundDoc = listDocsRes.data.documents.find((d) => d.id === docId);
  assert.ok(foundDoc);
  assert.equal(foundDoc.calculation?.issued, true);
  assert.ok(foundDoc.einvoice);
});
