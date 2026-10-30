'use strict';

/**
 * src/domain/pricing/pricing-engine.js
 * 
 * Single Source of Truth cho toàn bộ logic định giá đơn hàng và áp dụng khuyến mại tại GAERU:
 * - Khuyến mại biến thể (product_promotions)
 * - Chiến dịch Flash Sale (flash_sales)
 * - Gói sản phẩm / Combo (product_bundles)
 * - Mã giảm giá / Voucher (marketing.js)
 * - Phí vận chuyển theo biểu phí tỉnh/thành (checkout-flow.js)
 */

function calculateReducedPrice(basePrice, promotion) {
  if (!promotion) return basePrice;
  if (promotion.kind === 'percent') {
    return Math.max(0, basePrice - Math.floor(basePrice * promotion.amount / 100));
  }
  return Math.max(0, basePrice - (promotion.amount || 0));
}

class PricingEngine {
  /**
   * Áp dụng khuyến mại biến thể và flash sale lên danh sách biến thể được chuẩn bị
   */
  static async applyPromotions(client, variants) {
    if (!variants || !variants.length) return variants || [];

    const variantIds = variants.map(v => v.id).filter(Boolean);
    let promoRows = [];
    if (variantIds.length) {
      try {
        const res = await client.query(
          `SELECT p.*, pv.variant_id 
           FROM product_promotions p 
           JOIN product_promotion_variants pv ON pv.promotion_id = p.id 
           WHERE pv.variant_id = ANY($1::uuid[]) 
             AND p.active = true 
             AND p.starts_at <= statement_timestamp() 
             AND p.ends_at > statement_timestamp() 
           ORDER BY p.id`,
          [variantIds]
        );
        promoRows = res.rows || [];
      } catch {}
    }

    let flashRows = [];
    try {
      const fsRes = await client.query(
        `SELECT id, title, ends_at, discount_percent, product_slugs 
         FROM flash_sales 
         WHERE active = true 
           AND starts_at <= statement_timestamp() 
           AND ends_at > statement_timestamp()`
      );
      flashRows = fsRes.rows || [];
    } catch {}

    const slugByVariantId = new Map();
    const needSlugs = variants.filter(v => !v.productSlug && v.id).map(v => v.id);
    if (needSlugs.length && flashRows.length) {
      try {
        const psRes = await client.query(
          `SELECT v.id AS variant_id, p.slug 
           FROM product_variants v 
           JOIN products p ON p.id = v.product_id 
           WHERE v.id = ANY($1::uuid[])`,
          [needSlugs]
        );
        for (const r of (psRes.rows || [])) {
          slugByVariantId.set(r.variant_id, r.slug);
        }
      } catch {}
    }

    return variants.map(v => {
      let best = v.priceVnd;
      let promotion = null;

      for (const p of promoRows) {
        if (p.variant_id !== v.id) continue;
        const price = calculateReducedPrice(v.priceVnd, p);
        if (price < best) {
          best = price;
          promotion = {
            id: p.id,
            title: p.title,
            type: p.type,
            endsAt: p.ends_at
          };
        }
      }

      const vSlug = v.productSlug || slugByVariantId.get(v.id);
      for (const fs of flashRows) {
        const slugs = Array.isArray(fs.product_slugs)
          ? fs.product_slugs
          : (typeof fs.product_slugs === 'string' ? JSON.parse(fs.product_slugs || '[]') : []);

        if (slugs.length > 0 && vSlug && (
          slugs.includes(vSlug) ||
          slugs.includes(vSlug.replace(/^gaeru-/, '')) ||
          slugs.includes('gaeru-' + vSlug)
        )) {
          const fsPrice = Math.max(0, Math.floor(v.priceVnd * (100 - fs.discount_percent) / 100));
          if (fsPrice < best) {
            best = fsPrice;
            promotion = {
              id: fs.id,
              title: fs.title,
              type: 'flash',
              endsAt: fs.ends_at,
              discountPercent: fs.discount_percent
            };
          }
        }
      }

      return {
        ...v,
        priceVnd: best,
        originalPriceVnd: v.originalPriceVnd || v.priceVnd,
        promotion
      };
    });
  }

  /**
   * Tính toán toàn diện giá trị đơn hàng, giảm giá voucher, phí ship và tổng tiền
   */
  static async calculateOrderPricing(client, { items, voucherCode, customerId, city, shippingRates }) {
    const prepared = await PricingEngine.applyPromotions(client, items);
    const subtotalVnd = prepared.reduce((sum, item) => sum + item.priceVnd * item.quantity, 0);

    let discountVnd = 0;
    let voucher = null;
    if (voucherCode) {
      const marketing = require('../../marketing');
      const productSlugs = prepared.map(p => p.productSlug).filter(Boolean);
      voucher = await marketing.eligible(client, voucherCode, customerId, subtotalVnd, true, { productSlugs });
      discountVnd = voucher?.discountVnd || 0;
    }

    let shippingFeeVnd = 0;
    if (city && shippingRates) {
      const checkoutFlow = require('../../../checkout-flow');
      shippingFeeVnd = checkoutFlow.shippingFee(shippingRates, city) || 0;
    }

    const totalVnd = Math.max(0, subtotalVnd + shippingFeeVnd - discountVnd);

    return {
      items: prepared,
      subtotalVnd,
      discountVnd,
      shippingFeeVnd,
      totalVnd,
      voucher,
      promotionSnapshots: prepared.map(item => ({
        variantId: item.id,
        originalPriceVnd: item.originalPriceVnd,
        finalPriceVnd: item.priceVnd,
        quantity: item.quantity,
        promotion: item.promotion
      }))
    };
  }
}

module.exports = {
  PricingEngine,
  calculateReducedPrice
};
