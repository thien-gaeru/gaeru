'use strict';
/*
 * GAERU Admin – web administration panel (Node.js, runs as root on the host).
 * Port 8080. Login with the system root password.
 */
const http = require('http');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const os = require('os');

const PORT = Number(process.env.ADMIN_PORT || 8080);
const ROOT = __dirname;
const DATA_DIR = process.env.ADMIN_DATA_DIR || ROOT;
const PUBLIC = path.join(ROOT, 'public');
const NM = path.join(ROOT, 'node_modules');
const APPS = '/storage/apps';
const DEB = '/storage/ubuntu';
const SESSION_TTL = 12 * 3600e3;
const SESSION_IDLE_TTL = 2 * 3600e3;
const CHALLENGE_TTL = 3 * 60e3;
const SETUP_TTL = 10 * 60e3;
const TOTP_FILE = path.join(DATA_DIR, 'totp.json');
const FAILURES_FILE = path.join(DATA_DIR, 'login-failures.json');
let QRCode = null;
for (const qrMod of [path.join(NM, 'qrcode'), path.join(APPS, 'gaeru', 'node_modules', 'qrcode'), 'qrcode']) {
  try { QRCode = require(qrMod); break; } catch {}
}
const ENV = {
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: '/root', LANG: 'C.UTF-8', TERM: 'dumb',
};

// ----------------------------------------------------------------- helpers
function sh(cmd, opts = {}) {
  return new Promise((resolve) => {
    cp.exec(cmd, {
      shell: '/bin/bash', env: ENV, timeout: opts.timeout || 30000,
      maxBuffer: 32 * 1024 * 1024, cwd: opts.cwd || '/root',
    }, (err, out, errOut) => resolve({ code: err ? (err.code || 1) : 0, out: String(out), err: String(errOut) }));
  });
}
function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    const p = cp.spawn(file, args, { env: ENV, cwd: opts.cwd || '/root' });
    let out = '', err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), opts.timeout || 60000);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(t); resolve({ code: 127, out, err: e.message }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    if (opts.input != null) p.stdin.end(opts.input); else p.stdin.end();
  });
}
const rd = (f, def = '') => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return def; } };
const num = (f) => { const v = parseFloat(rd(f)); return isNaN(v) ? null : v; };
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_\-]{0,62}$/;

function statPreserveOpts(filePath) {
  try {
    const st = fs.lstatSync(filePath);
    if (!st.isSymbolicLink()) return { mode: st.mode & 0o7777, uid: st.uid, gid: st.gid };
  } catch {}
  return {};
}
function applyFileOpts(filePath, opts = {}) {
  if (opts.mode !== undefined) {
    try { fs.chmodSync(filePath, opts.mode); } catch {}
  }
  if (opts.uid !== undefined && opts.gid !== undefined) {
    try { fs.chownSync(filePath, opts.uid, opts.gid); } catch {}
  }
}
function writeFileAtomic(filePath, content, opts = {}) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
  try {
    fs.writeFileSync(tmp, content, opts.mode ? { mode: opts.mode } : undefined);
    applyFileOpts(tmp, opts);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

const CF_RAY_RE = /^[0-9a-f]{16}-[A-Z0-9]{3,8}$/i;
function clientIp(req) {
  const ra = (req.socket && req.socket.remoteAddress) || '';
  if (ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1') {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    const ray = String(req.headers['cf-ray'] || '').trim();
    if (cf && CF_RAY_RE.test(ray) && net.isIP(cf)) return cf;
  }
  return ra;
}
function normalizeIp(ip) {
  return String(ip || '').trim().replace(/^::ffff:/i, '');
}
function isTrustedLanClient(req) {
  if (!req || req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for']) {
    return false;
  }
  const ra = normalizeIp(req.socket && req.socket.remoteAddress);
  if (ra === '127.0.0.1' || ra === '::1') return true;
  return /^192\.168\.31\.\d{1,3}$/.test(ra);
}
function checkSameOrigin(req) {
  const sfs = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  if (!host) return false;
  try {
    return new URL(String(origin)).host.toLowerCase() === host;
  } catch {
    return false;
  }
}
function isHttpsReq(req) {
  const xf = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (xf === 'https') return true;
  const cfv = req?.headers?.['cf-visitor'];
  if (cfv) {
    try { if (JSON.parse(String(cfv)).scheme === 'https') return true; } catch {}
  }
  return Boolean(req?.socket?.encrypted);
}
function secHeaders(req, extra = {}) {
  const h = {
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    ...extra,
  };
  if (isHttpsReq(req)) {
    h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return h;
}
function json(res, code, obj, req = null) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, secHeaders(req, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': b.length,
    'Cache-Control': 'no-store',
  }));
  res.end(b);
}
function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []; let settled = false;
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > limit) {
        settled = true;
        reject(new Error('Body too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', (e) => {
      if (!settled) { settled = true; reject(e); }
    });
  });
}
function parseCookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) {
      const k = p.slice(0, i).trim();
      const raw = p.slice(i + 1).trim();
      try { o[k] = decodeURIComponent(raw); } catch { o[k] = raw; }
    }
  });
  return o;
}

// ----------------------------------------------------------------- auth & 2FA TOTP
const sessions = new Map();
const failures = new Map();
const loginChallenges = new Map();
const setupChallenges = new Map();
const MAX_SESSIONS = 128;
const MAX_FAILURE_IPS = 2048;
const MAX_CHALLENGES = 64;
const FAILURE_WINDOW_MS = 900000;
let activeAuthChecks = 0;
const MAX_CONCURRENT_AUTH = 3;

function capMapSize(map, limit) {
  while (map.size >= limit) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

function loadFailuresFromDisk() {
  failures.clear();
  try {
    if (!fs.existsSync(FAILURES_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(FAILURES_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    const now = Date.now();
    for (const [ip, rec] of Object.entries(raw)) {
      if (!rec || typeof rec.n !== 'number' || typeof rec.t !== 'number') continue;
      if (now - rec.t >= FAILURE_WINDOW_MS) continue;
      capMapSize(failures, MAX_FAILURE_IPS);
      failures.set(ip, { n: rec.n, t: rec.t });
    }
  } catch {}
}
function saveFailuresToDisk() {
  try {
    const obj = {};
    for (const [ip, rec] of failures) obj[ip] = rec;
    writeFileAtomic(FAILURES_FILE, JSON.stringify(obj), { mode: 0o600 });
  } catch (e) {
    console.error(new Date().toISOString(), 'Failed saving login failures:', e.message);
  }
}
function failureCooldownMs(n) {
  if (n >= 15) return 900000;
  if (n >= 10) return 300000;
  if (n >= 5) return 60000;
  return 0;
}
function checkIpLockout(ip) {
  const f = failures.get(ip);
  if (!f) return null;
  const cd = failureCooldownMs(f.n);
  if (!cd) return null;
  const elapsed = Date.now() - f.t;
  if (elapsed < cd) {
    const mins = Math.max(1, Math.ceil((cd - elapsed) / 60000));
    return `Sai quá nhiều lần, thử lại sau ${mins} phút`;
  }
  return null;
}
function recordFailure(ip) {
  const f = failures.get(ip) || { n: 0, t: 0 };
  const next = { n: f.n + 1, t: Date.now() };
  capMapSize(failures, MAX_FAILURE_IPS);
  failures.set(ip, next);
  saveFailuresToDisk();
  return next.n;
}
function clearFailure(ip) {
  if (failures.delete(ip)) saveFailuresToDisk();
}
loadFailuresFromDisk();

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[\s=-]+/g, '');
  let bits = 0, value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) return Buffer.alloc(0);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
function generateHotp(secretBuf, counter) {
  const msg = Buffer.alloc(8);
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) {
    msg[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  const hmac = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[off] & 0x7f) << 24) | ((hmac[off + 1] & 0xff) << 16) | ((hmac[off + 2] & 0xff) << 8) | (hmac[off + 3] & 0xff);
  return String(bin % 1000000).padStart(6, '0');
}
function generateTotp(secretB32, nowMs = Date.now()) {
  const buf = base32Decode(secretB32);
  if (!buf.length) return '';
  return generateHotp(buf, Math.floor(nowMs / 30000));
}
function verifyTotp(secretB32, codeRaw, lastStep = null, nowMs = Date.now()) {
  const code = String(codeRaw || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return { ok: false };
  const secretBuf = base32Decode(secretB32);
  if (!secretBuf.length) return { ok: false };
  const curStep = Math.floor(nowMs / 30000);
  const codeBuf = Buffer.from(code, 'utf8');
  for (const offset of [-1, 0, 1]) {
    const step = curStep + offset;
    if (lastStep !== null && step <= lastStep) continue;
    const expected = generateHotp(secretBuf, step);
    if (crypto.timingSafeEqual(codeBuf, Buffer.from(expected, 'utf8'))) {
      return { ok: true, step };
    }
  }
  return { ok: false };
}
function generateBackupCodes(count = 8) {
  const plainCodes = [];
  const hashedEntries = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    plainCodes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHash('sha256').update(`${salt}:${raw}`).digest('hex');
    hashedEntries.push({ salt, hash });
  }
  return { plainCodes, hashedEntries };
}
function consumeBackupCode(cfg, inputRaw) {
  if (!cfg || !Array.isArray(cfg.backupHashes) || !cfg.backupHashes.length) return false;
  const norm = String(inputRaw || '').trim().toUpperCase().replace(/[\s-]+/g, '');
  if (!/^[A-F0-9]{8}$/.test(norm)) return false;
  let matchedIdx = -1;
  for (let i = 0; i < cfg.backupHashes.length; i++) {
    const entry = cfg.backupHashes[i];
    if (!entry || typeof entry.salt !== 'string' || typeof entry.hash !== 'string' || entry.hash.length !== 64) continue;
    const candidate = crypto.createHash('sha256').update(`${entry.salt}:${norm}`).digest('hex');
    if (crypto.timingSafeEqual(Buffer.from(candidate, 'utf8'), Buffer.from(entry.hash, 'utf8')) && matchedIdx === -1) {
      matchedIdx = i;
    }
  }
  if (matchedIdx === -1) return false;
  cfg.backupHashes.splice(matchedIdx, 1);
  return true;
}
function readTotpConfig() {
  try {
    if (!fs.existsSync(TOTP_FILE)) return null;
    const cfg = JSON.parse(fs.readFileSync(TOTP_FILE, 'utf8'));
    if (!cfg || !cfg.enabled || typeof cfg.secret !== 'string' || !cfg.secret) return null;
    if (!Array.isArray(cfg.backupHashes)) cfg.backupHashes = [];
    return cfg;
  } catch {
    return null;
  }
}
function writeTotpConfig(cfg) {
  writeFileAtomic(TOTP_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}
async function createPendingSetup(ip, rekey = false) {
  const secret = base32Encode(crypto.randomBytes(20));
  const { plainCodes, hashedEntries } = generateBackupCodes(8);
  const label = encodeURIComponent('GAERU Admin:root@mi6');
  const issuer = encodeURIComponent('GAERU Admin');
  const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
  let qrDataUrl = null;
  if (QRCode && typeof QRCode.toDataURL === 'function') {
    try { qrDataUrl = await QRCode.toDataURL(otpauthUrl, { width: 220, margin: 1 }); } catch {}
  }
  capMapSize(setupChallenges, MAX_CHALLENGES);
  const setupToken = crypto.randomBytes(24).toString('hex');
  setupChallenges.set(setupToken, {
    secret,
    backupHashes: hashedEntries,
    ip,
    rekey: Boolean(rekey),
    exp: Date.now() + SETUP_TTL,
    attempts: 0,
  });
  return { setupToken, secret, otpauthUrl, qrDataUrl, backupCodes: plainCodes };
}
function issueSessionCookie(req, res) {
  capMapSize(sessions, MAX_SESSIONS);
  const sid = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(sid, { exp: now + SESSION_TTL, idleExp: now + SESSION_IDLE_TTL });
  const sec = isHttpsReq(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `mi6sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}${sec}`);
  return sid;
}

let customPasswordVerifier = null;
async function verifyRootPassword(pw) {
  if (typeof pw !== 'string' || !pw || pw.length > 512 || pw.includes('\0')) return false;
  if (customPasswordVerifier) return Boolean(await customPasswordVerifier(pw));
  if (activeAuthChecks >= MAX_CONCURRENT_AUTH) throw Object.assign(new Error('Máy chủ đang bận xác thực, thử lại sau giây lát'), { status: 503 });
  activeAuthChecks++;
  try {
    const py = 'import crypt,spwd,sys\nh=spwd.getspnam("root").sp_pwd\npw=sys.stdin.read()\nprint("OK" if h and crypt.crypt(pw,h)==h else "NO")';
    const r = await run('python3', ['-c', py], { input: pw, timeout: 10000 });
    return r.out.trim() === 'OK';
  } finally {
    activeAuthChecks = Math.max(0, activeAuthChecks - 1);
  }
}
function authedSession(req, touchIdle = false) {
  const sid = parseCookies(req).mi6sid;
  const s = sid && sessions.get(sid);
  if (!s) return null;
  const now = Date.now();
  if (s.exp < now || s.idleExp < now) { sessions.delete(sid); return null; }
  if (touchIdle) s.idleExp = now + SESSION_IDLE_TTL;
  return s;
}
function authed(req, touchIdle = false) {
  return Boolean(authedSession(req, touchIdle));
}
function revokeOtherSessions(keepSid) {
  let removed = 0;
  for (const k of [...sessions.keys()]) {
    if (k !== keepSid) {
      sessions.delete(k);
      removed++;
    }
  }
  return removed;
}

// ----------------------------------------------------------------- stats
let prevCpu = null, prevNet = null, cpuHist = [], gpuHist = [];
function readCpu() {
  const o = {};
  rd('/proc/stat').split('\n').forEach((l) => {
    if (!l.startsWith('cpu')) return;
    const p = l.trim().split(/\s+/); const name = p[0]; const v = p.slice(1).map(Number);
    const idle = v[3] + (v[4] || 0); const total = v.reduce((a, b) => a + b, 0);
    o[name] = { idle, total };
  });
  return o;
}
function readNet() {
  const o = {};
  rd('/proc/net/dev').split('\n').slice(2).forEach((l) => {
    const [n, rest] = l.split(':'); if (!rest) return;
    const v = rest.trim().split(/\s+/).map(Number);
    o[n.trim()] = { rx: v[0], tx: v[8] };
  });
  return o;
}
let wifiCache = { t: 0, ssid: '' };
async function wifiSsid() {
  if (Date.now() - wifiCache.t > 15000) {
    const r = await sh("nmcli -t -f active,ssid dev wifi 2>/dev/null | grep '^yes' | head -1 | cut -d: -f2-", { timeout: 8000 });
    wifiCache = { t: Date.now(), ssid: r.out.trim() };
  }
  return wifiCache.ssid;
}
function probeHealth(url = 'http://127.0.0.1:3000/health', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, statusCode: res.statusCode, latencyMs: Date.now() - t0 }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, statusCode: 0, latencyMs: Date.now() - t0, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, statusCode: 0, latencyMs: Date.now() - t0, error: e.message }));
  });
}

