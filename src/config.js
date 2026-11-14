const { z } = require("zod");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  AUTH_ENCRYPTION_KEY: z.string().min(32).optional(),
  ADMIN_USERNAME: z.string().min(3).max(100),
  ADMIN_PASSWORD_HASH: z.string().regex(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/),
  PGSSL_CA: z.string().min(1).optional(),
  PGSSL: z.enum(["disable", "require"]).default("disable"),
  PGSSL_MIN_VERSION: z.enum(["TLSv1.2", "TLSv1.3"]).default("TLSv1.2"),
  STORE_ORDERS_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  PUBLIC_BASE_URL: z.string().url().refine((value) => {
    if (!URL.canParse(value)) return false;
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === "/";
  }, "Must be an HTTPS origin without credentials, path, query, or fragment").optional(),
  VNPAY_TMN_CODE: z.string().trim().regex(/^[A-Za-z0-9]{8}$/).optional(),
  VNPAY_HASH_SECRET: z.string().min(1).optional(),
  VNPAY_PAYMENT_URL: z.string().url().refine((value) => /^https:\/\//i.test(value), "Must use HTTPS").optional(),
  TURNSTILE_SITE_KEY: z.string().trim().min(1).max(200).optional(),
  TURNSTILE_SECRET_KEY: z.string().trim().min(1).max(500).optional(),
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  OPENAI_CHAT_MODEL: z.string().trim().regex(/^[a-zA-Z0-9._-]{1,100}$/).default('gpt-4.1-mini'),
  OPENAI_NEWS_MODEL: z.string().trim().regex(/^[a-zA-Z0-9._-]{1,100}$/).default('gpt-4.1-mini'),
  SMTP_HOST: z.string().trim().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  SMTP_SECURE: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  SMTP_FROM: z.string().email().optional(),
  SMTP_REPLY_TO: z.string().trim().email().optional().or(z.literal('').transform(() => undefined)),
  ADMIN_DOMAIN_EMAIL: z.string().trim().email().optional().or(z.literal('').transform(() => undefined)),
  VAPID_PUBLIC_KEY: z.string().trim().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().trim().min(1).optional(),
  VAPID_SUBJECT: z.string().trim().min(1).optional(),
  GOOGLE_CLIENT_ID: z.string().trim().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().trim().min(1).optional(),
  GA_MEASUREMENT_ID: z.string().trim().regex(/^G-[A-Z0-9]+$/i).optional().or(z.literal('').transform(() => undefined)),
  GOOGLE_ANALYTICS_ID: z.string().trim().regex(/^G-[A-Z0-9]+$/i).optional().or(z.literal('').transform(() => undefined)),
  PG_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(200).optional(),
  PG_POOL_SIZE: z.coerce.number().int().min(1).max(200).optional(),
  DDOS_RATE_LIMIT: z.coerce.number().int().min(100).max(100000).optional(),
  CACHE_RAM_MAX_ENTRIES: z.coerce.number().int().min(100).max(100000).optional(),
  CACHE_RAM_MAX_MB: z.coerce.number().int().min(16).max(4096).optional()
}).superRefine((values, context) => {
  if((values.TURNSTILE_SITE_KEY||values.TURNSTILE_SECRET_KEY)&&(!values.TURNSTILE_SITE_KEY||!values.TURNSTILE_SECRET_KEY||!values.PUBLIC_BASE_URL))context.addIssue({code:'custom',message:'TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY và PUBLIC_BASE_URL phải được cấu hình cùng nhau.'});
  const vnpayConfigured = Boolean(values.VNPAY_TMN_CODE || values.VNPAY_HASH_SECRET || values.VNPAY_PAYMENT_URL);
  if (vnpayConfigured && (!values.VNPAY_TMN_CODE || !values.VNPAY_HASH_SECRET || !values.PUBLIC_BASE_URL || !values.VNPAY_PAYMENT_URL)) {
    context.addIssue({ code: "custom", message: "VNPAY_TMN_CODE, VNPAY_HASH_SECRET, PUBLIC_BASE_URL và VNPAY_PAYMENT_URL phải được cấu hình cùng nhau." });
  }
  const smtpConfigured = Boolean(values.SMTP_HOST || values.SMTP_PORT || values.SMTP_USER || values.SMTP_PASSWORD || values.SMTP_FROM);
  if (smtpConfigured && (!values.SMTP_HOST || !values.SMTP_PORT || !values.SMTP_USER || !values.SMTP_PASSWORD || !values.SMTP_FROM || !values.PUBLIC_BASE_URL)) {
    context.addIssue({ code: "custom", message: "SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM và PUBLIC_BASE_URL phải được cấu hình cùng nhau." });
  }
  if (values.NODE_ENV === "production" && !process.env.ALLOW_LEGACY_SESSION_ENCRYPTION) {
    if (!values.AUTH_ENCRYPTION_KEY || values.AUTH_ENCRYPTION_KEY === values.SESSION_SECRET) {
      context.addIssue({ code: "custom", path: ["AUTH_ENCRYPTION_KEY"], message: "AUTH_ENCRYPTION_KEY (>= 32 chars) phải được cấu hình riêng trong production và khác SESSION_SECRET." });
    }
  }
});

function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const config = parsed.data;
  const normalizeBrand=require('./primary-domain').normalizeBrandText;config.PUBLIC_BASE_URL=require('./primary-domain').normalizePublicBase(config.PUBLIC_BASE_URL);if(config.SMTP_FROM)config.SMTP_FROM=normalizeBrand(config.SMTP_FROM);if(config.SMTP_REPLY_TO)config.SMTP_REPLY_TO=normalizeBrand(config.SMTP_REPLY_TO).toLowerCase();if(config.ADMIN_DOMAIN_EMAIL)config.ADMIN_DOMAIN_EMAIL=normalizeBrand(config.ADMIN_DOMAIN_EMAIL).toLowerCase();
  const gaId = config.GA_MEASUREMENT_ID || config.GOOGLE_ANALYTICS_ID || undefined;
  return {
    ...config,
    GA_MEASUREMENT_ID: gaId,
    vnpay: config.VNPAY_TMN_CODE ? {
      tmnCode: config.VNPAY_TMN_CODE,
      hashSecret: config.VNPAY_HASH_SECRET,
      paymentUrl: config.VNPAY_PAYMENT_URL,
      returnUrl: new URL("/api/payments/vnpay/return", config.PUBLIC_BASE_URL).toString()
    } : null,
    smtp: config.SMTP_HOST ? {
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      user: config.SMTP_USER,
      password: config.SMTP_PASSWORD,
      from: config.SMTP_FROM,
      replyTo: config.SMTP_REPLY_TO || 'business@gaeru.com',
      adminDomainEmail: config.ADMIN_DOMAIN_EMAIL || undefined,
      publicBaseUrl: config.PUBLIC_BASE_URL
    } : null
  };
}

module.exports = { loadConfig };
