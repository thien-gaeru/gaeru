'use strict';

const express = require('express');

const recentAlerts = new Map();

async function alertSystem(pool, { severity = 'warning', source = 'system', message, metadata = {}, config = {} }, fetcher = (typeof fetch !== 'undefined' ? fetch : null)) {
  const normSeverity = ['info', 'warning', 'error', 'critical'].includes(severity) ? severity : 'warning';
  const text = String(message || '').trim().slice(0, 2000);
  const src = String(source || 'system').slice(0, 100);

  // Deduplicate identical alerts within 10 minutes
  const alertKey = `${normSeverity}:${src}:${text}`;
  const now = Date.now();
  const lastTime = recentAlerts.get(alertKey) || 0;
  const isDuplicate = (now - lastTime) < 600000;
  if (!isDuplicate) {
    recentAlerts.set(alertKey, now);
  }

  // Cleanup old keys in memory
  if (recentAlerts.size > 200) {
    for (const [k, t] of recentAlerts) {
      if (now - t >= 600000) recentAlerts.delete(k);
    }
  }

  // Save to database
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO system_alerts (severity, source, message, metadata)
         VALUES ($1, $2, $3, $4)`,
        [normSeverity, src, text, JSON.stringify(metadata)]
      );
    } catch {
      // Suppress logging database failure
    }
  }

  let alerted = false;
  if (!isDuplicate && fetcher) {
    const telegramToken = config.ALERT_TELEGRAM_BOT_TOKEN || process.env.ALERT_TELEGRAM_BOT_TOKEN;
    const telegramChatId = config.ALERT_TELEGRAM_CHAT_ID || process.env.ALERT_TELEGRAM_CHAT_ID;
    const webhookUrl = config.ALERT_WEBHOOK_URL || process.env.ALERT_WEBHOOK_URL;

    // Send to Telegram if configured
    if (telegramToken && telegramChatId) {
      const icon = normSeverity === 'critical' ? '🔥' : normSeverity === 'error' ? '🚨' : '⚠️';
      const telegramBody = `${icon} *[GAERU ALERT: ${normSeverity.toUpperCase()}]*\n*Nguồn:* \`${src}\`\n*Nội dung:* ${text}`;
      try {
        await fetcher(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: telegramChatId,
            text: telegramBody,
            parse_mode: 'Markdown'
          })
        });
        alerted = true;
      } catch {
        // Suppress external network failure
      }
    }

    // Send to generic webhook if configured
    if (webhookUrl) {
      try {
        await fetcher(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            severity: normSeverity,
            source: src,
            message: text,
            metadata,
            timestamp: new Date().toISOString()
          })
        });
        alerted = true;
      } catch {
        // Suppress external network failure
      }
    }
  }

  return { logged: true, alerted, isDuplicate };
}

function createSystemAlertsAdmin(pool, config) {
  const router = express.Router();

  router.get('/system-alerts', async (req, res, next) => {
    try {
      const result = await pool.query(`
        SELECT id, severity, source, message, metadata, sent_at AS "sentAt", created_at AS "createdAt"
        FROM system_alerts
        ORDER BY created_at DESC
        LIMIT 50
      `);
      res.json({ alerts: result.rows });
    } catch (err) {
      next(err);
    }
  });

  router.post('/system-alerts/test', express.json(), async (req, res, next) => {
    try {
      const result = await alertSystem(pool, {
        severity: 'info',
        source: 'admin_test',
        message: 'Kiểm tra thông báo cảnh báo GAERU thành công.',
        metadata: { triggeredBy: req.admin?.username || 'admin' },
        config
      });
      res.json({ ok: true, result });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  alertSystem,
  createSystemAlertsAdmin
};
