/* Club NNN : service worker pour l'installation en appli et les notifications.
   Réseau d'abord pour les fichiers du site (toujours la dernière version), copie locale si hors ligne.
   Les appels à Supabase ne sont jamais mis en cache. */
const CACHE = 'nnn-v3';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/config.js', '/manifest.webmanifest', '/icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('/index.html'))));
});

// Notifications envoyées par le serveur (fonction nnn-push).
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'NNN club', {
    body: d.body || '', tag: d.tag || 'nnn', renotify: true, lang: 'fr',
    icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: d.url || '/#feed' },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin);
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => new URL(x.url).origin === self.location.origin);
    if (c) { c.postMessage({ go: url.hash.slice(1), g: url.searchParams.get('g') }); return c.focus(); }
    return self.clients.openWindow(url.href);
  }));
});
