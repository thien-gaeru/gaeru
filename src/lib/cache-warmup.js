'use strict';

const { getFreshData, stockMap } = require('../cache');
const { loadProducts } = require('../store-api');
const { getCachedImageRow, warmPublicImage } = require('./image-renditions');
const { warmStaticAssets } = require('../persistent-assets');
try { require('sharp').concurrency(Math.max(1, Number(process.env.SHARP_CONCURRENCY) || (process.arch === 'arm64' ? 1 : 2))); } catch (_) {}

async function warmHotImagesInBackground(pool, products) {
  if (!pool || !pool.__gaeruCacheHooked || process.env.MEDIA_CACHE_ENABLED === 'false') return;
  try {
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
        await warmPublicImage(row);
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
        await warmPublicImage(row);
      }
    }
  } catch (_) {}
}

async function warmUpCache(pool) {
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

    if (pool && pool.__gaeruCacheHooked && process.env.MEDIA_CACHE_ENABLED !== 'false') {
      const t = setTimeout(() => { warmHotImagesInBackground(pool, products); }, 50);
      if (typeof t.unref === 'function') t.unref();
    }

    console.log(`[Cache Ready] Đã nạp sẵn ${products?.length || 0} thiết bị vào RAM.`);
    return products;
  } catch (err) {
    console.warn('[Cache Ready] Lỗi nạp cache khởi động:', err.message);
    return [];
  }
}

module.exports = { warmUpCache, warmHotImagesInBackground };
