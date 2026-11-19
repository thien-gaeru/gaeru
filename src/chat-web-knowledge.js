const { getExternalWebKnowledge } = require('./chat-external-knowledge');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { parseHTML } = require('linkedom');
const { normalizeVi, expandQueryVi, hasAnyBoundaryTerm, tokenizeMeaningful, tokenOverlapScore } = require('./lib/ai-nlu');
const { embedText, embedTexts, cosineSimilarity } = require('./lib/gpu-ai-client');
const { ensureEmbeddings, rankByCosine } = require('./lib/embedding-store');

const ROOT_DIR = path.resolve(__dirname, '..');
const EXCLUDED_HTML = new Set([
  'cart.html',
  'checkout.html',
  'payment-result.html',
  'sitemap.html',
  'account.html',
  'product.html',
  'news.html',
  'news-article.html',
  'tracking.html',
  'index.html',
  'shop.html',
  'guides.html',
  'warranty-activation.html'
]);
const MAX_WEB_KNOWLEDGE_FILES = 100;
const BOILERPLATE_EXACT_LINES = new Set([
  'huong dan su dung',
  'gaeru trong cuoc song cua ban',
  'gaeru care+',
  'chi tiet thiet bi',
  'hieu ro truoc khi chon.',
  'giai dap nhanh',
  'truoc khi bat dau.',
  'chon phien ban',
  'thiet lap tung buoc',
  'van de thuong gap',
  'van can gaeru ho tro?',
  'can ho tro them?',
  'trinh duyet chua ho tro video.'
]);

function isNoiseKnowledgeLine(line) {
  const s = String(line || '').trim();
  if (!s || s.length < 12) return true;
  if (/[↗›]/.test(s)) return true;
  if (/^cập nhật gần nhất:/i.test(s)) return true;
  if (/^đang tải\b/i.test(s)) return true;
  if (/^gửi yêu cầu hỗ trợ\b/i.test(s)) return true;
  if (/^xem hướng dẫn sản phẩm khác\b/i.test(s)) return true;
  if (/^nguồn hình ảnh và video minh họa:/i.test(s)) return true;
  if (/^đối chiếu với phiên bản và hướng dẫn trong hộp/i.test(s)) return true;
  const norm = normalizeText(s);
  if (BOILERPLATE_EXACT_LINES.has(norm)) return true;
  return false;
}

let cachedPages = null;
let cachedPagesAt = 0;
let pendingPagesLoad = null;
let webPagesEpoch = 0;
const PAGE_CACHE_TTL_MS = 300000;

let liveDbCache = new WeakMap();
const LIVE_DB_TTL_MS = 30000;
const WEB_KNOWLEDGE_SYNC_TAGS = new Set(['*', 'catalog', 'products', 'product:list', 'gaeru-catalog', 'settings', 'store-config', 'payment-channels', 'promotions', 'news', 'site-pages']);

function clearWebKnowledgeCache() {
  webPagesEpoch++;
  cachedPages = null;
  cachedPagesAt = 0;
  pendingPagesLoad = null;
  liveDbCache = new WeakMap();
}

const WEB_KNOWLEDGE_IPC_KEY = Symbol.for('gaeru.webKnowledge.ipc');
if (!global[WEB_KNOWLEDGE_IPC_KEY]) {
  global[WEB_KNOWLEDGE_IPC_KEY] = true;
  if (typeof process.on === 'function') {
    process.on('message', (msg) => {
      if (msg?.type === 'AI_KNOWLEDGE_INVALIDATE') {
        clearWebKnowledgeCache();
      } else if (msg?.type === 'CACHE_INVALIDATE_TAGS' && Array.isArray(msg.tags) && msg.tags.some(t => WEB_KNOWLEDGE_SYNC_TAGS.has(String(t || '').trim()))) {
        clearWebKnowledgeCache();
      }
    });
  }
  try {
    require('./cache').cacheEvents.on('invalidated', (payload) => {
      if (Array.isArray(payload?.tags) && payload.tags.some(t => WEB_KNOWLEDGE_SYNC_TAGS.has(String(t || '').trim()))) {
        clearWebKnowledgeCache();
      }
    });
  } catch (_) {}
}