function probeJson(url = 'http://127.0.0.1:3100/health', timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 400) {
        res.resume();
        return resolve(null);
      }
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total <= 32768) chunks.push(c);
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function readGpuTempC(rawTemp) {
  if (rawTemp == null || !Number.isFinite(rawTemp)) return null;
  if (rawTemp >= 1000) return +(rawTemp / 1000).toFixed(1);
  if (rawTemp >= 120) return +(rawTemp / 10).toFixed(1);
  return +rawTemp.toFixed(1);
}

function readGpuStats(aiHealth, gpuSvc) {
  const K = '/sys/class/kgsl/kgsl-3d0/';
  const model = rd(K + 'gpu_model') || 'Adreno 540';
  const clkHz = num(K + 'gpuclk');
  const maxClkHz = num(K + 'max_gpuclk');
  const governor = rd(K + 'devfreq/governor') || 'msm-adreno-tz';
  const tempC = readGpuTempC(num(K + 'temp')) ?? aiHealth?.gpu?.temp_c ?? null;

  let busyPct = (aiHealth && aiHealth.gpu && Number.isFinite(aiHealth.gpu.busy_pct))
    ? Number(aiHealth.gpu.busy_pct)
    : null;
  if (busyPct == null) {
    const rawBusy = rd(K + 'gpu_busy_percentage');
    const parsed = rawBusy ? parseFloat(rawBusy) : NaN;
    busyPct = Number.isFinite(parsed) ? parsed : 0;
  }
  busyPct = +Math.min(100, Math.max(0, busyPct)).toFixed(1);
  gpuHist.push(busyPct);
  if (gpuHist.length > 60) gpuHist.shift();

  const rmbgCalls = aiHealth?.stats?.rmbg_calls ?? 0;
  const embedCalls = aiHealth?.stats?.embed_calls ?? 0;
  return {
    model,
    busyPct,
    hist: gpuHist,
    clkMhz: clkHz != null ? Math.round(clkHz / 1e6) : Math.round(aiHealth?.gpu?.clk_mhz || 0),
    maxClkMhz: maxClkHz != null ? Math.round(maxClkHz / 1e6) : 710,
    governor,
    tempC,
    throttling: (num(K + 'thermal_pwrlevel') ?? 0) > 0 || Boolean(aiHealth?.thermal?.throttled),
    thermalPwrLevel: num(K + 'thermal_pwrlevel') ?? 0,
    ai: {
      online: Boolean(aiHealth?.ok),
      running: Boolean(gpuSvc?.running),
      pid: gpuSvc?.pid || null,
      readyRmbg: Boolean(aiHealth?.ready?.rmbg),
      readyEmbed: Boolean(aiHealth?.ready?.embed),
      rssMb: aiHealth?.rss_kb?.total ? +(aiHealth.rss_kb.total / 1024).toFixed(1) : 0,
      rssRmbgMb: aiHealth?.rss_kb?.rmbg ? +(aiHealth.rss_kb.rmbg / 1024).toFixed(1) : 0,
      rssEmbedMb: aiHealth?.rss_kb?.embed ? +(aiHealth.rss_kb.embed / 1024).toFixed(1) : 0,
      rmbgCalls,
      rmbgAvgMs: aiHealth?.stats?.rmbg_avg_ms ? +Number(aiHealth.stats.rmbg_avg_ms).toFixed(1) : 0,
      embedCalls,
      embedAvgMs: aiHealth?.stats?.embed_avg_ms ? +Number(aiHealth.stats.embed_avg_ms).toFixed(1) : 0,
      errors: aiHealth?.stats?.errors ?? 0,
      uptimeS: aiHealth?.uptime_s ?? 0,
      models: aiHealth?.models || null,
    },
  };
}

function readLastLogLine(filePath) {
  try {
    if (!fs.existsSync(filePath)) return '';
    const st = fs.statSync(filePath);
    if (!st.size) return '';
    const size = Math.min(st.size, 2048);
    const buf = Buffer.alloc(size);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines[lines.length - 1] || '';
  } catch {
    return '';
  }
}

async function webHealth({ includeGpuHealth = false } = {}) {
  const fileMasterPid = parseInt(rd('/storage/apps/gaeru/logs/cluster.pid', '0'), 10) || null;
  let detectedMasterPid = null;
  const [httpRes, pgSvc, healthSvc, wdSvc, cfSvc, gpuSvc, gpuAiHealth] = await Promise.all([
    probeHealth(),
    jobStatus('postgresql-chroot'),
    jobStatus('gaeru-health'),
    jobStatus('network-watchdog'),
    jobStatus('cloudflared'),
    jobStatus('gaeru-gpu-ai'),
    probeJson('http://127.0.0.1:3100/health', 800),
  ]);
  const procEntries = [];
  try {
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      const pid = +d;
      try {
        const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0+/g, ' ').trim();
        if (!cmd || !/\bnode\b|src\/(?:server|cluster(?:-master)?)\.js/.test(cmd)) continue;
        const st = fs.readFileSync(`/proc/${d}/status`, 'utf8');
        const ppidMatch = st.match(/^PPid:\s+(\d+)/m);
        const vm = st.match(/VmRSS:\s+(\d+)\s+kB/);
        const ppid = ppidMatch ? +ppidMatch[1] : 0;
        const rssMb = +(vm ? +vm[1] / 1024 : 0).toFixed(1);
        const isClusterCmd = /(?:^|\s|\/)src\/cluster(?:-master)?\.js(?:\s|$)/.test(cmd);
        const isServerCmd = /(?:^|\s|\/)src\/server\.js(?:\s|$)/.test(cmd);
        if ((fileMasterPid && pid === fileMasterPid) || isClusterCmd) {
          detectedMasterPid = detectedMasterPid || pid;
        }
        procEntries.push({ pid, ppid, cmd, rssMb, isClusterCmd, isServerCmd });
      } catch {}
    }
  } catch {}

  const masterPid = (fileMasterPid && fs.existsSync('/proc/' + fileMasterPid)) ? fileMasterPid : detectedMasterPid;
  const masterAlive = !!(masterPid && fs.existsSync('/proc/' + masterPid));
  const workers = [];
  let clusterRssMb = 0;
  for (const p of procEntries) {
    const isMaster = p.pid === masterPid || p.isClusterCmd;
    const isWorker = !isMaster && (
      p.isServerCmd ||
      (masterAlive && p.ppid === masterPid && /(?:^|\s|\/)node(?:\s|$)/.test(p.cmd))
    );
    if (!isMaster && !isWorker) continue;
    clusterRssMb += p.rssMb;
    if (isWorker) workers.push({ pid: p.pid, rssMb: p.rssMb });
  }
  workers.sort((a, b) => a.pid - b.pid);
  return {
    domain: 'gaeru.com',
    port: 3000,
    http: httpRes,
    cluster: {
      masterPid,
      masterAlive,
      workersCount: workers.length,
      workers,
      clusterRssMb: +clusterRssMb.toFixed(1),
    },
    postgresql: pgSvc,
    cloudflared: cfSvc,
    healthcheck: healthSvc,
    watchdog: wdSvc,
    gpuAi: gpuSvc,
    gpuAiOnline: Boolean(gpuAiHealth?.ok),
    ...(includeGpuHealth ? { _gpuAiHealth: gpuAiHealth || null } : {}),
    lastHealthcheck: readLastLogLine('/var/log/gaeru-health.log'),
  };
}

