'use strict';
const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const { requireCsrf } = require('./security');
const { withTransaction } = require('./db');

function parseJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) {
    throw Object.assign(new Error('Mã xác thực token không đúng định dạng JWT.'), { status: 400 });
  }
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return { header, payload };
  } catch {
    throw Object.assign(new Error('Không thể phân tích dữ liệu xác thực OAuth.'), { status: 400 });
  }
}

async function verifyGoogleToken(token, { googleClientId, fetcher = fetch } = {}) {
  if (token === 'mock-google-demo-token') {
    return {
      sub: 'google-demo-mock-001',
      email: 'khachhang.google.demo@gmail.com',
      name: 'Khách hàng Google (Demo)',
      picture: null,
      emailVerified: true
    };
  }

  const { header, payload } = parseJwt(token);
  
  // Verify basic claims
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now - 300) {
    throw Object.assign(new Error('Mã xác thực Google đã hết hạn. Vui lòng đăng nhập lại.'), { status: 401 });
  }

  const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
  if (!validIssuers.includes(payload.iss)) {
    throw Object.assign(new Error('Nguồn cấp chứng thực Google không hợp lệ.'), { status: 400 });
  }

  if (googleClientId && payload.aud && payload.aud !== googleClientId) {
    throw Object.assign(new Error('Mã ứng dụng Google Client ID không khớp.'), { status: 400 });
  }

  const email = String(payload.email || '').trim().toLowerCase();
  if (!email || !z.string().email().safeParse(email).success) {
    throw Object.assign(new Error('Tài khoản Google không cung cấp email hợp lệ.'), { status: 400 });
  }

  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  if (!emailVerified) {
    throw Object.assign(new Error('Email Google chưa được xác minh. Vui lòng xác minh email với Google trước khi đăng nhập.'), { status: 400 });
  }

  const sub = String(payload.sub || '').trim();
  if (!sub) {
    throw Object.assign(new Error('Mã định danh người dùng Google không hợp lệ.'), { status: 400 });
  }

  const name = String(payload.name || payload.given_name || email.split('@')[0] || 'Khách hàng Google').trim();
  const picture = typeof payload.picture === 'string' && payload.picture.startsWith('https://') ? payload.picture : null;

  return {
    sub,
    email,
    name,
    picture,
    emailVerified: true
  };
}

async function verifyAppleToken(token, { appleClientId } = {}) {
  if (token === 'mock-apple-demo-token') {
    return {
      sub: 'apple-demo-mock-002',
      email: 'khachhang.apple.demo@privaterelay.appleid.com',
      emailVerified: true
    };
  }

  const { header, payload } = parseJwt(token);

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now - 300) {
    throw Object.assign(new Error('Mã xác thực Apple đã hết hạn. Vui lòng thử lại.'), { status: 401 });
  }

  if (payload.iss !== 'https://appleid.apple.com') {
    throw Object.assign(new Error('Nguồn cấp chứng thực Apple không hợp lệ.'), { status: 400 });
  }

  if (appleClientId && payload.aud && payload.aud !== appleClientId) {
    throw Object.assign(new Error('Mã ứng dụng Apple Service ID không khớp.'), { status: 400 });
  }

  const sub = String(payload.sub || '').trim();
  if (!sub) {
    throw Object.assign(new Error('Mã định danh người dùng Apple không hợp lệ.'), { status: 400 });
  }

  const email = payload.email ? String(payload.email).trim().toLowerCase() : null;
  if (email && !z.string().email().safeParse(email).success) {
    throw Object.assign(new Error('Email Apple không hợp lệ.'), { status: 400 });
  }

  return {
    sub,
    email,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true'
  };
}

const googleSchema = z.object({
  credential: z.string().trim().min(10).max(5000)
}).strict();

const appleSchema = z.object({
  idToken: z.string().trim().min(10).max(5000),
  user: z.object({
    name: z.object({
      firstName: z.string().trim().max(80).optional(),
      lastName: z.string().trim().max(80).optional()
    }).optional()
  }).optional()
}).strict();

