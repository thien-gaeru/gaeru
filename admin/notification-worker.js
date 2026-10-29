const CACHE_NAME = 'gaeru-admin-v1';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))),
      self.clients.claim()
    ])
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = String(event.notification.data?.target || 'notifications');
  const hash = /^[a-z]+$/.test(target) ? target : 'notifications';
  const url = '/gaeru_ceo#' + hash;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url.includes('/gaeru_ceo') && 'focus' in client) {
          if (typeof client.navigate === 'function') client.navigate(url);
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

self.addEventListener('push', event => {
  let data = { title: 'GAERU CEO', body: 'Có công việc mới cần xử lý.', target: 'notifications' };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch {
    if (event.data) data.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/assets/brand/gaeru-app-192.png',
      badge: '/assets/brand/gaeru-app-192.png',
      tag: 'gaeru-admin-push',
      renotify: true,
      data: { target: data.target || 'notifications' }
    })
  );
});
