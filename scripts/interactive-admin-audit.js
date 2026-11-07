'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const outDir = path.join('C:', 'Users', 'imdot', '.gemini', 'antigravity', 'brain', '470c3e88-af2f-4c7e-9f97-1ee26cfc045b', 'screenshots');
fs.mkdirSync(outDir, { recursive: true });

function sendCDP(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1000000);
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id === id) {
          ws.removeEventListener('message', handler);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      } catch (e) {}
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalInPage(ws, expression) {
  const res = await sendCDP(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (res.exceptionDetails) {
    console.warn('Evaluation exception:', res.exceptionDetails.text);
  }
  return res.result?.value;
}

async function captureScreen(ws, filename) {
  const { data } = await sendCDP(ws, 'Page.captureScreenshot', { format: 'png' });
  const targetFile = path.join(outDir, filename);
  fs.writeFileSync(targetFile, Buffer.from(data, 'base64'));
  console.log(`[Captured] ${filename}`);
  return targetFile;
}

async function main() {
  const tmpDir = path.join(__dirname, '..', '.chrome-audit-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  console.log('Starting headless Chrome for deep interactive audit...');
  const proc = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=9222',
    '--user-data-dir=' + tmpDir,
    '--window-size=1440,960',
    '--disable-gpu',
    '--no-sandbox',
    'http://127.0.0.1:3000/gaeru_ceo'
  ]);

  await new Promise((r) => setTimeout(r, 2500));

  const res = await fetch('http://127.0.0.1:9222/json');
  const tabs = await res.json();
  const adminTab = tabs.find((t) => t.url.includes('/gaeru_ceo'));
  if (!adminTab) throw new Error('Could not find admin tab in Chrome');

  console.log('Connecting to WebSocket:', adminTab.webSocketDebuggerUrl);
  const ws = new WebSocket(adminTab.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));

  await sendCDP(ws, 'Page.enable');
  await sendCDP(ws, 'Runtime.enable');
  await sendCDP(ws, 'DOM.enable');

  // Track console logs
  const consoleLogs = [];
  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map((a) => a.value || a.description || '').join(' ');
        consoleLogs.push({ type: msg.params.type, text });
      }
    } catch (_) {}
  });

  console.log('Logging in as gaeru...');
  await evalInPage(ws, `(() => {
    const u = document.querySelector('input[name="username"]');
    const p = document.querySelector('input[name="password"]');
    const f = document.querySelector('#login-form');
    if (u && p && f) {
      u.value = 'gaeru';
      p.value = 'GaeruSecret2026!';
      f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    }
    return false;
  })()`);

  await new Promise((r) => setTimeout(r, 3000));

  const auditFindings = [];

  // ==========================================
  // 1. OVERVIEW
  // ==========================================
  console.log('\n--- 1. Testing Overview ---');
  await evalInPage(ws, `window.GAERUAdmin?.activateView('overview')`);
  await new Promise((r) => setTimeout(r, 1200));
  await captureScreen(ws, '01_overview.png');

  // Check metrics on overview
  const overviewMetrics = await evalInPage(ws, `(() => {
    const cards = Array.from(document.querySelectorAll('#overview-view .metric-card, #overview-view .stat-card, #overview-view .owner-status-card')).map(c => c.textContent.trim().replace(/\\s+/g, ' '));
    return { count: cards.length, cards };
  })()`);
  console.log('Overview metrics:', overviewMetrics.count);

  // ==========================================
  // 2. ORDERS WORKSPACE
  // ==========================================
  console.log('\n--- 2. Testing Orders Workspace ---');
  await evalInPage(ws, `window.GAERUAdmin?.activateView('orders')`);
  await new Promise((r) => setTimeout(r, 1200));
  await captureScreen(ws, '02_orders_list.png');

  // Check filter tabs
  const filterTabs = await evalInPage(ws, `(() => {
    const tabs = document.querySelectorAll('#order-tabs button');
    return Array.from(tabs).map(o => ({ value: o.dataset.orderTab, text: o.textContent.trim() }));
  })()`);
  console.log('Order filter tabs:', (filterTabs || []).map(t => t.text).join(' | '));

  // Open first order modal (Pending order GR-20261107-001)
  console.log('Opening order processing modal for Order 1 (Pending)...');
  const openedModal = await evalInPage(ws, `(() => {
    const btn = document.querySelector('.order-process-button');
    if (btn) { btn.click(); return true; }
    return false;
  })()`);
  await new Promise((r) => setTimeout(r, 1000));
  await captureScreen(ws, '03_order_pending_modal.png');

  // Inspect the 4 steps in modal
  const modalStepper = await evalInPage(ws, `(() => {
    const dialog = document.getElementById('order-processing-dialog');
    if (!dialog) return { found: false };
    const steps = Array.from(dialog.querySelectorAll('.order-process-steps li')).map(li => ({
      text: li.textContent.trim(),
      className: li.className
    }));
    const nextButtons = Array.from(dialog.querySelectorAll('.order-status-buttons button')).map(b => b.textContent.trim());
    return { found: true, steps, nextButtons };
  })()`);
  console.log('Modal Stepper Steps:', modalStepper.steps?.map(s => s.text).join(' -> '));
  console.log('Next Step Choice Buttons:', modalStepper.nextButtons?.join(', '));

  // Advance Order 1: click next step choice button -> click "Lưu cập nhật"
  console.log('Clicking next step button in modal...');
  await evalInPage(ws, `(() => {
    const choiceBtn = document.querySelector('.order-status-buttons button');
    if (choiceBtn) choiceBtn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 500));

  console.log('Submitting order update form...');
  await evalInPage(ws, `(() => {
    const submitBtn = document.querySelector('#order-processing-dialog button[type="submit"]');
    if (submitBtn) submitBtn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 1500));
  await captureScreen(ws, '04_order_processing_saved.png');

  // Now open Order 3 (Shipped with Viettel Post waybill)
  console.log('Opening Order 3 (Shipped with Viettel Post waybill)...');
  await evalInPage(ws, `(() => {
    const rows = Array.from(document.querySelectorAll('.order-card'));
    const shippedRow = rows.find(r => r.textContent.includes('GR-20261107-003') || r.textContent.includes('156668075672'));
    if (shippedRow) {
      const btn = shippedRow.querySelector('.order-process-button');
      if (btn) { btn.click(); return true; }
    }
    // Fallback: click second process button if any
    const allBtns = document.querySelectorAll('.order-process-button');
    if (allBtns[1]) { allBtns[1].click(); return true; }
    return false;
  })()`);
  await new Promise((r) => setTimeout(r, 1000));
  await captureScreen(ws, '05_order_shipped_waybill.png');

  // Test "Đồng bộ hành trình" on Order 3
  console.log('Testing "Đồng bộ hành trình" button...');
  const syncClicked = await evalInPage(ws, `(() => {
    const syncBtn = document.querySelector('[data-sync-carrier-tracking]');
    if (syncBtn) { syncBtn.click(); return true; }
    return false;
  })()`);
  await new Promise((r) => setTimeout(r, 2000));
  await captureScreen(ws, '06_waybill_sync_result.png');

  // Check waybill feedback text
  const syncFeedback = await evalInPage(ws, `(() => {
    const fb = document.querySelector('.waybill-feedback');
    const gf = document.querySelector('#global-feedback');
    return { waybillFeedback: fb?.textContent.trim(), globalFeedback: gf?.textContent.trim() };
  })()`);
  console.log('Sync feedback:', syncFeedback);

  // Close modal
  await evalInPage(ws, `(() => {
    const closeBtn = document.querySelector('[data-close-order]');
    if (closeBtn) closeBtn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 500));

  // Test Bulk processing modal
  console.log('Testing Bulk Processing modal...');
  await evalInPage(ws, `(() => {
    const checks = document.querySelectorAll('[data-select-order]');
    checks.forEach(c => c.checked = true);
    // trigger change
    if (checks[0]) checks[0].dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 500));

  await evalInPage(ws, `(() => {
    const bulkBtn = document.querySelector('#btn-bulk-process, [data-bulk-process]');
    if (bulkBtn) bulkBtn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 1000));
  await captureScreen(ws, '07_orders_bulk_modal.png');

  // Close bulk dialog
  await evalInPage(ws, `(() => {
    const closeBulk = document.querySelector('[data-close-bulk]');
    if (closeBulk) closeBulk.click();
  })()`);
  await new Promise((r) => setTimeout(r, 500));

  // ==========================================
  // 3. LOGISTICS & PAYMENTS
  // ==========================================
  console.log('\n--- 3. Testing Logistics & Payments ---');
  await evalInPage(ws, `window.GAERUAdmin?.activateView('logistics')`);
  await new Promise((r) => setTimeout(r, 1000));

  // Sub-tab: Rates
  console.log('Viewing Sub-tab: Rates...');
  await evalInPage(ws, `document.querySelector('[data-logistics-tab="rates"]')?.click()`);
  await new Promise((r) => setTimeout(r, 800));
  await captureScreen(ws, '08_logistics_rates.png');

  // Sub-tab: Shipping Carriers
  console.log('Viewing Sub-tab: Shipping Carriers...');
  await evalInPage(ws, `document.querySelector('[data-logistics-tab="shipping"]')?.click()`);
  await new Promise((r) => setTimeout(r, 800));
  await captureScreen(ws, '09_logistics_shipping_carriers.png');

  // Sub-tab: Payment Channels
  console.log('Viewing Sub-tab: Payment Channels...');
  await evalInPage(ws, `document.querySelector('[data-logistics-tab="payments"]')?.click()`);
  await new Promise((r) => setTimeout(r, 800));
  await captureScreen(ws, '10_logistics_payment_channels.png');

  // ==========================================
  // 4. PRODUCTS
  // ==========================================
  console.log('\n--- 4. Testing Products ---');
  await evalInPage(ws, `window.GAERUAdmin?.activateView('products')`);
  await new Promise((r) => setTimeout(r, 1200));
  await captureScreen(ws, '11_products_list.png');

  // ==========================================
  // 5. CUSTOMERS
  // ==========================================
  console.log('\n--- 5. Testing Customers ---');
  await evalInPage(ws, `window.GAERUAdmin?.activateView('customers')`);
  await new Promise((r) => setTimeout(r, 1200));
  await captureScreen(ws, '12_customers_list.png');

  // ==========================================
  // 6. INVENTORY & WAREHOUSES
  // ==========================================
  console.log('\n--- 6. Testing Inventory & Warehouses ---');
  await evalInPage(ws, `window.GAERUAdmin?.activateView('inventory')`);
  await new Promise((r) => setTimeout(r, 1200));
  await captureScreen(ws, '13_inventory.png');

  await evalInPage(ws, `window.GAERUAdmin?.activateView('warehouses')`);
  await new Promise((r) => setTimeout(r, 1200));
  await captureScreen(ws, '14_warehouses.png');

  // ==========================================
  // 7. FINANCE
  // ==========================================
  console.log('\n--- 7. Testing Finance ---');
  await evalInPage(ws, `window.GAERUAdmin?.activateView('finance')`);
  await new Promise((r) => setTimeout(r, 1200));
  await captureScreen(ws, '15_finance_receipts.png');

  // ==========================================
  // 8. STAFF
  // ==========================================
  console.log('\n--- 8. Testing Staff ---');
  await evalInPage(ws, `window.GAERUAdmin?.activateView('staff')`);
  await new Promise((r) => setTimeout(r, 1200));
  await captureScreen(ws, '16_staff_accounts.png');

  // ==========================================
  // 9. SETTINGS & SECURITY
  // ==========================================
  console.log('\n--- 9. Testing Settings & Security ---');
  await evalInPage(ws, `window.GAERUAdmin?.activateView('settings')`);
  await new Promise((r) => setTimeout(r, 1200));
  await captureScreen(ws, '17_settings.png');

  await evalInPage(ws, `window.GAERUAdmin?.activateView('security')`);
  await new Promise((r) => setTimeout(r, 1200));
  await captureScreen(ws, '18_security.png');

  // ==========================================
  // 10. MARKETING & CARE
  // ==========================================
  console.log('\n--- 10. Testing Marketing & Care ---');
  await evalInPage(ws, `window.GAERUAdmin?.activateView('marketing')`);
  await new Promise((r) => setTimeout(r, 1200));
  await captureScreen(ws, '19_marketing.png');

  // Inspect any errors logged in console
  console.log('\n--- Console Logs Recorded During Interactive Session ---');
  const errors = consoleLogs.filter(l => l.type === 'error');
  const warnings = consoleLogs.filter(l => l.type === 'warning');
  console.log(`Total Errors: ${errors.length}, Warnings: ${warnings.length}`);
  if (errors.length) console.log('Errors:', errors);

  ws.close();
  proc.kill();
  console.log('\n[SUCCESS] Completed interactive operations across all admin tabs and views.');
}

main().catch((err) => {
  console.error('Interactive audit execution error:', err);
  process.exit(1);
});
