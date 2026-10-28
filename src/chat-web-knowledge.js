const { getExternalWebKnowledge } = require('./chat-external-knowledge');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const EXCLUDED_HTML = new Set(['cart.html', 'checkout.html', 'payment-result.html', 'sitemap.html']);

let cachedPages = null;
let cachedPagesAt = 0;
const PAGE_CACHE_TTL_MS = 300000;

const liveDbCache = new WeakMap();
const LIVE_DB_TTL_MS = 30000;

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase();
}

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&bull;|&middot;/gi, '·')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function extractPageKnowledge(fileName, html) {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const descMatch = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)
    || /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i.exec(html);
  const title = decodeHtmlEntities(titleMatch ? titleMatch[1] : fileName).replace(/\s+/g, ' ').trim();
  const description = decodeHtmlEntities(descMatch ? descMatch[1] : '').replace(/\s+/g, ' ').trim();

  const mainMatch = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  let bodyHtml = mainMatch ? mainMatch[1] : html;
  bodyHtml = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<dialog[\s\S]*?<\/dialog>/gi, ' ')
    .replace(/<\/(h[1-6]|p|li|tr|section|article|div)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  const cleanText = decodeHtmlEntities(bodyHtml)
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 2)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 3500);

  const url = fileName === 'index.html' ? 'https://gaeru.com/' : `https://gaeru.com/${fileName}`;
  const normalized = normalizeText(`${fileName} ${title} ${description} ${cleanText}`);
  return {
    file: fileName,
    url,
    title,
    description,
    content: cleanText,
    normalized
  };
}

function loadWebPagesIndex() {
  if (cachedPages && Date.now() - cachedPagesAt < PAGE_CACHE_TTL_MS) {
    return cachedPages;
  }
  const pages = [];
  try {
    const files = fs.readdirSync(ROOT_DIR).filter(f => f.endsWith('.html') && !EXCLUDED_HTML.has(f));
    for (const fileName of files) {
      try {
        const fullPath = path.join(ROOT_DIR, fileName);
        const raw = fs.readFileSync(fullPath, 'utf8');
        const page = extractPageKnowledge(fileName, raw);
        if (page.content.length > 20) pages.push(page);
      } catch {}
    }
  } catch {}
  cachedPages = pages;
  cachedPagesAt = Date.now();
  return pages;
}

async function loadLiveSiteFacts(pool) {
  if (!pool || typeof pool.query !== 'function') return {};
  const cached = liveDbCache.get(pool);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const facts = {};
  try {
    const [settingsRes, vouchersRes, campaignsRes, newsRes] = await Promise.all([
      pool.query("SELECT setting_key, setting_value FROM store_settings WHERE setting_key IN ('shipping_rates', 'shipping_note')").catch(() => ({ rows: [] })),
      pool.query("SELECT code, title, kind, amount, max_discount_vnd, min_spend_vnd, ends_at FROM marketing_vouchers WHERE active=true AND public_claim=true AND now() BETWEEN starts_at AND ends_at ORDER BY created_at DESC LIMIT 6").catch(() => ({ rows: [] })),
      pool.query("SELECT title, body, ends_at FROM marketing_campaigns WHERE active=true AND now() BETWEEN starts_at AND ends_at ORDER BY created_at DESC LIMIT 4").catch(() => ({ rows: [] })),
      pool.query("SELECT slug, title, excerpt AS summary FROM news_posts WHERE status='published' ORDER BY published_at DESC NULLS LAST, created_at DESC LIMIT 6").catch(error => { console.warn("AI news context unavailable", /^[A-Z0-9]{5}$/.test(error.code || "") ? error.code : "QUERY_FAILED"); return { rows: [] }; })
    ]);

    for (const row of settingsRes.rows || []) {
      if (row.setting_key === 'shipping_rates' && row.setting_value) facts.shippingRates = row.setting_value;
      if (row.setting_key === 'shipping_note' && row.setting_value) facts.shippingNote = row.setting_value;
    }
    if (vouchersRes.rows?.length) {
      facts.activeVouchers = vouchersRes.rows.map(v => ({
        code: v.code,
        title: v.title,
        discount: v.kind === 'percent' ? `${v.amount}%` : `${v.amount} VND`,
        maxDiscountVnd: v.max_discount_vnd,
        minSpendVnd: v.min_spend_vnd
      }));
    }
    if (campaignsRes.rows?.length) {
      facts.activeCampaigns = campaignsRes.rows.map(c => ({
        title: c.title,
        summary: String(c.body || '').slice(0, 350)
      }));
    }
    if (newsRes.rows?.length) {
      facts.latestNews = newsRes.rows.map(n => ({
        url: `https://gaeru.com/news-article.html?slug=${encodeURIComponent(n.slug)}`,
        title: n.title,
        summary: String(n.summary || '').slice(0, 240)
      }));
    }
  } catch {}

  liveDbCache.set(pool, { value: facts, expiresAt: Date.now() + LIVE_DB_TTL_MS });
  return facts;
}

