'use strict';
const { createHash } = require('node:crypto');
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CHUNK_BYTES = 5 * 1024 * 1024;
const MAX_CHUNKS = 256;
const MAX_THREAD_BYTES = 100 * 1024 * 1024;
const MAX_PENDING_BYTES = 512 * 1024 * 1024;
const MAX_PENDING_SESSIONS = 128;
const MAX_ACTIVE_PER_THREAD = 2;
const sha256 = data => createHash('sha256').update(data).digest('hex');
const failure = (message, status = 409) => Object.assign(new Error(message), { status });
function validateMeta(meta, buffer) {
  if (!meta || typeof meta.requestKey !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(meta.requestKey))
    throw failure('Invalid upload request key.', 400);
  if (typeof meta.fileName !== 'string' || !meta.fileName.trim() || meta.fileName.length > 180)
    throw failure('Invalid file name.', 400);
  const { chunkIndex, totalChunks, totalBytes } = meta;
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > MAX_FILE_BYTES)
    throw failure('File exceeds the 10 MiB upload limit.', 413);
  if (!Number.isSafeInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_CHUNKS || totalChunks > totalBytes ||
      !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks)
    throw failure('Invalid upload chunk metadata.', 400);
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_CHUNK_BYTES || buffer.length > totalBytes)
    throw failure('Invalid upload chunk size.', 413);
}
/** Pure state transition. Retries are checked by content hash, never appended. */
function appendChunk(state, meta, buffer) {
  validateMeta(meta, buffer);
  if (state.file_name !== meta.fileName || Number(state.total_bytes) !== meta.totalBytes || Number(state.total_chunks) !== meta.totalChunks)
    throw failure('Upload metadata changed; use a new request key.');
  const receipts = state.chunk_hashes || {};
  const receivedBefore = Number(state.received_chunks);
  if (!Number.isSafeInteger(receivedBefore) || receivedBefore < 0 || receivedBefore > meta.totalChunks ||
      !receipts || typeof receipts !== 'object' || Array.isArray(receipts) || Object.keys(receipts).length !== receivedBefore)
    throw failure('Upload state is from an older version or is invalid. Start a new upload.');
  if (state.completed_file_id && receivedBefore !== meta.totalChunks) throw failure('Invalid completed upload state.');
  if (!state.completed_file_id && Buffer.from(state.content || []).length > meta.totalBytes)
    throw failure('Stored upload exceeds its declared size.');
  const hash = sha256(buffer);
  const oldReceipt = receipts[String(meta.chunkIndex)];
  if (oldReceipt) {
    if (oldReceipt.hash !== hash || oldReceipt.bytes !== buffer.length)
      throw failure('A retried chunk has different bytes.');
    return { duplicate: true, content: Buffer.from(state.content || []), receipts,
      received: Number(state.received_chunks), complete: Number(state.received_chunks) === meta.totalChunks };
  }
  if (state.completed_file_id) throw failure('This upload has already completed.');
  if (meta.chunkIndex !== Number(state.received_chunks))
    throw failure('Chunk is out of order; retry the expected chunk.');
  const previous = Buffer.from(state.content || []);
  if (previous.length + buffer.length > meta.totalBytes)
    throw failure('Received bytes exceed the declared file length.');
  const received = Number(state.received_chunks) + 1;
  const complete = received === meta.totalChunks;
  const length = previous.length + buffer.length;
  if ((complete && length !== meta.totalBytes) || (!complete && length >= meta.totalBytes))
    throw failure('Chunk count and file length do not match.');
  return { duplicate: false, content: Buffer.concat([previous, buffer], length),
    receipts: { ...receipts, [String(meta.chunkIndex)]: { hash, bytes: buffer.length } }, received, complete };
}
/** Bound concurrent buffers in each Node process. Call before multer.
 * A disconnected client must not free a slot while a database/storage task still
 * owns the buffer. withUploadWork() releases the slot after that task settles.
 */
const UPLOAD_LEASE = Symbol('gaeru-upload-lease');
function createUploadGate(max = 2) {
  if (!Number.isSafeInteger(max) || max < 1 || max > 16) throw new TypeError('Invalid concurrency limit');
  let active = 0;
  return (req, res, next) => {
    if (active >= max) return res.status(429).json({ error: 'Upload capacity is busy. Please retry.' });
    active++;
    const lease = { working: false, released: false,
      release() { if (!this.released) { this.released = true; active--; } }
    };
    req[UPLOAD_LEASE] = lease;
    const completed = () => { if (!lease.working) lease.release(); };
    res.once('finish', completed);
    res.once('close', completed);
    try { next(); } catch (error) { lease.release(); throw error; }
  };
}
function withUploadWork(handler) {
  return async (req, res, next) => {
    const lease = req[UPLOAD_LEASE];
    if (lease?.released) return; // The client disconnected while the multipart body was being parsed.
    if (lease) lease.working = true;
    try { return await handler(req, res, next); }
    finally { if (lease) { lease.working = false; lease.release(); } }
  };
}
module.exports = { MAX_FILE_BYTES, MAX_CHUNK_BYTES, MAX_CHUNKS, MAX_THREAD_BYTES,
  MAX_PENDING_BYTES, MAX_PENDING_SESSIONS, MAX_ACTIVE_PER_THREAD,
  validateMeta, appendChunk, createUploadGate, withUploadWork };
