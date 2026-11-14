'use strict';
const sharp = require('sharp');

try {
  sharp.concurrency(Math.max(1, Number(process.env.SHARP_CONCURRENCY) || (process.arch === 'arm64' ? 1 : 2)));
  sharp.cache({ memory: 32, files: 0, items: 64 });
} catch (_) {}

const MIN_AVIF_SOURCE_BYTES = 16 * 1024;
const SAVINGS_RATIO = 0.88;
const DEFAULT_AVIF_EFFORT = process.arch === 'arm64' ? 1 : 2;
const DEFAULT_WEBP_EFFORT = process.arch === 'arm64' ? 1 : 2;

function clientSupportsAvif(req) {
  if (!req) return false;
  const format = req.query?.format;
  if (format === 'webp') return false;
  if (format === 'avif') return true;
  const accept = String(req.headers?.accept || '');
  return /\bimage\/avif\b/i.test(accept);
}

function qualifiesForSelectiveAvif(req, sourceByteSize) {
  if (!clientSupportsAvif(req)) return false;
  if (typeof sourceByteSize === 'number' && sourceByteSize > 0 && sourceByteSize < MIN_AVIF_SOURCE_BYTES) {
    return false;
  }
  return true;
}

async function encodeAvif(inputBuffer, { width, quality = 68, effort = DEFAULT_AVIF_EFFORT, chromaSubsampling = '4:4:4', tune = 'ssim' } = {}) {
  let pipeline = sharp(inputBuffer, { limitInputPixels: 24000000 }).rotate();
  if (width) pipeline = pipeline.resize({ width, withoutEnlargement: true });
  return pipeline.avif({ quality, effort, chromaSubsampling, tune }).toBuffer();
}

async function encodeWebp(inputBuffer, { width, quality = 84, alphaQuality = 92, effort = DEFAULT_WEBP_EFFORT, lossless = false } = {}) {
  let pipeline = sharp(inputBuffer, { limitInputPixels: 24000000 }).rotate();
  if (width) pipeline = pipeline.resize({ width, withoutEnlargement: true });
  return lossless
    ? pipeline.webp({ lossless: true, effort: 1 }).toBuffer()
    : pipeline.webp({ quality, alphaQuality, effort }).toBuffer();
}

module.exports = {
  MIN_AVIF_SOURCE_BYTES,
  SAVINGS_RATIO,
  clientSupportsAvif,
  qualifiesForSelectiveAvif,
  encodeAvif,
  encodeWebp
};
