const path = require("node:path");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const { createAdminAuthRouter } = require("./admin-auth");
const { createCustomerAuthRouter } = require("./customer-auth");
const { createContactChangeApi } = require("./contact-change-api");
const { createStoreApi } = require("./store-api");
const { getCsrfToken } = require("./security");
const { createAdminAccess } = require("./staff-access");
const { createStaffApi } = require("./staff-api");
const { createOperationsApi } = require("./operations-api");
const { createFinanceApi, receiptTotal, recordFullOrderPayment } = require("./finance-api");
const inventory = require("./inventory");
const { appendAudit } = require("./audit");
const { adminPolicy } = require("./admin-policy");
const { createCustomerExperience } = require("./customer-experience");
const { createCareCustomerApi, createCareAdminApi } = require("./care-api");
const { createOwnerApi } = require("./owner-api");
const { createWarrantyCustomerApi, createWarrantyAdminApi } = require("./warranty-api");
const { createWarrantyPublicApi } = require("./warranty-public-api");
const { createBusinessApi } = require("./business-api");

function createApp({ config, pool, sessionStore, customerMailer }) {
  if (!sessionStore) throw new Error("A persistent session store must be provided.");
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", config.NODE_ENV === "production" ? 1 : false);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        ...(config.NODE_ENV === "production" ? { upgradeInsecureRequests: [] } : {})
      }
    },
    crossOriginEmbedderPolicy: false
  }));
  app.use(express.json({ limit: "32kb" }));
  app.use(session({
    name: "gaeru.sid",
    store: sessionStore,
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 8 * 60 * 60 * 1000,
      path: "/"
    }
  }));

  app.get("/api/health", async (_req, res, next) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/csrf", (req, res) => {
    const csrfToken = getCsrfToken(req);
    req.session.save((error) => {
      if (error) return res.status(500).json({ error: "Không thể khởi tạo phiên bảo mật." });
      res.json({ csrfToken });
    });
  });

  app.use("/api/auth", createAdminAuthRouter(config, pool));
  app.use("/api/customer", createCustomerExperience(pool));
  app.use("/api/customer/care", createCareCustomerApi(pool));
  app.use("/api/customer/warranties", createWarrantyCustomerApi(pool));
  app.use("/api/warranty-requests", createWarrantyPublicApi(pool));
  app.use("/api/customer-auth/contact-change", createContactChangeApi(pool, {smtpConfig:config.smtp,mailer:customerMailer}));
  app.use("/api/customer-auth", createCustomerAuthRouter(pool, {
    smtpConfig: config.smtp,
    mailer: customerMailer
  }));
  app.use("/api/admin", createAdminAccess(pool, config), adminPolicy);
  app.use("/api/admin", createStaffApi(pool, config));
  app.use("/api/admin", createOperationsApi(pool));
  app.use("/api/admin", createFinanceApi(pool));
  app.use("/api/admin", createCareAdminApi(pool));
  app.use("/api/admin", createOwnerApi(pool, config));
  app.use("/api/admin", createWarrantyAdminApi(pool));
  app.use("/api/admin", createBusinessApi(pool));
  app.use("/api", createStoreApi(pool, {
    ordersEnabled: config.STORE_ORDERS_ENABLED,
    vnpayConfig: config.vnpay || null,
    inventory,
    audit: appendAudit,
    finance: { receiptTotal, recordFullOrderPayment }
  }));
  app.use("/api", (_req, res) => res.status(404).json({ error: "Không tìm thấy API." }));

  app.use((req, res, next) => {
    if (/^\/(?:src|db|node_modules|tests?)(?:\/|$)|^\/(?:package(?:-lock)?\.json|\.env)/i.test(req.path)) {
      return res.sendStatus(404);
    }
    next();
  });

  app.get(["/admin", "/admin/", "/admin/index.html"], (_req, res) => res.redirect(308, "/gaeru_ceo"));
  app.get("/gaeru_ceo", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "..", "admin", "index.html"), error => { if (error) next(error); });
  });
  app.use(express.static(path.join(__dirname, ".."), {
    dotfiles: "deny",
    index: "index.html",
    setHeaders(res, file) {
      if (['account.html', 'account.js'].includes(path.basename(file))) {
        res.setHeader('Cache-Control', 'no-store');
      }
    },
    maxAge: config.NODE_ENV === "production" ? "1h" : 0
  }));

  app.use((error, _req, res, _next) => {
    if (res.headersSent) return;
    const status = Number.isInteger(error.status) ? error.status : error.statusCode;
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: status === 413 ? "Dữ liệu gửi lên quá lớn." : "Yêu cầu không hợp lệ." });
    }
    console.error("Request failed:", error);
    res.status(500).json({ error: "Đã xảy ra lỗi hệ thống. Vui lòng thử lại sau." });
  });

  return app;
}

module.exports = { createApp };
