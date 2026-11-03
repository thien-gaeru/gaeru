'use strict';
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { createHash, randomUUID } = require('node:crypto');
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

const MAX_ATTEMPTS = 3;
const LEASE_MINUTES = 10;
async function reclaimExpired(pool) {
  await pool.query(`UPDATE shopping_chat_files SET compression_status='failed', compression_lease=NULL,
    compression_lease_until=NULL, compression_last_error='ATTEMPTS_EXHAUSTED'
    WHERE compression_status='processing' AND compression_lease_until<now() AND compression_attempts >= $1`,[MAX_ATTEMPTS]);
}
async function processOneChatCompression(pool, targetId = null, { readMedia, storeMedia, optimizeImage } = {}) {
  readMedia ||= require('./lib/stored-media').readMedia;
  storeMedia ||= require('./lib/stored-media').storeMedia;
  optimizeImage ||= require('./lib/image-optimizer').optimizeImage;
  await reclaimExpired(pool);
  const lease = randomUUID();
  const job = await withTransaction(pool, async client => {
    const row = (await client.query(`SELECT id,name,mime,content,byte_size,original_byte_size,original_content,original_mime,original_name
      FROM shopping_chat_files WHERE deleted_at IS NULL AND created_at>now()-interval '30 days'
      AND compression_attempts<$1 AND ($2::uuid IS NULL OR id=$2)
      AND ((compression_status='pending' AND compression_next_attempt_at<=now())
        OR (compression_status='processing' AND (compression_lease_until IS NULL OR compression_lease_until<now())))
      ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[MAX_ATTEMPTS,targetId])).rows[0];
    if(!row)return null;
    await client.query(`UPDATE shopping_chat_files SET compression_status='processing',compression_attempts=compression_attempts+1,
      compression_lease=$2,compression_lease_until=now()+interval '10 minutes',compression_last_error=NULL,
      original_content=COALESCE(original_content,content),original_mime=COALESCE(original_mime,mime),original_name=COALESCE(original_name,name) WHERE id=$1`,[row.id,lease]);
    return row;
  });
  if(!job)return false;
  let leaseLost=false;
  const heartbeat=setInterval(()=>{pool.query(`UPDATE shopping_chat_files SET compression_lease_until=now()+interval '10 minutes'
    WHERE id=$1 AND compression_lease=$2 AND compression_status='processing' AND deleted_at IS NULL`,[job.id,lease])
    .then(r=>{if(!r.rowCount)leaseLost=true;}).catch(()=>{leaseLost=true;});},30000);heartbeat.unref?.();
  try {
    const raw=await readMedia(job.original_content||job.content),originalMime=job.original_mime||job.mime;
    const originalSize=raw.length;
    let nextBuffer=raw,nextMime=originalMime,nextName=job.original_name||job.name,wasCompressed=false;
    if(['image/jpeg','image/png','image/heic'].includes(originalMime)){
      try {const optimized=await optimizeImage(raw,originalMime,{maxUploadBytes:Infinity});
        if(optimized.mimeType==='image/webp'){nextBuffer=optimized.buffer;nextMime=optimized.mimeType;wasCompressed=true;
          if(nextMime==='image/webp')nextName=nextName.replace(/\.[^.]+$/,'')+'.webp';}
      }catch{/* Original remains downloadable if an optional optimization is unsupported. */}
    }
    if(!wasCompressed){const gz=await compressBuffer(nextBuffer,nextMime);if(gz.compressed){nextBuffer=gz.buffer;wasCompressed=true;}}
    if(leaseLost)return true;
    if(wasCompressed){
      const stored=await storeMedia('chat',nextBuffer,nextMime);
      const logical=nextMime==='image/webp'&&originalMime!=='image/webp'?nextBuffer.length:originalSize;
      const updated=await pool.query(`UPDATE shopping_chat_files SET name=$3,mime=$4,content=$5,byte_size=$6,
        original_byte_size=$7,compressed_byte_size=$8,compression_status='compressed',compression_lease=NULL,compression_lease_until=NULL
        WHERE id=$1 AND compression_lease=$2 AND compression_status='processing' AND deleted_at IS NULL`,
        [job.id,lease,nextName,nextMime,stored,logical,originalSize,nextBuffer.length]);
      // Original content is retained until the attachment's existing retention/deletion policy runs.
      if(!updated.rowCount)await require('./shopping-chat-file-retention').cleanupUnreferencedChatMedia(pool,stored);
    }else await pool.query(`UPDATE shopping_chat_files SET original_byte_size=$3,compressed_byte_size=$4,
      compression_status='optimal',compression_lease=NULL,compression_lease_until=NULL
      WHERE id=$1 AND compression_lease=$2 AND compression_status='processing' AND deleted_at IS NULL`,[job.id,lease,originalSize,raw.length]);
  }catch(error){
    const code=/^[A-Z0-9_]{1,50}$/.test(String(error.code||''))?error.code:'COMPRESSION_FAILED';
    await pool.query(`UPDATE shopping_chat_files SET compression_status=CASE WHEN compression_attempts<$3 THEN 'pending' ELSE 'failed' END,
      compression_lease=NULL,compression_lease_until=NULL,compression_last_error=$4,
      compression_next_attempt_at=now()+interval '5 minutes' WHERE id=$1 AND compression_lease=$2 AND deleted_at IS NULL`,[job.id,lease,MAX_ATTEMPTS,code]).catch(()=>{});
  }finally{clearInterval(heartbeat);}
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
  MAX_ATTEMPTS, LEASE_MINUTES, reclaimExpired, processOneChatCompression,
  processChatCompression,
  startChatCompressionWorker
};
