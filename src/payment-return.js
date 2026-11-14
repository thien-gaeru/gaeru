'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');
const { verifyGatewayPayload } = require('./payment-channels');

// Browser returns prove access to an order only when their provider signature is
// valid. Payment settlement remains exclusively in the IPN/query flow.
function verifyGatewayReturn(provider, payload, settings) {
  if (provider === 'momo') return verifyGatewayPayload(provider, payload, settings);
  const invalid = { valid: false, reason: 'Invalid ZaloPay redirect' };
  if (provider !== 'zalopay' || !settings || typeof settings.key2 !== 'string' || !settings.key2
    || !payload || typeof payload !== 'object' || Array.isArray(payload)) return invalid;

  // ZaloPay redirects use a checksum over these seven fields, unlike the JSON
  // callback envelope. See https://developer.zalopay.vn/v2/docs/gateway/api.html#redirect
  const fields = ['appid', 'apptransid', 'pmcid', 'bankcode', 'amount', 'discountamount', 'status'];
  if (fields.some(key => typeof payload[key] !== 'string' || payload[key].length > 120)) return invalid;
  const unsigned = value => /^(?:0|[1-9]\d{0,19})$/.test(value) && Number.isSafeInteger(Number(value));
  const match = payload.apptransid.match(/^\d{6}_(GR-\d{8}-[A-Z0-9]{4,20})$/);
  if (!match || !unsigned(payload.appid) || payload.appid !== String(settings.appId)
    || !unsigned(payload.pmcid) || !/^[A-Za-z0-9_-]{0,64}$/.test(payload.bankcode)
    || !unsigned(payload.amount) || Number(payload.amount) < 1 || Number(payload.amount) > 2_000_000_000
    || !unsigned(payload.discountamount) || Number(payload.discountamount) > Number(payload.amount)
    || !/^-?(?:0|[1-9]\d{0,9})$/.test(payload.status)
    || typeof payload.checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(payload.checksum)) return invalid;

  const expected = createHmac('sha256', settings.key2).update(fields.map(key => payload[key]).join('|'), 'utf8').digest();
  if (!timingSafeEqual(expected, Buffer.from(payload.checksum, 'hex'))) return invalid;
  return {
    valid: true,
    orderNumber: match[1],
    providerOrderId: payload.apptransid,
    amountVnd: Number(payload.amount),
    successful: payload.status === '1',
    responseCode: payload.status
  };
}

module.exports = { verifyGatewayReturn };
