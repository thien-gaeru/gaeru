'use strict';

const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { LRUCache } = require('lru-cache');

// Zero-Copy L1 RAM Cache with Pre-compressed Brotli & Gzip Buffers
class RamCache {
  constructor({
    maxEntries = Number(process.env.RAM_CACHE_MAX_ENTRIES) || 5000,
    maxByteSize = Number(process.env.RAM_CACHE_MAX_BYTES) || 256 * 1024 * 1024,
    defaultTtlMs = 60 * 60 * 1000
  } = {}) {
    this.defaultTtlMs = defaultTtlMs;
    this.lru = new LRUCache({
      max: maxEntries,
      maxSize: maxByteSize,
      sizeCalculation: (entry) => {
        const rawLen = entry.rawBuffer ? entry.rawBuffer.length : 1024;
        const brLen = entry.brotliBuffer ? entry.brotliBuffer.length : 0;
        const gzLen = entry.gzipBuffer ? entry.gzipBuffer.length : 0;
        return rawLen + brLen + gzLen;
      },
      ttl: defaultTtlMs
    });

    // Tag index: Map<tag, Set<cacheKey>> for O(1) instant invalidation
    this.tagIndex = new Map();

    // Singleflight: Map<key, Promise> to coalesce identical concurrent requests
    this.inFlight = new Map();

    // Metrics for performance monitoring
    this.metrics = {
      hits: 0,
      misses: 0,
      coalesced: 0,
      invalidations: 0,
      brotliBytesServed: 0,
      gzipBytesServed: 0,
      rawBytesServed: 0,
      notModifiedServed: 0
    };
  }

  generateETag(buffer) {
    const hash = crypto.createHash('sha256').update(buffer).digest('base64url').slice(0, 16);
    return `W/"${hash}"`;
  }

  // Pre-compress payload into Brotli & Gzip binary buffers
  prepareEntry({ key, payload, contentType = 'application/json; charset=utf-8', tags = [], ttlMs = this.defaultTtlMs }) {
    let rawBuffer;
    if (Buffer.isBuffer(payload)) {
      rawBuffer = payload;
    } else if (typeof payload === 'string') {
      rawBuffer = Buffer.from(payload, 'utf8');
    } else {
      rawBuffer = Buffer.from(JSON.stringify(payload), 'utf8');
    }

    const etag = this.generateETag(rawBuffer);

    // Fast Brotli compression (level 4: optimal trade-off between speed & compression ratio)
    let brotliBuffer = null;
    try {
      brotliBuffer = zlib.brotliCompressSync(rawBuffer, {
        params: {
          [zlib.constants.BROTLI_PARAM_MODE]: contentType.includes('html') ? zlib.constants.BROTLI_MODE_TEXT : zlib.constants.BROTLI_MODE_GENERIC,
          [zlib.constants.BROTLI_PARAM_QUALITY]: 4
        }
      });
    } catch {
      brotliBuffer = null;
    }

    // Fast Gzip compression (level 6)
    let gzipBuffer = null;
    try {
      gzipBuffer = zlib.gzipSync(rawBuffer, { level: 6 });
    } catch {
      gzipBuffer = null;
    }

    const normalizedTags = Array.isArray(tags) ? tags.map(t => String(t).trim().toLowerCase()) : [];

    const entry = {
      key,
      rawBuffer,
      brotliBuffer,
      gzipBuffer,
      etag,
      contentType,
      tags: normalizedTags,
      createdAt: Date.now(),
      ttlMs
    };

    this.lru.set(key, entry, { ttl: ttlMs });

    // Index tags for rapid multi-target invalidation
    for (const tag of normalizedTags) {
      if (!this.tagIndex.has(tag)) {
        this.tagIndex.set(tag, new Set());
      }
      this.tagIndex.get(tag).add(key);
    }

    return entry;
  }

  get(key) {
    const entry = this.lru.get(key);
    if (entry) {
      this.metrics.hits++;
      return entry;
    }
    this.metrics.misses++;
    return null;
  }

