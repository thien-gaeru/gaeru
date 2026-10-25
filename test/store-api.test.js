const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const express = require("express");
const { createStoreApi, transitions, orderSchema, settingsSchema } = require("../src/store-api");

const product = {
  id: "4b4cfca4-96cd-47b1-a851-ed6f9944359f",
  slug: "k9",
  name: "GAERU K9",
  category: "audio",
  descriptor: "Nhỏ gọn",
  description: "Micro không dây",
  imageUrl: "/assets/products/k9.png",
  imageAlt: "GAERU K9",
  active: true,
  sortOrder: 10,
  variants: []
};

test("store API serves products from the database-backed repository", async (context) => {
  const app = express();
  app.use("/api", createStoreApi({
    query: async () => ({ rows: [product] })
  }));
  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const list = await fetch(`http://127.0.0.1:${address.port}/api/products`);
  assert.equal(list.status, 200);
  const listed = (await list.json()).products;
  assert.deepEqual(listed.map((item) => item.slug), ["k9"]);
  assert.equal(listed[0].imageUrl, "/assets/products/k9.webp");
  assert.equal(product.imageUrl, "/assets/products/k9.png");

  const detail = await fetch(`http://127.0.0.1:${address.port}/api/products/k9`);
  assert.equal(detail.status, 200);
  const shown = (await detail.json()).product;
  assert.equal(shown.name, "GAERU K9");
  assert.equal(shown.imageUrl, "/assets/products/k9.webp");
});

test("order submission is closed by default and does not touch the database", async (context) => {
  let databaseAccessed = false;
  const app = express();
  app.use(express.json());
  app.use("/api", createStoreApi({
    async query() {
      databaseAccessed = true;
      throw new Error("Database should not be accessed");
    }
  }));
  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /tạm dừng tiếp nhận/);
  assert.equal(databaseAccessed, false);
});

test("order schema validates guest checkout and rejects zero quantities", () => {
  const valid = orderSchema.safeParse({
    customer: {
      name: "Nguyen An",
      email: "an@example.com",
      phone: "0829191080",
      address: "12 Nguyen Trai",
      city: "Ninh Binh"
    },
    paymentMethod: "vnpay",
    items: [{ variantId: "4b4cfca4-96cd-47b1-a851-ed6f9944359f", quantity: 2 }]
  });
  assert.equal(valid.success, true);
  const invalid = orderSchema.safeParse({
    customer: {
      name: "A",
      email: "bad-email",
      phone: "1",
      address: "x",
      city: "y"
    },
    paymentMethod: "cod",
    items: [{ variantId: "not-a-uuid", quantity: 0 }]
  });
  assert.equal(invalid.success, false);
});

test("shipping settings validate province names and whole-VND fees", () => {
  const valid = settingsSchema.safeParse({
    shippingNote: "",
    shippingRates: { "Hà Nội": 30000 }
  });
  assert.equal(valid.success, true);
  const duplicate = settingsSchema.safeParse({
    shippingNote: "",
    shippingRates: { "Hà Nội": 30000, "hà nội": 40000 }
  });
  assert.equal(duplicate.success, false);
  const invalidFee = settingsSchema.safeParse({
    shippingNote: "",
    shippingRates: { "Hà Nội": -1 }
  });
  assert.equal(invalidFee.success, false);
});

