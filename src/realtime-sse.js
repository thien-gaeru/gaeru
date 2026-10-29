'use strict';

const express = require('express');

function createRealtimeHub({ pool, config } = {}) {
  const clients = new Map();
  let clientSequence = 0;

  function handleConnection(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    const clientId = ++clientSequence;
    const threadId = String(req.query.threadId || '').trim() || null;
    const isAdmin = Boolean(req.admin || req.session?.adminUsername);
    const customerId = req.session?.customer?.id || null;

    const client = {
      id: clientId,
      req,
      res,
      threadId,
      isAdmin,
      customerId,
      connectedAt: Date.now()
    };
    clients.set(clientId, client);

    res.write(`: connected\nevent: connected\ndata: ${JSON.stringify({ ok: true, clientId, timestamp: Date.now() })}\n\n`);

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        cleanup();
      }
    }, 25000);
    if (heartbeat.unref) heartbeat.unref();

    function cleanup() {
      clearInterval(heartbeat);
      clients.delete(clientId);
    }

    if (typeof req.on === 'function') {
      req.on('close', cleanup);
      req.on('error', cleanup);
    }
    if (typeof res.on === 'function') {
      res.on('error', cleanup);
    }
  }

  function publish(eventName, data, filter) {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    let delivered = 0;
    for (const [id, client] of clients) {
      if (typeof filter === 'function' && !filter(client)) {
        continue;
      }
      try {
        client.res.write(payload);
        delivered++;
      } catch {
        clients.delete(id);
      }
    }
    return delivered;
  }

  function notifyChatMessage(message, threadId) {
    return publish('chat_message', { threadId, message }, (client) => {
      if (client.isAdmin) return true;
      if (threadId && client.threadId === threadId) return true;
      return false;
    });
  }

  function notifyOrderUpdate(order) {
    return publish('order_update', order, (client) => {
      if (client.isAdmin) return true;
      if (order.customerId && client.customerId === order.customerId) return true;
      return false;
    });
  }

  function notifyInventoryUpdate(sku, stockQuantity) {
    return publish('inventory_update', { sku, stockQuantity });
  }

  const router = express.Router();
  router.get('/realtime/stream', handleConnection);

  return {
    router,
    handleConnection,
    publish,
    notifyChatMessage,
    notifyOrderUpdate,
    notifyInventoryUpdate,
    getClientCount: () => clients.size
  };
}

module.exports = { createRealtimeHub };
