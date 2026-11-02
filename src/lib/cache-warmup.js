'use strict';

const { getFreshData, stockMap } = require('../cache');
const { loadProducts } = require('../store-api');

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

    console.log(`[Cache Ready] Đã nạp sẵn ${products?.length || 0} thiết bị vào RAM.`);
    return products;
  } catch (err) {
    console.warn('[Cache Ready] Lỗi nạp cache khởi động:', err.message);
    return [];
  }
}

module.exports = { warmUpCache };