test("order creation calculates shipping server-side from the selected province", async (context) => {
  const statements = [];
  const variantId = "4b4cfca4-96cd-47b1-a851-ed6f9944359f";
  const createdOrder = {
    id: "8fdd01fd-c15d-42d0-b95d-beb8cc3a5ef7",
    orderNumber: "GR-20260101-ABCDE12345",
    subtotalVnd: 200000,
    shippingFeeVnd: 30000,
    totalVnd: 230000,
    status: "pending",
    paymentMethod: "vnpay",
    createdAt: "2026-01-01T00:00:00.000Z"
  };
  const client = {
    async query(sql, values) {
      statements.push({ sql, values });
      if (sql.startsWith("SELECT v.id")) {
        return { rows: [{
          id: variantId,
          sku: "K9-USB",
          variantName: "USB-C",
          priceVnd: 100000,
          stockQuantity: 10,
          productName: "GAERU K9"
        }] };
      }
      if (sql.includes("setting_key = 'shipping_rates'")) return { rows: [{ setting_value: { "Hà Nội": 30000 } }] };
      if (sql.startsWith("INSERT INTO orders")) return { rows: [createdOrder] };
      return { rows: [] };
    },
    release() {}
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { csrfToken: "valid-token" };
    next();
  });
  app.use("/api", createStoreApi({ connect: async () => client }, {
    ordersEnabled: true,
    vnpayConfig: {
      tmnCode: "ABC12345",
      hashSecret: "sandbox-secret",
      paymentUrl: "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html",
      returnUrl: "https://store.example/api/payments/vnpay/return"
    }
  }));
  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": "valid-token" },
    body: JSON.stringify({
      customer: {
        name: "Nguyen An",
        email: "an@example.com",
        phone: "0829191080",
        address: "12 Nguyen Trai",
        city: "Hà Nội"
      },
      paymentMethod: "vnpay",
      items: [{ variantId, quantity: 2 }]
    })
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.order.totalVnd, 230000);
  assert.equal(new URL(body.paymentUrl).origin, "https://sandbox.vnpayment.vn");
  const insert = statements.find(({ sql }) => sql.startsWith("INSERT INTO orders"));
  assert.equal(insert.values[9], 30000);
  assert.equal(insert.values[10], 230000);
  const paymentAttempt = statements.find(({ sql }) => sql.startsWith("INSERT INTO payment_attempts"));
  assert.deepEqual(paymentAttempt.values, [createdOrder.id, createdOrder.orderNumber, 230000]);
  assert.equal(statements.some(({ sql }) => sql.startsWith("UPDATE product_variants SET stock_quantity")), true);
});

test("order status transitions do not allow reopening completed or cancelled orders", () => {
  assert.deepEqual(transitions.pending, ["confirmed", "cancelled"]);
  assert.deepEqual(transitions.completed, []);
  assert.deepEqual(transitions.cancelled, []);
  assert.equal(transitions.shipped.includes("cancelled"), false);
});

test("variant deletion preserves variants referenced by historical orders", async (context) => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql.startsWith("SELECT p.id")) return { rows: [{ id: "8fdd01fd-c15d-42d0-b95d-beb8cc3a5ef7", active: false }] };
      if (sql.startsWith("SELECT id, active,") && sql.includes("FROM product_variants")) return { rows: [{ id: "4b4cfca4-96cd-47b1-a851-ed6f9944359f", active: true, stockQuantity: 0 }] };
      if (sql.startsWith("SELECT EXISTS")) return { rows: [{ referenced: true }] };
      return { rows: [] };
    },
    release() { statements.push("RELEASE"); }
  };
  const app = express();
  app.use((req, _res, next) => {
    req.session = { admin: { username: "manager" }, csrfToken: "valid-token" };
    next();
  });
  app.use("/api", createStoreApi({ connect: async () => client }));
  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/gaeru_ceo/variants/4b4cfca4-96cd-47b1-a851-ed6f9944359f`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": "valid-token" }
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /tạm ẩn thay vì xóa/);
  assert.equal(statements.some((sql) => sql.startsWith("DELETE FROM product_variants")), false);
  assert.equal(statements.at(-1), "RELEASE");
});

test("admin order search is paginated and validates filters", async (context) => {
  const queries = [];
  const app = express();
  app.use((req, _res, next) => {
    req.session = { admin: { username: "manager" } };
    next();
  });
  app.use("/api", createStoreApi({
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.startsWith("SELECT COUNT(*)")) return { rows: [{ total: values[0] === "cancelled" ? 0 : 31 }] };
      return { rows: [] };
    }
  }));
  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}/api/gaeru_ceo/orders`;
  const response = await fetch(`${baseUrl}?status=pending&q=GR-123&page=2`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.pagination, { page: 2, pageSize: 25, total: 31, pageCount: 2 });
  assert.deepEqual(queries[0].values, ["pending", "GR-123", "", ""]);
  assert.deepEqual(queries[1].values, ["pending", "GR-123", "", "", 25, 25]);
  assert.match(queries[1].sql, /ILIKE/);

  const emptyPageResponse = await fetch(`${baseUrl}?status=cancelled&page=4`);
  assert.equal(emptyPageResponse.status, 200);
  assert.deepEqual((await emptyPageResponse.json()).pagination, { page: 1, pageSize: 25, total: 0, pageCount: 0 });
  assert.deepEqual(queries.at(-1).values, ["cancelled", "", "", "", 25, 0]);

  const invalid = await fetch(`${baseUrl}?status=unknown`);
  assert.equal(invalid.status, 400);
});

