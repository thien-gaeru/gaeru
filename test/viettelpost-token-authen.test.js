'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { viettelAdapter, viettelTokenCache } = require('../src/shipping-adapters');

test.beforeEach(() => {
  viettelTokenCache.clear();
});

test('viettelAdapter.createWaybill with static 1-year JWT token calls createOrder directly', async () => {
  const jwtToken = 'eyJhbGciOiJFUzI1NiJ9.test-jwt-token-1-year';
  const settings = {
    pickupName: 'GAERU Kho Hà Nội',
    pickupAddress: 'Đại Mỗ, Nam Từ Liêm, Hà Nội',
    pickupPhone: '0901234567',
    secret: jwtToken
  };

  const orderData = {
    orderNumber: 'GR-20261107-TEST01',
    customerName: 'Nguyễn Văn A',
    address: '123 Đường Láng',
    city: 'Hà Nội',
    phone: '0987654321',
    items: [{ productName: 'GAERU M3' }],
    subtotalVnd: 840000,
    codAmountVnd: 840000,
    weightGrams: 500
  };

  const calls = [];
  const mockFetcher = async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://partner.viettelpost.vn/v2/order/createOrder') {
      assert.equal(options.headers.Token, jwtToken);
      return {
        ok: true,
        json: async () => ({
          status: 200,
          error: false,
          data: {
            ORDER_NUMBER: 'VT88990011',
            MONEY_TOTAL: 30000
          }
        })
      };
    }
    throw new Error('Unexpected URL: ' + url);
  };

  const result = await viettelAdapter.createWaybill(settings, orderData, { fetcher: mockFetcher });
  assert.equal(result.success, true);
  assert.equal(result.trackingNumber, 'VT88990011');
  assert.equal(result.shippingFeeVnd, 30000);
  assert.equal(calls.length, 1, 'Direct call to createOrder without LoginVTP');
});

test('viettelAdapter.createWaybill with Token Secret automatically exchanges via LoginVTP and retries', async () => {
  const webSecret = '58346742179D84F2E9';
  const exchangedJwt = 'eyJhbGciOiJFUzI1NiJ9.fresh-exchanged-jwt-from-login-vtp';
  const settings = {
    pickupName: 'GAERU Kho Hà Nội',
    pickupAddress: 'Đại Mỗ, Nam Từ Liêm, Hà Nội',
    pickupPhone: '0901234567',
    secret: webSecret
  };

  const orderData = {
    orderNumber: 'GR-20261107-TEST02',
    customerName: 'Trần Thị B',
    address: '456 Lê Lợi',
    city: 'Hồ Chí Minh',
    phone: '0912345678',
    items: [{ productName: 'GAERU Buds' }],
    subtotalVnd: 500000,
    codAmountVnd: 0,
    weightGrams: 300
  };

  const calls = [];
  const mockFetcher = async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://partner.viettelpost.vn/v2/order/createOrder') {
      if (options.headers.Token === webSecret) {
        // First try with raw web secret fails because Viettel Post expects JWT
        return {
          ok: true,
          json: async () => ({
            status: 201,
            error: true,
            message: 'Token invalid',
            data: null
          })
        };
      }
      if (options.headers.Token === exchangedJwt) {
        // Second try with fresh JWT succeeds
        return {
          ok: true,
          json: async () => ({
            status: 200,
            error: false,
            data: {
              ORDER_NUMBER: 'VT99112233',
              MONEY_TOTAL: 25000
            }
          })
        };
      }
    }
    if (url === 'https://partner.viettelpost.vn/v2/user/LoginVTP') {
      const body = JSON.parse(options.body);
      assert.equal(body.token, webSecret);
      return {
        ok: true,
        json: async () => ({
          status: 200,
          error: false,
          data: {
            userId: 8866484,
            token: exchangedJwt,
            expired: Date.now() + 86400000
          }
        })
      };
    }
    throw new Error('Unexpected URL: ' + url);
  };

  const result = await viettelAdapter.createWaybill(settings, orderData, { fetcher: mockFetcher });
  assert.equal(result.success, true);
  assert.equal(result.trackingNumber, 'VT99112233');
  assert.equal(result.shippingFeeVnd, 25000);

  // Expect 3 calls: (1) createOrder with raw secret -> (2) LoginVTP -> (3) createOrder with JWT
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://partner.viettelpost.vn/v2/order/createOrder');
  assert.equal(calls[1].url, 'https://partner.viettelpost.vn/v2/user/LoginVTP');
  assert.equal(calls[2].url, 'https://partner.viettelpost.vn/v2/order/createOrder');
  assert.equal(calls[2].options.headers.Token, exchangedJwt);

  // Subsequent call for tracking should reuse cached JWT token without calling LoginVTP again!
  const trackingCalls = [];
  const mockTrackingFetcher = async (url, options) => {
    trackingCalls.push({ url, options });
    if (url === 'https://partner.viettelpost.vn/v2/order/getTracking') {
      assert.equal(options.headers.Token, exchangedJwt, 'Reuses cached JWT');
      return {
        ok: true,
        json: async () => ({
          status: 200,
          error: false,
          data: [{ DATE: '2026-11-07 10:00:00', ORDER_STATUS: 100, STATUS_NAME: 'Đã nhận đơn' }]
        })
      };
    }
    throw new Error('Unexpected URL: ' + url);
  };

  const tracking = await viettelAdapter.queryTracking(settings, { trackingNumber: 'VT99112233' }, { fetcher: mockTrackingFetcher });
  assert.equal(tracking.success, true);
  assert.equal(tracking.trackingNumber, 'VT99112233');
  assert.equal(trackingCalls.length, 1, 'Only 1 call to getTracking using cached token');
});

