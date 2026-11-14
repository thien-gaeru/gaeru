'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fileType } = require('../src/shopping-chat-extras');
const { checkKey } = require('../src/lib/media-keys');
const { storeMedia, readMedia, readMediaRange } = require('../src/lib/stored-media');
const { compressBuffer } = require('../src/shopping-chat-compression');

test('Pillar 1: Zero-copy byte-range streaming reads exact slices from disk and skips gzip on video/audio', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gaeru-chat-range-'));
  const prev = process.env.MEDIA_ROOT;
  process.env.MEDIA_ROOT = root;
  t.after(async () => {
    if (prev === undefined) delete process.env.MEDIA_ROOT;
    else process.env.MEDIA_ROOT = prev;
    await fsp.rm(root, { recursive: true, force: true });
  });

  // Video & audio buffers should never be wrapped in GAERU_ZLIB_V1 so disk range reads remain zero-copy
  const mp4Buf = Buffer.from('000000206674797069736f6d00000200' + '41424344'.repeat(100), 'hex');
  const gzVideo = await compressBuffer(mp4Buf, 'video/mp4');
  assert.equal(gzVideo.compressed, false);
  const gzAudio = await compressBuffer(mp4Buf, 'audio/mpeg');
  assert.equal(gzAudio.compressed, false);

  const pointer = await storeMedia('chat', mp4Buf, 'video/mp4');
  const slice1 = await readMediaRange(pointer, 'bytes=0-7');
  assert.equal(slice1.invalidRange, undefined);
  assert.equal(slice1.totalSize, mp4Buf.length);
  assert.equal(slice1.start, 0);
  assert.equal(slice1.end, 7);
  assert.deepEqual(slice1.buffer, mp4Buf.subarray(0, 8));

  const sliceSuffix = await readMediaRange(pointer, 'bytes=-8');
  assert.equal(sliceSuffix.start, mp4Buf.length - 8);
  assert.equal(sliceSuffix.end, mp4Buf.length - 1);
  assert.deepEqual(sliceSuffix.buffer, mp4Buf.subarray(mp4Buf.length - 8));

  const invalid = await readMediaRange(pointer, 'bytes=999999-');
  assert.equal(invalid.invalidRange, true);
  assert.equal(invalid.totalSize, mp4Buf.length);

  assert.deepEqual(await readMedia(pointer), mp4Buf);
});

test('Pillar 2: Expanded safe file formats validate magic bytes and reject spoofed files', () => {
  // AVIF
  const avifBuf = Buffer.concat([Buffer.from([0, 0, 0, 28]), Buffer.from('ftypavif', 'ascii'), Buffer.alloc(16)]);
  assert.equal(fileType({ originalname: 'photo.avif', buffer: avifBuf }), 'image/avif');
  assert.equal(checkKey('chat/11111111-1111-4111-8111-111111111111.avif'), 'chat/11111111-1111-4111-8111-111111111111.avif');

  // MP3 (ID3 & sync frame)
  assert.equal(fileType({ originalname: 'voice.mp3', buffer: Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00') }), 'audio/mpeg');
  assert.equal(fileType({ originalname: 'voice2.mp3', buffer: Buffer.from([0xff, 0xfb, 0x90, 0x64]) }), 'audio/mpeg');

  // M4A / WAV / OGG / WEBA
  const m4aBuf = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A ', 'ascii'), Buffer.alloc(12)]);
  assert.equal(fileType({ originalname: 'note.m4a', buffer: m4aBuf }), 'audio/mp4');
  const wavBuf = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEfmt ', 'ascii')]);
  assert.equal(fileType({ originalname: 'clip.wav', buffer: wavBuf }), 'audio/wav');
  assert.equal(fileType({ originalname: 'voice.ogg', buffer: Buffer.from('OggS\x00\x02\x00\x00') }), 'audio/ogg');
  assert.equal(fileType({ originalname: 'voice.weba', buffer: Buffer.from([26, 69, 223, 163, 1, 2]) }), 'audio/webm');

  // RAR / 7z / JSON / XML
  assert.equal(fileType({ originalname: 'archive.rar', buffer: Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]) }), 'application/octet-stream');
  assert.equal(fileType({ originalname: 'archive.7z', buffer: Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00]) }), 'application/octet-stream');
  assert.equal(fileType({ originalname: 'order.json', buffer: Buffer.from('{"order":"GR-01"}', 'utf8') }), 'application/json');
  assert.equal(fileType({ originalname: 'invoice.xml', buffer: Buffer.from('<?xml version="1.0"?><invoice/>', 'utf8') }), 'application/xml');

  // Spoofed / executable rejection
  assert.equal(fileType({ originalname: 'malware.mp3', buffer: Buffer.from('MZ\x90\x00') }), null);
  assert.equal(fileType({ originalname: 'script.json', buffer: Buffer.from('alert(1)', 'utf8') }), null);
});

