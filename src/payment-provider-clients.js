'use strict';
const { createHmac, randomUUID, timingSafeEqual } = require('node:crypto');
const momoProtocol = require('./momo-protocol');

// Provider contracts: MoMo wallet/onetime + payment-api/query; Zalopay
// specs/order-create + specs/order-query. No caller-supplied endpoint is used.
const PROVIDERS = Object.freeze({
  momo: {
    name: 'MoMo',
    sandbox: 'https://test-payment.momo.vn',
    production: 'https://payment.momo.vn',
    create: '/v2/gateway/api/create',
    query: '/v2/gateway/api/query',
    refund: '/v2/gateway/api/refund',
    refundQuery: '/v2/gateway/api/refund/query',
    paymentHosts: { sandbox: ['test-payment.momo.vn'], production: ['payment.momo.vn'] }
  },
  zalopay: {
    name: 'ZaloPay',
    sandbox: 'https://sb-openapi.zalopay.vn',
    production: 'https://openapi.zalopay.vn',
    create: '/v2/create', query: '/v2/query',
    paymentHosts: { sandbox: ['qcgateway.zalopay.vn', 'sbgateway.zalopay.vn'], production: ['gateway.zalopay.vn'] }
  }
});
const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 35000; // MoMo specifies a minimum 30 second client timeout; 35s gives 5s TLS/network margin.
const MAX_TIMEOUT_MS = 60000;
const MOMO_DEFAULT_EXPIRE_MINUTES = 15;
const hmac = (key, value) => createHmac('sha256', key).update(value, 'utf8').digest('hex');
function fail(provider, code, { status = 502, ambiguous = false, upstreamStatus } = {}) {
  const name = PROVIDERS[provider]?.name || 'thanh toán';
  return Object.assign(new Error(status === 400
    ? 'Thông tin tạo yêu cầu ' + name + ' không hợp lệ.'
    : 'Chưa nhận được kết quả hợp lệ từ ' + name + '. Vui lòng kiểm tra trạng thái giao dịch trước khi thử lại.'),
  { status, code, provider, ambiguous, ...(upstreamStatus ? { upstreamStatus } : {}) });
}
function validText(value, min, max) {
  return typeof value === 'string' && value.length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function credentials(provider, settings) {
  const meta = PROVIDERS[provider];
  if (!['momo', 'zalopay'].includes(provider) || !meta || !settings || !['sandbox', 'production'].includes(settings.environment)) throw fail(provider, 'PAYMENT_CONFIGURATION_INVALID', { status: 400 });
  if (provider === 'momo') {
    if (!validText(settings.partnerCode, 2, 50) || !/^[A-Za-z0-9_-]+$/.test(settings.partnerCode)
      || !validText(settings.accessKey, 2, 160) || !/^[A-Za-z0-9_-]+$/.test(settings.accessKey)
      || !validText(settings.secretKey, 8, 500)
      || (settings.requestType !== undefined && !momoProtocol.REQUEST_TYPES.includes(settings.requestType))) throw fail(provider, 'PAYMENT_CONFIGURATION_INVALID', { status: 400 });
  } else if (!/^[1-9]\d{0,9}$/.test(String(settings.appId || '')) || Number(settings.appId) > 2147483647
    || !validText(settings.key1, 8, 500) || !validText(settings.key2, 8, 500)) {
    throw fail(provider, 'PAYMENT_CONFIGURATION_INVALID', { status: 400 });
  }
  return meta;
}
function timestamp(value) {
  const time = value instanceof Date ? value.getTime() : typeof value === 'function' ? value() : value ?? Date.now();
  if (!Number.isSafeInteger(time) || time <= 0 || Number.isNaN(new Date(time).getTime())) throw fail('', 'PAYMENT_REQUEST_INVALID', { status: 400 });
  return time;
}
function vietnamDate(time) {
  return new Date(time + 7 * 60 * 60 * 1000).toISOString().slice(2, 10).replaceAll('-', '');
}
function validReference(value, max) {
  const alphanumeric = char => (char >= '0' && char <= '9') || (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z');
  return validText(value, 1, max) && alphanumeric(value[0]) && alphanumeric(value[value.length - 1]) && !/[^A-Za-z0-9._-]/.test(value);
}
function reference(provider, txnRef, time, requestId) {
  if (!validReference(txnRef, 50)) throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
  const id = requestId ?? (provider === 'zalopay' ? vietnamDate(time) + '_' + txnRef : txnRef);
  if (!validReference(id, provider === 'zalopay' ? 40 : 50)
    || (provider === 'zalopay' && (!/^\d{6}_/.test(id) || id.slice(7) !== txnRef))) throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
  return id;
}
function publicOrigin(provider, value) {
  let url;
  try { url = new URL(value); } catch { throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 }); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
  return url.origin;
}
function paymentUrl(provider, environment, value) {
  let url;
  try { url = new URL(value); } catch { throw fail(provider, 'PAYMENT_RESPONSE_INVALID', { ambiguous: true }); }
  if (!validText(value, 1, 8192) || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || !PROVIDERS[provider].paymentHosts[environment].includes(url.hostname)) throw fail(provider, 'PAYMENT_RESPONSE_INVALID', { ambiguous: true });
  return url.toString();
}
async function readJson(provider, response) {
  if (!response || response.redirected || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
    throw fail(provider, 'PAYMENT_HTTP_ERROR', { ambiguous: true, upstreamStatus: response?.status });
  }
  const advertised = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(advertised) && advertised > MAX_RESPONSE_BYTES) throw fail(provider, 'PAYMENT_RESPONSE_TOO_LARGE', { ambiguous: true });
  const chunks = [];
  let size = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          void reader.cancel().catch(() => {});
          throw fail(provider, 'PAYMENT_RESPONSE_TOO_LARGE', { ambiguous: true });
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
  } else if (typeof response.text === 'function') {
    const text = await response.text();
    size = Buffer.byteLength(text);
    if (size > MAX_RESPONSE_BYTES) throw fail(provider, 'PAYMENT_RESPONSE_TOO_LARGE', { ambiguous: true });
    chunks.push(Buffer.from(text));
  } else throw fail(provider, 'PAYMENT_RESPONSE_INVALID', { ambiguous: true });
  let data;
  try { data = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw fail(provider, 'PAYMENT_RESPONSE_INVALID', { ambiguous: true }); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail(provider, 'PAYMENT_RESPONSE_INVALID', { ambiguous: true });
  return data;
}
async function post(provider, settings, operation, body, options) {
  const meta = PROVIDERS[provider];
  const fetcher = options.fetcher || fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  if (typeof fetcher !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(fail(provider, 'PAYMENT_TIMEOUT', { ambiguous: true }));
  }, timeoutMs); });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetcher(meta[settings.environment] + meta[operation], {
        method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body), signal: controller.signal
      });
      return readJson(provider, response);
    })()]);
  } catch (error) {
    if (error?.provider === provider && /^PAYMENT_[A-Z_]+$/.test(error.code)) throw error;
    throw fail(provider, controller.signal.aborted ? 'PAYMENT_TIMEOUT' : 'PAYMENT_NETWORK_ERROR', { ambiguous: true });
  } finally { clearTimeout(timer); }
}
function equalHex(value, expected) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) return false;
  return timingSafeEqual(Buffer.from(value.toLowerCase(), 'hex'), Buffer.from(expected, 'hex'));
}
function safeTransactionId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  return /^[A-Za-z0-9_.:-]{1,100}$/.test(String(value ?? '')) ? String(value) : null;
}
function cleanOptionalString(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return trimmed.length ? trimmed.slice(0, max) : null;
}
function sanitizeMomoItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return undefined;
  const usedIds = new Set();
  const out = [];
  for (let i = 0; i < rawItems.length && out.length < 50; i++) {
    const item = rawItems[i];
    if (!item || typeof item !== 'object') continue;
    const price = Number(item.price);
    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(price) || price < 0 || !Number.isSafeInteger(quantity) || quantity < 1) continue;
    const name = cleanOptionalString(item.name, 200);
    if (!name) continue;
    let id = cleanOptionalString(String(item.id ?? ''), 80) || `ITEM-${i + 1}`;
    if (usedIds.has(id)) {
      let suffix = i + 1;
      while (usedIds.has(`${id}-${suffix}`)) suffix++;
      id = `${id.slice(0, 70)}-${suffix}`;
    }
    usedIds.add(id);
    const totalPrice = Number.isSafeInteger(Number(item.totalPrice)) && Number(item.totalPrice) >= 0
      ? Number(item.totalPrice)
      : price * quantity;
    const entry = { id, name, price, currency: 'VND', quantity, totalPrice };
    const manufacturer = cleanOptionalString(item.manufacturer, 100);
    if (manufacturer) entry.manufacturer = manufacturer;
    const category = cleanOptionalString(item.category, 100);
    if (category) entry.category = category;
    const description = cleanOptionalString(item.description, 255);
    if (description) entry.description = description;
    const unit = cleanOptionalString(item.unit, 50);
    if (unit) entry.unit = unit;
    if (typeof item.imageUrl === 'string') {
      try {
        const parsedImg = new URL(item.imageUrl);
        if (parsedImg.protocol === 'https:') entry.imageUrl = parsedImg.toString().slice(0, 500);
      } catch {}
    }
    out.push(entry);
  }
  return out.length ? out : undefined;
}
function sanitizeMomoDeliveryInfo(info) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return undefined;
  const out = {};
  const deliveryAddress = cleanOptionalString(info.deliveryAddress, 300);
  if (deliveryAddress) out.deliveryAddress = deliveryAddress;
  if (info.deliveryFee !== undefined && info.deliveryFee !== null && info.deliveryFee !== '') {
    const fee = cleanOptionalString(String(info.deliveryFee), 30);
    if (fee && /^\d+$/.test(fee)) out.deliveryFee = fee;
  }
  if (info.quantity !== undefined && info.quantity !== null && info.quantity !== '') {
    const qty = cleanOptionalString(String(info.quantity), 20);
    if (qty && /^\d+$/.test(qty)) out.quantity = qty;
  }
  return Object.keys(out).length ? out : undefined;
}
function sanitizeMomoUserInfo(info) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return undefined;
  const out = {};
  const name = cleanOptionalString(info.name, 120);
  if (name) out.name = name;
  const phoneNumber = cleanOptionalString(info.phoneNumber, 30);
  if (phoneNumber) out.phoneNumber = phoneNumber;
  const email = cleanOptionalString(info.email, 254);
  if (email) out.email = email;
  return Object.keys(out).length ? out : undefined;
}
function extractMomoReconciliationMeta(data) {
  if (!data || typeof data !== 'object') return {};
  const payType = cleanOptionalString(data.payType, 64);
  const paymentOption = cleanOptionalString(data.paymentOption, 64);
  const rawFee = data.userFee;
  const userFee = (typeof rawFee === 'number' || (typeof rawFee === 'string' && /^\d+$/.test(rawFee)))
    && Number.isSafeInteger(Number(rawFee)) && Number(rawFee) >= 0
    ? Number(rawFee)
    : null;
  let promotionInfo = null;
  if (Array.isArray(data.promotionInfo) && data.promotionInfo.length > 0) {
    const promos = [];
    for (const p of data.promotionInfo.slice(0, 20)) {
      if (!p || typeof p !== 'object') continue;
      promos.push({
        voucherId: cleanOptionalString(String(p.voucherId ?? ''), 120),
        voucherName: cleanOptionalString(String(p.voucherName ?? ''), 200),
        voucherType: cleanOptionalString(String(p.voucherType ?? ''), 60),
        amount: Number.isSafeInteger(Number(p.amount)) && Number(p.amount) >= 0 ? Number(p.amount) : null,
        amountSponsor: Number.isSafeInteger(Number(p.amountSponsor)) && Number(p.amountSponsor) >= 0 ? Number(p.amountSponsor) : null,
        merchantRate: cleanOptionalString(String(p.merchantRate ?? ''), 40)
      });
    }
    if (promos.length) promotionInfo = promos;
  }
  return {
    ...(payType ? { payType } : {}),
    ...(paymentOption ? { paymentOption } : {}),
    ...(userFee !== null ? { userFee } : {}),
    ...(promotionInfo ? { promotionInfo } : {})
  };
}

