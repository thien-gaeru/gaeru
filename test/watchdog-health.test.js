'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const source = fs.readFileSync(path.join(__dirname, '../scripts/watchdog-supervisor.js'), 'utf8');
const healthSource = source.slice(source.indexOf('function checkHttpHealth()'), source.indexOf('function recycleServer()'));

function fixture() {
  const requests = [], timers = new Set();
  const http = { get(url, options, respond) {
    if (http.throwNext) { http.throwNext = false; throw new Error('connection setup failed'); }
    const req = new EventEmitter();
    req.destroy = () => { req.destroyed = true; req.emit('error', new Error('socket destroyed')); };
    req.respond = statusCode => respond({ statusCode, resume() {} });
    requests.push(req);
    return req;
  } };
  const context = vm.createContext({ http, log() {}, SERVER_PORT: 3000, HEALTH_CHECK_TIMEOUT_MS: 6000, MAX_CONSECUTIVE_FAILURES: 3,
    setTimeout(fn) { const timer = { fn }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); }
  });
  vm.runInContext(`let childProcess = { pid: 100 }; let isShuttingDown = false;
    let consecutiveFailures = 0, recycled = 0, healthCheckInFlight = false;
    function recycleServer() { recycled++; consecutiveFailures = 0; }
    ${healthSource}`, context);
  return { requests, timers, http, check: () => vm.runInContext('checkHttpHealth()', context),
    run: code => vm.runInContext(code, context),
    state: () => JSON.parse(vm.runInContext('JSON.stringify({ consecutiveFailures, recycled, healthCheckInFlight })', context)) };
}

test('timeout plus destroy error counts once; three distinct failed probes recycle once', () => {
  const f = fixture();
  for (let attempt = 1; attempt <= 3; attempt++) {
    f.check();
    f.requests.at(-1).emit('timeout');
    assert.equal(f.state().consecutiveFailures, attempt % 3);
    assert.equal(f.state().recycled, attempt === 3 ? 1 : 0);
    assert.equal(f.state().healthCheckInFlight, false);
    assert.equal(f.timers.size, 0);
  }
});

test('overlapping ticks are skipped and absolute deadline releases a stalled connection', () => {
  const f = fixture();
  f.check(); f.check(); f.check();
  assert.equal(f.requests.length, 1);
  [...f.timers][0].fn();
  assert.equal(f.requests[0].destroyed, true);
  assert.equal(f.state().consecutiveFailures, 1);
  f.check();
  assert.equal(f.requests.length, 2);
});

test('late events cannot overwrite a completed probe; a fresh success clears failures', () => {
  const f = fixture();
  f.check(); f.requests[0].emit('error', new Error('connection refused'));
  f.requests[0].respond(200);
  assert.equal(f.state().consecutiveFailures, 1);
  f.check(); f.requests[1].respond(200);
  f.requests[1].emit('error', new Error('late close'));
  assert.equal(f.state().consecutiveFailures, 0);
  assert.equal(f.timers.size, 0);
});

test('a replaced server and shutdown ignore outstanding probe results', () => {
  const f = fixture();
  f.check(); f.run('childProcess = { pid: 200 }'); f.requests[0].respond(503);
  assert.equal(f.state().consecutiveFailures, 0);
  f.check(); f.run('isShuttingDown = true'); f.requests[1].emit('timeout'); f.check();
  assert.equal(f.state().consecutiveFailures, 0);
  assert.equal(f.requests.length, 2);
});

test('synchronous connection setup errors release the probe lock', () => {
  const f = fixture(); f.http.throwNext = true; f.check();
  assert.equal(f.state().consecutiveFailures, 1);
  assert.equal(f.state().healthCheckInFlight, false);
  f.check(); assert.equal(f.requests.length, 1);
});
