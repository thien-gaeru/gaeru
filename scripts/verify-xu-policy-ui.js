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

async function runXuPolicyVerification() {
  console.log('=== KIỂM THỬ GIAO DIỆN CHÍNH SÁCH GAERU XU VÀ CHỤP ẢNH MINH CHỨNG ===');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });

  try {
    const page = await browser.newPage();

    // 1. Desktop - Trang Chính sách GAERU Xu (/chinh-sach/gaeru-xu) - Phần đầu trang
    await page.setViewport({ width: 1280, height: 950 });
    await page.goto('http://127.0.0.1:3000/chinh-sach/gaeru-xu', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 800));

    const shot1 = path.join(SCREENSHOT_DIR, '46_ChinhSach_GAERU_Xu_Desktop_Top.png');
    await page.screenshot({ path: shot1 });
    console.log('✔ Đã chụp Chính sách GAERU Xu (Desktop Top):', shot1);

    // Cuộn xuống xem các điều khoản pháp lý và hạn mức 50%
    await page.evaluate(() => window.scrollBy(0, 750));
    await new Promise(r => setTimeout(r, 400));
    const shot2 = path.join(SCREENSHOT_DIR, '47_ChinhSach_GAERU_Xu_Desktop_Terms.png');
    await page.screenshot({ path: shot2 });
    console.log('✔ Đã chụp Chính sách GAERU Xu (Desktop Điều khoản & Hạn mức 50%):', shot2);

    // 2. Mobile (iPhone 14: 390 x 844)
    await page.setViewport({ width: 390, height: 844, isMobile: true });
    await page.goto('http://127.0.0.1:3000/chinh-sach/gaeru-xu', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 800));

    const shotMobile = path.join(SCREENSHOT_DIR, '48_ChinhSach_GAERU_Xu_Mobile.png');
    await page.screenshot({ path: shotMobile });
    console.log('✔ Đã chụp Chính sách GAERU Xu (Mobile):', shotMobile);

    console.log('=== HOÀN TẤT CHỤP ẢNH MINH CHỨNG CHÍNH SÁCH GAERU XU ===');
  } finally {
    await browser.close();
  }
}

runXuPolicyVerification().catch(err => {
  console.error('Lỗi kiểm thử:', err);
  process.exit(1);
});
