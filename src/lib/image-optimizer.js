'use strict';
// Optimize all new product-image uploads before writing to Neon or PostgreSQL.
const sharp = require('sharp');
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_PIXELS = 24_000_000;
const MAX_DIMENSION = 1600;
const EXPECTED_FORMATS = Object.freeze({
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp'
});

function invalidImage() {
  const error = new Error('Ảnh không hợp lệ hoặc độ phân giải quá lớn (tối đa 24 MP).');
  error.status = 400;
  return error;
}

async function optimizeProductImage(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 ||
      buffer.length > MAX_UPLOAD_BYTES || !EXPECTED_FORMATS[mimeType]) {
    throw invalidImage();
  }
  try {
    const input = { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS };
    const info = await sharp(buffer, input).metadata();
    if (info.format !== EXPECTED_FORMATS[mimeType] ||
        !info.width || !info.height ||
        info.width * info.height > MAX_INPUT_PIXELS) {
      throw invalidImage();
    }
    const webp = await sharp(buffer, input)
      .rotate() // Apply EXIF orientation; output metadata is stripped.
      .resize(MAX_DIMENSION, MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({ quality: 78, effort: 3 })
      .toBuffer();
    if (webp.length === 0 || webp.length > MAX_UPLOAD_BYTES) {
      throw invalidImage();
    }
    return { buffer: webp, mimeType: 'image/webp' };
  } catch (_error) {
    throw invalidImage();
  }
}

module.exports = { optimizeProductImage };
