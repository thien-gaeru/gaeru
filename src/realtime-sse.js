const { EventEmitter } = require('node:events');
const { z } = require('zod');
const { requirePermission } = require('./staff-access');
const { cacheEvents } = require('../cache');

class RealtimeHub {
  constructor({ clusterSync = false } = {}) {
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(1000);
    this.clusterSync = Boolean(clusterSync);
  }

  emitLocal(channel, event, payload = {}, meta = {}) {
    const id = meta.id || String(Date.now());
    const timestamp = meta.timestamp || new Date().toISOString();
    this.bus.emit(channel, {
      event,
      data: payload,
      id,
      timestamp
    });
  }

  publish(channel, event, payload = {}) {
    const id = String(Date.now());
    const timestamp = new Date().toISOString();
    this.emitLocal(channel, event, payload, { id, timestamp });
    if (this.clusterSync && typeof process.send === 'function') {
      try {
        process.send({
          type: 'REALTIME_SSE_EVENT',
          channel,
          event,
          payload,
          id,
          timestamp
        });
      } catch (_) {}
    }
  }

  subscribe(channel, listener) {
    this.bus.on(channel, listener);
    return () => this.bus.off(channel, listener);
  }
}

const defaultHub = new RealtimeHub({ clusterSync: true });

const SSE_IPC_LISTENER_KEY = Symbol.for('gaeru.realtimeSse.ipcRegistered');
if (typeof process.on === 'function' && !process[SSE_IPC_LISTENER_KEY]) {
  process[SSE_IPC_LISTENER_KEY] = true;
  process.on('message', (msg) => {
    if (msg && msg.type === 'REALTIME_SSE_EVENT' && typeof msg.channel === 'string' && typeof msg.event === 'string') {
      defaultHub.emitLocal(msg.channel, msg.event, msg.payload ?? {}, {
        id: msg.id,
        timestamp: msg.timestamp
      });
    }
  });
}

function configureSseSocket(req, res) {
  try {
    req?.setTimeout?.(0);
    res?.setTimeout?.(0);
    req?.socket?.setTimeout?.(0);
    req?.socket?.setNoDelay?.(true);
    req?.socket?.setKeepAlive?.(true, 10000);
  } catch (_) {}
}

function checkAdminSessionValid(req) {
  if (!req.session?.admin) return false;
  const now = Date.now();
  const idleMs = (req.adminSessionLimits?.idleMinutes || 30) * 60000;
  const absoluteMs = (req.adminSessionLimits?.absoluteHours || 8) * 3600000;
  if (!req.session.adminAuthenticatedAt || !req.session.adminLastSeenAt) return false;
  if (now - req.session.adminAuthenticatedAt >= absoluteMs || now - req.session.adminLastSeenAt >= idleMs) {
    delete req.session.admin;
    delete req.session.adminAuthenticatedAt;
    delete req.session.adminLastSeenAt;
    return false;
  }
  return true;
}

const SSE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function checkAdminSessionDbValid(pool, req) {
  if (pool && typeof pool.query === 'function') {
    const isMemorySessionStore = req?.sessionStore?.constructor?.name === 'MemoryStore';
    if (req.sessionID && !isMemorySessionStore) {
      const sRow = (await pool.query('SELECT sess, expire FROM user_sessions WHERE sid = $1 LIMIT 1', [req.sessionID])).rows[0];
      if (!sRow || (sRow.expire && new Date(sRow.expire).getTime() <= Date.now())) {
        return false;
      }
      const sess = typeof sRow.sess === 'string' ? JSON.parse(sRow.sess) : sRow.sess;
      if (!sess?.admin) return false;
      if (Number.isFinite(sess.adminLastSeenAt) && req.session) {
        req.session.adminLastSeenAt = Math.max(Number(req.session.adminLastSeenAt || 0), sess.adminLastSeenAt);
      }
    }
    const sessionAdmin = req.session?.admin;
    const admin = req.admin || sessionAdmin;
    if (admin?.source === 'staff' && admin?.id && SSE_UUID_RE.test(String(admin.id))) {
      const staffRow = (await pool.query('SELECT active, auth_version AS "authVersion" FROM staff_accounts WHERE id = $1 LIMIT 1', [admin.id])).rows[0];
      if (!staffRow || staffRow.active !== true) return false;
      const expectedAuthVer = Number.isInteger(sessionAdmin?.authVersion) ? sessionAdmin.authVersion : admin.authVersion;
      if (Number.isInteger(expectedAuthVer) && Number(staffRow.authVersion) !== expectedAuthVer) return false;
    }
    const secVer = sessionAdmin?.securityVersion ?? admin?.securityVersion ?? req.session?.securityVersion;
    if (Number.isInteger(secVer) && admin) {
      const accountKey = admin.source === 'bootstrap' ? 'owner' : (admin.id ? `staff:${admin.id}` : '');
      if (accountKey) {
        const secRow = (await pool.query('SELECT version FROM account_security WHERE account_key = $1 LIMIT 1', [accountKey])).rows[0];
        if (secRow && Number(secRow.version) !== secVer) return false;
      }
    }
  }
  return checkAdminSessionValid(req);
}