test("admin can complete a COD delivery and record collection in the same update", async (context) => {
  const updates = [];
  const currentOrder = {
    id: "4b4cfca4-96cd-47b1-a851-ed6f9944359f",
    status: "shipped",
    payment_status: "pending",
    payment_method: "cod",
    shipping_fee_vnd: 0,
    subtotal_vnd: 100000
  };
  const client = {
    async query(sql, values) {
      if (sql === "SELECT * FROM orders WHERE id=$1 FOR UPDATE") return { rows: [currentOrder] };
      if (sql.startsWith("UPDATE orders SET status=")) {
        updates.push(values);
        return {
          rows: [{
            id: currentOrder.id,
            status: values[1],
            paymentStatus: values[2],
            shippingFeeVnd: values[3],
            totalVnd: values[4]
          }]
        };
      }
      return { rows: [] };
    },
    release() {}
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { admin: { username: "manager" }, csrfToken: "valid-token" };
    next();
  });
  app.use("/api", createStoreApi({ connect: async () => client }));
  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/api/gaeru_ceo/orders/${currentOrder.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": "valid-token" },
    body: JSON.stringify({ status: "completed", paymentStatus: "paid" })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(updates[0].slice(1), ["completed", "paid", 0, 100000]);
});

test("admin cannot mark COD as paid before completing delivery", async (context) => {
  let orderUpdated = false;
  const currentOrder = {
    id: "4b4cfca4-96cd-47b1-a851-ed6f9944359f",
    status: "shipped",
    payment_status: "pending",
    payment_method: "cod",
    shipping_fee_vnd: 0,
    subtotal_vnd: 100000
  };
  const client = {
    async query(sql) {
      if (sql === "SELECT * FROM orders WHERE id=$1 FOR UPDATE") return { rows: [currentOrder] };
      if (sql.startsWith("UPDATE orders SET status=")) orderUpdated = true;
      return { rows: [] };
    },
    release() {}
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { admin: { username: "manager" }, csrfToken: "valid-token" };
    next();
  });
  app.use("/api", createStoreApi({ connect: async () => client }));
  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/gaeru_ceo/orders/${currentOrder.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": "valid-token" },
    body: JSON.stringify({ paymentStatus: "paid" })
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /sau khi giao hàng/);
  assert.equal(orderUpdated, false);
});

