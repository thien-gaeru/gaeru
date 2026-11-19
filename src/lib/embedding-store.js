'use strict';

/**
 * Persistent PostgreSQL + RAM Embedding Store with Cluster IPC Synchronization.
 *
 * Pre-indexes static GAERU knowledge (products, HTML pages, news articles,
 * active self-learned Q&As, and internal AI intent prototypes) so live customer
 * queries only need to embed ONE short string (~60-110ms) instead of 9-25 docs.
 */

const {
  embedTexts,
  cosineSimilarity,
  hashEmbeddingText,
  MAX_EMBED_TEXT_CHARS,
  isGpuAiEnabled
} = require('./gpu-ai-client');

const DEFAULT_MODEL_ID = (process.env.GAERU_EMBED_MODEL_ID || 'minilm-l12-v2-q8').trim();
const MAX_NAMESPACE_ENTRIES = 1000;

// Map<namespace, Map<itemKey, { hash: string, vec: Float32Array }>>
const memoryStore = new Map();
const hydratedNamespaces = new Set();
const hydrateInFlight = new Map();

function getModelId() {
  return (process.env.GAERU_EMBED_MODEL_ID || DEFAULT_MODEL_ID).trim();
}

function vecToBase64(vec) {
  if (!vec || !vec.length) return '';
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

function base64ToVec(b64, expectedDim = 0) {
  if (!b64 || typeof b64 !== 'string') return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length || buf.length % 4 !== 0) return null;
    const dim = buf.length / 4;
    if (expectedDim > 0 && dim !== expectedDim) return null;
    const out = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      out[i] = buf.readFloatLE(i * 4);
    }
    return out;
  } catch (_) {
    return null;
  }
}

function getNamespaceMap(namespace) {
  let nsMap = memoryStore.get(namespace);
  if (!nsMap) {
    nsMap = new Map();
    memoryStore.set(namespace, nsMap);
  }
  return nsMap;
}

function upsertMemoryEntries(namespace, entries) {
  if (!namespace || !Array.isArray(entries) || !entries.length) return;
  const nsMap = getNamespaceMap(namespace);
  for (const e of entries) {
    if (!e || !e.key || !e.hash) continue;
    const vec = e.vec instanceof Float32Array ? e.vec : base64ToVec(e.vectorB64, e.dim || 0);
    if (!vec) continue;
    if (!nsMap.has(e.key) && nsMap.size >= MAX_NAMESPACE_ENTRIES) {
      const oldest = nsMap.keys().next().value;
      if (oldest !== undefined) nsMap.delete(oldest);
    }
    nsMap.set(String(e.key), { hash: String(e.hash), vec });
  }
}

function resetEmbeddingStore() {
  memoryStore.clear();
  hydratedNamespaces.clear();
  hydrateInFlight.clear();
}

const IPC_KEY = Symbol.for('gaeru.embeddingStore.ipc');
if (typeof process.on === 'function' && !process[IPC_KEY]) {
  process[IPC_KEY] = true;
  process.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'EMBEDDING_STORE_SYNC' && msg.namespace && Array.isArray(msg.entries)) {
      if (msg.modelId && msg.modelId !== getModelId()) return;
      upsertMemoryEntries(msg.namespace, msg.entries);
    } else if (msg.type === 'AI_KNOWLEDGE_INVALIDATE') {
      memoryStore.delete('learned');
      hydratedNamespaces.delete('learned');
    }
  });
}

function broadcastSync(namespace, entries) {
  if (typeof process.send !== 'function' || !entries.length) return;
  try {
    process.send({
      type: 'EMBEDDING_STORE_SYNC',
      namespace,
      modelId: getModelId(),
      entries: entries.map(e => ({
        key: e.key,
        hash: e.hash,
        dim: e.vec.length,
        vectorB64: vecToBase64(e.vec)
      }))
    });
  } catch (_) {}
}

