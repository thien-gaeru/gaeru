const WebSocket = require('ws');

const BASE = 'http://192.168.31.59:8080';
const WS_URL = 'ws://192.168.31.59:8080/ws/term';

async function execCmd(command, timeoutMs = 8000) {
  // 1. Login lấy cookie
  const MI6_PASS = process.env.MI6_ADMIN_PASSWORD || process.env.PGPASSWORD || (process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).password : '');
  const loginRes = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: MI6_PASS })
  });

  const cookieHeader = loginRes.headers.get('set-cookie');
  if (!cookieHeader) throw new Error('Không nhận được cookie đăng nhập');
  const cookie = cookieHeader.split(';')[0];

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
      // 1. Gửi bản tin resize kích thước màn hình
      ws.send(JSON.stringify({ t: 'r', c: 120, r: 40 }));
      // 2. Chờ 300ms rồi gửi lệnh shell
      setTimeout(() => {
        ws.send(JSON.stringify({ t: 'd', d: command + '\r\n' }));
      }, 300);
    });

    ws.on('message', (data) => {
      const text = data.toString('utf8');
      output += text;
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

async function main() {
  console.log('--- CÀI ĐẶT CLOUDFLARED ARM64 TRÊN MI 6 ---');
  const result = await execCmd('wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb -O /tmp/cf.deb && dpkg -i /tmp/cf.deb && rm -f /tmp/cf.deb && cloudflared --version', 25000);
  console.log('OUTPUT:\n' + result);
}

main().catch(console.error);
