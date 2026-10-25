'use strict';

const STORAGE_POINTER_PREFIX = Buffer.from('GAERU_S3_V1:', 'ascii');

const {readMedia:readStoredImage}=require('./stored-media');

module.exports = { readStoredImage, STORAGE_POINTER_PREFIX };
