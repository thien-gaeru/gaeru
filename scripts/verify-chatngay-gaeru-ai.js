'use strict';

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SCREENSHOT_DIR = process.env.GAERU_SCREENSHOT_DIR || path.join(os.homedir(), '.gemini', 'antigravity', 'brain', '470c3e88-af2f-4c7e-9f97-1ee26cfc045b', 'screenshots');

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

(async () => {
  console.log('=== KIỂM THỬ THỰC TẾ CHAT NGAY VỚI GAERU AI ===');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 850 });

    // 1. Mở trang chủ
    await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 1000));

    // 2. Mở hộp thoại "Chat ngay"
    await page.evaluate(() => {
      const btn = document.querySelector('[data-product-chat]');
      if (btn) btn.click();
      else if (window.openChat) window.openChat(null);
    });

    await new Promise(r => setTimeout(r, 1500));

    // 3. Nhập câu hỏi gửi tới GAERU AI
    const textareaSelector = '#customer-chat-body';
    await page.waitForSelector(textareaSelector, { timeout: 5000 });
    await page.type(textareaSelector, 'Tư vấn giúp mình micro GAERU P01 cho iPhone 15 và cách lọc tiếng ồn ngoài đường');
    await new Promise(r => setTimeout(r, 300));

    // Bấm nút gửi
    await page.evaluate(() => {
      const form = document.querySelector('form[data-chat-compose]');
      const sendBtn = form ? form.querySelector('button[type="submit"]') : null;
      if (sendBtn) sendBtn.click();
    });

    console.log('Đã gửi câu hỏi tới GAERU AI, đang chờ phản hồi...');

    // Chờ GAERU AI phản hồi (tự động xử lý trong 1-3 giây)
    let replied = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 600));
      replied = await page.evaluate(() => {
        const msgs = document.querySelectorAll('.shopping-message.from-admin');
        for (const m of msgs) {
          const author = m.querySelector('strong')?.textContent || '';
          if (author.includes('GAERU AI') && !m.classList.contains('is-ai-typing')) {
            return true;
          }
        }
        return false;
      });
      if (replied) break;
    }

    console.log('Kết quả nhận phản hồi từ GAERU AI:', replied ? 'THÀNH CÔNG' : 'CHỜ THÊM');
    await new Promise(r => setTimeout(r, 800));

    // Chụp ảnh giao diện Chat ngay trên Desktop
    const shot54 = path.join(SCREENSHOT_DIR, '54_ChatNgay_GAERU_AI_Desktop.png');
    await page.screenshot({ path: shot54 });
    console.log('✔ Đã chụp màn hình Desktop Chat ngay với GAERU AI:', shot54);

    // 4. Kiểm tra trên Mobile (iPhone 14)
    const mobilePage = await browser.newPage();
    await mobilePage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await mobilePage.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 1000));

    await mobilePage.evaluate(() => {
      if (window.openChat) window.openChat(null);
    });
    await new Promise(r => setTimeout(r, 1500));

    const mobileShot = path.join(SCREENSHOT_DIR, '55_ChatNgay_GAERU_AI_Mobile.png');
    await mobilePage.screenshot({ path: mobileShot });
    console.log('✔ Đã chụp màn hình Mobile Chat ngay với GAERU AI:', mobileShot);

  } finally {
    await browser.close();
  }

  console.log('=== HOÀN TẤT KIỂM THỬ GIAO DIỆN CHAT NGAY VỚI GAERU AI ===');
})();
