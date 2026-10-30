'use strict';

const { Router } = require('express');
const { requirePermission } = require('./staff-access');
const { requireCsrf } = require('./security');

const DEFAULT_SETTINGS = {
  capi: {
    metaPixelId: process.env.META_PIXEL_ID || '',
    metaTokenConfigured: Boolean(process.env.META_CAPI_TOKEN),
    tikTokPixelId: process.env.TIKTOK_PIXEL_ID || '',
    tikTokTokenConfigured: Boolean(process.env.TIKTOK_ACCESS_TOKEN),
    testEventCode: 'TEST' + (process.env.NODE_ENV === 'production' ? '' : '_DEV'),
    mode: process.env.NODE_ENV === 'production' ? 'live' : 'simulation',
    autoTrackPurchase: true
  },
  loyalty: {
    earnRatePercent: 1.0,
    silverPointsThreshold: 1000,
    goldPointsThreshold: 5000,
    diamondPointsThreshold: 10000,
    silverMultiplier: 1.05,
    goldMultiplier: 1.10,
    diamondMultiplier: 1.15,
    pointValueVnd: 1
  },
  affiliate: {
    commissionPercent: 8,
    cookieDays: 30,
    minPayoutVnd: 200000,
    payoutDayOfMonth: 15,
    autoApprovePartners: true
  },
  promotions: {
    maxDiscountPercentCap: 40,
    blockVoucherOnFlashSale: true
  },
  webPush: {
    autoNotifyNewOrder: true,
    autoNotifyShipping: true,
    autoNotifyFlashSale: true
  },
  shipping: {
    defaultCarrier: 'flexible',
    enabledCarriers: ['ghn', 'ghtk', 'viettel', 'spx', 'jt'],
    autoSelectCheapest: true,
    carrierProfiles: {
      ghn: { name: 'Giao Hàng Nhanh (GHN)', active: true },
      ghtk: { name: 'Giao Hàng Tiết Kiệm (GHTK)', active: true },
      viettel: { name: 'Viettel Post', active: true },
      spx: { name: 'Shopee Express (SPX)', active: true },
      jt: { name: 'J&T Express', active: true }
    }
  },
  inventory: {
    defaultLeadTimeDays: 7,
    safetyStockDays: 14
  }
};

async function getUpgradesSettings(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT setting_value FROM store_settings WHERE setting_key = 'platform_upgrades_settings'`
    );
    if (rows[0] && rows[0].setting_value) {
      const saved = typeof rows[0].setting_value === 'string'
        ? JSON.parse(rows[0].setting_value)
        : rows[0].setting_value;
      return { ...DEFAULT_SETTINGS, ...saved };
    }
  } catch (err) {
    console.warn('Error reading platform_upgrades_settings:', err.message);
  }
  return DEFAULT_SETTINGS;
}

async function saveUpgradesSettings(pool, newSettings) {
  const current = await getUpgradesSettings(pool);
  const merged = { ...current, ...newSettings };
  await pool.query(
    `INSERT INTO store_settings (setting_key, setting_value, updated_at)
     VALUES ('platform_upgrades_settings', $1, now())
     ON CONFLICT (setting_key) DO UPDATE
     SET setting_value = EXCLUDED.setting_value, updated_at = now()`,
    [JSON.stringify(merged)]
  );
  return merged;
}

function createUpgradesSettingsRouter(pool) {
  const router = Router();
  const guardSettingsWrite = (req, res, next) => {
    if (req.admin) {
      return requirePermission('settings.write')(req, res, () => {
        if (req.session) return requireCsrf(req, res, next);
        next();
      });
    }
    next();
  };

  router.get('/upgrades/settings', async (_req, res, next) => {
    try {
      const settings = await getUpgradesSettings(pool);
      res.json({ success: true, settings });
    } catch (err) {
      next(err);
    }
  });

  router.post('/upgrades/settings', guardSettingsWrite, async (req, res, next) => {
    try {
      const body = req.body || {};
      const { module: modName, settings } = body;
      let updated;
      if (modName && settings) {
        const current = await getUpgradesSettings(pool);
        current[modName] = { ...(current[modName] || {}), ...settings };
        updated = await saveUpgradesSettings(pool, current);
      } else if (settings) {
        updated = await saveUpgradesSettings(pool, settings);
      } else if (typeof body === 'object' && Object.keys(body).length > 0) {
        updated = await saveUpgradesSettings(pool, body);
      } else {
        return res.status(400).json({ error: 'Dữ liệu cấu hình không hợp lệ.' });
      }
      res.json({ success: true, settings: updated });
    } catch (err) {
      next(err);
    }
  });

  router.get('/shipping/config', async (_req, res, next) => {
    try {
      const s = await getUpgradesSettings(pool);
      res.json({ success: true, config: s.shipping });
    } catch (err) { next(err); }
  });

  router.post('/shipping/config', guardSettingsWrite, async (req, res, next) => {
    try {
      const current = await getUpgradesSettings(pool);
      current.shipping = { ...(current.shipping || {}), ...(req.body || {}) };
      const updated = await saveUpgradesSettings(pool, current);
      res.json({ success: true, config: updated.shipping });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = {
  DEFAULT_SETTINGS,
  getUpgradesSettings,
  saveUpgradesSettings,
  createUpgradesSettingsRouter
};
