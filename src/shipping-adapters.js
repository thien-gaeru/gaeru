const jtVietnam = require('./jt-vietnam');
const carrierResponse = require('./carrier-response');

const CARRIER_NAMES = Object.freeze({
  ghn: 'GHN (Giao Hàng Nhanh)',
  ghtk: 'GHTK (Giao Hàng Tiết Kiệm)',
  viettel: 'Viettel Post',
  jt: 'J&T Express',
  spx: 'Shopee Express (SPX)'
});

function fail(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

function normalizeCarrierStatus(carrierId, rawStatus) {
  const s = String(rawStatus || '').toLowerCase().trim();
  if (['delivered', 'hoanthanh', 'dagiao', 'thanh_cong'].includes(s)) {
    return 'delivered';
  }
  if (['cancel', 'huy', 'huy_don', 'deleted', 'closed'].some(k => s.includes(k))) {
    return 'cancelled';
  }
  if (['return', 'tra_hang', 'chuyen_hoan', 'that_bai', 'failed', 'refused'].some(k => s.includes(k))) {
    return 'returned';
  }
  if (['delivering', 'transport', 'shipping', 'danggiao', 'dang_giao', 'xuat_kho', 'luanchuyen', 'on_delivery'].some(k => s.includes(k))) {
    return 'delivering';
  }
  if (['picking', 'waiting_pick', 'cho_lay', 'lay_hang', 'da_tiep_nhan', 'ready_to_pick', 'pickup'].some(k => s.includes(k))) {
    return 'picking';
  }
  return 'pending';
}

// -----------------------------------------------------------------------------
// 1. J&T Express Adapter (VIP / OpenAPI)
// -----------------------------------------------------------------------------
const jtAdapter = {
  createDigest: jtVietnam.headerDigest,

  async createWaybill(settings, orderData, options = {}) {
    const identity = jtVietnam.businessIdentity(settings);
    const sender = jtVietnam.address({ name: settings.pickupName, mobile: settings.pickupPhone,
      address: settings.pickupAddress, prov: settings.pickupProvince, area: settings.pickupArea }, 'người gửi');
    const receiver = jtVietnam.address(orderData.receiver, 'người nhận');
    const txlogisticId = jtVietnam.text(orderData.orderNumber, 'mã đơn hàng', 100);
    if (!['PP_PM', 'PP_CASH', 'CC_CASH'].includes(settings.payType) || ![1, 6].includes(settings.serviceType)) {
      throw jtVietnam.fail('Chọn phương thức trả cước và hình thức lấy hàng J&T trước khi tạo vận đơn.', 409);
    }
    const weight = Number(orderData.weightGrams) / 1000;
    const goodsValue = Number(orderData.subtotalVnd);
    const codMoney = Number(orderData.codAmountVnd);
    if (!Number.isFinite(weight) || weight < 0.01 || weight > 999 || !Number.isSafeInteger(goodsValue) || goodsValue < 0 || goodsValue > 30000000 || !Number.isSafeInteger(codMoney) || codMoney < 0) {
      throw jtVietnam.fail('Kiểm tra cân nặng, giá trị hàng hóa và tiền thu hộ J&T; chưa gửi yêu cầu.', 400);
    }
    if (!Array.isArray(orderData.items) || !orderData.items.length) throw jtVietnam.fail('J&T cần danh sách hàng hóa thực tế.', 400);
    const items = orderData.items.map(item => {
      const quantity = Number(item.quantity), price = Number(item.priceVnd);
      if (!Number.isSafeInteger(quantity) || quantity < 1 || !Number.isSafeInteger(price) || price < 0) throw jtVietnam.fail('Thông tin hàng hóa J&T chưa hợp lệ.', 400);
      const itemName = jtVietnam.text([item.productName, item.variantName].filter(Boolean).join(' - '), 'tên hàng hóa', 100);
      return { itemName, englishName: itemName, number: String(quantity), itemValue: String(price) };
    });
    const business = { ...identity, txlogisticId, orderType: 1, selfAddress: 0, serviceType: settings.serviceType,
      payType: settings.payType, productType: 'EXPRESS', goodsType: 'bm000010', deliveryType: 1,
      sender, receiver, items, packageInfo: { weight: String(weight) }, isInsured: 0, goodsValue,
      codMoney: String(codMoney), ...(orderData.note ? { remark: jtVietnam.text(orderData.note, 'ghi chú', 200) } : {}) };
    const response = await jtVietnam.request(settings, 'create', business, options);
    jtVietnam.assertOrderEcho(response.data, txlogisticId, { required: true });
    const trackingNumber = carrierResponse.trackingNumber(response.data?.billCode, 'jt');
    const fees = [response.data.inquiryFee, response.data.codFee, response.data.insuranceFee];
    const amounts = fees.map(value => carrierResponse.fee(value));
    const total = amounts.every(value => value !== null) ? amounts.reduce((sum, value) => sum + value, 0) : null;
    const shippingFeeVnd = total === null ? null : carrierResponse.fee(total);
    // Printing is a signed POST operation. Never fabricate an unauthenticated URL.
    return { success: true, carrierId: 'jt', carrierName: CARRIER_NAMES.jt, trackingNumber,
      carrierOrderId: txlogisticId, shippingFeeVnd, estimatedDelivery: null, labelUrl: null,
      rawResponse: { code: response.code, data: { billCode: trackingNumber, txlogisticId, inquiryFee: amounts[0], codFee: amounts[1], insuranceFee: amounts[2] } } };
  },

  async cancelWaybill(settings, { trackingNumber, carrierOrderId, reason = 'Chủ shop hủy' }, options = {}) {
    const txlogisticId = jtVietnam.text(carrierOrderId, 'mã đơn hàng của shop', 100);
    const billCode = carrierResponse.trackingNumber(trackingNumber, 'jt');
    const response = await jtVietnam.request(settings, 'cancel', { ...jtVietnam.businessIdentity(settings), txlogisticId,
      billCode, reason: jtVietnam.text(reason, 'lý do hủy', 200) }, options);
    jtVietnam.assertOrderEcho(response.data, txlogisticId, { required: true });
    if (response.data.billCode !== undefined && String(response.data.billCode) !== billCode) throw jtVietnam.fail('J&T trả mã vận đơn hủy khác yêu cầu. Đối soát tại hãng.', 502, { ambiguous: true });
    return { success: true, cancelled: true, message: 'J&T đã xác nhận hủy đúng mã đơn.' };
  },

  async queryTracking(settings, { trackingNumber, carrierOrderId }, options = {}) {
    const billCodes = carrierResponse.trackingNumber(trackingNumber, 'jt');
    const business = { ...jtVietnam.businessIdentity(settings), billCodes,
      txlogisticId: carrierOrderId ? jtVietnam.text(carrierOrderId, 'mã đơn hàng', 100) : '' };
    const response = await jtVietnam.request(settings, 'tracking', business, options);
    const row = Array.isArray(response.data) ? response.data.find(item => String(item?.billCode) === billCodes) : null;
    if (!row || !Array.isArray(row.details)) throw jtVietnam.fail('J&T chưa trả hành trình khớp mã vận đơn được hỏi.', 502);
    const details = row.details.filter(item => item && typeof item === 'object').sort((a, b) => String(b.scanTime || '').localeCompare(String(a.scanTime || '')));
    const latest = details[0] || {};
    // VN sample uses 100/94 while the same portal FAQ uses 113/112. Until the
    // contracted status map is accepted, show raw data without auto-settling COD.
    return { success: true, carrierId: 'jt', trackingNumber: billCodes, carrierStatusRaw: String(latest.scanTypeCode ?? ''),
      status: 'pending', statusMappingVerified: false, statusDescription: String(latest.desc || latest.scanTypeName || 'Chưa có hành trình'),
      history: details.map(item => ({ timestamp: item.scanTime || null, status: 'pending', rawStatus: String(item.scanTypeCode ?? ''),
        location: String(item.scanNetworkName || ''), description: String(item.desc || item.scanTypeName || '') })) };
  },

  async quoteShippingFee(settings, orderData, options = {}) {
    const identity = jtVietnam.businessIdentity(settings);
    const sender = jtVietnam.address({ name: settings.pickupName, mobile: settings.pickupPhone,
      address: settings.pickupAddress, prov: settings.pickupProvince, area: settings.pickupArea }, 'người gửi');
    const receiver = jtVietnam.address(orderData.receiver, 'người nhận');
    const weight = Number(orderData.weightGrams) / 1000;
    const goodsValue = Number(orderData.totalVnd), codMoney = Number(orderData.codAmountVnd ?? 0);
    if (!Number.isFinite(weight) || weight < 0.01 || weight > 999 || !Number.isSafeInteger(goodsValue) || goodsValue < 0 || goodsValue > 30000000 || !Number.isSafeInteger(codMoney) || codMoney < 0) throw jtVietnam.fail('Thông tin kiện hàng báo giá J&T chưa hợp lệ.', 400);
    const location = ({ prov, city, area }) => ({ prov, ...(city ? { city } : {}), area });
    const response = await jtVietnam.request(settings, 'quote', { ...identity, weight, selfAddress: 0, isInsured: 0,
      productType: 'EXPRESS', goodsType: 'bm000010', goodsValue, codMoney: String(codMoney),
      sender: location(sender), receiver: location(receiver) }, options);
    const fees = [response.data?.price, response.data?.codFee, response.data?.insuranceFee].map(value => carrierResponse.fee(value, { required: true }));
    return { success: true, carrierId: 'jt', carrierName: CARRIER_NAMES.jt,
      feeVnd: carrierResponse.fee(fees.reduce((sum, value) => sum + value, 0), { required: true }),
      estimatedDays: null, carrierService: 'J&T EXPRESS' };
  }
};

// -----------------------------------------------------------------------------
// 2. Viettel Post Adapter
// -----------------------------------------------------------------------------
const viettelTokenCache = new Map();

async function executeViettelRequest(settings, buildRequestFn, { fetcher = fetch } = {}) {
  const secret = settings?.secret?.trim();
  if (!secret) throw fail('Cần lưu API Token của Viettel Post.', 400);

  let activeToken = secret;
  if (!secret.startsWith('eyJ')) {
    const cached = viettelTokenCache.get(secret);
    if (cached && cached.expiresAt > Date.now() + 60000) {
      activeToken = cached.token;
    }
  }

  let { response, parsed } = await buildRequestFn(activeToken);

  const isInvalidToken = parsed && (parsed.status === 201 || parsed.status === 203 || (typeof parsed.message === 'string' && /token\s*invalid/i.test(parsed.message)));
  if (isInvalidToken && !secret.startsWith('eyJ')) {
    try {
      const loginUrl = 'https://partner.viettelpost.vn/v2/user/LoginVTP';
      const loginRes = await fetcher(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: secret }),
        signal: AbortSignal.timeout(10000),
        redirect: 'error'
      });
      if (loginRes.ok) {
        const loginData = await loginRes.json();
        if (carrierResponse.succeeded('viettel', loginData) && loginData.data?.token) {
          const jwtToken = loginData.data.token;
          const expiresAt = Number(loginData.data.expired) || (Date.now() + 24 * 60 * 60 * 1000);
          viettelTokenCache.set(secret, { token: jwtToken, expiresAt });
          const retry = await buildRequestFn(jwtToken);
          response = retry.response;
          parsed = retry.parsed;
        }
      }
    } catch (_err) {
      // Preserve original parsed response if login endpoint or mock fetcher does not support LoginVTP
    }
  }

  return { response, res: parsed };
}
const viettelAdapter = {
  async createWaybill(settings, orderData, { fetcher = fetch } = {}) {
    if (!settings.secret) throw fail('Cần lưu API Token của Viettel Post.', 400);
    const url = 'https://partner.viettelpost.vn/v2/order/createOrder';
    const payload = {
      ORDER_NUMBER: orderData.orderNumber,
      SENDER_FULLNAME: settings.pickupName || 'GAERU Store',
      SENDER_ADDRESS: settings.pickupAddress || 'Đại Mỗ, Nam Từ Liêm, Hà Nội',
      SENDER_PHONE: settings.pickupPhone || '0900000000',
      RECEIVER_FULLNAME: orderData.customerName,
      RECEIVER_ADDRESS: `${orderData.address}, ${orderData.city}`,
      RECEIVER_PHONE: orderData.phone,
      PRODUCT_NAME: (orderData.items || []).map(i => i.productName).join(', ') || 'Thiết bị GAERU',
      PRODUCT_PRICE: Number(orderData.subtotalVnd) || 0,
      PRODUCT_WEIGHT: Number(orderData.weightGrams) || 500,
      PRODUCT_TYPE: 'HH',
      ORDER_PAYMENT: orderData.codAmountVnd > 0 ? 2 : 1,
      MONEY_COLLECTION: Number(orderData.codAmountVnd) || 0,
      TYPE: 1
    };

    const { res } = await executeViettelRequest(settings, async (token) => {
      const resp = await fetcher(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Token': token
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
        redirect: 'error'
      });
      if (!resp.ok) throw fail(`Viettel Post từ chối kết nối (HTTP ${resp.status}).`, 502);
      const data = await resp.json();
      return { response: resp, parsed: data };
    }, { fetcher });

    const isSuccess = carrierResponse.succeeded('viettel', res);
    if (!isSuccess) {
      throw fail(`Viettel Post báo lỗi tạo vận đơn: ${res.message || 'Lỗi tạo đơn'}`, 502);
    }

    const trackingNumber = carrierResponse.trackingNumber(res.data?.ORDER_NUMBER, 'viettel');
    const feeVnd = carrierResponse.fee(res.data?.MONEY_TOTAL);
    const labelUrl = `https://partner.viettelpost.vn/v2/print?orderNumber=${encodeURIComponent(trackingNumber)}`;

    return {
      success: true,
      carrierId: 'viettel',
      carrierName: CARRIER_NAMES.viettel,
      trackingNumber,
      carrierOrderId: orderData.orderNumber,
      shippingFeeVnd: feeVnd,
      estimatedDelivery: null,
      labelUrl,
      rawResponse: res
    };
  },

  async cancelWaybill(settings, { trackingNumber }, { fetcher = fetch } = {}) {
    if (!settings.secret) throw fail('Cần API Token Viettel Post.', 400);
    const url = 'https://partner.viettelpost.vn/v2/order/UpdateOrder';
    const { res } = await executeViettelRequest(settings, async (token) => {
      const resp = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Token': token },
        body: JSON.stringify({ TYPE: 4, ORDER_NUMBER: trackingNumber }),
        signal: AbortSignal.timeout(12000),
        redirect: 'error'
      });
      if (!resp.ok) throw fail(`Viettel Post hủy đơn thất bại (HTTP ${resp.status}).`, 502);
      const data = await resp.json();
      return { response: resp, parsed: data };
    }, { fetcher });

    if (!carrierResponse.succeeded('viettel', res)) throw fail(`Viettel Post từ chối hủy: ${res.message || 'Lỗi'}`, 502);
    return { success: true, cancelled: true, message: 'Đã hủy vận đơn Viettel Post thành công.' };
  },

  async queryTracking(settings, { trackingNumber }, { fetcher = fetch } = {}) {
    const url = 'https://partner.viettelpost.vn/v2/order/getTracking';
    const { res } = await executeViettelRequest(settings, async (token) => {
      const resp = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Token': token },
        body: JSON.stringify({ ORDER_NUMBER: trackingNumber }),
        signal: AbortSignal.timeout(12000),
        redirect: 'error'
      });
      if (!resp.ok) throw fail(`Viettel Post tra cứu thất bại (HTTP ${resp.status}).`, 502);
      const data = await resp.json();
      return { response: resp, parsed: data };
    }, { fetcher });

    if (!carrierResponse.succeeded('viettel', res)) throw fail('Viettel Post chưa xác nhận kết quả tra cứu.', 502);
    const data = Array.isArray(res.data) ? res.data : [];
    const latest = data[data.length - 1] || {};
    const rawStatus = latest.ORDER_STATUS || res.status_name || 'pending';

    return {
      success: true,
      carrierId: 'viettel',
      trackingNumber,
      carrierStatusRaw: String(rawStatus),
      status: normalizeCarrierStatus('viettel', rawStatus),
      statusDescription: latest.STATUS_NAME || 'Đang cập nhật hành trình',
      history: data.map(d => ({
        timestamp: d.DATE || new Date().toISOString(),
        status: normalizeCarrierStatus('viettel', d.ORDER_STATUS),
        rawStatus: String(d.ORDER_STATUS),
        location: d.LOCATION || '',
        description: d.STATUS_NAME || ''
      }))
    };
  },

  async quoteShippingFee(settings, { city, weightGrams = 500 }, { fetcher = fetch } = {}) {
    const url = 'https://partner.viettelpost.vn/v2/order/getPriceAllNlp';
    const { res } = await executeViettelRequest(settings, async (token) => {
      const resp = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Token': token },
        body: JSON.stringify({
          SENDER_ADDRESS: settings.pickupAddress || 'Hà Nội',
          RECEIVER_ADDRESS: city || 'Hà Nội',
          RECEIVER_PROVINCE: 1,
          PRODUCT_TYPE: 'HH',
          PRODUCT_WEIGHT: Number(weightGrams) || 500,
          PRODUCT_PRICE: 0,
          MONEY_COLLECTION: 0,
          PRODUCT_LENGTH: 0,
          PRODUCT_WIDTH: 0,
          PRODUCT_HEIGHT: 0,
          TYPE: 1
        }),
        signal: AbortSignal.timeout(8000),
        redirect: 'error'
      });
      if (!resp.ok) throw fail('Viettel Post không phản hồi cước phí.', 502);
      const data = await resp.json();
      return { response: resp, parsed: data };
    }, { fetcher });

    if (!Array.isArray(res) && !carrierResponse.succeeded('viettel', res)) throw fail('Viettel Post chưa xác nhận báo giá.', 502);
    const rows = Array.isArray(res) ? res : res.data || [];
    const best = rows.find(r => r.GIA_CUOC > 0) || rows[0];
    const feeVnd = carrierResponse.fee(best?.GIA_CUOC, { required: true });
    return {
      success: true,
      carrierId: 'viettel',
      carrierName: CARRIER_NAMES.viettel,
      feeVnd,
      estimatedDays: 2,
      carrierService: best?.TEN_DICHVU || 'Chuyển phát nhanh Viettel Post'
    };
  }
};

