const test = require("node:test");
const assert = require("node:assert/strict");
const { buildVnpayPaymentUrl, verifyVnpayQuery } = require("../src/vnpay");

const config = {
  tmnCode: "ABC12345",
  hashSecret: "sandbox-secret",
  paymentUrl: "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html",
  returnUrl: "https://store.example/api/payments/vnpay/return"
};

test("builds a signed VNPAY payment URL with the VND amount and Vietnam timestamps", () => {
  const paymentUrl = buildVnpayPaymentUrl(config, {
    amountVnd: 230000,
    txnRef: "GR-20260101-ABCDE12345",
    ipAddress: "127.0.0.1",
    now: new Date("2024-01-01T00:00:00.000Z")
  });
  const url = new URL(paymentUrl);
  const query = Object.fromEntries(url.searchParams.entries());
  assert.equal(url.origin + url.pathname, config.paymentUrl);
  assert.equal(query.vnp_Amount, "23000000");
  assert.equal(query.vnp_CreateDate, "20240101070000");
  assert.equal(query.vnp_ExpireDate, "20240101071500");
  assert.equal(verifyVnpayQuery(query, config.hashSecret).valid, true);
});

test("rejects modified or ambiguous VNPAY callback parameters", () => {
  const url = new URL(buildVnpayPaymentUrl(config, {
    amountVnd: 100000,
    txnRef: "GR-20260101-ABCDE12345",
    ipAddress: "127.0.0.1"
  }));
  const callback = Object.fromEntries(url.searchParams.entries());
  callback.vnp_Amount = "1";
  assert.equal(verifyVnpayQuery(callback, config.hashSecret).valid, false);
  callback.vnp_Amount = [callback.vnp_Amount];
  assert.equal(verifyVnpayQuery(callback, config.hashSecret).valid, false);
});
