'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Shopping chat mobile inbox layout & responsive design compliance', () => {
  const css = fs.readFileSync(path.join(__dirname, '../shopping-chat.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../admin/shopping-chat.js'), 'utf8');

  // 1. Verify CSS mobile layout rules
  assert.ok(css.includes('.admin-shopping-chat'), 'Defines .admin-shopping-chat');
  assert.ok(css.includes('has-selected-thread'), 'Includes List-Detail toggle class has-selected-thread');
  assert.ok(css.includes('.admin-chat-mobile-header'), 'Defines mobile header');
  assert.ok(css.includes('.admin-chat-back-btn'), 'Defines mobile back button');
  assert.ok(css.includes('chat-scope-tabs'), 'Defines scope tabs styling');
  assert.ok(css.includes('white-space: nowrap'), 'Tabs prevent word breaking with white-space: nowrap');
  assert.ok(!css.includes('96px minmax'), 'Must not have 96px squashed two-column mobile hack');
  assert.ok(!css.includes('minmax(104px,28%)'), 'Must not have 104px squashed two-column mobile hack');
  assert.ok(css.includes('max-width: 900px'), 'Includes responsive breakpoint <= 900px');

  // 2. Button sizing & spacing standardization
  assert.ok(css.includes('.chat-scope-tabs button') || css.includes('.chat-scope-tab-btn'), 'Styles scope tab buttons');
  assert.ok(css.includes('gap: 8px') || css.includes('gap: 10px'), 'Proper button spacing gap defined');
  assert.ok(css.includes('min-height: 38px') || css.includes('height: 38px'), 'Scope tab button height standardized');

  // 3. Verify JS mobile navigation & controls
  assert.ok(js.includes('data-chat-back'), 'Script handles data-chat-back button click');
  assert.ok(js.includes('has-selected-thread'), 'Script toggles has-selected-thread class');
  assert.ok(js.includes('data-chat-mobile-title'), 'Script updates mobile thread title');
  assert.ok(js.includes('data-chat-filter="open"'), 'Open filter tab exists');
  assert.ok(js.includes('data-chat-filter="closed"'), 'Closed filter tab exists');
});

test('Helpdesk vertical navigation & 3-column layout compliance', () => {
  const css = fs.readFileSync(path.join(__dirname, '../shopping-chat.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../admin/shopping-chat.js'), 'utf8');
  const backend = fs.readFileSync(path.join(__dirname, '../src/shopping-chat.js'), 'utf8');

  // 1. Vertical Folder Sidebar Navigation elements
  assert.ok(css.includes('.chat-folder-nav'), 'Styles .chat-folder-nav sidebar');
  assert.ok(css.includes('.chat-folder-header'), 'Styles .chat-folder-header');
  assert.ok(css.includes('.chat-folder-item'), 'Styles .chat-folder-item queue buttons');
  assert.ok(css.includes('.chat-folder-divider'), 'Styles .chat-folder-divider separators');
  assert.ok(css.includes('.chat-folder-nav.is-collapsed'), 'Supports sidebar collapse mode');
  assert.ok(css.includes('.chat-threads-aside'), 'Defines .chat-threads-aside 2nd column');
  assert.ok(css.includes('.chat-conversation-section'), 'Defines .chat-conversation-section 3rd column');

  // 2. JS Helpdesk Folders & Queue Badges
  assert.ok(js.includes('data-chat-folder-toggle'), 'Has desktop sidebar collapse toggle');
  assert.ok(js.includes('data-chat-folder-drawer-toggle'), 'Has mobile folder drawer toggle');
  assert.ok(js.includes('data-chat-filter="unassigned"'), 'Folder: Chưa chỉ định');
  assert.ok(js.includes('data-chat-filter="assigned"'), 'Folder: Đã chỉ định');
  assert.ok(js.includes('data-chat-filter="open"'), 'Folder: Tất cả');
  assert.ok(js.includes('data-chat-filter="urgent"'), 'Folder: Cấp bách');
  assert.ok(js.includes('data-chat-filter="overdue"'), 'Folder: Quá hạn');
  assert.ok(js.includes('data-chat-filter="due_soon"'), 'Folder: Sắp hết hạn');
  assert.ok(js.includes('data-chat-filter="unanswered"'), 'Folder: Chưa trả lời');
  assert.ok(js.includes('data-chat-filter="unread"'), 'Folder: Chưa đọc');
  assert.ok(js.includes('data-chat-filter="starred"'), 'Folder: Đã gắn sao');
  assert.ok(js.includes('data-chat-filter="closed"'), 'Folder: Đã đóng');

  // 3. Backend Queue Counters & Filtering
  assert.ok(backend.includes('unassignedCount'), 'Backend counts unassigned threads');
  assert.ok(backend.includes('assignedCount'), 'Backend counts assigned threads');
  assert.ok(backend.includes('urgentCount'), 'Backend counts urgent threads');
  assert.ok(backend.includes('overdueCount'), 'Backend counts overdue threads');
  assert.ok(backend.includes('dueSoonCount'), 'Backend counts due soon threads');
});
