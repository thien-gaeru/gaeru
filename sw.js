// GAERU Storefront Service Worker — PWA for Android & iOS
const CACHE_NAME = 'gaeru-store-v20261029';
const APP_SHELL_ASSETS = [
  '/',
  '/index.html',
  '/shop.html',
  '/cart.html',
  '/account.html',
  '/care.html',
  '/styles.css',
  '/brand.css',
  '/typography.css',
  '/home-responsive.css',
  '/store-shell.js',
  '/pwa-storefront.css',
  '/pwa-storefront.js',
  '/assets/brand/gaeru-logo.webp',
  '/assets/brand/gaeru-app-192.png',
  '/assets/brand/gaeru-app-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL_ASSETS).catch((err) => {
        // Continue even if some individual resources fail to prefetch
        console.warn('[GAERU-SW] Pre-caching partial fallback:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key.startsWith('gaeru-store-')) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests and internal/admin/API paths from Service Worker caching
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/gaeru_ceo')) return;

  // Stale-While-Revalidate for images and static assets (png, webp, svg, css, js)
  if (/\.(?:png|jpe?g|webp|svg|css|js|woff2?)$/i.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.match(event.request).then((cachedResponse) => {
          const fetchPromise = fetch(event.request).then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              cache.put(event.request, networkResponse.clone());
            }
            return networkResponse;
          }).catch(() => cachedResponse);

          return cachedResponse || fetchPromise;
        });
      })
    );
    return;
  }

  // Network-First with Cache Fallback for HTML pages
  if (event.request.mode === 'navigate' || event.request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const cloned = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
        }
        return networkResponse;
      }).catch(() => {
        return caches.match(event.request).then((cached) => {
          return cached || caches.match('/index.html');
        });
      })
    );
  }
});

// Push notification support for order tracking and promotions
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'GAERU Store', body: event.data ? event.data.text() : 'Thông báo mới từ GAERU' };
  }

  const title = data.title || 'GAERU Store';
  const options = {
    body: data.body || 'Bạn có thông báo mới về đơn hàng hoặc ưu đãi GAERU.',
    icon: data.icon || '/assets/brand/gaeru-app-192.png',
    badge: '/assets/brand/gaeru-app-192.png',
    data: {
      url: data.url || '/account.html#customer-orders',
      dateOfArrival: Date.now()
    },
    vibrate: [100, 50, 100]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