// -----------------------------------------------------------------------------
// 3. GHN (Giao Hàng Nhanh) Adapter
// -----------------------------------------------------------------------------
const ghnAdapter = {
  async createWaybill(settings, orderData, { fetcher = fetch } = {}) {
    if (!settings.secret || !settings.accountId) throw fail('Cần Shop ID và Token GHN.', 400);
    const url = 'https://online-gateway.ghn.vn/shiip/public-api/v2/shipping-order/create';
    const payload = {
      client_order_code: orderData.orderNumber,
      to_name: orderData.customerName,
      to_phone: orderData.phone,
      to_address: orderData.address,
      cod_amount: Number(orderData.codAmountVnd) || 0,
      weight: Number(orderData.weightGrams) || 500,
      payment_type_id: orderData.codAmountVnd > 0 ? 2 : 1,
      required_note: 'CHOXEMHANGKHONGTHU',
      items: (orderData.items || []).map(i => ({
        name: i.productName || 'Sản phẩm GAERU',
        quantity: Number(i.quantity) || 1,
        price: Number(i.priceVnd) || 0,
        weight: 200
      }))
    };

    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Token': settings.secret,
        'ShopId': String(settings.accountId)
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
      redirect: 'error'
    });

    if (!response.ok) throw fail(`GHN từ chối kết nối (HTTP ${response.status}).`, 502);
    const res = await response.json();
    if (res.code !== 200 || !res.data?.order_code) {
      throw fail(`GHN báo lỗi tạo đơn: ${res.message || 'Lỗi GHN'}`, 502);
    }

    const trackingNumber = String(res.data.order_code);
    const feeVnd = carrierResponse.fee(res.data.total_fee);
    const labelUrl = `https://online-gateway.ghn.vn/a5/public-api/printA5?token=${encodeURIComponent(trackingNumber)}`;

    return {
      success: true,
      carrierId: 'ghn',
      carrierName: CARRIER_NAMES.ghn,
      trackingNumber,
      carrierOrderId: trackingNumber,
      shippingFeeVnd: feeVnd,
      estimatedDelivery: res.data.expected_delivery_time || null,
      labelUrl,
      rawResponse: res
    };
  },

  async cancelWaybill(settings, { trackingNumber }, { fetcher = fetch } = {}) {
    const url = 'https://online-gateway.ghn.vn/shiip/public-api/v2/switch-status/cancel';
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Token': settings.secret,
        'ShopId': String(settings.accountId)
      },
      body: JSON.stringify({ order_codes: [trackingNumber] }),
      signal: AbortSignal.timeout(12000),
      redirect: 'error'
    });
    if (!response.ok) throw fail(`GHN hủy đơn thất bại (HTTP ${response.status}).`, 502);
    const res = await response.json();
    if (!carrierResponse.succeeded('ghn', res) || !Array.isArray(res.data) || !res.data.some(row => row.order_code === trackingNumber && row.result === true)) throw fail('GHN chưa xác nhận hủy đúng mã vận đơn.', 502);
    return { success: true, cancelled: true, message: 'Đã hủy vận đơn GHN thành công.' };
  },

  async queryTracking(settings, { trackingNumber }, { fetcher = fetch } = {}) {
    const url = 'https://online-gateway.ghn.vn/shiip/public-api/v2/shipping-order/detail';
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Token': settings.secret },
      body: JSON.stringify({ order_code: trackingNumber }),
      signal: AbortSignal.timeout(12000),
      redirect: 'error'
    });
    if (!response.ok) throw fail(`GHN tra cứu thất bại (HTTP ${response.status}).`, 502);
    const res = await response.json();
    if (!carrierResponse.succeeded('ghn', res)) throw fail('GHN chưa xác nhận kết quả tra cứu.', 502);
    const rawStatus = res.data?.status || 'pending';
    const log = Array.isArray(res.data?.log) ? res.data.log : [];

    return {
      success: true,
      carrierId: 'ghn',
      trackingNumber,
      carrierStatusRaw: rawStatus,
      status: normalizeCarrierStatus('ghn', rawStatus),
      statusDescription: res.data?.status_name || rawStatus,
      history: log.map(l => ({
        timestamp: l.updated_date || new Date().toISOString(),
        status: normalizeCarrierStatus('ghn', l.status),
        rawStatus: l.status,
        location: '',
        description: l.status_name || ''
      }))
    };
  },

  async quoteShippingFee(settings, { weightGrams = 500 }, { fetcher = fetch } = {}) {
    const url = 'https://online-gateway.ghn.vn/shiip/public-api/v2/shipping-order/fee';
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Token': settings.secret,
        'ShopId': String(settings.accountId)
      },
      body: JSON.stringify({
        weight: Number(weightGrams) || 500,
        service_type_id: 2
      }),
      signal: AbortSignal.timeout(8000),
      redirect: 'error'
    });
    if (!response.ok) throw fail('GHN không phản hồi cước phí.', 502);
    const res = await response.json();
    if (!carrierResponse.succeeded('ghn', res)) throw fail('GHN chưa xác nhận báo giá.', 502);
    const feeVnd = carrierResponse.fee(res.data?.total, { required: true });
    return {
      success: true,
      carrierId: 'ghn',
      carrierName: CARRIER_NAMES.ghn,
      feeVnd,
      estimatedDays: 2,
      carrierService: 'GHN Chuẩn'
    };
  }
};

