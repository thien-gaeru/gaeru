(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GAERUOfflineCatalog = api;
})(typeof window === 'object' ? window : globalThis, function() {
  'use strict';

  const DB_NAME = 'gaeru_offline_store';
  const DB_VERSION = 1;

  function openDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('products')) {
          db.createObjectStore('products', { keyPath: 'slug' });
        }
        if (!db.objectStoreNames.contains('cart')) {
          db.createObjectStore('cart', { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function syncProducts(products = []) {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction('products', 'readwrite');
    const store = tx.objectStore('products');
    for (const p of products) {
      store.put(p);
    }
    return new Promise((resolve) => {
      tx.oncomplete = () => resolve(products.length);
      tx.onerror = () => resolve(0);
    });
  }

  async function getOfflineProducts() {
    const db = await openDb();
    if (!db) return [];
    const tx = db.transaction('products', 'readonly');
    const store = tx.objectStore('products');
    const req = store.getAll();
    return new Promise((resolve) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  async function saveOfflineCartItem(item) {
    const db = await openDb();
    if (!db) return null;
    const tx = db.transaction('cart', 'readwrite');
    const store = tx.objectStore('cart');
    const req = store.add({ ...item, addedAt: Date.now() });
    return new Promise((resolve) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }

  // Auto-sync when coming back online
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', () => {
      console.log('[GAERU Offline] Đã kết nối lại mạng Internet. Bắt đầu đồng bộ giỏ hàng...');
      const event = new CustomEvent('gaeru:online-sync');
      window.dispatchEvent(event);
    });
  }

  return {
    openDb,
    syncProducts,
    getOfflineProducts,
    saveOfflineCartItem
  };
});
