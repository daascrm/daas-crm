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
  // 2026-09-25.2: takes a file from ANY form field (not only "image" — an
  // installed app can keep an older share definition), reads it fully into
  // memory before storing, and writes a 'shared-meta' note of what actually
  // arrived so the app can say so on screen when a screenshot doesn't land.
  if (req.method === 'POST' && url.pathname.endsWith('/share')) {
    event.respondWith((async () => {
      const meta = { v: 2, at: Date.now(), fields: [], stored: false, error: '' };
      let cache = null;
      try {
        cache = await caches.open(SHARE_CACHE);
        await cache.delete('shared-image');
        const form = await req.formData();
        const text = [form.get('title'), form.get('text'), form.get('url')]
          .filter((v) => typeof v === 'string' && v).join('\n').trim();
        let file = null;
        for (const [name, val] of form.entries()) {
          if (val && typeof val === 'object' && 'size' in val) {
            meta.fields.push({ name, file: true, type: val.type || '', size: val.size || 0 });
            if (!file && val.size) file = val;
          } else {
            meta.fields.push({ name, file: false, len: String(val || '').length });
          }
        }
        await cache.put('shared-text', new Response(text || ''));
        if (file) {
          const buf = await file.arrayBuffer();
          await cache.put('shared-image', new Response(buf, {
            headers: { 'Content-Type': file.type || 'image/png' }
          }));
          meta.stored = true;
        }
      } catch (err) {
        meta.error = String((err && err.message) || err).slice(0, 300);
      }
      try { if (cache) await cache.put('shared-meta', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } })); } catch (e) { /* nothing more we can do */ }
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
