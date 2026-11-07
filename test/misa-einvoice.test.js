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

test("MISA probe and direct publishing fail closed before network access or invented invoice identifiers", async () => {
  let calls=0;const fetcher=async()=>{calls++;return {ok:true,json:async()=>({})};};
  for(const action of [()=>probeConnection({appId:'fixture',storeId:'fixture',secret:'fixture'},{fetcher}),()=>issueInvoice({},{},{fetcher}),()=>issueInvoiceForDocument({}, {}, 'fixture', {}, {fetcher})]) {
    await assert.rejects(action,e=>e.status===501&&e.code==='MISA_PROTOCOL_UNVERIFIED');
  }
  const result=await autoIssueForOrder({query(){throw Error('must not read or write');}},{},'fixture',{fetcher});
  assert.equal(result.skipped,true);assert.equal(result.reason,'misa_protocol_unverified');assert.equal(calls,0);
});

test("MISA stays unverified after saving; order completion and approved internal documents never publish externally", async (t) => {
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
  const patchRes = await api("/api/gaeru_ceo/orders/" + order.id + "/confirm-delivery", "POST", {
    evidenceNote: "Verified successful delivery of prepaid customer order"
  });
  assert.equal(patchRes.status, 200);

  // Protocol is unverified: completing the order must not publish an external invoice
  assert.equal(misaIssued, false);
  const einvoiceRows = (await pool.query("SELECT * FROM misa_einvoices WHERE order_id=$1", [order.id])).rows;
  assert.equal(einvoiceRows.length, 0);

  // Verify GET /api/gaeru_ceo/orders returns the invoice details
  const getOrdersRes = await api("/api/gaeru_ceo/orders?status=completed");
  assert.equal(getOrdersRes.status, 200);
  const found = getOrdersRes.data.orders.find((o) => o.id === order.id);
  assert.ok(found);
  assert.ok(!found.einvoice);

  // Probe is explicitly unavailable before partner protocol acceptance
  const probeRes = await api("/api/gaeru_ceo/owner/configuration/misa/test", "POST", { version: 1, password });
  assert.equal(probeRes.status, 501);
  assert.equal(probeRes.data.compatible, false);
  assert.equal(probeHit, false);

  // Saved MISA configuration never becomes authenticated provider evidence
  const intRes = await api("/api/gaeru_ceo/business/integrations");
  assert.equal(intRes.status, 200);
  assert.equal(intRes.data.automaticSyncEnabled, false);
  const misaProvider = intRes.data.providers.find((p) => p.name === "MISA eShop");
  assert.ok(misaProvider);
  assert.equal(misaProvider.connected, false);
  assert.equal(misaProvider.status, "configured_unverified");

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
  assert.equal(manualIssueRes.status, 501);
  assert.ok(!manualIssueRes.data.einvoice);
  assert.equal(misaIssued,false);

  // Check GET /business/invoice returns einvoice details
  const listDocsRes = await api("/api/gaeru_ceo/business/invoice?period=2026-10");
  assert.equal(listDocsRes.status, 200);
  const foundDoc = listDocsRes.data.documents.find((d) => d.id === docId);
  assert.ok(foundDoc);
  assert.notEqual(foundDoc.calculation?.issued,true);
  assert.ok(!foundDoc.einvoice);
});
