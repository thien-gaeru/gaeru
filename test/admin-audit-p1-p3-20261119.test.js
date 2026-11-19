'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('P1: Internal Admin AI reports both active and pending warranty activations', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/internal-ai.js'), 'utf8');
  assert.match(src, /COUNT\(\*\)\s+FILTER\s*\(WHERE\s+status\s*=\s*'active'\)::int\s+AS\s+active_count/i);
  assert.match(src, /COUNT\(\*\)\s+FILTER\s*\(WHERE\s+status\s*=\s*'pending'\)::int\s+AS\s+pending_count/i);
  assert.match(src, /out\.pendingWarranties\s*=\s*warRes\.rows\[0\]\?\.pending_count\s*\|\|\s*0/);
  assert.match(src, /Chờ duyệt:\s*\*\*\$\{care\.pendingWarranties\}\*\*\s*yêu cầu/);

  const { createInternalAiRouter } = require('../src/internal-ai');
  const threadUuid = '11111111-1111-4111-8111-111111111111';
  const mockPool = {
    async query(sql, params) {
      if (/FROM shopping_chat_threads/i.test(sql)) {
        return { rows: [{ open_chats: 2, awaiting_admin: 1 }] };
      }
      if (/FROM warranty_activations/i.test(sql)) {
        return { rows: [{ active_count: 3, pending_count: 10 }] };
      }
      if (/FROM order_after_sales/i.test(sql)) {
        return { rows: [{ total: 0 }] };
      }
      if (/FROM internal_ai_threads/i.test(sql)) {
        return { rows: [{ id: threadUuid, title: 'Kiểm tra bảo hành' }] };
      }
      if (/INSERT INTO internal_ai_messages[\s\S]*RETURNING/i.test(sql)) {
        return {
          rows: [{
            id: 'msg-assistant-1',
            role: params[1],
            content: params[2],
            toolResults: JSON.parse(params[3] || '[]'),
            actionCard: params[4] ? JSON.parse(params[4]) : null,
            createdAt: new Date().toISOString()
          }]
        };
      }
      if (/FROM internal_ai_messages/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
  const router = createInternalAiRouter(mockPool, {});

  const chatLayer = router.stack.find(l => l.route?.path === '/threads/:id/chat');
  assert.ok(chatLayer, 'POST /threads/:id/chat route should exist');

  let statusCode = 200;
  let body = null;
  const req = {
    admin: { id: 'owner-1', username: 'owner', role: 'owner', isOwner: true, permissions: ['*'] },
    params: { id: threadUuid },
    body: { question: 'Tình hình hội thoại chat khách hàng và bảo hành đang chờ' }
  };
  const res = {
    status(c) { statusCode = c; return this; },
    json(payload) { body = payload; return this; }
  };

  const handler = chatLayer.route.stack[chatLayer.route.stack.length - 1].handle;
  await handler(req, res, (err) => { if (err) throw err; });

  assert.equal(statusCode, 200);
  const replyText = body?.answer || '';
  assert.ok(replyText, 'Should produce an assistant answer');
  assert.match(replyText, /Bảo hành kích hoạt:\s*\*\*3\*\* thiết bị/, 'Should show active warranties');
  assert.match(replyText, /Chờ duyệt:\s*\*\*10\*\* yêu cầu/, 'Should show pending warranties');
  const careTool = (body?.toolResults || []).find(t => t.tool === 'get_customer_care');
  assert.equal(careTool?.data?.activeWarranties, 3);
  assert.equal(careTool?.data?.pendingWarranties, 10);
});

test('P2: Admin Shopping Chat folder rail buttons all have icons, tooltips and clean thread meta layout', () => {
  const js = fs.readFileSync(path.join(ROOT, 'admin/shopping-chat.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'shopping-chat.css'), 'utf8');

  const folderFilters = ['unassigned', 'assigned', 'open', 'urgent', 'overdue', 'due_soon', 'unanswered', 'unread', 'starred', 'closed'];
  for (const filter of folderFilters) {
    const btnRe = new RegExp(`data-chat-filter="${filter}"[^>]*title="[^"]+"[^>]*aria-label="[^"]+"[^>]*>'\\+\\s*'<span class="chat-folder-icon`);
    assert.match(js, btnRe, `Folder filter "${filter}" must have icon, title and aria-label`);
  }
  assert.ok(!js.includes('Hộp thư đ...'), 'Must not hardcode truncated folder title');
  assert.ok(js.includes('class="chat-thread-item"'), 'Thread button should carry explicit class to avoid unclassed button rules');
  assert.ok(js.includes('class="chat-thread-meta"'), 'Thread item should group status and timestamp in .chat-thread-meta');
  assert.ok(css.includes('[data-chat-thread] .chat-thread-meta'), 'CSS styles .chat-thread-meta cleanly');
  assert.ok(css.includes('scrollbar-gutter: stable'), 'Thread list reserves scrollbar gutter to avoid clipping timestamps');
});

test('P2: Inventory actions, movement delta badges, Product Editor gallery cards, Sidebar footer & Marketing tabs CSS rules', () => {
  const enterpriseJs = fs.readFileSync(path.join(ROOT, 'admin/enterprise.js'), 'utf8');
  const enterpriseCss = fs.readFileSync(path.join(ROOT, 'admin/enterprise.css'), 'utf8');
  const editorCss = fs.readFileSync(path.join(ROOT, 'admin/product-editor.css'), 'utf8');
  const mobileCss = fs.readFileSync(path.join(ROOT, 'admin/admin-mobile.css'), 'utf8');

  assert.ok(enterpriseJs.includes('loading="eager" decoding="async"'), 'Inventory thumbnails load eagerly');
  assert.ok(enterpriseJs.includes('class="movement-delta'), 'Inventory movements render distinct delta badge');
  assert.ok(enterpriseJs.includes('class="movement-range"'), 'Inventory movements separate before->after range');
  assert.ok(enterpriseCss.includes('#inventory-view .inventory-row-actions'), 'Inventory row actions have compact desktop fit');

  assert.ok(editorCss.includes('.product-workspace .editor-gallery .gallery-item [data-remove-image]'), 'Gallery remove button pinned cleanly');
  assert.ok(editorCss.includes('.product-workspace .editor-gallery .gallery-item > div > button:not([data-remove-image])'), 'Gallery action buttons defeat 16px global button rule');

  assert.match(mobileCss, /\.admin-shell\s+\.sidebar\s*>\s*\.sidebar-bottom[\s\S]*flex-direction:\s*column\s*!important/);
  assert.match(mobileCss, /#marketing-view\s+\.marketing-tabs[\s\S]*flex-wrap:\s*wrap/);
  assert.match(mobileCss, /\.admin-shell\s+\.admin-content[\s\S]*padding-bottom:\s*104px/);
});

test('P3: No raw blocking browser alert(), confirm(), or window.prompt() in admin/ai-knowledge.js or admin/admin.js', () => {
  const aiKnowledge = fs.readFileSync(path.join(ROOT, 'admin/ai-knowledge.js'), 'utf8');
  const adminJs = fs.readFileSync(path.join(ROOT, 'admin/admin.js'), 'utf8');

  assert.ok(!/(?:^|[^\w.])alert\s*\(/.test(aiKnowledge), 'admin/ai-knowledge.js must not call raw alert()');
  assert.ok(!/(?:^|[^\w.])confirm\s*\(/.test(aiKnowledge), 'admin/ai-knowledge.js must not call raw confirm()');
  assert.ok(aiKnowledge.includes('window.GAERUNotify?.toast'), 'admin/ai-knowledge.js uses GAERUNotify.toast');
  assert.ok(aiKnowledge.includes('window.GAERUNotify?.confirm'), 'admin/ai-knowledge.js uses GAERUNotify.confirm');
  assert.ok(!adminJs.includes('window.prompt('), 'admin/admin.js must not call raw window.prompt()');
});
