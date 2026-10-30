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
  static async applyPromotions(client, variants, options = {}) {
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

    let bundleRows = [];
    try {
      const bRes = await client.query(
        `SELECT id, main_product_slug AS "mainProductSlug", bundle_product_slug AS "bundleProductSlug", 
                bundle_title AS "bundleTitle", discount_percent AS "discountPercent"
         FROM product_bundles WHERE active = true`
      );
      bundleRows = bRes.rows || [];
    } catch {}

    const slugByVariantId = new Map();
    const needSlugs = variants.filter(v => !v.productSlug && v.id).map(v => v.id);
    if (needSlugs.length && (flashRows.length || bundleRows.length)) {
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
      let bestLineTotalVnd = undefined;
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

      // Ưu đãi gói Combo (product_bundles) khi giỏ hàng có cả sản phẩm chính và phụ kiện
      // CHỈ áp dụng trong ngữ cảnh giỏ hàng / checkout (options.context !== 'catalog')
      if (bundleRows.length && vSlug && options.context !== 'catalog') {
        const quantityBySlug = new Map();
        for (const item of variants) {
          const s = item.productSlug || slugByVariantId.get(item.id);
          if (s) {
            const q = Number(item.quantity) || 1;
            quantityBySlug.set(s, (quantityBySlug.get(s) || 0) + q);
          }
        }

        for (const b of bundleRows) {
          const mainSlug = b.mainProductSlug || b.main_product_slug;
          const bundleSlug = b.bundleProductSlug || b.bundle_product_slug;
          const discountPct = Number(b.discountPercent ?? b.discount_percent ?? 0);
          const bundleTitle = b.bundleTitle || b.bundle_title;

          if (bundleSlug === vSlug && quantityBySlug.has(mainSlug)) {
            const mainQty = quantityBySlug.get(mainSlug) || 0;
            const accessoryQty = Number(v.quantity) || 1;
            // Số lượng phụ kiện được hưởng ưu đãi combo tối đa là min(mainQty, accessoryQty)
            const eligibleUnits = Math.min(mainQty, accessoryQty);

            if (eligibleUnits > 0) {
              const discountedUnit = Math.max(0, Math.floor(v.priceVnd * (100 - discountPct) / 100));
              const remainingUnits = accessoryQty - eligibleUnits;
              const totalLineVnd = (eligibleUnits * discountedUnit) + (remainingUnits * v.priceVnd);
              const effectivePrice = Math.round(totalLineVnd / accessoryQty);

              if (effectivePrice < best) {
                best = effectivePrice;
                bestLineTotalVnd = totalLineVnd;
                promotion = {
                  id: b.id,
                  title: bundleTitle,
                  type: 'bundle',
                  discountPercent: discountPct,
                  eligibleUnits,
                  regularUnits: remainingUnits,
                  bundleUnitPrice: discountedUnit
                };
              }
            }
          }
        }
      }
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
            bestLineTotalVnd = v.quantity !== undefined ? fsPrice * (Number(v.quantity) || 1) : undefined;
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
        ...(bestLineTotalVnd !== undefined ? { lineTotalVnd: bestLineTotalVnd } : {}),
        originalPriceVnd: v.originalPriceVnd || v.priceVnd,
        promotion
      };
    });
  }

  /**
   * Báo giá danh mục sản phẩm công khai (context = 'catalog'):
   * Chỉ áp dụng các chương trình giảm giá độc lập (Promotion, Flash Sale),
   * KHÔNG tự ý áp giá gói Combo khi khách hàng chưa thêm sản phẩm chính vào giỏ.
   */
  static async quoteCatalogPrices(client, variants) {
    return PricingEngine.applyPromotions(client, variants, { context: 'catalog' });
  }

  /**
   * Báo giá giỏ hàng (context = 'cart'):
   * Áp dụng Promotion, Flash Sale và Combo giới hạn theo số lượng cặp hợp lệ min(mainQty, accessoryQty).
   */
  static async quoteCartPrices(client, items) {
    const prepared = await PricingEngine.applyPromotions(client, items, { context: 'cart' });
    const subtotalVnd = prepared.reduce(
      (sum, item) => sum + (item.lineTotalVnd !== undefined ? item.lineTotalVnd : item.priceVnd * (Number(item.quantity) || 1)),
      0
    );
    const productSlugs = prepared.map(p => p.productSlug).filter(Boolean);
    return {
      items: prepared,
      subtotalVnd,
      productSlugs
    };
  }

  /**
   * Tính toán toàn diện giá trị đơn hàng (dùng chung cho cả Voucher Quote API và Checkout):
   * - Tính giá từng dòng theo ngữ cảnh 'cart'
   * - Kiểm tra tính hợp lệ và mức giảm của Voucher (kèm chặn chồng lấn Flash Sale)
   * - Tính phí vận chuyển và tổng tiền thanh toán
   */
  static async quoteOrder(client, { items, voucherCode, customerId, lockVoucher = false, city, shippingRates }) {
    const { items: prepared, subtotalVnd, productSlugs } = await PricingEngine.quoteCartPrices(client, items);
    if (!Number.isSafeInteger(subtotalVnd) || subtotalVnd > 2_000_000_000) {
      throw Object.assign(new Error('Giá trị đơn quá lớn.'), { status: 400 });
    }

    let discountVnd = 0;
    let voucher = null;
    if (voucherCode) {
      const marketing = require('../../marketing');
      voucher = await marketing.eligible(client, voucherCode, customerId, subtotalVnd, lockVoucher, { productSlugs });
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
      productSlugs,
      promotionSnapshots: prepared.map(item => ({
        variantId: item.id,
        originalPriceVnd: item.originalPriceVnd,
        finalPriceVnd: item.priceVnd,
        lineTotalVnd: item.lineTotalVnd !== undefined ? item.lineTotalVnd : item.priceVnd * (Number(item.quantity) || 1),
        quantity: item.quantity,
        promotion: item.promotion
      }))
    };
  }

  /**
   * Alias tương thích ngược cho quoteOrder
   */
  static async calculateOrderPricing(client, options) {
    return PricingEngine.quoteOrder(client, { ...options, lockVoucher: options?.lockVoucher ?? true });
  }
}

module.exports = {
  PricingEngine,
  calculateReducedPrice
};
