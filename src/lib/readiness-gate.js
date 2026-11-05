'use strict';

let isReady = true;
let startupError = null;

function setReady(ready = true) {
  isReady = Boolean(ready);
}

function setStartupError(err) {
  startupError = err;
  isReady = false;
}

function isAppReady() {
  return isReady;
}

function getReadiness() {
  return { isReady, startupError };
}

function resetReadinessForTesting() {
  isReady = true;
  startupError = null;
}

function readinessMiddleware(req, res, next) {
  // Liveness probes allowed at all times (returns 200 whether ready or initializing)
  if (req.path === '/healthz' || req.path === '/livez') {
    return res.status(200).json({ status: isReady ? 'ready' : 'initializing', isReady });
  }

  // Explicit readiness probe (returns 200 when ready, 503 when initializing/failed)
  if (req.path === '/readyz') {
    if (startupError) {
      return res.status(503).json({ status: 'failed', error: 'STARTUP_FAILED' });
    }
    if (!isReady) {
      return res.status(503).json({ status: 'initializing', isReady: false });
    }
    return res.status(200).json({ status: 'ready', isReady: true });
  }

  if (isReady) return next();

  // Reject business traffic while initializing with 503 and Retry-After
  res.setHeader('Retry-After', '1');
  res.setHeader('Cache-Control', 'no-store, must-revalidate');

  if (typeof req.accepts === 'function' && req.accepts('html')) {
    return res.status(503).type('html').send(
      '<!doctype html><html lang="vi"><head><meta charset="utf-8">' +
      '<title>GAERU - Đang khởi động</title>' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;text-align:center;padding:72px 24px;color:#1d1d1f;background:#f5f5f7}h1{font-size:24px;margin-bottom:12px}p{color:#6e6e73;font-size:16px}</style>' +
      '</head><body><h1>Hệ thống đang chuẩn bị dữ liệu</h1>' +
      '<p>Vui lòng đợi vài giây, trang sẽ tự động tải lại.</p>' +
      '<script>setTimeout(()=>location.reload(),1500);</script></body></html>'
    );
  }

  return res.status(503).json({
    error: 'SERVICE_INITIALIZING',
    message: 'Hệ thống đang khởi động, vui lòng thử lại sau giây lát.'
  });
}

module.exports = {
  setReady,
  setStartupError,
  isAppReady,
  getReadiness,
  resetReadinessForTesting,
  readinessMiddleware
};
