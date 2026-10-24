const {restoreCustomer}=require('./account-retention');
const { createHash, randomBytes } = require("node:crypto");
const bcrypt = require("bcryptjs");
const { Router } = require("express");
const { rateLimit } = require("express-rate-limit");
const nodemailer = require("nodemailer");
const { z } = require("zod");
const { requireCsrf } = require("./security");
const { withTransaction } = require("./db");

const DUMMY_PASSWORD_HASH = bcrypt.hashSync(randomBytes(24).toString("hex"), 12);
const registrationSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  phone: z.string().trim().regex(/^\+?[0-9().\-\s]{8,25}$/).transform(normalizePhone),
  password: z.string().min(8).max(200)
});
const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254).optional(),
  email: z.string().trim().max(254).optional(),
  password: z.string().min(1).max(200)
}).transform(value => ({ identifier: value.identifier ?? value.email ?? '', password: value.password }))
  .refine(value => z.string().email().safeParse(value.identifier).success || /^\+?[0-9().\-\s]{8,25}$/.test(value.identifier), { message: 'Nhập email hoặc số điện thoại hợp lệ.' });

function loginPhoneCandidates(value) {
  const phone = normalizePhone(value);
  const local = /^\+?84[35789]\d{8}$/.test(phone) ? `0${phone.replace(/^\+?84/, '')}` : phone;
  return /^0[35789]\d{8}$/.test(local) ? [local, `+84${local.slice(1)}`, `84${local.slice(1)}`] : [phone];
}
const resetRequestSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  phone: z.string().trim().regex(/^\+?[0-9().\-\s]{8,25}$/).transform(normalizePhone)
});
const resetPasswordSchema = z.object({
  token: z.string().min(32).max(128),
  password: z.string().min(8).max(200)
});
const verificationTokenSchema = z.string().min(32).max(128);

function normalizePhone(phone) {
  const hasInternationalPrefix = phone.trim().startsWith("+");
  const digits = phone.replace(/\D/g, "");
  return hasInternationalPrefix ? `+${digits}` : digits;
}

function createMailer(smtpConfig) {
  if (!smtpConfig) return null;
  return nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    auth: {
      user: smtpConfig.user,
      pass: smtpConfig.password
    }
  });
}

