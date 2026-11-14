'use strict';
const { Router } = require('express');
const { z } = require('zod');
const { requirePermission } = require('./staff-access');
const { requireCsrf } = require('./security');
const { withTransaction } = require('./db');
const { appendAudit } = require('./audit');
const { assertPublicHttpsUrlSyntax } = require('./audit-fixes/push-url-guard');
const { getLearnedKnowledgeStats, scanAndHarvestPastChats, invalidateCache } = require('./ai-self-learning');

const KEY = 'ai_knowledge_policy';
const uuidParam = z.string().uuid();

const entry = z.object({
  title: z.string().trim().min(2).max(160),
  triggers: z.array(z.string().trim().min(2).max(80)).min(1).max(20),
  facts: z.array(z.string().trim().min(5).max(1500)).min(1).max(10),
  sourceUrl: z.string().refine((v) => {
    if (v === '') return true;
    try {
      assertPublicHttpsUrlSyntax(v);
      return true;
    } catch (_) {
      return false;
    }
  }).optional().or(z.literal('')),
  enabled: z.boolean()
}).strict();

const schema = z.object({
  version: z.number().int().min(0),
  webSearchEnabled: z.boolean(),
  curatedEnabled: z.boolean(),
  entries: z.array(entry).max(80)
}).strict();

async function readKnowledgePolicy(pool) {
  const defaults = { version: 0, webSearchEnabled: false, curatedEnabled: true, entries: [] };
  if (!pool?.query) return defaults;
  const row = (await pool.query('SELECT setting_value FROM store_settings WHERE setting_key=$1', [KEY])).rows[0];
  return row?.setting_value || defaults;
}

function createKnowledgeAdmin(pool) {
  const router = Router();

  router.get('/ai-knowledge', requirePermission('settings.read'), async (_req, res, next) => {
    try {
      res.json(await readKnowledgePolicy(pool));
    } catch (e) {
      next(e);
    }
  });

  router.get('/ai-knowledge/learned', requirePermission('settings.read'), async (_req, res, next) => {
    try {
      const stats = await getLearnedKnowledgeStats(pool);
      const items = (await pool.query(
        'SELECT * FROM ai_learned_knowledge ORDER BY occurrence_count DESC, confidence_score DESC LIMIT 50'
      )).rows;
      res.json({ stats, items });
    } catch (e) {
      next(e);
    }
  });

  router.post('/ai-knowledge/learned/:id/status', requirePermission('settings.write'), requireCsrf, async (req, res, next) => {
    try {
      const id = uuidParam.parse(req.params.id);
      const status = z.enum(['active', 'pending_review', 'archived']).parse(req.body?.status);
      const updated = await withTransaction(pool, async (client) => {
        const before = (await client.query('SELECT id, topic, status FROM ai_learned_knowledge WHERE id=$1 FOR UPDATE', [id])).rows[0];
        if (!before) return null;
        await client.query('UPDATE ai_learned_knowledge SET status=$1, updated_at=now() WHERE id=$2', [status, id]);
        await appendAudit(client, {
          actor: req.admin,
          action: 'ai.learned.status',
          entityType: 'ai_learned_knowledge',
          entityId: id,
          before: { status: before.status },
          after: { status }
        });
        return before;
      });
      if (!updated) return res.status(404).json({ error: 'Không tìm thấy tri thức.' });
      invalidateCache();
      res.json({ message: 'Đã cập nhật trạng thái tri thức.' });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: 'ID hoặc trạng thái tri thức không hợp lệ.' });
      next(e);
    }
  });

  router.delete('/ai-knowledge/learned/:id', requirePermission('settings.write'), requireCsrf, async (req, res, next) => {
    try {
      const id = uuidParam.parse(req.params.id);
      const removed = await withTransaction(pool, async (client) => {
        const before = (await client.query('SELECT id, topic, status FROM ai_learned_knowledge WHERE id=$1 FOR UPDATE', [id])).rows[0];
        if (!before) return null;
        await client.query('DELETE FROM ai_learned_knowledge WHERE id=$1', [id]);
        await appendAudit(client, {
          actor: req.admin,
          action: 'ai.learned.delete',
          entityType: 'ai_learned_knowledge',
          entityId: id,
          before: { topic: before.topic, status: before.status }
        });
        return before;
      });
      if (!removed) return res.status(404).json({ error: 'Không tìm thấy tri thức.' });
      invalidateCache();
      res.json({ message: 'Đã xóa tri thức tự học.' });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: 'ID tri thức không hợp lệ.' });
      next(e);
    }
  });

  router.post('/ai-knowledge/learned/scan', requirePermission('settings.write'), requireCsrf, async (req, res, next) => {
    try {
      const result = await scanAndHarvestPastChats(pool, { limit: 200 });
      await withTransaction(pool, async (client) => {
        await appendAudit(client, {
          actor: req.admin,
          action: 'ai.learned.scan',
          entityType: 'ai_learned_knowledge',
          entityId: 'scan',
          metadata: { processed: result?.processed || 0, learned: result?.learned || 0 }
        });
      });
      invalidateCache();
      res.json({ message: 'Đã quét và đúc kết tri thức từ các cuộc hội thoại.', ...result });
    } catch (e) {
      next(e);
    }
  });

  router.put('/ai-knowledge', requirePermission('settings.write'), requireCsrf, async (req, res, next) => {
    try {
      const data = schema.parse(req.body);
      const result = await withTransaction(pool, async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(hashtext('gaeru:ai-knowledge'))");
        const old = await readKnowledgePolicy(c);
        if (old.version !== data.version) throw Object.assign(Error('Cấu hình đã thay đổi. Tải lại trước khi lưu.'), { status: 409 });
        const saved = { ...data, version: data.version + 1 };
        await c.query(
          'INSERT INTO store_settings(setting_key,setting_value) VALUES($1,$2) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=now()',
          [KEY, JSON.stringify(saved)]
        );
        await appendAudit(c, {
          actor: req.admin,
          action: 'ai.knowledge.update',
          entityType: 'settings',
          entityId: KEY,
          metadata: { entries: saved.entries.length, webSearchEnabled: saved.webSearchEnabled }
        });
        return saved;
      });
      invalidateCache();
      res.json(result);
    } catch (e) {
      if (e.name === 'ZodError') return res.status(400).json({ error: 'Kiểm tra nội dung, từ khóa và URL nguồn HTTPS.' });
      next(e);
    }
  });

  return router;
}

module.exports = { createKnowledgeAdmin, readKnowledgePolicy, schema };
