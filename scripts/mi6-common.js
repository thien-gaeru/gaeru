const WebSocket = require('ws');

const BASE = 'http://192.168.31.59:8080';
const WS_URL = 'ws://192.168.31.59:8080/ws/term';

let cachedCookie = null;

const MI6_PASS = process.env.MI6_ADMIN_PASSWORD || process.env.PGPASSWORD || (process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).password : '');

async function getCookie() {
  if (cachedCookie) return cachedCookie;
  const loginRes = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: MI6_PASS })
  });
  const cookieHeader = loginRes.headers.get('set-cookie');
  if (!cookieHeader) throw new Error('Không nhận được cookie đăng nhập Mi 6');
  cachedCookie = cookieHeader.split(';')[0];
  return cachedCookie;
}

async function execCmd(command, timeoutMs = 8000) {
  const cookie = await getCookie();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, {
      headers: {
        'Cookie': cookie,
        'x-mi6': '1'
      }
    });

    let output = '';
    const timer = setTimeout(() => {
      ws.close();
      resolve(output);
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'r', c: 120, r: 40 }));
      setTimeout(() => {
        ws.send(JSON.stringify({ t: 'd', d: command + '\r\n' }));
      }, 300);
    });

    ws.on('message', (data) => {
      output += data.toString('utf8');
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    ws.on('close', () => {
      clearTimeout(timer);
      resolve(output);
    });
  });
}

module.exports = { execCmd, getCookie };
