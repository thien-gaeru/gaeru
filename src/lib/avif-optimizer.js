'use strict';
const fs = require('node:fs');
const path = require('node:path');

function canServeAvif(acceptHeader) {
  if (!acceptHeader || typeof acceptHeader !== 'string') return false;
  return acceptHeader.includes('image/avif');
}

function avifNegotiationMiddleware(options = {}) {
  const rootDirs = options.rootDirs || [
    path.join(__dirname, '..', '..', 'assets'),
    path.join(__dirname, '..', '..')
  ];

  return function (req, res, next) {
    // Only inspect GET or HEAD requests for images
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const accept = req.headers['accept'] || '';
    if (!canServeAvif(accept)) {
      res.vary('Accept');
      return next();
    }

    const urlPath = req.path;
    // Check if target is an image file with standard extensions (.webp, .jpg, .jpeg, .png)
    const match = urlPath.match(/\.(webp|jpg|jpeg|png)$/i);
    if (!match) return next();

    // Check if an equivalent .avif file exists
    const avifRelativePath = urlPath.replace(/\.(webp|jpg|jpeg|png)$/i, '.avif');
    
    // Look up in candidate root directories
    for (const root of rootDirs) {
      const fullPath = path.join(root, avifRelativePath.replace(/^\/+/, ''));
      if (fs.existsSync(fullPath)) {
        res.vary('Accept');
        res.type('image/avif');
        res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
        return res.sendFile(fullPath);
      }
    }

    res.vary('Accept');
    next();
  };
}

module.exports = {
  canServeAvif,
  avifNegotiationMiddleware
};
