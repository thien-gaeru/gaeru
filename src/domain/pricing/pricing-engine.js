'use strict';

/**
 * src/domain/pricing/pricing-engine.js
 *
 * Single Source of Truth cho toàn bộ logic định giá đơn hàng và áp dụng khuyến mại tại GAERU:
 * - Khuyến mại biến thể (product_promotions)
 * - Chiến dịch Flash Sale (flash_sales)
 * - Gói sản phẩm / Combo (product_bundles) với phân bổ bậc giá nguyên chính xác (priceAllocations)
 *   và công thức tách phần dư tường minh (quotientUnitPriceVnd * qty + remainderVnd = lineTotalVnd)
 * - Mã giảm giá / Voucher (marketing.js)
 * - Phí vận chuyển theo biểu phí tỉnh/thành (checkout-flow.js) và lựa chọn hãng vận chuyển
 * - Quy trình thống nhất quoteOrder(client, { ..., mode: 'quote' | 'commit' }) kèm snapshot + quoteHash
 */

const { createHash } = require('node:crypto');

const PRICING_RULES_VERSION = 'gaeru-pricing-v2';

function calculateReducedPrice(basePrice, promotion) {
  if (!promotion) return basePrice;
  if (promotion.kind === 'percent') {
    return Math.max(0, basePrice - Math.floor(basePrice * promotion.amount / 100));
  }
  return Math.max(0, basePrice - (promotion.amount || 0));
}

function buildRemainderBreakdown(lineTotalVnd, quantity) {
  const qty = Math.max(1, Number(quantity) || 1);
  const quotientUnitPriceVnd = Math.floor(lineTotalVnd / qty);
  const remainderVnd = lineTotalVnd - (quotientUnitPriceVnd * qty);
  const effectiveDisplayUnitPriceVnd = Math.round(lineTotalVnd / qty);
  return {
    quotientUnitPriceVnd,
    remainderVnd,
    effectiveDisplayUnitPriceVnd,
    exactUnitPrice: remainderVnd === 0
  };
}