function normalizeText(value) {
  return normalizeVi(value);
}

function extractPageKnowledge(fileName, html) {
  // Parse markup once. DOM text/attributes decode entities exactly once and
  // parser-recognized closing tags cannot leak script/style/UI chrome text into knowledge.
  const { document } = parseHTML(String(html || ''));
  const compact = value => String(value || '').replace(/\s+/g, ' ').trim();
  const attribute = (node, name) => [...node.attributes].find(item => item.name.toLowerCase() === name)?.value || '';
  const title = compact(document.querySelector('title')?.textContent || fileName);
  const metadata = [...document.querySelectorAll('meta')].find(node => attribute(node, 'name').toLowerCase() === 'description');
  const description = compact(metadata ? attribute(metadata, 'content') : '');
  const root = document.querySelector('main') || document.querySelector('body') || document;
  for (const node of root.querySelectorAll(
    'script,style,svg,nav,footer,dialog,template,noscript,head,button,form,input,select,textarea,label,[aria-hidden="true"],.cta,.btn,.button,.guide-help,.guide-help-actions,.discover-hero-actions,.discover-faq-actions,.discover-close,.discover-close-actions,.guide-link,.text-link,.chat-product-button'
  )) {
    node.remove();
  }
  const blocks = new Set(['H1','H2','H3','H4','H5','H6','P','LI','TR','SECTION','ARTICLE','DIV','BR','SUMMARY','DETAILS']);
  for (const node of root.querySelectorAll('*')) {
    node.before(document.createTextNode(' '));
    if (blocks.has(node.tagName)) node.after(document.createTextNode('\n'));
  }
  const text = root.nodeType === 9 ? [...root.childNodes].map(node => node.textContent || '').join(' ') : root.textContent;
  const seenLocal = new Set();
  const cleanLines = [];
  for (const rawLine of String(text || '').split('\n')) {
    const line = compact(rawLine);
    if (line.length <= 2 || isNoiseKnowledgeLine(line)) continue;
    const normKey = normalizeText(line);
    if (!normKey || seenLocal.has(normKey)) continue;
    seenLocal.add(normKey);
    cleanLines.push(line);
  }
  const cleanText = cleanLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 12000);

  const substantive = cleanLines.filter(l => l.length >= 28).slice(0, 5).join(' ');
  const summaryText = `${title}. ${description ? `${description}. ` : ''}${substantive || cleanText}`
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);

  const url = fileName === 'index.html' ? 'https://gaeru.com/' : `https://gaeru.com/${fileName}`;
  const normalized = normalizeText(`${fileName} ${title} ${description} ${cleanText}`);
  return {
    file: fileName,
    url,
    title,
    description,
    content: cleanText,
    summaryText,
    normalized
  };
}

function selectKnowledgeHtmlFiles(entries) {
  return (entries || [])
    .filter(f => typeof f === 'string' && f.endsWith('.html') && !EXCLUDED_HTML.has(f))
    .slice(0, MAX_WEB_KNOWLEDGE_FILES);
}