async function createGatewayPayment(provider, settings, options = {}) {
  credentials(provider, settings);
  const time = timestamp(options.now);
  const requestId = reference(provider, options.txnRef, time, options.requestId);
  const amount = options.amountVnd;
  if (!Number.isSafeInteger(amount) || amount < (provider === 'momo' ? momoProtocol.MIN_AMOUNT : 1) || amount > (provider === 'momo' ? momoProtocol.MAX_AMOUNT : 2000000000)) throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
  const baseUrl = publicOrigin(provider, options.baseUrl);
  let body;
  if (provider === 'momo') {
    if (options.requestType !== undefined && !momoProtocol.REQUEST_TYPES.includes(options.requestType)) throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
    const requestType = momoProtocol.normalizeRequestType(options.requestType ?? settings.requestType);
    const expireMinutes = options.orderExpireTime === undefined ? MOMO_DEFAULT_EXPIRE_MINUTES : options.orderExpireTime;
    if (!Number.isInteger(expireMinutes) || expireMinutes < 1 || expireMinutes > 1440) throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
    body = { partnerCode: settings.partnerCode, requestId, orderId: options.txnRef, amount,
      orderInfo: 'Thanh toan don hang ' + options.txnRef,
      redirectUrl: baseUrl + '/api/payments/momo/return', ipnUrl: baseUrl + '/api/payments/momo/ipn',
      requestType, extraData: '', autoCapture: true, orderExpireTime: expireMinutes, lang: 'vi' };
    const storeName = cleanOptionalString(options.storeName, 100);
    if (storeName) body.storeName = storeName;
    const storeId = cleanOptionalString(options.storeId, 50);
    if (storeId) body.storeId = storeId;
    const items = sanitizeMomoItems(options.items);
    if (items) body.items = items;
    if (requestType === 'captureWallet') {
      const deliveryInfo = sanitizeMomoDeliveryInfo(options.deliveryInfo);
      if (deliveryInfo) body.deliveryInfo = deliveryInfo;
    }
    const userInfo = sanitizeMomoUserInfo(options.userInfo);
    if (userInfo) body.userInfo = userInfo;
    body.signature = hmac(settings.secretKey, `accessKey=${settings.accessKey}&amount=${amount}&extraData=&ipnUrl=${body.ipnUrl}&orderId=${body.orderId}&orderInfo=${body.orderInfo}&partnerCode=${body.partnerCode}&redirectUrl=${body.redirectUrl}&requestId=${requestId}&requestType=${requestType}`);
  } else {
    body = { app_id: Number(settings.appId), app_user: 'gaeru', app_trans_id: requestId, app_time: time,
      expire_duration_seconds: 900, amount, description: 'Thanh toan don hang ' + options.txnRef,
      callback_url: baseUrl + '/api/payments/zalopay/ipn', item: '[]',
      embed_data: JSON.stringify({ redirecturl: baseUrl + '/api/payments/zalopay/return', orderNumber: options.txnRef }), bank_code: '' };
    body.mac = hmac(settings.key1, `${body.app_id}|${requestId}|gaeru|${amount}|${time}|${body.embed_data}|[]`);
  }
  const data = await post(provider, settings, 'create', body, options);
  if (provider === 'momo') {
    if (!Number.isInteger(data.resultCode)) throw fail(provider, 'PAYMENT_RESPONSE_INVALID', { ambiguous: true });
    if (data.resultCode !== 0) throw Object.assign(fail(provider, 'PAYMENT_PROVIDER_REJECTED', { ambiguous: [40, 41, 43, 7000, 7002, 9000].includes(data.resultCode) }), { gatewayResultCode: data.resultCode });
    if (data.partnerCode !== settings.partnerCode || data.orderId !== options.txnRef || data.requestId !== requestId || data.amount !== amount) throw fail(provider, 'PAYMENT_RESPONSE_MISMATCH', { ambiguous: true });
    if (data.signature !== undefined) {
      const raw = `accessKey=${settings.accessKey}&amount=${amount}&message=${data.message ?? ''}&orderId=${data.orderId}&partnerCode=${data.partnerCode}&payUrl=${data.payUrl}&requestId=${requestId}&responseTime=${data.responseTime}&resultCode=${data.resultCode}`;
      if (!equalHex(data.signature, hmac(settings.secretKey, raw))) throw fail(provider, 'PAYMENT_RESPONSE_SIGNATURE_INVALID', { ambiguous: true });
    }
  } else {
    if (!Number.isInteger(data.return_code)) throw fail(provider, 'PAYMENT_RESPONSE_INVALID', { ambiguous: true });
    if (data.return_code !== 1 || (data.sub_return_code !== undefined && (!Number.isInteger(data.sub_return_code) || data.sub_return_code < 0))) throw Object.assign(fail(provider, 'PAYMENT_PROVIDER_REJECTED', { ambiguous: data.sub_return_code === -68 }), { gatewayResultCode: data.return_code });
    if ((data.app_trans_id !== undefined && data.app_trans_id !== requestId) || (data.app_id !== undefined && Number(data.app_id) !== Number(settings.appId)) || (data.amount !== undefined && data.amount !== amount)) throw fail(provider, 'PAYMENT_RESPONSE_MISMATCH', { ambiguous: true });
  }
  const validatedShortLink = provider === 'momo' && data.shortLink !== undefined
    ? paymentUrl(provider, settings.environment, data.shortLink)
    : undefined;
  return { paymentUrl: paymentUrl(provider, settings.environment, provider === 'momo' ? data.payUrl : data.order_url), requestId,
    ...(provider === 'momo' ? { requestType: body.requestType } : {}),
    ...(validatedShortLink ? { shortLink: validatedShortLink } : {}),
    providerTransactionId: safeTransactionId(provider === 'momo' ? data.transId : data.zp_trans_id),
    verificationScope: 'api_credentials', callbackVerified: false };
}

