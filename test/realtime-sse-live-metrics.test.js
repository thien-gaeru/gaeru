'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createRealtimeHub } = require('../src/realtime-sse');

test('Realtime SSE Hub: Live W3C streaming, socket lifecycle, targeting and leak prevention', async (t) => {
  const app = express();
  const hub = createRealtimeHub();

  app.use('/api', (req, res, next) => {
    if (req.query.role === 'admin') req.admin = { id: 'admin-1', role: 'owner' };
    if (req.query.customerId) req.session = { customer: { id: req.query.customerId } };
    next();
  }, hub.router);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  function connectClient(query = {}) {
    return new Promise((resolve, reject) => {
      const q = new URLSearchParams(query);
      const req = http.get(`${baseUrl}/api/realtime/stream?${q.toString()}`, (res) => {
        let buffer = '';
        const events = [];

        res.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n\n');
          buffer = lines.pop();

          for (const raw of lines) {
            if (!raw.trim()) continue;
            const parsed = {};
            const eMatch = raw.match(/event:\s*([^\n]+)/);
            const dMatch = raw.match(/data:\s*([^\n]+)/);
            if (eMatch) parsed.event = eMatch[1].trim();
            if (dMatch) {
              try { parsed.data = JSON.parse(dMatch[1].trim()); } catch { parsed.data = dMatch[1].trim(); }
            }
            events.push(parsed);

            if (parsed.event === 'connected') {
              resolve({
                events,
                headers: res.headers,
                close: () => req.destroy(),
                waitForEvent: (eventName, timeoutMs = 2000) => {
                  return new Promise((resEvt, rejEvt) => {
                    const timer = setTimeout(() => rejEvt(new Error(`Timeout đợi event ${eventName}`)), timeoutMs);
                    const check = () => {
                      const found = events.find((e) => e.event === eventName);
                      if (found) {
                        clearTimeout(timer);
                        resEvt(found);
                      } else {
                        setTimeout(check, 10);
                      }
                    };
                    check();
                  });
                }
              });
            }
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
    });
  }

  try {
    await t.test('1. Protocol Headers & Handshake: Emits text/event-stream and connected event', async () => {
      const client = await connectClient({ role: 'admin' });
      assert.equal(client.headers['content-type'], 'text/event-stream');
      assert.equal(client.headers['connection'], 'keep-alive');
      assert.equal(client.headers['cache-control'], 'no-cache, no-transform');
      assert.equal(client.headers['x-accel-buffering'], 'no');

      const connected = client.events.find((e) => e.event === 'connected');
      assert.ok(connected);
      assert.equal(connected.data.ok, true);
      assert.ok(connected.data.clientId > 0);
      client.close();
      await new Promise((r) => setTimeout(r, 30));
    });

    await t.test('2. Targeted Chat Messaging: Routes exclusively to admin and matching threadId', async () => {
      const admin = await connectClient({ role: 'admin' });
      const buyerTarget = await connectClient({ customerId: 'cust-1', threadId: 'thread-123' });
      const buyerOther = await connectClient({ customerId: 'cust-2', threadId: 'thread-456' });

      const delivered = hub.notifyChatMessage({ text: 'Alo' }, 'thread-123');
      assert.equal(delivered, 2); // admin + buyerTarget

      const adminEvt = await admin.waitForEvent('chat_message');
      const targetEvt = await buyerTarget.waitForEvent('chat_message');
      assert.equal(adminEvt.data.message.text, 'Alo');
      assert.equal(targetEvt.data.message.text, 'Alo');

      const otherEvt = buyerOther.events.filter((e) => e.event === 'chat_message');
      assert.equal(otherEvt.length, 0, 'Thread khác không được nhận tin');

      admin.close();
      buyerTarget.close();
      buyerOther.close();
      await new Promise((r) => setTimeout(r, 30));
    });

    await t.test('3. Targeted Order Update: Isolates customer orders and broadcasts to admin', async () => {
      const admin = await connectClient({ role: 'admin' });
      const owner = await connectClient({ customerId: 'owner-789' });
      const stranger = await connectClient({ customerId: 'stranger-999' });

      const delivered = hub.notifyOrderUpdate({ id: 'ord-1', customerId: 'owner-789', status: 'shipped' });
      assert.equal(delivered, 2); // admin + owner

      const adminEvt = await admin.waitForEvent('order_update');
      const ownerEvt = await owner.waitForEvent('order_update');
      assert.equal(adminEvt.data.status, 'shipped');
      assert.equal(ownerEvt.data.status, 'shipped');

      const strangerEvt = stranger.events.filter((e) => e.event === 'order_update');
      assert.equal(strangerEvt.length, 0, 'Người lạ không được nhận cập nhật đơn');

      admin.close();
      owner.close();
      stranger.close();
      await new Promise((r) => setTimeout(r, 30));
    });

    await t.test('4. Socket Lifecycle & Memory Leak Prevention: Automatically purges on disconnect', async () => {
      const beforeCount = hub.getClientCount();
      const tempClients = await Promise.all([
        connectClient(),
        connectClient(),
        connectClient()
      ]);
      assert.equal(hub.getClientCount(), beforeCount + 3);

      for (const c of tempClients) c.close();
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(hub.getClientCount(), beforeCount, 'Map clients phải tự dọn sạch sau khi đóng socket');
    });
  } finally {
    server.close();
  }
});
