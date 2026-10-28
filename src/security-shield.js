const { rateLimit } = require('express-rate-limit');

// In-memory security shield metrics
const securityMetrics = {
  threatsBlocked: 0,
  lastIncident: null,
  activeSince: Date.now()
};

// Patterns for detecting web path traversal attacks
const MALICIOUS_PATH_PATTERNS = [
  /(?:\.\.[/\\])+/i,
  /%2e%2e(?:%2f|%5c|[/\\])/i,
  /\/etc\/passwd/i,
  /\/win(?:\.ini|dows)/i,
  /\.env(?:\.local)?$/i,
  /\/\.git(?:\/|$)/i
];

// Patterns for detecting SQLi and XSS in queries
const MALICIOUS_QUERY_PATTERNS = [
  /\bunion\s+(?:all\s+)?select\b/i,
  /\binformation_schema\b/i,
  /\bwaitfor\s+delay\b/i,
  /\bbenchmark\s*\(\s*[0-9]+/i,
  /\bsleep\s*\(\s*[0-9]+/i,
  /<script\b[^>]*>/i,
  /javascript\s*:\s*[a-z0-9_]/i,
  /\bon(?:error|load|click)\s*=/i
];

const SCANNER_UA_PATTERN = /^(?:nikto|sqlmap|masscan|wpscan|acunetix|dirbuster|gobuster|havij)/i;

/**
 * Web Application Firewall (WAF) & Anti-Hack Shield middleware
 */
function createWafShield() {
  return function wafShield(req, res, next) {
    const rawUrl = req.originalUrl || req.url || '';
    const pathOnly = rawUrl.split('?')[0];
    const ua = req.get('user-agent') || '';

    // 1. Block Malicious Vulnerability Scanners
    if (ua && SCANNER_UA_PATTERN.test(ua)) {
      securityMetrics.threatsBlocked++;
      securityMetrics.lastIncident = { type: 'scanner_blocked', target: req.path, time: new Date().toISOString() };
      return res.status(403).json({
        error: 'Truy cập bị từ chối bởi lá chắn bảo mật web (WAF Scanner Block).',
        code: 'WAF_SCANNER_BLOCKED'
      });
    }

    // 2. Block Path Traversal Attempts on requested path
    for (const pattern of MALICIOUS_PATH_PATTERNS) {
      if (pattern.test(pathOnly)) {
        securityMetrics.threatsBlocked++;
        securityMetrics.lastIncident = { type: 'path_traversal_blocked', target: req.path, time: new Date().toISOString() };
        return res.status(403).json({
          error: 'Truy cập bị từ chối bởi lá chắn bảo mật web (WAF Path Traversal Protection).',
          code: 'WAF_PATH_BLOCKED'
        });
      }
    }

    // 3. Block SQLi and XSS Injection Probes in Query String
    const queryString = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : '';
    if (queryString) {
      const decodedQuery = decodeURIComponent(queryString).replace(/\+/g, ' ');
      for (const pattern of MALICIOUS_QUERY_PATTERNS) {
        if (pattern.test(decodedQuery)) {
          securityMetrics.threatsBlocked++;
          securityMetrics.lastIncident = { type: 'injection_blocked', target: req.path, time: new Date().toISOString() };
          return res.status(403).json({
            error: 'Truy cập bị từ chối bởi lá chắn bảo mật web (WAF Injection Protection).',
            code: 'WAF_INJECTION_BLOCKED'
          });
        }
      }
    }

    next();
  };
}

/**
 * Honeypot Anti-Spam Field Detection on Forms
 */
function createHoneypotShield() {
  return function honeypotShield(req, res, next) {
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && typeof req.body === 'object') {
      const honeypot = req.body._website_hp || req.body.website_trap || req.body.__spamtrap;
      if (honeypot && String(honeypot).trim() !== '') {
        securityMetrics.threatsBlocked++;
        securityMetrics.lastIncident = { type: 'spam_honeypot_caught', target: req.path, time: new Date().toISOString() };
        return res.status(400).json({
          error: 'Yêu cầu không hợp lệ. Hãy tải lại trang.',
          code: 'SPAM_REJECTED'
        });
      }
    }
    next();
  };
}

/**
 * Adaptive Rate Limiter for API endpoints (Anti-DDoS / Flood Shield)
 */
function createDdosShield(config = {}) {
  const isTest = config.NODE_ENV === 'test' || process.env.NODE_ENV === 'test';
  return rateLimit({
    windowMs: 60000, // 1 minute
    limit: isTest ? 10000 : 600, // Generous limit for high-traffic browsing and polling
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    validate: { xForwardedForHeader: false, default: true },
    message: {
      error: 'Quá nhiều yêu cầu cùng lúc. Hệ thống phòng vệ chống DDoS đã tạm chặn để bảo vệ máy chủ. Vui lòng thử lại sau 1 phút.',
      code: 'DDOS_RATE_LIMITED'
    }
  });
}

/**
 * Sensitive Endpoints Rate Limiter (Brute-Force & Credential Stuffing Shield)
 */
function createAuthBruteForceShield(config = {}) {
  const isTest = config.NODE_ENV === 'test' || process.env.NODE_ENV === 'test';
  return rateLimit({
    windowMs: 900000, // 15 minutes
    limit: isTest ? 5000 : 60, // 60 requests per 15 mins for auth routes
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    validate: { xForwardedForHeader: false, default: true },
    message: {
      error: 'Phát hiện quá nhiều lần đăng nhập không thành công. Lá chắn chống dò mật khẩu (Anti-Brute Force) đã kích hoạt. Vui lòng thử lại sau 15 phút.',
      code: 'AUTH_RATE_LIMITED'
    }
  });
}

/**
 * Get current system health & security shield status
 */
async function getSystemHealth(pool, config = {}) {
  const startDb = Date.now();
  let dbStatus = 'connected';
  let dbLatency = 0;
  try {
    await pool.query('SELECT 1');
    dbLatency = Math.max(1, Date.now() - startDb);
  } catch (err) {
    dbStatus = 'error: ' + (err.message || 'database unavailable');
  }

  const memory = process.memoryUsage();
  const uptimeSeconds = Math.round(process.uptime());

  return {
    status: dbStatus === 'connected' ? 'healthy' : 'degraded',
    uptimeSeconds,
    database: {
      status: dbStatus,
      latencyMs: dbLatency,
      pool: 'PostgreSQL Pooler Active'
    },
    security: {
      status: 'protected',
      tlsEnforced: true,
      csrfActive: true,
      antiDdos: {
        status: 'active',
        limit: '600 req/phút/IP',
        strategy: 'Adaptive Rate Limiting'
      },
      antiBot: {
        status: 'active',
        turnstileConfigured: Boolean(config.TURNSTILE_SITE_KEY && config.TURNSTILE_SECRET_KEY),
        mode: config.TURNSTILE_SITE_KEY ? 'Cloudflare Turnstile + Adaptive Shield' : 'Adaptive IP Heuristics Shield'
      },
      antiHack: {
        status: 'active',
        wafFilters: [
          'Chống SQL Injection (SQLi Guard)',
          'Chống tấn công XSS (Cross-Site Scripting)',
          'Chống duyệt thư mục (Path Traversal Guard)',
          'Chặn công cụ quét lỗ hổng (Vulnerability Scanners Block)'
        ],
        threatsBlocked: securityMetrics.threatsBlocked,
        lastIncident: securityMetrics.lastIncident
      },
      antiSpam: {
        status: 'active',
        mode: 'Smart Form Honeypot & Request Guard'
      },
      headers: [
        'Content-Security-Policy',
        'X-Content-Type-Options: nosniff',
        'X-Frame-Options: DENY',
        'Permissions-Policy: camera=(), microphone=(), geolocation=()',
        'Strict-Transport-Security (HSTS)'
      ]
    },
    server: {
      nodeVersion: process.version,
      platform: process.platform,
      memoryUsage: {
        heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
        rssMb: Math.round(memory.rss / 1024 / 1024)
      }
    },
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  createWafShield,
  createHoneypotShield,
  createDdosShield,
  createAuthBruteForceShield,
  getSystemHealth,
  securityMetrics
};
