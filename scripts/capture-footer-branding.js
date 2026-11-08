'use strict';

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SCREENSHOT_DIR = process.env.GAERU_SCREENSHOT_DIR || path.join(os.homedir(), '.gemini', 'antigravity', 'brain', '470c3e88-af2f-4c7e-9f97-1ee26cfc045b', 'screenshots');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });

  try {
    const page = await browser.newPage();
    // Mobile footer
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 1000));
    await page.evaluate(() => {
      const f = document.querySelector('.site-footer');
      if (f) {
        f.style.contentVisibility = 'visible';
        f.scrollIntoView({ behavior: 'instant' });
      }
    });
    await new Promise(r => setTimeout(r, 600));
    const mobileFooter = await page.$('.site-footer');
    const shot53 = path.join(SCREENSHOT_DIR, '53_Mobile_Footer_Updated_GAERU_Brand.png');
    if (mobileFooter) {
      await mobileFooter.screenshot({ path: shot53 });
      console.log('Saved 53_Mobile_Footer_Updated_GAERU_Brand.png:', shot53);
    }
  } finally {
    await browser.close();
  }
})();