function createCustomerAuthRouter(pool, { smtpConfig = null, mailer = createMailer(smtpConfig), accountSecurity } = {}) {
  const router = Router();
  const authLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Quá nhiều yêu cầu tài khoản. Vui lòng thử lại sau." }
  });
  const resetLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Quá nhiều yêu cầu khôi phục mật khẩu. Vui lòng thử lại sau." }
  });
  const verificationLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Quá nhiều yêu cầu xác minh tài khoản. Vui lòng thử lại sau." }
  });

  router.post("/register", authLimit, requireCsrf, async (req, res, next) => {
    try {
      const parsed = registrationSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Vui lòng kiểm tra họ tên, email, số điện thoại và mật khẩu tối thiểu 8 ký tự." });

      const passwordHash = await bcrypt.hash(parsed.data.password, 12);
      const result = await pool.query(
        `INSERT INTO customers (full_name, email, phone, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, full_name AS "fullName", email, phone, email_verified_at IS NOT NULL AS "emailVerified"`,
        [parsed.data.fullName, parsed.data.email, parsed.data.phone, passwordHash]
      );
      startCustomerSession(req, res, next, result.rows[0]);
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ error: "Email này đã có tài khoản. Hãy đăng nhập hoặc khôi phục mật khẩu." });
      next(error);
    }
  });

  router.post("/login", authLimit, requireCsrf, async (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Email, số điện thoại hoặc mật khẩu chưa hợp lệ." });

      const isEmail = parsed.data.identifier.includes('@');
      const result = await pool.query(
        `SELECT id, full_name AS "fullName", email, phone, email_verified_at IS NOT NULL AS "emailVerified", active, password_hash,deleted_at AS "deletedAt",deletion_recoverable,deleted_at>now()-interval '30 days' AS "selfRestore"
         FROM customers WHERE ${isEmail ? 'email = $1' : 'phone = ANY($1::text[])'} LIMIT 2`,
        [isEmail ? parsed.data.identifier.toLowerCase() : loginPhoneCandidates(parsed.data.identifier)]
      );
      // Shared phone numbers must never select an arbitrary customer's account.
      const customer = result.rows.length === 1 ? result.rows[0] : null;
      const passwordMatches = await bcrypt.compare(parsed.data.password, customer?.password_hash || DUMMY_PASSWORD_HASH);
      if (!customer || !passwordMatches) return res.status(401).json({ error: "Email/số điện thoại hoặc mật khẩu không đúng. Nếu số điện thoại dùng chung nhiều tài khoản, vui lòng đăng nhập bằng email." });
      if(customer.deletedAt&&(!customer.deletion_recoverable||!customer.selfRestore))return res.status(403).json({error:'Tài khoản đã quá 30 ngày tự khôi phục. Vui lòng liên hệ quản trị GAERU; tài khoản không thể khôi phục sau 1 năm.'});
      if (customer.active === false&&!customer.deletedAt) return res.status(403).json({ error: "Tài khoản đã bị khóa. Vui lòng liên hệ GAERU để được hỗ trợ." });

      if(accountSecurity&&await accountSecurity.beginLogin(req,res,"customer:"+customer.id,parsed.data.password))return;
      if(customer.deletedAt){await withTransaction(pool,client=>restoreCustomer(client,customer.id,{expectedPasswordHash:customer.password_hash}));if(req.securityLoginVersion)req.securityLoginVersion++;customer.active=true;customer.deletedAt=null;}
      startCustomerSession(req, res, next, customer,accountSecurity);
    } catch (error) {
      if(error.status)return res.status(error.status).json({error:error.message});
      next(error);
    }
  });

  router.get("/me", async (req, res, next) => {
    const customer = req.session?.customer;
    if (!customer) return res.json({ authenticated: false, customer: null });
    try {
      const result = await pool.query(
        `SELECT id, full_name AS "fullName", email, phone,
                email_verified_at IS NOT NULL AS "emailVerified", active
         FROM customers WHERE id = $1`,
        [customer.id]
      );
      const currentCustomer = result.rows[0];
      if (!currentCustomer || currentCustomer.active === false) {
        delete req.session.customer;
        return res.json({ authenticated: false, customer: null });
      }
      req.session.customer = currentCustomer;
      res.json({ authenticated: true, customer: currentCustomer });
    } catch (error) {
      next(error);
    }
  });

  router.post("/logout", requireCsrf, (req, res, next) => {
    delete req.session.customer;
    req.session.csrfToken = randomBytes(32).toString("hex");
    req.session.save((error) => {
      if (error) return next(error);
      res.json({ authenticated: false, csrfToken: req.session.csrfToken });
    });
  });

  router.post("/password-reset/request", resetLimit, requireCsrf, async (req, res, next) => {
    try {
      const parsed = resetRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Vui lòng nhập email và số điện thoại hợp lệ." });
      if (!mailer || !smtpConfig?.publicBaseUrl) {
        return res.status(503).json({ error: "Chức năng khôi phục mật khẩu chưa được cấu hình dịch vụ email." });
      }

      const customerResult = await pool.query(
        "SELECT id, email FROM customers WHERE email = $1 AND phone = $2",
        [parsed.data.email, parsed.data.phone]
      );
      const customer = customerResult.rows[0];
      if (!customer) {
        return res.json({ message: "Nếu thông tin khớp với tài khoản, GAERU sẽ gửi hướng dẫn khôi phục đến email đã đăng ký." });
      }

      const token = randomBytes(32).toString("base64url");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      await withTransaction(pool, async (client) => {
        await client.query("SELECT id FROM customers WHERE id = $1 FOR UPDATE", [customer.id]);
        await client.query(
          `DELETE FROM customer_password_reset_tokens
           WHERE customer_id = $1 AND used_at IS NULL`,
          [customer.id]
        );
        await client.query(
          `INSERT INTO customer_password_reset_tokens (customer_id, token_hash, expires_at)
           VALUES ($1, $2, now() + interval '30 minutes')`,
          [customer.id, tokenHash]
        );
      });

      const resetUrl = new URL("/account.html", smtpConfig.publicBaseUrl);
      resetUrl.hash = "password-reset";
      resetUrl.searchParams.set("token", token);
      try {
        await mailer.sendMail({
          from: `GAERU Support <${smtpConfig.from}>`,
          to: customer.email,
          subject: "Khôi phục mật khẩu tài khoản GAERU",
          text: `GAERU nhận được yêu cầu đặt lại mật khẩu. Mở liên kết dùng một lần trong vòng 30 phút: ${resetUrl.toString()}\n\nNếu bạn không yêu cầu, hãy bỏ qua email này.`,
          html: `<p>GAERU nhận được yêu cầu đặt lại mật khẩu.</p><p><a href="${resetUrl.toString()}">Đặt lại mật khẩu</a></p><p>Liên kết chỉ dùng một lần và hết hạn sau 30 phút. Nếu bạn không yêu cầu, hãy bỏ qua email này.</p>`
        });
      } catch (error) {
        await pool.query(
          "DELETE FROM customer_password_reset_tokens WHERE token_hash = $1",
          [tokenHash]
        );
        return next(error);
      }

      res.json({ message: "Nếu thông tin khớp với tài khoản, GAERU sẽ gửi hướng dẫn khôi phục đến email đã đăng ký." });
    } catch (error) {
      next(error);
    }
  });

  router.post("/password-reset/complete", authLimit, requireCsrf, async (req, res, next) => {
    try {
      const parsed = resetPasswordSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Liên kết khôi phục hoặc mật khẩu mới chưa hợp lệ." });

      const tokenHash = createHash("sha256").update(parsed.data.token).digest("hex");
      const passwordHash = await bcrypt.hash(parsed.data.password, 12);
      const updated = await withTransaction(pool, async (client) => {
        const tokenResult = await client.query(
          `SELECT id, customer_id AS "customerId"
           FROM customer_password_reset_tokens
           WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
           FOR UPDATE`,
          [tokenHash]
        );
        const resetToken = tokenResult.rows[0];
        if (!resetToken) return false;

        const updateResult = await client.query(
          `UPDATE customers SET password_hash = $2, updated_at = now()
           WHERE id = $1`,
          [resetToken.customerId, passwordHash]
        );
        if (updateResult.rowCount !== 1) return false;
        if(accountSecurity){await client.query("INSERT INTO account_security(account_key) VALUES($1) ON CONFLICT DO NOTHING",["customer:"+resetToken.customerId]);await client.query("UPDATE account_security SET version=version+1 WHERE account_key=$1",["customer:"+resetToken.customerId]);}
        await client.query(
          "UPDATE customer_password_reset_tokens SET used_at = now() WHERE id = $1",
          [resetToken.id]
        );
        await client.query(
          `UPDATE customer_password_reset_tokens SET used_at = now()
           WHERE customer_id = $1 AND used_at IS NULL`,
          [resetToken.customerId]
        );
        return true;
      });

      if (!updated) return res.status(400).json({ error: "Liên kết khôi phục đã hết hạn hoặc không còn hợp lệ. Hãy yêu cầu liên kết mới." });
      res.json({ message: "Mật khẩu đã được cập nhật. Hãy đăng nhập bằng mật khẩu mới." });
    } catch (error) {
      next(error);
    }
  });

  router.post("/email-verification/request", verificationLimit, requireCsrf, async (req, res, next) => {
    try {
      const customerSession = req.session?.customer;
      if (!customerSession) return res.status(401).json({ error: "Vui lòng đăng nhập để xác minh tài khoản." });
      if (!mailer || !smtpConfig?.publicBaseUrl) {
        return res.status(503).json({ error: "Chức năng xác minh tài khoản chưa được cấu hình dịch vụ email." });
      }

      const token = randomBytes(32).toString("base64url");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const customer = await withTransaction(pool, async (client) => {
        const customerResult = await client.query(
          `SELECT id, full_name AS "fullName", email
           FROM customers WHERE id = $1 AND email_verified_at IS NULL
           FOR UPDATE`,
          [customerSession.id]
        );
        const pendingCustomer = customerResult.rows[0];
        if (!pendingCustomer) return null;

        await client.query(
          `DELETE FROM customer_email_verification_tokens
           WHERE customer_id = $1 AND used_at IS NULL`,
          [pendingCustomer.id]
        );
        await client.query(
          `INSERT INTO customer_email_verification_tokens (customer_id, token_hash, expires_at)
           VALUES ($1, $2, now() + interval '30 minutes')`,
          [pendingCustomer.id, tokenHash]
        );
        return pendingCustomer;
      });

      if (!customer) return res.json({ verified: true, message: "Email tài khoản này đã được xác minh." });
      const verificationUrl = new URL("/account.html", smtpConfig.publicBaseUrl);
      verificationUrl.hash = "customer-account";
      verificationUrl.searchParams.set("verify", token);
      try {
        await mailer.sendMail({
          from: `GAERU Support <${smtpConfig.from}>`,
          to: customer.email,
          subject: "Xác minh tài khoản GAERU",
          text: `Xin chào ${customer.fullName}, hãy mở liên kết sau để xác minh email tài khoản GAERU. Liên kết chỉ dùng một lần và có hiệu lực trong 30 phút: ${verificationUrl.toString()}\n\nNếu bạn không yêu cầu xác minh, hãy bỏ qua email này.`,
          html: `<p>Xin chào ${escapeHtml(customer.fullName)},</p><p>Hãy xác minh email tài khoản GAERU bằng liên kết dưới đây. Liên kết chỉ dùng một lần và có hiệu lực trong 30 phút.</p><p><a href="${verificationUrl.toString()}">Xác minh tài khoản GAERU</a></p><p>Nếu bạn không yêu cầu xác minh, hãy bỏ qua email này.</p>`
        });
      } catch (error) {
        await pool.query(
          "DELETE FROM customer_email_verification_tokens WHERE token_hash = $1",
          [tokenHash]
        );
        if (error.code === 'EAUTH' || error.responseCode === 535) {
          return res.status(503).json({ error: 'Chưa gửi được email xác minh do dịch vụ email từ chối xác thực. Vui lòng liên hệ GAERU để kiểm tra cấu hình gửi thư.' });
        }
        return next(error);
      }

      res.json({ message: "Đã gửi liên kết xác minh đến email tài khoản của bạn. Liên kết có hiệu lực trong 30 phút." });
    } catch (error) {
      next(error);
    }
  });

  router.post("/email-verification/complete", verificationLimit, requireCsrf, async (req, res, next) => {
    try {
      const parsed = verificationTokenSchema.safeParse(req.body?.token);
      if (!parsed.success) return res.status(400).json({ error: "Liên kết xác minh chưa hợp lệ." });
      const tokenHash = createHash("sha256").update(parsed.data).digest("hex");
      const customer = await withTransaction(pool, async (client) => {
        const tokenOwner = await client.query(
          `SELECT customer_id AS "customerId"
           FROM customer_email_verification_tokens
           WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
          [tokenHash]
        );
        const customerId = tokenOwner.rows[0]?.customerId;
        if (!customerId) return null;

        await client.query("SELECT id FROM customers WHERE id = $1 FOR UPDATE", [customerId]);
        const tokenResult = await client.query(
          `SELECT id FROM customer_email_verification_tokens
           WHERE token_hash = $1 AND customer_id = $2
             AND used_at IS NULL AND expires_at > now()
           FOR UPDATE`,
          [tokenHash, customerId]
        );
        const verificationToken = tokenResult.rows[0];
        if (!verificationToken) return null;

        const updated = await client.query(
          `UPDATE customers SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
           WHERE id = $1
           RETURNING id, full_name AS "fullName", email, phone,
                     email_verified_at IS NOT NULL AS "emailVerified"`,
          [customerId]
        );
        if (updated.rowCount !== 1) return null;
        await client.query(
          `UPDATE customer_email_verification_tokens SET used_at = now()
           WHERE customer_id = $1 AND used_at IS NULL`,
          [customerId]
        );
        return updated.rows[0];
      });

      if (!customer) return res.status(400).json({ error: "Liên kết xác minh đã hết hạn hoặc không còn hợp lệ. Hãy yêu cầu gửi liên kết mới." });
      if (req.session?.customer?.id === customer.id) req.session.customer = customer;
      res.json({ verified: true, message: "Email tài khoản GAERU đã được xác minh." });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function startCustomerSession(req, res, next, customer,accountSecurity) {
  req.session.regenerate(async(error) => {
    if (error) return next(error);
    req.session.customer = {
      id: customer.id,
      fullName: customer.fullName,
      email: customer.email,
      phone: customer.phone,
      emailVerified: Boolean(customer.emailVerified)
    };
    if(accountSecurity){try{await accountSecurity.stamp(req,"customer:"+customer.id);}catch(e){return next(e);}}
    req.session.csrfToken = randomBytes(32).toString("hex");
    req.session.save((saveError) => {
      if (saveError) return next(saveError);
      res.json({ customer: req.session.customer, csrfToken: req.session.csrfToken });
    });
  });
}

module.exports = { createCustomerAuthRouter, normalizePhone };
