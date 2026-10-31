'use strict';
const { createHmac, randomUUID, timingSafeEqual } = require('node:crypto');

// Provider contracts: MoMo wallet/onetime + payment-api/query; Zalopay
// specs/order-create + specs/order-query. No caller-supplied endpoint is used.
const PROVIDERS = Object.freeze({
  momo: {
    name: 'MoMo',
    sandbox: 'https://test-payment.momo.vn',
    production: 'https://payment.momo.vn',
    create: '/v2/gateway/api/create', query: '/v2/gateway/api/query',
    paymentHosts: { sandbox: ['test-payment.momo.vn'], production: ['payment.momo.vn'] }
  },
  zalopay: {
    name: 'ZaloPay',
    sandbox: 'https://sb-openapi.zalopay.vn',
    production: 'https://openapi.zalopay.vn',
    create: '/v2/create', query: '/v2/query',
    paymentHosts: { sandbox: ['qcgateway.zalopay.vn', 'sbgateway.zalopay.vn'], production: ['gateway.zalopay.vn'] }
  },
  vnpay: {
    name: 'VNPAY',
    sandbox: 'https://sandbox.vnpayment.vn',
    production: 'https://pay.vnpay.vn',
    query: '/merchant_webapi/api/transaction',
    paymentHosts: { sandbox: ['sandbox.vnpayment.vn'], production: ['pay.vnpay.vn'] }
  }
});
const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 30000; // MoMo specifies a minimum 30 second client timeout.
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
  if (!['momo', 'zalopay', 'vnpay'].includes(provider) || !meta || !settings || !['sandbox', 'production'].includes(settings.environment)) throw fail(provider, 'PAYMENT_CONFIGURATION_INVALID', { status: 400 });
  if (provider === 'momo') {
    if (!validText(settings.partnerCode, 2, 160) || !/^[A-Za-z0-9_-]+$/.test(settings.partnerCode)
      || !validText(settings.accessKey, 2, 160) || !/^[A-Za-z0-9_-]+$/.test(settings.accessKey)
      || !validText(settings.secretKey, 8, 500)) throw fail(provider, 'PAYMENT_CONFIGURATION_INVALID', { status: 400 });
  } else if (provider === 'zalopay') {
    if (!/^[1-9]\d{0,9}$/.test(String(settings.appId || '')) || Number(settings.appId) > 2147483647
      || !validText(settings.key1, 8, 500) || !validText(settings.key2, 8, 500)) {
      throw fail(provider, 'PAYMENT_CONFIGURATION_INVALID', { status: 400 });
    }
  } else if (provider === 'vnpay') {
    if (!validText(settings.tmnCode, 2, 32) || !validText(settings.hashSecret, 8, 500)) {
      throw fail(provider, 'PAYMENT_CONFIGURATION_INVALID', { status: 400 });
    }
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
function reference(provider, txnRef, time, requestId) {
  if (!validText(txnRef, 1, 50) || !/^[A-Za-z0-9](?:[-_.]*[A-Za-z0-9]+)*$/.test(txnRef)) throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
  const id = requestId ?? (provider === 'zalopay' ? vietnamDate(time) + '_' + txnRef : txnRef);
  const maxLen = provider === 'zalopay' ? 40 : 50;
  if (!validText(id, 1, maxLen) || !/^[A-Za-z0-9](?:[-_.]*[A-Za-z0-9]+)*$/.test(id)) throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
  if (provider === 'zalopay') {
    if (!/^\d{6}_/.test(id)) throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
    const payloadPart = id.slice(7);
    const maxTxnLen = 40 - 7 - 9;
    const baseTxn = txnRef.length > maxTxnLen ? txnRef.slice(0, maxTxnLen) : txnRef;
    const matchesTxn = payloadPart === txnRef ||
      payloadPart.startsWith(txnRef + '_') ||
      payloadPart.startsWith(baseTxn + '_');
    if (!matchesTxn) throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
  }
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
  if (typeof fetcher !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
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

function buildGatewayRequestId(provider, txnRef, now) {
  const time = timestamp(now);
  if (!validText(txnRef, 1, 50) || !/^[A-Za-z0-9](?:[-_.]*[A-Za-z0-9]+)*$/.test(txnRef)) {
    throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
  }

  if (provider === 'zalopay') {
    const datePrefix = vietnamDate(time) + '_';
    const dayMs = String(((time % 86400000) + 7 * 3600000) % 86400000).padStart(8, '0');
    const suffix = '_' + dayMs;
    const maxTxnLen = 40 - datePrefix.length - suffix.length;
    const baseTxn = txnRef.length > maxTxnLen ? txnRef.slice(0, maxTxnLen) : txnRef;
    const id = datePrefix + baseTxn + suffix;
    return reference(provider, txnRef, time, id);
  }

  if (provider === 'momo') {
    const suffix = '_' + String(time);
    const maxTxnLen = 50 - suffix.length;
    const baseTxn = txnRef.length > maxTxnLen ? txnRef.slice(0, maxTxnLen) : txnRef;
    const id = baseTxn + suffix;
    return reference(provider, txnRef, time, id);
  }

  return reference(provider, txnRef, time);
}

function validateGatewayInitiationRequest(provider, settings, options = {}) {
  credentials(provider, settings);
  const time = timestamp(options.now);
  const requestId = reference(provider, options.txnRef, time, options.requestId);
  const amount = options.amountVnd;
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > (provider === 'momo' ? 50000000 : 2000000000)) {
    throw fail(provider, 'PAYMENT_REQUEST_INVALID', { status: 400 });
  }
  const baseUrl = publicOrigin(provider, options.baseUrl);
  return { time, requestId, amount, baseUrl };
}

async function createGatewayPayment(provider, settings, options = {}) {
  const { time, requestId, amount, baseUrl } = validateGatewayInitiationRequest(provider, settings, options);
  let body;
  if (provider === 'momo') {
    body = { partnerCode: settings.partnerCode, requestId, orderId: options.txnRef, amount,
      orderInfo: 'Thanh toan don hang ' + options.txnRef,
      redirectUrl: baseUrl + '/api/payments/momo/return', ipnUrl: baseUrl + '/api/payments/momo/ipn',
      requestType: 'captureWallet', extraData: '', autoCapture: true, lang: 'vi' };
    body.signature = hmac(settings.secretKey, `accessKey=${settings.accessKey}&amount=${amount}&extraData=&ipnUrl=${body.ipnUrl}&orderId=${body.orderId}&orderInfo=${body.orderInfo}&partnerCode=${body.partnerCode}&redirectUrl=${body.redirectUrl}&requestId=${requestId}&requestType=captureWallet`);
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
    if (data.resultCode !== 0) throw Object.assign(fail(provider, 'PAYMENT_PROVIDER_REJECTED', { ambiguous: [40, 41].includes(data.resultCode) }), { gatewayResultCode: data.resultCode });
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
  return { paymentUrl: paymentUrl(provider, settings.environment, provider === 'momo' ? data.payUrl : data.order_url), requestId,
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
  } else if (provider === 'zalopay') {
    body = { app_id: Number(settings.appId), app_trans_id: requestId };
    body.mac = hmac(settings.key1, `${body.app_id}|${requestId}|${settings.key1}`);
  } else if (provider === 'vnpay') {
    const vnpDateStr = new Date(time + 7 * 60 * 60 * 1000).toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const transDateStr = options.transactionDate
      ? new Date(new Date(options.transactionDate).getTime() + 7 * 60 * 60 * 1000).toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
      : vnpDateStr;
    const reqId = options.queryRequestId || randomUUID();
    const orderInfo = `Truy van don ${options.txnRef}`;
    const ipAddr = options.ipAddress || '127.0.0.1';
    const rawData = `${reqId}|2.1.0|querydr|${settings.tmnCode}|${options.txnRef}|${transDateStr}|${vnpDateStr}|${ipAddr}|${orderInfo}`;
    body = {
      vnp_RequestId: reqId,
      vnp_Version: '2.1.0',
      vnp_Command: 'querydr',
      vnp_TmnCode: settings.tmnCode,
      vnp_TxnRef: options.txnRef,
      vnp_OrderInfo: orderInfo,
      vnp_TransactionDate: transDateStr,
      vnp_CreateDate: vnpDateStr,
      vnp_IpAddr: ipAddr,
      vnp_SecureHash: createHmac('sha512', settings.hashSecret).update(rawData, 'utf8').digest('hex')
    };
  }
  const data = await post(provider, settings, 'query', body, options);
  if (provider === 'vnpay') {
    const respCode = String(data.vnp_ResponseCode ?? '');
    const transStatus = String(data.vnp_TransactionStatus ?? '');
    const successful = respCode === '00' && transStatus === '00';
    const notFound = respCode === '91' || transStatus === '02';
    const found = successful || (respCode === '00' && transStatus === '01');
    const amount = Number(data.vnp_Amount) ? Math.round(Number(data.vnp_Amount) / 100) : null;
    return {
      provider,
      requestId,
      transactionRef: options.txnRef,
      reachable: true,
      found,
      amountVnd: amount,
      successful,
      providerTransactionId: safeTransactionId(data.vnp_TransactionNo),
      resultCode: Number(respCode) || 0,
      transactionStatus: transStatus,
      notFound
    };
  }
  const resultCode = provider === 'momo' ? data.resultCode : data.return_code;
  if (!Number.isInteger(resultCode)) throw fail(provider, 'PAYMENT_RESPONSE_INVALID');
  const found = provider === 'momo' ? [0, 1000, 9000].includes(resultCode) : [1, 3].includes(resultCode) && (data.sub_return_code === undefined || (Number.isInteger(data.sub_return_code) && data.sub_return_code >= 0));
  if (found && (!Number.isSafeInteger(data.amount) || data.amount < 1
    || (provider === 'momo' && (data.partnerCode !== settings.partnerCode || data.orderId !== options.txnRef || data.requestId !== body.requestId))
    || (provider === 'zalopay' && ((data.app_trans_id !== undefined && data.app_trans_id !== requestId) || (data.app_id !== undefined && Number(data.app_id) !== Number(settings.appId)))))) throw fail(provider, 'PAYMENT_RESPONSE_MISMATCH');
  return { provider, requestId, transactionRef: options.txnRef, reachable: true, found,
    amountVnd: found ? data.amount : null, successful: found && (provider === 'momo' ? resultCode === 0 : resultCode === 1),
    providerTransactionId: safeTransactionId(provider === 'momo' ? data.transId : data.zp_trans_id), resultCode };
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
    return { verified: false, reachable: Boolean(error.upstreamStatus), method: 'authenticated_query', verificationScope: 'unverified', callbackVerified: false,
      message: 'Chưa xác minh được thông tin merchant ' + PROVIDERS[provider].name + '. Kiểm tra cấu hình và thử lại sau.' };
  }
}
module.exports = {
  buildGatewayRequestId,
  validateGatewayInitiationRequest,
  createGatewayPayment,
  queryGatewayPayment,
  verifyGatewayAccount
};
