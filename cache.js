'use strict';

const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const { LRUCache } = require('lru-cache');

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

// Event emitter để phát tín hiệu cập nhật thời gian thực cho SSE và Cluster
const cacheEvents = new EventEmitter();
cacheEvents.setMaxListeners(1000);

// Đổi mới mỗi khi sửa code và restart server -> Ép trình duyệt bỏ bản HTML cũ ngay lập tức
const BOOT_ID = Date.now().toString(36);

// L1 RAM Cache: Tối đa 5000 mục
const ramCache = new LRUCache({ max: 5000 });

// Bảng ánh xạ Tag -> Set<cacheKey> cho việc xóa chính xác theo nhãn
const tagIndex = new Map();

// Lưu tồn kho thời gian thực trên RAM
const stockMap = new Map();

// Singleflight Map: Gộp các request đồng thời thành 1 truy vấn duy nhất
const inflight = new Map();

// Safe Cloudflare Edge Purge helper
let edgePurgeService = null;
try {
  edgePurgeService = require('./src/lib/edge-purge').edgePurge;
} catch (_) {}

function generateETag(data) {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  return '"' + crypto.createHash('sha1').update(str).digest('base64url') + '"';
}

function clearHtmlCacheOnly() {
  for (const key of ramCache.keys()) {
    if (typeof key === 'string' && key.startsWith('html:')) {
      ramCache.delete(key);
    }
  }
}

// Xóa toàn bộ Cache Key thuộc các Tag bị thay đổi
function purgeTagsLocal(tags = []) {
  const purgedKeys = [];
  const tagList = Array.isArray(tags) ? tags : [tags];
  for (const rawTag of tagList) {
    const tag = String(rawTag).trim();
    if (tag === '*') {
      for (const key of ramCache.keys()) {
        purgedKeys.push(key);
      }
      ramCache.clear();
      tagIndex.clear();
      clearHtmlCacheOnly();
      break;
    }
    const keys = tagIndex.get(tag);
    if (keys) {
      for (const key of keys) {
        ramCache.delete(key);
        purgedKeys.push(key);
      }
      tagIndex.delete(tag);
    }
    if (tag === 'catalog' || tag === 'product:list' || tag === 'gaeru-catalog') {
      clearHtmlCacheOnly();
    }
  }
  return purgedKeys;
}

// Micro-batching để gom các lời gọi invalidateTags trong cùng một tick
let pendingInvalidationTags = new Set();
let isMicrotaskScheduled = false;

function invalidateTags(tags = [], { immediate = false } = {}) {
  const tagList = Array.isArray(tags) ? tags : [tags];
  if (tagList.length === 0) return [];

  const purgedKeys = purgeTagsLocal(tagList);

  for (const t of tagList) {
    if (t) pendingInvalidationTags.add(String(t).trim());
  }

  const dispatch = () => {
    const batchedTags = Array.from(pendingInvalidationTags);
    pendingInvalidationTags.clear();
    if (batchedTags.length === 0) return;

    // Nếu chạy Node.js Cluster đa tiến trình, đồng bộ sang các Worker khác
    if (process.send) {
      try {
        process.send({ type: 'CACHE_INVALIDATE_TAGS', tags: batchedTags });
      } catch (_) {}
    }

    // Phát sự kiện để đẩy SSE xuống trình duyệt đang mở
    cacheEvents.emit('invalidated', {
      tags: batchedTags,
      timestamp: Date.now()
    });
  };

  if (immediate) {
    dispatch();
  } else if (!isMicrotaskScheduled) {
    isMicrotaskScheduled = true;
    queueMicrotask(() => {
      isMicrotaskScheduled = false;
      dispatch();
    });
  }

  return purgedKeys;
}

// Lắng nghe tín hiệu xóa cache & đồng bộ tồn kho từ Master/Worker khác (khi chạy Cluster)
if (typeof process.on === 'function') {
  process.on('message', (msg) => {
    if (msg?.type === 'CACHE_INVALIDATE_TAGS' && Array.isArray(msg.tags)) {
      purgeTagsLocal(msg.tags);
      cacheEvents.emit('invalidated', { tags: msg.tags, timestamp: Date.now() });
    } else if (msg?.type === 'STOCK_SYNC' && msg.skuOrId !== undefined && msg.qty !== undefined) {
      stockMap.set(msg.skuOrId, Number(msg.qty) || 0);
    }
  });
}

function flushAllCache() {
  ramCache.clear();
  stockMap.clear();
  tagIndex.clear();
  if (edgePurgeService && typeof edgePurgeService.purgeCatalog === 'function') {
    edgePurgeService.purgeCatalog().catch(() => {});
  }
  invalidateTags(['*'], { immediate: true });
}