  // Singleflight wrapper: execute factory once for N concurrent requests to the same key
  async getOrCoalesce(key, factoryFn, options = {}) {
    const existing = this.get(key);
    if (existing) return existing;

    if (this.inFlight.has(key)) {
      this.metrics.coalesced++;
      return await this.inFlight.get(key);
    }

    const promise = (async () => {
      try {
        const payload = await factoryFn();
        if (payload === null || payload === undefined) return null;
        return this.prepareEntry({ key, payload, ...options });
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return await promise;
  }

  // Zero-copy response transmission directly from RAM buffers
  serveCached(req, res, entry, { edgeMaxAge = 3600, edgeStaleWhileRevalidate = 86400, cacheControl = 'public, max-age=60, stale-while-revalidate=86400' } = {}) {
    if (!entry) return false;

    // 1. Conditional Request: 304 Not Modified in < 0.03ms
    const clientEtag = req.headers['if-none-match'];
    if (clientEtag && (clientEtag === entry.etag || clientEtag === entry.etag.replace(/^W\//, '') || `W/${clientEtag}` === entry.etag)) {
      this.metrics.notModifiedServed++;
      res.statusCode = 304;
      res.setHeader('ETag', entry.etag);
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('CDN-Cache-Control', `public, s-maxage=${edgeMaxAge}, stale-while-revalidate=${edgeStaleWhileRevalidate}`);
      res.setHeader('Cloudflare-CDN-Cache-Control', `public, s-maxage=${edgeMaxAge}, stale-while-revalidate=${edgeStaleWhileRevalidate}`);
      if (entry.tags && entry.tags.length > 0) {
        res.setHeader('Cache-Tag', entry.tags.join(', '));
      }
      res.end();
      return true;
    }

    // 2. Set Content & Cache Headers
    res.setHeader('Content-Type', entry.contentType);
    res.setHeader('ETag', entry.etag);
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('CDN-Cache-Control', `public, s-maxage=${edgeMaxAge}, stale-while-revalidate=${edgeStaleWhileRevalidate}`);
    res.setHeader('Cloudflare-CDN-Cache-Control', `public, s-maxage=${edgeMaxAge}, stale-while-revalidate=${edgeStaleWhileRevalidate}`);
    res.setHeader('X-GAERU-Cache', 'HIT-L1-RAM');

    if (entry.tags && entry.tags.length > 0) {
      res.setHeader('Cache-Tag', entry.tags.join(', '));
    }

    // 3. Negotiate Encoding (Zero-copy binary transmission)
    const acceptEncoding = String(req.headers['accept-encoding'] || '');
    if (entry.brotliBuffer && acceptEncoding.includes('br')) {
      this.metrics.brotliBytesServed += entry.brotliBuffer.length;
      res.setHeader('Content-Encoding', 'br');
      res.setHeader('Content-Length', entry.brotliBuffer.length);
      res.end(entry.brotliBuffer);
      return true;
    }

    if (entry.gzipBuffer && acceptEncoding.includes('gzip')) {
      this.metrics.gzipBytesServed += entry.gzipBuffer.length;
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', entry.gzipBuffer.length);
      res.end(entry.gzipBuffer);
      return true;
    }

    this.metrics.rawBytesServed += entry.rawBuffer.length;
    res.setHeader('Content-Length', entry.rawBuffer.length);
    res.end(entry.rawBuffer);
    return true;
  }

  // Invalidate specific cache key
  invalidateKey(key) {
    const entry = this.lru.get(key);
    if (entry) {
      for (const tag of entry.tags) {
        this.tagIndex.get(tag)?.delete(key);
      }
      this.lru.delete(key);
      this.metrics.invalidations++;
    }
  }

  // Invalidate all keys matching a specific tag in 0.01ms
  invalidateTag(tag) {
    const normTag = String(tag).trim().toLowerCase();
    const keys = this.tagIndex.get(normTag);
    if (keys && keys.size > 0) {
      for (const k of [...keys]) {
        this.invalidateKey(k);
      }
      this.tagIndex.delete(normTag);
    }
  }

  // Invalidate product specific cache (HTML & API)
  invalidateProduct(slug) {
    const cleanSlug = String(slug || '').trim().toLowerCase();
    this.invalidateTag(`gaeru-product-${cleanSlug}`);
    this.invalidateKey(`api:product:${cleanSlug}`);
    this.invalidateKey(`html:product:${cleanSlug}`);
    // A product change also affects search index and catalog listings
    this.invalidateTag('gaeru-catalog');
    this.invalidateKey('api:products:all');
    this.invalidateKey('api:search-index');
    this.invalidateKey('html:shop');
    this.invalidateKey('html:home');
  }

  // Invalidate all catalog & store pages
  invalidateCatalog() {
    this.invalidateTag('gaeru-catalog');
    this.invalidateTag('gaeru-html');
    this.invalidateKey('api:products:all');
    this.invalidateKey('api:search-index');
    this.invalidateKey('html:shop');
    this.invalidateKey('html:home');
  }

  clear() {
    this.lru.clear();
    this.tagIndex.clear();
    this.inFlight.clear();
    this.metrics.invalidations++;
  }

  getStats() {
    return {
      size: this.lru.size,
      byteSize: this.lru.calculatedSize,
      tagsCount: this.tagIndex.size,
      inFlightCount: this.inFlight.size,
      ...this.metrics
    };
  }
}

// Global Singleton Instance
const ramCache = new RamCache();

module.exports = {
  RamCache,
  ramCache
};
