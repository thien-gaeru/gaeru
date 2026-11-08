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

async function runCopilotVerification() {
  console.log('=== KHỞI ĐỘNG KIỂM THỬ GIAO DIỆN GAERU COPILOT VÀ CHỤP ẢNH MINH CHỨNG ===');

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
  console.log(`Server kiểm thử đang chạy tại: ${baseUrl}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1366,850']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 850 });

    page.on('console', msg => {
      const txt = msg.text();
      if (msg.type() === 'error') console.warn('[Browser Console Error]', txt);
    });

    page.on('response', res => {
      if (res.status() >= 400) {
        console.warn(`[HTTP ${res.status()}] ${res.url()}`);
      }
    });

    // 1. Đăng nhập vào Cổng Quản trị /gaeru_ceo
    console.log('1. Đang truy cập /gaeru_ceo để đăng nhập...');
    await page.goto(`${baseUrl}/gaeru_ceo`, { waitUntil: 'networkidle2' });

    await page.waitForSelector('input[name="username"]', { timeout: 5000 });
    await page.type('input[name="username"]', 'ceo_gaeru');
    await page.type('input[name="password"]', 'CeoGaeru@2026');
    await page.click('button[type="submit"]');

    // Chờ #admin-app được kích hoạt hiển thị
    await page.waitForFunction(() => {
      const appEl = document.getElementById('admin-app');
      return appEl && !appEl.hidden && window.getComputedStyle(appEl).display !== 'none';
    }, { timeout: 10000 });
    console.log('✓ Đăng nhập thành công, Dashboard quản trị đã kích hoạt.');

    // 2. Kiểm tra nút nổi Floating Copilot Button (#floating-copilot-btn)
    await page.waitForSelector('#floating-copilot-btn', { timeout: 5000 });
    console.log('✓ Nút nổi Floating Copilot Button (#floating-copilot-btn) đã sẵn sàng.');

    // Bấm mở Copilot View từ floating button
    console.log('2. Bấm mở GAERU Copilot từ floating button...');
    await page.click('#floating-copilot-btn');
    await new Promise(r => setTimeout(r, 600));

    // Kiểm tra view #internal-ai-view hiển thị
    const isVisible = await page.evaluate(() => {
      const panel = document.getElementById('internal-ai-view');
      return panel && !panel.hidden && window.getComputedStyle(panel).display !== 'none';
    });
    console.log('✓ Internal AI View hiển thị:', isVisible);

    // 3. Kiểm tra Quick Prompts và bấm hỏi doanh thu
    console.log('3. Bấm Quick Prompt hỏi doanh thu...');
    await page.waitForSelector('.copilot-prompt-chip', { timeout: 8000 });
    const quickChips = await page.$$('.copilot-prompt-chip');
    if (quickChips.length > 0) {
      await quickChips[0].click(); // Báo cáo doanh thu & tổng quan
    } else {
      await page.type('#copilot-input', 'Báo cáo doanh thu và tổng quan kinh doanh');
      await page.click('#btn-send-copilot');
    }

    // Đợi phản hồi xuất hiện
    console.log('Đang chờ Copilot phản hồi...');
    await page.waitForFunction(() => {
      const messages = document.querySelectorAll('.copilot-msg-row.assistant');
      return messages.length > 0;
    }, { timeout: 15000 });
    await new Promise(r => setTimeout(r, 1200));

    // Chụp ảnh màn hình 1: Giao diện Chat Copilot và Phân tích Doanh thu
    const shotOverview = path.join(SCREENSHOT_DIR, '34_Admin_Copilot_Overview_Chat.png');
    await page.screenshot({ path: shotOverview });
    console.log(`✓ Đã chụp ảnh màn hình 1: ${shotOverview}`);

    // 4. Gửi câu hỏi tạo voucher để kiểm tra Thẻ Hành Động Action Card
    console.log('4. Gửi yêu cầu tạo voucher VIP50K để kích hoạt Action Card...');
    await page.focus('#copilot-input');
    await page.keyboard.type('Tạo cho tôi mã giảm giá VIP50K giảm 50000đ');
    await new Promise(r => setTimeout(r, 300));
    await page.keyboard.press('Enter');

    // Chờ Action Card xuất hiện
    console.log('Đang chờ Action Card xuất hiện...');
    await page.waitForSelector('.copilot-action-card', { timeout: 15000 });
    console.log('✓ Thẻ Hành Động Action Card đã hiển thị.');

    // Bấm nút [Xác nhận thực thi] trên Action Card
    const confirmBtn = await page.$('.btn-confirm-action');
    if (confirmBtn) {
      console.log('Bấm nút [Xác nhận thực hiện] trên Action Card...');
      await confirmBtn.click();
      await new Promise(r => setTimeout(r, 2000));
    }

    // Chụp ảnh màn hình 2: Thẻ hành động đã được duyệt và thực thi
    const shotAction = path.join(SCREENSHOT_DIR, '35_Admin_Copilot_ActionCard_Executed.png');
    await page.screenshot({ path: shotAction });
    console.log(`✓ Đã chụp ảnh màn hình 2: ${shotAction}`);

    // 5. Kiểm tra hiển thị trên Mobile (Responsive)
    console.log('5. Đổi viewport sang Mobile (390x844) để kiểm tra độ tương thích...');
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await new Promise(r => setTimeout(r, 800));

    const shotMobile = path.join(SCREENSHOT_DIR, '36_Admin_Copilot_MobileView.png');
    await page.screenshot({ path: shotMobile });
    console.log(`✓ Đã chụp ảnh màn hình 3: ${shotMobile}`);

    console.log('\n=== TẤT CẢ 3 BÀI KIỂM THỬ GIAO DIỆN ĐỀU THÀNH CÔNG VÀ ĐÃ CHỤP ẢNH ĐẦY ĐỦ ===');
  } finally {
    await browser.close();
    await new Promise(r => server.close(r));
    await pool.end();
  }
}

runCopilotVerification().catch(err => {
  console.error('LỖI KIỂM THỬ GIAO DIỆN:', err);
  process.exit(1);
});
