const { EventEmitter } = require('node:events');
const { z } = require('zod');
const { requirePermission } = require('./staff-access');

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

function openSseStream(req, res, channel, { hub = defaultHub, isAdmin = false, checkSession = null } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
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
  }, 20000);

  const cleanup = () => {
    clearInterval(heartbeatTimer);
    unsubscribe();
  };

  req.on('close', cleanup);
  req.on('end', cleanup);
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

module.exports = {
  RealtimeHub,
  defaultHub,
  openSseStream,
  checkAdminSessionValid,
  createRealtimeRouter,
  publishAdminEvent,
  publishCareEvent,
  publishChatEvent
};
