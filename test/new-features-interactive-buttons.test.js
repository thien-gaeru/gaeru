'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Comprehensive Verification of All Interactive Buttons & Actions Across New Features', async (t) => {
  const adminIndex = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');
  const upgradesHubJs = fs.readFileSync(path.join(__dirname, '..', 'admin', 'upgrades-hub.js'), 'utf8');
  const rmaHtml = fs.readFileSync(path.join(__dirname, '..', 'rma.html'), 'utf8');
  const rmaJs = fs.readFileSync(path.join(__dirname, '..', 'rma.js'), 'utf8');
  const customerUpgradesJs = fs.readFileSync(path.join(__dirname, '..', 'customer-upgrades-ui.js'), 'utf8');
  const trackingHtml = fs.readFileSync(path.join(__dirname, '..', 'tracking.html'), 'utf8');
  const trackingJs = fs.readFileSync(path.join(__dirname, '..', 'tracking.js'), 'utf8');

  // 1. Admin Upgrades Hub buttons & tabs
  await t.test('1. Admin Upgrades Hub tabs, filters and actions respond reliably', () => {
    // Check all 6 tabs have onclick attribute
    const expectedTabs = ['matrix', 'rma', 'rop', 'rfm', 'capi', 'settings'];
    for (const tab of expectedTabs) {
      assert.match(
        adminIndex,
        new RegExp(`data-tab="${tab}"[^>]*onclick="window\\.GAERUUpgradesHub\\.switchUpgradeTab\\('${tab}'\\)"`),
        `Admin tab ${tab} must have explicit onclick calling window.GAERUUpgradesHub.switchUpgradeTab('${tab}')`
      );
    }

    // Check window.GAERUUpgradesHub is assigned immediately
    assert.match(upgradesHubJs, /window\.GAERUUpgradesHub\s*=\s*UpgradesHubApi/, 'Hub API must be assigned directly to window');
    assert.match(upgradesHubJs, /switchUpgradeTab,/, 'switchUpgradeTab must be in Hub API');
    assert.match(upgradesHubJs, /renderMatrix,/, 'renderMatrix must be in Hub API');
    assert.match(upgradesHubJs, /openRmaModal,/, 'openRmaModal must be in Hub API');
    assert.match(upgradesHubJs, /triggerTestCapi,/, 'triggerTestCapi must be in Hub API');
    assert.match(upgradesHubJs, /loadAllSettings,/, 'loadAllSettings must be in Hub API');
    assert.match(upgradesHubJs, /saveSettingModule/, 'saveSettingModule must be in Hub API');

    // Check global delegated event listener
    assert.match(upgradesHubJs, /document\.addEventListener\('click'/, 'Admin Hub must attach document-level click listener');
    assert.match(upgradesHubJs, /e\.target\.closest\('\.upgrades-tab-btn'\)/, 'Delegated click must handle tab switching');
    assert.match(upgradesHubJs, /e\.target\.closest\('\[data-matrix-filter\]'\)/, 'Delegated click must handle matrix filtering');
  });

  // 2. RMA (Bảo Hành 1-1) buttons & forms
  await t.test('2. RMA portal buttons (tabs, search, submit) respond reliably', () => {
    // Window assignment
    assert.match(rmaJs, /window\.switchRmaTab\s*=\s*switchRmaTab/, 'switchRmaTab must be exposed on window');
    assert.match(rmaJs, /window\.handleRmaLookup\s*=\s*handleRmaLookup/, 'handleRmaLookup must be exposed on window');
    assert.match(rmaJs, /window\.handleRmaSubmit\s*=\s*handleRmaSubmit/, 'handleRmaSubmit must be exposed on window');

    // HTML calls
    assert.match(rmaHtml, /onclick="window\.switchRmaTab\('lookup'\)"/, 'RMA lookup tab button must call window.switchRmaTab');
    assert.match(rmaHtml, /onclick="window\.switchRmaTab\('submit'\)"/, 'RMA submit tab button must call window.switchRmaTab');
    assert.match(rmaHtml, /onsubmit="window\.handleRmaLookup\(event\)"/, 'RMA lookup form must call window.handleRmaLookup');
    assert.match(rmaHtml, /onsubmit="window\.handleRmaSubmit\(event\)"/, 'RMA submit form must call window.handleRmaSubmit');

    // Delegated click and DOM events
    assert.match(rmaJs, /document\.addEventListener\('click'/, 'rma.js must have document click listener');
    assert.match(rmaJs, /lookupSubmitBtn\.addEventListener\('click'/, 'rma.js must wire lookup submit button');
    assert.match(rmaJs, /lookupForm\.addEventListener\('submit'/, 'rma.js must wire lookup form submit');
    assert.match(rmaJs, /submitForm\.addEventListener\('submit'/, 'rma.js must wire submit form submit');
  });

  // 3. Customer Upgrades UI actions
  await t.test('3. Customer Account upgrades action pills and modals respond reliably', () => {
    // Window assignment
    assert.match(customerUpgradesJs, /window\.GAERUCustomerUpgrades\s*=/, 'GAERUCustomerUpgrades must be on window');
    assert.match(customerUpgradesJs, /openAffiliateModal/, 'openAffiliateModal must be exported');
    assert.match(customerUpgradesJs, /openLoyaltyHistoryModal/, 'openLoyaltyHistoryModal must be exported');

    // Markup has onclick triggers
    assert.match(customerUpgradesJs, /onclick="window\.GAERUCustomerUpgrades\?\.openLoyaltyHistoryModal\(\)"/, 'Loyalty history button must have onclick');
    assert.match(customerUpgradesJs, /onclick="window\.GAERUCustomerUpgrades\?\.openAffiliateModal\(\)"/, 'Affiliate button must have onclick');

    // Global click delegation
    assert.match(customerUpgradesJs, /e\.target\.closest\('\[data-open-loyalty-history\]'\)/, 'Delegated click handles loyalty history');
    assert.match(customerUpgradesJs, /e\.target\.closest\('\[data-service-tile="affiliate"\]'\)/, 'Delegated click handles affiliate modal');
    assert.match(customerUpgradesJs, /e\.target\.closest\('\[data-dialog-close\]'\)/, 'Delegated click handles dialog close');

    // Dialog polyfill / fallback
    assert.match(customerUpgradesJs, /if \(typeof dialog\.showModal !== 'function'\)/, 'ensureDialog must polyfill showModal if unavailable');
  });

  // 5. Order Tracking buttons
  await t.test('5. Order Tracking query button and form respond reliably', () => {
    assert.match(trackingJs, /window\.doTrackingLookup\s*=\s*doLookup/, 'doTrackingLookup must be on window');
    assert.match(trackingJs, /form\.addEventListener\('submit'/, 'tracking form must handle submit');
    assert.match(trackingJs, /trackBtn\.addEventListener\('click'/, 'tracking button must handle direct click');
    assert.match(trackingHtml, /onclick="window\.doTrackingLookup/, 'tracking button in HTML must have onclick fallback');
  });
});
