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

  const getGoogleClientId = () => config.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '';
  const getAppleClientId = () => config.APPLE_CLIENT_ID || process.env.APPLE_CLIENT_ID || '';

  // Public config endpoint so client can initialize Google/Apple SDK buttons
  router.get('/config', (_req, res) => {
    const googleId = getGoogleClientId();
    const appleId = getAppleClientId();
    res.json({
      google: {
        enabled: Boolean(googleId) || config.NODE_ENV === 'test',
        clientId: googleId
      },
      apple: {
        enabled: Boolean(appleId) || config.NODE_ENV === 'test',
        clientId: appleId
      }
    });
  });

  // Google Login / One Tap Handler
  router.post('/google', oauthLimit, requireCsrf, async (req, res, next) => {
    try {
      const parsed = googleSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Chứng thực Google chưa hợp lệ.' });
      }

      const googleUser = await verifyGoogleToken(parsed.data.credential, {
        googleClientId: getGoogleClientId(),
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
  router.post('/apple', oauthLimit, requireCsrf, async (req, res, next) => {
    try {
      const parsed = appleSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Chứng thực Apple chưa hợp lệ.' });
      }

      const appleUser = await verifyAppleToken(parsed.data.idToken, {
        appleClientId: getAppleClientId()
      });

      let fullName = 'Khách hàng Apple';
      if (parsed.data.user?.name) {
        const { firstName, lastName } = parsed.data.user.name;
        fullName = [lastName, firstName].filter(Boolean).join(' ').trim() || fullName;
      } else if (appleUser.email) {
        fullName = appleUser.email.split('@')[0];
      }

      const customer = await withTransaction(pool, async (client) => {
        // 1. Tìm tài khoản theo apple_id
        let existing = (await client.query(
          `SELECT id, full_name AS "fullName", email, phone,
                  email_verified_at IS NOT NULL AS "emailVerified", active, deleted_at AS "deletedAt"
           FROM customers WHERE apple_id = $1 FOR UPDATE`,
          [appleUser.sub]
        )).rows[0];

        // 2. Nếu chưa liên kết theo apple_id và có email, tìm theo email
        if (!existing && appleUser.email) {
          existing = (await client.query(
            `SELECT id, full_name AS "fullName", email, phone,
                    email_verified_at IS NOT NULL AS "emailVerified", active, deleted_at AS "deletedAt"
             FROM customers WHERE lower(email) = $1 FOR UPDATE`,
            [appleUser.email]
          )).rows[0];

          if (existing) {
            await client.query(
              `UPDATE customers
               SET apple_id = $1,
                   email_verified_at = COALESCE(email_verified_at, now()),
                   updated_at = now()
               WHERE id = $2`,
              [appleUser.sub, existing.id]
            );
            existing.emailVerified = true;
          }
        }

        // 3. Kiểm tra tính hợp lệ
        if (existing) {
          if (existing.deletedAt) {
            throw Object.assign(new Error('Vui lòng liên hệ GAERU để khôi phục tài khoản: business@gaeru.com hoặc 082 919 1080.'), { status: 403 });
          }
          if (existing.active === false) {
            throw Object.assign(new Error('Tài khoản đã bị khóa. Vui lòng liên hệ GAERU để được hỗ trợ.'), { status: 403 });
          }
          return existing;
        }

        // 4. Tạo tài khoản mới qua Apple
        const email = appleUser.email || `apple-${appleUser.sub.slice(0, 16)}@privaterelay.appleid.com`;
        const inserted = await client.query(
          `INSERT INTO customers (full_name, email, phone, apple_id, active, email_verified_at)
           VALUES ($1, $2, '', $3, true, now())
           RETURNING id, full_name AS "fullName", email, phone, email_verified_at IS NOT NULL AS "emailVerified"`,
          [fullName, email, appleUser.sub]
        );
        return inserted.rows[0];
      });

      startCustomerSession(req, res, next, customer, accountSecurity);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  return router;
}

module.exports = {
  createCustomerOAuthRouter,
  verifyGoogleToken,
  verifyAppleToken,
  parseJwt
};