function loadWebPagesIndex() {
  if (cachedPages && Date.now() - cachedPagesAt < PAGE_CACHE_TTL_MS) {
    return cachedPages;
  }
  const pages = [];
  try {
    const files = selectKnowledgeHtmlFiles(fs.readdirSync(ROOT_DIR));
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

async function loadWebPagesIndexAsync() {
  if (cachedPages && Date.now() - cachedPagesAt < PAGE_CACHE_TTL_MS) {
    return cachedPages;
  }
  if (pendingPagesLoad) return pendingPagesLoad;
  const loadEpoch = webPagesEpoch;
  const loadPromise = (async () => {
    const pages = [];
    try {
      const files = selectKnowledgeHtmlFiles(await fsPromises.readdir(ROOT_DIR));
      const CONCURRENCY = 16;
      for (let i = 0; i < files.length; i += CONCURRENCY) {
        const batch = files.slice(i, i + CONCURRENCY);
        const parsedBatch = await Promise.all(batch.map(async (fileName) => {
          try {
            const raw = await fsPromises.readFile(path.join(ROOT_DIR, fileName), 'utf8');
            const page = extractPageKnowledge(fileName, raw);
            return page.content.length > 20 ? page : null;
          } catch {
            return null;
          }
        }));
        for (const page of parsedBatch) {
          if (page) pages.push(page);
        }
      }
    } catch {}
    if (loadEpoch === webPagesEpoch) {
      cachedPages = pages;
      cachedPagesAt = Date.now();
    }
    return pages;
  })().finally(() => {
    if (pendingPagesLoad === loadPromise) {
      pendingPagesLoad = null;
    }
  });
  pendingPagesLoad = loadPromise;
  return loadPromise;
}

async function loadLiveSiteFacts(pool, config = null) {
  if (!pool || typeof pool.query !== 'function') return {};
  const cached = liveDbCache.get(pool);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const facts = {};
  try {
    const [settingsRes, vouchersRes, campaignsRes, newsRes, bundlesRes, payConnRes] = await Promise.all([
      pool.query("SELECT setting_key, setting_value FROM store_settings WHERE setting_key IN ('shipping_rates', 'shipping_note', 'loyalty_policy')").catch(() => ({ rows: [] })),
      pool.query("SELECT v.code, v.title, v.kind, v.amount, v.max_discount_vnd, v.min_spend_vnd, v.ends_at FROM marketing_vouchers v WHERE v.active=true AND v.public_claim=true AND now() BETWEEN v.starts_at AND v.ends_at AND (SELECT count(*) FROM voucher_redemptions r WHERE r.voucher_id=v.id AND r.released=false) < v.total_limit ORDER BY v.created_at DESC LIMIT 6").catch(() => ({ rows: [] })),
      pool.query("SELECT title, body, ends_at FROM marketing_campaigns WHERE active=true AND now() BETWEEN starts_at AND ends_at ORDER BY created_at DESC LIMIT 4").catch(() => ({ rows: [] })),
      pool.query("SELECT slug, title, excerpt AS summary FROM news_posts WHERE status='published' ORDER BY published_at DESC NULLS LAST, created_at DESC LIMIT 100").catch(error => { console.warn("AI news context unavailable", /^[A-Z0-9]{5}$/.test(error.code || "") ? error.code : "QUERY_FAILED"); return { rows: [] }; }),
      pool.query("SELECT b.id, b.title, b.discount_type, b.discount_value, COALESCE((SELECT json_agg(json_build_object('productSlug', p.slug, 'productName', p.name, 'variantName', v.name, 'priceVnd', v.price_vnd, 'isPrimary', bi.is_primary)) FROM product_bundle_items bi JOIN product_variants v ON v.id=bi.variant_id JOIN products p ON p.id=v.product_id WHERE bi.bundle_id=b.id AND v.active=true AND p.active=true), '[]'::json) AS items FROM product_bundles b WHERE b.active=true AND b.starts_at <= now() AND b.ends_at > now() ORDER BY b.created_at DESC LIMIT 5").catch(() => ({ rows: [] })),
      pool.query("SELECT channel_id, enabled FROM payment_channel_connections").catch(() => ({ rows: [] }))
    ]);

    for (const row of settingsRes.rows || []) {
      if (row.setting_key === 'shipping_rates' && row.setting_value) facts.shippingRates = row.setting_value;
      if (row.setting_key === 'shipping_note' && row.setting_value) facts.shippingNote = row.setting_value;
      if (row.setting_key === 'loyalty_policy' && row.setting_value) facts.loyaltyPolicy = row.setting_value;
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
        url: `/tin-tuc/${encodeURIComponent(n.slug)}`,
        title: n.title,
        summary: String(n.summary || '').slice(0, 240)
      }));
    }
    if (bundlesRes.rows?.length) {
      facts.activeBundles = bundlesRes.rows;
    }

    // Đồng bộ kênh thanh toán đang bật thực tế trên trang Thanh toán
    let resolvedPayMethods = null;
    if (config && typeof config === 'object' && Object.keys(config).length > 0) {
      try {
        const ch = await require('./payment-channels').getCheckoutPaymentChannels(pool, config);
        if (Array.isArray(ch?.methods) && ch.methods.length > 0) {
          resolvedPayMethods = ch.methods;
        }
      } catch (_) {}
    }
    if (!resolvedPayMethods && Array.isArray(payConnRes.rows) && payConnRes.rows.length > 0) {
      const connMap = new Map(payConnRes.rows.map(r => [String(r.channel_id || ''), Boolean(r.enabled)]));
      const list = [];
      if (connMap.get('cod') !== false) list.push('cod');
      for (const id of ['bank_transfer', 'vnpay', 'momo', 'zalopay']) {
        if (connMap.get(id) === true) list.push(id);
      }
      if (list.length > 0) resolvedPayMethods = list;
    }
    if (resolvedPayMethods) {
      facts.enabledPaymentMethods = resolvedPayMethods;
    }
  } catch {}

  liveDbCache.set(pool, { value: facts, expiresAt: Date.now() + LIVE_DB_TTL_MS });
  return facts;
}


