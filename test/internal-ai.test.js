'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createInternalAiRouter } = require('../src/internal-ai');

test('GAERU AI Internal Test Suite', async (t) => {
  // Mock PostgreSQL Pool
  const mockOrders = [
    { order_number: 'GAE-261028-1001', customer_name: 'Nguyễn Văn A', phone: '0912345678', city: 'Hà Nội', status: 'pending', payment_status: 'pending', payment_method: 'cod', total_vnd: 450000, created_at: new Date() },
    { order_number: 'GAE-261028-1002', customer_name: 'Trần Thị B', phone: '0987654321', city: 'TP.HCM', status: 'completed', payment_status: 'paid', payment_method: 'vnpay', total_vnd: 890000, created_at: new Date() }
  ];

  const mockInventory = [
    { productName: 'GAERU P01', variantName: 'Đen 2 Mic', sku: 'P01-BLK-2M', priceVnd: 890000, stockQuantity: 3, isLowStock: true },
    { productName: 'GAERU K9', variantName: 'Bản Tiêu chuẩn', sku: 'K9-STD', priceVnd: 450000, stockQuantity: 25, isLowStock: false }
  ];

  const threadsDb = new Map();
  const messagesDb = [];
  const actionLogsDb = new Map();
  const vouchersDb = new Map();

  const mockPool = {
    query: async (sql, params = []) => {
      const q = sql.toLowerCase();

      // schema / health
      if (q.includes('schema_migrations')) return { rows: [] };

      // Business overview
      if (q.includes('from orders') && q.includes('count(case when status')) {
        return {
          rows: [{
            total_orders: 15,
            pending_orders: 2,
            confirmed_orders: 3,
            processing_orders: 4,
            shipped_orders: 1,
            completed_orders: 5,
            cancelled_orders: 0,
            paid_revenue: 4500000,
            gross_revenue: 6200000
          }]
        };
      }

      // New customers
      if (q.includes('select count(*)::int as count from customers')) {
        return { rows: [{ count: 8 }] };
      }

      // Query orders
      if (q.includes('from orders') && q.includes('order_number as "ordernumber"')) {
        return { rows: mockOrders };
      }

      // Check inventory
      if (q.includes('from product_variants') && q.includes('stock_quantity')) {
        return { rows: mockInventory };
      }

      // Threads
      if (q.includes('insert into internal_ai_threads')) {
        const id = '11111111-1111-4111-8111-111111111111';
        const row = { id, title: params[3] || 'Hội thoại mới', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        threadsDb.set(id, row);
        return { rows: [row] };
      }
      if (q.includes('select id, title') && q.includes('from internal_ai_threads')) {
        if (q.includes('where id = $1')) {
          const row = threadsDb.get(params[0]);
          return { rows: row ? [row] : [] };
        }
        return { rows: Array.from(threadsDb.values()) };
      }
      if (q.includes('update internal_ai_threads')) {
        return { rowCount: 1 };
      }
      if (q.includes('delete from internal_ai_threads')) {
        threadsDb.delete(params[0]);
        return { rowCount: 1 };
      }

      // Messages
      if (q.includes('insert into internal_ai_messages')) {
        const row = {
          id: '22222222-2222-4222-8222-222222222222',
          role: params[1],
          content: params[2],
          toolResults: params[3] ? JSON.parse(params[3]) : [],
          actionCard: params[4] ? JSON.parse(params[4]) : null,
          createdAt: new Date().toISOString()
        };
        messagesDb.push(row);
        return { rows: [row] };
      }
      if (q.includes('from internal_ai_messages')) {
        return { rows: messagesDb };
      }

      // Action logs
      if (q.includes('insert into internal_ai_action_logs')) {
        const id = '33333333-3333-4333-8333-333333333333';
        const row = { id, actionType: params[1], payload: JSON.parse(params[2]), status: 'pending', createdBy: params[3], createdAt: new Date().toISOString() };
        actionLogsDb.set(id, row);
        return { rows: [row] };
      }
      if (q.includes('from internal_ai_action_logs')) {
        const row = actionLogsDb.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      if (q.includes('update internal_ai_action_logs')) {
        const id = params[1] || params[0];
        const row = actionLogsDb.get(id);
        if (row) row.status = 'executed';
        return { rowCount: 1 };
      }

      // Vouchers
      if (q.includes('insert into marketing_vouchers')) {
        vouchersDb.set(params[0], { code: params[0], amount: params[3] });
        return { rowCount: 1 };
      }

      return { rows: [] };
    }
  };

  const app = express();
  app.use(express.json());

  let mockAdmin = { id: 'admin-01', username: 'ceo_gaeru', role: 'owner', isOwner: true, permissions: ['dashboard.read', 'finance.read', 'marketing.write'] };
  app.use((req, res, next) => {
    req.admin = mockAdmin;
    next();
  });

  app.use('/api/gaeru_ceo/internal-ai', createInternalAiRouter(mockPool, {}));

  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/gaeru_ceo/internal-ai`;

  try {
    await t.test('1. GET /quick-prompts returns role-tailored prompts', async () => {
      const res = await fetch(`${baseUrl}/quick-prompts`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.prompts));
      assert.ok(data.prompts.length >= 5);
      // Owner has executive prompt
      assert.ok(data.prompts.some(p => p.category === 'owner'));
    });

    let threadId = null;
    await t.test('2. POST /threads creates a new chat session', async () => {
      const res = await fetch(`${baseUrl}/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Tra cứu doanh thu' })
      });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.ok(data.thread.id);
      threadId = data.thread.id;
    });

    await t.test('3. POST /threads/:id/chat answers revenue with business grounding', async () => {
      const res = await fetch(`${baseUrl}/threads/${threadId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'Doanh thu hôm nay thế nào?' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.answer);
      assert.ok(data.toolResults.some(t => t.tool === 'get_business_overview'));
      // Owner can see revenue formatted
      assert.ok(data.answer.includes('Doanh thu'));
    });

    await t.test('4. POST /threads/:id/chat checks inventory and low stock alerts', async () => {
      const res = await fetch(`${baseUrl}/threads/${threadId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'Sản phẩm nào sắp hết hàng tồn kho?' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.toolResults.some(t => t.tool === 'check_inventory'));
      assert.ok(data.answer.includes('P01-BLK-2M') || data.answer.includes('GAERU P01'));
    });

    let actionId = null;
    await t.test('5. POST /threads/:id/chat generates Action Card for voucher creation', async () => {
      const res = await fetch(`${baseUrl}/threads/${threadId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'Tạo cho tôi mã giảm giá VIP50K giảm 50000đ' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.actionCard);
      assert.equal(data.actionCard.actionType, 'create_voucher');
      assert.equal(data.actionCard.status, 'pending');
      actionId = data.actionCard.actionId;
    });

    await t.test('6. POST /actions/:id/execute successfully confirms and creates voucher', async () => {
      assert.ok(actionId);
      const res = await fetch(`${baseUrl}/actions/${actionId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, 'executed');
      assert.ok(vouchersDb.size > 0);
    });

    await t.test('7. RBAC Protection: Staff role hides sensitive finance figures', async () => {
      // Switch mock user to staff without finance permission
      mockAdmin = { id: 'staff-02', username: 'cskh_01', role: 'support', isOwner: false, permissions: ['dashboard.read', 'orders.read'] };
      const res = await fetch(`${baseUrl}/threads/${threadId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'Báo cáo doanh thu hôm nay' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      const overviewTool = data.toolResults.find(t => t.tool === 'get_business_overview');
      assert.ok(overviewTool.data.revenue.note);
      assert.equal(overviewTool.data.revenue.paidVnd, undefined);
    });

    await t.test('8. GET /threads/:id/chat/stream streams SSE events smoothly', async () => {
      const res = await fetch(`${baseUrl}/threads/${threadId}/chat/stream?question=${encodeURIComponent('Tình hình kho thế nào')}`);
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type').includes('text/event-stream'));
      const text = await res.text();
      assert.ok(text.includes('event: tools'));
      assert.ok(text.includes('event: done'));
    });
  } finally {
    await new Promise(r => server.close(r));
  }
});
