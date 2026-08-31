/* Vigía Pro — service worker para la PWA (app instalable y arranque offline de la UI) */
const CACHE = 'vigia-pro-v1';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.json', '/favicon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
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
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request).then((res) => {
      const copy = res.clone();
      if (res.ok) caches.open(CACHE).then(c => c.put(event.request, copy));
      return res;
    }))
  );
});
