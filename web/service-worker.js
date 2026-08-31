/* Vigía Pro — service worker para la PWA (app instalable y arranque offline de la UI) */
const CACHE = 'vigia-pro-v5';
const SHELL = ['/', '/index.html', '/styles.css?v=20260831', '/app.js?v=20260831', '/manifest.json', '/favicon.png', '/icon-192.png', '/icon-512.png'];
// La app se actualiza al recargar: la interfaz debe venir de la red, no de
// una caché vieja (eso podía dejar los tabs/configuración sin funcionar).
const NETWORK_FIRST = new Set(['/', '/index.html', '/styles.css', '/app.js', '/manifest.json']);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && /^vigia-/.test(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/stream/') || url.pathname.startsWith('/api/recordings/play') || url.pathname.startsWith('/api/recordings/download')) {
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    // red: siempre intenta la red; si falla, devuelve lo que haya en caché
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }
  if (NETWORK_FIRST.has(url.pathname)) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).then((res) => {
        const copy = res.clone();
        if (res.ok) caches.open(CACHE).then(c => c.put(event.request, copy));
        return res;
      }).catch(() => caches.match(event.request))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request, { cache: 'no-store' }).then((res) => {
      const copy = res.clone();
      if (res.ok) caches.open(CACHE).then(c => c.put(event.request, copy));
      return res;
    }))
  );
});

self.addEventListener('push', (event) => {
  let data = { title: '🔔 Vigía Pro', body: 'Nuevo evento', url: '/#/events' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch { /* text */ }
  const options = {
    body: data.body || 'Nuevo evento',
    icon: '/icon-192.png',
    badge: '/favicon.png',
    vibrate: [120, 60, 120],
    tag: 'vigia-' + (data.tag || Date.now()),
    data: { url: data.url || '/#/events' },
  };
  event.waitUntil(self.registration.showNotification(data.title || '🔔 Vigía Pro', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/#/events';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const client of list) {
      if ('focus' in client) {
        client.navigate(url);
        return client.focus();
      }
    }
    return clients.openWindow(url);
  }));
});