async function queryGatewayPayment(provider, settings, options = {}) {
  credentials(provider, settings);
  const time = timestamp(options.now);
  const requestId = reference(provider, options.txnRef, time, options.requestId);
  let body;
  if (provider === 'momo') {
    body = { partnerCode: settings.partnerCode, orderId: options.txnRef, requestId: options.queryRequestId || randomUUID(), lang: 'vi' };
    if (!validText(body.requestId, 1, 50) || !/^[A-Za-z0-9_-]+$/.test(body.requestId)) throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
    body.signature = hmac(settings.secretKey, `accessKey=${settings.accessKey}&orderId=${body.orderId}&partnerCode=${body.partnerCode}&requestId=${body.requestId}`);
  } else {
    body = { app_id: Number(settings.appId), app_trans_id: requestId };
    body.mac = hmac(settings.key1, `${body.app_id}|${requestId}|${settings.key1}`);
  }
  const data = await post(provider, settings, 'query', body, options);
  const resultCode = provider === 'momo' ? data.resultCode : data.return_code;
  if (!Number.isInteger(resultCode)) throw fail(provider, 'PAYMENT_RESPONSE_INVALID');
  const found = provider === 'momo' ? momoProtocol.isTransactionResult(resultCode) : [1, 3].includes(resultCode) && (data.sub_return_code === undefined || (Number.isInteger(data.sub_return_code) && data.sub_return_code >= 0));
  if (found && (!Number.isSafeInteger(data.amount) || data.amount < 1
    || (provider === 'momo' && (data.partnerCode !== settings.partnerCode || data.orderId !== options.txnRef || data.requestId !== body.requestId))
    || (provider === 'zalopay' && ((data.app_trans_id !== undefined && data.app_trans_id !== requestId) || (data.app_id !== undefined && Number(data.app_id) !== Number(settings.appId)))))) throw fail(provider, 'PAYMENT_RESPONSE_MISMATCH');
  const state = provider === 'momo' ? momoProtocol.paymentState(resultCode) : resultCode === 1 ? 'paid' : 'pending';
  if (provider === 'momo' && found && (data.amount < momoProtocol.MIN_AMOUNT || data.amount > momoProtocol.MAX_AMOUNT
    || (options.amountVnd !== undefined && data.amount !== options.amountVnd)
    || (state === 'paid' && !(typeof data.transId === 'number' && Number.isSafeInteger(data.transId) && data.transId > 0)))) {
    throw fail(provider, 'PAYMENT_RESPONSE_MISMATCH');
  }
  const momoMeta = provider === 'momo' && found ? extractMomoReconciliationMeta(data) : {};
  return { provider, requestId, transactionRef: options.txnRef, reachable: true, found, state,
    amountVnd: found ? data.amount : null, successful: found && state === 'paid',
    hasRefund: provider === 'momo' && Array.isArray(data.refundTrans) && data.refundTrans.some(refund => refund && [0, 7000, 7002].includes(refund.resultCode)),
    providerTransactionId: safeTransactionId(provider === 'momo' ? data.transId : data.zp_trans_id), resultCode,
    ...(Object.keys(momoMeta).length ? { providerMeta: momoMeta, ...momoMeta } : {}) };
}

