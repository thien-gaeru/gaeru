'use strict';

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const SCREENSHOT_DIR = process.env.GAERU_SCREENSHOT_DIR || path.join(os.homedir(), '.gemini', 'antigravity', 'brain', '470c3e88-af2f-4c7e-9f97-1ee26cfc045b', 'screenshots');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function verifyProductSelection() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });

  console.log('Testing GAERU M3 initial load...');
  await page.goto('http://127.0.0.1:3000/product.html?id=gaeru-m3', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-product-main-image]');
  await page.waitForSelector('[data-option-group]');
  // brief pause for animations/renderings to settle
  await new Promise(r => setTimeout(r, 600));

  // 1. Verify M3 initial state
  const m3InitialState = await page.evaluate(() => {
    const mainImg = document.querySelector('[data-product-main-image]');
    const pressedOptions = [...document.querySelectorAll('[data-option-group][aria-pressed="true"]')].map(b => b.textContent.trim());
    const allOptions = [...document.querySelectorAll('[data-option-group]')].map(b => ({
      text: b.textContent.trim(),
      pressed: b.getAttribute('aria-pressed')
    }));
    const stockNote = document.querySelector('[data-stock-note]')?.textContent.trim();
    const buyNowDisabled = document.querySelector('[data-buy-now]')?.disabled;
    const addToCartDisabled = document.querySelector('[data-add-to-cart]')?.disabled;
    const priceText = document.querySelector('[data-selected-price]')?.textContent.trim();
    const pressedThumbs = [...document.querySelectorAll('[data-gallery-image][aria-pressed="true"]')].map(b => b.dataset.galleryImage);

    return {
      mainImgSrc: mainImg?.src,
      pressedOptions,
      allOptions,
      stockNote,
      buyNowDisabled,
      addToCartDisabled,
      priceText,
      pressedThumbs
    };
  });

  console.log('M3 Initial State:', JSON.stringify(m3InitialState, null, 2));

  assert.equal(m3InitialState.pressedOptions.length, 0, 'No option should be pre-selected on initial load');
  assert.ok(m3InitialState.mainImgSrc.includes('m3-home-cutout.webp'), 'Main image must be primary hero image');
  assert.equal(m3InitialState.stockNote, 'Vui lòng chọn phiên bản', 'Stock note must ask user to choose variant');
  assert.equal(m3InitialState.buyNowDisabled, true, 'Buy now button must be disabled');
  assert.equal(m3InitialState.addToCartDisabled, true, 'Add to cart button must be disabled');

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '84_PDP_Initial_No_Preselection_M3.png'), fullPage: false });
  console.log('Captured 84_PDP_Initial_No_Preselection_M3.png');

  // 2. Click Type C
  console.log('Clicking Type C option...');
  await page.click('button[data-option-group="Cổng kết nối"][data-option-value="Type C"]');
  await new Promise(r => setTimeout(r, 300));

  const m3SelectedState = await page.evaluate(() => {
    const mainImg = document.querySelector('[data-product-main-image]');
    const pressedOptions = [...document.querySelectorAll('[data-option-group][aria-pressed="true"]')].map(b => b.textContent.trim());
    const stockNote = document.querySelector('[data-stock-note]')?.textContent.trim();
    const buyNowDisabled = document.querySelector('[data-buy-now]')?.disabled;
    const addToCartDisabled = document.querySelector('[data-add-to-cart]')?.disabled;
    const priceText = document.querySelector('[data-selected-price]')?.textContent.trim();

    return {
      mainImgSrc: mainImg?.src,
      pressedOptions,
      stockNote,
      buyNowDisabled,
      addToCartDisabled,
      priceText
    };
  });

  console.log('M3 Selected State:', JSON.stringify(m3SelectedState, null, 2));

  assert.deepEqual(m3SelectedState.pressedOptions, ['Type C'], 'Only Type C should be pressed');
  assert.equal(m3SelectedState.stockNote, 'Còn hàng', 'Stock note should update to Còn hàng');
  assert.equal(m3SelectedState.buyNowDisabled, false, 'Buy now button should be enabled');
  assert.equal(m3SelectedState.addToCartDisabled, false, 'Add to cart button should be enabled');

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '85_PDP_Option_Selected_M3.png'), fullPage: false });
  console.log('Captured 85_PDP_Option_Selected_M3.png');

  // 3. Testing GAERU K9
  console.log('Testing GAERU K9 initial load...');
  await page.goto('http://127.0.0.1:3000/product.html?id=gaeru-k9', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-product-main-image]');
  await page.waitForSelector('[data-option-group]');
  await new Promise(r => setTimeout(r, 600));

  const k9InitialState = await page.evaluate(() => {
    const mainImg = document.querySelector('[data-product-main-image]');
    const pressedOptions = [...document.querySelectorAll('[data-option-group][aria-pressed="true"]')].map(b => b.textContent.trim());
    const stockNote = document.querySelector('[data-stock-note]')?.textContent.trim();
    const buyNowDisabled = document.querySelector('[data-buy-now]')?.disabled;
    const addToCartDisabled = document.querySelector('[data-add-to-cart]')?.disabled;
    const priceText = document.querySelector('[data-selected-price]')?.textContent.trim();

    return {
      mainImgSrc: mainImg?.src,
      pressedOptions,
      stockNote,
      buyNowDisabled,
      addToCartDisabled,
      priceText
    };
  });

  console.log('K9 Initial State:', JSON.stringify(k9InitialState, null, 2));

  assert.equal(k9InitialState.pressedOptions.length, 0, 'No option should be pre-selected on K9 initial load');
  assert.ok(k9InitialState.mainImgSrc.includes('k9.webp'), 'Main image must be K9 hero image');
  assert.equal(k9InitialState.stockNote, 'Vui lòng chọn phiên bản', 'Stock note must ask user to choose variant');
  assert.equal(k9InitialState.buyNowDisabled, true, 'Buy now button must be disabled');
  assert.equal(k9InitialState.addToCartDisabled, true, 'Add to cart button must be disabled');
  assert.ok(k9InitialState.priceText.includes('289.000'), 'Price text should show initial price range');

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '86_PDP_Initial_No_Preselection_K9.png'), fullPage: false });
  console.log('Captured 86_PDP_Initial_No_Preselection_K9.png');

  // 4. Click Chân Type C on K9
  console.log('Clicking Chân Type C on K9...');
  await page.click('button[data-option-group="Loại Chân Cắm"][data-option-value="Chân Type C"]');
  await new Promise(r => setTimeout(r, 300));

  const k9SelectedState = await page.evaluate(() => {
    const pressedOptions = [...document.querySelectorAll('[data-option-group][aria-pressed="true"]')].map(b => b.textContent.trim());
    const stockNote = document.querySelector('[data-stock-note]')?.textContent.trim();
    const buyNowDisabled = document.querySelector('[data-buy-now]')?.disabled;
    const addToCartDisabled = document.querySelector('[data-add-to-cart]')?.disabled;
    const priceText = document.querySelector('[data-selected-price]')?.textContent.trim();

    return {
      pressedOptions,
      stockNote,
      buyNowDisabled,
      addToCartDisabled,
      priceText
    };
  });

  console.log('K9 Selected State:', JSON.stringify(k9SelectedState, null, 2));

  assert.ok(k9SelectedState.pressedOptions.includes('Chân Type C'), 'Chân Type C must be pressed');
  assert.equal(k9SelectedState.buyNowDisabled, false, 'Buy now button should be enabled');
  assert.equal(k9SelectedState.addToCartDisabled, false, 'Add to cart button should be enabled');

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '87_PDP_Option_Selected_K9.png'), fullPage: false });
  console.log('Captured 87_PDP_Option_Selected_K9.png');

  // 5. Test Deep Link with ?variant=
  console.log('Testing deep link with ?variant=...');
  await page.goto('http://127.0.0.1:3000/product.html?id=gaeru-m3&variant=33b3c0c2-2665-45fc-bd4e-052df0ab1efa', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-product-main-image]');
  await page.waitForSelector('[data-option-group]');
  await new Promise(r => setTimeout(r, 600));

  const deepLinkState = await page.evaluate(() => {
    const pressedOptions = [...document.querySelectorAll('[data-option-group][aria-pressed="true"]')].map(b => b.textContent.trim());
    const buyNowDisabled = document.querySelector('[data-buy-now]')?.disabled;
    return { pressedOptions, buyNowDisabled };
  });
  console.log('Deep link state:', JSON.stringify(deepLinkState));
  assert.deepEqual(deepLinkState.pressedOptions, ['Type C'], 'Deep link should pre-select the variant');
  assert.equal(deepLinkState.buyNowDisabled, false, 'Buy now should be enabled for deep link');
  console.log('Deep link verified successfully!');

  await browser.close();
  console.log('All browser verification tests passed 100%!');
}

verifyProductSelection().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
