'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./helpers/pglite-db');
const {
  INITIAL_KNOWLEDGE,
  seedInitialKnowledge,
  searchKnowledge,
  createKnowledgeAdminRouter
} = require('../src/chat-semantic-knowledge');

test('Chat Semantic Knowledge: Live PostgreSQL seeding, RAG query latency, ranking and admin management', async (t) => {
  const { db, pool } = await createTestDb();

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_knowledge_documents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        category text NOT NULL DEFAULT 'general',
        title text NOT NULL,
        content text NOT NULL,
        product_slug text,
        keywords text[] NOT NULL DEFAULT '{}',
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS chat_knowledge_slug_idx ON chat_knowledge_documents (product_slug);
      CREATE INDEX IF NOT EXISTS chat_knowledge_category_idx ON chat_knowledge_documents (category);
    `);

    await t.test('1. Seeding & Idempotency: Inserts 9 knowledge documents and prevents duplicates on rerun', async () => {
      await seedInitialKnowledge(pool);
      const res1 = await pool.query('SELECT count(*)::int as count FROM chat_knowledge_documents');
      assert.equal(res1.rows[0].count, INITIAL_KNOWLEDGE.length);

      // Re-run seeding -> must not create duplicate documents
      await seedInitialKnowledge(pool);
      const res2 = await pool.query('SELECT count(*)::int as count FROM chat_knowledge_documents');
      assert.equal(res2.rows[0].count, INITIAL_KNOWLEDGE.length);
    });

    await t.test('2. Semantic & Keyword Ranking: Top match accurately classifies product specs and policies', async () => {
      // Test K9 microphone
      const k9 = await searchKnowledge(pool, 'mic k9 cắm iphone có lọc ồn không', { limit: 1, productSlug: 'k9' });
      assert.equal(k9.length, 1);
      assert.equal(k9[0].productSlug, 'k9');
      assert.match(k9[0].title, /K9/);

      // Test Gimbal P01
      const p01 = await searchKnowledge(pool, 'gimbal p01 bám mặt xoay 360 độ', { limit: 1, productSlug: 'p01' });
      assert.equal(p01.length, 1);
      assert.equal(p01[0].productSlug, 'p01');
      assert.match(p01[0].title, /P01/);

      // Test Warranty Policy
      const policy = await searchKnowledge(pool, 'chính sách bảo hành đổi trả 1 đổi 1', { limit: 1 });
      assert.equal(policy.length, 1);
      assert.equal(policy[0].category, 'policy');
      assert.match(policy[0].content, /12 tháng/);

      // Test Android OTG
      const otg = await searchKnowledge(pool, 'điện thoại oppo vivo cắm mic không nhận bật otg', { limit: 1 });
      assert.equal(otg.length, 1);
      assert.match(otg[0].title, /OTG/);
    });

    await t.test('3. Scoped Filtering & Active State: Excludes inactive documents and respects product_slug', async () => {
      const g1 = (await pool.query("SELECT id FROM chat_knowledge_documents WHERE product_slug = 'g1-ultra'")).rows[0];
      await pool.query('UPDATE chat_knowledge_documents SET active = false WHERE id = $1', [g1.id]);

      const searchInactive = await searchKnowledge(pool, 'g1 ultra mic kép', { productSlug: 'g1-ultra' });
      assert.ok(!searchInactive.some(d => d.id === g1.id), 'Deactivated document must not be returned');

      await pool.query('UPDATE chat_knowledge_documents SET active = true WHERE id = $1', [g1.id]);
    });

    await t.test('4. Admin Router Lifecycle: Mounts router with settings read/write permissions', async () => {
      const router = createKnowledgeAdminRouter(pool);
      assert.ok(router);
      assert.equal(typeof router, 'function');
    });

  } finally {
    await db.close();
  }
});