test('Pillars 3, 4 & 5: Client UI includes HD toggle, Paste/Drag-Drop, Camera/Voice recorder, Progress bar & Lightbox', () => {
  const clientJs = fs.readFileSync(path.join(__dirname, '..', 'shopping-chat-client.js'), 'utf8');
  const chatCss = fs.readFileSync(path.join(__dirname, '..', 'shopping-chat.css'), 'utf8');

  // Pillar 3: Smart optimization & HD toggle
  assert.ok(clientJs.includes('SMART_IMAGE_OPTIMIZE_BYTES'));
  assert.ok(clientJs.includes('data-chat-hd-toggle'));

  // Pillar 4: Omnichannel file input (Camera, Voice note, Paste, Drag & Drop)
  assert.ok(clientJs.includes('data-pick="camera"'));
  assert.ok(clientJs.includes('capture="environment"'));
  assert.ok(clientJs.includes('data-chat-voice-btn'));
  assert.ok(clientJs.includes('startVoiceRecording'));
  assert.ok(clientJs.includes('anh-chup-man-hinh-'));
  assert.ok(clientJs.includes('is-dragover'));

  // Pillar 5: Real-time progress, Cancel, Resumable chunks, Lightbox, Audio & PDF preview
  assert.ok(clientJs.includes('data-chat-upload-progress'));
  assert.ok(clientJs.includes('data-cancel-upload'));
  assert.ok(clientJs.includes('item.resumeFromChunk'));
  assert.ok(clientJs.includes('openMediaLightbox'));
  assert.ok(clientJs.includes('chat-inline-audio'));
  assert.ok(clientJs.includes('chat-pdf-preview-link'));
  assert.ok(chatCss.includes('dialog.chat-media-lightbox'));
  assert.ok(chatCss.includes('.chat-upload-progress'));
  assert.ok(chatCss.includes('.chat-voice-recorder'));
});

