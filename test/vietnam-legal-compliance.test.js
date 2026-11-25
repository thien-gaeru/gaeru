const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

test('Legal page complies with Decree 52/2013/ND-CP & Decree 85/2021/ND-CP mandatory seller disclosure', () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'legal.html'), 'utf8');
  assert.ok(html.includes('GAERU'), 'Must disclose registered business name in Vietnamese');
  assert.ok(html.includes('8836293843-002'), 'Must disclose business registration and tax code');
  assert.ok(html.includes('Thôn 2, Xã Rạng Đông'), 'Must disclose registered address');
  assert.ok(html.includes('082 919 1080'), 'Must disclose official contact hotline');
  assert.ok(html.includes('business@gaeru.com'), 'Must disclose official support email');
  assert.ok(html.includes('Nghị định 52/2013/NĐ-CP'), 'Must cite Decree 52/2013/ND-CP');
  assert.ok(html.includes('Nghị định 85/2021/NĐ-CP'), 'Must cite Decree 85/2021/ND-CP');
  assert.ok(html.includes('online.gov.vn'), 'Must cite Ministry of Industry and Trade portal');
  assert.ok(!html.includes('chưa hoàn tất thủ tục pháp lý áp dụng đối với việc vận hành website bán hàng trực tuyến'), 'Outdated temporary legal disclaimers must be removed');
});

test('Terms of service enforce clear electronic contract formation process under Article 31-43 of Decree 52', () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'terms.html'), 'utf8');
  assert.ok(html.includes('Quy trình giao kết hợp đồng mua bán điện tử'), 'Must define contract formation process');
  assert.ok(html.includes('Rà soát và xác nhận đơn hàng'), 'Must enforce order review step before placement');
  assert.ok(html.includes('Quyền và nghĩa vụ của bên bán'), 'Must specify seller obligations');
  assert.ok(html.includes('Quyền và nghĩa vụ của bên mua'), 'Must specify buyer rights and obligations');
  assert.ok(html.includes('Chính sách hủy đơn hàng'), 'Must define order cancellation policy');
  assert.ok(html.includes('giải quyết khiếu nại và tranh chấp'), 'Must define dispute resolution under VN law');
  assert.ok(!html.includes('Checkout trực tuyến hiện đang tạm khóa'), 'Must not display checkout lock text');
});

test('Delivery and returns policy satisfies Decree 85/2021/ND-CP co-inspection and logistics liability requirements', () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'delivery-returns.html'), 'utf8');
  assert.ok(html.includes('đồng kiểm khi nhận hàng') || html.includes('Đồng kiểm khi nhận'), 'Must offer co-inspection upon receipt');
  assert.ok(html.includes('Phân định trách nhiệm của GAERU và đơn vị logistics'), 'Must define logistics responsibility breakdown');
  assert.ok(html.includes('Đổi trả hàng') || html.includes('đổi mới 1:1'), 'Must define exchange conditions');
  assert.ok(html.includes('Chính sách hoàn tiền'), 'Must define refund policy and timeframe');
  assert.ok(html.includes('12 tháng'), 'Must state 12-month warranty');
});

test('Payment policy transparently discloses authorized VN payment methods and security standards', () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'payment.html'), 'utf8');
  assert.ok(html.includes('COD'), 'Must support COD');
  assert.ok(html.includes('VietQR'), 'Must support automated VietQR bank transfer');
  assert.ok(html.includes('VNPAY'), 'Must support VNPAY');
  assert.ok(html.includes('PCI-DSS') || html.includes('TLS 1.3'), 'Must declare payment data security standards');
});

test('Privacy policy complies with Decree 13/2023/ND-CP Personal Data Protection', () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'privacy.html'), 'utf8');
  assert.ok(html.includes('Nghị định số 13/2023/NĐ-CP') || html.includes('Nghị định 13/2023/NĐ-CP'), 'Must cite Decree 13/2023/ND-CP');
  assert.ok(html.includes('Mục đích thu thập'), 'Must specify collection purposes');
  assert.ok(html.includes('Phạm vi dữ liệu'), 'Must specify data scope');
  assert.ok(html.includes('Thời gian lưu trữ dữ liệu'), 'Must specify retention period');
  assert.ok(html.includes('Quyền của chủ thể dữ liệu'), 'Must state data subject rights');
  assert.ok(html.includes('Quyền được biết') && html.includes('Quyền truy cập'), 'Must detail specific rights');
});