// -----------------------------------------------------------------------------
// 4. GHTK (Giao Hàng Tiết Kiệm) Adapter
// -----------------------------------------------------------------------------
const ghtkAdapter = {
  async createWaybill(settings, orderData, { fetcher = fetch } = {}) {
    if (!settings.secret) throw fail('Cần Token GHTK.', 400);
    const url = 'https://services.giaohangtietkiem.vn/services/shipment/order';
    const headers = { 'Content-Type': 'application/json', 'Token': settings.secret };
    if (settings.partnerCode) headers['X-Client-Source'] = settings.partnerCode;

    const payload = {
      order: {
        id: orderData.orderNumber,
        pick_name: settings.pickupName || 'GAERU Store',
        pick_address: settings.pickupAddress || 'Hà Nội',
        pick_tel: settings.pickupPhone || '0900000000',
        name: orderData.customerName,
        address: orderData.address,
        province: orderData.city,
        tel: orderData.phone,
        is_freeship: orderData.codAmountVnd > 0 ? 0 : 1,
        pick_money: Number(orderData.codAmountVnd) || 0,
        value: Number(orderData.subtotalVnd) || 0
      },
      products: (orderData.items || []).map(i => ({
        name: i.productName || 'Sản phẩm',
        weight: 0.2,
        quantity: Number(i.quantity) || 1
      }))
    };

    const response = await fetcher(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
      redirect: 'error'
    });
    if (!response.ok) throw fail(`GHTK từ chối kết nối (HTTP ${response.status}).`, 502);
    const res = await response.json();
    if (res.success !== true || !res.order?.label) {
      throw fail(`GHTK báo lỗi tạo đơn: ${res.message || 'Lỗi GHTK'}`, 502);
    }

    const trackingNumber = String(res.order.label);
    const feeVnd = carrierResponse.fee(res.order.fee);
    const labelUrl = `https://services.giaohangtietkiem.vn/services/label/${encodeURIComponent(trackingNumber)}`;

    return {
      success: true,
      carrierId: 'ghtk',
      carrierName: CARRIER_NAMES.ghtk,
      trackingNumber,
      carrierOrderId: res.order.tracking_id || orderData.orderNumber,
      shippingFeeVnd: feeVnd,
      estimatedDelivery: res.order.estimated_deliver_time || null,
      labelUrl,
      rawResponse: res
    };
  },

  async cancelWaybill(settings, { trackingNumber }, { fetcher = fetch } = {}) {
    const url = `https://services.giaohangtietkiem.vn/services/shipment/cancel/${encodeURIComponent(trackingNumber)}`;
    const headers = { 'Token': settings.secret };
    if (settings.partnerCode) headers['X-Client-Source'] = settings.partnerCode;

    const response = await fetcher(url, { method: 'POST', headers, signal: AbortSignal.timeout(12000), redirect: 'error' });
    if (!response.ok) throw fail(`GHTK hủy đơn thất bại (HTTP ${response.status}).`, 502);
    const res = await response.json();
    if (res.success !== true) throw fail(`GHTK từ chối hủy: ${res.message || 'Lỗi'}`, 502);
    return { success: true, cancelled: true, message: 'Đã hủy vận đơn GHTK thành công.' };
  },

  async queryTracking(settings, { trackingNumber }, { fetcher = fetch } = {}) {
    const url = `https://services.giaohangtietkiem.vn/services/shipment/v2/${encodeURIComponent(trackingNumber)}`;
    const headers = { 'Token': settings.secret };
    if (settings.partnerCode) headers['X-Client-Source'] = settings.partnerCode;

    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(12000), redirect: 'error' });
    if (!response.ok) throw fail(`GHTK tra cứu thất bại (HTTP ${response.status}).`, 502);
    const res = await response.json();
    if (!carrierResponse.succeeded('ghtk', res)) throw fail('GHTK chưa xác nhận kết quả tra cứu.', 502);
    const order = res.order || {};
    const rawStatus = String(order.status_text || order.status || 'pending');

    return {
      success: true,
      carrierId: 'ghtk',
      trackingNumber,
      carrierStatusRaw: rawStatus,
      status: normalizeCarrierStatus('ghtk', rawStatus),
      statusDescription: order.status_text || 'Đang vận chuyển',
      history: []
    };
  },

  async quoteShippingFee(settings, { city, weightGrams = 500 }, { fetcher = fetch } = {}) {
    const url = `https://services.giaohangtietkiem.vn/services/shipment/fee?pick_province=${encodeURIComponent('Hà Nội')}&province=${encodeURIComponent(city || 'Hà Nội')}&weight=${weightGrams}`;
    const headers = { 'Token': settings.secret };
    if (settings.partnerCode) headers['X-Client-Source'] = settings.partnerCode;

    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!response.ok) throw fail('GHTK không phản hồi cước phí.', 502);
    const res = await response.json();
    if (!carrierResponse.succeeded('ghtk', res)) throw fail('GHTK chưa xác nhận báo giá.', 502);
    const feeVnd = carrierResponse.fee(res.fee?.fee, { required: true });
    return {
      success: true,
      carrierId: 'ghtk',
      carrierName: CARRIER_NAMES.ghtk,
      feeVnd,
      estimatedDays: 2,
      carrierService: 'GHTK Chuẩn'
    };
  }
};

