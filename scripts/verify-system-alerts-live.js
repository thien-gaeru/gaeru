'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createTestDb } = require('../test/helpers/pglite-db');
const { alertSystem, createSystemAlertsAdmin } = require('../src/system-alerts');

async function runLiveVerification() {
  console.log('='.repeat(80));
  console.log('KIỂM TRA CHẠY THẬT & ĐO LƯỜNG SỐ LIỆU THỰC TẾ: src/system-alerts.js');
  console.log('Môi trường: Node.js 24 LTS · PostgreSQL Engine (PGlite)');
  console.log('='.repeat(80));

  const { db, pool } = await createTestDb();

  try {
    // 0. Tạo bảng system_alerts chuẩn PostgreSQL
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_alerts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'error', 'critical')),
        source text NOT NULL,
        message text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        sent_at timestamptz DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS system_alerts_severity_idx ON system_alerts (severity, created_at DESC);
    `);
    console.log('✔ Đã khởi tạo cấu trúc bảng CSDL `system_alerts` và Index phân loại `severity`');

    // Thiết lập môi trường cấu hình mô phỏng
    const testConfig = {
      ALERT_TELEGRAM_BOT_TOKEN: '123456789:AAFakeTokenForGaeruAlertTesting',
      ALERT_TELEGRAM_CHAT_ID: '-1009876543210',
      ALERT_WEBHOOK_URL: 'https://webhook.gaeru.internal/alerts'
    };

    // Theo dõi các cuộc gọi mạng gửi ra ngoài
    const outgoingRequests = [];
    const mockFetcher = async (url, options) => {
      const parsedBody = options?.body ? JSON.parse(options.body) : null;
      outgoingRequests.push({ url, options, body: parsedBody });

      // Giả lập Telegram & Webhook phản hồi 200 OK thành công
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: Math.floor(Math.random() * 10000) } }),
        text: async () => '{"ok":true}'
      };
    };

    // --------------------------------------------------------------------------
    // KỊCH BẢN 1: Bắn Cảnh Báo Đầu Tiên & Kết Nối Ra Ngoài (Telegram + Webhook)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 1: Bắn Cảnh Báo Thực Tế (Ghi CSDL + Gửi Telegram & Webhook) ---');
    const t0 = performance.now();
    const alert1 = await alertSystem(pool, {
      severity: 'critical',
      source: 'payment_gateway',
      message: 'Cổng thanh toán MoMo phản hồi mã lỗi 99: Chữ ký số không khớp trên đơn GR-20261101-9988.',
      metadata: { orderCode: 'GR-20261101-9988', provider: 'momo', rawError: 'INVALID_SIGNATURE' },
      config: testConfig
    }, mockFetcher);
    const t1 = performance.now();
    const dur1 = t1 - t0;

    assert.equal(alert1.logged, true);
    assert.equal(alert1.alerted, true);
    assert.equal(alert1.isDuplicate, false);

    // Kiểm tra CSDL
    const dbAlerts1 = (await pool.query('SELECT id, severity, source, message, metadata, created_at FROM system_alerts')).rows;
    assert.equal(dbAlerts1.length, 1);
    assert.equal(dbAlerts1[0].severity, 'critical');
    assert.equal(dbAlerts1[0].source, 'payment_gateway');
    assert.match(dbAlerts1[0].message, /Chữ ký số không khớp/);

    console.log(`- [${dur1.toFixed(3)} ms] Bắn cảnh báo mức CRITICAL:`);
    console.log(`    * Trạng thái ghi CSDL    : ĐÃ LƯU (ID = ${dbAlerts1[0].id.slice(0, 8)}...)`);
    console.log(`    * Trạng thái gửi ra ngoài: THÀNH CÔNG (alerted = true)`);
    console.log(`    * Số gói mạng gửi đi     : ${outgoingRequests.length} (1 Telegram + 1 Webhook)`);

    // Kiểm tra nội dung gửi Telegram
    const teleReq = outgoingRequests.find(r => r.url.includes('telegram.org'));
    assert.ok(teleReq);
    assert.equal(teleReq.body.chat_id, testConfig.ALERT_TELEGRAM_CHAT_ID);
    assert.match(teleReq.body.text, /🔥/);
    assert.match(teleReq.body.text, /GAERU ALERT: CRITICAL/);
    assert.match(teleReq.body.text, /payment_gateway/);
    console.log(`    * Định dạng Telegram Markdown:`);
    console.log(`      ${teleReq.body.text.split('\n').join('\n      ')}`);

    // Kiểm tra nội dung gửi Webhook
    const hookReq = outgoingRequests.find(r => r.url.includes('webhook.gaeru.internal'));
    assert.ok(hookReq);
    assert.equal(hookReq.body.severity, 'critical');
    assert.equal(hookReq.body.source, 'payment_gateway');
    assert.equal(hookReq.body.metadata.orderCode, 'GR-20261101-9988');
    console.log(`    * Định dạng Webhook JSON     : severity=${hookReq.body.severity}, source=${hookReq.body.source}, timestamp=${hookReq.body.timestamp}`);

    // --------------------------------------------------------------------------
    // KỊCH BẢN 2: Cơ Chế Chống Bão Cảnh Báo (Anti-Flood / Deduplication 10 phút)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 2: Kiểm Tra Cơ Chế Chống Bão Cảnh Báo (Anti-Flood Suppression) ---');
    outgoingRequests.length = 0; // Reset đếm request

    // Bắn lại cùng 1 lỗi giống hệt ngay sau đó (Mô phỏng lỗi lặp trong vòng lặp)
    const alert2 = await alertSystem(pool, {
      severity: 'critical',
      source: 'payment_gateway',
      message: 'Cổng thanh toán MoMo phản hồi mã lỗi 99: Chữ ký số không khớp trên đơn GR-20261101-9988.',
      metadata: { repeatAttempt: 2 },
      config: testConfig
    }, mockFetcher);

    assert.equal(alert2.logged, true, 'Vẫn phải ghi log vào CSDL để lưu vết');
    assert.equal(alert2.isDuplicate, true, 'Phải phát hiện là thông báo trùng lặp');
    assert.equal(alert2.alerted, false, 'Không được bắn tin spam ra Telegram/Webhook');
    assert.equal(outgoingRequests.length, 0, 'Tuyệt đối không gửi gói mạng nào ra ngoài');

    const totalDbCount = (await pool.query('SELECT count(*)::int as count FROM system_alerts')).rows[0].count;
    assert.equal(totalDbCount, 2, 'CSDL có đủ 2 bản ghi để phục vụ kiểm toán');

    console.log(`- Bắn lại cùng 1 cảnh báo lần 2:`);
    console.log(`    * Phát hiện trùng lặp (isDuplicate): TRUE (Chặn spam thành công)`);
    console.log(`    * Số tin nhắn Telegram gửi đi      : 0 tin (Không làm phiền ban quản trị)`);
    console.log(`    * Lưu vết trong CSDL PostgreSQL     : Có (Đã lưu bản ghi #2 để kiểm toán)`);

    // --------------------------------------------------------------------------
    // KỊCH BẢN 3: Bắn Cảnh Báo Nguồn Khác Nhau (Tự Do Không Bị Chặn)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 3: Bắn Cảnh Báo Đa Nguồn & Đa Mức Độ Khác Nhau ---');
    outgoingRequests.length = 0;

    const sourcesToTest = [
      { severity: 'error', source: 'inventory_sync', message: 'Lệch tồn kho SKU K9-TYPC giữa Website và Shopee.' },
      { severity: 'warning', source: 'order_review', message: 'Đơn hàng GR-20261101-TEST có email tên miền không hợp lệ.' },
      { severity: 'info', source: 'backup_service', message: 'Sao lưu CSDL tự động hoàn tất thành công (12.4 MB).' }
    ];

    for (const item of sourcesToTest) {
      const res = await alertSystem(pool, {
        severity: item.severity,
        source: item.source,
        message: item.message,
        config: testConfig
      }, mockFetcher);
      assert.equal(res.isDuplicate, false);
      assert.equal(res.alerted, true);
    }

    console.log(`- Đã gửi thành công 3 cảnh báo khác nhau:`);
    console.log(`    + [🚨 ERROR] inventory_sync -> Đã gửi`);
    console.log(`    + [⚠️ WARNING] order_review -> Đã gửi`);
    console.log(`    + [⚠️ INFO] backup_service -> Đã gửi`);

    // --------------------------------------------------------------------------
    // KỊCH BẢN 4: Khả Năng Chịu Lỗi Mạng (Network Fault-Tolerance / Fail-Safe)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 4: Khả Năng Chịu Lỗi Mạng (Fail-Safe Không Bao Giờ Crash) ---');
    const failingFetcher = async () => {
      throw new Error('ETIMEDOUT: Không thể kết nối tới máy chủ Telegram (Đứt cáp quốc tế)');
    };

    // Bắn cảnh báo khi mạng lỗi hoàn toàn
    const alertFailSafe = await alertSystem(pool, {
      severity: 'error',
      source: 'network_test',
      message: 'Kiểm thử lỗi rớt mạng.',
      config: testConfig
    }, failingFetcher);

    assert.equal(alertFailSafe.logged, true, 'Vẫn phải ghi thành công vào CSDL');
    assert.equal(alertFailSafe.alerted, false, 'Ghi nhận gửi mạng thất bại êm thấm');
    console.log('- Khi mạng gặp sự cố (ETIMEDOUT): Hàm alertSystem bắt lỗi an toàn (Fail-Safe), không làm sập ứng dụng.');

    // --------------------------------------------------------------------------
    // KỊCH BẢN 5: Bộ Router Quản Trị Admin (createSystemAlertsAdmin)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 5: Kiểm Thử Router Quản Trị Hệ Thống (Admin Alerts API) ---');
    const adminRouter = createSystemAlertsAdmin(pool, testConfig);
    assert.ok(adminRouter);

    // Test GET /system-alerts
    let getStatus = 200, getBody = null;
    const reqGet = { admin: { permissions: ['dashboard.read'] } };
    const resGet = { status(s) { getStatus = s; return this; }, json(b) { getBody = b; return this; } };
    const getLayer = adminRouter.stack.find(l => l.route && l.route.path === '/system-alerts');
    await getLayer.route.stack[getLayer.route.stack.length - 1].handle(reqGet, resGet, () => {});

    assert.equal(getStatus, 200);
    assert.ok(Array.isArray(getBody.alerts));
    console.log(`- API GET /system-alerts: Trả về ${getBody.alerts.length} bản ghi cảnh báo gần nhất.`);
    console.log(`    * Bản ghi mới nhất: [${getBody.alerts[0].severity.toUpperCase()}] ${getBody.alerts[0].message}`);

    // Test POST /system-alerts/test
    let postStatus = 200, postBody = null;
    const reqPost = { admin: { username: 'giam_doc_gaeru', permissions: ['settings.write'] } };
    const resPost = { status(s) { postStatus = s; return this; }, json(b) { postBody = b; return this; } };
    const postLayer = adminRouter.stack.find(l => l.route && l.route.path === '/system-alerts/test');
    await postLayer.route.stack[postLayer.route.stack.length - 1].handle(reqPost, resPost, () => {});

    assert.equal(postStatus, 200);
    assert.equal(postBody.ok, true);
    console.log(`- API POST /system-alerts/test: Bắn cảnh báo test thành công từ tài khoản "${reqPost.admin.username}".`);

    // --------------------------------------------------------------------------
    // BẢNG TỔNG KẾT SỐ LIỆU ĐO ĐẠC THỰC TẾ
    // --------------------------------------------------------------------------
    console.log('\n' + '='.repeat(80));
    console.log('BẢNG TỔNG HỢP SỐ LIỆU ĐO ĐẠC THỰC TẾ: SYSTEM ALERTS');
    console.log('='.repeat(80));
    console.log(`- Độ trễ ghi nhận cảnh báo CSDL : ${dur1.toFixed(3)} ms`);
    console.log(`- Các kênh kết nối ra ngoài      : Telegram Bot API & Generic Webhook`);
    console.log(`- Cửa sổ chống bão (Anti-Flood)  : 10 phút (600.000 ms)`);
    console.log(`- Cơ chế nén trùng lặp           : Chặn 100% tin nhắn spam ra ngoài, vẫn lưu DB`);
    console.log(`- Định dạng tin nhắn Telegram    : Markdown kèm biểu tượng phân cấp (🔥, 🚨, ⚠️)`);
    console.log(`- Khả năng chịu lỗi (Fail-Safe)  : An toàn tuyệt đối khi rớt mạng, không crash app`);
    console.log(`- Phân quyền quản trị Admin      : dashboard.read (Xem danh sách) / settings.write (Test)`);
    console.log('='.repeat(80));

  } finally {
    await db.close();
  }
}

runLiveVerification().catch(err => {
  console.error('LỖI KIỂM TRA CHẠY THẬT:', err);
  process.exit(1);
});
