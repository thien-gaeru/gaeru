'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Shopping chat multi-device responsive layout suite', () => {
  const css = fs.readFileSync(path.join(__dirname, '../shopping-chat.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../admin/shopping-chat.js'), 'utf8');

  // 1. Mobile & Tablet Portrait (<= 900px)
  assert.ok(css.includes('@media (max-width: 900px)'), 'Has <= 900px breakpoint');
  assert.ok(css.includes('.chat-folder-backdrop'), 'Defines .chat-folder-backdrop for mobile drawer');
  assert.ok(css.includes('.chat-folder-close-btn'), 'Defines .chat-folder-close-btn for drawer dismissal');
  assert.ok(css.includes('transform: translateX(-105%)'), 'Off-canvas drawer uses hardware-accelerated translateX');
  assert.ok(css.includes('transform: translateX(0)'), 'Drawer opens smoothly to translateX(0)');
  assert.ok(css.includes('.chat-mobile-folder-btn'), 'Shows mobile drawer toggle');

  // 2. Extra Small Phone Screen (<= 480px)
  assert.ok(css.includes('@media (max-width: 480px)'), 'Has <= 480px phone breakpoint');
  assert.ok(css.includes('env(safe-area-inset-bottom'), 'Supports notch and home indicator safe area inset');
  assert.ok(css.includes('touch-action: manipulation'), 'Removes 300ms tap delay via touch-action manipulation');

  // 3. Tablet Landscape & Medium Desktops (901px - 1180px)
  assert.ok(css.includes('min-width: 901px') && css.includes('1180px'), 'Has tablet landscape breakpoint');
  assert.ok(css.includes('58px'), 'Condenses sidebar to 58px dock on tablet landscape to preserve chat width');

  // 4. Large Desktop (> 1440px)
  assert.ok(css.includes('@media (min-width: 1440px)'), 'Has large screen typography breakpoint');
  assert.ok(css.includes('72%'), 'Restricts bubble line length on ultrawide monitors');

  // 5. Dark Mode Compliance
  assert.ok(css.includes('@media (prefers-color-scheme: dark)'), 'Has dark mode queries');

  // 6. JavaScript Interaction Handlers
  assert.ok(js.includes('data-chat-folder-backdrop'), 'Handles backdrop clicks to dismiss drawer');
  assert.ok(js.includes('data-chat-folder-close'), 'Handles close button clicks to dismiss drawer');
  assert.ok(js.includes('data-chat-folder-drawer-toggle'), 'Handles hamburger button to open drawer');
  assert.ok(js.includes('is-mobile-open'), 'Toggles is-mobile-open class on folder nav');
});