function readDiskStatsNative() {
  const mounts = [['rootfs', '/'], ['/dev/sda17', '/userdata']];
  const out = [];
  for (const [fsName, mount] of mounts) {
    try {
      const st = fs.statfsSync(mount);
      const bsize = Number(st.bsize || 4096);
      const total = Number(st.blocks || 0) * bsize;
      const avail = Number(st.bavail || 0) * bsize;
      const free = Number(st.bfree || 0) * bsize;
      if (total > 0) {
        out.push({ fs: fsName, mount, total, used: Math.max(0, total - free), avail });
      }
    } catch {}
  }
  return out;
}

async function stats() {
  const now = Date.now();
  const cpu = readCpu();
  const cores = [];
  let total = 0;
  if (prevCpu) {
    if (cpu.cpu && prevCpu.cpu && cpu.cpu.total > prevCpu.cpu.total) {
      total = 100 * (1 - (cpu.cpu.idle - prevCpu.cpu.idle) / (cpu.cpu.total - prevCpu.cpu.total));
    }
    for (let i = 0; i < 8; i++) {
      const k = 'cpu' + i;
      const a = cpu[k], b = prevCpu[k];
      if (!a) {
        cores.push({ id: '' + i, usage: 0, online: false });
      } else {
        let u = 0;
        if (b && a.total > b.total) u = 100 * (1 - (a.idle - b.idle) / (a.total - b.total));
        cores.push({ id: '' + i, usage: +u.toFixed(1), online: true });
      }
    }
  }
  prevCpu = cpu;
  cpuHist.push(+total.toFixed(1)); if (cpuHist.length > 60) cpuHist.shift();

  const mi = {};
  rd('/proc/meminfo').split('\n').forEach((l) => { const m = l.match(/^(\w+):\s+(\d+)/); if (m) mi[m[1]] = +m[2]; });

  let disks = readDiskStatsNative();
  if (!disks.length) {
    const df = await sh('df -kP / /userdata 2>/dev/null | tail -n +2');
    disks = df.out.trim().split('\n').filter(Boolean).map((l) => {
      const p = l.split(/\s+/); return { fs: p[0], mount: p[5], total: +p[1] * 1024, used: +p[2] * 1024, avail: +p[3] * 1024 };
    });
  }

  const temps = {};
  try {
    let cpuMax = 0;
    for (const z of fs.readdirSync('/sys/class/thermal')) {
      if (!z.startsWith('thermal_zone')) continue;
      const type = rd(`/sys/class/thermal/${z}/type`); const t = num(`/sys/class/thermal/${z}/temp`);
      if (t == null) continue;
      if (type.startsWith('tsens_tz_sensor')) cpuMax = Math.max(cpuMax, t / 10);
      if (type === 'pm8998_tz') temps.pmic = t / 1000;
      if (type === 'xo_therm') temps.board = t;
    }
    temps.cpu = cpuMax;
  } catch {}
  const B = '/sys/class/power_supply/battery/';
  let limiter = null;
  try { limiter = JSON.parse(rd('/run/battery_limiter.json') || 'null'); } catch {}
  const battery = {
    capacity: num(B + 'capacity'), status: rd(B + 'status'), health: rd(B + 'health'),
    temp: num(B + 'temp') != null ? num(B + 'temp') / 10 : null,
    current_ma: num(B + 'current_now') != null ? Math.round(-num(B + 'current_now') / 1000) : null,
    voltage_v: num(B + 'voltage_now') != null ? +(num(B + 'voltage_now') / 1e6).toFixed(2) : null,
    cycles: num(B + 'cycle_count'), charger: rd(B + 'charger_type'),
    design_mah: num(B + 'charge_full_design') != null ? Math.round(num(B + 'charge_full_design') / 1000) : null,
    full_mah: num(B + 'charge_full') != null ? Math.round(num(B + 'charge_full') / 1000) : null,
    limiter,
  };

  const net = readNet(); const rates = {};
  if (prevNet) {
    const dt = (now - prevNet.t) / 1000;
    for (const k of Object.keys(net)) if (prevNet.v[k] && dt > 0) rates[k] = { rx: (net[k].rx - prevNet.v[k].rx) / dt, tx: (net[k].tx - prevNet.v[k].tx) / dt };
  }
  prevNet = { t: now, v: net };
  const ifaces = [];
  for (const [n, arr] of Object.entries(os.networkInterfaces())) {
    for (const a of arr) if (a.family === 'IPv4' && !a.internal) ifaces.push({ name: n, ip: a.address, rx: net[n] ? net[n].rx : 0, tx: net[n] ? net[n].tx : 0, rate: rates[n] || { rx: 0, tx: 0 } });
  }

  const web = await webHealth({ includeGpuHealth: true });
  const gpu = readGpuStats(web._gpuAiHealth || null, web.gpuAi);
  delete web._gpuAiHealth;
  if (gpu.tempC != null) temps.gpu = gpu.tempC;

  return {
    hostname: os.hostname(), kernel: os.release(), uptime: os.uptime(), load: os.loadavg(),
    cpu: { total: +total.toFixed(1), cores, hist: cpuHist, count: os.cpus().length || cores.length, model: 'Snapdragon 835 (Kryo 280)' },
    gpu,
    mem: { total: mi.MemTotal * 1024, avail: mi.MemAvailable * 1024, cached: (mi.Cached || 0) * 1024, swapTotal: (mi.SwapTotal || 0) * 1024, swapFree: (mi.SwapFree || 0) * 1024 },
    disks, temps, battery, ifaces, ssid: await wifiSsid(), web,
    brightness: { value: num('/sys/class/leds/lcd-backlight/brightness'), max: num('/sys/class/leds/lcd-backlight/max_brightness') || 4095 },
    time: new Date().toISOString(),
  };
}

// ----------------------------------------------------------------- services (upstart)
const SERVICES = [
  ['node-app APP=gaeru', 'GAERU Web Cluster (Node.js v26 – 4 Workers, cổng 3000)'],
  ['gaeru-gpu-ai', 'GAERU GPU AI Engine (Adreno 540 OpenCL 2.0, cổng 3100)'],
  ['postgresql-chroot', 'PostgreSQL 19 (Ubuntu 26.10 Chroot)'],
  ['cloudflared', 'Cloudflare Tunnel (gaeru.com / server.gaeru.com)'],
  ['gaeru-health', 'Giám sát sức khỏe tự động 24/7 (Healthcheck)'],
  ['network-watchdog', 'Tự động phục hồi mạng & dịch vụ 24/7 (Watchdog)'],
  ['battery-limiter', 'Giới hạn sạc pin 80% (Bảo vệ pin 24/7)'],
  ['gaeru-screen', 'Màn hình trạng thái Server (On-demand, 0% GUI)'],
  ['server-hardware-tuning', 'Tối ưu 8 nhân CPU Kryo 280 & GPU (One-shot boot task)', { oneShot: true }],
  ['ssh', 'SSH server (cổng 22)'],
  ['network-manager', 'NetworkManager (Wi-Fi)'],
  ['cron', 'Cron (Sao lưu định kỳ 3-2-1)'],
  ['ufw', 'Tường lửa UFW'],
  ['server-dashboard', 'Trang quản trị này (cổng 8080)'],
];