// -----------------------------------------------------------------------------
// 5. SPX (Shopee Express) Adapter
// -----------------------------------------------------------------------------
const spxAdapter = {
  async createWaybill(settings, orderData, { fetcher = fetch } = {}) {
    if (!settings.secret || !settings.accountId) throw fail('Cần Shop ID và Token SPX.', 400);
    const url = 'https://spx.vn/api/v2/fleet_order/create';
    const headers = { 'Content-Type': 'application/json', 'Token': settings.secret };
    if (settings.partnerCode) headers['X-Client-Source'] = settings.partnerCode;

    const payload = {
      shop_id: settings.accountId,
      order_id: orderData.orderNumber,
      recipient: {
        name: orderData.customerName,
        phone: orderData.phone,
        address: orderData.address,
        city: orderData.city
      },
      cod_amount: Number(orderData.codAmountVnd) || 0,
      weight: Number(orderData.weightGrams) || 500
    };

    const response = await fetcher(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw fail(`SPX từ chối kết nối (HTTP ${response.status}).`, 502);
    const res = await response.json();
    const ok = carrierResponse.succeeded('spx', res);
    if (!ok) throw fail(`SPX báo lỗi tạo đơn: ${res.message || 'Lỗi SPX'}`, 502);

    const trackingNumber = carrierResponse.trackingNumber(res.data?.tracking_number ?? res.tracking_number, 'spx');
    const feeVnd = carrierResponse.fee(res.data?.fee);
    const labelUrl = `https://spx.vn/api/v2/fleet_order/print?tracking_number=${encodeURIComponent(trackingNumber)}`;

    return {
      success: true,
      carrierId: 'spx',
      carrierName: CARRIER_NAMES.spx,
      trackingNumber,
      carrierOrderId: orderData.orderNumber,
      shippingFeeVnd: feeVnd,
      estimatedDelivery: null,
      labelUrl,
      rawResponse: res
    };
  },

  async cancelWaybill(settings, { trackingNumber }, { fetcher = fetch } = {}) {
    const url = 'https://spx.vn/api/v2/fleet_order/cancel';
    const headers = { 'Content-Type': 'application/json', 'Token': settings.secret };
    if (settings.partnerCode) headers['X-Client-Source'] = settings.partnerCode;

    const response = await fetcher(url, { method: 'POST', headers, body: JSON.stringify({ tracking_number: trackingNumber, shop_id: settings.accountId }), signal: AbortSignal.timeout(12000), redirect: 'error' });
    if (!response.ok) throw fail(`SPX hủy đơn thất bại (HTTP ${response.status}).`, 502);
    const res = await response.json();
    if (!carrierResponse.succeeded('spx', res)) throw fail('SPX chưa xác nhận hủy vận đơn.', 502);
    return { success: true, cancelled: true, message: 'Đã hủy vận đơn SPX thành công.' };
  },

  async queryTracking(settings, { trackingNumber }, { fetcher = fetch } = {}) {
    const url = `https://spx.vn/api/v2/fleet_order/tracking/open_api?shop_id=${encodeURIComponent(settings.accountId)}&tracking_number=${encodeURIComponent(trackingNumber)}`;
    const headers = { 'Token': settings.secret };
    if (settings.partnerCode) headers['X-Client-Source'] = settings.partnerCode;

    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(12000), redirect: 'error' });
    if (!response.ok) throw fail(`SPX tra cứu thất bại (HTTP ${response.status}).`, 502);
    const res = await response.json();
    if (!carrierResponse.succeeded('spx', res)) throw fail('SPX chưa xác nhận kết quả tra cứu.', 502);
    const rawStatus = res.data?.status || 'pending';

    return {
      success: true,
      carrierId: 'spx',
      trackingNumber,
      carrierStatusRaw: rawStatus,
      status: normalizeCarrierStatus('spx', rawStatus),
      statusDescription: res.data?.status_description || rawStatus,
      history: []
    };
  },

  async quoteShippingFee() {
    throw fail('Chưa tích hợp API báo giá SPX; sử dụng bảng phí niêm yết của website.', 501);
  }
};

const adapters = {
  jt: jtAdapter,
  viettel: viettelAdapter,
  ghn: ghnAdapter,
  ghtk: ghtkAdapter,
  spx: spxAdapter
};

function getAdapter(carrierId) {
  const adapter = adapters[carrierId];
  if (!adapter) throw fail(`Chưa hỗ trợ adapter cho hãng vận chuyển: ${carrierId}`, 400);
  return adapter;
}

module.exports = {
  CARRIER_NAMES,
  normalizeCarrierStatus,
  getAdapter,
  adapters,
  jtAdapter,
  viettelAdapter,
  ghnAdapter,
  ghtkAdapter,
  spxAdapter,
  viettelTokenCache
};
