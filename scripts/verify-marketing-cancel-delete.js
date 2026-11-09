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

async function verifyMarketingCancelDelete() {
  console.log('=== BẮT ĐẦU KIỂM TRA GIAO DIỆN HỦY/XÓA MARKETING & VOUCHER ===');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
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

  // Seed at least 1 promotion, 1 voucher, 1 campaign if none exists
  try {
    const pCount = (await pool.query('SELECT count(*)::int AS count FROM product_promotions')).rows[0].count;
    if (pCount === 0) {
      const vId = (await pool.query("SELECT id FROM product_variants WHERE active = true LIMIT 1")).rows[0]?.id;
      if (vId) {
        const promo = (await pool.query(`
          INSERT INTO product_promotions (title, type, kind, amount, starts_at, ends_at, active)
          VALUES ('Flash Sale 15% Tai nghe & Mic', 'flash', 'percent', 15, now(), now() + interval '7 days', true)
          RETURNING id
        `)).rows[0];
        await pool.query('INSERT INTO product_promotion_variants (promotion_id, variant_id) VALUES ($1, $2)', [promo.id, vId]);
      }
    }

    const vCount = (await pool.query('SELECT count(*)::int AS count FROM marketing_vouchers')).rows[0].count;
    if (vCount === 0) {
      await pool.query(`
        INSERT INTO marketing_vouchers (code, title, kind, amount, min_spend_vnd, starts_at, ends_at, total_limit, per_customer_limit, public_claim, active)
        VALUES ('GAERU2026', 'Voucher Giảm 50.000 ₫ cho Đơn từ 300K', 'fixed', 50000, 300000, now(), now() + interval '30 days', 100, 1, true, true)
      `);
    }

    const cCount = (await pool.query('SELECT count(*)::int AS count FROM marketing_campaigns')).rows[0].count;
    if (cCount === 0) {
      await pool.query(`
        INSERT INTO marketing_campaigns (title, body, starts_at, ends_at, active)
        VALUES ('Ưu đãi Mừng Mùa Mua Sắm GAERU', 'Nhận ngay mã giảm giá và quà tặng khi đặt hàng các thiết bị âm thanh GAERU chính hãng trong tuần này!', now(), now() + interval '14 days', true)
      `);
    }
  } catch (err) {
    console.warn('Seed warning:', err.message);
  }

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
  console.log(`Server chạy tại: ${baseUrl}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 850 });

    // 1. Đăng nhập trang quản trị
    console.log('1. Đang đăng nhập Admin...');
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

    // 2. Mở tab Marketing
    console.log('2. Mở view Marketing...');
    await page.evaluate(() => {
      window.location.hash = '#marketing';
      const mTab = document.querySelector('[data-view="marketing"]');
      if (mTab) mTab.click();
    });
    await new Promise(r => setTimeout(r, 1200));

    // 3. Chụp ảnh màn hình danh sách Khuyến mại với nút Dừng và Xóa
    const shot67 = path.join(SCREENSHOT_DIR, '67_Admin_Marketing_Cancel_Delete_Buttons.png');
    await page.screenshot({ path: shot67, fullPage: false });
    console.log('   Đã chụp ảnh 67_Admin_Marketing_Cancel_Delete_Buttons.png');

    // 4. Kích hoạt nút Xóa để bật Modal Popup Confirm an toàn
    console.log('3. Bấm nút Xóa để kiểm tra Modal Popup Confirm...');
    await page.evaluate(() => {
      const delBtn = document.querySelector('[data-p-delete]');
      if (delBtn) delBtn.click();
    });
    await new Promise(r => setTimeout(r, 600));

    // 5. Chụp ảnh màn hình Modal Popup Confirm
    const shot68 = path.join(SCREENSHOT_DIR, '68_Admin_Marketing_Confirm_Delete_Popup.png');
    await page.screenshot({ path: shot68, fullPage: false });
    console.log('   Đã chụp ảnh 68_Admin_Marketing_Confirm_Delete_Popup.png');

    // Đóng popup bằng cancel
    await page.evaluate(() => {
      const cancelBtn = document.querySelector('.gaeru-modal-cancel');
      if (cancelBtn) cancelBtn.click();
    });
    await new Promise(r => setTimeout(r, 400));

    // 6. Chuyển sang tab Voucher và chụp ảnh bảng voucher có nút Sửa / Dừng / Xóa
    console.log('4. Chuyển sang tab Voucher...');
    await page.evaluate(() => {
      const vTab = document.querySelector('[data-m-tab="vouchers"]');
      if (vTab) vTab.click();
    });
    await new Promise(r => setTimeout(r, 800));

    const shot69 = path.join(SCREENSHOT_DIR, '69_Admin_Marketing_Vouchers_Table.png');
    await page.screenshot({ path: shot69, fullPage: false });
    console.log('   Đã chụp ảnh 69_Admin_Marketing_Vouchers_Table.png');

  } finally {
    await browser.close();
    await new Promise(r => server.close(r));
    await pool.end();
  }
}

verifyMarketingCancelDelete().catch(e => {
  console.error('Lỗi kiểm tra:', e);
  process.exit(1);
});
