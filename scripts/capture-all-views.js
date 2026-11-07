'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

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

function assertAuditEnvironment(targetUrl = 'http://127.0.0.1:3000/gaeru_ceo', env = process.env) {
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to run screenshot audit script when NODE_ENV=production.');
  }
  const dbUrl = String(env.DATABASE_URL || '');
  if (dbUrl && !/^(?:local-pglite|postgres(?:ql)?:\/\/[^@]*@(?:127\.0\.0\.1|localhost)(?::\d+)?\/)/i.test(dbUrl)) {
    throw new Error('Refusing to run audit script against a non-local DATABASE_URL.');
  }
  const parsed = new URL(env.GAERU_AUDIT_BASE_URL || targetUrl);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error('Audit target URL must be a loopback address (127.0.0.1 or localhost).');
  }
  const auditUser = (env.GAERU_AUDIT_USERNAME || env.GAERU_AUDIT_USER || '').trim();
  const auditPass = env.GAERU_AUDIT_PASSWORD || '';
  if (!auditUser || !auditPass) {
    throw new Error('Missing required environment variables: GAERU_AUDIT_USERNAME (or GAERU_AUDIT_USER) and GAERU_AUDIT_PASSWORD.');
  }
  return { auditUser, auditPass };
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

async function main() {
  const targetUrl = process.env.GAERU_AUDIT_URL || 'http://127.0.0.1:3000/gaeru_ceo';
  const { auditUser, auditPass } = assertAuditEnvironment(targetUrl);
  const outDir = process.env.GAERU_SCREENSHOT_DIR || path.join(__dirname, '..', '.audit-screenshots');
  fs.mkdirSync(outDir, { recursive: true });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaeru-cdp-capture-'));
  const chromePath = resolveChromeBinary();
  const cdpPort = Number(process.env.GAERU_CDP_PORT) || await getFreeLoopbackPort();

  const args = [
    '--headless=new',
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${tmpDir}`,
    '--window-size=1280,960',
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

    await sendCDP(ws, 'Runtime.evaluate', {
      expression: `(() => {
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
      })()`
    });

    await new Promise((r) => setTimeout(r, 3000));

    const viewsToCapture = [
      { name: 'overview', view: 'overview' },
      { name: 'settings', view: 'settings' },
      { name: 'logistics-rates', view: 'logistics', subTab: 'rates' },
      { name: 'logistics-shipping', view: 'logistics', subTab: 'shipping' },
      { name: 'logistics-payments', view: 'logistics', subTab: 'payments' },
      { name: 'orders', view: 'orders' },
      { name: 'products', view: 'products' },
      { name: 'customers', view: 'customers' },
      { name: 'inventory', view: 'inventory' },
      { name: 'warehouses', view: 'warehouses' },
      { name: 'finance', view: 'finance' },
      { name: 'staff', view: 'staff' },
      { name: 'security', view: 'security' },
      { name: 'marketing', view: 'marketing' }
    ];

    for (const item of viewsToCapture) {
      await sendCDP(ws, 'Runtime.evaluate', {
        expression: `window.GAERUAdmin?.activateView(${JSON.stringify(item.view)})`
      });
      await new Promise((r) => setTimeout(r, 1000));

      if (item.subTab) {
        await sendCDP(ws, 'Runtime.evaluate', {
          expression: `document.querySelector('[data-logistics-tab=${JSON.stringify(item.subTab)}]')?.click()`
        });
        await new Promise((r) => setTimeout(r, 800));
      }

      const { data } = await sendCDP(ws, 'Page.captureScreenshot', { format: 'png' });
      const targetFile = path.join(outDir, `${item.name}.png`);
      fs.writeFileSync(targetFile, Buffer.from(data, 'base64'));
      console.log(`Captured: ${targetFile}`);
    }

    ws.close();
  } finally {
    proc.kill();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error in capture script:', err.message || err);
    process.exit(1);
  });
}

module.exports = { assertAuditEnvironment };