async function checkCustomerSessionDbValid(pool, req) {
  const customerId = req.session?.customer?.id;
  if (!customerId) return false;
  if (pool && typeof pool.query === 'function') {
    const isMemorySessionStore = req?.sessionStore?.constructor?.name === 'MemoryStore';
    if (req.sessionID && !isMemorySessionStore) {
      const sRow = (await pool.query('SELECT sess, expire FROM user_sessions WHERE sid = $1 LIMIT 1', [req.sessionID])).rows[0];
      if (!sRow || (sRow.expire && new Date(sRow.expire).getTime() <= Date.now())) {
        return false;
      }
      const sess = typeof sRow.sess === 'string' ? JSON.parse(sRow.sess) : sRow.sess;
      if (!sess?.customer?.id || String(sess.customer.id) !== String(customerId)) return false;
      if (Number.isInteger(sess.securityVersion) && req.session) {
        req.session.securityVersion = sess.securityVersion;
      }
    }
    if (!SSE_UUID_RE.test(String(customerId))) return false;
    const custRow = (await pool.query('SELECT id FROM customers WHERE id = $1 AND active = true AND deleted_at IS NULL LIMIT 1', [customerId])).rows[0];
    if (!custRow) return false;
    const expectedSecVer = Number.isInteger(req.session?.securityVersion) ? req.session.securityVersion : 1;
    const secRow = (await pool.query('SELECT version FROM account_security WHERE account_key = $1 LIMIT 1', [`customer:${customerId}`])).rows[0];
    const dbSecVer = secRow ? Number(secRow.version) : 1;
    if (dbSecVer !== expectedSecVer) return false;
  }
  return true;
}


// GAERU High-Performance Realtime Connection Budget
const MAX_TOTAL_SSE = Number(process.env.MAX_SSE_CONNECTIONS) || 1000;
const MAX_PER_IP_SSE = Number(process.env.MAX_PER_IP_SSE) || (process.env.NODE_ENV === 'test' ? 60 : 50);

const activeSseConnections = new Set();
const ipSseCounts = new Map();

function getActiveSseCount() {
  return activeSseConnections.size;
}

function isStreamClosed(req, res) {
  return Boolean(
    !res ||
    res.closed ||
    res.destroyed ||
    res.writableEnded ||
    req?.aborted ||
    req?.socket?.destroyed
  );
}

function canReceiveAdminEvent(admin, event) {
  if (!admin) return false;
  if (admin.role === 'owner' || admin.source === 'bootstrap' || admin.isOwner === true) return true;
  const perms = Array.isArray(admin.permissions) ? admin.permissions : [];
  const ev = String(event || '');
  if (ev.startsWith('chat:') || ev.startsWith('shopping_chat:')) return perms.includes('customers.read');
  if (ev.startsWith('care:') || ev.startsWith('order:') || ev.startsWith('after_sales:')) return perms.includes('orders.read');
  if (ev.startsWith('inventory:') || ev.startsWith('stock:')) return perms.includes('inventory.read') || perms.includes('catalog.read');
  if (ev.startsWith('marketing:')) return perms.includes('marketing.read');
  if (ev.startsWith('finance:')) return perms.includes('finance.read');
  if (ev.startsWith('product:')) return perms.includes('catalog.read');
  return perms.includes('dashboard.read');
}

function redactAdminBroadcastPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const { body: _body, content: _content, file: _file, message: _message, text: _text, ...safeMeta } = data;
  return safeMeta;
}

function acquireSseSlot(req, res) {
  if (isStreamClosed(req, res)) {
    return false;
  }
  if (activeSseConnections.size >= MAX_TOTAL_SSE) {
    if (typeof res.status === 'function') {
      res.status(503).json({ error: 'Hệ thống đang phục vụ lượng kết nối thời gian thực tối đa. Vui lòng thử lại sau.' });
    } else {
      res.writeHead?.(503, { 'Content-Type': 'application/json' });
      res.end?.(JSON.stringify({ error: 'Hệ thống đang phục vụ lượng kết nối thời gian thực tối đa. Vui lòng thử lại sau.' }));
    }
    return false;
  }
  const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';
  const currentIpCount = ipSseCounts.get(ip) || 0;
  if (currentIpCount >= MAX_PER_IP_SSE) {
    if (typeof res.status === 'function') {
      res.status(429).json({ error: 'Quá nhiều kết nối đồng thời từ thiết bị này.' });
    } else {
      res.writeHead?.(429, { 'Content-Type': 'application/json' });
      res.end?.(JSON.stringify({ error: 'Quá nhiều kết nối đồng thời từ thiết bị này.' }));
    }
    return false;
  }
  ipSseCounts.set(ip, currentIpCount + 1);
  activeSseConnections.add(res);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeSseConnections.delete(res);
    const count = ipSseCounts.get(ip) || 1;
    if (count <= 1) {
      ipSseCounts.delete(ip);
    } else {
      ipSseCounts.set(ip, count - 1);
    }
  };

  // GAERU RT-01 & SEC-01: Release slot strictly on response close/finish/error,
  // and immediately release if the response already closed before listeners attached.
  res.once?.('close', release);
  res.once?.('finish', release);
  res.once?.('error', release);
  if (isStreamClosed(req, res)) {
    release();
    return false;
  }
  return true;
}

const activeStreams = new Set();

function openSseStream(req, res, channel, { hub = defaultHub, isAdmin = false, checkSession = null, filterEvent = null } = {}) {
  if (isStreamClosed(req, res)) return;
  if (!acquireSseSlot(req, res)) return;
  activeStreams.add(res);
  configureSseSocket(req, res);

  let cleanedUp = false;
  let unsubscribe = null;
  let heartbeatTimer = null;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (typeof unsubscribe === 'function') {
      const fn = unsubscribe;
      unsubscribe = null;
      try { fn(); } catch (_) {}
    }
    activeStreams.delete(res);
  };

  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff'
    });
    res.write(': connected\n\n');
    res.write(`event: init\ndata: ${JSON.stringify({ connected: true, channel, at: Date.now() })}\n\n`);
  } catch (_) {
    cleanup();
    try { res.destroy?.(); } catch (_) {}
    return;
  }

  const onEvent = ({ event, data, id }) => {
    if (cleanedUp || isStreamClosed(req, res)) {
      cleanup();
      return;
    }
    if (typeof filterEvent === 'function') {
      try {
        if (!filterEvent(event, data)) return;
      } catch (_) {
        return;
      }
    }
    if (typeof res.writableLength === 'number' && res.writableLength > 512 * 1024) {
      cleanup();
      try { res.end(); } catch (_) {}
      return;
    }
    try {
      res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (_) {
      cleanup();
      try { res.destroy?.(); } catch (_) {}
    }
  };

  unsubscribe = hub.subscribe(channel, onEvent);

  let checkInFlight = false;
  let consecutiveDbErrors = 0;
  heartbeatTimer = setInterval(async () => {
    if (cleanedUp || isStreamClosed(req, res)) {
      cleanup();
      return;
    }
    if (checkInFlight) return;
    checkInFlight = true;
    try {
      if (checkSession) {
        let valid = false;
        try {
          valid = Boolean(await checkSession(req));
          consecutiveDbErrors = 0;
        } catch (_) {
          consecutiveDbErrors++;
          valid = consecutiveDbErrors < 2;
        }
        if (cleanedUp || isStreamClosed(req, res)) {
          cleanup();
          return;
        }
        if (!valid) {
          try {
            if (!isStreamClosed(req, res)) {
              res.write(`event: session-expired\ndata: ${JSON.stringify({ error: isAdmin ? 'Phiên quản trị đã hết hạn hoặc đã bị thu hồi.' : 'Phiên đăng nhập đã hết hạn hoặc đã bị thu hồi.' })}\n\n`);
              res.end();
            }
          } catch (_) {}
          cleanup();
          return;
        }
      }
      if (!cleanedUp && !isStreamClosed(req, res)) {
        try {
          res.write(': ping\n\n');
        } catch (_) {
          cleanup();
        }
      }
    } catch (_) {
      cleanup();
    } finally {
      checkInFlight = false;
    }
  }, 15000);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  // GAERU RT-01 & SEC-01: Cleanup SSE subscription and timers strictly on response close/finish/error.
  res.once?.('close', cleanup);
  res.once?.('finish', cleanup);
  res.once?.('error', cleanup);
  if (isStreamClosed(req, res)) {
    cleanup();
  }
}

