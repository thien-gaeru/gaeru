'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Customer Account Upgrades Hub - Verification and UI integrity', async (t) => {
  await t.test('account.html correctly includes new upgrades stylesheet and script', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'account.html'), 'utf8');
    assert.match(html, /customer-upgrades\.css\?v=20261101-account-card/, 'account.html should load the cache-busted customer-upgrades stylesheet');
    assert.match(html, /customer-upgrades-ui\.js/, 'account.html should include customer-upgrades-ui.js');
    assert.match(html, /data-customer-upgrades-hub/, 'account.html should include data-customer-upgrades-hub');
    assert.match(html, /id="customer-upgrades-hub"/, 'account.html should have #customer-upgrades-hub container');
    assert.match(
      html,
      /<details class="account-personal-details">[\s\S]*?<summary>Thông tin cá nhân<\/summary>[\s\S]*?data-customer-email[\s\S]*?data-customer-phone[\s\S]*?data-profile-editor/,
      'email, phone, and the editable profile form host should be grouped in the personal-information disclosure'
    );
    assert.match(html, /data-customer-vip-tier/, 'VIP tier should be displayed below the customer name');
    assert.match(html, /data-customer-vip-summary/, 'VIP brand and points should be rendered at the right side of the name row');
    assert.match(
      html,
      /<div class="account-overview-card"[^>]*>[\s\S]*?<div class="account-profile-header"[\s\S]*?<dl>[\s\S]*?<div class="account-trust-note"[\s\S]*?<div id="customer-upgrades-hub"[\s\S]*?<div class="account-overview-addresses"/,
      'customer details should precede VIP data inside the shared overview card'
    );
  });

  await t.test('src/public-files.js contains customer upgrades static assets', () => {
    const publicFiles = require('../src/public-files');
    assert.ok(publicFiles.has('customer-upgrades-ui.js'), 'publicFiles should include customer-upgrades-ui.js');
    assert.ok(publicFiles.has('customer-upgrades.css'), 'publicFiles should include customer-upgrades.css');
  });

  await t.test('customer-upgrades.css defines Apple-style styling for VIP Card, and Quick Actions', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'customer-upgrades.css'), 'utf8');
    assert.match(css, /\.gaeru-vip-card/, 'CSS should define .gaeru-vip-card');
    assert.match(css, /\.tier-diamond/, 'CSS should define diamond tier styling');
    assert.match(css, /\.tier-gold/, 'CSS should define gold tier styling');
    assert.match(css, /\.account-overview-card \.gaeru-vip-card-wrapper,\s*\.account-overview-card \.gaeru-vip-card-wrapper:hover/, 'VIP card should not retain a separate wrapper when inside account overview');
    assert.match(css, /\.account-overview-card \.gaeru-vip-card,\s*\.account-overview-card \.gaeru-vip-card\.tier-diamond/, 'VIP tiers should render as content in the shared account card');
    assert.match(css, /\.gaeru-account-quick-actions/, 'CSS should define .gaeru-account-quick-actions');
    assert.match(css, /\.gaeru-action-pill/, 'CSS should define .gaeru-action-pill');
    assert.match(css, /\.gaeru-dialog/, 'CSS should define .gaeru-dialog modal');
  });

  await t.test('customer-upgrades-ui.js displays only clean, context-specific account features', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'customer-upgrades-ui.js'), 'utf8');
    // Essential customer account features
    assert.match(script, /fetchCustomerLoyalty/, 'Script should fetch loyalty profile');
    assert.match(script, /renderVipCard/, 'Script should render VIP Loyalty Card');
    assert.match(script, /renderAccountQuickActions/, 'Script should render compact account quick actions');
    assert.match(script, /gaeru-vip-member-label/, 'VIP card should not duplicate the customer name');
    assert.match(script, /overviewCard\.after\(quickActions\)/, 'Quick actions should be placed in a separate card after the overview');
    assert.match(script, /GAERU-VIP-'\s*\+\s*customer\.id\.slice/, 'Membership ID should not repeat phone digits');
    assert.match(script, /data-service-tile="tracking"/, 'Script should have order tracking action');
    assert.match(script, /data-service-tile="affiliate"/, 'Script should have KOC affiliate action');
    assert.match(script, /autoPromptWebPush/, 'Script should auto-prompt Web Push on supported browsers');
    assert.doesNotMatch(script, /data-service-tile="push"/, 'Script should NOT have manual push activation button');
    assert.match(script, /enhanceCustomerOrders/, 'Script should enhance customer orders with tracking links');
    assert.match(script, /data-customer-vip-points/, 'VIP points should appear with the brand beside the customer name');

    assert.doesNotMatch(script, /rma\.html/, 'Account page must NOT link to removed RMA');
    // Cluttered catalog features must NOT be rendered in account hub
    assert.doesNotMatch(script, /AI Creator Setup Finder<\/h4>/, 'Account page must NOT display marketing AI quiz');
    assert.doesNotMatch(script, /So sánh thông số thiết bị<\/h4>/, 'Account page must NOT display catalog specs comparison');
  });

  await t.test('customer workspace keeps order and warranty cards compact until expanded', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'customer-experience.js'), 'utf8');
    assert.match(script, /data-warranty-detail/, 'Warranty details should be expandable');
    assert.match(script, /data-warranty-toggle-label>Chi tiết/, 'Collapsed warranty details should use the Chi tiết label');
    assert.match(script, /detail\.open\?'Thu gọn':'Chi tiết'/, 'Warranty toggle label should follow disclosure state');
    assert.match(script, /account-order-header/, 'Order detail action should sit beside the order code');
    assert.match(script, /data-order-detail[^>]*>Chi tiết/, 'Collapsed order details should use the Chi tiết label');
    assert.match(script, /button\.textContent='Thu gọn'/, 'Expanded order details should use the Thu gọn label');
  });
});