async function getRelevantWebKnowledge(pool, { question = '', selectedProduct = null, transport = fetch } = {}) {
  const pages = loadWebPagesIndex();
  const qNorm = normalizeText(typeof question === 'string' ? question : JSON.stringify(question || ''));
  const tokens = qNorm.split(/[^a-z0-9]+/).filter(t => t.length >= 2);
  const productNorm = selectedProduct ? normalizeText(`${selectedProduct.slug || ''} ${selectedProduct.name || ''}`) : '';

  const scored = pages.map(page => {
    let score = 0;
    if (productNorm) {
      if (productNorm.includes('k9') && page.file.includes('k9')) score += 25;
      if (productNorm.includes('m3') && page.file.includes('m3')) score += 25;
      if (productNorm.includes('p01') && page.file.includes('p01')) score += 25;
      if ((productNorm.includes('g1') || productNorm.includes('ultra')) && page.file.includes('g1')) score += 25;
    }
    if (/huong dan|ket noi|su dung|cach dung|sac|pin|bluetooth|usb|type c|lightning/.test(qNorm) && page.file.startsWith('guide')) score += 18;
    if (/bao hanh|care|doi moi|sua chua|kich hoat/.test(qNorm) && (page.file === 'care.html' || page.file === 'warranty-activation.html' || page.file === 'product-support.html')) score += 20;
    if (/giao hang|van chuyen|ship|doi tra|hoan tien|nhan hang/.test(qNorm) && page.file === 'delivery-returns.html') score += 20;
    if (/thanh toan|vnpay|momo|zalopay|9pay|chuyen khoan|cod|tra gop/.test(qNorm) && page.file === 'payment.html') score += 20;
    if (/gia|bang gia|uu dai|khuyen mai/.test(qNorm) && (page.file === 'pricing.html' || page.file === 'shop.html')) score += 15;
    if (/khieu nai|gop y|tranh chap/.test(qNorm) && page.file === 'complaints.html') score += 18;
    if (/chinh sach|dieu khoan|bao mat/.test(qNorm) && (page.file === 'terms.html' || page.file === 'privacy.html' || page.file === 'legal.html')) score += 15;

    for (const token of tokens) {
      if (page.file.includes(token)) score += 6;
      if (normalizeText(page.title).includes(token)) score += 4;
      if (page.normalized.includes(token)) score += 2;
    }
    return { page, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const topPages = scored
    .filter((item, index) => item.score > 0 || index < 2)
    .slice(0, 3)
    .map(({ page }) => ({
      url: page.url,
      title: page.title,
      excerpt: page.content.slice(0, 1200)
    }));

  const [liveFacts, externalKnowledge] = await Promise.all([
    loadLiveSiteFacts(pool),
    getExternalWebKnowledge({ question, selectedProduct, transport }).catch(() => ({ ecosystemFacts: [], searchSnippets: [] }))
  ]);
  return {
    webPages: topPages,
    externalKnowledge,
    ...liveFacts
  };
}

module.exports = {
  loadWebPagesIndex,
  loadLiveSiteFacts,
  getRelevantWebKnowledge
};