let upstartListCache = { t: 0, map: null, pending: null };
function invalidateUpstartCache() { upstartListCache.t = 0; }
async function getUpstartMap() {
  const now = Date.now();
  if (upstartListCache.map && (now - upstartListCache.t) < 2000) return upstartListCache.map;
  if (upstartListCache.pending) return upstartListCache.pending;
  upstartListCache.pending = (async () => {
    try {
      const r = await run('/sbin/initctl', ['list'], { timeout: 6000 });
      const map = new Map();
      for (const raw of String(r.out || '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const mInst = /^([A-Za-z0-9_-]+)\s+\(([^)]+)\)\s+(start|stop)\/(\w+)(?:,\s*process\s+(\d+))?/.exec(line);
        if (mInst) {
          map.set(`${mInst[1]} APP=${mInst[2]}`, [mInst[3], mInst[4], mInst[5] || null]);
          map.set(`${mInst[1]} ${mInst[2]}`, [mInst[3], mInst[4], mInst[5] || null]);
          continue;
        }
        const m = /^([A-Za-z0-9_-]+)\s+(start|stop)\/(\w+)(?:,\s*process\s+(\d+))?/.exec(line);
        if (m) map.set(m[1], [m[2], m[3], m[4] || null]);
      }
      upstartListCache.map = map;
      upstartListCache.t = Date.now();
      return map;
    } finally {
      upstartListCache.pending = null;
    }
  })();
  return upstartListCache.pending;
}

async function jobStatus(name, inst, opts = {}) {
  if (name === 'cloudflared') {
    const pid = rd('/var/run/cloudflared.pid');
    if (pid && /^\d+$/.test(pid) && fs.existsSync(`/proc/${pid}`)) {
      return { state: 'start/running', running: true, pid: +pid };
    }
    const pg = await sh('pgrep -x cloudflared 2>/dev/null | head -n1');
    const p2 = +pg.out.trim() || null;
    return { state: p2 ? 'start/running' : 'stop/waiting', running: !!p2, pid: p2 };
  }
  const fullKey = inst ? `${name} ${inst}` : name;
  const map = await getUpstartMap();
  let m = map && map.get(fullKey);
  let fallbackOut = '';
  if (!m) {
    const r = await sh(`initctl status ${fullKey} 2>&1`, { timeout: 8000 });
    fallbackOut = r.out;
    const rx = r.out.match(/(start|stop)\/(\w+)(?:, process (\d+))?/);
    if (rx) m = [rx[1], rx[2], rx[3] || null];
  }
  if (opts?.oneShot && m && m[0] === 'stop' && m[1] === 'waiting') {
    const manual = isManual(name);
    return {
      state: manual ? 'stop/waiting (disabled)' : 'task/applied (boot)',
      running: !manual,
      pid: null,
      oneShot: true,
    };
  }
  return { state: m ? m[0] + '/' + m[1] : (fallbackOut.trim() || 'stop/waiting'), running: !!(m && m[0] === 'start'), pid: m && m[2] ? +m[2] : null, ...(opts?.oneShot ? { oneShot: true } : {}) };
}
function nodeAppEnvPath(name) {
  const m = /^node-app APP=([A-Za-z_][A-Za-z0-9_-]{0,62})$/.exec(String(name || ''));
  return m ? path.join(APPS, m[1], 'app.env') : null;
}
function isManual(name) {
  if (name === 'cloudflared') {
    try { return !fs.readdirSync('/etc/rc2.d').some((f) => /^S\d+cloudflared$/.test(f)); } catch { return false; }
  }
  const appEnv = nodeAppEnvPath(name);
  if (appEnv) {
    return parseEnv(appEnv).AUTOSTART !== 'yes';
  }
  const base = name.split(' ')[0];
  return /^\s*manual\s*$/m.test(rd(`/etc/init/${base}.override`));
}
function setManual(name, manual) {
  const appEnv = nodeAppEnvPath(name);
  if (appEnv) {
    if (!fs.existsSync(appEnv)) throw new Error('Không tìm thấy ' + appEnv);
    const lines = fs.readFileSync(appEnv, 'utf8').split(/\r?\n/);
    const nextVal = manual ? 'no' : 'yes';
    let found = false;
    const out = lines.map((l) => {
      if (l.startsWith('AUTOSTART=')) { found = true; return 'AUTOSTART=' + nextVal; }
      return l;
    });
    if (!found) out.push('AUTOSTART=' + nextVal);
    const clean = out.filter((l, i, a) => i < a.length - 1 || l !== '').join('\n') + '\n';
    writeFileAtomic(appEnv, clean, { mode: 0o640, uid: 33, gid: 33 });
    return;
  }
  const base = name.split(' ')[0];
  const f = `/etc/init/${base}.override`;
  let c = rd(f).split('\n').filter((l) => !/^\s*manual\s*$/.test(l)).join('\n').trim();
  if (manual) c = (c ? c + '\n' : '') + 'manual';
  if (c) writeFileAtomic(f, c + '\n', { mode: 0o644 }); else { try { fs.unlinkSync(f); } catch {} }
}
async function listServices() {
  return Promise.all(SERVICES.map(async ([name, desc, opts]) => ({ name, desc, ...(await jobStatus(name, '', opts)), autostart: !isManual(name) })));
}

// ----------------------------------------------------------------- node apps
function parseEnv(f) {
  const o = {};
  rd(f).split('\n').forEach((l) => { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) o[m[1]] = m[2]; });
  return o;
}
async function listApps() {
  let dirs = [];
  try { dirs = fs.readdirSync(APPS).filter((d) => fs.existsSync(path.join(APPS, d, 'app.env'))); } catch {}
  return Promise.all(dirs.map(async (d) => {
    const e = parseEnv(path.join(APPS, d, 'app.env'));
    const env = Object.keys(e).filter((k) => k.startsWith('ENV_')).map((k) => k.slice(4) + '=' + e[k]);
    return { name: d, port: +e.PORT || 3000, entry: e.ENTRY || 'server.js', autostart: e.AUTOSTART === 'yes', env, ...(await jobStatus('node-app', 'APP=' + d)) };
  }));
}
function writeAppEnv(name, cfg) {
  const lines = ['# Config for: start|stop|restart node-app APP=' + name, 'PORT=' + cfg.port, 'ENTRY=' + cfg.entry,
    'AUTOSTART=' + (cfg.autostart ? 'yes' : 'no'), 'RUNUSER=33:33'];
  (cfg.env || []).forEach((kv) => { const m = String(kv).match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) lines.push('ENV_' + m[1] + '=' + m[2].replace(/[\r\n]/g, '')); });
  const f = path.join(APPS, name, 'app.env');
  writeFileAtomic(f, lines.join('\n') + '\n', { mode: 0o640, uid: 33, gid: 33 });
}
const APP_TEMPLATE = `const http = require('http');
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Hello from ' + require('path').basename(process.cwd()) + ' – Node ' + process.version + '\\n');
}).listen(port, '127.0.0.1', () => console.log('listening on', port));
`;

// ----------------------------------------------------------------- postgres
async function pgMount() { await run('/usr/local/sbin/ubuntu-mount.sh', []); }
async function psql(sql, db = 'postgres', csv = true) {
  await pgMount();
  const flags = '-X -q -v ON_ERROR_STOP=1 -P pager=off' + (csv ? ' --csv' : '');
  return run('chroot', [DEB, 'su', 'postgres', '-c', `psql ${flags} -d ${shq(db)}`], { input: sql, timeout: 120000 });
}
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
async function pgQuery(sql, db) {
  const r = await psql(sql, db, true);
  if (r.code !== 0) throw new Error(r.err.trim() || 'psql error');
  const rows = parseCsv(r.out); const head = rows.shift() || [];
  return rows.map((x) => Object.fromEntries(head.map((h, i) => [h, x[i]])));
}
const qi = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const ql = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// ----------------------------------------------------------------- logs
function logSources() {
  const s = {
    'app-gaeru': ['Web Server GAERU (Node.js Cluster)', '/var/log/upstart/node-app-gaeru.log'],
    'gaeru-gpu-ai': ['GPU AI Engine (gaeru-gpu-ai.log)', '/var/log/upstart/gaeru-gpu-ai.log'],
    'gaeru-health': ['Healthcheck 24/7 (gaeru-health.log)', '/var/log/gaeru-health.log'],
    'network-watchdog': ['Watchdog mạng & dịch vụ', '/var/log/network_watchdog.log'],
    cloudflared: ['Cloudflare Tunnel (cloudflared.err)', '/var/log/cloudflared.err'],
    postgresql: ['PostgreSQL 19 (postgresql-chroot.log)', '/var/log/upstart/postgresql-chroot.log'],
    'gdrive-sync': ['Đồng bộ Google Drive (gdrive-sync.log)', '/var/log/gaeru-gdrive-sync.log'],
    'pg-backup': ['Sao lưu PostgreSQL 19 (backup.log)', '/userdata/storage/gaeru-pg-backups/backup.log'],
    'media-backup': ['Sao lưu Media & Config (backup.log)', '/userdata/storage/gaeru-media-backups/backup.log'],
    'backup-prune': ['Dọn bản sao lưu >48h (gaeru-backup-prune.log)', '/var/log/gaeru-backup-prune.log'],
    admin: ['Trang quản trị (server-dashboard.log)', '/var/log/upstart/server-dashboard.log'],
    auth: ['Đăng nhập / sudo / SSH', '/var/log/auth.log'],
    syslog: ['Syslog', '/var/log/syslog'],
    dmesg: ['Kernel (dmesg)', null],
  };
  try { fs.readdirSync(APPS).forEach((d) => { if (d !== 'gaeru') s['app-' + d] = ['App: ' + d, `/var/log/upstart/node-app-${d}.log`]; }); } catch {}
  return s;
}

// ----------------------------------------------------------------- websocket terminal
const MAX_TERM_SESSIONS = 6;
const MAX_WS_PAYLOAD = 64 * 1024;
const MAX_WS_BUF = 128 * 1024;
let activeTermSessions = 0;

function wsAccept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
}
function wsFrame(opcode, payload) {
  const len = payload.length; let h;
  if (len < 126) { h = Buffer.alloc(2); h[1] = len; }
  else if (len < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(len, 2); }
  else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
  h[0] = 0x80 | opcode;
  return Buffer.concat([h, payload]);
}
function handleTerminal(req, socket, sess) {
  if (activeTermSessions >= MAX_TERM_SESSIONS) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  activeTermSessions++;
  wsAccept(req, socket);
  if (typeof socket.setTimeout === 'function') socket.setTimeout(0);
  if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
  const pty = cp.spawn('python3', [path.join(ROOT, 'pty_helper.py')], { env: ENV });
  let closed = false;
  const wsPing = setInterval(() => {
    if (!closed && !socket.destroyed && socket.writable) socket.write(wsFrame(9, Buffer.alloc(0)));
  }, 25000);
  if (wsPing.unref) wsPing.unref();
  const cleanup = () => {
    if (closed) return;
    closed = true;
    activeTermSessions = Math.max(0, activeTermSessions - 1);
    clearInterval(wsPing);
    try { pty.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { if (!pty.killed) pty.kill('SIGKILL'); } catch {} }, 1000).unref();
  };
  const toPty = (type, payload) => {
    const h = Buffer.alloc(5); h.write(type, 0); h.writeUInt32BE(payload.length, 1);
    if (!closed && pty.stdin.writable) pty.stdin.write(Buffer.concat([h, payload]));
  };
  pty.stdout.on('data', (d) => { if (!closed && !socket.destroyed && socket.writable) socket.write(wsFrame(2, d)); });
  pty.on('error', () => { cleanup(); if (!socket.destroyed) socket.destroy(); });
  pty.on('close', () => { cleanup(); if (!socket.destroyed) { try { socket.write(wsFrame(8, Buffer.alloc(0))); } catch {} socket.end(); } });
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    if (closed) return;
    if (sess && (sess.exp < Date.now() || sess.idleExp < Date.now())) {
      cleanup(); socket.destroy(); return;
    }
    if (buf.length + chunk.length > MAX_WS_BUF) { cleanup(); socket.destroy(); return; }
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f; const masked = buf[1] & 0x80; let len = buf[1] & 0x7f; let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (!Number.isFinite(len) || len < 0 || len > MAX_WS_PAYLOAD) { cleanup(); socket.destroy(); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let data = buf.slice(off + (masked ? 4 : 0), need);
      if (masked) { const m = buf.slice(off, off + 4); data = Buffer.from(data.map((b, i) => b ^ m[i % 4])); }
      buf = buf.slice(need);
      if (op === 8) { cleanup(); socket.end(); return; }
      if (op === 9) { if (socket.writable) socket.write(wsFrame(10, data)); continue; }
      if (op === 1 || op === 2) {
        try {
          const msg = JSON.parse(data.toString('utf8'));
          if (msg.t === 'd' && typeof msg.d === 'string') {
            if (sess) sess.idleExp = Date.now() + SESSION_IDLE_TTL;
            toPty('d', Buffer.from(msg.d, 'utf8'));
          } else if (msg.t === 'r' && Number.isFinite(+msg.r) && Number.isFinite(+msg.c)) {
            const p = Buffer.alloc(4);
            p.writeUInt16BE(Math.max(1, Math.min(500, Math.floor(+msg.r))), 0);
            p.writeUInt16BE(Math.max(1, Math.min(500, Math.floor(+msg.c))), 2);
            toPty('r', p);
          }
        } catch {}
      }
    }
  });
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

