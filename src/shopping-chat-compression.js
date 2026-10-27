'use strict';
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { withTransaction } = require('./db');

const gzipAsync = promisify(zlib.gzip);
const COMPRESSED_PREFIX = Buffer.from('GAERU_ZLIB_V1:');

function isCompressedBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > COMPRESSED_PREFIX.length && buffer.subarray(0, COMPRESSED_PREFIX.length).equals(COMPRESSED_PREFIX);
}

async function compressBuffer(buffer, _mime = 'application/octet-stream') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 128 || isCompressedBuffer(buffer)) {
    return { buffer, compressed: false, originalSize: buffer?.length || 0, compressedSize: buffer?.length || 0 };
  }
  try {
    const gz = await gzipAsync(buffer, { level: zlib.constants.Z_DEFAULT_COMPRESSION });
    const header = Buffer.from(JSON.stringify({
      alg: 'gzip',
      rawSize: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex')
    }) + '\n');
    const wrapped = Buffer.concat([COMPRESSED_PREFIX, header, gz]);
    if (wrapped.length + 32 < buffer.length) {
      return {
        buffer: wrapped,
        compressed: true,
        originalSize: buffer.length,
        compressedSize: wrapped.length
      };
    }
  } catch {
    // Fall back to original buffer if compression fails
  }
  return { buffer, compressed: false, originalSize: buffer.length, compressedSize: buffer.length };
}

function decompressBuffer(buffer) {
  if (!isCompressedBuffer(buffer)) return buffer;
  const newlineIndex = buffer.indexOf(10, COMPRESSED_PREFIX.length);
  if (newlineIndex === -1) throw new Error('Invalid compressed chat payload header');
  const meta = JSON.parse(buffer.subarray(COMPRESSED_PREFIX.length, newlineIndex).toString('utf8'));
  const payload = buffer.subarray(newlineIndex + 1);
  const raw = zlib.gunzipSync(payload);
  if (Number.isSafeInteger(meta.rawSize) && raw.length !== meta.rawSize) {
    throw new Error('Compressed chat payload size mismatch');
  }
  if (meta.sha256 && createHash('sha256').update(raw).digest('hex') !== meta.sha256) {
    throw new Error('Compressed chat payload checksum mismatch');
  }
  return raw;
}

async function processOneChatCompression(pool, targetId = null) {
  const { readMedia, storeMedia } = require('./lib/stored-media');
  const job = await withTransaction(pool, async (client) => {
    const row = (await client.query(
      targetId
        ? `SELECT id, name, mime, content, byte_size, original_byte_size
           FROM shopping_chat_files
           WHERE id = $1 AND compression_status = 'pending'
           FOR UPDATE SKIP LOCKED`
        : `SELECT id, name, mime, content, byte_size, original_byte_size
           FROM shopping_chat_files
           WHERE compression_status = 'pending'
           ORDER BY created_at ASC, id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1`,
      targetId ? [targetId] : []
    )).rows[0];
    if (!row) return null;
    await client.query(
      `UPDATE shopping_chat_files SET compression_status = 'processing' WHERE id = $1`,
      [row.id]
    );
    return row;
  });
  if (!job) return false;

  try {
    const raw = await readMedia(job.content);
    const originalSize = Number(job.original_byte_size || job.byte_size || raw.length);
    let nextBuffer = raw;
    let nextMime = job.mime;
    let nextName = job.name;
    let wasCompressed = false;

    if (['image/jpeg', 'image/png', 'image/heic'].includes(job.mime)) {
      try {
        const optimized = await require('./lib/image-optimizer').optimizeImage(raw, job.mime, { maxUploadBytes: Infinity });
        if (optimized.buffer.length < raw.length) {
          nextBuffer = optimized.buffer;
          nextMime = optimized.mimeType;
          if (nextMime === 'image/webp') nextName = nextName.replace(/\.[^.]+$/, '') + '.webp';
          wasCompressed = true;
        }
      } catch {
        // Keep original image if sharp cannot optimize further
      }
    }

    if (!wasCompressed) {
      const gz = await compressBuffer(nextBuffer, nextMime);
      if (gz.compressed) {
        nextBuffer = gz.buffer;
        wasCompressed = true;
      }
    }

    if (wasCompressed) {
      const storedContent = await storeMedia('chat', nextBuffer, nextMime);
      const logicalSize = nextMime === 'image/webp' && job.mime !== 'image/webp' ? nextBuffer.length : originalSize;
      await pool.query(
        `UPDATE shopping_chat_files
         SET name = $2,
             mime = $3,
             content = $4,
             byte_size = $5,
             original_byte_size = $6,
             compressed_byte_size = $7,
             compression_status = 'compressed'
         WHERE id = $1`,
        [job.id, nextName, nextMime, storedContent, logicalSize, originalSize, nextBuffer.length]
      );
    } else {
      await pool.query(
        `UPDATE shopping_chat_files
         SET original_byte_size = $2,
             compressed_byte_size = $3,
             compression_status = 'optimal'
         WHERE id = $1`,
        [job.id, originalSize, raw.length]
      );
    }
  } catch {
    await pool.query(
      `UPDATE shopping_chat_files SET compression_status = 'failed' WHERE id = $1`,
      [job.id]
    ).catch(() => {});
  }
  return true;
}

async function processChatCompression(pool, targetId = null) {
  if (targetId) return processOneChatCompression(pool, targetId);
  let count = 0;
  for (let i = 0; i < 10; i++) {
    if (!(await processOneChatCompression(pool))) break;
    count++;
  }
  return count > 0;
}

function startChatCompressionWorker(pool) {
  let stopped = false;
  let running = false;
  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      await processChatCompression(pool);
    } catch {
      // Ignore transient DB errors in background compression loop
    } finally {
      running = false;
    }
  }
  const timer = setInterval(tick, 2500);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

module.exports = {
  COMPRESSED_PREFIX,
  isCompressedBuffer,
  compressBuffer,
  decompressBuffer,
  processChatCompression,
  startChatCompressionWorker
};
