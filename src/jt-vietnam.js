'use strict';

const { createHash } = require('node:crypto');
const carrierResponse = require('./carrier-response');

// J&T Vietnam Open Platform, checked 2026-11-03. These are not the Indonesia
// data_param/data_sign protocol or the former logistics_interface endpoint.
// https://open.jtexpress.vn/apiDoc/index
// https://open.jtexpress.vn/apiDoc/vip/query
const PROTOCOL = 'jt-vn-open-platform-v1';
const BASES = Object.freeze({
  sandbox: 'https://demoopenapi.jtexpress.vn/webopenplatformapi/api/',
  production: 'https://ylopenapi.jtexpress.vn/webopenplatformapi/api/'
});
const PATHS = Object.freeze({
  account: 'vip/checkCusPwd',
  create: 'order/addOrder',
  cancel: 'order/cancelOrder',
  tracking: 'logistics/trace',
  quote: 'spmComCost/getComCost',
  label: 'order/printOrder'
});
const fail = (message, status = 409, extra = {}) => Object.assign(new Error(message), { status, ...extra });

function credentials(settings = {}) {
  if (settings.protocol !== PROTOCOL || !Object.hasOwn(BASES, settings.environment)) {
    throw fail('Lưu cấu hình J&T Việt Nam Open Platform và chọn đúng môi trường. Cấu hình cũ chưa được nghiệm thu.');
  }
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(settings.accountId || '')) throw fail('Nhập Mã khách hàng (customerCode) do J&T Việt Nam cấp.');
  // Keep the API identifier as a string: J&T examples exceed JS safe integers.
  if (!/^\d{1,30}$/.test(settings.partnerCode || '')) throw fail('Nhập apiAccount dạng chữ số từ ứng dụng J&T Open Platform.');
  if (typeof settings.secret !== 'string' || !settings.secret || settings.secret.length > 2000 || /[\u0000-\u001f\u007f]/.test(settings.secret)) throw fail('Lưu privateKey của đúng môi trường J&T trước khi kiểm tra.');
  // The public pages disagree on the plaintext-password salt. Require the
  // prepared business password from J&T's signature tool; never guess a salt.
  if (!/^[A-F0-9]{32}$/.test(settings.customerPassword || '')) throw fail('Nhập password nghiệp vụ gồm 32 ký tự HEX viết hoa từ công cụ ký J&T. Không nhập mật khẩu đăng nhập.');
  return {
    customerCode: settings.accountId,
    apiAccount: settings.partnerCode,
    privateKey: settings.secret,
    password: settings.customerPassword,
    environment: settings.environment
  };
}

function headerDigest(json, privateKey) {
  // The first-party VN signature specification requires MD5 bytes then Base64.
  // MD5 is a protocol limitation, not a password hash or internal auth primitive.
  return createHash('md5').update(json + privateKey, 'utf8').digest('base64');
}

function accountDigest(customerCode, preparedPassword, privateKey) {
  // /apiDoc/vip/query specifies customerCode + prepared ciphertext + privateKey.
  return headerDigest(customerCode + preparedPassword, privateKey);
}

function businessIdentity(settings) {
  const c = credentials(settings);
  return { customerCode: c.customerCode, password: c.password };
}

async function responseText(response) {
  const limit = 1000000;
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > limit) throw fail('Phản hồi J&T vượt giới hạn.', 502);
    return text;
  }
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel().catch(() => {});
      throw fail('Phản hồi J&T vượt giới hạn.', 502);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function request(settings, operation, business, { fetcher = fetch, now = Date.now } = {}) {
  const c = credentials(settings);
  if (!Object.hasOwn(PATHS, operation)) throw fail('Tác vụ J&T chưa được hỗ trợ.', 501);
  const json = JSON.stringify(business);
  const timestamp = String(now());
  if (!/^\d{10,16}$/.test(timestamp)) throw fail('Đồng hồ gửi yêu cầu J&T chưa hợp lệ.', 400);
  let response, data;
  try {
    response = await fetcher(BASES[c.environment] + PATHS[operation], {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        apiAccount: c.apiAccount,
        digest: headerDigest(json, c.privateKey),
        timestamp
      },
      body: new URLSearchParams({ bizContent: json }).toString(),
      signal: AbortSignal.timeout(operation === 'create' ? 15000 : 12000),
      redirect: 'error'
    });
    if (!response.ok) throw fail('J&T Việt Nam từ chối kết nối. Kiểm tra môi trường và quyền API.', 502);
    const text = await responseText(response);
    data = JSON.parse(text);
  } catch (error) {
    if (error.status) {
      if (operation === 'create' || operation === 'cancel') error.ambiguous = true;
      throw error;
    }
    // Do not include fetch/provider errors which may contain credentials/body.
    throw fail('Chưa nhận được phản hồi J&T hợp lệ. Đối chiếu kết quả tại hãng trước khi gửi lại.', 502, { ambiguous: operation === 'create' || operation === 'cancel' });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !carrierResponse.succeeded('jt', data)) {
    // Provider msg can echo request values; return a fixed safe diagnostic.
    throw fail('J&T chưa xác nhận tác vụ thành công. Kiểm tra quyền API và đối chiếu trên cổng J&T.', 502, { ambiguous: operation === 'create' || operation === 'cancel' });
  }
  return data;
}

async function verifyAccount(settings, options = {}) {
  const c = credentials(settings);
  await request(settings, 'account', { customerCode: c.customerCode, digest: accountDigest(c.customerCode, c.password, c.privateKey) }, options);
  return { id: 'jt', name: 'J&T Express', checkedAt: new Date().toISOString(), method: 'account_lookup', environment: c.environment, protocol: PROTOCOL, accountVerified: true, checkoutReady: false };
}

function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw fail('J&T cần ' + label + ' hợp lệ; chưa gửi yêu cầu.', 400);
  return value.trim();
}

function address(value, label) {
  if (!value || typeof value !== 'object') throw fail('J&T cần tỉnh/thành và xã/phường đã đối chiếu cho ' + label + '; không tự suy đoán từ chuỗi địa chỉ.', 409);
  return {
    name: text(value.name, 'tên ' + label, 40),
    mobile: text(value.mobile, 'điện thoại ' + label, 30),
    prov: text(value.prov, 'tỉnh/thành ' + label, 40),
    ...(value.city ? { city: text(value.city, 'quận/huyện ' + label, 40) } : {}),
    area: text(value.area, 'xã/phường ' + label, 40),
    address: text(value.address, 'địa chỉ ' + label, 250)
  };
}

function assertOrderEcho(data, orderId, { required = false } = {}) {
  const actual = data?.txlogisticId;
  if ((required && actual === undefined) || (actual !== undefined && String(actual) !== String(orderId))) {
    throw fail('J&T trả mã đơn khác yêu cầu hoặc thiếu liên kết đơn. Cần đối soát tại hãng.', 502, { ambiguous: true });
  }
}

module.exports = { PROTOCOL, BASES, PATHS, credentials, headerDigest, accountDigest, businessIdentity, request, verifyAccount, address, text, assertOrderEcho, fail };
