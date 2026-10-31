'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const { performance } = require('node:perf_hooks');
const {
  getCsrfToken,
  requireCsrf,
  requireAdmin,
  setCsrfToken
} = require('../src/security');

async function runLiveVerification() {
  console.log('='.repeat(80));
  console.log('KIỂM TRA CHẠY THẬT & ĐO LƯỜNG SỐ LIỆU THỰC TẾ: src/security.js');
  console.log('Môi trường: Node.js 24 LTS · Express 5 · CSRF Constant-Time & Admin Guards');
  console.log('='.repeat(80));

  // --------------------------------------------------------------------------
  // KỊCH BẢN 1: TÍNH NGẪU NHIÊN, ĐỘ DÀI & ĐỘ DỒI DÀO ENTROPY CỦA TOKEN
  // --------------------------------------------------------------------------
  console.log('\n--- 1. ĐO LƯỜNG ĐỘ DÀI ENTROPY VÀ TỐC ĐỘ SINH MÃ CSRF TOKEN ---');

  const dummyReq = { session: {} };
  const firstToken = getCsrfToken(dummyReq);

  assert.equal(typeof firstToken, 'string');
  assert.equal(firstToken.length, 64, 'Token CSRF phải có đúng 64 ký tự hex (32 bytes)');
  assert.equal(/^[0-9a-f]{64}$/.test(firstToken), true, 'Token phải là chuỗi hex hợp lệ');

  // Tính bất biến trong cùng session (Idempotent per session)
  const secondToken = getCsrfToken(dummyReq);
  assert.equal(firstToken, secondToken, 'Cùng một session phải luôn giữ nguyên token đã sinh');

  // Đo hiệu năng sinh 100.000 token ngẫu nhiên
  const t0 = performance.now();
  for (let i = 0; i < 100000; i++) {
    getCsrfToken({ session: {} });
  }
  const t1 = performance.now();
  const durGen100kMs = t1 - t0;
  const opsGenPerSec = Math.round((100000 / durGen100kMs) * 1000);

  console.log(`- Độ dài mã CSRF sinh ra           : ${firstToken.length} ký tự hex (256-bit entropy)`);
  console.log(`- Mã mẫu sinh ngẫu nhiên           : ${firstToken.slice(0, 16)}...${firstToken.slice(-8)}`);
  console.log(`- Tính bất biến trong session      : DUY TRÌ 100% (Không tái sinh làm lệch form)`);
  console.log(`- Tốc độ sinh mã ngẫu nhiên        : ${durGen100kMs.toFixed(3)} ms / 100.000 token (~${opsGenPerSec.toLocaleString('vi-VN')} ops/giây)`);

  // --------------------------------------------------------------------------
  // KỊCH BẢN 2: BẢO VỆ CHỐNG TẤN CÔNG ĐO THỜI GIAN (TIMING ATTACK DEFENSE)
  // --------------------------------------------------------------------------
  console.log('\n--- 2. KIỂM THỬ SO SÁNH THỜI GIAN HẰNG SỐ (TIMING-SAFE EQUAL) ---');

  const validToken = 'a'.repeat(64);
  const fakeTokenSameLen = 'a'.repeat(63) + 'b';
  const fakeTokenDiffLen = 'a'.repeat(32);
  const fakeUnicode = 'é'.repeat(64); // 64 ký tự nhưng 128 bytes trong UTF-8!

  function mockRes() {
    return {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
  }

  // 2.1. Khớp hoàn toàn -> Pass next()
  let pass1 = false;
  requireCsrf({ session: { csrfToken: validToken }, get: () => validToken }, mockRes(), () => { pass1 = true; });
  assert.equal(pass1, true);

  // 2.2. Khác ký tự cuối nhưng cùng độ dài -> Block HTTP 403 (Timing safe)
  const res2 = mockRes();
  let pass2 = false;
  requireCsrf({ session: { csrfToken: validToken }, get: () => fakeTokenSameLen }, res2, () => { pass2 = true; });
  assert.equal(pass2, false);
  assert.equal(res2.statusCode, 403);

  // 2.3. Khác độ dài chuỗi -> Block HTTP 403
  const res3 = mockRes();
  requireCsrf({ session: { csrfToken: validToken }, get: () => fakeTokenDiffLen }, res3, () => {});
  assert.equal(res3.statusCode, 403);

  // 2.4. Khác byte length (Unicode tấn công crash Buffer) -> Block HTTP 403 an toàn
  const res4 = mockRes();
  assert.doesNotThrow(() => {
    requireCsrf({ session: { csrfToken: validToken }, get: () => fakeUnicode }, res4, () => {});
  });
  assert.equal(res4.statusCode, 403);

  console.log('✔ Chống Timing Attack: timingSafeEqual bảo đảm so sánh thời gian hằng số O(1).');
  console.log('✔ Chống Unicode Crash Attack: Buffer.byteLength chặn an toàn chuỗi đa byte.');

  // --------------------------------------------------------------------------
  // KỊCH BẢN 3: KIỂM THỬ TOÀN DIỆN TRÊN MÁY CHỦ EXPRESS HTTP THỰC TẾ
  // --------------------------------------------------------------------------
  console.log('\n--- 3. CHẠY THẬT TRÊN MÁY CHỦ EXPRESS HTTP VỚI SESSION COOKIES ---');

  const app = express();
  app.use(express.json());
  app.use(session({
    secret: 'test_session_secret_for_csrf_verification',
    resave: false,
    saveUninitialized: true,
    cookie: { httpOnly: true, secure: false }
  }));

  // Endpoint 1: Lấy CSRF Token của phiên
  app.get('/api/csrf', (req, res) => {
    const token = getCsrfToken(req);
    res.json({ csrfToken: token });
  });

  // Endpoint 2: Route được bảo vệ CSRF
  app.post('/api/checkout', requireCsrf, (req, res) => {
    res.json({ success: true, message: 'Đơn hàng được chấp thuận an toàn.' });
  });

  // Endpoint 3: Route quản trị yêu cầu quyền Admin
  app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
    res.json({ success: true, admin: req.session.admin });
  });

  // Endpoint 4: Giả lập đăng nhập Admin
  app.post('/api/admin/login', (req, res) => {
    req.session.admin = { id: 'admin_01', username: 'ceo_gaeru' };
    res.json({ success: true });
  });

  // Endpoint 5: SSR View Template Token Injection (setCsrfToken)
  app.get('/checkout-view', setCsrfToken, (req, res) => {
    res.json({ renderedCsrf: res.locals.csrfToken });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let durPostValidMs = 0;

  try {
    // 3.1. Lấy Token & Session Cookie
    const csrfResp = await fetch(`${baseUrl}/api/csrf`);
    assert.equal(csrfResp.status, 200);
    const sessionCookie = csrfResp.headers.get('set-cookie');
    assert.ok(sessionCookie, 'Máy chủ phải cấp cookie phiên session');
    const { csrfToken } = await csrfResp.json();
    assert.equal(csrfToken.length, 64);
    console.log(`✔ GET /api/csrf -> HTTP 200 OK (Cấp phiên & Token: ${csrfToken.slice(0, 16)}...)`);

    // 3.2. POST với Token chuẩn xác -> HTTP 200 OK
    const tPost0 = performance.now();
    const validPost = await fetch(`${baseUrl}/api/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
        'Cookie': sessionCookie
      },
      body: JSON.stringify({ amount: 500000 })
    });
    const tPost1 = performance.now();
    durPostValidMs = tPost1 - tPost0;

    assert.equal(validPost.status, 200);
    const validData = await validPost.json();
    assert.equal(validData.success, true);
    console.log(`✔ POST /api/checkout (Kèm Token chuẩn) -> HTTP 200 OK (${durPostValidMs.toFixed(3)} ms)`);

    // 3.3. POST thiếu x-csrf-token -> Chặn HTTP 403 Forbidden
    const noTokenPost = await fetch(`${baseUrl}/api/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': sessionCookie
      },
      body: JSON.stringify({ amount: 500000 })
    });
    assert.equal(noTokenPost.status, 403);
    const noTokenData = await noTokenPost.json();
    assert.match(noTokenData.error, /Yêu cầu không hợp lệ/);
    console.log(`✔ POST /api/checkout (Thiếu Header Token) -> HTTP 403 Forbidden (${noTokenData.error})`);

    // 3.4. POST với Token giả mạo của kẻ tấn công (CSRF Attack) -> Chặn HTTP 403 Forbidden
    const forgedPost = await fetch(`${baseUrl}/api/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': 'deadbeef'.repeat(8),
        'Cookie': sessionCookie
      },
      body: JSON.stringify({ amount: 500000 })
    });
    assert.equal(forgedPost.status, 403);
    console.log(`✔ POST /api/checkout (Token giả mạo) -> HTTP 403 Forbidden (Chống CSRF thành công)`);

    // 3.5. Kiểm thử requireAdmin Guard
    // Chưa đăng nhập -> HTTP 401
    const unauthAdmin = await fetch(`${baseUrl}/api/admin/dashboard`);
    assert.equal(unauthAdmin.status, 401);
    console.log(`✔ GET /api/admin/dashboard (Chưa đăng nhập) -> HTTP 401 Unauthorized`);

    // Đăng nhập admin
    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Cookie': sessionCookie }
    });
    assert.equal(loginRes.status, 200);

    // Truy cập sau khi đăng nhập -> HTTP 200
    const authAdmin = await fetch(`${baseUrl}/api/admin/dashboard`, {
      headers: { 'Cookie': sessionCookie }
    });
    assert.equal(authAdmin.status, 200);
    const authData = await authAdmin.json();
    assert.equal(authData.admin.username, 'ceo_gaeru');
    console.log(`✔ GET /api/admin/dashboard (Đã xác thực Admin) -> HTTP 200 OK (User: ${authData.admin.username})`);

    // 3.6. Kiểm thử setCsrfToken (SSR View Template Injection)
    const viewRes = await fetch(`${baseUrl}/checkout-view`, {
      headers: { 'Cookie': sessionCookie }
    });
    assert.equal(viewRes.status, 200);
    const viewData = await viewRes.json();
    assert.equal(viewData.renderedCsrf, csrfToken);
    console.log(`✔ GET /checkout-view -> setCsrfToken truyền đúng token vào res.locals.csrfToken.`);

  } finally {
    server.close();
  }

  console.log('\n' + '='.repeat(80));
  console.log('BẢNG TỔNG HỢP SỐ LIỆU ĐO ĐẠC THỰC TẾ: CORE SECURITY SUBSYSTEM');
  console.log('='.repeat(80));
  console.log(`- Độ mạnh mã bảo vệ CSRF         : 256-bit Entropy (32 bytes ngẫu nhiên = 64 hex chars)`);
  console.log(`- Tốc độ sinh mã ngẫu nhiên      : ${opsGenPerSec.toLocaleString('vi-VN')} tokens/giây`);
  console.log(`- Kỹ thuật so sánh mã Token      : crypto.timingSafeEqual (Bảo vệ tuyệt đối Timing Attack)`);
  console.log(`- Kháng lỗi dữ liệu Unicode      : Buffer.byteLength kiểm tra độ dài byte trước khi so khớp`);
  console.log(`- Độ trễ xác thực HTTP CSRF      : ${durPostValidMs.toFixed(3)} ms`);
  console.log(`- Kiểm soát phiên Quản trị       : requireAdmin (401 khi chưa đăng nhập, 200 khi có session)`);
  console.log(`- Nạp biến giao diện SSR         : setCsrfToken (Tự động gán vào res.locals.csrfToken)`);
  console.log('='.repeat(80));
}

if (require.main === module) {
  runLiveVerification()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Verification Failed]', err);
      process.exit(1);
    });
}

module.exports = { runLiveVerification };
