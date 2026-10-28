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

// Locate the outer predicate instead of confusing a nested EXISTS/LATERAL WHERE
// with the paginated query's actual filter.
function outerWhere(sql) {
  let depth=0,start;
  for(const token of sql.matchAll(/'(?:''|[^'])*'|"(?:""|[^"])*"|[()]|\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|LIMIT)\b/gi)){
    const word=token[0];if(word[0]==="'"||word[0]==='"')continue;
    if(word==='('){depth++;continue;}if(word===')'){depth--;continue;}if(depth)continue;
    if(word.toUpperCase()==='WHERE'){start=token.index+word.length;continue;}
    if(start!==undefined)return sql.slice(start,token.index).trim();
  }
  assert.notEqual(start,undefined,'SQL must contain an outer WHERE clause');
  return sql.slice(start).trim();
}

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
          if (sql === "SELECT id FROM products WHERE id=$1 AND deleted_at IS NULL FOR UPDATE") return { rows: [{ id: productId }] };
          if (sql.startsWith("SELECT COUNT(*)")) return { rows: [{ count: activeVariants }] };
          if (sql.startsWith("UPDATE products")) return { rows: [{ id: productId }] };
          return { rows: [] };
        },
        release() {}
      };
      const request = await startAdminApi(subcontext, { connect: async () => client });
      const response = await request(`/gaeru_ceo/products/${productId}`, { method: "PUT", body: productPayload });
      assert.equal(response.status, activeVariants ? 200 : 409);
      const lock = statements.findIndex((sql) => sql === "SELECT id FROM products WHERE id=$1 AND deleted_at IS NULL FOR UPDATE");
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
  const countWhere = outerWhere(queries[0].sql);
  const listWhere = outerWhere(queries[1].sql);
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

test("order workspace validates sorting, paginates and returns global counts", async context => {
  const queries=[];
  const request=await startAdminApi(context,{async query(sql,values){
    queries.push({sql,values});
    if(sql.startsWith('SELECT COUNT(*)'))return {rows:[{total:45}]};
    if(sql.startsWith("SELECT CASE WHEN o.return_completed_at IS NOT NULL THEN 'returned' ELSE o.status END AS status, COUNT"))return {rows:[{status:'pending',total:45},{status:'completed',total:16},{status:'returned',total:3},{status:'cancelled',total:4}]};
    if(sql.startsWith('SELECT count(*)::int AS total FROM orders o WHERE')&&sql.includes("o.status='cancelled' OR EXISTS"))return {rows:[{total:7}]};
    return {rows:[]};
  }});
  for(const sort of ['newest','oldest','highest','lowest']){
    const start=queries.length;
    const response=await request('/gaeru_ceo/orders?overview=1&sort='+sort+'&pageSize=20&page=2&status=pending');
    assert.equal(response.status,200);const body=await response.json();
    assert.deepEqual(body.pagination,{page:2,pageSize:20,total:45,pageCount:3});
    assert.deepEqual(body.overview,{pending:45,completed:16,returned:3,cancelled:4,cancelled_or_returned:7});
    const batch=queries.slice(start),pageQuery=batch.find(q=>q.sql.includes('LIMIT $5 OFFSET $6'));
    assert.ok(pageQuery);assert.deepEqual(pageQuery.values,['pending','','','',20,20]);
    assert.match(pageQuery.sql,/ORDER BY o\.(created_at|total_vnd) (ASC|DESC)/);
    const globals=batch.filter(q=>q!==pageQuery&&!q.sql.startsWith('SELECT COUNT(*)'));
    assert.equal(globals.length,2,'global status groups and cancellation/return count are both queried');
    for(const query of globals){assert.equal(query.values,undefined);assert.doesNotMatch(query.sql,/o.status = \$1/);}
  }
  const count=queries.length;
  for(const suffix of ['sort=drop%20table','pageSize=0','pageSize=1000','pageSize=2.5']){
    assert.equal((await request('/gaeru_ceo/orders?'+suffix)).status,400);
  }
  assert.equal(queries.length,count);
});

