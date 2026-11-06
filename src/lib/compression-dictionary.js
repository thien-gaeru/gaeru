'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const DCB_MAGIC = Buffer.from([0xff, 0x44, 0x43, 0x42]); // \xffDCB (RFC 9842)
const DICT_PATH = path.join(__dirname, '..', '..', 'assets', 'dict', 'shared-template.dict');

let cachedDict = null;

function isDcbEnabled() {
  // GAERU-06: Tắt DCB mặc định trên production cho đến khi có encoder/decoder chuẩn RFC 9842
  if (process.env.ENABLE_DCB === 'true') return true;
  if (process.env.DISABLE_DCB === 'true' || process.env.ENABLE_DCB === 'false') return false;
  if (process.env.NODE_ENV === 'production') return false;
  return true;
}

function getDictionaryInfo() {
  if (!cachedDict) {
    let buffer;
    if (fs.existsSync(DICT_PATH)) {
      buffer = fs.readFileSync(DICT_PATH);
    } else {
      buffer = Buffer.from('<!doctype html><html lang="vi"><head><meta charset="utf-8">', 'utf8');
    }
    const hash = crypto.createHash('sha256').update(buffer).digest();
    const hashBase64 = hash.toString('base64');
    const hashBase64Formatted = `:${hashBase64}:`;
    const version = hash.toString('hex').slice(0, 8);
    cachedDict = {
      buffer,
      hash,
      hashBase64,
      hashBase64Formatted,
      version
    };
  }
  return cachedDict;
}

function isDcbEligible(req) {
  if (!isDcbEnabled()) return false;
  if (!req || !['GET', 'HEAD'].includes(req.method)) return false;
  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  if (!acceptEncoding.includes('dcb')) return false;

  const availDict = String(req.headers['available-dictionary'] || '');
  if (!availDict) return false;

  const info = getDictionaryInfo();
  // Client can send either :<base64>: or <base64>
  return availDict.includes(info.hashBase64) || availDict.includes(info.hashBase64Formatted);
}

function compressDcb(rawBuffer) {
  const info = getDictionaryInfo();
  const compressed = zlib.brotliCompressSync(rawBuffer, {
    dictionary: info.buffer,
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 5
    }
  });
  return Buffer.concat([DCB_MAGIC, info.hash, compressed]);
}

function serveDictionaryRoute(req, res) {
  const info = getDictionaryInfo();
  const etag = `"gaeru-dict-${info.version}"`;

  res.setHeader('Use-As-Dictionary', 'match="/san-pham/*", match="/kham-pha/*", match="/huong-dan/*", match="/tin-tuc/*", match="/cua-hang", match="/", id="gaeru-dict"');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', info.buffer.length);
  res.setHeader('ETag', etag);
  res.setHeader('Vary', 'Accept-Encoding');

  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  if (req.method === 'HEAD') {
    return res.status(200).end();
  }

  return res.end(info.buffer);
}

module.exports = {
  DCB_MAGIC,
  getDictionaryInfo,
  isDcbEnabled,
  isDcbEligible,
  compressDcb,
  serveDictionaryRoute
};
