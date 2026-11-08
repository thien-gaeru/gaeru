const { EventEmitter } = require('node:events');
const { z } = require('zod');
const { requirePermission } = require('./staff-access');
const { cacheEvents } = require('../cache');

class RealtimeHub {
  constructor() {
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(1000);
  }

  publish(channel, event, payload = {}) {
    const id = String(Date.now());
    const timestamp = new Date().toISOString();
    this.bus.emit(channel, {
      event,
      data: payload,
      id,
      timestamp
    });
  }

  subscribe(channel, listener) {
    this.bus.on(channel, listener);
    return () => this.bus.off(channel, listener);
  }
}

const defaultHub = new RealtimeHub();

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


// GAERU High-Performance Realtime Connection Budget
const MAX_TOTAL_SSE = Number(process.env.MAX_SSE_CONNECTIONS) || 1000;
const MAX_PER_IP_SSE = Number(process.env.MAX_PER_IP_SSE) || (process.env.NODE_ENV === 'test' ? 60 : 50);

const activeSseConnections = new Set();
const ipSseCounts = new Map();

function getActiveSseCount() {
  return activeSseConnections.size;
}

function acquireSseSlot(req, res) {
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

  // GAERU RT-01: Release slot strictly on response close/finish.
  // In modern Node.js, req emits 'end' and 'close' immediately when GET request headers finish,
  // while the SSE response stream is still alive and streaming.
  res.once?.('close', release);
  res.once?.('finish', release);
  return true;
}

const activeStreams = new Set();

function openSseStream(req, res, channel, { hub = defaultHub, isAdmin = false, checkSession = null } = {}) {
  if (!acquireSseSlot(req, res)) return;
  activeStreams.add(res);
  try {
    req.socket?.setNoDelay?.(true);
    req.socket?.setKeepAlive?.(true, 10000);
  } catch (_) {}
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff'
  });

  res.write(': connected\n\n');
  res.write(`event: init\ndata: ${JSON.stringify({ connected: true, channel, at: Date.now() })}\n\n`);

  const onEvent = ({ event, data, id }) => {
    if (res.writableEnded) return;
    res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const unsubscribe = hub.subscribe(channel, onEvent);

  const heartbeatTimer = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(heartbeatTimer);
      return;
    }
    if (checkSession) {
      const valid = checkSession(req);
      if (!valid) {
        res.write(`event: session-expired\ndata: ${JSON.stringify({ error: 'Phiên quản trị đã hết hạn hoặc cần xác thực lại.' })}\n\n`);
        res.end();
        clearInterval(heartbeatTimer);
        return;
      }
    }
    res.write(': ping\n\n');
  }, 15000);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeatTimer);
    unsubscribe();
    activeStreams.delete(res);
  };

  // GAERU RT-01: Cleanup SSE subscription and timers strictly on response close/finish.
  res.once?.('close', cleanup);
  res.once?.('finish', cleanup);
}

function createRealtimeRouter({ pool, config, hub = defaultHub } = {}) {
  const adminRouter = require('express').Router();
  const publicRouter = require('express').Router();

  adminRouter.get('/realtime-sse', requirePermission('dashboard.read'), (req, res) => {
    openSseStream(req, res, 'admin', {
      hub,
      isAdmin: true,
      checkSession: checkAdminSessionValid
    });
  });

  adminRouter.get('/care-requests/:id/realtime-sse', requirePermission('orders.read'), (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).end();
    openSseStream(req, res, 'care:' + req.params.id, {
      hub,
      isAdmin: true,
      checkSession: checkAdminSessionValid
    });
  });

  adminRouter.get('/shopping-chat/:id/realtime-sse', requirePermission('customers.read'), (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).end();
    openSseStream(req, res, 'shopping_chat:' + req.params.id, {
      hub,
      isAdmin: true,
      checkSession: checkAdminSessionValid
    });
  });

  publicRouter.get('/care/:id/realtime-sse', async (req, res, next) => {
    try {
      const id = req.session?.customer?.id;
      if (!id || !z.string().uuid().safeParse(req.params.id).success) return res.status(401).end();
      const owned = (await pool.query('SELECT id FROM care_requests WHERE id=$1 AND customer_id=$2', [req.params.id, id])).rows[0];
      if (!owned) return res.status(404).end();
      openSseStream(req, res, 'care:' + req.params.id, { hub, isAdmin: false });
    } catch (e) { next(e); }
  });

  publicRouter.get('/threads/:id/realtime-sse', async (req, res, next) => {
    try {
      if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).end();
      const ownerKey = req.session?.shoppingChatOwner ? require('node:crypto').createHash('sha256').update(req.session.shoppingChatOwner).digest('hex') : '';
      const customerId = req.session?.customer?.id || null;
      const thread = (await pool.query(
        'SELECT id FROM shopping_chat_threads WHERE id=$1 AND ((customer_id IS NULL AND owner_key=$2) OR customer_id=$3)',
        [req.params.id, ownerKey, customerId]
      )).rows[0];
      if (!thread) return res.status(404).end();
      openSseStream(req, res, 'shopping_chat:' + req.params.id, { hub, isAdmin: false });
    } catch (e) { next(e); }
  });

  return { adminRouter, publicRouter, hub };
}

function publishAdminEvent(event, data) {
  defaultHub.publish('admin', event, data);
}

function publishCareEvent(careId, event, data) {
  defaultHub.publish('care:' + careId, event, data);
  defaultHub.publish('admin', 'care:update', { careId, ...data });
}

function publishChatEvent(threadId, event, data) {
  defaultHub.publish('shopping_chat:' + threadId, event, data);
  defaultHub.publish('admin', 'chat:message', { threadId, ...data });
  defaultHub.publish('admin', 'shopping_chat:message', { threadId, ...data });
  if (event === 'chat:update') {
    defaultHub.publish('admin', 'chat:update', { threadId, ...data });
  }
}

// Danh sách client đang kết nối kênh Realtime Cache / Data SSE (/api/realtime)
const realtimeClients = new Set();

function sseHandler(req, res) {
  if (!acquireSseSlot(req, res)) return;
  try {
    req.socket?.setNoDelay?.(true);
    req.socket?.setKeepAlive?.(true, 10000);
  } catch (_) {}
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff'
  });

  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', timestamp: Date.now() })}\n\n`);
  realtimeClients.add(res);

  const heartbeat = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(heartbeat);
      return;
    }
    try {
      res.write(': keepalive\n\n');
    } catch (_) {}
  }, 15000);
  if (heartbeat.unref) heartbeat.unref();

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    realtimeClients.delete(res);
  };

  // GAERU RT-01: Remove SSE client strictly on response close/finish.
  res.once?.('close', cleanup);
  res.once?.('finish', cleanup);
}

// Khi có Cache Tag bị xóa, thông báo ngay tới mọi trình duyệt đang mở trang
cacheEvents.on('invalidated', (payload) => {
  try {
    defaultHub.publish('admin', 'cache:invalidated', payload);
  } catch (_) {}
  if (realtimeClients.size === 0) return;
  const message = `data: ${JSON.stringify({ type: 'CACHE_INVALIDATED', ...payload })}\n\n`;
  for (const client of realtimeClients) {
    try {
      client.write(message);
    } catch (_) {
      realtimeClients.delete(client);
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
  createRealtimeRouter,
  publishAdminEvent,
  publishCareEvent,
  publishChatEvent,
  sseHandler,
  realtimeClients,
  activeStreams,
  closeAllSseStreams,
  getActiveSseCount,
  MAX_TOTAL_SSE,
  MAX_PER_IP_SSE
};