function createRealtimeRouter({ pool, config, hub = defaultHub } = {}) {
  const adminRouter = require('express').Router();
  const publicRouter = require('express').Router();

  const adminSessionChecker = (req) => checkAdminSessionDbValid(pool, req);

  adminRouter.get('/realtime-sse', requirePermission('dashboard.read'), (req, res) => {
    const principal = req.admin;
    openSseStream(req, res, 'admin', {
      hub,
      isAdmin: true,
      checkSession: adminSessionChecker,
      filterEvent: (event) => canReceiveAdminEvent(principal, event)
    });
  });

  adminRouter.get('/care-requests/:id/realtime-sse', requirePermission('orders.read'), (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).end();
    openSseStream(req, res, 'care:' + req.params.id, {
      hub,
      isAdmin: true,
      checkSession: adminSessionChecker
    });
  });

  adminRouter.get('/shopping-chat/:id/realtime-sse', requirePermission('customers.read'), (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).end();
    openSseStream(req, res, 'shopping_chat:' + req.params.id, {
      hub,
      isAdmin: true,
      checkSession: adminSessionChecker
    });
  });

  publicRouter.get('/care/:id/realtime-sse', async (req, res, next) => {
    try {
      const id = req.session?.customer?.id;
      if (!id || !z.string().uuid().safeParse(req.params.id).success) return res.status(401).end();
      if (!(await checkCustomerSessionDbValid(pool, req))) return res.status(401).end();
      const owned = (await pool.query('SELECT id FROM care_requests WHERE id=$1 AND customer_id=$2', [req.params.id, id])).rows[0];
      if (!owned) return res.status(404).end();
      openSseStream(req, res, 'care:' + req.params.id, {
        hub,
        isAdmin: false,
        checkSession: (r) => checkCustomerSessionDbValid(pool, r)
      });
    } catch (e) { next(e); }
  });

  publicRouter.get('/threads/:id/realtime-sse', async (req, res, next) => {
    try {
      if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).end();
      const ownerKey = req.session?.shoppingChatOwner ? require('node:crypto').createHash('sha256').update(req.session.shoppingChatOwner).digest('hex') : '';
      const customerId = req.session?.customer?.id || null;
      if (customerId && !(await checkCustomerSessionDbValid(pool, req))) return res.status(401).end();
      const thread = (await pool.query(
        'SELECT id FROM shopping_chat_threads WHERE id=$1 AND ((customer_id IS NULL AND owner_key=$2) OR customer_id=$3)',
        [req.params.id, ownerKey, customerId]
      )).rows[0];
      if (!thread) return res.status(404).end();
      openSseStream(req, res, 'shopping_chat:' + req.params.id, {
        hub,
        isAdmin: false,
        checkSession: customerId ? (r) => (r.session?.customer?.id ? checkCustomerSessionDbValid(pool, r) : false) : null
      });
    } catch (e) { next(e); }
  });

  return { adminRouter, publicRouter, hub };
}

function publishAdminEvent(event, data) {
  defaultHub.publish('admin', event, data);
}

function publishCareEvent(careId, event, data) {
  defaultHub.publish('care:' + careId, event, data);
  defaultHub.publish('admin', 'care:update', { careId, ...redactAdminBroadcastPayload(data) });
}