async function verifyGatewayAccount(provider, settings, options = {}) {
  credentials(provider, settings);
  const knownOrder = validText(options.txnRef, 1, 50) && Number.isSafeInteger(options.amountVnd) && options.amountVnd > 0;
  const txnRef = knownOrder ? options.txnRef : 'GAERUPROBE-' + randomUUID().replaceAll('-', '').slice(0, 20);
  try {
    const result = await queryGatewayPayment(provider, settings, { ...options, txnRef, requestId: knownOrder ? options.requestId : undefined });
    const verified = Boolean(knownOrder && result.found && result.amountVnd === options.amountVnd);
    return { verified, reachable: true, method: 'authenticated_query', verificationScope: verified ? 'api_credentials' : 'reachability', callbackVerified: false,
      message: verified
        ? 'API ' + PROVIDERS[provider].name + ' đã đối chiếu đúng đơn và số tiền. Chữ ký callback' + (provider === 'zalopay' ? ' (Key 2)' : '') + ' chưa được xác minh qua kiểm tra này.'
        : 'Đã nhận phản hồi API ' + PROVIDERS[provider].name + ', chưa có đơn phù hợp để xác minh thông tin merchant. Không đánh dấu kết nối đã xác minh.' };
  } catch (error) {
    if (error.status === 400) throw error;
    return { verified: false, reachable: Boolean(error.upstreamStatus) || /^PAYMENT_RESPONSE_/.test(error.code || ''), method: 'authenticated_query', verificationScope: 'unverified', callbackVerified: false,
      message: 'Chưa xác minh được thông tin merchant ' + PROVIDERS[provider].name + '. Kiểm tra cấu hình và thử lại sau.' };
  }
}
function sanitizeMomoTransGroup(rawGroup) {
  if (!Array.isArray(rawGroup) || rawGroup.length === 0) return undefined;
  const out = [];
  for (const item of rawGroup.slice(0, 50)) {
    if (!item || typeof item !== 'object') continue;
    const itemId = cleanOptionalString(String(item.itemId ?? ''), 120);
    const amount = Number(item.amount);
    if (!itemId || !Number.isSafeInteger(amount) || amount < 1) continue;
    const entry = { itemId, amount };
    if (item.transId !== undefined && item.transId !== null && item.transId !== '') {
      const tid = Number(item.transId);
      if (Number.isSafeInteger(tid) && tid > 0) entry.transId = tid;
    }
    out.push(entry);
  }
  return out.length ? out : undefined;
}

