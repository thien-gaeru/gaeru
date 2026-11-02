'use strict';

const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { LRUCache } = require('lru-cache');

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

// Đổi mới mỗi khi sửa code và restart server -> Ép trình duyệt bỏ bản cũ ngay lập tức
const BOOT_ID = Date.now().toString(36);

// L1 RAM Cache: Tối đa 500 mục
const ramCache = new LRUCache({ max: 500 });

// Lưu tồn kho thời gian thực trên RAM
const stockMap = new Map();

// Singleflight Map: Gộp các request đồng thời thành 1 truy vấn duy nhất
const inflight = new Map();

// Safe Cloudflare Edge Purge helper
let edgePurgeService = null;
try {
  edgePurgeService = require('./src/lib/edge-purge').edgePurge;
} catch (_) {}

function clearHtmlCacheOnly() {
  for (const key of ramCache.keys()) {
    if (typeof key === 'string' && key.startsWith('html:')) {
      ramCache.delete(key);
    }
  }
}

function flushAllCache() {
  ramCache.clear();
  if (edgePurgeService && typeof edgePurgeService.purgeCatalog === 'function') {
    edgePurgeService.purgeCatalog().catch(() => {});
  }
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
function smartPageCache() {
  return (req, res, next) => {
    if (req.method !== 'GET') return next();

    // Bỏ qua cache với route riêng tư / session nhạy cảm
    if (req.session?.customer || req.session?.admin) return next();
    if (/^\/(?:tai-khoan|gio-hang|thanh-toan|ket-qua-thanh-toan|admin|gaeru_ceo|api)(?:\/|$)/i.test(req.path)) {
      return next();
    }

    const key = `html:${req.originalUrl}`;

    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('CDN-Cache-Control', 'public, max-age=5, stale-while-revalidate=15');
    res.setHeader('Cloudflare-CDN-Cache-Control', 'public, max-age=5, stale-while-revalidate=15');

    const hit = ramCache.get(key);
    if (hit) {
      if (req.headers['if-none-match'] === hit.etag) {
        return res.status(304).end();
      }

      res.setHeader('ETag', hit.etag);
      res.setHeader('X-Cache', 'HIT-FRESH-RAM');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');

      const acceptEncoding = req.headers['accept-encoding'] || '';
      if (acceptEncoding.includes('br') && hit.br) {
        res.setHeader('Content-Encoding', 'br');
        return res.end(hit.br);
      }
      if (acceptEncoding.includes('gzip') && hit.gz) {
        res.setHeader('Content-Encoding', 'gzip');
        return res.end(hit.gz);
      }
      return res.send(hit.raw);
    }

    const origSend = res.send.bind(res);
    res.send = (body) => {
      if (res.statusCode === 200 && typeof body === 'string') {
        const etag = `"${BOOT_ID}-${crypto.createHash('md5').update(body).digest('hex')}"`;
        res.setHeader('ETag', etag);

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
          ramCache.set(key, { raw: body, br, gz, etag });
        }).catch(() => {});
      }

      res.setHeader('X-Cache', 'MISS-REBUILT');
      return origSend(body);
    };

    next();
  };
}

// 3. Giữ chỗ & trừ tồn kho nguyên tử (Chống bán lố 100%)
function reserveStock(skuOrId, qty) {
  const current = stockMap.get(skuOrId) ?? 0;
  const quantity = Number.parseInt(qty, 10) || 1;
  if (current < quantity) {
    return { ok: false, remaining: current };
  }
  const remaining = current - quantity;
  stockMap.set(skuOrId, remaining);
  return { ok: true, remaining };
}

// Hoàn kho nguyên tử khi lỗi hoặc hủy đơn
function releaseStock(skuOrId, qty) {
  const current = stockMap.get(skuOrId) ?? 0;
  const quantity = Number.parseInt(qty, 10) || 1;
  const remaining = current + quantity;
  stockMap.set(skuOrId, remaining);
  return { ok: true, remaining };
}

// Seed tồn kho từ DB
function seedStock(skuOrId, qty) {
  stockMap.set(skuOrId, Number.parseInt(qty, 10) || 0);
}

module.exports = {
  BOOT_ID,
  ramCache,
  stockMap,
  inflight,
  getFreshData,
  smartPageCache,
  reserveStock,
  releaseStock,
  seedStock,
  clearHtmlCacheOnly,
  flushAllCache
};
