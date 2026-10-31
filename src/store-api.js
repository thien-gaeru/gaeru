'use strict';

/**
 * src/store-api.js — Bộ điều phối (Router Composer) cho API cửa hàng công khai và quản trị lõi GAERU.
 * Nghiệp vụ chi tiết được phân tách theo miền độc lập:
 *   - src/store/store-schemas.js                 : Lược đồ xác thực Zod & transitions
 *   - src/store/carrier-and-catalog-loader.js    : Điều phối hãng vận chuyển tối ưu & nạp danh mục
 *   - src/store/checkout-payment-routes.js       : Danh mục công khai, Checkout (PricingEngine) & IPN (PaymentService)
 *   - src/store/admin-catalog-customers-routes.js: Adapter mỏng cho CatalogService, Khách hàng & Tổng quan
 *   - src/store/admin-orders-settings-routes.js  : Quản trị Đơn hàng, Đối soát (PaymentService) & Cài đặt
 */

const { Router } = require('express');
const { requireAdmin } = require('./security');
const {
  orderSchema,
  transitions,
  productSchema,
  variantSchema,
  orderUpdateSchema,
  settingsSchema,
  requireUuidParam
} = require('./store/store-schemas');
const { allocateOptimalCarrier, loadProducts, getSettings } = require('./store/carrier-and-catalog-loader');
const { attachPublicAndCheckoutRoutes } = require('./store/checkout-payment-routes');
const { attachAdminCatalogAndCustomerRoutes } = require('./store/admin-catalog-customers-routes');
const { attachAdminOrderAndSettingsRoutes } = require('./store/admin-orders-settings-routes');

function createStoreApi(pool, {
  ordersEnabled = false,
  getOrdersEnabled = null,
  vnpayConfig = null,
  getVnpayConfig = null,
  paymentChannels = null,
  getPaymentChannels = null,
  paymentFetcher = fetch,
  publicBaseUrl = 'https://gaeru.com',
  inventory = null,
  finance = null,
  audit = async () => {},
  shippingChoices = false,
  checkoutAccounts = false,
  config = null,
  misaFetcher = fetch
} = {}) {
  const router = Router();

  router.use(async (req, _res, next) => {
    try {
      req.ordersEnabled = getOrdersEnabled ? await getOrdersEnabled() : ordersEnabled;
      req.vnpayConfig = getVnpayConfig ? await getVnpayConfig() : vnpayConfig;
      req.paymentChannels = getPaymentChannels ? await getPaymentChannels() : paymentChannels;
      req.vnpayCallbackConfig = req.paymentChannels?.callbackConfigs?.vnpay || req.vnpayConfig;
      next();
    } catch (error) {
      next(error);
    }
  });

  attachPublicAndCheckoutRoutes(router, pool, {
    getVnpayConfig,
    getPaymentChannels,
    paymentFetcher,
    publicBaseUrl,
    inventory,
    finance,
    audit,
    shippingChoices,
    checkoutAccounts,
    config
  });

  router.use('/gaeru_ceo', requireAdmin);

  attachAdminCatalogAndCustomerRoutes(router, pool, { inventory, audit });
  attachAdminOrderAndSettingsRoutes(router, pool, {
    inventory,
    finance,
    audit,
    shippingChoices,
    checkoutAccounts,
    config,
    paymentFetcher,
    misaFetcher
  });

  return router;
}

module.exports = {
  createStoreApi,
  loadProducts,
  allocateOptimalCarrier,
  getSettings,
  transitions,
  orderSchema,
  productSchema,
  variantSchema,
  orderUpdateSchema,
  settingsSchema,
  requireUuidParam
};