async function refundGatewayPayment(provider, settings, options = {}) {
  if (provider !== 'momo') throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
  credentials(provider, settings);
  const refundOrderId = options.refundOrderId;
  const originalOrderId = options.originalOrderId;
  if (!validReference(refundOrderId, 50) || (originalOrderId && refundOrderId === originalOrderId)) {
    throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
  }
  const requestId = options.requestId || randomUUID();
  if (!validText(requestId, 1, 50) || !/^[A-Za-z0-9._-]+$/.test(requestId)) {
    throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
  }
  const amount = Number(options.amountVnd);
  if (!Number.isSafeInteger(amount) || amount < momoProtocol.MIN_AMOUNT || amount > momoProtocol.MAX_AMOUNT) {
    throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
  }
  const transId = Number(options.originalTransId);
  if (!Number.isSafeInteger(transId) || transId <= 0) {
    throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
  }
  const description = options.description === undefined || options.description === null
    ? ''
    : (cleanOptionalString(String(options.description), 255) || '');
  const body = {
    partnerCode: settings.partnerCode,
    orderId: refundOrderId,
    requestId,
    amount,
    transId,
    lang: options.lang === 'en' ? 'en' : 'vi',
    description
  };
  const transGroup = sanitizeMomoTransGroup(options.transGroup);
  if (transGroup) body.transGroup = transGroup;
  // MoMo 2026 guide, p. 219: exact 7-field alphabetical HMAC-SHA256 signature
  body.signature = hmac(
    settings.secretKey,
    `accessKey=${settings.accessKey}&amount=${amount}&description=${description}&orderId=${refundOrderId}&partnerCode=${settings.partnerCode}&requestId=${requestId}&transId=${transId}`
  );
  const data = await post(provider, settings, 'refund', body, options);
  if (!Number.isInteger(data.resultCode)) throw fail(provider, 'PAYMENT_RESPONSE_INVALID', { ambiguous: true });
  const state = momoProtocol.refundState(data.resultCode);
  if (['succeeded', 'pending'].includes(state)) {
    if (data.partnerCode !== settings.partnerCode || data.orderId !== refundOrderId || data.requestId !== requestId || data.amount !== amount) {
      throw fail(provider, 'PAYMENT_RESPONSE_MISMATCH', { ambiguous: true });
    }
  }
  const refundTransId = safeTransactionId(data.transId && Number(data.transId) > 0 ? data.transId : null);
  return {
    provider,
    refundOrderId,
    requestId,
    amountVnd: amount,
    originalTransId: String(transId),
    refundTransId,
    resultCode: data.resultCode,
    state,
    successful: state === 'succeeded',
    pending: state === 'pending',
    ambiguous: state === 'ambiguous',
    message: cleanOptionalString(String(data.message ?? ''), 300) || '',
    responseTime: Number.isSafeInteger(data.responseTime) ? data.responseTime : null,
    transGroup: Array.isArray(data.transGroup) ? data.transGroup : null
  };
}

