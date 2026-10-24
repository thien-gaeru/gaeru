const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createStoreApi, loadProducts } = require("../src/store-api");

const productId = "8fdd01fd-c15d-42d0-b95d-beb8cc3a5ef7";
const variantId = "4b4cfca4-96cd-47b1-a851-ed6f9944359f";
const orderId = "2aee81a1-6f7d-4a9f-a651-d99e774df69f";
const variantPayload = { sku: "K9-USB", name: "USB-C", priceVnd: 100000, stockQuantity: 5, active: false };
const productPayload = {
  slug: "k9", name: "GAERU K9", category: "audio", imageUrl: "/assets/products/k9.png", active: true
};

async function startAdminApi(context, pool) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { admin: { username: "manager" }, csrfToken: "valid-token" };
    next();
  });
  app.use("/api", createStoreApi(pool));
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  return (path, { method = "GET", body } = {}) => fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-CSRF-Token": "valid-token" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

test("product search finds slug, variant name and SKU without exposing draft variants", async () => {
  const products = [{
    ...productPayload, slug: "wireless-kit", description: "Micro", descriptor: "Nhỏ gọn",
    variants: [{ name: "Bộ Lightning", sku: "K9-APL" }]
  }];
  const queries = [];
  const pool = { async query(sql) { queries.push(sql); return { rows: products }; } };
  for (const search of ["WIRELESS-KIT", "lightning", "k9-apl"]) {
    assert.equal((await loadProducts(pool, { search })).length, 1);
  }
  assert.equal((await loadProducts(pool, { search: "missing-sku" })).length, 0);
  assert.match(queries[0], /AND v.active = true/);
  await loadProducts(pool, { includeDrafts: true, search: "k9-apl" });
  assert.doesNotMatch(queries.at(-1), /AND v.active = true/);
});

test("publishing locks the parent before checking active variants", async (context) => {
  for (const activeVariants of [0, 1]) {
    await context.test(`${activeVariants} active variants`, async (subcontext) => {
      const statements = [];
      const client = {
        async query(sql) {
          statements.push(sql);
          if (sql === "SELECT id FROM products WHERE id=$1 FOR UPDATE") return { rows: [{ id: productId }] };
          if (sql.startsWith("SELECT COUNT(*)")) return { rows: [{ count: activeVariants }] };
          if (sql.startsWith("UPDATE products")) return { rows: [{ id: productId }] };
          return { rows: [] };
        },
        release() {}
      };
      const request = await startAdminApi(subcontext, { connect: async () => client });
      const response = await request(`/gaeru_ceo/products/${productId}`, { method: "PUT", body: productPayload });
      assert.equal(response.status, activeVariants ? 200 : 409);
      const lock = statements.findIndex((sql) => sql === "SELECT id FROM products WHERE id=$1 FOR UPDATE");
      const count = statements.findIndex((sql) => sql.startsWith("SELECT COUNT(*)"));
      assert.ok(lock >= 0 && count > lock);
      assert.equal(statements.some((sql) => sql.startsWith("UPDATE products")), Boolean(activeVariants));
      assert.equal(statements.at(-1), activeVariants ? "COMMIT" : "ROLLBACK");
    });
  }
});

test("variant editing and deletion preserve a published product's final active variant", async (context) => {
  const scenarios = [
    { label: "published, last variant", parentActive: true, otherActive: 0, expected: 409 },
    { label: "published, another active variant", parentActive: true, otherActive: 1, expected: 200 },
    { label: "draft, last variant", parentActive: false, otherActive: 0, expected: 200 }
  ];
  for (const method of ["PUT", "DELETE"]) {
    for (const scenario of scenarios) {
      await context.test(`${method}: ${scenario.label}`, async (subcontext) => {
        const statements = [];
        const client = {
          async query(sql) {
            statements.push(sql);
            if (sql.startsWith("SELECT p.id")) return { rows: [{ id: productId, active: scenario.parentActive }] };
            if (sql.startsWith("SELECT id, active,") && sql.includes("FROM product_variants")) return { rows: [{ id: variantId, active: true, stockQuantity: 3 }] };
            if (sql.startsWith("SELECT EXISTS")) return { rows: [{ referenced: false }] };
            if (sql.startsWith("SELECT COUNT(*)")) return { rows: [{ count: scenario.otherActive }] };
            if (sql.startsWith("UPDATE product_variants")) return { rows: [{ id: variantId }] };
            return { rows: [] };
          },
          release() {}
        };
        const request = await startAdminApi(subcontext, { connect: async () => client });
        const response = await request(`/gaeru_ceo/variants/${variantId}`, {
          method, ...(method === "PUT" ? { body: variantPayload } : {})
        });
        const expected = method === "DELETE" && scenario.expected === 200 ? 204 : scenario.expected;
        assert.equal(response.status, expected);
        const parentLock = statements.findIndex((sql) => sql.includes("FOR UPDATE OF p"));
        const variantLock = statements.findIndex((sql) => sql.startsWith("SELECT id, active,") && sql.includes("FROM product_variants"));
        assert.ok(parentLock >= 0 && variantLock > parentLock);
        const mutated = statements.some((sql) => sql.startsWith("UPDATE product_variants") || sql.startsWith("DELETE FROM product_variants"));
        assert.equal(mutated, scenario.expected === 200);
        assert.equal(statements.at(-1), scenario.expected === 200 ? "COMMIT" : "ROLLBACK");
        if (scenario.expected === 409) assert.match((await response.json()).error, /tạm ẩn sản phẩm/);
      });
    }
  }
});

