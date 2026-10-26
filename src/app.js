const {createAdminNotifications}=require('./admin-notifications');
const {createNewsAI}=require("./news-ai");
const {createCatalogVideos}=require('./catalog-videos');
const {createProductWorkspace}=require("./product-workspace");
const {createAccountSecurity}=require("./account-security");
const {createNewsPublicApi,createNewsAdminApi}=require("./news-api");
const path = require("node:path");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const { createAdminAuthRouter } = require("./admin-auth");
const { createCustomerAuthRouter } = require("./customer-auth");
const { createContactChangeApi } = require("./contact-change-api");
const { createStoreApi } = require("./store-api");
const { getCsrfToken, requireCsrf } = require("./security");
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
  app.use(require('./lib/public-compression').publicCompression());
  config={...config,PUBLIC_BASE_URL:require('./primary-domain').normalizePublicBase(config.PUBLIC_BASE_URL)};
  config={...config,accountSecurity:createAccountSecurity(pool,config,customerMailer)};

  app.use(require('./primary-domain').publicAliasRedirect);
  app.disable("x-powered-by");
  app.set('case sensitive routing', true);
  app.set("trust proxy", config.NODE_ENV === "production" ? 1 : false);
  app.use((req,res,next)=>{
    if (/^\/api(?:\/|$)/i.test(req.path)) {
      res.set({'Cache-Control':'no-store','Pragma':'no-cache','Expires':'0','X-Robots-Tag':'noindex, nofollow, noarchive'});
      res.vary('Cookie');
      if (!/^\/api(?:\/|$)/.test(req.path) || (/^\/api\/gaeru_ceo(?:\/|$)/i.test(req.path) && !/^\/api\/gaeru_ceo(?:\/|$)/.test(req.path))) return res.sendStatus(404);
    }
    if (/^\/gaeru_ceo(?:\/|$)/i.test(req.path)) res.set({'X-Robots-Tag':'noindex, nofollow, noarchive','Cache-Control':'no-store'});
    res.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    next();
  });
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://challenges.cloudflare.com"],
        frameSrc: ["'self'", "https://challenges.cloudflare.com"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'", "https://challenges.cloudflare.com"],
        mediaSrc: ["'self'", "blob:", "https://gaeru.com"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        ...(config.NODE_ENV === "production" ? { upgradeInsecureRequests: [] } : {})
      }
    },
    crossOriginEmbedderPolicy: false
  }));
  // Retired routes must not redirect or fall through to the static admin folder.
  app.use((req,res,next)=>{
    let pathname=req.path;
    try{for(let i=0;i<3;i++){const decoded=decodeURIComponent(pathname);if(decoded===pathname)break;pathname=decoded;}pathname=path.posix.normalize(pathname.replace(/\\/g,'/'));}catch{return res.sendStatus(404);}
    if(/^\/(?:admin(?:\/|$)|api\/admin(?:\/|$))/i.test(pathname))return res.set('Cache-Control','no-store').sendStatus(404);
    next();
  });
  app.use(require("./bot-protection").createBotProtection(pool,config));
  app.use("/api/gaeru_ceo/product-workspace",express.json({limit:"256kb"}));
  app.use("/api/gaeru_ceo/news", express.json({limit:"128kb"}));
  app.use("/api/gaeru_ceo/pages", express.json({limit:"128kb"}));
  app.use("/api/gaeru_ceo/marketing/emails",express.json({limit:"64kb"}));
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

  app.use(async(req,res,next)=>{try{if(req.session?.admin&&req.path.startsWith('/api/')){const record=await require('./admin-configuration').readRecord(pool,config,'security');req.adminSessionLimits=record.data;}require('./admin-session-policy').adminSessionPolicy(req,res,next);}catch(error){next(error);}});
  app.use(config.accountSecurity.sessionGuard);
  app.use("/api/account-security",config.accountSecurity.router);
  app.use("/api/account-deletion",require("./account-retention").createDeletionConfirmation(pool));
  app.get("/api/health", async (_req, res, next) => {
    try {
      await pool.query("SELECT 1");
      res.set({'Cache-Control':'no-store','X-GAERU-Media-Backend':require('./lib/filesystem-media').status().provider+'-'+(require('./lib/filesystem-media').status().verified?'ready':'unverified'),'X-GAERU-Media-Migration':require('./media-filesystem-migration').status().state,'X-GAERU-Media-Error':require('./lib/filesystem-media').status().errorCode||'none','X-GAERU-Media-Persistence':require('./lib/filesystem-media').status().verified?(require('./lib/filesystem-media').status().persistenceMarkerFound?'seen':'new'):'unverified'}).json({ status: "ok" });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/bot-protection',(_req,res)=>res.set('Cache-Control','no-store').json({enabled:Boolean(config.TURNSTILE_SITE_KEY&&config.TURNSTILE_SECRET_KEY&&config.PUBLIC_BASE_URL)}));
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
  app.use("/api/customer-auth",require("./checkout-account").setupRouter(pool));
  app.use("/api/customer-auth/contact-change", createContactChangeApi(pool, {smtpConfig:config.smtp,mailer:customerMailer}));
  app.use("/api/customer-auth", createCustomerAuthRouter(pool, {
    accountSecurity:config.accountSecurity,
    smtpConfig: config.smtp,
    mailer: customerMailer
  }));
  app.use("/api/gaeru_ceo", createAdminAccess(pool, config), adminPolicy, (req,res,next)=>{
    if (['POST','PUT','PATCH','DELETE'].includes(req.method)) return requireCsrf(req,res,next);
    next();
  });
  app.use("/api/gaeru_ceo", require("./media-diagnostics").createMediaDiagnostics());
  app.use("/api/gaeru_ceo", require("./site-pages").createPagesAdmin(pool));
  app.use("/api/gaeru_ceo", require("./order-review").reviewRouter(pool,config));
  app.use("/api/gaeru_ceo", require("./order-after-sales").afterSalesRouter(pool));
  app.use("/api/gaeru_ceo", require("./order-print").createOrderPrint(pool));
  app.use("/api/gaeru_ceo", require("./shipping-choice").createShippingAdmin(pool,config));
  app.use("/api/gaeru_ceo", createAdminNotifications(pool,config));
  app.use("/api/gaeru_ceo",require("./account-retention").createRetentionAdmin(pool,config,customerMailer));
  app.use("/api/gaeru_ceo", createStaffApi(pool, config));
  app.use("/api/gaeru_ceo", createOperationsApi(pool));
  app.use("/api/gaeru_ceo", createFinanceApi(pool));
  app.use("/api/gaeru_ceo", createCareAdminApi(pool));
  app.use("/api/gaeru_ceo", createOwnerApi(pool, config));
  app.use("/api/gaeru_ceo", createWarrantyAdminApi(pool));
  app.use("/api/gaeru_ceo", createBusinessApi(pool));
  app.use("/api/gaeru_ceo", createNewsAI(pool,config));
  app.use("/api/gaeru_ceo", createNewsAdminApi(pool));
  app.use("/api", createNewsPublicApi(pool));
  app.use("/api/gaeru_ceo",require("./admin-configuration").createAdminConfiguration(pool,config));
  const emailMarketing=require("./email-marketing").createEmailMarketing(pool,config);
  app.use("/api/gaeru_ceo",emailMarketing.admin);
  app.use("/api/marketing-email",emailMarketing.publicApi);
  const chat=require("./shopping-chat").createShoppingChat(pool,config);app.use("/api/shopping-chat",chat.publicApi);app.use("/api/gaeru_ceo",chat.admin);
  const marketing=require("./marketing").createMarketing(pool);
  app.use("/api/gaeru_ceo",marketing.admin);
  app.use("/api/customer/marketing",marketing.customer);
  const videos=createCatalogVideos(pool);app.use("/api/gaeru_ceo",videos.admin);app.use("/api",videos.publicApi);
  const productWorkspace=createProductWorkspace(pool);
  app.use("/api/gaeru_ceo",productWorkspace.admin);
  app.use("/api",productWorkspace.publicApi);
  app.use("/media",productWorkspace.publicMedia);
  app.use("/api", (req,res,next)=>{
    if (/^\/gaeru_ceo(?:\/|$)/i.test(req.path) && !req.admin) return res.status(401).json({error:'Vui lòng đăng nhập quản trị viên.'});
    next();
  }, createStoreApi(pool, {
    shippingChoices: true,
    checkoutAccounts: true,
    ordersEnabled: config.STORE_ORDERS_ENABLED,
    getOrdersEnabled: (client=pool) => require("./admin-configuration").getOrdersEnabled(client,config),
    vnpayConfig: config.vnpay || null,
    getVnpayConfig: (client=pool) => require("./admin-configuration").getVnpay(client,config),
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

  const managementAssets=new Set(['pages.js','order-print.js','after-sales.js','orders-workspace.css','order-review.js','admin.css','admin.js','business.js','care.js','enterprise.css','enterprise.js','news-ai.css','news.js','owner.js','product-editor.css','product-editor.js','description-editor.js','warranty.js','notifications.js','notifications.css','admin-ui.js','admin-refinement.css','admin-workspace.css','admin-mobile.css','configuration.js','marketing.js','email-marketing.js','shopping-chat.js']);
  app.get('/gaeru_ceo/notification-worker.js',(_req,res)=>res.set({'Cache-Control':'no-store','Service-Worker-Allowed':'/gaeru_ceo/'}).sendFile(path.join(__dirname,'..','admin','notification-worker.js')));
  app.get('/gaeru_ceo/assets/:file',(req,res,next)=>{
    if(!managementAssets.has(req.params.file))return res.sendStatus(404);
    res.set('Cache-Control','no-store');
    res.sendFile(path.join(__dirname,'..','admin',req.params.file),error=>{if(error)next(error);});
  });
  app.get(["/gaeru_ceo/products/new","/gaeru_ceo/products/:id/edit"],(_req,res)=>{res.set("Cache-Control","no-store").sendFile(path.join(__dirname,"..","admin","product-editor.html"));});
  app.get("/gaeru_ceo", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "..", "admin", "index.html"), error => { if (error) next(error); });
  });
  app.use(require('./site-pages').pageMetadata(pool));
  app.use(require('./clean-routes').cleanRoutes(new URL(config.PUBLIC_BASE_URL||'https://gaeru.com').origin));
  app.get(['/dang-ky-bao-hanh','/dang-ky-bao-hanh/'],(_req,res)=>{res.set('Cache-Control','no-store').sendFile(path.join(__dirname,'..','warranty-activation.html'));});
  app.use(require("./site-pages").createPagesPublic(pool));
  app.use(require("./sitemap").createSitemap(pool,config.PUBLIC_BASE_URL));
  app.use(require("./seo-pages").createSeoPages(pool,config.PUBLIC_BASE_URL));
  app.use((req,res,next)=>{
    let pathname=req.path;
    try {
      for(let i=0;i<4;i++){const decoded=decodeURIComponent(pathname);if(decoded===pathname)break;pathname=decoded;}
      pathname=path.posix.normalize(pathname.replace(/\\/g,'/'));
    } catch {return res.set('Cache-Control','no-store').sendStatus(404);}
    const publicFiles=require('./public-files');
    const isFile=pathname==='/' || publicFiles.has(pathname.slice(1));
    const isAsset=pathname==='/assets/data/vietnam-addresses.json' || pathname.startsWith('/assets/') && /\.(?:png|jpe?g|webp|gif|svg|ico|avif|woff2?|ttf|mp4|webm|pdf)$/i.test(pathname);
    if(!isFile&&!isAsset)return res.set('Cache-Control','no-store').sendStatus(404);
    next();
  });
  app.use(require('./clean-routes').staticHtml);
  app.use(express.static(path.join(__dirname, ".."), {
    dotfiles: "deny",
    index: "index.html",
    setHeaders(res, file) {
      if (/\.(?:js|css|webp|png|jpe?g|woff2?)$/i.test(file)&&/^[a-zA-Z0-9._-]{6,80}$/.test(String(res.req.query.v||'')))res.setHeader('Cache-Control','public, max-age=31536000, immutable');
      if (/\/assets\/.*-[0-9a-f]{12}\.webp$/i.test(file.replace(/\\/g,'/')))res.setHeader('Cache-Control','public, max-age=31536000, immutable');
      if (path.extname(file) === '.html') {
        res.setHeader('Cache-Control', 'no-cache');
      }
      if (['account.html', 'account.js'].includes(path.basename(file))) {
        res.setHeader('Cache-Control', 'no-store');
      }
    },
    maxAge: config.NODE_ENV === "production" ? "1h" : 0
  }));

  app.use((error, _req, res, _next) => {
    if (res.headersSent) return;
    if(error.code==='IMAGE_PROCESSING_BUSY')return res.status(503).json({error:'Đang tối ưu nhiều ảnh. Vui lòng thử lại sau.'});
    if(error.code==='MEDIA_STORAGE_UNAVAILABLE')return res.status(503).json({error:'Chưa lưu được tệp vào kho lưu trữ. Vui lòng thử lại.'});
    const status = Number.isInteger(error.status) ? error.status : error.statusCode;
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: status === 413 ? "Dữ liệu gửi lên quá lớn." : "Yêu cầu không hợp lệ." });
    }
    console.error("Request failed:", {name:error.name||'Error',code:error.code||'INTERNAL_ERROR'});
    res.status(500).json({ error: "Đã xảy ra lỗi hệ thống. Vui lòng thử lại sau." });
  });

  return app;
}

module.exports = { createApp };
