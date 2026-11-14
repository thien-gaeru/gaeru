'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  base64UrlEncode,
  base64UrlDecode,
  createVapidJwt,
  encryptWebPushPayload,
  decryptWebPushPayload,
  sendWebPushNotification
} = require('../src/web-push');
const { notices } = require('../src/admin-notifications');

function generateTestVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: base64UrlEncode(ecdh.getPublicKey()),
    privateKey: base64UrlEncode(ecdh.getPrivateKey()),
    subject: 'mailto:business@gaeru.com'
  };
}

test('RFC 8292 VAPID JWT & RFC 8291 aes128gcm encryption roundtrip', async () => {
  const vapid = generateTestVapidKeys();
  const jwt = createVapidJwt('https://fcm.googleapis.com', vapid.subject, vapid.publicKey, vapid.privateKey);
  const parts = jwt.split('.');
  assert.equal(parts.length, 3);

  const pubBuf = base64UrlDecode(vapid.publicKey);
  const verifyKey = crypto.createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: base64UrlEncode(pubBuf.subarray(1, 33)),
      y: base64UrlEncode(pubBuf.subarray(33, 65))
    },
    format: 'jwk'
  });
  const validSig = crypto.verify(
    'sha256',
    Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
    { key: verifyKey, dsaEncoding: 'ieee-p1363' },
    base64UrlDecode(parts[2])
  );
  assert.equal(validSig, true, 'VAPID ES256 signature must verify cleanly');

  const receiverEcdh = crypto.createECDH('prime256v1');
  receiverEcdh.generateKeys();
  const authSecret = base64UrlEncode(crypto.randomBytes(16));
  const subKeys = {
    p256dh: base64UrlEncode(receiverEcdh.getPublicKey()),
    auth: authSecret
  };

  const messageObj = {
    title: '✉️ Thư mới · GAERU <business@gaeru.com>',
    body: '[business@gaeru.com] Đơn hàng và hợp tác mới',
    target: 'webmail',
    url: 'https://mail.gaeru.com/?_task=mail&_mbox=INBOX'
  };
  const encrypted = encryptWebPushPayload(Buffer.from(JSON.stringify(messageObj), 'utf8'), subKeys);
  assert.ok(encrypted.length > 86, 'Encrypted payload must contain 86-byte aes128gcm header + ciphertext');

  const decrypted = decryptWebPushPayload(encrypted, receiverEcdh, authSecret);
  assert.deepEqual(JSON.parse(decrypted.toString('utf8')), messageObj);

  let capturedReq = null;
  const res = await sendWebPushNotification(
    { endpoint: 'https://fcm.googleapis.com/fcm/send/test-sub-1', keys: subKeys },
    messageObj,
    vapid,
    async (url, opts) => {
      capturedReq = { url, opts };
      return { status: 201 };
    }
  );
  assert.equal(res.ok, true);
  assert.equal(res.gone, false);
  assert.equal(capturedReq.opts.headers['Content-Encoding'], 'aes128gcm');
  assert.match(capturedReq.opts.headers.Authorization, /^vapid t=[^,]+, k=/);
});

test('inbound_mail_notifications surface in admin notices with webmail target', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('FROM inbound_mail_notifications')) {
        return {
          rows: [
            {
              id: 1,
              mail_uid: '30899',
              recipient: 'business@gaeru.com',
              sender: 'Khách hàng A <khach@example.com>',
              subject: 'Hỏi báo giá sỉ GAERU M3',
              created_at: '2026-11-14T06:10:00.000Z',
              version: '2026-11-14T06:10:00.000Z'
            }
          ]
        };
      }
      return { rows: [] };
    }
  };

  const items = await notices(
    pool,
    { source: 'bootstrap', permissions: ['dashboard.read'] },
    { TURNSTILE_SITE_KEY: 'k', TURNSTILE_SECRET_KEY: 's', smtp: {} }
  );
  const mailNotice = items.find(i => i.key.startsWith('mail:'));
  assert.ok(mailNotice, 'Mail notice must be included in admin notifications');
  assert.equal(mailNotice.target, 'webmail');
  assert.match(mailNotice.title, /business@gaeru\.com/);
  assert.match(mailNotice.detail, /Hỏi báo giá sỉ GAERU M3/);
});
