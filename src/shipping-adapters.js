const jtVietnam = require('./jt-vietnam');
const carrierResponse = require('./carrier-response');

const CARRIER_NAMES = Object.freeze({
  viettel: 'Viettel Post',
  jt: 'J&T Express',
  spx: 'Shopee Express (SPX)'
});

function fail(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

function stripVietnameseAccents(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/\b(?:tinh|thanh pho|tp\.?|tp)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const VIETTEL_PROVINCE_IDS = Object.freeze({
  'ha noi': 1,
  'ho chi minh': 2,
  'hcm': 2,
  'sai gon': 2,
  'hai phong': 3,
  'da nang': 4,
  'can tho': 5,
  'an giang': 6,
  'ba ria vung tau': 7,
  'vung tau': 7,
  'bac giang': 8,
  'bac kan': 9,
  'bac lieu': 10,
  'bac ninh': 11,
  'ben tre': 12,
  'binh dinh': 13,
  'binh duong': 14,
  'binh phuoc': 15,
  'binh thuan': 16,
  'ca mau': 17,
  'cao bang': 18,
  'dak lak': 19,
  'dak nong': 20,
  'dien bien': 21,
  'dong nai': 22,
  'dong thap': 23,
  'gia lai': 24,
  'ha giang': 25,
  'ha nam': 26,
  'ha tinh': 27,
  'hai duong': 28,
  'hau giang': 29,
  'hoa binh': 30,
  'hung yen': 31,
  'khanh hoa': 32,
  'kien giang': 33,
  'kon tum': 34,
  'lai chau': 35,
  'lam dong': 36,
  'lang son': 37,
  'lao cai': 38,
  'long an': 39,
  'nam dinh': 40,
  'nghe an': 41,
  'ninh binh': 42,
  'ninh thuan': 43,
  'phu tho': 44,
  'phu yen': 45,
  'quang binh': 46,
  'quang nam': 47,
  'quang ngai': 48,
  'quang ninh': 49,
  'quang tri': 50,
  'soc trang': 51,
  'son la': 52,
  'tay ninh': 53,
  'thai binh': 54,
  'thai nguyen': 55,
  'thanh hoa': 56,
  'thua thien hue': 57,
  'hue': 57,
  'tien giang': 58,
  'tra vinh': 59,
  'tuyen quang': 60,
  'vinh long': 61,
  'vinh phuc': 62,
  'yen bai': 63
});

function resolveViettelProvinceId(city) {
  const key = stripVietnameseAccents(city);
  if (!key) return 1;
  if (VIETTEL_PROVINCE_IDS[key]) return VIETTEL_PROVINCE_IDS[key];
  for (const [name, id] of Object.entries(VIETTEL_PROVINCE_IDS)) {
    if (key.includes(name) || name.includes(key)) return id;
  }
  return 1;
}

function estimateItemWeightGrams(item) {
  if (Number(item?.weightGrams) > 0) return Math.round(Number(item.weightGrams));
  const text = `${item?.sku || ''} ${item?.productName || ''} ${item?.variantName || ''}`.toLowerCase();
  if (/2m1|tripod|chan\b/.test(text)) return 850;
  if (/p01|gimbal/.test(text)) return 450;
  if (/g1|ultra|m3/.test(text)) return 320;
  if (/k9/.test(text)) return 250;
  return 300;
}

function computeCarrierShipmentPricing(orderData = {}, settings = {}) {
  const subtotalVnd = Math.max(0, Number(orderData.subtotalVnd ?? orderData.subtotal_vnd) || 0);
  const discountVnd = Math.max(0, Number(orderData.discountVnd ?? orderData.discount_vnd) || 0);
  const productPayableVnd = Math.max(0, subtotalVnd - discountVnd);
  const webShippingFeeVnd = Math.max(0, Number(orderData.shippingFeeVnd ?? orderData.shipping_fee_vnd) || 0);

  let weightGrams = Number(orderData.weightGrams);
  if (!Number.isFinite(weightGrams) || weightGrams <= 0) {
    const items = Array.isArray(orderData.items) ? orderData.items : [];
    const computed = items.reduce((sum, item) => {
      const qty = Math.max(1, Number(item?.quantity) || 1);
      const unitWeight = Number(item?.weightGrams) > 0
        ? Math.round(Number(item.weightGrams))
        : (Number(settings?.defaultItemWeightGrams) > 0 ? Math.round(Number(settings.defaultItemWeightGrams)) : estimateItemWeightGrams(item));
      return sum + qty * unitWeight;
    }, 0);
    weightGrams = Math.min(50000, Math.max(100, computed || 500));
  } else {
    weightGrams = Math.min(50000, Math.max(1, Math.round(weightGrams)));
  }

  const explicitCod = (orderData.codAmountVnd ?? orderData.cod_amount_vnd) !== undefined && (orderData.codAmountVnd ?? orderData.cod_amount_vnd) !== null
    ? Math.max(0, Math.round(Number(orderData.codAmountVnd ?? orderData.cod_amount_vnd) || 0))
    : null;
  const effectivePaymentMethod = orderData.paymentMethod ?? orderData.payment_method;
  const effectivePaymentStatus = orderData.paymentStatus ?? orderData.payment_status;
  const effectiveTotalVnd = orderData.totalVnd ?? orderData.total_vnd;
  const isCod = explicitCod !== null
    ? explicitCod > 0
    : (effectivePaymentMethod === 'cod' && effectivePaymentStatus !== 'paid');

  // Khi đơn web đã cộng sẵn shippingFeeVnd vào totalVnd (hoặc shop freeship), người gửi (GAERU) thanh toán cước cho hãng
  // để hãng chỉ thu đúng số tiền khách chốt trên website (tránh ORDER_PAYMENT=2 cộng trùng cước lần 2).
  const requestedPayer = orderData.feePayer || settings?.feePayer || 'sender';
  const feePayer = (requestedPayer === 'receiver' && webShippingFeeVnd === 0) ? 'receiver' : 'sender';

  let carrierCodCollectionVnd = 0;
  if (isCod) {
    if (feePayer === 'receiver') {
      carrierCodCollectionVnd = productPayableVnd;
    } else if (explicitCod !== null) {
      carrierCodCollectionVnd = explicitCod;
    } else if (effectiveTotalVnd !== undefined && effectiveTotalVnd !== null) {
      carrierCodCollectionVnd = Math.max(0, Math.round(Number(effectiveTotalVnd) || 0));
    } else {
      carrierCodCollectionVnd = productPayableVnd + webShippingFeeVnd;
    }
  }

  // Viettel Post ORDER_PAYMENT:
  // 1: Không thu tiền (người gửi trả cước)
  // 2: Thu hộ tiền hàng + cước hãng (người nhận trả thêm cước hãng ngoài MONEY_COLLECTION)
  // 3: Thu hộ đúng MONEY_COLLECTION, người gửi trả cước cho hãng (chuẩn TMĐT khi cước web đã tính trong MONEY_COLLECTION hoặc freeship)
  // 4: Không thu hộ tiền hàng, người nhận tự trả cước hãng
  const viettelOrderPayment = isCod
    ? (feePayer === 'receiver' ? 2 : 3)
    : (feePayer === 'receiver' ? 4 : 1);

  return {
    productPayableVnd,
    webShippingFeeVnd,
    feePayer,
    isCod,
    carrierCodCollectionVnd,
    viettelOrderPayment,
    weightGrams,
    receiverProvinceId: resolveViettelProvinceId(orderData.city)
  };
}

function normalizeCarrierStatus(carrierId, rawStatus) {
  const s = String(rawStatus ?? '').toLowerCase().trim();
  if (carrierId === 'viettel' && /^-?\d+$/.test(s)) {
    if (s === '501') return 'delivered';
    if (['107', '503'].includes(s)) return 'cancelled';
    if (s === '504') return 'returned';
    if (s === '502') return 'returning';
    if (s === '505') return 'return_requested';
    if (['105', '200', '202', '300', '320', '400', '500'].includes(s)) return 'delivering';
    if (['100', '102', '103', '104'].includes(s)) return 'picking';
    return 'pending';
  }
  if (['delivered', 'hoanthanh', 'dagiao', 'thanh_cong'].includes(s)) {
    return 'delivered';
  }
  if (['cancel', 'huy', 'huy_don', 'deleted', 'closed'].some(k => s.includes(k))) {
    return 'cancelled';
  }
  if (['return_requested', 'cho_chuyen_hoan', 'cho_xu_ly_hoan', 'cho_hoan'].includes(s)) {
    return 'return_requested';
  }
  if (['returning', 'returning_to_sender', 'dang_hoan', 'chuyen_hoan_ve_buu_cuc'].includes(s)) {
    return 'returning';
  }
  if (['return', 'tra_hang', 'chuyen_hoan', 'that_bai', 'failed', 'refused', 'returned_to_sender'].some(k => s.includes(k))) {
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

async function getViettelActiveToken(settings, { fetcher = fetch, forceRefresh = false } = {}) {
  const secret = settings?.secret?.trim();
  if (!secret) throw fail('Cần lưu API Token của Viettel Post.', 400);

  if (secret.startsWith('eyJ')) {
    return secret;
  }

  if (!forceRefresh) {
    const cached = viettelTokenCache.get(secret);
    if (cached && cached.expiresAt > Date.now() + 60000) {
      return cached.token;
    }
  }

  const loginUrl = 'https://partner.viettelpost.vn/v2/user/LoginVTP';
  let loginRes;
  try {
    loginRes = await fetcher(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token: secret }),
      signal: AbortSignal.timeout(10000),
      redirect: 'error'
    });
  } catch (err) {
    throw fail('Không thể kết nối máy chủ xác thực Viettel Post (LoginVTP). Kiểm tra mạng hoặc thử lại.', 502);
  }

  if (!loginRes.ok) {
    throw fail('Viettel Post từ chối kết nối LoginVTP (mã HTTP ' + loginRes.status + '). Kiểm tra token bí mật và thử lại.', 502);
  }

  let loginData;
  try {
    const raw = typeof loginRes.text === 'function' ? await loginRes.text() : await loginRes.json();
    loginData = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_e) {
    throw fail('Phản hồi từ Viettel Post LoginVTP không đúng định dạng JSON.', 502);
  }

  if (!carrierResponse.succeeded('viettel', loginData) || !loginData.data?.token) {
    const detail = loginData?.message || (loginData?.status ? `Mã phản hồi ${loginData.status}` : 'Mã token bí mật không hợp lệ');
    throw fail('Xác thực Viettel Post qua viettelpost.vn thất bại: ' + detail, 502);
  }

  const jwtToken = loginData.data.token;
  const expiresAt = Number(loginData.data.expired) || (Date.now() + 24 * 60 * 60 * 1000);
  viettelTokenCache.set(secret, { token: jwtToken, expiresAt });
  return jwtToken;
}

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

  const isInvalidToken = parsed && (parsed.status === 201 || parsed.status === 203 || parsed.status === 204 || (typeof parsed.message === 'string' && /token\s*invalid/i.test(parsed.message)));
  if (isInvalidToken && !secret.startsWith('eyJ')) {
    try {
      const loginUrl = 'https://partner.viettelpost.vn/v2/user/LoginVTP';
      const loginRes = await fetcher(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ token: secret }),
        signal: AbortSignal.timeout(10000),
        redirect: 'error'
      });
      if (loginRes.ok) {
        const raw = typeof loginRes.text === 'function' ? await loginRes.text() : await loginRes.json();
        const loginData = typeof raw === 'string' ? JSON.parse(raw) : raw;
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
    const pricing = computeCarrierShipmentPricing(orderData, settings);
    const { isCod, viettelOrderPayment: orderPayment, carrierCodCollectionVnd, weightGrams, receiverProvinceId, productPayableVnd } = pricing;
    let serviceCode = orderData.carrierServiceCode || settings.defaultService || 'LCOD';

    const buildPayload = (srv) => ({
      ORDER_NUMBER: orderData.orderNumber,
      ORDER_SERVICE: srv,
      SENDER_FULLNAME: settings.pickupName || 'GAERU Store',
      SENDER_ADDRESS: settings.pickupAddress || 'Đại Mỗ, Nam Từ Liêm, Hà Nội',
      SENDER_PHONE: settings.pickupPhone || '0900000000',
      RECEIVER_FULLNAME: orderData.customerName,
      RECEIVER_ADDRESS: `${orderData.address}, ${orderData.city}`,
      RECEIVER_PROVINCE: receiverProvinceId,
      RECEIVER_PHONE: orderData.phone,
      PRODUCT_NAME: (orderData.items || []).map(i => i.productName).join(', ') || 'Thiết bị GAERU',
      PRODUCT_PRICE: productPayableVnd,
      PRODUCT_WEIGHT: weightGrams,
      PRODUCT_TYPE: 'HH',
      ORDER_PAYMENT: orderPayment,
      MONEY_COLLECTION: isCod ? carrierCodCollectionVnd : 0,
      TYPE: 1
    });

    let { res } = await executeViettelRequest(settings, async (token) => {
      const resp = await fetcher(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Token': token
        },
        body: JSON.stringify(buildPayload(serviceCode)),
        signal: AbortSignal.timeout(15000),
        redirect: 'error'
      });
      if (!resp.ok) throw fail(`Viettel Post từ chối kết nối (HTTP ${resp.status}).`, 502);
      const data = await resp.json();
      return { response: resp, parsed: data };
    }, { fetcher });

    // Tự động fallback dịch vụ nếu Viettel Post báo lỗi dịch vụ không áp dụng cho hành trình này
    const isServiceMismatch = res && (
      res.status === 204 ||
      (typeof res.message === 'string' && /ORDER_SERVICE|itinerary|dịch vụ/i.test(res.message))
    );

    if (isServiceMismatch) {
      try {
        const nlpUrl = 'https://partner.viettelpost.vn/v2/order/getPriceAllNlp';
        const { res: nlpRes } = await executeViettelRequest(settings, async (token) => {
          const resp = await fetcher(nlpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Token': token },
            body: JSON.stringify({
              SENDER_ADDRESS: settings.pickupAddress || 'Hà Nội',
              RECEIVER_ADDRESS: `${orderData.address}, ${orderData.city}`,
              RECEIVER_PROVINCE: receiverProvinceId,
              PRODUCT_TYPE: 'HH',
              PRODUCT_WEIGHT: weightGrams,
              PRODUCT_PRICE: productPayableVnd,
              MONEY_COLLECTION: isCod ? carrierCodCollectionVnd : 0,
              PRODUCT_LENGTH: 0,
              PRODUCT_WIDTH: 0,
              PRODUCT_HEIGHT: 0,
              TYPE: 1
            }),
            signal: AbortSignal.timeout(8000),
            redirect: 'error'
          });
          if (!resp.ok) throw fail('Không thể kiểm tra dịch vụ NLP Viettel Post.', 502);
          const parsedData = await resp.json();
          return { response: resp, parsed: parsedData };
        }, { fetcher });

        const extractServices = d => Array.isArray(d) ? d : (Array.isArray(d?.RESULT) ? d.RESULT : (Array.isArray(d?.data) ? d.data : []));
        const services = extractServices(nlpRes);
        const viableService = services.find(s => s.MA_DV_CHINH && s.MA_DV_CHINH !== serviceCode) || services[0];
        if (viableService?.MA_DV_CHINH) {
          serviceCode = viableService.MA_DV_CHINH;
          const retryResult = await executeViettelRequest(settings, async (token) => {
            const resp = await fetcher(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Token': token },
              body: JSON.stringify(buildPayload(serviceCode)),
              signal: AbortSignal.timeout(15000),
              redirect: 'error'
            });
            if (!resp.ok) throw fail(`Viettel Post từ chối kết nối thử lại (HTTP ${resp.status}).`, 502);
            const data = await resp.json();
            return { response: resp, parsed: data };
          }, { fetcher });
          res = retryResult.res;
        }
      } catch (_err) {
        // Giữ nguyên phản hồi lỗi ban đầu của Viettel Post nếu không fallback được
      }
    }

    const isSuccess = carrierResponse.succeeded('viettel', res);
    if (!isSuccess) {
      const err = fail(`Viettel Post báo lỗi tạo vận đơn: ${res?.message || 'Lỗi tạo đơn'}`, 502);
      err.isCarrierRejected = true;
      err.rawResponse = res;
      throw err;
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
      if (!resp.ok) {
        throw fail(`Viettel Post hủy đơn thất bại (HTTP ${resp.status}).`, 502);
      }
      const data = await resp.json();
      return { response: resp, parsed: data };
    }, { fetcher });

    const isTokenError = Boolean(
      res && (
        res.status === 201 ||
        res.status === 203 ||
        res.status === 204 ||
        (typeof res.message === 'string' && /token\s*invalid/i.test(res.message))
      )
    );
    const isAlreadyCancelled = Boolean(
      res &&
      !isTokenError &&
      typeof res.message === 'string' &&
      /^(?:đơn hàng|vận đơn)\s*đã\s*(?:được\s*)?hủy[!.]?$/i.test(res.message.trim())
    );
    if (!carrierResponse.succeeded('viettel', res) && !isAlreadyCancelled) throw fail(`Viettel Post từ chối hủy: ${res?.message || 'Lỗi'}`, 502);
    return { success: true, cancelled: true, message: isAlreadyCancelled ? 'Đơn hàng đã được xác nhận hủy trên hệ thống Viettel Post.' : 'Đã hủy vận đơn Viettel Post thành công.' };
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
      if (!resp.ok) {
        if (resp.status === 405 || resp.status === 404) {
          throw fail(`Cổng API Viettel Post tạm thời không hỗ trợ tra cứu trực tiếp qua REST (HTTP ${resp.status}). Vui lòng bấm 'Tra cứu trên cổng hãng ↗' để xem chi tiết hành trình.`, 502);
        }
        throw fail(`Viettel Post tra cứu thất bại (HTTP ${resp.status}).`, 502);
      }
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

  async quoteShippingFee(settings, { city, district, address, weightGrams = 500, totalVnd = 0, codAmountVnd = 0 }, { fetcher = fetch } = {}) {
    const url = 'https://partner.viettelpost.vn/v2/order/getPriceAllNlp';
    const receiverAddress = [address, district, city].filter(Boolean).join(', ') || 'Hà Nội';
    const receiverProvince = resolveViettelProvinceId(city);
    const { res } = await executeViettelRequest(settings, async (token) => {
      const resp = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Token': token },
        body: JSON.stringify({
          SENDER_ADDRESS: settings.pickupAddress || 'Hà Nội',
          RECEIVER_ADDRESS: receiverAddress,
          RECEIVER_PROVINCE: receiverProvince,
          PRODUCT_TYPE: 'HH',
          PRODUCT_WEIGHT: Math.max(1, Math.round(Number(weightGrams) || 500)),
          PRODUCT_PRICE: Math.max(0, Math.round(Number(totalVnd) || 0)),
          MONEY_COLLECTION: Math.max(0, Math.round(Number(codAmountVnd) || 0)),
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

    const extractServices = d => Array.isArray(d) ? d : (Array.isArray(d?.RESULT) ? d.RESULT : (Array.isArray(d?.data) ? d.data : []));
    const rows = extractServices(res);
    if (!rows.length && !carrierResponse.succeeded('viettel', res)) throw fail('Viettel Post chưa xác nhận báo giá.', 502);
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
// 3. SPX (Shopee Express) Adapter
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
  resolveViettelProvinceId,
  computeCarrierShipmentPricing,
  getAdapter,
  adapters,
  jtAdapter,
  viettelAdapter,
  spxAdapter,
  viettelTokenCache,
  getViettelActiveToken,
  executeViettelRequest
};
