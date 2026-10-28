'use strict';
// Optimize all new product-image uploads before writing to persistent storage.
const sharp = require('sharp');
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_PIXELS = 24_000_000;
const MAX_DIMENSION = 1600;
const EXPECTED_FORMATS = Object.freeze({
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic':'heif'
});

function invalidImage() {
  const error = new Error('Chọn ảnh tĩnh PNG, JPG hoặc WebP hợp lệ, tối đa 24 MP. Nếu HEIC chưa được hỗ trợ, hãy chuyển sang JPG trước.');
  error.status = 400;
  return error;
}

async function encodeImage(buffer, mimeType, {maxUploadBytes=MAX_UPLOAD_BYTES}={}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 ||
      buffer.length > maxUploadBytes || !EXPECTED_FORMATS[mimeType]) {
    throw invalidImage();
  }
  try {
    const pixelLimit = maxUploadBytes === Infinity ? 100_000_000 : MAX_INPUT_PIXELS;
    const input = { failOn: 'error', limitInputPixels: pixelLimit };
    const info = await sharp(buffer, input).metadata();
    if (info.format !== EXPECTED_FORMATS[mimeType] ||
        !info.width || !info.height ||
        info.width * info.height > pixelLimit || (info.pages||1)>1) {
      throw invalidImage();
    }
    if(info.format==='webp'&&info.width<=MAX_DIMENSION&&info.height<=MAX_DIMENSION&&!info.exif&&!info.icc&&!info.xmp&&!info.orientation)return {buffer,mimeType:'image/webp'};
    const webp = await sharp(buffer, input)
      .rotate() // Apply EXIF orientation; output metadata is stripped.
      .resize(MAX_DIMENSION, MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .toColourspace('srgb')
      .webp({ quality: 90, alphaQuality:100, effort: 5, smartSubsample:true })
      .toBuffer();
    if (webp.length === 0 || webp.length > maxUploadBytes) {
      throw invalidImage();
    }
    return { buffer: webp, mimeType: 'image/webp' };
  } catch (_error) {
    throw invalidImage();
  }
}

let active=0;const waiting=[];
async function optimizeImage(...args){if(active>=2){if(waiting.length>=8)throw Object.assign(Error('Đang tối ưu nhiều ảnh. Vui lòng thử lại sau.'),{status:503,code:'IMAGE_PROCESSING_BUSY'});await new Promise(resolve=>waiting.push(resolve));}active++;try{return await encodeImage(...args);}finally{active--;waiting.shift()?.();}}
module.exports = { optimizeImage, optimizeProductImage:optimizeImage };