test('Pillar 6: Broadened file signatures, Permissions-Policy microphone=(self), and CSRF session owner persistence', async t => {
  // Extended safe formats
  assert.equal(fileType({ originalname: 'photo.jfif', buffer: Buffer.from([255, 216, 255, 224]) }), 'image/jpeg');
  assert.equal(fileType({ originalname: 'scan.bmp', buffer: Buffer.from('BM\x00\x00\x00\x00', 'ascii') }), 'image/bmp');
  assert.equal(fileType({ originalname: 'scan.tif', buffer: Buffer.from([73, 73, 42, 0, 8, 0]) }), 'image/tiff');
  assert.equal(fileType({ originalname: 'burst.heic', buffer: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheim', 'ascii'), Buffer.alloc(12)]) }), 'image/heic');
  assert.equal(fileType({ originalname: 'clip.3gp', buffer: Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftyp3gp5', 'ascii'), Buffer.alloc(8)]) }), 'video/mp4');
  assert.equal(fileType({ originalname: 'bom.pdf', buffer: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(' %PDF-1.7\n', 'ascii')]) }), 'application/pdf');
  assert.equal(fileType({ originalname: 'empty.zip', buffer: Buffer.from([80, 75, 5, 6, 0, 0]) }), 'application/octet-stream');
  assert.equal(fileType({ originalname: 'padded.mp3', buffer: Buffer.concat([Buffer.alloc(128, 0), Buffer.from([0xff, 0xfb, 0x90, 0x64])]) }), 'audio/mpeg');
  assert.equal(fileType({ originalname: 'win.csv', buffer: Buffer.from([0x54, 0x65, 0x6e, 0x2c, 0x80, 0x0d, 0x0a]) }), 'text/plain');
  assert.equal(fileType({ originalname: 'app.log', buffer: Buffer.from('2026-11-14 OK\n', 'utf8') }), 'text/plain');
  assert.equal(fileType({ originalname: 'blob', buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]) }), 'image/png');
  assert.equal(fileType({ originalname: 'blob', buffer: Buffer.from('<script>alert(1)</script>', 'utf8') }), null);
  assert.equal(fileType({ originalname: 'bad.png', buffer: Buffer.from('<script>bad</script>') }), null);
  assert.equal(fileType({ originalname: 'bad.exe', buffer: Buffer.from('MZbinary') }), null);
  assert.equal(checkKey('chat/11111111-1111-4111-8111-111111111111.bmp'), 'chat/11111111-1111-4111-8111-111111111111.bmp');
  assert.equal(checkKey('chat/11111111-1111-4111-8111-111111111111.tiff'), 'chat/11111111-1111-4111-8111-111111111111.tiff');

  // Client resilient markers
  const clientJs = fs.readFileSync(path.join(__dirname, '..', 'shopping-chat-client.js'), 'utf8');
  assert.ok(clientJs.includes('data-pick="media" data-no-action-feedback'));
  assert.ok(clientJs.includes('safeUploadName'));

  // App Permissions-Policy & CSRF session shoppingChatOwner initialization
  const mediaRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gaeru-chat-upgrade-media-'));
  const prevMedia = process.env.MEDIA_ROOT;
  process.env.MEDIA_ROOT = mediaRoot;
  const { createLocalPool } = require('../src/local-server');
  const pool = await createLocalPool();
  await require('../src/migrate').migrateDatabase(pool);
  const crypto = require('node:crypto');
  const session = require('express-session');
  const store = new session.MemoryStore();
  const app = require('../src/app').createApp({
    config: {
      NODE_ENV: 'test',
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      ADMIN_USERNAME: 'upgrade-owner',
      ADMIN_PASSWORD_HASH: require('bcryptjs').hashSync(crypto.randomBytes(12).toString('hex'), 4),
      PUBLIC_BASE_URL: 'https://gaeru.com'
    },
    pool,
    sessionStore: store,
    customerMailer: { sendMail: async () => ({ accepted: [], rejected: [] }) }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => {
    await new Promise(r => { server.closeAllConnections(); server.close(r); });
    await pool.end();
    if (prevMedia === undefined) delete process.env.MEDIA_ROOT;
    else process.env.MEDIA_ROOT = prevMedia;
    await fsp.rm(mediaRoot, { recursive: true, force: true });
  });

  const base = 'http://127.0.0.1:' + server.address().port;
  const homeRes = await fetch(base + '/');
  assert.match(homeRes.headers.get('permissions-policy'), /camera=\(\)/);
  assert.match(homeRes.headers.get('permissions-policy'), /microphone=\(self\)/);
  const adminRes = await fetch(base + '/gaeru_ceo');
  assert.match(adminRes.headers.get('permissions-policy'), /camera=\(self\)/);
  assert.match(adminRes.headers.get('permissions-policy'), /microphone=\(self\)/);

  const csrfRes = await fetch(base + '/api/csrf');
  assert.equal(csrfRes.status, 200);
  const cookie = csrfRes.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await csrfRes.json();

  const createRes = await fetch(base + '/api/shopping-chat/threads', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ productSlug: null, body: 'Tôi gửi tệp để được tư vấn.', requestKey: crypto.randomUUID() })
  });
  assert.equal(createRes.status, 201);
  const { thread } = await createRes.json();

  // Upload extensionless PNG blob right after creating thread
  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const form = new FormData();
  form.append('file', new Blob([pngBytes], { type: 'image/png' }), 'blob');
  form.append('requestKey', crypto.randomUUID());
  const upRes = await fetch(base + '/api/shopping-chat/threads/' + thread.id + '/files', {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken },
    body: form
  });
  assert.equal(upRes.status, 201);
});

