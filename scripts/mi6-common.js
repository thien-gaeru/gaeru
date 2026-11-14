const nodeFs = require('node:fs');
const WebSocket = require('ws');

function resolveMi6ControlConfig() {
  const rawOrigin = String(process.env.MI6_CONTROL_ORIGIN || 'https://192.168.31.59:8080').trim().replace(/\/+$/, '');
  const parsedOrigin = new URL(rawOrigin);
  const hostname = parsedOrigin.hostname.toLowerCase();
  const isPrivateLanOrLoopback = hostname === '127.0.0.1'
    || hostname === 'localhost'
    || hostname === '::1'
    || hostname.startsWith('192.168.')
    || hostname.startsWith('10.')
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);

  if (parsedOrigin.protocol === 'http:') {
    if (!isPrivateLanOrLoopback || process.env.ALLOW_INSECURE_LAN_HTTP !== '1') {
      throw new Error('Refusing insecure http:// MI6_CONTROL_ORIGIN without ALLOW_INSECURE_LAN_HTTP=1 on private LAN.');
    }
  } else if (parsedOrigin.protocol !== 'https:') {
    throw new Error(`Unsupported MI6_CONTROL_ORIGIN protocol: ${parsedOrigin.protocol}`);
  }

  const caPath = String(process.env.MI6_CONTROL_CA || '').trim();
  if (caPath && !nodeFs.existsSync(caPath)) {
    throw new Error(`MI6_CONTROL_CA certificate file not found: ${caPath}`);
  }
  const tlsOptions = parsedOrigin.protocol === 'https:'
    ? {
        rejectUnauthorized: true,
        ...(caPath ? { ca: nodeFs.readFileSync(caPath, 'utf8') } : {})
      }
    : {};

  return {
    base: parsedOrigin.origin,
    wsUrl: `${parsedOrigin.protocol === 'https:' ? 'wss:' : 'ws:'}//${parsedOrigin.host}/ws/term`,
    tlsOptions
  };
}

function requireMi6Password() {
  const password = String(process.env.MI6_ADMIN_PASSWORD || '').trim();
  if (!password) {
    throw new Error('MI6_ADMIN_PASSWORD is required (never fall back to PostgreSQL credentials).');
  }
  return password;
}

const { base: BASE, wsUrl: WS_URL, tlsOptions: MI6_TLS_OPTIONS } = resolveMi6ControlConfig();

let cachedCookie = null;

async function getCookie() {
  if (cachedCookie) return cachedCookie;
  const password = requireMi6Password();
  const loginRes = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
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
      },
      ...MI6_TLS_OPTIONS
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
