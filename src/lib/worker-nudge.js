'use strict';

const IPC_KEY = Symbol.for('gaeru.backgroundWorkerNudge.ipcRegistered');
const handlers = new Map();

if (typeof process.on === 'function' && !process[IPC_KEY]) {
  process[IPC_KEY] = true;
  if (typeof process.getMaxListeners === 'function' && typeof process.setMaxListeners === 'function') {
    const currentMax = process.getMaxListeners();
    if (currentMax > 0 && currentMax < 24) process.setMaxListeners(24);
  }
  process.on('message', (msg) => {
    if (msg?.type !== 'BACKGROUND_WORKER_NUDGE' || typeof msg.worker !== 'string') return;
    const entry = handlers.get(msg.worker);
    if (!entry) return;
    if (entry.delayMs > 0) {
      setImmediate(() => setTimeout(entry.fn, entry.delayMs).unref?.());
    } else {
      setImmediate(entry.fn);
    }
  });
}

function registerWorkerNudge(workerName, fn, { delayMs = 0 } = {}) {
  if (!workerName || typeof fn !== 'function') return () => {};
  const entry = { fn, delayMs };
  handlers.set(workerName, entry);
  return () => {
    if (handlers.get(workerName) === entry) {
      handlers.delete(workerName);
    }
  };
}

function triggerWorkerNudge(workerName) {
  const entry = handlers.get(workerName);
  if (entry) {
    if (entry.delayMs > 0) {
      setImmediate(() => setTimeout(entry.fn, entry.delayMs).unref?.());
    } else {
      setImmediate(entry.fn);
    }
    return true;
  }
  if (typeof process.send === 'function') {
    try {
      process.send({ type: 'BACKGROUND_WORKER_NUDGE', worker: workerName });
      return true;
    } catch (_) {}
  }
  return false;
}

module.exports = {
  registerWorkerNudge,
  triggerWorkerNudge
};
