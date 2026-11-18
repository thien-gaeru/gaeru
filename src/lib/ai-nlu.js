'use strict';

/**
 * Shared Vietnamese NLU, boundary matching, entity extraction, and conciseness helpers
 * used across GAERU Customer AI, Internal Admin Copilot, Self-Learning, and Web Knowledge.
 */

const STOP_WORDS = new Set([
  'la', 'gi', 'cua', 'va', 'voi', 'cho', 'nhung', 'cac', 'duoc', 'khong', 'co',
  'nhe', 'nha', 'a', 'thi', 'sao', 'nao', 'minh', 'em', 'anh', 'chi', 'toi',
  'ban', 'shop', 'ad', 'oi', 'giup', 'xin', 'hoi', 've', 'nay', 'do', 'kia',
  'trong', 'ngoai', 'tren', 'duoi', 'tu', 'den', 'khi', 'neu', 'ma', 'hay',
  'hoac', 'nhu', 'the', 'vay', 'de', 'roi', 'chua', 'dang', 'da', 'se', 'rat',
  'qua', 'nhieu', 'it', 'mot', 'hai', 'ba', 'cai', 'chiec', 'bo', 'mau', 'loai'
]);

function normalizeVi(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSearchSpace(text) {
  return normalizeVi(text)
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Expands unambiguous Vietnamese chat shorthands & compact tech names
 * strictly along token boundaries so codes like "k9" or "m3" are preserved.
 */
function expandQueryVi(text) {
  let s = normalizeVi(text);
  if (!s) return '';
  s = s
    .replace(/(?<![a-z0-9])ip\s*(1[0-8])\s*e(?![a-z0-9])/g, 'iphone $1e')
    .replace(/(?<![a-z0-9])iphone\s*(1[0-8])\s*e(?![a-z0-9])/g, 'iphone $1e')
    .replace(/(?<![a-z0-9])(?:ip|iphone)\s*(1[0-8]|[5-9]|xs|xr|x|se)\s*(?:prm|pm)(?![a-z0-9])/g, 'iphone $1 pro max')
    .replace(/(?<![a-z0-9])ip\s*(1[0-8]|[5-9])(?![a-z0-9])/g, 'iphone $1')
    .replace(/(?<![a-z0-9])iphone(1[0-8]|[5-9])(?![a-z0-9])/g, 'iphone $1')
    .replace(/(?<![a-z0-9])(?:ip|iphone)\s*(xs\s*max|xs|xr|x|se|air)(?![a-z0-9])/g, 'iphone $1')
    .replace(/(?<![a-z0-9])ip(?![a-z0-9])(?!\s*(?:tinh|address|v4|v6))/g, 'iphone')
    .replace(/(?<![a-z0-9])ss(?=\s*(?:galaxy|s[12]\d|a[0-9]{2}|m[0-9]{2}|z\s*(?:fold|flip)|fold|flip|note|tab|j\d))/g, 'samsung')
    .replace(/(?<![a-z0-9])xm(?=\s*(?:1[2-9]|redmi|poco|ultra|pro))/g, 'xiaomi')
    .replace(/(?<![a-z0-9])(?:type\s*c|typec|usb\s*c|usb-c)(?![a-z0-9])/g, 'type-c')
    .replace(/(?<![a-z0-9])(?:micro\s*usb|microusb)(?![a-z0-9])/g, 'micro-usb')
    .replace(/(?<![a-z0-9])(?:ko|hok)(?![a-z0-9])/g, 'khong')
    .replace(/(?<![a-z0-9])(?:bn|bnh|bnhieu)(?![a-z0-9])/g, 'bao nhieu')
    .replace(/(?<![a-z0-9])bh(?![a-z0-9])/g, 'bao hanh')
    .replace(/(?<![a-z0-9])sp(?![a-z0-9])/g, 'san pham')
    .replace(/(?<![a-z0-9])sdt(?![a-z0-9])/g, 'so dien thoai')
    .replace(/(?<![a-z0-9])nv(?![a-z0-9])/g, 'nhan vien')
    .replace(/(?<![a-z0-9])(?:dthoai|dt)(?![a-z0-9])/g, 'dien thoai')
    .replace(/(?<![a-z0-9])vc(?![a-z0-9])/g, 'van chuyen')
    .replace(/(?<![a-z0-9])dc(?![a-z0-9])/g, 'duoc');
  return s.replace(/\s+/g, ' ').trim();
}

function hasBoundaryTerm(normOrRawText, term) {
  const hay = normalizeSearchSpace(normOrRawText);
  const needle = normalizeSearchSpace(term);
  if (!hay || !needle) return false;
  const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(needle)}(?=$|[^a-z0-9])`, 'i');
  return re.test(hay);
}

function hasAnyBoundaryTerm(normOrRawText, terms) {
  if (!Array.isArray(terms) || !terms.length) return false;
  const hay = normalizeSearchSpace(normOrRawText);
  if (!hay) return false;
  for (const term of terms) {
    const needle = normalizeSearchSpace(term);
    if (!needle) continue;
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(needle)}(?=$|[^a-z0-9])`, 'i');
    if (re.test(hay)) return true;
  }
  return false;
}

