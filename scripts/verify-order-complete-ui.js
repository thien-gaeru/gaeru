'use strict';

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
require('dotenv').config();

const { createApp } = require('../src/app');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SCREENSHOT_DIR = process.env.GAERU_SCREENSHOT_DIR || path.join(os.homedir(), '.gemini', 'antigravity', 'brain', '470c3e88-af2f-4c7e-9f97-1ee26cfc045b', 'screenshots');

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function verifyOrderCompleteUI() {
  console.log('=== KIỂM TRA QUY TRÌNH HOÀN THÀNH ĐƠN HÀNG TRÊN UI GAERU CEO ===');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5433/gaeru_store'
  });

  const originalQuery = pool.query.bind(pool);
  pool.query = function (sql, params, callback) {
    const q = typeof sql === 'string' ? sql.toLowerCase() : (sql && typeof sql.text === 'string' ? sql.text.toLowerCase() : '');
    if (q.includes('account_security')) {
      const emptyResult = { rows: [], rowCount: 0 };
      if (typeof params === 'function') return params(null, emptyResult);
      if (typeof callback === 'function') return callback(null, emptyResult);
      return Promise.resolve(emptyResult);
    }
    return originalQuery(sql, params, callback);
  };

  const TEST_ORDER_ID = '99999999-8888-7777-6666-555555555555';
  const TEST_ORDER_CODE = 'GAERU-TEST-COMPLETE';

  try {
    // 1. Tạo hoặc reset đơn hàng test ở trạng thái 'shipped' (đang giao hàng)
    await pool.query('DELETE FROM warranty_activations WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = $1)', [TEST_ORDER_ID]);
    await pool.query('DELETE FROM sales_receipts WHERE order_id = $1', [TEST_ORDER_ID]);
    await pool.query('DELETE FROM order_items WHERE order_id = $1', [TEST_ORDER_ID]);
    await pool.query('DELETE FROM orders WHERE id = $1', [TEST_ORDER_ID]);

    const variant = (await pool.query('SELECT id, price_vnd FROM product_variants WHERE active = true LIMIT 1')).rows[0];
    const variantId = variant ? variant.id : '00000000-0000-0000-0000-000000000001';

    await pool.query(`
      INSERT INTO orders (
        id, order_number, customer_name, email, phone, address, city, note,
        payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd,
        created_at, updated_at
      ) VALUES (
        $1, $2, 'Trần Minh Hoàng', 'hoangtm@gaeru.vn', '0987654321', '123 Nguyễn Huệ, Phường Bến Nghé, Quận 1',
        'Hồ Chí Minh', 'Giao giờ hành chính', 'cod', 'pending', 'shipped', 650000, 30000, 680000,
        now() - interval '1 day', now()
      )
    `, [TEST_ORDER_ID, TEST_ORDER_CODE]);

    await pool.query(`
      INSERT INTO order_items (id, order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
      VALUES (gen_random_uuid(), $1, $2, 'Tai nghe Gaeru Air Max', 'Bản Tiêu Chuẩn', 'GAERU-AIRMAX-01', 1, 650000, 650000)
    `, [TEST_ORDER_ID, variantId]);

    console.log('1. Đã chuẩn bị đơn hàng test:', TEST_ORDER_CODE, 'ID:', TEST_ORDER_ID);

    // 2. Khởi tạo server app
    const config = {
      NODE_ENV: 'test',
      PORT: 0,
      SESSION_SECRET: 'test-session-secret-with-at-least-32-characters',
      ADMIN_USERNAME: 'ceo_gaeru',
      ADMIN_PASSWORD_HASH: bcrypt.hashSync('CeoGaeru@2026', 4),
      PUBLIC_BASE_URL: 'http://127.0.0.1:3000'
    };

    const app = createApp({
      config,
      pool,
      sessionStore: new session.MemoryStore()
    });

    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    console.log(`2. Test server chạy tại: ${baseUrl}`);

    // 3. Khởi chạy Puppeteer
    const browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
    });

    try {
      const page = await browser.newPage();
      page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
      page.on('pageerror', err => console.log('BROWSER ERROR:', err.message));
      await page.setViewport({ width: 1440, height: 900 });

      // Đăng nhập Admin
      console.log('3. Đăng nhập trang quản trị...');
      await page.goto(`${baseUrl}/gaeru_ceo`, { waitUntil: 'networkidle2' });
      await page.waitForSelector('input[name="username"]', { timeout: 8000 });
      await page.type('input[name="username"]', 'ceo_gaeru');
      await page.type('input[name="password"]', 'CeoGaeru@2026');
      await page.click('button[type="submit"]');

      await page.waitForFunction(() => {
        const appEl = document.getElementById('admin-app');
        return appEl && !appEl.hidden && window.getComputedStyle(appEl).display !== 'none';
      }, { timeout: 10000 });
      console.log('   Đăng nhập thành công.');

      // Điều hướng đến danh sách đơn hàng
      console.log('4. Mở tab Quản lý đơn hàng...');
      await page.click('button[data-view="orders"]');
      await new Promise(r => setTimeout(r, 1200));

      // Mở modal xử lý đơn hàng TEST_ORDER_ID
      console.log('5. Mở modal xử lý đơn hàng:', TEST_ORDER_CODE);
      await page.evaluate((orderId) => {
        const btn = document.querySelector(`button[data-process-order="${orderId}"]`);
        if (btn) {
          btn.click();
        } else if (typeof window.openOrderProcessing === 'function') {
          window.openOrderProcessing(orderId);
        }
      }, TEST_ORDER_ID);

      // Chờ modal xử lý đơn hàng hiển thị
      await page.waitForFunction(() => {
        const dialog = document.getElementById('order-processing-dialog');
        return dialog && (dialog.open || window.getComputedStyle(dialog).display !== 'none');
      }, { timeout: 8000 });

      console.log('   Modal xử lý đơn hàng đã mở.');
      await new Promise(r => setTimeout(r, 600));

      // Chụp ảnh màn hình modal trước khi cập nhật
      const screenshotModalBefore = path.join(SCREENSHOT_DIR, '88_Order_Modal_Before_Complete.png');
      await page.screenshot({ path: screenshotModalBefore, fullPage: false });
      console.log('   Đã chụp ảnh:', screenshotModalBefore);

      // 6. Chọn bước "Hoàn thành"
      console.log('6. Chọn bước Hoàn thành (Complete)...');
      const clickedStep = await page.evaluate(() => {
        const completeBtn = document.querySelector('#order-processing-dialog button[data-status-choice="completed"]');
        if (completeBtn) {
          completeBtn.click();
          return true;
        }
        return false;
      });
      console.log('   Đã bấm nút Hoàn thành:', clickedStep);

      await new Promise(r => setTimeout(r, 600));

      // Chụp ảnh màn hình sau khi chọn bước Hoàn thành
      const screenshotModalReady = path.join(SCREENSHOT_DIR, '89_Order_Modal_Ready_To_Complete.png');
      await page.screenshot({ path: screenshotModalReady, fullPage: false });
      console.log('   Đã chụp ảnh:', screenshotModalReady);

      // 7. Bấm "Lưu cập nhật"
      console.log('7. Bấm nút "Lưu cập nhật"...');
      const clicked = await page.evaluate(() => {
        const form = document.querySelector('#order-processing-dialog form[data-order-form]');
        const submitBtn = form ? form.querySelector('button[type="submit"]') : null;
        if (submitBtn) {
          submitBtn.click();
          return true;
        }
        return false;
      });
      console.log('   Đã click submit button:', clicked);

      // 8. Chờ phản hồi hệ thống
      console.log('8. Chờ phản hồi hệ thống...');
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 500));
        const status = await page.evaluate(() => {
          const dialog = document.getElementById('order-processing-dialog');
          const form = dialog ? dialog.querySelector('form[data-order-form]') : null;
          const submitBtn = form ? form.querySelector('button[type="submit"]') : null;
          const feedback = form ? form.querySelector('.feedback') : null;
          const toast = document.querySelector('.gaeru-action-notice, .gaeru-notice, .gaeru-toast');
          return {
            dialogOpen: dialog ? Boolean(dialog.open) : false,
            saving: form ? form.dataset.saving : null,
            btnText: submitBtn ? submitBtn.textContent : null,
            btnDisabled: submitBtn ? submitBtn.disabled : null,
            feedback: feedback ? feedback.textContent : null,
            toast: toast ? toast.textContent : null
          };
        });
        console.log(`   [${i * 0.5}s] Trạng thái:`, JSON.stringify(status));
        if (!status.dialogOpen || (status.toast && status.toast.includes('Đã cập nhật'))) {
          console.log('   => Thành công: Modal đã đóng hoặc Toast đã hiển thị!');
          break;
        }
      }
      await new Promise(r => setTimeout(r, 1200));

      // Chụp ảnh danh sách đơn hàng đã được cập nhật
      const screenshotListAfter = path.join(SCREENSHOT_DIR, '90_Order_List_After_Completed.png');
      await page.screenshot({ path: screenshotListAfter, fullPage: false });
      console.log('   Đã chụp ảnh:', screenshotListAfter);

      // 9. Kiểm tra trực tiếp trong CSDL
      const dbCheck = await pool.query('SELECT status, payment_status, delivered_at FROM orders WHERE id = $1', [TEST_ORDER_ID]);
      const updatedOrder = dbCheck.rows[0];
      console.log('9. Trạng thái trong database sau khi lưu:');
      console.log('   status:', updatedOrder.status);
      console.log('   payment_status:', updatedOrder.payment_status);
      console.log('   delivered_at:', updatedOrder.delivered_at);

      if (updatedOrder.status !== 'completed' || updatedOrder.payment_status !== 'paid') {
        throw new Error(`Đơn hàng chưa đạt completed/paid! Hiện tại: status=${updatedOrder.status}, payment_status=${updatedOrder.payment_status}`);
      }

      const receiptCheck = await pool.query('SELECT id, amount_vnd, method FROM sales_receipts WHERE order_id = $1', [TEST_ORDER_ID]);
      console.log('   sales_receipts:', receiptCheck.rows);
      if (receiptCheck.rows.length === 0) {
        throw new Error('Chưa ghi nhận phiếu thu tiền COD vào sổ cái sales_receipts!');
      }

      console.log('=== TẤT CẢ KIỂM TRA ĐỀU THÀNH CÔNG 100%! ===');
    } finally {
      await browser.close();
      await new Promise(r => server.close(r));
    }
  } finally {
    await pool.end();
  }
}

verifyOrderCompleteUI().catch(err => {
  console.error('LỖI KIỂM TRA:', err);
  process.exit(1);
});
