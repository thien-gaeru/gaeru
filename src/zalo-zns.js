'use strict';

const express = require('express');

function normalizeZaloPhone(phone) {
  let cleaned = String(phone || '').replace(/[^0-9]/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '84' + cleaned.slice(1);
  }
  return cleaned;
}

async function sendZaloZns({ phone, templateId, templateData = {}, config = {} }, fetcher = (typeof fetch !== 'undefined' ? fetch : null)) {
  const normPhone = normalizeZaloPhone(phone);
  if (!normPhone || normPhone.length < 11) {
    throw Object.assign(new Error('Số điện thoại không hợp lệ để gửi Zalo ZNS.'), { status: 400 });
  }

  const token = config.ZALO_OA_ACCESS_TOKEN || process.env.ZALO_OA_ACCESS_TOKEN;
  if (!token || !fetcher) {
    // If ZNS is not configured in environment, simulate successful dispatch in dry-run mode
    return { ok: true, dryRun: true, phone: normPhone, templateId, message: 'ZNS mô phỏng (chưa cấu hình token Zalo OA).' };
  }

  try {
    const res = await fetcher('https://business.openapi.zalo.me/message/template', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'access_token': token
      },
      body: JSON.stringify({
        phone: normPhone,
        template_id: templateId,
        template_data: templateData,
        tracking_id: 'gaeru-' + Date.now()
      })
    });
    const result = await res.json();
    return { ok: result.error === 0, result, phone: normPhone };
  } catch (err) {
    return { ok: false, error: err.message, phone: normPhone };
  }
}

function createZaloZnsAdmin(config) {
  const { AdminAction } = require('./admin-action');
  const router = express.Router();

  router.post('/zns/test', AdminAction('marketing.write'), express.json(), async (req, res, next) => {
    try {
      const { phone = '0901234567', templateId = '12345', templateData = { order_code: 'GAERU-TEST', customer_name: 'Khách hàng' } } = req.body || {};
      const result = await sendZaloZns({ phone, templateId, templateData, config });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  normalizeZaloPhone,
  sendZaloZns,
  createZaloZnsAdmin
};
