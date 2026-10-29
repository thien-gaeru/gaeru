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

  await t.test('customer-upgrades.css defines Apple-style styling for VIP Card and Services Grid', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'customer-upgrades.css'), 'utf8');
    assert.match(css, /\.gaeru-vip-card/, 'CSS should define .gaeru-vip-card');
    assert.match(css, /\.tier-diamond/, 'CSS should define diamond tier styling');
    assert.match(css, /\.tier-gold/, 'CSS should define gold tier styling');
    assert.match(css, /\.gaeru-services-grid/, 'CSS should define .gaeru-services-grid');
    assert.match(css, /\.gaeru-service-tile/, 'CSS should define .gaeru-service-tile');
    assert.match(css, /\.gaeru-rma-section/, 'CSS should define .gaeru-rma-section');
    assert.match(css, /\.gaeru-dialog/, 'CSS should define .gaeru-dialog modal');
  });

  await t.test('customer-upgrades-ui.js implements all 8 upgraded customer services', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'customer-upgrades-ui.js'), 'utf8');
    assert.match(script, /fetchCustomerLoyalty/, 'Script should fetch loyalty profile');
    assert.match(script, /fetchCustomerRma/, 'Script should lookup RMA tickets');
    assert.match(script, /data-service-tile="tracking"/, 'Script should have SPX tracking action');
    assert.match(script, /data-service-tile="rma"/, 'Script should have RMA 1-1 action');
    assert.match(script, /data-service-tile="bnpl"/, 'Script should have BNPL 0% action');
    assert.match(script, /data-service-tile="quiz"/, 'Script should have AI quiz action');
    assert.match(script, /data-service-tile="affiliate"/, 'Script should have KOC affiliate action');
    assert.match(script, /data-service-tile="compare"/, 'Script should have compare action');
    assert.match(script, /data-service-tile="care"/, 'Script should have GAERU Care+ action');
    assert.match(script, /data-service-tile="push"/, 'Script should have Web Push action');
    assert.match(script, /openBnplCalculatorModal/, 'Script should support interactive BNPL calculator');
    assert.match(script, /openAffiliateModal/, 'Script should support affiliate link sharing');
    assert.match(script, /enhanceCustomerOrders/, 'Script should enhance customer orders with SPX & RMA links');
  });
});
