'use strict';

// Consolidated entrypoint: delegate runtime clustering to src/cluster-master.js
// which provides rolling reloads, readiness gating, and full IPC fan-out.
module.exports = require('./cluster-master');
