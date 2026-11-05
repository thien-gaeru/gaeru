'use strict';

const EARLY_HINT_PRELOADS = [
  '</styles.css?v=20261103-experience>; rel=preload; as=style',
  '</brand.css?v=20261025-webp>; rel=preload; as=style'
];

function earlyHintsMiddleware(req, res, next) {
  if (['GET', 'HEAD'].includes(req.method) && !/^\/(?:api|gaeru_ceo|admin)(?:\/|$)/.test(req.path)) {
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
