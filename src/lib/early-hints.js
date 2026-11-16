'use strict';

const path = require('node:path');
const { getAssetHash12 } = require('./static-asset-cache');

const projectRoot = path.join(__dirname, '..', '..');

function resolvePreloadHint(filename) {
  const hash12 = getAssetHash12(projectRoot, filename);
  return `</${filename}${hash12 ? `?v=${hash12}` : ''}>; rel=preload; as=style`;
}

const EARLY_HINT_PRELOADS = [
  resolvePreloadHint('styles.css'),
  resolvePreloadHint('brand.css')
];

function earlyHintsMiddleware(req, res, next) {
  // Only send 103 Early Hints if explicitly enabled via environment variable.
  // Reverse proxies such as Hostinger LiteSpeed / CloudLinux / HCDN do not support
  // HTTP/1.1 103 interim responses and corrupt the subsequent HTTP/1.1 200 status line,
  // resulting in ERR_INVALID_RESPONSE on client browsers.
  if (process.env.EARLY_HINTS_ENABLED === 'true' && ['GET', 'HEAD'].includes(req.method) && !/^\/(?:api|gaeru_ceo|admin)(?:\/|$)/.test(req.path)) {
    if (typeof res.writeEarlyHints === 'function') {
      try {
        res.writeEarlyHints({ link: EARLY_HINT_PRELOADS });
      } catch (_) {
        // Ignored safely if stream closed or mocked
      }
    }
  }
  next();
}

module.exports = {
  earlyHintsMiddleware,
  EARLY_HINT_PRELOADS
};
