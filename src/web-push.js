'use strict';

const crypto = require('node:crypto');

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function base64UrlDecode(str) {
  return Buffer.from(String(str || '').trim(), 'base64url');
}

/**
 * Tạo JWT VAPID (RFC 8292, thuật toán ES256 P-256) không cần thư viện ngoài.
 */
function createVapidJwt(audienceOrigin, subject, publicKeyB64, privateKeyB64, expSeconds) {
  const pubBuf = base64UrlDecode(publicKeyB64);
  const privBuf = base64UrlDecode(privateKeyB64);
  if (pubBuf.length !== 65 || pubBuf[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY phải là khóa công khai P-256 không nén (65 bytes).');
  }
  if (privBuf.length !== 32) {
    throw new Error('VAPID_PRIVATE_KEY phải là khóa bí mật P-256 (32 bytes).');
  }

  const privateKey = crypto.createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: base64UrlEncode(pubBuf.subarray(1, 33)),
      y: base64UrlEncode(pubBuf.subarray(33, 65)),
      d: base64UrlEncode(privBuf)
    },
    format: 'jwk'
  });

  const now = Math.floor(Date.now() / 1000);
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audienceOrigin,
    exp: expSeconds || (now + 12 * 3600),
    sub: subject || 'mailto:business@gaeru.com'
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363'
  });

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

/**
 * Mã hóa nội dung Web Push theo chuẩn RFC 8291 (aes128gcm) + RFC 8188.
 */
function encryptWebPushPayload(payloadBuffer, subscriptionKeys, options = {}) {
  const uaPublic = base64UrlDecode(subscriptionKeys?.p256dh);
  const authSecret = base64UrlDecode(subscriptionKeys?.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error('Khóa p256dh của thiết bị không hợp lệ.');
  }
  if (authSecret.length < 16) {
    throw new Error('Khóa auth của thiết bị không hợp lệ.');
  }

  const ecdh = crypto.createECDH('prime256v1');
  if (options.ephemeralPrivateKey) {
    ecdh.setPrivateKey(options.ephemeralPrivateKey);
  } else {
    ecdh.generateKeys();
  }
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);
  const salt = options.salt ? Buffer.from(options.salt) : crypto.randomBytes(16);

  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'ascii'),
    uaPublic,
    asPublic
  ]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));

  const cekInfo = Buffer.from('Content-Encoding: aes128gcm\0', 'ascii');
  const nonceInfo = Buffer.from('Content-Encoding: nonce\0', 'ascii');
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, cekInfo, 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, nonceInfo, 12));

  const plaintext = Buffer.isBuffer(payloadBuffer)
    ? payloadBuffer
    : Buffer.from(String(payloadBuffer ?? ''), 'utf8');
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1 + asPublic.length);
  salt.copy(header, 0, 0, 16);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);

  return Buffer.concat([header, ciphertext]);
}

/**
 * Giải mã gói aes128gcm (dùng cho kiểm thử tự động chuẩn RFC 8291).
 */
function decryptWebPushPayload(encryptedBody, receiverEcdh, authSecretB64) {
  const buf = Buffer.from(encryptedBody);
  const salt = buf.subarray(0, 16);
  const idlen = buf.readUInt8(20);
  const asPublic = buf.subarray(21, 21 + idlen);
  const ciphertextWithTag = buf.subarray(21 + idlen);
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);
  const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);

  const uaPublic = receiverEcdh.getPublicKey();
  const sharedSecret = receiverEcdh.computeSecret(asPublic);
  const authSecret = base64UrlDecode(authSecretB64);

  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'ascii'),
    uaPublic,
    asPublic
  ]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'ascii'), 12));

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0x00) end -= 1;
  if (end < 0 || padded[end] !== 0x02) {
    throw new Error('Delimiter 0x02 không hợp lệ trong bản mã aes128gcm.');
  }
  return padded.subarray(0, end);
}

/**
 * Gửi thông báo Web Push tới một PushSubscription.
 */
async function sendWebPushNotification(subscription, payload, vapidConfig, fetchImpl = globalThis.fetch) {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new Error('Subscription thiếu endpoint hoặc keys (p256dh, auth).');
  }
  const publicKey = vapidConfig?.publicKey || vapidConfig?.VAPID_PUBLIC_KEY;
  const privateKey = vapidConfig?.privateKey || vapidConfig?.VAPID_PRIVATE_KEY;
  const subject = vapidConfig?.subject || vapidConfig?.VAPID_SUBJECT || 'mailto:business@gaeru.com';
  if (!publicKey || !privateKey) {
    throw new Error('Chưa cấu hình VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.');
  }

  const { assertSafePushEndpoint } = require('./audit-fixes/push-url-guard');
  const { url: endpointUrl } = await assertSafePushEndpoint(subscription.endpoint, {
    allowUnresolvedForMockFetch: fetchImpl !== globalThis.fetch
  });
  const audience = endpointUrl.origin;
  const jwt = createVapidJwt(audience, subject, publicKey, privateKey);

  const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const body = encryptWebPushPayload(Buffer.from(payloadString, 'utf8'), subscription.keys);

  const response = await fetchImpl(endpointUrl.toString(), {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Authorization: `vapid t=${jwt}, k=${publicKey}`,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'Content-Length': String(body.length),
      TTL: '86400',
      Urgency: 'high'
    },
    body,
    signal: AbortSignal.timeout(12000)
  });

  const gone = response.status === 404 || response.status === 410;
  const ok = response.status >= 200 && response.status < 300;
  return {
    ok,
    status: response.status,
    gone
  };
}

module.exports = {
  base64UrlEncode,
  base64UrlDecode,
  createVapidJwt,
  encryptWebPushPayload,
  decryptWebPushPayload,
  sendWebPushNotification
};
