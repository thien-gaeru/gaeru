'use strict';

function createCacheManager({ maxEntries = 1000, defaultTtlSeconds = 300, redisUrl = null } = {}) {
  const store = new Map();
  let hits = 0;
  let misses = 0;

  function pruneExpired() {
    const now = Date.now();
    for (const [key, item] of store) {
      if (item.expiresAt <= now) {
        store.delete(key);
      }
    }
  }

  function get(key) {
    const item = store.get(key);
    if (!item) {
      misses++;
      return null;
    }
    if (item.expiresAt <= Date.now()) {
      store.delete(key);
      misses++;
      return null;
    }
    // Refresh LRU order
    store.delete(key);
    store.set(key, item);
    hits++;
    return item.value;
  }

  function set(key, value, ttlSeconds = defaultTtlSeconds) {
    if (store.size >= maxEntries) {
      pruneExpired();
      if (store.size >= maxEntries) {
        // Evict oldest (first) item
        const firstKey = store.keys().next().value;
        if (firstKey) store.delete(firstKey);
      }
    }
    const expiresAt = Date.now() + Math.max(1, ttlSeconds) * 1000;
    store.set(key, { value, expiresAt });
    return value;
  }

  function del(key) {
    return store.delete(key);
  }

  function delPattern(pattern) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    let deleted = 0;
    for (const key of store.keys()) {
      if (regex.test(key)) {
        store.delete(key);
        deleted++;
      }
    }
    return deleted;
  }

  async function wrap(key, ttlSeconds, computeFn) {
    const cached = get(key);
    if (cached !== null && cached !== undefined) {
      return cached;
    }
    const fresh = await computeFn();
    set(key, fresh, ttlSeconds);
    return fresh;
  }

  function clear() {
    store.clear();
    hits = 0;
    misses = 0;
  }

  function stats() {
    return {
      entries: store.size,
      maxEntries,
      hits,
      misses,
      hitRate: (hits + misses) > 0 ? (hits / (hits + misses)).toFixed(3) : '0.000'
    };
  }

  return {
    get,
    set,
    del,
    delPattern,
    wrap,
    clear,
    stats
  };
}

const defaultCache = createCacheManager();

module.exports = {
  createCacheManager,
  defaultCache
};
