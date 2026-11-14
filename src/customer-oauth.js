'use strict';
const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const { OAuth2Client } = require('google-auth-library');
const crypto = require('node:crypto');
const { requireCsrf } = require('./security');
const { withTransaction } = require('./db');

function parseCookies(req) {
  if (req.cookies && typeof req.cookies === 'object') return req.cookies;
  const list = {};
  const rc = req.headers?.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      const name = parts.shift()?.trim();
      const val = parts.join('=').trim();
      if (name) {
        try {
          list[name] = decodeURIComponent(val);
        } catch {
          list[name] = val;
        }
      }
    });
  }
  return list;
}

function verifyGisCsrf(cookieVal, bodyVal) {
  if (typeof cookieVal !== 'string' || typeof bodyVal !== 'string' || !cookieVal || !bodyVal) {
    return false;
  }
  const a = Buffer.from(cookieVal);
  const b = Buffer.from(bodyVal);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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

async function verifyGoogleToken(token, { googleClientId, oauthClient = null } = {}) {
  const clientId = String(googleClientId || '').trim();
  if (!clientId) {
    throw Object.assign(new Error('Đăng nhập Google chưa được cấu hình trên máy chủ.'), { status: 503 });
  }

  if (!token || typeof token !== 'string' || !token.trim()) {
    throw Object.assign(new Error('Mã xác thực Google không hợp lệ.'), { status: 401 });
  }

  let realPayload;
  try {
    const client = oauthClient || new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: clientId
    });
    realPayload = ticket ? ticket.getPayload() : null;
  } catch (err) {
    const msg = String(err?.message || '');
    if (/Token used too late|expired/i.test(msg)) {
      throw Object.assign(new Error('Mã xác thực Google đã hết hạn. Vui lòng đăng nhập lại.'), { status: 401 });
    }
    if (/Wrong recipient|audience/i.test(msg)) {
      throw Object.assign(new Error('Mã ứng dụng Google Client ID không khớp.'), { status: 400 });
    }
    if (/Wrong issuer|invalid issuer/i.test(msg)) {
      throw Object.assign(new Error('Nguồn cấp chứng thực Google không hợp lệ.'), { status: 400 });
    }
    throw Object.assign(new Error('Xác thực chữ ký Google thất bại.'), { status: 401 });
  }

  if (!realPayload || typeof realPayload !== 'object') {
    throw Object.assign(new Error('Xác thực chữ ký Google thất bại.'), { status: 401 });
  }

  const now = Math.floor(Date.now() / 1000);
  if (!realPayload.exp || realPayload.exp < now - 300) {
    throw Object.assign(new Error('Mã xác thực Google đã hết hạn. Vui lòng đăng nhập lại.'), { status: 401 });
  }

  const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
  if (!realPayload.iss || !validIssuers.includes(realPayload.iss)) {
    throw Object.assign(new Error('Nguồn cấp chứng thực Google không hợp lệ.'), { status: 400 });
  }

  const audMatch = Array.isArray(realPayload.aud)
    ? realPayload.aud.includes(clientId)
    : realPayload.aud === clientId;
  if (!audMatch) {
    throw Object.assign(new Error('Mã ứng dụng Google Client ID không khớp.'), { status: 400 });
  }

  const email = String(realPayload.email || '').trim().toLowerCase();
  if (!email || !z.string().email().safeParse(email).success) {
    throw Object.assign(new Error('Tài khoản Google không cung cấp email hợp lệ.'), { status: 400 });
  }

  const emailVerified = realPayload.email_verified === true || realPayload.email_verified === 'true';
  if (!emailVerified) {
    throw Object.assign(new Error('Email Google chưa được xác minh. Vui lòng xác minh email với Google trước khi đăng nhập.'), { status: 400 });
  }

  const sub = String(realPayload.sub || '').trim();
  if (!sub) {
    throw Object.assign(new Error('Mã định danh người dùng Google không hợp lệ.'), { status: 401 });
  }

  const name = String(realPayload.name || realPayload.given_name || email.split('@')[0] || 'Khách hàng Google').trim();
  const picture = typeof realPayload.picture === 'string' && realPayload.picture.startsWith('https://') ? realPayload.picture : null;

  return {
    sub,
    email,
    name,
    picture,
    emailVerified: true,
    issuer: 'https://accounts.google.com'
  };
}