// ----------------------------------------------------------------- API routes
const routes = {};
const on = (m, p, fn) => (routes[m + ' ' + p] = fn);

on('GET', '/api/stats', async () => stats());

// services
on('GET', '/api/services', async () => listServices());

on('POST', '/api/services', async (b) => {
  const svcEntry = SERVICES.find((s) => s[0] === b.name);
  if (!svcEntry) throw new Error('Dịch vụ không hợp lệ');
  const svcOpts = svcEntry[2] || {};
  if (b.name === 'cloudflared') {
    if (b.action === 'enable' || b.action === 'disable') {
      const r = await sh(`update-rc.d cloudflared ${b.action} 2>&1`);
      return { ok: r.code === 0, out: r.out.trim() };
    }
    if (!['start', 'stop', 'restart'].includes(b.action)) throw new Error('Thao tác không hợp lệ');
    const r = await sh(`service cloudflared ${b.action} 2>&1`, { timeout: 60000 });
    return { ok: r.code === 0, out: r.out.trim() };
  }
  if (b.action === 'enable' || b.action === 'disable') { setManual(b.name, b.action === 'disable'); invalidateUpstartCache(); return { ok: true }; }
  if (!['start', 'stop', 'restart'].includes(b.action)) throw new Error('Thao tác không hợp lệ');
  if (svcOpts.oneShot && b.action !== 'start') throw new Error('Tác vụ boot one-shot chỉ hỗ trợ chạy lại (start)');
  if (b.name === 'server-dashboard') { setTimeout(() => sh(`${b.action} server-dashboard`), 500); return { ok: true, out: 'Đang ' + b.action + ' trang quản trị…' }; }
  let r = await sh(`${b.action} ${b.name} 2>&1`, { timeout: 60000 });
  if (b.action === 'restart' && /Unknown instance/.test(r.out)) r = await sh(`start ${b.name} 2>&1`, { timeout: 60000 });
  invalidateUpstartCache();
  return { ok: r.code === 0, out: r.out.trim() };
});

on('POST', '/api/web/reload', async () => {
  const masterPid = parseInt(rd('/storage/apps/gaeru/logs/cluster.pid', '0'), 10);
  if (masterPid > 1 && fs.existsSync('/proc/' + masterPid)) {
    process.kill(masterPid, 'SIGHUP');
    return { ok: true, masterPid, out: `Đã gửi SIGHUP tới Cluster Master PID ${masterPid} (Rolling Reload 0s downtime).` };
  }
  const r = await sh('restart node-app APP=gaeru 2>&1 || start node-app APP=gaeru 2>&1', { timeout: 60000 });
  return { ok: r.code === 0, out: r.out.trim() || 'Đã khởi động lại GAERU Web Cluster.' };
});

// node apps
on('GET', '/api/apps', async () => listApps());
on('POST', '/api/apps', async (b) => {
  const name = b.name;
  if (!NAME_RE.test(name || '')) throw new Error('Tên app không hợp lệ');
  const dir = path.join(APPS, name);
  switch (b.action) {
    case 'create': {
      if (fs.existsSync(dir)) throw new Error('App đã tồn tại');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'server.js'), APP_TEMPLATE);
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'server.js', scripts: { start: 'node server.js' } }, null, 2) + '\n');
      writeAppEnv(name, { port: +b.port || 3001, entry: 'server.js', autostart: true, env: [] });
      await sh(`chown -R 33:33 ${shq(dir)}`);
      return { ok: true };
    }
    case 'config': {
      writeAppEnv(name, { port: +b.port || 3000, entry: b.entry || 'server.js', autostart: !!b.autostart, env: b.env || [] });
      return { ok: true };
    }
    case 'start': case 'stop': case 'restart': {
      let r = await sh(`${b.action} node-app APP=${name} 2>&1`, { timeout: 60000 });
      if (b.action === 'restart' && /Unknown instance/.test(r.out)) r = await sh(`start node-app APP=${name} 2>&1`);
      return { ok: r.code === 0, out: r.out.trim() };
    }
    case 'npm-install': {
      const r = await sh(`cd ${shq(dir)} && npm install --no-fund --no-audit 2>&1; chown -R 33:33 ${shq(dir)}`, { timeout: 600000 });
      return { ok: r.code === 0, out: r.out.trim().split('\n').slice(-30).join('\n') };
    }
    case 'delete': {
      if (b.confirm !== name) throw new Error('Xác nhận tên app không khớp');
      await sh(`stop node-app APP=${name} 2>&1`);
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: true };
    }
  }
  throw new Error('Thao tác không hợp lệ');
});

// processes
on('GET', '/api/processes', async () => {
  const r = await sh('ps --no-headers -eo pid,user:20,pcpu,pmem,rss,etime,args --sort=-pcpu | head -n 150');
  return r.out.split('\n').filter(Boolean).map((l) => {
    const p = l.trim().split(/\s+/);
    return { pid: +p[0], user: p[1], cpu: +p[2], mem: +p[3], rss: +p[4] * 1024, etime: p[5], cmd: p.slice(6).join(' ') };
  });
});
on('POST', '/api/processes/kill', async (b) => {
  const sig = ['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGINT'].includes(b.signal) ? b.signal : 'SIGTERM';
  const pid = Number(b && b.pid);
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) throw new Error('PID không hợp lệ');
  process.kill(pid, sig);
  console.log(new Date().toISOString(), 'Process signal', sig, '-> PID', pid);
  return { ok: true };
});

// files
function resolveReqPath(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Thiếu đường dẫn path');
  return path.resolve(raw);
}
function stat(p) {
  const st = fs.lstatSync(p);
  return { name: path.basename(p), path: p, dir: st.isDirectory() || (st.isSymbolicLink() && (() => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })()),
    link: st.isSymbolicLink(), size: st.size, mtime: st.mtimeMs, mode: (st.mode & 0o7777).toString(8), uid: st.uid };
}
on('GET', '/api/fs/list', async (b, q) => {
  const p = path.resolve(q.get('path') || '/storage');
  const items = fs.readdirSync(p).map((n) => { try { return stat(path.join(p, n)); } catch { return { name: n, path: path.join(p, n), error: true }; } });
  items.sort((a, b2) => (b2.dir - a.dir) || a.name.localeCompare(b2.name));
  return { path: p, items };
});
on('GET', '/api/fs/read', async (b, q) => {
  const p = resolveReqPath(q.get('path'));
  const st = fs.statSync(p);
  if (!st.isFile()) throw new Error('Không phải file thông thường');
  if (st.size > 3 * 1024 * 1024) throw new Error('File quá lớn để mở (>3MB) – hãy tải về');
  const buf = fs.readFileSync(p);
  if (buf.includes(0)) throw new Error('File nhị phân – hãy tải về');
  return { path: p, content: buf.toString('utf8') };
});
on('POST', '/api/fs/write', async (b) => {
  const p = resolveReqPath(b?.path);
  writeFileAtomic(p, String(b?.content ?? ''), statPreserveOpts(p));
  return { ok: true };
});
on('POST', '/api/fs/op', async (b) => {
  const p = resolveReqPath(b?.path);
  if (b.op === 'mkdir') fs.mkdirSync(p, { recursive: true });
  else if (b.op === 'newfile') { if (fs.existsSync(p)) throw new Error('Đã tồn tại'); fs.writeFileSync(p, ''); }
  else if (b.op === 'delete') { if (['/', '/usr', '/etc', '/bin', '/lib', '/var', '/storage', '/userdata', '/boot', '/root'].includes(p)) throw new Error('Không được xoá thư mục hệ thống'); fs.rmSync(p, { recursive: true, force: true }); }
  else if (b.op === 'rename') fs.renameSync(p, resolveReqPath(b?.to));
  else if (b.op === 'chmod') { const m = parseInt(b.mode, 8); if (!Number.isInteger(m) || m < 0 || m > 0o7777) throw new Error('Mode không hợp lệ'); fs.chmodSync(p, m); }
  else if (b.op === 'chown') { const r = await sh(`chown -R ${shq(b.owner)} ${shq(p)} 2>&1`); if (r.code) throw new Error(r.out); }
  else throw new Error('Thao tác không hợp lệ');
  return { ok: true };
});

