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

async function runFooterVerification() {
  console.log('=== KIỂM THỬ ĐỒNG BỘ CHÂN TRANG (FOOTER) TRÊN TOÀN WEB GAERU ===');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });

  try {
    const page = await browser.newPage();

    // 1. Desktop - Trang chủ (/)
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 800));

    await page.evaluate(() => {
      const f = document.querySelector('.site-footer');
      if (f) {
        f.style.contentVisibility = 'visible';
        f.scrollIntoView({ behavior: 'instant' });
      }
    });
    await new Promise(r => setTimeout(r, 400));
    const footerElem = await page.$('.site-footer');
    if (footerElem) {
      const homeFooterShot = path.join(SCREENSHOT_DIR, '40_Footer_Desktop_Home.png');
      await footerElem.screenshot({ path: homeFooterShot });
      console.log('✔ Đã chụp chân trang Trang chủ (Desktop):', homeFooterShot);
    }

    // 2. Desktop - Trang Chi tiết sản phẩm (/san-pham/gaeru-p01)
    await page.goto('http://127.0.0.1:3000/san-pham/gaeru-p01', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 800));
    await page.evaluate(() => {
      const f = document.querySelector('.site-footer');
      if (f) {
        f.style.contentVisibility = 'visible';
        f.scrollIntoView({ behavior: 'instant' });
      }
    });
    await new Promise(r => setTimeout(r, 400));
    const p01Footer = await page.$('.site-footer');
    if (p01Footer) {
      const p01Shot = path.join(SCREENSHOT_DIR, '41_Footer_Desktop_Product_P01.png');
      await p01Footer.screenshot({ path: p01Shot });
      console.log('✔ Đã chụp chân trang Sản phẩm P01 (Desktop):', p01Shot);
    }

    // 3. Desktop - Trang Chính sách quyền riêng tư (/chinh-sach/quyen-rieng-tu)
    await page.goto('http://127.0.0.1:3000/chinh-sach/quyen-rieng-tu', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 800));
    await page.evaluate(() => {
      const f = document.querySelector('.site-footer');
      if (f) {
        f.style.contentVisibility = 'visible';
        f.scrollIntoView({ behavior: 'instant' });
      }
    });
    await new Promise(r => setTimeout(r, 400));
    const policyFooter = await page.$('.site-footer');
    if (policyFooter) {
      const policyShot = path.join(SCREENSHOT_DIR, '42_Footer_Desktop_Policy.png');
      await policyFooter.screenshot({ path: policyShot });
      console.log('✔ Đã chụp chân trang Trang Chính sách (Desktop):', policyShot);
    }

    // 4. Desktop - Trang Hỗ trợ (/ho-tro)
    await page.goto('http://127.0.0.1:3000/ho-tro', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 800));
    await page.evaluate(() => {
      const f = document.querySelector('.site-footer');
      if (f) {
        f.style.contentVisibility = 'visible';
        f.scrollIntoView({ behavior: 'instant' });
      }
    });
    await new Promise(r => setTimeout(r, 400));
    const supportFooter = await page.$('.site-footer');
    if (supportFooter) {
      const supportShot = path.join(SCREENSHOT_DIR, '43_Footer_Desktop_Support.png');
      await supportFooter.screenshot({ path: supportShot });
      console.log('✔ Đã chụp chân trang Trang Hỗ trợ (Desktop):', supportShot);
    }

    // 5. Mobile (iPhone 14: 390 x 844) - Kiểm tra responsive accordion
    await page.setViewport({ width: 390, height: 844, isMobile: true });
    await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 800));

    await page.evaluate(() => {
      const f = document.querySelector('.site-footer');
      if (f) {
        f.style.contentVisibility = 'visible';
        f.scrollIntoView({ behavior: 'instant' });
      }
    });
    await new Promise(r => setTimeout(r, 500));

    const mobileFooter = await page.$('.site-footer');
    if (mobileFooter) {
      const mobileShot = path.join(SCREENSHOT_DIR, '44_Footer_Mobile_Default.png');
      await mobileFooter.screenshot({ path: mobileShot });
      console.log('✔ Đã chụp chân trang Mobile mặc định:', mobileShot);

      // Mở mục "Khám phá GAERU" trên mobile
      await page.evaluate(() => {
        const col = document.querySelector('details.footer-column');
        if (col) col.open = true;
      });
      await new Promise(r => setTimeout(r, 400));
      const mobileExpandedShot = path.join(SCREENSHOT_DIR, '45_Footer_Mobile_Expanded.png');
      await mobileFooter.screenshot({ path: mobileExpandedShot });
      console.log('✔ Đã chụp chân trang Mobile khi mở Accordion:', mobileExpandedShot);
    }

    console.log('=== HOÀN TẤT KIỂM THỬ VÀ CHỤP ẢNH FOOTER THÀNH CÔNG ===');
  } finally {
    await browser.close();
  }
}

runFooterVerification().catch(err => {
  console.error('Lỗi kiểm thử:', err);
  process.exit(1);
});
