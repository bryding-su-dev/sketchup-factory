// SketchUp Factory service worker: Web Push notifications (server/notify.ts). No offline caching: the app
// is live data over a WebSocket, and a stale cached shell would only confuse.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let n = {};
  try {
    n = event.data ? event.data.json() : {};
  } catch {
    n = { title: 'SketchUp Factory', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    (async () => {
      // Someone is looking at the app right now: the page itself shows what changed.
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (wins.some((w) => w.focused && w.visibilityState === 'visible') && n.tag !== 'test') return;
      await self.registration.showNotification(n.title || 'SketchUp Factory', {
        body: n.body || '',
        tag: n.tag,
        renotify: !!n.tag,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { url: n.url || '#/' },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const hash = (event.notification.data && event.notification.data.url) || '#/';
  const target = new URL('/' + hash.replace(/^\/?/, ''), self.location.origin).href;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin) {
          await w.focus();
          w.postMessage({ type: 'navigate', hash });
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