async function hydrateNamespace(pool, namespace) {
  if (!pool || typeof pool.query !== 'function' || !namespace) return getNamespaceMap(namespace);
  const modelId = getModelId();
  const hydrateKey = `${namespace}:${modelId}`;
  if (hydratedNamespaces.has(hydrateKey)) return getNamespaceMap(namespace);
  if (hydrateInFlight.has(hydrateKey)) return hydrateInFlight.get(hydrateKey);

  const p = (async () => {
    const nsMap = getNamespaceMap(namespace);
    try {
      const res = await pool.query(
        'SELECT item_key, content_hash, dim, vector_b64 FROM ai_embedding_vectors WHERE namespace=$1 AND model_id=$2 LIMIT $3',
        [namespace, modelId, MAX_NAMESPACE_ENTRIES]
      );
      for (const row of res?.rows || []) {
        const vec = base64ToVec(row.vector_b64, Number(row.dim) || 0);
        if (vec && row.item_key && row.content_hash) {
          nsMap.set(String(row.item_key), { hash: String(row.content_hash), vec });
        }
      }
      hydratedNamespaces.add(hydrateKey);
    } catch (_) {
      // Graceful fallback when running against mock pools or pre-migration DB
    } finally {
      hydrateInFlight.delete(hydrateKey);
    }
    return nsMap;
  })();

  hydrateInFlight.set(hydrateKey, p);
  return p;
}

async function persistEntries(pool, namespace, entries) {
  if (!pool || typeof pool.query !== 'function' || !entries.length) return;
  const modelId = getModelId();
  const keys = [];
  const hashes = [];
  const dims = [];
  const b64s = [];
  for (const e of entries) {
    if (!e?.key || !e?.hash || !e?.vec?.length) continue;
    keys.push(String(e.key));
    hashes.push(String(e.hash));
    dims.push(e.vec.length);
    b64s.push(vecToBase64(e.vec));
  }
  if (!keys.length) return;
  try {
    await pool.query(
      `INSERT INTO ai_embedding_vectors (namespace, item_key, content_hash, model_id, dim, vector_b64, updated_at)
       SELECT $1, u.k, u.h, $2, u.d, u.v, NOW()
       FROM UNNEST($3::text[], $4::text[], $5::int[], $6::text[]) AS u(k, h, d, v)
       ON CONFLICT (namespace, item_key, model_id)
       DO UPDATE SET content_hash = EXCLUDED.content_hash,
                     dim = EXCLUDED.dim,
                     vector_b64 = EXCLUDED.vector_b64,
                     updated_at = NOW()`,
      [namespace, modelId, keys, hashes, dims, b64s]
    );
  } catch (_) {
    // Non-fatal: RAM cache remains valid even if DB write is unavailable
  }
}

/**
 * Ensures embeddings exist for all provided `{ key, text }` items in `namespace`.
 * Returns Map<key, Float32Array> for all successfully resolved items.
 */
async function ensureEmbeddings(pool, namespace, items, {
  priority = 'normal',
  batchSize,
  transport = fetch,
  skipDb = false
} = {}) {
  const result = new Map();
  if (!Array.isArray(items) || !items.length) return result;

  const isCustomTransport = transport !== fetch;
  const nsMap = (!skipDb && !isCustomTransport)
    ? await hydrateNamespace(pool, namespace)
    : getNamespaceMap(namespace);

  const missing = [];
  for (const raw of items) {
    const key = String(raw?.key || '').trim();
    const text = String(raw?.text || '').trim().slice(0, MAX_EMBED_TEXT_CHARS);
    if (!key || !text) continue;
    const hash = hashEmbeddingText(text);
    const hit = !isCustomTransport ? nsMap.get(key) : null;
    if (hit && hit.hash === hash && hit.vec) {
      result.set(key, hit.vec);
    } else {
      missing.push({ key, text, hash });
    }
  }

  if (missing.length > 0) {
    const chunkSize = Math.max(1, Number(batchSize) || (priority === 'background' ? 4 : 8));
    for (let offset = 0; offset < missing.length; offset += chunkSize) {
      const slice = missing.slice(offset, offset + chunkSize);
      const vecs = await embedTexts(slice.map(m => m.text), { priority, batchSize: chunkSize, transport });
      if (!Array.isArray(vecs)) {
        // Thermal/busy shed on background chunk: persist what we already computed and yield
        break;
      }
      const newlyComputed = [];
      for (let i = 0; i < slice.length; i++) {
        const vec = vecs[i];
        if (!vec) continue;
        result.set(slice[i].key, vec);
        newlyComputed.push({ key: slice[i].key, hash: slice[i].hash, vec });
      }
      if (newlyComputed.length && !isCustomTransport) {
        upsertMemoryEntries(namespace, newlyComputed);
        if (!skipDb) await persistEntries(pool, namespace, newlyComputed);
        broadcastSync(namespace, newlyComputed);
      }
      if (priority === 'background' && offset + chunkSize < missing.length) {
        await new Promise(r => setTimeout(r, 150));
      }
    }
  }

  return result;
}