test("admin cannot undo received payments, alter gateway results, or reprice paid orders", async (context) => {
  const scenarios = [
    { method: "bank_transfer", payment: "paid", body: { paymentStatus: "pending" }, error: /đã thanh toán về chưa thanh toán/ },
    { method: "vnpay", payment: "paid", body: { paymentStatus: "pending" }, error: /đã thanh toán về chưa thanh toán/ },
    { method: "vnpay", payment: "pending", body: { paymentStatus: "paid" }, error: /không thể sửa thủ công/ },
    { method: "9pay", payment: "pending", body: { paymentStatus: "paid" }, error: /không thể sửa thủ công/ },
    { method: "bank_transfer", payment: "paid", body: { shippingFeeVnd: 40000 }, error: /phí giao hàng sau khi đơn đã thanh toán/ },
    { method: "vnpay", payment: "paid", body: { status: "cancelled" }, error: /hoàn tiền trước khi hủy/ }
  ];
  for (const scenario of scenarios) {
    await context.test(`${scenario.method}: ${JSON.stringify(scenario.body)}`, async (subcontext) => {
      const statements = [];
      const client = {
        async query(sql) {
          statements.push(sql);
          if (sql === "SELECT * FROM orders WHERE id=$1 FOR UPDATE") return { rows: [{
            id: orderId, status: "pending", payment_method: scenario.method, payment_status: scenario.payment,
            shipping_fee_vnd: 30000, subtotal_vnd: 100000
          }] };
          return { rows: [] };
        },
        release() {}
      };
      const request = await startAdminApi(subcontext, { connect: async () => client });
      const response = await request(`/gaeru_ceo/orders/${orderId}`, { method: "PATCH", body: scenario.body });
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, scenario.error);
      assert.equal(statements.some((sql) => /^UPDATE (orders|product_variants|payment_attempts)/.test(sql)), false);
      assert.equal(statements.at(-1), "ROLLBACK");
    });
  }
});

test("unchanged gateway payment status permits normal order processing", async (context) => {
  const statements = [];
  const client = {
    async query(sql, values) {
      statements.push(sql);
      if (sql === "SELECT * FROM orders WHERE id=$1 FOR UPDATE") return { rows: [{
        id: orderId, status: "pending", payment_method: "vnpay", payment_status: "paid",
        shipping_fee_vnd: 30000, subtotal_vnd: 100000
      }] };
      if (sql.startsWith("UPDATE orders")) return { rows: [{ id: orderId, status: values[1], paymentStatus: values[2] }] };
      return { rows: [] };
    },
    release() {}
  };
  const request = await startAdminApi(context, { connect: async () => client });
  const response = await request(`/gaeru_ceo/orders/${orderId}`, {
    method: "PATCH", body: { status: "confirmed", paymentStatus: "paid", shippingFeeVnd: 30000 }
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).order, { id: orderId, status: "confirmed", paymentStatus: "paid" });
  assert.equal(statements.some((sql) => sql.startsWith("UPDATE product_variants")), false);
});

test("order payment filters use the same count/page predicate and preserve pagination", async (context) => {
  const queries = [];
  const paymentAttemptExpiresAt = "2026-10-23T08:15:00.000Z";
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.startsWith("SELECT COUNT(*)")) return { rows: [{ total: 31 }] };
      return { rows: [{ id: orderId, paymentAttemptExpiresAt }] };
    }
  };
  const request = await startAdminApi(context, pool);
  const response = await request("/gaeru_ceo/orders?status=pending&q=GR-123&paymentStatus=paid&paymentMethod=vnpay&page=2");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.pagination, { page: 2, pageSize: 25, total: 31, pageCount: 2 });
  assert.equal(body.orders[0].paymentAttemptExpiresAt, paymentAttemptExpiresAt);
  assert.deepEqual(queries[0].values, ["pending", "GR-123", "paid", "vnpay"]);
  assert.deepEqual(queries[1].values, ["pending", "GR-123", "paid", "vnpay", 25, 25]);
  const countWhere = queries[0].sql.slice(queries[0].sql.indexOf("WHERE ") + 6).trim();
  const listWhere = queries[1].sql.slice(queries[1].sql.lastIndexOf("WHERE ") + 6).split("GROUP BY")[0].trim();
  assert.equal(listWhere, countWhere);
  assert.match(listWhere, /o.payment_status = \$3/);
  assert.match(listWhere, /o.payment_method = \$4/);
  assert.match(queries[1].sql, /p.expires_at AS "paymentAttemptExpiresAt"/);
  assert.match(queries[1].sql, /SELECT provider, status, expires_at FROM payment_attempts/);
  for (const query of ["paymentStatus=refunded", "paymentMethod=paypal", "paymentStatus=paid&paymentStatus=pending"]) {
    const invalid = await request(`/gaeru_ceo/orders?${query}`);
    assert.equal(invalid.status, 400);
  }
  assert.equal(queries.length, 2);
  for (const paymentMethod of ["cod", "bank_transfer", "9pay", "vnpay"]) {
    const valid = await request(`/gaeru_ceo/orders?paymentStatus=pending&paymentMethod=${paymentMethod}`);
    assert.equal(valid.status, 200);
  }
});