// postgres
on('GET', '/api/pg/overview', async () => {
  const [ver] = await pgQuery("select version() v, pg_postmaster_start_time() started, (select count(*) from pg_stat_activity where backend_type='client backend') conns, current_setting('max_connections') maxconns, current_setting('data_directory') datadir");
  const dbs = await pgQuery('select datname as name, pg_get_userbyid(datdba) as owner, pg_size_pretty(pg_database_size(datname)) as size, pg_encoding_to_char(encoding) as encoding from pg_database where not datistemplate order by 1');
  const roles = await pgQuery("select rolname as name, rolsuper as superuser, rolcreatedb as createdb, rolcanlogin as login from pg_roles where rolname !~ '^pg_' order by 1");
  return { version: ver, dbs, roles };
});
on('GET', '/api/pg/tables', async (b, q) => {
  return pgQuery("select schemaname as schema, relname as table, n_live_tup as rows, pg_size_pretty(pg_total_relation_size(relid)) as size from pg_stat_user_tables order by 1,2", q.get('db'));
});
on('POST', '/api/pg/sql', async (b) => {
  const r = await psql(b.sql, b.db || 'postgres', false);
  return { ok: r.code === 0, out: (r.out + (r.err ? '\n' + r.err : '')).trim() || '(OK – không có kết quả)' };
});
on('POST', '/api/pg/admin', async (b) => {
  const need = (v) => { if (!NAME_RE.test(v || '')) throw new Error('Tên không hợp lệ: ' + v); return v; };
  let sql;
  switch (b.action) {
    case 'createdb': sql = `CREATE DATABASE ${qi(need(b.name))}` + (b.owner ? ` OWNER ${qi(need(b.owner))}` : '') + ` ENCODING 'UTF8'`; break;
    case 'dropdb': if (b.confirm !== b.name) throw new Error('Xác nhận tên không khớp'); sql = `DROP DATABASE ${qi(need(b.name))} WITH (FORCE)`; break;
    case 'createrole': sql = `CREATE ROLE ${qi(need(b.name))} LOGIN PASSWORD ${ql(b.password || '')}` + (b.superuser ? ' SUPERUSER' : '') + (b.createdb ? ' CREATEDB' : ''); break;
    case 'droprole': if (b.confirm !== b.name) throw new Error('Xác nhận tên không khớp'); sql = `DROP ROLE ${qi(need(b.name))}`; break;
    case 'password': sql = `ALTER ROLE ${qi(need(b.name))} PASSWORD ${ql(b.password || '')}`; break;
    default: throw new Error('Thao tác không hợp lệ');
  }
  const r = await psql(sql, 'postgres', false);
  if (r.code !== 0) throw new Error(r.err.trim());
  return { ok: true };
});

// logs
on('GET', '/api/logs/sources', async () => Object.entries(logSources()).map(([id, [label]]) => ({ id, label })));
on('GET', '/api/logs', async (b, q) => {
  const src = logSources()[q.get('src')]; if (!src) throw new Error('Nguồn log không hợp lệ');
  const n = Math.min(+q.get('lines') || 300, 5000);
  const r = src[1] ? await sh(`tail -n ${n} ${shq(src[1])} 2>&1`) : await sh(`dmesg | tail -n ${n}`);
  return { out: r.out };
});

// system
on('POST', '/api/system/brightness', async (b) => {
  const v = Math.max(0, Math.min(4095, Math.round(+b.value || 0)));
  fs.writeFileSync('/sys/class/leds/lcd-backlight/brightness', String(v));
  try { writeFileAtomic('/etc/screen_brightness.conf', String(v) + '\n', { mode: 0o644 }); } catch {}
  return { ok: true, value: v, max: 4095 };
});
on('POST', '/api/battery/config', async (b) => {
  const max = Math.max(50, Math.min(100, parseInt(b.target_max, 10) || 80));
  const min = Math.max(40, Math.min(max - 5, parseInt(b.target_min, 10) || 75));
  writeFileAtomic('/etc/battery_limiter.conf', `TARGET_MAX=${max}\nTARGET_MIN=${min}\n`, { mode: 0o644 });
  return { ok: true, target_max: max, target_min: min };
});
on('POST', '/api/system/power', async (b) => {
  if (!['reboot', 'poweroff'].includes(b.action)) throw new Error('Thao tác không hợp lệ');
  setTimeout(() => sh(`sync; ${b.action}`), 800); return { ok: true };
});
on('GET', '/api/system/info', async () => {
  const [osr, tz, ufw, upg, ssh] = await Promise.all([
    sh('lsb_release -ds'), sh('cat /etc/timezone'), sh('ufw status verbose 2>&1 | head -30'),
    sh("apt list --upgradable 2>/dev/null | tail -n +2 | wc -l"), sh("grep -E '^(PermitRootLogin|PasswordAuthentication|Port)' /etc/ssh/sshd_config"),
  ]);
  return { os: osr.out.trim(), timezone: tz.out.trim(), ufw: ufw.out.trim(), upgradable: +upg.out.trim() || 0, ssh: ssh.out.trim(), node: process.version };
});
on('GET', '/api/wifi/scan', async () => {
  await sh('nmcli dev wifi rescan 2>/dev/null; sleep 2', { timeout: 15000 });
  const r = await sh('nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY,CHAN dev wifi list 2>&1', { timeout: 15000 });
  const seen = new Set();
  return r.out.split('\n').filter(Boolean).map((l) => {
    const p = l.split(/(?<!\\):/).map((x) => x.replace(/\\:/g, ':'));
    return { inUse: p[0] === '*', ssid: p[1], signal: +p[2], security: p[3], chan: p[4] };
  }).filter((w) => w.ssid && !seen.has(w.ssid) && seen.add(w.ssid)).sort((a, b) => b.signal - a.signal);
});
on('POST', '/api/wifi/connect', async (b) => {
  const ssid = typeof b?.ssid === 'string' ? b.ssid.trim() : '';
  if (!ssid || ssid.length > 128) throw new Error('Tên Wi-Fi không hợp lệ');
  const args = ['dev', 'wifi', 'connect', ssid]; if (b.password) args.push('password', String(b.password));
  const r = await run('nmcli', args, { timeout: 45000 });
  return { ok: r.code === 0, out: (r.out + r.err).trim() };
});
on('POST', '/api/system/firewall', async (b) => {
  if (b.action === 'enable') {
    const st = await sh('ufw status 2>/dev/null');
    let cmd = 'ufw --force enable';
    if (!/\b22\/tcp\b.*ALLOW/i.test(st.out) || !/\b8080\/tcp\b.*ALLOW/i.test(st.out)) {
      cmd = 'ufw allow from 192.168.31.0/24 to any port 22 proto tcp && ufw allow from 192.168.31.0/24 to any port 8080 proto tcp && ufw --force enable';
    }
    const r = await sh(cmd + ' 2>&1');
    return { ok: r.code === 0, out: r.out.trim() };
  }
  let cmd = b.action === 'disable' ? 'ufw disable' : null;
  if (b.action === 'allow' || b.action === 'deny') { if (!/^\d{1,5}(\/(tcp|udp))?$/.test(b.port || '')) throw new Error('Cổng không hợp lệ'); cmd = `ufw ${b.action} ${b.port}`; }
  if (!cmd) throw new Error('Thao tác không hợp lệ');
  const r = await sh(cmd + ' 2>&1'); return { ok: r.code === 0, out: r.out.trim() };
});
on('GET', '/api/2fa/status', async (b, q, req) => {
  const cfg = readTotpConfig();
  return {
    enabled: Boolean(cfg),
    remainingBackup: cfg ? (cfg.backupHashes || []).length : 0,
    updatedAt: cfg ? cfg.updatedAt || cfg.createdAt || null : null,
    isLan: isTrustedLanClient(req),
  };
});
on('POST', '/api/2fa/backup-regen', async (b, q, req) => {
  const cfg = readTotpConfig();
  if (!cfg) throw Object.assign(new Error('Chưa kích hoạt 2FA'), { status: 400 });
  const okPw = await verifyRootPassword(String(b?.password || ''));
  if (!okPw) throw Object.assign(new Error('Sai mật khẩu root'), { status: 403 });
  const { plainCodes, hashedEntries } = generateBackupCodes(8);
  cfg.backupHashes = hashedEntries;
  cfg.updatedAt = new Date().toISOString();
  writeTotpConfig(cfg);
  const revoked = revokeOtherSessions(parseCookies(req).mi6sid);
  console.log(new Date().toISOString(), 'Admin 2FA backup codes regenerated from', clientIp(req), 'revokedSessions=', revoked);
  return { ok: true, backupCodes: plainCodes, remainingBackup: hashedEntries.length, revokedSessions: revoked };
});
on('POST', '/api/2fa/reset', async (b, q, req) => {
  if (!isTrustedLanClient(req)) {
    throw Object.assign(new Error('Chỉ được phép đổi khóa 2FA khi truy cập từ mạng LAN'), { status: 403 });
  }
  const okPw = await verifyRootPassword(String(b?.password || ''));
  if (!okPw) throw Object.assign(new Error('Sai mật khẩu root'), { status: 403 });
  const pending = await createPendingSetup(clientIp(req), true);
  console.log(new Date().toISOString(), 'Admin 2FA re-key initiated from LAN', clientIp(req));
  return { ok: true, ...pending };
});

const APP_DOT_ENV = '/storage/apps/gaeru/.env';
function readIcloudMailState() {
  const envMap = parseEnv(APP_DOT_ENV);
  const pass = String(envMap.SMTP_PASSWORD || '').trim();
  const passwordConfigured = Boolean(pass && pass !== 'ICLOUD_APP_PASSWORD_REQUIRED' && !/^<.*>$/.test(pass));
  return {
    provider: 'iCloud+ Custom Email Domain',
    domain: 'gaeru.com',
    webmailUrl: 'https://www.icloud.com/mail',
    mxServers: ['mx01.mail.icloud.com', 'mx02.mail.icloud.com'],
    addresses: [
      { email: 'noreply@gaeru.com', role: 'Mail gửi thông báo người dùng (SMTP_FROM)', displayName: 'GAERU', provider: 'iCloud+' },
      { email: 'business@gaeru.com', role: 'Mail nhận thông báo quản trị (ADMIN_DOMAIN_EMAIL)', displayName: 'GAERU', provider: 'iCloud+' }
    ],
    smtp: {
      host: envMap.SMTP_HOST || 'smtp.mail.me.com',
      port: +(envMap.SMTP_PORT || 587),
      secure: String(envMap.SMTP_SECURE || 'false') === 'true',
      user: envMap.SMTP_USER || 'business@gaeru.com',
      from: envMap.SMTP_FROM || 'noreply@gaeru.com',
      replyTo: envMap.SMTP_REPLY_TO || 'business@gaeru.com',
      adminEmail: envMap.ADMIN_DOMAIN_EMAIL || 'business@gaeru.com',
      passwordConfigured
    }
  };
}
function upsertAppEnv(updates) {
  let lines = fs.existsSync(APP_DOT_ENV) ? fs.readFileSync(APP_DOT_ENV, 'utf8').split(/\r?\n/) : [];
  for (const [k, rawVal] of Object.entries(updates)) {
    const v = String(rawVal ?? '').replace(/[\r\n]/g, '');
    const idx = lines.findIndex((l) => l.startsWith(k + '='));
    if (idx >= 0) lines[idx] = k + '=' + v;
    else lines.push(k + '=' + v);
  }
  const clean = lines.filter((l, i, arr) => i < arr.length - 1 || l !== '').join('\n') + '\n';
  writeFileAtomic(APP_DOT_ENV, clean, { mode: 0o640, uid: 33, gid: 33 });
}