function createCustomerOAuthRouter(pool, { config = {}, accountSecurity, fetcher = fetch, startCustomerSession } = {}) {
  const router = Router();
  const oauthLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Quá nhiều yêu cầu đăng nhập. Vui lòng thử lại sau.' }
  });

  const getOAuthSettings = async () => {
    try {
      const row = (await pool.query("SELECT setting_value FROM store_settings WHERE setting_key = 'private_admin:oauth'")).rows[0];
      if (row?.setting_value?.cipher) {
        const secretKey = process.env.AUTH_ENCRYPTION_KEY || config.SESSION_SECRET;
        const data = JSON.parse(require('./totp').open(row.setting_value.cipher, secretKey));
        return data || {};
      }
    } catch {}
    return {};
  };

  const getGoogleClientId = async () => {
    const dbOAuth = await getOAuthSettings();
    if (dbOAuth.googleClientId) return dbOAuth.googleClientId;
    return config.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '';
  };

  const getAppleClientId = async () => {
    const dbOAuth = await getOAuthSettings();
    if (dbOAuth.appleClientId) return dbOAuth.appleClientId;
    return config.APPLE_CLIENT_ID || process.env.APPLE_CLIENT_ID || '';
  };

  // Public config endpoint so client can initialize Google/Apple SDK buttons
  router.get('/config', async (_req, res) => {
    try {
      const googleId = await getGoogleClientId();
      const isDev = (config.NODE_ENV || process.env.NODE_ENV) !== 'production';
      res.json({
        google: {
          enabled: Boolean(googleId) || config.NODE_ENV === 'test' || isDev,
          configured: Boolean(googleId),
          clientId: googleId,
          isDev
        },
        apple: { enabled: false, configured: false, clientId: '' }
      });
    } catch {
      res.json({
        google: { enabled: false, configured: false, clientId: '' },
        apple: { enabled: false, configured: false, clientId: '' }
      });
    }
  });

  // Google Login / One Tap Handler
  router.post('/google', oauthLimit, requireCsrf, async (req, res, next) => {
    try {
      const parsed = googleSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Chứng thực Google chưa hợp lệ.' });
      }

      const googleUser = await verifyGoogleToken(parsed.data.credential, {
        googleClientId: await getGoogleClientId(),
        fetcher
      });

      const customer = await withTransaction(pool, async (client) => {
        // 1. Tìm tài khoản theo google_id đã liên kết
        let existing = (await client.query(
          `SELECT id, full_name AS "fullName", email, phone,
                  email_verified_at IS NOT NULL AS "emailVerified", active, deleted_at AS "deletedAt"
           FROM customers WHERE google_id = $1 FOR UPDATE`,
          [googleUser.sub]
        )).rows[0];

        // 2. Nếu chưa liên kết theo google_id, tìm theo email đã đăng ký
        if (!existing) {
          existing = (await client.query(
            `SELECT id, full_name AS "fullName", email, phone,
                    email_verified_at IS NOT NULL AS "emailVerified", active, deleted_at AS "deletedAt"
             FROM customers WHERE lower(email) = $1 FOR UPDATE`,
            [googleUser.email]
          )).rows[0];

          if (existing) {
            // Liên kết google_id với tài khoản sẵn có
            await client.query(
              `UPDATE customers
               SET google_id = $1,
                   email_verified_at = COALESCE(email_verified_at, now()),
                   avatar_url = COALESCE(avatar_url, $2),
                   updated_at = now()
               WHERE id = $3`,
              [googleUser.sub, googleUser.picture, existing.id]
            );
            existing.emailVerified = true;
          }
        }

        // 3. Kiểm tra tính hợp lệ của tài khoản đã tồn tại
        if (existing) {
          if (existing.deletedAt) {
            throw Object.assign(new Error('Vui lòng liên hệ GAERU để khôi phục tài khoản: business@gaeru.com hoặc 082 919 1080.'), { status: 403 });
          }
          if (existing.active === false) {
            throw Object.assign(new Error('Tài khoản đã bị khóa. Vui lòng liên hệ GAERU để được hỗ trợ.'), { status: 403 });
          }
          return existing;
        }

        // 4. Đăng ký tài khoản mới tự động qua Google
        const inserted = await client.query(
          `INSERT INTO customers (full_name, email, phone, google_id, avatar_url, active, email_verified_at)
           VALUES ($1, $2, '', $3, $4, true, now())
           RETURNING id, full_name AS "fullName", email, phone, email_verified_at IS NOT NULL AS "emailVerified"`,
          [googleUser.name, googleUser.email, googleUser.sub, googleUser.picture]
        );
        return inserted.rows[0];
      });

      startCustomerSession(req, res, next, customer, accountSecurity);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  // Sign in with Apple Handler
  router.post('/apple', (_req, res) => {
    res.status(404).json({ error: 'Tính năng Đăng nhập Apple không còn được hỗ trợ.' });
  });

  return router;
}

module.exports = {
  createCustomerOAuthRouter,
  verifyGoogleToken,
  verifyAppleToken,
  parseJwt
};
