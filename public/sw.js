// Service worker: breaking-news push notifications, and an offline copy of
// the app, the latest feed and saved stories.
//
// Everything is network-first, so a deploy is live on the next load; the
// cache only answers when the network can't.

const CACHE = 'fw-v2';
const SHELL = ['./', 'index.html', 'app.js', 'search.js', 'breaking.js', 'palette.js', 'foryou.js', 'accounts.js', 'styles.css', 'favicon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// What is worth keeping for offline reading: the shell, the feed, story pages.
const keep = (url) => !url.pathname.startsWith('/api/') || url.pathname === '/api/snapshot' || url.pathname === '/api/story' || url.pathname === '/api/breaking';

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname === '/api/stream' || url.pathname.startsWith('/admin') || url.pathname.startsWith('/media/')) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && keep(url)) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? 'index.html' : req, copy));
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req.mode === 'navigate' ? 'index.html' : req, { ignoreVary: true });
      if (hit) return hit;
      throw err;
    }
  })());
});

// Saved stories ask to be kept: the page posts their URLs here.
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'keep' || !Array.isArray(e.data.urls)) return;
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(e.data.urls.slice(0, 100).map((u) => {
    const url = new URL(u, location.origin);
    if (url.origin !== location.origin || url.pathname !== '/api/story') return null;
    return c.match(url.href).then((hit) => hit || fetch(url.href).then((res) => res.ok && c.put(url.href, res)).catch(() => {}));
  }))));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data?.json() || {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Breaking', {
    body: d.body || '',
    tag: d.tag || 'breaking',
    icon: 'icon-192.png',
    badge: 'favicon.svg',
    timestamp: d.at || Date.now(),
    data: { url: d.url || './' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === location.origin);
    if (win) {
      await win.focus();
      return win.navigate(target).catch(() => {});
    }
    return self.clients.openWindow(target);
  })());
});
