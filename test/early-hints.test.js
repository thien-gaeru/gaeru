'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const net = require('node:net');
const { once } = require('node:events');
const { earlyHintsMiddleware, EARLY_HINT_PRELOADS } = require('../src/lib/early-hints');

test('earlyHintsMiddleware sends 103 Early Hints on public GET requests when explicitly enabled', async (t) => {
  process.env.EARLY_HINTS_ENABLED = 'true';
  t.after(() => { delete process.env.EARLY_HINTS_ENABLED; });

  const app = express();
  app.use(earlyHintsMiddleware);
  app.get('/cua-hang', (_req, res) => {
    res.type('html').send('<h1>Store</h1>');
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(r => server.close(r)));

  const port = server.address().port;
  const rawResponse = await new Promise((resolve) => {
    const client = net.connect(port, '127.0.0.1', () => {
      client.write('GET /cua-hang HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    client.on('data', chunk => { data += chunk.toString(); });
    client.on('end', () => resolve(data));
  });

  assert.ok(rawResponse.includes('HTTP/1.1 103 Early Hints'));
  assert.ok(rawResponse.includes('styles.css'));
  assert.ok(rawResponse.includes('HTTP/1.1 200 OK'));
  assert.ok(rawResponse.includes('Store'));
});

test('earlyHintsMiddleware bypasses 103 Early Hints by default for reverse proxy safety', async (t) => {
  delete process.env.EARLY_HINTS_ENABLED;

  const app = express();
  app.use(earlyHintsMiddleware);
  app.get('/cua-hang', (_req, res) => {
    res.type('html').send('<h1>Store</h1>');
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(r => server.close(r)));

  const port = server.address().port;
  const rawResponse = await new Promise((resolve) => {
    const client = net.connect(port, '127.0.0.1', () => {
      client.write('GET /cua-hang HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    client.on('data', chunk => { data += chunk.toString(); });
    client.on('end', () => resolve(data));
  });

  assert.ok(!rawResponse.includes('103 Early Hints'));
  assert.ok(rawResponse.includes('HTTP/1.1 200 OK'));
  assert.ok(rawResponse.includes('Store'));
});
