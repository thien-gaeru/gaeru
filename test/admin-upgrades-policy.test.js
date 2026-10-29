'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { adminPolicy } = require('../src/admin-policy');
const { createUpgradesSettingsRouter, DEFAULT_SETTINGS } = require('../src/upgrades-settings');

test('Admin Policy & Upgrades Settings Verification', async (t) => {
  await t.test('adminPolicy allows upgraded domain routes without 404 error', () => {
    const upgradedRoutes = [
      '/rma/tickets',
      '/rma/config',
      '/bnpl/transactions',
      '/bnpl/config',
      '/capi/logs',
      '/capi/config',
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

    const { getUpgradesSettings, saveUpgradesSettings } = require('../src/upgrades-settings');

    const initial = await getUpgradesSettings(fakePool);
    assert.equal(initial.rma.returnDays, 30);
    assert.equal(initial.bnpl.fundiinEnabled, true);
    assert.equal(initial.affiliate.commissionPercent, 8);

    await saveUpgradesSettings(fakePool, {
      rma: { ...initial.rma, returnDays: 45 }
    });

    const updated = await getUpgradesSettings(fakePool);
    assert.equal(updated.rma.returnDays, 45);
    assert.equal(updated.bnpl.fundiinEnabled, true);
  });
});
