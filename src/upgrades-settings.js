'use strict';

const { Router } = require('express');

const DEFAULT_SETTINGS = {
  rma: {
    enabled: true,
    returnDays: 30,
    warehouseAddress: 'Kho GAERU Logistics, 123 Đường Số 7, P. An Phú, TP. Thủ Đức, TP. Hồ Chí Minh',
    supportHotline: '0901234567',
    inspectionLeadHours: 24,
    policyText: 'Cam kết 1 đổi 1 nguyên seal trong 30 ngày đầu cho mọi lỗi kỹ thuật phát sinh từ nhà sản xuất.'
  },
  bnpl: {
    fundiinEnabled: true,
    kredivoEnabled: true,
    minAmountVnd: 300000,
    maxAmountVnd: 30000000,
    defaultTenure: 3,
    supportedTenures: [3, 6, 12],
    interestRatePercent: 0,
    downPaymentRate: 0
  },
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
  webPush: {
    autoNotifyNewOrder: true,
    autoNotifyShipping: true,
    autoNotifyFlashSale: true
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

  router.get('/upgrades/settings', async (_req, res, next) => {
    try {
      const settings = await getUpgradesSettings(pool);
      res.json({ success: true, settings });
    } catch (err) {
      next(err);
    }
  });

  router.post('/upgrades/settings', async (req, res, next) => {
    try {
      const { module: modName, settings } = req.body || {};
      let updated;
      if (modName && settings) {
        const current = await getUpgradesSettings(pool);
        current[modName] = { ...(current[modName] || {}), ...settings };
        updated = await saveUpgradesSettings(pool, current);
      } else if (settings) {
        updated = await saveUpgradesSettings(pool, settings);
      } else {
        return res.status(400).json({ error: 'Dữ liệu cấu hình không hợp lệ.' });
      }
      res.json({ success: true, settings: updated });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  DEFAULT_SETTINGS,
  getUpgradesSettings,
  saveUpgradesSettings,
  createUpgradesSettingsRouter
};
