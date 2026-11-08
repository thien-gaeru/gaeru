'use strict';

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const os = require('os');

const SCREENSHOT_DIR = process.env.GAERU_SCREENSHOT_DIR || path.join(os.homedir(), '.gemini', 'antigravity', 'brain', '470c3e88-af2f-4c7e-9f97-1ee26cfc045b', 'screenshots');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function testMobileChatHeader() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu']
  });

  const page = await browser.newPage();
  // Mô phỏng đúng kích thước iPhone trong ảnh của người dùng (390 x 844)
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

  await page.goto('http://127.0.0.1:3000/cua-hang', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 600));

  // Mở chat
  await page.evaluate(() => {
    if (window.openChat) window.openChat(null);
  });
  await new Promise(r => setTimeout(r, 1200));

  // Chụp toàn bộ dialog chat trên mobile
  const fullShot = path.join(SCREENSHOT_DIR, '32_Mobile_Chat_Header_KiemTraKhoangCach.png');
  await page.screenshot({ path: fullShot });
  console.log('Saved full mobile chat screenshot:', fullShot);

  // Chụp riêng phần header của dialog chat để soi cận cảnh
  const headerEl = await page.$('.shopping-chat-dialog > header');
  if (headerEl) {
    const headerShot = path.join(SCREENSHOT_DIR, '33_CanCanh_Chat_Header_KhongBiDe.png');
    await headerEl.screenshot({ path: headerShot });
    console.log('Saved header closeup screenshot:', headerShot);
  }

  // Đo khoảng cách tọa độ thực tế (BoundingClientRect) giữa dot và hotline
  const metrics = await page.evaluate(() => {
    const dot = document.querySelector('.shopping-chat-dialog .chat-live-badge');
    const hotline = document.querySelector('.shopping-chat-dialog .chat-hotline-header');
    const title = document.querySelector('.shopping-chat-dialog .chat-header-main h2');
    if (!dot || !hotline || !title) return null;
    const rDot = dot.getBoundingClientRect();
    const rHotline = hotline.getBoundingClientRect();
    const rTitle = title.getBoundingClientRect();
    return {
      titleRight: rTitle.right,
      dotLeft: rDot.left,
      dotRight: rDot.right,
      dotWidth: rDot.width,
      hotlineLeft: rHotline.left,
      hotlineRight: rHotline.right,
      gapTitleToDot: rDot.left - rTitle.right,
      gapDotToHotline: rHotline.left - rDot.right,
      isOverlapping: rHotline.left < rDot.right
    };
  });

  console.log('Bounding Metrics:', metrics);
  await browser.close();

  if (metrics && metrics.isOverlapping) {
    console.error('LỖI: Vẫn còn hiện tượng chồng đè!');
    process.exit(1);
  } else {
    console.log('THÀNH CÔNG: Khoảng cách giữa Dot và Hotline:', metrics?.gapDotToHotline, 'px (Rành mạch, không đè)!');
  }
}

testMobileChatHeader().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