// Đọc cache hoặc nạp mới với Singleflight, gán Tag và ETag
async function getOrSetCache(key, tags = [], fetchFn, ttl) {
  const cached = ramCache.get(key);
  if (cached) return cached;

  if (inflight.has(key)) {
    return inflight.get(key);
  }

  const promise = (async () => {
    try {
      const freshData = await fetchFn();
      if (freshData === undefined || freshData === null) return freshData;
      const entry = {
        data: freshData,
        etag: generateETag(freshData),
        updatedAt: Date.now(),
        tags: Array.isArray(tags) ? tags : [tags]
      };

      if (ttl) {
        ramCache.set(key, entry, { ttl });
      } else {
        ramCache.set(key, entry);
      }

      const tagList = Array.isArray(tags) ? tags : [tags];
      for (const tag of tagList) {
        const normTag = String(tag).trim();
        if (!tagIndex.has(normTag)) tagIndex.set(normTag, new Set());
        tagIndex.get(normTag).add(key);
      }

      return entry;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

// Middleware ETag và Tag-based Cache cho Express Route
function withCache(keyBuilder, tagsBuilder, fetchFn, ttl) {
  return async (req, res, next) => {
    try {
      const key = typeof keyBuilder === 'function' ? keyBuilder(req) : keyBuilder;
      const rawTags = typeof tagsBuilder === 'function' ? tagsBuilder(req) : (tagsBuilder || []);
      const tags = Array.isArray(rawTags) ? rawTags : [rawTags];

      const entry = await getOrSetCache(key, tags, () => fetchFn(req), ttl);
      if (!entry) return next();

      const { data, etag } = entry;

      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      res.setHeader('ETag', etag);
      if (tags.length > 0) {
        res.setHeader('Cache-Tag', tags.join(','));
      }

      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      return res.json(data);
    } catch (err) {
      next(err);
    }
  };
}

// 1. Lấy dữ liệu DB: Phản hồi 0.01ms từ RAM, tự kiểm tra ngầm DB sau mỗi 3 giây (SWR)
async function getFreshData(key, dbFetchFn, swrMs = 3000) {
  const entry = ramCache.get(key);
  const now = Date.now();

  if (entry) {
    if (now - entry.time > swrMs && !inflight.has(key)) {
      const bg = Promise.resolve()
        .then(() => dbFetchFn())
        .then((fresh) => {
          if (fresh !== undefined && fresh !== null) {
            const newHash = crypto.createHash('md5').update(JSON.stringify(fresh)).digest('hex');
            if (newHash !== entry.hash) {
              ramCache.set(key, { data: fresh, time: Date.now(), hash: newHash });
              clearHtmlCacheOnly(); // DB có thay đổi -> Xóa ngay HTML cũ
              if (edgePurgeService && typeof edgePurgeService.purgeCatalog === 'function') {
                edgePurgeService.purgeCatalog().catch(() => {});
              }
            } else {
              entry.time = Date.now();
            }
          }
        })
        .catch(() => {})
        .finally(() => inflight.delete(key));

      inflight.set(key, bg);
    }
    return entry.data;
  }

  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const data = await dbFetchFn();
      if (data !== undefined && data !== null) {
        const hash = crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
        ramCache.set(key, { data, time: Date.now(), hash });
      }
      return data;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}

// 2. Middleware HTML Cache: Luôn đối chiếu ETag (Trả 304 nếu chưa đổi, trả bản mới ngay nếu đã đổi)
function smartPageCache(swrMs = 3000) {
  return (req, res, next) => {
    if (req.method !== 'GET') return next();

    // Bỏ qua cache với route riêng tư / session nhạy cảm
    if (req.session?.customer || req.session?.admin) return next();
    const privatePath = p => /^\/(?:tai-khoan|gio-hang|thanh-toan|ket-qua-thanh-toan|admin|gaeru_ceo|api)(?:\/|$)/i.test(p) || /^\/(?:account|cart|checkout|payment-result)\.html$/i.test(p);
    if (privatePath(req.path) || privatePath(String(req.originalUrl).split('?')[0])) {
      return next();
    }

    const key = `html:${req.originalUrl}`;

    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('CDN-Cache-Control', 'public, max-age=5, stale-while-revalidate=15');
    res.setHeader('Cloudflare-CDN-Cache-Control', 'public, max-age=5, stale-while-revalidate=15');

    const hit = ramCache.get(key);
    if (hit) {
      const now = Date.now();
      // SWR: Nếu bản HTML đã nằm trong RAM quá swrMs (3s), xóa để lượt truy cập tiếp theo tự đối chiếu getFreshData
      if (now - (hit.time || 0) > swrMs) {
        ramCache.delete(key);
      }

      res.vary('Accept-Encoding');
      if (req.headers['if-none-match'] === hit.etag) {
        return res.status(304).end();
      }

      res.setHeader('ETag', hit.etag);
      res.setHeader('X-Cache', 'HIT-FRESH-RAM');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');

      const preferences = new Map(String(req.headers['accept-encoding'] || '').split(',').map(part => {
        const [name, ...params] = part.trim().toLowerCase().split(';');
        const value = params.find(p => /^\s*q\s*=/i.test(p));
        const q = value === undefined ? 1 : Number(value.split('=')[1]);
        return [name, Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0];
      }));
      const quality = name => preferences.get(name) ?? preferences.get('*') ?? (name === 'identity' ? 1 : 0);
      const encoding = [{ name: 'br', data: hit.br }, { name: 'gzip', data: hit.gz }, { name: 'identity', data: hit.raw }]
        .filter(item => item.data && quality(item.name) > 0).sort((a, b) => quality(b.name) - quality(a.name))[0]?.name;
      if (!encoding) return res.status(406).end();
      if (encoding === 'br') {
        res.setHeader('Content-Encoding', 'br');
        res.setHeader('Content-Length', hit.br.length);
        return res.end(hit.br);
      }
      if (encoding === 'gzip') {
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', hit.gz.length);
        return res.end(hit.gz);
      }
      return (res.locals.publicHtml?.send || res.send.bind(res))(hit.raw);
    }

    const origSend = res.locals.publicHtml?.send || res.send.bind(res);
    res.send = (body) => {
      if (res.locals.publicHtml) body = res.locals.publicHtml.prepare(body);
      if (res.statusCode === 200 && typeof body === 'string') {
        const etag = `"${BOOT_ID}-${crypto.createHash('md5').update(body).digest('hex')}"`;
        if (!res.headersSent) {
          res.vary('Accept-Encoding');
          res.setHeader('ETag', etag);
          res.setHeader('X-Cache', 'MISS-REBUILT');
        }

        const rawBuffer = Buffer.from(body, 'utf-8');
        Promise.all([
          brotli(rawBuffer, {
            params: {
              [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
              [zlib.constants.BROTLI_PARAM_QUALITY]: 6
            }
          }).catch(() => null),
          gzip(rawBuffer, { level: 6 }).catch(() => null)
        ]).then(([br, gz]) => {
          ramCache.set(key, { raw: body, br, gz, etag, time: Date.now() });
        }).catch(() => {});
      } else if (!res.headersSent) {
        res.setHeader('X-Cache', 'MISS-REBUILT');
      }

      return origSend(body);
    };

    next();
  };
}

function isValidOrderQuantity(qty) {
  return typeof qty === 'number' && Number.isSafeInteger(qty) && qty >= 1 && qty <= 99;
}

// 3. Giữ chỗ & trừ tồn kho nguyên tử (Chống bán lố 100%)
function reserveStock(skuOrId, qty) {
  const current = stockMap.get(skuOrId) ?? 0;
  if (!isValidOrderQuantity(qty)) {
    return { ok: false, remaining: current, error: 'INVALID_QUANTITY' };
  }
  if (!stockMap.has(skuOrId)) {
    return { ok: false, remaining: 0, error: 'CACHE_MISS' };
  }
  if (current < qty) {
    return { ok: false, remaining: current, error: 'INSUFFICIENT_STOCK' };
  }
  const remaining = current - qty;
  stockMap.set(skuOrId, remaining);
  if (process.send) {
    try { process.send({ type: 'STOCK_SYNC', skuOrId, qty: remaining }); } catch (_) {}
  }
  return { ok: true, remaining };
}

// Hoàn kho nguyên tử khi lỗi hoặc hủy đơn
function releaseStock(skuOrId, qty) {
  const current = stockMap.get(skuOrId) ?? 0;
  if (!isValidOrderQuantity(qty)) {
    return { ok: false, remaining: current, error: 'INVALID_QUANTITY' };
  }
  if (!stockMap.has(skuOrId)) {
    return { ok: false, remaining: 0, error: 'CACHE_MISS' };
  }
  const remaining = current + qty;
  stockMap.set(skuOrId, remaining);
  if (process.send) {
    try { process.send({ type: 'STOCK_SYNC', skuOrId, qty: remaining }); } catch (_) {}
  }
  return { ok: true, remaining };
}

// Seed tồn kho từ DB
function seedStock(skuOrId, qty) {
  const num = typeof qty === 'number' ? qty : Number(qty);
  if (!Number.isSafeInteger(num) || num < 0) return;
  stockMap.set(skuOrId, num);
  if (process.send) {
    try { process.send({ type: 'STOCK_SYNC', skuOrId, qty: num }); } catch (_) {}
  }
}

module.exports = {
  BOOT_ID,
  ramCache,
  stockMap,
  inflight,
  getFreshData,
  smartPageCache,
  isValidOrderQuantity,
  reserveStock,
  releaseStock,
  seedStock,
  clearHtmlCacheOnly,
  flushAllCache,
  cacheEvents,
  tagIndex,
  generateETag,
  getOrSetCache,
  purgeTagsLocal,
  invalidateTags,
  withCache
};
