'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Customer Account Upgrades Hub - Verification and UI integrity', async (t) => {
  await t.test('account.html correctly includes new upgrades stylesheet and script', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'account.html'), 'utf8');
    assert.match(html, /customer-upgrades\.css/, 'account.html should include customer-upgrades.css');
    assert.match(html, /customer-upgrades-ui\.js/, 'account.html should include customer-upgrades-ui.js');
    assert.match(html, /data-customer-upgrades-hub/, 'account.html should include data-customer-upgrades-hub');
    assert.match(html, /id="customer-upgrades-hub"/, 'account.html should have #customer-upgrades-hub container');
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
    assert.match(script, /data-service-tile="tracking"/, 'Script should have order tracking action');
    assert.match(script, /data-service-tile="affiliate"/, 'Script should have KOC affiliate action');
    assert.match(script, /autoPromptWebPush/, 'Script should auto-prompt Web Push on supported browsers');
    assert.doesNotMatch(script, /data-service-tile="push"/, 'Script should NOT have manual push activation button');
    assert.match(script, /enhanceCustomerOrders/, 'Script should enhance customer orders with tracking links');

    assert.doesNotMatch(script, /rma\.html/, 'Account page must NOT link to removed RMA');
    // Cluttered catalog features must NOT be rendered in account hub
    assert.doesNotMatch(script, /AI Creator Setup Finder<\/h4>/, 'Account page must NOT display marketing AI quiz');
    assert.doesNotMatch(script, /So sánh thông số thiết bị<\/h4>/, 'Account page must NOT display catalog specs comparison');
  });
});