test('real PostgreSQL pagination and global workflow counts stay correct with grouped filters and closed returns',async context=>{
 const {PGlite}=require('@electric-sql/pglite'),db=await PGlite.create();
 const pool={async query(sql,args){const r=!args&&sql.includes(';')?(await db.exec(sql)).at(-1):await db.query(sql,args);return {...r,rows:r?.rows||[],rowCount:r?.affectedRows??r?.rows?.length??0};},async connect(){return {query:pool.query,release(){}};}};
 await require('../src/migrate').migrateDatabase(pool);
 const statuses=[...Array(25).fill('pending'),'confirmed','confirmed','processing','processing','shipped','completed','completed','cancelled'],ids=[];
 for(const [index,status]of statuses.entries()){
  const row=(await pool.query("INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,subtotal_vnd,total_vnd,status,payment_status) VALUES($1,$2,'paging@example.invalid','0900000000','Fixture Address','Hà Nội','cod',100000,100000,$3,$4) RETURNING id",['GR-PAGING-'+(index+1),'Buyer-'+(index+1),status,status==='completed'?'paid':'pending'])).rows[0];ids.push(row.id);
 }
 await pool.query("INSERT INTO order_after_sales(order_id,kind,status,reason,resolution) VALUES($1,'return','resolved','Fixture closed return','Fixture return processed')",[ids[30]]);
 await pool.query('UPDATE orders SET return_completed_at=now() WHERE id=$1',[ids[30]]);
 const request=await startAdminApi(context,pool);context.after(()=>db.close());
 const ready=await(await request('/gaeru_ceo/orders?status=ready_to_ship&overview=1&pageSize=20')).json();
 assert.deepEqual(ready.pagination,{page:1,pageSize:20,total:4,pageCount:1});assert.deepEqual(new Set(ready.orders.map(o=>o.id)),new Set(ids.slice(25,29)));
 assert.deepEqual(ready.overview,{pending:25,confirmed:2,processing:2,shipped:1,completed:1,cancelled:1,returned:1,cancelled_or_returned:2});
 const first=await(await request('/gaeru_ceo/orders?status=pending&pageSize=20&page=1')).json(),second=await(await request('/gaeru_ceo/orders?status=pending&pageSize=20&page=2')).json();
 assert.equal(first.orders.length,20);assert.equal(second.orders.length,5);assert.deepEqual(second.pagination,{page:2,pageSize:20,total:25,pageCount:2});assert.equal(new Set([...first.orders,...second.orders].map(o=>o.id)).size,25);
 const searched=await(await request('/gaeru_ceo/orders?status=pending&q=Buyer-2&overview=1&pageSize=20')).json();assert.equal(searched.pagination.total,7);assert.equal(searched.orders.length,7);assert.equal(searched.overview.pending,25,'global counts remain independent of current search');
 const returned=await(await request('/gaeru_ceo/orders?status=cancelled_or_returned&pageSize=20')).json();assert.deepEqual(new Set(returned.orders.map(o=>o.id)),new Set([ids[30],ids[32]]));assert.equal(returned.orders.find(o=>o.id===ids[30]).returnStatus,'returned');
 const completed=await(await request('/gaeru_ceo/orders?status=completed&pageSize=20')).json();assert.deepEqual(completed.orders.map(o=>o.id),[ids[31]]);
});

test('Excel export produces a real workbook with literal text, numeric money and filter scope',async context=>{
 const {unzipSync,strFromU8}=require('fflate');const {parseHTML}=require('linkedom');const queries=[];
 const request=await startAdminApi(context,{async query(sql,values){queries.push({sql,values});return sql.startsWith('SELECT COUNT(*)')?{rows:[{total:1}]}:{rows:[{orderNumber:'=1+1',customerName:'Khách hàng',phone:'0900000000',createdAt:'2026-10-26T00:00:00Z',totalVnd:1200000,status:'pending',paymentMethod:'cod',items:[]}]};}});
 const response=await request('/gaeru_ceo/orders?format=xlsx&scope=all&status=pending');assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/spreadsheetml/);
 const files=unzipSync(new Uint8Array(await response.arrayBuffer()));const sheet=parseHTML(strFromU8(files['xl/worksheets/sheet1.xml'])).document;
 const strings=parseHTML(strFromU8(files['xl/sharedStrings.xml'])).document.querySelectorAll('si');
 const value=id=>{const cell=sheet.querySelector('c[r="'+id+'"]');assert.equal(cell.querySelector('f'),null);return cell.getAttribute('t')==='s'?strings[Number(cell.querySelector('v').textContent)].textContent:cell.querySelector('v').textContent};
 assert.equal(value('A2'),'=1+1');assert.equal(value('D2'),'0900000000');assert.equal(Number(value('P2')),1200000);assert.match(strFromU8(files['xl/worksheets/sheet1.xml']),/autoFilter ref="A1:P2"/);assert.match(strFromU8(files['xl/worksheets/sheet1.xml']),/state="frozen"/);assert.deepEqual(queries[1].values,['pending','','','',5000,0]);
});
