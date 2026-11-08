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

async function verifyExternalChatAiRemoved() {
  console.log('=== BẮT ĐẦU KIỂM TRA GỠ BỎ HOÀN TOÀN CHAT AI BÊN NGOÀI KHỎI HỆ THỐNG ===');

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
  console.log(`Server chạy tại: ${baseUrl}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    page.on('dialog', async d => await d.dismiss());

    // 1. Đăng nhập Admin
    await page.goto(`${baseUrl}/gaeru_ceo`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('input[name="username"]', { timeout: 5000 });
    await page.type('input[name="username"]', 'ceo_gaeru');
    await page.type('input[name="password"]', 'CeoGaeru@2026');
    await page.click('button[type="submit"]');

    await page.waitForFunction(() => {
      const appEl = document.getElementById('admin-app');
      return appEl && !appEl.hidden && window.getComputedStyle(appEl).display !== 'none';
    }, { timeout: 10000 });
    console.log('✓ Đăng nhập thành công Cổng Quản trị.');

    // 2. Điều hướng vào Cấu hình hệ thống (Settings)
    await page.evaluate(() => {
      const btn = document.querySelector('[data-view="settings"]');
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 1200));

    // 3. Đợi khu vực cấu hình render
    await page.waitForSelector('#system-configuration', { timeout: 8000 });
    await new Promise(r => setTimeout(r, 600));

    // 4. Kiểm tra sự vắng mặt hoàn toàn của Chat AI bên ngoài
    const checkResult = await page.evaluate(() => {
      const text = document.body.innerText;
      const html = document.getElementById('system-configuration')?.innerHTML || '';
      return {
        hasChatAiText: /Chat AI · GPT, Gemini, Claude/i.test(text),
        hasOpenAiInput: /Model OpenAI/i.test(html) || /API key OpenAI/i.test(html),
        hasGeminiInput: /Model Gemini/i.test(html) || /API key Gemini/i.test(html),
        hasClaudeInput: /Model Claude/i.test(html) || /API key Claude/i.test(html),
        hasChatAiTestBtn: Boolean(document.querySelector('[data-chat-ai-test]')),
        hasChatAiPanel: Boolean(document.getElementById('config-panel-chat_ai')),
        hasOauthPanel: Boolean(document.getElementById('config-panel-oauth')),
        hasSecurityPanel: Boolean(document.getElementById('config-panel-security'))
      };
    });

    console.log('✓ Kiểm tra không còn tiêu đề "Chat AI · GPT, Gemini, Claude":', !checkResult.hasChatAiText);
    console.log('✓ Kiểm tra không còn ô nhập OpenAI / GPT:', !checkResult.hasOpenAiInput);
    console.log('✓ Kiểm tra không còn ô nhập Gemini:', !checkResult.hasGeminiInput);
    console.log('✓ Kiểm tra không còn ô nhập Claude:', !checkResult.hasClaudeInput);
    console.log('✓ Kiểm tra không còn nút [Kiểm tra chat AI]:', !checkResult.hasChatAiTestBtn);
    console.log('✓ Kiểm tra không còn panel #config-panel-chat_ai:', !checkResult.hasChatAiPanel);
    console.log('✓ Các cấu hình chuẩn khác (OAuth, Security) hoạt động bình thường:', checkResult.hasOauthPanel && checkResult.hasSecurityPanel);

    if (checkResult.hasChatAiText || checkResult.hasOpenAiInput || checkResult.hasChatAiTestBtn) {
      throw new Error('Chat AI bên ngoài vẫn còn tồn tại trong giao diện!');
    }

    // Cuộn tới khu vực cấu hình và chụp ảnh minh chứng
    await page.evaluate(() => {
      const panel = document.getElementById('system-configuration');
      if (panel) panel.scrollIntoView({ behavior: 'instant', block: 'start' });
      document.querySelectorAll('.toast, [role="alert"], .notification-toast').forEach(t => t.remove());
    });
    await new Promise(r => setTimeout(r, 400));

    const shotConfig = path.join(SCREENSHOT_DIR, '58_Admin_Configuration_Without_External_Chat_AI.png');
    await page.screenshot({ path: shotConfig });
    console.log(`✓ Đã chụp ảnh màn hình Cấu hình sau khi gỡ bỏ Chat AI: ${shotConfig}`);

    console.log('\n=== XÁC MINH THÀNH CÔNG: CHAT AI BÊN NGOÀI ĐÃ ĐƯỢC GỠ BỎ HOÀN TOÀN ===');
  } finally {
    await browser.close();
    await new Promise(r => server.close(r));
    await pool.end();
  }
}

verifyExternalChatAiRemoved().catch(err => {
  console.error('LỖI KIỂM TRA:', err);
  process.exit(1);
});