test('Complaints policy satisfies Consumer Rights Protection Law standards', () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'complaints.html'), 'utf8');
  assert.ok(html.includes('Luật Bảo vệ quyền lợi người tiêu dùng'), 'Must cite Consumer Protection Law');
  assert.ok(html.includes('Các kênh tiếp nhận khiếu nại'), 'Must specify intake channels');
  assert.ok(html.includes('Quy trình') && html.includes('giải quyết khiếu nại'), 'Must outline resolution process');
});

test('Store footer shell contains registered business info under Article 29 of Decree 52', () => {
  const js = fs.readFileSync(path.join(ROOT_DIR, 'store-shell.js'), 'utf8');
  assert.ok(js.includes('8836293843-002'), 'Footer must contain business registration and tax code');
  assert.ok(js.includes('Thôn 2, Xã Rạng Đông'), 'Footer must contain registered address');
  assert.ok(js.includes('Nghị định 52/2013/NĐ-CP'), 'Footer must state Decree 52 compliance');
});

test('GAERU Xu policy complies with Decree 81/2018/ND-CP, Decree 52/2024/ND-CP & Consumer Protection standards', () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'gaeru-xu.html'), 'utf8');
  assert.ok(html.includes('Nghị định số 81/2018/NĐ-CP') || html.includes('Nghị định 81/2018/NĐ-CP'), 'Must cite Trade Promotion Decree 81/2018/ND-CP');
  assert.ok(html.includes('50%'), 'Must enforce maximum 50% discount cap under Article 8 of Decree 81');
  assert.ok(html.includes('Nghị định số 52/2024/NĐ-CP') || html.includes('Nghị định 52/2024/NĐ-CP'), 'Must cite Non-cash Payment Decree 52/2024/ND-CP');
  assert.ok(html.includes('không phải là tiền pháp định') || html.includes('không phải tiền pháp định') || html.includes('không phải là tiền tệ'), 'Must state GAERU Xu is non-currency reward point');
  assert.ok(html.includes('hoàn tiền') || html.includes('hoàn trả') || html.includes('Hủy đơn hàng'), 'Must define refund and reversal policy for customer protection');
  assert.ok(html.includes('Luật Bảo vệ quyền lợi người tiêu dùng'), 'Must cite Consumer Protection Law');
});

