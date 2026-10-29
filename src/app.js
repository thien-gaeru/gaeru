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
const { rateLimit } = require("express-rate-limit");
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
  const normalizePublicBase=require('./primary-domain').normalizePublicBase;
  config={...config,PUBLIC_BASE_URL:normalizePublicBase(config.PUBLIC_BASE_URL),...(config.smtp?{smtp:{...config.smtp,publicBaseUrl:normalizePublicBase(config.smtp.publicBaseUrl||config.PUBLIC_BASE_URL)}}:{})};
  config={...config,accountSecurity:createAccountSecurity(pool,config,customerMailer)};

  app.use(require('./primary-domain').publicAliasRedirect);
  app.disable("x-powered-by");
  app.set('case sensitive routing', true);
  app.set("trust proxy", 1);
  app.use((req,res,next)=>{
    if (/^\/api(?:\/|$)/i.test(req.path)) {
      res.set({'Cache-Control':'no-store','Pragma':'no-cache','Expires':'0','X-Robots-Tag':'noindex, nofollow, noarchive'});
      res.vary('Cookie');
      if (!/^\/api(?:\/|$)/.test(req.path) || (/^\/api\/gaeru_ceo(?:\/|$)/i.test(req.path) && !/^\/api\/gaeru_ceo(?:\/|$)/.test(req.path))) return res.sendStatus(404);
    }
    if (/^\/gaeru_ceo(?:\/|$)/i.test(req.path)) res.set({'X-Robots-Tag':'noindex, nofollow, noarchive','Cache-Control':'no-store'});
    res.set('Permissions-Policy', /^\/gaeru_ceo(?:\/|$)/i.test(req.path) ? 'camera=(self), microphone=(), geolocation=()' : 'camera=(), microphone=(), geolocation=()');
    next();
  });
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://challenges.cloudflare.com", "https://accounts.google.com", "https://apis.google.com", "https://ssl.gstatic.com", "https://*.gstatic.com"],
        frameSrc: ["'self'", "https://challenges.cloudflare.com", "https://accounts.google.com", "https://apis.google.com", "https://ssl.gstatic.com", "https://*.gstatic.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://accounts.google.com", "https://ssl.gstatic.com", "https://*.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:", "https://*.googleusercontent.com", "https://ssl.gstatic.com", "https://*.gstatic.com"],
        connectSrc: ["'self'", "https://challenges.cloudflare.com", "https://accounts.google.com", "https://apis.google.com", "https://*.googleapis.com", "https://ssl.gstatic.com", "https://*.gstatic.com"],
        mediaSrc: ["'self'", "blob:", "https://gaeru.com"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: []
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" }
  }));
  // Retired routes must not redirect or fall through to the static admin folder.
  app.use((req,res,next)=>{
    let pathname=req.path;
    try{for(let i=0;i<3;i++){const decoded=decodeURIComponent(pathname);if(decoded===pathname)break;pathname=decoded;}pathname=path.posix.normalize(pathname.replace(/\\/g,'/'));}catch{return res.sendStatus(404);}
    if(/^\/(?:admin(?:\/|$)|api\/admin(?:\/|$))/i.test(pathname))return res.set('Cache-Control','no-store').sendStatus(404);
    next();
  });
  const { createWafShield, createHoneypotShield, createDdosShield, createAuthBruteForceShield, getSystemHealth } = require('./security-shield');
  app.use(createWafShield());
  app.use(['/api/auth', '/api/customer-auth'], createAuthBruteForceShield(config));
  app.use('/api', createDdosShield(config));
  app.use(require("./bot-protection").createBotProtection(pool,config));
  app.use("/api/gaeru_ceo/product-workspace",express.json({limit:"256kb"}));
  app.use("/api/gaeru_ceo/news", express.json({limit:"128kb"}));
  app.use("/api/gaeru_ceo/pages", express.json({limit:"128kb"}));
  app.use("/api/gaeru_ceo/marketing/emails",express.json({limit:"64kb"}));
  app.use(express.json({ limit: "32kb" }));
  app.use(createHoneypotShield());
  app.use(session({
    name: "gaeru.sid",
    store: sessionStore,
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: config.NODE_ENV === "production" ? true : "auto",
      sameSite: "lax",
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
      res.set({'Cache-Control':'no-store','X-GAERU-Web-TLS':'enforced','X-GAERU-Media-Backend':require('./lib/filesystem-media').status().provider+'-'+(require('./lib/filesystem-media').status().verified?'ready':'unverified'),'X-GAERU-Media-Local-References':require('./media-storage-audit').auditStatus().state,'X-GAERU-Media-Volume':require('./lib/filesystem-media').status().volumeFingerprint||'unverified','X-GAERU-Media-Error':require('./lib/filesystem-media').status().errorCode||'none','X-GAERU-Media-Persistence':require('./lib/filesystem-media').status().verified?(require('./lib/filesystem-media').status().persistenceMarkerFound?'seen':'new'):'unverified'}).json({ status: "ok" });
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

  const realtimeHub = require('./realtime-sse').createRealtimeHub({ pool, config });
  app.use('/api', realtimeHub.router);
  app.use('/api/cart', require('./abandoned-cart').createAbandonedCartRouter(pool, config, customerMailer));
  app.use('/api/customer', require('./loyalty-api').createLoyaltyCustomerApi(pool));
  app.use('/api', require('./omnichannel-sync').createOmnichannelRouter(pool, config));
  app.use('/api', require('./product-reviews').createReviewsPublicRouter(pool));
  app.use('/api', require('./tracking-api').createTrackingRouter(pool));
  app.use('/api', require('./product-bundles').createBundlesPublicRouter(pool));
  app.use('/api', require('./flash-sale').createFlashSalePublicRouter(pool));
  app.use('/api', require('./affiliate-system').createAffiliatePublicRouter(pool));
  app.use('/api', require('./instant-search').createSearchRouter(pool));
  app.use('/api', require('./web-push').createPushPublicRouter(pool));
  app.use('/api', require('./bnpl-payment').createBnplPublicRouter(pool));
  app.use('/api', require('./creator-quiz').createQuizRouter());
  app.use('/api', require('./product-comparison').createComparisonRouter(pool));
  app.use('/api', require('./rma-workflow').createRmaPublicRouter(pool));
  app.use('/api', require('./social-proof').createSocialProofRouter(pool));

  app.use("/api/auth", createAdminAuthRouter(config, pool));
  app.use("/api/customer", createCustomerExperience(pool));
  app.use("/api/customer/care", createCareCustomerApi(pool));
  app.use("/api/customer/warranties", createWarrantyCustomerApi(pool));
  app.use("/api/warranty-requests", createWarrantyPublicApi(pool));
  app.use("/api/customer-auth",require("./checkout-account").setupRouter(pool));
  app.use("/api/customer-auth/contact-change", createContactChangeApi(pool, {smtpConfig:config.smtp,mailer:customerMailer}));
  const customerOAuthRouter = require("./customer-oauth").createCustomerOAuthRouter(pool, {
    config,
    accountSecurity: config.accountSecurity,
    startCustomerSession: require("./customer-auth").startCustomerSession
  });
  app.use("/api/customer-auth/oauth", customerOAuthRouter);
  if (customerOAuthRouter.handleRedirectCallback) {
    app.post(['/account.html', '/tai-khoan', '/account'], express.urlencoded({ extended: false, limit: '32kb' }), customerOAuthRouter.handleRedirectCallback);
  }
  app.use("/api/customer-auth", createCustomerAuthRouter(pool, {
    accountSecurity:config.accountSecurity,
    smtpConfig: config.smtp,
    mailer: customerMailer,
    isTest: config?.NODE_ENV === "test"
  }));
  app.use("/api/gaeru_ceo", createAdminAccess(pool, config), adminPolicy, (req,res,next)=>{
    if (['POST','PUT','PATCH','DELETE'].includes(req.method)) return requireCsrf(req,res,next);
    next();
  });
  app.get("/api/gaeru_ceo/system-health", async (_req, res, next) => {
    try {
      const health = await getSystemHealth(pool, config);
      res.set("Cache-Control", "no-store").json(health);
    } catch (err) {
      next(err);
    }
  });
  app.use("/api/gaeru_ceo", require("./media-diagnostics").createMediaDiagnostics());
  app.use("/api/gaeru_ceo", require("./file-library").createFileLibrary(pool));
  app.use("/api/gaeru_ceo", require("./site-pages").createPagesAdmin(pool));
  app.use("/api/gaeru_ceo", require("./order-review").reviewRouter(pool,config));
  app.use("/api/gaeru_ceo", require("./order-after-sales").afterSalesRouter(pool));
  app.use("/api/gaeru_ceo", require("./order-print").createOrderPrint(pool));
  app.use("/api/gaeru_ceo", require("./shipping-choice").createShippingAdmin(pool,config));
  app.use("/api/gaeru_ceo", require("./payment-channels").createPaymentAdmin(pool,config,{finance:{receiptTotal,recordFullOrderPayment}}));
  app.use("/api/gaeru_ceo", createAdminNotifications(pool,config));
  app.use("/api/gaeru_ceo",require("./account-retention").createRetentionAdmin(pool,config,customerMailer));
  app.use("/api/gaeru_ceo", createStaffApi(pool, config));
  app.use("/api/gaeru_ceo", createOperationsApi(pool));
  app.use("/api/gaeru_ceo", createFinanceApi(pool));
  app.use("/api/gaeru_ceo", createCareAdminApi(pool));
  app.use("/api/gaeru_ceo", createOwnerApi(pool, config));
  app.use("/api/gaeru_ceo", createWarrantyAdminApi(pool));
  app.use("/api/gaeru_ceo", createBusinessApi(pool, config));
  app.use("/api/gaeru_ceo", createNewsAI(pool,config));
  app.use("/api/gaeru_ceo", createNewsAdminApi(pool));
  app.use("/api", createNewsPublicApi(pool));
  app.use("/api/gaeru_ceo",require("./admin-configuration").createAdminConfiguration(pool,config));
  app.use('/api/gaeru_ceo', require('./abandoned-cart').createAbandonedCartAdmin(pool));
  app.use('/api/gaeru_ceo', require('./loyalty-api').createLoyaltyAdminApi(pool));
  app.use('/api/gaeru_ceo', require('./chat-semantic-knowledge').createKnowledgeAdminRouter(pool));
  app.use('/api/gaeru_ceo', require('./barcode-api').createBarcodeApi(pool, { notifyOrderUpdate: realtimeHub.notifyOrderUpdate }));
  app.use('/api/gaeru_ceo', require('./omnichannel-sync').createOmnichannelAdmin(pool));
  app.use('/api/gaeru_ceo', require('./system-alerts').createSystemAlertsAdmin(pool, config));
  app.use('/api/gaeru_ceo', require('./product-reviews').createReviewsAdminRouter(pool));
  app.use('/api/gaeru_ceo', require('./product-bundles').createBundlesAdminRouter(pool));
  app.use('/api/gaeru_ceo', require('./flash-sale').createFlashSaleAdminRouter(pool));
  app.use('/api/gaeru_ceo', require('./affiliate-system').createAffiliateAdminRouter(pool));
  app.use('/api/gaeru_ceo', require('./zalo-zns').createZaloZnsAdmin(config));
  app.use('/api/gaeru_ceo', require('./cod-reconciliation').createCodReconciliationAdmin(pool));
  app.use('/api/gaeru_ceo', require('./web-push').createPushAdminRouter(pool));
  app.use('/api/gaeru_ceo', require('./bnpl-payment').createBnplAdminRouter(pool));
  app.use('/api/gaeru_ceo', require('./rma-workflow').createRmaAdminRouter(pool));
  app.use('/api/gaeru_ceo', require('./server-capi').createCapiAdminRouter(pool, config));
  app.use('/api/gaeru_ceo', require('./inventory-forecast').createInventoryForecastAdmin(pool));
  app.use('/api/gaeru_ceo', require('./rfm-analytics').createRfmAdminRouter(pool));
  app.use('/api/gaeru_ceo', require('./order-activity').createOrderActivityAdminRouter(pool));
  app.use('/api/gaeru_ceo',require('./tiktok-ads').createTikTokAdsAdmin(pool,config));
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
  app.use("/assets",rateLimit({windowMs:60000,limit:600,standardHeaders:"draft-8",legacyHeaders:false}),require("./persistent-assets").serveAssets(pool));
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
    getPaymentChannels: (client=pool) => require("./payment-channels").getCheckoutPaymentChannels(client,config,config.vnpay||null),
    paymentFetcher: config.paymentFetcher,
    publicBaseUrl: config.PUBLIC_BASE_URL || "https://gaeru.com",
    inventory,
    audit: appendAudit,
    config,
    misaFetcher: config.misaFetcher,
    finance: { receiptTotal, recordFullOrderPayment }
  }));
  app.use("/api", (_req, res) => res.status(404).json({ error: "Không tìm thấy API." }));

  app.use((req, res, next) => {
    if (/^\/(?:src|db|node_modules|tests?)(?:\/|$)|^\/(?:package(?:-lock)?\.json|\.env)/i.test(req.path)) {
      return res.sendStatus(404);
    }
    next();
  });

  const managementAssets=new Set(['file-library.js','file-library.css','pages.js','order-print.js','after-sales.js','orders-workspace.css','order-review.js','admin.css','admin.js','business.js','care.js','enterprise.css','enterprise.js','news-ai.css','news.js','owner.js','product-editor.css','product-editor.js','description-editor.js','warranty.js','notifications.js','notifications.css','admin-ui.js','admin-refinement.css','admin-workspace.css','admin-mobile.css','configuration.js','tiktok-ads.js','marketing.js','email-marketing.js','shopping-chat.js','pwa-install.js','barcode-scanner.js']);
  const projectRoot=path.join(__dirname,'..'),adminRoot=path.join(projectRoot,'admin');
  app.get('/gaeru_ceo/notification-worker.js',(_req,res)=>res.set({'Cache-Control':'no-store','Service-Worker-Allowed':'/gaeru_ceo/'}).sendFile('notification-worker.js',{root:adminRoot}));
  app.get(['/gaeru_ceo/manifest.webmanifest','/gaeru_ceo/manifest.json'],(_req,res)=>res.set({'Content-Type':'application/manifest+json; charset=utf-8','Cache-Control':'public, max-age=3600'}).sendFile('manifest.webmanifest',{root:adminRoot}));
  app.get('/gaeru_ceo/assets/:file',(req,res,next)=>{
    if(!managementAssets.has(req.params.file))return res.sendStatus(404);
    res.set('Cache-Control','no-store');
    res.sendFile(req.params.file,{root:adminRoot},error=>{if(error)next(error);});
  });
  app.get(["/gaeru_ceo/products/new","/gaeru_ceo/products/:id/edit"],(_req,res)=>{res.set("Cache-Control","no-store").sendFile("product-editor.html",{root:adminRoot});});
  app.get("/gaeru_ceo", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.sendFile("index.html", { root: adminRoot }, error => { if (error) next(error); });
  });
  app.use(require('./traffic-tracker').createTrafficTracker(pool));
  app.use(require('./site-pages').pageMetadata(pool));
  app.use(require('./clean-routes').cleanRoutes(new URL(config.PUBLIC_BASE_URL||'https://gaeru.com').origin));
  app.get(['/dang-ky-bao-hanh','/dang-ky-bao-hanh/'],(_req,res)=>{res.set('Cache-Control','no-store').sendFile('warranty-activation.html',{root:projectRoot});});
  app.get(['/tra-cuu-don-hang','/tra-cuu-don-hang/'],(_req,res)=>{res.set('Cache-Control','no-store').sendFile('tracking.html',{root:projectRoot});});
  app.get(['/rma','/rma/','/yeu-cau-bao-hanh','/yeu-cau-bao-hanh/'],(_req,res)=>{res.set('Cache-Control','no-store').sendFile('rma.html',{root:projectRoot});});
  app.get(['/quiz','/quiz/','/tu-van-combo','/tu-van-combo/'],(_req,res)=>{res.set('Cache-Control','no-store').sendFile('quiz.html',{root:projectRoot});});
  app.use(require('./lib/avif-optimizer').avifNegotiationMiddleware({ rootDirs: [path.join(projectRoot, 'assets'), projectRoot] }));
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
      const isSyntaxOrBody = error instanceof SyntaxError || error.type === 'entity.parse.failed' || status === 413 || !error.message;
      return res.status(status).json({ error: status === 413 ? "Dữ liệu gửi lên quá lớn." : (isSyntaxOrBody ? "Yêu cầu không hợp lệ." : error.message) });
    }
    console.error("Request failed:", {name:error.name||'Error',code:error.code||'INTERNAL_ERROR'});
    res.status(500).json({ error: "Đã xảy ra lỗi hệ thống. Vui lòng thử lại sau." });
  });

  return app;
}

module.exports = { createApp };
