const {createAdminNotifications}=require('./admin-notifications');
const {createNewsAI}=require("./news-ai");
const {createCatalogVideos}=require('./catalog-videos');
const {createProductWorkspace}=require("./product-workspace");
const {createAccountSecurity}=require("./account-security");
const {createNewsPublicApi,createNewsAdminApi}=require("./news-api");
const fs = require("node:fs");
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

function attachTransactionalCacheInvalidation(pool) {
  if (!pool || typeof pool.query !== 'function' || pool.__gaeruCacheHooked) return pool;
  const isCatalogOrPageMutation = sql => typeof sql === 'string' && /^\s*(?:INSERT|UPDATE|DELETE)\b[\s\S]*\b(?:products|product_variants|product_presentations|product_promotions|product_promotion_variants|catalog_images|news_posts|news_images|site_pages|store_settings|marketing_banner_images|site_asset_snapshots)\b/i.test(sql);
  const isBeginSql = sql => typeof sql === 'string' && /^\s*(?:BEGIN|START\s+TRANSACTION)\b/i.test(sql);
  const isCommitSql = sql => typeof sql === 'string' && /^\s*(?:COMMIT|END)\b/i.test(sql);
  const isRollbackSql = sql => typeof sql === 'string' && /^\s*ROLLBACK\b(?!\s+TO\b)/i.test(sql);
  const flushCatalogCaches = () => {
    const cacheMod = require('./cache');
    cacheMod.clearHtmlCacheOnly();
    cacheMod.ramCache.delete('data:catalog');
    cacheMod.invalidateTags(['products', 'catalog', 'promotions'], { immediate: true });
    require('./site-pages').clearSitePagesCache(pool);
    require('./lib/image-renditions').clearImageLookupCache(pool);
    require('./persistent-assets').clearAssetSnapshotCache(pool);
  };
  const extractSqlText = sql => (typeof sql === 'object' && sql !== null ? sql.text : sql);
  const rawPoolQuery = pool.query.bind(pool);
  const wrapAutocommitQuery = fn => function(sql, values, cb) {
    const onDone = err => { if (!err && isCatalogOrPageMutation(extractSqlText(sql))) flushCatalogCaches(); };
    if (typeof values === 'function') {
      const origCb = values;
      return fn.call(this, sql, (err, res) => { onDone(err); origCb(err, res); });
    }
    if (typeof cb === 'function') {
      return fn.call(this, sql, values, (err, res) => { onDone(err); cb(err, res); });
    }
    const p = fn.call(this, sql, values);
    if (p && typeof p.then === 'function') {
      return p.then(res => { onDone(null); return res; });
    }
    return p;
  };
  const wrapClientQuery = (client, fn) => function(sql, values, cb) {
    const text = extractSqlText(sql);
    const afterSuccess = () => {
      if (isBeginSql(text)) {
        client.__gaeruInTx = true;
        client.__gaeruDirtyCatalog = false;
      } else if (isRollbackSql(text)) {
        client.__gaeruInTx = false;
        client.__gaeruDirtyCatalog = false;
      } else if (isCommitSql(text)) {
        const wasDirty = Boolean(client.__gaeruDirtyCatalog);
        client.__gaeruInTx = false;
        client.__gaeruDirtyCatalog = false;
        if (wasDirty) flushCatalogCaches();
      } else if (isCatalogOrPageMutation(text)) {
        if (client.__gaeruInTx) {
          client.__gaeruDirtyCatalog = true;
        } else {
          flushCatalogCaches();
        }
      }
    };
    if (typeof values === 'function') {
      const origCb = values;
      return fn.call(this, sql, (err, res) => { if (!err) afterSuccess(); origCb(err, res); });
    }
    if (typeof cb === 'function') {
      return fn.call(this, sql, values, (err, res) => { if (!err) afterSuccess(); cb(err, res); });
    }
    const p = fn.call(this, sql, values);
    if (p && typeof p.then === 'function') {
      return p.then(res => { afterSuccess(); return res; });
    }
    return p;
  };
  pool.query = wrapAutocommitQuery(rawPoolQuery);
  if (typeof pool.connect === 'function') {
    const origConnect = pool.connect;
    pool.connect = function(cb) {
      const hookClient = client => {
        if (client && typeof client.query === 'function' && !client.__gaeruCacheHooked) {
          const baseClientQuery = client.query === pool.query ? rawPoolQuery : client.query.bind(client);
          client.__gaeruInTx = false;
          client.__gaeruDirtyCatalog = false;
          client.query = wrapClientQuery(client, baseClientQuery);
          if (typeof client.release === 'function') {
            const origRelease = client.release.bind(client);
            client.release = (...args) => {
              client.__gaeruInTx = false;
              client.__gaeruDirtyCatalog = false;
              return origRelease(...args);
            };
          }
          Object.defineProperty(client, '__gaeruCacheHooked', { value: true });
        }
        return client;
      };
      if (typeof cb === 'function') {
        return origConnect.call(this, (err, client, done) => {
          if (!err && client) hookClient(client);
          cb(err, client, done);
        });
      }
      return origConnect.call(this).then(hookClient);
    };
  }
  Object.defineProperty(pool, '__gaeruCacheHooked', { value: true });
  return pool;
}

