/* StoryT service worker
   - App screens load instantly and show an offline page without internet
   - Posts, messages (/api) and videos (/media) always come live from the server
   - Shows push notifications and opens the right screen when one is tapped
   Change VERSION when you update the app so phones pick up the new files. */
const VERSION = 'storyt-v4';
const SHELL = ['/', '/offline.html', '/manifest.json', '/icon-192.png', '/icon-512.png', '/icon.svg', '/mark.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put('/', copy));
        return res;
      }).catch(() => caches.match('/').then(r => r || caches.match('/offline.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(cached => {
      const live = fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => cached);
      return cached || live;
    })
  );
});

/* Push notifications */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'StoryT', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'StoryT', {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-96.png',
    data: { url: d.url || '/' },
    tag: d.tag,
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.navigate(target).catch(() => {}); return c.focus(); } }
    return clients.openWindow(target);
  }));
});
