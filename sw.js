'use strict';

// GAERU Storefront Web Push Service Worker
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {
    title: 'GAERU Store',
    body: 'Bạn có thông báo mới từ GAERU.',
    url: '/',
    icon: '/assets/brand/gaeru-logo.webp',
    badge: '/assets/brand/gaeru-logo.webp',
    tag: 'gaeru-web-push'
  };

  try {
    if (event.data) {
      const json = event.data.json();
      data = Object.assign(data, json);
    }
  } catch (err) {
    if (event.data) {
      data.body = event.data.text();
    }
  }

  const title = data.title || 'GAERU Store';
  const options = {
    body: data.body,
    icon: data.icon || '/assets/brand/gaeru-logo.webp',
    badge: data.badge || '/assets/brand/gaeru-logo.webp',
    tag: data.tag || 'gaeru-web-push',
    renotify: true,
    data: {
      url: data.url || '/'
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url === targetUrl && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