function computeCanonicalQuoteHash({
  pricingVersion,
  items,
  city,
  voucherCode,
  subtotalVnd,
  shippingFeeVnd,
  discountVnd,
  totalVnd
}) {
  const canonicalItems = [...(items || [])]
    .map((item) => {
      const qty = Math.max(1, Number(item.quantity) || 1);
      const lineTotalVnd = item.lineTotalVnd !== undefined ? item.lineTotalVnd : item.priceVnd * qty;
      return {
        variantId: String(item.id || item.variantId || ''),
        sku: item.sku || null,
        quantity: qty,
        originalPriceVnd: Number(item.originalPriceVnd ?? item.priceVnd ?? 0),
        effectiveUnitPriceVnd: Number(item.effectiveUnitPriceVnd ?? item.priceVnd ?? 0),
        lineTotalVnd: Number(lineTotalVnd),
        promotionId: item.promotion?.id ? String(item.promotion.id) : null,
        promotionType: item.promotion?.type || null,
        priceAllocations: (item.priceAllocations || []).map((a) => ({
          tierKind: a.tierKind,
          quantity: Number(a.quantity),
          unitPriceVnd: Number(a.unitPriceVnd),
          lineTotalVnd: Number(a.lineTotalVnd),
          discountPercent: Number(a.discountPercent || 0)
        }))
      };
    })
    .sort((a, b) => a.variantId.localeCompare(b.variantId));

  const payload = {
    pricingVersion,
    city: city ? String(city).trim() : null,
    voucherCode: voucherCode ? String(voucherCode).trim().toUpperCase() : null,
    subtotalVnd: Number(subtotalVnd),
    shippingFeeVnd: Number(shippingFeeVnd),
    discountVnd: Number(discountVnd),
    totalVnd: Number(totalVnd),
    items: canonicalItems
  };

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

class PricingEngine {
  /**
   * Áp dụng khuyến mại biến thể, combo và flash sale lên danh sách biến thể được chuẩn bị
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

    const isCatalogContext = options.context === 'catalog';

    return variants.map(v => {
      const originalPriceVnd = v.originalPriceVnd !== undefined ? v.originalPriceVnd : v.priceVnd;
      const qty = Math.max(1, Number(v.quantity) || 1);
      let best = v.priceVnd;
      let bestLineTotalVnd = undefined;
      let promotion = null;
      let priceAllocations = [
        {
          tierKind: 'regular',
          quantity: qty,
          unitPriceVnd: v.priceVnd,
          lineTotalVnd: v.priceVnd * qty,
          discountPercent: 0
        }
      ];

      for (const p of promoRows) {
        if (p.variant_id !== v.id) continue;
        const price = calculateReducedPrice(v.priceVnd, p);
        if (price < best) {
          best = price;
          bestLineTotalVnd = v.quantity !== undefined ? price * qty : undefined;
          const discountPercent = p.kind === 'percent' ? Number(p.amount || 0) : 0;
          priceAllocations = [
            {
              tierKind: p.type === 'flash' ? 'flash' : 'promotion',
              quantity: qty,
              unitPriceVnd: price,
              lineTotalVnd: price * qty,
              discountPercent
            }
          ];
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
      if (bundleRows.length && vSlug && !isCatalogContext) {
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
            const accessoryQty = qty;
            // Số lượng phụ kiện được hưởng ưu đãi combo tối đa là min(mainQty, accessoryQty)
            const eligibleUnits = Math.min(mainQty, accessoryQty);

            if (eligibleUnits > 0) {
              const discountedUnit = Math.max(0, Math.floor(v.priceVnd * (100 - discountPct) / 100));
              const remainingUnits = accessoryQty - eligibleUnits;
              const totalLineVnd = (eligibleUnits * discountedUnit) + (remainingUnits * v.priceVnd);
              const currentBestLineVnd = bestLineTotalVnd !== undefined ? bestLineTotalVnd : (best * accessoryQty);

              if (totalLineVnd < currentBestLineVnd) {
                const effectivePrice = Math.round(totalLineVnd / accessoryQty);
                const bundleAllocations = [
                  {
                    tierKind: 'bundle_discounted',
                    quantity: eligibleUnits,
                    unitPriceVnd: discountedUnit,
                    lineTotalVnd: eligibleUnits * discountedUnit,
                    discountPercent: discountPct
                  }
                ];
                if (remainingUnits > 0) {
                  bundleAllocations.push({
                    tierKind: 'regular',
                    quantity: remainingUnits,
                    unitPriceVnd: v.priceVnd,
                    lineTotalVnd: remainingUnits * v.priceVnd,
                    discountPercent: 0
                  });
                }
                const remainderBreakdown = buildRemainderBreakdown(totalLineVnd, accessoryQty);

                best = effectivePrice;
                bestLineTotalVnd = totalLineVnd;
                priceAllocations = bundleAllocations;
                promotion = {
                  id: b.id,
                  title: bundleTitle,
                  type: 'bundle',
                  discountPercent: discountPct,
                  eligibleUnits,
                  regularUnits: remainingUnits,
                  bundleUnitPrice: discountedUnit,
                  regularUnitPrice: v.priceVnd,
                  priceAllocations: bundleAllocations,
                  remainderBreakdown
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
          const fsLineVnd = fsPrice * qty;
          const currentBestLineVnd = bestLineTotalVnd !== undefined ? bestLineTotalVnd : (best * qty);
          if (fsPrice < best && (isCatalogContext || fsLineVnd < currentBestLineVnd)) {
            best = fsPrice;
            bestLineTotalVnd = v.quantity !== undefined ? fsLineVnd : undefined;
            priceAllocations = [
              {
                tierKind: 'flash',
                quantity: qty,
                unitPriceVnd: fsPrice,
                lineTotalVnd: fsLineVnd,
                discountPercent: Number(fs.discount_percent || 0)
              }
            ];
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

      if (isCatalogContext) {
        return {
          ...v,
          priceVnd: best,
          originalPriceVnd,
          promotion
        };
      }

      const resolvedLineTotalVnd = bestLineTotalVnd !== undefined ? bestLineTotalVnd : best * qty;
      const unitPriceBreakdown = buildRemainderBreakdown(resolvedLineTotalVnd, qty);

      return {
        ...v,
        priceVnd: best,
        effectiveUnitPriceVnd: unitPriceBreakdown.effectiveDisplayUnitPriceVnd,
        lineTotalVnd: resolvedLineTotalVnd,
        originalPriceVnd,
        priceAllocations,
        unitPriceBreakdown,
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
   * Quy trình định giá đơn hàng thống nhất cho cả Báo giá (mode: 'quote') và Đặt hàng (mode: 'commit'):
   * - Tính giá từng dòng theo ngữ cảnh 'cart' với phân bổ bậc giá nguyên (priceAllocations)
   * - Kiểm tra hạn mức subtotal, expectedSubtotalVnd
   * - Xác định phí vận chuyển (từ shippingRates truyền vào hoặc đọc store_settings) & hãng vận chuyển
   * - Kiểm tra và khóa Voucher (lockVoucher mặc định theo mode === 'commit')
   * - Kiểm tra ràng buộc phương thức thanh toán (tổng tiền online >= 1đ, hạn mức COD)
   * - Sinh snapshot chuẩn kèm phiên bản quy tắc (pricingVersion) và mã băm đối soát (quoteHash)
   */
  static async quoteOrder(client, {
    items,
    voucherCode,
    customerId,
    mode = 'quote',
    lockVoucher,
    city,
    shippingRates,
    loadShippingFromDb = false,
    requireSupportedCity = false,
    shippingChoices = false,
    shippingCarrierId,
    paymentMethod,
    codMaxAmountVnd,
    expectedSubtotalVnd,
    expectedShippingFeeVnd,
    expectedQuoteHash
  } = {}) {
    const normalizedMode = mode === 'commit' ? 'commit' : 'quote';
    const isCommit = normalizedMode === 'commit';
    const shouldLockVoucher = lockVoucher !== undefined ? Boolean(lockVoucher) : isCommit;

    const { items: prepared, subtotalVnd, productSlugs } = await PricingEngine.quoteCartPrices(client, items);
    if (!Number.isSafeInteger(subtotalVnd) || subtotalVnd < 0 || subtotalVnd > 2_000_000_000) {
      throw Object.assign(
        new Error(isCommit ? 'Tổng giá trị đơn hàng vượt giới hạn cho phép.' : 'Giá trị đơn quá lớn.'),
        { status: 400 }
      );
    }

    if (expectedSubtotalVnd !== undefined && expectedSubtotalVnd !== subtotalVnd) {
      throw Object.assign(
        new Error('Giá hoặc chương trình đã thay đổi. Tải lại trang để xác nhận giá mới trước khi đặt hàng.'),
        { status: 409 }
      );
    }

    let resolvedShippingRates = shippingRates;
    if (!resolvedShippingRates && (loadShippingFromDb || isCommit)) {
      const shippingResult = await client.query(
        "SELECT setting_value FROM store_settings WHERE setting_key = 'shipping_rates' FOR SHARE"
      );
      resolvedShippingRates = shippingResult.rows[0]?.setting_value || {};
    }

    let shippingFeeVnd = 0;
    if (city && resolvedShippingRates) {
      const checkoutFlow = require('../../../checkout-flow');
      const fee = checkoutFlow.shippingFee(resolvedShippingRates, city);
      if (fee === undefined) {
        if (isCommit || requireSupportedCity) {
          throw Object.assign(
            new Error('Tỉnh/thành phố giao hàng hiện chưa được hỗ trợ hoặc chưa có phí vận chuyển.'),
            { status: 409 }
          );
        }
        shippingFeeVnd = 0;
      } else {
        shippingFeeVnd = fee;
      }
    }

    let shippingSelection = null;
    if (shippingChoices) {
      try {
        shippingSelection = await require('../../shipping-choice').validateSelection(client, shippingCarrierId);
      } catch (err) {
        const connCheck = await client.query('SELECT count(*)::int AS cnt FROM shipping_carrier_connections').catch(() => ({ rows: [] }));
        if (connCheck.rows[0]?.cnt > 0) {
          throw err;
        }
        const allowed = {
          ghn: 'Giao Hàng Nhanh (GHN)',
          ghtk: 'Giao Hàng Tiết Kiệm (GHTK)',
          viettel: 'Viettel Post',
          spx: 'Shopee Express (SPX)'
        };
        if (shippingCarrierId && allowed[shippingCarrierId]) {
          shippingSelection = {
            id: shippingCarrierId,
            name: allowed[shippingCarrierId],
            version: 1
          };
        } else if (shippingCarrierId) {
          throw err;
        }
      }
    }

    if (expectedShippingFeeVnd !== undefined && expectedShippingFeeVnd !== shippingFeeVnd) {
      throw Object.assign(
        new Error('Phí vận chuyển đã thay đổi. Tải lại trang trước khi đặt hàng.'),
        { status: 409 }
      );
    }

    let discountVnd = 0;
    let voucher = null;
    if (voucherCode) {
      const marketing = require('../../marketing');
      voucher = await marketing.eligible(client, voucherCode, customerId, subtotalVnd, shouldLockVoucher, { productSlugs });
      discountVnd = voucher?.discountVnd || 0;
    }

    const totalVnd = subtotalVnd + shippingFeeVnd - discountVnd;
    if (!Number.isSafeInteger(totalVnd) || totalVnd < 0 || totalVnd > 2_000_000_000) {
      throw Object.assign(
        new Error('Tổng giá trị đơn hàng vượt giới hạn cho phép.'),
        { status: 400 }
      );
    }

    if (paymentMethod && paymentMethod !== 'cod' && totalVnd < 1) {
      throw Object.assign(
        new Error('Cổng thanh toán trực tuyến không hỗ trợ đơn hàng có tổng tiền bằng 0.'),
        { status: 400 }
      );
    }

    if (paymentMethod === 'cod' && codMaxAmountVnd && totalVnd > codMaxAmountVnd) {
      throw Object.assign(
        new Error(`Đơn hàng vượt hạn mức thu hộ COD (${new Intl.NumberFormat('vi-VN').format(codMaxAmountVnd)} ₫). Vui lòng chọn phương thức thanh toán trước.`),
        { status: 400 }
      );
    }

    const resolvedVoucherCode = voucher?.voucher?.code || voucher?.code || (voucherCode ? String(voucherCode).trim().toUpperCase() : null);
    const quoteHash = computeCanonicalQuoteHash({
      pricingVersion: PRICING_RULES_VERSION,
      items: prepared,
      city,
      voucherCode: resolvedVoucherCode,
      subtotalVnd,
      shippingFeeVnd,
      discountVnd,
      totalVnd
    });

    if (expectedQuoteHash !== undefined && expectedQuoteHash !== quoteHash) {
      throw Object.assign(
        new Error('Báo giá đơn hàng đã thay đổi. Tải lại trang để xác nhận giá mới trước khi đặt hàng.'),
        { status: 409, code: 'QUOTE_HASH_MISMATCH' }
      );
    }

    const promotionSnapshots = prepared.map(item => ({
      variantId: item.id,
      sku: item.sku || null,
      originalPriceVnd: item.originalPriceVnd,
      finalPriceVnd: item.priceVnd,
      effectiveUnitPriceVnd: item.effectiveUnitPriceVnd ?? item.priceVnd,
      lineTotalVnd: item.lineTotalVnd !== undefined ? item.lineTotalVnd : item.priceVnd * (Number(item.quantity) || 1),
      quantity: item.quantity,
      priceAllocations: item.priceAllocations || [],
      unitPriceBreakdown: item.unitPriceBreakdown || null,
      promotion: item.promotion
    }));

    const snapshot = {
      pricingVersion: PRICING_RULES_VERSION,
      quoteHash,
      mode: normalizedMode,
      subtotalVnd,
      shippingFeeVnd,
      discountVnd,
      totalVnd,
      city: city || null,
      voucherCode: resolvedVoucherCode,
      lines: promotionSnapshots
    };

    return {
      mode: normalizedMode,
      pricingVersion: PRICING_RULES_VERSION,
      quoteHash,
      items: prepared,
      subtotalVnd,
      discountVnd,
      shippingFeeVnd,
      totalVnd,
      voucher,
      shippingSelection,
      productSlugs,
      promotionSnapshots,
      snapshot
    };
  }

  /**
   * Alias tương thích ngược cho quoteOrder ở chế độ commit
   */
  static async calculateOrderPricing(client, options = {}) {
    return PricingEngine.quoteOrder(client, {
      ...options,
      mode: options.mode || 'commit',
      lockVoucher: options?.lockVoucher ?? true
    });
  }
}

module.exports = {
  PricingEngine,
  PRICING_RULES_VERSION,
  calculateReducedPrice,
  buildRemainderBreakdown,
  computeCanonicalQuoteHash
};
