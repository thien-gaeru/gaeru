'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { LRUCache } = require('lru-cache');

const COMPRESS_THRESHOLD = 1024;
const SKIP_CACHE_FILES = new Set(['account.js', 'checkout-flow.js', 'payment-result.js', 'account-security.js', 'account-deletion.js']);
const TEXT_ASSET_MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};
const HASHED_FILENAME_RE = /-[0-9a-f]{8,32}\.(?:js|css)$/i;
const IS_ARM64 = process.arch === 'arm64';
const STATIC_ASSET_MAX_BYTES = Math.max(
  2 * 1024 * 1024,
  Number.parseInt(process.env.STATIC_ASSET_CACHE_MAX_BYTES || '', 10) || (IS_ARM64 ? 16 * 1024 * 1024 : 32 * 1024 * 1024)
);

const assetCache = new LRUCache({
  max: 500,
  maxSize: STATIC_ASSET_MAX_BYTES,
  sizeCalculation: (entry) => (entry?.raw?.length || 0) + (entry?.gzip?.length || 0) + (entry?.br?.length || 0) + 256
});

function buildEntry(fullPath, ext, stat) {
  const raw = fs.readFileSync(fullPath);
  const hash12 = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  const canCompress = raw.length >= COMPRESS_THRESHOLD;
  const gzip = canCompress ? zlib.gzipSync(raw, { level: 6 }) : null;
  const br = canCompress
    ? zlib.brotliCompressSync(raw, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 6,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length
        }
      })
    : null;
  return {
    raw,
    gzip: gzip && gzip.length < raw.length ? gzip : null,
    br: br && br.length < raw.length ? br : null,
    hash12,
    contentType: TEXT_ASSET_MIME[ext],
    lastModified: stat.mtime.toUTCString(),
    mtimeMs: stat.mtimeMs,
    size: stat.size
  };
}

function getEntry(projectRoot, filename, ext) {
  const key = `${projectRoot}\0${filename}`;
  const isProd = process.env.NODE_ENV === 'production';
  const cached = assetCache.get(key);
  if (cached && isProd) return cached;

  const fullPath = path.join(projectRoot, filename);
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedFile = path.resolve(fullPath);
  if (!resolvedFile.startsWith(resolvedRoot + path.sep)) return null;

  let stat;
  try {
    stat = fs.statSync(resolvedFile);
  } catch {
    assetCache.delete(key);
    return null;
  }
  if (!stat.isFile()) return null;
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached;
  }
  const entry = buildEntry(resolvedFile, ext, stat);
  assetCache.set(key, entry);
  return entry;
}

function negotiateEncoding(acceptEncodingHeader, entry) {
  if (!acceptEncodingHeader || (!entry.br && !entry.gzip)) return 'raw';
  let brQ = 0;
  let gzipQ = 0;
  for (const part of String(acceptEncodingHeader).toLowerCase().split(',')) {
    const pieces = part.trim().split(';');
    const coding = pieces[0]?.trim();
    if (!coding) continue;
    let q = 1;
    for (let i = 1; i < pieces.length; i++) {
      const m = /^q\s*=\s*([0-9.]+)$/.exec(pieces[i].trim());
      if (m) {
        const parsed = Number(m[1]);
        if (Number.isFinite(parsed)) q = parsed;
      }
    }
    if (coding === 'br' && q > brQ) brQ = q;
    else if (coding === 'gzip' && q > gzipQ) gzipQ = q;
  }
  if (brQ > 0 && entry.br && brQ >= gzipQ) return 'br';
  if (gzipQ > 0 && entry.gzip) return 'gzip';
  if (brQ > 0 && entry.br) return 'br';
  return 'raw';
}

function etagMatches(ifNoneMatch, currentEtag) {
  if (!ifNoneMatch) return false;
  const raw = String(ifNoneMatch).trim();
  if (raw === '*') return true;
  const target = currentEtag.replace(/^W\//i, '');
  return raw.split(',').some((item) => item.trim().replace(/^W\//i, '') === target);
}

function isCacheableTextAsset(filename) {
  return (
    typeof filename === 'string' &&
    filename.length > 0 &&
    !filename.includes('/') &&
    !filename.includes('\\') &&
    !SKIP_CACHE_FILES.has(filename) &&
    Object.prototype.hasOwnProperty.call(TEXT_ASSET_MIME, path.extname(filename).toLowerCase())
  );
}

/**
 * Serves reviewed public CSS/JS files from RAM with pre-compressed Brotli/Gzip buffers
 * and promotes verified ?v=<sha256_hash12> or hashed filenames to immutable caching.
 */
function createStaticAssetMiddleware(projectRoot, publicFiles) {
  const resolvedRoot = path.resolve(projectRoot);
  return function staticAssetCacheMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.headers.range) return next();
    let pathname = req.path || '/';
    try {
      for (let i = 0; i < 4; i++) {
        const decoded = decodeURIComponent(pathname);
        if (decoded === pathname) break;
        pathname = decoded;
      }
      pathname = path.posix.normalize(pathname.replace(/\\/g, '/'));
    } catch {
      return next();
    }
    if (!pathname.startsWith('/')) return next();
    const filename = pathname.slice(1);
    if (!publicFiles?.has(filename) || !isCacheableTextAsset(filename)) return next();

    const ext = path.extname(filename).toLowerCase();
    const entry = getEntry(resolvedRoot, filename, ext);
    if (!entry) return next();

    const encoding = negotiateEncoding(req.headers['accept-encoding'], entry);
    const body = encoding === 'br' ? entry.br : (encoding === 'gzip' ? entry.gzip : entry.raw);
    // Weak ETag preserves RFC 9110 conditional 304 matching while allowing Cloudflare Edge
    // to apply Brotli/Gzip compression when CDN cache pulls pull raw bytes from origin.
    const etag = `W/"${entry.hash12}-${encoding}"`;
    const isImmutable =
      HASHED_FILENAME_RE.test(filename) ||
      (typeof req.query?.v === 'string' && req.query.v === entry.hash12);

    res.setHeader(
      'Cache-Control',
      isImmutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate'
    );
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', entry.lastModified);
    res.vary('Accept-Encoding');

    if (etagMatches(req.headers['if-none-match'], etag)) {
      return res.status(304).end();
    }

    res.setHeader('Content-Type', entry.contentType);
    if (encoding !== 'raw') {
      res.setHeader('Content-Encoding', encoding);
    }
    res.setHeader('Content-Length', String(body.length));

    if (req.method === 'HEAD') {
      return res.status(200).end();
    }
    return res.status(200).end(body);
  };
}

/**
 * Pre-warms public CSS/JS buffers and pre-compressed variants into worker RAM at startup.
 */
function warmStaticTextAssets(projectRoot, publicFiles) {
  const resolvedRoot = path.resolve(projectRoot);
  let warmed = 0;
  for (const filename of publicFiles || []) {
    if (!isCacheableTextAsset(filename)) continue;
    const ext = path.extname(filename).toLowerCase();
    if (getEntry(resolvedRoot, filename, ext)) warmed++;
  }
  return warmed;
}

/**
 * Returns the cached 12-character SHA-256 content hash for a cacheable public CSS/JS asset.
 */
function getAssetHash12(projectRoot, filename) {
  if (!isCacheableTextAsset(filename)) return null;
  const entry = getEntry(path.resolve(projectRoot), filename, path.extname(filename).toLowerCase());
  return entry ? entry.hash12 : null;
}

module.exports = {
  createStaticAssetMiddleware,
  warmStaticTextAssets,
  getAssetHash12,
  _clearCacheForTest: () => assetCache.clear()
};