test('viettelAdapter rejects missing secret with 400', async () => {
  await assert.rejects(() => viettelAdapter.createWaybill({}, {}), { status: 400 });
  await assert.rejects(() => viettelAdapter.cancelWaybill({}, { trackingNumber: 'VT1' }), { status: 400 });
});


test('viettelAdapter.createWaybill populates ORDER_SERVICE and correct ORDER_PAYMENT for COD freeship', async () => {
  const jwtToken = 'eyJhbGciOiJFUzI1NiJ9.test-jwt';
  const settings = { secret: jwtToken, pickupAddress: 'Thôn 2, Xã Rạng Đông, Tỉnh Ninh Bình' };
  const orderData = {
    orderNumber: 'GR-20261107-COD01',
    customerName: 'Đỗ Thiện',
    address: 'Ở điaa na, Xã Tả Lèng',
    city: 'Lai Châu',
    phone: '0358888536',
    items: [{ productName: 'GAERU K9' }],
    subtotalVnd: 202300,
    codAmountVnd: 202300,
    shippingFeeVnd: 0,
    weightGrams: 500
  };

  let sentPayload = null;
  const mockFetcher = async (url, options) => {
    if (url === 'https://partner.viettelpost.vn/v2/order/createOrder') {
      sentPayload = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          status: 200,
          error: false,
          data: { ORDER_NUMBER: 'VT123456789', MONEY_TOTAL: 33600 }
        })
      };
    }
    throw new Error('Unexpected: ' + url);
  };

  const result = await viettelAdapter.createWaybill(settings, orderData, { fetcher: mockFetcher });
  assert.equal(result.success, true);
  assert.equal(sentPayload.ORDER_SERVICE, 'LCOD', 'Default to LCOD service');
  assert.equal(sentPayload.ORDER_PAYMENT, 3, 'ORDER_PAYMENT must be 3 for COD freeship');
  assert.equal(sentPayload.MONEY_COLLECTION, 202300);
});

test('viettelAdapter.createWaybill automatically falls back to NLP service if itinerary does not support default service', async () => {
  const jwtToken = 'eyJhbGciOiJFUzI1NiJ9.test-jwt';
  const settings = { secret: jwtToken, pickupAddress: 'Thôn 2, Xã Rạng Đông, Tỉnh Ninh Bình' };
  const orderData = {
    orderNumber: 'GR-20261107-FALLBACK',
    customerName: 'Đỗ Thiện',
    address: 'Xã Tả Lèng',
    city: 'Lai Châu',
    phone: '0358888536',
    items: [{ productName: 'GAERU K9' }],
    subtotalVnd: 202300,
    codAmountVnd: 202300,
    shippingFeeVnd: 30000
  };

  let attemptCount = 0;
  let finalServiceUsed = null;
  const mockFetcher = async (url, options) => {
    if (url === 'https://partner.viettelpost.vn/v2/order/createOrder') {
      attemptCount++;
      const payload = JSON.parse(options.body);
      if (payload.ORDER_SERVICE === 'LCOD') {
        return {
          ok: true,
          json: async () => ({
            status: 204,
            error: true,
            message: 'Price does not apply to this itinerary!',
            data: null
          })
        };
      }
      finalServiceUsed = payload.ORDER_SERVICE;
      return {
        ok: true,
        json: async () => ({
          status: 200,
          error: false,
          data: { ORDER_NUMBER: 'VT987654321', MONEY_TOTAL: 34720 }
        })
      };
    }
    if (url === 'https://partner.viettelpost.vn/v2/order/getPriceAllNlp') {
      return {
        ok: true,
        json: async () => ({
          status: 200,
          error: false,
          RESULT: [
            { MA_DV_CHINH: 'NCOD', TEN_DICHVU: 'TMĐT Nhanh thỏa thuận', GIA_CUOC: 34720 }
          ]
        })
      };
    }
    throw new Error('Unexpected: ' + url);
  };

  const result = await viettelAdapter.createWaybill(settings, orderData, { fetcher: mockFetcher });
  assert.equal(result.success, true);
  assert.equal(attemptCount, 2, 'Retried createOrder with viable NLP service');
  assert.equal(finalServiceUsed, 'NCOD', 'Used NCOD from NLP result');
  assert.equal(result.trackingNumber, 'VT987654321');
});
