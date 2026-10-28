'use strict';
const rules = require('./upload-state');
const failure = (message, status = 409) => Object.assign(new Error(message), { status });
/** Run only inside withTransaction(). Caller has authenticated the chat owner. */
async function receiveChunk(client, { thread, isAdmin, meta, buffer, detectType, persist }) {
  rules.validateMeta(meta, buffer);
  // Same lock order as persistChatFile: storage first, thread second.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('shopping-chat-storage'))");
  const liveThread = (await client.query('SELECT status FROM shopping_chat_threads WHERE id=$1 FOR UPDATE', [thread.id])).rows[0];
  if (!liveThread || liveThread.status === 'closed') throw failure('Chat is not open.');
  await client.query("DELETE FROM shopping_chat_upload_sessions WHERE updated_at < now() - interval '1 hour'");
  // Never return an oversized pre-upgrade bytea into the Node heap.
  let state = (await client.query(`SELECT id,thread_id,sender,request_key,file_name,mime_type,
    total_bytes,total_chunks,received_chunks,chunk_hashes,completed_file_id,
    CASE WHEN octet_length(content) <= $3 THEN content ELSE NULL END AS content
    FROM shopping_chat_upload_sessions WHERE thread_id=$1 AND request_key=$2 FOR UPDATE`,
    [thread.id, meta.requestKey, rules.MAX_FILE_BYTES])).rows[0];
  if (state && (state.content === null || Number(state.total_bytes) > rules.MAX_FILE_BYTES))
    throw failure('Legacy upload exceeds the new limit. Start a smaller upload.', 413);
  const sender = isAdmin ? 'admin' : 'customer';
  if (!state) {
    if (meta.chunkIndex !== 0) throw failure('Upload expired or not started.', 404);
    const usedKey = (await client.query('SELECT id FROM shopping_chat_messages WHERE thread_id=$1 AND request_key=$2', [thread.id, meta.requestKey])).rows[0];
    if (usedKey) throw failure('Request key already used; do not create a second file.');
    const quota = (await client.query(`SELECT COUNT(*)::int AS sessions,
      COALESCE(SUM(total_bytes),0)::bigint AS reserved,
      COUNT(*) FILTER (WHERE thread_id=$1)::int AS thread_sessions
      FROM shopping_chat_upload_sessions WHERE completed_file_id IS NULL`, [thread.id])).rows[0];
    if (Number(quota.sessions) >= rules.MAX_PENDING_SESSIONS ||
        Number(quota.reserved) + meta.totalBytes > rules.MAX_PENDING_BYTES ||
        Number(quota.thread_sessions) >= rules.MAX_ACTIVE_PER_THREAD)
      throw failure('Upload quota reached. Complete or expire an existing upload.', 429);
    const mime = detectType({ originalname: meta.fileName, buffer });
    if (!mime) throw failure('Unsupported or invalid file.', 400);
    state = (await client.query(`INSERT INTO shopping_chat_upload_sessions
      (thread_id,sender,request_key,file_name,mime_type,total_bytes,total_chunks,received_chunks,content,chunk_hashes)
      VALUES($1,$2,$3,$4,$5,$6,$7,0,$8,'{}'::jsonb) RETURNING *`,
      [thread.id, sender, meta.requestKey, meta.fileName, mime, meta.totalBytes, meta.totalChunks, Buffer.alloc(0)])).rows[0];
  }
  if (state.sender !== sender) throw failure('Upload belongs to a different sender.', 403);
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
module.exports = { receiveChunk };
