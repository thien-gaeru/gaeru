'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Comprehensive Verification of All Interactive Buttons & Actions Across New Features', async (t) => {
  const adminIndex = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');
  const upgradesHubJs = fs.readFileSync(path.join(__dirname, '..', 'admin', 'upgrades-hub.js'), 'utf8');
  const customerUpgradesJs = fs.readFileSync(path.join(__dirname, '..', 'customer-upgrades-ui.js'), 'utf8');
  const trackingHtml = fs.readFileSync(path.join(__dirname, '..', 'tracking.html'), 'utf8');
  const trackingJs = fs.readFileSync(path.join(__dirname, '..', 'tracking.js'), 'utf8');

  // 1. Admin Upgrades Hub buttons & tabs (CSP Strict Compliant without inline handlers)
  await t.test('1. Admin Upgrades Hub tabs, filters and actions respond reliably with CSP compliance', () => {
    // Check all tabs have data-tab and NO inline onclick (Helmet CSP protection)
    const expectedTabs = ['matrix', 'rop', 'rfm', 'capi', 'settings'];
    for (const tab of expectedTabs) {
      assert.match(
        adminIndex,
        new RegExp(`data-tab="${tab}"`),
        `Admin tab ${tab} must have data-tab="${tab}"`
      );
    }
    assert.doesNotMatch(
      adminIndex,
      /onclick="window\.GAERUUpgradesHub/,
      'Admin index.html must not use inline onclick handlers violating Helmet CSP'
    );
    assert.doesNotMatch(
      upgradesHubJs,
      /onclick="window\.GAERUUpgradesHub/,
      'Upgrades Hub JS must not use inline onclick templates violating Helmet CSP'
    );
    assert.doesNotMatch(
      upgradesHubJs,
      /onsubmit="window\.GAERUUpgradesHub/,
      'Upgrades Hub JS must not use inline onsubmit templates violating Helmet CSP'
    );

    // Check window.GAERUUpgradesHub is assigned immediately
    assert.match(upgradesHubJs, /window\.GAERUUpgradesHub\s*=\s*UpgradesHubApi/, 'Hub API must be assigned directly to window');
    assert.match(upgradesHubJs, /switchUpgradeTab,/, 'switchUpgradeTab must be in Hub API');
    assert.match(upgradesHubJs, /renderMatrix,/, 'renderMatrix must be in Hub API');
    assert.match(upgradesHubJs, /triggerTestCapi,/, 'triggerTestCapi must be in Hub API');
    assert.match(upgradesHubJs, /loadAllSettings,/, 'loadAllSettings must be in Hub API');
    assert.match(upgradesHubJs, /saveSettingModule/, 'saveSettingModule must be in Hub API');

    // Check global delegated event listeners
    assert.match(upgradesHubJs, /document\.addEventListener\('click'/, 'Admin Hub must attach document-level click listener');
    assert.match(upgradesHubJs, /e\.target\.closest\('\.upgrades-tab-btn'\)/, 'Delegated click must handle tab switching');
    assert.match(upgradesHubJs, /e\.target\.closest\('\[data-matrix-filter\]'\)/, 'Delegated click must handle matrix filtering');
    assert.match(upgradesHubJs, /e\.target\.closest\('\[data-save-module\]'\)/, 'Delegated click must handle saving modules');
    assert.match(upgradesHubJs, /e\.target\.closest\('\[data-action\]'\)/, 'Delegated click must handle action triggers');
    assert.match(upgradesHubJs, /document\.addEventListener\('submit'/, 'Admin Hub must attach form submit listener');
  });

  // 2. Customer Upgrades UI actions
  await t.test('2. Customer Account upgrades action pills and modals respond reliably', () => {
    // Window assignment
    assert.match(customerUpgradesJs, /window\.GAERUCustomerUpgrades\s*=/, 'GAERUCustomerUpgrades must be on window');
    assert.match(customerUpgradesJs, /openAffiliateModal/, 'openAffiliateModal must be exported');
    assert.match(customerUpgradesJs, /openLoyaltyHistoryModal/, 'openLoyaltyHistoryModal must be exported');

    // Markup has triggers
    assert.match(customerUpgradesJs, /openLoyaltyHistoryModal\(\)/, 'Loyalty history button must invoke openLoyaltyHistoryModal');
    assert.match(customerUpgradesJs, /openAffiliateModal\(\)/, 'Affiliate button must invoke openAffiliateModal');

    // Global click delegation
    assert.match(customerUpgradesJs, /e\.target\.closest\('\[data-open-loyalty-history\]'\)/, 'Delegated click handles loyalty history');
    assert.match(customerUpgradesJs, /e\.target\.closest\('\[data-service-tile="affiliate"\]'\)/, 'Delegated click handles affiliate modal');
    assert.match(customerUpgradesJs, /e\.target\.closest\('\[data-dialog-close\]'\)/, 'Delegated click handles dialog close');

    // Dialog polyfill / fallback
    assert.match(customerUpgradesJs, /if \(typeof dialog\.showModal !== 'function'\)/, 'ensureDialog must polyfill showModal if unavailable');
  });

  // 3. Order Tracking buttons & Payment Status Logic
  await t.test('3. Order Tracking query button and formatPaymentBadge logic', () => {
    assert.match(trackingJs, /window\.doTrackingLookup\s*=\s*doLookup/, 'doTrackingLookup must be on window');
    assert.match(trackingJs, /form\.addEventListener\('submit'/, 'tracking form must handle submit');
    assert.match(trackingJs, /trackBtn\.addEventListener\('click'/, 'tracking button must handle direct click');
    assert.match(trackingJs, /formatPaymentBadge/, 'tracking.js must have formatPaymentBadge function to distinguish paid vs pending');
  });
});
