/* Service Worker: кэш оффлайн + пуш-уведомления */
'use strict';
const CACHE = 'dailytasks-v2';
const ASSETS = ['./', './index.html', './style.css', './app.js', './manifest.webmanifest', './icon.svg',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(ASSETS.map(a => c.add(a))))
      .catch(() => {})
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});

/* пуш от приложения (self-send) */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  const title = d.title || 'Мои дела';
  const opts = {
    body: d.body || '',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: d.tag,
    data: { url: d.url || './' },
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) if ('focus' in c) return c.focus();
      return clients.openWindow((e.notification.data && e.notification.data.url) || './');
    })
  );
});

/* будильники от страницы (best-effort: живут, пока жив сервис-воркер) */
self.addEventListener('message', e => {
  if (!e.data || e.data.type !== 'schedule') return;
  const now = Date.now();
  (e.data.items || []).forEach(it => {
    const delay = it.at - now;
    if (delay > 0 && delay < 24 * 3600 * 1000) {
      setTimeout(() => {
        self.registration.showNotification(it.title || 'Мои дела', { body: it.body || '', icon: './icons/icon-192.png', tag: it.tag });
      }, delay);
    }
  });
});
