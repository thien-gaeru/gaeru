'use strict';

const http = require('node:http');
const { getFreshData, stockMap } = require('../cache');
const { loadProducts } = require('../store-api');
const { getCachedImageRow, warmPublicImage, supportedServeWidths } = require('./image-renditions');
const { warmStaticAssets } = require('../persistent-assets');
const { warmStaticTextAssets } = require('./static-asset-cache');
const path = require('node:path');
try { require('sharp').concurrency(Math.max(1, Number(process.env.SHARP_CONCURRENCY) || (process.arch === 'arm64' ? 1 : 2))); } catch (_) {}

function fetchLocalRoute(port, routePath) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: routePath,
        method: 'GET',
        timeout: 4000,
        headers: {
          'Accept-Encoding': 'br, gzip',
          'User-Agent': 'GAERU-Warmup-Bot/1.0'
        }
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode || 0));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
    req.end();
  });
}

async function warmLocalSsrRoutes(app, products) {
  if (!app || typeof app !== 'function') return 0;
  const routes = ['/', '/cua-hang', '/ho-tro', '/huong-dan'];
  const slugs = (Array.isArray(products) ? products : [])
    .map((p) => String(p?.slug || '').trim())
    .filter((s) => /^[a-z0-9-]+$/i.test(s))
    .slice(0, 8);
  for (const slug of slugs) {
    routes.push(`/san-pham/${slug}`);
    routes.push(`/huong-dan/${slug}`);
  }
  const tempServer = http.createServer(app);
  let warmed = 0;
  try {
    await new Promise((resolve, reject) => {
      tempServer.once('error', reject);
      tempServer.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
    });
    tempServer.unref?.();
    const addr = tempServer.address();
    if (!addr || typeof addr !== 'object' || !addr.port) return 0;
    for (const route of routes) {
      const status = await fetchLocalRoute(addr.port, route);
      if (status >= 200 && status < 400) warmed++;
    }
    return warmed;
  } catch (_) {
    return warmed;
  } finally {
    try { tempServer.close(); } catch (_) {}
  }
}

async function warmHotImagesInBackground(pool, products) {
  if (!pool || !pool.__gaeruCacheHooked || process.env.MEDIA_CACHE_ENABLED === 'false') return;
  try {
    warmStaticTextAssets(path.resolve(__dirname, '..', '..'), require('../public-files'));
    await warmStaticAssets(pool);
    const shouldWarmRenditions = process.env.RENDITION_DISK_CACHE === 'true' || process.env.NODE_ENV === 'production';
    const catalogIds = new Set();
    for (const p of products || []) {
      const mediaUrls = Array.isArray(p.descriptionMedia)
        ? p.descriptionMedia.filter(m => m && m.type === 'image').map(m => m.url)
        : [];
      const urls = [p.imageUrl, ...(p.gallery || []), ...(p.variants || []).map(v => v.imageUrl), ...mediaUrls].filter(Boolean);
      for (const rawUrl of urls) {
        const match = /^\/api\/catalog-images\/([0-9a-f-]{36})(?:\?|$)/i.exec(String(rawUrl));
        if (match) catalogIds.add(match[1]);
      }
    }
    for (const id of [...catalogIds].slice(0, 64)) {
      const canonical = '/api/catalog-images/' + id;
      const row = await getCachedImageRow(
        pool,
        'catalog:' + id,
        async () => (await pool.query(
          `SELECT content,mime_type FROM catalog_images WHERE id=$1 AND EXISTS(SELECT 1 FROM products p LEFT JOIN product_presentations m ON m.product_id=p.id WHERE p.active=true AND p.deleted_at IS NULL AND (p.image_url=$2 OR m.gallery @> $3::jsonb OR m.description_media @> $4::jsonb OR EXISTS(SELECT 1 FROM product_variants v WHERE v.product_id=p.id AND v.active=true AND v.image_url=$2)))`,
          [id, canonical, JSON.stringify([canonical]), JSON.stringify([{ type: 'image', url: canonical }])]
        )).rows[0]
      );
      if (row && shouldWarmRenditions) {
        await warmPublicImage(row, supportedServeWidths);
      }
    }
    const newsRows = (await pool.query("SELECT cover_id FROM news_posts WHERE status='published' AND cover_id IS NOT NULL ORDER BY published_at DESC, id LIMIT 24")).rows;
    for (const { cover_id: coverId } of newsRows) {
      if (!coverId) continue;
      const row = await getCachedImageRow(
        pool,
        'news:' + coverId,
        async () => (await pool.query(
          "SELECT content,mime_type FROM news_images WHERE id=$1 AND EXISTS(SELECT 1 FROM news_posts WHERE cover_id=$1 AND status='published')",
          [coverId]
        )).rows[0]
      );
      if (row && shouldWarmRenditions) {
        await warmPublicImage(row, supportedServeWidths);
      }
    }
  } catch (_) {}
}