test("VNPAY IPN verifies amount and signature, then updates payment idempotently", async (context) => {
  const transactionRef = "GR-20260101-ABCDE12345";
  const parameters = {
    vnp_TmnCode: "ABC12345",
    vnp_TxnRef: transactionRef,
    vnp_Amount: "23000000",
    vnp_Command: "pay",
    vnp_ResponseCode: "00",
    vnp_TransactionStatus: "00",
    vnp_TransactionNo: "123456"
  };
  const canonical = new URLSearchParams(
    Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right))
  ).toString();
  parameters.vnp_SecureHash = createHmac("sha512", "sandbox-secret").update(canonical).digest("hex");

  let attemptStatus = "pending";
  let orderUpdates = 0;
  const client = {
    async query(sql) {
      if (sql.startsWith("SELECT p.id")) {
        return { rows: [{
          id: "8fdd01fd-c15d-42d0-b95d-beb8cc3a5ef7",
          amountVnd: 230000,
          attemptStatus,
          orderId: "2aee81a1-6f7d-4a9f-a651-d99e774df69f",
          totalVnd: 230000,
          paymentStatus: orderUpdates ? "paid" : "pending"
        }] };
      }
      if (sql.startsWith("UPDATE payment_attempts")) attemptStatus = "paid";
      if (sql.startsWith("UPDATE orders SET payment_status")) orderUpdates += 1;
      return { rows: [] };
    },
    release() {}
  };
  const app = express();
  app.use("/api", createStoreApi({ connect: async () => client }, {
    vnpayConfig: {
      tmnCode: "ABC12345",
      hashSecret: "sandbox-secret",
      paymentUrl: "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html",
      returnUrl: "https://store.example/api/payments/vnpay/return"
    }
  }));
  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  const callbackUrl = `http://127.0.0.1:${server.address().port}/api/payments/vnpay/ipn`;
  const signedQuery = new URLSearchParams(parameters).toString();

  const firstResponse = await fetch(`${callbackUrl}?${signedQuery}`);
  assert.deepEqual(await firstResponse.json(), { RspCode: "00", Message: "Confirm Success" });
  assert.equal(orderUpdates, 1);

  const duplicateResponse = await fetch(`${callbackUrl}?${signedQuery}`);
  assert.deepEqual(await duplicateResponse.json(), { RspCode: "02", Message: "Order already confirmed" });
  assert.equal(orderUpdates, 1);

  const tampered = new URLSearchParams(parameters);
  tampered.set("vnp_Amount", "1");
  const invalidSignatureResponse = await fetch(`${callbackUrl}?${tampered}`);
  assert.deepEqual(await invalidSignatureResponse.json(), { RspCode: "97", Message: "Invalid signature" });
  assert.equal(orderUpdates, 1);
});

test("order creation accepts a recipient city with a configured nationwide fee", async (context) => {
  const statements = [];
  const variantId = "4b4cfca4-96cd-47b1-a851-ed6f9944359f";
  const createdOrder = {
    id: "8fdd01fd-c15d-42d0-b95d-beb8cc3a5ef7",
    orderNumber: "GR-20260101-ABCDE12345",
    subtotalVnd: 200000,
    shippingFeeVnd: 30000,
    totalVnd: 230000,
    status: "pending",
    paymentMethod: "vnpay",
    createdAt: "2026-01-01T00:00:00.000Z"
  };
  const client = {
    async query(sql, values) {
      statements.push({ sql, values });
      if (sql.startsWith("SELECT v.id")) {
        return { rows: [{
          id: variantId,
          sku: "K9-USB",
          variantName: "USB-C",
          priceVnd: 100000,
          stockQuantity: 10,
          productName: "GAERU K9"
        }] };
      }
      if (sql.includes("setting_key = 'shipping_rates'")) return { rows: [{ setting_value: { "Toàn quốc": 30000 } }] };
      if (sql.startsWith("INSERT INTO orders")) return { rows: [createdOrder] };
      return { rows: [] };
    },
    release() {}
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { csrfToken: "valid-token" };
    next();
  });
  app.use("/api", createStoreApi({ connect: async () => client }, {
    ordersEnabled: true,
    vnpayConfig: {
      tmnCode: "ABC12345",
      hashSecret: "sandbox-secret",
      paymentUrl: "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html",
      returnUrl: "https://store.example/api/payments/vnpay/return"
    }
  }));
  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": "valid-token" },
    body: JSON.stringify({
      customer: {
        name: "Nguyen An",
        email: "an@example.com",
        phone: "0829191080",
        address: "12 Nguyen Trai",
        city: "Hà Nội"
      },
      paymentMethod: "vnpay",
      items: [{ variantId, quantity: 2 }]
    })
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.order.totalVnd, 230000);
  assert.equal(new URL(body.paymentUrl).origin, "https://sandbox.vnpayment.vn");
  const insert = statements.find(({ sql }) => sql.startsWith("INSERT INTO orders"));
  assert.equal(insert.values[9], 30000);
  assert.equal(insert.values[10], 230000);
  const paymentAttempt = statements.find(({ sql }) => sql.startsWith("INSERT INTO payment_attempts"));
  assert.deepEqual(paymentAttempt.values, [createdOrder.id, createdOrder.orderNumber, 230000]);
  assert.equal(statements.some(({ sql }) => sql.startsWith("UPDATE product_variants SET stock_quantity")), true);
});