const googleSchema = z.object({
  credential: z.string().trim().min(10).max(16000)
}).strict();

/**
 * Resolves or creates customer from Google OAuth identity.
 * Conforms to OWASP Anti-Account Takeover Guidelines:
 * - Tra cứu theo Google sub trong auth_identities (provider='google', issuer, provider_subject)
 * - Nếu chưa liên kết mà email đã tồn tại ở tài khoản khác: KHÔNG auto-link, trả { kind: 'link_required' }
 * - Nếu chưa tồn tại: Tạo customer mới và lưu vào auth_identities
 */
async function resolveGoogleIdentity(pool, googleUser) {
  return await withTransaction(pool, async (client) => {
    const issuer = 'https://accounts.google.com';
    const subject = googleUser.sub;
    const email = googleUser.email.toLowerCase();

    // 1. Tìm tài khoản theo auth_identities
    let identity = (await client.query(
      `SELECT ai.customer_id, c.id, c.full_name AS "fullName", c.email, c.phone,
              c.email_verified_at IS NOT NULL AS "emailVerified", c.active, c.deleted_at AS "deletedAt",
              c.phone_invalid_at AS "phoneInvalidAt", c.created_at AS "createdAt"
       FROM auth_identities ai
       JOIN customers c ON c.id = ai.customer_id
       WHERE ai.provider = 'google' AND (ai.issuer = $1 OR ai.issuer = 'accounts.google.com') AND ai.provider_subject = $2
       FOR UPDATE OF c`,
      [issuer, subject]
    )).rows[0];

    // 1b. Fallback check legacy google_id in customers
    if (!identity) {
      const legacy = (await client.query(
        `SELECT id, full_name AS "fullName", email, phone,
                email_verified_at IS NOT NULL AS "emailVerified", active, deleted_at AS "deletedAt",
                phone_invalid_at AS "phoneInvalidAt", created_at AS "createdAt"
         FROM customers WHERE google_id = $1 FOR UPDATE`,
        [subject]
      )).rows[0];

      if (legacy) {
        await client.query(
          `INSERT INTO auth_identities (customer_id, provider, issuer, provider_subject, email_at_link)
           VALUES ($1, 'google', $2, $3, $4)
           ON CONFLICT (provider, issuer, provider_subject) DO NOTHING`,
          [legacy.id, issuer, subject, email]
        );
        identity = legacy;
      }
    }

    // NẾU TÀI KHOẢN ĐÃ TỒN TẠI VÀ ĐÃ LIÊN KẾT GOOGLE SUB:
    if (identity) {
      if (identity.deletedAt) {
        throw Object.assign(new Error('Vui lòng liên hệ GAERU để khôi phục tài khoản: business@gaeru.com hoặc 082 919 1080.'), { status: 403 });
      }
      if (identity.active === false) {
        throw Object.assign(new Error('Tài khoản đã bị khóa. Vui lòng liên hệ GAERU để được hỗ trợ.'), { status: 403 });
      }
      return { kind: 'existing', customer: identity };
    }

    // NẾU CHƯA LIÊN KẾT GOOGLE SUB:
    // 2. CHỐNG ACCOUNT TAKEOVER (OWASP SC03 & G050)
    // Kiểm tra xem email có thuộc tài khoản GAERU nào khác không:
    const collision = (await client.query(
      `SELECT id, email, full_name AS "fullName", phone,
              email_verified_at IS NOT NULL AS "emailVerified", active, deleted_at AS "deletedAt",
              phone_invalid_at AS "phoneInvalidAt", created_at AS "createdAt"
       FROM customers WHERE lower(email) = $1 AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,
      [email]
    )).rows[0];

    if (collision) {
      if (collision.deletedAt) {
        throw Object.assign(new Error('Vui lòng liên hệ GAERU để khôi phục tài khoản: business@gaeru.com hoặc 082 919 1080.'), { status: 403 });
      }
      if (collision.active === false) {
        throw Object.assign(new Error('Tài khoản đã bị khóa. Vui lòng liên hệ GAERU để được hỗ trợ.'), { status: 403 });
      }

      // NẾU CẢ TÀI KHOẢN GAERU VÀ GOOGLE ĐỀU ĐÃ XÁC THỰC EMAIL:
      // Cả hai bên đều đã xác thực quyền sở hữu email chính chủ -> Tự động liên kết Google identity an toàn tuyệt đối
      if (googleUser.emailVerified && collision.emailVerified) {
        await client.query(
          `INSERT INTO auth_identities (customer_id, provider, issuer, provider_subject, email_at_link)
           VALUES ($1, 'google', $2, $3, $4)
           ON CONFLICT (provider, issuer, provider_subject)
           DO UPDATE SET customer_id = $1, email_at_link = $4, linked_at = now()`,
          [collision.id, issuer, subject, email]
        );
        await client.query(
          `UPDATE customers
           SET google_id = COALESCE(google_id, $1),
               avatar_url = COALESCE(avatar_url, $2),
               email_verified_at = COALESCE(email_verified_at, now()),
               updated_at = now()
           WHERE id = $3`,
          [subject, googleUser.picture || null, collision.id]
        );
        collision.emailVerified = true;
        return { kind: 'existing', customer: collision };
      }

      // TUYỆT ĐỐI CHỐNG ACCOUNT TAKEOVER (OWASP SC03 & G050):
      // Nếu tài khoản GAERU chưa xác thực email, bắt buộc khách đăng nhập mật khẩu tài khoản cũ trước khi link Google
      return {
        kind: 'link_required',
        email: collision.email,
        message: 'Email này đã tồn tại tài khoản GAERU. Vui lòng đăng nhập mật khẩu trước để liên kết Google an toàn.'
      };
    }

    // 3. TẠO KHÁCH HÀNG MỚI HOÀN TOÀN
    const inserted = (await client.query(
      `INSERT INTO customers (full_name, email, phone, google_id, avatar_url, active, email_verified_at)
       VALUES ($1, $2, '', $3, $4, true, now())
       RETURNING id, full_name AS "fullName", email, phone, email_verified_at IS NOT NULL AS "emailVerified",
                 phone_invalid_at AS "phoneInvalidAt", created_at AS "createdAt"`,
      [googleUser.name, email, subject, googleUser.picture]
    )).rows[0];

    await client.query(
      `INSERT INTO auth_identities (customer_id, provider, issuer, provider_subject, email_at_link)
       VALUES ($1, 'google', $2, $3, $4)
       ON CONFLICT (provider, issuer, provider_subject) DO NOTHING`,
      [inserted.id, issuer, subject, email]
    );

    return { kind: 'created', customer: inserted };
  });
}

function createCustomerOAuthRouter(pool, { config = {}, accountSecurity, fetcher = fetch, oauthClient = null, startCustomerSession } = {}) {
  const resolvedOAuthClient = oauthClient || config.oauthClient || null;
  const router = Router();
  const oauthLimit = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Quá nhiều yêu cầu đăng nhập. Vui lòng thử lại sau.' }
  });

  const getOAuthSettings = async () => {
    try {
      const row = (await pool.query("SELECT setting_value FROM store_settings WHERE setting_key = 'private_admin:oauth'")).rows[0];
      if (row?.setting_value?.cipher) {
        const encKeys = require('./audit-fixes/encryption-key').resolveEncryptionKeys(config);
        const data = JSON.parse(require('./audit-fixes/encryption-key').openWithKeyFallback(row.setting_value.cipher, encKeys));
        return data || {};
      }
      if (row?.setting_value && typeof row.setting_value === 'object') {
        return row.setting_value;
      }
    } catch {}
    return {};
  };

  const isGoogleLoginEnabled = (dbOAuth = null) => {
    if (dbOAuth && (dbOAuth.enabled === false || dbOAuth.googleEnabled === false)) {
      return false;
    }
    if (config.GOOGLE_LOGIN_ENABLED === false || process.env.GOOGLE_LOGIN_ENABLED === 'false') {
      return false;
    }
    return true;
  };

  const getGoogleClientId = async (dbOAuthArg = null) => {
    const dbOAuth = dbOAuthArg || await getOAuthSettings();
    if (!isGoogleLoginEnabled(dbOAuth)) return '';
    if (dbOAuth.googleClientId && String(dbOAuth.googleClientId).trim()) {
      return String(dbOAuth.googleClientId).trim();
    }
    if (Object.prototype.hasOwnProperty.call(config, 'GOOGLE_CLIENT_ID')) {
      return String(config.GOOGLE_CLIENT_ID || '').trim();
    }
    return String(process.env.GOOGLE_CLIENT_ID || '').trim();
  };

  // Pending link info endpoint for frontend feedback
  router.get('/pending-link', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const pending = req.session?.pendingOAuthLink;
    if (!pending) return res.json({ pending: false });
    if (Date.now() - pending.createdAt > 15 * 60 * 1000) {
      delete req.session.pendingOAuthLink;
      return res.json({ pending: false });
    }
    return res.json({
      pending: true,
      email: pending.email,
      provider: pending.provider
    });
  });

  // Public config endpoint so client can initialize Google SDK button
  router.get('/config', async (_req, res) => {
    try {
      const dbOAuth = await getOAuthSettings();
      const googleId = await getGoogleClientId(dbOAuth);
      const configured = Boolean(googleId);
      const enabled = isGoogleLoginEnabled(dbOAuth) && configured;
      res.json({
        google: {
          enabled,
          configured,
          clientId: enabled ? googleId : ''
        }
      });
    } catch {
      res.json({
        google: { enabled: false, configured: false, clientId: '' }
      });
    }
  });

  // Google Login / AJAX One Tap Handler
  router.post('/google', oauthLimit, requireCsrf, async (req, res, next) => {
    try {
      const dbOAuth = await getOAuthSettings();
      if (!isGoogleLoginEnabled(dbOAuth)) {
        return res.status(404).json({ error: 'Tính năng đăng nhập Google hiện đang tạm đóng.' });
      }

      const googleClientId = await getGoogleClientId(dbOAuth);
      if (!googleClientId) {
        return res.status(503).json({ error: 'Đăng nhập Google chưa được cấu hình trên máy chủ.' });
      }

      const parsed = googleSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Chứng thực Google chưa hợp lệ.' });
      }

      const googleUser = await verifyGoogleToken(parsed.data.credential, {
        googleClientId,
        fetcher,
        oauthClient: resolvedOAuthClient
      });

      const outcome = await resolveGoogleIdentity(pool, googleUser);

      if (outcome.kind === 'link_required') {
        if (req.session) {
          req.session.pendingOAuthLink = {
            email: outcome.email,
            provider: 'google',
            googleSub: googleUser.sub,
            picture: googleUser.picture,
            createdAt: Date.now()
          };
        }
        return res.status(409).json({
          linkRequired: true,
          email: outcome.email,
          error: outcome.message || 'Email này đã tồn tại tài khoản GAERU. Vui lòng đăng nhập mật khẩu trước để liên kết Google an toàn.'
        });
      }

      const { checkCustomerPhoneStatus } = require('./customer-lifecycle');
      const phoneStatus = checkCustomerPhoneStatus({
        phone: outcome.customer.phone,
        phone_invalid_at: outcome.customer.phoneInvalidAt,
        created_at: outcome.customer.createdAt
      });
      if (phoneStatus.isExpired) {
        try {
          await pool.query(
            "UPDATE customers SET active = false, lock_reason = 'invalid_phone_timeout', locked_at = now(), updated_at = now() WHERE id = $1",
            [outcome.customer.id]
          );
        } catch (_) {}
        return res.status(403).json({ error: 'Tài khoản đã bị tự động khóa do chưa cập nhật số điện thoại hợp lệ trong vòng 12 giờ. Vui lòng liên hệ GAERU để mở khóa.' });
      }
      if (phoneStatus.isWarning) {
        outcome.customer.phoneWarning = true;
        outcome.customer.phoneWarningRemainingHours = phoneStatus.remainingHours;
        outcome.customer.phoneWarningExpiresAt = phoneStatus.warningExpiresAt;
        outcome.customer.phoneWarningMessage = phoneStatus.warningMessage;
      }

      if (accountSecurity && typeof accountSecurity.beginExternalLogin === 'function') {
        const mfaStarted = await accountSecurity.beginExternalLogin(req, res, `customer:${outcome.customer.id}`, { sendJson: true });
        if (mfaStarted) return;
      }
      startCustomerSession(req, res, next, outcome.customer, accountSecurity);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  // GIS HTML Redirect Callback Handler (POST /auth/google & /account.html redirect POST)
  const handleRedirectCallback = async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');

      const dbOAuth = await getOAuthSettings();
      if (!isGoogleLoginEnabled(dbOAuth)) {
        return res.status(404).send('Tính năng đăng nhập Google hiện đang tạm đóng.');
      }

      // GIS Double-submit CSRF Token check (Unconditional: missing either or both, or mismatch -> 403)
      const cookies = parseCookies(req);
      const cookieCsrf = cookies.g_csrf_token;
      const bodyCsrf = req.body?.g_csrf_token;

      if (!verifyGisCsrf(cookieCsrf, bodyCsrf)) {
        return res.status(403).type('html').send('<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thử lại đăng nhập Google | GAERU</title><main><h1>Phiên đăng nhập Google chưa hợp lệ</h1><p>Kiểm tra CSRF không thành công. Vui lòng quay lại trang tài khoản và chọn nút Đăng nhập bằng Google để thử lại.</p><a href="/tai-khoan#login">Quay lại đăng nhập GAERU</a></main></html>');
      }

      const googleClientId = await getGoogleClientId(dbOAuth);
      if (!googleClientId) {
        return res.status(503).send('Đăng nhập Google chưa được cấu hình trên máy chủ.');
      }

      const credential = req.body?.credential || req.body?.id_token;
      if (!credential || typeof credential !== 'string') {
        return res.redirect(302, '/account.html#login');
      }

      const googleUser = await verifyGoogleToken(credential, {
        googleClientId,
        fetcher,
        oauthClient: resolvedOAuthClient
      });

      const outcome = await resolveGoogleIdentity(pool, googleUser);

      if (outcome.kind === 'link_required') {
        if (req.session) {
          req.session.pendingOAuthLink = {
            email: outcome.email,
            provider: 'google',
            googleSub: googleUser.sub,
            createdAt: Date.now()
          };
        }
        if (req.path === '/auth/google') {
          return res.redirect(303, '/account/link-required');
        }
        return res.redirect(303, '/account.html?linkRequired=1');
      }

      if (outcome.customer.active === false || outcome.customer.deletedAt) {
        return res.status(403).send('Tài khoản đã bị khóa hoặc không còn hoạt động.');
      }

      const { checkCustomerPhoneStatus } = require('./customer-lifecycle');
      const phoneStatus = checkCustomerPhoneStatus({
        phone: outcome.customer.phone,
        phone_invalid_at: outcome.customer.phoneInvalidAt,
        created_at: outcome.customer.createdAt
      });
      if (phoneStatus.isExpired) {
        try {
          await pool.query(
            "UPDATE customers SET active = false, lock_reason = 'invalid_phone_timeout', locked_at = now(), updated_at = now() WHERE id = $1",
            [outcome.customer.id]
          );
        } catch (_) {}
        return res.status(403).send('Tài khoản đã bị tự động khóa do chưa cập nhật số điện thoại hợp lệ trong vòng 12 giờ.');
      }
      if (phoneStatus.isWarning) {
        outcome.customer.phoneWarning = true;
        outcome.customer.phoneWarningRemainingHours = phoneStatus.remainingHours;
        outcome.customer.phoneWarningExpiresAt = phoneStatus.warningExpiresAt;
        outcome.customer.phoneWarningMessage = phoneStatus.warningMessage;
      }

      const targetUrl = req.path === '/auth/google' ? '/account' : '/account.html#customer-account';
      if (accountSecurity && typeof accountSecurity.beginExternalLogin === 'function') {
        const mfaStarted = await accountSecurity.beginExternalLogin(req, res, `customer:${outcome.customer.id}`, { sendJson: false });
        if (mfaStarted) {
          const mfaTarget = req.path === '/auth/google' ? '/account?mfaRequired=1#login' : '/account.html?mfaRequired=1#login';
          return res.redirect(302, mfaTarget);
        }
      }
      startCustomerSession(req, res, next, outcome.customer, accountSecurity, {
        redirectUrl: targetUrl
      });
    } catch (error) {
      console.warn('Google OAuth Redirect Callback error:', error.message);
      const publicMessage = 'Không thể xác thực Google. Vui lòng quay lại trang tài khoản và thử lại.';
      if (req.path === '/auth/google') {
        const code = error.status && error.status >= 400 && error.status < 600 ? error.status : 401;
        return res.status(code).type('text/plain').send(publicMessage);
      }
      res.redirect(302, '/account.html?oauthError=' + encodeURIComponent(publicMessage));
    }
  };

  // Secure Account Linking Endpoint: POST /api/customer-auth/oauth/link-google
  const handleLinkGoogle = async (req, res, next) => {
    const customerId = req.session?.customer?.id;
    if (!customerId) return res.status(401).json({ error: 'Vui lòng đăng nhập tài khoản GAERU để liên kết.' });

    const googleClientId = await getGoogleClientId();
    if (!googleClientId) {
      return res.status(503).json({ error: 'Đăng nhập Google chưa được cấu hình trên máy chủ.' });
    }

    const parsed = googleSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Chứng thực Google chưa hợp lệ.' });

    try {
      const googleUser = await verifyGoogleToken(parsed.data.credential, {
        googleClientId,
        fetcher,
        oauthClient: resolvedOAuthClient
      });

      const outcome = await withTransaction(pool, async (client) => {
        const issuer = 'https://accounts.google.com';
        const subject = googleUser.sub;

        // Check if this Google sub is occupied by another customer (SC25, TC030)
        const occupied = (await client.query(
          `SELECT customer_id FROM auth_identities
           WHERE provider = 'google' AND (issuer = $1 OR issuer = 'accounts.google.com') AND provider_subject = $2
           LIMIT 1`,
          [issuer, subject]
        )).rows[0];

        if (occupied && occupied.customer_id !== customerId) {
          throw Object.assign(new Error('Tài khoản Google này đã được liên kết với một tài khoản GAERU khác.'), { status: 409 });
        }

        if (!googleUser.emailVerified) {
          throw Object.assign(new Error('Email Google chưa được xác minh.'), { status: 403 });
        }

        const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
        const custRes = await client.query(
          `SELECT id, email, email_verified_at IS NOT NULL AS "emailVerified", active, deleted_at AS "deletedAt"
           FROM customers
           WHERE id = $1
           FOR UPDATE`,
          [customerId]
        );
        const cust = custRes.rows[0] || null;
        if (cust) {
          if (cust.deletedAt || cust.active === false) {
            throw Object.assign(new Error('Tài khoản đã bị khóa hoặc không khả dụng.'), { status: 403 });
          }
          const sameEmail = Boolean(cust.email) && normalizeEmail(cust.email) === normalizeEmail(googleUser.email);
          if (!sameEmail && !cust.emailVerified) {
            throw Object.assign(new Error('Tài khoản chưa xác minh email chỉ được liên kết với Google có cùng địa chỉ email.'), { status: 403 });
          }
          if (!sameEmail) {
            throw Object.assign(new Error('Email tài khoản Google phải trùng với email tài khoản GAERU đang đăng nhập.'), { status: 403 });
          }
        } else if (req.session?.customer?.email && normalizeEmail(req.session.customer.email) !== normalizeEmail(googleUser.email)) {
          throw Object.assign(new Error('Email tài khoản Google phải trùng với email tài khoản GAERU đang đăng nhập.'), { status: 403 });
        }

        const canMarkEmailVerified = Boolean(
          googleUser.emailVerified &&
          (cust ? normalizeEmail(cust.email) === normalizeEmail(googleUser.email) : normalizeEmail(req.session?.customer?.email) === normalizeEmail(googleUser.email))
        );

        // Link identity atomically
        await client.query(
          `INSERT INTO auth_identities (customer_id, provider, issuer, provider_subject, email_at_link)
           VALUES ($1, 'google', $2, $3, $4)
           ON CONFLICT (provider, issuer, provider_subject)
           DO UPDATE SET customer_id = $1, email_at_link = $4, linked_at = now()`,
          [customerId, issuer, subject, googleUser.email]
        );

        await client.query(
          `UPDATE customers
           SET google_id = $1,
               avatar_url = COALESCE(avatar_url, $2),
               email_verified_at = CASE WHEN $4 THEN COALESCE(email_verified_at, now()) ELSE email_verified_at END,
               updated_at = now()
           WHERE id = $3`,
          [subject, googleUser.picture, customerId, canMarkEmailVerified]
        );

        if (req.session?.pendingOAuthLink) {
          delete req.session.pendingOAuthLink;
        }
        return { success: true, message: 'Đã liên kết tài khoản Google thành công.' };
      });

      res.json(outcome);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  };

  // Secure Account Unlinking Endpoint: POST /api/customer-auth/oauth/unlink-google
  const handleUnlinkGoogle = async (req, res, next) => {
    const customerId = req.session?.customer?.id;
    if (!customerId) return res.status(401).json({ error: 'Vui lòng đăng nhập tài khoản GAERU.' });

    try {
      const outcome = await withTransaction(pool, async (client) => {
        const cust = (await client.query(
          `SELECT password_hash, email, phone FROM customers WHERE id = $1 FOR UPDATE`,
          [customerId]
        )).rows[0];

        if (!cust) throw Object.assign(new Error('Không tìm thấy tài khoản.'), { status: 404 });

        // Prevent Google-only account lockout (SC26, TC032)
        if (!cust.password_hash) {
          throw Object.assign(
            new Error('Vui lòng thiết lập mật khẩu tài khoản trước khi hủy liên kết Google để tránh mất quyền đăng nhập.'),
            { status: 409 }
          );
        }

        await client.query(
          `DELETE FROM auth_identities WHERE customer_id = $1 AND provider = 'google'`,
          [customerId]
        );

        await client.query(
          `UPDATE customers SET google_id = NULL, updated_at = now() WHERE id = $1`,
          [customerId]
        );

        return { success: true, message: 'Đã hủy liên kết tài khoản Google.' };
      });

      res.json(outcome);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  };

  const express = require('express');
  router.post('/google-callback', express.urlencoded({ extended: false, limit: '32kb' }), handleRedirectCallback);
  router.post('/link-google', requireCsrf, handleLinkGoogle);
  router.post('/unlink-google', requireCsrf, handleUnlinkGoogle);

  router.handleRedirectCallback = handleRedirectCallback;
  router.handleGisRedirect = handleRedirectCallback;
  router.handleLinkGoogle = handleLinkGoogle;
  router.handleUnlinkGoogle = handleUnlinkGoogle;

  return router;
}

module.exports = {
  createCustomerOAuthRouter,
  verifyGoogleToken,
  resolveGoogleIdentity,
  parseJwt,
  verifyGisCsrf,
  parseCookies
};
