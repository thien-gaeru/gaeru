'use strict';
// Optimize all new product-image uploads before writing to persistent storage.
const sharp = require('sharp');
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_PIXELS = 24_000_000;
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;
const MAX_WEBP_DIMENSION = 16383;
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

function outputTooLarge() {
  return Object.assign(new Error('Ảnh WebP giữ nguyên chi tiết vượt 25 MB. Hãy chọn ảnh nhỏ hơn; hệ thống không tự giảm chất lượng ảnh.'), {status:413,code:'IMAGE_OUTPUT_TOO_LARGE'});
}

let pixelsInUse=0;
const pixelWaiters=[];
async function reservePixels(pixels){
  if(!pixelWaiters.length&&pixelsInUse+pixels<=MAX_INPUT_PIXELS)pixelsInUse+=pixels;
  else await new Promise(resolve=>pixelWaiters.push({pixels,resolve}));
  return ()=>{
    pixelsInUse-=pixels;
    while(pixelWaiters.length&&pixelsInUse+pixelWaiters[0].pixels<=MAX_INPUT_PIXELS){
      const next=pixelWaiters.shift();pixelsInUse+=next.pixels;next.resolve();
    }
  };
}

async function encodeImage(buffer, mimeType, {maxUploadBytes=MAX_UPLOAD_BYTES,maxOutputBytes=MAX_OUTPUT_BYTES,removeBackground=false,...backgroundOptions}={}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 ||
      buffer.length > maxUploadBytes || !EXPECTED_FORMATS[mimeType]) {
    throw invalidImage();
  }
  try {
    const input = { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS };
    const info = await sharp(buffer, input).metadata();
    if (info.format !== EXPECTED_FORMATS[mimeType] ||
        !info.width || !info.height ||
        info.width * info.height > MAX_INPUT_PIXELS || (info.pages||1)>1 ||
        info.width > MAX_WEBP_DIMENSION || info.height > MAX_WEBP_DIMENSION) {
      throw invalidImage();
    }
    // WebP is an 8-bit format. Keep higher-depth originals rather than silently
    // quantizing them while claiming a lossless conversion.
    if(info.depth && info.depth !== 'uchar') throw Object.assign(new Error('Ảnh cần ở hệ màu sRGB 8-bit để chuyển WebP không mất dữ liệu. Bản ảnh có độ sâu màu cao hơn cần được chuyển riêng.'), {status:400,code:'IMAGE_BIT_DEPTH_UNSUPPORTED'});
    // Full-size decoding and optional cutout masks have a second, weighted
    // budget. Two request slots must not decode two 24 MP images at once.
    const pixels=info.width*info.height;
    const releasePixels=await reservePixels(Math.min(MAX_INPUT_PIXELS,pixels*(removeBackground&&pixels<=8_000_000?3:1)));
    try {
    if(removeBackground){const cutout=await require('./product-background').removeWhiteBackground(buffer,backgroundOptions);if(cutout){if(cutout.length>maxOutputBytes)throw outputTooLarge();return {buffer:cutout,mimeType:'image/webp',backgroundRemoved:true};}}
    if(info.format==='webp'&&!info.exif&&!info.icc&&!info.xmp&&!info.orientation){
      await sharp(buffer,input).stats(); // Validate the complete image before storing it.
      if(buffer.length>maxOutputBytes)throw outputTooLarge();
      return {buffer,mimeType:'image/webp'};
    }
    const webp = await sharp(buffer, input)
      .rotate() // Apply EXIF orientation; output metadata is stripped.
      .toColourspace('srgb')
      .webp({ lossless:true, alphaQuality:100, effort:5 })
      .toBuffer();
    if (!webp.length) throw invalidImage();
    if (webp.length > maxOutputBytes) throw outputTooLarge();
    return { buffer: webp, mimeType: 'image/webp' };
    } finally {releasePixels();}
  } catch (error) {
    if(['IMAGE_OUTPUT_TOO_LARGE','IMAGE_BIT_DEPTH_UNSUPPORTED'].includes(error.code))throw error;
    throw invalidImage();
  }
}

let active=0;const waiting=[];
async function optimizeImage(...args){if(active>=2){if(waiting.length>=8)throw Object.assign(Error('Đang tối ưu nhiều ảnh. Vui lòng thử lại sau.'),{status:503,code:'IMAGE_PROCESSING_BUSY'});await new Promise(resolve=>waiting.push(resolve));}else active++;try{return await encodeImage(...args);}finally{const next=waiting.shift();if(next)next();else active--;}}
module.exports = { optimizeImage, optimizeProductImage:optimizeImage };
