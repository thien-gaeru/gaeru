'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { adminPolicy } = require('../src/admin-policy');
const { createUpgradesSettingsRouter, DEFAULT_SETTINGS, getUpgradesSettings, saveUpgradesSettings } = require('../src/upgrades-settings');

test('Admin Policy & Upgrades Settings Verification', async (t) => {
  await t.test('adminPolicy allows upgraded domain routes without 404 error', () => {
    const upgradedRoutes = [
      '/rma/tickets',
      '/rma/config',
      '/bnpl/transactions',
      '/bnpl/config',
      '/capi/logs',
      '/capi/config',
      '/shipping/config',
      '/upgrades/settings',
      '/abandoned-carts',
      '/loyalty/tiers',
      '/chat-knowledge',
      '/barcode/scan',
      '/omnichannel/webhook',
      '/system-alerts',
      '/reviews',
      '/bundles',
      '/flash-sales',
      '/affiliates',
      '/zalo-zns',
      '/cod-reconciliation',
      '/push/broadcast',
      '/tiktok-ads'
    ];

    for (const route of upgradedRoutes) {
      let nextCalled = false;
      let statusCalledWith = null;

      const req = {
        path: route,
        method: 'GET'
      };
      const res = {
        status(s) {
          statusCalledWith = s;
          return { json() {} };
        }
      };
      const next = () => {
        nextCalled = true;
      };

      adminPolicy(req, res, next);

      assert.equal(nextCalled, true, `Route ${route} should pass adminPolicy via next()`);
      assert.equal(statusCalledWith, null, `Route ${route} should NOT return 404 error`);
    }
  });

  await t.test('Upgrades Settings Router provides default settings and handles updates', async () => {
    let storedValue = null;
    const fakePool = {
      async query(sql, params) {
        if (sql.includes('SELECT setting_value')) {
          return { rows: storedValue ? [{ setting_value: storedValue }] : [] };
        }
        if (sql.includes('INSERT INTO store_settings')) {
          storedValue = params[0];
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    const initial = await getUpgradesSettings(fakePool);
    assert.equal(initial.rma.returnDays, 30);
    assert.equal(initial.bnpl.fundiinEnabled, true);
    assert.equal(initial.affiliate.commissionPercent, 8);
    assert.equal(initial.shipping.defaultCarrier, 'flexible');

    await saveUpgradesSettings(fakePool, {
      rma: { ...initial.rma, returnDays: 45 },
      shipping: { ...initial.shipping, defaultCarrier: 'viettel' }
    });

    const updated = await getUpgradesSettings(fakePool);
    assert.equal(updated.rma.returnDays, 45);
    assert.equal(updated.bnpl.fundiinEnabled, true);
    assert.equal(updated.shipping.defaultCarrier, 'viettel');
  });

  await t.test('Upgrades Settings Router accepts module-based updates and responds with status', async () => {
    let storedValue = null;
    const fakePool = {
      async query(sql, params) {
        if (sql.includes('SELECT setting_value')) {
          return { rows: storedValue ? [{ setting_value: storedValue }] : [] };
        }
        if (sql.includes('INSERT INTO store_settings')) {
          storedValue = params[0];
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    const router = createUpgradesSettingsRouter(fakePool);

    // Test GET /upgrades/settings
    const getPayload = await new Promise((resolve, reject) => {
      const getReq = { method: 'GET', url: '/upgrades/settings', headers: {} };
      const getRes = { json: resolve, status() { return this; } };
      router.handle(getReq, getRes, (err) => reject(err || new Error('route not matched')));
    });
    assert.ok(getPayload);
    assert.equal(getPayload.success, true);
    assert.equal(getPayload.settings.rma.returnDays, 30);

    // Test POST /upgrades/settings for specific module
    const postPayload = await new Promise((resolve, reject) => {
      const postReq = {
        method: 'POST',
        url: '/upgrades/settings',
        headers: {},
        body: { module: 'bnpl', settings: { fundiinEnabled: false, minAmountVnd: 500000 } }
      };
      const postRes = { json: resolve, status() { return this; } };
      router.handle(postReq, postRes, (err) => reject(err || new Error('route not matched')));
    });
    assert.ok(postPayload);
    assert.equal(postPayload.success, true);
    assert.equal(postPayload.settings.bnpl.fundiinEnabled, false);
    assert.equal(postPayload.settings.bnpl.minAmountVnd, 500000);
  });

  await t.test('Admin UI upgrades-hub.js has CSRF protection, 3-step transparent save feedback and shipping config', () => {
    const hubScript = fs.readFileSync(path.join(__dirname, '..', 'admin', 'upgrades-hub.js'), 'utf8');

    // 1. CSRF Token handling
    assert.match(hubScript, /X-CSRF-Token/, 'upgrades-hub.js must attach X-CSRF-Token on requests');
    assert.match(hubScript, /getCsrfToken/, 'upgrades-hub.js must define CSRF token helper');

    // 2. 3-step transparent save workflow
    assert.match(hubScript, /\[Thao tác 1\/3\]/, 'upgrades-hub.js must show Step 1/3 (validation)');
    assert.match(hubScript, /\[Thao tác 2\/3\]/, 'upgrades-hub.js must show Step 2/3 (saving)');
    assert.match(hubScript, /\[Thao tác 3\/3 Hoàn tất\]/, 'upgrades-hub.js must show Step 3/3 (completion)');

    // 3. Multi-carrier shipping config card
    assert.match(hubScript, /card-cfg-shipping/, 'upgrades-hub.js must render shipping configuration card');
    assert.match(hubScript, /cfg-ship-default/, 'upgrades-hub.js must allow configuring default carrier policy');
    assert.match(hubScript, /cfg-carrier-ghn/, 'upgrades-hub.js must allow configuring GHN carrier');
  });
});
