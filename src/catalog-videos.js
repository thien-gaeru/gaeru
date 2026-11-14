const { pipeline } = require('node:stream/promises');
const { storeMedia, readMedia, readMediaRange, openMediaStream } = require('./lib/stored-media');
const { createUploadGate, withUploadWork } = require('./audit-fixes/upload-state');
const { Router } = require('express');
const multer = require('multer');
const { z } = require('zod');
const { rateLimit } = require('express-rate-limit');
const { requirePermission } = require('./staff-access');
const { requireCsrf } = require('./security');

function createCatalogVideos(pool) {
  const admin = Router();
  const publicApi = Router();
  const reserve = createUploadGate(2);
  const valid = z.string().uuid();

  async function send(req, res, next, isPublic) {
    if (!valid.safeParse(req.params.id).success) return res.sendStatus(404);
    try {
      const sql = 'SELECT content,mime_type FROM catalog_videos WHERE id=$1' + (
        isPublic
          ? ' AND EXISTS(SELECT 1 FROM product_presentations m JOIN products p ON p.id=m.product_id WHERE p.active=true AND p.deleted_at IS NULL AND m.description_media @> $2::jsonb)'
          : ''
      );
      const params = isPublic
        ? [req.params.id, JSON.stringify([{ type: 'video', url: '/api/catalog-videos/' + req.params.id }])]
        : [req.params.id];
      const row = (await pool.query(sql, params)).rows[0];
      if (!row) return res.sendStatus(404);

      res.type(row.mime_type).set({
        'Accept-Ranges': 'bytes',
        'Cache-Control': isPublic ? 'private, max-age=300' : 'no-store'
      });

      const streamResult = typeof openMediaStream === 'function'
        ? await openMediaStream(row.content, req.headers.range)
        : null;
      if (streamResult) {
        if (streamResult.invalidRange) {
          streamResult.stream?.destroy?.();
          return res.status(416).set('Content-Range', 'bytes */' + streamResult.totalSize).end();
        }
        res.status(streamResult.partial ? 206 : 200);
        if (streamResult.partial) {
          res.set('Content-Range', 'bytes ' + streamResult.start + '-' + streamResult.end + '/' + streamResult.totalSize);
        }
        if (Number.isFinite(streamResult.end) && Number.isFinite(streamResult.start)) {
          res.set('Content-Length', String(streamResult.end - streamResult.start + 1));
        } else if (Number.isFinite(streamResult.totalSize) && !streamResult.compressed) {
          res.set('Content-Length', String(streamResult.totalSize));
        }
        if (req.method === 'HEAD') {
          streamResult.stream?.destroy?.();
          return res.end();
        }
        try {
          await pipeline(streamResult.stream, res);
        } catch (err) {
          if (err?.code === 'ERR_STREAM_PREMATURE_CLOSE' || req.aborted || res.destroyed) return;
          throw err;
        }
        return;
      }

      if (req.headers.range && typeof readMediaRange === 'function') {
        const ranged = await readMediaRange(row.content, req.headers.range);
        if (ranged) {
          if (ranged.invalidRange) {
            return res.status(416).set('Content-Range', 'bytes */' + ranged.totalSize).end();
          }
          return res.status(206)
            .set('Content-Range', 'bytes ' + ranged.start + '-' + ranged.end + '/' + ranged.totalSize)
            .send(ranged.buffer);
        }
      }

      const b = await readMedia(row.content);
      if (req.headers.range) {
        const match = /^bytes=([0-9]*)-([0-9]*)$/.exec(req.headers.range);
        let start = 0;
        let end = b.length - 1;
        if (!match || (!match[1] && !match[2])) return res.status(416).set('Content-Range', 'bytes */' + b.length).end();
        if (!match[1]) start = Math.max(0, b.length - Number(match[2]));
        else {
          start = Number(match[1]);
          if (match[2]) end = Number(match[2]);
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= b.length) {
          return res.status(416).set('Content-Range', 'bytes */' + b.length).end();
        }
        end = Math.min(end, b.length - 1);
        return res.status(206).set('Content-Range', 'bytes ' + start + '-' + end + '/' + b.length).send(b.subarray(start, end + 1));
      }
      res.send(b);
    } catch (e) {
      if (res.headersSent) return;
      next(e);
    }
  }

  admin.get('/catalog-videos/:id', requirePermission('catalog.read'), (req, res, next) => send(req, res, next, false));
  publicApi.get('/catalog-videos/:id', (req, res, next) => send(req, res, next, true));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 0 }
  }).single('video');
  const limit = rateLimit({
    windowMs: 3600000,
    limit: 15,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Tối đa 15 video mỗi giờ. Vui lòng thử lại sau.' }
  });

  admin.post(
    '/catalog-videos',
    requirePermission('catalog.write'),
    requireCsrf,
    limit,
    reserve,
    (req, res, next) => upload(req, res, e => (e ? res.status(400).json({ error: 'Chọn một video MP4 tối đa 25 MB.' }) : next())),
    withUploadWork(async (req, res, next) => {
      const f = req.file;
      if (!f || f.mimetype !== 'video/mp4' || f.buffer.length < 12 || f.buffer.toString('ascii', 4, 8) !== 'ftyp') {
        return res.status(400).json({ error: 'Tệp video MP4 không hợp lệ.' });
      }
      try {
        const row = (await pool.query(
          'INSERT INTO catalog_videos(content,mime_type) VALUES($1,$2) RETURNING id',
          [await storeMedia('videos', f.buffer, 'video/mp4'), 'video/mp4']
        )).rows[0];
        res.status(201).json({ url: '/api/catalog-videos/' + row.id });
      } catch (e) {
        next(e);
      }
    })
  );

  return { admin, publicApi };
}

module.exports = { createCatalogVideos };
