'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createCatalogVideos } = require('../src/catalog-videos');

test('disconnected video uploads retain their capacity until storage work settles', { timeout: 10000 }, async t => {
  const previous = { NODE_ENV: process.env.NODE_ENV, MEDIA_ROOT: process.env.MEDIA_ROOT };
  process.env.NODE_ENV = 'test';
  delete process.env.MEDIA_ROOT;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  });
  const started = [], storageWork = [], closed = [];
  const pool = { async query() {
    const index = storageWork.length;
    if (index >= 2) throw Error('A disconnected request freed capacity while its video was still in use');
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    storageWork.push(finish);
    started[index]();
    await pending;
    return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }] };
  } };
  const app = express();
  app.use((req, res, next) => {
    req.admin = { permissions: ['catalog.write'] };
    req.session = { csrfToken: 'fixture-csrf' };
    res.once('close', () => closed.shift()?.());
    next();
  });
  app.use(createCatalogVideos(pool).admin);
  app.use((_error, _req, res, _next) => res.status(500).end());
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    storageWork.forEach(finish => finish());
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const url = 'http://127.0.0.1:' + server.address().port + '/catalog-videos';
  const bytes = Buffer.from([0,0,0,16,102,116,121,112,109,112,52,50,0,0,0,0]);
  const send = signal => {
    const body = new FormData();
    body.append('video', new Blob([bytes], { type: 'video/mp4' }), 'fixture.mp4');
    return fetch(url, { method: 'POST', headers: { 'X-CSRF-Token': 'fixture-csrf' }, body, signal });
  };
  for (let index = 0; index < 2; index++) {
    const workStarted = new Promise(resolve => { started[index] = resolve; });
    const responseClosed = new Promise(resolve => closed.push(resolve));
    const controller = new AbortController();
    const request = send(controller.signal);
    await workStarted;
    controller.abort();
    await assert.rejects(request, { name: 'AbortError' });
    await responseClosed;
  }
  const busy = await send(AbortSignal.timeout(2000));
  assert.equal(busy.status, 429);
  assert.equal(storageWork.length, 2);
  await busy.arrayBuffer();
  storageWork.forEach(finish => finish());
});
