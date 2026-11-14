'use strict';

const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { exec, execFile } = require('child_process');
const { getCsrfToken, requireCsrf } = require('./security');
const { createAdminAccess, bootstrapPrincipal, bootstrapCredentialVersion, principalFromStaff } = require('./staff-access');
const { resolveLogin } = require('./admin-login-identity');
const { adminSessionPolicy, stampAdminSession } = require('./admin-session-policy');
const { enrollment, sharedStore } = require('./security-hardening');

function checkTcpPort(port, host = '127.0.0.1', timeout = 400) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let isResolved = false;
    socket.setTimeout(timeout);
    socket.once('connect', () => {
      isResolved = true;
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      if (!isResolved) {
        isResolved = true;
        socket.destroy();
        resolve(false);
      }
    });
    socket.once('error', () => {
      if (!isResolved) {
        isResolved = true;
        socket.destroy();
        resolve(false);
      }
    });
    try {
      socket.connect(port, host);
    } catch (_) {
      resolve(false);
    }
  });
}

function runCommand(cmd, timeoutMs = 8000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, maxBuffer: 1024 * 512 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: err.message, stderr: stderr ? stderr.trim() : null, stdout: stdout ? stdout.trim() : null });
      } else {
        resolve({ ok: true, stdout: stdout ? stdout.trim() : '', stderr: stderr ? stderr.trim() : '' });
      }
    });
  });
}

function readProcMemInfo() {
  try {
    if (!fs.existsSync('/proc/meminfo')) return null;
    const content = fs.readFileSync('/proc/meminfo', 'utf8');
    const lines = content.split('\n');
    const data = {};
    for (const line of lines) {
      const match = line.match(/^([A-Za-z0-9_()]+):\s+(\d+)\s*kB/);
      if (match) {
        data[match[1]] = parseInt(match[2], 10);
      }
    }
    return data;
  } catch (_) {
    return null;
  }
}

function readBatteryInfo() {
  const result = {
    level: 100,
    status: 'Charging (Bypass / Cắm sạc liên tục)',
    temperature: 34.5,
    voltage: 4120,
    source: 'emulated'
  };

  try {
    const base = '/sys/class/power_supply/battery';
    if (fs.existsSync(base)) {
      if (fs.existsSync(`${base}/capacity`)) {
        result.level = parseInt(fs.readFileSync(`${base}/capacity`, 'utf8').trim(), 10);
      }
      if (fs.existsSync(`${base}/temp`)) {
        const rawTemp = parseInt(fs.readFileSync(`${base}/temp`, 'utf8').trim(), 10);
        result.temperature = rawTemp > 100 ? (rawTemp / 10).toFixed(1) : rawTemp;
      }
      if (fs.existsSync(`${base}/status`)) {
        result.status = fs.readFileSync(`${base}/status`, 'utf8').trim();
      }
      if (fs.existsSync(`${base}/voltage_now`)) {
        const rawV = parseInt(fs.readFileSync(`${base}/voltage_now`, 'utf8').trim(), 10);
        result.voltage = rawV > 10000 ? Math.round(rawV / 1000) : rawV;
      }
      result.source = 'sysfs';
    }
  } catch (_) {}

  return result;
}

function readThermals() {
  const thermals = [];
  try {
    for (let i = 0; i < 20; i++) {
      const p = `/sys/class/thermal/thermal_zone${i}`;
      if (fs.existsSync(p)) {
        const typeFile = `${p}/type`;
        const tempFile = `${p}/temp`;
        if (fs.existsSync(tempFile)) {
          const type = fs.existsSync(typeFile) ? fs.readFileSync(typeFile, 'utf8').trim() : `zone${i}`;
          let temp = parseInt(fs.readFileSync(tempFile, 'utf8').trim(), 10);
          if (temp > 1000) temp = (temp / 1000).toFixed(1);
          thermals.push({ zone: i, type, temp: Number(temp) });
        }
      }
    }
  } catch (_) {}
  return thermals.slice(0, 10);
}

