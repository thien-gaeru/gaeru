'use strict';

// Require an explicit acknowledgement. Error metadata or a tracking/fee field
// alone cannot override a provider rejection carried by another field.
function succeeded(carrier, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.success === false || (value.error !== undefined && ![false, 0, '', null].includes(value.error))) return false;
  if (['failed', 'error', 'failure', 'unauthorized'].includes(String(value.status).toLowerCase())) return false;
  if (carrier === 'ghn') return value.code === 200;
  if (carrier === 'ghtk') return value.success === true;
  if (carrier === 'viettel') return value.status === 200 && [false, 0].includes(value.error);
  const validCodes = carrier === 'jt' ? ['1', 1, '200', 200] : carrier === 'spx' ? ['0', 0, '200', 200] : [];
  if (value.code !== undefined) return validCodes.includes(value.code);
  return validCodes.length > 0 && (value.success === true || value.status === 'success');
}
function trackingNumber(value, carrier) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim() || String(value).length > 200 || /[\u0000-\u001f\u007f]/.test(String(value))) {
    throw Object.assign(Error('Hãng vận chuyển chưa trả mã vận đơn hợp lệ. Kiểm tra kết quả trên hệ thống hãng trước khi thử lại.'), { status: 502, ambiguous: true, carrier });
  }
  return String(value).trim();
}
function fee(value, { required = false } = {}) {
  if (value !== undefined && value !== null && value !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 2147483647) return Number(value);
  if (!required) return null;
  throw Object.assign(Error('Hãng vận chuyển chưa trả cước phí hợp lệ.'), { status: 502 });
}
module.exports = { succeeded, trackingNumber, fee };