on('GET', '/api/icloud-mail/status', async () => {
  return { ok: true, ...readIcloudMailState() };
});

on('POST', '/api/icloud-mail/smtp', async (b) => {
  const smtpUser = String((b && b.smtpUser) || 'business@gaeru.com').trim();
  const smtpPassword = String((b && b.smtpPassword) || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(smtpUser)) {
    throw new Error('Email Apple ID không hợp lệ');
  }
  if (!smtpPassword || smtpPassword.length < 8 || smtpPassword === 'ICLOUD_APP_PASSWORD_REQUIRED') {
    throw new Error('Cần nhập App-Specific Password hợp lệ từ appleid.apple.com');
  }
  const rawPort = Number((b && b.smtpPort) || 587);
  const smtpPort = rawPort === 465 ? 465 : 587;
  upsertAppEnv({
    SMTP_HOST: 'smtp.mail.me.com',
    SMTP_PORT: String(smtpPort),
    SMTP_SECURE: String(smtpPort === 465),
    SMTP_USER: smtpUser,
    SMTP_PASSWORD: smtpPassword,
    SMTP_FROM: 'noreply@gaeru.com',
    SMTP_REPLY_TO: 'business@gaeru.com',
    ADMIN_DOMAIN_EMAIL: 'business@gaeru.com'
  });
  try {
    const masterPid = parseInt(rd('/storage/apps/gaeru/logs/cluster.pid', '0'), 10);
    if (masterPid > 1 && fs.existsSync('/proc/' + masterPid)) {
      process.kill(masterPid, 'SIGHUP');
    } else {
      const { execFile } = require('child_process');
      execFile('/bin/sh', ['-c', '/sbin/initctl restart node-app APP=gaeru >/dev/null 2>&1 || /sbin/initctl start node-app APP=gaeru >/dev/null 2>&1 || true'], () => {});
    }
  } catch {}
  return {
    ok: true,
    message: 'Đã lưu App-Specific Password SMTP iCloud+ (smtp.mail.me.com:' + smtpPort + ') và nạp lại web server (0s downtime).',
    ...readIcloudMailState()
  };
});

on('GET', '/api/backups/status', async () => {
  const listDirNewest = (dir, prefix) => {
    try {
      const files = fs.readdirSync(dir)
        .filter((f) => f.startsWith(prefix) && !f.endsWith('.sha256') && !f.includes('-latest.'))
        .sort()
        .reverse();
      return files.slice(0, 5).map((name) => {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        const sha = rd(full + '.sha256', '').split(/\s+/)[0] || null;
        return { name, sizeBytes: st.size, mtime: st.mtime.toISOString(), sha256: sha };
      });
    } catch {
      return [];
    }
  };
  const dirStats = (dir, prefix) => {
    try {
      const files = fs.readdirSync(dir);
      let count = 0; let bytes = 0;
      for (const name of files) {
        const st = fs.statSync(path.join(dir, name));
        if (!st.isFile()) continue;
        bytes += st.size;
        if (name.startsWith(prefix) && !name.endsWith('.sha256') && !name.includes('-latest.')) count++;
      }
      return { count, bytes };
    } catch {
      return { count: 0, bytes: 0 };
    }
  };
  const rcloneConf = '/userdata/storage/ubuntu/etc/gaeru-rclone/rclone.conf';
  const gdriveConfigured = fs.existsSync(rcloneConf) && rd(rcloneConf).includes('[gdrive]');
  let gdriveSyncState = null;
  try { gdriveSyncState = JSON.parse(rd('/var/lib/gaeru-gdrive-sync-status.json')); } catch {}
  let pruneState = null;
  try { pruneState = JSON.parse(rd('/var/lib/gaeru-backup-prune-status.json')); } catch {}
  const pgStats = dirStats('/userdata/storage/gaeru-pg-backups', 'gaeru_store-');
  const mediaStats = dirStats('/userdata/storage/gaeru-media-backups', 'gaeru-media-config-');
  return {
    ok: true,
    pg: listDirNewest('/userdata/storage/gaeru-pg-backups', 'gaeru_store-'),
    media: listDirNewest('/userdata/storage/gaeru-media-backups', 'gaeru-media-config-'),
    retention: {
      mi6Hours: 48,
      pcDays: 30,
      gdriveDays: 60,
      pgCount: pgStats.count,
      pgBytes: pgStats.bytes,
      mediaCount: mediaStats.count,
      mediaBytes: mediaStats.bytes,
      lastPrune: pruneState
    },
    gdrive: {
      configured: gdriveConfigured,
      remoteRoot: 'gdrive:GAERU_Backups',
      lastSync: gdriveSyncState
    }
  };
});

on('POST', '/api/backups/run', async (b) => {
  const mode = String((b && b.mode) || 'verify');
  const cmds = {
    pg: '/usr/local/sbin/gaeru-pg-backup.sh',
    media: '/usr/local/sbin/gaeru-media-backup.sh',
    gdrive: '/usr/local/sbin/gaeru-gdrive-sync.sh all',
    prune: '/usr/local/sbin/gaeru-backup-prune.sh --verbose',
    verify: '/usr/local/sbin/gaeru-full-restore.sh --verify'
  };
  const cmd = cmds[mode];
  if (!cmd) throw new Error('Chế độ backup không hợp lệ');
  const r = await sh(cmd + ' 2>&1', { timeout: 120000 });
  return { ok: r.code === 0, out: (r.out + r.err).trim() };
});

