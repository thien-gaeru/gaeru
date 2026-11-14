'use strict';
const { randomUUID } = require('node:crypto');
const rules = require('./upload-state');
const local = require('../lib/filesystem-media');
const STAGE_PREFIX = Buffer.from('GAERU_STAGE_V1:');
const failure = (message, status = 409) => Object.assign(new Error(message), { status });
function parseStage(content) {
  if (!content) return null;
  const buf = Buffer.from(content);
  if (!buf.subarray(0, STAGE_PREFIX.length).equals(STAGE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(buf.subarray(STAGE_PREFIX.length).toString('utf8'));
    if (typeof parsed?.id === 'string' && Number.isSafeInteger(parsed.bytes) && parsed.bytes >= 0) return parsed;
  } catch {}
  throw failure('Corrupted staged upload metadata.', 400);
}
/** Run only inside withTransaction(). Caller has authenticated the chat owner. */
async function receiveChunk(client, { thread, isAdmin, meta, buffer, detectType, persist, stageToDisk = false, persistStaged = null, rollbackTasks = null, commitTasks = null }) {
  rules.validateMeta(meta, buffer);
  const isFinalChunk = meta.chunkIndex === meta.totalChunks - 1;
  if (isFinalChunk) {
    // Same lock order as persistChatFile: storage first, thread second.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('shopping-chat-storage'))");
  } else {
    // Intermediate chunks only serialize per thread so concurrent users do not block on a global lock.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('shopping-chat-upload:' || $1))", [String(thread.id)]);
  }
  const liveThread = (await client.query('SELECT status FROM shopping_chat_threads WHERE id=$1 FOR UPDATE', [thread.id])).rows[0];
  if (!liveThread || liveThread.status === 'closed') throw failure('Chat is not open.');
  const expiredRows = (await client.query(`DELETE FROM shopping_chat_upload_sessions
    WHERE id IN (
      SELECT id FROM shopping_chat_upload_sessions
      WHERE updated_at < now() - interval '15 minutes'
      ORDER BY updated_at
      LIMIT 50
      FOR UPDATE SKIP LOCKED
    )
    RETURNING content`)).rows;
  for (const row of expiredRows) {
    try {
      const stale = parseStage(row.content);
      if (stale?.id) void local.removeStage(stale.id).catch(() => {});
    } catch {}
  }
  if (stageToDisk) void local.pruneExpiredStages?.(15 * 60 * 1000).catch(() => {});
  // Never return an oversized pre-upgrade bytea into the Node heap.
  let state = (await client.query(`SELECT id,thread_id,sender,request_key,file_name,mime_type,
    total_bytes,total_chunks,received_chunks,chunk_hashes,completed_file_id,
    CASE WHEN octet_length(content) <= $3 THEN content ELSE NULL END AS content
    FROM shopping_chat_upload_sessions WHERE thread_id=$1 AND request_key=$2 FOR UPDATE`,
    [thread.id, meta.requestKey, rules.MAX_FILE_BYTES])).rows[0];
  if (state && (state.content === null || Number(state.total_bytes) > rules.MAX_FILE_BYTES))
    throw failure('Legacy upload exceeds the new limit. Start a smaller upload.', 413);
  const sender = isAdmin ? 'admin' : 'customer';
  const useDiskStaging = Boolean(stageToDisk && typeof persistStaged === 'function' && local.configured());
  let initialStageId = null;
  if (!state) {
    if (meta.chunkIndex !== 0) throw failure('Upload expired or not started.', 404);
    const usedKey = (await client.query('SELECT id FROM shopping_chat_messages WHERE thread_id=$1 AND request_key=$2', [thread.id, meta.requestKey])).rows[0];
    if (usedKey) throw failure('Request key already used; do not create a second file.');
    const quota = (await client.query(`SELECT COUNT(*)::int AS sessions,
      COALESCE(SUM(total_bytes),0)::bigint AS reserved,
      COUNT(*) FILTER (WHERE thread_id=$1)::int AS thread_sessions,
      COALESCE(SUM(total_bytes) FILTER (WHERE thread_id=$1),0)::bigint AS thread_reserved
      FROM shopping_chat_upload_sessions WHERE completed_file_id IS NULL`, [thread.id])).rows[0];
    if (Number(quota.sessions) >= rules.MAX_PENDING_SESSIONS ||
        Number(quota.reserved) + meta.totalBytes > rules.MAX_PENDING_BYTES ||
        Number(quota.thread_sessions) >= rules.MAX_ACTIVE_PER_THREAD ||
        Number(quota.thread_reserved) + meta.totalBytes > rules.MAX_THREAD_BYTES)
      throw failure('Upload quota reached. Complete or expire an existing upload.', 429);
    if (!useDiskStaging && meta.totalBytes > rules.MAX_MEMORY_FALLBACK_BYTES)
      throw failure('Chunked uploads over 25 MiB require disk staging (MEDIA_ROOT).', 413);
    const mime = detectType({ originalname: meta.fileName, buffer });
    if (!mime) throw failure('Unsupported or invalid file.', 400);
    let initialContent = Buffer.alloc(0);
    if (useDiskStaging) {
      initialStageId = randomUUID();
      initialContent = Buffer.concat([STAGE_PREFIX, Buffer.from(JSON.stringify({ id: initialStageId, bytes: 0 }))]);
    }
    state = (await client.query(`INSERT INTO shopping_chat_upload_sessions
      (thread_id,sender,request_key,file_name,mime_type,total_bytes,total_chunks,received_chunks,content,chunk_hashes)
      VALUES($1,$2,$3,$4,$5,$6,$7,0,$8,'{}'::jsonb) RETURNING *`,
      [thread.id, sender, meta.requestKey, meta.fileName, mime, meta.totalBytes, meta.totalChunks, initialContent])).rows[0];
  }
  if (state.sender !== sender) throw failure('Upload belongs to a different sender.', 403);
  const stage = parseStage(state.content);
  if (stage) {
    const next = rules.planChunkTransition(state, meta, buffer, stage.bytes);
    if (state.completed_file_id) {
      const file = (await client.query('SELECT id,name,mime,byte_size FROM shopping_chat_files WHERE id=$1 AND thread_id=$2', [state.completed_file_id, thread.id])).rows[0];
      if (!file) throw failure('Completed file is unavailable.', 404);
      return { status: 'completed', file, duplicate: true };
    }
    if (!next.duplicate) {
      const creating = Boolean(initialStageId && meta.chunkIndex === 0 && stage.bytes === 0);
      try {
        await local.writeStageChunk(stage.id, stage.bytes, buffer, { create: creating });
      } catch (err) {
        if (err?.code === 'ENOENT' || err?.message === 'MEDIA_STAGE_OFFSET_MISMATCH') {
          throw failure('Upload expired or stage missing; restart upload.', 404);
        }
        throw err;
      }
      if (creating && Array.isArray(rollbackTasks)) rollbackTasks.push(() => local.removeStage(stage.id));
      const nextPointer = Buffer.concat([STAGE_PREFIX, Buffer.from(JSON.stringify({ id: stage.id, bytes: next.length }))]);
      await client.query('UPDATE shopping_chat_upload_sessions SET content=$2,received_chunks=$3,chunk_hashes=$4,updated_at=now() WHERE id=$1',
        [state.id, nextPointer, next.received, JSON.stringify(next.receipts)]);
    }
    if (!next.complete) return { status: 'uploading', receivedChunks: next.received, totalChunks: meta.totalChunks, duplicate: next.duplicate };
    const head = await local.readStageHead(stage.id, 65536);
    const mime = detectType({ originalname: meta.fileName, buffer: head });
    if (!mime || mime !== state.mime_type) throw failure('Assembled file type does not match.', 400);
    if (/^(text\/|application\/(?:json|xml)$)/i.test(mime)) {
      const safeText = await local.verifyStagePlainText(stage.id);
      if (!safeText) throw failure('Assembled file failed plain-text integrity check.', 400);
    }
    const file = await persistStaged(client, { stageId: stage.id, totalBytes: meta.totalBytes, mime });
    if (!file?.id) throw failure('Storage did not return a file record.', 503);
    await client.query("UPDATE shopping_chat_upload_sessions SET completed_file_id=$2,content=''::bytea,updated_at=now() WHERE id=$1", [state.id, file.id]);
    if (Array.isArray(commitTasks)) commitTasks.push(() => local.removeStage(stage.id));
    return { status: 'completed', file };
  }
  const next = rules.appendChunk(state, meta, buffer);
  if (state.completed_file_id) {
    const file = (await client.query('SELECT id,name,mime,byte_size FROM shopping_chat_files WHERE id=$1 AND thread_id=$2', [state.completed_file_id, thread.id])).rows[0];
    if (!file) throw failure('Completed file is unavailable.', 404);
    return { status: 'completed', file, duplicate: true };
  }
  if (!next.duplicate) {
    await client.query('UPDATE shopping_chat_upload_sessions SET content=$2,received_chunks=$3,chunk_hashes=$4,updated_at=now() WHERE id=$1',
      [state.id, next.content, next.received, JSON.stringify(next.receipts)]);
  }
  if (!next.complete) return { status: 'uploading', receivedChunks: next.received, totalChunks: meta.totalChunks, duplicate: next.duplicate };
  const mime = detectType({ originalname: meta.fileName, buffer: next.content });
  if (!mime || mime !== state.mime_type) throw failure('Assembled file type does not match.', 400);
  // File row and completed marker commit together. Failed storage leaves the
  // previous state intact, so the same final chunk can be retried safely.
  const file = await persist(client, next.content, mime);
  if (!file?.id) throw failure('Storage did not return a file record.', 503);
  await client.query("UPDATE shopping_chat_upload_sessions SET completed_file_id=$2,content=''::bytea,updated_at=now() WHERE id=$1", [state.id, file.id]);
  return { status: 'completed', file };
}
module.exports = { receiveChunk, STAGE_PREFIX };
