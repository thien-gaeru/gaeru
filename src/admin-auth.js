const bcrypt = require("bcryptjs");
const { Router } = require("express");
const { rateLimit } = require("express-rate-limit");
const { z } = require("zod");
const { requireCsrf } = require("./security");

const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200)
});

function createAdminAuthRouter(config) {
  const router = Router();
  const loginLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Quá nhiều lần đăng nhập. Vui lòng thử lại sau." }
  });

  router.post("/login", loginLimit, requireCsrf, async (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Tên đăng nhập hoặc mật khẩu chưa hợp lệ." });

      const usernameMatches = parsed.data.username === config.ADMIN_USERNAME;
      const passwordMatches = await bcrypt.compare(parsed.data.password, config.ADMIN_PASSWORD_HASH);
      if (!usernameMatches || !passwordMatches) {
        return res.status(401).json({ error: "Tên đăng nhập hoặc mật khẩu không đúng." });
      }

      req.session.regenerate((error) => {
        if (error) return next(error);
        req.session.admin = { username: config.ADMIN_USERNAME };
        req.session.csrfToken = require("node:crypto").randomBytes(32).toString("hex");
        req.session.save((saveError) => {
          if (saveError) return next(saveError);
          res.json({ username: config.ADMIN_USERNAME, csrfToken: req.session.csrfToken });
        });
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/logout", requireCsrf, (req, res, next) => {
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie("gaeru.sid");
      res.status(204).end();
    });
  });

  router.get("/me", (req, res) => {
    res.json({ authenticated: Boolean(req.session.admin), username: req.session.admin?.username || null });
  });

  return router;
}

module.exports = { createAdminAuthRouter };