/**
 * Ranks items by cosine similarity with margin calculation.
 * Returns `{ matches: Array<{ key, cos, item }>, best, secondBest, margin }`.
 */
function rankByCosine(queryVec, itemsWithVec, { topK = 5, minCos = 0.24 } = {}) {
  if (!queryVec || !Array.isArray(itemsWithVec) || !itemsWithVec.length) {
    return { matches: [], best: null, secondBest: null, margin: 0 };
  }
  const scored = [];
  for (const entry of itemsWithVec) {
    if (!entry?.vec) continue;
    const cos = cosineSimilarity(queryVec, entry.vec);
    scored.push({ key: entry.key, cos, item: entry.item });
  }
  scored.sort((a, b) => b.cos - a.cos);
  const best = scored[0] || null;
  const secondBest = scored[1] || null;
  const margin = best ? (best.cos - (secondBest ? secondBest.cos : 0)) : 0;
  const matches = scored.filter(s => s.cos >= minCos).slice(0, topK);
  return { matches, best, secondBest, margin };
}

function getEmbeddingStoreStats() {
  const namespaces = {};
  let totalVectors = 0;
  let totalBytes = 0;
  for (const [ns, map] of memoryStore.entries()) {
    namespaces[ns] = map.size;
    totalVectors += map.size;
    for (const entry of map.values()) {
      totalBytes += (entry.vec?.byteLength || 0);
    }
  }
  return {
    modelId: getModelId(),
    namespaces,
    totalVectors,
    ramKb: Math.round(totalBytes / 1024)
  };
}

