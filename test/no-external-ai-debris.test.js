'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { notices } = require('../src/admin-notifications');

test('Admin notifications never include external AI / OpenAI missing warnings', async () => {
  const dummyPool = {
    query: async (sql) => {
      if (sql.includes('admin_notice_reads')) return { rows: [] };
      return { rows: [] };
    }
  };
  const dummyAdmin = {
    id: 'owner-id',
    source: 'bootstrap',
    permissions: ['settings.write', 'orders.read', 'catalog.write']
  };
  const configWithoutOpenAI = {
    TURNSTILE_SITE_KEY: 'test-key',
    TURNSTILE_SECRET_KEY: 'test-secret',
    smtp: { host: 'smtp.test' }
    // No OPENAI_API_KEY
  };

  const list = await notices(dummyPool, dummyAdmin, configWithoutOpenAI);
  const openaiNotice = list.find(n => n.key.includes('openai') || (n.title && n.title.includes('OpenAI')));
  assert.equal(openaiNotice, undefined, 'Phải loại bỏ hoàn toàn thông báo cảnh báo thiếu OpenAI');
});

test('admin/owner.js does not render leftover OpenAI status card', () => {
  const ownerJs = fs.readFileSync(path.resolve(__dirname, '../admin/owner.js'), 'utf8');
  assert.ok(!ownerJs.includes("OpenAI · nội dung"), 'Không được chứa thẻ trạng thái OpenAI bên ngoài');
  assert.ok(ownerJs.includes("Trí tuệ nhân tạo GAERU AI"), 'Phải hiển thị trạng thái Trí tuệ nhân tạo GAERU AI nội bộ');
});

test('admin/news.js cleans up OpenAI and Hostinger debris and hides unconfigured AI panel', () => {
  const newsJs = fs.readFileSync(path.resolve(__dirname, '../admin/news.js'), 'utf8');
  assert.ok(!newsJs.includes("máy chủ Hostinger"), 'Không được còn tàn dư nhắc đến máy chủ Hostinger');
  assert.ok(!newsJs.includes("OpenAI đang soạn bài"), 'Không được nhắc đến tiến trình OpenAI soạn bài');
  assert.ok(newsJs.includes("aiPanel.hidden=true"), 'Phải tự động ẩn panel soạn bài AI khi chưa cấu hình');
});
