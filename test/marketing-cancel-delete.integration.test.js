const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const { createApp } = require("../src/app");
const { migrateDatabase } = require("../src/migrate");

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

test("Marketing Cancel & Delete Comprehensive Integration Suite", { timeout: 60000 }, async (context) => {
  const pool = await database();
  await migrateDatabase(pool);

  const app = createApp({
    config: {
      NODE_ENV: "test",
      SESSION_SECRET: randomBytes(48).toString("hex"),
      ADMIN_USERNAME: "marketing-owner",
      ADMIN_PASSWORD_HASH: bcrypt.hashSync("Marketing-owner-password", 4),
      STORE_ORDERS_ENABLED: true
    },
    pool,
    sessionStore: new session.MemoryStore()
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  context.after(async () => {
    await new Promise((r) => server.close(r));
    await pool.end();
  });
  const base = "http://127.0.0.1:" + server.address().port;

  function client() {
    let cookie = "", csrf = "";
    const api = {
      async request(url, method = "GET", body) {
        const response = await fetch(base + url, {
          method,
          headers: {
            Cookie: cookie,
            ...(method !== "GET" ? { "X-CSRF-Token": csrf } : {}),
            ...(body ? { "Content-Type": "application/json" } : {})
          },
          body: body ? JSON.stringify(body) : undefined
        });
        const updatedCookie = response.headers.get("set-cookie");
        if (updatedCookie) cookie = updatedCookie.split(";")[0];
        const data = response.status === 204 ? null : response.headers.get("content-type")?.includes("application/json") ? await response.json() : await response.text();
        if (data?.csrfToken) csrf = data.csrfToken;
        return { status: response.status, data };
      },
      async ok(url, method = "GET", body, expected = 200) {
        const response = await api.request(url, method, body);
        assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(response.data)}`);
        return response.data;
      },
      async login(username, password) {
        await api.ok("/api/csrf");
        return api.ok("/api/auth/login", "POST", { username, password });
      }
    };
    return api;
  }

  const owner = client();
  await owner.login("marketing-owner", "Marketing-owner-password");

  // Create test product and variant for promotions and bundles
  const productRes = await pool.query(
    "INSERT INTO products(slug, name, category, description, active) VALUES('test-prod', 'Test Product', 'audio', 'Desc', true) RETURNING id"
  );
  const productId = productRes.rows[0].id;
  const variantRes1 = await pool.query(
    "INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active) VALUES($1, 'SKU-01', 'Var 1', 500000, 10, true) RETURNING id",
    [productId]
  );
  const variantId1 = variantRes1.rows[0].id;
  const variantRes2 = await pool.query(
    "INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active) VALUES($1, 'SKU-02', 'Var 2', 200000, 10, true) RETURNING id",
    [productId]
  );
  const variantId2 = variantRes2.rows[0].id;

  await context.test("1. Voucher: Cancel and Delete endpoints operate cleanly with FK cleanup", async () => {
    const startsAt = new Date().toISOString();
    const endsAt = new Date(Date.now() + 86400000).toISOString();

    // Create voucher
    const createRes = await owner.ok("/api/gaeru_ceo/marketing/vouchers", "POST", {
      data: {
        code: "CANCELME20",
        title: "Test Cancel Voucher",
        kind: "percent",
        amount: 20,
        maxDiscountVnd: 100000,
        minSpendVnd: 200000,
        startsAt,
        endsAt,
        totalLimit: 50,
        perCustomerLimit: 2,
        publicClaim: true,
        active: true
      }
    }, 201);
    const voucherId = createRes.item.id;
    assert.equal(createRes.item.active, true);

    // Cancel voucher
    const cancelRes = await owner.ok(`/api/gaeru_ceo/marketing/vouchers/${voucherId}/cancel`, "POST", {});
    assert.equal(cancelRes.success, true);
    assert.equal(cancelRes.item.active, false);

    // Check DB
    const dbRow = (await pool.query("SELECT active FROM marketing_vouchers WHERE id = $1", [voucherId])).rows[0];
    assert.equal(dbRow.active, false);

    // Link customer voucher and campaign to test FK cascade deletion
    const custRes = await pool.query("INSERT INTO customers(email, full_name, active) VALUES('cust@test.com', 'Test Cust', true) RETURNING id");
    const custId = custRes.rows[0].id;
    await pool.query("INSERT INTO customer_vouchers(customer_id, voucher_id, source) VALUES($1, $2, 'granted')", [custId, voucherId]);

    // Create a campaign linked to this voucher
    const campRes = await owner.ok("/api/gaeru_ceo/marketing/campaigns", "POST", {
      data: {
        title: "Campaign with Voucher",
        body: "Test campaign content",
        voucherId,
        bannerId: null,
        startsAt,
        endsAt,
        active: true
      }
    }, 201);
    const campaignId = campRes.item.id;

    // Delete voucher
    const delRes = await owner.ok(`/api/gaeru_ceo/marketing/vouchers/${voucherId}`, "DELETE");
    assert.equal(delRes.success, true);

    // Verify voucher is deleted
    const afterDel = (await pool.query("SELECT id FROM marketing_vouchers WHERE id = $1", [voucherId])).rows;
    assert.equal(afterDel.length, 0);

    // Verify customer_vouchers was cleaned
    const custVoucherAfter = (await pool.query("SELECT * FROM customer_vouchers WHERE voucher_id = $1", [voucherId])).rows;
    assert.equal(custVoucherAfter.length, 0);

    // Verify campaign voucher_id was set to NULL
    const campAfter = (await pool.query("SELECT voucher_id FROM marketing_campaigns WHERE id = $1", [campaignId])).rows[0];
    assert.equal(campAfter.voucher_id, null);
  });

  await context.test("2. Marketing Campaign: Cancel and Delete endpoints operate cleanly", async () => {
    const startsAt = new Date().toISOString();
    const endsAt = new Date(Date.now() + 86400000).toISOString();

    const createRes = await owner.ok("/api/gaeru_ceo/marketing/campaigns", "POST", {
      data: {
        title: "Test Campaign for Delete",
        body: "Valid campaign body details",
        voucherId: null,
        bannerId: null,
        startsAt,
        endsAt,
        active: true
      }
    }, 201);
    const campId = createRes.item.id;
    assert.equal(createRes.item.active, true);

    // Cancel
    const cancelRes = await owner.ok(`/api/gaeru_ceo/marketing/campaigns/${campId}/cancel`, "POST", {});
    assert.equal(cancelRes.success, true);
    assert.equal(cancelRes.item.active, false);

    // Delete
    const delRes = await owner.ok(`/api/gaeru_ceo/marketing/campaigns/${campId}`, "DELETE");
    assert.equal(delRes.success, true);

    const afterDel = (await pool.query("SELECT id FROM marketing_campaigns WHERE id = $1", [campId])).rows;
    assert.equal(afterDel.length, 0);
  });

  await context.test("3. Product Promotion & Flash Sale: Cancel and Delete operate cleanly", async () => {
    const startsAt = new Date().toISOString();
    const endsAt = new Date(Date.now() + 86400000).toISOString();

    const createRes = await owner.ok("/api/gaeru_ceo/marketing/promotions", "POST", {
      data: {
        title: "Flash Sale 10%",
        type: "flash",
        kind: "percent",
        amount: 10,
        startsAt,
        endsAt,
        active: true,
        variantIds: [variantId1]
      }
    }, 201);
    const promoId = createRes.item.id;
    assert.equal(createRes.item.active, true);

    // Cancel
    const cancelRes = await owner.ok(`/api/gaeru_ceo/marketing/promotions/${promoId}/cancel`, "POST", {});
    assert.equal(cancelRes.success, true);
    assert.equal(cancelRes.item.active, false);

    // Delete
    const delRes = await owner.ok(`/api/gaeru_ceo/marketing/promotions/${promoId}`, "DELETE");
    assert.equal(delRes.success, true);

    const afterDel = (await pool.query("SELECT id FROM product_promotions WHERE id = $1", [promoId])).rows;
    assert.equal(afterDel.length, 0);
    const variantsAfter = (await pool.query("SELECT * FROM product_promotion_variants WHERE promotion_id = $1", [promoId])).rows;
    assert.equal(variantsAfter.length, 0);
  });

  await context.test("4. Product Bundle: Cancel and Delete endpoints operate cleanly", async () => {
    const startsAt = new Date().toISOString();
    const endsAt = new Date(Date.now() + 86400000).toISOString();

    const createRes = await owner.ok("/api/gaeru_ceo/marketing/bundles", "POST", {
      data: {
        title: "Combo Pro Audio",
        description: "Mua Mic tang tai nghe",
        discountType: "fixed",
        discountValue: 50000,
        startsAt,
        endsAt,
        active: true,
        items: [
          { variantId: variantId1, isPrimary: true, minQuantity: 1 },
          { variantId: variantId2, isPrimary: false, minQuantity: 1 }
        ]
      }
    }, 201);
    const bundleId = createRes.item.id;
    assert.equal(createRes.item.active, true);

    // Cancel
    const cancelRes = await owner.ok(`/api/gaeru_ceo/marketing/bundles/${bundleId}/cancel`, "POST", {});
    assert.equal(cancelRes.success, true);
    assert.equal(cancelRes.item.active, false);

    // Delete
    const delRes = await owner.ok(`/api/gaeru_ceo/marketing/bundles/${bundleId}`, "DELETE");
    assert.equal(delRes.success, true);

    const afterDel = (await pool.query("SELECT id FROM product_bundles WHERE id = $1", [bundleId])).rows;
    assert.equal(afterDel.length, 0);
  });

  await context.test("5. Email Marketing: Delete draft / cancelled campaign operates cleanly", async () => {
    const createRes = await owner.ok("/api/gaeru_ceo/marketing/emails", "POST", {
      data: {
        title: "Draft Email Campaign",
        subject: "Exclusive Offer for Subscribers",
        body: "Hello, enjoy your special gift at GAERU Store!",
        sources: ["subscribers"],
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
        ratePerMinute: 6
      }
    }, 201);
    const emailId = createRes.item.id;
    assert.equal(createRes.item.status, "draft");

    // Delete draft
    const delRes = await owner.ok(`/api/gaeru_ceo/marketing/emails/${emailId}`, "DELETE");
    assert.equal(delRes.success, true);

    const afterDel = (await pool.query("SELECT id FROM marketing_email_campaigns WHERE id = $1", [emailId])).rows;
    assert.equal(afterDel.length, 0);
  });

  await context.test("6. GAERU AI Action Card: cancel_voucher and delete_voucher execution", async () => {
    const startsAt = new Date().toISOString();
    const endsAt = new Date(Date.now() + 86400000).toISOString();

    const createRes = await owner.ok("/api/gaeru_ceo/marketing/vouchers", "POST", {
      data: {
        code: "AICANCEL50",
        title: "AI Voucher Test",
        kind: "fixed",
        amount: 50000,
        maxDiscountVnd: null,
        minSpendVnd: 100000,
        startsAt,
        endsAt,
        totalLimit: 50,
        perCustomerLimit: 1,
        publicClaim: true,
        active: true
      }
    }, 201);
    const voucherId = createRes.item.id;

    // Chat with AI asking to cancel voucher
    const threadRes = await owner.ok("/api/gaeru_ceo/internal-ai/threads", "POST", { title: "Test Cancel Voucher" }, 201);
    const threadId = threadRes.thread.id;

    const chatRes = await owner.ok(`/api/gaeru_ceo/internal-ai/threads/${threadId}/chat`, "POST", {
      question: "hủy voucher AICANCEL50"
    });
    assert.ok(chatRes.actionCard, "AI should propose an Action Card for canceling voucher");
    assert.equal(chatRes.actionCard.actionType, "cancel_voucher");

    // Execute the action card
    const execRes = await owner.ok(`/api/gaeru_ceo/internal-ai/actions/${chatRes.actionCard.id}/execute`, "POST", {});
    assert.equal(execRes.success, true);
    assert.equal(execRes.status, "executed");

    // Verify voucher is now inactive
    const vRow = (await pool.query("SELECT active FROM marketing_vouchers WHERE id = $1", [voucherId])).rows[0];
    assert.equal(vRow.active, false);

    // Chat with AI asking to delete voucher
    const chatDelRes = await owner.ok(`/api/gaeru_ceo/internal-ai/threads/${threadId}/chat`, "POST", {
      question: "xóa voucher AICANCEL50"
    });
    assert.ok(chatDelRes.actionCard, "AI should propose an Action Card for deleting voucher");
    assert.equal(chatDelRes.actionCard.actionType, "delete_voucher");

    // Execute delete action
    const execDelRes = await owner.ok(`/api/gaeru_ceo/internal-ai/actions/${chatDelRes.actionCard.id}/execute`, "POST", {});
    assert.equal(execDelRes.success, true);

    // Verify voucher deleted
    const vAfter = (await pool.query("SELECT id FROM marketing_vouchers WHERE id = $1", [voucherId])).rows;
    assert.equal(vAfter.length, 0);

    // Test AI Action Card for cancel_campaign and delete_campaign
    const campCreateRes = await owner.ok("/api/gaeru_ceo/marketing/campaigns", "POST", {
      data: {
        title: "Chiến dịch Tết 2027",
        body: "Ưu đãi Tết nguyên đán cùng GAERU",
        voucherId: null,
        bannerId: null,
        startsAt,
        endsAt,
        active: true
      }
    }, 201);
    const aiCampId = campCreateRes.item.id;

    // Chat with AI asking to cancel campaign
    const campChatRes = await owner.ok(`/api/gaeru_ceo/internal-ai/threads/${threadId}/chat`, "POST", {
      question: "hủy chiến dịch khuyến mại Tết"
    });
    assert.ok(campChatRes.actionCard, "AI should propose an Action Card for canceling campaign");
    assert.equal(campChatRes.actionCard.actionType, "cancel_campaign");

    const execCampCancel = await owner.ok(`/api/gaeru_ceo/internal-ai/actions/${campChatRes.actionCard.id}/execute`, "POST", {});
    assert.equal(execCampCancel.success, true);
    const campRow = (await pool.query("SELECT active FROM marketing_campaigns WHERE id = $1", [aiCampId])).rows[0];
    assert.equal(campRow.active, false);

    // Chat with AI asking to delete campaign
    const campDelChatRes = await owner.ok(`/api/gaeru_ceo/internal-ai/threads/${threadId}/chat`, "POST", {
      question: "xóa chiến dịch khuyến mại"
    });
    assert.ok(campDelChatRes.actionCard, "AI should propose an Action Card for deleting campaign");
    assert.equal(campDelChatRes.actionCard.actionType, "delete_campaign");

    const execCampDel = await owner.ok(`/api/gaeru_ceo/internal-ai/actions/${campDelChatRes.actionCard.id}/execute`, "POST", {});
    assert.equal(execCampDel.success, true);
    const campAfter = (await pool.query("SELECT id FROM marketing_campaigns WHERE id = $1", [aiCampId])).rows;
    assert.equal(campAfter.length, 0);
  });
});