let warmupRunning = false;
async function warmEmbeddingIndexInBackground(pool, { transport = fetch } = {}) {
  if (warmupRunning || !pool || typeof pool.query !== 'function') return { skipped: true };
  if (!isGpuAiEnabled() && transport === fetch) return { skipped: true, reason: 'disabled' };
  warmupRunning = true;
  const summary = { products: 0, webPages: 0, news: 0, learned: 0, internalIntents: 0, customerFaqs: 0, customerIntents: 0 };
  try {
    // 1. Products (active catalog)
    try {
      const prodRes = await pool.query(`
        SELECT p.slug, p.name, p.category, p.descriptor, p.card_summary, p.description
        FROM products p
        WHERE p.active = true AND p.deleted_at IS NULL
        ORDER BY p.created_at DESC
        LIMIT 60
      `);
      const prodItems = (prodRes.rows || []).map(p => ({
        key: String(p.slug),
        text: `${p.name || ''}. ${p.category || ''}. ${p.descriptor || ''}. ${p.card_summary || p.description || ''}`.replace(/\s+/g, ' ').trim().slice(0, MAX_EMBED_TEXT_CHARS)
      }));
      if (prodItems.length) {
        const m = await ensureEmbeddings(pool, 'products', prodItems, { priority: 'background', transport });
        summary.products = m.size;
      }
    } catch (_) {}

    // 2. Static Web Knowledge HTML pages (use clean substantive summaryText & prune excluded pages)
    try {
      const { loadWebPagesIndexAsync, EXCLUDED_HTML } = require('../chat-web-knowledge');
      if (typeof loadWebPagesIndexAsync === 'function') {
        if (EXCLUDED_HTML && EXCLUDED_HTML.size && typeof pool.query === 'function') {
          await pool.query(
            'DELETE FROM ai_embedding_vectors WHERE namespace = $1 AND item_key = ANY($2::text[])',
            ['web_pages', Array.from(EXCLUDED_HTML)]
          ).catch(() => {});
        }
        const pages = await loadWebPagesIndexAsync();
        const pageItems = (pages || []).map(page => ({
          key: String(page.file),
          text: (page.summaryText || `${page.title || ''}. ${String(page.content || '').slice(0, 280)}`).replace(/\s+/g, ' ').trim().slice(0, MAX_EMBED_TEXT_CHARS)
        }));
        if (pageItems.length) {
          const m = await ensureEmbeddings(pool, 'web_pages', pageItems, { priority: 'background', transport });
          summary.webPages = m.size;
        }
      }
    } catch (_) {}

    // 3. Published News / Guides articles
    try {
      const newsRes = await pool.query(`
        SELECT slug, title, excerpt
        FROM news_posts
        WHERE status = 'published'
        ORDER BY published_at DESC NULLS LAST, created_at DESC
        LIMIT 100
      `);
      const newsItems = (newsRes.rows || []).map(n => ({
        key: String(n.slug),
        text: `${n.title || ''}. ${n.excerpt || ''}`.replace(/\s+/g, ' ').trim().slice(0, MAX_EMBED_TEXT_CHARS)
      }));
      if (newsItems.length) {
        const m = await ensureEmbeddings(pool, 'news', newsItems, { priority: 'background', transport });
        summary.news = m.size;
      }
    } catch (_) {}

    // 4. Active Self-Learned Knowledge
    try {
      const learnedRes = await pool.query(`
        SELECT id, topic, sample_question, learned_facts, sample_answer
        FROM ai_learned_knowledge
        WHERE status = 'active'
        ORDER BY confidence_score DESC, occurrence_count DESC
        LIMIT 100
      `);
      const learnedItems = (learnedRes.rows || []).map(e => ({
        key: String(e.id),
        text: `${e.topic || ''}. ${e.sample_question || ''}. ${e.learned_facts || e.sample_answer || ''}`.replace(/\s+/g, ' ').trim().slice(0, MAX_EMBED_TEXT_CHARS)
      }));
      if (learnedItems.length) {
        const m = await ensureEmbeddings(pool, 'learned', learnedItems, { priority: 'background', transport });
        summary.learned = m.size;
      }
    } catch (_) {}

    // 5. Internal Admin AI Intent Prototypes
    try {
      const { INTERNAL_AI_INTENT_PROTOTYPES } = require('./internal-ai-intents');
      if (Array.isArray(INTERNAL_AI_INTENT_PROTOTYPES) && INTERNAL_AI_INTENT_PROTOTYPES.length) {
        const m = await ensureEmbeddings(pool, 'internal_intents', INTERNAL_AI_INTENT_PROTOTYPES, { priority: 'background', transport });
        summary.internalIntents = m.size;
      }
    } catch (_) {}

    // 6. Curated Customer Semantic FAQ Prototypes (P2 Rescue Layer)
    try {
      const { CUSTOMER_SEMANTIC_FAQS } = require('./customer-semantic-faq');
      if (Array.isArray(CUSTOMER_SEMANTIC_FAQS) && CUSTOMER_SEMANTIC_FAQS.length) {
        const faqItems = CUSTOMER_SEMANTIC_FAQS.map(f => ({ key: f.key, text: f.text }));
        const m = await ensureEmbeddings(pool, 'customer_faqs', faqItems, { priority: 'background', transport });
        summary.customerFaqs = m.size;
      }
    } catch (_) {}

    // 7. Curated Customer Semantic Intent Prototypes (Gói 1 Context Intelligence)
    try {
      const { CUSTOMER_INTENT_PROTOTYPES } = require('./customer-intent-router');
      if (Array.isArray(CUSTOMER_INTENT_PROTOTYPES) && CUSTOMER_INTENT_PROTOTYPES.length) {
        const intentItems = CUSTOMER_INTENT_PROTOTYPES.map(i => ({ key: i.key, text: i.text }));
        const m = await ensureEmbeddings(pool, 'customer_intents', intentItems, { priority: 'background', transport });
        summary.customerIntents = m.size;
      }
    } catch (_) {}
  } finally {
    warmupRunning = false;
  }
  return summary;
}

module.exports = {
  DEFAULT_MODEL_ID,
  getModelId,
  vecToBase64,
  base64ToVec,
  hydrateNamespace,
  ensureEmbeddings,
  rankByCosine,
  getEmbeddingStoreStats,
  warmEmbeddingIndexInBackground,
  resetEmbeddingStore
};