function publishChatEvent(threadId, event, data) {
  defaultHub.publish('shopping_chat:' + threadId, event, data);
  const safeAdminPayload = { threadId, ...redactAdminBroadcastPayload(data) };
  defaultHub.publish('admin', 'chat:message', safeAdminPayload);
  defaultHub.publish('admin', 'shopping_chat:message', safeAdminPayload);
  if (event === 'chat:update') {
    defaultHub.publish('admin', 'chat:update', safeAdminPayload);
  }
}

// Danh sách client đang kết nối kênh Realtime Cache / Data SSE (/api/realtime)
const realtimeClients = new Set();

function sseHandler(req, res) {
  if (isStreamClosed(req, res)) return;
  if (!acquireSseSlot(req, res)) return;
  configureSseSocket(req, res);

  let cleanedUp = false;
  let heartbeat = null;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    realtimeClients.delete(res);
  };

  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff'
    });
    res.write(`data: ${JSON.stringify({ type: 'CONNECTED', timestamp: Date.now() })}\n\n`);
  } catch (_) {
    cleanup();
    try { res.destroy?.(); } catch (_) {}
    return;
  }
  realtimeClients.add(res);

  heartbeat = setInterval(() => {
    if (cleanedUp || isStreamClosed(req, res)) {
      cleanup();
      return;
    }
    try {
      res.write(': keepalive\n\n');
    } catch (_) {
      cleanup();
    }
  }, 15000);
  if (heartbeat.unref) heartbeat.unref();

  // GAERU RT-01 & SEC-01: Remove SSE client strictly on response close/finish/error.
  res.once?.('close', cleanup);
  res.once?.('finish', cleanup);
  res.once?.('error', cleanup);
  if (isStreamClosed(req, res)) {
    cleanup();
  }
}

const PUBLIC_SSE_TAGS = new Set(['*', 'catalog', 'stock', 'product', 'products', 'promotion', 'promotions', 'news', 'pages', 'store-config', 'payment-channels', 'shipping', 'bundles']);
function filterPublicCacheTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.filter((t) => {
    const s = String(t || '');
    return PUBLIC_SSE_TAGS.has(s) || s.startsWith('product:') || s.startsWith('news:');
  });
}

// Khi có Cache Tag bị xóa, thông báo ngay tới mọi trình duyệt đang mở trang
cacheEvents.on('invalidated', (payload) => {
  if (!payload?.fromIpc) {
    try {
      defaultHub.publish('admin', 'cache:invalidated', payload);
    } catch (_) {}
  }
  if (realtimeClients.size === 0) return;
  const publicTags = filterPublicCacheTags(payload?.tags);
  if (publicTags.length === 0) return;
  const publicPayload = {
    tags: publicTags,
    timestamp: payload?.timestamp || Date.now()
  };
  const message = `data: ${JSON.stringify({ type: 'CACHE_INVALIDATED', ...publicPayload })}\n\n`;
  for (const client of realtimeClients) {
    try {
      client.write(message);
    } catch (_) {
      realtimeClients.delete(client);
      try { client.end?.(); } catch (__) {}
    }
  }
});

function closeAllSseStreams() {
  for (const client of realtimeClients) {
    try {
      client.write?.('event: shutdown\ndata: {"shutdown":true}\n\n');
      client.end?.();
    } catch (_) {}
  }
  realtimeClients.clear();
  for (const stream of activeStreams) {
    try {
      stream.write?.('event: shutdown\ndata: {"shutdown":true}\n\n');
      stream.end?.();
    } catch (_) {}
  }
  activeStreams.clear();
}

module.exports = {
  RealtimeHub,
  defaultHub,
  openSseStream,
  checkAdminSessionValid,
  checkAdminSessionDbValid,
  checkCustomerSessionDbValid,
  createRealtimeRouter,
  publishAdminEvent,
  publishCareEvent,
  publishChatEvent,
  sseHandler,
  realtimeClients,
  activeStreams,
  closeAllSseStreams,
  acquireSseSlot,
  filterPublicCacheTags,
  getActiveSseCount,
  MAX_TOTAL_SSE,
  MAX_PER_IP_SSE
};
