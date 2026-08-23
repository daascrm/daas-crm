// DAAS service worker
// Purpose: (1) receive Web Share Target POSTs (text + screenshots) on a static
// GitHub Pages host, (2) keep the installed PWA fresh by always fetching the
// latest index.html from the network (no stale app after deploy), and
// (3) receive Web Push notifications (event/donation form signups) and open the
// app when one is tapped.
//
// This worker lives beside the shared /crm/ app so its scope is limited to that
// route when DAAS is published on the main site.

const SHARE_CACHE = 'daas-share-v1';

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

// 3) Web Push — show the notification the signup-notify function sent.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'DAAS';
  const options = {
    body: data.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: data.tag || 'daas',
    renotify: true,
    data: { url: data.url || './index.html' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping a push focuses an open DAAS tab, or opens the app.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { try { await c.focus(); return; } catch (e) { /* try next */ } } }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1) Share-target POST → stash payload, redirect into the app
  if (req.method === 'POST' && url.pathname.endsWith('/share')) {
    event.respondWith((async () => {
      try {
        const form = await req.formData();
        const text = [form.get('title'), form.get('text'), form.get('url')]
          .filter(Boolean).join('\n').trim();
        const files = form.getAll('image') || [];
        const cache = await caches.open(SHARE_CACHE);
        await cache.put('shared-text', new Response(text || ''));
        if (files && files.length && files[0] && files[0].size) {
          await cache.put('shared-image', new Response(files[0], {
            headers: { 'Content-Type': files[0].type || 'image/png' }
          }));
        } else {
          await cache.delete('shared-image');
        }
      } catch (err) { /* swallow — still redirect */ }
      return Response.redirect('./index.html?shared=1', 303);
    })());
    return;
  }

  // 2) Navigation requests (loading the app page) → network-first so the
  //    installed PWA always gets the freshest index.html after a deploy.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req, { cache: 'reload' }).catch(() => caches.match(req))
    );
    return;
  }
  // Everything else: let the browser handle it normally.
});
