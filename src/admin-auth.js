const bcrypt = require("bcryptjs");
const { Router } = require("express");
const { rateLimit } = require("express-rate-limit");
const { z } = require("zod");
const { requireCsrf } = require("./security");
const {
  bootstrapCredentialVersion, bootstrapPrincipal, principalFromStaff, resolveAdminSession
} = require("./staff-access");
const { appendAudit } = require("./audit");

const loginSchema = z.object({
  username: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200)
});

function publicIdentity(principal) {
  if (!principal) return { username: null, fullName: null, role: null, permissions: [], source: null };
  return {
    username: principal.username, fullName: principal.fullName, role: principal.role,
    permissions: principal.permissions, source: principal.source
  };
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
}

function saveSession(req) {
  return new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
}

function destroySession(req) {
  return new Promise((resolve, reject) => req.session.destroy((error) => error ? reject(error) : resolve()));
}

function createAdminAuthRouter(config, pool) {
  const router = Router();
  const loginLimit = rateLimit({
    ...require("./security-hardening").sharedStore(pool,config,"admin-login"),
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Quá nhiều lần đăng nhập. Vui lòng thử lại sau." }
  });

  router.post("/login", loginLimit, requireCsrf, async (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Thông tin đăng nhập hoặc mật khẩu chưa hợp lệ." });

      let principal = null;
      let identity;
      const effectiveConfig=config.accountSecurity?await config.accountSecurity.ownerConfig():config;
      const resolved=await require("./admin-login-identity").resolveLogin(pool,config,parsed.data.username);
      if (resolved?.source=== "bootstrap") {
        const passwordMatches = await bcrypt.compare(parsed.data.password, effectiveConfig.ADMIN_PASSWORD_HASH);
        if (passwordMatches && Buffer.byteLength(parsed.data.password, "utf8") <= 72) {
          principal = bootstrapPrincipal(effectiveConfig);
          identity = { source: "bootstrap", username: config.ADMIN_USERNAME, credentialVersion: bootstrapCredentialVersion(effectiveConfig) };
        }
      } else {
        const employee=resolved?.staff;
        const passwordMatches = await bcrypt.compare(parsed.data.password, employee?.passwordHash || config.ADMIN_PASSWORD_HASH);
        if (passwordMatches && Buffer.byteLength(parsed.data.password, "utf8") <= 72 && employee?.active) {
          principal = principalFromStaff(employee);
          if (principal) identity = { source: "staff", id: employee.id, username: employee.username, authVersion: employee.authVersion };
        }
      }
      if (!principal) {
        return res.status(401).json({ error: "Thông tin đăng nhập hoặc mật khẩu không đúng." });
      }

      const securityKey=identity.source==="bootstrap"?"owner":"staff:"+identity.id;
      if(config.accountSecurity&&await config.accountSecurity.beginLogin(req,res,securityKey,parsed.data.password))return;
      if (pool) await appendAudit(pool, { actor: principal, action: "auth.login", entityType: "staff", entityId: principal.id || principal.username });
      await regenerateSession(req);
      req.session.admin = identity;
      require('./admin-session-policy').stampAdminSession(req.session);
      if(config.accountSecurity)await config.accountSecurity.stamp(req,securityKey);
      req.session.csrfToken = require("node:crypto").randomBytes(32).toString("hex");
      await saveSession(req);
      res.json({ ...publicIdentity(principal), mfaEnrollmentRequired:await require("./security-hardening").enrollment(config,req,principal), csrfToken: req.session.csrfToken });
    } catch (error) {
      if(error.status)return res.status(error.status).json({error:error.message});
      next(error);
    }
  });

  router.post("/logout", requireCsrf, async (req, res, next) => {
    try {
      // Always end the session, including sessions already revoked in the database.
      await destroySession(req);
      res.clearCookie("gaeru.sid");
      res.status(204).end();
    } catch (error) { next(error); }
  });

  router.get("/me", async (req, res, next) => {
    try {
      const principal = await resolveAdminSession(req, pool, config);
      if(principal&&require('./security-hardening').required(config)&&!await require('./security-hardening').enrollment(config,req,principal)&&req.session.adminMfaVerified!==true){delete req.session.admin;return res.json({authenticated:false,...publicIdentity(null)});}
      res.json({ authenticated: Boolean(principal), ...publicIdentity(principal), ...(principal?{mfaEnrollmentRequired:await require("./security-hardening").enrollment(config,req,principal)}:{}) });
    } catch (error) { next(error); }
  });

  router.post('/activity', rateLimit({windowMs:15*60*1000,limit:300,standardHeaders:'draft-8',legacyHeaders:false}), requireCsrf, async(req,res,next)=>{
    try {
      if(!await resolveAdminSession(req,pool,config)) return res.status(401).json({error:'Phiên quản trị đã kết thúc. Vui lòng đăng nhập lại.'});
      res.status(204).end();
    } catch(error){next(error);}
  });

  return router;
}

module.exports = { createAdminAuthRouter };