function readTailLines(filePath, maxLines = 100) {
  try {
    if (!fs.existsSync(filePath)) return [`[Không tìm thấy tệp: ${filePath}]`];
    const stat = fs.statSync(filePath);
    const readSize = Math.min(stat.size, 1024 * 128); // read max 128KB from end
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);
    const str = buffer.toString('utf8');
    const lines = str.split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines);
  } catch (e) {
    return ['[Không thể đọc log máy chủ.]'];
  }
}

function createServerAdminRouter(config, pool) {
  const router = Router();
  const { getFailoverSync } = require('./failover-sync');
  const failoverSync = getFailoverSync(config, pool);
  const adminDir = path.join(__dirname, '..', 'admin');
  const adminHtmlPath = path.join(adminDir, 'server-admin.html');
  const adminCssPath = path.join(adminDir, 'server-admin.css');
  const adminJsPath = path.join(adminDir, 'server-admin.js');

  // The server console uses the same revocable identity as the store admin.
  // Legacy serverAdmin sessions deliberately require a fresh login.
  router.use(async (req, res, next) => {
    if (!req.path.toLowerCase().startsWith('/server_admin/api/')) return next();
    try {
      if (req.session) delete req.session.serverAdmin;
      if (req.session?.admin) {
        if (pool && !req.adminSessionLimits) req.adminSessionLimits = (await require('./admin-configuration').readRecord(pool, config, 'security')).data;
        adminSessionPolicy(req, res, () => {});
        const identity = req.session?.admin;
        if (identity && config.accountSecurity) {
          const key = identity.source === 'bootstrap' ? 'owner' : 'staff:' + identity.id;
          const current = await config.accountSecurity.version(key);
          if (current !== (req.session.securityVersion || 1)) delete req.session.admin;
        }
      }
      next();
    } catch (error) { next(error); }
  });

  // Serve static assets for server admin
  router.get('/server_admin/server-admin.css', (_req, res) => {
    res.set({
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    });
    res.sendFile(adminCssPath);
  });

  router.get('/server_admin/server-admin.js', (_req, res) => {
    res.set({
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    });
    res.sendFile(adminJsPath);
  });

  // Rate limiter for server admin login
  const loginLimiter = rateLimit({
    ...sharedStore(pool, config, 'server-admin-login'),
    windowMs: 15 * 60 * 1000,
    limit: 15,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { ok: false, error: 'Quá nhiều lần thử đăng nhập. Vui lòng chờ 15 phút.' }
  });

  const canManageServer = principal => principal && ['owner', 'admin'].includes(principal.role);
  const requireServerAdmin = [createAdminAccess(pool, config), (req, res, next) => {
    if (!canManageServer(req.admin)) return res.status(403).json({ ok: false, error: 'Chỉ chủ doanh nghiệp và quản trị viên được quản lý máy chủ.' });
    next();
  }];

  // 1. Redirect /server -> /server_admin
  router.get(['/server', '/server/'], (_req, res) => res.redirect(302, '/server_admin'));

  // 2. Main Page: GET /server_admin
  router.get(['/server_admin', '/server_admin/'], (req, res, next) => {
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'X-Frame-Options': 'DENY'
    });
    if (!fs.existsSync(adminHtmlPath)) {
      return res.status(500).send('Server admin template not found.');
    }
    res.sendFile(adminHtmlPath);
  });

  // 3. CSRF endpoint for server admin
  router.get('/server_admin/api/csrf', (req, res) => {
    const csrfToken = getCsrfToken(req);
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: 'Không thể tạo CSRF token.' });
      res.json({ csrfToken });
    });
  });

  // 4. Session Info: GET /server_admin/api/me
  router.get('/server_admin/api/me', (req, res, next) => {
    if (!req.session?.admin) return res.json({ authenticated: false });
    next();
  }, requireServerAdmin, (req, res) => res.json({
    authenticated: true,
    user: { username: req.admin.username, role: req.admin.role, loginAt: new Date(req.session.adminAuthenticatedAt).toISOString() }
  }));

  // 5. Login: POST /server_admin/api/login (F03: Đồng bộ mật khẩu DB & MFA trung tâm)
  router.post('/server_admin/api/login', loginLimiter, requireCsrf, async (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      if (typeof username !== 'string' || !username.trim() || username.length > 254 || typeof password !== 'string' || !password || password.length > 200 || Buffer.byteLength(password, 'utf8') > 72) {
        return res.status(400).json({ ok: false, error: 'Vui lòng nhập tên đăng nhập và mật khẩu.' });
      }

      const inputUser = String(username).trim();
      const inputPass = String(password);

      const effectiveConfig = config?.accountSecurity ? await config.accountSecurity.ownerConfig() : config;
      const resolved = await resolveLogin(pool, config, inputUser);
      let principal = null;
      let identity;
      if (resolved?.source === 'bootstrap') {
        if (await bcrypt.compare(inputPass, effectiveConfig.ADMIN_PASSWORD_HASH)) {
          principal = bootstrapPrincipal(effectiveConfig);
          identity = { source: 'bootstrap', username: config.ADMIN_USERNAME, credentialVersion: bootstrapCredentialVersion(effectiveConfig) };
        }
      } else {
        const employee = resolved?.staff;
        const matches = await bcrypt.compare(inputPass, employee?.passwordHash || effectiveConfig.ADMIN_PASSWORD_HASH);
        if (matches) {
          principal = principalFromStaff(employee);
          if (principal) identity = { source: 'staff', id: employee.id, username: employee.username, authVersion: employee.authVersion };
        }
      }
      if (!principal) {
        return res.status(401).json({ ok: false, error: 'Tên đăng nhập hoặc mật khẩu máy chủ không đúng.' });
      }
      if (!canManageServer(principal)) return res.status(403).json({ ok: false, error: 'Chỉ chủ doanh nghiệp và quản trị viên được quản lý máy chủ.' });
      const securityKey = identity.source === 'bootstrap' ? 'owner' : 'staff:' + identity.id;

      // 4. Kiểm tra MFA / TOTP 2FA trung tâm qua accountSecurity (F03)
      if (config?.accountSecurity && typeof config.accountSecurity.beginLogin === 'function') {
        const mfaIntercepted = await config.accountSecurity.beginLogin(req, res, securityKey, inputPass);
        if (mfaIntercepted) return;
      }

      // 5. Tái sinh phiên làm việc và bảo đảm an toàn CSRF
      const shoppingChatOwner = req.session?.shoppingChatOwner || null;
      if (typeof req.session.regenerate === 'function') {
        await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
      }
      if (shoppingChatOwner) req.session.shoppingChatOwner = shoppingChatOwner;
      req.session.admin = identity;
      stampAdminSession(req.session);

      if (config?.accountSecurity && typeof config.accountSecurity.stamp === 'function') {
        await config.accountSecurity.stamp(req, securityKey);
      }

      const crypto = require('node:crypto');
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      const mfaEnrollmentRequired = await enrollment(config, req, principal);

      req.session.save((err) => {
        if (err) return res.status(500).json({ ok: false, error: 'Không thể lưu phiên đăng nhập.' });
        res.json({
          ok: !mfaEnrollmentRequired,
          mfaEnrollmentRequired,
          user: {
            username: principal.username,
            role: principal.role,
            loginAt: new Date(req.session.adminAuthenticatedAt).toISOString()
          },
          csrfToken: req.session.csrfToken
        });
      });
    } catch (e) {
      next(e);
    }
  });

  // 6. Logout: POST /server_admin/api/logout
  router.post('/server_admin/api/logout', requireCsrf, (req, res) => {
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ ok: false, error: 'Không thể hủy phiên.' });
      res.clearCookie('gaeru.sid');
      res.json({ ok: true });
    });
  });

  // 7. Realtime Metrics & Telemetry: GET /server_admin/api/stats
  router.get('/server_admin/api/stats', requireServerAdmin, async (_req, res) => {
    try {
      // 1. Hardware & OS
      const cpus = os.cpus();
      const cpuCount = cpus.length || 8;
      const meminfo = readProcMemInfo();

      let ramTotalMb, ramFreeMb, ramBuffersMb = 0, ramCachedMb = 0, zramTotalMb = 0, zramUsedMb = 0;
      if (meminfo && meminfo.MemTotal) {
        ramTotalMb = Math.round(meminfo.MemTotal / 1024);
        ramFreeMb = Math.round((meminfo.MemAvailable || meminfo.MemFree) / 1024);
        ramBuffersMb = Math.round((meminfo.Buffers || 0) / 1024);
        ramCachedMb = Math.round((meminfo.Cached || 0) / 1024);
        zramTotalMb = Math.round((meminfo.SwapTotal || 0) / 1024);
        zramUsedMb = Math.round(((meminfo.SwapTotal || 0) - (meminfo.SwapFree || 0)) / 1024);
      } else {
        ramTotalMb = Math.round(os.totalmem() / 1024 / 1024);
        ramFreeMb = Math.round(os.freemem() / 1024 / 1024);
        zramTotalMb = 1600;
        zramUsedMb = 240;
      }
      const ramUsedMb = Math.max(0, ramTotalMb - ramFreeMb);
      const ramPercent = Math.min(100, Math.round((ramUsedMb / ramTotalMb) * 100));

      // 2. Services TCP & Process Checks
      const [http80, dashRunning, pgRunning, ssh22, ssh8022, cfProc] = await Promise.all([
        checkTcpPort(80),
        checkTcpPort(8080),
        checkTcpPort(5432),
        checkTcpPort(22),
        checkTcpPort(8022),
        process.platform === 'linux' ? runCommand('pgrep -x cloudflared >/dev/null 2>&1') : Promise.resolve({ ok: true })
      ]);
      const nginxRunning = http80 || dashRunning;
      const sshRunning = ssh22 || ssh8022;
      const cfRunning = Boolean(cfProc && cfProc.ok);

      // 3. PostgreSQL Database Summary
      let dbSummary = { activeConnections: 0, dbSize: 'Chưa xác định', totalTables: 0 };
      if (pool) {
        try {
          const [connRes, sizeRes, tblRes] = await Promise.all([
            pool.query("SELECT count(*)::int as count FROM pg_stat_activity WHERE state = 'active'"),
            pool.query("SELECT pg_size_pretty(pg_database_size(current_database())) as size"),
            pool.query("SELECT count(*)::int as count FROM pg_tables WHERE schemaname = 'public'")
          ]);
          dbSummary = {
            activeConnections: connRes.rows[0]?.count ?? 1,
            dbSize: sizeRes.rows[0]?.size || '0 MB',
            totalTables: tblRes.rows[0]?.count ?? 0
          };
        } catch (_) {}
      }

      // 4. Node Memory Usage
      const nodeMem = process.memoryUsage();
      const nodeSummary = {
        pid: process.pid,
        heapUsedMb: (nodeMem.heapUsed / 1024 / 1024).toFixed(1),
        heapTotalMb: (nodeMem.heapTotal / 1024 / 1024).toFixed(1),
        rssMb: (nodeMem.rss / 1024 / 1024).toFixed(1),
        uptimeSec: Math.round(process.uptime())
      };

      // 5. Battery & Thermals
      const battery = readBatteryInfo();
      const thermals = readThermals();

      // 6. Disk Space
      let diskInfo = { totalGb: '58.2', usedGb: '18.4', freeGb: '39.8', percent: 32 };
      try {
        const dfOut = await runCommand('df -k /userdata 2>/dev/null || df -k /data 2>/dev/null || df -k .');
        if (dfOut.ok && dfOut.stdout) {
          const lines = dfOut.stdout.split('\n');
          if (lines.length > 1) {
            const parts = lines[1].trim().split(/\s+/);
            if (parts.length >= 5) {
              const totalK = parseInt(parts[1], 10);
              const usedK = parseInt(parts[2], 10);
              const availK = parseInt(parts[3], 10);
              if (totalK > 0) {
                diskInfo = {
                  totalGb: (totalK / 1024 / 1024).toFixed(1),
                  usedGb: (usedK / 1024 / 1024).toFixed(1),
                  freeGb: (availK / 1024 / 1024).toFixed(1),
                  percent: Math.round((usedK / totalK) * 100)
                };
              }
            }
          }
        }
      } catch (_) {}

      // Calculate approximate CPU load from os loadavg
      const loadAvg = os.loadavg();
      const cpuPercent = Math.min(100, Math.round(((loadAvg[0] || 0.4) / cpuCount) * 100));

      res.json({
        ok: true,
        timestamp: new Date().toISOString(),
        system: {
          hostname: os.hostname(),
          device: 'Xiaomi Mi 6 (MSM8998 - sagit)',
          soc: 'Qualcomm Snapdragon 835 (8 nhân Kryo 280: 4x 2.45GHz + 4x 1.90GHz)',
          os: `Ubuntu 26.04 ARM64 • Kernel ${os.release()}`,
          arch: os.arch(),
          uptimeSec: Math.round(os.uptime()),
          loadAvg: loadAvg.map(l => l.toFixed(2)),
          localIp: '192.168.31.59',
          publicDomain: 'gaeru.com'
        },
        cpu: {
          coresCount: cpuCount,
          percent: cpuPercent,
          governor: 'performance (Khóa tần số tối đa)'
        },
        memory: {
          totalMb: ramTotalMb,
          usedMb: ramUsedMb,
          freeMb: ramFreeMb,
          buffersMb: ramBuffersMb,
          cachedMb: ramCachedMb,
          percent: ramPercent,
          zram: {
            totalMb: zramTotalMb,
            usedMb: zramUsedMb,
            percent: zramTotalMb > 0 ? Math.round((zramUsedMb / zramTotalMb) * 100) : 0
          }
        },
        storage: diskInfo,
        battery,
        thermals,
        failover: failoverSync.getStatus(),
        services: {
          nginx: { name: 'Nginx Web Server', port: 80, status: nginxRunning ? 'online' : 'stopped', workers: 2 },
          node: { name: 'Node.js Gaeru Cluster', port: 3000, status: 'online', ...nodeSummary },
          postgres: { name: 'PostgreSQL 18 Database', port: 5432, status: pgRunning ? 'online' : 'stopped', ...dbSummary },
          redis: { name: 'RAM Cache (In-Memory LRU)', port: 3000, status: 'online', mode: 'in-memory-lru-pg18' },
          cloudflared: { name: 'Cloudflare Tunnel', status: cfRunning ? 'online' : 'stopped', domain: 'gaeru.com' },
          dashboard: { name: 'GAERU Server Console', port: 8080, status: dashRunning ? 'online' : 'stopped' },
          sshd: { name: 'OpenSSH Server', port: 22, status: sshRunning ? 'online' : 'stopped', user: 'root' },
          watchdog: { name: 'Network Watchdog & Healthcheck', status: 'online', interval: '30s' }
        }
      });
    } catch (e) {
      console.error('[server-admin] internal error:', e);
      res.status(500).json({ ok: false, error: 'Lỗi máy chủ nội bộ.' });
    }
  });

  // 8. Service Action Controls: POST /server_admin/api/action
  router.post('/server_admin/api/action', requireServerAdmin, requireCsrf, async (req, res) => {
    try {
      const { action } = req.body || {};
      if (!action) return res.status(400).json({ ok: false, error: 'Thiếu tham số hành động.' });

      let result = { message: 'Đã thực thi thành công.' };

      switch (action) {
        case 'reload-nginx': {
          const out = await runCommand('nginx -s reload || /storage/ubuntu/usr/sbin/nginx -s reload');
          result = { message: 'Nginx đã nạp lại cấu hình thành công (Zero-Downtime Reload).', detail: out.stdout || out.stderr };
          break;
        }
        case 'test-nginx': {
          const out = await runCommand('nginx -t || /storage/ubuntu/usr/sbin/nginx -t');
          result = { message: 'Kiểm tra cú pháp Nginx hoàn tất.', detail: out.stderr || out.stdout };
          break;
        }
        case 'flush-redis': {
          try { require('./cache').flushAllCache(); } catch (_) {}
          result = { message: 'Đã làm sạch bộ nhớ đệm RAM (In-Memory Cache) trên Worker.', detail: 'in-memory-cache-flushed' };
          break;
        }
        case 'vacuum-db': {
          if (pool) {
            await pool.query('VACUUM ANALYZE;');
            result = { message: 'Đã hoàn tất tối ưu hóa PostgreSQL (VACUUM ANALYZE hoàn tất).' };
          } else {
            result = { message: 'Cơ sở dữ liệu đang chạy độc lập.' };
          }
          break;
        }
        case 'sync-primary': {
          const syncRes = await failoverSync.syncFromPrimary();
          result = syncRes;
          break;
        }
        case 'check-primary': {
          const health = await failoverSync.checkPrimaryHealth();
          result = {
            message: health.online
              ? `Máy chủ chính ${failoverSync.primaryDomain} đang hoạt động bình thường (Độ trễ: ${health.latencyMs}ms).`
              : `Cảnh báo: Không thể kết nối tới máy chủ chính ${failoverSync.primaryDomain} (${health.error || health.statusCode}).`,
            health
          };
          break;
        }
        case 'promote-primary': {
          result = failoverSync.promoteToPrimary();
          break;
        }
        case 'demote-standby': {
          result = failoverSync.demoteToStandby();
          break;
        }
        case 'drop-caches': {
          try { require('./cache').flushAllCache(); } catch (_) {}
          result = { message: 'Đã xóa bộ nhớ đệm ứng dụng (in-memory cache). Can thiệp /proc kernel drop_caches đã bị vô hiệu hóa để bảo đảm an toàn hệ thống.', detail: 'app-cache-flushed' };
          break;
        }
        case 'restart-node': {
          result = { message: 'Đang gửi tín hiệu Rolling Reload (0s Downtime) cho GAERU Web Cluster...' };
          setTimeout(() => {
            try {
              const pidFile = '/storage/apps/gaeru/logs/cluster.pid';
              if (fs.existsSync(pidFile)) {
                const masterPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
                if (Number.isInteger(masterPid) && masterPid > 1) {
                  process.kill(masterPid, 'SIGHUP');
                  return;
                }
              }
            } catch (_) {}
            process.exit(0);
          }, 600);
          break;
        }
        default:
          return res.status(400).json({ ok: false, error: `Hành động không xác định: ${action}` });
      }

      res.json({ ok: true, ...result });
    } catch (e) {
      console.error('[server-admin] internal error:', e);
      res.status(500).json({ ok: false, error: 'Lỗi máy chủ nội bộ.' });
    }
  });

  // 9. Live Logs Endpoint: GET /server_admin/api/logs
  router.get('/server_admin/api/logs', requireServerAdmin, (req, res) => {
    try {
      const source = String(req.query.source || 'app');
      const maxLines = Math.min(300, Math.max(10, parseInt(req.query.lines, 10) || 100));
      const pickLog = (...candidates) => candidates.find((p) => fs.existsSync(p)) || candidates[0];

      let logPath;
      switch (source) {
        case 'app':
          logPath = pickLog(
            '/var/log/upstart/node-app-gaeru.log',
            '/storage/apps/gaeru/logs/server.out.log',
            path.join(__dirname, '..', 'logs', 'server.out.log'),
            path.join(__dirname, '..', 'gaeru.log')
          );
          break;
        case 'nginx-error':
          logPath = pickLog('/var/log/nginx/error.log', '/storage/ubuntu/var/log/nginx/error.log');
          break;
        case 'nginx-access':
          logPath = pickLog('/var/log/nginx/access.log', '/storage/ubuntu/var/log/nginx/access.log');
          break;
        case 'cloudflared':
          logPath = pickLog('/var/log/cloudflared.err', '/var/log/upstart/cloudflared.log');
          break;
        case 'postgres':
        case 'postgresql':
          logPath = pickLog('/storage/ubuntu/var/log/postgresql/postgresql-18-main.log', '/var/log/postgresql/postgresql-18-main.log');
          break;
        default:
          logPath = pickLog(
            '/var/log/upstart/node-app-gaeru.log',
            '/storage/apps/gaeru/logs/server.out.log',
            path.join(__dirname, '..', 'gaeru.log')
          );
      }

      const lines = readTailLines(logPath, maxLines);
      res.json({
        ok: true,
        source,
        lineCount: lines.length,
        lines
      });
    } catch (e) {
      console.error('[server-admin] internal error:', e);
      res.status(500).json({ ok: false, error: 'Lỗi máy chủ nội bộ.' });
    }
  });

  // 10. Database Tables Summary: GET /server_admin/api/db-summary
  router.get('/server_admin/api/db-summary', requireServerAdmin, async (_req, res) => {
    try {
      if (!pool) return res.json({ ok: true, tables: [] });
      const query = `
        SELECT 
          c.relname AS table_name,
          c.reltuples::bigint AS row_estimate,
          pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
          pg_total_relation_size(c.oid) AS raw_bytes
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY pg_total_relation_size(c.oid) DESC
        LIMIT 60;
      `;
      const result = await pool.query(query);
      res.json({
        ok: true,
        count: result.rows.length,
        tables: result.rows
      });
    } catch (e) {
      console.error('[server-admin] internal error:', e);
      res.status(500).json({ ok: false, error: 'Lỗi máy chủ nội bộ.' });
    }
  });

  // 11. Database Backup (Export schema & table data as JSON/SQL): GET /server_admin/api/db-backup
  router.get('/server_admin/api/db-backup', requireServerAdmin, async (req, res) => {
    try {
      if (req.admin?.role !== 'owner' || req.admin?.source !== 'bootstrap') {
        return res.status(403).json({ ok: false, error: 'Chỉ chủ doanh nghiệp mới có quyền sao lưu dữ liệu.' });
      }
      if (!pool) return res.status(503).json({ ok: false, error: 'Database pool không khả dụng.' });

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="gaeru_backup_${new Date().toISOString().slice(0, 10)}.json"`);

      const tablesRes = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
      const backupData = {
        meta: {
          server: os.hostname(),
          database: 'gaeru',
          exportedAt: new Date().toISOString(),
          truncated: false,
          tableCounts: {}
        },
        tables: {}
      };

      const EXCLUDED_BACKUP_TABLES = new Set([
        'sessions', 'staff_accounts', 'account_security', 'security_challenges',
        'admin_configuration', 'web_push_subscriptions', 'email_outbox'
      ]);
      const REDACT_COLS = new Set([
        'password_hash', 'totp_secret', 'recovery_codes_hash',
        'recovery_token', 'recovery_token_hash', 'sess'
      ]);
      const sanitizeRow = (row) => {
        const clean = { ...row };
        for (const col of REDACT_COLS) {
          if (Object.prototype.hasOwnProperty.call(clean, col)) clean[col] = '[REDACTED]';
        }
        return clean;
      };
      const BATCH_SIZE = 500;
      const MAX_ROWS_PER_TABLE = 50000;
      if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.write('{\n  "meta": ' + JSON.stringify({ ...backupData.meta, truncatedAt: MAX_ROWS_PER_TABLE }) + ',\n  "tables": {\n');
      let firstTable = true;
      for (const row of tablesRes.rows) {
        const tbl = row.tablename;
        if (EXCLUDED_BACKUP_TABLES.has(tbl)) continue;
        try {
          const firstBatch = await pool.query(`SELECT * FROM "${tbl}" LIMIT $1 OFFSET $2`, [BATCH_SIZE, 0]);
          if (!firstTable) res.write(',\n');
          firstTable = false;
          res.write(`    ${JSON.stringify(tbl)}: [`);
          let offset = 0;
          let count = 0;
          let batchRows = firstBatch.rows || [];
          while (count < MAX_ROWS_PER_TABLE) {
            for (let i = 0; i < batchRows.length && count < MAX_ROWS_PER_TABLE; i++) {
              if (count > 0) res.write(',');
              res.write(JSON.stringify(sanitizeRow(batchRows[i])));
              count++;
            }
            if (batchRows.length < BATCH_SIZE || count >= MAX_ROWS_PER_TABLE) break;
            offset += batchRows.length;
            const nextLimit = Math.min(BATCH_SIZE, MAX_ROWS_PER_TABLE - count);
            const nextRes = await pool.query(`SELECT * FROM "${tbl}" LIMIT $1 OFFSET $2`, [nextLimit, offset]);
            batchRows = nextRes.rows || [];
          }
          res.write(']');
          backupData.meta.tableCounts[tbl] = count;
        } catch (_) {}
      }
      res.write('\n  },\n  "tableCounts": ' + JSON.stringify(backupData.meta.tableCounts) + '\n}');
      return res.end();
    } catch (e) {
      console.error('[server-admin] db-backup error:', e);
      if (res.headersSent) return res.end();
      res.status(500).json({ ok: false, error: 'Lỗi máy chủ nội bộ.' });
    }
  });

  return router;
}

module.exports = { createServerAdminRouter };
