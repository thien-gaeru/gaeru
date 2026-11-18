'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const semver = require('semver');

const ROOT = path.resolve(__dirname, '..');

test('Node 26 LTS alignment: package engines, version files, CI workflows, Render and setup-mi6 match Node 26 LTS', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '>=26.0.0 <27');
  assert.equal(semver.satisfies(process.versions.node, pkg.engines.node), true, `Current Node ${process.versions.node} must satisfy engines.node`);
  assert.equal(semver.satisfies('26.13.0', pkg.engines.node), true);
  assert.equal(semver.satisfies('24.22.1', pkg.engines.node), false);
  assert.equal(semver.satisfies('27.0.0', pkg.engines.node), false);

  assert.equal(fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim(), '26');
  assert.equal(fs.readFileSync(path.join(ROOT, '.node-version'), 'utf8').trim(), '26');

  const ciYaml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'node.yml'), 'utf8');
  assert.match(ciYaml, /node-version:\s*\[\s*'26'\s*\]/);

  const releaseYaml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release-check.yml'), 'utf8');
  assert.match(releaseYaml, /node-version:\s*'26'/);

  const renderYaml = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
  assert.match(renderYaml, /value:\s*26\.13\.0/);

  const setupShPath = path.join(ROOT, 'deploy-mi6', 'setup-mi6.sh');
  if (fs.existsSync(setupShPath)) {
    const setupSh = fs.readFileSync(setupShPath, 'utf8');
    assert.equal(setupSh.includes('\r\n'), false, 'deploy-mi6/setup-mi6.sh must use LF line endings');
    assert.match(setupSh, /node_26\.x/);
    assert.match(setupSh, /libatomic1/);
  }
});

test('Node 26 LTS code hygiene: src/ and scripts/ use node: protocol specifiers and google-analytics avoids unconfigured localStorage warning', () => {
  const bareBuiltins = [
    'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
    'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
    'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
    'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline',
    'repl', 'stream', 'string_decoder', 'timers', 'tls', 'trace_events', 'tty',
    'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'
  ];
  const bareRe = new RegExp(`require\\(\\s*['"](?:${bareBuiltins.join('|')})(?:/promises|/strict)?['"]\\s*\\)`);

  for (const dir of ['src', 'scripts']) {
    const stack = [path.join(ROOT, dir)];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) {
          const content = fs.readFileSync(full, 'utf8');
          assert.equal(bareRe.test(content), false, `${path.relative(ROOT, full)} should use node: prefix for Node built-in modules`);
        }
      }
    }
  }

  // Run google-analytics.trackPurchase in a clean child Node process without --localstorage-file and assert zero warnings
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      [
        "const warnings = [];",
        "process.on('warning', (w) => warnings.push(`${w.name}: ${w.message}`));",
        "globalThis.gtag = () => {};",
        "const GA = require('./google-analytics');",
        "GA.trackPurchase({ orderNumber: 'N26-PROBE-1', totalVnd: 100000, shippingFeeVnd: 0, items: [{ variantId: 'v1', name: 'Mic', priceVnd: 100000, quantity: 1 }] });",
        "setImmediate(() => console.log(JSON.stringify({ warnings })));"
      ].join(' ')
    ],
    { cwd: ROOT, encoding: 'utf8' }
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stderr.trim(), '', `Expected clean stderr without warnings, got: ${probe.stderr}`);
  const parsed = JSON.parse(probe.stdout.trim().split('\n').pop());
  assert.deepEqual(parsed.warnings, []);
});