test('2026-11-25 Policy & Operational Alignment: HỘ KINH DOANH GAERU, online.gov.vn review status, no change-mind RMA, accessory warranty exclusion, and 12-month GAERU Xu rolling expiry', async (t) => {
  const legalHtml = fs.readFileSync(path.join(ROOT_DIR, 'legal.html'), 'utf8');
  assert.ok(legalHtml.includes('HỘ KINH DOANH GAERU'), 'Must disclose full registered household business name');
  assert.match(legalHtml, /online\.gov\.vn[\s\S]*đang trong quá trình.*xét duyệt/i, 'Must accurately state MOIT filing is under review');

  const returnsHtml = fs.readFileSync(path.join(ROOT_DIR, 'delivery-returns.html'), 'utf8');
  assert.match(returnsHtml, /không áp dụng đổi\/trả đối với trường hợp khách hàng đổi ý/i, 'Must explicitly exclude change-of-mind returns');
  assert.match(returnsHtml, /GAERU P185[\s\S]*Đầu chuyển đổi[\s\S]*không áp dụng chế độ bảo hành 12 tháng/i, 'Must explicitly exclude P185 and adapters from 12m warranty');

  const { REASON_CATEGORIES } = require('../src/order-after-sales');
  assert.equal('change_mind' in REASON_CATEGORIES, false, 'RMA reason categories must not allow change_mind');

  const { PGlite } = require('@electric-sql/pglite');
  const { migrateDatabase } = require('../src/migrate');
  const { earnPoints, getOrCreateLoyalty, expireDueLoyaltyPoints } = require('../src/loyalty-api');
  const db = await PGlite.create();
  const pool = {
    async query(sql, values) {
      const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
      return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
    },
    async connect() { return { query: pool.query, release() {} }; }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);

  // 1. Accessory items (P185 & Đầu chuyển đổi) do NOT auto-generate 12-month website warranties, while K9 does
  const ord = (await pool.query(
    "INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,subtotal_vnd,total_vnd) VALUES('WAR-ACC-01','Test','t@example.invalid','0912345678','123 Street','Hà Nội','cod',600000,600000) RETURNING id"
  )).rows[0];
  const k9Item = (await pool.query("INSERT INTO order_items(order_id,product_name,variant_name,sku,unit_price_vnd,quantity,line_total_vnd) VALUES($1,'GAERU K9','Type-C','K9-TC',300000,1,300000) RETURNING id", [ord.id])).rows[0];
  const p185Item = (await pool.query("INSERT INTO order_items(order_id,product_name,variant_name,sku,unit_price_vnd,quantity,line_total_vnd) VALUES($1,'GAERU P185','Tiêu chuẩn','P185',250000,1,250000) RETURNING id", [ord.id])).rows[0];
  const adapterItem = (await pool.query("INSERT INTO order_items(order_id,product_name,variant_name,sku,unit_price_vnd,quantity,line_total_vnd) VALUES($1,'Đầu chuyển đổi','Lightning','ADP-LT',50000,1,50000) RETURNING id", [ord.id])).rows[0];

  assert.equal((await pool.query('SELECT count(*)::int AS c FROM warranty_activations WHERE order_item_id=$1', [k9Item.id])).rows[0].c, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS c FROM warranty_activations WHERE order_item_id=$1', [p185Item.id])).rows[0].c, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS c FROM warranty_activations WHERE order_item_id=$1', [adapterItem.id])).rows[0].c, 0);

  // 2. GAERU Xu sets 12-month rolling expiry, extends on new earn, and expires overdue balance while preserving tier
  const cust = (await pool.query("INSERT INTO customers(full_name,email,phone,password_hash) VALUES('Xu Tester','xu@example.invalid','0988777666','hash') RETURNING id")).rows[0];
  await earnPoints(pool, { customerId: cust.id, orderId: ord.id, orderTotalVnd: 12000000 }); // 120,000 Xu -> Silver tier
  let loyalty = (await pool.query('SELECT points_balance, lifetime_earned, tier, expires_at FROM customer_loyalty WHERE customer_id=$1', [cust.id])).rows[0];
  assert.equal(loyalty.points_balance, 120000);
  assert.equal(loyalty.tier, 'silver');
  assert.ok(loyalty.expires_at && new Date(loyalty.expires_at).getTime() > Date.now() + 330 * 86400000, 'Sets ~12 month expiry');

  // Simulate expiry timestamp passing (>12 months)
  await pool.query("UPDATE customer_loyalty SET expires_at = now() - interval '2 days' WHERE customer_id=$1", [cust.id]);
  const expiredCount = await expireDueLoyaltyPoints(pool);
  assert.equal(expiredCount, 1);

  const afterExpire = await getOrCreateLoyalty(pool, cust.id);
  assert.equal(afterExpire.pointsBalance, 0, 'Expired points are zeroed');
  assert.equal(afterExpire.lifetimeEarned, 120000, 'Lifetime earned is preserved');
  assert.equal(afterExpire.tier, 'silver', 'Member tier is never downgraded on expiry');
  assert.equal(afterExpire.expiresAt, null);

  const ledgerExp = (await pool.query("SELECT type, points, balance_after FROM customer_loyalty_ledger WHERE customer_id=$1 AND type='expire'", [cust.id])).rows[0];
  assert.ok(ledgerExp);
  assert.equal(ledgerExp.points, -120000);
  assert.equal(ledgerExp.balance_after, 0);
});