function isTermNegated(normOrRawText, term) {
  const hay = normalizeSearchSpace(normOrRawText);
  const needle = normalizeSearchSpace(term);
  if (!hay || !needle) return false;
  const re = new RegExp(`(?:^|[^a-z0-9])(?:khong|chua|dung|bo qua|khong phai|khong can|khong muon)\\s+(?:\\w+\\s+){0,2}${escapeRegex(needle)}(?=$|[^a-z0-9])`, 'i');
  return re.test(hay);
}

function tokenizeMeaningful(text, { minLen = 2 } = {}) {
  const space = normalizeSearchSpace(text);
  if (!space) return [];
  const rawTokens = space.split(/[^a-z0-9.]+/).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const tok of rawTokens) {
    const clean = tok.replace(/^\.+|\.+$/g, '');
    if (clean.length < minLen || STOP_WORDS.has(clean)) continue;
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function tokenOverlapScore(tokensA, tokensB) {
  const a = Array.isArray(tokensA) ? tokensA : tokenizeMeaningful(tokensA);
  const b = Array.isArray(tokensB) ? tokensB : tokenizeMeaningful(tokensB);
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let hits = 0;
  for (const t of a) {
    if (setB.has(t)) hits++;
  }
  if (!hits) return 0;
  // Balanced coverage biased toward query recall + mutual Dice similarity
  const recall = hits / a.length;
  const dice = (2 * hits) / (a.length + b.length);
  return (recall * 0.6) + (dice * 0.4);
}

/**
 * Extracts real production GR-... and legacy GAE-... / TEST-... order codes.
 */
function extractOrderCodes(text) {
  const raw = String(text || '');
  const matches = raw.match(/\b(?:GR|GAE|TEST)-[A-Z0-9-]{3,36}\b/gi) || [];
  return Array.from(new Set(matches.map(m => m.trim())));
}

function extractPhoneNumbers(text) {
  const raw = String(text || '');
  const matches = raw.match(/(?:\+84|84|0)(?:3[2-9]|5[2689]|7[06-9]|8[1-9]|9[0-9])\d{7}\b|\b0\d{9}\b/g) || [];
  return Array.from(new Set(matches.map(p => p.replace(/^(?:\+84|84)/, '0'))));
}

function isExplicitDetailedRequest(normText) {
  return hasAnyBoundaryTerm(normText, [
    'tong quan', 'bao cao', 'chi tiet', 'day du', 'liet ke', 'danh sach',
    'toan bo', 'tat ca', 'bang gia', 'tinh hinh chung', 'review', 'gioi thieu'
  ]);
}

function isFollowUpReference(normText) {
  return /^(?:con|the con|vay con|vay thi|neu|gia thi|pin thi|bao nhieu|may tien|con hang|may gio|may tieng|bao lau|bao xa|dung duoc|tuong thich|cam duoc|co duoc|khac nhau|loai 1|loai 2|ban 1|ban 2)\b/.test(normalizeSearchSpace(normText)) ||
    hasAnyBoundaryTerm(normText, ['mau nay', 'mau do', 'cai nay', 'cai do', 'con nay', 'con do', 'san pham nay', 'san pham do', 'no co', 'no dung', 'cua no']);
}

/**
 * Matches GAERU catalog entries mentioned in the current message, falling back cleanly
 * to the chat thread's bound product or the most recently discussed product in history.
 */
function resolveMentionedProducts(question, catalog = [], { thread = null, history = [] } = {}) {
  const expanded = expandQueryVi(question);
  const space = normalizeSearchSpace(expanded);

  const knownModels = [
    { key: 'gaeru-p01', aliases: ['p01', 'gaeru p01'] },
    { key: 'gaeru-k9', aliases: ['k9', 'gaeru k9'] },
    { key: 'gaeru-m3', aliases: ['m3', 'gaeru m3'] },
    { key: 'gaeru-p185', aliases: ['p185', 'gaeru p185'] },
    { key: 'gaeru-g1-ultra', aliases: ['g1 ultra', 'gaeru g1 ultra', 'g1'] }
  ];

  // Build lookup descriptors from both known models and dynamic DB catalog
  const entries = [];
  const seenKeys = new Set();

  for (const prod of Array.isArray(catalog) ? catalog : []) {
    const slug = String(prod.slug || '').toLowerCase();
    const name = String(prod.name || '');
    const key = slug || normalizeSearchSpace(name);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);

    const aliases = new Set();
    if (name) aliases.add(normalizeSearchSpace(name));
    if (slug) aliases.add(normalizeSearchSpace(slug));
    const shortName = normalizeSearchSpace(name.replace(/^gaeru\s+/i, ''));
    if (shortName && shortName.length >= 2) aliases.add(shortName);

    const known = knownModels.find(k => k.key === slug || k.aliases.some(a => aliases.has(a)));
    if (known) known.aliases.forEach(a => aliases.add(a));
    if (key.includes('g1')) {
      aliases.add('g1 ultra');
      aliases.add('g1');
    }
    entries.push({ key, product: prod, aliases: Array.from(aliases) });
  }

  for (const km of knownModels) {
    if (!seenKeys.has(km.key)) {
      seenKeys.add(km.key);
      entries.push({ key: km.key, product: null, aliases: km.aliases });
    }
  }

  const productSpace = space.replace(/\b(?:ipad|macbook|imac|chip|apple)\s+(?:air\s+|pro\s+)?m3\b/g, '$1');
  const directMatches = [];
  for (const e of entries) {
    const matchTarget = e.key === 'gaeru-m3' && !hasBoundaryTerm(space, 'gaeru m3') ? productSpace : space;
    if (hasAnyBoundaryTerm(matchTarget, e.aliases)) {
      directMatches.push(e);
    }
  }

  // Category/form-factor hints when customer describes the product without its model code
  if (!directMatches.length) {
    if (hasAnyBoundaryTerm(space, ['gimbal', 'quay theo nguoi', 'tu xoay', 'tu quay'])) {
      const p01 = entries.find(e => e.key === 'gaeru-p01' || normalizeSearchSpace(e.product?.category).includes('video'));
      if (p01) directMatches.push(p01);
    } else if (hasAnyBoundaryTerm(space, ['gay selfie', 'gay chup hinh', 'gay quay phim', 'tripod', '4 chan', 'chan quay'])) {
      const p185 = entries.find(e => e.key === 'gaeru-p185');
      if (p185) directMatches.push(p185);
    }
  }

  if (directMatches.length) {
    return { source: 'question', items: directMatches };
  }

  // Multi-turn & thread binding fallback
  const looksFollowUp = isFollowUpReference(expanded) ||
    hasAnyBoundaryTerm(space, ['gia', 'pin', 'bao lau', 'khoang cach', 'bao xa', 'con hang', 'het hang', 'phan loai', '1 mic', '2 mic', 'type c', 'lightning', 'chong on', 'loc on', 'dung duoc', 'tuong thich', 'trong luong', 'hop sac']);

  if (Array.isArray(history) && history.length) {
    const recentReverse = [...history].slice(-6).reverse();
    for (const msg of recentReverse) {
      const mText = expandQueryVi(msg?.body || msg?.content || '');
      const histHits = entries.filter(e => hasAnyBoundaryTerm(mText, e.aliases));
      if (histHits.length === 1 && (looksFollowUp || mText.length < 180)) {
        return { source: 'history', items: histHits };
      }
    }
  }

  if (thread?.product_id || thread?.product_name) {
    const bound = entries.find(e =>
      (thread.product_id && e.product?.id === thread.product_id) ||
      (thread.product_name && hasAnyBoundaryTerm(thread.product_name, e.aliases))
    );
    if (bound && (looksFollowUp || !hasAnyBoundaryTerm(space, ['don hang', 'ma giam gia', 'voucher', 'bao hanh', 'giao hang', 'ship', 'xu']))) {
      return { source: 'thread', items: [bound] };
    }
  }

  return { source: 'none', items: [] };
}