async function boostWebKnowledgeWithEmbeddings(pool, rawQuestion, scored, relevantSnippets, gpuTransport) {
  if (!rawQuestion || rawQuestion.trim().length < 5) {
    return;
  }
  const topKeywordScore = scored[0]?.score || 0;
  const isCustomTransport = typeof gpuTransport === 'function' && gpuTransport !== fetch;
  let qVec = null;

  if (topKeywordScore < 18) {
    const candidates = [];
    const seenFiles = new Set();
    for (const item of scored) {
      const f = item.page.file;
      if (seenFiles.has(f)) continue;
      if (item.score > 0 || /^(guide|care|delivery-returns|payment|pricing|product-support|warranty)/.test(f)) {
        seenFiles.add(f);
        candidates.push(item);
        if (candidates.length >= 8) break;
      }
    }
    if (candidates.length) {
      const itemsWithVec = [];
      if (isCustomTransport) {
        const texts = [
          rawQuestion,
          ...candidates.map(c => c.page.summaryText || `${c.page.title}. ${String(c.page.content || '').slice(0, 280)}`)
        ];
        const vecs = await embedTexts(texts, { transport: gpuTransport });
        if (!vecs || !vecs[0]) return;
        qVec = vecs[0];
        for (let i = 0; i < candidates.length; i++) {
          if (vecs[i + 1]) itemsWithVec.push({ key: candidates[i].page.file, vec: vecs[i + 1], item: candidates[i] });
        }
      } else {
        const pageItems = candidates.map(c => ({
          key: String(c.page.file),
          text: (c.page.summaryText || `${c.page.title}. ${String(c.page.content || '').slice(0, 280)}`).replace(/\s+/g, ' ').trim()
        }));
        const [qRes, vecMap] = await Promise.all([
          embedText(rawQuestion),
          ensureEmbeddings(pool, 'web_pages', pageItems)
        ]);
        if (!qRes) return;
        qVec = qRes;
        for (let i = 0; i < candidates.length; i++) {
          const vec = vecMap.get(pageItems[i].key);
          if (vec) itemsWithVec.push({ key: pageItems[i].key, vec, item: candidates[i] });
        }
      }

      if (qVec && itemsWithVec.length) {
        const cosines = itemsWithVec.map(x => cosineSimilarity(qVec, x.vec));
        const sortedCos = [...cosines].sort((a, b) => a - b);
        const medianCos = sortedCos[Math.floor(sortedCos.length / 2)] || 0;
        for (let i = 0; i < itemsWithVec.length; i++) {
          const cos = cosines[i];
          const aboveNoise = itemsWithVec.length < 3 ? cos >= 0.32 : (cos >= 0.30 && (cos - medianCos) >= 0.08);
          if (aboveNoise) {
            itemsWithVec[i].item.score += Math.round(cos * 22);
          }
        }
        scored.sort((a, b) => b.score - a.score);
      }
    }
  }

  if (relevantSnippets.length < 2) {
    const extraLines = [];
    const seenExtra = new Set(relevantSnippets.map(s => normalizeText(s.line || '')));
    for (const item of scored.slice(0, 2)) {
      if (item.score < 8) continue;
      const lines = String(item.page.content || '')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length >= 28 && l.length <= 260 && !isNoiseKnowledgeLine(l));
      for (const line of lines.slice(0, 28)) {
        const norm = normalizeText(line);
        if (!norm || seenExtra.has(norm)) continue;
        seenExtra.add(norm);
        extraLines.push({ page: item.page, line });
        if (extraLines.length >= 6) break;
      }
      if (extraLines.length >= 6) break;
    }
    if (extraLines.length) {
      const toEmbed = qVec ? extraLines.map(x => x.line) : [rawQuestion, ...extraLines.map(x => x.line)];
      const lVecs = await embedTexts(toEmbed, { transport: gpuTransport });
      if (lVecs) {
        const lineOffset = qVec ? 0 : 1;
        if (!qVec) qVec = lVecs[0];
        if (qVec) {
          const lineItems = [];
          for (let i = 0; i < extraLines.length; i++) {
            const vec = lVecs[i + lineOffset];
            if (vec) lineItems.push({ key: String(i), vec, item: extraLines[i] });
          }
          const ranked = rankByCosine(qVec, lineItems, { topK: 2, minCos: 0.34 });
          for (const m of ranked.matches) {
            relevantSnippets.push({
              title: m.item.page.title,
              url: m.item.page.url,
              line: m.item.line,
              score: Number(m.cos.toFixed(4))
            });
          }
          relevantSnippets.sort((a, b) => b.score - a.score);
        }
      }
    }
  }
}

