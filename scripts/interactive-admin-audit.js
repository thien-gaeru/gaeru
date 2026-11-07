'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { assertAuditEnvironment } = require('./capture-all-views');

function resolveChromeBinary() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe')
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome binary not found. Set CHROME_PATH environment variable.');
  return found;
}

function getFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

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
      } catch (_) {}
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

async function main() {
  const targetUrl = process.env.GAERU_AUDIT_URL || 'http://127.0.0.1:3000/gaeru_ceo';
  const { auditUser, auditPass } = assertAuditEnvironment(targetUrl);
  const allowMutations = process.env.GAERU_AUDIT_ALLOW_MUTATIONS === 'true' && process.env.AUDIT_FIXTURE_DB_ONLY === 'true';
  const outDir = process.env.GAERU_SCREENSHOT_DIR || path.join(__dirname, '..', '.audit-screenshots');
  fs.mkdirSync(outDir, { recursive: true });

  async function captureScreen(ws, filename) {
    const { data } = await sendCDP(ws, 'Page.captureScreenshot', { format: 'png' });
    const targetFile = path.join(outDir, filename);
    fs.writeFileSync(targetFile, Buffer.from(data, 'base64'));
    console.log(`[Captured] ${filename}`);
    return targetFile;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaeru-cdp-audit-'));
  const chromePath = resolveChromeBinary();
  const cdpPort = Number(process.env.GAERU_CDP_PORT) || await getFreeLoopbackPort();

  const args = [
    '--headless=new',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${tmpDir}`,
    '--window-size=1440,960',
    '--disable-gpu'
  ];
  if (process.env.CI === 'true') args.push('--no-sandbox');
  args.push(targetUrl);

  const proc = spawn(chromePath, args);
  try {
    await new Promise((r) => setTimeout(r, 2500));
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
    const tabs = await res.json();
    const adminTab = tabs.find((t) => t.url.includes('/gaeru_ceo'));
    if (!adminTab) throw new Error('Could not find admin tab in headless Chrome');

    const ws = new WebSocket(adminTab.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));

    await sendCDP(ws, 'Page.enable');
    await sendCDP(ws, 'Runtime.enable');
    await sendCDP(ws, 'DOM.enable');

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

    await evalInPage(ws, `(() => {
      const u = document.querySelector('input[name="username"]');
      const p = document.querySelector('input[name="password"]');
      const f = document.querySelector('#login-form');
      if (u && p && f) {
        u.value = ${JSON.stringify(auditUser)};
        p.value = ${JSON.stringify(auditPass)};
        f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return true;
      }
      return false;
    })()`);

    await new Promise((r) => setTimeout(r, 3000));

    await evalInPage(ws, `window.GAERUAdmin?.activateView('overview')`);
    await new Promise((r) => setTimeout(r, 1200));
    await captureScreen(ws, '01_overview.png');

    await evalInPage(ws, `window.GAERUAdmin?.activateView('orders')`);
    await new Promise((r) => setTimeout(r, 1200));
    await captureScreen(ws, '02_orders_list.png');

    await evalInPage(ws, `document.querySelector('.order-process-button')?.click()`);
    await new Promise((r) => setTimeout(r, 1000));
    await captureScreen(ws, '03_order_pending_modal.png');

    if (allowMutations) {
      await evalInPage(ws, `document.querySelector('.order-status-buttons button')?.click()`);
      await new Promise((r) => setTimeout(r, 500));
      await evalInPage(ws, `document.querySelector('#order-processing-dialog button[type="submit"]')?.click()`);
      await new Promise((r) => setTimeout(r, 1500));
      await captureScreen(ws, '04_order_processing_saved.png');
    } else {
      await evalInPage(ws, `document.querySelector('[data-close-order]')?.click()`);
      await new Promise((r) => setTimeout(r, 500));
    }

    for (const [file, view] of [
      ['08_logistics_rates.png', 'logistics'],
      ['11_products_list.png', 'products'],
      ['12_customers_list.png', 'customers'],
      ['13_inventory.png', 'inventory'],
      ['14_warehouses.png', 'warehouses'],
      ['15_finance_receipts.png', 'finance'],
      ['16_staff_accounts.png', 'staff'],
      ['17_settings.png', 'settings'],
      ['18_security.png', 'security'],
      ['19_marketing.png', 'marketing']
    ]) {
      await evalInPage(ws, `window.GAERUAdmin?.activateView(${JSON.stringify(view)})`);
      await new Promise((r) => setTimeout(r, 1000));
      await captureScreen(ws, file);
    }

    const errors = consoleLogs.filter((l) => l.type === 'error');
    console.log(`Total console errors: ${errors.length}`);
    ws.close();
  } finally {
    proc.kill();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Interactive audit execution error:', err.message || err);
    process.exit(1);
  });
}

module.exports = { assertAuditEnvironment };