// ----------------------------------------------------------------- HTTP server
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};
const STATIC = Object.assign(Object.create(null), {
  '/': path.join(PUBLIC, 'index.html'),
  '/logo.png': path.join(PUBLIC, 'logo.png'),
  '/favicon.ico': path.join(PUBLIC, 'favicon.ico'),
  '/favicon-16x16.png': path.join(PUBLIC, 'favicon-16x16.png'),
  '/favicon-32x32.png': path.join(PUBLIC, 'favicon-32x32.png'),
  '/apple-touch-icon.png': path.join(PUBLIC, 'apple-touch-icon.png'),
  '/icon-192.png': path.join(PUBLIC, 'icon-192.png'),
  '/icon-512.png': path.join(PUBLIC, 'icon-512.png'),
  '/manifest.webmanifest': path.join(PUBLIC, 'manifest.webmanifest'),
  '/vendor/xterm.js': path.join(NM, '@xterm/xterm/lib/xterm.js'),
  '/vendor/xterm.css': path.join(NM, '@xterm/xterm/css/xterm.css'),
  '/vendor/addon-fit.js': path.join(NM, '@xterm/addon-fit/lib/addon-fit.js'),
});
const PASSIVE_POLL_PATHS = new Set(['/api/stats', '/api/processes', '/api/logs']);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && STATIC[p]) {
      const f = STATIC[p];
      if (p === '/') {
        const nonce = crypto.randomBytes(16).toString('base64');
        const html = fs.readFileSync(f, 'utf8').replace(/<script>/g, `<script nonce="${nonce}">`);
        const buf = Buffer.from(html, 'utf8');
        res.writeHead(200, secHeaders(req, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': buf.length,
          'Cache-Control': 'no-store',
          'Content-Security-Policy': `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
        }));
        return req.method === 'HEAD' ? res.end() : res.end(buf);
      }
      res.writeHead(200, secHeaders(req, {
        'Content-Type': MIME[path.extname(f)] || 'application/octet-stream',
        'Cache-Control': 'max-age=86400',
      }));
      return req.method === 'HEAD' ? res.end() : fs.createReadStream(f).on('error', () => res.end()).pipe(res);
    }
    if (p === '/api/login' && req.method === 'POST') {
      if (!checkSameOrigin(req)) return json(res, 403, { error: 'Origin không hợp lệ' }, req);
      const ip = clientIp(req);
      const lockMsg = checkIpLockout(ip);
      if (lockMsg) return json(res, 429, { error: lockMsg }, req);
      const b = await readBody(req);

      if (b && b.challengeId !== undefined) {
        const cid = String(b.challengeId || '');
        const ch = loginChallenges.get(cid);
        if (!ch || ch.exp < Date.now() || ch.ip !== ip) {
          if (cid) loginChallenges.delete(cid);
          return json(res, 401, { error: 'Phiên xác thực 2FA đã hết hạn, vui lòng nhập lại mật khẩu' }, req);
        }
        const totpCfg = readTotpConfig();
        if (!totpCfg) {
          loginChallenges.delete(cid);
          return json(res, 409, { error: '2FA chưa được cấu hình' }, req);
        }
        ch.attempts += 1;
        const code = String(b.code !== undefined ? b.code : (b.totp || ''));
        const tRes = verifyTotp(totpCfg.secret, code, totpCfg.lastStep ?? null);
        const usedBackup = tRes.ok ? false : consumeBackupCode(totpCfg, code);
        if (!tRes.ok && !usedBackup) {
          const failN = recordFailure(ip);
          console.warn(new Date().toISOString(), 'Admin 2FA FAIL from', ip, 'attempt', failN);
          if (ch.attempts >= 5) loginChallenges.delete(cid);
          await new Promise((r) => setTimeout(r, 800));
          if (ch.attempts >= 5) return json(res, 429, { error: 'Nhập sai mã 2FA quá nhiều lần, vui lòng đăng nhập lại' }, req);
          return json(res, 401, { error: 'Mã xác thực 2FA không đúng hoặc đã sử dụng' }, req);
        }
        if (tRes.ok) totpCfg.lastStep = tRes.step;
        totpCfg.updatedAt = new Date().toISOString();
        writeTotpConfig(totpCfg);
        loginChallenges.delete(cid);
        clearFailure(ip);
        issueSessionCookie(req, res);
        console.log(new Date().toISOString(), usedBackup ? 'Admin backup-code login OK from' : 'Admin 2FA login OK from', ip);
        return json(res, 200, { ok: true, usedBackup, remainingBackup: totpCfg.backupHashes.length }, req);
      }

      let verified = false;
      try { verified = await verifyRootPassword(String(b.password || '')); }
      catch (err) { return json(res, err?.status || 503, { error: err?.message || 'Lỗi xác thực' }, req); }
      if (!verified) {
        const failN = recordFailure(ip);
        console.warn(new Date().toISOString(), 'Admin login FAIL from', ip, 'attempt', failN);
        await new Promise((r) => setTimeout(r, 1000));
        return json(res, 401, { error: 'Sai mật khẩu' }, req);
      }

      const totpCfg = readTotpConfig();
      if (totpCfg && totpCfg.enabled) {
        capMapSize(loginChallenges, MAX_CHALLENGES);
        const challengeId = crypto.randomBytes(24).toString('hex');
        loginChallenges.set(challengeId, { ip, exp: Date.now() + CHALLENGE_TTL, attempts: 0 });
        return json(res, 200, { ok: true, needTotp: true, challengeId, expiresInSec: CHALLENGE_TTL / 1000 }, req);
      }
      if (!isTrustedLanClient(req)) {
        console.warn(new Date().toISOString(), 'Blocked pre-2FA login from WAN/untrusted IP', ip);
        return json(res, 403, { error: '2FA chưa được kích hoạt. Mở http://192.168.31.59:8080 từ mạng LAN để quét mã QR 2FA trước khi đăng nhập từ xa.' }, req);
      }
      const setup = await createPendingSetup(ip, false);
      return json(res, 200, { ok: true, needSetup2fa: true, ...setup }, req);
    }
    if (p === '/api/2fa/enroll' && req.method === 'POST') {
      if (!checkSameOrigin(req)) return json(res, 403, { error: 'Origin không hợp lệ' }, req);
      if (!isTrustedLanClient(req)) return json(res, 403, { error: 'Chỉ được phép kích hoạt 2FA khi truy cập từ mạng LAN' }, req);
      const ip = clientIp(req);
      const lockMsg = checkIpLockout(ip);
      if (lockMsg) return json(res, 429, { error: lockMsg }, req);
      const b = await readBody(req);
      const tok = String(b.setupToken || '');
      const s = setupChallenges.get(tok);
      if (!s || s.exp < Date.now() || s.ip !== ip) {
        if (tok) setupChallenges.delete(tok);
        return json(res, 401, { error: 'Phiên cài đặt 2FA đã hết hạn, vui lòng đăng nhập lại' }, req);
      }
      const existing = readTotpConfig();
      if (existing && !s.rekey) {
        setupChallenges.delete(tok);
        return json(res, 409, { error: '2FA đã được kích hoạt trước đó' }, req);
      }
      if (s.rekey && !authed(req, true)) {
        setupChallenges.delete(tok);
        return json(res, 401, { error: 'Cần đăng nhập hợp lệ để đổi khóa 2FA' }, req);
      }
      s.attempts += 1;
      const tRes = verifyTotp(s.secret, String(b.code || ''), null);
      if (!tRes.ok) {
        recordFailure(ip);
        if (s.attempts >= 5) setupChallenges.delete(tok);
        await new Promise((r) => setTimeout(r, 800));
        if (s.attempts >= 5) return json(res, 429, { error: 'Nhập sai mã 2FA quá nhiều lần, vui lòng bắt đầu lại' }, req);
        return json(res, 401, { error: 'Mã 6 số không khớp với Authenticator, kiểm tra lại và thử lại' }, req);
      }
      const nowIso = new Date().toISOString();
      writeTotpConfig({
        enabled: true,
        secret: s.secret,
        issuer: 'GAERU Admin',
        account: 'root@mi6',
        lastStep: tRes.step,
        backupHashes: s.backupHashes,
        createdAt: existing?.createdAt || nowIso,
        updatedAt: nowIso,
      });
      setupChallenges.delete(tok);
      clearFailure(ip);
      let activeSid = parseCookies(req).mi6sid;
      if (!authed(req, true)) activeSid = issueSessionCookie(req, res);
      const revoked = s.rekey ? revokeOtherSessions(activeSid) : 0;
      console.log(new Date().toISOString(), s.rekey ? 'Admin 2FA re-keyed from LAN' : 'Admin 2FA enrolled from LAN', ip, 'revokedSessions=', revoked);
      return json(res, 200, { ok: true, remainingBackup: s.backupHashes.length, revokedSessions: revoked }, req);
    }
    if (p === '/api/logout') {
      if (req.method !== 'POST' || req.headers['x-mi6'] !== '1' || !checkSameOrigin(req)) {
        return json(res, 403, { error: 'CSRF' }, req);
      }
      sessions.delete(parseCookies(req).mi6sid);
      const sec = isHttpsReq(req) ? '; Secure' : '';
      res.setHeader('Set-Cookie', `mi6sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${sec}`);
      return json(res, 200, { ok: true }, req);
    }
    if (p === '/api/me') {
      return json(res, 200, { authed: authed(req, false), totpEnabled: Boolean(readTotpConfig()), isLan: isTrustedLanClient(req) }, req);
    }

    if (!p.startsWith('/api/')) {
      res.writeHead(404, secHeaders(req, { 'Cache-Control': 'no-store' }));
      return res.end('Not found');
    }
    if (!checkSameOrigin(req)) return json(res, 403, { error: 'CSRF' }, req);
    const touchIdle = !(req.method === 'GET' && PASSIVE_POLL_PATHS.has(p));
    if (!authed(req, touchIdle)) return json(res, 401, { error: 'Chưa đăng nhập' }, req);
    if (req.method !== 'GET' && req.headers['x-mi6'] !== '1') return json(res, 403, { error: 'CSRF' }, req);

    // streaming endpoints
    if (p === '/api/fs/download' && req.method === 'GET') {
      const f = resolveReqPath(u.searchParams.get('path'));
      const st = fs.statSync(f);
      if (!st.isFile()) throw new Error('Chỉ hỗ trợ tải file thông thường');
      res.writeHead(200, secHeaders(req, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(f))}`,
      }));
      const rs = fs.createReadStream(f);
      req.on('close', () => { if (!rs.destroyed) rs.destroy(); });
      rs.on('error', () => { if (!res.writableEnded) res.end(); });
      return rs.pipe(res);
    }
    if (p === '/api/fs/upload' && req.method === 'PUT') {
      const f = resolveReqPath(u.searchParams.get('path'));
      const tmp = f + `.upload.${process.pid}.${Date.now()}`;
      const ws = fs.createWriteStream(tmp);
      let uploaded = 0; let settled = false;
      const failUpload = (code, msg) => {
        if (settled) return;
        settled = true;
        ws.destroy();
        try { fs.unlinkSync(tmp); } catch {}
        if (!res.headersSent) json(res, code, { error: msg }, req);
        else res.end();
      };
      req.on('data', (chunk) => {
        if (settled) return;
        uploaded += chunk.length;
        if (uploaded > MAX_UPLOAD_BYTES) {
          req.destroy();
          failUpload(413, 'File tải lên vượt giới hạn 100 MB');
          return;
        }
        if (!ws.write(chunk)) req.pause();
      });
      ws.on('drain', () => { if (!settled) req.resume(); });
      req.on('end', () => {
        if (settled) return;
        ws.end(() => {
          if (settled) return;
          try {
            applyFileOpts(tmp, statPreserveOpts(f));
            fs.renameSync(tmp, f);
            settled = true;
            json(res, 200, { ok: true, size: uploaded }, req);
          } catch (e) {
            failUpload(500, e.message);
          }
        });
      });
      req.on('aborted', () => failUpload(499, 'Upload aborted'));
      req.on('error', (e) => failUpload(500, e.message));
      ws.on('error', (e) => failUpload(500, e.message));
      return;
    }
    if (p === '/api/pg/dump' && req.method === 'GET') {
      const db = u.searchParams.get('db'); if (!NAME_RE.test(db || '')) throw new Error('Tên DB không hợp lệ');
      await pgMount();
      res.writeHead(200, secHeaders(req, {
        'Content-Type': 'application/sql',
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${db}-${new Date().toISOString().slice(0, 10)}.sql"`,
      }));
      const d = cp.spawn('chroot', [DEB, 'su', 'postgres', '-c', `pg_dump --clean --if-exists ${shq(db)}`], { env: ENV });
      d.stderr.on('data', () => {});
      d.on('error', () => { if (!res.writableEnded) res.end(); });
      req.on('close', () => { if (!res.writableEnded && !d.killed) d.kill('SIGTERM'); });
      d.stdout.pipe(res); return;
    }

    const fn = routes[req.method + ' ' + p];
    if (!fn) return json(res, 404, { error: 'API không tồn tại' }, req);
    const body = req.method === 'GET' ? {} : await readBody(req);
    json(res, 200, await fn(body, u.searchParams, req), req);
  } catch (e) {
    if (!res.headersSent) json(res, e?.status || 400, { error: e.message }, req);
    else res.end();
  }
});

server.on('upgrade', (req, socket) => {
  const sess = authedSession(req, true);
  if (!String(req.url || '').startsWith('/ws/term') || !sess) {
    return socket.destroy();
  }
  const wsKey = String(req.headers['sec-websocket-key'] || '').trim();
  if (!/^[A-Za-z0-9+/=]{16,64}$/.test(wsKey)) return socket.destroy();
  if (!req.headers.origin || !checkSameOrigin(req)) return socket.destroy();
  return handleTerminal(req, socket, sess);
});

setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) if (s.exp < now || s.idleExp < now) sessions.delete(k);
  for (const [k, c] of loginChallenges) if (c.exp < now) loginChallenges.delete(k);
  for (const [k, s] of setupChallenges) if (s.exp < now) setupChallenges.delete(k);
  let failuresPruned = false;
  for (const [ip, f] of failures) {
    if (now - f.t >= FAILURE_WINDOW_MS) { failures.delete(ip); failuresPruned = true; }
  }
  if (failuresPruned) saveFailuresToDisk();
}, 60000).unref();
process.on('unhandledRejection', (err) => console.error(new Date().toISOString(), 'Admin unhandledRejection:', err && err.message ? err.message : err));
process.on('uncaughtException', (err) => {
  console.error(new Date().toISOString(), 'Admin uncaughtException:', err && err.stack ? err.stack : err);
  if (err && (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')) return;
  process.exit(1);
});
server.requestTimeout = 60000;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

if (require.main === module) {
  stats();
  server.listen(PORT, '0.0.0.0', () => console.log(new Date().toISOString(), 'GAERU Admin listening on', PORT));
} else {
  module.exports = {
    server,
    _test: {
      base32Encode,
      base32Decode,
      generateHotp,
      generateTotp,
      verifyTotp,
      generateBackupCodes,
      consumeBackupCode,
      readTotpConfig,
      isTrustedLanClient,
      isHttpsReq,
      checkSameOrigin,
      sessions,
      failures,
      loginChallenges,
      setupChallenges,
      loadFailuresFromDisk,
      setPasswordVerifier(fn) { customPasswordVerifier = fn; },
    },
  };
}
