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

async function main() {
  const tmpDir = path.join(__dirname, '..', '.chrome-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  
  console.log('Starting headless Chrome...');
  const proc = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=9222',
    '--user-data-dir=' + tmpDir,
    '--window-size=1280,960',
    '--disable-gpu',
    '--no-sandbox',
    'http://127.0.0.1:3000/gaeru_ceo'
  ]);

  await new Promise((r) => setTimeout(r, 2500));

  console.log('Fetching tabs...');
  const res = await fetch('http://127.0.0.1:9222/json');
  const tabs = await res.json();
  const adminTab = tabs.find((t) => t.url.includes('/gaeru_ceo'));
  if (!adminTab) throw new Error('Could not find admin tab in Chrome');

  console.log('Connecting to WebSocket:', adminTab.webSocketDebuggerUrl);
  const ws = new WebSocket(adminTab.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));

  await sendCDP(ws, 'Page.enable');
  await sendCDP(ws, 'Runtime.enable');

  console.log('Logging in as gaeru...');
  await sendCDP(ws, 'Runtime.evaluate', {
    expression: `(() => {
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
    })()`
  });

  // Wait for login to complete and dashboard to load
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
    console.log(`Processing view: ${item.name} (${item.view})...`);
    await sendCDP(ws, 'Runtime.evaluate', {
      expression: `window.GAERUAdmin?.activateView('${item.view}')`
    });
    await new Promise((r) => setTimeout(r, 1000));

    if (item.subTab) {
      await sendCDP(ws, 'Runtime.evaluate', {
        expression: `(() => {
          const btn = document.querySelector('[data-logistics-tab="${item.subTab}"]');
          if (btn) btn.click();
        })()`
      });
      await new Promise((r) => setTimeout(r, 800));
    }

    const { data } = await sendCDP(ws, 'Page.captureScreenshot', { format: 'png' });
    const targetFile = path.join(outDir, `${item.name}.png`);
    fs.writeFileSync(targetFile, Buffer.from(data, 'base64'));
    console.log(`Captured: ${targetFile}`);
  }

  ws.close();
  proc.kill();
  console.log('All views successfully captured in:', outDir);
}

main().catch((err) => {
  console.error('Error in capture script:', err);
  process.exit(1);
});