async function queryGatewayRefund(provider, settings, options = {}) {
  if (provider !== 'momo') throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
  credentials(provider, settings);
  const refundOrderId = options.refundOrderId;
  if (!validReference(refundOrderId, 50)) throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
  const requestId = options.queryRequestId || randomUUID();
  if (!validText(requestId, 1, 50) || !/^[A-Za-z0-9._-]+$/.test(requestId)) {
    throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
  }
  const body = {
    partnerCode: settings.partnerCode,
    requestId,
    orderId: refundOrderId,
    lang: options.lang === 'en' ? 'en' : 'vi'
  };
  // MoMo 2026 guide, p. 221: exact 4-field alphabetical HMAC-SHA256 signature
  body.signature = hmac(
    settings.secretKey,
    `accessKey=${settings.accessKey}&orderId=${refundOrderId}&partnerCode=${settings.partnerCode}&requestId=${requestId}`
  );
  const data = await post(provider, settings, 'refundQuery', body, options);
  if (!Number.isInteger(data.resultCode)) throw fail(provider, 'PAYMENT_RESPONSE_INVALID', { ambiguous: true });
  if (data.partnerCode !== undefined && data.partnerCode !== settings.partnerCode) {
    throw fail(provider, 'PAYMENT_RESPONSE_MISMATCH', { ambiguous: true });
  }
  if (data.requestId !== undefined && data.requestId !== requestId) {
    throw fail(provider, 'PAYMENT_RESPONSE_MISMATCH', { ambiguous: true });
  }
  const refundTransList = Array.isArray(data.refundTrans) ? data.refundTrans : [];
  // Per MoMo p. 222 example, top-level orderId may echo the original order while refundTrans[].orderId matches refundOrderId.
  const matchedRefund = refundTransList.find(item => item && String(item.orderId) === refundOrderId) || null;
  if (matchedRefund) {
    const entryCode = Number(matchedRefund.resultCode);
    if (!Number.isInteger(entryCode)) throw fail(provider, 'PAYMENT_RESPONSE_INVALID', { ambiguous: true });
    const entryAmount = Number(matchedRefund.amount);
    if (options.amountVnd !== undefined && Number.isSafeInteger(entryAmount) && entryAmount !== options.amountVnd) {
      throw fail(provider, 'PAYMENT_RESPONSE_MISMATCH', { ambiguous: true });
    }
    const state = momoProtocol.refundState(entryCode);
    return {
      provider,
      found: true,
      refundOrderId,
      requestId,
      amountVnd: Number.isSafeInteger(entryAmount) ? entryAmount : null,
      refundTransId: safeTransactionId(matchedRefund.transId && Number(matchedRefund.transId) > 0 ? matchedRefund.transId : null),
      resultCode: entryCode,
      state,
      successful: state === 'succeeded',
      pending: state === 'pending',
      ambiguous: state === 'ambiguous',
      message: cleanOptionalString(String(data.message ?? ''), 300) || '',
      createdTime: Number.isSafeInteger(matchedRefund.createdTime) ? matchedRefund.createdTime : null,
      refundTrans: refundTransList
    };
  }
  const topState = data.resultCode === 0 ? 'ambiguous' : momoProtocol.refundState(data.resultCode);
  return {
    provider,
    found: false,
    refundOrderId,
    requestId,
    amountVnd: null,
    refundTransId: null,
    resultCode: data.resultCode,
    state: topState,
    successful: false,
    pending: topState === 'pending',
    ambiguous: topState === 'ambiguous',
    message: cleanOptionalString(String(data.message ?? ''), 300) || '',
    createdTime: null,
    refundTrans: refundTransList
  };
}

module.exports = {
  createGatewayPayment,
  queryGatewayPayment,
  verifyGatewayAccount,
  refundGatewayPayment,
  queryGatewayRefund,
  extractMomoReconciliationMeta
};