test('Pillar 7: Mobile upload resilience (mixed magic/ext, HEIF brands, 1 MiB chunking, buffered handles, and non-JSON status handling)', async t => {
  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  // Mobile OS/pickers sometimes hand PNG bytes as .jpg or JPEG bytes as .heic, or new HEIF/AVIF brands
  assert.equal(fileType({ originalname: 'IMG_001.jpg', buffer: pngBytes }), 'image/png');
  assert.equal(fileType({ originalname: 'IMG_002.heic', buffer: Buffer.from([255, 216, 255, 224, 0, 16]) }), 'image/jpeg');
  assert.equal(fileType({ originalname: 'Live.heif', buffer: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmif2', 'ascii'), Buffer.alloc(12)]) }), 'image/heic');
  assert.equal(fileType({ originalname: 'photo.heic', buffer: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheif', 'ascii'), Buffer.alloc(12)]) }), 'image/heic');
  assert.equal(fileType({ originalname: 'spoof.jpg', buffer: Buffer.from('<!doctype html><script>alert(1)</script>') }), null);
  assert.equal(fileType({ originalname: 'spoof.heic', buffer: Buffer.from('MZbinary') }), null);

  const clientJs = fs.readFileSync(path.join(__dirname, '..', 'shopping-chat-client.js'), 'utf8');
  assert.ok(clientJs.includes('takenPickerFiles'));
  assert.ok(clientJs.includes('materializePickedFile'));
  assert.ok(clientJs.includes('toMemoryBlob'));
  assert.ok(clientJs.includes('chooseChunkBytes'));
  assert.ok(clientJs.includes('500*1024*1024'));
  assert.ok(clientJs.includes('withTimeout(run()'));
  assert.ok(clientJs.includes("webkit-playsinline"));

  const servicesJs = fs.readFileSync(path.join(__dirname, '..', 'product-services.js'), 'utf8');
  assert.ok(servicesJs.includes("netErr?.name === 'AbortError'"));
  assert.ok(servicesJs.includes('JSON.parse(rawText)'));

  const mediaRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gaeru-chat-mobile-media-'));
  const prevMedia = process.env.MEDIA_ROOT;
  process.env.MEDIA_ROOT = mediaRoot;
  const { createLocalPool } = require('../src/local-server');
  const pool = await createLocalPool();
  await require('../src/migrate').migrateDatabase(pool);
  const crypto = require('node:crypto');
  const session = require('express-session');
  const app = require('../src/app').createApp({
    config: {
      NODE_ENV: 'test',
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      ADMIN_USERNAME: 'mobile-owner',
      ADMIN_PASSWORD_HASH: require('bcryptjs').hashSync(crypto.randomBytes(12).toString('hex'), 4),
      PUBLIC_BASE_URL: 'https://gaeru.com'
    },
    pool,
    sessionStore: new session.MemoryStore(),
    customerMailer: { sendMail: async () => ({ accepted: [], rejected: [] }) }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => {
    await new Promise(r => { server.closeAllConnections(); server.close(r); });
    await pool.end();
    if (prevMedia === undefined) delete process.env.MEDIA_ROOT;
    else process.env.MEDIA_ROOT = prevMedia;
    await fsp.rm(mediaRoot, { recursive: true, force: true });
  });

  const base = 'http://127.0.0.1:' + server.address().port;
  const csrfRes = await fetch(base + '/api/csrf');
  const cookie = csrfRes.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await csrfRes.json();

  const createRes = await fetch(base + '/api/shopping-chat/threads', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' },
    body: JSON.stringify({ productSlug: null, body: 'Tôi gửi tệp để được tư vấn.', requestKey: crypto.randomUUID() })
  });
  assert.equal(createRes.status, 201);
  const { thread } = await createRes.json();

  // Capture rejection log when uploading invalid file
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warns.push(args.join(' ')); };
  let badStatus = 0;
  try {
    const badForm = new FormData();
    badForm.append('file', new Blob([Buffer.from('MZbad')], { type: 'application/octet-stream' }), 'bad.jpg');
    badForm.append('requestKey', crypto.randomUUID());
    const badRes = await fetch(base + '/api/shopping-chat/threads/' + thread.id + '/files', {
      method: 'POST',
      headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken, 'User-Agent': 'MobileTest/1.0' },
      body: badForm
    });
    badStatus = badRes.status;
  } finally {
    console.warn = origWarn;
  }
  assert.equal(badStatus, 400);
  assert.ok(warns.some(w => w.includes('[shopping-chat-upload-reject]') && w.includes('unsupported_mime')));

  // Simulate 1.25 MiB mobile photo uploaded as 2 x 1 MiB chunks
  const mp4Head = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42', 'ascii'), Buffer.alloc(12)]);
  const bigBuf = Buffer.concat([mp4Head, Buffer.alloc(1048576 + 262144 - mp4Head.length, 0x22)]);
  const chunkSize = 1048576;
  const totalChunks = Math.ceil(bigBuf.length / chunkSize);
  assert.equal(totalChunks, 2);
  const reqKey = crypto.randomUUID();
  for (let i = 0; i < totalChunks; i++) {
    const slice = bigBuf.subarray(i * chunkSize, Math.min(bigBuf.length, (i + 1) * chunkSize));
    const f = new FormData();
    f.append('file', new Blob([slice], { type: 'application/octet-stream' }), 'camera-clip.mp4');
    f.append('requestKey', reqKey);
    f.append('fileName', 'camera-clip.mp4');
    f.append('chunkIndex', String(i));
    f.append('totalChunks', String(totalChunks));
    f.append('totalBytes', String(bigBuf.length));
    const res = await fetch(base + '/api/shopping-chat/threads/' + thread.id + '/files/chunk', {
      method: 'POST',
      headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken },
      body: f
    });
    assert.equal(res.status, i === totalChunks - 1 ? 201 : 202);
  }
});

test('Pillar 8: Disk-staged >120 MiB video upload (126 MiB / 42x3 MiB chunks), idempotent retry, stage cleanup, and streamed download', { timeout: 60000 }, async t => {
  const uploadRules = require('../src/audit-fixes/upload-state');
  assert.ok(uploadRules.MAX_FILE_BYTES >= 500 * 1024 * 1024);

  const mediaRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gaeru-chat-large-stage-'));
  const prevMedia = process.env.MEDIA_ROOT;
  process.env.MEDIA_ROOT = mediaRoot;
  const { createLocalPool } = require('../src/local-server');
  const pool = await createLocalPool();
  await require('../src/migrate').migrateDatabase(pool);
  const crypto = require('node:crypto');
  const session = require('express-session');
  const app = require('../src/app').createApp({
    config: {
      NODE_ENV: 'test',
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      ADMIN_USERNAME: 'large-owner',
      ADMIN_PASSWORD_HASH: require('bcryptjs').hashSync(crypto.randomBytes(12).toString('hex'), 4),
      PUBLIC_BASE_URL: 'https://gaeru.com'
    },
    pool,
    sessionStore: new session.MemoryStore(),
    customerMailer: { sendMail: async () => ({ accepted: [], rejected: [] }) }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => {
    await new Promise(r => { server.closeAllConnections(); server.close(r); });
    await pool.end();
    if (prevMedia === undefined) delete process.env.MEDIA_ROOT;
    else process.env.MEDIA_ROOT = prevMedia;
    await fsp.rm(mediaRoot, { recursive: true, force: true });
  });

  const base = 'http://127.0.0.1:' + server.address().port;
  const caps = await (await fetch(base + '/api/shopping-chat/capabilities')).json();
  assert.equal(caps.maxFileBytes, 500 * 1024 * 1024);
  assert.equal(caps.maxChunkBytes, 5 * 1024 * 1024);
  assert.equal(caps.maxChunks, 256);

  const csrfRes = await fetch(base + '/api/csrf');
  const cookie = csrfRes.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await csrfRes.json();

  const createRes = await fetch(base + '/api/shopping-chat/threads', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ productSlug: null, body: 'Gửi video lớn 126 MiB.', requestKey: crypto.randomUUID() })
  });
  assert.equal(createRes.status, 201);
  const { thread } = await createRes.json();

  const chunkSize = 3 * 1024 * 1024;
  const totalChunks = 42; // 42 * 3 MiB = 126 MiB
  const totalBytes = chunkSize * totalChunks;
  const mp4Head = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42', 'ascii'), Buffer.alloc(12)]);
  const firstChunk = Buffer.concat([mp4Head, Buffer.alloc(chunkSize - mp4Head.length, 0x33)]);
  const bodyChunk = Buffer.alloc(chunkSize, 0x33);
  const reqKey = crypto.randomUUID();

  let completedFile = null;
  for (let i = 0; i < totalChunks; i++) {
    const slice = i === 0 ? firstChunk : bodyChunk;
    const f = new FormData();
    f.append('file', new Blob([slice], { type: 'application/octet-stream' }), 'IMG_LARGE_4K.mov');
    f.append('requestKey', reqKey);
    f.append('fileName', 'IMG_LARGE_4K.mov');
    f.append('chunkIndex', String(i));
    f.append('totalChunks', String(totalChunks));
    f.append('totalBytes', String(totalBytes));
    const res = await fetch(base + '/api/shopping-chat/threads/' + thread.id + '/files/chunk', {
      method: 'POST',
      headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken },
      body: f
    });
    assert.equal(res.status, i === totalChunks - 1 ? 201 : 202);
    const body = await res.json();
    if (i === 5) {
      // Postgres session content stays a small stage pointer instead of O(N^2) bytea
      const sess = (await pool.query('SELECT octet_length(content) AS len FROM shopping_chat_upload_sessions WHERE thread_id=$1 AND request_key=$2', [thread.id, reqKey])).rows[0];
      assert.ok(sess && Number(sess.len) < 512, 'expected tiny stage pointer, got ' + sess?.len);
      // Duplicate chunk retry must be idempotent
      const dupRes = await fetch(base + '/api/shopping-chat/threads/' + thread.id + '/files/chunk', {
        method: 'POST',
        headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken },
        body: f
      });
      assert.equal(dupRes.status, 202);
      const dupJson = await dupRes.json();
      assert.equal(dupJson.duplicate, true);
      assert.equal(dupJson.receivedChunks, 6);
    }
    if (i === totalChunks - 1) completedFile = body.file;
  }

  assert.ok(completedFile?.id);
  assert.equal(completedFile.size, totalBytes);
  assert.equal(completedFile.mime, 'video/quicktime');

  // Verify no leftover .part stage files remain in chat directory
  const chatEntries = await fsp.readdir(path.join(mediaRoot, 'chat'));
  assert.equal(chatEntries.filter(n => n.endsWith('.part')).length, 0);
  assert.equal(chatEntries.filter(n => n.endsWith('.mov')).length, 1);

  // Verify DB marked large video as optimal immediately (skipping 126 MiB RAM read in worker)
  const fileRow = (await pool.query('SELECT compression_status FROM shopping_chat_files WHERE id=$1', [completedFile.id])).rows[0];
  assert.equal(fileRow.compression_status, 'optimal');

  // Streamed Range 206 head + tail + full 200 download check
  const fileUrl = base + '/api/shopping-chat/threads/' + thread.id + '/files/' + completedFile.id;
  const rHead = await fetch(fileUrl, { headers: { Cookie: cookie, Range: 'bytes=0-11' } });
  assert.equal(rHead.status, 206);
  assert.equal(rHead.headers.get('content-range'), `bytes 0-11/${totalBytes}`);
  assert.deepEqual(Buffer.from(await rHead.arrayBuffer()), mp4Head.subarray(0, 12));

  const rTail = await fetch(fileUrl, { headers: { Cookie: cookie, Range: `bytes=${totalBytes - 8}-${totalBytes - 1}` } });
  assert.equal(rTail.status, 206);
  assert.deepEqual(Buffer.from(await rTail.arrayBuffer()), Buffer.alloc(8, 0x33));

  const rFull = await fetch(fileUrl + '?download=1', { headers: { Cookie: cookie } });
  assert.equal(rFull.status, 200);
  assert.equal(Number(rFull.headers.get('content-length')), totalBytes);
  let streamedBytes = 0;
  for await (const chunk of rFull.body) streamedBytes += chunk.length;
  assert.equal(streamedBytes, totalBytes);
});
