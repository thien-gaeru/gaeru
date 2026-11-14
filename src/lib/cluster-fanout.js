'use strict';

const cluster = require('node:cluster');
const { purgeTagsLocal, cacheEvents, stockMap } = require('../../cache');

/**
 * Trạm điều phối IPC Fan-out (IPC Fan-out Hub)
 * Quản lý đồng bộ Cache Tags và Atomic Stock giữa các tiến trình Worker trong Cluster.
 */
class IpcFanoutHub {
  constructor(options = {}) {
    this.metrics = {
      messagesFannedOut: 0,
      tagsFannedOut: 0,
      stockSyncs: 0,
      workerCrashes: 0,
      workerRespawns: 0
    };
    this.customHandlers = new Map();
  }

  // Master: Xử lý thông điệp IPC từ Worker và thực hiện Fan-out sang tất cả các Worker khác
  handleWorkerMessage(senderWorker, message) {
    if (!message || typeof message !== 'object') return { fannedCount: 0 };

    const action = message.type || message.action;

    // 1. Điều phối xóa Cache theo nhãn (Cache Tag Invalidation Fan-out)
    if (action === 'CACHE_INVALIDATE_TAGS') {
      const rawTags = message.tags;
      const tags = Array.isArray(rawTags) ? rawTags : (rawTags ? [rawTags] : []);
      if (tags.length === 0) return { fannedCount: 0 };

      // Xóa cache cục bộ ngay trên Master
      try {
        purgeTagsLocal(tags);
        cacheEvents.emit('invalidated', { tags, timestamp: Date.now() });
      } catch (_) {}

      // Fan-out tin nhắn tới tất cả các Worker khác (trừ Worker nguồn gửi lệnh)
      const fannedCount = this.broadcast(
        { type: 'CACHE_INVALIDATE_TAGS', tags, timestamp: message.timestamp || Date.now() },
        senderWorker?.id
      );

      this.metrics.messagesFannedOut++;
      this.metrics.tagsFannedOut += tags.length;
      return { fannedCount };
    }

    if (action === 'AI_KNOWLEDGE_INVALIDATE') {
      const fannedCount = this.broadcast(
        { type: 'AI_KNOWLEDGE_INVALIDATE', timestamp: message.timestamp || Date.now() },
        senderWorker?.id
      );
      this.metrics.messagesFannedOut++;
      return { fannedCount };
    }

    if (action === 'RENDITION_CACHE_INVALIDATE') {
      const fannedCount = this.broadcast(
        { type: 'RENDITION_CACHE_INVALIDATE', timestamp: message.timestamp || Date.now() },
        senderWorker?.id
      );
      this.metrics.messagesFannedOut++;
      return { fannedCount };
    }

    if (action === 'REALTIME_SSE_EVENT' && typeof message.channel === 'string' && typeof message.event === 'string') {
      const fannedCount = this.broadcast(
        {
          type: 'REALTIME_SSE_EVENT',
          channel: message.channel,
          event: message.event,
          payload: message.payload ?? {},
          id: message.id,
          timestamp: message.timestamp
        },
        senderWorker?.id
      );
      this.metrics.messagesFannedOut++;
      return { fannedCount };
    }

    // 2. Điều phối đồng bộ tồn kho tức thời (Stock Synchronization Fan-out)
    if (action === 'STOCK_SYNC') {
      const { skuOrId, qty } = message;
      if (skuOrId !== undefined && qty !== undefined) {
        const numQty = Number(qty) || 0;
        try {
          stockMap.set(skuOrId, numQty);
        } catch (_) {}
        const fannedCount = this.broadcast({ type: 'STOCK_SYNC', skuOrId, qty: numQty }, senderWorker?.id);
        this.metrics.stockSyncs++;
        return { fannedCount };
      }
      return { fannedCount: 0 };
    }

    // 3. Trình xử lý tùy biến mở rộng (Custom Handlers)
    if (this.customHandlers.has(action)) {
      const handler = this.customHandlers.get(action);
      return handler(senderWorker, message);
    }

    return { fannedCount: 0 };
  }

  // Gửi thông điệp tới toàn bộ các Worker đang kết nối, loại trừ Worker nguồn
  broadcast(message, excludeWorkerId = null) {
    const workers = cluster.workers;
    if (!workers) return 0;
    let sentCount = 0;
    for (const [id, worker] of Object.entries(workers)) {
      if (worker && worker.isConnected() && Number(id) !== Number(excludeWorkerId)) {
        try {
          worker.send(message);
          sentCount++;
        } catch (_) {}
      }
    }
    return sentCount;
  }

  getMetrics() {
    return {
      activeWorkers: cluster.workers ? Object.keys(cluster.workers).length : 0,
      ...this.metrics
    };
  }

  registerHandler(action, fn) {
    this.customHandlers.set(action, fn);
  }
}

const defaultFanoutHub = new IpcFanoutHub();

module.exports = {
  IpcFanoutHub,
  defaultFanoutHub
};