function createApp({ config, pool, sessionStore, customerMailer, oauthClient = null }) {
  if (!sessionStore) throw new Error("A persistent session store must be provided.");
  require('./cache').clearHtmlCacheOnly();
  attachTransactionalCacheInvalidation(pool);
  const app = express();
  app.use(require('./lib/readiness-gate').readinessMiddleware);
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
    if (/^\/(?:tai-khoan|thanh-toan|gio-hang|ket-qua-thanh-toan|gaeru_ceo)(?:\/|$)/i.test(req.path)||/^\/(?:account|checkout|cart|payment-result)\.(?:html|js)$/i.test(req.path)) {
      res.set({'Cache-Control':'private, no-store, max-age=0','CDN-Cache-Control':'no-store','Cloudflare-CDN-Cache-Control':'no-store','Surrogate-Control':'no-store','Pragma':'no-cache','Expires':'0'});res.vary('Cookie');
    }
    res.set('Permissions-Policy',/^\/gaeru_ceo(?:\/|$)/.test(req.path)?'camera=(self), microphone=(), geolocation=()':'camera=(), microphone=(), geolocation=()');
    next();
  });
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", require('./speculation-policy').cspHash, "https://challenges.cloudflare.com", "https://accounts.google.com", "https://apis.google.com", "https://ssl.gstatic.com", "https://*.gstatic.com"],
        frameSrc: ["'self'", "https://challenges.cloudflare.com", "https://accounts.google.com", "https://apis.google.com", "https://ssl.gstatic.com", "https://*.gstatic.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://accounts.google.com", "https://ssl.gstatic.com", "https://*.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:", "https://*.googleusercontent.com", "https://ssl.gstatic.com", "https://*.gstatic.com"],
        connectSrc: ["'self'", "https://challenges.cloudflare.com", "https://accounts.google.com", "https://apis.google.com", "https://*.googleapis.com", "https://ssl.gstatic.com", "https://*.gstatic.com"],
        mediaSrc: ["'self'", "blob:", "https://gaeru.com"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.NODE_ENV === "production" ? [] : null
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
  app.get("/api/health", async (req, res, next) => {
    try {
      await pool.query("SELECT 1");
      res.set({'Cache-Control':'no-store','X-GAERU-Web-TLS':req.secure?'observed_https':'observed_http','X-GAERU-Media-Backend':require('./lib/filesystem-media').status().provider+'-'+(require('./lib/filesystem-media').status().verified?'ready':'unverified'),'X-GAERU-Media-Local-References':require('./media-storage-audit').auditStatus().state,'X-GAERU-Media-Volume':require('./lib/filesystem-media').status().volumeFingerprint||'unverified','X-GAERU-Media-Error':require('./lib/filesystem-media').status().errorCode||'none','X-GAERU-Media-Persistence':require('./lib/filesystem-media').status().verified?(require('./lib/filesystem-media').status().persistenceMarkerFound?'seen':'new'):'unverified'}).json({ status: "ok" });
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

  const { sseHandler } = require("./realtime-sse");
  app.get("/api/realtime", sseHandler);

  app.use("/api/auth", createAdminAuthRouter(config, pool));
  app.use("/api/customer/cart", require("./customer-cart").createCustomerCartRouter(pool));
  app.use("/api/customer", createCustomerExperience(pool, { inventory, audit: appendAudit }));
  app.use("/api/customer/care", createCareCustomerApi(pool, config));
  app.use("/api/customer/warranties", createWarrantyCustomerApi(pool));
  app.use("/api/warranty-requests", createWarrantyPublicApi(pool));
  app.use("/api/customer-auth",require("./checkout-account").setupRouter(pool));
  app.use("/api/customer-auth/contact-change", createContactChangeApi(pool, {smtpConfig:config.smtp,mailer:customerMailer}));
  const customerOAuthRouter = require("./customer-oauth").createCustomerOAuthRouter(pool, {
    config,
    accountSecurity: config.accountSecurity,
    oauthClient: oauthClient || config.oauthClient || null,
    startCustomerSession: require("./customer-auth").startCustomerSession
  });
  app.use("/api/customer-auth/oauth", customerOAuthRouter);
  if (customerOAuthRouter.handleRedirectCallback) {
    app.post(['/auth/google', '/account.html', '/tai-khoan', '/account'], express.urlencoded({ extended: false, limit: '32kb' }), customerOAuthRouter.handleRedirectCallback);
  }
  app.get('/account/link-required', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const emailParam = req.query.email ? '&email=' + encodeURIComponent(req.query.email) : '';
    res.redirect(303, '/account.html?linkRequired=1' + emailParam);
  });
  app.post('/api/auth/link-google', requireCsrf, customerOAuthRouter.handleLinkGoogle);
  app.post('/api/auth/unlink-google', requireCsrf, customerOAuthRouter.handleUnlinkGoogle);

  app.get('/api/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const customer = req.session?.customer;
    if (!customer) return res.status(401).json({ error: 'Chưa đăng nhập' });
    res.json({
      id: customer.id,
      displayName: customer.fullName || customer.email,
      fullName: customer.fullName,
      email: customer.email,
      phone: customer.phone,
      emailVerified: Boolean(customer.emailVerified)
    });
  });

  app.post('/auth/logout', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const secFetchSite = String(req.get('sec-fetch-site') || '').trim().toLowerCase();
    if (secFetchSite && !['same-origin', 'none'].includes(secFetchSite)) {
      return res.sendStatus(403);
    }

    const trustedOrigins = new Set();
    const trustedHosts = new Set();
    const rawHost = String(req.get('host') || '').trim();
    if (rawHost) {
      try {
        const proto = req.protocol === 'https' ? 'https:' : 'http:';
        const parsedReqHost = new URL(`${proto}//${rawHost}`);
        trustedHosts.add(parsedReqHost.host.toLowerCase());
        trustedOrigins.add(`${parsedReqHost.protocol}//${parsedReqHost.host}`.toLowerCase());
      } catch {
        return res.sendStatus(403);
      }
    }
    if (config.PUBLIC_BASE_URL) {
      try {
        const parsedPublic = new URL(config.PUBLIC_BASE_URL);
        trustedHosts.add(parsedPublic.host.toLowerCase());
        trustedOrigins.add(parsedPublic.origin.toLowerCase());
      } catch {}
    }

    const matchesTrustedOrigin = (rawUrl) => {
      try {
        const parsed = new URL(String(rawUrl));
        if (!['http:', 'https:'].includes(parsed.protocol)) return false;
        const normalizedOrigin = parsed.origin.toLowerCase();
        const normalizedHost = parsed.host.toLowerCase();
        return trustedOrigins.has(normalizedOrigin) || trustedHosts.has(normalizedHost);
      } catch {
        return false;
      }
    };

    const origin = req.get('origin');
    const referer = req.get('referer');
    if (origin) {
      if (!matchesTrustedOrigin(origin)) return res.sendStatus(403);
    } else if (referer) {
      if (!matchesTrustedOrigin(referer)) return res.sendStatus(403);
    }

    const providedCsrf = String(req.get('x-csrf-token') || req.body?._csrf || '');
    const sessionCsrf = String(req.session?.csrfToken || '');
    const crypto = require('node:crypto');
    const hasValidCsrf = Boolean(
      providedCsrf &&
      sessionCsrf &&
      Buffer.byteLength(providedCsrf) === Buffer.byteLength(sessionCsrf) &&
      crypto.timingSafeEqual(Buffer.from(providedCsrf), Buffer.from(sessionCsrf))
    );
    const hasLogoutHeader = req.get('x-gaeru-action') === 'logout';

    if (!origin && !referer && !hasValidCsrf && !hasLogoutHeader) {
      return res.sendStatus(403);
    }
    if (providedCsrf && sessionCsrf && !hasValidCsrf) {
      return res.sendStatus(403);
    }

    req.session.regenerate((err) => {
      if (err) return next(err);
      res.clearCookie('connect.sid');
      res.clearCookie('gaeru.sid');
      res.sendStatus(204);
    });
  });
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
  app.get("/api/gaeru_ceo/system-health", async (req, res, next) => {
    try {
      const health = await getSystemHealth(pool, config, req);
      res.set("Cache-Control", "no-store").json(health);
    } catch (err) {
      next(err);
    }
  });
  app.use('/api/gaeru_ceo', require('./operations-queues').createOperationsQueues(pool, config));
  app.use("/api/gaeru_ceo", require("./media-diagnostics").createMediaDiagnostics());
  app.use('/api/gaeru_ceo', require('./ai-knowledge-admin').createKnowledgeAdmin(pool));
  app.use('/api/gaeru_ceo', require('./chat-compression-admin').createChatCompressionAdmin(pool));
  app.use("/api/gaeru_ceo", require("./file-library").createFileLibrary(pool));
  app.use("/api/gaeru_ceo", require("./site-pages").createPagesAdmin(pool));
  app.use("/api/gaeru_ceo", require("./order-review").reviewRouter(pool,config));
  app.use("/api/gaeru_ceo", require("./order-after-sales").afterSalesRouter(pool));
  app.use("/api/gaeru_ceo", require("./cod-return-intake").createCodReturnIntake(pool));
  const rmaApi = require("./rma-tickets").createRmaApi(pool, config);
  app.use("/api", rmaApi.publicApi);
  app.use("/api/gaeru_ceo", rmaApi.admin);
  app.use("/api/gaeru_ceo", require("./order-print").createOrderPrint(pool));
  app.use("/api/gaeru_ceo", require("./shipping-choice").createShippingAdmin(pool,config));
  const shippingMgmt = require("./shipping-management").createShippingManagement(pool, config, { finance: { receiptTotal, recordFullOrderPayment } });
  app.use("/api/gaeru_ceo", shippingMgmt.admin);
  app.use("/api", shippingMgmt.publicApi);
  const trackingApi = require("./tracking-api").createTrackingApi(pool, config);
  app.use("/api", trackingApi);
  app.use("/api/gaeru_ceo", require("./payment-channels").createPaymentAdmin(pool,config,{finance:{receiptTotal,recordFullOrderPayment}}));
  app.use("/api/gaeru_ceo", createAdminNotifications(pool,config));
  app.use("/api/gaeru_ceo",require("./account-retention").createRetentionAdmin(pool,config,customerMailer));
  app.use("/api/gaeru_ceo", createStaffApi(pool, config));
  app.use("/api/gaeru_ceo", createOperationsApi(pool));
  app.use("/api/gaeru_ceo", require("./inventory-forecast").createInventoryForecastApi(pool));
  app.use("/api/gaeru_ceo/inventory", require("./inventory-forecast").createInventoryForecastApi(pool));
  app.use("/api/gaeru_ceo", createFinanceApi(pool));
  app.use("/api/gaeru_ceo", createCareAdminApi(pool, config));
  app.use("/api/gaeru_ceo", createOwnerApi(pool, config));
  app.use("/api/gaeru_ceo", createWarrantyAdminApi(pool));
  app.use("/api/gaeru_ceo", createBusinessApi(pool, config));
  app.use("/api/gaeru_ceo", createNewsAI(pool,config));
  app.use("/api/gaeru_ceo", createNewsAdminApi(pool));
  app.use("/api", createNewsPublicApi(pool));
  app.use("/api/gaeru_ceo",require("./admin-configuration").createAdminConfiguration(pool,config));
  app.use('/api/gaeru_ceo',require('./tiktok-ads').createTikTokAdsAdmin(pool,config));
  const emailMarketing=require("./email-marketing").createEmailMarketing(pool,config,{mailer:customerMailer});
  app.use("/api/gaeru_ceo",emailMarketing.admin);
  app.use("/api/marketing-email",emailMarketing.publicApi);
  const chat=require("./shopping-chat").createShoppingChat(pool,config);app.use("/api/shopping-chat",chat.publicApi);app.use("/api/gaeru_ceo",chat.admin);
  const realtime=require("./realtime-sse").createRealtimeRouter({pool,config});
  app.use("/api/gaeru_ceo",realtime.adminRouter);
  app.use("/api/shopping-chat",realtime.publicRouter);
  app.use("/api/customer",realtime.publicRouter);
  const homeBanner=require("./home-banner").createHomeBanner(pool);
  app.use("/api/gaeru_ceo",homeBanner.admin);
  app.use("/api",homeBanner.publicApi);
  const marketing=require("./marketing").createMarketing(pool);
  app.use("/api/gaeru_ceo",marketing.admin);
  app.use("/api/customer/marketing",marketing.customer);
  const abandonedCart=require("./abandoned-cart").createAbandonedCartApi(pool,config,{mailer:customerMailer});
  app.use("/api/gaeru_ceo",abandonedCart.admin);
  app.use("/api/abandoned-cart",abandonedCart.publicApi);
  const barcode=require("./barcode-api").createBarcodeApi(pool,config);
  app.use("/api/gaeru_ceo",barcode.admin);
  const omnichannel=require("./omnichannel-sync").createOmnichannelSync(pool,config);
  app.use("/api/gaeru_ceo",omnichannel.admin);
  app.use("/api",omnichannel.publicApi);
  const loyalty=require("./loyalty-api").createLoyaltyApi(pool);
  app.use("/api/gaeru_ceo",loyalty.admin);
  app.use("/api/customer",loyalty.customer);
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

  const managementAssets=new Set(['marketing-home-banner.js','marketplace-sync.js','marketplace-sync.css','ai-knowledge.js','operational-tools.js','operational-tools.css','chat-compression-jobs.js','barcode.js','file-library.js','file-library.css','pages.js','order-print.js','after-sales.js','cod-return.js','orders-workspace.css','order-review.js','admin.css','admin.js','business.js','care.js','enterprise.css','enterprise.js','news-ai.css','news.js','owner.js','product-editor.css','product-editor.js','description-editor.js','warranty.js','notifications.js','notifications.css','admin-ui.js','admin-refinement.css','admin-workspace.css','admin-mobile.css','configuration.js','tiktok-ads.js','marketing.js','email-marketing.js','shopping-chat.js','shopping-chat.css','pwa-install.js']);
  const projectRoot=path.join(__dirname,'..'),adminRoot=path.join(projectRoot,'admin');
  app.get('/gaeru_ceo/notification-worker.js',(_req,res)=>res.set({'Cache-Control':'no-store','Service-Worker-Allowed':'/gaeru_ceo/'}).sendFile('notification-worker.js',{root:adminRoot}));
  app.get(['/gaeru_ceo/manifest.webmanifest','/gaeru_ceo/manifest.json'],(_req,res)=>res.set({'Content-Type':'application/manifest+json; charset=utf-8','Cache-Control':'no-store'}).sendFile('manifest.webmanifest',{root:adminRoot}));
  app.get('/gaeru_ceo/pwa-qr.png',async(req,res,next)=>{
    try{
      const QRCode=require('qrcode');
      let target=`${req.protocol}://${req.get('host')||'gaeru.com'}/gaeru_ceo`;
      if(typeof req.query.url==='string'&&/^https?:\/\//i.test(req.query.url)){
        try{
          const parsed=new URL(req.query.url);
          const host=parsed.hostname.toLowerCase();
          const currentHost=(req.get('host')||'gaeru.com').split(':')[0].toLowerCase();
          if(host===currentHost||host==='gaeru.com'||host.endsWith('.gaeru.com')||host==='localhost'||host==='127.0.0.1'){
            target=parsed.href;
          }
        }catch(_){}
      }
      const buf=await QRCode.toBuffer(target,{width:280,margin:1,errorCorrectionLevel:'M',color:{dark:'#0f172a',light:'#ffffff'}});
      res.set({'Content-Type':'image/png','Cache-Control':'public, max-age=86400'}).send(buf);
    }catch(err){next(err);}
  });
  app.get('/gaeru_ceo/assets/zxing-browser.min.js',(_req,res)=>res.set('Cache-Control','no-store').sendFile('zxing-browser.min.js',{root:path.join(projectRoot,'node_modules','@zxing','browser','umd')}));
  app.get('/gaeru_ceo/assets/:file',(req,res,next)=>{
    if(!managementAssets.has(req.params.file))return res.sendStatus(404);
    res.set('Cache-Control','no-store');
    const rootDir=fs.existsSync(path.join(adminRoot,req.params.file))?adminRoot:projectRoot;res.sendFile(req.params.file,{root:rootDir},error=>{if(error)next(error);});
  });
  app.get(["/gaeru_ceo/products/new","/gaeru_ceo/products/:id/edit"],(_req,res)=>{res.set("Cache-Control","no-store").sendFile("product-editor.html",{root:adminRoot});});
  app.get("/gaeru_ceo", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.sendFile("index.html", { root: adminRoot }, error => { if (error) next(error); });
  });
  app.get('/dict/shared-template.dict', require('./lib/compression-dictionary').serveDictionaryRoute);
  app.use(require('./lib/early-hints').earlyHintsMiddleware);
  app.use(require('./traffic-tracker').createTrafficTracker(pool));
  app.use(require('./site-pages').pageMetadata(pool));
  app.use(require('./clean-routes').cleanRoutes(new URL(config.PUBLIC_BASE_URL||'https://gaeru.com').origin));

  app.use(require('./cache').smartPageCache());
  app.use(require('./product-guides').createProductGuidePages(pool));
  app.get(['/dang-ky-bao-hanh','/dang-ky-bao-hanh/'],(_req,res)=>{res.set('Cache-Control','no-store').sendFile('warranty-activation.html',{root:projectRoot});});
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
    const isAsset=pathname==='/assets/data/vietnam-addresses.json' || (pathname.startsWith('/assets/') || pathname.startsWith('/public/')) && /\.(?:png|jpe?g|webp|gif|svg|ico|avif|woff2?|ttf|mp4|webm|pdf)$/i.test(pathname);
    if(!isFile&&!isAsset)return res.set('Cache-Control','no-store').sendStatus(404);
    next();
  });

  app.use(require('./clean-routes').staticHtml);
  app.use(express.static(path.join(__dirname, ".."), {
    dotfiles: "deny",
    index: "index.html",
    setHeaders(res, file) {
      if (/-[0-9a-f]{8,32}\.(?:js|css|webp|png|jpe?g|woff2?|avif)$/i.test(file)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (/\.(?:js|css|webp|png|jpe?g|woff2?)$/i.test(file)) {
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      }
      if (path.extname(file) === '.html') {
        res.setHeader('Cache-Control', 'no-cache');
      }
      if (['account.html', 'account.js'].includes(path.basename(file))) {
        res.setHeader('Cache-Control', 'no-store');
      }
    },
    etag: true,
    lastModified: true,
    maxAge: 0
  }));

  app.use((error, req, res, _next) => {
    if (res.headersSent) return;
    if(error.code==='IMAGE_PROCESSING_BUSY')return res.status(503).json({error:'Đang tối ưu nhiều ảnh. Vui lòng thử lại sau.'});
    if(error.code==='MEDIA_STORAGE_UNAVAILABLE')return res.status(503).json({error:'Chưa lưu được tệp vào kho lưu trữ. Vui lòng thử lại.'});
    const status = Number.isInteger(error.status) ? error.status : error.statusCode;
    if (error.code && typeof error.code === 'string') {
      const isCodRelated = ['cod_settlement_allocations', 'cod_settlement_batches', 'carrier_shipments', 'sales_receipts'].includes(error.table) ||
        (typeof error.constraint === 'string' && /cod_settlement|cap_check|sales_receipts/.test(error.constraint));
      if (isCodRelated) {
        if (error.code === '23505') {
          const msg = error.table === 'cod_settlement_allocations' || (typeof error.constraint === 'string' && error.constraint.includes('cod_settlement_allocations'))
            ? 'Đơn hàng này đã có chứng từ phân bổ đối soát COD trong hệ thống.'
            : error.table === 'cod_settlement_batches' || (typeof error.constraint === 'string' && error.constraint.includes('cod_settlement_batches'))
            ? 'Mã giao dịch sao kê đã được sử dụng cho một lô đối soát khác của hãng này.'
            : 'Chứng từ thu tiền hoặc mã đối soát thanh toán đã tồn tại trong sổ quỹ.';
          return res.status(409).json({ error: msg });
        }
        if (error.code === '23514') {
          const msg = (typeof error.constraint === 'string' && error.constraint.includes('cap_check'))
            ? 'Tổng tiền phân bổ vượt quá tổng tiền sao kê khai báo của lô đối soát.'
            : 'Trạng thái đối soát của vận đơn không hợp lệ.';
          return res.status(409).json({ error: msg });
        }
        if (error.code === '40P01' || error.code === '40001') {
          return res.status(409).json({ error: 'Hệ thống đang xử lý đồng thời yêu cầu khác trên đơn hàng này. Vui lòng thử lại sau giây lát.' });
        }
      }
    }
    if ([502,503,504].includes(status)) return res.status(status).json({ error: error.message || (status===504 ? 'Dịch vụ kết nối phản hồi quá chậm. Vui lòng thử lại.' : 'Dịch vụ kết nối chưa trả dữ liệu hợp lệ. Vui lòng thử lại.') });
    if (status >= 400 && status < 500) {
      const isSyntaxOrBody = error instanceof SyntaxError || error.type === 'entity.parse.failed' || status === 413 || !error.message;
      return res.status(status).json({ error: status === 413 ? "Dữ liệu gửi lên quá lớn." : (isSyntaxOrBody ? "Yêu cầu không hợp lệ." : error.message) });
    }
    const sanitizeErrorMessage = (msg) => {
      if (!msg || typeof msg !== 'string') return '';
      return msg
        .replace(/(?:password|secret|token|key|authorization|bearer)[=:\s]+[^\s,;&]+/gi, '[REDACTED]')
        .replace(/postgres(?:ql)?:\/\/[^\s@]+@[^\s\/]+/gi, 'postgres://[REDACTED]@[HOST]');
    };
    const isProd = (config?.NODE_ENV || process.env.NODE_ENV) === 'production';
    console.error("Request failed:", {
      name: error.name || 'Error',
      code: error.code || 'INTERNAL_ERROR',
      message: isProd ? sanitizeErrorMessage(error.message) : error.message,
      ...(isProd ? {} : { stack: error.stack })
    });
    const isAdminRoute = Boolean(req && ((typeof req.originalUrl === 'string' && /^\/api\/gaeru_ceo(?:\/|$)/i.test(req.originalUrl)) || (typeof req.path === 'string' && /^\/gaeru_ceo(?:\/|$)/i.test(req.path)) || req.admin));
    res.status(500).json({ error: isAdminRoute ? ("Lỗi hệ thống: " + sanitizeErrorMessage(error.message)) : "Đã xảy ra lỗi hệ thống. Vui lòng thử lại sau." });
  });

  return app;
}

module.exports = { createApp, attachTransactionalCacheInvalidation };