/**
 * Filters a product's variants to the ones specifically asked about (e.g. "2 mic Type-C", "Lightning").
 */
function matchProductVariants(question, variants = []) {
  if (!Array.isArray(variants) || !variants.length) return [];
  const space = normalizeSearchSpace(expandQueryVi(question));

  const hints = [];
  if (hasAnyBoundaryTerm(space, ['2 mic', '2 micro', 'ban 2', 'hai mic', 'doi'])) hints.push(['2 mic', 'doi', '2tx', '2bo', '2 micro']);
  if (hasAnyBoundaryTerm(space, ['1 mic', '1 micro', 'ban 1', 'mot mic', 'don'])) hints.push(['1 mic', 'don', '1tx', '1bo', '1 micro']);
  if (hasBoundaryTerm(space, 'micro usb')) hints.push(['micro usb']);
  else if (hasBoundaryTerm(space, 'type c')) hints.push(['type c', 'typec', 'usb c']);
  if (hasBoundaryTerm(space, 'lightning')) hints.push(['lightning', 'ios', 'iphone cu']);
  if (hasAnyBoundaryTerm(space, ['2m1', '2.1m', 'chan cao'])) hints.push(['2m1', '2.1']);
  if (hasAnyBoundaryTerm(space, ['de ban', 'mini'])) hints.push(['de ban']);

  if (!hints.length) return [];

  const matched = variants.filter(v => {
    const vSpace = normalizeSearchSpace(`${v.name || ''} ${v.sku || ''}`);
    return hints.every(group => group.some(tok => hasBoundaryTerm(vSpace, tok) || vSpace.includes(tok)));
  });
  if (matched.length) return matched;

  return variants.filter(v => {
    const vSpace = normalizeSearchSpace(`${v.name || ''} ${v.sku || ''}`);
    return hints.some(group => group.some(tok => hasBoundaryTerm(vSpace, tok) || vSpace.includes(tok)));
  });
}

module.exports = {
  STOP_WORDS,
  normalizeVi,
  normalizeSearchSpace,
  expandQueryVi,
  escapeRegex,
  hasBoundaryTerm,
  hasAnyBoundaryTerm,
  isTermNegated,
  tokenizeMeaningful,
  tokenOverlapScore,
  extractOrderCodes,
  extractPhoneNumbers,
  isExplicitDetailedRequest,
  isFollowUpReference,
  resolveMentionedProducts,
  matchProductVariants
};