async function getRelevantWebKnowledge(pool, { question = '', selectedProduct = null, transport = fetch, gpuTransport } = {}) {
  const pages = await loadWebPagesIndexAsync();
  const qNorm = expandQueryVi(typeof question === 'string' ? question : JSON.stringify(question || ''));
  const tokens = tokenizeMeaningful(qNorm);
  const productNorm = selectedProduct ? normalizeText(`${selectedProduct.slug || ''} ${selectedProduct.name || ''}`) : '';

  const scored = pages.map(page => {
    let score = 0;
    if (productNorm) {
      if (hasAnyBoundaryTerm(productNorm, ['k9']) && page.file.includes('k9')) score += 25;
      if (hasAnyBoundaryTerm(productNorm, ['m3']) && page.file.includes('m3')) score += 25;
      if (hasAnyBoundaryTerm(productNorm, ['p01']) && page.file.includes('p01')) score += 25;
      if (hasAnyBoundaryTerm(productNorm, ['p185']) && page.file.includes('p185')) score += 25;
      if (hasAnyBoundaryTerm(productNorm, ['g1', 'g1 ultra']) && page.file.includes('g1')) score += 25;
    }
    if (/\b(?:huong dan|ket noi|su dung|cach dung|sac|pin|bluetooth|usb|type-c|type c|lightning)\b/.test(qNorm) && page.file.startsWith('guide')) score += 18;
    if (/\b(?:bao hanh|care|doi moi|sua chua|kich hoat)\b/.test(qNorm) && (page.file === 'care.html' || page.file === 'warranty-activation.html' || page.file === 'product-support.html')) score += 20;
    if (/\b(?:giao hang|van chuyen|ship|doi tra|hoan tien|nhan hang)\b/.test(qNorm) && page.file === 'delivery-returns.html') score += 20;
    if (/\b(?:thanh toan|vnpay|momo|zalopay|chuyen khoan|cod|tra gop)\b/.test(qNorm) && page.file === 'payment.html') score += 20;
    if (/\b(?:gia|bang gia|uu dai|khuyen mai|bao nhieu)\b/.test(qNorm) && (page.file === 'pricing.html' || page.file === 'shop.html')) score += 15;
    if (/\b(?:khieu nai|gop y|tranh chap)\b/.test(qNorm) && page.file === 'complaints.html') score += 18;
    if (/\b(?:chinh sach|dieu khoan|bao mat)\b/.test(qNorm) && (page.file === 'terms.html' || page.file === 'privacy.html' || page.file === 'legal.html')) score += 15;

    for (const token of tokens) {
      if (page.file.includes(token)) score += 6;
      if (normalizeText(page.title).includes(token)) score += 4;
      if (page.normalized.includes(token)) score += 2;
    }
    return { page, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const semanticSnippets = [];
  try {
    const qRaw = typeof question === 'string' ? question : '';
    if (tokens.length > 0 && qRaw) {
      await boostWebKnowledgeWithEmbeddings(pool, qRaw, scored, semanticSnippets, gpuTransport);
    }
  } catch (_) {}
  const topMatched = scored.filter((item, index) => item.score > 0 || index < 2).slice(0, 3);
  const topPages = topMatched.map(({ page }) => ({
    url: page.url,
    title: page.title,
    excerpt: page.content.slice(0, 1200)
  }));

  // Extract crisp matching lines across top pages for direct factual grounding (globally deduplicated across pages)
  const relevantSnippets = [];
  const seenLines = new Set();
  for (const s of semanticSnippets) {
    const norm = normalizeText(s.line || '');
    if (!norm || isNoiseKnowledgeLine(s.line) || seenLines.has(norm)) continue;
    seenLines.add(norm);
    relevantSnippets.push(s);
  }
  if (tokens.length > 0) {
    for (const { page, score } of topMatched) {
      if (score < 4) continue;
      const lines = page.content.split('\n').map(l => l.trim()).filter(l => l.length >= 26 && l.length <= 280 && !isNoiseKnowledgeLine(l));
      for (const line of lines) {
        const key = normalizeText(line);
        if (!key || seenLines.has(key)) continue;
        const lineScore = tokenOverlapScore(tokens, tokenizeMeaningful(line));
        if (lineScore >= 0.35) {
          seenLines.add(key);
          relevantSnippets.push({ title: page.title, url: page.url, line, score: lineScore });
        }
      }
    }
    relevantSnippets.sort((a, b) => b.score - a.score);
  }

  const policy = await require('./ai-knowledge-admin').readKnowledgePolicy(pool);
  const [liveFacts, externalKnowledge] = await Promise.all([
    loadLiveSiteFacts(pool),
    getExternalWebKnowledge({ question, selectedProduct, transport, webSearchEnabled: policy.webSearchEnabled, curatedEnabled: policy.curatedEnabled }).catch(() => ({ ecosystemFacts: [], searchSnippets: [] }))
  ]);
  const approved = (policy.entries || []).filter(e => e.enabled && hasAnyBoundaryTerm(qNorm, e.triggers || [])).slice(0, 6);
  externalKnowledge.approvedSources = approved.map(e => ({ title: e.title, url: e.sourceUrl || null, facts: e.facts }));
  externalKnowledge.ecosystemFacts = [...approved.flatMap(e => e.facts), ...externalKnowledge.ecosystemFacts].slice(0, 12);
  return {
    webPages: topPages,
    relevantSnippets: relevantSnippets.slice(0, 3),
    externalKnowledge,
    ...liveFacts
  };
}

module.exports = {
  EXCLUDED_HTML,
  isNoiseKnowledgeLine,
  extractPageKnowledge,
  loadWebPagesIndex,
  loadWebPagesIndexAsync,
  clearWebKnowledgeCache,
  loadLiveSiteFacts,
  getRelevantWebKnowledge
};