async function warmUpCache(pool, { app = null } = {}) {
  try {
    const products = await getFreshData('data:catalog', async () => {
      const list = await loadProducts(pool);
      return list;
    });

    if (Array.isArray(products)) {
      for (const p of products) {
        if (Array.isArray(p.variants)) {
          for (const v of p.variants) {
            const qty = Number(v.stockQuantity ?? v.stock ?? 0);
            if (v.sku) stockMap.set(v.sku, qty);
            if (v.id) stockMap.set(v.id, qty);
          }
        }
      }
    }

    // Pre-warm public CSS/JS buffers & pre-compressed br/gzip variants on EVERY worker RAM
    try {
      warmStaticTextAssets(path.resolve(__dirname, '..', '..'), require('../public-files'));
    } catch (_) {}

    const workerIndex = Math.max(0, Number.parseInt(process.env.WORKER_INDEX || '0', 10) || 0);
    const isPrimarySlot = !process.env.CLUSTER_WORKER || workerIndex === 0;
    const isTestEnv = process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);

    if (isPrimarySlot && pool && pool.__gaeruCacheHooked && process.env.MEDIA_CACHE_ENABLED !== 'false') {
      const t = setTimeout(() => { warmHotImagesInBackground(pool, products); }, 50);
      if (typeof t.unref === 'function') t.unref();
    }
    if (!isTestEnv && app && typeof app === 'function' && process.env.SSR_WARMUP_ENABLED !== 'false') {
      // Stagger per-worker SSR HTML warmup so each worker populates its own RAM cache cleanly
      const ssrTimer = setTimeout(() => {
        warmLocalSsrRoutes(app, products)
          .then((count) => {
            if (count > 0) console.log(`[SSR Warmup] Worker #${workerIndex} đã làm ấm ${count} trang HTML trong RAM.`);
          })
          .catch(() => {});
      }, 400 + workerIndex * 350);
      if (typeof ssrTimer.unref === 'function') ssrTimer.unref();
    }
    if (pool && typeof pool.query === 'function' && !isTestEnv) {
      const embedStore = require('./embedding-store');
      // Every worker hydrates pre-computed vectors from PostgreSQL into RAM (<2ms)
      const hTimer = setTimeout(() => {
        Promise.all([
          embedStore.hydrateNamespace(pool, 'products'),
          embedStore.hydrateNamespace(pool, 'web_pages'),
          embedStore.hydrateNamespace(pool, 'news'),
          embedStore.hydrateNamespace(pool, 'learned'),
          embedStore.hydrateNamespace(pool, 'internal_intents'),
          embedStore.hydrateNamespace(pool, 'customer_faqs'),
          embedStore.hydrateNamespace(pool, 'customer_intents')
        ]).catch(() => {});
      }, 250);
      if (typeof hTimer.unref === 'function') hTimer.unref();

      // Primary worker incrementally fills any missing vectors in background (thermal-safe)
      if (isPrimarySlot) {
        const wTimer = setTimeout(() => {
          embedStore.warmEmbeddingIndexInBackground(pool).catch(() => {});
        }, 15000);
        if (typeof wTimer.unref === 'function') wTimer.unref();

        const wInterval = setInterval(() => {
          embedStore.warmEmbeddingIndexInBackground(pool).catch(() => {});
        }, 15 * 60 * 1000);
        if (typeof wInterval.unref === 'function') wInterval.unref();
      }
    }

    console.log(`[Cache Ready] Đã nạp sẵn ${products?.length || 0} thiết bị vào RAM.`);
    return products;
  } catch (err) {
    console.warn('[Cache Ready] Lỗi nạp cache khởi động:', err.message);
    return [];
  }
}

module.exports = { warmUpCache, warmHotImagesInBackground, warmLocalSsrRoutes };
