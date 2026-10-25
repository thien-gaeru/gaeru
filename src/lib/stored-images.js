'use strict';

const { downloadProductImage } = require('./neon-storage');
const STORAGE_POINTER_PREFIX = Buffer.from('GAERU_S3_V1:', 'ascii');

async function readStoredImage(content) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (data.subarray(0, STORAGE_POINTER_PREFIX.length).equals(STORAGE_POINTER_PREFIX)) {
    return downloadProductImage(data.subarray(STORAGE_POINTER_PREFIX.length).toString('utf8'));
  }
  return data;
}

module.exports = { readStoredImage, STORAGE_POINTER_PREFIX };
