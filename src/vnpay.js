const { createHmac, timingSafeEqual } = require("node:crypto");

function formatVnpayDate(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`;
}

function canonicalize(parameters) {
  return new URLSearchParams(
    Object.entries(parameters)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .sort(([left], [right]) => left.localeCompare(right))
  ).toString();
}

function sign(data, secret) {
  return createHmac("sha512", secret).update(data, "utf8").digest("hex");
}

function buildVnpayPaymentUrl(config, { amountVnd, txnRef, ipAddress, now = new Date() }) {
  if (!Number.isSafeInteger(amountVnd) || amountVnd < 1 || amountVnd * 100 > 999_999_999_999) {
    throw new Error("Số tiền thanh toán VNPAY không hợp lệ.");
  }
  const createdAt = new Date(now);
  const expiresAt = new Date(createdAt.getTime() + 15 * 60 * 1000);
  const parameters = {
    vnp_Version: "2.1.0",
    vnp_Command: "pay",
    vnp_TmnCode: config.tmnCode,
    vnp_Amount: String(amountVnd * 100),
    vnp_CurrCode: "VND",
    vnp_TxnRef: txnRef,
    vnp_OrderInfo: `Thanh toan don hang ${txnRef}`,
    vnp_OrderType: "other",
    vnp_Locale: "vn",
    vnp_ReturnUrl: config.returnUrl,
    vnp_IpAddr: ipAddress,
    vnp_CreateDate: formatVnpayDate(createdAt),
    vnp_ExpireDate: formatVnpayDate(expiresAt)
  };
  const canonical = canonicalize(parameters);
  return `${config.paymentUrl}?${canonical}&vnp_SecureHash=${sign(canonical, config.hashSecret)}`;
}

function verifyVnpayQuery(query, hashSecret) {
  const parameters = {};
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith("vnp_") || key === "vnp_SecureHash" || key === "vnp_SecureHashType") continue;
    if (typeof value !== "string") return { valid: false, parameters: {} };
    parameters[key] = value;
  }
  const providedHash = query.vnp_SecureHash;
  if (typeof providedHash !== "string" || !/^[a-f0-9]{128}$/i.test(providedHash)) {
    return { valid: false, parameters };
  }
  const expected = Buffer.from(sign(canonicalize(parameters), hashSecret), "hex");
  const actual = Buffer.from(providedHash, "hex");
  return { valid: timingSafeEqual(expected, actual), parameters };
}

module.exports = { buildVnpayPaymentUrl, verifyVnpayQuery, formatVnpayDate };
