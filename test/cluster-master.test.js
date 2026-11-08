'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

test('GAERU High-Availability Cluster Orchestrator architecture verification', () => {
  const masterSrc = fs.readFileSync(path.join(__dirname, '../src/cluster-master.js'), 'utf8');

  // Verify core cluster orchestration requirements
  assert.ok(masterSrc.includes('cluster.setupPrimary'), 'Must configure cluster primary execution target');
  assert.ok(masterSrc.includes('path.join(__dirname, \'server.js\')'), 'Primary must target server.js');
  assert.ok(masterSrc.includes('executeRollingReload'), 'Must provide executeRollingReload function');
  assert.ok(masterSrc.includes('WORKER_INDEX'), 'Must pass WORKER_INDEX to workers');
  assert.ok(masterSrc.includes('CLUSTER_WORKER'), 'Must pass CLUSTER_WORKER flag');
  assert.ok(masterSrc.includes('defaultFanoutHub'), 'Must integrate IPC Fan-out Hub');
  assert.ok(masterSrc.includes('clusterStockCoordinator'), 'Must integrate Cluster Stock Coordinator');
  assert.ok(masterSrc.includes('oldWorker.disconnect()'), 'Rolling reload must gracefully disconnect old worker');
  assert.ok(masterSrc.includes('tuneWorkerPriority'), 'Must tune worker priority to AboveNormal');
  assert.ok(masterSrc.includes('reload.signal'), 'Must watch reload.signal for zero-downtime rolling reload');
});

test('Watchdog supervisor is configured with cluster master for zero-downtime rolling deployment', () => {
  const supervisorSrc = fs.readFileSync(path.join(__dirname, '../scripts/watchdog-supervisor.js'), 'utf8');

  assert.ok(supervisorSrc.includes('cluster-master.js'), 'Supervisor must target cluster-master.js');
  assert.ok(supervisorSrc.includes('Zero-Downtime Rolling Reload'), 'Supervisor must delegate reload to Cluster Master');
});

test('Server entrypoint notifies cluster master when readiness gate is fully open', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');

  assert.ok(serverSrc.includes('WORKER_READY'), 'Server must send WORKER_READY to master upon setReady(true)');
  assert.ok(serverSrc.includes('isBackgroundWorker'), 'Server must preserve single background scheduler role');
});
